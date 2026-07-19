// lib/f02/normalize.test.js
//
// Acceptance tests for lib/f02/normalize.js, per docs/backlog/02-sourcing-radar/
// plan.md Task 1. Run with: node --test lib/f02/*.test.js (glob form -- the
// directory form fails with MODULE_NOT_FOUND on Node v22.19.0).
//
// This file MAY require() -- only lib/f02/normalize.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { contentHash, canonicalDomain, normalizeName, parseArtifactUrl } = require('./normalize.js');

describe('contentHash -- design §6.1', () => {
  test('returns a 64-char lowercase hex string (sha256)', async () => {
    const h = await contentHash(['hn_algolia', '48964105']);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('is stable across repeated calls with the same input', async () => {
    const a = await contentHash(['github_api', 'octocat', '2026-07-19T00:00:00Z']);
    const b = await contentHash(['github_api', 'octocat', '2026-07-19T00:00:00Z']);
    assert.equal(a, b);
  });

  test('argument ORDER matters -- reordering the same parts changes the hash', async () => {
    const a = await contentHash(['a', 'b', 'c']);
    const b = await contentHash(['c', 'b', 'a']);
    assert.notEqual(a, b);
  });

  test('the join delimiter prevents a naive concatenation collision ("ab"+"c" vs "a"+"bc")', async () => {
    const a = await contentHash(['ab', 'c']);
    const b = await contentHash(['a', 'bc']);
    assert.notEqual(a, b);
  });

  test('a bare non-array value is treated as a single-element array', async () => {
    const a = await contentHash('solo-part');
    const b = await contentHash(['solo-part']);
    assert.equal(a, b);
  });

  test('null/undefined parts hash as empty string, not the literal "null"/"undefined"', async () => {
    const a = await contentHash(['x', null, 'y']);
    const b = await contentHash(['x', '', 'y']);
    assert.equal(a, b);
  });

  test('the composite-id shape from design §6.1 examples is a valid basis', async () => {
    const h = await contentHash(['hn_algolia', '48964105']);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('canonicalDomain -- design §4.1 generic-host guard', () => {
  test('a github.io page must NOT become a company domain', () => {
    assert.equal(canonicalDomain('https://someone.github.io/my-project'), null);
    assert.equal(canonicalDomain('https://someone.github.io'), null);
  });

  test('bare generic hosts from the task brief list all return null', () => {
    const genericUrls = [
      'https://github.com/octocat/hello',
      'https://gitlab.com/octocat/hello',
      'https://myapp.vercel.app',
      'https://myapp.netlify.app',
      'https://myapp.pages.dev',
      'https://someone.notion.site',
      'https://someone.substack.com',
      'https://medium.com/@someone',
      'https://www.linkedin.com/in/someone',
      'https://twitter.com/someone',
      'https://x.com/someone',
      'https://www.producthunt.com/posts/foo',
      'https://www.ycombinator.com/companies/foo',
      'https://chromewebstore.google.com/detail/foo',
      'https://apps.apple.com/us/app/foo',
      'https://play.google.com/store/apps/details?id=foo',
      'https://huggingface.co/someone',
      'https://myapp.replit.app',
      'https://myapp.streamlit.app',
      'https://myapp.herokuapp.com',
    ];
    for (const url of genericUrls) {
      assert.equal(canonicalDomain(url), null, `expected null for ${url}`);
    }
  });

  test('a 3-label generic host (chromewebstore.google.com) does not collapse to a false "google.com" company domain', () => {
    assert.equal(canonicalDomain('https://chromewebstore.google.com/detail/xyz'), null);
  });

  test('subdomain collapse -- ordinary TLD: sub.acme.com -> acme.com', () => {
    assert.equal(canonicalDomain('https://blog.acme.com'), 'acme.com');
    assert.equal(canonicalDomain('https://a.b.acme.com'), 'acme.com');
  });

  test('subdomain collapse -- multi-part public suffix: sub.acme.co.uk -> acme.co.uk', () => {
    assert.equal(canonicalDomain('https://blog.acme.co.uk'), 'acme.co.uk');
  });

  test('multi-part public suffixes: com.au, co.jp', () => {
    assert.equal(canonicalDomain('https://shop.acme.com.au'), 'acme.com.au');
    assert.equal(canonicalDomain('https://acme.co.jp'), 'acme.co.jp');
  });

  test('leading www. is stripped before reduction', () => {
    assert.equal(canonicalDomain('https://www.acme.com'), 'acme.com');
  });

  test('a genuine two-label domain on a non-generic TLD is returned as-is', () => {
    assert.equal(canonicalDomain('https://foocompany.io'), 'foocompany.io');
  });

  test('a scheme-less host is accepted (http:// is assumed)', () => {
    assert.equal(canonicalDomain('acme.com'), 'acme.com');
  });

  test('null/undefined/empty input returns null, not a throw', () => {
    assert.equal(canonicalDomain(null), null);
    assert.equal(canonicalDomain(undefined), null);
    assert.equal(canonicalDomain(''), null);
    assert.equal(canonicalDomain('   '), null);
  });

  test('a bare host with no dot returns null', () => {
    assert.equal(canonicalDomain('localhost'), null);
  });

  test('a malformed URL returns null rather than throwing', () => {
    assert.equal(canonicalDomain('http://['), null);
  });
});

describe('normalizeName', () => {
  test('lowercases, trims and collapses whitespace', () => {
    assert.equal(normalizeName('  Acme   Widgets  '), 'acme widgets');
  });

  test('strips a single trailing legal suffix', () => {
    assert.equal(normalizeName('Acme Inc'), 'acme');
    assert.equal(normalizeName('Acme Ltd'), 'acme');
    assert.equal(normalizeName('Acme LLC'), 'acme');
    assert.equal(normalizeName('Acme GmbH'), 'acme');
  });

  test('strips a single trailing AI-era suffix', () => {
    assert.equal(normalizeName('Acme AI'), 'acme');
    assert.equal(normalizeName('Acme Labs'), 'acme');
    assert.equal(normalizeName('Acme Technologies'), 'acme');
    assert.equal(normalizeName('Acme Technology'), 'acme');
    assert.equal(normalizeName('Acme HQ'), 'acme');
  });

  test('strips MULTIPLE trailing suffixes iteratively', () => {
    assert.equal(normalizeName('Acme Labs Inc'), 'acme');
    assert.equal(normalizeName('Acme AI Technologies'), 'acme');
  });

  test('a suffix that is not trailing is left alone', () => {
    assert.equal(normalizeName('AI for Acme'), 'ai for acme');
  });

  test('empty/null input returns empty string, not a throw', () => {
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName(null), '');
    assert.equal(normalizeName(undefined), '');
  });
});

describe('parseArtifactUrl -- the four kinds', () => {
  test('github_repo -- github.com/{owner}/{repo}', () => {
    assert.deepEqual(parseArtifactUrl('https://github.com/octocat/hello-world'), {
      kind: 'github_repo',
      owner: 'octocat',
      repo: 'hello-world',
      host: 'github.com',
    });
  });

  test('github_repo -- extra path segments after the repo are ignored', () => {
    const result = parseArtifactUrl('https://github.com/octocat/hello-world/tree/main/src');
    assert.equal(result.kind, 'github_repo');
    assert.equal(result.owner, 'octocat');
    assert.equal(result.repo, 'hello-world');
  });

  test('github_repo -- a trailing .git is stripped from the repo name', () => {
    const result = parseArtifactUrl('https://github.com/octocat/hello-world.git');
    assert.equal(result.repo, 'hello-world');
  });

  test('github_user -- github.com/{owner} with no repo segment', () => {
    assert.deepEqual(parseArtifactUrl('https://github.com/octocat'), {
      kind: 'github_user',
      owner: 'octocat',
      repo: null,
      host: 'github.com',
    });
  });

  test('product -- any non-github.com URL', () => {
    const result = parseArtifactUrl('https://myapp.example.com/landing');
    assert.equal(result.kind, 'product');
    assert.equal(result.owner, null);
    assert.equal(result.repo, null);
    assert.equal(result.host, 'myapp.example.com');
  });

  test('none -- no URL at all', () => {
    assert.deepEqual(parseArtifactUrl(null), { kind: 'none', owner: null, repo: null, host: null });
    assert.deepEqual(parseArtifactUrl(''), { kind: 'none', owner: null, repo: null, host: null });
    assert.deepEqual(parseArtifactUrl(undefined), { kind: 'none', owner: null, repo: null, host: null });
  });

  test('none -- a bare github.com URL with no owner segment resolves nothing', () => {
    const result = parseArtifactUrl('https://github.com');
    assert.equal(result.kind, 'none');
    assert.equal(result.owner, null);
  });

  test('a malformed URL resolves to none rather than throwing', () => {
    assert.equal(parseArtifactUrl('http://[').kind, 'none');
  });
});
