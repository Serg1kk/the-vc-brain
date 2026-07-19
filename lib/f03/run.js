#!/usr/bin/env node
// lib/f03/run.js
//
// Headless runner for feature 03 (Founder Score) -- docs/backlog/03-founder-score/plan.md
// task B4. Makes the feature demonstrable end to end without n8n: reads claims from
// Postgres, builds the 4 routed context packs (design.md SS4.7), calls the 4 sub-scorer
// agents (or replays recorded JSON), runs them through lib/f03/gate.js and
// lib/f03/scoring.js -- both of which are SOURCE OF TRUTH and are never modified here --
// writes the resulting rows, and prints the SS4.9 output contract to stdout.
//
// Unlike gate.js/scoring.js this file is a Node CLI, not a Code-node body: it may
// require() freely. No package.json / no dependencies (plan.md guiding decision 4) --
// Postgres access goes through the `psql` binary via node:child_process, per this task's
// own instructions ("shell out to psql ... entirely acceptable").
//
// Usage:
//   node lib/f03/run.js <founder_id> [--recorded <dir>] [--record <dir>]
//
//   --recorded <dir>   Skip ALL OpenAI calls. Load <dir>/<subscorer>.json for each of the
//                       4 sub-scorers instead (the exact object gate.js expects as
//                       rawAgentOutputs[subscorer]). Zero network access. This is the
//                       default path for testing (D1).
//   --record <dir>     Make the 4 live OpenAI calls AND save each parsed agent response to
//                       <dir>/<subscorer>.json, so a live run can be replayed later via
//                       --recorded. Mutually exclusive with --recorded.
//
// Every other invocation (no --recorded, no --record) makes live calls without saving --
// not the intended path per plan.md's budget guidance, but not forbidden either.
//
// Env:
//   OPENAI_API_KEY   read from process.env, falling back to the repo-root .env
//                    (gitignored) -- see getOpenAiKey().
//   DATABASE_URL     read from process.env if set, else built from
//                    infra/supabase/.env's POOLER_TENANT_ID + POSTGRES_PASSWORD
//                    (Supavisor pooler on :54322 -- CLAUDE.md > Commands).
//
// Pipeline (design.md SS4.1, SS4.3, SS4.7, SS4.9; SS2.4 for the insufficient_evidence
// branch):
//   1. Load the active `score_formulas` row for axis='founder_score'.
//   2. Load founder + (best) company, and every claim⋈evidence⋈raw_signals for the
//      founder (design SS4.1's join, restructured as a per-claim evidence aggregate --
//      see loadClaims()).
//   3. Build 4 routed context packs (SS4.7): 3 positive packs by claims.topic prefix, plus
//      the red-flags pack = the union of ALL claims (matched + unmatched -- SS4.7's
//      fallback rule). Cap + order each pack, record its claim_ids, normalize claim text.
//   4. Call the 4 sub-scorer agents (gpt-5.6-luna, temperature 0, JSON mode) or replay
//      recorded JSON.
//   5. Write `ai_runs` x4 -- ALWAYS, before validation (design I8) -- with `run_id` echoed
//      into each output_json.
//   6. lib/f03/gate.js `applyGate()`.
//   7. lib/f03/scoring.js `aggregate()`, against the most recent prior founder_score row.
//   8. Write results: `scores` x1 + `score_components` x N on `status:'scored'`; one
//      `events` row (no `scores` row) + `score_components` x N with score_id NULL on
//      `status:'insufficient_evidence'` (design SS2.4).
//   9. Print the SS4.9 contract to stdout as JSON.
//
// docs/backlog/03-founder-score/plan.md task B4.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const { applyGate } = require('./gate');
const { aggregate } = require('./scoring');

// ============================================================================
// Constants
// ============================================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'docs', 'backlog', '03-founder-score', 'agents');

// design.md SS4.8 / agents/README.md "Model & parameters".
const MODEL = 'gpt-5.6-luna';
// No other fixed value exists anywhere in the repo for this -- design.md SS4.9's example
// contract is the only concrete string given ("p1-2026.07"), so it is adopted here as the
// constant for this build of the 4 prompts (docs/backlog/03-founder-score/agents/*.md).
const PROMPT_VERSION = 'p1-2026.07';

const SUBSCORERS = ['execution-signals', 'expertise-signals', 'leadership-sales-proxies', 'red-flags'];

const SUBSCORER_SPEC_FILES = {
  'execution-signals': 'execution-signals.md',
  'expertise-signals': 'expertise-signals.md',
  'leadership-sales-proxies': 'leadership-sales-proxies.md',
  'red-flags': 'red-flags.md'
};

