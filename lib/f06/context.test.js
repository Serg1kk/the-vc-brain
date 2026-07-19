// lib/f06/context.test.js
//
// Acceptance tests for lib/f06/context.js, per docs/backlog/06-memo-decision/
// plan.md task T2 (the T2 acceptance list IS the test table below). Run with:
//   node --test lib/f06/context.test.js
// -- ONLY this file (T1's decision.test.js and T3's assemble.test.js are
// concurrent sibling agents' files in this same new directory).
//
// This file MAY require() -- only lib/f06/context.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node). No live DB:
// `pg` is a synthetic mock keyed by path pattern, matching context.js's own
// documented contract `pg(method, path) -> Promise<parsed JSON>`. Integration
// against the real database is task T6, not this file.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPack,
  buildGaps,
  normalizeAxis,
  buildTrustAxis,
  buildCompetitors,
  countMaterialAndFatal,
  weakestAssessedAxis,
  isResolvableRouterClass,
} = require('./context.js');

// ============================================================================
// Mock pg -- routes matched by regex over the `path` argument, in order.
// Throws on an unmocked path so a test that forgets to stub a read fails
// loudly instead of silently returning undefined.
// ============================================================================

function makeMockPg(routes) {
  const calls = [];
  const pg = async (method, path) => {
    calls.push(method + ' ' + path);
    for (const route of routes) {
      if (route.match.test(path)) {
        return typeof route.rows === 'function' ? route.rows(path) : route.rows;
      }
    }
    throw new Error('makeMockPg: unmocked path -- ' + method + ' ' + path);
  };
  pg.calls = calls;
  return pg;
}

const APP_ID = 'app-0001';
const COMPANY_ID = 'company-0001';
const FOUNDER_1 = 'founder-0001';
const FOUNDER_2 = 'founder-0002';

const NOT_ASSESSED_AXIS = Object.freeze({ value: null, trend: null, confidence: null, missing: [], assessed: false });

function assessedAxis(value, overrides) {
  return Object.assign({ value, trend: 'stable', confidence: 0.6, missing: [], assessed: true }, overrides);
}

function applicationRow(overrides) {
  return Object.assign(
    {
      application_id: APP_ID,
      company_id: COMPANY_ID,
      company_name: 'Acme Inc',
      company_domain: 'acme.example',
      stage: 'pre_seed',
      category: null,
      kind: 'inbound',
      status: 'screening',
      submitted_at: '2026-07-01T00:00:00Z',
      artifact_links: {},
      score_founder: NOT_ASSESSED_AXIS,
      score_market: NOT_ASSESSED_AXIS,
      score_idea_vs_market: NOT_ASSESSED_AXIS,
      thesis_id: null,
      thesis_name: null,
      thesis_verdict: null,
      thesis_fit: null,
      thesis_coverage: null,
      thesis_missing_fields: [],
      thesis_fired_rules: [],
      memo_version: null,
      memo_available: false,
      is_synthetic: false,
    },
    overrides
  );
}

function founderRow(overrides) {
  return Object.assign(
    {
      founder_id: FOUNDER_1,
      full_name: 'Jordan Test',
      founder_score: null,
      founder_score_trend: null,
      founder_score_confidence: null,
      score_assessed: false,
      founder_score_gaps: [],
    },
    overrides
  );
}

function apiClaimRow(overrides) {
  return Object.assign(
    {
      claim_id: 'claim-0001',
      card_id: 'card-0001',
      founder_id: null,
      company_id: COMPANY_ID,
      application_id: APP_ID,
      topic: 'founder.execution.provenance',
      axis: null,
      text_verbatim: 'Some claim text.',
      value: null,
      source_kind: 'self_reported',
      base_confidence: 0.3,
      verification_status: 'unverified',
      created_at: '2026-07-01T00:00:00Z',
      evidence: [],
    },
    overrides
  );
}

function claimTrustRow(overrides) {
  return Object.assign(
    {
      claim_id: 'claim-0001',
      card_id: 'card-0001',
      topic: 'founder.execution.provenance',
      axis: null,
      text_verbatim: 'Some claim text.',
      source_kind: 'self_reported',
      verification_status: 'unverified',
      router_class: 'factual_static',
      n_supports: 0,
      n_contradicts: 0,
      n_contradicts_counting: 0,
      n_independent: 0,
      base: null,
      independence_factor: 0.5,
      contradiction_penalty: 0,
      trust: 0,
      derived_status: 'unverified',
    },
    overrides
  );
}

