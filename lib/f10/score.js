// lib/f10/score.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and re-paste.
//
// Stage 3 of feature 10's NL-search: pure function `(plan, fetchedRows) ->
// { items, low_confidence, total, truncated, low_confidence_only, plan }`.
// No I/O, no database, no network, no LLM -- everything here is arithmetic
// over data the caller already fetched via lib/f10/plan.js's descriptors
// (design.md §5.1: "In-memory scoring over 122 founders is trivially fast
// and keeps the module zero-dependency and testable against fixtures").
// Same shape as lib/f07/rules.js's `evaluateThesis` -- a deterministic
// evaluator pasted verbatim into an n8n Code node, unit tested here first.
//
// Authoritative source for every rule below: docs/backlog/10-api-cli-skill/
// design.md rev.4 §5.4/§5.5/§5.6, cited inline. Do not recompute any of
// these formulas from first principles -- they were wrong twice across
// three spec-review rounds (rev.4 changelog) and are implemented here
// literally, not "improved".
//
// docs/backlog/10-api-cli-skill/plan.md, task B1.

'use strict';

const {
  TIER_CREDIT,
  BROADENING_CREDIT,
  CONFIDENCE_FLOOR,
  CANDIDATE_CAP,
  STATES,
  ASSESSED_STATES,
  CREDITED_STATES,
  COVERAGE_BUCKET_ORDINAL,
  COVERAGE_BUCKET_THRESHOLDS,
} = require('./constants');

// ============================================================================
// Small shared helpers
// ============================================================================

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Rounds to 2dp -- same mechanism and rationale as lib/f03/scoring.js's
// round2: keeps floats from carrying noise into the response, and matches
// house convention for every other feature's score output.
function round2(value) {
  return Number(value.toFixed(2));
}

// ============================================================================
// §4.3 -- evidence classification for ONE claim row. Returns exactly one of:
//   { kind: 'mismatch' }
//   { kind: 'match', tier, evidenceEntry }
//   { kind: 'unknown_searched' }
//   { kind: 'inconclusive' }        -- contributes to neither match nor mismatch
//
// This is where rev.4's F4 fix lives: tier selection counts
// `evidence.relation === 'supports'` ONLY; `context` never sets credit; a
// row whose strongest signal is `contradicts` (or whose claim carries
// `verification_status='contradicted'`) resolves to `mismatch`, never
// `matched` -- refuting evidence must never raise a founder's rank (the
// live DB already holds 3 `contradicts` and 104 `context` rows).
// ============================================================================

function classifyRow(row) {
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const contradicts = evidence.filter((e) => e && e.relation === 'contradicts');

  // A decisive, human/pipeline-authored disagreement signal must never be
  // silently outvoted by a co-existing supports entry on the SAME claim
  // (§5.5, review round 3 S6 + F4).
  if (row.verification_status === 'contradicted' || contradicts.length > 0) {
    return { kind: 'mismatch' };
  }

  // §4.3: verification_status='missing' claims are DELIBERATE data -- "we
  // looked and did not find X" -- never a match, regardless of what (if
  // any) evidence rows happen to be attached.
  if (row.verification_status === 'missing') {
    return { kind: 'unknown_searched' };
  }

  // Tier selection filters relation='supports' ONLY (§5.5). A supports-tier
  // evidence row whose OWN tier is 'missing' is excluded here too --
  // TIER_CREDIT (constants.js) deliberately has no 'missing' entry, so
  // "missing tier never a match" holds even when relation says supports.
  const supports = evidence.filter((e) => e && e.relation === 'supports');
  let best = null;
  for (const e of supports) {
    if (!Object.prototype.hasOwnProperty.call(TIER_CREDIT, e.tier)) continue;
    if (!best || TIER_CREDIT[e.tier] > TIER_CREDIT[best.tier]) best = e;
  }
  if (best) return { kind: 'match', tier: best.tier, evidenceEntry: best };

  // No creditable supports evidence. A missing-tier row anywhere on the
  // claim (even outside `supports`) still reads as "we looked and found
  // nothing usable" -- e.g. a context row with tier='missing' -- otherwise
  // a claim with no usable evidence at all (context-only, or empty
  // evidence[]) is 'inconclusive': recorded, but decides nothing.
  if (evidence.some((e) => e && e.tier === 'missing')) return { kind: 'unknown_searched' };
  return { kind: 'inconclusive' };
}

// ============================================================================
// §4.3 -- "latest claim per topic" (supersedes_claim_id is NULL
// database-wide; fallback is `ORDER BY created_at DESC, id`). Applied WITHIN
// one candidate's rows for one attribute, before evaluating state -- a
// provenance family fetch (e.g. founder.expertise.*) can return several
// distinct topics for the same founder; each topic keeps only its newest row.
// ============================================================================

