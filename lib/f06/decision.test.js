// lib/f06/decision.test.js
//
// Acceptance tests for lib/f06/decision.js, per docs/backlog/06-memo-decision/
// plan.md task T1 and design.md §8's D1-D6 cascade. Run with:
//   node --test lib/f06/decision.test.js
// ONLY this file (single-file form) -- do NOT run the `lib/f06/*.test.js`
// glob / directory form: context.js and assemble.js are being built
// concurrently by parallel agents in this same new directory, and the
// directory form has an independent Node v22 quirk on this repo (same
// caution as lib/f05/trust.test.js's header, restated here for this dir).
//
// This file MAY require() -- only lib/f06/decision.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).
//
// -- Ambiguity resolutions (ownership: this file + decision.js only) --
// 1. `decide(inputs, configOverrides?)` takes an optional second config-
//    override argument, merged over DECISION_CONFIG. The task brief's
//    one-line signature only shows `decide(inputs)`, but the brief's own
//    acceptance list requires a "D1b disabled by config" case, and
//    DECISION_CONFIG is exported frozen -- the only way to exercise that
//    case without mutating a frozen exported object is a config-override
//    parameter. Matches this repo's existing convention (lib/f05/trust.js's
//    `computeTrustRollup(rows, config, ctx)`, config passed in with literal
//    fallbacks, never hardcoded a second time).
// 2. `conditions.items` is built ONLY for D6 (decision.js's own header cites
//    this). Design §8 spells out the items-construction recipe exclusively
//    under the D6 heading; the D2 prose ("condition = resolve the
//    contradiction / raise trust coverage") is narrative, not a second items
//    recipe. D1/D1b/D2/D3/D4/D5 all ship `items: []`.
// 3. `conditions.items[].claim_ids` is always `[]`: the frozen `decide()`
//    input contract (design §8's own inputs list, restated in the team-lead
//    task message) carries only axis/trust/contradiction NUMBERS, no
//    per-topic claim ids to cite. Any claim-id enrichment of condition items
//    is [D] Assemble's job (it holds the claim corpus), not this node's.
// 4. `decision_inputs.fatal_contradictions` is always present (not made
//    optional per the task brief's `fatal_contradictions?`) -- design §3.9
//    says the context pack "exposes both material_contradictions and
//    fatal_contradictions counts" unconditionally, so the traceability
//    snapshot carries both every time for a complete "exact numbers the RULE
//    saw" record (design §4.4's own framing).
//
// -- Inversion checks (locked cases, verified manually, not left inverted) --
// For each of D1, D2 (material-contradiction leg) and D4, the corresponding
// guard below was temporarily inverted in decision.js (`===` -> `!==` for
// D1's `thesisVerdict === 'failed'`; `> 0` -> `<= 0` for D2's
// `materialContradictions > 0`; `<` -> `>=` for D4's `axis.value <
// config.AXIS_LOW`), `node --test lib/f06/decision.test.js` was re-run, and
// the corresponding test below was confirmed to FAIL under each inversion.
// The inversions were then reverted (decision.js as committed has none of
// them) -- this comment is the record the task asked for.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { DECISION_CONFIG, CHECK_SIZE_USD, decide } = require('./decision.js');

const RECOMMENDATION_VOCAB = new Set(['proceed', 'proceed-with-conditions', 'pass', 'watchlist']);

// ============================================================================
// Fixtures -- a fully decidable, D6-boundary-adjacent baseline, overridden
// per test. Mirrors lib/f05/trust.test.js's claimRow()-style builder pattern.
// ============================================================================

function axis(value, assessed) {
  return { value, assessed };
}

const DEFAULTS = Object.freeze({
  thesis_verdict: 'passed',
  thesis_fit: 75,
  thesis_fired_rules: [],
  axes: {
    founder: axis(null, false), // assessed=false on every app today, design §8/§F5
    market: axis(68, true),
    idea_vs_market: axis(65, true),
  },
  founder_score: { value: null, assessed: false },
  trust: { value: 65, assessed: true, coverage: 0.5, confidence: 0.6 },
  material_contradictions: 0,
  fatal_contradictions: 0,
});

