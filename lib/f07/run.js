#!/usr/bin/env node
// lib/f07/run.js
// SOURCE OF TRUTH for the headless equivalent of the `f07-thesis-gate` n8n
// workflow (docs/backlog/07-thesis-engine/handoff.md §1: "same code path,
// usable without n8n"). UNLIKE vocabulary.js / rules.js / hashes.js, this
// file never runs inside an n8n Code node -- it runs under plain Node, so it
// is EXEMPT from the zero-project-import convention and requires its
// sibling modules normally (team-lead correction, 2026-07-19).
//
// Usage:
//   node lib/f07/run.js <application_id> --recorded <dir> [--gate-text <file>]
//     Reads <dir>/<application_id>.json -- exactly the extraction output
//     object from design.md §4 / thesis-attribute-extractor-agent-json-
//     schema.json (reasoning, the five attributes, quotes, missing_fields).
//     Makes NO OpenAI call. If the file is absent, fails loudly -- it never
//     falls through to a live call, so nobody burns shared OpenAI credits
//     by accident (team-lead, 2026-07-19). `--gate-text` is OPTIONAL here:
//     supplying it lets the deterministic validator check quote grounding
//     and lets `_text` synthesize correctly (vocabulary.synthesize_text);
//     without it, `_text` is honestly absent (§1.1: "_text ... present
//     whenever the gate has any text") rather than reconstructed from a
//     claim -- `_text` is NEVER derived from `company.what_is_built` or any
//     other claim (db/fixtures/07-thesis-engine.sql, team-lead correction,
//     2026-07-19).
//
//   node lib/f07/run.js <application_id> --gate-text <file>
//     Live mode: calls the thesis-attribute-extractor (gpt-5.6-luna) with
//     the contents of <file> as `gate_text`. Required here (07 has no deck
//     parser, §6.1, so there is no other way to obtain gate text for a
//     fresh call). `--gate-text` is not part of the CLI signature the team
//     lead gave ("node lib/f07/run.js <application_id> [--recorded <dir>]")
//     -- that signature has no way to supply raw text at all -- so it is
//     this file's own minimal extension, added to make live mode (and
//     grounded --recorded validation) actually possible. Flagged to the
//     team lead as a resolved ambiguity and ACCEPTED (2026-07-19).
//
// TWO DELIBERATE DECISIONS, both accepted by the team lead (2026-07-19),
// documented here per that ruling rather than only inline:
//   1. `--gate-text` (above) exists because the team lead's own CLI spec had
//      no way to supply raw text at all, live or recorded.
//   2. The deterministic validator's check 2 (quote grounding, input-spec.md)
//      is a NO-OP when there is nothing to ground against -- i.e.
//      `--recorded` with no `--gate-text` and no `structured_hints`. The
//      team lead's recorded-file spec carries only the extraction OUTPUT,
//      no raw text, so demoting every field to null in that case (the
//      literal reading of check 2) would null out every recorded fixture
//      and defeat --recorded mode's entire purpose. See
//      `validateExtraction`'s own comment for the exact condition.
//
// Both modes require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
// environment (PostgREST over `fetch`, mirroring n8n/workflows/
// f04-db-write.json's calling convention exactly -- same base URL
// construction, same apikey/Authorization/Content-Type/Prefer headers).
// Live mode additionally requires OPENAI_API_KEY.
//
// ⚠️ The live-call path (callExtractorLive, below) has NOT been exercised
// against the real OpenAI API by this terminal -- doing so was explicitly
// out of scope ("nobody burns shared OpenAI credits debugging"). Use
// --recorded for all development and testing; treat callExtractorLive as
// reviewed-but-unverified until someone runs it once, deliberately, with
// budget to spend.
//
// docs/backlog/07-thesis-engine/plan.md, task B4.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const vocabulary = require('./vocabulary');
const rules = require('./rules');
const hashes = require('./hashes');