function isLater(a, b) {
  const ta = a.created_at ? Date.parse(a.created_at) : NaN;
  const tb = b.created_at ? Date.parse(b.created_at) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta > tb;
  return String(a.claim_id) > String(b.claim_id); // tiebreak: id, per §4.3
}

function pickLatestPerTopic(rows) {
  const byTopic = new Map();
  for (const row of rows) {
    const existing = byTopic.get(row.topic);
    if (!existing || isLater(row, existing)) byTopic.set(row.topic, row);
  }
  return byTopic;
}

// ============================================================================
// evalOpMatch -- does a single claim row's `.value` satisfy the attribute's
// `op`/`value`? Only meaningful for eq/contains/gte/lte; `exists` never
// calls this (presence alone is the test, per the family-glob provenance
// path). `gte`/`lte`/`contains` exist in the JSON schema's op enum but have
// no worked example anywhere in design.md -- their natural home was the CUT
// `velocity` kind (metric thresholds); implemented here for schema
// completeness, not exercised by any required §9 test, flagged in the B1
// report.
// ============================================================================

function evalOpMatch(op, rowValue, target) {
  switch (op) {
    case 'eq':
      return rowValue === target;
    case 'contains':
      if (Array.isArray(rowValue)) return rowValue.includes(target);
      if (typeof rowValue === 'string') return rowValue.includes(String(target));
      return false;
    case 'gte':
      return typeof rowValue === 'number' && typeof target === 'number' && rowValue >= target;
    case 'lte':
      return typeof rowValue === 'number' && typeof target === 'number' && rowValue <= target;
    default:
      return false;
  }
}

// ============================================================================
// §5.5 -- per-candidate, per-POSITIVE-attribute state resolution.
//
//   rows.length === 0                           -> unknown
//   any qualifying row classifies 'mismatch'     -> mismatch (always wins --
//                                                    a refuted claim is never
//                                                    eligible to match)
//   else any qualifying row classifies 'match'   -> matched / matched_broadened,
//                                                    tier = best across qualifying rows
//   else eq-only: a DIFFERENT, genuinely-matched -> mismatch (a real,
//        (non-contradicted) value exists            evidenced, different value
//                                                    IS a positive disagreement --
//                                                    contrast a context-only or
//                                                    unknown_searched row with a
//                                                    different value, which is
//                                                    too weak a signal and does
//                                                    NOT force mismatch)
//   else any qualifying row is unknown_searched  -> unknown_searched
//   else (context-only / inconclusive rows only) -> unknown
// ============================================================================

function resolvePositiveAttributeForCandidate(attr, rowsForFounder) {
  if (!rowsForFounder || rowsForFounder.length === 0) return { state: STATES.UNKNOWN };

  const latest = pickLatestPerTopic(rowsForFounder);

  let bestMatch = null; // { tier, row, evidenceEntry }
  let sawMismatch = false;
  let mismatchRow = null;
  let sawUnknownSearched = false;
  let unknownSearchedRow = null;

  for (const row of latest.values()) {
    const classified = classifyRow(row);

    if (classified.kind === 'mismatch') {
      sawMismatch = true;
      mismatchRow = mismatchRow || row;
      continue;
    }

    if (attr.op !== 'exists') {
      const qualifies = evalOpMatch(attr.op, row.value, attr.value);
      if (!qualifies) {
        if (attr.op === 'eq' && classified.kind === 'match') {
          // The claim genuinely, evidently asserts a DIFFERENT value than
          // what was asked for -- a positive disagreement, not silence.
          sawMismatch = true;
          mismatchRow = mismatchRow || row;
        }
        continue;
      }
    }

    if (classified.kind === 'match') {
      if (!bestMatch || TIER_CREDIT[classified.tier] > TIER_CREDIT[bestMatch.tier]) {
        bestMatch = { tier: classified.tier, row, evidenceEntry: classified.evidenceEntry };
      }
      continue;
    }
    if (classified.kind === 'unknown_searched') {
      sawUnknownSearched = true;
      unknownSearchedRow = unknownSearchedRow || row;
    }
    // 'inconclusive' -- no contribution, keep looking at the other topics.
  }

  if (sawMismatch) return { state: STATES.MISMATCH, evidenceRow: mismatchRow };
  if (bestMatch) {
    const state = attr.broadening ? STATES.MATCHED_BROADENED : STATES.MATCHED;
    return { state, tier: bestMatch.tier, evidenceRow: bestMatch.row, evidenceEntry: bestMatch.evidenceEntry };
  }
  if (sawUnknownSearched) return { state: STATES.UNKNOWN_SEARCHED, evidenceRow: unknownSearchedRow };
  return { state: STATES.UNKNOWN };
}

