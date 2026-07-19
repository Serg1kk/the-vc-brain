// lib/f04/scoring.test.js
//
// Tests for lib/f04/scoring.js (the formula half of the B1a/B1b split, per
// plan.md rev.2 Decision D1). Run with: node --test lib/f04/scoring.test.js
// (or `node --test lib/f04/*.test.js` for both scoring.test.js and
// provenance.test.js together).
//
// Test numbering below matches plan.md's B1a acceptance list (1-9) verbatim.
// Provenance/hashing/curation tests (formerly B1's tests 5/6, now B1b) live
// in provenance.test.js.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const config = require('./config');
const {
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
} = require('./scoring');

const newsFixture = require('./fixtures/news-results.json');

// ============================================================================
// B1a acceptance test 1 -- venture-scale ceiling breakpoint grid (§6.2),
// now including $400M (the new cross-gate disagreement column).
// ============================================================================

describe('ventureScaleCheck -- §6.2 breakpoint grid', () => {
  const M = 1_000_000;
  const tamGrid = [100 * M, 300 * M, 400 * M, 600 * M, 1000 * M, 1500 * M, 2000 * M, 3000 * M, 5000 * M, 10000 * M];

  // Hand-derived from design.md §6.2 -- implied_exit = tam_low *
  // share_assumption * exit_multiple, banded at [$30M, $100M). design.md
  // rev.3's "factor" column (0.10/0.05/0.02) now agrees with this directly;
  // an earlier draft had it 5x off (0.50/0.25/0.10) but the breakpoints
  // themselves were always right -- see the note above ventureScaleCheck in
  // scoring.js.
  const expected = {
    concentrated: ['FAIL', 'WATCH', 'WATCH', 'WATCH', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
    mid_market: ['FAIL', 'FAIL', 'FAIL', 'WATCH', 'WATCH', 'WATCH', 'PASS', 'PASS', 'PASS', 'PASS'],
    long_tail: ['FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'WATCH', 'WATCH', 'WATCH', 'PASS', 'PASS'],
  };

  for (const tier of ['concentrated', 'mid_market', 'long_tail']) {
    tamGrid.forEach((tamLow, i) => {
      test(`${tier} @ tam_low=${tamLow / M}M -> ${expected[tier][i]}`, () => {
        const result = ventureScaleCheck(tamLow, tier);
        assert.equal(result.status, expected[tier][i]);
      });
    });
  }

  test('PASS at exactly $1B / $2B / $5B (concentrated / mid_market / long_tail)', () => {
    assert.equal(ventureScaleCheck(1_000_000_000, 'concentrated').status, 'PASS');
    assert.equal(ventureScaleCheck(2_000_000_000, 'mid_market').status, 'PASS');
    assert.equal(ventureScaleCheck(5_000_000_000, 'long_tail').status, 'PASS');
  });

  test('FAIL strictly below $300M / $600M / $1.5B', () => {
    assert.equal(ventureScaleCheck(299_999_999, 'concentrated').status, 'FAIL');
    assert.equal(ventureScaleCheck(599_999_999, 'mid_market').status, 'FAIL');
    assert.equal(ventureScaleCheck(1_499_999_999, 'long_tail').status, 'FAIL');
  });

  test('FAIL/PASS breakpoint ratio is exactly 0.30 in every tier', () => {
    for (const tier of ['concentrated', 'mid_market', 'long_tail']) {
      const factor = config.SHARE_BY_CONCENTRATION[tier] * config.EXIT_MULTIPLE;
      const failWatchBoundary = config.IMPLIED_EXIT_BAND.WATCH_MIN / factor;
      const watchPassBoundary = config.IMPLIED_EXIT_BAND.PASS_MIN / factor;
      assert.equal(failWatchBoundary / watchPassBoundary, 0.3);
    }
  });

  test('concentrated tier coincides with §6.1 at the PASS threshold only ($1B)', () => {
    assert.equal(config.SHARE_BY_CONCENTRATION.concentrated * config.EXIT_MULTIPLE, 0.10);
    assert.equal(config.IMPLIED_EXIT_BAND.PASS_MIN / 0.10, 1_000_000_000);
    assert.equal(tamBand(1_000_000_000), 'PASS');
    assert.equal(ventureScaleCheck(1_000_000_000, 'concentrated').status, 'PASS');
  });

  test('the two gates genuinely disagree over [$300M, $500M) concentrated -- §6.1 FAIL, ceiling WATCH', () => {
    // design.md §6.2: "the two gates' WATCH floors differ ($300M here vs
    // $500M in §6.1), so over [$300M, $500M) they genuinely disagree."
    for (const tamLow of [300_000_000, 400_000_000, 499_999_999]) {
      assert.equal(tamBand(tamLow), 'FAIL');
      assert.equal(ventureScaleCheck(tamLow, 'concentrated').status, 'WATCH');
    }
  });

  test('UNKNOWN when tam_used is absent, even with a known concentration', () => {
    const result = ventureScaleCheck(null, 'concentrated');
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.implied_exit_value, null);
    assert.equal(result.share_assumption, null);
    assert.deepEqual(result.scenarios, []);
  });

  test('UNKNOWN when buyer_concentration is absent, even with a known TAM', () => {
    const result = ventureScaleCheck(1_000_000_000, 'unknown');
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.implied_exit_value, null);
    // the two founder-standard scenarios (10%/20%) do not depend on
    // buyer_concentration and are still computed when TAM alone is known
    assert.equal(result.scenarios.length, 2);
    assert.equal(result.scenarios[0].implied_exit, 1_000_000_000 * 0.10 * 5);
  });

  test('scenarios[] carries the founder-standard 10%/20% cases alongside the calibrated share', () => {
    const result = ventureScaleCheck(1_000_000_000, 'concentrated');
    assert.equal(result.scenarios.length, 3);
    assert.equal(result.scenarios[0].label, 'share_assumption');
    assert.ok(result.scenarios.some((s) => s.label === 'founder_10pct'));
    assert.ok(result.scenarios.some((s) => s.label === 'founder_20pct'));
  });
});

