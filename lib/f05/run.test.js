// lib/f05/run.test.js
//
// Tests for the pure, DB-free helpers exported by lib/f05/run.js (feature 05,
// task B3) -- the GDPR event-shaping logic (design.md SS9) above all, since
// that is the one part of this file that must never regress silently: an
// event written with the wrong entity_id/entity_type is permanently
// unpurgeable (events is append-only). Everything else in run.js talks to a
// live database via psql and is exercised by the acceptance run against a
// named application instead (see the task's own report), matching
// lib/f02/f03's precedent of not unit-testing their own DB-calling main().
//
// Run with: node --test lib/f05/run.test.js
//
// Do NOT run this via the `lib/f05/*.test.js` glob during Wave T0 (plan.md's
// binding rule) -- this file is Wave T1 (B3), added after T0 closed, so the
// glob is safe to use for it; kept here only as a note for any future reader
// who copies the T0 rule verbatim.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  entityForClaim,
  buildAttemptedEventRow,
  buildUnmatchedTopicEventRow,
  buildVerifiedEventRow,
  buildContradictedEventRow,
  buildEntityForRow,
  extractSourceText,
  uuidArrayLiteral,
} = require('./run');

const FOUNDER_ID = '11111111-1111-1111-1111-111111111111';
const APPLICATION_ID = '22222222-2222-2222-2222-222222222222';
const RUN_ID = '33333333-3333-3333-3333-333333333333';

// ============================================================================
// entityForClaim -- the GDPR anti-join's single point of truth (design SS9)
// ============================================================================

describe('entityForClaim', () => {
  test('a founder-scoped card (card_founder_id set) resolves to entity_type=founder, entity_id=founders.id', () => {
    const result = entityForClaim({ card_founder_id: FOUNDER_ID }, { applicationId: APPLICATION_ID });
    assert.deepEqual(result, { entityType: 'founder', entityId: FOUNDER_ID });
  });

  test('a company-only card (no founder) falls back to entity_type=application, entity_id=applicationId', () => {
    const result = entityForClaim({ card_founder_id: null }, { applicationId: APPLICATION_ID });
    assert.deepEqual(result, { entityType: 'application', entityId: APPLICATION_ID });
  });
});

// ============================================================================
// buildContradictedEventRow -- the highest-stakes shape in this file (design
// SS6.1/SS6.2/SS9/SS14): founder_claim and entity_match.quote must be
// PRESENT on a founder-scoped event and ABSENT on the application fallback.
// ============================================================================

