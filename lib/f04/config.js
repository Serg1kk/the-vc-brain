// lib/f04/config.js
//
// Every tunable constant for feature 04 (market / idea_vs_market screening axes).
// Authoritative source for every number below: docs/backlog/04-market-trend-competition/
// design.md rev.3, sections cited inline. No constant is invented here that design.md
// does not state -- where design.md names a source *class* without enumerating domains
// (the documented/discovered/inferred allow-lists in DOMAIN_TIER_RULES below), the
// concrete domain list is this file's operationalisation of that class and is called out
// as such; it is additive-only and never the safety property under test (default-deny to
// 'inferred' is unaffected by what is or isn't in these lists -- see provenance.js tierForDomain).
//
// Conventions (binding for lib/f04/):
//   * This is the ONLY file allowed to hold a magic number/threshold/weight/domain list.
//     scoring.js and provenance.js import everything they need from here -- no literal
//     duplication. Shared by both (D1 in plan.md's decisions log: splitting scoring.js
//     from provenance.js was necessary because they share no state; config.js is the one
//     file both still depend on).
//   * Money amounts are plain numbers in USD (not cents), matching design.md's $ notation.
//   * Percentages that read as "15%" in design.md are stored as the number 15, not 0.15,
//     except *share* fractions (buyer-capture %, e.g. 0.020) which design.md itself always
//     writes as decimals -- kept as decimals here to match §6.2 verbatim.

'use strict';

// ============================================================================
// §3.4 -- report-mill blocklist (passed to Tavily as exclude_domains, and
// re-checked defensively inside curate()/tierForDomain() -- design.md §3.4:
// "It is still deduplicated and is still subject to the blocklist.")
// ============================================================================

const REPORT_MILL_BLOCKLIST = Object.freeze([
  'grandviewresearch.com',
  'mordorintelligence.com',
  'marketsandmarkets.com',
  'precedenceresearch.com',
  'alliedmarketresearch.com',
  'fortunebusinessinsights.com',
  'futuremarketinsights.com',
  'technavio.com',
  'imarcgroup.com',
  'marketresearchfuture.com',
  'verifiedmarketresearch.com',
  'zionmarketresearch.com',
  'expertmarketresearch.com',
  'transparencymarketresearch.com',
  'coherentmarketinsights.com',
  'straitsresearch.com',
  'globalmarketinsights.com',
  'credenceresearch.com',
  'businessresearchinsights.com',
  'researchandmarkets.com',
]);

// ============================================================================
// §3.4 -- evidence tiering. `tier` (documented|discovered|inferred) and
// `strength` (0.90/0.80/0.60/0.30) are looked up together per matched domain
// class, because 'documented' itself carries TWO strengths depending on which
// source class matched (design.md's own table splits it: government/patents at
// 0.90, named-methodology analyst firms/top-tier press at 0.80).
//
// design.md enumerates source *classes*, not an exhaustive domain list, for the
// documented/discovered rows (it enumerates the report-mill blocklist in full,
// but only names representative companies for the other rows -- IBISWorld,
// Euromonitor, Gartner/Forrester, FT/WSJ/Bloomberg/Reuters, GitHub, Product
// Hunt, G2). The lists below encode exactly those named examples plus the
// blocklist; nothing here changes the default-deny guarantee (§3.4: "any
// domain not matching a rule above" -> inferred, strength 0.30) -- that
// guarantee is DEFAULT_DOMAIN_TIER/DEFAULT_DOMAIN_STRENGTH below, and holds
// for every domain not explicitly listed in this file, blocklisted or not.
// Rules are checked in array order in scoring.js; the sets below are disjoint
// by construction so order does not matter in practice.
// ============================================================================

