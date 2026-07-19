#!/usr/bin/env node
// lib/f05/run.js
//
// Headless runner for feature 05 (Truth-Gap Check & Trust Score) --
// docs/backlog/05-truth-gap-trust/plan.md task B3. Mirrors lib/f02/f03/f07's
// run.js shape: makes the deterministic core demonstrable end to end without
// n8n. Unlike lib/f05/{router,trust,entity_gate,verifiers,quote_guard}.js this
// file is a Node CLI, not a Code-node body: it may require() freely and shells
// out to `psql` (team lead's own instruction for this task) -- the
// zero-import rule binds only the five sibling modules above, which get
// pasted verbatim into n8n Code nodes.
//
// Usage:
//   node lib/f05/run.js <application_id>
//
// Pipeline (design.md SS4-SS10, SS14; plan.md B3):
//   1. Load the active trust_v1 score_formulas row -> router config + rollup
//      config (min_coverage, version).
//   2. Resolve ctx = { applicationId, companyId, founderIds, runId } --
//      design SS8.1.
//   3. Load the FULL SS8.1 superset from claim_trust JOIN cards (the
//      column-contract reconciliation this task owns -- tracker.md's
//      "Column-contract reconciliation" section: `router_class AS class`,
//      plus `cards.application_id/company_id/founder_id`). Restrict
//      immediately via trust.js's own scopeClaimsToApplication() -- the
//      RESTRICTED set (not the superset) is what "claims in scope" means
//      everywhere below, including the claim_verification_attempted count.
//   4. Route every scoped claim via lib/f05/router.js (for the `check` hint
//      and the unmatched-topic flag -- the view already carries the
//      resulting class, so this is not a second classification, only the
//      audit metadata the view does not expose).
//   5. Run the two deterministic checks this feature ships in MVP (design
//      SS5.1): GitHub provenance vs Show HN date (check_id 'gh_provenance')
//      and the quote-salience fabrication guard (quote_guard, applied to
//      deck-sourced/self-reported claims carrying a quote). Denominator
//      extraction runs too, advisory-only (SS5.1c/B2 ruling: no evidence row).
//      Any confirmed contradiction candidate passes lib/f05/entity_gate.js
//      first (design SS6) -- step 3 (the LLM hook) is omitted, per this
//      task's brief ("owned by C1b").
//   6. Write evidence (batch, idempotent via content_hash), then re-read
//      claim_trust for the scoped claims to get post-write verdicts.
//   7. Write the audit events: claim_verification_attempted (mandatory, one
//      per scoped claim, design SS9), claim_verified / claim_contradicted on
//      a verdict transition, router_unmatched_topic, all through ONE
//      GDPR-safe writer (design SS9's anti-join: entity_id is always
//      founders.id when entity_type='founder', never claim_id).
//   8. Recompute the full scope from claim_trust (fresh) and feed
//      lib/f05/trust.js's computeTrustRollup() -- write scores(axis='trust')
//      or the trust_rollup_insufficient_evidence event (design SS8.2/SS8.3).
//   9. Write-back claims.verification_status best-effort, only after a
//      successful ('scored') rollup (design SS8.4).
//  10. Write ai_runs (confidence always NULL -- design SS6.0b) so the run_id
//      is traceable to something concrete even though every check here is
//      zero-LLM.
//  11. Print a summary contract to stdout as JSON.
//
// Env:
//   DATABASE_URL   read from process.env if set, else built from
//                  infra/supabase/.env's POOLER_TENANT_ID + POSTGRES_PASSWORD
//                  (Supavisor pooler on :54322 -- CLAUDE.md > Commands).
//
// docs/backlog/05-truth-gap-trust/plan.md, task B3.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { routeClaimTopic } = require('./router');
const { scopeClaimsToApplication, computeTrustRollup } = require('./trust');
const { applyEntityGate } = require('./entity_gate');
const { buildEvidenceRow, checkGithubProvenance, extractDenominator, sha256Hex } = require('./verifiers');
const { quoteSalienceMismatches } = require('./quote_guard');
const {
  buildSearchQuery,
  filterByTemporalCutoff,
  dedupeByRegistrableHost,
  isClaimsOwnCitation,
  passesRelevanceGate,
  classifySourceKind,
  decideEvidenceAction,
  selectClaimsWithinBudget,
  buildQuoteVerbatim,
} = require('./dynamic');

// ============================================================================
// Constants
// ============================================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// design.md SS9's full event list this feature writes.
const EVENT_VERIFICATION_ATTEMPTED = 'claim_verification_attempted';
const EVENT_VERIFIED = 'claim_verified';
const EVENT_CONTRADICTED = 'claim_contradicted';
const EVENT_UNMATCHED_TOPIC = 'router_unmatched_topic';

const ACTOR = 'lib/f05/run.js';

// ============================================================================
// CLI
// ============================================================================

function usageError(msg) {
  process.stderr.write('run.js: ' + msg + '\nUsage: node lib/f05/run.js <application_id>\n');
  process.exit(1);
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  if (rest.length === 0) usageError('missing <application_id>');
  const applicationId = rest[0];
  if (!UUID_RE.test(applicationId)) usageError('<application_id> must be a UUID, got "' + applicationId + '"');
  return { applicationId };
}

// ============================================================================
// .env loading (no dependencies -- same minimal parser as lib/f02/f03/run.js)
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
// Postgres access via psql -- identical safety rationale to lib/f03/run.js's
// psqlRun: every parameter travels through `-v NAME=value`, referenced via
// `:'NAME'` (psql's quote_literal-equivalent substitution), never string-
// concatenated into the SQL text; spawnSync passes argv as an array (no
// shell), so no argument is ever shell-interpreted either. SQL text goes in
// via `-f -` (stdin), not `-c` -- this repo's psql 16.13/17.x build does NOT
// perform `:'var'` interpolation under `-c` (verified by lib/f03/run.js).
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

// Postgres array-literal text for a `-v` substitution used as `:'name'::TYPE[]`.
function uuidArrayLiteral(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  return '{' + list.join(',') + '}';
}

// Same shape as uuidArrayLiteral, for the content_hash values used in
// insertRawSignalsAndResolveIds's select-back (task C3). Safe unquoted --
// every value here is a sha256 hex digest (lib/f05/verifiers.js's
// sha256Hex()), which contains no comma/brace/whitespace that could break
// out of the literal.
function hexArrayLiteral(hashes) {
  const list = Array.isArray(hashes) ? hashes.filter(Boolean) : [];
  return '{' + list.join(',') + '}';
}

// ============================================================================
// factual_dynamic (task C3) -- Tavily key, the live HTTP call, and the
// raw_signals write-and-resolve helper. Everything ELSE this branch needs
// (query building, temporal filtering, source classification, verdict
// decision, budget capping) is lib/f05/dynamic.js's own zero-import, unit-
// tested pure logic (lib/f05/dynamic.test.js) -- this file owns only the
// parts that module's own header says it deliberately does NOT: fetch() and
// psql, neither of which exists inside an n8n Code-node sandbox.
// ============================================================================

// TAVILY_API_KEY -- lib/f02/run.js's own getTavilyKey(), reproduced here
// rather than required from that file (a different feature's module; this
// project's own established per-file duplication convention for these few
// lines -- see e.g. lib/f05/ingest_commits.js's getGithubToken() header for
// the identical rationale). Never printed, never written to any file, never
// placed in a SQL or JSON literal -- used only as a Bearer header value.
function getTavilyKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  const env = parseDotEnv(path.join(REPO_ROOT, '.env'));
  return env.TAVILY_API_KEY || null;
}