// design.md SS4.7's routing table. Order matters: first matching prefix wins (topics are
// disjoint by construction, so this is defensive, not load-bearing).
const TOPIC_ROUTES = [
  { prefix: 'founder.execution.', subscorer: 'execution-signals' },
  { prefix: 'founder.expertise.', subscorer: 'expertise-signals' },
  { prefix: 'founder.leadership.', subscorer: 'leadership-sales-proxies' }
];

// Same ranking gate.js uses internally for its own (different) purpose -- reproduced here
// because context-pack ordering ("documented -> discovered -> inferred", design SS4.7) is a
// run.js concern, not gate.js's.
const TIER_RANK = { documented: 3, discovered: 2, inferred: 1, missing: 0 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// CLI
// ============================================================================

function usageError(msg) {
  process.stderr.write(
    'run.js: ' + msg + '\n' +
    'Usage: node lib/f03/run.js <founder_id> [--recorded <dir>] [--record <dir>]\n'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0].startsWith('--')) usageError('missing <founder_id>');
  const founderId = rest[0];
  if (!UUID_RE.test(founderId)) usageError('<founder_id> must be a UUID, got "' + founderId + '"');

  let recordedDir = null;
  let recordDir = null;
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--recorded') {
      if (i + 1 >= rest.length) usageError('--recorded requires a directory argument');
      recordedDir = rest[++i];
    } else if (rest[i] === '--record') {
      if (i + 1 >= rest.length) usageError('--record requires a directory argument');
      recordDir = rest[++i];
    } else {
      usageError('unknown argument "' + rest[i] + '"');
    }
  }
  if (recordedDir && recordDir) usageError('--recorded and --record are mutually exclusive');

  return {
    founderId,
    recordedDir: recordedDir ? path.resolve(process.cwd(), recordedDir) : null,
    recordDir: recordDir ? path.resolve(process.cwd(), recordDir) : null
  };
}

// ============================================================================
// .env loading (no dependencies -- minimal KEY=VALUE parser, not a shell)
// ============================================================================

function parseDotEnv(filePath) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return out;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getOpenAiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const env = parseDotEnv(path.join(REPO_ROOT, '.env'));
  return env.OPENAI_API_KEY || null;
}

function getDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = parseDotEnv(path.join(REPO_ROOT, 'infra', 'supabase', '.env'));
  const tenant = env.POOLER_TENANT_ID;
  const password = env.POSTGRES_PASSWORD;
  if (!tenant || !password) {
    throw new Error(
      'run.js: cannot build DATABASE_URL -- set DATABASE_URL explicitly, or ensure ' +
      'infra/supabase/.env has POOLER_TENANT_ID and POSTGRES_PASSWORD (CLAUDE.md > Commands)'
    );
  }
  return 'postgresql://postgres.' + tenant + ':' + password + '@localhost:54322/postgres';
}

// ============================================================================
// Postgres access via psql (no pg driver -- no dependencies, per plan.md guiding decision 4)
//
// All parameter values travel through psql `-v NAME=value`, referenced in the SQL text via
// `:'NAME'` (psql's quote_literal-equivalent substitution) -- never string-concatenated
// into the SQL directly. spawnSync passes argv as an array (no shell), so no argument is
// ever shell-interpreted either. This is the safe combination against injection from a
// founder_id or a JSON payload containing arbitrary characters.
//
// The SQL text itself is fed via `-f -` (read script from stdin), NOT `-c`: verified live
// against this repo's psql 16.13 (Homebrew) that `-c "SELECT :'foo';"` does NOT perform
// `:'var'` interpolation at all (raises "syntax error at or near ':'"), while piping the
// identical text to `-f -` does. This is a real behavioural difference in this psql build,
// not a hypothetical -- confirmed by direct reproduction before writing this comment.
// ============================================================================