const DOMAIN_TIER_RULES = Object.freeze([
  {
    // "Government statistics, regulatory filings, industry-association data,
    // peer-reviewed work, patents" (§3.4) -- represented by canonical
    // government/international-body/peer-review/patent-office domains plus a
    // blanket .gov suffix match (the class is inherently open-ended; .gov is
    // the one unambiguous, enumerable signal for "regulatory filing").
    tier: 'documented',
    strength: 0.90,
    suffixes: ['.gov'],
    domains: [
      'sec.gov', 'census.gov', 'uspto.gov', 'bls.gov', 'fda.gov',
      'oecd.org', 'imf.org', 'worldbank.org', 'who.int', 'un.org', 'europa.eu',
      'arxiv.org', 'nature.com', 'sciencedirect.com', 'ncbi.nlm.nih.gov', 'ieee.org',
      'patents.google.com', 'wipo.int', 'epo.org',
      // aha.org (American Hospital Association) and jamanetwork.com (JAMA) --
      // added per team lead's live Tavily probe (2026-07-19): both surfaced
      // as genuine buyer-count anchors on a real Q1 query. aha.org is
      // industry-association data, jamanetwork.com is peer-reviewed work --
      // both already-named §3.4 source classes, not a new class.
      'aha.org', 'jamanetwork.com',
    ],
  },
  {
    // "Named-methodology analyst firms (IBISWorld, Euromonitor, Gartner/
    // Forrester with disclosed methodology), FT/WSJ/Bloomberg/Reuters, vertical
    // trade press" (§3.4) -- the named examples; "vertical trade press" has no
    // enumerable member list in design.md and is intentionally left uncoded.
    tier: 'documented',
    strength: 0.80,
    domains: [
      'ibisworld.com', 'euromonitor.com', 'gartner.com', 'forrester.com',
      'ft.com', 'wsj.com', 'bloomberg.com', 'reuters.com',
    ],
  },
  {
    // "Company/competitor websites, product directories, GitHub, Product Hunt,
    // G2" (§3.4). Company/competitor first-party sites are handled separately
    // by curate()'s first-party exemption (matched against companies.domain at
    // runtime, not a static list) -- only the named directories are listed here.
    tier: 'discovered',
    strength: 0.60,
    domains: ['github.com', 'producthunt.com', 'g2.com'],
  },
  {
    // "Report mills, SEO listicles, Reddit/HN/X threads" (§3.4). The report
    // mills are REPORT_MILL_BLOCKLIST above; Reddit/HN/X are the named forum
    // examples. "SEO listicles" has no enumerable domain and is left uncoded.
    tier: 'inferred',
    strength: 0.30,
    domains: [...REPORT_MILL_BLOCKLIST, 'reddit.com', 'news.ycombinator.com', 'twitter.com', 'x.com'],
  },
]);

// "Any domain not matching a rule above" (§3.4) -- the default-deny row. This
// is the load-bearing safety property: a brand-new report mill nobody has
// seen yet (design.md's own live-probe example, astuteanalytica.com) lands
// here, not in 'discovered' or 'documented'.
const DEFAULT_DOMAIN_TIER = 'inferred';
const DEFAULT_DOMAIN_STRENGTH = 0.30;

// ============================================================================
// §6.1 -- vc_rule_check, half-open intervals, applied to tam_low / cagr_pct_low.
// ============================================================================

const TAM_BAND = Object.freeze({
  PASS_MIN: 1_000_000_000,   // >= $1B -> PASS
  WATCH_MIN: 500_000_000,    // [$500M, $1B) -> WATCH; below -> FAIL
});

const CAGR_BAND = Object.freeze({
  PASS_MIN: 15,               // >= 15% -> PASS
  WATCH_MIN: 5,                // [5%, 15%) -> WATCH; below -> FAIL
});

// ============================================================================
// §6.2 -- venture-scale ceiling.
// ============================================================================

const EXIT_MULTIPLE = 5;

// buyer_concentration -> share_assumption (Pear VC's 5x relative spread,
// calibrated to the 0.1%-2% observed IPO band per §1/RSK-004 -- NOT the
// deck-standard 10%/5%/2%).
const SHARE_BY_CONCENTRATION = Object.freeze({
  concentrated: 0.020,
  mid_market: 0.010,
  long_tail: 0.004,
});

// buyer_count -> buyer_concentration, the AUTHORITATIVE derivation (§6.2) --
// the categorizer's pre-search guess is a query hint only and is overridden
// by this whenever they disagree.
const BUYER_CONCENTRATION_THRESHOLDS = Object.freeze({
  concentratedMax: 10_000,   // buyer_count < 10k -> concentrated
  midMarketMax: 500_000,     // 10k <= buyer_count <= 500k -> mid_market; > 500k -> long_tail
});