describe('deriveConcentration -- §6.2 authoritative derivation from buyer_count', () => {
  test('buyer_count < 10k -> concentrated', () => {
    assert.equal(deriveConcentration(0), 'concentrated');
    assert.equal(deriveConcentration(9_999), 'concentrated');
  });
  test('10k <= buyer_count <= 500k -> mid_market', () => {
    assert.equal(deriveConcentration(10_000), 'mid_market');
    assert.equal(deriveConcentration(500_000), 'mid_market');
  });
  test('buyer_count > 500k -> long_tail', () => {
    assert.equal(deriveConcentration(500_001), 'long_tail');
    assert.equal(deriveConcentration(50_000_000), 'long_tail');
  });
  test('absent/invalid buyer_count -> unknown', () => {
    assert.equal(deriveConcentration(null), 'unknown');
    assert.equal(deriveConcentration(undefined), 'unknown');
    assert.equal(deriveConcentration(NaN), 'unknown');
    assert.equal(deriveConcentration(-5), 'unknown');
  });
});

// ============================================================================
// B1a acceptance test 2 -- §6.1's own TAM gate, plus the two documented
// cross-gate disagreements ($1B long_tail; $400M concentrated).
// ============================================================================

describe('tamBand -- §6.1\'s own TAM gate', () => {
  test('PASS >= $1B', () => {
    assert.equal(tamBand(1_000_000_000), 'PASS');
    assert.equal(tamBand(10_000_000_000), 'PASS');
  });
  test('WATCH [$500M, $1B)', () => {
    assert.equal(tamBand(500_000_000), 'WATCH');
    assert.equal(tamBand(999_999_999), 'WATCH');
  });
  test('FAIL < $500M', () => {
    assert.equal(tamBand(499_999_999), 'FAIL');
    assert.equal(tamBand(0), 'FAIL');
  });
  test('UNKNOWN when no TAM established', () => {
    assert.equal(tamBand(null), 'UNKNOWN');
    assert.equal(tamBand(undefined), 'UNKNOWN');
    assert.equal(tamBand(NaN), 'UNKNOWN');
  });
});

describe('the two documented cross-gate disagreements (§6.2, "the point, not a defect")', () => {
  test('$1B long_tail: §6.1 PASS, ceiling FAIL ($20M implied exit)', () => {
    assert.equal(tamBand(1_000_000_000), 'PASS');
    const ceiling = ventureScaleCheck(1_000_000_000, 'long_tail');
    assert.equal(ceiling.status, 'FAIL');
    assert.equal(ceiling.implied_exit_value, 20_000_000);
  });

  test('$400M concentrated: §6.1 FAIL, ceiling WATCH ($40M implied exit)', () => {
    assert.equal(tamBand(400_000_000), 'FAIL');
    const ceiling = ventureScaleCheck(400_000_000, 'concentrated');
    assert.equal(ceiling.status, 'WATCH');
    assert.equal(ceiling.implied_exit_value, 40_000_000);
  });
});

// ============================================================================
// B1a acceptance test 3 -- the §6.0 property test, stated correctly.
//
// The ORIGINAL wording given for this task ("replacing a known value with
// UNKNOWN/null must never decrease the returned value") was retracted by the
// team lead as wrong and unimplementable -- true counter-examples exist in
// design.md's own tables (CAGR PASS +10 -> UNKNOWN 0 IS a decrease). What
// REQ-003 actually requires, restated correctly:
//
//   1. absence never scores worse than a verified negative:
//      value(term = UNKNOWN) >= value(term = that term's worst verified reading)
//   2. every unknown/not-assessed branch contributes EXACTLY 0 --
//      EXCEPT the TAM base term, which is a named, deliberate, and explicit
//      exception in design.md §6.3: "UNKNOWN base is 50, deliberately the
//      same as WATCH ... the whole cost of that ignorance is paid in
//      confidence." A property test asserting the TAM base contributes 0
//      would be asserting design.md is wrong; it is not confirmed wrong, so
//      this suite tests the exception explicitly rather than silently
//      folding it into the general rule.
//
// Enumerated exhaustively (not sampled) -- the state space is small.
// ============================================================================

