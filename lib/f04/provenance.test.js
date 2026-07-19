// lib/f04/provenance.test.js
//
// Tests for lib/f04/provenance.js (the provenance/hashing/curation half of
// the B1a/B1b split, per plan.md rev.2 Decision D1). Run with:
// node --test lib/f04/provenance.test.js (or `node --test lib/f04/*.test.js`
// for both scoring.test.js and provenance.test.js together).
//
// Test numbering below matches plan.md's B1b acceptance list (1-4) verbatim.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  tierForDomain,
  evidenceStrengthForDomain,
  independentDomainCount,
  independentSourceCount,
  contentHash,
  curate,
} = require('./provenance');

const curatedFixture = require('./fixtures/curated-results.json');
const competitorsFixture = require('./fixtures/competitors.json');

// ============================================================================
// B1b acceptance test 1 -- tierForDomain default-deny
// ============================================================================

describe('tierForDomain -- §3.4 default-deny', () => {
  test('an unknown/never-seen report-mill domain defaults to inferred (the design.md live-probe example)', () => {
    assert.equal(tierForDomain('https://astuteanalytica.com/whatever'), 'inferred');
  });

  test('a genuinely unrecognizable domain also defaults to inferred', () => {
    assert.equal(tierForDomain('https://some-random-startup-blog-nobody-has-heard-of.io/post'), 'inferred');
  });

  test('a malformed URL defaults to inferred rather than throwing', () => {
    assert.equal(tierForDomain('not a url'), 'inferred');
  });

  test('the report-mill blocklist resolves to inferred, including via a subdomain', () => {
    assert.equal(tierForDomain('https://www.grandviewresearch.com/industry-analysis/x'), 'inferred');
    assert.equal(tierForDomain('https://reports.mordorintelligence.com/x'), 'inferred');
  });

  test('named documented-tier domains resolve to documented, with the correct split strength', () => {
    assert.equal(tierForDomain('https://www.sec.gov/filing'), 'documented');
    assert.equal(evidenceStrengthForDomain('https://www.sec.gov/filing'), 0.90);
    assert.equal(tierForDomain('https://www.ft.com/content/x'), 'documented');
    assert.equal(evidenceStrengthForDomain('https://www.ft.com/content/x'), 0.80);
  });

  test('named discovered-tier domains resolve to discovered', () => {
    assert.equal(tierForDomain('https://github.com/acme/repo'), 'discovered');
    assert.equal(evidenceStrengthForDomain('https://github.com/acme/repo'), 0.60);
  });

  test('named low-signal forums resolve to inferred', () => {
    assert.equal(tierForDomain('https://www.reddit.com/r/startups'), 'inferred');
    assert.equal(tierForDomain('https://news.ycombinator.com/item?id=1'), 'inferred');
  });

  test('aha.org and jamanetwork.com resolve to documented, strength 0.90 -- live-probed genuine buyer-count anchors', () => {
    // Surfaced in a real Tavily Q1 query (team lead, 2026-07-19): aha.org
    // (American Hospital Association) is industry-association data,
    // jamanetwork.com (JAMA) is peer-reviewed work -- both already-named
    // §3.4 source classes at strength 0.90, not a new class.
    assert.equal(tierForDomain('https://www.aha.org/statistics'), 'documented');
    assert.equal(evidenceStrengthForDomain('https://www.aha.org/statistics'), 0.90);
    assert.equal(tierForDomain('https://jamanetwork.com/journals/jama/fullarticle/x'), 'documented');
    assert.equal(evidenceStrengthForDomain('https://jamanetwork.com/journals/jama/fullarticle/x'), 0.90);
  });
});

// ============================================================================
// B1b acceptance test 2 -- independentDomainCount: two report mills -> 1;
// a .co.uk pair and a subdomain pair handled by registrable domain, not string.
//
// NOTE on design.md's own worked example, flagged rather than silently
// resolved: §3.4 rule 2's prose says "two supporting rows from
// grandviewresearch.com and mordorintelligence.com count as one weak source,
// not two" -- but those ARE two distinct registrable domains, so a literal
// reading contradicts the rule's own definition ("independence is counted by
// distinct registrable domain"). independentDomainCount(urls) takes ONLY
// URLs -- no tier/strength data -- so it cannot implement "collapse same-TIER
// weak sources" (it has nothing to collapse on); it can only implement
// literal distinct-registrable-domain counting, which is what "two report
// mills" is tested as here: two DIFFERENT URLs on the SAME report-mill
// domain. Two DIFFERENT mill domains correctly count as 2 below.
// ============================================================================

