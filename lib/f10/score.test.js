// lib/f10/score.test.js
//
// Tests for lib/f10/score.js (feature 10, NL-search executor -- Stage 3,
// pure scoring). Run with:
//   node --test lib/f10/*.test.js
// (glob form -- `node --test lib/f10/` fails with MODULE_NOT_FOUND on Node
// v22.19.0, a known quirk, not a path problem).
//
// Every case named in design.md §9's scorer row exists here as a NAMED
// test, plus two spec-delta ordering additions that arrived after this file
// was first dispatched:
//   rev.5 -- bucket_ordinal must outrank rank_score (coordinator message,
//            "reaching you deliberately before score.js exists").
//   rev.6 -- has_match must lead the sort, found by running Q2 live against
//            the deployed workflow (coordinator message, after rev.5 had
//            already shipped and been approved).
//
// docs/backlog/10-api-cli-skill/plan.md, task B1.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyRow,
  resolvePositiveAttributeForCandidate,
  resolveNegativeAttributeForCandidate,
  gatherCandidateIds,
  hasMatch,
  computeCoverageBucket,
  scoreCandidateAttributes,
  compareByBucket,
  compareByRankOnly,
  score,
} = require('./score');
const { validatePlan } = require('./plan');
const { WEIGHTS, CONFIDENCE_FLOOR, CANDIDATE_CAP } = require('./constants');

// ============================================================================
// Fixture builders. `attr()` builds a COMPILED attribute (the shape
// lib/f10/plan.js's validatePlan() produces) -- score.js's own input
// contract, per the task brief's "(plan, fetchedRows) -> {...}" signature.
// `row()` matches api_claims's documented shape (design §4.3): claim +
// folded evidence[].
// ============================================================================

function attr(overrides) {
  return {
    id: 'a1', label: 'Attr', kind: 'provenance', polarity: 'positive',
    target: { type: 'claim_topic', value: 'founder.expertise.*' },
    op: 'exists', value: null, broadening: null, resolved_as: null,
    weight: WEIGHTS.provenance,
    ...overrides,
  };
}

function row(overrides) {
  return {
    claim_id: 'c1', founder_id: 'f1', topic: 'founder.expertise.vertical_tenure',
    value: null, verification_status: 'unverified', created_at: '2026-07-01T00:00:00Z',
    evidence: [],
    ...overrides,
  };
}

function evid(overrides) {
  return { tier: 'documented', relation: 'supports', quote_verbatim: null, source_url: null, ...overrides };
}

function founder(overrides) {
  return { founder_id: 'f1', full_name: 'Founder', founder_score: null, ...overrides };
}

function compiledPlan(attributes, unresolvable) {
  return { attributes: attributes || [], unresolvable: unresolvable || [] };
}

// ============================================================================
// classifyRow -- §4.3 / §5.5's per-claim evidence classification. This is
// where the rev.4 F4 fix lives (contradicting evidence must never raise a
// match).
// ============================================================================

describe('classifyRow', () => {
  test('a claim with only supports evidence classifies match, tier = the evidence tier', () => {
    const r = row({ evidence: [evid({ tier: 'discovered', relation: 'supports' })] });
    assert.deepEqual(classifyRow(r).kind, 'match');
    assert.equal(classifyRow(r).tier, 'discovered');
  });

  test('relation=context NEVER sets credit -- a context-only claim is inconclusive, not a match', () => {
    const r = row({ evidence: [evid({ tier: 'documented', relation: 'context' })] });
    assert.equal(classifyRow(r).kind, 'inconclusive');
  });

  test('§9 "contradicts forces mismatch" -- relation=contradicts resolves mismatch even at documented tier', () => {
    const r = row({ evidence: [evid({ tier: 'documented', relation: 'contradicts' })] });
    assert.equal(classifyRow(r).kind, 'mismatch');
  });

  test('a documented CONTRADICTS entry beats a co-existing supports entry on the same claim (rev.4 F4 -- the live defect)', () => {
    const r = row({
      evidence: [
        evid({ tier: 'inferred', relation: 'supports' }),
        evid({ tier: 'documented', relation: 'contradicts' }),
      ],
    });
    // Pre-fix behaviour would have taken max(tier) across ALL relations and
    // returned 'match' at tier 'documented' -- refuting evidence raising the
    // score. This must never happen.
    assert.equal(classifyRow(r).kind, 'mismatch');
  });

  test('verification_status=contradicted forces mismatch even with no contradicts evidence row', () => {
    const r = row({ verification_status: 'contradicted', evidence: [evid({ tier: 'documented', relation: 'supports' })] });
    assert.equal(classifyRow(r).kind, 'mismatch');
  });

  test('§9 "missing tier never a match" -- a supports-relation evidence row whose OWN tier is missing is not creditable', () => {
    const r = row({ evidence: [evid({ tier: 'missing', relation: 'supports' })] });
    assert.equal(classifyRow(r).kind, 'unknown_searched');
  });

  test('verification_status=missing is unknown_searched regardless of attached evidence', () => {
    const r = row({ verification_status: 'missing', evidence: [] });
    assert.equal(classifyRow(r).kind, 'unknown_searched');
  });

  test('best-of-multiple-supports picks the highest tier_credit', () => {
    const r = row({
      evidence: [
        evid({ tier: 'inferred', relation: 'supports' }),
        evid({ tier: 'documented', relation: 'supports' }),
        evid({ tier: 'discovered', relation: 'supports' }),
      ],
    });
    assert.equal(classifyRow(r).tier, 'documented');
  });
});

