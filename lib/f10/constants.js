// lib/f10/constants.js
// SOURCE OF TRUTH -- do not edit inside the n8n Code node, edit here and re-paste.
//
// Shared constants for feature 10's deterministic query-plan executor
// (lib/f10/plan.js, lib/f10/score.js). Authoritative source: docs/backlog/
// 10-api-cli-skill/design.md rev.4 §5.4 (constants block), §5.5 (formulas),
// §5.3 (attribute taxonomy). Every number here is quoted verbatim from that
// constants block -- do not recompute or "improve" any of them without a
// design.md change first (rev.2's review B4: weights come from a fixed
// table, never from the LLM, so the same query ranks identically on every
// run).
//
// Self-contained CommonJS, zero imports -- matches lib/f02/normalize.js and
// lib/f07/vocabulary.js's zero-dependency convention.
//
// docs/backlog/10-api-cli-skill/plan.md, task B1.

'use strict';

// ============================================================================
// §5.4 -- fixed weight table, keyed by attribute `kind`. THIS BUILD SUPPORTS
// TWO KINDS ONLY (rev.4 -- velocity/text cut; nl-search-resolver-agent-json-
// schema.json's `kind` enum has exactly these two members). `negative` is a
// `polarity`, not a `kind` -- a negative attribute is weighted by its
// subject-matter kind (§5.3: "negative is NOT a kind... weighted by its
// subject kind").
// ============================================================================

const WEIGHTS = Object.freeze({
  provenance: 25,
  structural: 20,
});

// §5.5 tier table. `missing` is deliberately ABSENT from this map -- a
// `missing`-tier claim is never a match (it resolves to the display state
// `unknown_searched`, scorer-invisible, §5.5); looking it up here would
// silently coerce "we looked and found nothing" into a numeric credit if a
// caller ever slipped up and used TIER_CREDIT[tier] without the
// missing-tier guard score.js applies before every lookup.
const TIER_CREDIT = Object.freeze({
  documented: 1.0,
  discovered: 0.7,
  inferred: 0.4,
});

// §5.3 / §5.5 -- a widened match (city asked for, country answered) costs
// something real in the ranking, not only in the label. Applied as a
// multiplier on top of TIER_CREDIT, never in place of it.
const BROADENING_CREDIT = 0.75;

// §5.5 -- candidates with confidence below this land in the low_confidence[]
// bucket, never interleaved with the ranked list. Mirrors 07's
// `min_coverage` / 03's 0.25 threshold (house convention, not a coincidence
// per design.md's own citation).
const CONFIDENCE_FLOOR = 0.25;

// §5.4 rule 5 -- the candidate-gathering cap. NOT a page-size limit (that is
// the caller's `limit` parameter, applied by the n8n workflow / CLI on top
// of what this module returns) -- this is "how many candidates get scored
// at all" before the ranked list is even built. `total` reports the
// post-cap size of the scored set; `truncated` is true only when the
// pre-cap union exceeded this number (§5.4 rule 5, §5.6).
const CANDIDATE_CAP = 200;

// §5.4 rule 6, rev.5 (spec delta, review round 4) -- primary sort key.
// `rank_score` alone put the LEAST-known founders at the head of the list:
// one matched attribute at `documented` scores 100, while a founder who
// satisfies every attribute in a 4-attribute query scores 92.5 (his
// evidence merely averages 0.93, not 1.0), and the confidence floor does
// not catch the sparse case -- 1-of-4 assessed lands confidence EXACTLY at
// the 0.25 floor, which is not `< 0.25`. `coverage` fixes this by counting
// ASSESSED ATTRIBUTES, never weight -- weight-based bucketing sits exactly
// on the achievable lattice for equal-weight queries and diverges from its
// own meaning the moment weights differ by kind (three `provenance` + one
// `structural` assessed buckets `high` or `mid` depending on WHICH three,
// if weighted). `confidence` is unchanged, still published, still the
// floor -- `coverage`/`confidence_bucket` are a NEW, separate, count-based
// axis, sorted lexicographically ahead of `rank_score` rather than fused
// into it (invariant #1: independent signals are never collapsed).
//
// Sort the ORDINAL INTEGER, never the bucket string -- alphabetically
// 'high' < 'low' < 'mid', so a naive `DESC` string sort yields
// mid -> low -> high, the exact inversion of intent, silently.
const COVERAGE_BUCKET_ORDINAL = Object.freeze({ high: 3, mid: 2, low: 1 });

// coverage >= 0.75 -> 'high' ; >= 0.5 -> 'mid' ; else 'low'. Thresholds are
// design.md's own, not tuned here.
const COVERAGE_BUCKET_THRESHOLDS = Object.freeze({ high: 0.75, mid: 0.5 });

// §5.5 -- the three-state matching vocabulary, plus the two display-only
// states carved out by rev.3/rev.4 (`matched_broadened`, `unknown_searched`).
// Exported as a frozen object so both plan.js and score.js reference the
// same literal strings rather than each hand-typing them.
const STATES = Object.freeze({
  MATCHED: 'matched',
  MATCHED_BROADENED: 'matched_broadened',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
  UNKNOWN_SEARCHED: 'unknown_searched',
});

// §5.5 -- states that count toward `assessed` (the rank_score denominator).
// `unknown` and `unknown_searched` are deliberately absent -- both are
// "genuinely free": they lower `confidence` only, never `rank_score`
// (design.md's own words, twice, for exactly this reason).
const ASSESSED_STATES = Object.freeze([STATES.MATCHED, STATES.MATCHED_BROADENED, STATES.MISMATCH]);

// States that contribute to the rank_score NUMERATOR (rev.4 F2 fix:
// `matched_broadened` belongs here too -- rev.3 left it in `assessed` only,
// which scored a widened match identically to a mismatch).
const CREDITED_STATES = Object.freeze([STATES.MATCHED, STATES.MATCHED_BROADENED]);

module.exports = {
  WEIGHTS,
  TIER_CREDIT,
  BROADENING_CREDIT,
  CONFIDENCE_FLOOR,
  CANDIDATE_CAP,
  STATES,
  ASSESSED_STATES,
  CREDITED_STATES,
  COVERAGE_BUCKET_ORDINAL,
  COVERAGE_BUCKET_THRESHOLDS,
};
