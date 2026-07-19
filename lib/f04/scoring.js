// lib/f04/scoring.js
//
// Deterministic scoring core for feature 04 (market / idea_vs_market / founder
// screening axes). Pure functions only -- no I/O, no n8n imports, no network.
// This is the module the plan calls "the deterministic scoring core built
// first": every number is unit-tested here before it is pasted verbatim into
// an n8n Code node (docs/backlog/04-market-trend-competition/plan.md,
// "Guiding decision").
//
// Split from provenance.js (plan.md rev.2, Decision D1): this file owns the
// score formulas and shares no state with domain-tiering/hashing/curation.
//
// Authoritative source for every formula: docs/backlog/04-market-trend-competition/
// design.md rev.3 (+ §6.6 scope addition), sections cited inline next to each
// function. All tunable numbers live in ./config.js -- nothing here hardcodes
// a threshold, weight or domain list.

'use strict';

const config = require('./config');

const {
  TAM_BAND,
  CAGR_BAND,
  EXIT_MULTIPLE,
  SHARE_BY_CONCENTRATION,
  BUYER_CONCENTRATION_THRESHOLDS,
  IMPLIED_EXIT_BAND,
  FOUNDER_STANDARD_SHARE_SCENARIOS,
  MOMENTUM_WINDOW,
  MARKET_SCORE_TERMS,
  MARKET_SCORE_RANGE,
  MARKET_OUTLOOK_BAND,
  IDEA_VS_MARKET_BASE,
  IDEA_VS_MARKET_TERMS,
  IDEA_VS_MARKET_RANGE,
  FOUNDER_AXIS_TERMS,
  FOUNDER_AXIS_RANGE,
  CONFIDENCE_FORMULA,
  CONFIDENCE_CAPS,
  SHADOW_MARKET_GUARD,
} = config;

// ============================================================================
// Small shared helpers
// ============================================================================

