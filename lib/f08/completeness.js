// lib/f08/completeness.js
// SOURCE OF TRUTH: lib/f08/completeness.js
//
// `cards.completeness` for feature 08, design.md §6.1: covered weight ÷
// reachable weight, over the SAME three-criterion set lib/f08/gaps.js
// selects from (the criteria whose neg_src is deck/interview-reachable --
// L2/L3/X5 against the live seeded formula).
//
// THIS IS NOT 03's `coverage`. Stated here per design.md §6.1's own
// instruction ("the two must never be rendered as the same quantity"):
// - 03's `coverage` (lib/f03/scoring.js, `aggregate()`) spans ALL TWELVE
//   founder_score criteria, assessed against a ~0.704 ceiling that includes
//   criteria no founder-side action can ever close (E1/E3/E4/E5/E7 need
//   `github_api`; L5 needs `hn_algolia`). It answers "how much of the
//   founder's TOTAL score is evidenced".
// - 08's `card_completeness` (this file) spans only the three criteria a
//   FOUNDER can personally close by answering a gap question, against a
//   ceiling of exactly their combined weight (0.29625 in the live config).
//   It answers "of the questions we could still ask you, how many have you
//   answered" -- the dashboard renders it as "how complete your card is",
//   never as a score (design.md §6.1).
// A founder who skips every gap question can show `card_completeness: 0.0`
// while still carrying a perfectly respectable `founder_score.coverage`
// from public signals alone -- the two numbers are allowed, and expected, to
// disagree.
//
// Self-contained CommonJS, ZERO imports/requires (docs/backlog/TRACKER.md
// hard convention). Duplicates lib/f08/gaps.js's CRITERION_TOPIC map and
// reachability filter rather than requiring that file (each lib/f08/*.js
// file is pasted into its own separate n8n Code node) -- kept in lockstep
// by hand; completeness.test.js cross-checks the two copies stay equal.

'use strict';

// ---- duplicated from lib/f08/gaps.js; see that file's header for why. ----

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

const GAP_REACHABLE_SOURCES = new Set(['deck_parse', 'interview_answer']);

function normalizeCriteriaList(criteria) {
  if (!criteria) return [];
  if (Array.isArray(criteria)) return criteria.filter(Boolean);
  return Object.keys(criteria).map((id) => ({ id, ...criteria[id] }));
}

function isGapReachable(criterion) {
  const negSrc = Array.isArray(criterion.neg_src) ? criterion.neg_src : [];
  if (negSrc.length === 0) return false;
  return negSrc.every((src) => GAP_REACHABLE_SOURCES.has(src));
}

function isCriterionCovered(criterionId, claims) {
  const topic = CRITERION_TOPIC[criterionId];
  if (!topic) return false;
  const list = Array.isArray(claims) ? claims : [];
  return list.some((c) => c && c.topic === topic && c.verification_status !== 'missing');
}

// ---- rounding: matches cards.completeness numeric(3,2) (db/schema.sql). ----

function round2(value) {
  return Number(value.toFixed(2));
}

// ============================================================================
// cardCompleteness({criteria, claims}) -> number, 0..1, rounded to 2dp.
//
// Guarded against an empty reachable set (0/0 -> 0.0 rather than NaN),
// though the live config never produces one (min three criteria always
// pass the reachability filter, same guard shape as lib/f03/scoring.js's
// `allWeight > 0 ? ... : 0` for its own coverage calculation).
// ============================================================================

function cardCompleteness({ criteria, claims } = {}) {
  const reachable = normalizeCriteriaList(criteria).filter(isGapReachable);
  const reachableWeight = reachable.reduce((sum, c) => sum + (c.weight ?? 0), 0);
  if (reachableWeight <= 0) return 0;

  const coveredWeight = reachable
    .filter((c) => isCriterionCovered(c.id, claims))
    .reduce((sum, c) => sum + (c.weight ?? 0), 0);

  return round2(coveredWeight / reachableWeight);
}

module.exports = {
  CRITERION_TOPIC,
  GAP_REACHABLE_SOURCES,
  normalizeCriteriaList,
  isGapReachable,
  isCriterionCovered,
  round2,
  cardCompleteness,
};