// tavilySearchPost -- best-effort, NEVER fatal (lib/f02/run.js's own
// tavilyPost posture, restated here: "a Tavily failure must not kill a run
// whose [other] signals are already in hand" -- here, a run whose
// factual_static/qualitative claims are already processed). Returns the raw
// parsed response (`{results, usage, ...}`) or null.
async function tavilySearchPost(query, searchParams, key) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ query }, searchParams)),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  }
}

// hourTrunc -- lib/f02/pipeline.js's / lib/f05/ingest_commits.js's own
// helper, reproduced verbatim (same file-local-copy convention). Used ONLY
// as the observed_at FALLBACK for a Tavily result carrying no published_date
// (measured live 2026-07-19: the common case for search_depth:'basic' with
// no `topic` param -- see lib/f05/dynamic.js's filterByTemporalCutoff
// header). Two runs launched within the same clock hour hash identically
// (raw_signals content_hash, below) and are therefore idempotent, matching
// ingest_commits.js's own documented same-hour-only idempotency guarantee
// for this identical "live fetch, no natural per-fetch timestamp" situation.
function hourTrunc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// raw_signals content_hash -- lib/f02/normalize.js's OWN recipe
// (`sha256(source || '::' || source_id || '::' || observed_at)`), reused for
// the identical reason lib/f05/ingest_commits.js already reuses it rather
// than inventing a second one for this same table (that file's own header).
// `source_id` here is `query + '::' + url` -- the query disambiguates two
// DIFFERENT claims' searches that happen to surface the same url (rare but
// possible), which a bare url alone would collide on.
async function rawSignalContentHash(query, url, observedAt) {
  return sha256Hex(['tavily_search', query, url || '', observedAt].join('::'));
}

// insertRawSignalsAndResolveIds -- writes a batch of raw_signals rows
// (idempotent, ON CONFLICT (content_hash) DO NOTHING) and returns a
// Map<content_hash, id> covering EVERY row in the batch, whether just
// created or already present from an earlier run -- unlike
// lib/f05/ingest_commits.js's insertRawSignals (which only needs
// newly-created ids), THIS caller (runFactualDynamicCheck) needs the id
// regardless of which branch fired, because it is the FK the evidence row
// built from this exact result must carry (design.md SS2.1/SS10.2: every
// evidence row this feature writes needs a non-NULL raw_signal_id, and it
// must point at a row that carries founder_id/company_id at insert).
function insertRawSignalsAndResolveIds(databaseUrl, rows) {
  if (!rows.length) return new Map();
  const insertSql = `
    INSERT INTO raw_signals (source, source_url, payload, content_hash, founder_id, company_id, observed_at)
    SELECT
      r->>'source', r->>'source_url', r->'payload', r->>'content_hash',
      NULLIF(r->>'founder_id', '')::uuid, NULLIF(r->>'company_id', '')::uuid, (r->>'observed_at')::timestamptz
    FROM jsonb_array_elements(:'rows_json'::jsonb) AS r
    ON CONFLICT (content_hash) DO NOTHING;`;
  pgExec(databaseUrl, insertSql, { rows_json: JSON.stringify(rows) });

  const hashes = rows.map((r) => r.content_hash);
  const selectSql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT content_hash, id FROM raw_signals WHERE content_hash = ANY(:'hashes'::text[])
    ) t;`;
  const found = pgQueryJson(databaseUrl, selectSql, { hashes: hexArrayLiteral(hashes) }) || [];
  const map = new Map();
  for (const row of found) map.set(row.content_hash, row.id);
  return map;
}

// ============================================================================
// Reads
// ============================================================================

// design.md SS10 / seed.sql -- the single active trust_v1 row. LEFT-JOIN +
// literal-fallback discipline belongs to the VIEW (design SS7.5) and to
// trust.js's own DEFAULT_MIN_COVERAGE; this loader fails loudly if the row is
// entirely absent, since router.js has no built-in prefix map to fall back to
// (design SS4.1: "the module exports no built-in prefix map... a second
// hardcoded copy here would silently drift").
function loadActiveTrustFormula(databaseUrl) {
  const sql = `
    SELECT row_to_json(t) FROM (
      SELECT version, config FROM score_formulas WHERE axis = 'trust' AND active LIMIT 1
    ) t;`;
  const row = pgQueryJson(databaseUrl, sql, {});
  if (!row) throw new Error("run.js: no active score_formulas row for axis='trust' (db/seed.sql should have inserted trust_v1)");
  return row; // { version, config }
}

function loadApplication(databaseUrl, applicationId) {
  const sql = `
    SELECT row_to_json(t) FROM (
      SELECT id, company_id, created_at FROM applications WHERE id = :'application_id'::uuid
    ) t;`;
  const row = pgQueryJson(databaseUrl, sql, { application_id: applicationId });
  if (!row) throw new Error('run.js: no application found for id ' + applicationId);
  return row; // { id, company_id, created_at }
}

// design.md SS8.1's own instruction: founderIds is "resolved by the caller
// with a single-table lookup, not re-derived here" (lib/f05/trust.js header).
function loadFounderIdsForCompany(databaseUrl, companyId) {
  const sql = `
    SELECT COALESCE(json_agg(founder_id), '[]'::json)
    FROM founder_company WHERE company_id = :'company_id'::uuid;`;
  return pgQueryJson(databaseUrl, sql, { company_id: companyId }) || [];
}

// The SS8.1 SUPERSET (unrestricted route 3) joined to claim_trust, aliasing
// router_class -> class and supplying the three card FKs claim_trust does not
// expose (card_id only) -- tracker.md's "Column-contract reconciliation",
// this task's job, done once here rather than inside either frozen module.
// scopeClaimsToApplication() (lib/f05/trust.js) applies route 3's company_id
// restriction; this query intentionally does NOT, matching that module's own
// documented contract ("a caller may pass a superset and rely on this module
// for the restriction").
function loadScopeSuperset(databaseUrl, ctx) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT
        ct.claim_id, ct.topic, ct.text_verbatim, ct.source_kind,
        ct.router_class AS class, ct.derived_status,
        ct.n_supports, ct.n_contradicts, ct.n_independent,
        ct.trust, ct.independence_factor,
        k.application_id AS card_application_id,
        k.company_id     AS card_company_id,
        k.founder_id      AS card_founder_id
      FROM claim_trust ct
      JOIN cards k ON k.id = ct.card_id
      WHERE k.application_id = :'application_id'::uuid
         OR k.company_id     = :'company_id'::uuid
         OR k.founder_id      = ANY(:'founder_ids'::uuid[])
    ) t;`;
  return (
    pgQueryJson(databaseUrl, sql, {
      application_id: ctx.applicationId,
      company_id: ctx.companyId,
      founder_ids: uuidArrayLiteral(ctx.founderIds),
    }) || []
  );
}

