// lib/f05/router.test.js
//
// Acceptance tests for lib/f05/router.js, per docs/backlog/05-truth-gap-trust/plan.md task A2.
// Run with: node --test lib/f05/router.test.js
//
// ⚠️ Run ONLY this file, never the `lib/f05/*.test.js` glob (plan.md T0 rule 1 / design §11):
// three other T0 agents are concurrently creating files in this same new directory, and the
// glob would pick up their half-written tests. The full glob runs once, at task B3.
//
// FIXTURE_PREFIX_MAP below is copied verbatim from design.md §4.1's jsonc block (task A2
// instruction: "Tests supply a fixture copied verbatim from design §4.1"). The module itself
// carries no built-in copy -- the live source of truth is the score_formulas('trust_v1',
// 'trust') seed row another agent (A1) is writing; this fixture must never drift from it
// silently, which is exactly why it is pasted in full rather than hand-trimmed.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { routeClaimTopic, routeClaims } = require('./router');

// ----------------------------------------------------------------------------
// Fixture -- design.md §4.1, verbatim
// ----------------------------------------------------------------------------

const FIXTURE_PREFIX_MAP = [
  { prefix: 'founder.execution.merged_pr_foreign', class: 'factual_static', check: 'gh_merged_pr' },
  { prefix: 'founder.execution.commit_consistency', class: 'factual_static', check: 'gh_commit_weeks' },
  { prefix: 'founder.execution.provenance', class: 'factual_static', check: 'gh_provenance' },
  { prefix: 'founder.execution.live_product', class: 'factual_static', check: 'url_liveness' },
  { prefix: 'founder.execution.external_usage', class: 'factual_static', check: 'gh_dependents' },
  { prefix: 'founder.execution.traction', class: 'factual_dynamic', check: 'web_traction' },
  { prefix: 'founder.execution.', class: 'factual_static' },
  { prefix: 'founder.expertise.', class: 'qualitative' },
  { prefix: 'founder.leadership.', class: 'qualitative' },
  { prefix: 'market.size_', class: 'forecast' },
  { prefix: 'market.growth', class: 'factual_dynamic' },
  { prefix: 'market.', class: 'qualitative' },
  { prefix: 'competition.founder_claim_mismatch', class: 'precomputed' },
  { prefix: 'competition.competitor', class: 'factual_static', check: 'competitor_exists' },
  { prefix: 'competition.', class: 'qualitative' },
  { prefix: 'company.geography_country', class: 'factual_static' },
  { prefix: 'company.what_is_built', class: 'factual_dynamic' },
  { prefix: 'company.stage_evidence', class: 'factual_dynamic' },
  { prefix: 'company.sector', class: 'qualitative' },
  { prefix: 'company.business_model', class: 'qualitative' },
  { prefix: 'round.', class: 'unverifiable' },
  { prefix: 'traction.', class: 'factual_dynamic' }
];

const FIXTURE_ROUTER_CONFIG = {
  prefix_map: FIXTURE_PREFIX_MAP,
  default_class: 'unverifiable'
};

// ============================================================================
// Plan.md task A2's explicitly named cases
// ============================================================================