// implied_exit = tam_used * share_assumption * exit_multiple, banded here.
// These two numbers are what actually generate every FAIL/WATCH/PASS
// breakpoint in §6.2's tam_low table (300M/1B, 600M/2B, 1.5B/5B). design.md's
// rev.3 "factor" column (0.10/0.05/0.02 = share_assumption * exit_multiple)
// now agrees with this arithmetic -- an earlier draft had it at 0.50/0.25/0.10
// (a flat 5x error), independently caught before this file was written; the
// breakpoints below were never wrong, only that column was.
const IMPLIED_EXIT_BAND = Object.freeze({
  PASS_MIN: 100_000_000,   // >= $100M -> PASS
  WATCH_MIN: 30_000_000,   // [$30M, $100M) -> WATCH; below -> FAIL
});

// The two founder-standard assumptions §6.2 says must ride alongside the
// calibrated share in every venture_scale_check.scenarios[] ("the investor
// sees what the founder's own assumption would imply").
const FOUNDER_STANDARD_SHARE_SCENARIOS = Object.freeze([0.10, 0.20]);

// ============================================================================
// §5 -- momentum layer.
// ============================================================================

const MOMENTUM_WINDOW = Object.freeze({
  RECENT_DAYS: 90,             // recent_events: (T-90d, T]
  PRIOR_WINDOW_END_DAYS: 180,  // prior_events:  (T-180d, T-90d]
  THIN_SIGNAL_MIN_EVENTS: 3,   // recent+prior < 3 -> 'stable' + thin_category_signal, evaluated FIRST
  RATIO_IMPROVING_MIN: 1.5,    // ratio >= 1.5 -> 'improving'
  RATIO_DECLINING_MAX: 0.67,   // ratio <= 0.67 -> 'declining'; between -> 'stable'
});

// ============================================================================
// §6.3 -- market axis value = clamp(0, 100, base + cagr + momentum + ceiling).
// Every row names its UNKNOWN/thin-signal state per §6.0 -- absence contributes
// exactly 0 (or, for the TAM base, the same value as WATCH), never a penalty.
// ============================================================================

const MARKET_SCORE_TERMS = Object.freeze({
  tamBand: Object.freeze({ PASS: 70, WATCH: 50, FAIL: 25, UNKNOWN: 50 }),
  cagrBand: Object.freeze({ PASS: 10, WATCH: 0, FAIL: -10, UNKNOWN: 0 }),
  // 'stable' also covers the thin-signal case (momentum() collapses thin-data
  // into direction='stable' at source -- see §5), so no separate UNKNOWN entry
  // is needed here: it would be identical to 'stable'.
  momentum: Object.freeze({ improving: 4, stable: 0, declining: -4 }),
  ceiling: Object.freeze({ PASS: 0, WATCH: -5, FAIL: -15, UNKNOWN: 0 }),
});

const MARKET_SCORE_RANGE = Object.freeze({ MIN: 0, MAX: 100 }); // clamp bounds; realised range is 0..84 (§6.3)

// market.outlook label bands (§6.3) -- a claim field, not a scores column.
const MARKET_OUTLOOK_BAND = Object.freeze({
  BULLISH_MIN: 70,
  NEUTRAL_MIN: 40,
  // < NEUTRAL_MIN -> 'bear'; tamBand === 'UNKNOWN' -> 'undetermined' (never 'neutral')
});

// ============================================================================
// §6.4 -- idea_vs_market axis value = clamp(0, 100, sum of terms below).
// The moat bonus's +8-not-+10 case at threat_level=1 AND switching_cost=1 is
// the documented nonlinearity that holds the reachable maximum at exactly 100
// (50+20+15+8+7) instead of the raw sum's 102 -- do not collapse to a flat +10.
// ============================================================================

const IDEA_VS_MARKET_BASE = 50;

const IDEA_VS_MARKET_TERMS = Object.freeze({
  // keys are switching_cost values (1|2|3); `null` is the unknown/not-assessed state
  switchingCost: Object.freeze({ 1: 20, 2: 0, 3: -15, null: 0 }),
  // keys are threat_level values (1|2|3|4); `null` is the unknown/not-assessed state
  threatLevel: Object.freeze({ 1: 15, 2: 8, 3: 0, 4: -20, null: 0 }),
  moatBonus: 10,          // articulated accumulating advantage w/ public evidence, normal case
  moatBonusAtMax: 8,      // same, but threat_level=1 AND switching_cost=1 (the +8 nonlinearity)
  statusQuoDisplacedBonus: 7,
  zeroCompetitorsNamedPenalty: -10,
});