// design.md SS5.1(b): raw_signals ALREADY in the database, grouped so a
// per-claim lookup is a JS map read, not an N+1 query. Only github_api (for
// extractEarliestCommitAuthorDate) and hn_algolia (for
// extractShowHnSubmittedAt) are relevant here.
function loadProvenanceRawSignals(databaseUrl, founderIds, companyIds) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT id, founder_id, company_id, source, source_url, payload
      FROM raw_signals
      WHERE source IN ('github_api', 'hn_algolia')
        AND (founder_id = ANY(:'founder_ids'::uuid[]) OR company_id = ANY(:'company_ids'::uuid[]))
    ) t;`;
  return (
    pgQueryJson(databaseUrl, sql, {
      founder_ids: uuidArrayLiteral(founderIds),
      company_ids: uuidArrayLiteral(companyIds),
    }) || []
  );
}

// design.md SS5.1(a) call-site measurement (A3/tracker.md): "deck-sourced OR
// self-reported, carrying a quote". DISTINCT ON picks the earliest-created
// qualifying evidence row per claim -- a claim with more than one qualifying
// row is not expected in this corpus, but the tie-break must be deterministic
// either way.
//
// ⚠️ `e.relation = 'supports'` is load-bearing, found by this task's own
// exploratory sweep of the live corpus: without it, a claim whose ONLY
// quote-bearing evidence row is a `contradicts` row planted by an unrelated
// mechanism (feature 03's red-flag machinery on claim
// 03f00006-...-0103; db/fixtures/05-truth-gap.sql's own SS14 claim 204) gets
// compared against that UNRELATED contradicting source instead of its own
// cited support -- quote_guard's whole premise (design SS5.1(a)) is "does the
// claim overstate what ITS OWN citation says", not a second, coincidental
// pass over evidence another check already wrote for a different reason.
function loadQuoteGuardCandidates(databaseUrl, claimIds) {
  if (!claimIds.length) return [];
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT DISTINCT ON (e.claim_id)
        e.claim_id, e.quote_verbatim, e.source_url, e.raw_signal_id,
        rs.payload, rs.founder_id AS rs_founder_id, rs.company_id AS rs_company_id, rs.source AS rs_source
      FROM evidence e
      JOIN raw_signals rs ON rs.id = e.raw_signal_id
      JOIN claims cl ON cl.id = e.claim_id
      WHERE e.claim_id = ANY(:'claim_ids'::uuid[])
        AND e.relation = 'supports'
        AND e.quote_verbatim IS NOT NULL
        AND (cl.source_kind = 'self_reported' OR rs.source = 'deck_parse')
      ORDER BY e.claim_id, e.created_at
    ) t;`;
  return pgQueryJson(databaseUrl, sql, { claim_ids: uuidArrayLiteral(claimIds) }) || [];
}

// Entity gate step 2 (registrable-domain match) + human-readable
// disambiguators for step 1's resolvedResult() -- design SS6.
function loadEntityContext(databaseUrl, founderIds, companyIds) {
  const foundersSql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT id, full_name FROM founders WHERE id = ANY(:'founder_ids'::uuid[])
    ) t;`;
  const companiesSql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT id, name, domain, aliases FROM companies WHERE id = ANY(:'company_ids'::uuid[])
    ) t;`;
  const founders = pgQueryJson(databaseUrl, foundersSql, { founder_ids: uuidArrayLiteral(founderIds) }) || [];
  const companies = pgQueryJson(databaseUrl, companiesSql, { company_ids: uuidArrayLiteral(companyIds) }) || [];
  const founderById = new Map(founders.map((f) => [f.id, f]));
  const companyById = new Map(companies.map((c) => [c.id, c]));
  return { founderById, companyById };
}

// ============================================================================
// Writes -- batch, one JSON-array parameter per call (lib/f03/run.js's
// writeScoreComponents/writeScored pattern: a whole array travels as ONE
// jsonb `-v` value, unpacked server-side via jsonb_array_elements -- avoids an
// N-small-calls round trip per claim).
// ============================================================================

// evidence.content_hash is NOT NULL UNIQUE (design SS10.1) -- ON CONFLICT DO
// NOTHING is what makes a re-run of this file idempotent at the evidence
// layer (acceptance 3: "run twice -> zero duplicate evidence rows").
function writeEvidenceRows(databaseUrl, rows) {
  if (!rows.length) return;
  const sql = `
    INSERT INTO evidence (claim_id, relation, tier, strength, quote_verbatim, source_url, raw_signal_id, content_hash)
    SELECT
      (r->>'claim_id')::uuid, r->>'relation', r->>'tier',
      NULLIF(r->>'strength', '')::numeric,
      r->>'quote_verbatim', r->>'source_url',
      (r->>'raw_signal_id')::uuid, r->>'content_hash'
    FROM jsonb_array_elements(:'rows_json'::jsonb) AS r
    ON CONFLICT (content_hash) DO NOTHING;`;
  pgExec(databaseUrl, sql, { rows_json: JSON.stringify(rows) });
}

// events has no uniqueness of its own (append-only ledger, project-wide
// convention -- e.g. lib/f02/run.js's radar_scan_completed row on every
// --write run) -- no ON CONFLICT here, a re-run legitimately appends a fresh
// batch. `entity_id` is ALWAYS supplied by the caller (never derived here)
// so the GDPR anti-join (design SS9) is structurally the caller's
// responsibility, enforced by buildAttemptedEventRow/buildTransitionEventRows
// below, not by this generic writer.
function writeEvents(databaseUrl, rows) {
  if (!rows.length) return;
  const sql = `
    INSERT INTO events (event_type, entity_type, entity_id, payload, actor)
    SELECT r->>'event_type', r->>'entity_type', (r->>'entity_id')::uuid, r->'payload', r->>'actor'
    FROM jsonb_array_elements(:'rows_json'::jsonb) AS r;`;
  pgExec(databaseUrl, sql, { rows_json: JSON.stringify(rows) });
}

// design.md SS6.0b: confidence is a literal SQL NULL here, not read from the
// JSON payload -- structural enforcement that no LLM in this feature ever
// reports a confidence number, belt-and-suspenders over the JS side never
// setting one.
function writeAiRuns(databaseUrl, rows) {
  if (!rows.length) return;
  const sql = `
    INSERT INTO ai_runs (task_type, founder_id, company_id, application_id, model, output_json, confidence)
    SELECT
      r->>'task_type',
      NULLIF(r->>'founder_id', '')::uuid,
      NULLIF(r->>'company_id', '')::uuid,
      NULLIF(r->>'application_id', '')::uuid,
      r->>'model', r->'output_json', NULL
    FROM jsonb_array_elements(:'rows_json'::jsonb) AS r;`;
  pgExec(databaseUrl, sql, { rows_json: JSON.stringify(rows) });
}

// design.md SS8.4 -- best-effort write-back of the view's derived_status into
// claims.verification_status (the one mutable column on an otherwise
// SS5.3-append-mostly table). Never throws; a failure here must not block a
// rollup that already succeeded.
function writeBackVerificationStatus(databaseUrl, rows) {
  if (!rows.length) return;
  const sql = `
    UPDATE claims c SET verification_status = v.status, updated_at = now()
    FROM (
      SELECT (r->>'claim_id')::uuid AS claim_id, r->>'status' AS status
      FROM jsonb_array_elements(:'rows_json'::jsonb) AS r
    ) v
    WHERE c.id = v.claim_id;`;
  try {
    pgExec(databaseUrl, sql, { rows_json: JSON.stringify(rows) });
  } catch (err) {
    process.stderr.write('run.js: WARNING write-back of verification_status failed (best-effort, non-fatal): ' + err.message + '\n');
  }
}