// Shallow-merges top-level keys; `axes`/`trust`/`founder_score` overrides
// replace whole nested objects (never a partial-field patch inside one axis)
// -- matches how decide()'s own input contract shapes those fields.
function makeInputs(overrides) {
  const o = overrides || {};
  return {
    thesis_verdict: 'thesis_verdict' in o ? o.thesis_verdict : DEFAULTS.thesis_verdict,
    thesis_fit: 'thesis_fit' in o ? o.thesis_fit : DEFAULTS.thesis_fit,
    thesis_fired_rules: 'thesis_fired_rules' in o ? o.thesis_fired_rules : DEFAULTS.thesis_fired_rules,
    axes: Object.assign({}, DEFAULTS.axes, o.axes),
    founder_score: 'founder_score' in o ? o.founder_score : DEFAULTS.founder_score,
    trust: 'trust' in o ? o.trust : DEFAULTS.trust,
    material_contradictions:
      'material_contradictions' in o ? o.material_contradictions : DEFAULTS.material_contradictions,
    fatal_contradictions: 'fatal_contradictions' in o ? o.fatal_contradictions : DEFAULTS.fatal_contradictions,
  };
}

function assertValidShape(result) {
  assert.ok(RECOMMENDATION_VOCAB.has(result.recommendation), `unexpected recommendation: ${result.recommendation}`);
  assert.equal(typeof result.conditions, 'object');
  assert.equal(result.conditions.check_size_usd, CHECK_SIZE_USD);
  assert.equal(typeof result.conditions.rationale, 'string');
  assert.ok(result.conditions.rationale.length > 0);
  assert.ok(Array.isArray(result.conditions.items));
  assert.equal(typeof result.conditions.decision_inputs, 'object');
  assert.equal(typeof result.conditions.decision_inputs.rule_fired, 'string');
  assert.equal(result.conditions.thresholds_version, DECISION_CONFIG.thresholds_version);
}

// ============================================================================
// DECISION_CONFIG -- constants sanity (plan.md T1's named-constants list)
// ============================================================================

describe('DECISION_CONFIG', () => {
  test('exposes the exact constants named in the task brief', () => {
    assert.equal(DECISION_CONFIG.TRUST_FLOOR, 40);
    assert.equal(DECISION_CONFIG.STRONG_TRUST, 60);
    assert.equal(DECISION_CONFIG.AXIS_HIGH, 60);
    assert.equal(DECISION_CONFIG.AXIS_LOW, 40);
    assert.equal(DECISION_CONFIG.CONF_FLOOR, 0.45);
    assert.equal(DECISION_CONFIG.MIN_TRUST_COVERAGE, 0.25);
    assert.equal(DECISION_CONFIG.ENABLE_FATAL_CONTRADICTION_PASS, true);
    assert.equal(DECISION_CONFIG.thresholds_version, 'f06-2026.07');
  });

  test('is frozen -- a consumer cannot mutate the exported defaults', () => {
    assert.throws(() => {
      'use strict';
      DECISION_CONFIG.TRUST_FLOOR = 0;
    });
  });
});

// ============================================================================
// D1 -- thesis_verdict == 'failed' -> pass, unconditionally
// ============================================================================

describe('D1 (design §8)', () => {
  test('thesis failed -> pass, regardless of strong scores', () => {
    const result = decide(
      makeInputs({
        thesis_verdict: 'failed',
        axes: { founder: axis(90, true), market: axis(90, true), idea_vs_market: axis(90, true) },
        trust: { value: 90, assessed: true, coverage: 0.9, confidence: 0.9 },
      })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'pass');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D1');
    assert.deepEqual(result.conditions.items, []);
  });
});

// ============================================================================
// D1b -- fatal_contradictions > 0 (config enabled) -> pass
// ============================================================================