function psqlRun(databaseUrl, sql, vars) {
  const args = [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tA'];
  for (const [k, v] of Object.entries(vars || {})) {
    args.push('-v', k + '=' + v);
  }
  args.push('-f', '-');
  const res = spawnSync('psql', args, { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    throw new Error('run.js: failed to spawn psql (' + res.error.message + ')');
  }
  if (res.status !== 0) {
    throw new Error(
      'run.js: psql exited ' + res.status + ':\n' + (res.stderr || '').trim() + '\n--- SQL ---\n' + sql
    );
  }
  return res.stdout;
}

function pgQueryJson(databaseUrl, sql, vars) {
  const out = psqlRun(databaseUrl, sql, vars).trim();
  if (!out) return null;
  return JSON.parse(out);
}

function pgExec(databaseUrl, sql, vars) {
  psqlRun(databaseUrl, sql, vars);
}

// ---- Reads --------------------------------------------------------------

function loadActiveFormula(databaseUrl) {
  const sql = `
    SELECT row_to_json(t) FROM (
      SELECT version, config FROM score_formulas WHERE axis = 'founder_score' AND active LIMIT 1
    ) t;`;
  const row = pgQueryJson(databaseUrl, sql, {});
  if (!row) throw new Error('run.js: no active score_formulas row for axis=founder_score');
  return row; // { version, config }
}

function loadFounderContext(databaseUrl, founderId) {
  const sql = `
    SELECT row_to_json(t) FROM (
      SELECT f.id, f.full_name, f.headline, f.location_country,
        (SELECT row_to_json(co) FROM (
           SELECT c.name, c.one_liner, c.category, c.stage
           FROM founder_company fc JOIN companies c ON c.id = fc.company_id
           WHERE fc.founder_id = f.id
           ORDER BY fc.is_current DESC NULLS LAST, fc.confidence DESC NULLS LAST
           LIMIT 1
         ) co) AS company
      FROM founders f
      WHERE f.id = :'founder_id'::uuid
    ) t;`;
  const row = pgQueryJson(databaseUrl, sql, { founder_id: founderId });
  if (!row) throw new Error('run.js: no founder found for id ' + founderId);
  return row; // { id, full_name, headline, location_country, company: {...} | null }
}

// design.md SS4.1: `claims c JOIN cards k ON c.card_id=k.id LEFT JOIN evidence e ON
// e.claim_id=c.id LEFT JOIN raw_signals rs ON e.raw_signal_id=rs.id WHERE k.founder_id=$1`.
// Restructured here as a correlated-subquery aggregate rather than a flat 3-way LEFT JOIN
// re-grouped in JS -- functionally identical (every claim's evidence rows, each carrying
// the pre-joined raw_signals.source gate.js's header comment requires), but avoids
// (claim x evidence) row multiplication reaching the client at all.
function loadClaims(databaseUrl, founderId) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT
        c.id AS claim_id,
        c.text_verbatim,
        c.topic,
        c.source_kind,
        c.created_at,
        COALESCE((
          SELECT json_agg(json_build_object(
            'tier', e.tier,
            'quote_verbatim', e.quote_verbatim,
            'source_url', e.source_url,
            'raw_signal_id', e.raw_signal_id,
            'source', rs.source
          ) ORDER BY e.created_at)
          FROM evidence e
          LEFT JOIN raw_signals rs ON rs.id = e.raw_signal_id
          WHERE e.claim_id = c.id
        ), '[]'::json) AS evidence
      FROM claims c
      JOIN cards k ON c.card_id = k.id
      WHERE k.founder_id = :'founder_id'::uuid
      ORDER BY c.created_at
    ) t;`;
  return pgQueryJson(databaseUrl, sql, { founder_id: founderId }) || [];
}

function loadPreviousScore(databaseUrl, founderId) {
  const sql = `
    SELECT row_to_json(t) FROM (
      SELECT value, formula_version, input_claim_ids
      FROM scores
      WHERE founder_id = :'founder_id'::uuid AND axis = 'founder_score'
      ORDER BY computed_at DESC
      LIMIT 1
    ) t;`;
  return pgQueryJson(databaseUrl, sql, { founder_id: founderId }); // null or {value, formula_version, input_claim_ids}
}

// ---- Writes ---------------------------------------------------------------

// design I8: ai_runs written ALWAYS, before validation. `run_id` is echoed into every
// output_json (design SS4.9) so the four ledger rows join to the components without a
// dedicated column for it.
function writeAiRuns(databaseUrl, runId, founderId, rawAgentOutputs) {
  const vars = { founder_id: founderId, model: MODEL, prompt_version: PROMPT_VERSION };
  const statements = [];
  SUBSCORERS.forEach((s, i) => {
    const key = 'output_json_' + i;
    const payload = Object.assign({}, rawAgentOutputs[s], { run_id: runId });
    vars[key] = JSON.stringify(payload);
    statements.push(
      "INSERT INTO ai_runs (task_type, founder_id, model, prompt_version, output_json) " +
      "VALUES ('scoring', :'founder_id'::uuid, :'model', :'prompt_version', :'" + key + "'::jsonb);"
    );
  });
  pgExec(databaseUrl, 'BEGIN;\n' + statements.join('\n') + '\nCOMMIT;', vars);
}

// score_components rows travel as one jsonb array so nullability (credit, contribution,
// evidence_tier, quote_verbatim, rationale, what_would_close_it, demoted_by, score_id) is
// handled by `->>'field'` yielding SQL NULL on a JSON null, rather than hand-rolling a
// NULL-vs-literal branch per column per row.
function writeScoreComponents(databaseUrl, runId, founderId, scoreId, components) {
  const rows = components.map((c) => ({
    score_id: scoreId, // string or null (design SS2.4: NULL on insufficient_evidence)
    founder_id: founderId,
    run_id: runId,
    subscorer: c.subscorer,
    criterion_id: c.criterion_id,
    verdict: c.verdict,
    weight: c.weight,
    credit: c.credit,
    contribution: c.contribution,
    evidence_tier: c.evidence_tier,
    claim_ids: Array.isArray(c.claim_ids) ? c.claim_ids : [],
    quote_verbatim: c.quote_verbatim,
    rationale: c.rationale,
    what_would_close_it: c.what_would_close_it,
    demoted_by: c.demoted_by
  }));
  const sql = `
    INSERT INTO score_components
      (score_id, founder_id, run_id, subscorer, criterion_id, verdict, weight, credit,
       contribution, evidence_tier, claim_ids, quote_verbatim, rationale,
       what_would_close_it, demoted_by)
    SELECT
      (r->>'score_id')::uuid,
      (r->>'founder_id')::uuid,
      (r->>'run_id')::uuid,
      r->>'subscorer',
      r->>'criterion_id',
      r->>'verdict',
      (r->>'weight')::numeric,
      (r->>'credit')::numeric,
      (r->>'contribution')::numeric,
      r->>'evidence_tier',
      COALESCE((SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(r->'claim_ids') AS x), '{}'::uuid[]),
      r->>'quote_verbatim',
      r->>'rationale',
      r->>'what_would_close_it',
      r->>'demoted_by'
    FROM jsonb_array_elements(:'rows_json'::jsonb) AS r;`;
  pgExec(databaseUrl, sql, { rows_json: JSON.stringify(rows) });
}

// status:'scored' branch (design SS4.3 / SS2.3). `input_claim_ids` is the union of the 4
// context packs' claim_ids (task B4 instructions; confirmed by the orchestrator) -- NOT
// scoring.js's internal `unionClaimIds(components)`, which is the narrower "claims actually
// cited by a verdict" set scoring.js uses for its own SS4.5 same-claims trend guard. See
// this task's final report for the resulting asymmetry across runs.
function writeScored(databaseUrl, founderId, result, formulaVersion, inputClaimIds) {
  const scoreId = crypto.randomUUID();
  const payload = {
    id: scoreId,
    founder_id: founderId,
    value: result.value,
    confidence: result.confidence,
    trend: result.trend, // may be null
    missing_flags: result.missing, // ARRAY, verbatim -- never the '{}' object default
    input_claim_ids: inputClaimIds,
    formula_version: formulaVersion,
    prompt_version: PROMPT_VERSION,
    model: MODEL
  };
  const sql = `
    INSERT INTO scores
      (id, founder_id, axis, value, confidence, trend, missing_flags, input_claim_ids,
       formula_version, prompt_version, model)
    SELECT
      (j->>'id')::uuid,
      (j->>'founder_id')::uuid,
      'founder_score',
      (j->>'value')::numeric,
      (j->>'confidence')::numeric,
      j->>'trend',
      COALESCE(j->'missing_flags', '[]'::jsonb),
      COALESCE((SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(j->'input_claim_ids') AS x), '{}'::uuid[]),
      j->>'formula_version',
      j->>'prompt_version',
      j->>'model'
    FROM (SELECT :'score_json'::jsonb AS j) t;`;
  pgExec(databaseUrl, sql, { score_json: JSON.stringify(payload) });
  return scoreId;
}

// status:'insufficient_evidence' branch (design SS2.4): NO scores row; one events row
// instead, so the branch is distinguishable from "never scored".
function writeInsufficientEvidenceEvent(databaseUrl, runId, founderId, result) {
  const payload = { run_id: runId, coverage: result.coverage, missing: result.missing };
  const sql = `
    INSERT INTO events (event_type, entity_type, entity_id, payload)
    VALUES ('founder_score_insufficient_evidence', 'founder', :'founder_id'::uuid, :'payload_json'::jsonb);`;
  pgExec(databaseUrl, sql, { founder_id: founderId, payload_json: JSON.stringify(payload) });
}

// ============================================================================
// Claim text normalization (design SS4.7: "formatting is normalized before judging --
// style bias is the dominant LLM-judge bias ... and favours markdown; a raw scraped
// footprint must not lose to a well-formatted deck on presentation alone").
//
// Applied EXACTLY ONCE, at claim-load time, before either the gate.js-facing pack or the
// LLM-facing prompt pack is derived -- both are built from the SAME normalized string, so
// gate.js's step-7 substring check (I6) stays self-consistent: whatever the model quotes
// back from what it was shown is checked against that same shown text, never the raw,
// un-normalized DB column. Conservative by design: only strips unambiguous markdown syntax
// (headers, list markers, fenced/inline code, **bold**/__bold__ pairs) and collapses
// egregious whitespace. Deliberately leaves single '_' / '*' characters alone (e.g.
// snake_case identifiers, like the fixture's own `commit_weeks_active` evidence quote) --
// regex-based single-delimiter italics detection is too failure-prone to risk mangling a
// verbatim quote.
// ============================================================================

function normalizeClaimText(s) {
  if (s === null || s === undefined) return s;
  if (typeof s !== 'string') return s;
  let out = s.replace(/\r\n/g, '\n');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // markdown headers
  out = out.replace(/^\s*[-*+]\s+(?=\S)/gm, ''); // bullet list markers
  out = out.replace(/^\s*\d+[.)]\s+(?=\S)/gm, ''); // numbered list markers
  out = out.replace(/```[^\n`]*\n?([\s\S]*?)```/g, '$1'); // fenced code blocks
  out = out.replace(/`([^`\n]+)`/g, '$1'); // inline code
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1'); // **bold**
  out = out.replace(/__([^_\n]+)__/g, '$1'); // __bold__
  out = out.replace(/[ \t]{2,}/g, ' '); // collapse runs of 2+ spaces/tabs
  out = out.replace(/\n{3,}/g, '\n\n'); // collapse 3+ blank lines to one
  return out.trim();
}

function loadClaimsNormalized(databaseUrl, founderId) {
  const rows = loadClaims(databaseUrl, founderId);
  return rows.map((row) => ({
    claim_id: row.claim_id,
    text_verbatim: normalizeClaimText(row.text_verbatim),
    topic: row.topic,
    source_kind: row.source_kind,
    created_at: row.created_at,
    evidence: (Array.isArray(row.evidence) ? row.evidence : []).map((e) => ({
      tier: e.tier,
      quote_verbatim: normalizeClaimText(e.quote_verbatim),
      source_url: e.source_url,
      raw_signal_id: e.raw_signal_id,
      source: e.source
    }))
  }));
}

// ============================================================================
// Context pack construction (design SS4.7)
// ============================================================================

function routeForTopic(topic) {
  if (typeof topic !== 'string') return null;
  for (const r of TOPIC_ROUTES) {
    if (topic.startsWith(r.prefix)) return r.subscorer;
  }
  return null;
}

function bestTierRank(claim) {
  let best = -1;
  for (const ev of claim.evidence) {
    const r = Object.prototype.hasOwnProperty.call(TIER_RANK, ev.tier) ? TIER_RANK[ev.tier] : -1;
    if (r > best) best = r;
  }
  return best;
}

// Cap + order: evidence.tier (documented -> discovered -> inferred) then claims.created_at
// desc (design SS4.7 / agents/README.md).
function orderAndCap(claimsList, cap) {
  const sorted = claimsList.slice().sort((a, b) => {
    const rb = bestTierRank(b);
    const ra = bestTierRank(a);
    if (rb !== ra) return rb - ra;
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });
  return sorted.slice(0, cap);
}

// gate.js header comment's hard contract: {claim_id, text_verbatim, topic, source_kind,
// evidence:[{tier, quote_verbatim, source_url, raw_signal_id, source}]}.
function toGateClaimShape(c) {
  return {
    claim_id: c.claim_id,
    text_verbatim: c.text_verbatim,
    topic: c.topic,
    source_kind: c.source_kind,
    evidence: c.evidence.map((e) => ({
      tier: e.tier,
      quote_verbatim: e.quote_verbatim,
      source_url: e.source_url,
      raw_signal_id: e.raw_signal_id,
      source: e.source
    }))
  };
}

// agents/README.md "Shared input contract" claim shape. `raw_signal_source` mirrors the
// first evidence row's (pre-joined) source, as a convenience field for the model -- the
// hard, backend-verified source-per-evidence-row data still travels in `evidence[]`,
// gate.js's step 5 never reads this convenience field.
function toPromptClaimShape(c) {
  const firstSource = c.evidence.length ? c.evidence[0].source : null;
  return {
    claim_id: c.claim_id,
    topic: c.topic,
    text_verbatim: c.text_verbatim,
    source_kind: c.source_kind,
    raw_signal_source: firstSource,
    evidence: c.evidence.map((e) => ({
      tier: e.tier,
      quote_verbatim: e.quote_verbatim,
      source_url: e.source_url
    }))
  };
}

// Returns { contextPacks, promptPayloads }. contextPacks feeds lib/f03/gate.js's
// applyGate() verbatim (its hard contract); promptPayloads feeds the 4 LLM calls
// (agents/README.md's shared input contract). Both are derived from the SAME per-pack
// claim subset, so claim_id references line up between what the model saw and what the
// gate verifies against.
function buildContextPacks(claims, founderRow, maxClaimsPerAgent) {
  const bySubscorer = {
    'execution-signals': [],
    'expertise-signals': [],
    'leadership-sales-proxies': []
  };
  for (const c of claims) {
    const route = routeForTopic(c.topic);
    if (route) bySubscorer[route].push(c);
    // design SS4.7 fallback: a claim matching no prefix goes to the union pack (red-flags)
    // rather than being dropped -- it already will be, below, since red-flags gets every
    // claim regardless of routing.
  }

  const packSources = {
    'execution-signals': bySubscorer['execution-signals'],
    'expertise-signals': bySubscorer['expertise-signals'],
    'leadership-sales-proxies': bySubscorer['leadership-sales-proxies'],
    'red-flags': claims.slice() // union of ALL claims, matched + unmatched
  };

  const founderHeader = {
    id: founderRow.id,
    full_name: founderRow.full_name,
    headline: founderRow.headline || null,
    location_country: founderRow.location_country || null
  };
  const companyHeader = founderRow.company
    ? {
        name: founderRow.company.name,
        one_liner: founderRow.company.one_liner,
        category: founderRow.company.category,
        stage: founderRow.company.stage
      }
    : null;

  const contextPacks = {};
  const promptPayloads = {};
  for (const subscorer of SUBSCORERS) {
    const capped = orderAndCap(packSources[subscorer], maxClaimsPerAgent);
    contextPacks[subscorer] = {
      claim_ids: capped.map((c) => c.claim_id),
      claims: capped.map(toGateClaimShape)
    };
    promptPayloads[subscorer] = {
      founder: founderHeader,
      company: companyHeader,
      claims: capped.map(toPromptClaimShape)
    };
  }
  return { contextPacks, promptPayloads };
}

function unionOfPackClaimIds(contextPacks) {
  const set = new Set();
  for (const subscorer of Object.keys(contextPacks)) {
    for (const id of contextPacks[subscorer].claim_ids) set.add(id);
  }
  return Array.from(set);
}

// ============================================================================
// Agent prompts + OpenAI calls
// ============================================================================

const _systemPromptCache = {};

function loadSystemPrompt(subscorer) {
  if (_systemPromptCache[subscorer]) return _systemPromptCache[subscorer];
  const file = path.join(AGENTS_DIR, SUBSCORER_SPEC_FILES[subscorer]);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/```xml\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error('run.js: could not find a ```xml fenced system prompt in ' + file);
  }
  _systemPromptCache[subscorer] = match[1];
  return match[1];
}

