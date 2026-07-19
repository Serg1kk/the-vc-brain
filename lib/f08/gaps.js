// lib/f08/gaps.js
// SOURCE OF TRUTH: lib/f08/gaps.js
//
// Deterministic gap-question selection for feature 08, design.md §6 ("Gap
// questions -- deterministic selection, LLM only for phrasing"). Selection
// is code, never a model: read `score_formulas.config.criteria` (the row
// for `axis='founder_score' AND active`, resolved by the CALLER -- this
// file only ever sees the `criteria` array/object already extracted from
// that row's `config`), keep criteria whose `neg_src` is reachable WITHOUT
// public sources (deck or interview only), drop those already covered by an
// existing claim, rank by weight, cap at 3.
//
// Against the live seeded formula (`db/seed.sql`, `formula_v1`/
// `founder_score`) this returns exactly `[L2, L3, X5]` in that order --
// X1/X2 both carry `tavily_extract` in `neg_src` (a public source CAN reach
// them), so they fail the reachability filter and are never asked. See
// design.md §6's own table for why exactly these three.
//
// Self-contained CommonJS, ZERO imports/requires (docs/backlog/TRACKER.md
// hard convention). lib/f08/completeness.js (T9) duplicates the
// reachability filter and the CRITERION_TOPIC map below rather than
// requiring this file, for the same "one Code node per file" reason --
// gaps.test.js and completeness.test.js both cross-check the two copies
// stay equal.

'use strict';

// ============================================================================
// CRITERION_TOPIC -- the criterion-id -> claims.topic mapping this file
// needs to check "is this criterion already covered by a claim". 03's own
// design.md §4.7 only defines PREFIX-level routing (founder.execution.* /
// .expertise.* / .leadership.* -> sub-scorer), not a per-criterion topic
// slug -- that vocabulary is otherwise open (01 design §11) and 03's own
// fixture only exercises E1/E3/E4/E5/E7/X1/X2/X6/L5, never L2/L3/X5 (the
// only three this file cares about). This map CLOSES that gap for exactly
// the three criteria gap-selection needs, following the existing naming
// style (vertical_tenure, insight_specificity, written_communication, ...):
// `L2 -> founder.leadership.first_customers` is pinned directly by plan.md
// T8's own acceptance criterion; `L3`/`X5` are this file's own choice,
// named in parallel style (L3's anchor literally says "ICP specificity";
// X5's says "insider granularity"). Flagged for review rather than assumed
// silent -- if 03 or 07 later establishes a DIFFERENT topic string for
// either, this map is the one place to update, and every consumer here
// reads through it rather than hardcoding a topic elsewhere.
//
// The other nine are carried too (not strictly required, since the live
// config's neg_src filter below excludes them from ever needing a coverage
// check), purely so this map stays a complete, single source of truth for
// "criterion id -> topic" rather than a partial one that would silently
// need extending the day a future formula version widens the reachable set.
const CRITERION_TOPIC = {
  E1: 'founder.execution.merged_pr_foreign',
  E3: 'founder.execution.commit_consistency',
  E4: 'founder.execution.live_product',
  E5: 'founder.execution.external_usage',
  E7: 'founder.execution.provenance',
  X1: 'founder.expertise.vertical_tenure',
  X2: 'founder.expertise.insight_specificity',
  X5: 'founder.expertise.competitor_granularity',
  X6: 'founder.expertise.unasked_work',
  L2: 'founder.leadership.first_customers',
  L3: 'founder.leadership.icp_specificity',
  L5: 'founder.leadership.written_communication',
};

// Criteria whose `neg_src` is a subset of this set can be closed WITHOUT any
// public source -- design.md §6: "keep criteria whose neg_src contains
// ONLY deck_parse and interview_answer". `raw` is not neg_src at all (it is
// the model's own confidence-cap input, 03 design §2.3) so it never appears
// here.
const GAP_REACHABLE_SOURCES = new Set(['deck_parse', 'interview_answer']);

// ============================================================================
// Shared helpers
// ============================================================================