describe('D1b (design §8, rev-2.1)', () => {
  test('fatal + material contradiction present -> pass (D1b wins over D2)', () => {
    const result = decide(
      makeInputs({
        material_contradictions: 1, // fatal implies material (design §3.9); D1b still wins over D2
        fatal_contradictions: 1,
      })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'pass');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D1b');
  });

  test('material but NON-fatal (temporal/scope) contradiction -> falls through to D2 watchlist, not D1b', () => {
    const result = decide(
      makeInputs({
        material_contradictions: 1, // documented contradiction, no factual/material event -> fatal stays 0
        fatal_contradictions: 0,
      })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D2');
  });

  test('ENABLE_FATAL_CONTRADICTION_PASS=false -> D1b disabled, falls to D2 even with fatal>0', () => {
    const result = decide(
      makeInputs({ material_contradictions: 1, fatal_contradictions: 1 }),
      { ENABLE_FATAL_CONTRADICTION_PASS: false }
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D2');
  });
});

// ============================================================================
// D2 -- material_contradictions > 0 OR (trust assessed AND trust < TRUST_FLOOR) -> watchlist
// ============================================================================

describe('D2 (design §8)', () => {
  test('material contradiction, no fatal -> watchlist', () => {
    const result = decide(makeInputs({ material_contradictions: 2 }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D2');
    assert.deepEqual(result.conditions.items, []); // items only on D6 (ambiguity resolution 2)
  });

  test('trust assessed below TRUST_FLOOR, zero contradictions -> watchlist', () => {
    const result = decide(
      makeInputs({ trust: { value: 35, assessed: true, coverage: 0.5, confidence: 0.6 } })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D2');
  });
});

// ============================================================================
// D3 -- NOT decidable -> watchlist
// ============================================================================

describe('D3 (design §8)', () => {
  test('thesis_verdict = insufficient_evidence (NULL-gate) -> not decidable -> watchlist', () => {
    const result = decide(makeInputs({ thesis_verdict: 'insufficient_evidence' }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D3');
  });

  test('thesis_verdict = null -> not decidable -> watchlist', () => {
    const result = decide(makeInputs({ thesis_verdict: null }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D3');
  });

  test('trust not assessed -> not decidable -> watchlist', () => {
    const result = decide(makeInputs({ trust: { value: null, assessed: false, coverage: null, confidence: null } }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D3');
  });

  test('trust coverage below MIN_TRUST_COVERAGE -> not decidable -> watchlist', () => {
    const result = decide(makeInputs({ trust: { value: 70, assessed: true, coverage: 0.1, confidence: 0.6 } }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D3');
  });

  test('trust confidence below CONF_FLOOR -> not decidable -> watchlist', () => {
    const result = decide(makeInputs({ trust: { value: 70, assessed: true, coverage: 0.5, confidence: 0.1 } }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D3');
  });

  test('only 1 of 3 screening axes assessed -> not decidable -> watchlist', () => {
    const result = decide(
      makeInputs({
        axes: { founder: axis(null, false), market: axis(70, true), idea_vs_market: axis(null, false) },
      })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'watchlist');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D3');
  });
});

// ============================================================================
// D4 -- any ASSESSED structural axis (market OR idea_vs_market) < AXIS_LOW -> pass
// ============================================================================

describe('D4 (design §8)', () => {
  test('measured market < 40 -> pass', () => {
    const result = decide(makeInputs({ axes: { market: axis(30, true), idea_vs_market: axis(65, true) } }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'pass');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D4');
  });

  test('measured idea_vs_market < 40 -> pass (market still strong -- non-averaging)', () => {
    const result = decide(makeInputs({ axes: { market: axis(70, true), idea_vs_market: axis(35, true) } }));
    assertValidShape(result);
    assert.equal(result.recommendation, 'pass');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D4');
  });

  test('low founder axis does NOT trigger D4 -- market/idea_vs_market both healthy -> falls to D6, not D4', () => {
    const result = decide(
      makeInputs({
        axes: { founder: axis(10, true), market: axis(65, true), idea_vs_market: axis(60, true) },
      })
    );
    assertValidShape(result);
    assert.notEqual(result.conditions.decision_inputs.rule_fired, 'D4');
    // founder=10 assessed and < AXIS_HIGH -> D5's "every assessed axis strong" fails too -> D6.
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D6');
    assert.equal(result.recommendation, 'proceed-with-conditions');
  });
});

// ============================================================================
// D5 -- everything strong -> proceed
// ============================================================================

describe('D5 (design §8)', () => {
  test('thesis passed, all assessed axes >= AXIS_HIGH, trust >= STRONG_TRUST, zero contradictions -> proceed', () => {
    const result = decide(
      makeInputs({
        axes: { founder: axis(70, true), market: axis(68, true), idea_vs_market: axis(65, true) },
        trust: { value: 70, assessed: true, coverage: 0.6, confidence: 0.7 },
      })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'proceed');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D5');
    assert.deepEqual(result.conditions.items, []); // clean proceed -- no conditions to close
  });
});

// ============================================================================
// D6 -- decidable, mixed -> proceed-with-conditions; rationale + items name
// exactly what fell short (design §4.4's worked example).
// ============================================================================

describe('D6 (design §8/§4.4)', () => {
  test('market 68 (strong) + idea_vs_market 55 (thin) + trust 55 (middling) -> proceed-with-conditions, ' +
    'naming idea-market fit and trust', () => {
    const result = decide(
      makeInputs({
        axes: { market: axis(68, true), idea_vs_market: axis(55, true) },
        trust: { value: 55, assessed: true, coverage: 0.5, confidence: 0.6 },
      })
    );
    assertValidShape(result);
    assert.equal(result.recommendation, 'proceed-with-conditions');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D6');

    // rationale names the disagreeing axes and trust (I6 -- renders the rule's own reasoning).
    assert.match(result.conditions.rationale, /idea-market fit/i);
    assert.match(result.conditions.rationale, /trust/i);
    assert.match(result.conditions.rationale, /55/); // both idea_vs_market and trust sit at 55

    // items name exactly what fell short: idea_vs_market (<AXIS_HIGH) + trust in [FLOOR, STRONG).
    const itemTexts = result.conditions.items.map((i) => i.text).join(' | ');
    assert.match(itemTexts, /idea-market fit/i);
    assert.match(itemTexts, /trust/i);
    assert.equal(result.conditions.items.length, 2); // no fired thesis rules in this fixture
    for (const item of result.conditions.items) {
      assert.deepEqual(item.claim_ids, []); // ambiguity resolution 3
    }
  });

  test('a fired soft deal-breaker rule is named in items', () => {
    const result = decide(
      makeInputs({
        axes: { market: axis(68, true), idea_vs_market: axis(68, true) },
        trust: { value: 70, assessed: true, coverage: 0.6, confidence: 0.7 },
        thesis_fired_rules: [
          { id: 'M_negkw', label: 'Mandate: negative keywords', kind: 'deal_breaker', enforcement: 'soft', outcome: 'triggered' },
          { id: 'M_sector', label: 'Mandate: sector', kind: 'focus', enforcement: 'soft', outcome: 'satisfied' }, // not fired
        ],
      })
    );
    assertValidShape(result);
    // all axes/trust strong -> would be D5, EXCEPT a fired soft rule alone
    // does not gate the cascade (design §8 only gates hard rules at D1) --
    // this fixture is D5 by the numbers; assert the satisfied rule is never
    // surfaced and, separately, that a triggered one would be (next case).
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D5');
  });

  test('fired soft deal-breaker rule surfaces as a condition item when the cascade IS at D6', () => {
    const result = decide(
      makeInputs({
        axes: { market: axis(55, true), idea_vs_market: axis(68, true) },
        trust: { value: 70, assessed: true, coverage: 0.6, confidence: 0.7 },
        thesis_fired_rules: [
          { id: 'M_negkw', label: 'Mandate: negative keywords', kind: 'deal_breaker', enforcement: 'soft', outcome: 'triggered' },
        ],
      })
    );
    assertValidShape(result);
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D6');
    const itemTexts = result.conditions.items.map((i) => i.text).join(' | ');
    assert.match(itemTexts, /Mandate: negative keywords/);
    assert.match(itemTexts, /market/i); // market=55 < AXIS_HIGH also surfaces
  });
});

// ============================================================================
// Non-averaging (I1) -- a strong axis must never rescue a weak one via an
// implicit mean.
// ============================================================================

describe('non-averaging (design I1)', () => {
  test('market=68, idea_vs_market=40 (exactly at AXIS_LOW, not below it) -> never proceed; ' +
    'a naive average (54) is irrelevant to the rule', () => {
    const result = decide(makeInputs({ axes: { market: axis(68, true), idea_vs_market: axis(40, true) } }));
    assertValidShape(result);
    assert.notEqual(result.recommendation, 'proceed');
    assert.equal(result.recommendation, 'proceed-with-conditions');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D6');
  });

  test('decision_inputs.axes always reports the three axes independently, never a combined figure', () => {
    const result = decide(makeInputs({ axes: { market: axis(68, true), idea_vs_market: axis(40, true) } }));
    const reportedAxes = result.conditions.decision_inputs.axes;
    assert.deepEqual(Object.keys(reportedAxes).sort(), ['founder', 'idea_vs_market', 'market']);
    assert.equal(reportedAxes.market, 68);
    assert.equal(reportedAxes.idea_vs_market, 40);
    assert.equal(reportedAxes.founder, null); // not assessed in this fixture -- absent is null, never 0 (I2)
  });
});

// ============================================================================
// Totality -- decide() never returns a null/undefined recommendation, even
// on malformed/partial input (fuzz-ish fixed adversarial set, kept
// deterministic rather than true Math.random() for reproducible CI runs).
// ============================================================================

describe('totality (never null, design §8 "never NULL")', () => {
  const adversarialInputs = [
    undefined,
    null,
    {},
    { thesis_verdict: 'bogus-value' },
    { axes: null },
    { axes: {} },
    { axes: { market: null, idea_vs_market: 'nope', founder: 42 } },
    { axes: { market: { value: 'NaN', assessed: true } } },
    { axes: { market: { value: NaN, assessed: true } } },
    { trust: null },
    { trust: 'not-an-object' },
    { trust: { value: 50, assessed: 'yes' } }, // assessed must be === true
    { material_contradictions: 'lots' },
    { material_contradictions: -1 },
    { fatal_contradictions: null },
    { thesis_fired_rules: 'not-an-array' },
    { thesis_fired_rules: [null, 42, 'x', { id: 'r1', enforcement: 'soft', outcome: 'triggered' }] },
    { founder_score: { value: 'high', assessed: true } },
    { thesis_verdict: 'passed', axes: { market: axis(1000, true), idea_vs_market: axis(-1000, true) } },
  ];

  for (const [i, fixture] of adversarialInputs.entries()) {
    test(`adversarial fixture #${i} never yields a null/invalid recommendation`, () => {
      const result = decide(fixture);
      assertValidShape(result);
    });
  }

  test('a config override with an unrelated/garbage key does not break the cascade', () => {
    const result = decide(makeInputs({}), { NOT_A_REAL_KEY: 'whatever', TRUST_FLOOR: 40 });
    assertValidShape(result);
    // DEFAULTS is a clean-strong fixture (market 68, idea_vs_market 65, trust
    // 65, thesis passed, zero contradictions) -- D5, not D6.
    assert.equal(result.recommendation, 'proceed');
    assert.equal(result.conditions.decision_inputs.rule_fired, 'D5');
  });
});