function httpsPostJson(host, urlPath, bodyObj, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: host,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch (_e) {
            return reject(new Error('run.js: non-JSON response from OpenAI (HTTP ' + res.statusCode + '): ' + text.slice(0, 300)));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error('run.js: OpenAI API error ' + res.statusCode + ': ' + JSON.stringify(json.error || json));
            err.statusCode = res.statusCode;
            err.body = json;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('run.js: OpenAI request timed out after 120s')));
    req.write(data);
    req.end();
  });
}

// design SS4.8: gpt-5.6-luna, temperature 0, JSON response format. Reasoning-tier models
// sometimes reject `temperature` outright -- retry once without it if the API says so,
// rather than hard-failing a $50-shared-budget run on a parameter-support guess.
async function callOpenAiChat(apiKey, systemPrompt, userContent, omitTemperature) {
  const body = {
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ]
  };
  if (!omitTemperature) body.temperature = 0;
  try {
    return await httpsPostJson('api.openai.com', '/v1/chat/completions', body, apiKey);
  } catch (err) {
    if (!omitTemperature && err && err.statusCode === 400 && /temperature/i.test(JSON.stringify(err.body || {}))) {
      return callOpenAiChat(apiKey, systemPrompt, userContent, true);
    }
    throw err;
  }
}