describe('§6.0 property test, part 1 -- UNKNOWN never scores below that term\'s worst verified (FAIL) reading', () => {
  const TAM_STATES = ['PASS', 'WATCH', 'FAIL', 'UNKNOWN'];
  const CAGR_STATES = ['PASS', 'WATCH', 'FAIL', 'UNKNOWN'];
  const MOMENTUM_STATES = ['improving', 'stable', 'declining'];
  const CEILING_STATES = ['PASS', 'WATCH', 'FAIL', 'UNKNOWN'];

  test('tamBand: UNKNOWN >= FAIL, holding every combination of the other three terms', () => {
    for (const cagrBandState of CAGR_STATES) {
      for (const momentumState of MOMENTUM_STATES) {
        for (const ceiling of CEILING_STATES) {
          const failScore = marketScore({ tamBand: 'FAIL', cagrBand: cagrBandState, momentum: momentumState, ceiling });
          const unknownScore = marketScore({ tamBand: 'UNKNOWN', cagrBand: cagrBandState, momentum: momentumState, ceiling });
          assert.ok(unknownScore >= failScore, `tamBand UNKNOWN(${unknownScore}) < FAIL(${failScore}) at cagr=${cagrBandState} mom=${momentumState} ceil=${ceiling}`);
        }
      }
    }
  });

  test('cagrBand: UNKNOWN >= FAIL, holding every combination of the other three terms', () => {
    for (const tamBandState of TAM_STATES) {
      for (const momentumState of MOMENTUM_STATES) {
        for (const ceiling of CEILING_STATES) {
          const failScore = marketScore({ tamBand: tamBandState, cagrBand: 'FAIL', momentum: momentumState, ceiling });
          const unknownScore = marketScore({ tamBand: tamBandState, cagrBand: 'UNKNOWN', momentum: momentumState, ceiling });
          assert.ok(unknownScore >= failScore, `cagrBand UNKNOWN(${unknownScore}) < FAIL(${failScore}) at tam=${tamBandState} mom=${momentumState} ceil=${ceiling}`);
        }
      }
    }
  });

  test('ceiling: UNKNOWN >= FAIL, holding every combination of the other three terms', () => {
    for (const tamBandState of TAM_STATES) {
      for (const cagrBandState of CAGR_STATES) {
        for (const momentumState of MOMENTUM_STATES) {
          const failScore = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: momentumState, ceiling: 'FAIL' });
          const unknownScore = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: momentumState, ceiling: 'UNKNOWN' });
          assert.ok(unknownScore >= failScore, `ceiling UNKNOWN(${unknownScore}) < FAIL(${failScore}) at tam=${tamBandState} cagr=${cagrBandState} mom=${momentumState}`);
        }
      }
    }
  });

  test('momentum: "stable" (thin-signal\'s state) never scores below "declining"', () => {
    for (const tamBandState of TAM_STATES) {
      for (const cagrBandState of CAGR_STATES) {
        for (const ceiling of CEILING_STATES) {
          const decliningScore = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: 'declining', ceiling });
          const stableScore = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: 'stable', ceiling });
          assert.ok(stableScore >= decliningScore, `momentum stable(${stableScore}) < declining(${decliningScore}) at tam=${tamBandState} cagr=${cagrBandState} ceil=${ceiling}`);
        }
      }
    }
  });

  test('momentum: undated-majority (forced 0) never scores below "declining", regardless of the underlying computed direction', () => {
    for (const tamBandState of TAM_STATES) {
      for (const cagrBandState of CAGR_STATES) {
        for (const ceiling of CEILING_STATES) {
          const decliningScore = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: 'declining', ceiling });
          const forcedZeroScore = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: 'declining', momentumUndatedMajority: true, ceiling });
          assert.ok(forcedZeroScore >= decliningScore);
        }
      }
    }
  });

  const SWITCHING_STATES = [1, 2, 3, null];
  const THREAT_STATES = [1, 2, 3, 4, null];
  const MOAT_STATES = [true, false];
  const STATUS_QUO_STATES = [true, false];
  const ZERO_COMPETITORS_STATES = [true, false, null];

  test('switchingCost: null >= 3 (worst known), holding every combination of the other terms', () => {
    for (const threatLevel of THREAT_STATES) {
      for (const moat of MOAT_STATES) {
        for (const statusQuo of STATUS_QUO_STATES) {
          for (const zeroCompetitorsNamed of ZERO_COMPETITORS_STATES) {
            const worst = ideaVsMarketScore({ switchingCost: 3, threatLevel, moat, statusQuo, zeroCompetitorsNamed });
            const unknown = ideaVsMarketScore({ switchingCost: null, threatLevel, moat, statusQuo, zeroCompetitorsNamed });
            assert.ok(unknown >= worst, `switchingCost null(${unknown}) < 3(${worst})`);
          }
        }
      }
    }
  });

  test('threatLevel: null >= 4 (worst known), holding every combination of the other terms', () => {
    for (const switchingCost of SWITCHING_STATES) {
      for (const moat of MOAT_STATES) {
        for (const statusQuo of STATUS_QUO_STATES) {
          for (const zeroCompetitorsNamed of ZERO_COMPETITORS_STATES) {
            const worst = ideaVsMarketScore({ switchingCost, threatLevel: 4, moat, statusQuo, zeroCompetitorsNamed });
            const unknown = ideaVsMarketScore({ switchingCost, threatLevel: null, moat, statusQuo, zeroCompetitorsNamed });
            assert.ok(unknown >= worst, `threatLevel null(${unknown}) < 4(${worst})`);
          }
        }
      }
    }
  });

  test('zeroCompetitorsNamed: not-assessable (false/null) >= fired (true, worst known), holding every combination of the other terms', () => {
    for (const switchingCost of SWITCHING_STATES) {
      for (const threatLevel of THREAT_STATES) {
        for (const moat of MOAT_STATES) {
          for (const statusQuo of STATUS_QUO_STATES) {
            const worst = ideaVsMarketScore({ switchingCost, threatLevel, moat, statusQuo, zeroCompetitorsNamed: true });
            const notAssessableFalse = ideaVsMarketScore({ switchingCost, threatLevel, moat, statusQuo, zeroCompetitorsNamed: false });
            const notAssessableNull = ideaVsMarketScore({ switchingCost, threatLevel, moat, statusQuo, zeroCompetitorsNamed: null });
            assert.ok(notAssessableFalse >= worst, `zeroCompetitorsNamed false(${notAssessableFalse}) < true(${worst})`);
            assert.ok(notAssessableNull >= worst, `zeroCompetitorsNamed null(${notAssessableNull}) < true(${worst})`);
          }
        }
      }
    }
  });

  test('moat and status-quo terms are additive-only -- no negative branch, so the invariant is vacuous but ranges still hold', () => {
    for (const moat of MOAT_STATES) {
      for (const statusQuo of STATUS_QUO_STATES) {
        const value = ideaVsMarketScore({ switchingCost: 2, threatLevel: 3, moat, statusQuo, zeroCompetitorsNamed: false });
        assert.ok(value >= config.IDEA_VS_MARKET_RANGE.MIN && value <= config.IDEA_VS_MARKET_RANGE.MAX);
      }
    }
  });

  const FMF_STATES = ['direct', 'adjacent', null];
  const MATURITY_STATES = ['material', 'moderate', 'minor', 'no_mismatch_3plus_named', null];

  test('§6.6 maturity: null (not assessable) >= "material" (worst known), holding fmf fixed across every state', () => {
    for (const fmf of FMF_STATES) {
      const worst = founderAxisScore({ founderScore: 50, fmf, maturity: 'material' });
      const unknown = founderAxisScore({ founderScore: 50, fmf, maturity: null });
      assert.ok(unknown >= worst, `maturity null(${unknown}) < material(${worst})`);
    }
  });

  test('§6.6 fmf: additive-only (direct/adjacent/null, no negative branch) -- vacuous but ranges still hold', () => {
    for (const fmf of FMF_STATES) {
      for (const maturity of MATURITY_STATES) {
        const value = founderAxisScore({ founderScore: 50, fmf, maturity });
        assert.ok(value >= config.FOUNDER_AXIS_RANGE.MIN && value <= config.FOUNDER_AXIS_RANGE.MAX);
      }
    }
  });
});

