// lib/f07/rules.test.js
//
// Tests for lib/f07/rules.js and lib/f07/vocabulary.js (feature 07, Thesis
// Engine, Stage B). Run with: node --test lib/f07/rules.test.js (or
// `node --test lib/f07/` for the whole directory).
//
// A note on provenance: design.md §9's rev.3a note references a six-case
// hand computation whose actual numbers were not written down anywhere in
// design.md/plan.md/tracker.md, so this file originally reconstructed six
// cases itself, directly from §1's own worked config example. rev3-check
// subsequently supplied the REAL six (now seven, with the keyword-mode
// case) cases -- computed independently, without seeing this file's code --
// against a DIFFERENT thesis config (D-04a: weights 30/25/25 plus a
// zero-weight deal-breaker, vs. this file's four-rules-at-20 reconstruction).
// Per the team lead (2026-07-19): these are two independent configurations
// exercising the same formula, not competing versions of one truth -- BOTH
// suites stay, labeled for what they are. Two describe blocks below:
// "six worked cases (reconstructed from §1's config)" is this file's own,
// and "seven worked cases (rev3-check / design.md D-04a, authoritative)" is
// the hand-verified one. Every case that overlaps in spirit produced
// consistent behavior between the two -- if the two sets ever disagree on a
// shared property, that is a signal to investigate, not something to
// reconcile by deleting one side.
//
// CALIBRATION (rev3-check, 2026-07-19): the six/seven-case agreement is
// SPEC-CONFORMANCE evidence, not independent correctness validation. Both
// sets were derived from the same source (§2/§3.1/§3.2/D-04), so a spec-
// level error passes both silently -- not hypothetical: case 4 was `passed`
// until rev.3a added step 2b, and case 7 exists only because keyword mode
// was writing ranked `scores` rows at coverage 0. A future reader should not
// read "133/133 green, cases 1-7 agree" as the formula being validated
// against ground truth; it means this file faithfully encodes what
// design.md currently says. The describe blocks below this one (evalExpr's
// empty-array-operand test, resolveField's `scaling` test, computeVerdict's
// hard-must_have-missed test, and "coverage never exceeds 1") are the
// property-level checks that would actually catch the NEXT spec-level
// error, per rev3-check's own list of what the seven cases do not touch.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const vocabulary = require('./vocabulary');
const { region_of, stage_of } = vocabulary;

const {
  clamp,
  compileMandateRules,
  compileRules,
  resolveField,
  evalContains,
  evalExpr,
  deriveOutcome,
  computeVerdict,
  evaluateThesis,
} = require('./rules');

// ============================================================================
// Shared fixture -- design.md §1's own worked config example ("B2B tech ·
// pre-seed/seed · EU+US · $100K", mirrored again at §7). A fresh object every
// call: several tests mutate their own copy (adding a rule, disabling one),
// and nothing here should leak across tests.
// ============================================================================

function baseConfig() {
  return {
    schema_version: 1,
    mandate: {
      stages: ['pre_seed', 'seed'],
      geographies: ['EU', 'US'],
      sectors: ['b2b-software', 'ai-infra', 'devtools'],
      risk_appetite: 'high',
      check_size_usd: { min: 50000, max: 150000 },
      ownership_target_pct: null,
    },
    geos: ['DE', 'FR', 'NL', 'US', 'GB'],
    positive_keywords: ['developer tools', 'infrastructure'],
    negative_keywords: ['casino', 'betting'],
    rules: [
      {
        id: 'R1', label: 'Excluded sector: gambling',
        kind: 'deal_breaker', enforcement: 'hard', hard_justification: 'mandate_fatal',
        expr: { field: 'sector', op: 'in', value: ['gambling', 'adtech'] },
        weight: 0, enabled: true,
      },
    ],
    fit: {
      base: 50,
      mandate_weight: 20,
      soft_deal_breaker_penalty: 30,
      strong_threshold: 70,
      min_coverage: 0.5,
    },
  };
}

// A fully-extracted, fully-matching attribute set against baseConfig(): every
// mandate-compiled rule (M_sector, M_geography, M_stage, M_poskw) is
// `satisfied`, R1 and M_negkw are `satisfied` (no_match on a deal_breaker).
function fullAttributes() {
  return {
    sector: 'b2b-software',
    business_model: 'b2b',
    geography_country: 'DE',
    stage_evidence: 'prototype',
    what_is_built: 'a developer tool for infrastructure automation',
    _text: 'we build developer tools for infrastructure automation',
  };
}

// ============================================================================
// vocabulary.js -- region_of / stage_of (§1.1), the building blocks rules.js
// composes for the two derived fields.
// ============================================================================

describe('vocabulary.region_of -- §1.1', () => {
  test('EU members map to EU', () => {
    assert.equal(region_of('DE'), 'EU');
    assert.equal(region_of('fr'), 'EU'); // case-insensitive
    assert.equal(region_of(' nl '), 'EU'); // trimmed
  });
  test('US -> US, GB -> UK (GB is not in the EU set)', () => {
    assert.equal(region_of('US'), 'US');
    assert.equal(region_of('GB'), 'UK');
  });
  test('starter APAC/LATAM/MEA sets resolve to their region', () => {
    assert.equal(region_of('CN'), 'APAC');
    assert.equal(region_of('BR'), 'LATAM');
    assert.equal(region_of('AE'), 'MEA');
  });
  test('a well-formed but unclassified code resolves to "other" -- a legal value, not unknown', () => {
    assert.equal(region_of('AQ'), 'other'); // Antarctica: real ISO code, no named block
  });
  test('absent/invalid input resolves to null -- distinct from "other"', () => {
    assert.equal(region_of(null), null);
    assert.equal(region_of(undefined), null);
    assert.equal(region_of(123), null);
    assert.equal(region_of('Germany'), null); // not a 2-letter code
    assert.equal(region_of(''), null);
  });
});

describe('vocabulary.stage_of -- §1.1 stage_evidence -> stage', () => {
  test('idea and prototype both map to pre_seed', () => {
    assert.equal(stage_of('idea'), 'pre_seed');
    assert.equal(stage_of('prototype'), 'pre_seed');
  });
  test('early_revenue maps to seed', () => {
    assert.equal(stage_of('early_revenue'), 'seed');
  });
  test('scaling has NO mapping -- null, never a stage value (acceptance criterion for B1)', () => {
    assert.equal(stage_of('scaling'), null);
  });
  test('unrecognized or absent evidence resolves to null', () => {
    assert.equal(stage_of('bogus'), null);
    assert.equal(stage_of(null), null);
    assert.equal(stage_of(undefined), null);
  });
});

// ============================================================================
// §1.2 -- mandate -> rule compilation
// ============================================================================