// design.md SS8.2/SS8.3: no idempotency guard on scores by design ("accept
// duplicates under append-only semantics... resolve current by
// max(computed_at)") -- a plain INSERT, matching lib/f03/run.js's writeScored.
function writeScoreRow(databaseUrl, scoresRow) {
  const sql = `
    INSERT INTO scores (application_id, founder_id, axis, value, confidence, missing_flags, input_claim_ids, formula_version, model)
    SELECT
      (j->>'application_id')::uuid, NULL, 'trust',
      (j->>'value')::numeric, (j->>'confidence')::numeric,
      COALESCE(j->'missing_flags', '{}'::jsonb),
      COALESCE((SELECT array_agg(x)::uuid[] FROM jsonb_array_elements_text(j->'input_claim_ids') AS x), '{}'::uuid[]),
      j->>'formula_version', NULL
    FROM (SELECT :'score_json'::jsonb AS j) t
    RETURNING id;`;
  return psqlRun(databaseUrl, sql, { score_json: JSON.stringify(scoresRow) }).trim();
}

// ============================================================================
// Event-row builders -- GDPR anti-join is enforced HERE, structurally, by
// always deriving entity_id from the claim's own card (never claim_id).
// design.md SS9: entity_type='founder' => entity_id MUST be founders.id;
// entity_type='application' is the safe fallback for a company-scoped card
// with no resolvable founder, and on THAT fallback the payload must omit
// founder_claim / entity_match.quote (design SS9, restated SS14).
// ============================================================================

function entityForClaim(row, ctx) {
  if (row.card_founder_id) return { entityType: 'founder', entityId: row.card_founder_id };
  return { entityType: 'application', entityId: ctx.applicationId };
}

function buildAttemptedEventRow(row, routing, verdictAfter, ctx, checkedAt, extra) {
  const { entityType, entityId } = entityForClaim(row, ctx);
  const payload = Object.assign(
    {
      claim_id: row.claim_id,
      class: row.class,
      check: routing.check,
      verdict_before: row.derived_status,
      verdict_after: verdictAfter,
      checked_at: checkedAt,
      run_id: ctx.runId,
    },
    extra || {}
  );
  return { event_type: EVENT_VERIFICATION_ATTEMPTED, entity_type: entityType, entity_id: entityId, payload, actor: ACTOR };
}

function buildUnmatchedTopicEventRow(row, ctx, checkedAt) {
  const { entityType, entityId } = entityForClaim(row, ctx);
  return {
    event_type: EVENT_UNMATCHED_TOPIC,
    entity_type: entityType,
    entity_id: entityId,
    payload: { claim_id: row.claim_id, topic: row.topic, run_id: ctx.runId, checked_at: checkedAt },
    actor: ACTOR,
  };
}

function buildVerifiedEventRow(row, routing, verdictAfter, sourceUrl, ctx, checkedAt) {
  const { entityType, entityId } = entityForClaim(row, ctx);
  return {
    event_type: EVENT_VERIFIED,
    entity_type: entityType,
    entity_id: entityId,
    payload: {
      claim_id: row.claim_id,
      class: row.class,
      check: routing.check,
      verdict_before: row.derived_status,
      verdict_after: verdictAfter,
      source_url: sourceUrl || null,
      checked_at: checkedAt,
      run_id: ctx.runId,
    },
    actor: ACTOR,
  };
}

// design.md SS6.1 + SS6.2's union object. On the entity_type='application'
// fallback (no resolvable founder on this claim's card), founder_claim and
// entity_match.quote are OMITTED -- design SS9's explicit rule, restated
// SS14 -- so an unpurgeable event never carries personal data.
//
// ⚠️ Caught by lib/f05/run.test.js during this task's own build: an earlier
// version of this function put `entity_match` (quote included) inside `base`,
// the object BOTH branches share -- the application-fallback branch reused
// `base` as-is and the quote leaked straight through, silently defeating the
// one rule this function exists to enforce. `entity_match` is therefore built
// per-branch below, never inside the shared `base`.
function buildContradictedEventRow(row, routing, verdictAfter, ctx, checkedAt, contradiction) {
  const { entityType, entityId } = entityForClaim(row, ctx);
  const base = {
    claim_id: row.claim_id,
    class: row.class,
    check: routing.check,
    verdict_before: row.derived_status,
    verdict_after: verdictAfter,
    source_url: contradiction.sourceUrl || null,
    checked_at: checkedAt,
    run_id: ctx.runId,
    nature: contradiction.nature,
    severity: contradiction.severity,
    found_reality: contradiction.foundReality,
    question: contradiction.question,
  };
  const payload =
    entityType === 'application'
      ? Object.assign({}, base, {
          // resolved_by/disambiguator kept (never personal on this fallback --
          // entityForClaim only reaches here when card_founder_id is null, so
          // entity_gate.js's own disambiguator can only ever be company-shaped
          // here); `.quote` is the one field design SS9 names explicitly.
          entity_match: contradiction.entityMatch
            ? { resolved_by: contradiction.entityMatch.resolved_by, disambiguator: contradiction.entityMatch.disambiguator }
            : null,
        })
      : Object.assign({ founder_claim: row.text_verbatim }, base, {
          entity_match: contradiction.entityMatch, // keep the quote -- personal data is fine on a founder-scoped, purgeable event
        });
  return { event_type: EVENT_CONTRADICTED, entity_type: entityType, entity_id: entityId, payload, actor: ACTOR };
}

// ============================================================================
// Check dispatch -- design.md SS5.1: exactly two deterministic checks ship in
// this MVP (gh_provenance, quote_guard) plus denominator extraction
// (advisory only, B2 ruling: writes no evidence row). Every OTHER `check`
// hint the router table carries (gh_merged_pr, gh_commit_weeks, url_liveness,
// gh_dependents, competitor_exists, web_traction) is documentation of the
// DESIGNED shape, per design SS5.1(b)'s own scope ruling ("the rest is
// documented here... built only if the clock allows") -- this file does not
// invent implementations for them; such claims simply carry whatever
// supports/contradicts evidence an upstream feature (02/04) already wrote,
// same as every other verdict-eligible claim this run does not otherwise
// touch.
// ============================================================================