function contradictedEventRow(overrides) {
  return Object.assign(
    {
      id: 'event-0001',
      event_type: 'claim_contradicted',
      entity_type: 'founder',
      entity_id: FOUNDER_1,
      payload: { claim_id: 'claim-0001', nature: 'factual', severity: 'material' },
      actor: 'test',
      created_at: '2026-07-01T00:00:00Z',
    },
    overrides
  );
}

// Builds the full route set a buildPack() call needs, defaulting every read
// to empty so a test only has to override what it cares about.
function buildRoutes(fixtures) {
  const f = Object.assign(
    { app: [applicationRow()], founders: [], appClaims: [], founderClaims: [], claimTrust: [], trustScores: [], eventsFounder: [], eventsApplication: [] },
    fixtures
  );
  return [
    { match: /^api_applications\?application_id=eq\./, rows: f.app },
    { match: /^api_founders\?application_id=eq\./, rows: f.founders },
    { match: /^scores\?application_id=eq\..*axis=eq\.trust/, rows: f.trustScores },
    { match: /^api_claims\?application_id=eq\./, rows: f.appClaims },
    { match: /^api_claims\?founder_id=in\.\(/, rows: f.founderClaims },
    { match: /^claim_trust\?claim_id=in\.\(/, rows: f.claimTrust },
    { match: /^events\?event_type=eq\.claim_contradicted&entity_type=eq\.founder/, rows: f.eventsFounder },
    { match: /^events\?event_type=eq\.claim_contradicted&entity_type=eq\.application/, rows: f.eventsApplication },
  ];
}

// ============================================================================
// §3.1 -- application not found is the ONE hard error
// ============================================================================

describe('buildPack -- §3.1 application not found', () => {
  test('throws a clear error, never returns a partial pack', async () => {
    const pg = makeMockPg(buildRoutes({ app: [] }));
    await assert.rejects(() => buildPack(pg, APP_ID), /application not found/);
  });
});

// ============================================================================
// §3.2 -- absent ≠ zero
// ============================================================================

describe('buildPack -- §3.2 screening axes (I2 absent ≠ zero)', () => {
  test('assessed=false stays null, never coerced to 0', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [
          applicationRow({
            score_founder: NOT_ASSESSED_AXIS,
            score_market: assessedAxis(68),
            score_idea_vs_market: NOT_ASSESSED_AXIS,
          }),
        ],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.axes.founder.assessed, false);
    assert.equal(pack.axes.founder.value, null);
    assert.equal(pack.axes.market.assessed, true);
    assert.equal(pack.axes.market.value, 68);
    assert.equal(pack.axes.idea_vs_market.assessed, false);
    assert.equal(pack.axes.idea_vs_market.value, null);
  });

  test('normalizeAxis never invents assessed from value presence', () => {
    // A defensive/malformed row carrying a value but assessed !== true must
    // still read as not-assessed -- assessed is read verbatim, never derived.
    const axis = normalizeAxis({ value: 42, assessed: false });
    assert.equal(axis.assessed, false);
    assert.equal(axis.value, 42); // passthrough -- context.js does not scrub value, only never treats it as 0-by-default
  });

  test('missing axis object (undefined) resolves to a fully not-assessed axis', () => {
    const axis = normalizeAxis(undefined);
    assert.deepEqual(axis, { value: null, trend: null, confidence: null, missing: [], assessed: false });
  });
});

// ============================================================================
// §3.4 -- trust axis
// ============================================================================