describe('independentDomainCount -- §3.4 rule 2', () => {
  test('two URLs on the SAME report-mill domain count as 1', () => {
    assert.equal(
      independentDomainCount([
        'https://grandviewresearch.com/report-a',
        'https://grandviewresearch.com/report-b',
      ]),
      1,
    );
  });

  test('two DIFFERENT report-mill domains count as 2 -- distinct registrable domains are distinct sources', () => {
    // See the note above the describe block: design.md's own prose example
    // (these same two domains, claimed to count as "one weak source") is
    // inconsistent with "independence is counted by distinct registrable
    // domain" as literally stated, and independentDomainCount's signature
    // (URLs only, no tier) cannot implement the alternative "collapse by
    // tier" reading. Flagged to the team lead, not silently resolved.
    assert.equal(
      independentDomainCount([
        'https://grandviewresearch.com/report-a',
        'https://mordorintelligence.com/report-b',
      ]),
      2,
    );
  });

  test('a .co.uk pair collapses to the same registrable domain (public-suffix aware, not "last two labels")', () => {
    assert.equal(
      independentDomainCount([
        'https://shop.example.co.uk/page',
        'https://blog.example.co.uk/page',
      ]),
      1,
    );
    // and a genuinely different .co.uk registrant is a different domain
    assert.equal(
      independentDomainCount([
        'https://shop.example.co.uk/page',
        'https://shop.other-example.co.uk/page',
      ]),
      2,
    );
  });

  test('a subdomain pair on an ordinary TLD collapses to the same registrable domain', () => {
    assert.equal(
      independentDomainCount([
        'https://docs.github.com/x',
        'https://gist.github.com/y',
      ]),
      1,
    );
  });

  test('empty/absent input returns 0', () => {
    assert.equal(independentDomainCount([]), 0);
    assert.equal(independentDomainCount(undefined), 0);
  });

  test('malformed URLs are ignored, not counted or thrown on', () => {
    assert.equal(independentDomainCount(['not a url', 'https://example.com/a']), 1);
  });
});

// ============================================================================
// independentSourceCount -- §3.4 rule 2, corrected split (2a distinct
// registrable domain for documented/discovered + 2b tier collapse for
// inferred). Added after independentDomainCount's own tests surfaced a real
// defect in design.md's original rule-2 wording (two different report mills
// were claimed to count as one, contradicting "distinct registrable domain"
// literally) -- the team lead confirmed the finding and split the rule into
// 2a (this function's `documented`/`discovered` half, identical in spirit to
// independentDomainCount) and 2b (the `inferred`/report-mill collapse, which
// needs tier data independentDomainCount deliberately does not have).
// ============================================================================