describe('compileMandateRules -- §1.2', () => {
  test('an empty mandate + no keywords compiles to nothing', () => {
    assert.deepEqual(compileMandateRules({}), []);
    assert.deepEqual(compileMandateRules({ mandate: {} }), []);
  });

  test('each row emits ONLY when its source array is non-empty', () => {
    const compiled = compileMandateRules({
      mandate: { sectors: [], geographies: ['EU'], stages: [] },
      positive_keywords: [],
      negative_keywords: ['casino'],
    });
    const ids = compiled.map((r) => r.id);
    assert.deepEqual(ids, ['M_geography', 'M_negkw']);
  });

  test('all four mandate-array rows compile to `focus`+`soft`, weight = fit.mandate_weight', () => {
    const compiled = compileMandateRules(baseConfig());
    const byId = Object.fromEntries(compiled.map((r) => [r.id, r]));

    assert.equal(byId.M_sector.kind, 'focus');
    assert.equal(byId.M_sector.enforcement, 'soft');
    assert.equal(byId.M_sector.weight, 20);
    assert.deepEqual(byId.M_sector.expr, { field: 'sector', op: 'in', value: ['b2b-software', 'ai-infra', 'devtools'] });

    assert.equal(byId.M_geography.kind, 'focus');
    assert.equal(byId.M_geography.expr.field, 'geography_region');
    assert.equal(byId.M_geography.weight, 20);

    assert.equal(byId.M_stage.kind, 'focus');
    assert.equal(byId.M_stage.expr.field, 'stage');
    assert.equal(byId.M_stage.weight, 20);

    assert.equal(byId.M_poskw.kind, 'focus');
    assert.equal(byId.M_poskw.expr.field, '_text');
    assert.equal(byId.M_poskw.expr.op, 'contains');
    assert.equal(byId.M_poskw.weight, 20);
  });

  test('M_negkw compiles to `deal_breaker`+`soft`, weight ALWAYS 0 -- never fit.mandate_weight', () => {
    const compiled = compileMandateRules({
      mandate: {},
      negative_keywords: ['casino', 'betting'],
      fit: { mandate_weight: 999 }, // a large mandate_weight must not leak into M_negkw
    });
    assert.equal(compiled.length, 1);
    assert.equal(compiled[0].id, 'M_negkw');
    assert.equal(compiled[0].kind, 'deal_breaker');
    assert.equal(compiled[0].enforcement, 'soft');
    assert.equal(compiled[0].weight, 0);
  });

  test('check_size_usd, ownership_target_pct, risk_appetite and geos compile to nothing', () => {
    const compiled = compileMandateRules({
      mandate: {
        check_size_usd: { min: 1, max: 2 },
        ownership_target_pct: 10,
        risk_appetite: 'high',
      },
      geos: ['DE', 'US'],
    });
    assert.deepEqual(compiled, []);
  });
});

describe('compileRules -- hand-authored + compiled, D-01 defaults', () => {
  test('a hand-authored rule with no `enforcement` defaults to soft (D-01)', () => {
    const compiled = compileRules({ rules: [{ id: 'X', kind: 'focus', weight: 10, expr: { field: 'sector', op: 'eq', value: 'fintech' } }] });
    assert.equal(compiled.find((r) => r.id === 'X').enforcement, 'soft');
  });
  test('a hand-authored rule with no `enabled` defaults to true; explicit false is preserved', () => {
    const compiled = compileRules({
      rules: [
        { id: 'Y1', kind: 'focus', weight: 10, expr: { field: 'sector', op: 'eq', value: 'fintech' } },
        { id: 'Y2', kind: 'focus', weight: 10, enabled: false, expr: { field: 'sector', op: 'eq', value: 'fintech' } },
      ],
    });
    assert.equal(compiled.find((r) => r.id === 'Y1').enabled, true);
    assert.equal(compiled.find((r) => r.id === 'Y2').enabled, false);
  });
  test('hand-authored rules come first, compiled mandate rules appended', () => {
    const compiled = compileRules(baseConfig());
    assert.equal(compiled[0].id, 'R1');
    assert.ok(compiled.slice(1).every((r) => r.id.startsWith('M_')));
  });
});

// ============================================================================
// Field resolution -- base fields, derived fields, and the `missingFields`
// contract (D-03).
// ============================================================================

describe('resolveField -- base and derived fields, D-03 unknown conditions', () => {
  test('a present base field resolves known', () => {
    assert.deepEqual(resolveField('sector', { sector: 'fintech' }, []), { value: 'fintech', unknown: false });
  });
  test('an absent base field resolves unknown, without needing to be listed in missingFields', () => {
    assert.deepEqual(resolveField('sector', {}, []), { value: null, unknown: true });
  });
  test('a field explicitly listed in missingFields resolves unknown even if present in attributes', () => {
    // models a claim backed only by a `contradicted` verification_status (D-03) --
    // the caller folds that into missingFields before calling in.
    assert.deepEqual(resolveField('sector', { sector: 'fintech' }, ['sector']), { value: null, unknown: true });
  });

  test('geography_region derives from geography_country via region_of()', () => {
    assert.deepEqual(resolveField('geography_region', { geography_country: 'DE' }, []), { value: 'EU', unknown: false });
  });
  test('geography_region is unknown when geography_country is absent, contradicted, or itself listed missing', () => {
    assert.equal(resolveField('geography_region', {}, []).unknown, true);
    assert.equal(resolveField('geography_region', { geography_country: 'DE' }, ['geography_country']).unknown, true);
    assert.equal(resolveField('geography_region', { geography_country: 'DE' }, ['geography_region']).unknown, true);
  });

  test('stage derives from stage_evidence via stage_of()', () => {
    assert.deepEqual(resolveField('stage', { stage_evidence: 'prototype' }, []), { value: 'pre_seed', unknown: false });
    assert.deepEqual(resolveField('stage', { stage_evidence: 'early_revenue' }, []), { value: 'seed', unknown: false });
  });
  test('stage_evidence=scaling yields unknown on stage rules -- never a rejection (B1/B2 acceptance criterion)', () => {
    assert.deepEqual(resolveField('stage', { stage_evidence: 'scaling' }, []), { value: null, unknown: true });
  });
});

describe('evalContains -- §1.1 type dispatch', () => {
  test('text field + array operand: substring-match-on-any-element (OR)', () => {
    assert.equal(evalContains('developer tools for infra', ['fintech', 'developer']), true);
    assert.equal(evalContains('developer tools for infra', ['fintech', 'healthtech']), false);
  });
  test('text field + string operand: plain substring match', () => {
    assert.equal(evalContains('developer tools for infra', 'developer'), true);
    assert.equal(evalContains('developer tools for infra', 'healthtech'), false);
  });
  test('multi-valued field (array fieldValue): array membership', () => {
    assert.equal(evalContains(['a', 'b', 'c'], 'b'), true);
    assert.equal(evalContains(['a', 'b', 'c'], ['x', 'b']), true);
    assert.equal(evalContains(['a', 'b', 'c'], ['x', 'y']), false);
  });
});

