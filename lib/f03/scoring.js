// lib/f03/scoring.js
//
// Deterministic aggregation core for feature 03 (Founder Score). Pure
// functions only -- NO imports, NO requires, no I/O, no network, no
// Date.now()/Math.random() anywhere. This file's body is pasted verbatim
// into an n8n Code node with a `// SOURCE OF TRUTH` header (plan.md guiding
// decision 3): n8n's Code-node sandbox has no bind-mount of this repo and
// cannot `require()` from it, so a single stray `require()` here would make
// the file unusable in production. "The model proposes booleans, the
// backend decides the number" (design.md §0) -- this is the "the number"
// half; lib/f03/gate.js (B2) is the half that decides verdicts/tiers.
//
// Authoritative source for every formula: docs/backlog/03-founder-score/
// design.md rev 3 -- section cited inline next to each piece. Every tunable
// constant (weights, credits, tier factors, min_coverage, trend_epsilon) is
// read from the `config` argument passed to aggregate(); nothing here is
// hardcoded (plan.md B1 task brief: "Read them from the passed config
// object; hardcode nothing").
//
// ============================================================================
// Config shape (design §2.3 constants block + §3 criteria registry). This is
// the jsonb payload the caller reads from the active `score_formulas` row --
// see the note above computeTrend() for why `version` is folded in here too.
//
//   {
//     version: 'formula_v1',
//     min_coverage: 0.25,
//     trend_epsilon: 3.0,
//     tier_factor: { documented: 1.0, discovered: 0.7, inferred: 0.4, missing: 0.0 },
//     credit:      { met_documented: 1.0, met_discovered: 0.8, self_asserted: 0.3, not_met: 0.0 },
//     criteria: {                    // §3 -- ALL criteria that exist for this
//       E1: { weight: 0.10000, subscorer: 'execution-signals', ... },  // formula version; the
//       ...                                                            // authoritative source
//     },                                                                // of "all_weight" (below)
//   }
//
// `config.criteria` is accepted in EITHER shape: an object keyed by
// criterion_id (above) OR an array of `{ id, weight, ... }` elements -- the
// live `score_formulas.config->'criteria'` row (B3a) stores it as a jsonb
// ARRAY (`[{"id":"E1","raw":5,"weight":0.10000,...}, ...]`), not an object.
// normalizeCriteriaRegistry() below folds either shape into the internal
// by-id map every lookup in this file uses, so a caller can pass the config
// row through unchanged -- same normalization lib/f03/gate.js already
// applies, kept independent here (no shared import, per the zero-imports
// constraint) but matching its behaviour exactly.
//
// Component shape -- one entry per criterion in `config.criteria`, produced
// by gate.js (B2). verdict + evidence_tier are ALREADY backend-decided per
// design §4.4 by the time they reach this file; aggregate() only aggregates,
// it never assigns either (that would re-do gate.js's job in the wrong
// layer):
//
//   {
//     criterion_id: 'E1',
//     verdict: 'met' | 'self_asserted' | 'not_met' | 'cannot_assess',
//     evidence_tier: 'documented' | 'discovered' | 'inferred' | 'missing' | null,
//     claim_ids: [...],              // optional, defaults to []
//     what_would_close_it: '...',    // optional, used only for cannot_assess rows
//     // + any other pass-through fields (subscorer, quote_verbatim,
//     //   rationale, demoted_by, ...) -- echoed back untouched on the
//     //   `components` key of aggregate()'s return value.
//   }
// ============================================================================

'use strict';

// ----------------------------------------------------------------------------
// Small shared helpers
// ----------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Rounds to 2dp via the same `toFixed` mechanism the property tests check
// against (`Number(v.toFixed(2)) === v`) -- design §2.3 rounding discipline:
// "value -> round 2dp, clamp [0,100]; confidence -> round 2dp, clamp [0,1];
// applied in the aggregate node before insert. numeric(5,2) would otherwise
// reject a float-computed 100.005."
function round2(value) {
  return Number(value.toFixed(2));
}