const EXTRACTOR_MODEL = 'gpt-5.6-luna';
const FORMULA_VERSION = 'f07_v1';
const EVIDENCE_STRENGTH_DOCUMENTED = 0.9;
const DEFAULT_BASE_CONFIDENCE = 0.4; // orchestrator ruling (tracker.md, B4); not specified in design.md itself

const EXTRACTION_FIELDS = ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'];

const CLAIM_TOPIC_BY_FIELD = Object.freeze({
  sector: 'company.sector',
  business_model: 'company.business_model',
  geography_country: 'company.geography_country',
  stage_evidence: 'company.stage_evidence',
  what_is_built: 'company.what_is_built',
});

// Wording matches db/fixtures/07-thesis-engine.sql's own gap-claim
// convention exactly (its Fogline fixture, application B), which itself
// follows db/tests/smoke.sql's "Cap table: not disclosed." precedent --
// kept in sync so a human reading claims from either source sees one voice.
const FIELD_LABEL = Object.freeze({
  sector: 'Sector',
  business_model: 'Business model',
  geography_country: 'Headquarters location',
  stage_evidence: 'Product stage',
  what_is_built: 'Product description',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ============================================================================
// CLI parsing -- pure, testable.
// ============================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith('--')) {
    throw new Error('usage: node lib/f07/run.js <application_id> [--recorded <dir>] [--gate-text <file>]');
  }
  const applicationId = args[0];
  let recordedDir = null;
  let gateTextFile = null;

  const recordedIdx = args.indexOf('--recorded');
  if (recordedIdx !== -1) {
    recordedDir = args[recordedIdx + 1];
    if (!recordedDir) throw new Error('--recorded requires a directory argument');
  }
  const gateTextIdx = args.indexOf('--gate-text');
  if (gateTextIdx !== -1) {
    gateTextFile = args[gateTextIdx + 1];
    if (!gateTextFile) throw new Error('--gate-text requires a file argument');
  }
  // --recorded and --gate-text are NOT mutually exclusive: --recorded
  // replaces the LLM call, but the raw gate text is a separate concern
  // (quote grounding + `_text` synthesis) that --recorded's fixture file
  // does not carry (team lead's spec: the recorded file is exactly the
  // extraction OUTPUT object, nothing else). Live mode (no --recorded)
  // requires --gate-text since there is no other source of raw text.
  if (!recordedDir && !gateTextFile) {
    throw new Error('live mode (no --recorded) requires --gate-text <file> -- 07 has no deck parser (§6.1)');
  }
  return { applicationId, recordedDir, gateTextFile };
}

// ============================================================================
// --recorded mode: load a saved extraction output. Fails loudly on a miss --
// never falls through to a live call (team-lead, 2026-07-19).
// ============================================================================