// ============================================================================
// §5.4 rule 3 (per-candidate form) -- a negative resolves `matched` ONLY for
// candidates that have SOME evidence in the target's topic family; a
// candidate with none resolves `unknown`. No mismatch state for negatives
// (design.md's own text enumerates exactly these two outcomes for the
// per-candidate rule) -- negatives are a binary "did we investigate this
// area for this candidate at all" test, not a value comparison.
//
// A matched negative takes tier_credit 1.0 unconditionally (JSON schema:
// "there is no claim to read a tier from, and the evidence-presence test...
// IS its assessment").
// ============================================================================

function resolveNegativeAttributeForCandidate(rowsForFounder) {
  if (!rowsForFounder || rowsForFounder.length === 0) return { state: STATES.UNKNOWN };
  return { state: STATES.MATCHED, claimIds: rowsForFounder.map((r) => r.claim_id).filter((id) => id != null) };
}

// ============================================================================
// QA finding B (post-B1 gate) -- founder resolution index. `api_claims`
// carries `founder_id` / `company_id` / `application_id` as three
// independent nullable columns (design.md §4: "a card can carry more than
// one at once"). Founder-scoped topics (`founder.*`, the provenance kind)
// set `founder_id`. Company-scoped topics -- `company.sector` /
// `company.geography_country`, the ONLY claim_topic targets the
// `structural` kind resolves against (§5.3) -- set `company_id` /
// `application_id` and leave `founder_id` NULL. Live, confirmed by QA:
// `select count(*), count(founder_id) from api_claims where topic like
// 'company.%'` -> 49 total, 1 with a founder_id. A row-to-founder
// resolution keyed on `row.founder_id` alone therefore silently dropped
// essentially every structural claim, and `geo_berlin`/`sector_ai_infra`
// -shaped attributes could never match -- not because the data does not
// exist, but because the join never reached it.
//
// The fetch itself does not change: `lib/f10/plan.js`'s descriptor already
// filters by `topic` ONLY (never by `founder_id`), so the n8n workflow
// already returns every company-scoped row regardless of its founder_id.
// This is purely an in-memory resolution fix.
//
// Resolution rule: a row with a `founder_id` is attributed to THAT founder
// ONLY -- the company/application fallback below never runs for it, and
// never extends a founder-specific claim (e.g. "founder A has vertical
// tenure") onto a co-founder B just because the same card also happens to
// carry A's `company_id`. A row with NO `founder_id` (company-scoped) is
// attributed to every CURRENT founder of its company/application, via
// `api_founders`' own `company_id`/`application_id` (§4.1 -- LEFT JOINed
// through `founder_company.is_current`; this reuses that existing
// resolution, it does not invent a new join). The three-state semantics
// are unchanged by this: a founder with no company still has zero matching
// rows for a structural attribute and correctly resolves `unknown`, never
// `mismatch` -- this index only WIDENS which rows a founder can see, it
// never fabricates evidence for one that has none.
// ============================================================================

function buildFounderIndex(founders) {
  const byId = new Map();
  const byCompany = new Map();
  const byApplication = new Map();
  for (const f of Array.isArray(founders) ? founders : []) {
    if (!f || f.founder_id == null) continue;
    byId.set(f.founder_id, f);
    if (f.company_id != null) {
      if (!byCompany.has(f.company_id)) byCompany.set(f.company_id, []);
      byCompany.get(f.company_id).push(f.founder_id);
    }
    if (f.application_id != null) {
      if (!byApplication.has(f.application_id)) byApplication.set(f.application_id, []);
      byApplication.get(f.application_id).push(f.founder_id);
    }
  }
  return { byId, byCompany, byApplication };
}

const EMPTY_FOUNDER_INDEX = Object.freeze({ byId: new Map(), byCompany: new Map(), byApplication: new Map() });

// The founder_id(s) ONE row is evidence for -- see the rule above. Returns
// an array (usually 0 or 1 entries; more than 1 only when several founders
// currently share the same company/application and the row itself carries
// no founder_id of its own).
function resolveRowFounderIds(row, founderIndex) {
  if (row.founder_id != null) return [row.founder_id];
  const idx = founderIndex || EMPTY_FOUNDER_INDEX;
  const ids = new Set();
  if (row.company_id != null && idx.byCompany.has(row.company_id)) {
    for (const id of idx.byCompany.get(row.company_id)) ids.add(id);
  }
  if (row.application_id != null && idx.byApplication.has(row.application_id)) {
    for (const id of idx.byApplication.get(row.application_id)) ids.add(id);
  }
  return [...ids];
}