describe('independentSourceCount -- §3.4 rule 2 (2a + 2b)', () => {
  test('two different report mills (both inferred) -> 1 -- tier collapse (2b)', () => {
    const count = independentSourceCount([
      { url: 'https://grandviewresearch.com/report-a', tier: 'inferred' },
      { url: 'https://mordorintelligence.com/report-b', tier: 'inferred' },
    ]);
    assert.equal(count, 1);
  });

  test('one documented + two different mills -> 2 (1 strong domain + 1 collapsed inferred)', () => {
    const count = independentSourceCount([
      { url: 'https://www.sec.gov/filing', tier: 'documented' },
      { url: 'https://grandviewresearch.com/report-a', tier: 'inferred' },
      { url: 'https://mordorintelligence.com/report-b', tier: 'inferred' },
    ]);
    assert.equal(count, 2);
  });

  test('three documented on distinct domains -> 3 -- distinct registrable domain (2a)', () => {
    const count = independentSourceCount([
      { url: 'https://www.sec.gov/filing', tier: 'documented' },
      { url: 'https://www.ft.com/content/x', tier: 'documented' },
      { url: 'https://github.com/acme/repo', tier: 'discovered' },
    ]);
    assert.equal(count, 3);
  });

  test('the same documented domain twice -> 1', () => {
    const count = independentSourceCount([
      { url: 'https://www.sec.gov/filing-a', tier: 'documented' },
      { url: 'https://sec.gov/filing-b', tier: 'documented' },
    ]);
    assert.equal(count, 1);
  });

  test('empty -> 0', () => {
    assert.equal(independentSourceCount([]), 0);
    assert.equal(independentSourceCount(undefined), 0);
  });

  test('tier=missing rows contribute nothing (no real URL per §3.5, and no tier collapse either)', () => {
    const count = independentSourceCount([
      { url: null, tier: 'missing' },
      { url: 'https://www.sec.gov/filing', tier: 'documented' },
    ]);
    assert.equal(count, 1);
  });

  test('a mix of many inferred sources still only contributes 1 to the total, regardless of count', () => {
    const count = independentSourceCount([
      { url: 'https://grandviewresearch.com/a', tier: 'inferred' },
      { url: 'https://mordorintelligence.com/b', tier: 'inferred' },
      { url: 'https://marketsandmarkets.com/c', tier: 'inferred' },
      { url: 'https://precedenceresearch.com/d', tier: 'inferred' },
    ]);
    assert.equal(count, 1);
  });
});

// ============================================================================
// B1b acceptance test 3 -- hash collisions/determinism, incl. two runs with
// the same pinned end_date -> identical raw_signals hashes.
// ============================================================================

describe('contentHash -- §3.5 recipes', () => {
  test('two different competitors in one run produce different claim hashes', () => {
    const base = { card_id: 'card-1', topic: 'competition.competitor', ai_run_id: 'run-1' };
    const h1 = contentHash.claim({ ...base, item_key: 'acme-inc' });
    const h2 = contentHash.claim({ ...base, item_key: 'globex-corp' });
    assert.notEqual(h1, h2);
  });

  test('the same claim inputs hash identically (determinism)', () => {
    const args = { card_id: 'card-1', topic: 'competition.competitor', ai_run_id: 'run-1', item_key: 'acme-inc' };
    assert.equal(contentHash.claim(args), contentHash.claim({ ...args }));
  });

  test('a re-run (new ai_run_id) produces a new claim hash, so scores.trend has history', () => {
    const h1 = contentHash.claim({ card_id: 'card-1', topic: 'market.size_bottom_up', ai_run_id: 'run-1', item_key: '_' });
    const h2 = contentHash.claim({ card_id: 'card-1', topic: 'market.size_bottom_up', ai_run_id: 'run-2', item_key: '_' });
    assert.notEqual(h1, h2);
  });

  test('two tier=missing evidence rows on one claim from different queries produce different evidence hashes', () => {
    const base = { claim_id: 'claim-1', relation: 'context', source_url: null, quote_verbatim: null };
    const h1 = contentHash.evidence({ ...base, query: 'buyer count query 1' });
    const h2 = contentHash.evidence({ ...base, query: 'buyer count query 2' });
    assert.notEqual(h1, h2);
  });

  test('two runs with the SAME pinned end_date produce IDENTICAL raw_signals hashes -- what makes select-by-hash work', () => {
    // §3.5: raw_signals.content_hash has no ai_run_id and no "now" component.
    // observed_at = coalesce(published_date, end_date) -- with end_date
    // pinned, a re-run of the demo must reuse the SAME raw_signals row rather
    // than insert a duplicate (which would then fail the NOT NULL UNIQUE
    // constraint via a bare INSERT, or silently diverge via ON CONFLICT DO
    // NOTHING returning zero rows over PostgREST -- exactly the failure mode
    // design.md §3.5 calls out). This is C0's headline failure mode if it varies.
    const pinnedEndDate = '2026-07-19T00:00:00Z';
    const run1 = contentHash.rawSignal({
      source: 'tavily_search',
      source_url: 'https://example.com/a',
      query: 'how many enterprise buyers in AI observability',
      observed_at: pinnedEndDate,
    });
    const run2 = contentHash.rawSignal({
      source: 'tavily_search',
      source_url: 'https://example.com/a',
      query: 'how many enterprise buyers in AI observability',
      observed_at: pinnedEndDate,
    });
    assert.equal(run1, run2);
  });

  test('a raw_signals hash differs on any field change', () => {
    const base = { source: 'tavily_search', source_url: 'https://example.com/a', query: 'q1', observed_at: '2026-07-19' };
    const h1 = contentHash.rawSignal(base);
    const h3 = contentHash.rawSignal({ ...base, query: 'q2' });
    assert.notEqual(h1, h3);
  });
});