async function runGithubProvenanceCheck(row, rawSignalsByEntity, entityContext, ctx) {
  const founderId = row.card_founder_id;
  const companyId = row.card_company_id;
  const key = founderId || companyId;
  const bucket = rawSignalsByEntity.get(key) || { commitPayloads: [], hnPayloads: [], githubSignal: null };

  const result = checkGithubProvenance({ commitPayloads: bucket.commitPayloads, hnPayloads: bucket.hnPayloads });

  if (result.status === 'insufficient_data') {
    // design.md SS9: "a check that ran and found nothing writes tier='missing',
    // relation='context' evidence" -- only when there is at least one
    // github_api raw_signal to attach as raw_signal_id (SS2.1's non-NULL
    // requirement); with zero raw_signals reachable there is nothing to cite
    // and this file does not fabricate a foreign key.
    if (!bucket.githubSignal) return { evidenceRow: null, contradiction: null, checkRan: bucket.commitPayloads.length > 0 || bucket.hnPayloads.length > 0 };
    const evidenceRow = await buildEvidenceRow({
      claimId: row.claim_id,
      relation: 'context',
      tier: 'missing',
      quoteVerbatim: null,
      sourceUrl: null,
      rawSignalId: bucket.githubSignal,
      checkId: 'gh_provenance',
      candidateKey: 'insufficient_data',
    });
    return { evidenceRow, contradiction: null, checkRan: true };
  }

  if (result.status === 'clean') {
    const evidenceRow = await buildEvidenceRow({
      claimId: row.claim_id,
      relation: 'supports',
      tier: 'documented',
      quoteVerbatim: result.summary,
      sourceUrl: bucket.githubSourceUrl || null,
      rawSignalId: bucket.githubSignal,
      checkId: 'gh_provenance',
      candidateKey: result.earliestCommitAuthorDate,
    });
    // design.md SS6: "Only CONTRADICTION candidates ever reach this gate" --
    // a supports row carries no false-accusation risk and is written directly.
    return { evidenceRow, contradiction: null, checkRan: true };
  }

  // status === 'flagged' -- a contradiction CANDIDATE, must pass the entity
  // gate before it may become a `contradicts` row (design SS6).
  const entity = buildEntityForRow(row, entityContext);
  const gate = await applyEntityGate({
    claimId: row.claim_id,
    candidate: { sourceUrl: bucket.githubSourceUrl || null, quote: result.summary, tier: 'documented' },
    rawSignal: { id: bucket.githubSignal, founderId: bucket.rsFounderId, companyId: bucket.rsCompanyId },
    entity,
  });

  if (gate.resolved) {
    const evidenceRow = await buildEvidenceRow({
      claimId: row.claim_id,
      relation: 'contradicts',
      tier: 'documented',
      quoteVerbatim: result.summary,
      sourceUrl: bucket.githubSourceUrl || null,
      rawSignalId: bucket.githubSignal,
      checkId: 'gh_provenance',
      candidateKey: result.earliestCommitAuthorDate,
    });
    return {
      evidenceRow,
      contradiction: {
        sourceUrl: bucket.githubSourceUrl || null,
        nature: 'temporal',
        severity: 'material',
        foundReality: result.summary,
        question:
          'Can you walk us through the development history of this repository -- specifically why the earliest ' +
          'commit postdates your own earliest public trace by ' + result.gapDays + ' day(s)?',
        entityMatch: gate.entityMatch,
      },
      checkRan: true,
    };
  }

  // Step 4 downgrade -- the candidate is never silently dropped (design SS6).
  const contextRow = await buildEvidenceRow({
    claimId: gate.contextRowFields.claimId,
    relation: gate.contextRowFields.relation,
    tier: gate.contextRowFields.tier,
    quoteVerbatim: gate.contextRowFields.quoteVerbatim,
    sourceUrl: gate.contextRowFields.sourceUrl,
    rawSignalId: gate.contextRowFields.rawSignalId,
    checkId: gate.contextRowFields.checkId,
    candidateKey: gate.contextRowFields.candidateKey,
  });
  return { evidenceRow: contextRow, contradiction: null, checkRan: true };
}

function buildEntityForRow(row, entityContext) {
  const founder = row.card_founder_id ? entityContext.founderById.get(row.card_founder_id) : null;
  const company = row.card_company_id ? entityContext.companyById.get(row.card_company_id) : null;
  return {
    founderId: row.card_founder_id || null,
    companyId: row.card_company_id || null,
    founderName: founder ? founder.full_name : null,
    companyName: company ? company.name : null,
    companyDomain: company ? company.domain : null,
    companyAliases: company ? company.aliases : [],
  };
}

// Common text fields raw_signals.payload carries the underlying document
// under, across the sources this corpus actually uses (deck_parse: `text`;
// tavily_extract: `extracted_text`; hn_algolia: `story_text`; interview_answer:
// `answer`). Returns '' (not null) when none is present -- quoteSalienceMismatches
// treats an empty source as "nothing to compare", not a crash (its own guard).
function extractSourceText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['text', 'extracted_text', 'story_text', 'readme_excerpt', 'answer'];
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  return '';
}

async function runQuoteGuardCheck(row, candidate, entityContext, ctx) {
  const sourceText = extractSourceText(candidate.payload);
  const mismatches = quoteSalienceMismatches(row.text_verbatim, sourceText);
  if (!mismatches.length) return { evidenceRow: null, contradiction: null };

  const foundReality = mismatches.join('; ');
  const entity = buildEntityForRow(row, entityContext);
  const gate = await applyEntityGate({
    claimId: row.claim_id,
    candidate: { sourceUrl: candidate.source_url || null, quote: foundReality, tier: 'documented' },
    rawSignal: { id: candidate.raw_signal_id, founderId: candidate.rs_founder_id, companyId: candidate.rs_company_id },
    entity,
  });

  if (gate.resolved) {
    const evidenceRow = await buildEvidenceRow({
      claimId: row.claim_id,
      relation: 'contradicts',
      tier: 'documented',
      quoteVerbatim: foundReality,
      sourceUrl: candidate.source_url || null,
      rawSignalId: candidate.raw_signal_id,
      checkId: 'quote_guard',
      candidateKey: foundReality,
    });
    return {
      evidenceRow,
      contradiction: {
        sourceUrl: candidate.source_url || null,
        nature: 'factual',
        severity: 'material',
        foundReality,
        question:
          "Can you walk us through the figure(s) behind this claim -- our review of the cited source found: " + foundReality,
        entityMatch: gate.entityMatch,
      },
    };
  }

  const contextRow = await buildEvidenceRow({
    claimId: gate.contextRowFields.claimId,
    relation: gate.contextRowFields.relation,
    tier: gate.contextRowFields.tier,
    quoteVerbatim: gate.contextRowFields.quoteVerbatim,
    sourceUrl: gate.contextRowFields.sourceUrl,
    rawSignalId: gate.contextRowFields.rawSignalId,
    checkId: gate.contextRowFields.checkId,
    candidateKey: gate.contextRowFields.candidateKey,
  });
  return { evidenceRow: contextRow, contradiction: null };
}