// ============================================================================
// Row bookkeeping -- index a flat row array BY FOUNDER once per attribute,
// rather than re-scanning on every candidate (122 founders is trivially
// fast either way, but this keeps the per-candidate loop O(1) lookups
// instead of O(n) filters). A single row can now land under more than one
// founder_id (co-founders sharing a company-scoped claim, per the
// resolution rule above) -- the row object itself is never cloned or
// mutated, just referenced from each relevant founder's bucket.
// ============================================================================

function indexRowsByFounder(rows, founderIndex) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    for (const founderId of resolveRowFounderIds(row, founderIndex)) {
      if (!map.has(founderId)) map.set(founderId, []);
      map.get(founderId).push(row);
    }
  }
  return map;
}

function buildFounderMetaMap(founders) {
  const map = new Map();
  for (const f of Array.isArray(founders) ? founders : []) {
    if (f && f.founder_id != null) map.set(f.founder_id, f);
  }
  return map;
}

// api_founders' documented column is `score_assessed` (§4.1); the search
// response's own field is `founder_score_assessed` (§5.6 example) --
// distinct names for the same fact. Read either shape defensively so a
// fixture (or a caller that already renamed it) works either way.
function founderDisplay(founderId, metaMap) {
  const meta = metaMap.get(founderId) || {};
  return {
    founder_id: founderId,
    full_name: meta.full_name != null ? meta.full_name : null,
    is_synthetic: meta.is_synthetic === true,
    company_id: meta.company_id != null ? meta.company_id : null,
    company_name: meta.company_name != null ? meta.company_name : null,
    application_id: meta.application_id != null ? meta.application_id : null,
    founder_score: typeof meta.founder_score === 'number' ? meta.founder_score : null,
    founder_score_assessed: meta.founder_score_assessed === true || meta.score_assessed === true,
  };
}

// ============================================================================
// §5.4 rule 4 -- candidate gathering: union of founder_ids from POSITIVE
// attributes' fetched rows ONLY (negatives never generate candidates).
// Each attribute's own fetch is assumed already `ORDER BY founder_id`
// (the descriptor says so, lib/f10/plan.js); the union is re-sorted here so
// the FINAL 200-cap slice is deterministic regardless of fetch order
// between attributes (§5.4: "so *which* 200 is deterministic" -- this
// module treats that guarantee as applying to the scored set as a whole,
// documented as an interpretation call in the B1 report: design.md's
// "each fetch ordered... before the 200-row cap" phrasing is compatible
// with either "cap each fetch" or "cap the union"; the union-cap reading is
// the only one consistent with §5.4 rule 5's own definition of `total` as
// "size of the SCORED candidate set" and `truncated` as a single, singular
// 200-candidate cap).
//
// QA finding B -- a positive STRUCTURAL attribute's rows are company-scoped
// (no `founder_id`), so gathering must resolve them through the same
// founder index `indexRowsByFounder` uses (`resolveRowFounderIds`), not
// `row.founder_id` alone -- otherwise a structural attribute contributes
// ZERO candidates even when its rows exist (live: 49 company.* claims, 1
// with a founder_id).
// ============================================================================

function gatherCandidateIds(positiveAttrs, fetchedRows, founderIndex) {
  const idSet = new Set();
  for (const attr of positiveAttrs) {
    const rows = Array.isArray(fetchedRows[attr.id]) ? fetchedRows[attr.id] : [];
    for (const row of rows) {
      if (!row) continue;
      for (const founderId of resolveRowFounderIds(row, founderIndex)) idSet.add(founderId);
    }
  }
  const sorted = [...idSet].sort();
  return {
    ids: sorted.slice(0, CANDIDATE_CAP),
    truncated: sorted.length > CANDIDATE_CAP,
  };
}

// ============================================================================
// §5.5 -- per-attribute response view (the `attributes[]` entry inside a
// search hit, §5.6). `evidence_quality` (per-candidate, computed below in
// scoreCandidate) is NOT shown in §5.6's illustrative JSON, but §5.5 defines
// it as a formula explicitly meant to travel WITH rank_score/confidence
// ("the pair is read together exactly as value + confidence is for the
// axes") -- included here on that basis; flagged as a doc gap in the B1
// report (the example simply was not updated when F5 added the formula).
// ============================================================================