function loadRecordedExtraction(dir, applicationId) {
  const file = path.join(dir, `${applicationId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `--recorded: no fixture at ${file} -- refusing to fall back to a live OpenAI call. ` +
      'Create the fixture file (the extraction output object from design.md §4) or omit --recorded to run live.'
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ============================================================================
// The deterministic validator -- input-spec.md "The deterministic validator
// (consumer node -- required, not optional)". Four checks. Pure, testable.
// This is the Code node the input spec places immediately after the LLM
// node in the n8n workflow; run.js performs the identical work inline since
// it has no separate node graph.
// ============================================================================

function normalizeForSubstringCheck(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
}

function isGroundedSubstring(quote, haystacks) {
  const needle = normalizeForSubstringCheck(quote);
  if (!needle) return false;
  return haystacks.some((h) => normalizeForSubstringCheck(h).includes(needle));
}

// `gateText` is optional: in `--recorded` mode there is no surviving raw
// gate text to check quotes against (the recorded fixture is exactly the
// extraction OUTPUT object, per the team lead's spec -- no input text
// field). When there is truly nothing to check a quote against (no
// gate_text AND no structured_hints), check 2 is a no-op rather than a
// blanket rejection: demoting every recorded quote to null because the
// replay harness didn't also replay the original input would defeat
// --recorded mode's entire purpose. This is a resolved ambiguity, not a
// silent weakening -- flagged to the team lead.
function validateExtraction(output, { gateText, structuredHints } = {}) {
  const out = isPlainObject(output) ? output : {};
  const quotesIn = isPlainObject(out.quotes) ? out.quotes : {};
  const missingIn = Array.isArray(out.missing_fields) ? out.missing_fields : [];

  const haystacks = [gateText, ...Object.values(structuredHints || {})].filter((v) => typeof v === 'string' && v.length > 0);
  const canCheckGrounding = haystacks.length > 0;

  // check 3: legal keys only, deduped (Set membership dedupes for free).
  const missingSet = new Set(missingIn.filter((f) => EXTRACTION_FIELDS.includes(f)));

  const values = {};
  const quotes = {};

  for (const field of EXTRACTION_FIELDS) {
    let value = Object.prototype.hasOwnProperty.call(out, field) ? out[field] : null;
    let quote = Object.prototype.hasOwnProperty.call(quotesIn, field) ? quotesIn[field] : null;

    const declaredMissing = missingSet.has(field);
    const hasValue = value !== null && value !== undefined;
    const hasQuote = typeof quote === 'string' && quote.length > 0;

    // check 1: value===null <=> quote===null <=> field in missing_fields.
    // The validator only ever demotes to null -- it never repairs upward.
    if (!hasValue || !hasQuote || declaredMissing) {
      value = null;
      quote = null;
      missingSet.add(field);
    } else if (canCheckGrounding && !isGroundedSubstring(quote, haystacks)) {
      // check 2: the quote must be a genuine contiguous substring of
      // gate_text or of some structured_hints value (whitespace-normalized).
      value = null;
      quote = null;
      missingSet.add(field);
    }

    values[field] = value;
    quotes[field] = quote;
  }

  // check 4 (no emitted key outside the schema) is structural here: only
  // the fields named above and `reasoning` are ever read from `out` -- any
  // extra key (geography_region, stage, a confidence field) is simply never
  // propagated, which has the same effect as stripping it.
  return {
    reasoning: typeof out.reasoning === 'string' ? out.reasoning : '',
    ...values,
    quotes,
    missing_fields: EXTRACTION_FIELDS.filter((f) => missingSet.has(f)),
  };
}

// ============================================================================
// Turning a validated extraction into evaluateThesis()'s inputs. `_text`
// synthesis (§1.1, vocabulary.synthesize_text) is the raw gate text ONLY --
// never `what_is_built` or any other claim (db/fixtures/07-thesis-engine.sql,
// team-lead correction, 2026-07-19). When `gateText` is not supplied (e.g.
// --recorded with no --gate-text), `_text` is honestly absent, and any
// `_text`-based rule (M_poskw, M_negkw, a hand-authored one) correctly reads
// `unknown` rather than being silently reconstructed from a claim.
// ============================================================================

function buildAttributesFromExtraction(validated, { gateText } = {}) {
  const attributes = {
    sector: validated.sector,
    business_model: validated.business_model,
    geography_country: validated.geography_country,
    stage_evidence: validated.stage_evidence,
    what_is_built: validated.what_is_built,
    _text: vocabulary.synthesize_text(gateText),
  };
  const missingFields = validated.missing_fields.slice();
  return { attributes, missingFields };
}

// Which claims to write: one row per present attribute, one gap row per
// missing one (§5.4.1). Pure -- no DB access, just the plan.
//
// Gap topic: the BASE topic (`company.<field>`), NOT `company.<field>.gap`.
// design.md §5.4.1 states "gaps follow the `*.gap` convention", but
// db/fixtures/07-thesis-engine.sql's actual Fogline fixture never used that
// suffix -- it writes gap rows under the base topic with `value: NULL` and
// `verification_status: 'missing'`, exactly like db/tests/smoke.sql's
// precedent. The orchestrator ruled in favor of the fixture's convention
// (tracker.md, B4); this file follows that ruling. `writeClaimsAndEvidence`
// below dedupes gap rows by (card_id, topic, source_kind='derived') rather
// than by topic alone, since a present claim and a gap claim can now share
// the identical topic string across different runs (a field extracted in
// one pass, missing in a later re-extraction, or vice versa) -- the
// `source_kind` is what keeps the two kinds from being mistaken for each
// other.
function buildClaimPlan(validated) {
  const present = [];
  const gaps = [];
  for (const field of EXTRACTION_FIELDS) {
    const topic = CLAIM_TOPIC_BY_FIELD[field];
    if (validated.missing_fields.includes(field)) {
      gaps.push({ field, topic, text_verbatim: `${FIELD_LABEL[field]}: not disclosed.` });
    } else {
      present.push({ field, topic, text_verbatim: validated.quotes[field], value: validated[field] });
    }
  }
  return { present, gaps };
}

// ============================================================================
// Live extraction call (gpt-5.6-luna, Responses API). See the module header
// -- UNTESTED against the real API. Schema keywords OpenAI strict mode may
// reject (model-recommendations.md's "Strict-mode schema caveat") are
// stripped preemptively; the deterministic validator above re-checks
// everything they would have enforced, so stripping them costs nothing.
// ============================================================================

// Copied under lib/f07/extractor/ (not read from docs/backlog/) so live mode
// is self-contained in whatever ships publicly -- docs/ is gitignored from
// the public the-vc-brain repo per CLAUDE.md's publication gate, and
// reaching into it at runtime would make live mode work in this monorepo
// checkout and silently break the moment the repo is published (team-lead
// ruling, tracker.md B4). `docs/backlog/07-thesis-engine/agents/
// thesis-attribute-extractor/` remains the C1 deliverable's source of
// record during development; `lib/f07/extractor/` is a COPY, the runtime
// artifact, not the canonical location -- THIS DUPLICATION IS DELIBERATE
// and unmanaged: if C1's prompt or schema changes, re-copy both files here
// by hand, nothing automates it, and nothing detects drift between the two.
const AGENT_DIR = path.join(__dirname, 'extractor');
const UNSUPPORTED_STRICT_SCHEMA_KEYWORDS = new Set(['minLength', 'maxLength', 'pattern', 'uniqueItems', 'maxItems']);

function stripUnsupportedSchemaKeywords(node) {
  if (Array.isArray(node)) return node.map(stripUnsupportedSchemaKeywords);
  if (isPlainObject(node)) {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_STRICT_SCHEMA_KEYWORDS.has(key)) continue;
      out[key] = stripUnsupportedSchemaKeywords(value);
    }
    return out;
  }
  return node;
}

