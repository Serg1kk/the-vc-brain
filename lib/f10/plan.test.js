// lib/f10/plan.test.js
//
// Tests for lib/f10/plan.js (feature 10, NL-search executor -- Stage 2,
// validation + descriptor compiling). Run with:
//   node --test lib/f10/*.test.js
// (glob form -- `node --test lib/f10/` fails with MODULE_NOT_FOUND on Node
// v22.19.0, a known quirk documented in the task brief, not a path problem).
//
// docs/backlog/10-api-cli-skill/plan.md, task B1.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCatalogue,
  familyRowCount,
  topicRecognised,
  validateTarget,
  buildDescriptor,
  validatePlan,
} = require('./plan');
const { WEIGHTS } = require('./constants');

// ============================================================================
// Shared fixtures -- the live catalogue shape, verbatim per
// docs/backlog/10-api-cli-skill/agents/nl-search-resolver/
// nl-search-resolver-agent-input-spec.md ("Structure"): ARRAYS of
// {topic, rows} / {field, filled, total}, not maps -- this is what the n8n
// workflow's "build resolver input" Code node actually produces and what
// this executor receives verbatim (D-07: "re-validates every target
// against the SAME catalogue").
// ============================================================================

function liveCatalogue() {
  return {
    claim_topics: [
      { topic: 'founder.leadership.written_communication', rows: 118 },
      { topic: 'founder.expertise.unasked_work', rows: 95 },
      { topic: 'founder.expertise.vertical_tenure', rows: 71 },
      { topic: 'founder.execution.live_product', rows: 71 },
      { topic: 'founder.expertise.insight_specificity', rows: 65 },
      { topic: 'founder.execution.provenance', rows: 34 },
      { topic: 'founder.execution.external_usage', rows: 33 },
      { topic: 'founder.execution.commit_consistency', rows: 25 },
      { topic: 'founder.execution.merged_pr_foreign', rows: 24 },
      { topic: 'company.sector', rows: 9 },
      { topic: 'company.geography_country', rows: 8 },
    ],
    structural_fields: [
      { field: 'companies.hq_country', filled: 0, total: 198 },
      { field: 'companies.stage', filled: 198, total: 198 },
      { field: 'companies.category', filled: 7, total: 198 },
      { field: 'founders.location_country', filled: 0, total: 122 },
    ],
    vocabularies: {
      sector: ['b2b-software', 'ai-infra', 'devtools', 'fintech', 'healthtech',
        'consumer', 'marketplace', 'gambling', 'adtech', 'other'],
      geography_region: ['EU', 'US', 'UK', 'APAC', 'LATAM', 'MEA', 'other'],
    },
    metric_kinds: ['gh_stars', 'gh_commit_weeks'],
  };
}

// A catalogue where `company.geography_country` is a RECOGNISED topic
// (part of the taxonomy) with ZERO rows right now -- distinct from a topic
// the catalogue never mentions at all (§5.4 rule 3's "global short-circuit").
function zeroRowGeographyCatalogue() {
  const cat = liveCatalogue();
  cat.claim_topics = cat.claim_topics.filter((t) => t.topic !== 'company.geography_country');
  cat.claim_topics.push({ topic: 'company.geography_country', rows: 0 });
  return cat;
}

function baseAttribute(overrides) {
  return {
    id: 'technical_founder',
    label: 'technical founder',
    kind: 'provenance',
    polarity: 'positive',
    target: { type: 'claim_topic', value: 'founder.expertise.*' },
    op: 'exists',
    ...overrides,
  };
}

function basePlan(attributes, unresolvable) {
  return { attributes: attributes || [], unresolvable: unresolvable || [] };
}

// ============================================================================
// normalizeCatalogue / familyRowCount / topicRecognised
// ============================================================================

