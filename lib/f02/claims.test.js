// lib/f02/claims.test.js
//
// Acceptance tests for lib/f02/claims.js, per docs/backlog/02-sourcing-radar/
// plan.md Task 3 and design.md §5.0/§5.1. Run with:
// node --test lib/f02/*.test.js (glob form -- the directory form fails with
// MODULE_NOT_FOUND on Node v22.19.0).
//
// This file MAY require() -- only lib/f02/claims.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { TOPIC, PRODUCERS, assertClaimWellFormed } = require('./claims.js');

const ALL_SLUGS = [
  'founder.execution.merged_pr_foreign',
  'founder.execution.commit_consistency',
  'founder.execution.live_product',
  'founder.execution.external_usage',
  'founder.execution.provenance',
  'founder.expertise.vertical_tenure',
  'founder.expertise.insight_specificity',
  'founder.expertise.unasked_work',
  'founder.leadership.written_communication',
];

describe('TOPIC -- exact slug strings, design §5.1', () => {
  test('every slug in §5.1 is present, spelled exactly', () => {
    const values = Object.values(TOPIC).sort();
    assert.deepEqual(values, ALL_SLUGS.slice().sort());
  });

  test('there are exactly 9 slugs -- no more, no fewer', () => {
    assert.equal(Object.keys(TOPIC).length, 9);
  });
});

describe('PRODUCERS -- every slug has a producing function', () => {
  for (const slug of ALL_SLUGS) {
    test(`a producer exists for ${slug}`, () => {
      assert.equal(typeof PRODUCERS[slug], 'function');
    });
  }
});

// ============================================================================
// Per-slug fixtures: [slug, producerRef, presentFact, absentButAttemptedFact]
// "presentFact" makes a real claim; "absentButAttemptedFact" makes a
// missing-marker (attempted but nothing found). Both always carry
// rawSignalRef, since design §5.0 rule 2.3 gates on it FIRST.
// ============================================================================

const FIXTURES = [
  {
    slug: TOPIC.EXECUTION_MERGED_PR_FOREIGN,
    fn: PRODUCERS[TOPIC.EXECUTION_MERGED_PR_FOREIGN],
    present: { attempted: true, rawSignalRef: 'rs-1', mergedForeignPrCount: 3, sourceUrl: 'https://github.com/octocat' },
    absent: { attempted: true, rawSignalRef: 'rs-1', mergedForeignPrCount: 0 },
  },
  {
    slug: TOPIC.EXECUTION_COMMIT_CONSISTENCY,
    fn: PRODUCERS[TOPIC.EXECUTION_COMMIT_CONSISTENCY],
    present: { attempted: true, rawSignalRef: 'rs-2', weeksWithCommitCount: 9, weeksObserved: 12 },
    absent: { attempted: true, rawSignalRef: 'rs-2' },
  },
  {
    slug: TOPIC.EXECUTION_LIVE_PRODUCT,
    fn: PRODUCERS[TOPIC.EXECUTION_LIVE_PRODUCT],
    present: { attempted: true, rawSignalRef: 'rs-3', status: 'live', sourceUrl: 'https://example.com' },
    absent: { attempted: true, rawSignalRef: 'rs-3', status: 'bogus-status' },
  },
  {
    slug: TOPIC.EXECUTION_EXTERNAL_USAGE,
    fn: PRODUCERS[TOPIC.EXECUTION_EXTERNAL_USAGE],
    present: { attempted: true, rawSignalRef: 'rs-4', forkCount: 5, dependentsCount: 2, releaseDownloadCount: 100 },
    absent: { attempted: true, rawSignalRef: 'rs-4' },
  },
  {
    slug: TOPIC.EXECUTION_PROVENANCE,
    fn: PRODUCERS[TOPIC.EXECUTION_PROVENANCE],
    present: {
      attempted: true,
      rawSignalRef: 'rs-5',
      repoCreatedAt: '2025-01-01T00:00:00Z',
      firstCommitAt: '2025-01-02T00:00:00Z',
      accountCreatedAt: '2020-01-01T00:00:00Z',
    },
    absent: { attempted: true, rawSignalRef: 'rs-5' },
  },
  {
    slug: TOPIC.EXPERTISE_VERTICAL_TENURE,
    fn: PRODUCERS[TOPIC.EXPERTISE_VERTICAL_TENURE],
    present: { attempted: true, rawSignalRef: 'rs-6', quoteVerbatim: '5 years building developer tools.' },
    absent: { attempted: true, rawSignalRef: 'rs-6' },
  },
  {
    slug: TOPIC.EXPERTISE_INSIGHT_SPECIFICITY,
    fn: PRODUCERS[TOPIC.EXPERTISE_INSIGHT_SPECIFICITY],
    present: { attempted: true, rawSignalRef: 'rs-7', quoteVerbatim: 'Postgres WAL replay is the actual bottleneck, not the index.' },
    absent: { attempted: true, rawSignalRef: 'rs-7' },
  },
  {
    slug: TOPIC.EXPERTISE_UNASKED_WORK,
    fn: PRODUCERS[TOPIC.EXPERTISE_UNASKED_WORK],
    present: { attempted: true, rawSignalRef: 'rs-8', earliestArtifactDate: '2022-03-01' },
    absent: { attempted: true, rawSignalRef: 'rs-8' },
  },
  {
    slug: TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION,
    fn: PRODUCERS[TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION],
    present: { attempted: true, rawSignalRef: 'rs-9', quoteVerbatim: 'Show HN: I built this after three failed attempts.' },
    absent: { attempted: true, rawSignalRef: 'rs-9' },
  },
];