// ============================================================================
// resolvePositiveAttributeForCandidate -- §5.5 three-state matching, one
// candidate at a time.
// ============================================================================

describe('resolvePositiveAttributeForCandidate', () => {
  test('no rows at all -> unknown ("we never looked")', () => {
    const result = resolvePositiveAttributeForCandidate(attr(), []);
    assert.equal(result.state, 'unknown');
  });

  test('op=exists: any row with supports evidence in the family -> matched', () => {
    const rows = [row({ topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'discovered' })] })];
    const result = resolvePositiveAttributeForCandidate(attr({ op: 'exists' }), rows);
    assert.equal(result.state, 'matched');
    assert.equal(result.tier, 'discovered');
  });

  test('op=exists with `broadening` set on the attribute -> matched_broadened, not matched', () => {
    const rows = [row({ evidence: [evid({ tier: 'documented' })] })];
    const a = attr({ broadening: 'city→country', resolved_as: 'company.geography_country = DE' });
    const result = resolvePositiveAttributeForCandidate(a, rows);
    assert.equal(result.state, 'matched_broadened');
  });

  test('op=eq: a claim whose value equals the target -> matched', () => {
    const a = attr({
      kind: 'structural', op: 'eq', value: 'DE',
      target: { type: 'claim_topic', value: 'company.geography_country' },
      weight: WEIGHTS.structural,
    });
    const rows = [row({ topic: 'company.geography_country', value: 'DE', evidence: [evid({ tier: 'discovered' })] })];
    const result = resolvePositiveAttributeForCandidate(a, rows);
    assert.equal(result.state, 'matched');
  });

  test('op=eq: a genuinely different, evidenced value is a mismatch, not unknown', () => {
    const a = attr({
      kind: 'structural', op: 'eq', value: 'DE',
      target: { type: 'claim_topic', value: 'company.geography_country' },
      weight: WEIGHTS.structural,
    });
    const rows = [row({ topic: 'company.geography_country', value: 'NL', evidence: [evid({ tier: 'discovered' })] })];
    const result = resolvePositiveAttributeForCandidate(a, rows);
    assert.equal(result.state, 'mismatch');
  });

  test('op=eq: a different value backed ONLY by context/inconclusive evidence is too weak a signal to force mismatch -> unknown', () => {
    const a = attr({
      kind: 'structural', op: 'eq', value: 'DE',
      target: { type: 'claim_topic', value: 'company.geography_country' },
      weight: WEIGHTS.structural,
    });
    const rows = [row({ topic: 'company.geography_country', value: 'NL', evidence: [evid({ tier: 'documented', relation: 'context' })] })];
    const result = resolvePositiveAttributeForCandidate(a, rows);
    assert.equal(result.state, 'unknown');
  });

  test('a `missing`-tier / verification_status=missing row on the topic -> unknown_searched, distinct from unknown', () => {
    const rows = [row({ verification_status: 'missing', evidence: [] })];
    const result = resolvePositiveAttributeForCandidate(attr(), rows);
    assert.equal(result.state, 'unknown_searched');
  });

  test('a family fetch with several distinct sub-topics -- the best MATCHING topic wins over an inconclusive one', () => {
    const rows = [
      row({ topic: 'founder.expertise.unasked_work', evidence: [evid({ tier: 'documented', relation: 'context' })] }), // inconclusive
      row({ topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'inferred', relation: 'supports' })] }), // match
    ];
    const result = resolvePositiveAttributeForCandidate(attr(), rows);
    assert.equal(result.state, 'matched');
    assert.equal(result.tier, 'inferred');
  });

  test('"latest claim per topic" (§4.3): a superseding row on the SAME topic wins over an older one', () => {
    const rows = [
      row({ topic: 'founder.expertise.vertical_tenure', created_at: '2026-01-01T00:00:00Z', evidence: [evid({ tier: 'documented', relation: 'contradicts' })] }),
      row({ claim_id: 'c2', topic: 'founder.expertise.vertical_tenure', created_at: '2026-06-01T00:00:00Z', evidence: [evid({ tier: 'documented', relation: 'supports' })] }),
    ];
    const result = resolvePositiveAttributeForCandidate(attr(), rows);
    assert.equal(result.state, 'matched'); // the newer, supporting claim wins, not the older contradicted one
  });
});

// ============================================================================
// resolveNegativeAttributeForCandidate -- §5.4 rule 3's per-candidate form.
// ============================================================================

describe('resolveNegativeAttributeForCandidate', () => {
  test('§9 "negatives... sparse-but-nonempty topic yields unknown for candidates with no evidence in that family"', () => {
    assert.equal(resolveNegativeAttributeForCandidate([]).state, 'unknown');
  });

  test('any evidence in the family -> matched, tier_credit fixed at 1.0 (no claim to read a tier from)', () => {
    const result = resolveNegativeAttributeForCandidate([row({ claim_id: 'c9' })]);
    assert.equal(result.state, 'matched');
    assert.deepEqual(result.claimIds, ['c9']);
  });
});

// ============================================================================
// §9: "negative never reaches FTS" -- score.js side. plan.js already
// rejects an fts target outright (plan.test.js); this asserts the SAME
// property one layer up, through a full validatePlan() -> score() round
// trip: a negative attribute can never even become a compiled attribute
// with an fts descriptor for score.js to run.
// ============================================================================

