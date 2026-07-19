// lib/f02/ethics.test.js
//
// Tests for lib/f02/ethics.js -- design.md §7's two claimed-as-demonstrable
// mechanisms. Run: node --test lib/f02/*.test.js (glob form; the directory
// form fails with MODULE_NOT_FOUND on Node v22.19.0).
//
// This file MAY require() -- only lib/f02/ethics.js itself must stay
// import-free, since it gets pasted verbatim into an n8n Code node.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRobotsTxt, isCrawlAllowed, checkRobots, crawlSkippedEvent, isOptedOut,
} = require('./ethics.js');

const UA = 'vcbrain-radar';

// A stub fetch. Never touches the network -- the whole point of injecting it.
function stubFetch(map) {
  return async function (url) {
    if (!(url in map)) throw new Error('ENOTFOUND ' + url);
    const entry = map[url];
    if (entry instanceof Error) throw entry;
    return { status: entry.status, text: async () => entry.body || '' };
  };
}

describe('parseRobotsTxt -- group selection', () => {
  const txt = [
    'User-agent: *',
    'Disallow: /private',
    '',
    'User-agent: vcbrain-radar',
    'Disallow: /secret',
    'Allow: /secret/public',
  ].join('\n');

  test('an exact user-agent group wins over the wildcard group', () => {
    const g = parseRobotsTxt(txt, UA);
    assert.deepEqual(g.disallow, ['/secret']);
    assert.deepEqual(g.allow, ['/secret/public']);
  });

  test('an unknown agent falls back to the wildcard group', () => {
    const g = parseRobotsTxt(txt, 'some-other-bot');
    assert.deepEqual(g.disallow, ['/private']);
  });

  test('consecutive User-agent lines share one rule block', () => {
    const shared = ['User-agent: alpha', 'User-agent: beta', 'Disallow: /x'].join('\n');
    assert.deepEqual(parseRobotsTxt(shared, 'alpha').disallow, ['/x']);
    assert.deepEqual(parseRobotsTxt(shared, 'beta').disallow, ['/x']);
  });

  test('a new User-agent AFTER rules starts a new group, not a continuation', () => {
    const seq = ['User-agent: alpha', 'Disallow: /a', 'User-agent: beta', 'Disallow: /b'].join('\n');
    assert.deepEqual(parseRobotsTxt(seq, 'alpha').disallow, ['/a']);
    assert.deepEqual(parseRobotsTxt(seq, 'beta').disallow, ['/b']);
  });

  test('comments and blank lines are ignored; empty input allows everything', () => {
    const g = parseRobotsTxt('# just a comment\n\n', UA);
    assert.deepEqual(g.disallow, []);
    assert.equal(isCrawlAllowed('', 'https://x.com/a', UA).allowed, true);
  });
});

describe('isCrawlAllowed -- longest match wins', () => {
  const txt = ['User-agent: *', 'Disallow: /', 'Allow: /public'].join('\n');

  test('a blanket Disallow: / blocks an ordinary path', () => {
    assert.equal(isCrawlAllowed(txt, 'https://x.com/about', UA).allowed, false);
  });

  test('a longer Allow overrides a shorter Disallow', () => {
    const v = isCrawlAllowed(txt, 'https://x.com/public/page', UA);
    assert.equal(v.allowed, true);
    assert.equal(v.reason, 'allow_overrides');
  });

  test('`Disallow:` with an empty value means allow-all, not block-all', () => {
    // The single most common way a naive parser blocks an entire site.
    const permissive = ['User-agent: *', 'Disallow:'].join('\n');
    assert.equal(isCrawlAllowed(permissive, 'https://x.com/anything', UA).allowed, true);
  });

  test('the $ end-anchor is honoured', () => {
    const anchored = ['User-agent: *', 'Disallow: /*.pdf$'].join('\n');
    assert.equal(isCrawlAllowed(anchored, 'https://x.com/a/b.pdf', UA).allowed, false);
    assert.equal(isCrawlAllowed(anchored, 'https://x.com/a/b.pdf.html', UA).allowed, true);
  });

  test('an unparseable URL is refused rather than crawled', () => {
    const v = isCrawlAllowed('', 'not a url', UA);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'unparseable_url');
  });
});

describe('checkRobots -- "could not verify" is not "objects to crawling"', () => {
  test('200 + a disallow rule blocks, and reports it was checked', async () => {
    const f = stubFetch({ 'https://x.com/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' } });
    const v = await checkRobots('https://x.com/about', f, UA);
    assert.equal(v.allowed, false);
    assert.equal(v.checked, true);
  });

  test('404 means the site expressed no objection -> allowed, checked', async () => {
    const f = stubFetch({ 'https://x.com/robots.txt': { status: 404 } });
    const v = await checkRobots('https://x.com/about', f, UA);
    assert.equal(v.allowed, true);
    assert.equal(v.checked, true);
    assert.equal(v.reason, 'no_robots_txt');
  });

  test('a network failure is allowed BUT flagged checked:false -- the two must stay distinguishable', async () => {
    // design §7.1: a failed fetch is "could not verify", never "objects" and
    // never "project is dead". If this collapsed to allowed/blocked with no
    // flag, the distinction would be unauditable after the fact.
    const v = await checkRobots('https://x.com/about', stubFetch({}), UA);
    assert.equal(v.allowed, true);
    assert.equal(v.checked, false);
    assert.match(v.reason, /^fetch_failed:/);
  });

  test('a skip produces a recordable event, so it is visible rather than silent', () => {
    const ev = crawlSkippedEvent('https://x.com/about', { rule: '/', reason: 'disallowed', checked: true });
    assert.equal(ev.event_type, 'crawl_skipped_robots');
    assert.equal(ev.payload.url, 'https://x.com/about');
    assert.equal(ev.payload.rule, '/');
  });
});

describe('isOptedOut -- design §7 item 2', () => {
  test('an identity whose founder has opt_out_at set blocks ingestion', () => {
    const r = isOptedOut([
      { kind: 'hn', value: 'someone', founder_opt_out_at: null },
      { kind: 'github', value: 'someone', founder_opt_out_at: '2026-07-19T00:00:00Z' },
    ]);
    assert.equal(r.blocked, true);
    assert.equal(r.matchedIdentity.kind, 'github');
  });

  test('no opt-out anywhere -> not blocked', () => {
    assert.equal(isOptedOut([{ kind: 'hn', value: 'a', founder_opt_out_at: null }]).blocked, false);
  });

  test('an empty identity set is not blocked -- a brand-new candidate must ingest', () => {
    // The tombstone only exists for someone previously seen. Blocking on
    // "no match" would stop the radar discovering anyone at all.
    assert.equal(isOptedOut([]).blocked, false);
    assert.equal(isOptedOut(null).blocked, false);
  });
});