describe('§6.0 property test, part 2 -- unknown/not-assessed branches contribute EXACTLY 0 (TAM base is the one named exception)', () => {
  // Baseline where every OTHER term is at a state worth exactly 0, so the sum
  // isolates the term under test: cagr=WATCH(0), momentum=stable(0), ceiling=PASS(0).
  test('cagrBand UNKNOWN contributes exactly 0 (same total as cagrBand=WATCH, which is 0 by definition)', () => {
    const withUnknown = marketScore({ tamBand: 'WATCH', cagrBand: 'UNKNOWN', momentum: 'stable', ceiling: 'PASS' });
    const withWatch = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'stable', ceiling: 'PASS' });
    assert.equal(withUnknown, 50); // base(50) + 0 + 0 + 0
    assert.equal(withUnknown, withWatch);
  });

  test('ceiling UNKNOWN contributes exactly 0 (same total as ceiling=PASS, which is 0 by definition)', () => {
    const withUnknown = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'stable', ceiling: 'UNKNOWN' });
    const withPass = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'stable', ceiling: 'PASS' });
    assert.equal(withUnknown, 50);
    assert.equal(withUnknown, withPass);
  });

  test('momentum "stable"/thin-signal contributes exactly 0, and undated-majority forces the term to 0 regardless of the computed direction', () => {
    const stableScore = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'stable', ceiling: 'PASS' });
    assert.equal(stableScore, 50);
    // even though 'declining' alone would subtract 4, undatedMajority forces
    // the TERM (not the reported direction) to 0 -- §5's new rule.
    const forcedZero = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'declining', momentumUndatedMajority: true, ceiling: 'PASS' });
    assert.equal(forcedZero, 50);
    const forcedZeroImproving = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'improving', momentumUndatedMajority: true, ceiling: 'PASS' });
    assert.equal(forcedZeroImproving, 50); // the term is forced to 0 even when the direction is 'improving'
  });

  test('TAM base is the ONE documented exception: UNKNOWN equals WATCH (50), NOT 0 -- design.md §6.3 is explicit this is deliberate', () => {
    const withUnknown = marketScore({ tamBand: 'UNKNOWN', cagrBand: 'WATCH', momentum: 'stable', ceiling: 'PASS' });
    const withWatch = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: 'stable', ceiling: 'PASS' });
    assert.equal(withUnknown, 50);
    assert.equal(withUnknown, withWatch);
    // contrast: this is NOT the same shape as the other three terms, where
    // the zero-contribution baseline (PASS/WATCH cagr, stable momentum, PASS
    // ceiling) is what UNKNOWN matches. Here UNKNOWN matches WATCH (50), and
    // 50 is not 0 -- the "cost of ignorance is paid in confidence", per design.
  });

  test('§6.4 switchingCost null and threatLevel null both contribute exactly 0', () => {
    const baseline = ideaVsMarketScore({ switchingCost: 2, threatLevel: 3, moat: false, statusQuo: false, zeroCompetitorsNamed: false });
    assert.equal(baseline, 50); // base only -- switchingCost=2 and threatLevel=3 are both 0-value states
    const switchingUnknown = ideaVsMarketScore({ switchingCost: null, threatLevel: 3, moat: false, statusQuo: false, zeroCompetitorsNamed: false });
    assert.equal(switchingUnknown, 50);
    const threatUnknown = ideaVsMarketScore({ switchingCost: 2, threatLevel: null, moat: false, statusQuo: false, zeroCompetitorsNamed: false });
    assert.equal(threatUnknown, 50);
  });

  test('§6.4 zeroCompetitorsNamed not-assessable (false/null) contributes exactly 0', () => {
    const withFalse = ideaVsMarketScore({ switchingCost: 2, threatLevel: 3, moat: false, statusQuo: false, zeroCompetitorsNamed: false });
    const withNull = ideaVsMarketScore({ switchingCost: 2, threatLevel: 3, moat: false, statusQuo: false, zeroCompetitorsNamed: null });
    assert.equal(withFalse, 50);
    assert.equal(withNull, 50);
  });

  test('§6.6 fmf not-established and maturity not-assessable both contribute exactly 0', () => {
    const baseline = founderAxisScore({ founderScore: 50, fmf: null, maturity: null });
    assert.equal(baseline, 50);
    const maturityMinor = founderAxisScore({ founderScore: 50, fmf: null, maturity: 'minor' }); // a real 0-value reading
    assert.equal(maturityMinor, 50);
    // 'minor' (assessed, low severity) and null (not assessable) both land at
    // 0 -- but for different reasons (§6.0's unknown rule vs. a genuine
    // low-severity finding). See config.js FOUNDER_AXIS_TERMS.maturity.
  });
});

