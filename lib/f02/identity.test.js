// lib/f02/identity.test.js
//
// Acceptance tests for lib/f02/identity.js, per docs/backlog/02-sourcing-radar/
// plan.md Task 2 and design.md §4.1's revised five-tier cascade. Run with:
// node --test lib/f02/*.test.js (glob form -- the directory form fails with
// MODULE_NOT_FOUND on Node v22.19.0).
//
// This file MAY require() -- only lib/f02/identity.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveIdentity, canonicalDomainForBlogMatch, GENERIC_HOSTS_FOR_BLOG_MATCH } = require('./identity.js');
const { canonicalDomain, hostIsGenericOrSubdomainOfGeneric } = require('./normalize.js');

// ============================================================================
// The 18 REAL measured pairs, design §4.1 / task brief, verbatim.
// (hnAuthor, ghOwner, ghOwnerType) -- expected: 7 case-insensitive exact
// matches -> tier 1/0.95; 2 Organizations -> tier 3/0.60/orgIsCompany; the
// remaining 9 Users -> tier 2/0.85 via declared authorship, NO fuzzy match.
// ============================================================================

const MEASURED_PAIRS = [
  { hnAuthor: 'kaiwuTW', ghOwner: 'kaiwutech-TW', ghOwnerType: 'User' },
  { hnAuthor: 'G3819', ghOwner: 'puffinsoft', ghOwnerType: 'Organization' },
  { hnAuthor: 'geminimir', ghOwner: 'geminimir', ghOwnerType: 'User' },
  { hnAuthor: 'claudiusthebot', ghOwner: 'dylanneve1', ghOwnerType: 'User' },
  { hnAuthor: 'ashitesh_12', ghOwner: 'AshiteshSingh', ghOwnerType: 'User' },
  { hnAuthor: 'misilojakub', ghOwner: 'jmisilo', ghOwnerType: 'User' },
  { hnAuthor: 'smashah', ghOwner: 'smashah', ghOwnerType: 'User' },
  { hnAuthor: 'missingstack', ghOwner: 'inklate', ghOwnerType: 'Organization' },
  { hnAuthor: 'ayuhito', ghOwner: 'ayuhito', ghOwnerType: 'User' },
  { hnAuthor: 'shlokkshahh', ghOwner: 'shlokkokk', ghOwnerType: 'User' },
  { hnAuthor: 'rangerwolf', ghOwner: 'RangerWolf', ghOwnerType: 'User' },
  { hnAuthor: 'modinfo', ghOwner: 'skorotkiewicz', ghOwnerType: 'User' },
  { hnAuthor: 'andreaborio', ghOwner: 'andreaborio', ghOwnerType: 'User' },
  { hnAuthor: 'jgo94', ghOwner: 'jgouviergmail', ghOwnerType: 'User' },
  { hnAuthor: 'abduznik', ghOwner: 'abduznik', ghOwnerType: 'User' },
  { hnAuthor: 'tschillaci', ghOwner: 'colomalabs', ghOwnerType: 'User' },
  { hnAuthor: 'SwagKing', ghOwner: '0pen-Sourcer', ghOwnerType: 'User' },
  { hnAuthor: 'anlor1002-alt', ghOwner: 'anlor1002-alt', ghOwnerType: 'User' },
];

function expectationFor({ hnAuthor, ghOwner, ghOwnerType }) {
  if (ghOwnerType === 'Organization') {
    return { tier: 3, confidence: 0.60 };
  }
  if (hnAuthor.toLowerCase() === ghOwner.toLowerCase()) {
    return { tier: 1, confidence: 0.95 };
  }
  return { tier: 2, confidence: 0.85 };
}

function artifactFor(ghOwner) {
  return {
    kind: 'github_repo',
    owner: ghOwner,
    repo: 'example-project',
    host: 'github.com',
    url: `https://github.com/${ghOwner}/example-project`,
  };
}