// Returns the PARSED agent JSON object (gate.js's rawAgentOutputs[subscorer] shape) on
// success, or {error: "<message>"} on any failure -- gate.js's step 8 (subscorerFailed())
// turns that into "every criterion of this sub-scorer is cannot_assess", so a single flaky
// agent call degrades the run rather than crashing it.
async function callAgentLive(apiKey, subscorer, promptPayload) {
  const systemPrompt = loadSystemPrompt(subscorer);
  const userContent = JSON.stringify(promptPayload);
  try {
    const resp = await callOpenAiChat(apiKey, systemPrompt, userContent, false);
    const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    if (typeof content !== 'string') {
      return { error: 'no message content in OpenAI response for ' + subscorer };
    }
    try {
      return JSON.parse(content);
    } catch (parseErr) {
      return { error: 'failed to parse ' + subscorer + ' agent JSON: ' + parseErr.message };
    }
  } catch (err) {
    return { error: 'OpenAI call failed for ' + subscorer + ': ' + err.message };
  }
}

function loadRecordedAgent(recordedDir, subscorer) {
  const file = path.join(recordedDir, subscorer + '.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('run.js: --recorded is missing ' + file + ' (' + e.message + ')');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('run.js: ' + file + ' is not valid JSON (' + e.message + ')');
  }
}

