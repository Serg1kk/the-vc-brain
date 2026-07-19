// lib/f04/scoring.test.js
//
// Acceptance tests for lib/f04/scoring.js, per docs/backlog/04-market-trend-competition/
// plan.md Task B1. Run with: node --test lib/f04/
//
// Test numbering below matches the six acceptance tests in the B1 task brief
// verbatim (breakpoint grid / §6.0 property / ranges / momentum / hash
// collisions / tierForDomain default-deny), plus supporting coverage for the
// remaining B1 functions (deriveConcentration, confidence, curate) that the
// six named tests exercise only indirectly.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const config = require('./config');
const {
  tamBand,
  cagrBand,
  deriveConcentration,
  ventureScaleCheck,
  shadowMarketGuardFires,
  parseRfc1123Date,
  momentum,
  marketScore,
  marketOutlook,
  ideaVsMarketScore,
  confidence,
  tierForDomain,
  evidenceStrengthForDomain,
  contentHash,
  curate,
} = require('./scoring');

// ============================================================================
// Acceptance test 1 -- venture-scale ceiling breakpoint grid (§6.2)
// ============================================================================

describe('ventureScaleCheck -- §6.2 breakpoint grid', () => {
  const M = 1_000_000;
  const tamGrid = [100 * M, 300 * M, 600 * M, 1000 * M, 1500 * M, 2000 * M, 3000 * M, 5000 * M, 10000 * M];

  // Hand-derived from design.md §6.2's own numbers -- implied_exit = tam_low *
  // share_assumption * exit_multiple, banded at [$30M, $100M) -- NOT from the
  // table's mislabeled "factor" column (see the note above ventureScaleCheck
  // in scoring.js). Independently verifies design's published breakpoints:
  // PASS at $1B/$2B/$5B, FAIL below $300M/$600M/$1.5B, WATCH between.
  const expected = {
    concentrated: ['FAIL', 'WATCH', 'WATCH', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
    mid_market: ['FAIL', 'FAIL', 'WATCH', 'WATCH', 'WATCH', 'PASS', 'PASS', 'PASS', 'PASS'],
    long_tail: ['FAIL', 'FAIL', 'FAIL', 'FAIL', 'WATCH', 'WATCH', 'WATCH', 'PASS', 'PASS'],
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

  test('concentrated tier coincides exactly with §6.1\'s own $1B TAM gate', () => {
    // 0.020 * 5 = 0.10, and $100M / 0.10 = $1B -- design.md's own explicit
    // arithmetic sentence; the "coincidence" is asserted here as code, not prose.
    assert.equal(config.SHARE_BY_CONCENTRATION.concentrated * config.EXIT_MULTIPLE, 0.10);
    assert.equal(config.IMPLIED_EXIT_BAND.PASS_MIN / 0.10, 1_000_000_000);
    assert.equal(tamBand(1_000_000_000), 'PASS');
    assert.equal(ventureScaleCheck(1_000_000_000, 'concentrated').status, 'PASS');
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
// Acceptance test 2 -- the §6.0 unknown-state invariant as a property test
// ("replacing a term's worst KNOWN (FAIL) reading with its UNKNOWN/null state
// must never DECREASE the returned value"). Enumerated over the full state
// space per term, per design.md §6.0: "no term may go negative on absence --
// only on a verified negative reading". Note this is deliberately NOT "UNKNOWN
// >= every known state" -- that would be false on its face against design's
// own numbers (e.g. TAM base PASS=70 > UNKNOWN=50); the invariant design.md
// actually states and everywhere upholds is UNKNOWN >= FAIL.
// ============================================================================

describe('§6.0 property test -- marketScore: UNKNOWN never scores below FAIL, per term', () => {
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

  test('momentum: thin-signal/"stable" never scores below "declining" (§5 collapses thin-data into stable)', () => {
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
});

describe('§6.0 property test -- ideaVsMarketScore: unknown/not-assessed never scores below the worst known reading, per term', () => {
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

  test('moat and status-quo terms are additive-only -- absent (0) is never negative, so the invariant is vacuous but ranges still hold', () => {
    // §6.4: "the moat term is additive-only" -- there is no FAIL/negative
    // branch to compare against, unlike switchingCost/threatLevel/zeroCompetitors.
    for (const moat of MOAT_STATES) {
      for (const statusQuo of STATUS_QUO_STATES) {
        const value = ideaVsMarketScore({ switchingCost: 2, threatLevel: 3, moat, statusQuo, zeroCompetitorsNamed: false });
        assert.ok(value >= config.IDEA_VS_MARKET_RANGE.MIN && value <= config.IDEA_VS_MARKET_RANGE.MAX);
      }
    }
  });
});

// ============================================================================
// Acceptance test 3 -- ranges
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

  test('an unresearched market (all UNKNOWN) scores exactly 50 -- undetermined, not neutral (see marketOutlook)', () => {
    const value = marketScore({ tamBand: 'UNKNOWN', cagrBand: 'UNKNOWN', momentum: 'stable', ceiling: 'UNKNOWN' });
    assert.equal(value, 50);
    assert.equal(marketOutlook(value, 'UNKNOWN'), 'undetermined');
  });

  test('marketOutlook bands: bullish >= 70, neutral [40,70), bear < 40, undetermined iff tamBand UNKNOWN', () => {
    assert.equal(marketOutlook(84, 'PASS'), 'bullish');
    assert.equal(marketOutlook(70, 'PASS'), 'bullish');
    assert.equal(marketOutlook(69, 'WATCH'), 'neutral');
    assert.equal(marketOutlook(40, 'WATCH'), 'neutral');
    assert.equal(marketOutlook(39, 'FAIL'), 'bear');
    assert.equal(marketOutlook(0, 'FAIL'), 'bear');
    assert.equal(marketOutlook(70, 'UNKNOWN'), 'undetermined');
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
// Acceptance test 4 -- momentum: thin-signal evaluated first, RFC 1123 parsing,
// unparseable/absent dates count as undated, never now().
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
});

describe('shadowMarketGuardFires -- §7 three-condition rule', () => {
  test('fires only on a MEASURED FAIL + identified status-quo + switching_cost=1', () => {
    assert.equal(shadowMarketGuardFires({ ventureScaleStatus: 'FAIL', statusQuoIdentified: true, switchingCost: 1 }), true);
  });
  test('never fires on UNKNOWN, even with the other two conditions met', () => {
    assert.equal(shadowMarketGuardFires({ ventureScaleStatus: 'UNKNOWN', statusQuoIdentified: true, switchingCost: 1 }), false);
  });
  test('does not fire on WATCH', () => {
    assert.equal(shadowMarketGuardFires({ ventureScaleStatus: 'WATCH', statusQuoIdentified: true, switchingCost: 1 }), false);
  });
  test('does not fire without an identified status-quo alternative', () => {
    assert.equal(shadowMarketGuardFires({ ventureScaleStatus: 'FAIL', statusQuoIdentified: false, switchingCost: 1 }), false);
  });
  test('does not fire unless switching_cost crosses the 10x threshold (=1)', () => {
    assert.equal(shadowMarketGuardFires({ ventureScaleStatus: 'FAIL', statusQuoIdentified: true, switchingCost: 2 }), false);
    assert.equal(shadowMarketGuardFires({ ventureScaleStatus: 'FAIL', statusQuoIdentified: true, switchingCost: null }), false);
  });
});

// ============================================================================
// Acceptance test 5 -- hash collision tests
// ============================================================================

describe('contentHash -- §3.5 recipes', () => {
  test('two different competitors in one run produce different claim hashes', () => {
    const base = { card_id: 'card-1', topic: 'competition.competitor', ai_run_id: 'run-1' };
    const h1 = contentHash.claim({ ...base, item_key: 'acme-inc' });
    const h2 = contentHash.claim({ ...base, item_key: 'globex-corp' });
    assert.notEqual(h1, h2);
  });

  test('the same claim inputs hash identically (determinism)', () => {
    const args = { card_id: 'card-1', topic: 'competition.competitor', ai_run_id: 'run-1', item_key: 'acme-inc' };
    assert.equal(contentHash.claim(args), contentHash.claim({ ...args }));
  });

  test('a re-run (new ai_run_id) produces a new claim hash, so scores.trend has history', () => {
    const h1 = contentHash.claim({ card_id: 'card-1', topic: 'market.size_bottom_up', ai_run_id: 'run-1', item_key: '_' });
    const h2 = contentHash.claim({ card_id: 'card-1', topic: 'market.size_bottom_up', ai_run_id: 'run-2', item_key: '_' });
    assert.notEqual(h1, h2);
  });

  test('two tier=missing evidence rows on one claim from different queries produce different evidence hashes', () => {
    const base = { claim_id: 'claim-1', relation: 'context', source_url: null, quote_verbatim: null };
    const h1 = contentHash.evidence({ ...base, query: 'buyer count query 1' });
    const h2 = contentHash.evidence({ ...base, query: 'buyer count query 2' });
    assert.notEqual(h1, h2);
  });

  test('a raw_signals hash is stable for identical inputs and differs on any field change', () => {
    const base = { source: 'tavily_search', source_url: 'https://example.com/a', query: 'q1', observed_at: '2026-07-19' };
    const h1 = contentHash.rawSignal(base);
    const h2 = contentHash.rawSignal({ ...base });
    assert.equal(h1, h2);
    const h3 = contentHash.rawSignal({ ...base, query: 'q2' });
    assert.notEqual(h1, h3);
  });
});

// ============================================================================
// Acceptance test 6 -- tierForDomain default-deny
// ============================================================================

describe('tierForDomain -- §3.4 default-deny', () => {
  test('an unknown/never-seen report-mill domain defaults to inferred (the design.md live-probe example)', () => {
    assert.equal(tierForDomain('https://astuteanalytica.com/whatever'), 'inferred');
  });

  test('a genuinely unrecognizable domain also defaults to inferred', () => {
    assert.equal(tierForDomain('https://some-random-startup-blog-nobody-has-heard-of.io/post'), 'inferred');
  });

  test('a malformed URL defaults to inferred rather than throwing', () => {
    assert.equal(tierForDomain('not a url'), 'inferred');
  });

  test('the report-mill blocklist resolves to inferred, including via a subdomain', () => {
    assert.equal(tierForDomain('https://www.grandviewresearch.com/industry-analysis/x'), 'inferred');
    assert.equal(tierForDomain('https://reports.mordorintelligence.com/x'), 'inferred');
  });

  test('named documented-tier domains resolve to documented, with the correct split strength', () => {
    assert.equal(tierForDomain('https://www.sec.gov/filing'), 'documented');
    assert.equal(evidenceStrengthForDomain('https://www.sec.gov/filing'), 0.90);
    assert.equal(tierForDomain('https://www.ft.com/content/x'), 'documented');
    assert.equal(evidenceStrengthForDomain('https://www.ft.com/content/x'), 0.80);
  });

  test('named discovered-tier domains resolve to discovered', () => {
    assert.equal(tierForDomain('https://github.com/acme/repo'), 'discovered');
    assert.equal(evidenceStrengthForDomain('https://github.com/acme/repo'), 0.60);
  });

  test('named low-signal forums resolve to inferred', () => {
    assert.equal(tierForDomain('https://www.reddit.com/r/startups'), 'inferred');
    assert.equal(tierForDomain('https://news.ycombinator.com/item?id=1'), 'inferred');
  });
});

// ============================================================================
// confidence -- §6.5 + §7, cap ordering
// ============================================================================

describe('confidence -- §6.5 formula, hard caps, §7 penalty ordering', () => {
  test('evidence_ct = 0 caps confidence at 0.15 regardless of missingCount', () => {
    assert.ok(confidence({ evidenceCt: 0, missingCount: 0 }) <= 0.15);
    assert.ok(confidence({ evidenceCt: 0, missingCount: 5 }) <= 0.15);
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

// ============================================================================
// curate -- §4 relevance gate, dedup, first-party exemption, top-N
// ============================================================================

describe('curate -- §4', () => {
  test('filters out results below the 0.4 relevance gate', () => {
    const results = [
      { url: 'https://a.example.com/1', score: 0.5 },
      { url: 'https://b.example.com/1', score: 0.1 },
    ];
    const survivors = curate(results, null);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].url, 'https://a.example.com/1');
  });

  test('the first-party exemption bypasses the relevance gate only, not dedup or the blocklist', () => {
    const results = [
      { url: 'https://acme.com/about', score: 0.05 }, // first-party, low score -- must survive the gate
      { url: 'https://grandviewresearch.com/x', score: 0.99 }, // blocklisted, high score -- must still be dropped
    ];
    const survivors = curate(results, 'acme.com');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].url, 'https://acme.com/about');
    assert.equal(survivors[0].firstParty, true);
  });

  test('URL-normalised dedup collapses www/trailing-slash variants, keeping the higher score', () => {
    const results = [
      { url: 'https://Example.com/page/', score: 0.5 },
      { url: 'https://www.example.com/page', score: 0.8 },
    ];
    const survivors = curate(results, null);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].score, 0.8);
  });

  test('caps survivors at the top-8', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ url: `https://site${i}.example.com/`, score: 0.5 + i * 0.01 }));
    const survivors = curate(results, null);
    assert.equal(survivors.length, 8);
    assert.equal(survivors[0].score, results[19].score); // sorted descending by score
  });

  test('empty input returns an empty array', () => {
    assert.deepEqual(curate([], null), []);
    assert.deepEqual(curate(undefined, null), []);
  });
});