// Rounds to 5dp, matching `score_components.contribution numeric(8,5)`
// (design §4.2) -- the column's own precision, not an arbitrary choice.
function round5(value) {
  return Number(value.toFixed(5));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const ASSESSED_VERDICTS = new Set(['met', 'self_asserted', 'not_met']);

// ----------------------------------------------------------------------------
// §2.2 / §2.3 -- credit and tier_factor lookups. Both are backend arithmetic
// on values gate.js already decided (verdict, evidence_tier); this file does
// not re-derive either.
// ----------------------------------------------------------------------------

// credit(verdict, evidence_tier) -- §2.2 table + §2.3 constants block. `met`
// splits on evidence_tier because the credit map has no single 'met' key: it
// carries `met_documented` and `met_discovered` separately. §2.3, verbatim:
// "the credit map has no met_inferred / met_missing entry by construction:
// §4.4 step 5a coerces such a verdict to self_asserted before aggregation,
// so the case cannot reach the formula" -- i.e. by the time a component
// reaches aggregate(), a 'met' verdict's evidence_tier is guaranteed
// 'documented' or 'discovered'. Anything else (a gate.js defect, not this
// file's to police) falls through to met_discovered rather than throwing --
// that coercion is gate.js's contract to keep, not this file's to enforce.
function creditFor(verdict, evidenceTier, creditMap) {
  if (verdict === 'met') {
    return evidenceTier === 'documented' ? creditMap.met_documented : creditMap.met_discovered;
  }
  if (verdict === 'self_asserted') return creditMap.self_asserted;
  if (verdict === 'not_met') return creditMap.not_met;
  return null; // cannot_assess -- credit n/a, excluded from every sum (§2.3)
}

// tier_factor(evidence_tier) -- §2.3: "tier_mix runs over ALL assessed
// criteria... taking tier_factor from the tier of the source that
// established the verdict." An absent/unrecognized tier defaults to 0
// rather than throwing: assigning a *valid* tier to every assessed
// component is gate.js's contract (§4.4 step 6a), not something this purely
// arithmetic layer re-validates.
function tierFactorFor(evidenceTier, tierFactorMap) {
  if (evidenceTier === null || evidenceTier === undefined) return 0;
  if (!tierFactorMap || !Object.prototype.hasOwnProperty.call(tierFactorMap, evidenceTier)) return 0;
  return tierFactorMap[evidenceTier];
}

// weight(criterion_id) -- §3 registry, looked up from the normalized
// by-id criteria map (see normalizeCriteriaRegistry() below). Throws on an
// unknown criterion_id: unlike an unrecognized tier (a defensive default),
// an unweighted/unregistered criterion is a genuine config defect that must
// fail loudly rather than silently under-count all_weight (mirrors
// lib/f04/scoring.js's scoreTermFor: "a typo'd state string fails loudly
// instead of quietly scoring as unknown").
function weightFor(criterionId, criteriaRegistry) {
  const entry = criteriaRegistry ? criteriaRegistry[criterionId] : undefined;
  if (!entry || !isFiniteNumber(entry.weight)) {
    throw new Error(`scoring.js: unknown or unweighted criterion_id in config.criteria: ${JSON.stringify(criterionId)}`);
  }
  return entry.weight;
}

// normalizeCriteriaRegistry(criteria) -- accepts either shape config.criteria
// can arrive in (see the file-header note) and returns the internal by-id
// map every lookup in this file expects:
//   - object already keyed by criterion_id -> returned as-is (fast path,
//     also what every unit test in scoring.test.js constructs directly).
//   - array of `{ id, weight, ... }` elements (the live score_formulas.config
//     shape, per B3a) -> folded into `{ [entry.id]: entry }`.
// A malformed array element (no usable `id`) is skipped, not thrown on here
// -- it will surface as the loud "unknown or unweighted criterion_id" error
// from weightFor() the moment a component actually references it, which is
// the more useful failure point (it names the missing id).
function normalizeCriteriaRegistry(criteria) {
  if (!criteria) return {};
  if (!Array.isArray(criteria)) return criteria;

  const map = {};
  for (const entry of criteria) {
    if (!entry) continue;
    const id = entry.id ?? entry.criterion_id;
    if (id === undefined || id === null) continue;
    map[id] = entry;
  }
  return map;
}

// ----------------------------------------------------------------------------
// §4.5 -- trend helpers
// ----------------------------------------------------------------------------

// Order-insensitive uuid[] set equality. §4.5, verbatim: "the prior row's
// input_claim_ids is the same set as this run's (compared order-
// insensitively -- uuid[] equality in Postgres is order-sensitive and would
// miss it)". Duplicates inside either list collapse under Set semantics,
// which is the correct reading of "same SET".
function sameIdSet(a, b) {
  const setA = new Set(Array.isArray(a) ? a : []);
  const setB = new Set(Array.isArray(b) ? b : []);
  if (setA.size !== setB.size) return false;
  for (const id of setA) {
    if (!setB.has(id)) return false;
  }
  return true;
}

// Union of every component's claim_ids -- "this run's" input_claim_ids for
// the §4.5 comparison. See the note above computeTrend() for why aggregate()
// derives it this way rather than taking it as a fifth argument.
function unionClaimIds(components) {
  const set = new Set();
  for (const c of components) {
    if (Array.isArray(c.claim_ids)) {
      for (const id of c.claim_ids) set.add(id);
    }
  }
  return Array.from(set);
}

// computeTrend -- §4.5. NULL when: no previous row; previous.formula_version
// differs from the current one; previous.input_claim_ids is the same set as
// this run's. Otherwise Δ = currentValue - previousScore.value, banded
// against trendEpsilon. `currentValue` is the already-ROUNDED value (the one
// that gets persisted to `scores.value numeric(5,2)`), compared against
// `previousScore.value` which is that same persisted, already-rounded
// column from the prior run -- comparing like with like.
function computeTrend({ currentValue, currentVersion, currentClaimIds, previousScore, trendEpsilon }) {
  if (!previousScore) return null;
  if (previousScore.formula_version !== currentVersion) return null;
  if (sameIdSet(previousScore.input_claim_ids, currentClaimIds)) return null;
  if (!isFiniteNumber(previousScore.value) || !isFiniteNumber(currentValue) || !isFiniteNumber(trendEpsilon)) return null;

  const delta = currentValue - previousScore.value;
  if (delta >= trendEpsilon) return 'improving';
  if (delta <= -trendEpsilon) return 'declining';
  return 'stable';
}

// ----------------------------------------------------------------------------
// §2.3 / §2.4 -- aggregate(). The single entry point pasted into the
// f03-aggregate-score n8n Code node.
// ----------------------------------------------------------------------------

// aggregate(components, config, previousScore) -> {status, value, confidence,
//   coverage, trend, missing, components}
//
// `components` -- array, one entry per criterion in config.criteria (gate.js's
//   contract: every registry criterion is represented, `cannot_assess` when
//   absent from the model's response -- see design §4.4 step 3).
// `config` -- the score_formulas config shape documented at the top of this
//   file (constants block + §3 criteria registry + `version`).
// `previousScore` -- the previous founder_score `scores` row for this
//   founder ({value, formula_version, input_claim_ids}), or null/undefined
//   if none exists yet.
//
// Returns the 6 fields the B1 task brief names explicitly (status, value,
// confidence, coverage, trend, missing) PLUS a `components` array: each
// input component augmented with its resolved `weight`, `credit` and
// `contribution` (percentage points, §2.3) -- the per-criterion breakdown a
// caller needs to write `score_components` rows and the judge-checkable
// "Σ contribution == value" identity design §2.3 describes. `credit` and
// `contribution` are `null` on `cannot_assess` rows (n/a, excluded from
// every sum), matching the nullable `score_components.credit` /
// `.contribution` columns (design §4.2).
function aggregate(components, config, previousScore) {
  const list = Array.isArray(components) ? components : [];
  const creditMap = config.credit;
  const tierFactorMap = config.tier_factor;
  const criteriaRegistry = normalizeCriteriaRegistry(config.criteria);

  // all_weight = Σ(weight)[all criteria] -- §2.3. "All criteria" means every
  // criterion DECLARED in config's own registry, the authoritative source of
  // what exists for this formula version -- not merely whatever happens to
  // be present in `components`. A criterion missing from `components`
  // entirely behaves exactly like an explicit `cannot_assess` entry for
  // weight-counting purposes (counted in all_weight, excluded from
  // assessed_weight) -- the only difference is it will not appear in
  // `missing[]`, since that list is built from actual cannot_assess rows.
  //
  // Load-bearing consequence for I2/REQ-003 ("adding a cannot_assess
  // criterion leaves value identical, strictly lowers confidence"): the
  // effect only shows up when the EXTRA criterion is newly DECLARED in the
  // registry passed to this call -- re-running the SAME registry with one
  // more explicit cannot_assess entry for a criterion it already declared
  // is a no-op on all_weight (it was already counted). In production
  // gate.js always declares the full registry every run (design §4.4 step
  // 3: "a criterion absent from the response -> inserted as cannot_assess"),
  // so all_weight is the same fixed constant (1.0 for formula_v1's 12
  // criteria) on every call; the registry only varies across formula
  // *versions*, not across calls of the same version. See scoring.test.js's
  // I2/REQ-003 tests for both the object-form and array-form demonstration.
  let allWeight = 0;
  for (const criterionId of Object.keys(criteriaRegistry)) {
    allWeight += weightFor(criterionId, criteriaRegistry);
  }

  const missing = [];
  const augmented = [];
  let assessedWeight = 0;
  let weightedCreditSum = 0;
  let weightedTierSum = 0;

  for (const c of list) {
    const weight = weightFor(c.criterion_id, criteriaRegistry);
    const verdict = c.verdict;

    if (verdict === 'cannot_assess') {
      missing.push({ criterion_id: c.criterion_id, what_would_close_it: c.what_would_close_it ?? null });
      augmented.push({ ...c, weight, credit: null, contribution: null });
      continue;
    }

    if (!ASSESSED_VERDICTS.has(verdict)) {
      // A verdict outside the 4-value enum should never reach this file --
      // design §4.4 step 2 (gate.js) coerces anything unrecognized to
      // cannot_assess before aggregation. Reaching here means gate.js's
      // contract was violated; fail loudly rather than silently mis-scoring.
      throw new Error(`scoring.js: unrecognized verdict for criterion ${JSON.stringify(c.criterion_id)}: ${JSON.stringify(verdict)}`);
    }

    const credit = creditFor(verdict, c.evidence_tier, creditMap);
    const tierFactor = tierFactorFor(c.evidence_tier, tierFactorMap);

    assessedWeight += weight;
    weightedCreditSum += weight * credit;
    weightedTierSum += weight * tierFactor;

    augmented.push({ ...c, weight, credit, contribution: null }); // filled in below, once assessedWeight is final
  }

  // coverage = assessed_weight / all_weight -- §2.3. Guarded against an
  // empty registry (all_weight === 0) so this never divides by zero even
  // before the insufficient_evidence guard runs.
  const coverage = allWeight > 0 ? assessedWeight / allWeight : 0;

  // ---- guard FIRST -- before any division by assessed_weight (§2.3/§2.4) ----
  if (assessedWeight === 0 || coverage < config.min_coverage) {
    return {
      status: 'insufficient_evidence',
      value: null,
      confidence: null,
      coverage,
      trend: null,
      missing,
      components: augmented,
    };
  }

  // value, tier_mix computed from UNROUNDED terms (§2.3: "value is computed
  // from unrounded terms and rounded once at the end").
  const rawValue = (weightedCreditSum / assessedWeight) * 100;
  const tierMix = weightedTierSum / assessedWeight;
  const rawConfidence = clamp(0.55 * coverage + 0.45 * tierMix, 0, 1);

  const value = clamp(round2(rawValue), 0, 100);
  const confidence = clamp(round2(rawConfidence), 0, 1);

  // contribution = weight * credit / assessed_weight * 100 -- §2.3, the same
  // denominator as value, so Σ contribution reproduces value. Rounded to 5dp
  // to match `score_components.contribution numeric(8,5)` (§4.2) -- storing
  // full float precision would not survive a round-trip through that
  // column, and 5dp rounding noise across a dozen criteria is negligible
  // next to the identity it is meant to preserve.
  for (const a of augmented) {
    if (a.credit === null) continue; // cannot_assess -- contribution stays null
    a.contribution = round5((a.weight * a.credit) / assessedWeight * 100);
  }

  const currentClaimIds = unionClaimIds(list);
  const trend = computeTrend({
    currentValue: value,
    currentVersion: config.version,
    currentClaimIds,
    previousScore,
    trendEpsilon: config.trend_epsilon,
  });

  return {
    status: 'scored',
    value,
    confidence,
    coverage,
    trend,
    missing,
    components: augmented,
  };
}

module.exports = {
  aggregate,
  clamp,
  round2,
  round5,
  creditFor,
  tierFactorFor,
  weightFor,
  normalizeCriteriaRegistry,
  sameIdSet,
  unionClaimIds,
  computeTrend,
};