describe('§9 -- negative never reaches FTS (full round trip)', () => {
  test('a plan with a negative fts attribute never compiles -- score.js never sees an fts descriptor', () => {
    const raw = {
      attributes: [{
        id: 'no_backing', label: 'no prior VC backing', kind: 'structural', polarity: 'negative',
        target: { type: 'fts', value: 'venture backing' }, op: 'not_exists',
      }],
      unresolvable: [],
    };
    const validated = validatePlan(raw, undefined);
    assert.equal(validated.ok, false);
    assert.equal(validated.error.kind, 'invalid_target');
  });
});

// ============================================================================
// §9: "six-attribute query returns rows (not zero)" -- the no-boolean-AND
// candidate-gathering claim, exercised at full scale.
// ============================================================================

describe('§9 -- six-attribute query returns rows', () => {
  test('a six-attribute compound plan returns a non-empty result over a realistic corpus slice', () => {
    const attributes = [
      attr({ id: 'technical', target: { type: 'claim_topic', value: 'founder.expertise.*' } }),
      attr({ id: 'ships_prod', target: { type: 'claim_topic', value: 'founder.execution.live_product' } }),
      attr({ id: 'external_usage', target: { type: 'claim_topic', value: 'founder.execution.external_usage' } }),
      attr({ id: 'merged_pr', target: { type: 'claim_topic', value: 'founder.execution.merged_pr_foreign' } }),
      attr({
        id: 'geo_de', kind: 'structural', op: 'eq', value: 'DE', weight: WEIGHTS.structural,
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
      attr({
        id: 'no_backing', kind: 'structural', polarity: 'negative', op: 'not_exists', weight: WEIGHTS.structural,
        target: { type: 'claim_topic', value: 'company.funding_history' },
      }),
    ];

    const fetchedRows = {
      technical: [row({ founder_id: 'f1', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] })],
      ships_prod: [row({ founder_id: 'f1', topic: 'founder.execution.live_product', evidence: [evid({ tier: 'discovered' })] })],
      external_usage: [],
      merged_pr: [row({ founder_id: 'f2', topic: 'founder.execution.merged_pr_foreign', evidence: [evid({ tier: 'inferred' })] })],
      geo_de: [row({ founder_id: 'f1', topic: 'company.geography_country', value: 'DE', evidence: [evid({ tier: 'discovered' })] })],
      no_backing: [],
      founders: [founder({ founder_id: 'f1' }), founder({ founder_id: 'f2' })],
    };

    const result = score(compiledPlan(attributes), fetchedRows);
    assert.ok(result.items.length + result.low_confidence.length > 0, 'expected at least one scored candidate');
    assert.equal(result.total, 2); // union of f1 (technical/ships_prod/geo_de) and f2 (merged_pr)
  });
});

// ============================================================================
// §9: the explicit unknown-vs-mismatch regression (the exact numbers named
// in the task brief: 100 vs ~38.5, documented tier).
// ============================================================================

describe('§9 -- unknown vs mismatch regression (one match + two unknown outranks one match + two mismatch)', () => {
  const attributes = [
    attr({ id: 'p1', kind: 'provenance', weight: WEIGHTS.provenance, target: { type: 'claim_topic', value: 'founder.expertise.*' } }),
    attr({
      id: 's1', kind: 'structural', op: 'eq', value: 'DE', weight: WEIGHTS.structural,
      target: { type: 'claim_topic', value: 'company.geography_country' },
    }),
    attr({
      id: 's2', kind: 'structural', op: 'eq', value: 'ai-infra', weight: WEIGHTS.structural,
      target: { type: 'claim_topic', value: 'company.sector' },
    }),
  ];

  test('case A: one match + two unknown -> rank_score 100 exactly', () => {
    const fetchedRows = {
      p1: [row({ founder_id: 'f1', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] })],
      s1: [], // unknown -- no row at all for this founder
      s2: [], // unknown
      founders: [founder({ founder_id: 'f1' })],
    };
    const result = score(compiledPlan(attributes), fetchedRows);
    const item = result.items.find((it) => it.founder_id === 'f1');
    assert.equal(item.rank_score, 100);
    // assessed=25 of total weight 65 (25+20+20), rounded to 2dp like every
    // other numeric field this module emits (round2, house convention).
    assert.equal(item.confidence, Number((25 / 65).toFixed(2)));
  });

  test('case B: one match + two mismatch -> rank_score ≈ 38.5 (25/65 × 100), strictly less than case A', () => {
    const fetchedRows = {
      p1: [row({ founder_id: 'f1', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] })],
      s1: [row({ founder_id: 'f1', topic: 'company.geography_country', value: 'NL', evidence: [evid({ tier: 'discovered' })] })], // mismatch: NL != DE
      s2: [row({ founder_id: 'f1', topic: 'company.sector', value: 'fintech', evidence: [evid({ tier: 'discovered' })] })], // mismatch: fintech != ai-infra
      founders: [founder({ founder_id: 'f1' })],
    };
    const result = score(compiledPlan(attributes), fetchedRows);
    const item = result.items.length > 0
      ? result.items.find((it) => it.founder_id === 'f1')
      : result.low_confidence.find((it) => it.founder_id === 'f1');
    const expected = Number(((25 / 65) * 100).toFixed(2));
    assert.equal(item.rank_score, expected);
    assert.ok(Math.abs(item.rank_score - 38.46) < 0.01, `expected ≈38.5, got ${item.rank_score}`);
    assert.ok(item.rank_score < 100, 'B2 regression: one match + two unknown must outrank one match + two mismatch');
  });
});