describe('plan A2 acceptance cases', () => {
  test('founder.execution.tech routes to factual_static VIA THE CATCH-ALL, not a specific leaf', () => {
    // This carries a real contradiction in the live DB and was nearly lost before the
    // founder.execution. catch-all was added (design §4.1) -- it must match none of the
    // specific founder.execution.* leaves above it.
    const result = routeClaimTopic('founder.execution.tech', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'factual_static');
    assert.equal(result.matched_prefix, 'founder.execution.');
    assert.equal(result.check, null);
    assert.equal(result.unmatched_topic, false);
  });

  test('founder.expertise.insight routes to qualitative via the founder.expertise. catch-all', () => {
    const result = routeClaimTopic('founder.expertise.insight', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'qualitative');
    assert.equal(result.matched_prefix, 'founder.expertise.');
    assert.equal(result.unmatched_topic, false);
  });

  test('market.size_top_down routes to forecast, not factual_dynamic (design §4.2a)', () => {
    const result = routeClaimTopic('market.size_top_down', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'forecast');
    assert.equal(result.matched_prefix, 'market.size_');
    assert.equal(result.unmatched_topic, false);
  });

  test('competition.status_quo_alternative routes to qualitative via the competition. catch-all', () => {
    const result = routeClaimTopic('competition.status_quo_alternative', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'qualitative');
    assert.equal(result.matched_prefix, 'competition.');
    assert.equal(result.unmatched_topic, false);
  });

  test('founder.execution.provenance routes to factual_static and carries its check hint', () => {
    const result = routeClaimTopic('founder.execution.provenance', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'factual_static');
    assert.equal(result.check, 'gh_provenance');
    assert.equal(result.matched_prefix, 'founder.execution.provenance');
    assert.equal(result.unmatched_topic, false);
  });

  test('an invented topic matching no prefix routes to unverifiable and sets the unmatched flag', () => {
    const result = routeClaimTopic('totally.invented.topic.nobody.wrote', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'unverifiable');
    assert.equal(result.check, null);
    assert.equal(result.matched_prefix, null);
    assert.equal(result.unmatched_topic, true);
  });

  test('longest-prefix precedence, explicit: a specific leaf beats its own family catch-all', () => {
    const specific = routeClaimTopic('founder.execution.provenance', FIXTURE_ROUTER_CONFIG);
    const catchAll = routeClaimTopic('founder.execution.something_unlisted', FIXTURE_ROUTER_CONFIG);
    assert.equal(specific.matched_prefix, 'founder.execution.provenance');
    assert.equal(specific.class, 'factual_static');
    assert.equal(catchAll.matched_prefix, 'founder.execution.');
    assert.equal(catchAll.class, 'factual_static');
    // Both land factual_static here, so also prove precedence on a family where the specific
    // leaf's class actually DIFFERS from its catch-all -- founder.execution.traction is
    // factual_dynamic while the founder.execution. catch-all is factual_static.
    const traction = routeClaimTopic('founder.execution.traction', FIXTURE_ROUTER_CONFIG);
    assert.equal(traction.class, 'factual_dynamic');
    assert.equal(traction.matched_prefix, 'founder.execution.traction');
  });
});

// ============================================================================
// Additional class coverage -- one representative topic per remaining class name
// ============================================================================

describe('remaining class coverage', () => {
  test('competition.founder_claim_mismatch routes to precomputed (04\'s ingested verdict)', () => {
    const result = routeClaimTopic('competition.founder_claim_mismatch', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'precomputed');
    assert.equal(result.matched_prefix, 'competition.founder_claim_mismatch');
  });

  test('round.size routes to unverifiable via an explicit prefix, not the default', () => {
    const result = routeClaimTopic('round.size', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'unverifiable');
    assert.equal(result.matched_prefix, 'round.');
    // Explicitly matched, so this must NOT be flagged as an unmatched-topic event trigger even
    // though the resulting class is the same string as default_class.
    assert.equal(result.unmatched_topic, false);
  });

  test('competition.competitor carries its check hint', () => {
    const result = routeClaimTopic('competition.competitor_pricing', FIXTURE_ROUTER_CONFIG);
    assert.equal(result.class, 'factual_static');
    assert.equal(result.check, 'competitor_exists');
    assert.equal(result.matched_prefix, 'competition.competitor');
  });
});

// ============================================================================
// Fail-safe / fail-silent guard (design §4.1's warning, verbatim rule)
// ============================================================================