// ============================================================================
// Output contract (design SS4.9)
// ============================================================================

function findRedFlagRule(config, flagId) {
  const list = Array.isArray(config.red_flags)
    ? config.red_flags
    : config.red_flags && typeof config.red_flags === 'object'
    ? Object.values(config.red_flags)
    : [];
  return list.find((r) => r && String(r.id) === flagId) || null;
}

function extractRedFlags(rawRedFlags, config) {
  if (!rawRedFlags || typeof rawRedFlags !== 'object') return [];
  const arr = Array.isArray(rawRedFlags.flags)
    ? rawRedFlags.flags
    : Array.isArray(rawRedFlags.red_flags)
    ? rawRedFlags.red_flags
    : [];
  return arr
    .filter((f) => f && (f.flag_id != null || f.id != null))
    .map((f) => {
      const flagId = String(f.flag_id != null ? f.flag_id : f.id).trim();
      const rule = findRedFlagRule(config, flagId);
      return {
        id: flagId,
        severity: f.severity != null ? f.severity : null,
        contradicts: rule && Array.isArray(rule.contradicts) ? rule.contradicts : [],
        evidence: f.quote_verbatim ? [f.quote_verbatim] : []
      };
    });
}

function extractPedigree(rawExpertise) {
  const p = rawExpertise && typeof rawExpertise === 'object' && rawExpertise.pedigree && typeof rawExpertise.pedigree === 'object'
    ? rawExpertise.pedigree
    : {};
  return {
    prior_companies: Array.isArray(p.prior_companies) ? p.prior_companies : [],
    notable_employers: Array.isArray(p.notable_employers) ? p.notable_employers : [],
    scored: false,
    note: 'Displayed for context. Not scored — see design §3.2.'
  };
}