// ============================================================================
// §9: "assessed = 0 -> rank_score: null, not 0 and not a division by zero"
// ============================================================================

describe('§9 -- assessed = 0 -> rank_score: null', () => {
  test('every attribute unknown for a candidate -> rank_score is null, confidence is 0, never a fabricated number', () => {
    const attributes = [attr({ id: 'p1' }), attr({ id: 'p2', target: { type: 'claim_topic', value: 'founder.execution.live_product' } })];
    const rowsByAttrFounder = new Map([
      ['p1', new Map()],
      ['p2', new Map()],
    ]);
    const result = scoreCandidateAttributes('fX', attributes, rowsByAttrFounder);
    assert.equal(result.rank_score, null);
    assert.equal(result.confidence, 0);
  });

  test('reachable end to end via the zero-positive fallback -- every item carries rank_score: null', () => {
    const attributes = [attr({ polarity: 'negative', op: 'not_exists', target: { type: 'claim_topic', value: 'company.geography_country' } })];
    const fetchedRows = { a1: [], founders: [founder({ founder_id: 'f1', founder_score: 42 }), founder({ founder_id: 'f2', founder_score: null })] };
    const result = score(compiledPlan(attributes), fetchedRows);
    assert.equal(result.items.length, 2);
    for (const item of result.items) assert.equal(item.rank_score, null);
    // founder_score DESC NULLS LAST -- f1 (42) before f2 (null)
    assert.deepEqual(result.items.map((i) => i.founder_id), ['f1', 'f2']);
  });
});

// ============================================================================
// §9: confidence floor bucketing + the low_confidence_only fallback.
// ============================================================================

describe('§9 -- confidence floor bucketing', () => {
  test('candidates split by CONFIDENCE_FLOOR into items[] / low_confidence[], never interleaved', () => {
    // 5 equal-weight (25 each) provenance attributes, total weight 125.
    // f1 assessed on all 5 (confidence 1.0, clears the floor). f2 assessed
    // on exactly ONE (confidence 25/125 = 0.2, STRICTLY below the 0.25
    // floor -- 1-of-4 would land exactly AT 0.25, which clears it; 5
    // attributes is deliberate so this fixture cannot collide with the
    // floor-boundary case exercised separately below).
    const attributes = [
      attr({ id: 'p1' }), attr({ id: 'p2', target: { type: 'claim_topic', value: 'founder.execution.live_product' } }),
      attr({ id: 'p3', target: { type: 'claim_topic', value: 'founder.execution.external_usage' } }),
      attr({ id: 'p4', target: { type: 'claim_topic', value: 'founder.leadership.written_communication' } }),
      attr({ id: 'p5', target: { type: 'claim_topic', value: 'founder.execution.merged_pr_foreign' } }),
    ];
    const fetchedRows = {
      p1: [
        row({ founder_id: 'f1', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
        row({ founder_id: 'f2', claim_id: 'c2', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
      ],
      p2: [row({ founder_id: 'f1', claim_id: 'c3', topic: 'founder.execution.live_product', evidence: [evid({ tier: 'documented' })] })],
      p3: [row({ founder_id: 'f1', claim_id: 'c4', topic: 'founder.execution.external_usage', evidence: [evid({ tier: 'documented' })] })],
      p4: [row({ founder_id: 'f1', claim_id: 'c5', topic: 'founder.leadership.written_communication', evidence: [evid({ tier: 'documented' })] })],
      p5: [row({ founder_id: 'f1', claim_id: 'c6', topic: 'founder.execution.merged_pr_foreign', evidence: [evid({ tier: 'documented' })] })],
      founders: [founder({ founder_id: 'f1' }), founder({ founder_id: 'f2' })],
    };
    const result = score(compiledPlan(attributes), fetchedRows);
    assert.equal(result.low_confidence_only, false);
    assert.ok(result.items.some((it) => it.founder_id === 'f1'));
    assert.ok(result.low_confidence.some((it) => it.founder_id === 'f2'));
    for (const it of result.items) assert.ok(it.confidence >= CONFIDENCE_FLOOR);
    for (const it of result.low_confidence) assert.ok(it.confidence < CONFIDENCE_FLOOR);
  });

  test('if NO candidate clears the floor, items[] is populated anyway and low_confidence_only is true', () => {
    const attributes = [
      attr({ id: 'p1' }), attr({ id: 'p2', target: { type: 'claim_topic', value: 'founder.execution.live_product' } }),
      attr({ id: 'p3', target: { type: 'claim_topic', value: 'founder.execution.external_usage' } }),
      attr({ id: 'p4', target: { type: 'claim_topic', value: 'founder.leadership.written_communication' } }),
    ];
    // f1 assessed on exactly ONE of four -> confidence 0.25 exactly. Below
    // 0.25 is required to guarantee the floor is not cleared -- use a
    // partial-weight assessment to land strictly under it (0 assessed here
    // is the zero-positive path, tested separately, so instead assess a
    // SINGLE attribute at partial weight via a plan with unequal weights).
    const mixedAttributes = [
      attr({ id: 'p1', kind: 'structural', weight: WEIGHTS.structural, target: { type: 'claim_topic', value: 'company.sector' }, op: 'exists' }),
      attr({ id: 'p2' }),
      attr({ id: 'p3', target: { type: 'claim_topic', value: 'founder.execution.live_product' } }),
      attr({ id: 'p4', target: { type: 'claim_topic', value: 'founder.execution.external_usage' } }),
    ];
    const totalWeight = mixedAttributes.reduce((s, a) => s + a.weight, 0); // 20+25+25+25 = 95
    const fetchedRows = {
      p1: [row({ founder_id: 'f1', topic: 'company.sector', evidence: [evid({ tier: 'documented' })] })], // assessed=20, confidence 20/95 = 0.2105 < 0.25
      p2: [], p3: [], p4: [],
      founders: [founder({ founder_id: 'f1' })],
    };
    const result = score(compiledPlan(mixedAttributes), fetchedRows);
    assert.ok(totalWeight > 0);
    assert.equal(result.low_confidence_only, true);
    assert.equal(result.low_confidence.length, 0);
    assert.equal(result.items.length, 1);
    assert.ok(typeof result.note === 'string' && result.note.length > 0);
    assert.equal(result.items[0].confidence_bucket, null);
  });
});

// ============================================================================
// §9: tier credit ordering.
// ============================================================================

describe('§9 -- tier credit orders documented > discovered > inferred', () => {
  test('three otherwise-identical candidates rank strictly by evidence tier', () => {
    const attributes = [attr({ id: 'p1' })];
    const fetchedRows = {
      p1: [
        row({ founder_id: 'f_doc', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
        row({ founder_id: 'f_disc', claim_id: 'c2', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'discovered' })] }),
        row({ founder_id: 'f_inf', claim_id: 'c3', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'inferred' })] }),
      ],
      founders: [founder({ founder_id: 'f_doc' }), founder({ founder_id: 'f_disc' }), founder({ founder_id: 'f_inf' })],
    };
    const result = score(compiledPlan(attributes), fetchedRows);
    const all = result.items.concat(result.low_confidence);
    const byId = Object.fromEntries(all.map((it) => [it.founder_id, it.rank_score]));
    assert.equal(byId.f_doc, 100);
    assert.equal(byId.f_disc, 70);
    assert.equal(byId.f_inf, 40);
    assert.ok(byId.f_doc > byId.f_disc && byId.f_disc > byId.f_inf);
  });
});