describe('default_class and the unmatched signal', () => {
  test('default_class is read from routerConfig, not hardcoded', () => {
    const customConfig = { prefix_map: FIXTURE_PREFIX_MAP, default_class: 'qualitative' };
    const result = routeClaimTopic('nothing.matches.this', customConfig);
    assert.equal(result.class, 'qualitative');
    assert.equal(result.unmatched_topic, true);
  });

  test('a missing default_class falls back to the same literal the design uses ("unverifiable")', () => {
    const configWithoutDefault = { prefix_map: FIXTURE_PREFIX_MAP };
    const result = routeClaimTopic('nothing.matches.this', configWithoutDefault);
    assert.equal(result.class, 'unverifiable');
    assert.equal(result.unmatched_topic, true);
  });

  test('an empty or non-string topic is treated as unmatched, never throws', () => {
    assert.equal(routeClaimTopic('', FIXTURE_ROUTER_CONFIG).unmatched_topic, true);
    assert.equal(routeClaimTopic(null, FIXTURE_ROUTER_CONFIG).unmatched_topic, true);
    assert.equal(routeClaimTopic(undefined, FIXTURE_ROUTER_CONFIG).unmatched_topic, true);
  });

  test('a missing or malformed routerConfig degrades to unmatched rather than throwing', () => {
    assert.equal(routeClaimTopic('founder.execution.tech', undefined).unmatched_topic, true);
    assert.equal(routeClaimTopic('founder.execution.tech', {}).unmatched_topic, true);
    assert.equal(routeClaimTopic('founder.execution.tech', { prefix_map: 'not-an-array' }).unmatched_topic, true);
  });

  test('a malformed prefix_map entry (unknown class) is skipped, not fatal, and does not shadow a valid match', () => {
    const config = {
      prefix_map: [
        { prefix: 'founder.execution.', class: 'not_a_real_class' },
        { prefix: 'founder.execution.provenance', class: 'factual_static', check: 'gh_provenance' }
      ],
      default_class: 'unverifiable'
    };
    const result = routeClaimTopic('founder.execution.provenance', config);
    assert.equal(result.class, 'factual_static');
    assert.equal(result.matched_prefix, 'founder.execution.provenance');

    // With ONLY the malformed entry able to match a topic, the topic must still land on
    // default_class rather than adopting the invalid class.
    const noValidMatch = routeClaimTopic('founder.execution.tech', {
      prefix_map: [{ prefix: 'founder.execution.', class: 'not_a_real_class' }],
      default_class: 'unverifiable'
    });
    assert.equal(noValidMatch.class, 'unverifiable');
    assert.equal(noValidMatch.unmatched_topic, true);
  });
});

// ============================================================================
// routeClaims -- batch convenience wrapper for the n8n ROUTE Code node
// ============================================================================

describe('routeClaims (batch)', () => {
  test('routes every claim in order, preserving claim_id and echoing the topic', () => {
    const claims = [
      { claim_id: 'c1', topic: 'founder.execution.provenance' },
      { claim_id: 'c2', topic: 'founder.expertise.insight' },
      { claim_id: 'c3', topic: 'totally.invented.topic' }
    ];
    const result = routeClaims(claims, FIXTURE_ROUTER_CONFIG);
    assert.equal(result.length, 3);
    assert.equal(result[0].claim_id, 'c1');
    assert.equal(result[0].class, 'factual_static');
    assert.equal(result[0].check, 'gh_provenance');
    assert.equal(result[1].claim_id, 'c2');
    assert.equal(result[1].class, 'qualitative');
    assert.equal(result[2].claim_id, 'c3');
    assert.equal(result[2].class, 'unverifiable');
    assert.equal(result[2].unmatched_topic, true);
  });

  test('a non-array input yields an empty array rather than throwing', () => {
    assert.deepEqual(routeClaims(null, FIXTURE_ROUTER_CONFIG), []);
    assert.deepEqual(routeClaims(undefined, FIXTURE_ROUTER_CONFIG), []);
  });

  test('a claim missing claim_id or topic still produces a row (fail-safe, not fail-silent)', () => {
    const result = routeClaims([{}], FIXTURE_ROUTER_CONFIG);
    assert.equal(result.length, 1);
    assert.equal(result[0].claim_id, null);
    assert.equal(result[0].topic, '');
    assert.equal(result[0].unmatched_topic, true);
  });
});