// Groups aggregate()'s augmented `components` by subscorer, preserving the order they
// arrive in (which follows config.criteria's registry order -- see gate.js's own
// Object.keys(criteriaBySubscorer) grouping, itself ordered by first occurrence in
// config.criteria, i.e. design SS3's table order: E1,E3,E4,E5,E7 / X1,X2,X5,X6 / L2,L3,L5).
function buildSubscorersBlock(components, config) {
  const order = [];
  const bySubscorer = {};
  for (const c of components) {
    if (!bySubscorer[c.subscorer]) {
      bySubscorer[c.subscorer] = [];
      order.push(c.subscorer);
    }
    bySubscorer[c.subscorer].push({
      id: c.criterion_id,
      verdict: c.verdict,
      credit: c.credit,
      weight: c.weight,
      contribution: c.contribution,
      evidence_tier: c.evidence_tier,
      claim_ids: c.claim_ids,
      quote_verbatim: c.quote_verbatim,
      rationale: c.rationale,
      demoted_by: c.demoted_by
    });
  }
  const weights = config.subscorer_weights || {};
  return order.map((name) => ({
    name,
    weight: weights[name] != null ? weights[name] : null,
    criteria: bySubscorer[name]
  }));
}

function buildContract(opts) {
  return {
    status: opts.status,
    founder_id: opts.founderId,
    run_id: opts.runId,
    score_id: opts.scoreId,
    axis: 'founder_score',
    value: opts.result.value,
    confidence: opts.result.confidence,
    coverage: opts.result.coverage,
    trend: opts.result.trend,
    formula_version: opts.formulaVersion,
    prompt_version: PROMPT_VERSION,
    model: MODEL,
    subscorers: buildSubscorersBlock(opts.result.components, opts.config),
    missing: opts.result.missing,
    red_flags: extractRedFlags(opts.rawAgentOutputs['red-flags'], opts.config),
    pedigree: extractPedigree(opts.rawAgentOutputs['expertise-signals'])
  };
}

// ============================================================================
// main
// ============================================================================