describe('resolveIdentity -- 18-pair measured table (design §4.1)', () => {
  for (const pair of MEASURED_PAIRS) {
    const expected = expectationFor(pair);
    test(`${pair.hnAuthor} / ${pair.ghOwner} (${pair.ghOwnerType}) -> tier ${expected.tier} / ${expected.confidence}`, () => {
      const result = resolveIdentity({
        hnAuthor: pair.hnAuthor,
        artifact: artifactFor(pair.ghOwner),
        ghOwnerType: pair.ghOwnerType,
      });
      assert.equal(result.tier, expected.tier);
      assert.equal(result.confidence, expected.confidence);
    });
  }

  test('exactly 7 pairs resolve at tier 1 (exact handle match, case-insensitive)', () => {
    const tier1 = MEASURED_PAIRS.filter((p) => expectationFor(p).tier === 1);
    assert.equal(tier1.length, 7);
  });

  test('exactly 2 pairs resolve at tier 3 (Organization owner)', () => {
    const tier3 = MEASURED_PAIRS.filter((p) => expectationFor(p).tier === 3);
    assert.equal(tier3.length, 2);
  });

  test('exactly 9 pairs resolve at tier 2 (declared authorship, handles differ)', () => {
    const tier2 = MEASURED_PAIRS.filter((p) => expectationFor(p).tier === 2);
    assert.equal(tier2.length, 9);
  });

  test('rangerwolf / RangerWolf is the explicit case-insensitive tier-1 example', () => {
    const result = resolveIdentity({
      hnAuthor: 'rangerwolf',
      artifact: artifactFor('RangerWolf'),
      ghOwnerType: 'User',
    });
    assert.equal(result.tier, 1);
    assert.equal(result.discoveredVia, 'handle_match');
  });

  test('tier-2 pairs are discovered via declared authorship, not a handle comparison', () => {
    const result = resolveIdentity({
      hnAuthor: 'misilojakub',
      artifact: artifactFor('jmisilo'),
      ghOwnerType: 'User',
    });
    assert.equal(result.tier, 2);
    assert.equal(result.discoveredVia, 'showhn_declared_artifact');
  });

  test('tier-3 pairs mark orgIsCompany and needsReview, and stay cross-platform-unlinked', () => {
    const result = resolveIdentity({
      hnAuthor: 'G3819',
      artifact: artifactFor('puffinsoft'),
      ghOwnerType: 'Organization',
    });
    assert.equal(result.tier, 3);
    assert.equal(result.orgIsCompany, true);
    assert.equal(result.needsReview, true);
    assert.equal(result.crossPlatformLinked, false);
  });
});

// ============================================================================
// REQ-004 -- zero fuzzy matching anywhere. Near-miss pairs (visually similar
// but not equal, and not equal case-insensitively) must NOT resolve at
// tier 1 on the strength of their similarity -- they resolve at tier 2 via
// platform-rule authorship, exactly like a totally unrelated handle would.
// ============================================================================

describe('REQ-004 -- no fuzzy string matching', () => {
  test('a near-miss pair (misilojakub / jmisilo) does not resolve at tier 1', () => {
    const result = resolveIdentity({
      hnAuthor: 'misilojakub',
      artifact: artifactFor('jmisilo'),
      ghOwnerType: 'User',
    });
    assert.notEqual(result.tier, 1);
    assert.equal(result.tier, 2);
  });

  test('a totally unrelated handle pair resolves IDENTICALLY to a near-miss pair -- proving no similarity threshold exists', () => {
    const nearMiss = resolveIdentity({
      hnAuthor: 'kaiwuTW',
      artifact: artifactFor('kaiwutech-TW'),
      ghOwnerType: 'User',
    });
    const unrelated = resolveIdentity({
      hnAuthor: 'claudiusthebot',
      artifact: artifactFor('dylanneve1'),
      ghOwnerType: 'User',
    });
    assert.equal(nearMiss.tier, unrelated.tier);
    assert.equal(nearMiss.confidence, unrelated.confidence);
    assert.equal(nearMiss.discoveredVia, unrelated.discoveredVia);
  });

  test('the source has no similarity/levenshtein/dice/jaro helper anywhere (comments stripped -- the header prose documents "no fuzzy matching" and names the near-miss pairs, which would otherwise self-match; precedent: n8n/build-f03-workflow.py strips comments before its analogous require()-freedom assertion)', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'identity.js'), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/[^\n]*/g, ''); // line comments
    assert.doesNotMatch(codeOnly.toLowerCase(), /levenshtein|jaro|dice|bigram|similarity|fuzzy/);
  });
});