describe('buildPack -- §3.4 trust axis', () => {
  test('no scores row -> trust.assessed=false, value/coverage null', async () => {
    const pg = makeMockPg(buildRoutes({ trustScores: [] }));
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.trust, { value: null, confidence: null, coverage: null, assessed: false });
    assert.deepEqual(pack.decision_inputs.trust, { value: null, assessed: false, coverage: null, confidence: null });
  });

  test('a scores row is read: value/confidence direct, coverage from raw missing_flags.coverage only', async () => {
    const pg = makeMockPg(
      buildRoutes({
        trustScores: [
          { id: 's1', application_id: APP_ID, axis: 'trust', value: 55, confidence: 0.61, missing_flags: { topics: ['x'], not_assessable_count: 2, coverage: 0.667, _internal: 'must-not-leak' } },
        ],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.trust.value, 55);
    assert.equal(pack.trust.confidence, 0.61);
    assert.equal(pack.trust.coverage, 0.667);
    assert.equal(pack.trust.assessed, true);
    // buildTrustAxis is directly unit-testable too.
    assert.equal(buildTrustAxis([]).assessed, false);
  });
});

// ============================================================================
// §3.5 -- thesis fit / NULL-gate passthrough (stale-thesis trap is
// api_applications's job, not context.js's -- this only verifies the pack
// carries the already-resolved NULL through, shaped for D3's "not decidable".
// ============================================================================

describe('buildPack -- §3.5 thesis (NULL-gate passthrough)', () => {
  test('insufficient_evidence verdict with score_id NULL -> thesis_fit stays null (not a stale fallback)', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [
          applicationRow({
            thesis_verdict: 'insufficient_evidence',
            thesis_fit: null,
            thesis_coverage: 0.2,
            thesis_missing_fields: ['stage_evidence'],
          }),
        ],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.thesis.thesis_verdict, 'insufficient_evidence');
    assert.equal(pack.thesis.thesis_fit, null);
    assert.equal(pack.decision_inputs.thesis_verdict, 'insufficient_evidence');
    assert.equal(pack.decision_inputs.thesis_fit, null);
    assert.deepEqual(pack.thesis.thesis_missing_fields, ['stage_evidence']);
  });

  test('no thesis_evaluations row at all (LEFT JOIN NULLs) -> arrays default to [], not null/undefined', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [applicationRow({ thesis_missing_fields: null, thesis_fired_rules: null })],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.thesis.thesis_missing_fields, []);
    assert.deepEqual(pack.thesis.thesis_fired_rules, []);
  });
});

// ============================================================================
// §3.6 -- allowed_claim_ids is the founder-scoped SUPERSET
// ============================================================================