function loadAgentSystemPrompt() {
  const raw = fs.readFileSync(path.join(AGENT_DIR, 'thesis-attribute-extractor-agent-prompts.txt'), 'utf8');
  const marker = 'SYSTEM MESSAGE\n================================================================================';
  const idx = raw.indexOf(marker);
  if (idx === -1) throw new Error('run.js: could not locate the SYSTEM MESSAGE section in the agent prompts file');
  return raw.slice(idx + marker.length).trim();
}

function loadAgentSchema() {
  const raw = fs.readFileSync(path.join(AGENT_DIR, 'thesis-attribute-extractor-agent-json-schema.json'), 'utf8');
  return stripUnsupportedSchemaKeywords(JSON.parse(raw));
}

async function callExtractorLive({ gateText, structuredHints, apiKey }) {
  if (!apiKey) {
    throw new Error('run.js: OPENAI_API_KEY is required for a live extraction call (use --recorded to avoid one)');
  }
  const systemPrompt = loadAgentSystemPrompt();
  const schema = loadAgentSchema();
  const userMessage =
    `<company_text>\n${gateText || ''}\n</company_text>\n\n` +
    `<structured_hints>\n${JSON.stringify(structuredHints || {})}\n</structured_hints>`;

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EXTRACTOR_MODEL,
      temperature: 0,
      reasoning: { effort: 'low' },
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', name: 'thesis_attribute_extractor_output', strict: true, schema },
      },
      max_output_tokens: 1500,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`run.js: OpenAI extraction call failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  const text =
    data.output_text ||
    (data.output && data.output[0] && data.output[0].content && data.output[0].content[0] && data.output[0].content[0].text);
  if (!text) throw new Error('run.js: could not locate structured output text in the OpenAI response (untested response shape)');
  return JSON.parse(text);
}

// ============================================================================
// PostgREST over fetch -- mirrors n8n/workflows/f04-db-write.json's `pg()`
// helper exactly: same base URL construction, same header set, same
// `Prefer: return=representation` convention on insert.
// ============================================================================

function makePg({ supabaseUrl, serviceRoleKey }) {
  return async function pg(method, restPath, body, prefer) {
    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${supabaseUrl}/rest/v1/${restPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PostgREST ${method} ${restPath} -> ${res.status}: ${text}`);
    }
    if (res.status === 204) return [];
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  };
}

