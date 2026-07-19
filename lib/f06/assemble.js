// lib/f06/assemble.js
// SOURCE OF TRUTH: lib/f06/assemble.js
//
// Feature 06 (Investment Memo & $100K Decision) -- docs/backlog/
// 06-memo-decision/design.md §9 (validate, assemble, version, write) +
// plan.md task T3. This module IS node [D] of the `f06-generate-memo`
// workflow (design.md §5), minus the DB read/write: it is the hard
// guarantee behind I3 ("Trust is per-claim") that no uncited or smuggled
// fact ever RENDERS. Self-contained CommonJS, ZERO imports/requires
// (docs/backlog/TRACKER.md hard convention) -- this file's body is pasted
// verbatim into an n8n Code node; the sandbox has no bind-mount of this
// repo and cannot `require()` from it.
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
// DROP + LOG revision (task T6b, design §9's own "revised after T6's live
// finding" text) -- READ THIS BEFORE THE REST OF THE FILE
// ============================================================================
//
// T6's live smoke measured ~40% of runs hitting a whole-memo 422 (zero bad
// writes, but a live-demo retry risk) from exactly two content slips: a
// section-writer occasionally putting the $100K check-size figure in a
// `structural` statement, or citing a rare hallucinated claim id. Both used
// to REJECT THE WHOLE MEMO (design §9.1/§9.2's original text). Design §9 was
// revised: the citation gate and the typed-exception guard are now
// **DROP + LOG**, not whole-memo reject -- the offending statement/item is
// silently stripped from the row and recorded in `dropped_statements[]`
// (never silent-silent: the count + details ride the `memo_generated` event
// payload, §9.7), and assembly continues. **I3 is preserved exactly** -- no
// uncited fact and no smuggled figure ever reaches a rendered row -- but a
// single LLM slip no longer nukes an otherwise-good memo. This matches the
// product's existing absent≠zero / back-fill philosophy (spec-review
// should-fix #1 already made the required-key gate a back-fill, never a
// reject; this extends the same posture to the other two gates).
//
// Consequence: `assembleMemo()` NO LONGER returns `{error}` for a content
// issue. The only remaining `{error}` path is genuinely malformed input --
// `pack`/`decision` missing entirely -- which design guarantees never
// happens from real [A]/[C] output; it exists purely so this pure function
// fails loudly on a broken caller instead of assembling a memo from nothing.
// "The only hard errors that abort a write are structural (application not
// found, DB failure) -- never a content slip" (design §9.2's closing line).
//
// ============================================================================
// Input contract this module expects
// ============================================================================
//
//   assembleMemo({ pack, sections_parts, decision })
//     -> { row, dropped_statements } | { error }
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
// Returns `{ row, dropped_statements }` on success (the ready-to-INSERT
// `memos` row payload, design §4 frozen contract, `version` still a
// placeholder -- see above; `dropped_statements` is the DROP+LOG accumulator,
// `[]` on a clean run, never written to the `memos` table itself -- it rides
// the `memo_generated` event, §9.7) or `{ error: { code, message } }` on
// malformed input -- NEVER for a content-gate/typed-exception slip any more
// (see the revision note above).

'use strict';

// ============================================================================
// Section-shape vocabulary (design §4.1)
// ============================================================================

// I7: exactly these five are guaranteed present; a required section with
// nothing to say still ships (the empty-but-required rule fills one
// `structural` line -- design §9.3's back-fill, step 4 below -- runs AFTER
// both drop steps so a section a drop just emptied still ships one line
// rather than an empty array).
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

// Defensive fallbacks for a SUB-field being absent on an otherwise-real pack
// / decision object (design guarantees `pack.gaps` / `decision.conditions`
// are always populated in real usage -- context.js/decision.js are total --
// so these exist only so this pure function degrades predictably rather than
// throwing when a test omits one). Distinct from the malformed-input guard
// in `assembleMemo()` below, which rejects a missing `pack`/`decision`
// TOP-LEVEL argument outright -- these two only ever paper over a missing
// sub-field on a real argument.
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