// ============================================================================
// §9: negatives generate no candidates.
// ============================================================================

describe('§9 -- negatives generate no candidates', () => {
  test('a founder appearing ONLY in a negative attribute\'s rows never becomes a candidate', () => {
    const attributes = [
      attr({ id: 'p1' }), // positive
      attr({
        id: 'neg1', kind: 'structural', polarity: 'negative', op: 'not_exists', weight: WEIGHTS.structural,
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
    ];
    const fetchedRows = {
      p1: [row({ founder_id: 'f1', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] })],
      neg1: [row({ founder_id: 'f_only_negative', topic: 'company.geography_country' })], // f_only_negative has NO positive-attribute row
      founders: [founder({ founder_id: 'f1' }), founder({ founder_id: 'f_only_negative' })],
    };
    const result = score(compiledPlan(attributes), fetchedRows);
    const all = result.items.concat(result.low_confidence).map((it) => it.founder_id);
    assert.deepEqual(all, ['f1']);
    assert.ok(!all.includes('f_only_negative'));
  });
});

// ============================================================================
// §9: zero-positive fallback returns an explained list (also exercised
// above under the assessed=0 case; this one asserts the `note`/shape).
// ============================================================================

describe('§9 -- zero-positive fallback', () => {
  test('a plan with only unresolvable/negative attributes returns an explained, non-crashing list', () => {
    const attributes = []; // e.g. every attribute was promoted to unresolvable upstream
    const fetchedRows = { founders: [founder({ founder_id: 'f1', founder_score: 10 }), founder({ founder_id: 'f2', founder_score: 90 })] };
    const result = score(compiledPlan(attributes), fetchedRows);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((i) => i.founder_id), ['f2', 'f1']); // founder_score DESC
    assert.ok(typeof result.note === 'string' && result.note.length > 0);
    assert.equal(result.low_confidence.length, 0);
  });

  test('no founders[] supplied at all -- degrades to an empty, explained list rather than throwing', () => {
    const result = score(compiledPlan([]), {});
    assert.deepEqual(result.items, []);
    assert.equal(typeof result.note, 'string');
  });
});

// ============================================================================
// §9: truncated reflects the 200-candidate cap only. UNIT TEST ONLY -- the
// live corpus is 122 founders, so this cap never binds end to end; QA must
// not chase it live (design.md §9's own instruction).
// ============================================================================

describe('§9 -- truncated (200-candidate cap, unreachable on the live 122-founder corpus)', () => {
  test('a >200-row fixture trips truncated:true and caps total at CANDIDATE_CAP', () => {
    const attributes = [attr({ id: 'p1' })];
    const rows = [];
    for (let i = 0; i < 250; i += 1) {
      rows.push(row({ founder_id: `f${String(i).padStart(4, '0')}`, claim_id: `c${i}`, topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }));
    }
    const founders = rows.map((r) => founder({ founder_id: r.founder_id }));
    const result = score(compiledPlan(attributes), { p1: rows, founders });
    assert.equal(result.truncated, true);
    assert.equal(result.total, CANDIDATE_CAP);
    assert.equal(result.items.length + result.low_confidence.length, CANDIDATE_CAP);
  });

  test('a <=200-row fixture never trips truncated, regardless of total > limit', () => {
    const attributes = [attr({ id: 'p1' })];
    const rows = [
      row({ founder_id: 'f1', evidence: [evid({ tier: 'documented' })] }),
      row({ founder_id: 'f2', claim_id: 'c2', evidence: [evid({ tier: 'documented' })] }),
    ];
    const result = score(compiledPlan(attributes), { p1: rows, founders: [founder({ founder_id: 'f1' }), founder({ founder_id: 'f2' })] });
    assert.equal(result.truncated, false);
    assert.equal(result.total, 2); // `total` is candidates SCORED, not the caller's page `limit`
  });
});