async function main() {
  const { founderId, recordedDir, recordDir } = parseArgs(process.argv);
  const databaseUrl = getDatabaseUrl();
  const runId = crypto.randomUUID();

  process.stderr.write('[f03/run] founder=' + founderId + ' run_id=' + runId + '\n');

  // 1. Load config (score_formulas.version lives OUTSIDE .config -- the caller folds it in;
  //    coordinator-confirmed convention, also required by scoring.js's trend guard).
  const formulaRow = loadActiveFormula(databaseUrl);
  const config = Object.assign({}, formulaRow.config, { version: formulaRow.version });
  process.stderr.write('[f03/run] loaded formula ' + formulaRow.version + '\n');

  // 2. Load founder + claims + previous score.
  const founderRow = loadFounderContext(databaseUrl, founderId);
  const claims = loadClaimsNormalized(databaseUrl, founderId);
  const previousScore = loadPreviousScore(databaseUrl, founderId);
  process.stderr.write('[f03/run] founder="' + founderRow.full_name + '" claims=' + claims.length +
    ' previous_score=' + (previousScore ? previousScore.value : 'none') + '\n');

  // 3. Build the 4 routed context packs.
  const maxClaimsPerAgent = config.max_claims_per_agent || 40;
  const { contextPacks, promptPayloads } = buildContextPacks(claims, founderRow, maxClaimsPerAgent);
  SUBSCORERS.forEach((s) => {
    process.stderr.write('[f03/run] pack ' + s + ': ' + contextPacks[s].claim_ids.length + ' claims\n');
  });

  // 4. Call the 4 agents (or replay recorded JSON).
  const rawAgentOutputs = {};
  if (recordedDir) {
    process.stderr.write('[f03/run] --recorded ' + recordedDir + ' (no API calls)\n');
    for (const s of SUBSCORERS) rawAgentOutputs[s] = loadRecordedAgent(recordedDir, s);
  } else {
    const apiKey = getOpenAiKey();
    if (!apiKey) {
      throw new Error('run.js: OPENAI_API_KEY not found in process.env or repo-root .env');
    }
    for (const s of SUBSCORERS) {
      process.stderr.write('[f03/run] calling ' + s + '...\n');
      rawAgentOutputs[s] = await callAgentLive(apiKey, s, promptPayloads[s]);
      if (rawAgentOutputs[s] && rawAgentOutputs[s].error) {
        process.stderr.write('[f03/run] WARNING ' + s + ' failed: ' + rawAgentOutputs[s].error + '\n');
      }
    }
    if (recordDir) {
      fs.mkdirSync(recordDir, { recursive: true });
      for (const s of SUBSCORERS) {
        fs.writeFileSync(path.join(recordDir, s + '.json'), JSON.stringify(rawAgentOutputs[s], null, 2) + '\n');
      }
      process.stderr.write('[f03/run] recorded 4 agent responses to ' + recordDir + '\n');
    }
  }

  // 5. Write ai_runs x4 -- always, before validation (design I8).
  writeAiRuns(databaseUrl, runId, founderId, rawAgentOutputs);
  process.stderr.write('[f03/run] wrote 4 ai_runs rows\n');

  // 6. Gate (SOURCE OF TRUTH -- lib/f03/gate.js, not modified here).
  const components = applyGate(rawAgentOutputs, contextPacks, config);

  // 7. Aggregate (SOURCE OF TRUTH -- lib/f03/scoring.js, not modified here).
  const result = aggregate(components, config, previousScore);
  process.stderr.write('[f03/run] status=' + result.status + ' value=' + result.value +
    ' confidence=' + result.confidence + ' coverage=' + result.coverage + ' trend=' + result.trend + '\n');

  // 8. Write results.
  const inputClaimIds = unionOfPackClaimIds(contextPacks);
  let scoreId = null;
  if (result.status === 'scored') {
    scoreId = writeScored(databaseUrl, founderId, result, formulaRow.version, inputClaimIds);
    process.stderr.write('[f03/run] wrote scores row ' + scoreId + '\n');
  } else {
    writeInsufficientEvidenceEvent(databaseUrl, runId, founderId, result);
    process.stderr.write('[f03/run] wrote events row (insufficient_evidence, no scores row)\n');
  }
  writeScoreComponents(databaseUrl, runId, founderId, scoreId, result.components);
  process.stderr.write('[f03/run] wrote ' + result.components.length + ' score_components rows\n');

  // 9. Print the SS4.9 contract.
  const contract = buildContract({
    status: result.status,
    founderId,
    runId,
    scoreId,
    result,
    formulaVersion: formulaRow.version,
    config,
    rawAgentOutputs
  });
  process.stdout.write(JSON.stringify(contract, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('run.js: FATAL: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  normalizeClaimText,
  routeForTopic,
  orderAndCap,
  buildContextPacks,
  unionOfPackClaimIds,
  extractRedFlags,
  extractPedigree,
  buildSubscorersBlock,
  buildContract
};