function clamp(min, max, value) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Looks up a term value in a `{1: x, 2: y, null: z}`-shaped table (§6.4/§6.6
// -style per-state score tables). `key === null || key === undefined` maps to
// the table's `null` entry (the unknown/not-assessed state); any other key
// not present in the table is a programming error, not a silent 0 -- it
// throws, so a typo'd state string fails loudly instead of quietly scoring
// as unknown.
function scoreTermFor(table, key, label) {
  if (key === null || key === undefined) return table.null;
  if (!Object.prototype.hasOwnProperty.call(table, key)) {
    throw new Error(`scoring.js: unrecognized ${label} state: ${JSON.stringify(key)}`);
  }
  return table[key];
}

// ============================================================================
// §6.1 -- vc_rule_check (half-open intervals, applied to tam_low / cagr_pct_low)
// ============================================================================

function tamBand(tamLow) {
  if (!isFiniteNumber(tamLow)) return 'UNKNOWN';
  if (tamLow >= TAM_BAND.PASS_MIN) return 'PASS';
  if (tamLow >= TAM_BAND.WATCH_MIN) return 'WATCH';
  return 'FAIL';
}

function cagrBand(cagrPct) {
  if (!isFiniteNumber(cagrPct)) return 'UNKNOWN';
  if (cagrPct >= CAGR_BAND.PASS_MIN) return 'PASS';
  if (cagrPct >= CAGR_BAND.WATCH_MIN) return 'WATCH';
  return 'FAIL';
}

// ============================================================================
// §6.2 -- venture-scale ceiling
// ============================================================================

// buyer_count -> buyer_concentration. THE authoritative derivation -- the
// market-categorizer's pre-search guess is a query hint only (§6.2 CR-4) and
// is overridden by this whenever the two disagree.
function deriveConcentration(buyerCount) {
  if (!isFiniteNumber(buyerCount) || buyerCount < 0) return 'unknown';
  if (buyerCount < BUYER_CONCENTRATION_THRESHOLDS.concentratedMax) return 'concentrated';
  if (buyerCount <= BUYER_CONCENTRATION_THRESHOLDS.midMarketMax) return 'mid_market';
  return 'long_tail';
}

function impliedExitBand(impliedExit) {
  if (!isFiniteNumber(impliedExit)) return 'UNKNOWN';
  if (impliedExit >= IMPLIED_EXIT_BAND.PASS_MIN) return 'PASS';
  if (impliedExit >= IMPLIED_EXIT_BAND.WATCH_MIN) return 'WATCH';
  return 'FAIL';
}

// implied_exit = tam_used * share_assumption * exit_multiple, banded against
// IMPLIED_EXIT_BAND. This is §6.2's central claim: identical TAM, different
// reachability depending on buyer_concentration -- e.g. at tam_low=$1B,
// concentrated coincides with §6.1's own PASS gate while long_tail reads
// ceiling FAIL ($20M implied exit) on the SAME $1B market. Both readings are
// deliberate, not a bug (design.md §6.2).
function ventureScaleCheck(tamLow, concentration) {
  const tamKnown = isFiniteNumber(tamLow);
  const concentrationKnown = Object.prototype.hasOwnProperty.call(SHARE_BY_CONCENTRATION, concentration);

  // The two founder-standard comparison scenarios (§6.2: "the investor sees
  // what the founder's own assumption would imply") are independent of
  // buyer_concentration, so they are computed whenever tam_low is known --
  // even when concentration itself is not, which is exactly when a reader
  // most needs a sanity-check reference point.
  const scenarios = [];
  if (tamKnown) {
    for (const share of FOUNDER_STANDARD_SHARE_SCENARIOS) {
      scenarios.push({
        label: `founder_${Math.round(share * 100)}pct`,
        share,
        implied_exit: tamLow * share * EXIT_MULTIPLE,
      });
    }
  }

  if (!tamKnown || !concentrationKnown) {
    return {
      status: 'UNKNOWN',
      tam_used: tamKnown ? tamLow : null,
      share_assumption: null,
      share_rationale: null,
      exit_multiple: EXIT_MULTIPLE,
      implied_exit_value: null,
      scenarios,
      rationale: !tamKnown
        ? 'no TAM established -- venture-scale ceiling not computed (§6.2)'
        : 'buyer_concentration not established -- venture-scale ceiling not computed (§6.2)',
    };
  }

  const share = SHARE_BY_CONCENTRATION[concentration];
  const impliedExit = tamLow * share * EXIT_MULTIPLE;
  const status = impliedExitBand(impliedExit);

  scenarios.unshift({ label: 'share_assumption', share, implied_exit: impliedExit });

  return {
    status,
    tam_used: tamLow,
    share_assumption: share,
    share_rationale: `${concentration} buyer base -> calibrated share ${(share * 100).toFixed(1)}% (§6.2)`,
    exit_multiple: EXIT_MULTIPLE,
    implied_exit_value: impliedExit,
    scenarios,
    rationale: `implied_exit = tam_low(${tamLow}) x share(${share}) x exit_multiple(${EXIT_MULTIPLE}) = ${impliedExit}`,
  };
}

// ============================================================================
// §7 -- underestimation guard condition (not itself a §6 scoring term; feeds
// the -0.15 confidence() penalty below). Kept as its own pure function because
// this exact three-condition rule is the one design.md calls out as needing a
// strict evaluation order match -- see the caller contract in confidence().
// ============================================================================

function shadowMarketGuard({ ventureScaleStatus, statusQuoIdentified, switchingCost }) {
  // A *measured* FAIL only -- UNKNOWN never fires this (§6.2: "UNKNOWN never
  // triggers §7 either -- a shadow-market hypothesis written on an absent TAM
  // would be fabrication"). WATCH never fires it either (e.g. $400M
  // concentrated: ceiling WATCH, §6.1 FAIL -- small but honestly reachable,
  // not mispriced by our own measurement).
  return ventureScaleStatus === 'FAIL' && statusQuoIdentified === true && switchingCost === 1;
}

// ============================================================================
// §5 -- momentum layer
// ============================================================================

const RFC1123_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

const RFC1123_MONTHS = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
});

