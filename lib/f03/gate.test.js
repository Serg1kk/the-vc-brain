// lib/f03/gate.test.js
//
// Acceptance tests for lib/f03/gate.js, per docs/backlog/03-founder-score/plan.md task B2.
// Run with: node --test lib/f03/
//
// One describe block per design.md §4.4 step (1-8), plus the plan's specifically-named
// cases. Fixtures are small and in-line -- no database, per task instructions.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { applyGate } = require('./gate');

// ----------------------------------------------------------------------------
// Fixture helpers
// ----------------------------------------------------------------------------

function makeEvidence(opts) {
  opts = opts || {};
  return {
    tier: opts.tier || 'documented',
    quote_verbatim: opts.quote_verbatim !== undefined ? opts.quote_verbatim : null,
    source_url: opts.source_url !== undefined ? opts.source_url : null,
    // Deliberately defaults to "not reachable" (raw_signal_id null) so every test is explicit
    // about whether it is exercising the primary source-resolution path or the fallback.
    raw_signal_id: opts.raw_signal_id !== undefined ? opts.raw_signal_id : null,
    source: opts.source !== undefined ? opts.source : null
  };
}

function makeClaim(claimId, opts) {
  opts = opts || {};
  return {
    claim_id: claimId,
    text_verbatim: opts.text_verbatim || ('verbatim text for ' + claimId),
    topic: opts.topic || 'founder.execution.generic',
    source_kind: opts.source_kind || 'public',
    evidence: opts.evidence || []
  };
}

function makePack(claims) {
  return { claim_ids: claims.map(function (c) { return c.claim_id; }), claims: claims };
}

function criterion(id, subscorer, weight, negSrc) {
  return { subscorer: subscorer, weight: weight, neg_src: negSrc };
}

const CREDIT = { met_documented: 1.0, met_discovered: 0.8, self_asserted: 0.3, not_met: 0.0 };

function byId(components) {
  const out = {};
  components.forEach(function (c) { out[c.criterion_id] = c; });
  return out;
}

// ============================================================================
// Step 1 -- normalize (+ plan's "uppercase MET -> accepted and lowercased")
// ============================================================================

describe('step 1: normalize', () => {
  test('uppercase MET is accepted and lowercased end to end', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', {
      text_verbatim: 'I merged a pull request into someone else\'s repo last month',
      evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api', quote_verbatim: 'merged a pull request' })]
    });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': {
        criteria: [{ criterion_id: 'E1', verdict: 'MET', claim_ids: ['c1'], quote_verbatim: 'merged a pull request', rationale: 'clear PR evidence' }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result.length, 1);
    assert.equal(result[0].verdict, 'met');
    assert.equal(result[0].evidence_tier, 'documented');
    assert.equal(result[0].credit, 1.0);
    assert.equal(result[0].weight, 0.1);
    assert.equal(result[0].quote_verbatim, 'merged a pull request');
  });
});

// ============================================================================
// Step 2 -- enum
// ============================================================================

describe('step 2: enum', () => {
  test('a verdict outside the four values is coerced to cannot_assess', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'maybe', claim_ids: ['c1'] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'cannot_assess');
    assert.equal(result[0].credit, null);
    assert.equal(result[0].evidence_tier, null);
    assert.ok(result[0].what_would_close_it);
  });
});

// ============================================================================
// Step 3 -- registry
// ============================================================================

