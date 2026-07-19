// lib/f05/trust.test.js
//
// Acceptance tests for lib/f05/trust.js, per docs/backlog/05-truth-gap-trust/
// plan.md task B1 (the 5-item acceptance list in the task brief IS the test
// table below). Run with: node --test lib/f05/trust.test.js -- ONLY this
// file, never the `lib/f05/*.test.js` glob (plan.md T0 rule 1: three other
// agents are concurrently creating half-written test files in this same new
// directory).
//
// This file MAY require() -- only lib/f05/trust.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).
//
// All fixtures are synthetic (no DB access, per the task's hard constraint);
// field names follow trust.js's own documented input contract (see that
// file's header).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERDICT_ELIGIBLE_CLASSES,
  NOT_ASSESSABLE_CLASSES,
  isClaimInScope,
  scopeClaimsToApplication,
  buildMissingFlags,
  computeTrustRollup,
} = require('./trust.js');

// ============================================================================
// Shared fixtures
// ============================================================================

const APP_ID = 'app-0001';
const COMPANY_A = 'company-000A';
const COMPANY_B = 'company-000B';
const FOUNDER_X = 'founder-000X';

const CTX = Object.freeze({ applicationId: APP_ID, companyId: COMPANY_A, founderIds: [FOUNDER_X] });
const CONFIG = Object.freeze({ version: 'trust_v1', min_coverage: 0.25 });

let claimCounter = 0;
function claimRow(overrides) {
  claimCounter += 1;
  return Object.assign(
    {
      claim_id: 'claim-' + claimCounter,
      topic: 'founder.execution.provenance',
      class: 'factual_static',
      derived_status: 'unverified',
      trust: null,
      independence_factor: null,
      n_supports: 0,
      n_contradicts: 0,
      card_application_id: APP_ID,
      card_company_id: null,
      card_founder_id: null,
    },
    overrides
  );
}

// An "assessed" verdict-eligible claim: carries >=1 supports row and a
// concrete trust/independence_factor pair.
function assessedClaim(overrides) {
  return claimRow(
    Object.assign(
      { derived_status: 'verified', trust: 0.8, independence_factor: 1.0, n_supports: 1 },
      overrides
    )
  );
}

// A verdict-eligible claim with no evidence at all -- an honest gap (REQ-003).
function gapClaim(overrides) {
  return claimRow(Object.assign({ derived_status: 'unverified', n_supports: 0, n_contradicts: 0 }, overrides));
}

function qualitativeClaim(overrides) {
  return claimRow(
    Object.assign(
      { class: 'qualitative', derived_status: 'unverified', topic: 'founder.expertise.insight_specificity' },
      overrides
    )
  );
}

// ============================================================================
// isClaimInScope / scopeClaimsToApplication -- SS8.1's three routes
// ============================================================================

describe('isClaimInScope (design SS8.1)', () => {
  test('route 1: card tagged directly with this application', () => {
    const row = claimRow({ card_application_id: APP_ID, card_company_id: null, card_founder_id: null });
    assert.equal(isClaimInScope(row, CTX), true);
  });

  test('route 1 miss: card tagged with a DIFFERENT application', () => {
    const row = claimRow({ card_application_id: 'app-other', card_company_id: null, card_founder_id: null });
    assert.equal(isClaimInScope(row, CTX), false);
  });

  test('route 2: company card on the application\'s own company', () => {
    const row = claimRow({ card_application_id: null, card_company_id: COMPANY_A, card_founder_id: null });
    assert.equal(isClaimInScope(row, CTX), true);
  });

  test('route 2 miss: company card on a DIFFERENT company', () => {
    const row = claimRow({ card_application_id: null, card_company_id: COMPANY_B, card_founder_id: null });
    assert.equal(isClaimInScope(row, CTX), false);
  });

  test('route 3: person-scoped claim (card_company_id NULL) on a founder of this application', () => {
    const row = claimRow({ card_application_id: null, card_company_id: null, card_founder_id: FOUNDER_X });
    assert.equal(isClaimInScope(row, CTX), true);
  });

  test('route 3: founder claim explicitly re-scoped to this same company', () => {
    const row = claimRow({ card_application_id: null, card_company_id: COMPANY_A, card_founder_id: FOUNDER_X });
    assert.equal(isClaimInScope(row, CTX), true);
  });

  test('route 3 RESTRICTION (load-bearing): same founder, but card scoped to a DIFFERENT company -- excluded', () => {
    const row = claimRow({ card_application_id: null, card_company_id: COMPANY_B, card_founder_id: FOUNDER_X });
    assert.equal(isClaimInScope(row, CTX), false);
  });

  test('a founder not on this application at all is excluded regardless of company_id', () => {
    const row = claimRow({ card_application_id: null, card_company_id: null, card_founder_id: 'founder-unrelated' });
    assert.equal(isClaimInScope(row, CTX), false);
  });

  test('scopeClaimsToApplication filters a mixed batch to exactly the in-scope subset', () => {
    const inScope1 = claimRow({ card_application_id: APP_ID });
    const inScope2 = claimRow({ card_application_id: null, card_company_id: COMPANY_A });
    const outOfScope = claimRow({ card_application_id: null, card_company_id: COMPANY_B, card_founder_id: FOUNDER_X });
    const result = scopeClaimsToApplication([inScope1, inScope2, outOfScope], CTX);
    assert.deepEqual(
      result.map((r) => r.claim_id).sort(),
      [inScope1.claim_id, inScope2.claim_id].sort()
    );
  });
});