// Best-effort human-readable label for a dropped item's log entry -- the
// five item shapes this module ever drops don't share one text field
// (`statement.text`, `deep_dive_questions[].question`,
// `competition.competitors[].name`), so this tries each in turn rather than
// hard-coding one.
function describeItem(item) {
  if (item.text != null) return item.text;
  if (item.question != null) return item.question;
  if (item.name != null) return item.name;
  return null;
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
// collectAllStatements / collectAllClaimIds -- read-only collectors, used
// ONLY to compute `cited_claim_ids` (step 5) over the already-dropped,
// already-back-filled row. `dropUncitedItems()` (step 2) and
// `dropTypedExceptionOffenders()` (step 3) below CANNOT reuse these: they
// need to WRITE a filtered array back per location, not just read ids, so
// they walk the same locations with their own filtering loops instead.
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

// Collects EVERY claim id anywhere in the assembled row (design §9's own
// enumeration): sections (via collectAllStatements + risk_matrix.risks +
// competition.competitors), deep_dive_questions[].claim_ids,
// conditions.items[].claim_ids, and gaps.contradictions[].claim_id --
// SINGULAR key, not `claim_ids` (design §4.2's shape; easy to get wrong,
// called out explicitly in the design and in plan.md T3). Called on the
// POST-drop, POST-back-fill row (step 5) -- every id it finds already
// belongs to a surviving statement/item, or to `gaps.contradictions`, which
// is pack-sourced and never dropped (see `dropUncitedItems()` below).
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
// Step 2 -- citation gate, DROP + LOG (design §9.1, revised per task T6b)
// ============================================================================
//
// Any item citing an id NOT in `allowedClaimIds` is dropped from its own
// array (never the whole memo) and recorded in the `dropped` accumulator.
// `allowedClaimIds` is design §3.6's superset (application-scoped UNION
// founder-scoped claims), so this is safe for pack-sourced ids
// (`gaps.contradictions`, `conditions.items` built by the deterministic
// decision node from pack data) -- the gate's real target is a
// HALLUCINATED id an LLM-authored block (`sections`, `deep_dive_questions`)
// invents. `gaps.contradictions[].claim_id` is pack-sourced and therefore
// ALWAYS valid by construction -- it is never walked here (leaving it
// otherwise would be redundant work, not a safety gap).
function filterByClaimIds(items, allowedClaimIds, location, dropped) {
  const kept = [];
  for (const item of asArray(items)) {
    if (!item) continue;
    const offending = asArray(item.claim_ids).filter(function (id) { return !allowedClaimIds.has(id); });
    if (offending.length === 0) {
      kept.push(item);
    } else {
      dropped.push({ location, text: describeItem(item), offending_ids: offending, reason: 'uncited_claim_id' });
    }
  }
  return kept;
}

// Walks every documented citation location (design §9.1's own enumeration,
// mirrored from the old whole-list `collectAllClaimIds` walk, but rebuilding
// each array with the offenders stripped rather than only reading ids):
// the `.statements`-shaped sections (incl. the optional ones), swot's four
// arrays, `risk_matrix.risks`, `competition.competitors`,
// `deep_dive_questions`, and `conditions.items`.
function dropUncitedItems({ sections, deep_dive_questions, conditions, allowedClaimIds }) {
  const sec = sections && typeof sections === 'object' ? sections : {};
  const dropped = [];
  const outSections = {};

  for (const key of Object.keys(sec)) {
    const section = sec[key];
    if (!section || typeof section !== 'object') {
      outSections[key] = section;
      continue;
    }

    if (key === 'swot') {
      const swot = {};
      for (const bucket of SWOT_ARRAYS) {
        swot[bucket] = filterByClaimIds(section[bucket], allowedClaimIds, 'swot.' + bucket, dropped);
      }
      outSections.swot = swot;
      continue;
    }

    const next = Object.assign({}, section);
    if (Array.isArray(section.statements)) {
      next.statements = filterByClaimIds(section.statements, allowedClaimIds, key, dropped);
    }
    if (key === 'risk_matrix' && Array.isArray(section.risks)) {
      next.risks = filterByClaimIds(section.risks, allowedClaimIds, 'risk_matrix.risks', dropped);
    }
    if (key === 'competition' && Array.isArray(section.competitors)) {
      next.competitors = filterByClaimIds(section.competitors, allowedClaimIds, 'competition.competitors', dropped);
    }
    outSections[key] = next;
  }

  const outQuestions = filterByClaimIds(deep_dive_questions, allowedClaimIds, 'deep_dive_questions', dropped);

  const cond = conditions && typeof conditions === 'object' ? conditions : DEFAULT_CONDITIONS;
  const outConditions = Object.assign({}, cond, {
    items: filterByClaimIds(cond.items, allowedClaimIds, 'conditions.items', dropped),
  });

  return { sections: outSections, deep_dive_questions: outQuestions, conditions: outConditions, dropped };
}

// ============================================================================
// Step 3 -- typed-exception guard, DROP + LOG (design §9.2, closes the I3
// loophole; same DROP+LOG revision as step 2)
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

// Single-statement verdict: `null` = keep, otherwise the drop `reason`
// (reusing the same codes the old whole-memo `{error.code}` used, for
// continuity with anyone already grepping logs for them). `fact` with zero
// claim_ids is the same I3 loophole from the other direction -- an
// assertion wearing the claim-backed kind label without actually citing
// anything -- so it is dropped here too, same as the design's other two
// checks: "the only hard errors that abort a write are structural... never
// a content slip" (design §9.2) applies to all three, not just the two the
// task brief named explicitly.
function typedExceptionDropReason(statement) {
  const kind = statement.kind;
  const text = statement.text;

  if ((kind === 'not_disclosed' || kind === 'structural') && statementHasNumericFigure(text)) {
    return 'typed_exception_numeric_smuggling';
  }
  if (kind === 'benchmark' && !BENCHMARK_CAVEAT_RE.test(String(text == null ? '' : text))) {
    return 'benchmark_missing_caveat';
  }
  if (kind === 'fact' && asArray(statement.claim_ids).length === 0) {
    return 'fact_missing_claim_id';
  }
  return null;
}

// Walks the same statement locations `collectAllStatements` reads (the
// `.statements`-shaped sections + swot's four arrays) -- `risk_matrix.risks`
// and `competition.competitors` are never walked here, same as before: they
// have no `kind`, so the typed-exception vocabulary does not apply to them.
function dropTypedExceptionOffenders(sections) {
  const sec = sections && typeof sections === 'object' ? sections : {};
  const dropped = [];

  function filterStatements(statements, location) {
    const kept = [];
    for (const statement of asArray(statements)) {
      if (!statement) continue;
      const reason = typedExceptionDropReason(statement);
      if (reason) {
        dropped.push({ location, text: describeItem(statement), offending_ids: [], reason });
      } else {
        kept.push(statement);
      }
    }
    return kept;
  }

  const outSections = {};
  for (const key of Object.keys(sec)) {
    const section = sec[key];
    if (!section || typeof section !== 'object') {
      outSections[key] = section;
      continue;
    }

    if (key === 'swot') {
      const swot = {};
      for (const bucket of SWOT_ARRAYS) {
        swot[bucket] = filterStatements(section[bucket], 'swot.' + bucket);
      }
      outSections.swot = swot;
      continue;
    }

    outSections[key] = Array.isArray(section.statements)
      ? Object.assign({}, section, { statements: filterStatements(section.statements, key) })
      : section;
  }

  return { sections: outSections, dropped };
}

// ============================================================================
// Step 4 -- required-section BACK-FILL, never reject (design §9.3, spec-
// review should-fix #1). Runs LAST of the three content steps -- AFTER both
// drop steps -- so a required section a drop just emptied still ships one
// line rather than an empty array (design §9.1's closing sentence: "If
// dropping empties a required section, the back-fill covers it").
// ============================================================================
//
// A missing/empty required section (any of the five REQUIRED_SECTION_KEYS,
// or any of swot's four parallel arrays) is deterministically BACK-FILLED
// with one `structural` statement instead of failing the whole memo. This
// step never returns an error -- it is total. Text is drawn from a fixed
// table (never company-specific, never carries a `$`/digit), so a
// back-filled line can never itself trip the typed-exception guard, and
// never needs a claim_id (`claim_ids: []`, `kind: 'structural'` -- the
// exact shape §4.1 reserves for connective prose with no factual
// assertion).
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
// `dropped_count`/`dropped_statements` are the DROP+LOG revision's own
// addition (design §9.1: "the drop is logged, not silent... so a systematic
// hallucination is still visible") -- an EXPECTED, healthy field on most
// runs (a handful of drops from an otherwise-good memo is the whole point
// of this revision), not itself a failure signal.
// ============================================================================

function buildMemoGeneratedEvent({
  memo_id,
  application_id,
  version,
  recommendation,
  rule_fired,
  run_id,
  n8n_execution_id,
  dropped_statements,
}) {
  const dropped = asArray(dropped_statements);
  return {
    event_type: 'memo_generated',
    entity_type: 'application',
    entity_id: application_id,
    payload: {
      memo_id,
      version,
      recommendation,
      rule_fired,
      run_id,
      n8n_execution_id,
      dropped_count: dropped.length,
      dropped_statements: dropped,
    },
  };
}

// ============================================================================
// assembleMemo -- the entry point. Order follows design §9's own numbering,
// as revised by task T6b: 1 merge, 2 citation drop, 3 typed-exception drop,
// 4 required-section back-fill, 5 cited_claim_ids. Back-fill runs AFTER both
// drop steps (not before, unlike the pre-T6b ordering) -- a required section
// a drop just emptied must still get its structural line, and a back-filled
// line is fixed, claim-free, digit-free text that cannot itself be dropped
// by either gate regardless of ordering. The malformed-input guard is the
// ONLY remaining `{error}` path -- see the revision note at the top of this
// file.
// ============================================================================

function assembleMemo({ pack, sections_parts, decision } = {}) {
  if (!pack || typeof pack !== 'object') {
    return { error: { code: 'malformed_input', message: 'assembleMemo requires a pack object.' } };
  }
  if (!decision || typeof decision !== 'object') {
    return { error: { code: 'malformed_input', message: 'assembleMemo requires a decision object.' } };
  }

  const applicationId = pack.application_id != null ? pack.application_id : null;
  const allowedClaimIds = new Set(asArray(pack.allowed_claim_ids));
  const gaps = pack.gaps && typeof pack.gaps === 'object' ? pack.gaps : DEFAULT_GAPS;

  const recommendation = decision.recommendation != null ? decision.recommendation : null;
  const conditions =
    decision.conditions && typeof decision.conditions === 'object' ? decision.conditions : DEFAULT_CONDITIONS;

  // Step 1.
  const merged = mergeSectionsParts(sections_parts);

  // Step 2 -- citation drop (soft: strips offenders, never rejects).
  const afterCitation = dropUncitedItems({
    sections: merged.sections,
    deep_dive_questions: merged.deep_dive_questions,
    conditions,
    allowedClaimIds,
  });

  // Step 3 -- typed-exception drop (soft, same revision). Runs over the
  // POST-citation-drop sections -- a statement can only be dropped once, but
  // ordering here is arbitrary either way since the two checks are disjoint
  // (citation drop only inspects claim_ids, typed-exception only inspects
  // kind/text).
  const afterTypedException = dropTypedExceptionOffenders(afterCitation.sections);

  const dropped_statements = afterCitation.dropped.concat(afterTypedException.dropped);

  // Step 4 -- required-section back-fill. MUST run after both drops (see
  // the header comment above).
  const sections = backfillRequiredSections(afterTypedException.sections);

  // Step 5 -- cited_claim_ids = union of what SURVIVED (sections/questions/
  // conditions post-drop, plus gaps.contradictions, which is pack-sourced
  // and was never walked by the drop steps).
  const cited_claim_ids = Array.from(
    collectAllClaimIds({
      sections,
      deep_dive_questions: afterCitation.deep_dive_questions,
      conditions: afterCitation.conditions,
      gaps,
    })
  );

  const row = {
    application_id: applicationId,
    // Placeholder -- the n8n node (T5) overwrites this with
    // computeVersion(<live memos?version read>) before INSERT (see header).
    version: null,
    sections,
    gaps,
    cited_claim_ids,
    recommendation,
    conditions: afterCitation.conditions,
    deep_dive_questions: afterCitation.deep_dive_questions,
  };

  return { row, dropped_statements };
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
  dropUncitedItems,
  statementHasNumericFigure,
  dropTypedExceptionOffenders,
  STRUCTURAL_BACKFILL_TEXT,
  backfillRequiredSections,
  computeVersion,
  buildMemoGeneratedEvent,
  assembleMemo,
};