describe('step 3: registry', () => {
  test('an unknown or misrouted criterion_id is dropped, not inserted', () => {
    const config = {
      credit: CREDIT,
      criteria: {
        E1: criterion('E1', 'execution-signals', 0.1, 'github_api'),
        X1: criterion('X1', 'expertise-signals', 0.09, 'deck_parse')
      },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]), 'expertise-signals': makePack([]) };
    const rawAgentOutputs = {
      'execution-signals': {
        criteria: [
          { criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] },
          { criterion_id: 'X1', verdict: 'met', claim_ids: ['c1'] }, // belongs to expertise-signals -- misrouted
          { criterion_id: 'Z9', verdict: 'met', claim_ids: ['c1'] }  // not in the registry at all
        ]
      },
      'expertise-signals': { criteria: [] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    // Exactly the two registered criteria come back -- no Z9, and X1 comes back as
    // cannot_assess (absent from *its own* subscorer's response), not as whatever
    // execution-signals tried to claim about it.
    assert.equal(result.length, 2);
    const map = byId(result);
    assert.equal(map.E1.verdict, 'met');
    assert.equal(map.X1.verdict, 'cannot_assess');
    assert.ok(!('Z9' in map));
  });

  test('a registry criterion absent from the response is inserted as cannot_assess', () => {
    const config = {
      credit: CREDIT,
      criteria: {
        E1: criterion('E1', 'execution-signals', 0.1, 'github_api'),
        E7: criterion('E7', 'execution-signals', 0.06, 'github_api')
      },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    const map = byId(result);
    assert.equal(map.E7.verdict, 'cannot_assess');
    assert.equal(map.E7.weight, 0.06);
    assert.deepEqual(map.E7.claim_ids, []);
    assert.match(map.E7.what_would_close_it, /not addressed/);
  });
});

// ============================================================================
// Step 4 -- citation
// ============================================================================

describe('step 4: citation', () => {
  test('met with empty claim_ids is coerced to cannot_assess (vantage guard)', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const contextPacks = { 'execution-signals': makePack([]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: [] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'cannot_assess');
  });

  test('one hallucinated claim_id alongside two valid ones: verdict survives, bad id dropped', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const c2 = makeClaim('c2', { evidence: [makeEvidence({ tier: 'discovered', raw_signal_id: 'rs2', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1, c2]) };
    const rawAgentOutputs = {
      'execution-signals': {
        criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1', 'fake-nonexistent-id', 'c2'] }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'met');
    assert.deepEqual(result[0].claim_ids, ['c1', 'c2']);
  });
});

// ============================================================================
// Step 5 -- negative capability
// ============================================================================

describe('step 5: negative capability', () => {
  test('not_met with no neg_src-matching claim in the pack is coerced to cannot_assess', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    // Only tavily_extract-sourced evidence exists -- no github_api anywhere in the pack.
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'discovered', raw_signal_id: 'rs1', source: 'tavily_extract' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'not_met', claim_ids: [] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'cannot_assess');
    assert.equal(result[0].credit, null);
    assert.equal(result[0].evidence_tier, null);
  });

  test('not_met reaching its source ONLY via the source_kind fallback is permitted', () => {
    const config = {
      credit: CREDIT,
      criteria: { X1: criterion('X1', 'expertise-signals', 0.09, 'deck_parse') },
      red_flags: {}
    };
    // evidence.raw_signal_id is null (not reachable) -- must fall back to claims.source_kind.
    const c1 = makeClaim('c1', {
      source_kind: 'self_reported',
      evidence: [makeEvidence({ tier: 'discovered', raw_signal_id: null, source: null })]
    });
    const contextPacks = { 'expertise-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'expertise-signals': { criteria: [{ criterion_id: 'X1', verdict: 'not_met', claim_ids: [] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'not_met');
    assert.equal(result[0].evidence_tier, 'discovered');
    assert.equal(result[0].credit, 0.0);
    assert.ok(result[0].claim_ids.includes('c1'));
  });

  test('the public source_kind fallback is a wildcard matching any neg_src', () => {
    const config = {
      credit: CREDIT,
      criteria: { L5: criterion('L5', 'leadership-sales-proxies', 0.06, 'hn_algolia') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', {
      source_kind: 'public',
      evidence: [makeEvidence({ tier: 'documented', raw_signal_id: null, source: null })]
    });
    const contextPacks = { 'leadership-sales-proxies': makePack([c1]) };
    const rawAgentOutputs = {
      'leadership-sales-proxies': { criteria: [{ criterion_id: 'L5', verdict: 'not_met', claim_ids: [] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'not_met');
    assert.equal(result[0].evidence_tier, 'documented');
  });

  test('primary path (evidence.raw_signal_id -> raw_signals.source) is used when reachable, no fallback needed', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', {
      source_kind: 'derived', // fallback for 'derived' is deck_parse, which would NOT match
      evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })]
    });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'not_met', claim_ids: [] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'not_met');
    assert.equal(result[0].evidence_tier, 'documented');
  });
});