// ============================================================================
// Acceptance 1 -- REQ-003 core invariant: gaps lower confidence, NOT value.
// ============================================================================

describe('acceptance 1 -- REQ-003: gaps lower confidence but never value', () => {
  test('adding several unassessed verdict-eligible claims leaves value unchanged and strictly lowers confidence', () => {
    const assessedClaims = [
      assessedClaim({ trust: 0.8, independence_factor: 1.0 }),
      assessedClaim({ trust: 0.8, independence_factor: 1.0 }),
      assessedClaim({ trust: 0.8, independence_factor: 1.0 }),
      assessedClaim({ trust: 0.8, independence_factor: 1.0 }),
    ];

    const baseline = computeTrustRollup(assessedClaims, CONFIG, CTX);
    assert.equal(baseline.status, 'scored');
    assert.equal(baseline.scoresRow.value, 80);
    assert.equal(baseline.scoresRow.confidence, 1); // coverage=1, mean independence=1

    const gaps = [gapClaim(), gapClaim(), gapClaim()];
    const withGaps = computeTrustRollup(assessedClaims.concat(gaps), CONFIG, CTX);
    assert.equal(withGaps.status, 'scored'); // coverage 4/7 = 0.571 still clears min_coverage 0.25

    assert.equal(withGaps.scoresRow.value, baseline.scoresRow.value); // UNCHANGED
    assert.ok(withGaps.scoresRow.confidence < baseline.scoresRow.confidence); // STRICTLY lower
    assert.equal(withGaps.scoresRow.confidence, 0.57); // round2(4/7 * 1)

    // coverage lives inside missing_flags (SS14.1 display requirement) and
    // tracks the same drop confidence does.
    assert.equal(baseline.scoresRow.missing_flags.coverage, 1);
    assert.equal(withGaps.scoresRow.missing_flags.coverage, 0.57);
  });
});

// ============================================================================
// Acceptance 2 -- an all-qualitative application yields not_assessable_count,
// never a several-hundred-entry topics list.
// ============================================================================

describe('acceptance 2 -- all-qualitative application', () => {
  test('500 qualitative claims across 5 topics: topics list is empty, not_assessable_count = 500', () => {
    const rows = [];
    const topics = ['founder.expertise.a', 'founder.expertise.b', 'founder.expertise.c', 'founder.expertise.d', 'founder.expertise.e'];
    for (let i = 0; i < 500; i++) {
      rows.push(qualitativeClaim({ topic: topics[i % topics.length] }));
    }

    const result = computeTrustRollup(rows, CONFIG, CTX);

    // Qualitative claims can never be verdict-eligible -> 0 assessed -> insufficient_evidence.
    assert.equal(result.status, 'insufficient_evidence');
    assert.equal(result.scoresRow, null);
    assert.equal(result.missingFlags.not_assessable_count, 500);
    assert.equal(result.missingFlags.topics.length, 0); // NOT a several-hundred-entry list
    assert.equal(result.missingFlags.coverage, 0); // no verdict-eligible claims at all
  });

  test('buildMissingFlags directly: verdict-eligible gap topics dedupe, qualitative claims never enter the topics list', () => {
    const rows = [];
    // 5 distinct gap topics, 20 claims apiece on the same handful of topics --
    // proves dedup by topic, not by claim.
    const gapTopics = ['founder.execution.traction', 'company.what_is_built', 'market.growth', 'competition.competitor_x', 'traction.users'];
    for (let i = 0; i < 100; i++) {
      rows.push(gapClaim({ topic: gapTopics[i % gapTopics.length], class: 'factual_dynamic' }));
    }
    // 400 qualitative claims -- must never appear in `topics`.
    for (let i = 0; i < 400; i++) {
      rows.push(qualitativeClaim({ topic: 'founder.leadership.written_communication' }));
    }

    const flags = buildMissingFlags(rows, 0.4231);
    assert.equal(flags.topics.length, 5); // deduplicated, NOT 100
    assert.equal(flags.not_assessable_count, 400);
    assert.ok(!flags.topics.includes('founder.leadership.written_communication'));
    assert.equal(flags.coverage, 0.42); // rounded 2dp, per the caller-supplied coverage argument
  });

  test('buildMissingFlags without a coverage argument returns coverage: null rather than throwing', () => {
    const flags = buildMissingFlags([qualitativeClaim()]);
    assert.equal(flags.coverage, null);
  });
});