// ============================================================================
// B1a acceptance test 4 -- founderAxisScore(founderScore: null) -> null
// ============================================================================

describe('founderAxisScore -- §6.6', () => {
  test('founderScore: null -> null, not 0 -- no persistent score means no founder axis row at all', () => {
    assert.equal(founderAxisScore({ founderScore: null, fmf: 'direct', maturity: 'material' }), null);
  });
  test('founderScore: undefined -> null (same as explicit null)', () => {
    assert.equal(founderAxisScore({}), null);
    assert.equal(founderAxisScore(), null);
  });
  test('founderScore: NaN -> null (not a valid persistent score)', () => {
    assert.equal(founderAxisScore({ founderScore: NaN }), null);
  });
  test('a real founder_score composes with fmf and maturity, clamped to [0,100]', () => {
    assert.equal(founderAxisScore({ founderScore: 60, fmf: 'direct', maturity: 'material' }), 60 + 10 - 10);
    assert.equal(founderAxisScore({ founderScore: 95, fmf: 'direct', maturity: 'no_mismatch_3plus_named' }), 100); // clamped from 110
    assert.equal(founderAxisScore({ founderScore: 5, fmf: null, maturity: 'material' }), 0); // clamped from -5
  });
  test('fmf direct/adjacent and maturity bands match §6.6 exactly', () => {
    assert.equal(founderAxisScore({ founderScore: 50, fmf: 'direct', maturity: null }), 60);
    assert.equal(founderAxisScore({ founderScore: 50, fmf: 'adjacent', maturity: null }), 55);
    assert.equal(founderAxisScore({ founderScore: 50, fmf: null, maturity: 'moderate' }), 45);
    assert.equal(founderAxisScore({ founderScore: 50, fmf: null, maturity: 'no_mismatch_3plus_named' }), 55);
  });
});

// ============================================================================
// B1a acceptance test 5 -- ranges
// ============================================================================

describe('marketScore range -- [0, 84]', () => {
  const TAM_STATES = ['PASS', 'WATCH', 'FAIL', 'UNKNOWN'];
  const CAGR_STATES = ['PASS', 'WATCH', 'FAIL', 'UNKNOWN'];
  const MOMENTUM_STATES = ['improving', 'stable', 'declining'];
  const CEILING_STATES = ['PASS', 'WATCH', 'FAIL', 'UNKNOWN'];

  test('every term-state combination falls within [0, 84]', () => {
    for (const tamBandState of TAM_STATES) {
      for (const cagrBandState of CAGR_STATES) {
        for (const momentumState of MOMENTUM_STATES) {
          for (const ceiling of CEILING_STATES) {
            const value = marketScore({ tamBand: tamBandState, cagrBand: cagrBandState, momentum: momentumState, ceiling });
            assert.ok(value >= 0 && value <= 84, `marketScore out of [0,84]: ${value} (${tamBandState},${cagrBandState},${momentumState},${ceiling})`);
          }
        }
      }
    }
  });

  test('84 is reachable (PASS/PASS/improving/PASS = 70+10+4+0)', () => {
    assert.equal(marketScore({ tamBand: 'PASS', cagrBand: 'PASS', momentum: 'improving', ceiling: 'PASS' }), 84);
  });

  test('0 is reachable and the clamp is load-bearing at the bottom (FAIL/FAIL/declining/FAIL = 25-10-4-15 = -4, clamped)', () => {
    assert.equal(marketScore({ tamBand: 'FAIL', cagrBand: 'FAIL', momentum: 'declining', ceiling: 'FAIL' }), 0);
  });

  test('an unresearched market (all UNKNOWN) scores exactly 50 -- undetermined, not neutral (see outlook)', () => {
    const value = marketScore({ tamBand: 'UNKNOWN', cagrBand: 'UNKNOWN', momentum: 'stable', ceiling: 'UNKNOWN' });
    assert.equal(value, 50);
    assert.equal(outlook(value, 'UNKNOWN'), 'undetermined');
  });
});