// ============================================================================
// §9: identical plan + identical rows -> identical output, across runs.
// ============================================================================

describe('§9 -- deterministic order across runs', () => {
  test('calling score() twice with the SAME plan/fetchedRows references yields deepStrictEqual output', () => {
    const attributes = [
      attr({ id: 'p1' }),
      attr({
        id: 's1', kind: 'structural', op: 'eq', value: 'DE', weight: WEIGHTS.structural,
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
    ];
    const fetchedRows = {
      p1: [
        row({ founder_id: 'f3', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
        row({ founder_id: 'f1', claim_id: 'c2', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'discovered' })] }),
        row({ founder_id: 'f2', claim_id: 'c3', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'inferred' })] }),
      ],
      s1: [row({ founder_id: 'f1', claim_id: 'c4', topic: 'company.geography_country', value: 'DE', evidence: [evid({ tier: 'documented' })] })],
      founders: [founder({ founder_id: 'f1' }), founder({ founder_id: 'f2' }), founder({ founder_id: 'f3' })],
    };
    const plan = compiledPlan(attributes);
    const first = score(plan, fetchedRows);
    const second = score(plan, fetchedRows);
    assert.deepStrictEqual(first, second);
  });

  test('row insertion order does not affect the result (candidate union is re-sorted, not fetch-order dependent)', () => {
    const attributes = [attr({ id: 'p1' })];
    const rowsInOrder = [
      row({ founder_id: 'f3', evidence: [evid({ tier: 'documented' })] }),
      row({ founder_id: 'f1', claim_id: 'c2', evidence: [evid({ tier: 'documented' })] }),
      row({ founder_id: 'f2', claim_id: 'c3', evidence: [evid({ tier: 'documented' })] }),
    ];
    const rowsShuffled = [rowsInOrder[2], rowsInOrder[0], rowsInOrder[1]];
    const founders = [founder({ founder_id: 'f1' }), founder({ founder_id: 'f2' }), founder({ founder_id: 'f3' })];

    const a = score(compiledPlan(attributes), { p1: rowsInOrder, founders });
    const b = score(compiledPlan(attributes), { p1: rowsShuffled, founders });
    assert.deepStrictEqual(a, b);
  });
});

// ============================================================================
// rev.5 spec delta -- coverage / confidence_bucket ordering. Reached the
// backend-developer BEFORE this file existed (coordinator message);
// everything below is the new material, on top of (not instead of) the
// original §9 list above.
// ============================================================================

describe('rev.5 -- computeCoverageBucket thresholds', () => {
  test('boundaries: >=0.75 high, >=0.5 mid, else low', () => {
    assert.equal(computeCoverageBucket(1.0), 'high');
    assert.equal(computeCoverageBucket(0.75), 'high');
    assert.equal(computeCoverageBucket(0.7499), 'mid');
    assert.equal(computeCoverageBucket(0.5), 'mid');
    assert.equal(computeCoverageBucket(0.4999), 'low');
    assert.equal(computeCoverageBucket(0), 'low');
  });
});

describe('rev.5 -- compareByBucket sorts the ORDINAL, never the bucket string', () => {
  test('high before mid before low, NOT the alphabetical mid -> low -> high a naive string DESC sort would produce', () => {
    const items = [
      { confidence_bucket: 'mid', rank_score: 50, founder_id: 'b' },
      { confidence_bucket: 'low', rank_score: 90, founder_id: 'c' }, // higher rank_score, but lower bucket -- must still sort AFTER mid/high
      { confidence_bucket: 'high', rank_score: 10, founder_id: 'a' }, // lower rank_score, but higher bucket -- must sort FIRST
    ];
    const sorted = items.slice().sort(compareByBucket);
    assert.deepEqual(sorted.map((i) => i.confidence_bucket), ['high', 'mid', 'low']);
    assert.deepEqual(sorted.map((i) => i.founder_id), ['a', 'b', 'c']);
  });

  test('within the same bucket, rank_score DESC NULLS LAST, then founder_id ASC', () => {
    const items = [
      { confidence_bucket: 'high', rank_score: null, founder_id: 'z' },
      { confidence_bucket: 'high', rank_score: 80, founder_id: 'y' },
      { confidence_bucket: 'high', rank_score: 80, founder_id: 'x' },
    ];
    const sorted = items.slice().sort(compareByBucket);
    assert.deepEqual(sorted.map((i) => i.founder_id), ['x', 'y', 'z']); // tie on rank_score -> founder_id ASC; null rank_score last
  });
});

describe('rev.5 -- compareByRankOnly (the low_confidence_only fallback comparator)', () => {
  test('rank_score DESC NULLS LAST, founder_id ASC -- ignores confidence_bucket entirely', () => {
    const items = [
      { confidence_bucket: null, rank_score: 40, founder_id: 'b' },
      { confidence_bucket: null, rank_score: null, founder_id: 'a' },
      { confidence_bucket: null, rank_score: 70, founder_id: 'c' },
    ];
    const sorted = items.slice().sort(compareByRankOnly);
    assert.deepEqual(sorted.map((i) => i.founder_id), ['c', 'b', 'a']);
  });
});