describe('buildPack -- §3.6 allowed_claim_ids superset', () => {
  test('a founder-scoped claim with application_id NULL is present in allowed_claim_ids', async () => {
    const founderOnlyClaim = apiClaimRow({
      claim_id: 'claim-founder-only',
      founder_id: FOUNDER_1,
      application_id: null, // card.application_id nullable -- design §3.6's load-bearing case
      topic: 'founder.execution.merged_pr_foreign',
    });
    const pg = makeMockPg(
      buildRoutes({
        founders: [founderRow({ founder_id: FOUNDER_1 })],
        appClaims: [],
        founderClaims: [founderOnlyClaim],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.ok(pack.allowed_claim_ids.includes('claim-founder-only'));
    const claim = pack.claims.find((c) => c.claim_id === 'claim-founder-only');
    assert.ok(claim, 'claim must be present in pack.claims');
    assert.equal(claim.application_id, null);
  });

  test('deduplicates a claim id present in both the application-scoped and founder-scoped reads', async () => {
    const shared = apiClaimRow({ claim_id: 'claim-shared', founder_id: FOUNDER_1 });
    const pg = makeMockPg(
      buildRoutes({
        founders: [founderRow({ founder_id: FOUNDER_1 })],
        appClaims: [shared],
        founderClaims: [shared],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.allowed_claim_ids.filter((id) => id === 'claim-shared').length, 1);
    assert.equal(pack.claims.filter((c) => c.claim_id === 'claim-shared').length, 1);
  });

  test('no founders on the application -> the founder-scoped read is skipped, not sent as in.()', async () => {
    const pg = makeMockPg(buildRoutes({ founders: [] }));
    // No route matches api_claims?founder_id=in.( -- if buildPack ever called
    // it with an empty list this would throw "unmocked path" via the
    // in.() form not matching /in\.\(/ literally... so assert instead via
    // call log: the founder-claims path must never appear at all.
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.claims.length, 0);
    assert.ok(!pg.calls.some((c) => c.indexOf('api_claims?founder_id=in.(') !== -1));
  });

  test('claims_for_writers is the trimmed 7-field slice, no evidence/founder_id/company_id leak', async () => {
    const pg = makeMockPg(buildRoutes({ appClaims: [apiClaimRow({ evidence: [{ source_url: 'https://x' }] })] }));
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.claims_for_writers.length, 1);
    assert.deepEqual(Object.keys(pack.claims_for_writers[0]).sort(), [
      'claim_id',
      'derived_status',
      'router_class',
      'source_kind',
      'text_verbatim',
      'topic',
      'value',
    ]);
  });

  test('a claim with no matching claim_trust row gets derived_status/router_class = null, not thrown', async () => {
    const pg = makeMockPg(buildRoutes({ appClaims: [apiClaimRow({ claim_id: 'claim-fresh' })], claimTrust: [] }));
    const pack = await buildPack(pg, APP_ID);
    const claim = pack.claims.find((c) => c.claim_id === 'claim-fresh');
    assert.equal(claim.derived_status, null);
    assert.equal(claim.router_class, null);
  });
});

// ============================================================================
// §3.9 -- material / fatal contradictions
// ============================================================================

describe('buildPack -- §3.9 contradictions (material vs fatal)', () => {
  test('material fires on severity=material regardless of nature; fatal requires nature=factual AND severity=material', async () => {
    const claims = [
      apiClaimRow({ claim_id: 'c1', topic: 'founder.execution.provenance' }),
      apiClaimRow({ claim_id: 'c2', topic: 'founder.execution.provenance' }),
      apiClaimRow({ claim_id: 'c3', topic: 'founder.execution.provenance' }),
    ];
    const events = [
      contradictedEventRow({ id: 'ev1', payload: { claim_id: 'c1', nature: 'temporal', severity: 'material' } }), // material, not fatal
      contradictedEventRow({ id: 'ev2', payload: { claim_id: 'c2', nature: 'factual', severity: 'material' } }), // material AND fatal
      contradictedEventRow({ id: 'ev3', payload: { claim_id: 'c3', nature: 'factual', severity: 'minor' } }), // neither
    ];
    const pg = makeMockPg(buildRoutes({ appClaims: claims, eventsApplication: events }));
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.material_contradictions, 2);
    assert.equal(pack.fatal_contradictions, 1);
    assert.equal(pack.decision_inputs.material_contradictions, 2);
    assert.equal(pack.decision_inputs.fatal_contradictions, 1);
  });

  test('a documented contradiction with NO event (derived_status=contradicted only) counts as material, never fatal', async () => {
    const claims = [apiClaimRow({ claim_id: 'c9' })];
    const trust = [claimTrustRow({ claim_id: 'c9', derived_status: 'contradicted' })];
    const pg = makeMockPg(buildRoutes({ appClaims: claims, claimTrust: trust, eventsApplication: [] }));
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.material_contradictions, 1);
    assert.equal(pack.fatal_contradictions, 0);
  });

  test('the same claim signalled by BOTH an event and derived_status=contradicted counts once, not twice', async () => {
    const claims = [apiClaimRow({ claim_id: 'c4' })];
    const trust = [claimTrustRow({ claim_id: 'c4', derived_status: 'contradicted' })];
    const events = [contradictedEventRow({ id: 'ev4', payload: { claim_id: 'c4', nature: 'factual', severity: 'material' } })];
    const pg = makeMockPg(buildRoutes({ appClaims: claims, claimTrust: trust, eventsApplication: events }));
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.material_contradictions, 1);
    assert.equal(pack.fatal_contradictions, 1);
  });

  test('countMaterialAndFatal unit: no events, no contradicted claims -> both zero', () => {
    const result = countMaterialAndFatal([], []);
    assert.deepEqual(result, { material_contradictions: 0, fatal_contradictions: 0 });
  });

  test('both entity shapes are queried and merged (founder-scoped AND application-scoped, deduped by event id)', async () => {
    const sharedEvent = contradictedEventRow({ id: 'ev-dup', entity_type: 'founder', payload: { claim_id: 'c5', nature: 'factual', severity: 'material' } });
    const pg = makeMockPg(
      buildRoutes({
        founders: [founderRow({ founder_id: FOUNDER_1 })],
        eventsFounder: [sharedEvent],
        eventsApplication: [contradictedEventRow({ id: 'ev-app', entity_type: 'application', payload: { claim_id: 'c6', nature: 'factual', severity: 'material' } })],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.equal(pack.contradiction_events.length, 2);
    assert.equal(pack.fatal_contradictions, 2);
  });

  test('gaps.contradictions prefers the richer event entry over a claim-only entry for the same claim_id', async () => {
    const claims = [apiClaimRow({ claim_id: 'c4', topic: 'founder.execution.provenance' })];
    const trust = [claimTrustRow({ claim_id: 'c4', derived_status: 'contradicted' })];
    const events = [contradictedEventRow({ id: 'ev4', payload: { claim_id: 'c4', nature: 'factual', severity: 'material' } })];
    const pg = makeMockPg(buildRoutes({ appClaims: claims, claimTrust: trust, eventsApplication: events }));
    const pack = await buildPack(pg, APP_ID);
    const entry = pack.gaps.contradictions.find((c) => c.claim_id === 'c4');
    assert.deepEqual(entry, { claim_id: 'c4', severity: 'material', nature: 'factual', topic: 'founder.execution.provenance' });
  });

  test('a claim-only contradiction (no event) surfaces with severity/nature null, never fabricated', async () => {
    const claims = [apiClaimRow({ claim_id: 'c9', topic: 'founder.leadership.experience' })];
    const trust = [claimTrustRow({ claim_id: 'c9', derived_status: 'partially_supported' })];
    const pg = makeMockPg(buildRoutes({ appClaims: claims, claimTrust: trust }));
    const pack = await buildPack(pg, APP_ID);
    const entry = pack.gaps.contradictions.find((c) => c.claim_id === 'c9');
    assert.deepEqual(entry, { claim_id: 'c9', severity: null, nature: null, topic: 'founder.leadership.experience' });
  });
});

// ============================================================================
// §3.10 -- competition slug mapping
// ============================================================================

describe('buildPack -- §3.10 competition', () => {
  test('competition.competitor -> structured competitors[] with named_by_founder from value.company_mentioned', async () => {
    const claims = [
      apiClaimRow({ claim_id: 'comp1', topic: 'competition.competitor', value: { name: 'Acme Corp', company_mentioned: true } }),
      apiClaimRow({ claim_id: 'comp2', topic: 'competition.competitor', value: { company_mentioned: false } }),
      apiClaimRow({ claim_id: 'comp3', topic: 'competition.status_quo_alternative', value: { alternative: 'a spreadsheet' } }),
      apiClaimRow({ claim_id: 'comp4', topic: 'competition.founder_claim_mismatch', value: { nature: 'factual', severity: 'material' } }),
      apiClaimRow({ claim_id: 'noncomp', topic: 'market.tailwind', value: {} }),
    ];
    const pg = makeMockPg(buildRoutes({ appClaims: claims }));
    const pack = await buildPack(pg, APP_ID);

    assert.equal(pack.competitors.length, 2);
    assert.deepEqual(pack.competitors[0], { name: 'Acme Corp', named_by_founder: true, claim_ids: ['comp1'] });
    assert.deepEqual(pack.competitors[1], { name: null, named_by_founder: false, claim_ids: ['comp2'] });

    // All three competition.* topics land in competition_claims for [B3]'s prose.
    const compClaimIds = pack.competition_claims.map((c) => c.claim_id).sort();
    assert.deepEqual(compClaimIds, ['comp1', 'comp2', 'comp3', 'comp4']);
  });

  test('buildCompetitors unit: a claim with no value object never throws, name resolves to null', () => {
    const competitors = buildCompetitors([apiClaimRow({ claim_id: 'x', topic: 'competition.competitor', value: null })]);
    assert.deepEqual(competitors, [{ name: null, named_by_founder: false, claim_ids: ['x'] }]);
  });
});

// ============================================================================
// §7 -- per-agent slices: ambiguous claims + weakest assessed axis
// ============================================================================

describe('buildPack -- §7 per-agent slices', () => {
  test('ambiguous_claims keeps only unverified/partially_supported claims on a RESOLVABLE router_class', async () => {
    const claims = [
      apiClaimRow({ claim_id: 'a1', topic: 'founder.execution.provenance' }), // unverified/factual_static -> kept
      apiClaimRow({ claim_id: 'a2', topic: 'founder.expertise.x' }), // partially_supported/qualitative -> pinned, dropped
      apiClaimRow({ claim_id: 'a3', topic: 'traction.users' }), // verified/factual_dynamic -> not ambiguous, dropped
    ];
    const trust = [
      claimTrustRow({ claim_id: 'a1', derived_status: 'unverified', router_class: 'factual_static' }),
      claimTrustRow({ claim_id: 'a2', derived_status: 'partially_supported', router_class: 'qualitative' }),
      claimTrustRow({ claim_id: 'a3', derived_status: 'verified', router_class: 'factual_dynamic' }),
    ];
    const pg = makeMockPg(buildRoutes({ appClaims: claims, claimTrust: trust }));
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.ambiguous_claims.map((c) => c.claim_id), ['a1']);
  });

  test('isResolvableRouterClass: unverifiable/qualitative/forecast are pinned, never resolvable', () => {
    assert.equal(isResolvableRouterClass('factual_static'), true);
    assert.equal(isResolvableRouterClass('factual_dynamic'), true);
    assert.equal(isResolvableRouterClass('precomputed'), true);
    assert.equal(isResolvableRouterClass('qualitative'), false);
    assert.equal(isResolvableRouterClass('forecast'), false);
    assert.equal(isResolvableRouterClass('unverifiable'), false);
  });

  test('weakest_assessed_axis picks the lowest-value ASSESSED screening axis, never trust/founder_score', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [applicationRow({ score_founder: NOT_ASSESSED_AXIS, score_market: assessedAxis(68), score_idea_vs_market: assessedAxis(40) })],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.weakest_assessed_axis, { axis: 'idea_vs_market', value: 40 });
  });

  test('weakestAssessedAxis unit: nothing assessed -> null, never fabricated', () => {
    assert.equal(weakestAssessedAxis({ founder: NOT_ASSESSED_AXIS, market: NOT_ASSESSED_AXIS, idea_vs_market: NOT_ASSESSED_AXIS }), null);
  });
});