// ============================================================================
// The write path (§5.4 + §5.1 + §5.3 + §2's persistence table), in order.
// Every step is select-by-hash-first, then insert -- never `ON CONFLICT DO
// NOTHING` (04/design.md:240's warning, inherited: that returns zero rows
// over PostgREST and nulls the provenance FK).
// ============================================================================

async function preflight(pg, applicationId) {
  const apps = await pg('GET', `applications?id=eq.${applicationId}&select=id,company_id,thesis_id`);
  if (!apps.length) throw new Error(`run.js: no application found for id ${applicationId}`);
  const companyId = apps[0].company_id;

  const existingCards = await pg(
    'GET',
    `cards?application_id=eq.${applicationId}&card_type=eq.company&select=id&order=created_at.asc&limit=1`
  );
  let cardId = existingCards.length ? existingCards[0].id : null;
  if (!cardId) {
    const made = await pg('POST', 'cards', { card_type: 'company', company_id: companyId, application_id: applicationId, status: 'draft' }, 'return=representation');
    cardId = made[0].id;
  }
  return { companyId, cardId };
}

async function loadDefaultThesis(pg) {
  const rows = await pg('GET', 'theses?is_default=eq.true&active=eq.true&select=id,name,version,config&limit=1');
  if (!rows.length) {
    throw new Error('run.js: no thesis satisfies (is_default AND active) -- the gate has nothing to load (§7)');
  }
  return rows[0];
}

async function writeAiRun(pg, { applicationId, companyId, model, promptVersion, inputTextHashValue, gateText, structuredHints, rawExtraction }) {
  const inputHash = hashes.contentHash.aiRun({ application_id: applicationId, input_text_hash: inputTextHashValue, prompt_version: promptVersion, model });
  const found = await pg('GET', `ai_runs?input_hash=eq.${inputHash}&select=id`);
  if (found.length) return found[0].id;

  const made = await pg(
    'POST',
    'ai_runs',
    {
      task_type: 'thesis_extraction',
      company_id: companyId,
      application_id: applicationId,
      model,
      prompt_version: promptVersion,
      input_hash: inputHash,
      // Corollary from input-spec.md: "the ai_runs.prompt payload written
      // by the preflight must contain no thesis field" (§8.3 test 13). This
      // object never merges in theses.config or a thesis id.
      output_json: { input: { gate_text: gateText || null, structured_hints: structuredHints || {} }, extraction: rawExtraction },
    },
    'return=representation'
  );
  return made[0].id;
}