// ============================================================================
// runFactualDynamicCheck -- task C3, design.md SS5.2/SS10.2. Unlike the two
// checks above (at most one evidence row each), this branch may write
// SEVERAL rows per claim -- one per independent surviving source
// (lib/f05/dynamic.js's dedupeByRegistrableHost, design SS7.3) -- so it
// returns an ARRAY, and the caller (main(), below) spreads it into the
// shared evidenceRows batch rather than pushing a single value.
//
// `cache` is a Map<query, {results}> the CALLER owns and passes in, shared
// across every claim processed in one run() invocation -- several claims in
// this corpus are near-duplicate deck text on the SAME company (measured
// live 2026-07-19: e.g. two claim rows both reading "GameLoop has been
// generating revenue from real users for the past five months"), and this
// cache is what keeps a second, functionally-identical query from spending a
// second Tavily credit within the same run ("be economical", team lead's own
// instruction) -- it is NOT a cross-run cache; each invocation of run.js
// starts with an empty one, so re-run idempotency (acceptance criterion 3)
// is unaffected by it.
async function runFactualDynamicCheck(params) {
  const { row, company, cutoffIso, tavilyKey, cache, checkedAtHour, databaseUrl, entityContext, ctx } = params;

  const { query, params: searchParams } = buildSearchQuery(row, company);

  let results;
  let creditsUsed = 0;
  if (cache.has(query)) {
    results = cache.get(query).results;
  } else {
    const resp = await tavilySearchPost(query, searchParams, tavilyKey);
    if (!resp) {
      // Best-effort, never fatal (this function's own header note) -- an
      // empty result set is cached too, so a second near-duplicate claim in
      // the SAME run does not retry a query that just failed.
      cache.set(query, { results: [] });
      return { evidenceRows: [], contradiction: null, creditsUsed: 0 };
    }
    results = Array.isArray(resp.results) ? resp.results : [];
    creditsUsed = (resp.usage && resp.usage.credits) || 0;
    cache.set(query, { results });
  }

  const { kept } = filterByTemporalCutoff(results, cutoffIso);
  // Cap 5 -- design SS7.2's independence_factor already saturates at
  // n_independent=3 (indep_base 0.70 + indep_step 0.15 x 2 = indep_max
  // 1.00); 5 leaves headroom for a couple of the deduped hosts to fail the
  // relevance gate below without starving the claim of everything the
  // formula could actually use, while still bounding the raw_signals/
  // evidence volume one claim can generate from a single search.
  const deduped = dedupeByRegistrableHost(kept).slice(0, 5);

  const candidates = [];
  for (const result of deduped) {
    // A result whose url is the CLAIM'S OWN inline-cited source (this
    // corpus's convention, measured live -- see isClaimsOwnCitation's own
    // header) is the claim finding its own footnote, not new independent
    // corroboration; skipped before the relevance gate even runs.
    if (isClaimsOwnCitation(row.text_verbatim, result.url)) continue;
    if (!passesRelevanceGate(company && company.name, row.text_verbatim, result)) continue;
    const sourceKind = classifySourceKind(result.url, company);
    const mismatches = quoteSalienceMismatches(row.text_verbatim, result.content || '');
    const decision = decideEvidenceAction({ hasMismatch: mismatches.length > 0, sourceKind });
    candidates.push({ result, sourceKind, mismatches, action: decision.action, tier: decision.tier });
  }
  if (candidates.length === 0) return { evidenceRows: [], contradiction: null, creditsUsed };

  // ---- raw_signals FIRST (design SS10.2), founder_id/company_id from the
  // CLAIM's own card -- required at insert, GDPR purge-scoping (SS10.2's own
  // restated warning: feature 04 left nine permanently-unpurgeable orphans by
  // skipping this). observed_at = the result's own published_date when
  // known, else the hour-truncated run start (this file's hourTrunc header).
  const rawSignalRows = [];
  for (const c of candidates) {
    const observedAt =
      typeof c.result.published_date === 'string' && Number.isFinite(Date.parse(c.result.published_date))
        ? c.result.published_date
        : checkedAtHour;
    const contentHash = await rawSignalContentHash(query, c.result.url, observedAt);
    c.contentHash = contentHash;
    rawSignalRows.push({
      source: 'tavily_search',
      source_url: c.result.url || null,
      payload: c.result,
      content_hash: contentHash,
      founder_id: row.card_founder_id || null,
      company_id: row.card_company_id || null,
      observed_at: observedAt,
    });
  }
  const hashToId = insertRawSignalsAndResolveIds(databaseUrl, rawSignalRows);

  // ⚠️ POST-INCIDENT RULING (team lead, after this branch's own live test run
  // flipped 2 claims to `verified` off a same-named-but-unrelated company's
  // marketing page): entity_gate.js's own header scopes itself to
  // CONTRADICTION candidates only ("supports evidence carries no
  // false-accusation risk"), which is correct for gh_provenance/quote_guard
  // (their raw_signals FK comes from an INDEPENDENT identity-resolution
  // process that ran before this feature touched the row -- feature 02's
  // writer, or ingest_commits.js's checkable-founder resolution -- so a
  // step-1/step-2 match there really is evidence the CONTENT is about the
  // right entity). It is NOT correct for THIS branch: false CORROBORATION
  // from an open web search is at least as dangerous as false contradiction
  // -- `verified` is the label an investor actually trusts, and minting one
  // off a same-named unrelated site is a textbook REQ-004 fabrication, not a
  // merely-annoying false positive. So the gate runs for BOTH actions here,
  // not only 'contradicts'. This is a deliberate, narrower-than-the-file's
  // own-stated-scope use of applyEntityGate() by THIS caller alone --
  // gh_provenance/quote_guard above are unaffected and still gate contradicts
  // only, per the reasoning that remains correct for them.
  const evidenceRows = [];
  let contradiction = null;
  for (const c of candidates) {
    const rawSignalId = hashToId.get(c.contentHash);
    if (!rawSignalId) continue; // defensive; the batch insert-then-select-back above should always resolve this
    const quoteVerbatim = buildQuoteVerbatim(c.result);
    const candidateKey = c.result.url || quoteVerbatim;

    // `rawSignal` carries ONLY the real id, no founderId/companyId --
    // DELIBERATE, not an oversight, and not the same as omitting it entirely
    // (an earlier version of this function passed `rawSignal: null` for the
    // contradicts-only path, which also zeroed out `gate.contextRowFields
    // .rawSignalId` on a downgrade -- entity_gate.js derives that field from
    // this SAME param -- and would have thrown inside buildEvidenceRow the
    // first time a downgrade actually fired, since rawSignalId is required
    // there; never caught live because no downgrade had fired yet). This
    // shape keeps BOTH properties true at once: step 1 cannot resolve
    // trivially off our own insert-time FK assignment (rawSignal.founderId/
    // companyId are undefined, so neither of step 1's comparisons can ever
    // be truthy), while step 4's downgrade still has a real, valid
    // raw_signal_id to cite in its context row.
    const entity = buildEntityForRow(row, entityContext);
    const gate = await applyEntityGate({
      claimId: row.claim_id,
      candidate: { sourceUrl: c.result.url || null, quote: quoteVerbatim, tier: c.tier },
      rawSignal: { id: rawSignalId },
      entity,
    });

    if (gate.resolved) {
      const evidenceRow = await buildEvidenceRow({
        claimId: row.claim_id, relation: c.action, tier: c.tier,
        quoteVerbatim, sourceUrl: c.result.url || null, rawSignalId,
        checkId: 'tavily_dynamic', candidateKey,
      });
      evidenceRows.push(evidenceRow);
      if (c.action === 'contradicts' && !contradiction) {
        const foundReality = c.mismatches.length ? c.mismatches.join('; ') : quoteVerbatim;
        contradiction = {
          sourceUrl: c.result.url || null,
          nature: 'factual',
          // design SS6.0/this file's own header note: this branch never
          // reaches documented tier, so the strongest a factual_dynamic
          // finding gets here is 'moderate', never the 'material' this
          // codebase reserves for a documented-tier finding elsewhere
          // (lib/f05/run.js's own gh_provenance/quote_guard branches).
          severity: 'moderate',
          foundReality,
          question:
            'An independent web source we checked reads differently from this claim (' + foundReality +
            ') -- can you help reconcile the two?',
          entityMatch: gate.entityMatch,
        };
      }
    } else {
      // Failing the gate must not silently drop the evidence (team lead
      // ruling, restating design SS6's own "the candidate is not silently
      // dropped; the attempt is auditable") -- for a SUPPORTS candidate this
      // means a same-named-but-unresolved site is recorded as `context`, not
      // quietly discarded and not promoted to `verified` either.
      const contextRow = await buildEvidenceRow(gate.contextRowFields);
      evidenceRows.push(contextRow);
    }
  }

  return { evidenceRows, contradiction, creditsUsed };
}