// ============================================================================
// Step 6 (+ ordering guard) -- red-flag demotion, re-checked by step 5
// ============================================================================

describe('step 6: red-flag demotion, re-checked by step 5', () => {
  test('demotion to not_met with a genuine neg_src match in the pack survives', () => {
    const config = {
      credit: CREDIT,
      criteria: {
        E1: criterion('E1', 'execution-signals', 0.1, 'github_api'),
        E7: criterion('E7', 'execution-signals', 0.06, 'github_api')
      },
      red_flags: { R1: { contradicts: ['E1', 'E7'], demote_to: 'not_met' } }
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = {
      'execution-signals': makePack([c1]),
      'red-flags': makePack([c1])
    };
    const rawAgentOutputs = {
      'execution-signals': {
        criteria: [
          { criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] },
          { criterion_id: 'E7', verdict: 'met', claim_ids: ['c1'] }
        ]
      },
      'red-flags': {
        red_flags: [{ id: 'R1', severity: 3, claim_ids: ['c1'], quote_verbatim: null, rationale: 'backdated commits' }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    const map = byId(result);
    assert.equal(map.E1.verdict, 'not_met');
    assert.equal(map.E1.demoted_by, 'R1');
    assert.equal(map.E1.evidence_tier, 'documented');
    assert.equal(map.E1.credit, 0.0);
    assert.equal(map.E7.verdict, 'not_met');
    assert.equal(map.E7.demoted_by, 'R1');
  });

  test('ORDERING GUARD: demotion to not_met with no neg_src match in the pack is reverted to cannot_assess', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: { R1: { contradicts: ['E1'], demote_to: 'not_met' } }
    };
    // c1 exists and is cited as support for the original `met`, but nothing in the pack is
    // sourced from github_api -- the demotion must not be able to manufacture a not_met that
    // step 5 would otherwise refuse to a directly-emitted verdict.
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'tavily_extract' })] });
    const contextPacks = {
      'execution-signals': makePack([c1]),
      'red-flags': makePack([c1])
    };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] },
      'red-flags': { red_flags: [{ id: 'R1', severity: 2, claim_ids: ['c1'], rationale: 'suspicious pattern' }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'cannot_assess');
    assert.equal(result[0].credit, null);
    assert.equal(result[0].evidence_tier, null);
    assert.ok(result[0].what_would_close_it);
    // Demotion is still recorded as having fired, even though the guard overrode its effect.
    assert.equal(result[0].demoted_by, 'R1');
  });

  test('demotion to self_asserted (R4) reassigns tier/credit via step 6a', () => {
    const config = {
      credit: CREDIT,
      criteria: { X2: criterion('X2', 'expertise-signals', 0.075, ['deck_parse', 'interview_answer', 'tavily_extract']) },
      red_flags: { R4: { contradicts: ['X2'], demote_to: 'self_asserted' } }
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'tavily_extract' })] });
    const contextPacks = {
      'expertise-signals': makePack([c1]),
      'red-flags': makePack([c1])
    };
    const rawAgentOutputs = {
      'expertise-signals': { criteria: [{ criterion_id: 'X2', verdict: 'met', claim_ids: ['c1'] }] },
      'red-flags': { red_flags: [{ id: 'R4', severity: 2, claim_ids: ['c1'], rationale: 'AI-washing suspected' }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'self_asserted');
    assert.equal(result[0].demoted_by, 'R4');
    assert.equal(result[0].evidence_tier, 'missing');
    assert.equal(result[0].credit, 0.3);
  });
});