// Parses Tavily's actual `results[].published_date` format, verified live
// (§5): "Fri, 26 Jun 2026 06:06:36 GMT" -- RFC 1123, NOT ISO 8601. Anything
// that doesn't match this exact shape (including a well-formed ISO date, or
// no value at all) returns null, i.e. undated -- never `new Date()` / now().
function parseRfc1123Date(value) {
  if (typeof value !== 'string') return null;
  const m = RFC1123_RE.exec(value.trim());
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss] = m;
  const ms = Date.UTC(Number(yyyy), RFC1123_MONTHS[mon], Number(dd), Number(hh), Number(mi), Number(ss));
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

// momentum(newsResults, endDate) -- §5. `endDate` is the pinned run end_date
// (T), NEVER now(), so a re-run of the demo reproduces the same trend. Rule 1
// (thin-signal) is evaluated FIRST and short-circuits rule 2, per design.md's
// explicit ordering note.
//
// `undatedMajority` on the return value does NOT change `direction` here --
// design.md is explicit that the computed direction is still recorded in the
// market.trend claim. It is marketScore()'s job to force the §6.3 TERM to 0
// when undatedMajority is true (see the `momentumUndatedMajority` parameter
// below) -- keeping that override at the scoring boundary, not inside
// momentum() itself, is what lets the claim show the honest computed
// direction while the axis VALUE stays untouched by absent metadata (§6.0).
function momentum(newsResults, endDate) {
  const t = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(t.getTime())) {
    throw new Error('scoring.js: momentum() requires a valid pinned endDate (the run end_date)');
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const recentStart = new Date(t.getTime() - MOMENTUM_WINDOW.RECENT_DAYS * dayMs); // exclusive lower bound
  const priorStart = new Date(t.getTime() - MOMENTUM_WINDOW.PRIOR_WINDOW_END_DAYS * dayMs); // exclusive lower bound
  const priorEnd = recentStart; // (T-90d), inclusive upper bound for prior -- no gap, no overlap with recent

  let recent = 0;
  let prior = 0;
  let undated = 0;

  for (const result of newsResults || []) {
    const raw = result && result.published_date;
    const parsed = raw ? parseRfc1123Date(raw) : null;
    if (!parsed) {
      undated += 1;
      continue;
    }
    const ms = parsed.getTime();
    if (ms > recentStart.getTime() && ms <= t.getTime()) {
      recent += 1;
    } else if (ms > priorStart.getTime() && ms <= priorEnd.getTime()) {
      prior += 1;
    }
    // else: outside the 180-day window entirely -- not counted in either
    // bucket, and (per §5) not counted as undated either.
  }

  const ratio = recent / Math.max(prior, 1);

  let direction;
  let thinSignal = false;
  if (recent + prior < MOMENTUM_WINDOW.THIN_SIGNAL_MIN_EVENTS) {
    // Rule 1, evaluated first: thin data reads 'stable', regardless of ratio.
    direction = 'stable';
    thinSignal = true;
  } else if (ratio >= MOMENTUM_WINDOW.RATIO_IMPROVING_MIN) {
    direction = 'improving';
  } else if (ratio > MOMENTUM_WINDOW.RATIO_DECLINING_MAX) {
    direction = 'stable';
  } else {
    direction = 'declining';
  }

  return {
    direction,
    recent,
    prior,
    undated,
    ratio,
    thinSignal,
    undatedMajority: undated > recent + prior,
    windowDays: MOMENTUM_WINDOW.PRIOR_WINDOW_END_DAYS,
  };
}

// ============================================================================
// §6.3 -- market axis value
// ============================================================================