// ============================================================================
// main
// ============================================================================

async function main() {
  const { applicationId } = parseArgs(process.argv);
  const databaseUrl = getDatabaseUrl();
  const runId = crypto.randomUUID();
  const checkedAt = new Date().toISOString();
  const checkedAtHour = hourTrunc(checkedAt);

  process.stderr.write('[f05/run] application=' + applicationId + ' run_id=' + runId + '\n');

  // 1. Load config.
  const formulaRow = loadActiveTrustFormula(databaseUrl);
  const routerConfig = formulaRow.config.router || {};
  const rollupConfig = { version: formulaRow.version, min_coverage: formulaRow.config.rollup && formulaRow.config.rollup.min_coverage };
  // task C3 (design SS12): "capped per card in config" -- seed.sql placeholder 5.
  const maxPaidChecksPerCard =
    formulaRow.config.budget && typeof formulaRow.config.budget.max_paid_checks_per_card === 'number'
      ? formulaRow.config.budget.max_paid_checks_per_card
      : 5;

  // 2. Resolve ctx.
  const app = loadApplication(databaseUrl, applicationId);
  const founderIds = loadFounderIdsForCompany(databaseUrl, app.company_id);
  const ctx = { applicationId, companyId: app.company_id, founderIds, runId };
  process.stderr.write('[f05/run] company=' + app.company_id + ' founders=' + founderIds.length + '\n');

  // 3. Load the SS8.1 superset, then restrict via trust.js's own predicate --
  //    THIS restricted set is "claims in scope" for every count below.
  const superset = loadScopeSuperset(databaseUrl, ctx);
  const scopedRows = scopeClaimsToApplication(superset, ctx);
  process.stderr.write('[f05/run] superset=' + superset.length + ' scoped=' + scopedRows.length + '\n');

  // 4. Route every scoped claim (check hint + unmatched flag).
  const routingByClaim = new Map();
  for (const row of scopedRows) routingByClaim.set(row.claim_id, routeClaimTopic(row.topic, routerConfig));

  // 5a. Load raw_signals for the gh_provenance check, grouped by founder/company.
  const companyIds = Array.from(new Set(scopedRows.map((r) => r.card_company_id).filter(Boolean)));
  const rawProvenanceSignals = loadProvenanceRawSignals(databaseUrl, founderIds, companyIds.length ? companyIds : [app.company_id]);
  const rawSignalsByEntity = new Map();
  for (const rs of rawProvenanceSignals) {
    const key = rs.founder_id || rs.company_id;
    if (!key) continue;
    if (!rawSignalsByEntity.has(key)) {
      rawSignalsByEntity.set(key, { commitPayloads: [], hnPayloads: [], githubSignal: null, githubSourceUrl: null, rsFounderId: null, rsCompanyId: null });
    }
    const bucket = rawSignalsByEntity.get(key);
    if (rs.source === 'github_api') {
      bucket.commitPayloads.push(rs.payload);
      if (!bucket.githubSignal) {
        bucket.githubSignal = rs.id;
        bucket.githubSourceUrl = rs.source_url;
        bucket.rsFounderId = rs.founder_id;
        bucket.rsCompanyId = rs.company_id;
      }
    } else if (rs.source === 'hn_algolia') {
      bucket.hnPayloads.push(rs.payload);
    }
  }

  // 5b. Load quote_guard candidates.
  const claimIds = scopedRows.map((r) => r.claim_id);
  const quoteCandidates = loadQuoteGuardCandidates(databaseUrl, claimIds);
  const quoteCandidateByClaim = new Map(quoteCandidates.map((c) => [c.claim_id, c]));

  // 5c. Entity context for the gate.
  const entityContext = loadEntityContext(databaseUrl, founderIds, companyIds.length ? companyIds : [app.company_id]);

  // 5d. task C3 -- factual_dynamic budget split (design SS12). `row.class`
  // and `row.derived_status` are the VIEW's own columns (claim_trust),
  // already present on every scopedRows entry -- no second classification.
  // An already-`missing` claim is an honest gap (REQ-004: "a gap is never
  // upgraded away"), never a candidate for a live check.
  const tavilyKey = getTavilyKey();
  const factualDynamicCheckable = scopedRows.filter((r) => r.class === 'factual_dynamic' && r.derived_status !== 'missing');
  const factualDynamicMissingCount = scopedRows.filter((r) => r.class === 'factual_dynamic' && r.derived_status === 'missing').length;
  const { withinBudget: dynamicWithinBudget, overBudget: dynamicOverBudget } = selectClaimsWithinBudget(
    factualDynamicCheckable,
    maxPaidChecksPerCard
  );
  const dynamicWithinBudgetIds = new Set(dynamicWithinBudget.map((r) => r.claim_id));
  const dynamicQueryCache = new Map(); // query string -> {results} -- shared across claims THIS run only (see runFactualDynamicCheck's own header)
  process.stderr.write(
    '[f05/run] factual_dynamic: checkable=' + factualDynamicCheckable.length +
      ' missing=' + factualDynamicMissingCount +
      ' within_budget=' + dynamicWithinBudget.length +
      ' over_budget=' + dynamicOverBudget.length +
      ' tavily_key=' + (tavilyKey ? 'present' : 'ABSENT') + '\n'
  );

  // 6. Build the write plan: run checks, collect evidence rows + per-claim
  //    contradiction candidates + which checks actually ran (for ai_runs).
  const evidenceRows = [];
  const contradictionByClaim = new Map();
  let ghProvenanceRan = 0;
  let ghProvenanceInsufficientData = 0;
  let quoteGuardRan = 0;
  let quoteGuardMismatches = 0;
  const denominatorFindingsByClaim = new Map();
  let dynamicChecksRun = 0;
  let dynamicCreditsUsed = 0;
  let dynamicEvidenceWritten = 0;
  let dynamicNoUsableEvidence = 0;

  for (const row of scopedRows) {
    const routing = routingByClaim.get(row.claim_id);

    if (routing.check === 'gh_provenance') {
      const outcome = await runGithubProvenanceCheck(row, rawSignalsByEntity, entityContext, ctx);
      if (outcome.checkRan) {
        ghProvenanceRan += 1;
        if (outcome.evidenceRow && outcome.evidenceRow.tier === 'missing') ghProvenanceInsufficientData += 1;
      }
      if (outcome.evidenceRow) evidenceRows.push(outcome.evidenceRow);
      if (outcome.contradiction) contradictionByClaim.set(row.claim_id, outcome.contradiction);
    }

    const quoteCandidate = quoteCandidateByClaim.get(row.claim_id);
    if (quoteCandidate) {
      quoteGuardRan += 1;
      const outcome = await runQuoteGuardCheck(row, quoteCandidate, entityContext, ctx);
      if (outcome.evidenceRow) {
        quoteGuardMismatches += 1;
        evidenceRows.push(outcome.evidenceRow);
      }
      // A contradiction found via gh_provenance takes precedence for this
      // claim's single claim_contradicted event if both somehow fire; in
      // practice the two checks apply to disjoint claim populations
      // (gh_provenance only routes founder.execution.provenance).
      if (outcome.contradiction && !contradictionByClaim.has(row.claim_id)) contradictionByClaim.set(row.claim_id, outcome.contradiction);
    }

    // task C3 -- factual_dynamic (Tavily), only for a within-budget,
    // non-missing claim, and only when a Tavily key is actually available
    // (best-effort, never fatal -- same posture as lib/f02/run.js's own
    // Tavily usage: absent key or a failed call degrades to zero evidence
    // for this claim, not a crashed run).
    if (row.class === 'factual_dynamic' && dynamicWithinBudgetIds.has(row.claim_id) && tavilyKey) {
      const company = entityContext.companyById.get(row.card_company_id);
      const outcome = await runFactualDynamicCheck({
        row, company, cutoffIso: app.created_at, tavilyKey, cache: dynamicQueryCache,
        checkedAtHour, databaseUrl, entityContext, ctx,
      });
      dynamicChecksRun += 1;
      dynamicCreditsUsed += outcome.creditsUsed;
      if (outcome.evidenceRows.length) {
        evidenceRows.push(...outcome.evidenceRows);
        dynamicEvidenceWritten += outcome.evidenceRows.length;
      } else {
        dynamicNoUsableEvidence += 1;
      }
      if (outcome.contradiction && !contradictionByClaim.has(row.claim_id)) contradictionByClaim.set(row.claim_id, outcome.contradiction);
    }

    // SS5.1(c) -- denominator extraction, advisory only (B2 ruling: no
    // evidence row; folded into this claim's attempted-event payload below).
    const denom = extractDenominator(row.text_verbatim);
    if (denom.hasPercentageClaim && denom.cappedAtUnverified) {
      denominatorFindingsByClaim.set(row.claim_id, denom.deepDiveQuestions);
    }
  }

  // 7. Write evidence, then re-read claim_trust for the scoped claim_ids to
  //    get post-write verdicts.
  writeEvidenceRows(databaseUrl, evidenceRows);
  process.stderr.write('[f05/run] wrote ' + evidenceRows.length + ' evidence row(s) (ON CONFLICT DO NOTHING)\n');

  const supersetAfter = loadScopeSuperset(databaseUrl, ctx);
  const scopedRowsAfter = scopeClaimsToApplication(supersetAfter, ctx);
  const afterByClaim = new Map(scopedRowsAfter.map((r) => [r.claim_id, r]));

  // 8. Build events: claim_verification_attempted (mandatory, one per scoped
  //    claim -- design SS9), claim_verified / claim_contradicted on a
  //    transition OR on the SS14 qualitative-suppression override, and
  //    router_unmatched_topic.
  const eventRows = [];
  for (const row of scopedRows) {
    const routing = routingByClaim.get(row.claim_id);
    const after = afterByClaim.get(row.claim_id) || row;
    const verdictBefore = row.derived_status;
    const verdictAfter = after.derived_status;
    const contradiction = contradictionByClaim.get(row.claim_id);

    const extra = {};
    if (denominatorFindingsByClaim.has(row.claim_id)) extra.deep_dive_questions = denominatorFindingsByClaim.get(row.claim_id);
    eventRows.push(buildAttemptedEventRow(row, routing, verdictAfter, ctx, checkedAt, extra));

    if (routing.unmatched_topic) eventRows.push(buildUnmatchedTopicEventRow(row, ctx, checkedAt));

    if (verdictBefore !== verdictAfter && verdictAfter === 'verified') {
      eventRows.push(buildVerifiedEventRow(row, routing, verdictAfter, contradiction ? contradiction.sourceUrl : null, ctx, checkedAt));
    }

    // design.md SS14: a documented/discovered-tier contradiction ALWAYS gets
    // a claim_contradicted event, even when the claim's router class pins
    // the verdict to 'unverified'/'missing' (qualitative/forecast/
    // unverifiable) so the finding is never suppressed along with the verdict.
    if (contradiction) {
      eventRows.push(buildContradictedEventRow(row, routing, verdictAfter, ctx, checkedAt, contradiction));
    }
  }
  writeEvents(databaseUrl, eventRows);
  process.stderr.write('[f05/run] wrote ' + eventRows.length + ' event row(s)\n');

  // 9. ai_runs -- always at least one row, confidence NULL (design SS6.0b).
  const aiRunRows = [];
  const runSummary = {
    run_id: runId,
    application_id: applicationId,
    scoped_claims: scopedRows.length,
    gh_provenance_checks_run: ghProvenanceRan,
    gh_provenance_insufficient_data: ghProvenanceInsufficientData,
    quote_guard_checks_run: quoteGuardRan,
    quote_guard_mismatches: quoteGuardMismatches,
    dynamic_checkable: factualDynamicCheckable.length,
    dynamic_missing_skipped: factualDynamicMissingCount,
    dynamic_over_budget_skipped: dynamicOverBudget.length,
    dynamic_checks_run: dynamicChecksRun,
    dynamic_credits_used: dynamicCreditsUsed,
    dynamic_evidence_written: dynamicEvidenceWritten,
    dynamic_no_usable_evidence: dynamicNoUsableEvidence,
  };
  aiRunRows.push({
    task_type: 'verification',
    application_id: applicationId,
    founder_id: '',
    company_id: app.company_id,
    model: 'deterministic:f05_run',
    output_json: runSummary,
  });
  writeAiRuns(databaseUrl, aiRunRows);
  process.stderr.write('[f05/run] wrote ' + aiRunRows.length + ' ai_runs row(s)\n');

  // 10. Rollup -- recompute against the FRESH (post-write) claim_trust state.
  const rollup = computeTrustRollup(scopedRowsAfter, rollupConfig, ctx);
  let scoreId = null;
  if (rollup.status === 'scored') {
    scoreId = writeScoreRow(databaseUrl, rollup.scoresRow);
    process.stderr.write('[f05/run] wrote scores row ' + scoreId + ' value=' + rollup.scoresRow.value + ' confidence=' + rollup.scoresRow.confidence + '\n');
    // 11. Write-back verification_status, only after a successful rollup
    // (design SS8.4), best-effort, for every scoped claim.
    writeBackVerificationStatus(
      databaseUrl,
      scopedRowsAfter.map((r) => ({ claim_id: r.claim_id, status: r.derived_status }))
    );
  } else {
    writeEvents(databaseUrl, [rollup.event]);
    process.stderr.write('[f05/run] coverage ' + rollup.coverage + ' below min_coverage -- wrote trust_rollup_insufficient_evidence event, no scores row\n');
  }

  // 12. Print summary contract.
  const contract = {
    application_id: applicationId,
    run_id: runId,
    status: rollup.status,
    score_id: scoreId,
    coverage: rollup.coverage,
    verdict_eligible_count: rollup.verdictEligibleCount,
    assessed_count: rollup.assessedCount,
    scores_row: rollup.scoresRow,
    scoped_claim_count: scopedRows.length,
    events_written: eventRows.length + (rollup.status === 'insufficient_evidence' ? 1 : 0),
    evidence_written: evidenceRows.length,
    check_summary: runSummary,
  };
  process.stdout.write(JSON.stringify(contract, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('run.js: FATAL: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  uuidArrayLiteral,
  entityForClaim,
  buildAttemptedEventRow,
  buildUnmatchedTopicEventRow,
  buildVerifiedEventRow,
  buildContradictedEventRow,
  buildEntityForRow,
  extractSourceText,
  runGithubProvenanceCheck,
  runQuoteGuardCheck,
  runFactualDynamicCheck,
  hourTrunc,
  rawSignalContentHash,
  insertRawSignalsAndResolveIds,
};
