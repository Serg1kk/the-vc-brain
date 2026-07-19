// lib/f02/obscurity.js
// SOURCE OF TRUTH: lib/f02/obscurity.js
//
// Deterministic obscurity formula for feature 02 (Sourcing Radar), design.md
// §6.4. Self-contained CommonJS, ZERO imports, pure function, no I/O.
//
//   followers_term = 1 - clamp(log10(1 + gh_followers) / 3, 0, 1)   -- 999+ followers -> 0
//   karma_term     = 1 - clamp(log10(1 + hn_karma)     / 4, 0, 1)   -- 9999+ karma    -> 0
//   obscurity      = round(mean(OBSERVED terms), 4)
//
// ---------------------------------------------------------------------------
// REVISED 2026-07-19 after the second spec-review round. The first version of
// this file implemented "either input missing -> null", which is the
// SUPERSEDED rule. It survived here by an orchestration slip: the corrected
// semantics were relayed to the terminal building the SQL view but not to the
// one building this file, so `radar_candidates.obscurity` (production) and
// this function (CLI + tests) disagreed -- the view returned 0.8807 for a
// karma-only founder while this returned null. Two implementations of one
// formula is exactly the drift the design warns about; they are now aligned
// term-for-term with the view in db/schema.sql.
//
// Corrected rule (design §6.4 "Any-missing vs all-missing"): `hn_karma` is
// available for essentially every candidate (the HN handle always exists) but
// `gh_followers` resolves only ~36% of the time, so "any missing -> null"
// would blank the feature's headline column for the majority of candidates.
// Therefore: average over the OBSERVED terms only.
//
//   * both observed        -> mean of the two terms, basis = both names
//   * exactly one observed -> that single term, unmodified, basis = [name]
//   * neither observed     -> value null, basis null
//
// STILL ABSOLUTELY FORBIDDEN: 0-substituting a missing input. Averaging in a
// substituted karma_term(0) = 1.0 for a founder with no karma observation
// would pull a followers-only obscurity UP toward 1.0 ("maximally
// undiscovered"), floating missing data to the TOP of the feed -- REQ-003
// running backwards, and the precise defect §0 criticises `vantage` for.
// Absence must SHRINK the term count the mean is taken over, never contribute
// a value to it.
//
// This function reads ONLY `ghFollowers` and `hnKarma` off its argument. No
// other field has any effect (guarded by a test) -- REQ-002's "obscurity is
// never folded into founder quality" enforced structurally, so a stray
// founder-quality signal riding along on the same object cannot leak in.

'use strict';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  return Number(value.toFixed(4));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// A negative follower/karma count is not a real observation -- treated as
// "unknown" (term omitted) rather than fed into log10 of a negative-adjacent
// value.
function isObserved(v) {
  return isFiniteNumber(v) && v >= 0;
}

// computeObscurity({ghFollowers, hnKarma}) -> {value, basis}
//   value: number in [0,1], or null when NO term is observed
//   basis: array of the metric slugs the value was computed from, or null
// `basis` mirrors radar_candidates.obscurity_basis so feature 09 can show
// that a one-term value is weaker evidence than a two-term one.
function computeObscurity(input) {
  const ghFollowers = input && input.ghFollowers;
  const hnKarma = input && input.hnKarma;

  const terms = [];
  const basis = [];

  if (isObserved(ghFollowers)) {
    terms.push(1 - clamp(Math.log10(1 + ghFollowers) / 3, 0, 1));
    basis.push('gh_followers');
  }
  if (isObserved(hnKarma)) {
    terms.push(1 - clamp(Math.log10(1 + hnKarma) / 4, 0, 1));
    basis.push('hn_karma');
  }

  if (terms.length === 0) return { value: null, basis: null };

  const mean = terms.reduce(function (a, b) { return a + b; }, 0) / terms.length;
  return { value: round4(mean), basis: basis };
}

// Thin wrapper for callers that only want the number (run.js's CLI summary,
// pipeline.js's diagnostic echo). Same computation -- never a second formula.
function obscurity(input) {
  return computeObscurity(input).value;
}

module.exports = {
  obscurity,
  computeObscurity,
  clamp,
  round4,
};