// marketScore({tamBand, cagrBand, momentum, momentumUndatedMajority, ceiling})
//   `momentum` is the direction string ('improving'|'stable'|'declining').
//   `momentumUndatedMajority` (§5, new in this revision): when true, the
//   momentum TERM is forced to 0 regardless of `momentum`'s direction -- a
//   direction computed from a minority of dated results must not move the
//   axis value (§6.0), even though the honest direction is still what gets
//   recorded in the market.trend claim by the caller.
function marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: momentumState, momentumUndatedMajority = false, ceiling }) {
  const base = scoreTermFor(MARKET_SCORE_TERMS.tamBand, tamBandState, 'tamBand');
  const cagr = scoreTermFor(MARKET_SCORE_TERMS.cagrBand, cagrBandState, 'cagrBand');
  const mom = momentumUndatedMajority ? 0 : scoreTermFor(MARKET_SCORE_TERMS.momentum, momentumState, 'momentum');
  const ceil = scoreTermFor(MARKET_SCORE_TERMS.ceiling, ceiling, 'ceiling');
  return clamp(MARKET_SCORE_RANGE.MIN, MARKET_SCORE_RANGE.MAX, base + cagr + mom + ceil);
}

// market.outlook label (§6.3) -- a claim field, not a scores column. UNKNOWN
// TAM renders 'undetermined', never 'neutral', even though an unresearched
// market's raw value (50) falls in the 'neutral' band -- an unresearched
// market must never render as a confident-looking label.
function outlook(marketScoreValue, tamBandState) {
  if (tamBandState === 'UNKNOWN') return 'undetermined';
  if (marketScoreValue >= MARKET_OUTLOOK_BAND.BULLISH_MIN) return 'bullish';
  if (marketScoreValue >= MARKET_OUTLOOK_BAND.NEUTRAL_MIN) return 'neutral';
  return 'bear';
}

// ============================================================================
// §6.4 -- idea_vs_market axis value
// ============================================================================

function ideaVsMarketScore({ switchingCost = null, threatLevel = null, moat = false, statusQuo = false, zeroCompetitorsNamed = false } = {}) {
  const switchingTerm = scoreTermFor(IDEA_VS_MARKET_TERMS.switchingCost, switchingCost, 'switchingCost');
  const threatTerm = scoreTermFor(IDEA_VS_MARKET_TERMS.threatLevel, threatLevel, 'threatLevel');

  const moatPresent = moat === true;
  // The documented nonlinearity (§6.4): +8, not +10, exactly when
  // threat_level=1 AND switching_cost=1 -- this is what holds the reachable
  // maximum at 100 (50+20+15+8+7) instead of the raw sum's 102. Do not
  // "simplify" this back to a flat +10.
  const atNonlinearCap = moatPresent && threatLevel === 1 && switchingCost === 1;
  const moatTerm = moatPresent
    ? (atNonlinearCap ? IDEA_VS_MARKET_TERMS.moatBonusAtMax : IDEA_VS_MARKET_TERMS.moatBonus)
    : 0;

  const statusQuoTerm = statusQuo === true ? IDEA_VS_MARKET_TERMS.statusQuoDisplacedBonus : 0;

  // zeroCompetitorsNamed: true = the -10 term fires; false OR null (no deck /
  // no founder competition view -- "not assessable") both contribute 0.
  const zeroCompetitorsTerm = zeroCompetitorsNamed === true ? IDEA_VS_MARKET_TERMS.zeroCompetitorsNamedPenalty : 0;

  const sum = IDEA_VS_MARKET_BASE + switchingTerm + threatTerm + moatTerm + statusQuoTerm + zeroCompetitorsTerm;
  return clamp(IDEA_VS_MARKET_RANGE.MIN, IDEA_VS_MARKET_RANGE.MAX, sum);
}