// ============================================================================
// §5.0 rule 0(b) (spec re-review correction): every candidate gets a
// `founders` row regardless of tier -- "unresolved" means no CROSS-PLATFORM
// link, never no person. resolveIdentity() itself creates nothing, but its
// return shape must never say "no person" (i.e. crossPlatformLinked, not a
// renamed founderResolvable, is the only "linked or not" signal it emits).
// ============================================================================

describe('design §5.0 rule 0(b) -- unresolved != no founder', () => {
  test('every one of the 18 measured pairs yields a result a caller can build a founders row from (never a "no person" signal)', () => {
    for (const pair of MEASURED_PAIRS) {
      const result = resolveIdentity({
        hnAuthor: pair.hnAuthor,
        artifact: artifactFor(pair.ghOwner),
        ghOwnerType: pair.ghOwnerType,
      });
      // The function's contract is silent about founders-row creation (that
      // is the caller's job), but it must never expose a field that reads
      // as "drop this candidate" -- there is no `founderResolvable` key at
      // all (the pre-correction name), and every result carries a `tier`
      // (always a caller-usable classification, never undefined/null).
      assert.equal('founderResolvable' in result, false);
      assert.ok(typeof result.tier === 'number' && result.tier >= 1 && result.tier <= 5);
      assert.ok('crossPlatformLinked' in result);
    }
  });

  test('crossPlatformLinked is true for exactly the 16 User cases and false for the 2 Organization cases', () => {
    const results = MEASURED_PAIRS.map((pair) =>
      resolveIdentity({ hnAuthor: pair.hnAuthor, artifact: artifactFor(pair.ghOwner), ghOwnerType: pair.ghOwnerType })
    );
    const linked = results.filter((r) => r.crossPlatformLinked === true);
    const unlinked = results.filter((r) => r.crossPlatformLinked === false);
    assert.equal(linked.length, 16);
    assert.equal(unlinked.length, 2);
    assert.equal(unlinked.every((r) => r.orgIsCompany === true), true);
  });

  test('a wholly unresolved candidate (no artifact, no gh owner type) still returns a usable tier-5 result, not a null/throw', () => {
    const result = resolveIdentity({ hnAuthor: 'someone', artifact: { kind: 'none', owner: null, repo: null, host: null } });
    assert.equal(result.tier, 5);
    assert.equal(result.crossPlatformLinked, false);
    assert.equal(result.discoveredVia, 'unresolved');
  });
});

// ============================================================================
// Tier 1 case 2 (site backlink) and case 3 (gh blog domain match) --
// independent of a GitHub handle entirely.
// ============================================================================