async function writeRawSignal(pg, { applicationId, companyId, inputTextHashValue, promptVersion, observedAt, mode, gateText }) {
  const hash = hashes.contentHash.rawSignal({ application_id: applicationId, input_text_hash: inputTextHashValue, prompt_version: promptVersion });
  const found = await pg('GET', `raw_signals?content_hash=eq.${hash}&select=id`);
  if (found.length) return found[0].id;

  const made = await pg(
    'POST',
    'raw_signals',
    {
      source: 'deck_parse',
      // `payload.text` is the raw gate input verbatim -- the same string
      // `_text` resolves to (§1.1, vocabulary.synthesize_text). Aligned with
      // both the n8n workflow and db/fixtures/07-thesis-engine.sql's own
      // `payload.text` key (team-lead cross-check, 2026-07-19): 07 has no
      // gate text at all during `f07-thesis-reevaluate` (no fresh call), so
      // `_text` there resolves from exactly this stored payload. Omitting
      // it here would silently make every application run.js gates
      // unevaluable by re-evaluation forever -- every `_text` rule would
      // read `unknown` with no error. `gateText || null`, not `''`: an
      // absent gate text must read back as absent (null), not as an empty
      // string that would itself synthesize to null anyway, but should
      // still be represented as "no text was ever supplied" rather than
      // "empty text was supplied".
      payload: { mode, text: gateText || null },
      content_hash: hash,
      company_id: companyId,
      observed_at: observedAt, // the gate invocation timestamp, pinned once -- never a fresh now() per row
    },
    'return=representation'
  );
  return made[0].id;
}

async function writeClaimsAndEvidence(pg, { cardId, rawSignalId, present, gaps }) {
  const claimContentHashes = [];
  const claimIdsByField = {};

  for (const item of present) {
    const hash = hashes.contentHash.claim({ card_id: cardId, topic: item.topic, raw_signal_id: rawSignalId, item_key: '_' });
    let claimId;
    const found = await pg('GET', `claims?content_hash=eq.${hash}&select=id`);
    if (found.length) {
      claimId = found[0].id;
    } else {
      const made = await pg(
        'POST',
        'claims',
        {
          card_id: cardId,
          topic: item.topic,
          text_verbatim: item.text_verbatim,
          value: item.value,
          source_kind: 'self_reported',
          base_confidence: DEFAULT_BASE_CONFIDENCE,
          content_hash: hash,
        },
        'return=representation'
      );
      claimId = made[0].id;
    }
    claimIdsByField[item.field] = claimId;
    claimContentHashes.push(hash);

    const evidenceHash = hashes.contentHash.evidence({ claim_id: claimId, relation: 'supports' });
    const existingEvidence = await pg('GET', `evidence?content_hash=eq.${evidenceHash}&select=id`);
    if (!existingEvidence.length) {
      await pg('POST', 'evidence', {
        claim_id: claimId,
        relation: 'supports',
        tier: 'documented',
        strength: EVIDENCE_STRENGTH_DOCUMENTED,
        quote_verbatim: item.text_verbatim,
        raw_signal_id: rawSignalId,
        content_hash: evidenceHash,
      });
    }
  }

  // Gap claims (§5.4.1): no underlying raw content, so `content_hash` stays
  // NULL (schema comment: "a synthesized/derived 'missing' marker claim has
  // no underlying raw content to hash") and there is no evidence row. Dedup
  // by (card_id, topic, source_kind='derived') instead of content_hash --
  // the `source_kind` filter is load-bearing now that gaps share the base
  // topic with present claims (see buildClaimPlan's comment): without it, a
  // present `self_reported` claim under the same topic from an earlier run
  // would be mistaken for an existing gap and the gap would silently never
  // get written.
  for (const gap of gaps) {
    const existing = await pg('GET', `claims?card_id=eq.${cardId}&topic=eq.${encodeURIComponent(gap.topic)}&source_kind=eq.derived&select=id&order=created_at.desc&limit=1`);
    if (existing.length) continue;
    await pg('POST', 'claims', {
      card_id: cardId,
      topic: gap.topic,
      text_verbatim: gap.text_verbatim,
      value: null,
      source_kind: 'derived',
      verification_status: 'missing',
    });
  }

  return { claimIdsByField, claimContentHashes };
}

