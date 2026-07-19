// lib/f06/assemble.js
// SOURCE OF TRUTH: lib/f06/assemble.js
//
// Feature 06 (Investment Memo & $100K Decision) -- docs/backlog/
// 06-memo-decision/design.md §9 (validate, assemble, version, write) +
// plan.md task T3. This module IS node [D] of the `f06-generate-memo`
// workflow (design.md §5), minus the DB read/write: it is the hard
// guarantee behind I3 ("Trust is per-claim") that no uncited or smuggled
// fact ever reaches the `memos` table. Self-contained CommonJS, ZERO
// imports/requires (docs/backlog/TRACKER.md hard convention) -- this file's
// body is pasted verbatim into an n8n Code node; the sandbox has no
// bind-mount of this repo and cannot `require()` from it.
//
// This module does NOT talk to Postgres and does NOT compute `version` from
// a live read -- design.md §9.4 ("next = COALESCE(MAX(version),0)+1 ...
// alwaysOutputData -- empty at v1 is normal") is a live `memos` SELECT the
// n8n node (task T5) performs, then feeds through `computeVersion()` below.
// `assembleMemo()`'s output `row.version` is therefore an explicit `null`
// placeholder, not a guess -- the caller overwrites it before INSERT. This
// module is likewise not the one that emits `memo_generated` (design §9.7,
// after a successful INSERT); it only builds the payload via
// `buildMemoGeneratedEvent()` so the n8n node has a single, tested place to
// get that shape from.
//
// ============================================================================
// Input contract this module expects
// ============================================================================
//
//   assembleMemo({ pack, sections_parts, decision }) -> { row } | { error }
//
//   pack   -- the [A] context-pack object (design §3), read by [D] via
//             `$('Context pack').first().json` (design §5.1). Only three
//             fields matter here:
//               application_id      uuid
//               allowed_claim_ids   uuid[]   -- design §3.6's SUPERSET
//                                               (application-scoped UNION
//                                               founder-scoped claims)
//               gaps                object   -- design §4.2's shape,
//                                               computed deterministically
//                                               in [A]/[D] upstream of THIS
//                                               module (I4's guarantee does
//                                               not depend on the LLM)
//
//   sections_parts -- the FOUR raw JSON outputs of [B1]/[B2]/[B3]/[B4]
//             (design §5, §5.2/§5.3's Merge fan-in), already unwrapped from
//             n8n's `{json:...}` item shape by the calling Code node (this
//             module is pure and never touches n8n's item envelope):
//               [B1] descriptive  { snapshot, problem_product, traction }
//               [B2] analytical   { hypotheses, swot }
//               [B3] optional     { _sentinel, risk_matrix, competition,
//                                    financials_lite } -- each optional key
//                                    is `null` (not omitted, design's
//                                    memo-optional schema note: "strict mode
//                                    requires every key present") when [B3]
//                                    had no qualifying input; `_sentinel:
//                                    true` marks the all-null case (§5.3)
//               [B4] questions    { deep_dive_questions: [...] }
//             ORDER IS NOT GUARANTEED to match B1..B4 -- see
//             `mergeSectionsParts()` below, which merges by KEY/CONTENT
//             (plan.md T3, risk note "index-merge is the tempting default").
//
//   decision -- the [C] decision node's output (lib/f06/decision.js,
//             design §8): `{ recommendation, conditions }`, conditions
//             matching design §4.4 (`check_size_usd`, `rationale`, `items`,
//             `decision_inputs`, `thresholds_version`).
//
// Returns `{ row }` on success (the ready-to-INSERT `memos` row payload,
// design §4 frozen contract, `version` still a placeholder -- see above) or
// `{ error: { code, message } }` on a citation-gate or typed-exception-guard
// failure -- NEVER a partial row (design §9.1: "reject the whole memo"). A
// missing/empty required section is NOT a gate failure any more (spec-review
// should-fix #1, design §9.3): it is deterministically back-filled with one
// `structural` line instead.

'use strict';

// ============================================================================
// Section-shape vocabulary (design §4.1)
// ============================================================================

// I7: exactly these five are guaranteed present; a required section with
// nothing to say still ships (the empty-but-required rule fills one
// `structural` line UPSTREAM, in the section-writer prompt -- this module
// only VERIFIES that happened, per design §9.3's "stricter than
// memos_sections_check, which only tests key existence").
const REQUIRED_SECTION_KEYS = ['snapshot', 'hypotheses', 'swot', 'problem_product', 'traction'];