// ============================================================================
// D-03 -- three-valued evaluation, all ops, negate.
// ============================================================================

describe('evalExpr -- ops and negate (D-03)', () => {
  test('eq', () => {
    assert.equal(evalExpr({ field: 'business_model', op: 'eq', value: 'b2b' }, { business_model: 'b2b' }, []), 'match');
    assert.equal(evalExpr({ field: 'business_model', op: 'eq', value: 'b2c' }, { business_model: 'b2b' }, []), 'no_match');
  });
  test('in', () => {
    assert.equal(evalExpr({ field: 'sector', op: 'in', value: ['ai-infra', 'devtools'] }, { sector: 'ai-infra' }, []), 'match');
    assert.equal(evalExpr({ field: 'sector', op: 'in', value: ['ai-infra', 'devtools'] }, { sector: 'consumer' }, []), 'no_match');
  });
  test('gte / lte on a generic numeric field (not part of the closed vocabulary -- expr is evaluable against any key)', () => {
    assert.equal(evalExpr({ field: 'employee_count', op: 'gte', value: 10 }, { employee_count: 12 }, []), 'match');
    assert.equal(evalExpr({ field: 'employee_count', op: 'lte', value: 10 }, { employee_count: 12 }, []), 'no_match');
  });
  test('exists: known field always matches; absent field is unknown, never no_match', () => {
    assert.equal(evalExpr({ field: 'sector', op: 'exists' }, { sector: 'fintech' }, []), 'match');
    assert.equal(evalExpr({ field: 'sector', op: 'exists' }, {}, []), 'unknown');
  });
  test('negate flips a resolved match/no_match but cannot manufacture one out of unknown', () => {
    assert.equal(evalExpr({ field: 'sector', op: 'eq', value: 'gambling', negate: true }, { sector: 'b2b-software' }, []), 'match');
    assert.equal(evalExpr({ field: 'sector', op: 'eq', value: 'gambling', negate: true }, { sector: 'gambling' }, []), 'no_match');
    assert.equal(evalExpr({ field: 'sector', op: 'eq', value: 'gambling', negate: true }, {}, []), 'unknown');
  });
  test('contains: empty array operand yields unknown, not a miss (§1.1) -- regardless of the field\'s own value', () => {
    assert.equal(evalExpr({ field: '_text', op: 'contains', value: [] }, { _text: 'anything at all' }, []), 'unknown');
    assert.equal(evalExpr({ field: '_text', op: 'contains', value: [] }, {}, []), 'unknown');
  });
  test('an absent field is unknown regardless of op', () => {
    assert.equal(evalExpr({ field: 'sector', op: 'eq', value: 'fintech' }, {}, []), 'unknown');
  });
  test('an unsupported op throws rather than silently mis-evaluating', () => {
    assert.throws(() => evalExpr({ field: 'sector', op: 'nope', value: 'x' }, { sector: 'x' }, []));
  });
});

// ============================================================================
// D-04 -- outcome vocabulary, the full table.
// ============================================================================

describe('deriveOutcome -- D-04, the full table', () => {
  test('focus', () => {
    assert.equal(deriveOutcome('focus', 'match'), 'satisfied');
    assert.equal(deriveOutcome('focus', 'no_match'), 'missed');
    assert.equal(deriveOutcome('focus', 'unknown'), 'unknown');
  });
  test('must_have', () => {
    assert.equal(deriveOutcome('must_have', 'match'), 'satisfied');
    assert.equal(deriveOutcome('must_have', 'no_match'), 'missed');
    assert.equal(deriveOutcome('must_have', 'unknown'), 'unknown');
  });
  test('deal_breaker -- match triggers, no_match is the SAFE (satisfied) reading, never the reverse', () => {
    assert.equal(deriveOutcome('deal_breaker', 'match'), 'triggered');
    assert.equal(deriveOutcome('deal_breaker', 'no_match'), 'satisfied');
    assert.equal(deriveOutcome('deal_breaker', 'unknown'), 'unknown');
  });
});

// ============================================================================
// §2 -- ordered verdict procedure, tested in isolation from rule evaluation.
// ============================================================================