const IDEA_VS_MARKET_RANGE = Object.freeze({ MIN: 0, MAX: 100 }); // clamp bounds; realised range is 5..100 (§6.4)

// ============================================================================
// §6.6 -- founder axis value = clamp(0, 100, base + fmf + maturity), where
// base = latest scores.value WHERE axis='founder_score' (feature 03's
// persistent, person-scoped score -- an INPUT here, never copied/replaced).
// No such row -> founderAxisScore() returns null, not 0: a person 03 has not
// scored gets no founder axis row written at all.
// ============================================================================

const FOUNDER_AXIS_TERMS = Object.freeze({
  // founder-market fit (SIG-026): domain expertise vs. the resolved category.
  // keys: 'direct' | 'adjacent'; `null` is "not established"
  fmf: Object.freeze({ direct: 10, adjacent: 5, null: 0 }),
  // competitor-knowledge maturity (SIG-024), reusing §8's mismatch severity.
  // keys: 'material' | 'moderate' | 'minor' (a real assessed reading of low
  // severity) | 'no_mismatch_3plus_named' (no mismatch AND founder named >=3
  // competitors); `null` is "not assessable" (no deck / no founder
  // competition view) -- distinct from 'minor', both contribute 0 but for
  // different reasons (§6.0 vs. a genuine low-severity reading).
  maturity: Object.freeze({ material: -10, moderate: -5, minor: 0, no_mismatch_3plus_named: 5, null: 0 }),
});

const FOUNDER_AXIS_RANGE = Object.freeze({ MIN: 0, MAX: 100 });

// ============================================================================
// §6.5 -- confidence formula + hard caps (order: caps first, §7 penalty second).
// ============================================================================

const CONFIDENCE_FORMULA = Object.freeze({
  MISSING_COUNT_CAP: 5,
  EVIDENCE_CT_CAP: 6,
  MISSING_COUNT_STEP: 0.2,     // completeness = 1 - min(1, missing_count * 0.2)
  EVIDENCE_WEIGHT: 0.55,       // confidence = evidence_ct/6 * 0.55 + completeness * 0.45
  COMPLETENESS_WEIGHT: 0.45,
});

const CONFIDENCE_CAPS = Object.freeze({
  ZERO_EVIDENCE: 0.15,          // evidence_ct = 0
  NO_DOCUMENTED_EVIDENCE: 0.40, // no documented-tier evidence behind the size claim
  FEW_INDEPENDENT_DOMAINS: 0.55, // fewer than 2 independent registrable domains
  TOP_DOWN_ONLY: 0.45,          // top-down-only sizing (§6.1)
});

// §7 underestimation guard: -0.15 penalty applied AFTER all §6.5 hard caps,
// floored at 0.1 (never at 0 -- a fired guard still leaves a nonzero reading).
const SHADOW_MARKET_GUARD = Object.freeze({
  CONFIDENCE_PENALTY: 0.15,
  CONFIDENCE_FLOOR: 0.1,
});

// ============================================================================
// §4 -- curator + Tavily budget.
// ============================================================================

const CURATE = Object.freeze({
  RELEVANCE_MIN: 0.4,   // score >= 0.4 gate; first-party docs bypass this gate only
  TOP_N: 8,              // top-8 survivors per curated bucket
});

const TAVILY_BUDGET = Object.freeze({
  SEARCH_QUERIES_PER_CARD: 5,   // Q1-Q5, 1 credit each (basic)
  EXTRACT_MAX_URLS: 20,          // single batched /extract call, urls[] <= 20
  CREDIT_CAP_PER_CARD: 25,       // hard stop (config); expected cost is 9-14
});

module.exports = {
  REPORT_MILL_BLOCKLIST,
  DOMAIN_TIER_RULES,
  DEFAULT_DOMAIN_TIER,
  DEFAULT_DOMAIN_STRENGTH,
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
  CURATE,
  TAVILY_BUDGET,
};