// Present only when [B3] had a qualifying input (design §5.3); absent key =>
// 09 renders nothing (I7). Listed here only for documentation -- the merge
// step below does not special-case optional vs required, it copies whatever
// KNOWN_SECTION_KEYS key a part carries and is non-null.
const OPTIONAL_SECTION_KEYS = ['risk_matrix', 'competition', 'financials_lite'];

// Every top-level key a section-writer's schema may emit (design §4.1's
// three JSON schemas, agents/memo-{descriptive,analytical,optional}).
const KNOWN_SECTION_KEYS = REQUIRED_SECTION_KEYS.concat(OPTIONAL_SECTION_KEYS);

// swot's four parallel arrays (design §4.1) -- these carry `statement`
// objects directly, unlike every other section which wraps them in a single
// `.statements` array.
const SWOT_ARRAYS = ['strengths', 'weaknesses', 'opportunities', 'threats'];

// Defensive fallbacks -- design guarantees `pack.gaps` / `decision.conditions`
// are always populated in real usage (gaps computed deterministically in
// [A]; decision.js is a total function, design §8's D6 catch-all never
// returns NULL), so these exist only so this pure function degrades
// predictably rather than throwing when a test or a malformed upstream item
// omits them.
const DEFAULT_GAPS = Object.freeze({
  not_disclosed: [],
  missing_axes: [],
  missing_fields: [],
  low_coverage: {},
  contradictions: [],
});
const DEFAULT_CONDITIONS = Object.freeze({
  check_size_usd: null,
  rationale: '',
  items: [],
  decision_inputs: {},
  thresholds_version: null,
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// ============================================================================
// Step 1 -- merge the four [B1]/[B2]/[B3]/[B4] outputs by KEY/CONTENT
// ============================================================================
//
// design §5.2/plan.md T3 risk note: the append-Merge node preserves input
// order in this n8n build, but this module deliberately does NOT rely on
// that -- it inspects each part's own keys instead. This is what makes the
// [B3] sentinel harmless regardless of which Merge slot it landed in:
// `{_sentinel:true, risk_matrix:null, competition:null, financials_lite:null}`
// carries three KNOWN_SECTION_KEYS whose values are all `null`, so the loop
// below skips all three (I7: null/absent optional => omit the key, never an
// empty shell). `_sentinel` itself is bookkeeping, never copied into
// `sections`.
function mergeSectionsParts(sectionsParts) {
  const parts = asArray(sectionsParts);
  const sections = {};
  let deep_dive_questions = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;

    // [B4]'s item is recognised by its one distinguishing key, not by
    // position -- matches every other branch's content-based dispatch.
    if (Array.isArray(part.deep_dive_questions)) {
      deep_dive_questions = part.deep_dive_questions;
      continue;
    }

    for (const key of KNOWN_SECTION_KEYS) {
      if (!(key in part)) continue;
      const value = part[key];
      if (value === null || value === undefined) continue; // I7 / §5.3 sentinel path
      sections[key] = value;
    }
  }

  return { sections, deep_dive_questions };
}

// ============================================================================
// Statement/claim-id collectors -- shared by the citation gate (step 2), the
// typed-exception guard (step 3) and cited_claim_ids (step 5). Structural,
// not name-keyed: walks whatever `.statements` / swot arrays / risk-matrix /
// competitor entries are actually present, so it is correct whether or not
// the optional sections survived the merge above.
// ============================================================================

// Every `{text, claim_ids, kind}` statement anywhere in `sections` (design
// §4.1): the five `.statements`-shaped sections (snapshot, hypotheses,
// problem_product, traction, plus the optional competition/financials_lite,
// which ALSO carry `.statements` alongside their own extra arrays) and
// swot's four parallel arrays. `risk_matrix.risks[]` and
// `competition.competitors[]` are NOT statements (no `kind`) -- collected
// separately by `collectAllClaimIds()` below, never by this function.
function collectAllStatements(sections) {
  const sec = sections && typeof sections === 'object' ? sections : {};
  const out = [];

  for (const key of Object.keys(sec)) {
    const section = sec[key];
    if (!section || typeof section !== 'object') continue;
    if (Array.isArray(section.statements)) {
      for (const statement of section.statements) {
        if (statement) out.push({ location: key, statement });
      }
    }
  }

  if (sec.swot && typeof sec.swot === 'object') {
    for (const bucket of SWOT_ARRAYS) {
      for (const statement of asArray(sec.swot[bucket])) {
        if (statement) out.push({ location: 'swot.' + bucket, statement });
      }
    }
  }

  return out;
}

function addClaimIds(target, ids) {
  for (const id of asArray(ids)) target.add(id);
}

// Collects EVERY claim id anywhere in the assembled row (design §9.1's own
// enumeration): sections (via collectAllStatements + risk_matrix.risks +
// competition.competitors), deep_dive_questions[].claim_ids,
// conditions.items[].claim_ids, and gaps.contradictions[].claim_id --
// SINGULAR key, not `claim_ids` (design §4.2's shape; easy to get wrong,
// called out explicitly in the design and in plan.md T3).
function collectAllClaimIds({ sections, deep_dive_questions, conditions, gaps }) {
  const ids = new Set();
  const sec = sections && typeof sections === 'object' ? sections : {};

  for (const { statement } of collectAllStatements(sec)) {
    addClaimIds(ids, statement.claim_ids);
  }

  if (sec.risk_matrix && Array.isArray(sec.risk_matrix.risks)) {
    for (const risk of sec.risk_matrix.risks) {
      if (risk) addClaimIds(ids, risk.claim_ids);
    }
  }

  if (sec.competition && Array.isArray(sec.competition.competitors)) {
    for (const competitor of sec.competition.competitors) {
      if (competitor) addClaimIds(ids, competitor.claim_ids);
    }
  }

  for (const question of asArray(deep_dive_questions)) {
    if (question) addClaimIds(ids, question.claim_ids);
  }

  const items = conditions && Array.isArray(conditions.items) ? conditions.items : [];
  for (const item of items) {
    if (item) addClaimIds(ids, item.claim_ids);
  }

  const contradictions = gaps && Array.isArray(gaps.contradictions) ? gaps.contradictions : [];
  for (const contradiction of contradictions) {
    if (contradiction && contradiction.claim_id != null) ids.add(contradiction.claim_id);
  }

  return ids;
}

// ============================================================================
// Step 3 -- citation gate (hard, design §9.1)
// ============================================================================
//
// Any collected id NOT in `allowedClaimIds` rejects the WHOLE memo, no
// partial write. `allowedClaimIds` is design §3.6's superset (application-
// scoped UNION founder-scoped claims), so this is safe for pack-sourced ids
// (`gaps.contradictions`, `conditions.items` built by the deterministic
// decision node from pack data) -- the gate's real target is a
// HALLUCINATED id an LLM-authored block (`sections`, `deep_dive_questions`)
// invents.
function checkCitationGate(allClaimIds, allowedClaimIds) {
  const bad = [];
  for (const id of allClaimIds) {
    if (!allowedClaimIds.has(id)) bad.push(id);
  }
  if (bad.length === 0) return null;
  return {
    code: 'uncited_claim_id',
    message:
      'Memo cites claim id(s) not in allowed_claim_ids (hallucinated or out-of-scope): ' + bad.join(', '),
  };
}

// ============================================================================
// Step 4 -- typed-exception guard (design §9.2, closes the I3 loophole)
// ============================================================================
//
// `not_disclosed` and `structural` exist to state absence / connective
// prose ONLY (design §4.1) -- a company-specific number inside one of those
// kinds is a smuggled fact with no claim_id backing it, exactly the hole I3
// leaves open ("the only claim-free statements are the explicitly typed
// not_disclosed/benchmark/structural... and those are guarded against
// smuggling facts").
//
// Detection is a curated unit-token heuristic, NOT "any digit" (a bare year
// in ordinary prose -- "no revenue disclosed as of 2026" -- must not trip
// this) and NOT "any letter after a digit" (too permissive; would flag the
// digit-then-next-word case on ordinary sentences). Residual, documented
// per plan.md T3's own instruction: a WORDED number with no digit at all
// ("forty thousand dollars") or a unit outside this list is NOT caught
// here -- I3 is airtight only for `kind:'fact'` (which is claim-backed by
// construction, checked below); this guard is the second, weaker line of
// defence the design explicitly scopes to `$`/digit+unit, leaving anything
// subtler to the §6/QA prompt-level assertion (plan.md T8).
const FIGURE_UNIT_RE =
  /\d[\d,.]*\s?(k|m|b|%|x|percent|users?|customers?|employees?|founders?|months?|weeks?|years?|days?|prs?|repos?|repositories|stars?|followers?|dollars?|usd|mrr|arr|dau|mau)/i;

function statementHasNumericFigure(text) {
  const s = String(text == null ? '' : text);
  if (s.indexOf('$') !== -1) return true;
  return FIGURE_UNIT_RE.test(s);
}

// `benchmark` MAY carry numbers, but only inside the labelled-range template
// (design §4.1's own example: "...closed at ~$8-12M post (range, not a
// valuation; survivorship-biased)."). The caveat substring is the one thing
// this guard enforces literally -- the range wording itself is left to the
// prompt.
const BENCHMARK_CAVEAT_RE = /not a valuation/i;

function checkTypedExceptionGuard(sections) {
  for (const { location, statement } of collectAllStatements(sections)) {
    const kind = statement.kind;
    const text = statement.text;

    if ((kind === 'not_disclosed' || kind === 'structural') && statementHasNumericFigure(text)) {
      return {
        code: 'typed_exception_numeric_smuggling',
        message:
          'Statement in "' + location + '" (kind:' + kind + ') smuggles a numeric figure it must not carry: "' + text + '"',
      };
    }

    if (kind === 'benchmark' && !BENCHMARK_CAVEAT_RE.test(String(text == null ? '' : text))) {
      return {
        code: 'benchmark_missing_caveat',
        message: 'Benchmark statement in "' + location + '" is missing the "not a valuation" caveat: "' + text + '"',
      };
    }

    // `fact` statements are claim-backed assertions by definition (design
    // §4.1: "claim_ids non-empty"); a `fact` with zero claim_ids is the same
    // I3 loophole from the other direction -- an assertion wearing the
    // claim-backed kind label without actually citing anything.
    if (kind === 'fact' && asArray(statement.claim_ids).length === 0) {
      return {
        code: 'fact_missing_claim_id',
        message: 'Fact statement in "' + location + '" has no claim_ids: "' + text + '"',
      };
    }
  }
  return null;
}

// ============================================================================
// Step 2 -- required-section BACK-FILL, never reject (design §9.3, spec-
// review should-fix #1)
// ============================================================================
//
// Originally a gate that rejected the whole memo on a missing/empty required
// section (`memos_sections_check` is key-existence-only; this used to be the
// stricter per-array check on top of it). Spec review flipped that: "the
// prompt can slip, this cannot" -- a missing/empty required section (any of
// the five REQUIRED_SECTION_KEYS, or any of swot's four parallel arrays) is
// deterministically BACK-FILLED with one `structural` statement instead of
// failing the whole memo. Only the citation gate (step 3) and the
// typed-exception guard (step 4) may still reject -- this step is now total,
// it never returns an error. Text is drawn from a fixed table (never company-
// specific, never carries a `$`/digit), so a back-filled line can never trip
// the typed-exception guard regardless of gate ordering, and never needs a
// claim_id (`claim_ids: []`, `kind: 'structural'` -- the exact shape §4.1
// reserves for connective prose with no factual assertion).
const STRUCTURAL_BACKFILL_TEXT = Object.freeze({
  snapshot: 'Snapshot: nothing disclosed at this stage.',
  hypotheses: 'Hypotheses: nothing disclosed at this stage.',
  problem_product: 'Problem & product: nothing disclosed at this stage.',
  traction: 'Traction: nothing verifiable disclosed at this stage.',
  'swot.strengths': 'Strengths: nothing disclosed at this stage.',
  'swot.weaknesses': 'Weaknesses: nothing disclosed at this stage.',
  'swot.opportunities': 'Opportunities: nothing disclosed at this stage.',
  'swot.threats': 'Threats: nothing disclosed at this stage.',
});

function backfillStatement(key) {
  return { text: STRUCTURAL_BACKFILL_TEXT[key], claim_ids: [], kind: 'structural' };
}

function backfillRequiredSections(sections) {
  const sec = sections && typeof sections === 'object' ? sections : {};
  const filled = Object.assign({}, sec);

  for (const key of ['snapshot', 'hypotheses', 'problem_product', 'traction']) {
    const section = filled[key] && typeof filled[key] === 'object' ? filled[key] : {};
    const statements = asArray(section.statements);
    filled[key] = { statements: statements.length ? statements : [backfillStatement(key)] };
  }

  const swot = filled.swot && typeof filled.swot === 'object' ? filled.swot : {};
  const filledSwot = {};
  for (const bucket of SWOT_ARRAYS) {
    const arr = asArray(swot[bucket]);
    filledSwot[bucket] = arr.length ? arr : [backfillStatement('swot.' + bucket)];
  }
  filled.swot = filledSwot;

  return filled;
}

// ============================================================================
// computeVersion -- design §9.4. `next = COALESCE(MAX(version),0)+1`. Pure:
// the n8n node (task T5) performs the live `memos?application_id=eq.<id>&
// select=version&order=version.desc&limit=1` read (alwaysOutputData -- empty
// at v1 is normal, design §3's own convention) and passes whatever it got
// here, including `[]`.
// ============================================================================

function computeVersion(existingVersions) {
  let max = 0;
  for (const v of asArray(existingVersions)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

// ============================================================================
// buildMemoGeneratedEvent -- design §9.7's payload shape, exposed so the
// n8n node has one tested place to build it from after a successful INSERT
// (this module never writes the event itself -- no I/O here at all).
// ============================================================================

function buildMemoGeneratedEvent({ memo_id, application_id, version, recommendation, rule_fired, run_id, n8n_execution_id }) {
  return {
    event_type: 'memo_generated',
    entity_type: 'application',
    entity_id: application_id,
    payload: { memo_id, version, recommendation, rule_fired, run_id, n8n_execution_id },
  };
}

// ============================================================================
// assembleMemo -- the entry point. Order follows design §9's own numbering,
// as revised by spec-review should-fix #1 (1 merge, 2 required-section
// back-fill, 3 citation gate, 4 typed-exception guard, 5 cited_claim_ids).
// Back-fill runs BEFORE the two remaining gates -- a required section is
// always complete by the time either gate inspects `sections`, and a
// back-filled line is fixed, claim-free, digit-free text that cannot itself
// trip either gate regardless of ordering. Only the citation gate and the
// typed-exception guard can still return `{ error }` -- back-fill never does
// ("the prompt can slip, this cannot", design §9.3).
// ============================================================================

function assembleMemo({ pack, sections_parts, decision } = {}) {
  const packObj = pack && typeof pack === 'object' ? pack : {};
  const applicationId = packObj.application_id != null ? packObj.application_id : null;
  const allowedClaimIds = new Set(asArray(packObj.allowed_claim_ids));
  const gaps = packObj.gaps && typeof packObj.gaps === 'object' ? packObj.gaps : DEFAULT_GAPS;

  const decisionObj = decision && typeof decision === 'object' ? decision : {};
  const recommendation = decisionObj.recommendation != null ? decisionObj.recommendation : null;
  const conditions =
    decisionObj.conditions && typeof decisionObj.conditions === 'object' ? decisionObj.conditions : DEFAULT_CONDITIONS;

  // Step 1.
  const merged = mergeSectionsParts(sections_parts);
  const deep_dive_questions = merged.deep_dive_questions;

  // Step 2 -- required-section back-fill (never rejects).
  const sections = backfillRequiredSections(merged.sections);

  // Step 3 -- citation gate (hard). Collected once, reused for step 5.
  const allClaimIds = collectAllClaimIds({ sections, deep_dive_questions, conditions, gaps });
  const citationError = checkCitationGate(allClaimIds, allowedClaimIds);
  if (citationError) return { error: citationError };

  // Step 4.
  const typedExceptionError = checkTypedExceptionGuard(sections);
  if (typedExceptionError) return { error: typedExceptionError };

  // Step 5.
  const cited_claim_ids = Array.from(allClaimIds);

  const row = {
    application_id: applicationId,
    // Placeholder -- the n8n node (T5) overwrites this with
    // computeVersion(<live memos?version read>) before INSERT (see header).
    version: null,
    sections,
    gaps,
    cited_claim_ids,
    recommendation,
    conditions,
    deep_dive_questions,
  };

  return { row };
}

module.exports = {
  REQUIRED_SECTION_KEYS,
  OPTIONAL_SECTION_KEYS,
  KNOWN_SECTION_KEYS,
  SWOT_ARRAYS,
  DEFAULT_GAPS,
  DEFAULT_CONDITIONS,
  asArray,
  mergeSectionsParts,
  collectAllStatements,
  collectAllClaimIds,
  checkCitationGate,
  statementHasNumericFigure,
  checkTypedExceptionGuard,
  STRUCTURAL_BACKFILL_TEXT,
  backfillRequiredSections,
  computeVersion,
  buildMemoGeneratedEvent,
  assembleMemo,
};