function buildAttributeView(attr, resolved, tierCredit) {
  const view = {
    id: attr.id,
    label: attr.label,
    kind: attr.kind,
    polarity: attr.polarity,
    state: resolved.state,
    weight: attr.weight,
    tier_credit: tierCredit,
  };
  if (attr.broadening) {
    view.broadening = attr.broadening;
    view.resolved_as = attr.resolved_as;
  }

  if (resolved.state === STATES.MATCHED || resolved.state === STATES.MATCHED_BROADENED) {
    if (attr.polarity === 'negative') {
      view.evidence = { claim_ids: resolved.claimIds || [] };
    } else {
      const row = resolved.evidenceRow || {};
      const entry = resolved.evidenceEntry || {};
      // QA finding A (post-B1 gate): `quote_verbatim` must be a REAL quote
      // from the source (`evidence.quote_verbatim`, §4.3) or `null` --
      // NEVER `claims.text_verbatim` (the claim's own, system-generated
      // text) silently substituted under the same field name. `evidence`
      // rows with relation='supports' are 590 live, 398 with a real quote
      // -- the other 32.5% were rendering as a fabricated citation under
      // this fix's predecessor, which is exactly what REQ-004 and the
      // Agentic Traceability claim forbid. `claim_text` carries our own
      // text separately and always, so nothing is lost -- it is simply
      // never presented AS a source quote. `quote_source` names which one
      // is populated so a consumer never has to guess.
      view.evidence = {
        claim_id: row.claim_id != null ? row.claim_id : null,
        quote_verbatim: entry.quote_verbatim != null ? entry.quote_verbatim : null,
        claim_text: row.text_verbatim != null ? row.text_verbatim : null,
        quote_source: entry.quote_verbatim != null ? 'evidence' : null,
        source_url: entry.source_url != null ? entry.source_url : null,
        tier: resolved.tier,
      };
    }
  } else if (resolved.state === STATES.MISMATCH) {
    const row = resolved.evidenceRow || {};
    view.evidence = { claim_id: row.claim_id != null ? row.claim_id : null };
    view.note = 'evidence contradicts this attribute';
  } else if (resolved.state === STATES.UNKNOWN_SEARCHED) {
    view.evidence = null;
    view.note = 'we looked and found nothing recorded -- lowers confidence, not rank';
  } else {
    view.evidence = null;
    view.note = 'no data -- lowers confidence, not rank';
  }
  return view;
}

// ============================================================================
// §5.4 rule 6, rev.5 -- `coverage` / `confidence_bucket`. A SEPARATE,
// count-based axis from `confidence` (weight-based) -- computed here so
// bucketing never depends on WHICH attributes assessed, only how many
// (constants.js's own rationale). `coverage` is the raw fraction (used for
// the threshold test); the DISPLAYED value is rounded like every other
// numeric field.
// ============================================================================

function computeCoverageBucket(coverage) {
  if (coverage >= COVERAGE_BUCKET_THRESHOLDS.high) return 'high';
  if (coverage >= COVERAGE_BUCKET_THRESHOLDS.mid) return 'mid';
  return 'low';
}

// ============================================================================
// §5.5 formulas, applied to ONE candidate across every attribute in the
// plan -- implemented literally, per the task brief:
//
//   assessed         = Σ weight where state ∈ {matched, matched_broadened, mismatch}
//   credit(a)        = tier_credit(a) × (a.broadening ? BROADENING_CREDIT : 1.0)
//   rank_score       = Σ (weight × credit) where state ∈ {matched, matched_broadened}
//                       ÷ assessed × 100          (assessed === 0 -> null, NEVER 0/100)
//   confidence       = assessed ÷ Σ weight(all attributes in the plan)
//   evidence_quality = mean(tier_credit(a)) over matched + matched_broadened
//                       (RAW tier_credit, before the broadening discount --
//                       "evidence_quality" measures how good the evidence
//                       was, not how much the match cost after widening)
//   coverage         = |{a : state ∈ assessed}| / |{a : resolvable}|   -- COUNT, not weight
//                       ("resolvable" = every attribute that made it into
//                       the compiled plan; unresolvable[] attributes never
//                       became attributes at all, so `attributes.length`
//                       already IS that count)
//   confidence_bucket = coverage >= 0.75 ? 'high' : coverage >= 0.5 ? 'mid' : 'low'
// ============================================================================

