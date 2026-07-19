// lib/f08/gaps.test.js
//
// Acceptance tests for lib/f08/gaps.js, per docs/backlog/
// 08-founder-intake-interview/plan.md T8. Run with: node --test lib/f08/*.js
// (glob form -- the directory form fails with MODULE_NOT_FOUND on Node
// v22.19.0).
//
// This file MAY require() -- only lib/f08/gaps.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { selectGapCriteria, isGapReachable, isCriterionCovered, normalizeCriteriaList, CRITERION_TOPIC } = require('./gaps.js');

// The LIVE `score_formulas` config.criteria array for axis='founder_score',
// version='formula_v1' -- copied verbatim from db/seed.sql so this test
// exercises the exact registry the running system uses, not a hand-picked
// subset. If seed.sql's criteria array ever changes, this fixture must be
// updated to match (same "recorded fixture, not invented data" spirit as
// lib/f02's and lib/f03's fixtures).
const LIVE_CRITERIA = [
  { id: 'E1', raw: 5, anchor: 'Merged PR into a repo they do not own, within 12 months', weight: 0.10000, neg_src: ['github_api'], subscorer: 'execution-signals' },
  { id: 'E3', raw: 3, anchor: 'Commits present in ≥48 of the last 12 weeks (consistency, not volume)', weight: 0.06000, neg_src: ['github_api'], subscorer: 'execution-signals' },
  { id: 'E4', raw: 5, anchor: 'A live production URL responds', weight: 0.10000, neg_src: ['tavily_extract', 'github_api'], subscorer: 'execution-signals' },
  { id: 'E5', raw: 4, anchor: 'Measured external usage', weight: 0.08000, neg_src: ['github_api'], subscorer: 'execution-signals' },
  { id: 'E7', raw: 3, anchor: 'Provenance clean', weight: 0.06000, neg_src: ['github_api'], subscorer: 'execution-signals' },
  { id: 'X1', raw: 5, anchor: 'Documented tenure in the same vertical as the startup', weight: 0.09375, neg_src: ['deck_parse', 'interview_answer', 'tavily_extract'], subscorer: 'expertise-signals' },
  { id: 'X2', raw: 4, anchor: 'Insight specificity', weight: 0.07500, neg_src: ['deck_parse', 'interview_answer', 'tavily_extract'], subscorer: 'expertise-signals' },
  { id: 'X5', raw: 3, anchor: 'Describes competitors at insider granularity', weight: 0.05625, neg_src: ['deck_parse', 'interview_answer'], subscorer: 'expertise-signals' },
  { id: 'X6', raw: 4, anchor: 'Did substantial work nobody asked for, before any funding', weight: 0.07500, neg_src: ['github_api', 'tavily_extract'], subscorer: 'expertise-signals' },
  { id: 'L2', raw: 5, anchor: 'First customers / LOI / pilot evidence', weight: 0.15000, neg_src: ['deck_parse', 'interview_answer'], subscorer: 'leadership-sales-proxies' },
  { id: 'L3', raw: 3, anchor: 'ICP specificity', weight: 0.09000, neg_src: ['deck_parse', 'interview_answer'], subscorer: 'leadership-sales-proxies' },
  { id: 'L5', raw: 2, anchor: 'Written communication concise and structured under compression', weight: 0.06000, neg_src: ['hn_algolia', 'tavily_extract'], subscorer: 'leadership-sales-proxies' },
];

describe('isGapReachable', () => {
  test('deck_parse + interview_answer only -> reachable', () => {
    assert.equal(isGapReachable({ neg_src: ['deck_parse', 'interview_answer'] }), true);
  });

  test('adding tavily_extract makes it publicly reachable -> not a gap question', () => {
    assert.equal(isGapReachable({ neg_src: ['deck_parse', 'interview_answer', 'tavily_extract'] }), false);
  });

  test('github_api-only criteria are never reachable by a gap question', () => {
    assert.equal(isGapReachable({ neg_src: ['github_api'] }), false);
  });

  test('empty/missing neg_src is not reachable', () => {
    assert.equal(isGapReachable({ neg_src: [] }), false);
    assert.equal(isGapReachable({}), false);
  });
});

describe('normalizeCriteriaList -- either jsonb shape', () => {
  test('accepts the array shape (the live score_formulas shape) unchanged', () => {
    const list = normalizeCriteriaList(LIVE_CRITERIA);
    assert.equal(list.length, LIVE_CRITERIA.length);
  });

  test('accepts an object-keyed-by-id shape and folds it to a list', () => {
    const asObject = { L2: { weight: 0.15, neg_src: ['deck_parse'] }, X1: { weight: 0.09375, neg_src: ['tavily_extract'] } };
    const list = normalizeCriteriaList(asObject);
    assert.equal(list.length, 2);
    assert.ok(list.some((c) => c.id === 'L2' && c.weight === 0.15));
  });
});