async function writeScoreIfEligible(pg, { applicationId, thesisId, evaluation, model, promptVersion, claimIds }) {
  if (evaluation.verdict === 'insufficient_evidence') return null; // §2's persistence table: no scores row
  const made = await pg(
    'POST',
    'scores',
    {
      application_id: applicationId,
      founder_id: null,
      axis: 'thesis_fit',
      value: evaluation.fit,
      confidence: evaluation.coverage,
      missing_flags: {},
      input_claim_ids: claimIds,
      formula_version: FORMULA_VERSION,
      prompt_version: promptVersion,
      model,
      thesis_id: thesisId,
    },
    'return=representation'
  );
  return made[0].id;
}

// §5.1's own idempotency key is (application_id, thesis_id, input_fingerprint)
// -- checked FIRST, before scores is even considered, because `scores` has
// no unique constraint of its own (design.md: "scores has no uniqueness for
// any axis") and would otherwise insert a fresh row on every retry. A retry
// must reuse the ORIGINAL evaluation's score_id rather than minting a new
// scores row that no thesis_evaluations row will ever point back to.
async function findExistingThesisEvaluation(pg, { applicationId, thesisId, inputFingerprintValue }) {
  const rows = await pg(
    'GET',
    `thesis_evaluations?application_id=eq.${applicationId}&thesis_id=eq.${thesisId}&input_fingerprint=eq.${inputFingerprintValue}&select=id,score_id`
  );
  return rows.length ? rows[0] : null;
}

async function insertThesisEvaluation(pg, {
  applicationId, thesis, evaluation, missingFields, validated, inputFingerprintValue, aiRunId, scoreId, mode,
}) {
  const made = await pg(
    'POST',
    'thesis_evaluations',
    {
      application_id: applicationId,
      thesis_id: thesis.id,
      thesis_version: thesis.version,
      input_fingerprint: inputFingerprintValue,
      evaluation_mode: mode,
      verdict: evaluation.verdict,
      score_id: scoreId,
      fired_rules: evaluation.fired_rules,
      extracted_snapshot: validated,
      thesis_config_snapshot: thesis.config,
      missing_fields: missingFields,
      coverage: evaluation.coverage,
      extraction_ai_run_id: aiRunId,
      formula_version: FORMULA_VERSION,
    },
    'return=representation'
  );
  return made[0].id;
}

async function updateApplicationCache(pg, { applicationId, thesis, evaluation }) {
  const thesisGate = evaluation.verdict === 'insufficient_evidence' ? null : evaluation.verdict;
  await pg('PATCH', `applications?id=eq.${applicationId}`, { thesis_gate: thesisGate, thesis_id: thesis.id });
}

async function writeInsufficientEvidenceEvent(pg, { applicationId, evaluation }) {
  if (evaluation.verdict !== 'insufficient_evidence') return;
  await pg('POST', 'events', {
    event_type: 'thesis_gate_insufficient_evidence',
    entity_type: 'application',
    entity_id: applicationId,
    payload: { fit: evaluation.fit, coverage: evaluation.coverage },
    actor: 'lib/f07/run.js',
  });
}

// ============================================================================
// Orchestration. `mode` is always 'full' -- the CLI has no way to supply
// `structured_hints`-only keyword-mode input, and the team lead's spec did
// not ask for one; a documented limitation, not an oversight.
// ============================================================================