describe('normalizeCatalogue + familyRowCount + topicRecognised', () => {
  test('family glob sums every catalogue topic sharing the prefix', () => {
    const cat = normalizeCatalogue(liveCatalogue());
    // founder.expertise.* = unasked_work(95) + vertical_tenure(71) + insight_specificity(65)
    assert.equal(familyRowCount(cat, 'founder.expertise.*'), 95 + 71 + 65);
  });

  test('exact topic returns its own row count', () => {
    const cat = normalizeCatalogue(liveCatalogue());
    assert.equal(familyRowCount(cat, 'company.geography_country'), 8);
  });

  test('a topic absent from the catalogue has a family row count of 0', () => {
    const cat = normalizeCatalogue(liveCatalogue());
    assert.equal(familyRowCount(cat, 'company.funding_history'), 0);
  });

  test('no catalogue supplied -> familyRowCount is null (unknown, not zero)', () => {
    assert.equal(familyRowCount(null, 'company.geography_country'), null);
  });

  test('topicRecognised is true for a family with at least one matching key', () => {
    const cat = normalizeCatalogue(liveCatalogue());
    assert.equal(topicRecognised(cat, 'founder.execution.*'), true);
  });

  test('topicRecognised is false for a family with zero matching keys', () => {
    const cat = normalizeCatalogue(liveCatalogue());
    assert.equal(topicRecognised(cat, 'company.funding_history.*'), false);
  });

  test('no catalogue supplied -> topicRecognised is permissive (true)', () => {
    assert.equal(topicRecognised(null, 'anything.at.all'), true);
  });
});

// ============================================================================
// validateTarget -- the documented taxonomy (§5.3's "resolves against"
// table), kind by kind.
// ============================================================================

describe('validateTarget -- provenance', () => {
  test('a family glob under founder.expertise.* is valid', () => {
    const attr = baseAttribute();
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, true);
    assert.equal(result.family, true);
  });

  test('an exact topic under founder.execution.* is valid, non-family', () => {
    const attr = baseAttribute({ id: 'ships_to_prod', target: { type: 'claim_topic', value: 'founder.execution.live_product' } });
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, true);
    assert.equal(result.family, false);
  });

  test('a claim_topic outside the three provenance families is rejected', () => {
    const attr = baseAttribute({ target: { type: 'claim_topic', value: 'company.sector' } });
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, false);
  });

  test('a column target is rejected for provenance -- only claim_topic resolves this kind', () => {
    const attr = baseAttribute({ target: { type: 'column', value: 'companies.stage' } });
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, false);
  });

  test('a topic the live catalogue does not recognise is rejected, never guessed', () => {
    const attr = baseAttribute({ target: { type: 'claim_topic', value: 'founder.expertise.nonexistent_subtopic' } });
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, false);
  });
});

describe('validateTarget -- structural', () => {
  test('company.sector is a valid structural claim_topic', () => {
    const attr = baseAttribute({ kind: 'structural', op: 'eq', value: 'ai-infra', target: { type: 'claim_topic', value: 'company.sector' } });
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, true);
  });

  test('company.sector eq value must come from catalogue.vocabularies.sector', () => {
    const attr = baseAttribute({ kind: 'structural', op: 'eq', value: 'not-a-real-sector', target: { type: 'claim_topic', value: 'company.sector' } });
    const result = validateTarget(attr, normalizeCatalogue(liveCatalogue()));
    assert.equal(result.ok, false);
  });

  test('company.geography_country eq value must be ISO-3166-1 alpha-2 shaped', () => {
    const bad = baseAttribute({ kind: 'structural', op: 'eq', value: 'Germany', target: { type: 'claim_topic', value: 'company.geography_country' } });
    assert.equal(validateTarget(bad, normalizeCatalogue(liveCatalogue())).ok, false);

    const good = baseAttribute({ kind: 'structural', op: 'eq', value: 'DE', target: { type: 'claim_topic', value: 'company.geography_country' } });
    assert.equal(validateTarget(good, normalizeCatalogue(liveCatalogue())).ok, true);
  });

  test('companies.stage column is valid when catalogue reports filled > 0', () => {
    const attr = baseAttribute({ kind: 'structural', op: 'eq', value: 'pre_seed', target: { type: 'column', value: 'companies.stage' } });
    assert.equal(validateTarget(attr, normalizeCatalogue(liveCatalogue())).ok, true);
  });

  test('companies.hq_country column is rejected -- 0 filled, and not on the documented allow-list either way', () => {
    const attr = baseAttribute({ kind: 'structural', op: 'eq', value: 'DE', target: { type: 'column', value: 'companies.hq_country' } });
    assert.equal(validateTarget(attr, normalizeCatalogue(liveCatalogue())).ok, false);
  });

  test('a structural claim_topic outside {sector, geography_country} is rejected', () => {
    const attr = baseAttribute({ kind: 'structural', op: 'exists', target: { type: 'claim_topic', value: 'company.funding_history' } });
    assert.equal(validateTarget(attr, normalizeCatalogue(liveCatalogue())).ok, false);
  });
});