// ============================================================================
// buildGaps -- §4.2
// ============================================================================

describe('buildGaps -- §4.2', () => {
  test('not_disclosed: financials + revenue fire when no claim covers either topic', async () => {
    const pg = makeMockPg(buildRoutes({}));
    const pack = await buildPack(pg, APP_ID);
    const topics = pack.gaps.not_disclosed.map((n) => n.topic).sort();
    assert.deepEqual(topics, ['financials', 'revenue']);
    assert.ok(pack.gaps.not_disclosed.some((n) => n.text === 'Cap table: not disclosed.'));
  });

  test('a round.cap_table claim suppresses the financials not_disclosed line (but not revenue)', async () => {
    const pg = makeMockPg(buildRoutes({ appClaims: [apiClaimRow({ claim_id: 'r1', topic: 'round.cap_table' })] }));
    const pack = await buildPack(pg, APP_ID);
    const topics = pack.gaps.not_disclosed.map((n) => n.topic);
    assert.ok(!topics.includes('financials'));
    assert.ok(topics.includes('revenue'));
  });

  test('a traction.revenue claim suppresses the revenue not_disclosed line', async () => {
    const pg = makeMockPg(buildRoutes({ appClaims: [apiClaimRow({ claim_id: 'r2', topic: 'traction.revenue_run_rate' })] }));
    const pack = await buildPack(pg, APP_ID);
    const topics = pack.gaps.not_disclosed.map((n) => n.topic);
    assert.ok(!topics.includes('revenue'));
    assert.ok(topics.includes('financials'));
  });

  test('thesis_missing_fields extension: stage_evidence/business_model add their own not_disclosed lines', async () => {
    const pg = makeMockPg(
      buildRoutes({ app: [applicationRow({ thesis_missing_fields: ['stage_evidence', 'business_model', 'geography_country'] })] })
    );
    const pack = await buildPack(pg, APP_ID);
    const topics = pack.gaps.not_disclosed.map((n) => n.topic);
    assert.ok(topics.includes('stage_evidence'));
    assert.ok(topics.includes('business_model'));
    // geography_country is a company-data field, not a founder disclosure --
    // deliberately NOT extended (this file's header note 3).
    assert.ok(!topics.includes('geography_country'));
  });

  test('missing_axes lists every not-assessed axis among founder/market/idea_vs_market/trust', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [applicationRow({ score_founder: NOT_ASSESSED_AXIS, score_market: assessedAxis(68), score_idea_vs_market: NOT_ASSESSED_AXIS })],
        trustScores: [],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.gaps.missing_axes.sort(), ['founder', 'idea_vs_market', 'trust']);
  });

  test('missing_fields is the union of thesis_missing_fields and every founder_score_gaps criterion_id, deduped', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [applicationRow({ thesis_missing_fields: ['stage_evidence'] })],
        founders: [
          founderRow({ founder_id: FOUNDER_1, founder_score_gaps: [{ criterion_id: 'track_record', what_would_close_it: 'x' }] }),
          founderRow({ founder_id: FOUNDER_2, founder_score_gaps: [{ criterion_id: 'stage_evidence', what_would_close_it: 'y' }] }),
        ],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.gaps.missing_fields.sort(), ['stage_evidence', 'track_record']);
  });

  test('low_coverage passes through trust.coverage / thesis.thesis_coverage, null when unknown', async () => {
    const pg = makeMockPg(
      buildRoutes({
        app: [applicationRow({ thesis_coverage: null })],
        trustScores: [{ id: 's1', application_id: APP_ID, axis: 'trust', value: 55, confidence: 0.6, missing_flags: { coverage: 0.31 } }],
      })
    );
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(pack.gaps.low_coverage, { trust: 0.31, thesis: null });
  });

  test('buildGaps is independently callable on an already-built pack (same result as pack.gaps)', async () => {
    const pg = makeMockPg(buildRoutes({}));
    const pack = await buildPack(pg, APP_ID);
    assert.deepEqual(buildGaps(pack), pack.gaps);
  });
});