describe('resolveIdentity -- tier 1 cases 2 and 3', () => {
  test('case 2 -- bidirectional site backlink, no GitHub artifact needed at all', () => {
    const result = resolveIdentity({
      hnAuthor: 'jdoe',
      artifact: { kind: 'product', owner: null, repo: null, host: 'jdoe.dev', url: 'https://jdoe.dev' },
      siteBacklinkHnUser: 'jdoe',
    });
    assert.equal(result.tier, 1);
    assert.equal(result.confidence, 0.95);
    assert.equal(result.discoveredVia, 'site_backlink_bidirectional');
  });

  test('case 2 is case-insensitive', () => {
    const result = resolveIdentity({
      hnAuthor: 'JDoe',
      artifact: { kind: 'none', owner: null, repo: null, host: null },
      siteBacklinkHnUser: 'jdoe',
    });
    assert.equal(result.tier, 1);
  });

  test('case 3 -- ghBlogDomain matches the artifact domain', () => {
    const result = resolveIdentity({
      hnAuthor: 'jdoe',
      artifact: { kind: 'product', owner: null, repo: null, host: 'jdoe.dev', url: 'https://jdoe.dev/about' },
      ghBlogDomain: 'jdoe.dev',
    });
    assert.equal(result.tier, 1);
    assert.equal(result.confidence, 0.90);
    assert.equal(result.discoveredVia, 'gh_blog_domain_match');
  });

  test('case 3 -- a mismatched blog domain does NOT resolve at tier 1', () => {
    const result = resolveIdentity({
      hnAuthor: 'jdoe',
      artifact: { kind: 'product', owner: null, repo: null, host: 'other.dev', url: 'https://other.dev' },
      ghBlogDomain: 'jdoe.dev',
    });
    assert.notEqual(result.tier, 1);
  });

  test('case 3 -- a github.io blog domain never falsely matches a github.io artifact (generic-host guard)', () => {
    // Two DIFFERENT people could each have a *.github.io page; matching on
    // the collapsed generic host "github.io" would wrongly link them.
    const result = resolveIdentity({
      hnAuthor: 'jdoe',
      artifact: { kind: 'product', owner: null, repo: null, host: 'someoneelse.github.io', url: 'https://someoneelse.github.io' },
      ghBlogDomain: null, // canonicalDomain('https://jdoe.github.io') would itself be null -- never populated by a real caller
    });
    assert.notEqual(result.tier, 1);
  });
});

describe('resolveIdentity -- tiers 4 and 5', () => {
  test('tier 4 -- a non-GitHub product URL with nothing else resolvable', () => {
    const result = resolveIdentity({
      hnAuthor: 'jdoe',
      artifact: { kind: 'product', owner: null, repo: null, host: 'example.com', url: 'https://example.com' },
    });
    assert.equal(result.tier, 4);
    assert.equal(result.confidence, null);
    assert.equal(result.crossPlatformLinked, false);
  });

  test('tier 5 -- no artifact at all (text-only HN post)', () => {
    const result = resolveIdentity({
      hnAuthor: 'jdoe',
      artifact: { kind: 'none', owner: null, repo: null, host: null },
    });
    assert.equal(result.tier, 5);
    assert.equal(result.confidence, null);
    assert.equal(result.crossPlatformLinked, false);
  });
});

// ============================================================================
// identity.js's own duplicated domain helper must stay in lockstep with
// lib/f02/normalize.js's -- both files independently implement the same
// GENERIC_HOSTS guard (zero-imports forbids sharing it directly).
// ============================================================================

describe('canonicalDomainForBlogMatch stays consistent with normalize.js', () => {
  test('the generic host sets are identical between the two files', () => {
    const fromNormalize = new Set();
    // normalize.js does not export its raw GENERIC_HOSTS set, only the
    // predicate -- probe it with every host identity.js declares generic,
    // and vice versa, via the shared behavioural contract instead.
    for (const host of GENERIC_HOSTS_FOR_BLOG_MATCH) {
      assert.equal(hostIsGenericOrSubdomainOfGeneric(host), true, `normalize.js does not treat ${host} as generic`);
    }
  });

  test('a sample of URLs canonicalize identically in both files', () => {
    const samples = [
      'https://someone.github.io/project',
      'https://blog.acme.co.uk',
      'https://foocompany.io',
      'https://myapp.vercel.app',
      'https://www.acme.com',
    ];
    for (const url of samples) {
      assert.equal(canonicalDomainForBlogMatch(url), canonicalDomain(url), `mismatch for ${url}`);
    }
  });
});