// ============================================================================
// Acceptance 3 -- below min_coverage: no scores row, exactly one event.
// ============================================================================

describe('acceptance 3 -- insufficient evidence below min_coverage', () => {
  test('coverage 0.2 < min_coverage 0.25 (with >0 assessed claims): writes no scores row, one event', () => {
    const assessedClaims = [assessedClaim(), assessedClaim()]; // 2 assessed
    const gaps = [];
    for (let i = 0; i < 8; i++) gaps.push(gapClaim()); // 8 unassessed verdict-eligible gaps
    const rows = assessedClaims.concat(gaps); // verdict_eligible=10, assessed=2, coverage=0.2

    const result = computeTrustRollup(rows, CONFIG, CTX);

    assert.equal(result.status, 'insufficient_evidence');
    assert.equal(result.scoresRow, null); // NO scores row
    assert.equal(result.coverage, 0.2);

    assert.equal(typeof result.event, 'object');
    assert.notEqual(result.event, null);
    assert.equal(Array.isArray(result.event), false); // exactly one event object, not a list
    assert.equal(result.event.event_type, 'trust_rollup_insufficient_evidence');
    assert.equal(result.event.entity_type, 'application');
    assert.equal(result.event.entity_id, APP_ID);

    // coverage is embedded in the event's own missing_flags too, so the
    // insufficient-evidence trail carries the same snapshot shape as a
    // scored row would.
    assert.equal(result.event.payload.missing_flags.coverage, 0.2);
  });

  test('zero assessed claims at all also trips the guard (assessed.length === 0 branch)', () => {
    const gaps = [gapClaim(), gapClaim(), gapClaim()];
    const result = computeTrustRollup(gaps, CONFIG, CTX);
    assert.equal(result.status, 'insufficient_evidence');
    assert.equal(result.scoresRow, null);
    assert.equal(result.event.event_type, 'trust_rollup_insufficient_evidence');
  });
});

// ============================================================================
// Acceptance 4 -- value = mean(trust) over assessed only; coverage divides
// by verdict-eligible, not by all in-scope claims.
// ============================================================================

describe('acceptance 4 -- denominators', () => {
  test('qualitative claims never dilute coverage or the value mean, regardless of count', () => {
    const assessedClaims = [
      assessedClaim({ trust: 1.0, independence_factor: 1.0 }),
      assessedClaim({ trust: 0.5, independence_factor: 1.0 }),
      assessedClaim({ trust: 0.75, independence_factor: 1.0 }),
    ];
    const oneGap = [gapClaim({ class: 'factual_dynamic' })]; // verdict-eligible, unassessed
    const manyQualitative = [];
    for (let i = 0; i < 100; i++) {
      manyQualitative.push(qualitativeClaim({ trust: null, independence_factor: null }));
    }

    const rows = assessedClaims.concat(oneGap, manyQualitative);
    const result = computeTrustRollup(rows, CONFIG, CTX);

    assert.equal(result.status, 'scored');
    assert.equal(result.verdictEligibleCount, 4); // 3 assessed + 1 gap -- the 100 qualitative claims are NOT counted
    assert.equal(result.assessedCount, 3);
    assert.equal(result.coverage, 0.75); // 3/4, unaffected by the 100 qualitative rows
    assert.equal(result.scoresRow.value, 75); // mean(1.0, 0.5, 0.75) * 100 == 75, exactly
    assert.equal(result.scoresRow.confidence, 0.75); // coverage(0.75) * mean_independence(1.0)
    assert.equal(result.scoresRow.missing_flags.coverage, 0.75); // same 0.75, persisted alongside value/confidence
  });

  test('input_claim_ids is exactly the assessed set, not the full in-scope set', () => {
    const assessedClaims = [assessedClaim(), assessedClaim()];
    const gaps = [gapClaim()];
    const qualitative = [qualitativeClaim()];
    const rows = assessedClaims.concat(gaps, qualitative);

    const result = computeTrustRollup(rows, CONFIG, CTX);
    assert.equal(result.status, 'scored');
    assert.deepEqual(
      result.scoresRow.input_claim_ids.sort(),
      assessedClaims.map((c) => c.claim_id).sort()
    );
  });
});