describe('buildContradictedEventRow', () => {
  const baseRow = {
    claim_id: 'c1',
    topic: 'founder.execution.provenance',
    text_verbatim: 'The founder claim text, verbatim.',
    class: 'factual_static',
    derived_status: 'unverified',
    card_founder_id: FOUNDER_ID,
    card_company_id: null,
  };
  const routing = { class: 'factual_static', check: 'gh_provenance', matched_prefix: 'founder.execution.provenance', unmatched_topic: false };
  const ctx = { applicationId: APPLICATION_ID, companyId: null, founderIds: [FOUNDER_ID], runId: RUN_ID };
  const contradiction = {
    sourceUrl: 'https://github.com/example/repo',
    nature: 'temporal',
    severity: 'material',
    foundReality: 'earliest commit postdates the public trace',
    question: 'Can you walk us through the timeline?',
    entityMatch: { resolved_by: 'raw_signal_fk', quote: 'a verbatim quote naming the founder', disambiguator: 'Jane Founder' },
  };

  test('founder-scoped: entity_type=founder, entity_id=founders.id, carries founder_claim and entity_match.quote', () => {
    const row = buildContradictedEventRow(baseRow, routing, 'contradicted', ctx, '2026-01-01T00:00:00Z', contradiction);
    assert.equal(row.event_type, 'claim_contradicted');
    assert.equal(row.entity_type, 'founder');
    assert.equal(row.entity_id, FOUNDER_ID);
    assert.equal(row.payload.founder_claim, baseRow.text_verbatim);
    assert.equal(row.payload.entity_match.quote, contradiction.entityMatch.quote);
    assert.equal(row.payload.verdict_after, 'contradicted');
    assert.equal(row.payload.run_id, RUN_ID);
  });

  test('company-only card fallback: entity_type=application, entity_id=applicationId, NEVER founder_claim or entity_match.quote (design SS9 -- resolved_by/disambiguator may remain)', () => {
    const companyRow = Object.assign({}, baseRow, { card_founder_id: null });
    const row = buildContradictedEventRow(companyRow, routing, 'unverified', ctx, '2026-01-01T00:00:00Z', contradiction);
    assert.equal(row.entity_type, 'application');
    assert.equal(row.entity_id, APPLICATION_ID);
    assert.equal(Object.prototype.hasOwnProperty.call(row.payload, 'founder_claim'), false);
    assert.equal(row.payload.entity_match.quote, undefined);
    assert.equal(row.payload.entity_match.resolved_by, contradiction.entityMatch.resolved_by);
    assert.equal(row.payload.entity_match.disambiguator, contradiction.entityMatch.disambiguator);
  });

  test('the SS14 qualitative-suppression case: verdict_before === verdict_after === unverified, event still carries the finding', () => {
    const qualRow = Object.assign({}, baseRow, { class: 'qualitative', derived_status: 'unverified' });
    const qualRouting = { class: 'qualitative', check: null, matched_prefix: 'founder.expertise.', unmatched_topic: false };
    const row = buildContradictedEventRow(qualRow, qualRouting, 'unverified', ctx, '2026-01-01T00:00:00Z', contradiction);
    assert.equal(row.payload.verdict_before, 'unverified');
    assert.equal(row.payload.verdict_after, 'unverified');
    assert.equal(row.payload.found_reality, contradiction.foundReality);
  });
});

// ============================================================================
// buildAttemptedEventRow / buildUnmatchedTopicEventRow / buildVerifiedEventRow
// -- same entity-resolution rule, none of these carry personal-data fields at
// all (design SS9's audit shape has no founder_claim/entity_match), so no
// fallback stripping is needed for them -- verified here anyway so a future
// edit that adds such a field trips a test, not a silent GDPR gap.
// ============================================================================

describe('buildAttemptedEventRow', () => {
  const row = { claim_id: 'c2', topic: 'company.sector', class: 'qualitative', derived_status: 'unverified', card_founder_id: null };
  const routing = { class: 'qualitative', check: null, matched_prefix: 'company.', unmatched_topic: false };
  const ctx = { applicationId: APPLICATION_ID, companyId: null, founderIds: [], runId: RUN_ID };

  test('mandatory event (design SS9): one per routed claim, application fallback when no founder', () => {
    const result = buildAttemptedEventRow(row, routing, 'unverified', ctx, '2026-01-01T00:00:00Z');
    assert.equal(result.event_type, 'claim_verification_attempted');
    assert.equal(result.entity_type, 'application');
    assert.equal(result.entity_id, APPLICATION_ID);
    assert.equal(result.payload.claim_id, 'c2');
  });

  test('optional extra fields (e.g. denominator deep_dive_questions) are merged into the payload without disturbing the required fields', () => {
    const result = buildAttemptedEventRow(row, routing, 'unverified', ctx, '2026-01-01T00:00:00Z', { deep_dive_questions: ['what is the denominator?'] });
    assert.deepEqual(result.payload.deep_dive_questions, ['what is the denominator?']);
    assert.equal(result.payload.claim_id, 'c2');
  });
});

describe('buildUnmatchedTopicEventRow', () => {
  test('router_unmatched_topic carries the raw topic string and resolves entity the same way', () => {
    const row = { claim_id: 'c3', topic: 'zzz_unknown', card_founder_id: FOUNDER_ID };
    const ctx = { applicationId: APPLICATION_ID, companyId: null, founderIds: [FOUNDER_ID], runId: RUN_ID };
    const result = buildUnmatchedTopicEventRow(row, ctx, '2026-01-01T00:00:00Z');
    assert.equal(result.event_type, 'router_unmatched_topic');
    assert.equal(result.entity_type, 'founder');
    assert.equal(result.entity_id, FOUNDER_ID);
    assert.equal(result.payload.topic, 'zzz_unknown');
  });
});