// ============================================================================
// Empty pack (no claims at all) -- design §10: "still writes a memo"
// ============================================================================

describe('buildPack -- empty pack end to end', () => {
  test('no claims, no founders, no trust, no thesis -> honest gaps + a decidable-shaped (if empty) decision_inputs, never throws', async () => {
    const pg = makeMockPg(buildRoutes({}));
    const pack = await buildPack(pg, APP_ID);

    assert.deepEqual(pack.claims, []);
    assert.deepEqual(pack.allowed_claim_ids, []);
    assert.deepEqual(pack.competitors, []);
    assert.deepEqual(pack.ambiguous_claims, []);
    assert.equal(pack.weakest_assessed_axis, null);
    assert.equal(pack.material_contradictions, 0);
    assert.equal(pack.fatal_contradictions, 0);

    // Gaps are fully populated -- an honest empty memo, not a silent blank.
    assert.equal(pack.gaps.not_disclosed.length, 2); // financials + revenue
    assert.deepEqual(pack.gaps.missing_axes.sort(), ['founder', 'idea_vs_market', 'market', 'trust']);
    assert.deepEqual(pack.gaps.missing_fields, []);
    assert.deepEqual(pack.gaps.low_coverage, { trust: null, thesis: null });
    assert.deepEqual(pack.gaps.contradictions, []);

    // decision_inputs is a valid, total shape -- every field present, nothing
    // undefined, so decision.js's D3 "not decidable" branch has real inputs
    // to reason over rather than a hole.
    assert.deepEqual(pack.decision_inputs, {
      thesis_verdict: null,
      thesis_fit: null,
      thesis_fired_rules: [],
      axes: {
        founder: { value: null, assessed: false },
        market: { value: null, assessed: false },
        idea_vs_market: { value: null, assessed: false },
      },
      trust: { value: null, assessed: false, coverage: null, confidence: null },
      founder_score: { value: null, assessed: false },
      material_contradictions: 0,
      fatal_contradictions: 0,
    });
  });
});