// `config.criteria` arrives as a jsonb ARRAY in the live `score_formulas`
// row (db/seed.sql), NOT an object keyed by id -- 03's own done.md warns
// about this explicitly ("config.criteria ... are jsonb ARRAYS, not objects
// keyed by id"). Both shapes are accepted here defensively, same as
// lib/f03/scoring.js's normalizeCriteriaRegistry(), because this file
// cannot require() that one either (zero-imports constraint) -- kept as its
// own small independent copy, narrowed to a list rather than a by-id map
// since gap selection iterates, it does not look up by id.
function normalizeCriteriaList(criteria) {
  if (!criteria) return [];
  if (Array.isArray(criteria)) return criteria.filter(Boolean);
  return Object.keys(criteria).map((id) => ({ id, ...criteria[id] }));
}

// True when EVERY entry in `neg_src` is deck/interview-reachable (and there
// is at least one entry -- an empty/missing neg_src is not "reachable by
// nothing", it is unspecified, and treating it as reachable would silently
// start asking about a criterion the config never intended to be
// interview-answerable at all).
function isGapReachable(criterion) {
  const negSrc = Array.isArray(criterion.neg_src) ? criterion.neg_src : [];
  if (negSrc.length === 0) return false;
  return negSrc.every((src) => GAP_REACHABLE_SOURCES.has(src));
}

// "Covered" -- design.md §6, R-7: a claim exists on the criterion's BASE
// topic with `verification_status` other than `'missing'`. 07/design.md:734
// (corrected 2026-07-19) is the authoritative convention: gaps use the base
// topic + `verification_status='missing'`, NOT a `.gap`-suffixed topic --
// the earlier `.gap` wording in 07/handoff.md §4 was wrong. Because this
// check is an EXACT topic-string match, a `.gap`-suffixed row (the old,
// wrong convention, should it ever appear from a stale writer) can never
// match the base topic here and therefore can never be mistaken for
// coverage either -- no separate suffix-stripping logic is needed for that
// half; only the `verification_status !== 'missing'` filter is load-bearing.
//
// This is the exact defect design.md §6/plan.md T8 call out: 07 (and 08's
// own deck cascade on an image-only deck, design.md §5) write a `missing`
// claim on a topic as an honest "looked, found nothing" marker -- a naive
// "does ANY claim exist on this topic" check would read that absence marker
// as coverage and suppress exactly the question worth asking.
function isCriterionCovered(criterionId, claims) {
  const topic = CRITERION_TOPIC[criterionId];
  if (!topic) return false; // unknown criterion id -- cannot check, so not covered (ask rather than silently skip)
  const list = Array.isArray(claims) ? claims : [];
  return list.some((c) => c && c.topic === topic && c.verification_status !== 'missing');
}

// ============================================================================
// selectGapCriteria -- design.md §6's full pipeline: filter reachable ->
// drop covered -> rank by weight desc -> cap.
//
// selectGapCriteria({criteria, claims, cap}) -> criterion objects (id,
// weight, anchor, neg_src, subscorer, topic), ranked, length 0..cap. Returns
// full objects rather than bare ids because the downstream
// `gap-question-phraser` agent (design.md §7) needs `id`, `anchor` and
// `weight` as its own input -- callers wanting the bare-id list the plan's
// AC is phrased against can `.map(c => c.id)`.
// ============================================================================

function selectGapCriteria({ criteria, claims, cap = 3 } = {}) {
  const reachable = normalizeCriteriaList(criteria).filter(isGapReachable);
  const uncovered = reachable.filter((c) => !isCriterionCovered(c.id, claims));
  const ranked = uncovered.slice().sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return ranked.slice(0, cap).map((c) => ({ ...c, topic: CRITERION_TOPIC[c.id] ?? null }));
}

module.exports = {
  CRITERION_TOPIC,
  GAP_REACHABLE_SOURCES,
  normalizeCriteriaList,
  isGapReachable,
  isCriterionCovered,
  selectGapCriteria,
};