describe('validateTarget -- metric and fts are cut from this build', () => {
  test('metric target is rejected regardless of kind or polarity (velocity kind is cut)', () => {
    const attr = baseAttribute({ target: { type: 'metric', value: 'gh_stars' }, op: 'gte', value: 100 });
    assert.equal(validateTarget(attr, normalizeCatalogue(liveCatalogue())).ok, false);
  });

  test('fts target is rejected for a POSITIVE attribute too -- text kind is cut entirely, not only for negatives', () => {
    const attr = baseAttribute({ target: { type: 'fts', value: 'developer tools' }, op: 'contains', value: 'developer tools' });
    assert.equal(validateTarget(attr, normalizeCatalogue(liveCatalogue())).ok, false);
  });

  test('fts target is rejected for a NEGATIVE attribute (§9: "negative never reaches FTS")', () => {
    const attr = baseAttribute({
      id: 'no_backing', label: 'no prior VC backing', kind: 'structural', polarity: 'negative',
      target: { type: 'fts', value: 'venture backing' }, op: 'not_exists',
    });
    assert.equal(validateTarget(attr, normalizeCatalogue(liveCatalogue())).ok, false);
  });
});

// ============================================================================
// buildDescriptor -- PostgREST query descriptor shape (data, not fetches).
// ============================================================================

describe('buildDescriptor', () => {
  test('a family glob compiles to a `like` filter, value passed through unchanged', () => {
    const attr = baseAttribute();
    const descriptor = buildDescriptor(attr, true);
    assert.equal(descriptor.resource, 'api_claims');
    assert.deepEqual(descriptor.filters, [{ column: 'topic', op: 'like', value: 'founder.expertise.*' }]);
    assert.deepEqual(descriptor.order, [{ column: 'founder_id', dir: 'asc' }]);
  });

  test('an exact topic compiles to an `eq` filter', () => {
    const attr = baseAttribute({ target: { type: 'claim_topic', value: 'founder.execution.live_product' } });
    const descriptor = buildDescriptor(attr, false);
    assert.deepEqual(descriptor.filters, [{ column: 'topic', op: 'eq', value: 'founder.execution.live_product' }]);
  });
});

// ============================================================================
// validatePlan -- the module's one entry point. Shape errors, taxonomy
// rejections (`invalid_target`), and the §5.4 rule 3 global short-circuit
// for negatives.
// ============================================================================

describe('validatePlan -- shape', () => {
  test('a well-formed two-attribute plan (design.md §5.3 example) compiles', () => {
    const raw = basePlan(
      [
        baseAttribute(),
        baseAttribute({
          id: 'geo_berlin', label: 'Berlin', kind: 'structural', op: 'eq', value: 'DE',
          target: { type: 'claim_topic', value: 'company.geography_country' },
          broadening: 'city→country', resolved_as: 'company.geography_country = DE',
        }),
      ],
      [{ label: 'no prior VC backing', reason: 'no_data_source' }],
    );
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, true);
    assert.equal(result.plan.attributes.length, 2);
    assert.equal(result.plan.attributes[0].weight, WEIGHTS.provenance);
    assert.equal(result.plan.attributes[1].weight, WEIGHTS.structural);
    assert.equal(result.plan.unresolvable.length, 1);
  });

  test('an object with error_code:"empty_query" maps to the empty_query error kind', () => {
    const result = validatePlan({ error_code: 'empty_query', message: 'blank' }, liveCatalogue());
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'empty_query');
    assert.equal(result.error.retryable, false);
  });

  test('an object with error_code:"no_catalogue" maps to resolver_failed, retryable (no dedicated §5.7 kind exists)', () => {
    const result = validatePlan({ error_code: 'no_catalogue', message: 'no catalogue supplied' }, liveCatalogue());
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'resolver_failed');
    assert.equal(result.error.retryable, true);
  });

  test('missing attributes[] / unresolvable[] is resolver_failed', () => {
    const result = validatePlan({ attributes: [] }, liveCatalogue());
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'resolver_failed');
  });

  test('a malformed attribute id is rejected', () => {
    const raw = basePlan([baseAttribute({ id: 'NotSnakeCase' })]);
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'resolver_failed');
  });

  test('duplicate attribute ids are rejected', () => {
    const raw = basePlan([baseAttribute(), baseAttribute({ target: { type: 'claim_topic', value: 'founder.execution.live_product' } })]);
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
  });

  test('a negative attribute with op !== not_exists is rejected', () => {
    const raw = basePlan([baseAttribute({ polarity: 'negative', op: 'exists' })]);
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
  });

  test('an eq op with no value is rejected', () => {
    const raw = basePlan([baseAttribute({ kind: 'structural', op: 'eq', target: { type: 'claim_topic', value: 'company.sector' } })]);
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
  });

  test('broadening set without resolved_as is rejected', () => {
    const raw = basePlan([baseAttribute({
      kind: 'structural', op: 'eq', value: 'DE',
      target: { type: 'claim_topic', value: 'company.geography_country' },
      broadening: 'city→country',
    })]);
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
  });

  test('more than 12 attributes is rejected', () => {
    const attrs = Array.from({ length: 13 }, (_, i) => baseAttribute({
      id: `a${i}`, target: { type: 'claim_topic', value: 'founder.execution.live_product' },
    }));
    const result = validatePlan(basePlan(attrs), liveCatalogue());
    assert.equal(result.ok, false);
  });
});