// ============================================================================
// §6.6 -- founder axis value (scope addition, cross-terminal from feature 03)
// ============================================================================

// founderAxisScore({founderScore, fmf, maturity}) -> value, or `null` when
// founderScore itself is absent. This is the one term in the whole module
// that is NOT §6.0's "unknown -> 0" shape: a missing persistent founder_score
// means NO axis row is written at all, never a zero founder axis (§6.6 --
// "feature 04 must never manufacture a founder axis for a person 03 has not
// scored"). fmf and maturity DO follow §6.0 (their unknown states are 0).
function founderAxisScore({ founderScore = null, fmf = null, maturity = null } = {}) {
  if (!isFiniteNumber(founderScore)) return null;
  const fmfTerm = scoreTermFor(FOUNDER_AXIS_TERMS.fmf, fmf, 'fmf');
  const maturityTerm = scoreTermFor(FOUNDER_AXIS_TERMS.maturity, maturity, 'maturity');
  return clamp(FOUNDER_AXIS_RANGE.MIN, FOUNDER_AXIS_RANGE.MAX, founderScore + fmfTerm + maturityTerm);
}

// ============================================================================
// §6.5 -- confidence (+ §7 penalty, applied last)
// ============================================================================

// confidence({ missingCount, evidenceCt, caps, shadowMarketPenalty })
//   caps.noDocumentedTierEvidence   -- no documented-tier evidence behind the size claim
//   caps.fewerThanTwoIndependentDomains
//   caps.topDownOnly
// The evidence_ct=0 cap is derived from evidenceCt itself (not part of
// `caps`) since it is fully determined by the other required argument.
//
// Order (§6.5 + §7, binding): raw formula -> all hard caps (order among caps
// does not matter, each is an independent min()) -> §7's -0.15 penalty last,
// floored at 0.1. Capped-then-penalised can only go lower; the reverse order
// would let a cap silently restore confidence the guard just removed.
function confidence({ missingCount = 0, evidenceCt = 0, caps = {}, shadowMarketPenalty = false } = {}) {
  const cappedMissing = Math.min(Math.max(0, missingCount), CONFIDENCE_FORMULA.MISSING_COUNT_CAP);
  const cappedEvidence = Math.min(Math.max(0, evidenceCt), CONFIDENCE_FORMULA.EVIDENCE_CT_CAP);

  const completeness = 1 - Math.min(1, cappedMissing * CONFIDENCE_FORMULA.MISSING_COUNT_STEP);
  let value =
    (cappedEvidence / CONFIDENCE_FORMULA.EVIDENCE_CT_CAP) * CONFIDENCE_FORMULA.EVIDENCE_WEIGHT +
    completeness * CONFIDENCE_FORMULA.COMPLETENESS_WEIGHT;

  if (evidenceCt === 0) value = Math.min(value, CONFIDENCE_CAPS.ZERO_EVIDENCE);
  if (caps.noDocumentedTierEvidence) value = Math.min(value, CONFIDENCE_CAPS.NO_DOCUMENTED_EVIDENCE);
  if (caps.fewerThanTwoIndependentDomains) value = Math.min(value, CONFIDENCE_CAPS.FEW_INDEPENDENT_DOMAINS);
  if (caps.topDownOnly) value = Math.min(value, CONFIDENCE_CAPS.TOP_DOWN_ONLY);

  if (shadowMarketPenalty) {
    value = Math.max(SHADOW_MARKET_GUARD.CONFIDENCE_FLOOR, value - SHADOW_MARKET_GUARD.CONFIDENCE_PENALTY);
  }

  return clamp(0, 1, value);
}

module.exports = {
  clamp,
  tamBand,
  cagrBand,
  deriveConcentration,
  ventureScaleCheck,
  shadowMarketGuard,
  parseRfc1123Date,
  momentum,
  marketScore,
  outlook,
  ideaVsMarketScore,
  founderAxisScore,
  confidence,
};