// ============================================================================
// Acceptance 5 -- route-3 scope restriction inside the full rollup.
// ============================================================================

describe('acceptance 5 -- route-3 restriction inside computeTrustRollup', () => {
  test('a claim on a card belonging to the same founder but a DIFFERENT company never enters the rollup', () => {
    const inScopeClaim = assessedClaim({
      claim_id: 'claim-in-scope',
      card_application_id: APP_ID,
      trust: 0.9,
      independence_factor: 1.0,
    });
    // Same founder as CTX.founderIds, but card_company_id points at a DIFFERENT
    // company, and card_application_id is null -- route 3's load-bearing case.
    const otherCompanyClaim = assessedClaim({
      claim_id: 'claim-other-company',
      card_application_id: null,
      card_company_id: COMPANY_B,
      card_founder_id: FOUNDER_X,
      trust: 0.1, // deliberately far from the in-scope claim's trust, to prove it was excluded, not just averaged in unnoticed
      independence_factor: 1.0,
    });

    const result = computeTrustRollup([inScopeClaim, otherCompanyClaim], CONFIG, CTX);

    assert.equal(result.status, 'scored');
    assert.equal(result.verdictEligibleCount, 1);
    assert.equal(result.assessedCount, 1);
    assert.equal(result.scoresRow.value, 90); // 0.9 * 100 -- the 0.1 claim never entered the mean
    assert.ok(!result.scoresRow.input_claim_ids.includes('claim-other-company'));
    assert.equal(result.scoresRow.missing_flags.coverage, 1); // 1/1 -- the excluded claim never entered the denominator either
  });
});

// ============================================================================
// Row shape / config fallback
// ============================================================================

describe('scores row shape (design SS8.2) and config fallback', () => {
  test('scoresRow carries the fixed fields the design mandates', () => {
    const rows = [assessedClaim(), assessedClaim(), assessedClaim(), assessedClaim()];
    const result = computeTrustRollup(rows, CONFIG, CTX);
    assert.equal(result.scoresRow.axis, 'trust');
    assert.equal(result.scoresRow.application_id, APP_ID);
    assert.equal(result.scoresRow.founder_id, null);
    assert.equal(result.scoresRow.formula_version, 'trust_v1');
    assert.equal(result.scoresRow.model, null);
    assert.equal(typeof result.scoresRow.missing_flags.coverage, 'number'); // persisted, not just top-level
  });

  test('missing config.min_coverage falls back to the documented literal (0.25), not a thrown error', () => {
    const rows = [assessedClaim(), assessedClaim(), assessedClaim(), assessedClaim()];
    const result = computeTrustRollup(rows, { version: 'trust_v1' }, CTX); // no min_coverage
    assert.equal(result.status, 'scored');
  });

  test('missing config entirely falls back to trust_v1 / 0.25 without throwing', () => {
    const rows = [assessedClaim(), assessedClaim(), assessedClaim(), assessedClaim()];
    const result = computeTrustRollup(rows, {}, CTX);
    assert.equal(result.status, 'scored');
    assert.equal(result.scoresRow.formula_version, 'trust_v1');
  });
});

// ============================================================================
// Sanity: the two class sets are disjoint and match design SS4/SS8.2 exactly.
// ============================================================================

describe('router class partition', () => {
  test('VERDICT_ELIGIBLE_CLASSES and NOT_ASSESSABLE_CLASSES are disjoint and match the design vocabulary', () => {
    assert.deepEqual([...VERDICT_ELIGIBLE_CLASSES].sort(), ['factual_dynamic', 'factual_static', 'precomputed']);
    assert.deepEqual([...NOT_ASSESSABLE_CLASSES].sort(), ['forecast', 'qualitative', 'unverifiable']);
    for (const c of VERDICT_ELIGIBLE_CLASSES) assert.equal(NOT_ASSESSABLE_CLASSES.has(c), false);
  });
});
