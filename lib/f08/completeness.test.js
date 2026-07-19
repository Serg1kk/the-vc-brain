// lib/f08/completeness.test.js
//
// Acceptance tests for lib/f08/completeness.js, per docs/backlog/
// 08-founder-intake-interview/plan.md T9. Run with: node --test lib/f08/*.js
// (glob form -- the directory form fails with MODULE_NOT_FOUND on Node
// v22.19.0).
//
// This file MAY require() -- only lib/f08/completeness.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).
//
// ⚠️ ARITHMETIC CORRECTION vs. plan.md T9 / the dispatch message: both state
// the "L2 only" acceptance case as "0.505 (0.15 / 0.29625, rounded to the
// column's numeric(3,2))". That arithmetic does not check out: 0.15 /
// 0.29625 = 0.5063291... (verified below to 10dp), which rounds to 0.51 at
// 2 decimal places -- not 0.505, which is not even representable in
// numeric(3,2) (scale 2 means exactly 2 digits after the point). This
// looks like a transcription slip that propagated from plan.md into the
// dispatch message rather than a deliberately different formula. Tests
// below assert the CORRECT computed value (0.51) and this comment flags
// the discrepancy for review rather than silently matching either number.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { cardCompleteness, round2, CRITERION_TOPIC, GAP_REACHABLE_SOURCES } = require('./completeness.js');
const gaps = require('./gaps.js');

const LIVE_CRITERIA = [
  { id: 'E1', weight: 0.10000, neg_src: ['github_api'] },
  { id: 'E3', weight: 0.06000, neg_src: ['github_api'] },
  { id: 'E4', weight: 0.10000, neg_src: ['tavily_extract', 'github_api'] },
  { id: 'E5', weight: 0.08000, neg_src: ['github_api'] },
  { id: 'E7', weight: 0.06000, neg_src: ['github_api'] },
  { id: 'X1', weight: 0.09375, neg_src: ['deck_parse', 'interview_answer', 'tavily_extract'] },
  { id: 'X2', weight: 0.07500, neg_src: ['deck_parse', 'interview_answer', 'tavily_extract'] },
  { id: 'X5', weight: 0.05625, neg_src: ['deck_parse', 'interview_answer'] },
  { id: 'X6', weight: 0.07500, neg_src: ['github_api', 'tavily_extract'] },
  { id: 'L2', weight: 0.15000, neg_src: ['deck_parse', 'interview_answer'] },
  { id: 'L3', weight: 0.09000, neg_src: ['deck_parse', 'interview_answer'] },
  { id: 'L5', weight: 0.06000, neg_src: ['hn_algolia', 'tavily_extract'] },
];

// Reachable set is exactly L2 (0.15) + L3 (0.09) + X5 (0.05625) = 0.29625,
// matching lib/f08/gaps.js's own AC against this same live config.
const REACHABLE_WEIGHT = 0.15 + 0.09 + 0.05625;

function claimFor(topic, status = 'verified') {
  return { topic, verification_status: status };
}

describe('cardCompleteness -- design §6.1', () => {
  test('AC: no answers -> 0.0', () => {
    assert.equal(cardCompleteness({ criteria: LIVE_CRITERIA, claims: [] }), 0.0);
  });

  test('AC: all three answered -> 1.0', () => {
    const claims = [
      claimFor('founder.leadership.first_customers'),
      claimFor('founder.leadership.icp_specificity'),
      claimFor('founder.expertise.competitor_granularity'),
    ];
    assert.equal(cardCompleteness({ criteria: LIVE_CRITERIA, claims }), 1.0);
  });

  test('the raw L2-only fraction is 0.15/0.29625 = 0.5063291... (documented correction, see file header)', () => {
    assert.ok(Math.abs(0.15 / REACHABLE_WEIGHT - 0.5063291139) < 1e-9);
  });

  test('L2 only -> 0.51 at 2dp (numeric(3,2) rounding of 0.5063291...; plan.md states 0.505, which this file corrects)', () => {
    const claims = [claimFor('founder.leadership.first_customers')];
    assert.equal(cardCompleteness({ criteria: LIVE_CRITERIA, claims }), 0.51);
  });

  test('a missing-marker claim on a reachable topic does not count as covered', () => {
    const claims = [claimFor('founder.leadership.first_customers', 'missing')];
    assert.equal(cardCompleteness({ criteria: LIVE_CRITERIA, claims }), 0.0);
  });

  test('a claim on a NON-reachable criterion (e.g. X1, publicly reachable) never affects the denominator or numerator', () => {
    const claims = [claimFor('founder.expertise.vertical_tenure')]; // X1's topic -- not in the reachable set
    assert.equal(cardCompleteness({ criteria: LIVE_CRITERIA, claims }), 0.0);
  });

  test('empty/malformed criteria config guards to 0 rather than NaN', () => {
    assert.equal(cardCompleteness({ criteria: [], claims: [] }), 0);
    assert.equal(cardCompleteness({}), 0);
  });

  test('round2 matches numeric(3,2) rounding discipline', () => {
    assert.equal(round2(0.5063291139), 0.51);
    assert.equal(round2(1), 1);
    assert.equal(round2(0), 0);
  });
});

// ============================================================================
// completeness.js duplicates gaps.js's CRITERION_TOPIC map and reachability
// filter (zero-imports forbids sharing it directly -- see completeness.js's
// header). This keeps the two copies honest against each other, the same
// pattern lib/f02/identity.test.js uses for its own duplicated helper.
// ============================================================================

describe('duplicated CRITERION_TOPIC / GAP_REACHABLE_SOURCES stay in lockstep with gaps.js', () => {
  test('CRITERION_TOPIC is identical between the two files', () => {
    assert.deepEqual(CRITERION_TOPIC, gaps.CRITERION_TOPIC);
  });

  test('GAP_REACHABLE_SOURCES is identical between the two files', () => {
    assert.deepEqual([...GAP_REACHABLE_SOURCES].sort(), [...gaps.GAP_REACHABLE_SOURCES].sort());
  });

  test('isGapReachable agrees on the full live criteria fixture', () => {
    for (const criterion of LIVE_CRITERIA) {
      assert.equal(
        require('./completeness.js').isGapReachable(criterion),
        gaps.isGapReachable(criterion),
        `disagreement on ${criterion.id}`
      );
    }
  });
});