async function runGate({ applicationId, recordedDir, gateTextFile, env = process.env } = {}) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('run.js: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in the environment');
  }
  const pg = makePg({ supabaseUrl, serviceRoleKey });
  const mode = 'full';

  const gateText = gateTextFile ? fs.readFileSync(gateTextFile, 'utf8') : '';
  const structuredHints = {};

  let rawExtraction;
  let modelUsed;
  if (recordedDir) {
    rawExtraction = loadRecordedExtraction(recordedDir, applicationId);
    modelUsed = 'recorded';
  } else {
    rawExtraction = await callExtractorLive({ gateText, structuredHints, apiKey: env.OPENAI_API_KEY });
    modelUsed = EXTRACTOR_MODEL;
  }

  const validated = validateExtraction(rawExtraction, { gateText, structuredHints });
  const { attributes, missingFields } = buildAttributesFromExtraction(validated, { gateText });
  const { present, gaps } = buildClaimPlan(validated);

  const { companyId, cardId } = await preflight(pg, applicationId);
  const thesis = await loadDefaultThesis(pg);

  const observedAt = new Date().toISOString(); // pinned once for this run, never re-evaluated per row
  const textForHash = gateText || JSON.stringify(rawExtraction); // recorded mode has no gate_text; hash the recorded object so retries of the SAME fixture still dedup
  const inputTextHashValue = hashes.inputTextHash(textForHash);

  const aiRunId = await writeAiRun(pg, {
    applicationId, companyId, model: modelUsed, promptVersion: hashes.PROMPT_VERSION,
    inputTextHashValue, gateText, structuredHints, rawExtraction,
  });
  const rawSignalId = await writeRawSignal(pg, { applicationId, companyId, inputTextHashValue, promptVersion: hashes.PROMPT_VERSION, observedAt, mode, gateText });
  const { claimIdsByField, claimContentHashes } = await writeClaimsAndEvidence(pg, { cardId, rawSignalId, present, gaps });

  const evaluation = rules.evaluateThesis({ config: thesis.config, attributes, missingFields, mode });
  const inputFingerprintValue = hashes.inputFingerprint({ claimContentHashes, thesisConfigSnapshot: thesis.config });

  // Check for an existing evaluation FIRST (§5.1's own key), before scores
  // is even considered -- see findExistingThesisEvaluation's comment. This
  // ordering is the actual fix for a duplication bug this file's own manual
  // smoke test caught: writing a fresh scores row unconditionally, on every
  // call, produced two rows for one retried gate call (scores has no unique
  // constraint to catch it) even though thesis_evaluations deduplicated
  // correctly -- an orphaned second score no thesis_evaluations row would
  // ever reference.
  const existingEvaluation = await findExistingThesisEvaluation(pg, { applicationId, thesisId: thesis.id, inputFingerprintValue });

  let scoreId;
  if (existingEvaluation) {
    scoreId = existingEvaluation.score_id; // retry -- reuse, never mint a second scores row
  } else {
    scoreId = await writeScoreIfEligible(pg, {
      applicationId, thesisId: thesis.id, evaluation, model: modelUsed, promptVersion: hashes.PROMPT_VERSION,
      claimIds: Object.values(claimIdsByField),
    });
  }

  if (!existingEvaluation) {
    await insertThesisEvaluation(pg, {
      applicationId, thesis, evaluation, missingFields, validated, inputFingerprintValue, aiRunId, scoreId, mode,
    });
  }

  await updateApplicationCache(pg, { applicationId, thesis, evaluation });
  await writeInsufficientEvidenceEvent(pg, { applicationId, evaluation });

  // §6.1's return contract.
  return {
    verdict: evaluation.verdict,
    fit: evaluation.fit,
    coverage: evaluation.coverage,
    fired_rules: evaluation.fired_rules,
    missing_fields: missingFields,
  };
}

async function main() {
  const { applicationId, recordedDir, gateTextFile } = parseArgs(process.argv);
  const result = await runGate({ applicationId, recordedDir, gateTextFile });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  loadRecordedExtraction,
  validateExtraction,
  buildAttributesFromExtraction,
  buildClaimPlan,
  stripUnsupportedSchemaKeywords,
  makePg,
  runGate,
};