// ============================================================================
// B1a acceptance test 8 -- outlook: tamBand=UNKNOWN -> 'undetermined', not
// 'neutral', even though the value (50) falls in the neutral band.
// ============================================================================

describe('outlook -- §6.3 label bands', () => {
  test('bullish >= 70, neutral [40,70), bear < 40', () => {
    assert.equal(outlook(84, 'PASS'), 'bullish');
    assert.equal(outlook(70, 'PASS'), 'bullish');
    assert.equal(outlook(69, 'WATCH'), 'neutral');
    assert.equal(outlook(40, 'WATCH'), 'neutral');
    assert.equal(outlook(39, 'FAIL'), 'bear');
    assert.equal(outlook(0, 'FAIL'), 'bear');
  });

  test('UNKNOWN TAM -> undetermined, NEVER neutral -- even though value=50 naively falls in the neutral band', () => {
    // this is the exact bug the case exists to catch: a naive threshold on
    // value alone would read 50 as 'neutral', rendering a confident-looking
    // label on zero evidence.
    assert.equal(outlook(50, 'UNKNOWN'), 'undetermined');
    assert.notEqual(outlook(50, 'UNKNOWN'), 'neutral');
    // and it overrides even a value that would otherwise read bullish/bear --
    // an UNKNOWN TAM band means the market was never researched, full stop.
    assert.equal(outlook(90, 'UNKNOWN'), 'undetermined');
    assert.equal(outlook(10, 'UNKNOWN'), 'undetermined');
  });
});

describe('ideaVsMarketScore range -- max exactly 100, reachable via the documented +8 nonlinearity', () => {
  test('100 is reachable via 50+20+15+8+7 (NOT +10 -- the nonlinearity is deliberate)', () => {
    const value = ideaVsMarketScore({ switchingCost: 1, threatLevel: 1, moat: true, statusQuo: true, zeroCompetitorsNamed: false });
    assert.equal(value, 100);
  });

  test('the +10 moat bonus (not +8) applies whenever threat_level=1 AND switching_cost=1 does NOT both hold', () => {
    // threat_level=2 here, so the nonlinear cap does not apply: 50+20+8(threat=2)+10(moat)+7 = 95
    const value = ideaVsMarketScore({ switchingCost: 1, threatLevel: 2, moat: true, statusQuo: true, zeroCompetitorsNamed: false });
    assert.equal(value, 95);
  });

  test('no combination exceeds 100', () => {
    const SWITCHING_STATES = [1, 2, 3, null];
    const THREAT_STATES = [1, 2, 3, 4, null];
    for (const switchingCost of SWITCHING_STATES) {
      for (const threatLevel of THREAT_STATES) {
        for (const moat of [true, false]) {
          for (const statusQuo of [true, false]) {
            for (const zeroCompetitorsNamed of [true, false, null]) {
              const value = ideaVsMarketScore({ switchingCost, threatLevel, moat, statusQuo, zeroCompetitorsNamed });
              assert.ok(value <= 100, `ideaVsMarketScore exceeded 100: ${value}`);
            }
          }
        }
      }
    }
  });

  test('the true minimum is 5, not 0 -- the clamp is load-bearing at the top only (§6.4)', () => {
    const value = ideaVsMarketScore({ switchingCost: 3, threatLevel: 4, moat: false, statusQuo: false, zeroCompetitorsNamed: true });
    assert.equal(value, 5);
  });
});

// ============================================================================
// B1a acceptance test 6 -- momentum: thin-signal evaluated first, RFC 1123
// parsing, unparseable/absent dates count as undated (never now()), and
// undated-majority forces the §6.3 TERM to 0 (new in this revision).
// ============================================================================