describe('isCriterionCovered -- R-7 missing-exclusion', () => {
  test('a verified claim on the topic DOES suppress the criterion', () => {
    const claims = [{ topic: CRITERION_TOPIC.L2, verification_status: 'verified' }];
    assert.equal(isCriterionCovered('L2', claims), true);
  });

  test('AC: a claim on L2s topic with verification_status=missing does NOT suppress L2', () => {
    const claims = [{ topic: 'founder.leadership.first_customers', verification_status: 'missing' }];
    assert.equal(isCriterionCovered('L2', claims), false);
  });

  test('no claim at all on the topic -> not covered', () => {
    assert.equal(isCriterionCovered('L2', []), false);
  });

  test('a claim on a DIFFERENT topic never counts as coverage', () => {
    const claims = [{ topic: 'founder.leadership.icp_specificity', verification_status: 'verified' }];
    assert.equal(isCriterionCovered('L2', claims), false);
  });

  test('a stray .gap-suffixed topic (the corrected-away convention) cannot be mistaken for coverage', () => {
    const claims = [{ topic: CRITERION_TOPIC.L2 + '.gap', verification_status: 'unverified' }];
    assert.equal(isCriterionCovered('L2', claims), false);
  });
});

describe('selectGapCriteria -- design §6 full pipeline', () => {
  test('AC: against the live seeded config, with no claims yet, returns exactly [L2, L3, X5] in that order', () => {
    const result = selectGapCriteria({ criteria: LIVE_CRITERIA, claims: [] });
    assert.deepEqual(result.map((c) => c.id), ['L2', 'L3', 'X5']);
  });

  test('X1 and X2 never appear -- they carry tavily_extract in neg_src (publicly reachable)', () => {
    const result = selectGapCriteria({ criteria: LIVE_CRITERIA, claims: [] });
    const ids = result.map((c) => c.id);
    assert.ok(!ids.includes('X1'));
    assert.ok(!ids.includes('X2'));
  });

  test('covering L2 with a real (non-missing) claim drops it from selection, leaving L3/X5', () => {
    const claims = [{ topic: 'founder.leadership.first_customers', verification_status: 'verified' }];
    const result = selectGapCriteria({ criteria: LIVE_CRITERIA, claims });
    assert.deepEqual(result.map((c) => c.id), ['L3', 'X5']);
  });

  test('a missing-marker claim on L2s topic does NOT remove it from selection', () => {
    const claims = [{ topic: 'founder.leadership.first_customers', verification_status: 'missing' }];
    const result = selectGapCriteria({ criteria: LIVE_CRITERIA, claims });
    assert.deepEqual(result.map((c) => c.id), ['L2', 'L3', 'X5']);
  });

  test('covering all three yields an empty (valid, expected) result', () => {
    const claims = [
      { topic: 'founder.leadership.first_customers', verification_status: 'verified' },
      { topic: 'founder.leadership.icp_specificity', verification_status: 'verified' },
      { topic: 'founder.expertise.competitor_granularity', verification_status: 'verified' },
    ];
    const result = selectGapCriteria({ criteria: LIVE_CRITERIA, claims });
    assert.deepEqual(result, []);
  });

  test('returned objects carry weight/anchor/topic for the downstream phrasing agent', () => {
    const result = selectGapCriteria({ criteria: LIVE_CRITERIA, claims: [] });
    assert.equal(result[0].id, 'L2');
    assert.equal(result[0].weight, 0.15);
    assert.equal(typeof result[0].anchor, 'string');
    assert.equal(result[0].topic, 'founder.leadership.first_customers');
  });

  test('cap is respected even if a future config makes more than 3 criteria reachable', () => {
    const widened = LIVE_CRITERIA.concat([
      { id: 'Z9', weight: 0.20, neg_src: ['deck_parse'], anchor: 'hypothetical future criterion' },
    ]);
    const result = selectGapCriteria({ criteria: widened, claims: [], cap: 3 });
    assert.equal(result.length, 3);
    // Z9 outweighs everything (0.20 > L2's 0.15) so it displaces L2 for the cap, not append past it.
    assert.deepEqual(result.map((c) => c.id), ['Z9', 'L2', 'L3']);
  });
});