describe('validatePlan -- invalid_target (never guess)', () => {
  test('a target outside the documented taxonomy is rejected with kind invalid_target', () => {
    const raw = basePlan([baseAttribute({ target: { type: 'claim_topic', value: 'company.sector' } })]); // provenance + structural topic
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'invalid_target');
    assert.equal(result.error.retryable, false);
  });

  test('invalid_target rejects the WHOLE plan, not just the offending attribute', () => {
    const raw = basePlan([
      baseAttribute(), // valid
      baseAttribute({ id: 'bogus', target: { type: 'metric', value: 'gh_stars' }, op: 'gte', value: 10 }), // invalid
    ]);
    const result = validatePlan(raw, liveCatalogue());
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'invalid_target');
  });
});

describe('validatePlan -- §5.4 rule 3, negative global short-circuit', () => {
  test('a negative on a topic the catalogue KNOWS but that has zero rows is promoted to unresolvable, not kept as an attribute', () => {
    const raw = basePlan([
      baseAttribute({
        id: 'no_geo', label: 'no known geography', kind: 'structural', polarity: 'negative', op: 'not_exists',
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
    ]);
    const result = validatePlan(raw, zeroRowGeographyCatalogue());
    assert.equal(result.ok, true);
    assert.equal(result.plan.attributes.length, 0); // promoted away, never compiled
    assert.deepEqual(result.plan.unresolvable, [{ label: 'no known geography', reason: 'no_data_source' }]);
  });

  test('a negative on a topic with nonzero rows is kept as a compiled attribute (not promoted)', () => {
    const raw = basePlan([
      baseAttribute({
        id: 'no_geo', label: 'no known geography', kind: 'structural', polarity: 'negative', op: 'not_exists',
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
    ]);
    const result = validatePlan(raw, liveCatalogue()); // 8 rows, nonzero
    assert.equal(result.ok, true);
    assert.equal(result.plan.attributes.length, 1);
    assert.equal(result.plan.unresolvable.length, 0);
  });

  test('without a catalogue, the global short-circuit is skipped (permissive mode) -- attribute is kept', () => {
    const raw = basePlan([
      baseAttribute({
        id: 'no_geo', label: 'no known geography', kind: 'structural', polarity: 'negative', op: 'not_exists',
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
    ]);
    const result = validatePlan(raw, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.plan.attributes.length, 1);
  });

  test('a POSITIVE attribute on a zero-row topic is NOT promoted -- the short-circuit is negative-only', () => {
    const raw = basePlan([
      baseAttribute({
        kind: 'structural', op: 'exists',
        target: { type: 'claim_topic', value: 'company.geography_country' },
      }),
    ]);
    const result = validatePlan(raw, zeroRowGeographyCatalogue());
    assert.equal(result.ok, true);
    assert.equal(result.plan.attributes.length, 1);
    assert.equal(result.plan.unresolvable.length, 0);
  });
});