describe('buildVerifiedEventRow', () => {
  test('claim_verified carries source_url and the class/check audit fields', () => {
    const row = { claim_id: 'c4', topic: 'founder.execution.provenance', class: 'factual_static', derived_status: 'unverified', card_founder_id: FOUNDER_ID };
    const routing = { class: 'factual_static', check: 'gh_provenance', matched_prefix: 'founder.execution.provenance', unmatched_topic: false };
    const ctx = { applicationId: APPLICATION_ID, companyId: null, founderIds: [FOUNDER_ID], runId: RUN_ID };
    const result = buildVerifiedEventRow(row, routing, 'verified', 'https://github.com/example/repo', ctx, '2026-01-01T00:00:00Z');
    assert.equal(result.event_type, 'claim_verified');
    assert.equal(result.entity_type, 'founder');
    assert.equal(result.payload.source_url, 'https://github.com/example/repo');
    assert.equal(result.payload.verdict_after, 'verified');
  });
});

// ============================================================================
// buildEntityForRow -- the entity_gate.js input builder
// ============================================================================

describe('buildEntityForRow', () => {
  test('resolves founder name / company name / domain / aliases from the loaded entity context maps', () => {
    const founderById = new Map([[FOUNDER_ID, { id: FOUNDER_ID, full_name: 'Jane Founder' }]]);
    const companyById = new Map([['co1', { id: 'co1', name: 'Acme', domain: 'acme.example', aliases: ['acme-inc.example'] }]]);
    const row = { card_founder_id: FOUNDER_ID, card_company_id: 'co1' };
    const entity = buildEntityForRow(row, { founderById, companyById });
    assert.deepEqual(entity, {
      founderId: FOUNDER_ID,
      companyId: 'co1',
      founderName: 'Jane Founder',
      companyName: 'Acme',
      companyDomain: 'acme.example',
      companyAliases: ['acme-inc.example'],
    });
  });

  test('a card with neither FK resolves to an all-null/empty entity (no throw)', () => {
    const entity = buildEntityForRow({ card_founder_id: null, card_company_id: null }, { founderById: new Map(), companyById: new Map() });
    assert.deepEqual(entity, { founderId: null, companyId: null, founderName: null, companyName: null, companyDomain: null, companyAliases: [] });
  });
});

// ============================================================================
// extractSourceText -- the quote_guard call site's source-text extractor
// ============================================================================

describe('extractSourceText', () => {
  test('prefers `text` (deck_parse), falling through extracted_text/story_text/readme_excerpt/answer in order', () => {
    assert.equal(extractSourceText({ text: 'a', extracted_text: 'b' }), 'a');
    assert.equal(extractSourceText({ extracted_text: 'b', story_text: 'c' }), 'b');
    assert.equal(extractSourceText({ story_text: 'c' }), 'c');
    assert.equal(extractSourceText({ readme_excerpt: 'd' }), 'd');
    assert.equal(extractSourceText({ answer: 'e' }), 'e');
  });

  test('returns "" (never null/undefined) when nothing recognisable is present -- quote_guard treats an empty source as a no-op, not a crash', () => {
    assert.equal(extractSourceText({}), '');
    assert.equal(extractSourceText(null), '');
    assert.equal(extractSourceText('not an object'), '');
  });
});

// ============================================================================
// uuidArrayLiteral -- the Postgres `{...}` array-literal builder for `-v`
// substitution (`:'name'::uuid[]`)
// ============================================================================

describe('uuidArrayLiteral', () => {
  test('joins ids into a brace-delimited literal', () => {
    assert.equal(uuidArrayLiteral(['a', 'b', 'c']), '{a,b,c}');
  });

  test('an empty or non-array input produces the empty-array literal, never a throw', () => {
    assert.equal(uuidArrayLiteral([]), '{}');
    assert.equal(uuidArrayLiteral(null), '{}');
    assert.equal(uuidArrayLiteral(undefined), '{}');
  });

  test('falsy entries (null founder ids in a mixed list) are filtered out, not stringified as "null"', () => {
    assert.equal(uuidArrayLiteral(['a', null, 'b', undefined]), '{a,b}');
  });
});