// ============================================================================
// B1b acceptance test 4 -- curate: first-party URL at score 0.1 survives the
// relevance gate; the same first-party URL twice -> one row; blocklisted
// domain at score 0.9 -> dropped.
// ============================================================================

describe('curate -- §4', () => {
  test('a first-party URL at score 0.1 survives the relevance gate', () => {
    const results = [{ url: 'https://acme.com/pricing', score: 0.1 }];
    const survivors = curate(results, 'acme.com');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].firstParty, true);
  });

  test('the same first-party URL twice -> one row', () => {
    const results = [
      { url: 'https://acme.com/pricing', score: 0.1 },
      { url: 'https://acme.com/pricing', score: 0.1 },
    ];
    const survivors = curate(results, 'acme.com');
    assert.equal(survivors.length, 1);
  });

  test('a blocklisted domain at score 0.9 is dropped', () => {
    const results = [{ url: 'https://grandviewresearch.com/report', score: 0.9 }];
    const survivors = curate(results, null);
    assert.equal(survivors.length, 0);
  });

  test('filters out results below the 0.4 relevance gate', () => {
    const results = [
      { url: 'https://a.example.com/1', score: 0.5 },
      { url: 'https://b.example.com/1', score: 0.1 },
    ];
    const survivors = curate(results, null);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].url, 'https://a.example.com/1');
  });

  test('URL-normalised dedup collapses www/trailing-slash variants, keeping the higher score', () => {
    const results = [
      { url: 'https://Example.com/page/', score: 0.5 },
      { url: 'https://www.example.com/page', score: 0.8 },
    ];
    const survivors = curate(results, null);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].score, 0.8);
  });

  test('caps survivors at the top-8', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({ url: `https://site${i}.example.com/`, score: 0.5 + i * 0.01 }));
    const survivors = curate(results, null);
    assert.equal(survivors.length, 8);
    assert.equal(survivors[0].score, results[19].score); // sorted descending by score
  });

  test('empty input returns an empty array', () => {
    assert.deepEqual(curate([], null), []);
    assert.deepEqual(curate(undefined, null), []);
  });

  test('fixture: lib/f04/fixtures/curated-results.json matches its own recorded expectations', () => {
    const survivors = curate(curatedFixture.results, curatedFixture.company_domain);
    assert.deepEqual(survivors.map((s) => s.url), curatedFixture.expected.survivorUrlsInOrder);
  });
});

// ============================================================================
// Supporting coverage: the severity ladder's deterministic input shape, via
// the competitors fixture (design.md §8 -- feature 04 writes the mismatch,
// not the severity number itself here, but the fixture's own `foundCount`/
// `companyMentionedCount` are exactly what that ladder keys on).
// ============================================================================

describe('fixtures/competitors.json -- the "0 named, >=2 found" severity-ladder demo scenario', () => {
  test('every competitor in the fixture is unmentioned by the founder, and there are >=2 of them (=> material)', () => {
    const namedCount = competitorsFixture.competitors.filter((c) => c.company_mentioned).length;
    assert.equal(namedCount, competitorsFixture.companyMentionedCount);
    assert.equal(namedCount, 0);
    assert.ok(competitorsFixture.competitors.length >= 2);
    assert.equal(competitorsFixture.expectedSeverity, 'material');
  });

  test('threat_level and switching_cost are within their documented ranges (or null)', () => {
    for (const c of competitorsFixture.competitors) {
      if (c.threat_level !== null) assert.ok(c.threat_level >= 1 && c.threat_level <= 4);
      if (c.switching_cost !== null) assert.ok(c.switching_cost >= 1 && c.switching_cost <= 3);
    }
  });
});