// ============================================================================
// Step 6a -- backend-assigned evidence_tier
// ============================================================================

describe('step 6a: evidence_tier assignment', () => {
  test('met whose best evidence tier is inferred is coerced to self_asserted', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'inferred', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'self_asserted');
    assert.equal(result[0].evidence_tier, 'missing');
    assert.equal(result[0].credit, 0.3);
  });

  test('met citing a claim with zero evidence rows is coerced to self_asserted (no tier at all)', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'self_asserted');
    assert.equal(result[0].evidence_tier, 'missing');
  });

  test('met with discovered-tier evidence keeps met at the discovered credit', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'discovered', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'met');
    assert.equal(result[0].evidence_tier, 'discovered');
    assert.equal(result[0].credit, 0.8);
  });
});

// ============================================================================
// Step 7 -- verbatim integrity
// ============================================================================

describe('step 7: verbatim integrity', () => {
  test('a quote_verbatim not a substring of the cited claim is nulled; rationale is kept', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', {
      text_verbatim: 'Shipped v1 of the product in March',
      evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api', quote_verbatim: 'v1 shipped' })]
    });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': {
        criteria: [{
          criterion_id: 'E1',
          verdict: 'met',
          claim_ids: ['c1'],
          quote_verbatim: 'this exact phrase never appears in the pack',
          rationale: 'founder shipped an early version'
        }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'met');
    assert.equal(result[0].quote_verbatim, null);
    assert.equal(result[0].rationale, 'founder shipped an early version');
  });

  test('a quote_verbatim matching an evidence.quote_verbatim (not text_verbatim) survives', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', {
      text_verbatim: 'summary claim about the repo',
      evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api', quote_verbatim: 'merged 14 pull requests in Q1' })]
    });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': {
        criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'], quote_verbatim: 'merged 14 pull requests', rationale: 'ok' }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].quote_verbatim, 'merged 14 pull requests');
  });
});

// ============================================================================
// Step 8 -- partial failure
// ============================================================================

describe('step 8: partial failure', () => {
  test('a sub-scorer returning an error object: its criteria become cannot_assess, others still aggregate', () => {
    const config = {
      credit: CREDIT,
      criteria: {
        E1: criterion('E1', 'execution-signals', 0.1, 'github_api'),
        X1: criterion('X1', 'expertise-signals', 0.09, 'deck_parse')
      },
      red_flags: {}
    };
    const c2 = makeClaim('c2', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs2', source: 'deck_parse' })] });
    const contextPacks = {
      'execution-signals': makePack([]),
      'expertise-signals': makePack([c2])
    };
    const rawAgentOutputs = {
      'execution-signals': { error: 'timeout after 30s' },
      'expertise-signals': { criteria: [{ criterion_id: 'X1', verdict: 'met', claim_ids: ['c2'] }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    const map = byId(result);
    assert.equal(map.E1.verdict, 'cannot_assess');
    assert.equal(map.E1.what_would_close_it, 'sub-scorer execution-signals failed; rerun');
    assert.equal(map.X1.verdict, 'met');
    assert.equal(map.X1.credit, 1.0);
  });

  test('a sub-scorer entirely missing from rawAgentOutputs is treated the same as a failure', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const contextPacks = { 'execution-signals': makePack([]) };
    const rawAgentOutputs = {}; // execution-signals never ran / was never recorded

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'cannot_assess');
    assert.match(result[0].what_would_close_it, /failed; rerun/);
  });
});

// ============================================================================
// Contract absorption -- A2 agent specs + live db/seed.sql `formula_v1` shape landed after
// this file was first written. Coordinator ruling: gate.js accepts both the new (primary)
// and legacy shapes, so nothing else regresses.
// ============================================================================

describe('contract absorption: config.criteria / config.red_flags as arrays (live formula_v1 shape)', () => {
  test('array-form config.criteria produces the same components as the object form', () => {
    const objectFormConfig = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const arrayFormConfig = {
      credit: CREDIT,
      criteria: [
        { id: 'E1', subscorer: 'execution-signals', raw: 5, weight: 0.1, neg_src: ['github_api'], anchor: 'merged a PR into a repo they do not own' }
      ],
      red_flags: []
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] }
    };

    const objectResult = applyGate(rawAgentOutputs, contextPacks, objectFormConfig);
    const arrayResult = applyGate(rawAgentOutputs, contextPacks, arrayFormConfig);
    assert.deepEqual(arrayResult, objectResult);
    assert.equal(arrayResult[0].verdict, 'met');
    assert.equal(arrayResult[0].weight, 0.1);
  });

  test('array-form config.red_flags still demotes', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: [{ id: 'R1', contradicts: ['E1'], demote_to: 'not_met' }]
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = {
      'execution-signals': makePack([c1]),
      'red-flags': makePack([c1])
    };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'] }] },
      'red-flags': { red_flags: [{ id: 'R1', severity: 3, claim_ids: ['c1'], rationale: 'backdated commits' }] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'not_met');
    assert.equal(result[0].demoted_by, 'R1');
  });
});