function scoreCandidateAttributes(founderId, attributes, rowsByAttrFounder) {
  let assessed = 0;
  let assessedCount = 0;
  let numerator = 0;
  let tierSum = 0;
  let tierCount = 0;
  const totalWeight = attributes.reduce((sum, a) => sum + a.weight, 0);

  const attributeViews = attributes.map((attr) => {
    const founderRows = rowsByAttrFounder.get(attr.id).get(founderId) || [];
    const resolved = attr.polarity === 'negative'
      ? resolveNegativeAttributeForCandidate(founderRows)
      : resolvePositiveAttributeForCandidate(attr, founderRows);

    if (ASSESSED_STATES.includes(resolved.state)) {
      assessed += attr.weight;
      assessedCount += 1;
    }

    let tierCredit = null;
    if (CREDITED_STATES.includes(resolved.state)) {
      const base = attr.polarity === 'negative' ? 1.0 : TIER_CREDIT[resolved.tier];
      tierCredit = round2(base * (attr.broadening ? BROADENING_CREDIT : 1.0));
      numerator += attr.weight * tierCredit;
      tierSum += base;
      tierCount += 1;
    }

    return buildAttributeView(attr, resolved, tierCredit);
  });

  const coverage = attributes.length > 0 ? assessedCount / attributes.length : 0;

  return {
    rank_score: assessed > 0 ? round2((numerator / assessed) * 100) : null,
    confidence: totalWeight > 0 ? round2(assessed / totalWeight) : 0,
    coverage: round2(coverage),
    confidence_bucket: computeCoverageBucket(coverage),
    evidence_quality: tierCount > 0 ? round2(tierSum / tierCount) : null,
    attributes: attributeViews,
  };
}

// ============================================================================
// §5.4 rule 6, rev.6 -- total ordering: `has_match DESC, bucket_ordinal
// DESC, rank_score DESC NULLS LAST, founder_id ASC`, where
// `has_match = rank_score > 0`. `confidence` is DELIBERATELY not a sort key
// (rev.4's `rank_score DESC, confidence DESC, founder_id ASC` is
// superseded) -- it is still published on every item, just not used to
// order the list. `founder_id` is the unique final key, so the order is
// total regardless of which comparator is in play.
//
// `has_match` LEADS the sort (rev.6 -- found by running Q2 live against the
// deployed workflow, after the bucket order was already approved). Bucket
// -first ordering optimises for *how much we assessed* over *whether it
// matches*, and at the extreme that inverts: live Q2 put a founder with
// `rank_score = 0` (two demonstrable `mismatch`es, one `unknown`) at
// position 1, above nine founders at `rank_score = 100`, purely because his
// coverage (0.67, `mid`) beat theirs (0.33, `low`). "We know this person
// well and they do not fit" is not the best answer to a search query.
// Zero-match candidates stay in `items[]` -- they are honest output ("we
// assessed these and nothing matched") -- they just sink below every
// candidate with any match at all.
//
// Checked against the case that motivated bucketing in the first place: a
// 1-of-4 documented match (rank 100, bucket `low`) and a 4-of-4 match (rank
// 92.5, bucket `high`) BOTH have `has_match = true` (rank_score > 0 for
// both), so this new leading term does not separate them and the bucket
// still decides -- 92.5 correctly stays above 100. No regression (asserted
// by a dedicated test, kept deliberately next to the new has_match
// regression test below it, since the two pull in opposite directions and
// a fix for one can silently break the other).
//
// Two comparators, matching the two states §5.4/§5.5 actually describe:
//   compareByBucket   -- the default. Leads with has_match, then sorts the
//                         bucket ORDINAL INTEGER (never the bucket string --
//                         alphabetically 'high' < 'low' < 'mid', so a naive
//                         string DESC sort silently inverts to
//                         mid -> low -> high).
//   compareByRankOnly -- used ONLY when `low_confidence_only` fires: every
//                         candidate is below the floor and carries
//                         `confidence_bucket: null` (rule 6), so bucket
//                         cannot be the primary key -- falls back to
//                         `rank_score DESC NULLS LAST, founder_id ASC`
//                         (unchanged by rev.6 -- design.md's own rule 6
//                         text for this branch was not touched, and
//                         plain `rank_score DESC` already sinks a
//                         zero-match candidate below every positive-rank
//                         one on its own, so no extra `has_match` term is
//                         needed here).
// `null` rank_score (assessed === 0) sorts after every non-null value in
// BOTH comparators -- an unassessed candidate is never presented as
// ranking above an assessed one. `has_match` is false for `rank_score:
// null` too (typeof null !== 'number'), so an unassessed candidate never
// benefits from the leading term either -- it sinks with the mismatched
// ones, below every candidate with a real match.
// ============================================================================

function compareRankThenFounder(a, b) {
  if (a.rank_score !== b.rank_score) {
    if (a.rank_score === null) return 1;
    if (b.rank_score === null) return -1;
    return b.rank_score - a.rank_score;
  }
  if (a.founder_id < b.founder_id) return -1;
  if (a.founder_id > b.founder_id) return 1;
  return 0;
}