describe('claims producers -- design §5.0 rule 2, per slug', () => {
  for (const { slug, fn } of FIXTURES) {
    describe(slug, () => {
      test('no attempt at all -> null, no claim (rule 2.3)', () => {
        assert.equal(fn(null), null);
        assert.equal(fn({ attempted: false }), null);
        assert.equal(fn({ attempted: true, mergedForeignPrCount: 3 }), null); // attempted but no rawSignalRef
      });

      test('attempted but the fact is absent -> a well-formed missing-marker claim, never a throw', () => {
        const fixture = FIXTURES.find((f) => f.slug === slug);
        const claim = fn(fixture.absent);
        assert.notEqual(claim, null);
        assert.equal(claim.topic, slug);
        assert.equal(claim.evidence.tier, 'missing');
        assert.equal(claim.evidence.relation, 'context');
        assert.equal(claim.evidence.quote_verbatim, null);
        assert.equal(claim.evidence.raw_signal_ref, fixture.absent.rawSignalRef);
        assert.doesNotThrow(() => assertClaimWellFormed(claim));
        // db/schema.sql: `claims.text_verbatim text NOT NULL` -- a missing
        // marker must never leave this null, or the row fails to insert.
        // The absence lives on evidence.quote_verbatim (asserted above),
        // never on claims.text_verbatim.
        assert.equal(typeof claim.text_verbatim, 'string');
        assert.ok(claim.text_verbatim.length > 0);
      });

      test('attempted and the fact IS present -> a well-formed real claim', () => {
        const fixture = FIXTURES.find((f) => f.slug === slug);
        const claim = fn(fixture.present);
        assert.notEqual(claim, null);
        assert.equal(claim.topic, slug);
        assert.equal(claim.source_kind, 'public');
        assert.notEqual(claim.evidence.tier, 'missing');
        assert.equal(claim.evidence.relation, 'supports');
        assert.equal(claim.evidence.raw_signal_ref, fixture.present.rawSignalRef);
        assert.doesNotThrow(() => assertClaimWellFormed(claim));
      });

      test('never produces a not_met-shaped claim -- there is no verdict field at all', () => {
        const fixture = FIXTURES.find((f) => f.slug === slug);
        const claim = fn(fixture.present);
        assert.equal('verdict' in claim, false);
        assert.equal('value' in claim, true); // present (possibly null), never a bare "not_met" string
      });
    });
  }
});