describe('computeVerdict -- §2 ordered procedure, isolated', () => {
  test('step 1: a hard rule outcome=missed forces failed, even with a high fit and full coverage', () => {
    const verdict = computeVerdict({
      firedRules: [{ kind: 'must_have', enforcement: 'hard', outcome: 'missed' }],
      fit: 95, coverage: 1.0, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.equal(verdict, 'failed');
  });
  test('step 1: a hard rule outcome=triggered (deal_breaker) forces failed', () => {
    const verdict = computeVerdict({
      firedRules: [{ kind: 'deal_breaker', enforcement: 'hard', outcome: 'triggered' }],
      fit: 95, coverage: 1.0, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.equal(verdict, 'failed');
  });
  test('step 1: an unknown outcome on a hard rule never forces anything (D-03: unknown cannot reject)', () => {
    const verdict = computeVerdict({
      firedRules: [{ kind: 'must_have', enforcement: 'hard', outcome: 'unknown' }],
      fit: 10, coverage: 0.9, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.notEqual(verdict, 'failed');
  });
  test('step 2 (full mode only): coverage below min_coverage -> insufficient_evidence', () => {
    const verdict = computeVerdict({
      firedRules: [], fit: 90, coverage: 0.3, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.equal(verdict, 'insufficient_evidence');
  });
  test('step 2b: a triggered soft deal-breaker forces borderline even when fit clears strong_threshold', () => {
    const verdict = computeVerdict({
      firedRules: [{ kind: 'deal_breaker', enforcement: 'soft', outcome: 'triggered' }],
      fit: 95, coverage: 1.0, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.equal(verdict, 'borderline');
  });
  test('step 3 (full mode only): fit >= strong_threshold, nothing else fired -> passed', () => {
    const verdict = computeVerdict({
      firedRules: [], fit: 70, coverage: 1.0, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.equal(verdict, 'passed');
  });
  test('step 4: fit below strong_threshold, nothing else fired -> borderline', () => {
    const verdict = computeVerdict({
      firedRules: [], fit: 69.99, coverage: 1.0, minCoverage: 0.5, strongThreshold: 70, mode: 'full',
    });
    assert.equal(verdict, 'borderline');
  });
  test('keyword mode: never insufficient_evidence (no coverage to be short of), never passed, even at fit=100', () => {
    const verdict = computeVerdict({
      firedRules: [], fit: 100, coverage: null, minCoverage: 0.5, strongThreshold: 70, mode: 'keyword',
    });
    assert.equal(verdict, 'borderline');
  });
  test('keyword mode: a hard rule can still fire failed (e.g. a hand-authored hard rule on _text)', () => {
    const verdict = computeVerdict({
      firedRules: [{ kind: 'deal_breaker', enforcement: 'hard', outcome: 'triggered' }],
      fit: 100, coverage: null, minCoverage: 0.5, strongThreshold: 70, mode: 'keyword',
    });
    assert.equal(verdict, 'failed');
  });
});

// ============================================================================
// evaluateThesis -- the six worked cases (RECONSTRUCTED from §1's own worked
// config example -- see the provenance note at the top of this file). Kept
// alongside the rev3-check/D-04a suite below, not replaced by it: the two
// exercise the SAME formula against two independently-authored thesis
// configs (this one: four rules at weight 20 apiece, total 80; D-04a:
// 30/25/25 plus a zero-weight deal-breaker, also total 80), which is more
// evidence than either suite alone, per the team lead's explicit ruling
// (2026-07-19) not to collapse them into one.
// ============================================================================

describe('evaluateThesis -- six worked cases (reconstructed from §1\'s config)', () => {
  test('case 1 -- fully extracted, everything matches -> passed, fit=100, coverage=1', () => {
    const result = evaluateThesis({ config: baseConfig(), attributes: fullAttributes(), missingFields: [], mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 80);
    assert.equal(result.coverage, 1);
    assert.equal(result.fit, 100);
    assert.equal(result.verdict, 'passed');
  });

  test('case 2 -- half the focus rules miss, fully extracted -> borderline, fit=50, coverage=1', () => {
    const attributes = {
      sector: 'consumer', // not in mandate.sectors -> M_sector missed
      geography_country: 'DE', // -> EU, matches
      stage_evidence: 'prototype', // -> pre_seed, matches
      _text: 'we sell directly to consumers', // no positive keyword -> M_poskw missed
    };
    const result = evaluateThesis({ config: baseConfig(), attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 40);
    assert.equal(result.coverage, 1);
    assert.equal(result.fit, 50);
    assert.equal(result.verdict, 'borderline');
  });

  test('case 3 -- a hard must_have miss forces failed even though fit alone would pass', () => {
    const config = baseConfig();
    config.rules.push({
      id: 'R2', label: 'Must have: B2B model', kind: 'must_have', enforcement: 'hard',
      hard_justification: 'mandate_fatal',
      expr: { field: 'business_model', op: 'eq', value: 'b2b' },
      weight: 10, enabled: true,
    });
    const attributes = { ...fullAttributes(), business_model: 'b2c' }; // R2 misses
    const result = evaluateThesis({ config, attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 90); // 80 + R2's 10
    assert.equal(result.earned, 80); // R2 contributes 0 (missed)
    assert.equal(result.coverage, 1); // R2 was extracted and evaluated, just not satisfied
    assert.ok(Math.abs(result.fit - 8000 / 90) < 1e-9); // 100*80/90, fit alone would clear strong_threshold
    assert.equal(result.verdict, 'failed'); // step 1 outranks step 3
  });

  test('case 4 -- the hard deal-breaker (R1) triggers on an actual gambling sector -> failed', () => {
    const attributes = { ...fullAttributes(), sector: 'gambling' }; // R1 triggers; M_sector also misses
    const result = evaluateThesis({ config: baseConfig(), attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 60); // M_sector missed (20 lost), the other three still satisfied
    assert.equal(result.coverage, 1);
    assert.equal(result.fit, 75); // 100*60/80, would itself clear strong_threshold
    assert.equal(result.verdict, 'failed'); // R1 (hard) outranks fit
  });

  test('case 5 -- sparse extraction: only sector known -> insufficient_evidence, coverage below 0.5', () => {
    const attributes = { sector: 'b2b-software' };
    const missingFields = ['business_model', 'geography_country', 'stage_evidence', '_text'];
    const result = evaluateThesis({ config: baseConfig(), attributes, missingFields, mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 20); // only M_sector satisfied; the rest unknown
    assert.equal(result.coverage, 0.25);
    assert.equal(result.fit, 25);
    assert.equal(result.verdict, 'insufficient_evidence');
  });

  test('case 6 -- keyword mode: no LLM fields at all, only _text evaluates -> borderline, coverage=null', () => {
    const attributes = { _text: 'we build developer tools for infrastructure automation' };
    const missingFields = ['sector', 'business_model', 'geography_country', 'stage_evidence'];
    const result = evaluateThesis({ config: baseConfig(), attributes, missingFields, mode: 'keyword' });
    assert.equal(result.mode, 'keyword');
    assert.equal(result.total, 80); // total is thesis-constant regardless of mode
    assert.equal(result.earned, 20); // only M_poskw (the one _text rule) is satisfied
    assert.equal(result.coverage, null); // §3.2 / §6.1: NULL in keyword mode, never computed
    assert.equal(result.fit, 25); // fit is still computed even though coverage is bypassed
    assert.equal(result.verdict, 'borderline'); // never insufficient_evidence, never passed
  });
});

// ============================================================================
// evaluateThesis -- the seven worked cases, AUTHORITATIVE (rev3-check /
// design.md D-04a, the rev.3a hand computation, received directly from the
// agent that ran it, against its OWN independently-authored thesis config).
// Cross-checked by hand against §3.1/§3.2/D-04 before being encoded, and
// every number matched this file's implementation with zero discrepancy,
// which is itself the strongest evidence available that rules.js is correct
// (an independent hand computation and this code agree on all seven).
//
// Shared fixture, thesis "T" (deliberately different rule shape from
// baseConfig() above -- distinct weights make a transcription error visible
// rather than accidentally matching):
//   fit: { base: 50, min_coverage: 0.5, strong_threshold: 70,
//          soft_deal_breaker_penalty: 30 }
//   R_mh: must_have, soft, business_model eq "b2b",        weight 30
//   R_f1: focus,     soft, sector in ["ai-infra"],          weight 25
//   R_f2: focus,     soft, geography_region in ["EU"],      weight 25
//   R_db: deal_breaker, soft, _text contains ["casino"],    weight 0
//   total = 30+25+25 = 80 for cases 1-4 and 6-7 (deal_breaker weight
//   excluded, D-04). Case 5 uses a DIFFERENT thesis: only R_db, total = 0.
// ============================================================================

function thesisT() {
  return {
    schema_version: 1,
    fit: { base: 50, min_coverage: 0.5, strong_threshold: 70, soft_deal_breaker_penalty: 30 },
    rules: [
      { id: 'R_mh', label: 'Must have: B2B', kind: 'must_have', enforcement: 'soft',
        expr: { field: 'business_model', op: 'eq', value: 'b2b' }, weight: 30, enabled: true },
      { id: 'R_f1', label: 'Focus: ai-infra', kind: 'focus', enforcement: 'soft',
        expr: { field: 'sector', op: 'in', value: ['ai-infra'] }, weight: 25, enabled: true },
      { id: 'R_f2', label: 'Focus: EU', kind: 'focus', enforcement: 'soft',
        expr: { field: 'geography_region', op: 'in', value: ['EU'] }, weight: 25, enabled: true },
      { id: 'R_db', label: 'Deal-breaker: casino text', kind: 'deal_breaker', enforcement: 'soft',
        expr: { field: '_text', op: 'contains', value: ['casino'] }, weight: 0, enabled: true },
    ],
  };
}

// Case 5's thesis: only R_db -- isolates fit.base / coverage=1.0's total=0 else-branch.
function thesisOnlyDealBreaker() {
  const t = thesisT();
  return { ...t, rules: t.rules.filter((r) => r.id === 'R_db') };
}

describe('evaluateThesis -- seven worked cases (rev3-check, authoritative)', () => {
  test('case 1 -- business_model=b2b, sector=ai-infra, geography_region=US, no casino -> borderline, fit=68.75', () => {
    const attributes = { business_model: 'b2b', sector: 'ai-infra', geography_region: 'US', _text: 'we build productivity software for remote teams' };
    const result = evaluateThesis({ config: thesisT(), attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 55); // R_mh(30) + R_f1(25); R_f2 misses (US not EU)
    assert.equal(result.coverage, 1.0);
    assert.equal(result.fit, 68.75);
    assert.equal(result.verdict, 'borderline');
  });

  test('case 2 -- as case 1 but business_model + sector in missing_fields -> insufficient_evidence, coverage=0.3125', () => {
    const attributes = { geography_region: 'US', _text: 'we build productivity software for remote teams' };
    const missingFields = ['business_model', 'sector'];
    const result = evaluateThesis({ config: thesisT(), attributes, missingFields, mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 0); // R_mh, R_f1 unknown; R_f2 misses (0 either way)
    // raw float asserted here, per rev3-check's note -- 0.31 is what
    // numeric(3,2) rounds it to at the persistence layer, not this function's job.
    assert.equal(result.coverage, 0.3125);
    assert.equal(result.fit, 0);
    assert.equal(result.verdict, 'insufficient_evidence');
  });

  test('case 3 -- nothing extracted except _text, no casino -> insufficient_evidence, coverage=0', () => {
    const attributes = { _text: 'we build productivity software for remote teams' };
    const missingFields = ['business_model', 'sector', 'geography_region'];
    const result = evaluateThesis({ config: thesisT(), attributes, missingFields, mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 0);
    assert.equal(result.coverage, 0);
    assert.equal(result.fit, 0);
    assert.equal(result.verdict, 'insufficient_evidence');
  });

  test('case 4 -- all match, _text contains "casino" -> borderline (NOT passed), fit=70.00 exactly (rev.3a step 2b regression)', () => {
    // This is the case rev.3a's step 2b exists for: fit lands EXACTLY at
    // strong_threshold (100 - soft_deal_breaker_penalty = 70), which clears
    // step 3's ">=" test on the number alone. Do not "simplify" this back to
    // `passed` because the fit value looks like it should qualify -- a
    // triggered soft deal-breaker must cap the verdict at borderline (D-01).
    const attributes = { business_model: 'b2b', sector: 'ai-infra', geography_region: 'EU', _text: 'also some casino-adjacent stuff' };
    const result = evaluateThesis({ config: thesisT(), attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 80);
    assert.equal(result.coverage, 1.0);
    assert.equal(result.penalty, 30);
    assert.equal(result.fit, 70.0);
    assert.notEqual(result.verdict, 'passed');
    assert.equal(result.verdict, 'borderline');
  });

  test('case 5 -- a thesis with ONLY a (non-triggered) deal-breaker -> total=0, fit=fit.base, coverage=1.0 (else-branch), borderline', () => {
    const attributes = { _text: 'we build productivity software for remote teams' };
    const result = evaluateThesis({ config: thesisOnlyDealBreaker(), attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 0);
    assert.equal(result.earned, 0);
    assert.equal(result.coverage, 1.0); // total=0 else-branch, §3.2
    assert.equal(result.fit, 50); // fit.base, §3.1's total=0 else-branch
    assert.equal(result.verdict, 'borderline'); // fit(50) < strong_threshold(70), nothing else fired
  });

  test('case 6 -- all extracted, all match, nothing triggered -> passed, fit=100', () => {
    const attributes = { business_model: 'b2b', sector: 'ai-infra', geography_region: 'EU', _text: 'we build productivity software for remote teams' };
    const result = evaluateThesis({ config: thesisT(), attributes, missingFields: [], mode: 'full' });
    assert.equal(result.total, 80);
    assert.equal(result.earned, 80);
    assert.equal(result.coverage, 1.0);
    assert.equal(result.penalty, 0);
    assert.equal(result.fit, 100);
    assert.equal(result.verdict, 'passed');
  });

  test('case 7 -- keyword mode, no hints, no casino -> total=80, earned=0, coverage=null, fit=0, borderline (D-07 regression)', () => {
    // rev3-check's own addendum: this is the D-07 regression for keyword
    // mode specifically -- coverage's underlying ratio here is 0/80=0.00,
    // which in `full` mode would read `insufficient_evidence`; in `keyword`
    // mode it must instead report `coverage: null` and land `borderline`,
    // never quietly becoming a ranked `scores` row at `thesis_fit=0`.
    const attributes = { _text: 'we build productivity software for remote teams' };
    const missingFields = ['business_model', 'sector', 'geography_region'];
    const result = evaluateThesis({ config: thesisT(), attributes, missingFields, mode: 'keyword' });
    assert.equal(result.mode, 'keyword');
    assert.equal(result.total, 80);
    assert.equal(result.earned, 0);
    assert.equal(result.coverage, null);
    assert.equal(result.fit, 0);
    assert.equal(result.verdict, 'borderline');
  });
});

// ============================================================================
// Step 2b, dedicated: exactly strong_threshold with a triggered soft
// deal-breaker must still read borderline. This is the defect rev.3a fixed
// (§9): all rules matching alone would score exactly `strong_threshold` under
// §3.1's formula (100 - soft_deal_breaker_penalty = 70), which would clear
// step 3's ">=" test and reach `passed` without step 2b.
// ============================================================================

describe('step 2b -- a triggered soft deal-breaker cannot reach the top lane', () => {
  test('all focus/must_have rules matched + M_negkw triggered -> fit lands exactly at strong_threshold, verdict is borderline, not passed', () => {
    const attributes = {
      ...fullAttributes(),
      // still contains both positive keywords AND a negative one:
      _text: 'we build developer tools for infrastructure, though also some casino-adjacent work',
    };
    const result = evaluateThesis({ config: baseConfig(), attributes, missingFields: [], mode: 'full' });

    assert.equal(result.total, 80);
    assert.equal(result.earned, 80); // every must_have/focus rule still satisfied
    assert.equal(result.penalty, 30); // fit.soft_deal_breaker_penalty, M_negkw triggered once
    assert.equal(result.fit, 70); // 100*80/80 - 30 = 70 = fit.strong_threshold, EXACTLY
    assert.equal(result.coverage, 1);
    assert.notEqual(result.verdict, 'passed');
    assert.equal(result.verdict, 'borderline');
  });
});

// ============================================================================
// Keyword mode, dedicated: never passed even when the underlying ratio would
// clearly clear strong_threshold, and coverage is always reported as null --
// not merely "usually low", never computed at all.
// ============================================================================

describe('keyword mode -- never passed, coverage always null (§6.1)', () => {
  test('a keyword-mode case whose fit would clear strong_threshold in full mode is still capped at borderline', () => {
    const config = baseConfig();
    config.rules.push({
      id: 'R3', label: 'Heavily weighted text signal', kind: 'focus', enforcement: 'soft',
      expr: { field: '_text', op: 'contains', value: ['developer tools'] },
      weight: 200, enabled: true,
    });
    const attributes = { _text: 'we build developer tools for infrastructure automation' };
    const missingFields = ['sector', 'business_model', 'geography_country', 'stage_evidence'];
    const result = evaluateThesis({ config, attributes, missingFields, mode: 'keyword' });

    assert.equal(result.total, 280); // R3(200) + 4 mandate rules(20 each)
    assert.equal(result.earned, 220); // R3(200) + M_poskw(20); the rest unknown
    // the underlying ratio (220/280 ≈ 78.6) clears strong_threshold(70) --
    // this is the case that makes "never passed" a real constraint, not a
    // vacuous one.
    assert.ok(result.fit >= config.fit.strong_threshold);
    assert.equal(result.coverage, null);
    assert.notEqual(result.verdict, 'passed');
    assert.equal(result.verdict, 'borderline');
  });

  test('keyword mode never calls anything resembling extraction -- it only ever reads the attributes it is given', () => {
    // rules.js has no I/O of its own either way; this documents the contract
    // rather than testing an LLM call that does not belong in this module.
    const result = evaluateThesis({
      config: baseConfig(),
      attributes: { _text: 'no keywords here at all' },
      missingFields: ['sector', 'business_model', 'geography_country', 'stage_evidence'],
      mode: 'keyword',
    });
    assert.equal(result.coverage, null);
    assert.notEqual(result.verdict, 'passed');
  });
});

// ============================================================================
// coverage never exceeds 1 when a rule is enabled: false (§3.2's own
// regression case: a disabled rule must be dropped from BOTH total and
// evaluated, or it can enter one side but not the other).
// ============================================================================

describe('coverage never exceeds 1 -- a disabled rule contributes nothing to either side', () => {
  test('a disabled, would-otherwise-satisfy rule leaves total/earned/coverage/fit byte-for-byte identical to the case without it', () => {
    const withoutDisabled = evaluateThesis({ config: baseConfig(), attributes: fullAttributes(), missingFields: [], mode: 'full' });

    const configWithDisabled = baseConfig();
    configWithDisabled.rules.push({
      id: 'R5', label: 'Disabled rule that would otherwise satisfy', kind: 'focus', enforcement: 'soft',
      enabled: false, weight: 1000,
      expr: { field: 'sector', op: 'eq', value: 'b2b-software' }, // matches fullAttributes()
    });
    const withDisabled = evaluateThesis({ config: configWithDisabled, attributes: fullAttributes(), missingFields: [], mode: 'full' });

    assert.equal(withDisabled.total, withoutDisabled.total);
    assert.equal(withDisabled.earned, withoutDisabled.earned);
    assert.equal(withDisabled.coverage, withoutDisabled.coverage);
    assert.equal(withDisabled.fit, withoutDisabled.fit);
    assert.ok(withDisabled.coverage <= 1);
    assert.equal(withDisabled.fired_rules.some((r) => r.id === 'R5'), false); // never evaluated at all
  });
});

// ============================================================================
// D-07 property test -- the one that matters (§8.3 item 1; rev.1 and rev.2
// both shipped a REQ-003 violation here).
//
// The property asserted is D-07's GUARANTEE AS STATED, not the weaker and
// FALSE "fit does not drop": design.md is explicit that no arithmetic fix can
// keep fit from dropping as data goes missing (crediting unknowns at 0.5 or
// 1.0 both fail, for the reasons §9/D-07 give), and this suite's own case 3/4
// above show fit legitimately falling as rules go from satisfied to unknown.
// What is actually guaranteed:
//
//   "An application is never RANKED on a fit computed from less than
//   fit.min_coverage of the thesis's total rule weight. Insufficient data
//   removes it from the ranking and routes it to enrichment; it never
//   places it at the bottom of the ranking."
//
// Operationalized here as: for every coverage level reachable by removing
// extracted fields one at a time from a fully-extracted case, verdict is
// `insufficient_evidence` if and only if coverage < fit.min_coverage. There
// is no coverage level at which a case is BOTH below min_coverage AND still
// carries an ordinary (rankable) verdict, and no level above min_coverage
// that is incorrectly excluded either.
// ============================================================================

describe('D-07 property test -- an application is never ranked below min_coverage, never silently sunk instead', () => {
  // Four extracted fields feed baseConfig()'s four must_have/focus rules
  // 1:1 (each mandate rule weight 20 of a total 80) -- removing them one at
  // a time steps coverage through 1.00 / 0.75 / 0.50 / 0.25 / 0.00 exactly,
  // straddling min_coverage=0.5 at the k=2 -> k=3 boundary.
  const REMOVAL_ORDER = ['sector', 'geography_country', 'stage_evidence', '_text'];
  const EXPECTED_COVERAGE = [1, 0.75, 0.5, 0.25, 0];

  test('coverage steps through 1.00/0.75/0.50/0.25/0.00 as fields are removed one at a time', () => {
    for (let k = 0; k <= REMOVAL_ORDER.length; k++) {
      const missingFields = REMOVAL_ORDER.slice(0, k);
      const attributes = { ...fullAttributes() };
      missingFields.forEach((field) => { delete attributes[field]; });

      const result = evaluateThesis({ config: baseConfig(), attributes, missingFields, mode: 'full' });
      assert.equal(result.coverage, EXPECTED_COVERAGE[k], `k=${k}: expected coverage ${EXPECTED_COVERAGE[k]}, got ${result.coverage}`);
    }
  });

  test('verdict is insufficient_evidence if and only if coverage < min_coverage -- at every removal step, never both a rankable verdict AND under-covered', () => {
    const minCoverage = baseConfig().fit.min_coverage;
    for (let k = 0; k <= REMOVAL_ORDER.length; k++) {
      const missingFields = REMOVAL_ORDER.slice(0, k);
      const attributes = { ...fullAttributes() };
      missingFields.forEach((field) => { delete attributes[field]; });

      const result = evaluateThesis({ config: baseConfig(), attributes, missingFields, mode: 'full' });
      const shouldBeExcluded = result.coverage < minCoverage;
      assert.equal(
        result.verdict === 'insufficient_evidence',
        shouldBeExcluded,
        `k=${k}: coverage=${result.coverage}, verdict=${result.verdict}, expected excluded=${shouldBeExcluded}`
      );
    }
  });

  test('exactly at min_coverage (k=2, coverage=0.5) the application is still ranked -- the gate is a strict "<", not "<="', () => {
    const missingFields = REMOVAL_ORDER.slice(0, 2); // sector, geography_country removed
    const attributes = { ...fullAttributes() };
    missingFields.forEach((field) => { delete attributes[field]; });

    const result = evaluateThesis({ config: baseConfig(), attributes, missingFields, mode: 'full' });
    assert.equal(result.coverage, 0.5);
    assert.notEqual(result.verdict, 'insufficient_evidence');
  });

  test('removing a field that FEEDS A HARD RULE (sector, R1) never turns the verdict into failed -- unknown cannot reject (D-03), even mid-sequence', () => {
    for (let k = 1; k <= REMOVAL_ORDER.length; k++) {
      const missingFields = REMOVAL_ORDER.slice(0, k);
      const attributes = { ...fullAttributes() };
      missingFields.forEach((field) => { delete attributes[field]; });

      const result = evaluateThesis({ config: baseConfig(), attributes, missingFields, mode: 'full' });
      assert.notEqual(result.verdict, 'failed');
    }
  });
});

// ============================================================================
// Wider B2 acceptance -- items added on plan re-review. One case each.
// ============================================================================

describe('§2 verdict ordering -- failed outranks insufficient_evidence', () => {
  test('a hard rule failure AND coverage below min_coverage at once -> failed, not insufficient_evidence', () => {
    const config = thesisT();
    config.rules.push({
      id: 'R_hard', label: 'Hard must-have: known fraud signal', kind: 'must_have', enforcement: 'hard',
      hard_justification: 'fraud',
      expr: { field: 'what_is_built', op: 'eq', value: 'a real product' },
      weight: 10, enabled: true,
    });
    // R_hard misses (what_is_built is a different string); everything else is
    // unknown, so coverage is far below min_coverage(0.5).
    const attributes = { what_is_built: 'not a real product', _text: 'we build productivity software for remote teams' };
    const missingFields = ['business_model', 'sector', 'geography_region'];
    const result = evaluateThesis({ config, attributes, missingFields, mode: 'full' });
    assert.ok(result.coverage < config.fit.min_coverage, 'fixture must actually be under-covered');
    assert.equal(result.verdict, 'failed'); // step 1, not step 2
  });
});

describe('D-04 -- deal_breaker weight is excluded from both earned and total', () => {
  test('a deal_breaker rule contributes nothing to total/earned regardless of outcome, even with a (mis-configured) non-zero weight', () => {
    // validate_thesis_config() (§5.6, DB layer) rejects a non-zero deal_breaker
    // weight -- this test proves rules.js does not silently rely on that
    // upstream guarantee: it structurally never reads a deal_breaker's weight
    // into total/earned no matter what value the field holds.
    const config = {
      fit: { base: 50, min_coverage: 0.5, strong_threshold: 70, soft_deal_breaker_penalty: 30 },
      rules: [
        { id: 'R_f', kind: 'focus', enforcement: 'soft', weight: 40,
          expr: { field: 'sector', op: 'eq', value: 'fintech' }, enabled: true },
        { id: 'R_db_triggered', kind: 'deal_breaker', enforcement: 'soft', weight: 999,
          expr: { field: 'sector', op: 'eq', value: 'fintech' }, enabled: true }, // triggers (matches)
      ],
    };
    const result = evaluateThesis({ config, attributes: { sector: 'fintech' }, missingFields: [], mode: 'full' });
    assert.equal(result.total, 40); // R_f only; R_db_triggered's 999 never enters
    assert.equal(result.earned, 40);
    const dbRule = result.fired_rules.find((r) => r.id === 'R_db_triggered');
    assert.equal(dbRule.outcome, 'triggered');
    assert.equal(dbRule.weight_applied, 0); // always 0 for deal_breakers, by construction
  });
});

describe('penalty and clamp -- multiple triggered soft deal-breakers', () => {
  test('two independently-triggered soft deal-breakers double the penalty, and a large enough penalty clamps fit at 0 (not negative)', () => {
    const config = {
      fit: { base: 50, min_coverage: 0.5, strong_threshold: 70, soft_deal_breaker_penalty: 30 },
      rules: [
        // total>0 is required for the penalty to apply at all: §3.1's
        // formula is `total > 0 ? clamp(100×earned/total − penalty, ...) :
        // fit.base` -- the ELSE branch (fit.base) does not subtract penalty,
        // by construction (a thesis with no must_have/focus opinion at all
        // is unaffected by a triggered soft deal-breaker; see this file's
        // report to the team lead for whether that edge case is intended).
        { id: 'R_f', kind: 'focus', enforcement: 'soft', weight: 10,
          expr: { field: 'sector', op: 'eq', value: 'fintech' }, enabled: true },
        { id: 'R_db1', kind: 'deal_breaker', enforcement: 'soft', weight: 0,
          expr: { field: '_text', op: 'contains', value: ['casino'] }, enabled: true },
        { id: 'R_db2', kind: 'deal_breaker', enforcement: 'soft', weight: 0,
          expr: { field: '_text', op: 'contains', value: ['betting'] }, enabled: true },
      ],
    };
    // R_f misses (sector is not fintech) -> earned=0, total=10.
    const attributes = { sector: 'consumer', _text: 'a casino and betting platform' };
    const result = evaluateThesis({ config, attributes, missingFields: [], mode: 'full' });
    assert.equal(result.penalty, 60); // 2 × soft_deal_breaker_penalty(30)
    assert.equal(result.total, 10);
    assert.equal(result.earned, 0);
    // 100×0/10 − 60 = −60, clamped to 0 by clamp(0,100,...).
    assert.equal(result.fit, 0);
  });
});

describe('negate -- through evaluateThesis, not just evalExpr in isolation', () => {
  test('a hand-authored focus rule with negate:true (e.g. "NOT already in a red-flag sector") composes normally with the formula', () => {
    const config = {
      fit: { base: 50, min_coverage: 0.5, strong_threshold: 70, soft_deal_breaker_penalty: 30 },
      rules: [
        { id: 'R_not_gambling', kind: 'focus', enforcement: 'soft', weight: 50,
          expr: { field: 'sector', op: 'eq', value: 'gambling', negate: true }, enabled: true },
      ],
    };
    const matches = evaluateThesis({ config, attributes: { sector: 'b2b-software' }, missingFields: [], mode: 'full' });
    assert.equal(matches.earned, 50); // negate flips eq(gambling)=false -> true -> satisfied
    assert.equal(matches.fit, 100);

    const misses = evaluateThesis({ config, attributes: { sector: 'gambling' }, missingFields: [], mode: 'full' });
    assert.equal(misses.earned, 0);
    assert.equal(misses.fit, 0);
  });
});

describe('sentinel values -- business_model:"unknown" reads as unknown, sector:"other" stays a real value', () => {
  test('resolveField: business_model="unknown" is unknown; sector="other" is a known value', () => {
    assert.equal(resolveField('business_model', { business_model: 'unknown' }, []).unknown, true);
    assert.deepEqual(resolveField('sector', { sector: 'other' }, []), { value: 'other', unknown: false });
  });

  test('a sentinel-valued field contributes to total but not earned, and does NOT reduce fit relative to the same case with the field absent entirely', () => {
    const config = thesisT();
    const withSentinel = evaluateThesis({
      config, attributes: { business_model: 'unknown', sector: 'ai-infra', geography_region: 'EU', _text: 'we build productivity software for remote teams' }, missingFields: [], mode: 'full',
    });
    const withAbsent = evaluateThesis({
      config, attributes: { sector: 'ai-infra', geography_region: 'EU', _text: 'we build productivity software for remote teams' }, missingFields: ['business_model'], mode: 'full',
    });
    assert.equal(withSentinel.fit, withAbsent.fit);
    assert.equal(withSentinel.coverage, withAbsent.coverage);
    const sentinelRule = withSentinel.fired_rules.find((r) => r.id === 'R_mh');
    assert.equal(sentinelRule.outcome, 'unknown');
    assert.equal(sentinelRule.weight_applied, 0);
    // contrast: fit WOULD drop if 'unknown' were read as a real value (R_mh
    // would `miss` instead of going `unknown` -- both contribute 0 to earned
    // here, so this specific contrast doesn't show a numeric difference by
    // itself; the outcome-label assertion above is what actually catches a
    // regression back to comparing 'unknown' as a value).
  });

  test('sector="other" against a mandate/focus sector list produces a real no_match (outcome "missed"), never "unknown"', () => {
    const config = {
      fit: { base: 50, min_coverage: 0.5, strong_threshold: 70, soft_deal_breaker_penalty: 30 },
      rules: [{ id: 'R_sector', kind: 'focus', enforcement: 'soft', weight: 30,
        expr: { field: 'sector', op: 'in', value: ['ai-infra', 'devtools'] }, enabled: true }],
    };
    const result = evaluateThesis({ config, attributes: { sector: 'other' }, missingFields: [], mode: 'full' });
    const rule = result.fired_rules.find((r) => r.id === 'R_sector');
    assert.equal(rule.outcome, 'missed'); // NOT 'unknown' -- a real, observed miss
    assert.equal(result.coverage, 1); // 'other' is evaluated, not unknown -- full coverage
  });
});

describe('_text synthesis (§1.1) -- vocabulary.synthesize_text', () => {
  test('gate text present -> _text is the gate text (trimmed)', () => {
    assert.equal(vocabulary.synthesize_text('  developer tools for infra  '), 'developer tools for infra');
  });
  test('NEVER falls back to a claim value (e.g. what_is_built) -- an earlier draft did this and a later, dated correction in db/fixtures/07-thesis-engine.sql reversed it: "_text must resolve from raw_signals.payload.text -- NOT from company.what_is_built or any other claim"', () => {
    // synthesize_text takes exactly one argument on purpose -- there is no
    // second parameter to accidentally fold a claim into.
    assert.equal(vocabulary.synthesize_text.length, 1);
  });
  test('absent, blank, or non-string input -> null (absent, per "present whenever the gate has any text")', () => {
    assert.equal(vocabulary.synthesize_text(null), null);
    assert.equal(vocabulary.synthesize_text(undefined), null);
    assert.equal(vocabulary.synthesize_text('   '), null);
  });
  test('end-to-end: a synthesized _text feeds a contains rule through evaluateThesis exactly like an extractor-supplied one', () => {
    const config = {
      fit: { base: 50, min_coverage: 0.5, strong_threshold: 70, soft_deal_breaker_penalty: 30 },
      rules: [{ id: 'R_negkw', kind: 'deal_breaker', enforcement: 'soft', weight: 0,
        expr: { field: '_text', op: 'contains', value: ['casino'] }, enabled: true }],
    };
    // fixture-D-shaped gate text: the raw_signals.payload.text a fresh gate
    // call (or a re-evaluation's recovered payload) would supply.
    const _text = vocabulary.synthesize_text('GameLoop lets publishers add real-money betting mini-games their casino partners can white-label.');
    const result = evaluateThesis({ config, attributes: { _text }, missingFields: [], mode: 'full' });
    const rule = result.fired_rules.find((r) => r.id === 'R_negkw');
    assert.equal(rule.outcome, 'triggered');
  });
});

describe('region_of -- covers every country in the starting thesis\'s geos list (db/seed.sql)', () => {
  test('["DE","FR","NL","US"] (the seeded default thesis\'s geos array) all resolve to a real region, never null', () => {
    const geos = ['DE', 'FR', 'NL', 'US'];
    const expected = { DE: 'EU', FR: 'EU', NL: 'EU', US: 'US' };
    for (const code of geos) {
      assert.equal(region_of(code), expected[code], `region_of(${code})`);
    }
  });
  test('an unmapped-but-well-formed country never throws -- resolves to "other"', () => {
    assert.doesNotThrow(() => region_of('ZZ'));
    assert.equal(region_of('ZZ'), 'other');
  });
});

// ============================================================================
// clamp -- the one small arithmetic helper worth a direct test (fit's
// clamp(0,100,...) is exercised indirectly above via case 3's over-100
// pre-clamp fit; this isolates the helper itself).
// ============================================================================

describe('clamp', () => {
  test('clamps below min and above max, passes through in range', () => {
    assert.equal(clamp(0, 100, -5), 0);
    assert.equal(clamp(0, 100, 105), 100);
    assert.equal(clamp(0, 100, 42), 42);
  });
});