describe('contract absorption: A2 agent-output shape (verdicts / flags / flag_id)', () => {
  test('an A2-shaped positive-agent payload (subscorer + verdicts[]) parses identically to the legacy shape', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', {
      text_verbatim: 'Merged a pull request into a repository they do not own',
      evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api', quote_verbatim: 'Merged a pull request' })]
    });
    const contextPacks = { 'execution-signals': makePack([c1]) };

    const legacyOutputs = {
      'execution-signals': {
        criteria: [{ criterion_id: 'E1', verdict: 'met', claim_ids: ['c1'], quote_verbatim: 'Merged a pull request', rationale: 'clear PR evidence' }]
      }
    };
    const a2Outputs = {
      'execution-signals': {
        subscorer: 'execution-signals',
        verdicts: [{
          criterion_id: 'E1',
          reasoning: 'The founder has a merged PR into a third-party repo, which is strong signal.',
          verdict: 'met',
          claim_ids: ['c1'],
          quote_verbatim: 'Merged a pull request',
          rationale: 'clear PR evidence',
          what_would_close_it: null
        }]
      }
    };

    const legacyResult = applyGate(legacyOutputs, contextPacks, config);
    const a2Result = applyGate(a2Outputs, contextPacks, config);
    assert.deepEqual(a2Result, legacyResult);
    assert.equal(a2Result[0].verdict, 'met');
    assert.equal(a2Result[0].rationale, 'clear PR evidence');
  });

  test('`reasoning` is never used as a substitute for `rationale` when both are present', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'github_api' })] });
    const contextPacks = { 'execution-signals': makePack([c1]) };
    const rawAgentOutputs = {
      'execution-signals': {
        subscorer: 'execution-signals',
        verdicts: [{
          criterion_id: 'E1',
          reasoning: 'pre-verdict chain of thought, should never end up in rationale',
          verdict: 'met',
          claim_ids: ['c1'],
          rationale: 'the actual stored interpretation'
        }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].rationale, 'the actual stored interpretation');
  });

  test('a model-supplied what_would_close_it is preserved for a directly-emitted cannot_assess', () => {
    const config = {
      credit: CREDIT,
      criteria: { X1: criterion('X1', 'expertise-signals', 0.09, 'deck_parse') },
      red_flags: {}
    };
    const contextPacks = { 'expertise-signals': makePack([]) };
    const rawAgentOutputs = {
      'expertise-signals': {
        subscorer: 'expertise-signals',
        verdicts: [{
          criterion_id: 'X1',
          reasoning: 'no tenure claims found anywhere in the pack',
          verdict: 'cannot_assess',
          claim_ids: [],
          what_would_close_it: 'a LinkedIn profile or resume with dated employment history'
        }]
      }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].verdict, 'cannot_assess');
    assert.equal(result[0].what_would_close_it, 'a LinkedIn profile or resume with dated employment history');
  });

  test('an A2-shaped red-flags payload (subscorer + flags[] + flag_id) demotes identically to the legacy shape', () => {
    const config = {
      credit: CREDIT,
      criteria: { E4: criterion('E4', 'execution-signals', 0.1, ['tavily_extract', 'github_api']) },
      red_flags: { R4: { contradicts: ['E4'], demote_to: 'self_asserted' } }
    };
    const c1 = makeClaim('c1', { evidence: [makeEvidence({ tier: 'documented', raw_signal_id: 'rs1', source: 'tavily_extract' })] });
    const contextPacks = {
      'execution-signals': makePack([c1]),
      'red-flags': makePack([c1])
    };
    const baseExecutionOutputs = {
      'execution-signals': { criteria: [{ criterion_id: 'E4', verdict: 'met', claim_ids: ['c1'] }] }
    };

    const legacyOutputs = Object.assign({}, baseExecutionOutputs, {
      'red-flags': { red_flags: [{ id: 'R4', severity: 2, claim_ids: ['c1'], rationale: 'no live URL observed' }] }
    });
    const a2Outputs = Object.assign({}, baseExecutionOutputs, {
      'red-flags': {
        subscorer: 'red-flags',
        flags: [{
          flag_id: 'R4',
          reasoning: 'claimed a live product but no working URL could be found',
          severity: 2,
          claim_ids: ['c1'],
          quote_verbatim: null,
          contradiction: 'E4 claims a live production URL; none was reachable'
        }]
      }
    });

    const legacyResult = applyGate(legacyOutputs, contextPacks, config);
    const a2Result = applyGate(a2Outputs, contextPacks, config);
    assert.deepEqual(a2Result, legacyResult);
    assert.equal(a2Result[0].verdict, 'self_asserted');
    assert.equal(a2Result[0].demoted_by, 'R4');
  });
});