describe('claims producers -- evidence.tier defaulting (design §5.0 field defaults)', () => {
  test('github_api-sourced facts default to tier=documented', () => {
    const claim = PRODUCERS[TOPIC.EXECUTION_MERGED_PR_FOREIGN]({ attempted: true, rawSignalRef: 'r', mergedForeignPrCount: 1 });
    assert.equal(claim.evidence.tier, 'documented');
  });

  test('tavily_extract-sourced facts default to tier=discovered', () => {
    const claim = PRODUCERS[TOPIC.EXPERTISE_VERTICAL_TENURE]({ attempted: true, rawSignalRef: 'r', quoteVerbatim: 'quote' });
    assert.equal(claim.evidence.tier, 'discovered');
  });

  test('hn_algolia-sourced facts default to tier=documented', () => {
    const claim = PRODUCERS[TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION]({
      attempted: true,
      rawSignalRef: 'r',
      quoteVerbatim: 'quote',
      source: 'hn_algolia',
    });
    assert.equal(claim.evidence.tier, 'documented');
  });

  test('identity-link confidence < 0.85 forces tier to inferred, regardless of source', () => {
    const claim = PRODUCERS[TOPIC.EXECUTION_MERGED_PR_FOREIGN](
      { attempted: true, rawSignalRef: 'r', mergedForeignPrCount: 1 },
      { identityConfidence: 0.60 }
    );
    assert.equal(claim.evidence.tier, 'inferred');
  });

  test('identity-link confidence >= 0.85 does NOT force inferred', () => {
    const claim = PRODUCERS[TOPIC.EXECUTION_MERGED_PR_FOREIGN](
      { attempted: true, rawSignalRef: 'r', mergedForeignPrCount: 1 },
      { identityConfidence: 0.90 }
    );
    assert.equal(claim.evidence.tier, 'documented');
  });

  test('a missing identityConfidence does not force inferred (defaults apply)', () => {
    const claim = PRODUCERS[TOPIC.EXECUTION_MERGED_PR_FOREIGN]({ attempted: true, rawSignalRef: 'r', mergedForeignPrCount: 1 });
    assert.equal(claim.evidence.tier, 'documented');
  });
});

describe('assertClaimWellFormed -- design §5.0 rule 2 enforcement', () => {
  test('throws on a claim with no evidence.raw_signal_ref', () => {
    const malformed = {
      topic: 'founder.execution.merged_pr_foreign',
      text_verbatim: 'x',
      value: null,
      source_kind: 'public',
      base_confidence: 0.9,
      evidence: { tier: 'documented', relation: 'supports', quote_verbatim: null, source_url: null, raw_signal_ref: null },
    };
    assert.throws(() => assertClaimWellFormed(malformed), /raw_signal_ref/);
  });

  test('throws on a claim with an empty-string raw_signal_ref', () => {
    const malformed = {
      topic: 'x',
      evidence: { tier: 'documented', relation: 'supports', quote_verbatim: null, source_url: null, raw_signal_ref: '' },
    };
    assert.throws(() => assertClaimWellFormed(malformed), /raw_signal_ref/);
  });

  test('throws on a missing evidence object entirely', () => {
    assert.throws(() => assertClaimWellFormed({ topic: 'x' }), /evidence/);
  });

  test('throws on an invalid evidence.tier', () => {
    assert.throws(
      () =>
        assertClaimWellFormed({
          topic: 'x',
          evidence: { tier: 'bogus', relation: 'supports', quote_verbatim: null, source_url: null, raw_signal_ref: 'r' },
        }),
      /tier/
    );
  });

  test("throws when a 'missing' marker carries a non-null quote_verbatim", () => {
    assert.throws(
      () =>
        assertClaimWellFormed({
          topic: 'x',
          evidence: { tier: 'missing', relation: 'context', quote_verbatim: 'should be null', source_url: null, raw_signal_ref: 'r' },
        }),
      /quote_verbatim/
    );
  });

  test("throws when a 'missing' marker has relation != 'context'", () => {
    assert.throws(
      () =>
        assertClaimWellFormed({
          topic: 'x',
          evidence: { tier: 'missing', relation: 'supports', quote_verbatim: null, source_url: null, raw_signal_ref: 'r' },
        }),
      /relation/
    );
  });

  test('accepts a well-formed real claim and a well-formed missing-marker claim', () => {
    const real = {
      topic: 'x',
      evidence: { tier: 'documented', relation: 'supports', quote_verbatim: 'q', source_url: 'https://x', raw_signal_ref: 'r' },
    };
    const missing = {
      topic: 'x',
      evidence: { tier: 'missing', relation: 'context', quote_verbatim: null, source_url: null, raw_signal_ref: 'r' },
    };
    assert.equal(assertClaimWellFormed(real), true);
    assert.equal(assertClaimWellFormed(missing), true);
  });
});

describe('external_usage never accepts stars as a usage input (SIG-014)', () => {
  test('a stargazerCount field on the input fact has no effect on the output', () => {
    const withoutStars = PRODUCERS[TOPIC.EXECUTION_EXTERNAL_USAGE]({
      attempted: true,
      rawSignalRef: 'r',
      forkCount: 5,
    });
    const withStars = PRODUCERS[TOPIC.EXECUTION_EXTERNAL_USAGE]({
      attempted: true,
      rawSignalRef: 'r',
      forkCount: 5,
      stargazerCount: 99999,
    });
    assert.deepEqual(withoutStars, withStars);
  });
});