// has_match = rank_score > 0 (rev.6). `typeof item.rank_score === 'number'`
// guards the `assessed === 0` case (`rank_score: null`) -- `null > 0` is
// already `false` in JS, but the explicit typeof check keeps this readable
// as "a real, positive rank", not an accident of loose comparison.
function hasMatch(item) {
  return typeof item.rank_score === 'number' && item.rank_score > 0;
}

function compareByBucket(a, b) {
  const matchA = hasMatch(a);
  const matchB = hasMatch(b);
  if (matchA !== matchB) return matchA ? -1 : 1; // has_match DESC

  const ordA = COVERAGE_BUCKET_ORDINAL[a.confidence_bucket] || 0;
  const ordB = COVERAGE_BUCKET_ORDINAL[b.confidence_bucket] || 0;
  if (ordA !== ordB) return ordB - ordA; // DESC on the ORDINAL, never the string
  return compareRankThenFounder(a, b);
}

function compareByRankOnly(a, b) {
  return compareRankThenFounder(a, b);
}

// ============================================================================
// `plan` echo (§5.6: "plan is echoed so the caller sees how its words were
// interpreted"). Strips the internal `descriptor` field (lib/f10/plan.js) --
// that is a PostgREST fetch instruction, not something the calling human or
// agent needs to see.
// ============================================================================

function echoPlan(plan) {
  return {
    attributes: (plan.attributes || []).map((a) => {
      const out = {
        id: a.id, label: a.label, kind: a.kind, polarity: a.polarity,
        target: a.target, op: a.op, weight: a.weight,
      };
      if (a.value !== null && a.value !== undefined) out.value = a.value;
      if (a.broadening) {
        out.broadening = a.broadening;
        out.resolved_as = a.resolved_as;
      }
      return out;
    }),
    unresolvable: (plan.unresolvable || []).map((u) => ({ label: u.label, reason: u.reason })),
  };
}

// ============================================================================
// §5.4 rule 4, zero-positive fallback -- "fall back to all founders ordered
// by founder_score DESC NULLS LAST, every attribute unknown, confidence: 0,
// and a note explaining why." lib/f10/score.js has no database access, so
// the candidate universe for this path comes from `fetchedRows.founders`
// (the n8n workflow is expected to fetch api_founders unconditionally, the
// same way it must for display-metadata enrichment on the normal path --
// documented as the module's one reserved fetchedRows key, alongside the
// per-attribute-id keys).
// ============================================================================

function zeroPositiveFallback(founders, attributes, echoedPlan) {
  const list = Array.isArray(founders) ? founders.slice() : [];
  list.sort((a, b) => {
    const fa = typeof a.founder_score === 'number' ? a.founder_score : -Infinity;
    const fb = typeof b.founder_score === 'number' ? b.founder_score : -Infinity;
    if (fb !== fa) return fb - fa; // DESC, NULLS LAST
    return String(a.founder_id) < String(b.founder_id) ? -1 : 1;
  });
  const truncated = list.length > CANDIDATE_CAP;
  const capped = list.slice(0, CANDIDATE_CAP);

  const forcedAttributes = attributes.map((attr) => ({
    id: attr.id, label: attr.label, kind: attr.kind, polarity: attr.polarity,
    state: STATES.UNKNOWN, weight: attr.weight, tier_credit: null, evidence: null,
    note: 'zero resolvable positive attributes in this query -- nothing was fetched to assess it against',
  }));

  const items = capped.map((f) => {
    const metaMap = new Map([[f.founder_id, f]]);
    return {
      ...founderDisplay(f.founder_id, metaMap),
      rank_score: null,
      confidence: 0,
      // §5.4 rule 4's fallback is a SEPARATE escape hatch from rule 6's
      // low_confidence_only bucket-nulling -- computed literally per the
      // formula (0 assessed of N attributes -> coverage 0 -> bucket 'low'
      // uniformly for every item here) rather than special-cased to null;
      // it carries no ranking weight either way since this path's own
      // order is founder_score DESC NULLS LAST, not the bucket sort.
      coverage: 0,
      confidence_bucket: attributes.length > 0 ? 'low' : null,
      evidence_quality: null,
      attributes: forcedAttributes,
    };
  });

  return {
    items,
    low_confidence: [],
    total: capped.length,
    truncated,
    low_confidence_only: false,
    note: 'no attribute in this query resolved to a positive, queryable target -- returning all founders ordered by founder_score, unassessed',
    plan: echoedPlan,
  };
}