describe('momentum -- §5', () => {
  const T = new Date(Date.UTC(2026, 5, 26, 6, 6, 36)); // "Fri, 26 Jun 2026 06:06:36 GMT"

  test('thin-signal (recent+prior < 3) wins even when the ratio alone would read "improving"', () => {
    const results = [
      { published_date: 'Fri, 26 Jun 2026 06:06:36 GMT' }, // = T, recent (boundary inclusive)
      { published_date: 'Thu, 25 Jun 2026 00:00:00 GMT' }, // 1 day before T, recent
      // 0 prior events -- ratio would be 2/max(0,1) = 2.0 >= 1.5 ("improving")
    ];
    const result = momentum(results, T);
    assert.equal(result.recent, 2);
    assert.equal(result.prior, 0);
    assert.equal(result.direction, 'stable');
    assert.equal(result.thinSignal, true);
  });

  test('ratio >= 1.5 -> improving, once past the thin-signal threshold', () => {
    const results = [
      { published_date: 'Fri, 26 Jun 2026 06:06:36 GMT' },
      { published_date: 'Thu, 25 Jun 2026 00:00:00 GMT' },
      { published_date: 'Wed, 24 Jun 2026 00:00:00 GMT' }, // 3 recent, 0 prior -> ratio 3.0, total 3 (not thin)
    ];
    const result = momentum(results, T);
    assert.equal(result.recent + result.prior, 3);
    assert.equal(result.thinSignal, false);
    assert.equal(result.direction, 'improving');
  });

  test('0.67 < ratio < 1.5 -> stable (past the thin-signal threshold)', () => {
    const results = [
      { published_date: 'Fri, 26 Jun 2026 06:06:36 GMT' }, // recent
      { published_date: 'Thu, 25 Jun 2026 00:00:00 GMT' }, // recent
      { published_date: 'Wed, 25 Mar 2026 00:00:00 GMT' }, // prior (within 90-180d before T)
      { published_date: 'Tue, 24 Mar 2026 00:00:00 GMT' }, // prior
    ];
    const result = momentum(results, T);
    assert.equal(result.recent, 2);
    assert.equal(result.prior, 2);
    assert.equal(result.ratio, 1); // 2 / max(2,1) = 1, strictly between 0.67 and 1.5
    assert.equal(result.direction, 'stable');
    assert.equal(result.thinSignal, false);
  });

  test('ratio <= 0.67 -> declining (past the thin-signal threshold)', () => {
    const results = [
      { published_date: 'Fri, 26 Jun 2026 06:06:36 GMT' }, // 1 recent
      { published_date: 'Wed, 25 Mar 2026 00:00:00 GMT' }, // prior
      { published_date: 'Tue, 24 Mar 2026 00:00:00 GMT' }, // prior
      { published_date: 'Mon, 23 Mar 2026 00:00:00 GMT' }, // prior
    ];
    const result = momentum(results, T);
    assert.equal(result.recent, 1);
    assert.equal(result.prior, 3);
    assert.ok(result.ratio <= 0.67);
    assert.equal(result.direction, 'declining');
  });

  test('unparseable and absent dates both count as undated, never as "now"', () => {
    const results = [
      { published_date: '2026-06-26T06:06:36Z' }, // ISO 8601 -- NOT the real Tavily format, must NOT parse
      { published_date: 'not a date' },
      { published_date: null },
      {}, // no published_date field at all
    ];
    const result = momentum(results, T);
    assert.equal(result.undated, 4);
    assert.equal(result.recent, 0);
    assert.equal(result.prior, 0);
    assert.equal(result.direction, 'stable');
    assert.equal(result.thinSignal, true);
  });

  test('undatedMajority flags when undated outnumbers recent+prior', () => {
    const results = [
      { published_date: 'Fri, 26 Jun 2026 06:06:36 GMT' },
      { published_date: 'garbage' },
      { published_date: 'garbage' },
    ];
    const result = momentum(results, T);
    assert.equal(result.undatedMajority, true);
  });

  test('window boundaries: exactly T is recent, exactly T-90d is prior (not recent), exactly T-180d is excluded entirely', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const exactlyT = new Date(T.getTime());
    const exactly90dBefore = new Date(T.getTime() - 90 * dayMs);
    const exactly180dBefore = new Date(T.getTime() - 180 * dayMs);

    const toRfc1123 = (d) => {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const pad = (n) => String(n).padStart(2, '0');
      return `${days[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
    };

    const results = [
      { published_date: toRfc1123(exactlyT) },
      { published_date: toRfc1123(exactly90dBefore) },
      { published_date: toRfc1123(exactly180dBefore) },
    ];
    const result = momentum(results, T);
    assert.equal(result.recent, 1); // only exactlyT
    assert.equal(result.prior, 1);  // only exactly90dBefore; exactly180dBefore is excluded (exclusive lower bound)
    assert.equal(result.undated, 0); // the 180d-boundary result parsed fine, it's just outside both buckets
  });

  test('momentum requires a valid pinned endDate, never defaults to now()', () => {
    assert.throws(() => momentum([], 'not a date'));
    assert.throws(() => momentum([], undefined));
  });

  test('parseRfc1123Date parses the verified live Tavily format and rejects ISO 8601', () => {
    const parsed = parseRfc1123Date('Fri, 26 Jun 2026 06:06:36 GMT');
    assert.equal(parsed.getTime(), T.getTime());
    assert.equal(parseRfc1123Date('2026-06-26T06:06:36Z'), null);
    assert.equal(parseRfc1123Date(''), null);
    assert.equal(parseRfc1123Date(undefined), null);
  });

  test('fixture: lib/f04/fixtures/news-results.json matches its own recorded expectations', () => {
    const endDate = parseRfc1123Date(newsFixture.endDate);
    const result = momentum(newsFixture.results, endDate);
    assert.equal(result.recent, newsFixture.expected.recent);
    assert.equal(result.prior, newsFixture.expected.prior);
    assert.equal(result.undated, newsFixture.expected.undated);
    assert.equal(result.direction, newsFixture.expected.direction);
  });

  test('undated-majority forces the §6.3 momentum TERM to 0 while the claim would still record the computed direction', () => {
    // Construct a case with recent=2, prior=3 (ratio 0.667 -> "declining" by
    // the ratio rule) but 8 undated results, so undated(8) > recent+prior(5)
    // -- design.md §5's own worked example for why this rule exists.
    const results = [
      { published_date: 'Fri, 26 Jun 2026 06:06:36 GMT' },
      { published_date: 'Thu, 25 Jun 2026 00:00:00 GMT' },
      { published_date: 'Wed, 25 Mar 2026 00:00:00 GMT' },
      { published_date: 'Tue, 24 Mar 2026 00:00:00 GMT' },
      { published_date: 'Mon, 23 Mar 2026 00:00:00 GMT' },
      {}, {}, {}, {}, {}, {}, {}, {},
    ];
    const m = momentum(results, T);
    assert.equal(m.recent, 2);
    assert.equal(m.prior, 3);
    assert.equal(m.direction, 'declining'); // the honest computed direction, still recorded for the claim
    assert.equal(m.undatedMajority, true);

    // the claim would still show 'declining' (m.direction), but the axis
    // VALUE must not move on it -- absent publication metadata is not a
    // verified negative reading (§6.0).
    const scoreWithoutOverride = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: m.direction, ceiling: 'PASS' });
    const scoreWithOverride = marketScore({ tamBand: 'WATCH', cagrBand: 'WATCH', momentum: m.direction, momentumUndatedMajority: m.undatedMajority, ceiling: 'PASS' });
    assert.equal(scoreWithoutOverride, 46); // 50 + 0 + (-4) + 0, the bug this rule prevents
    assert.equal(scoreWithOverride, 50);    // 50 + 0 + 0 + 0, the correct behavior
  });
});

describe('shadowMarketGuard -- §7 three-condition rule', () => {
  test('fires only on a MEASURED FAIL + identified status-quo + switching_cost=1', () => {
    assert.equal(shadowMarketGuard({ ventureScaleStatus: 'FAIL', statusQuoIdentified: true, switchingCost: 1 }), true);
  });
  test('never fires on UNKNOWN, even with the other two conditions met (a hypothesis on an absent TAM would be REQ-004 fabrication)', () => {
    assert.equal(shadowMarketGuard({ ventureScaleStatus: 'UNKNOWN', statusQuoIdentified: true, switchingCost: 1 }), false);
  });
  test('does not fire on WATCH, including the $400M concentrated case (small but honestly reachable, not mispriced)', () => {
    const ceiling = ventureScaleCheck(400_000_000, 'concentrated');
    assert.equal(ceiling.status, 'WATCH');
    assert.equal(shadowMarketGuard({ ventureScaleStatus: ceiling.status, statusQuoIdentified: true, switchingCost: 1 }), false);
  });
  test('does not fire without an identified status-quo alternative', () => {
    assert.equal(shadowMarketGuard({ ventureScaleStatus: 'FAIL', statusQuoIdentified: false, switchingCost: 1 }), false);
  });
  test('does not fire unless switching_cost crosses the 10x threshold (=1)', () => {
    assert.equal(shadowMarketGuard({ ventureScaleStatus: 'FAIL', statusQuoIdentified: true, switchingCost: 2 }), false);
    assert.equal(shadowMarketGuard({ ventureScaleStatus: 'FAIL', statusQuoIdentified: true, switchingCost: null }), false);
  });
});

// ============================================================================
// B1a acceptance test 7 -- confidence cap ordering: evidence_ct=0 (cap 0.15)
// + §7 guard fires -> 0.10 (the floor), NOT 0.15. §7 applies AFTER §6.5's
// caps; the reverse order would silently restore confidence the guard removed.
// ============================================================================

describe('confidence -- §6.5 formula, hard caps, §7 penalty ordering', () => {
  test('evidence_ct = 0 caps confidence at 0.15 regardless of missingCount', () => {
    assert.ok(confidence({ evidenceCt: 0, missingCount: 0 }) <= 0.15);
    assert.ok(confidence({ evidenceCt: 0, missingCount: 5 }) <= 0.15);
  });

  test('evidence_ct=0 (cap 0.15) with the §7 guard firing -> 0.10, not 0.15', () => {
    // this is the precise ordering case: without missingCount also zeroing
    // the raw formula, the 0.15 cap is the binding constraint BEFORE the
    // penalty subtracts further to the 0.1 floor.
    const raw = confidence({ evidenceCt: 0, missingCount: 0 });
    assert.equal(raw, 0.15); // the cap alone, no guard
    const withGuard = confidence({ evidenceCt: 0, missingCount: 0, shadowMarketPenalty: true });
    assert.equal(withGuard, 0.10);
    assert.notEqual(withGuard, 0.15);
  });

  test('missing_count and evidence_ct are capped at 5 and 6 respectively before the formula runs', () => {
    const overCapped = confidence({ evidenceCt: 60, missingCount: 50 });
    const atCap = confidence({ evidenceCt: 6, missingCount: 5 });
    assert.equal(overCapped, atCap);
  });

  test('a fully-supported, fully-complete run reaches confidence 1', () => {
    assert.equal(confidence({ evidenceCt: 6, missingCount: 0 }), 1);
  });

  test('caps apply before the §7 penalty, and the penalty can only lower the result further', () => {
    // raw formula would be high, but topDownOnly caps it at 0.45, THEN the
    // -0.15 penalty applies -> 0.30, never (raw - 0.15) capped afterward.
    const withPenalty = confidence({ evidenceCt: 6, missingCount: 0, caps: { topDownOnly: true }, shadowMarketPenalty: true });
    // IEEE 754: 0.45 - 0.15 is 0.30000000000000004, not exactly 0.3 -- epsilon
    // compare rather than assert bitwise equality on a float subtraction.
    assert.ok(Math.abs(withPenalty - 0.30) < 1e-9, `expected ~0.30, got ${withPenalty}`);
  });

  test('the §7 penalty floors at 0.1, never lower', () => {
    const result = confidence({ evidenceCt: 0, missingCount: 5, shadowMarketPenalty: true });
    assert.equal(result, 0.1);
  });

  test('multiple simultaneous caps apply the strictest (minimum) bound', () => {
    const result = confidence({ evidenceCt: 6, missingCount: 0, caps: { noDocumentedTierEvidence: true, fewerThanTwoIndependentDomains: true } });
    assert.ok(result <= 0.40);
  });
});