// ============================================================================
// General invariants
// ============================================================================

describe('general invariants', () => {
  test('every registered criterion produces exactly one component row, weight always populated', () => {
    const config = {
      credit: CREDIT,
      criteria: {
        E1: criterion('E1', 'execution-signals', 0.1, 'github_api'),
        E7: criterion('E7', 'execution-signals', 0.06, 'github_api'),
        X1: criterion('X1', 'expertise-signals', 0.09375, 'deck_parse')
      },
      red_flags: {}
    };
    const contextPacks = { 'execution-signals': makePack([]), 'expertise-signals': makePack([]) };
    const rawAgentOutputs = {
      'execution-signals': { criteria: [] },
      'expertise-signals': { criteria: [] }
    };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result.length, 3);
    result.forEach((c) => {
      assert.equal(typeof c.weight, 'number');
      assert.ok(Array.isArray(c.claim_ids));
    });
  });

  test('cannot_assess rows always carry credit=null and evidence_tier=null', () => {
    const config = {
      credit: CREDIT,
      criteria: { E1: criterion('E1', 'execution-signals', 0.1, 'github_api') },
      red_flags: {}
    };
    const contextPacks = { 'execution-signals': makePack([]) };
    const rawAgentOutputs = { 'execution-signals': { criteria: [{ criterion_id: 'E1', verdict: 'cannot_assess', claim_ids: [] }] } };

    const result = applyGate(rawAgentOutputs, contextPacks, config);
    assert.equal(result[0].credit, null);
    assert.equal(result[0].evidence_tier, null);
    assert.ok(result[0].what_would_close_it);
  });
});