// ============================================================================
// score(plan, fetchedRows) -- the module's one entry point.
//
//   plan        -- the COMPILED plan from lib/f10/plan.js's validatePlan()
//                  (`{ attributes: [...], unresolvable: [...] }`, each
//                  attribute already carrying its `weight` and `descriptor`).
//   fetchedRows -- `{ [attribute.id]: Row[], founders: FounderRow[] }`.
//                  Row shape matches api_claims (design §4.3) for
//                  claim_topic attributes: `{ claim_id, founder_id, topic,
//                  value, verification_status, created_at, evidence[] }`.
//                  `founders` is the one reserved key beyond the
//                  per-attribute ones -- api_founders rows used both for
//                  display enrichment of scored candidates and as the
//                  universe for the zero-positive fallback.
// ============================================================================

function score(plan, fetchedRows) {
  const compiledPlan = isPlainObject(plan) ? plan : {};
  const attributes = Array.isArray(compiledPlan.attributes) ? compiledPlan.attributes : [];
  const unresolvable = Array.isArray(compiledPlan.unresolvable) ? compiledPlan.unresolvable : [];
  const rows = isPlainObject(fetchedRows) ? fetchedRows : {};

  const echoedPlan = echoPlan({ attributes, unresolvable });
  const positiveAttrs = attributes.filter((a) => a.polarity !== 'negative');

  if (positiveAttrs.length === 0) {
    return zeroPositiveFallback(rows.founders, attributes, echoedPlan);
  }

  // QA finding B -- company-scoped rows (structural claim_topic targets)
  // carry no founder_id; this index resolves them to their company's
  // CURRENT founders so structural attributes can be indexed and gathered
  // exactly like founder-scoped ones.
  const founderIndex = buildFounderIndex(rows.founders);

  const rowsByAttrFounder = new Map();
  for (const attr of attributes) {
    rowsByAttrFounder.set(attr.id, indexRowsByFounder(rows[attr.id], founderIndex));
  }

  const { ids: candidateIds, truncated } = gatherCandidateIds(positiveAttrs, rows, founderIndex);

  if (candidateIds.length === 0) {
    return {
      items: [],
      low_confidence: [],
      total: 0,
      truncated: false,
      low_confidence_only: false,
      note: 'no candidate carried any evidence for a positive attribute in this plan',
      plan: echoedPlan,
    };
  }

  const founderMeta = buildFounderMetaMap(rows.founders);
  const scored = candidateIds.map((founderId) => {
    const result = scoreCandidateAttributes(founderId, attributes, rowsByAttrFounder);
    return { ...founderDisplay(founderId, founderMeta), ...result };
  });

  const main = scored.filter((it) => it.confidence >= CONFIDENCE_FLOOR);
  const low = scored.filter((it) => it.confidence < CONFIDENCE_FLOOR);

  // §5.5 -- "if NO candidate clears the floor, items[] is populated anyway"
  // (rev.4 F3): the bucket [array] exists to stop weak hits outranking
  // strong ones, never to make the endpoint return nothing.
  const noCandidateClearedFloor = main.length === 0 && scored.length > 0;

  if (noCandidateClearedFloor) {
    // §5.4 rule 6, rev.5 review round 4 F9: every candidate is below the
    // floor and has no confidence_bucket (nulled below, distinct from
    // low_confidence_only[]'s array bucketing) -- the primary sort key
    // falls back to rank_score DESC NULLS LAST, founder_id ASC, or the
    // order would depend on sort stability with a null key on every row.
    const items = scored.map((it) => ({ ...it, confidence_bucket: null }));
    items.sort(compareByRankOnly);
    return {
      items,
      low_confidence: [],
      total: candidateIds.length,
      truncated,
      low_confidence_only: true,
      note: `no candidate reached the confidence floor (${CONFIDENCE_FLOOR}) -- showing every scored candidate ranked by rank_score rather than an empty result`,
      plan: echoedPlan,
    };
  }

  main.sort(compareByBucket);
  low.sort(compareByBucket);

  return {
    items: main,
    low_confidence: low,
    total: candidateIds.length,
    truncated,
    low_confidence_only: false,
    note: null,
    plan: echoedPlan,
  };
}

module.exports = {
  classifyRow,
  pickLatestPerTopic,
  evalOpMatch,
  resolvePositiveAttributeForCandidate,
  resolveNegativeAttributeForCandidate,
  buildAttributeView,
  buildFounderIndex,
  resolveRowFounderIds,
  indexRowsByFounder,
  gatherCandidateIds,
  hasMatch,
  computeCoverageBucket,
  scoreCandidateAttributes,
  compareByBucket,
  compareByRankOnly,
  echoPlan,
  score,
};