describe('rev.5 -- the exact live-data ordering regression named in the spec delta', () => {
  // A 4-attribute, equal-weight (provenance, 25 each) query. Founder "sparse"
  // matches exactly ONE attribute at documented tier: rank_score 100,
  // confidence 0.25 (EXACTLY at the floor, so it still clears it and
  // low_confidence_only never fires here), coverage 0.25 -> bucket 'low'.
  // Founder "thorough" matches all FOUR: three documented + one discovered,
  // rank_score = mean(credit)*100 = (1+1+1+0.7)/4*100 = 92.5, confidence
  // 1.0, coverage 1.0 -> bucket 'high'. Per rev.5, "thorough" must sort
  // BEFORE "sparse" despite the lower rank_score.
  const attributes = [
    attr({ id: 'p1' }),
    attr({ id: 'p2', target: { type: 'claim_topic', value: 'founder.execution.live_product' } }),
    attr({ id: 'p3', target: { type: 'claim_topic', value: 'founder.execution.external_usage' } }),
    attr({ id: 'p4', target: { type: 'claim_topic', value: 'founder.leadership.written_communication' } }),
  ];

  function buildFixture() {
    return {
      p1: [
        row({ founder_id: 'sparse', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
        row({ founder_id: 'thorough', claim_id: 'c1t', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
      ],
      p2: [row({ founder_id: 'thorough', claim_id: 'c2t', topic: 'founder.execution.live_product', evidence: [evid({ tier: 'documented' })] })],
      p3: [row({ founder_id: 'thorough', claim_id: 'c3t', topic: 'founder.execution.external_usage', evidence: [evid({ tier: 'documented' })] })],
      p4: [row({ founder_id: 'thorough', claim_id: 'c4t', topic: 'founder.leadership.written_communication', evidence: [evid({ tier: 'discovered' })] })],
      founders: [founder({ founder_id: 'sparse' }), founder({ founder_id: 'thorough' })],
    };
  }

  test('the two founders score exactly as specified', () => {
    const result = score(compiledPlan(attributes), buildFixture());
    const byId = Object.fromEntries(result.items.map((it) => [it.founder_id, it]));
    assert.equal(byId.sparse.rank_score, 100);
    assert.equal(byId.sparse.confidence, 0.25);
    assert.equal(byId.sparse.confidence_bucket, 'low');
    assert.equal(byId.thorough.rank_score, 92.5);
    assert.equal(byId.thorough.confidence, 1);
    assert.equal(byId.thorough.confidence_bucket, 'high');
  });

  test('"thorough" (bucket high, rank 92.5) sorts BEFORE "sparse" (bucket low, rank 100)', () => {
    const result = score(compiledPlan(attributes), buildFixture());
    const order = result.items.map((it) => it.founder_id);
    const thoroughIdx = order.indexOf('thorough');
    const sparseIdx = order.indexOf('sparse');
    assert.ok(thoroughIdx >= 0 && sparseIdx >= 0);
    assert.ok(thoroughIdx < sparseIdx, `expected thorough before sparse, got order ${order.join(',')}`);
  });

  test('coverage and confidence_bucket are emitted on every item (never hidden internal-only state)', () => {
    const result = score(compiledPlan(attributes), buildFixture());
    for (const it of result.items) {
      assert.equal(typeof it.coverage, 'number');
      assert.ok(['high', 'mid', 'low'].includes(it.confidence_bucket));
    }
  });
});

describe('rev.5 -- low_confidence_only nulls confidence_bucket and falls back to rank-only order', () => {
  test('every item carries confidence_bucket: null when nobody clears the floor', () => {
    // Single structural attribute (weight 20), matched at 'inferred' tier ->
    // confidence = 20/20 = 1.0 for the ONE attribute in the plan... use TWO
    // attributes so a partial assessment lands under the floor instead.
    const attributes = [
      attr({ id: 's1', kind: 'structural', weight: WEIGHTS.structural, op: 'exists', target: { type: 'claim_topic', value: 'company.sector' } }),
      attr({ id: 'p1', target: { type: 'claim_topic', value: 'founder.expertise.vertical_tenure' } }),
      attr({ id: 'p2', target: { type: 'claim_topic', value: 'founder.execution.live_product' } }),
      attr({ id: 'p3', target: { type: 'claim_topic', value: 'founder.execution.external_usage' } }),
    ]; // total weight 20+25+25+25 = 95
    const fetchedRows = {
      s1: [row({ founder_id: 'f1', topic: 'company.sector', evidence: [evid({ tier: 'documented' })] })], // assessed 20/95 = 0.2105 < 0.25
      p1: [], p2: [], p3: [],
      founders: [founder({ founder_id: 'f1' })],
    };
    const result = score(compiledPlan(attributes), fetchedRows);
    assert.equal(result.low_confidence_only, true);
    assert.equal(result.items[0].confidence_bucket, null);
  });
});

// ============================================================================
// rev.6 -- `has_match` leads the sort. Found by running Q2 live against the
// deployed workflow: bucket-first ordering put a founder who matched
// NOTHING (rank_score 0, two mismatches + one unknown, coverage 0.67 ->
// bucket 'mid') at position 1, above nine founders who each had one real,
// documented match (rank_score 100, coverage 0.33 -> bucket 'low'). "We
// know this person well and they do not fit" is not the best answer to a
// search query.
//
// The two tests immediately below are the paired regression the coordinator
// asked for, kept deliberately next to each other because they pull in
// OPPOSITE directions:
//   - regression 1 needs `has_match` to NOT interfere when both candidates
//     genuinely matched something (bucket must still decide);
//   - regression 2 needs `has_match` to override the bucket when one
//     candidate matched nothing at all.
// A fix aimed at satisfying one can silently break the other -- do not
// "simplify" this pair down to one test.
// ============================================================================

describe('rev.6 -- has_match leads the sort (paired regression -- keep both tests together)', () => {
  test('regression 1 (rev.5, still holds): a 4-of-4 match (rank 92.5, bucket high) outranks a 1-of-4 match (rank 100, bucket low) -- both have has_match=true, so has_match does not separate them and bucket still decides', () => {
    const thorough = { confidence_bucket: 'high', rank_score: 92.5, founder_id: 'thorough' };
    const sparse = { confidence_bucket: 'low', rank_score: 100, founder_id: 'sparse' };
    const sorted = [sparse, thorough].sort(compareByBucket);
    assert.deepEqual(sorted.map((i) => i.founder_id), ['thorough', 'sparse']);
  });

  test('regression 2 (rev.6, the live Q2 defect): rank_score=0 + bucket mid must NOT outrank rank_score=100 + bucket low', () => {
    const noFit = { confidence_bucket: 'mid', rank_score: 0, founder_id: 'no_fit' }; // 2 mismatch + 1 unknown, live Q2 shape
    const fits = { confidence_bucket: 'low', rank_score: 100, founder_id: 'fits' }; // 1 match + 2 unknown
    const sorted = [noFit, fits].sort(compareByBucket);
    assert.deepEqual(sorted.map((i) => i.founder_id), ['fits', 'no_fit']);
  });

  test('hasMatch: false for rank_score 0 and rank_score null (assessed=0), true for any positive rank_score', () => {
    assert.equal(hasMatch({ rank_score: 0 }), false);
    assert.equal(hasMatch({ rank_score: null }), false); // assessed === 0 -- must sink like a zero-match candidate, never be coerced into a match
    assert.equal(hasMatch({ rank_score: 100 }), true);
    assert.equal(hasMatch({ rank_score: 0.01 }), true);
  });
});

describe('rev.6 -- has_match, full score() round trip reproducing the live Q2 shape', () => {
  test('a founder with two mismatches + one unknown (rank 0, bucket mid) sorts BELOW founders with one match + two unknown (rank 100, bucket low)', () => {
    // Three equal-weight (25 each) attributes so coverage fractions come out
    // exactly 1/3 ('low') and 2/3 ('mid'), mirroring the live Q2 numbers
    // (0.33 / 0.67) without depending on the real WEIGHTS table.
    const attributes = [
      attr({ id: 'p1', target: { type: 'claim_topic', value: 'founder.expertise.vertical_tenure' } }),
      attr({
        id: 's1', kind: 'structural', op: 'eq', value: 'DE', weight: 25,
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
      attr({
        id: 's2', kind: 'structural', op: 'eq', value: 'ai-infra', weight: 25,
        target: { type: 'claim_topic', value: 'company.sector' },
      }),
    ];

    const fetchedRows = {
      // p1: matched (documented) for both 'fits' founders; no row at all
      // for 'no_fit' (-> unknown on p1 for no_fit).
      p1: [
        row({ founder_id: 'fits1', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
        row({ founder_id: 'fits2', claim_id: 'c2', topic: 'founder.expertise.vertical_tenure', evidence: [evid({ tier: 'documented' })] }),
      ],
      // s1/s2: only 'no_fit' has rows, and both carry a genuinely different,
      // evidenced value -> mismatch, mismatch (never touching 'fits1'/'fits2').
      s1: [row({ founder_id: 'no_fit', claim_id: 'c3', topic: 'company.geography_country', value: 'NL', evidence: [evid({ tier: 'discovered' })] })],
      s2: [row({ founder_id: 'no_fit', claim_id: 'c4', topic: 'company.sector', value: 'fintech', evidence: [evid({ tier: 'discovered' })] })],
      founders: [founder({ founder_id: 'fits1' }), founder({ founder_id: 'fits2' }), founder({ founder_id: 'no_fit' })],
    };

    const result = score(compiledPlan(attributes), fetchedRows);
    const byId = Object.fromEntries(result.items.map((it) => [it.founder_id, it]));

    // Exact shape assertions, matching the live Q2 numbers.
    assert.equal(byId.no_fit.rank_score, 0);
    assert.equal(byId.no_fit.confidence_bucket, 'mid');
    assert.equal(byId.fits1.rank_score, 100);
    assert.equal(byId.fits1.confidence_bucket, 'low');
    assert.equal(byId.fits2.rank_score, 100);
    assert.equal(byId.fits2.confidence_bucket, 'low');

    // The ordering fix itself: position 1 must be a real match, never the
    // rank_score=0 founder, regardless of his higher coverage bucket.
    const order = result.items.map((it) => it.founder_id);
    assert.equal(order[0], 'fits1'); // ties on rank/bucket resolve by founder_id ASC
    assert.equal(order[1], 'fits2');
    assert.equal(order[2], 'no_fit'); // sinks to the bottom despite bucket 'mid' > 'low'
  });
});
