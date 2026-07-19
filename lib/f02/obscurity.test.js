// lib/f02/obscurity.test.js
//
// Acceptance tests for lib/f02/obscurity.js, per docs/backlog/02-sourcing-radar/
// plan.md Task 4 and design.md §6.4. Run with:
// node --test lib/f02/*.test.js (glob form -- the directory form fails with
// MODULE_NOT_FOUND on Node v22.19.0).
//
// This file MAY require() -- only lib/f02/obscurity.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { obscurity, computeObscurity } = require('./obscurity.js');

describe('obscurity -- design §6.4 formula, exact values', () => {
  test('zero followers and zero karma -> maximally obscure (1.0)', () => {
    assert.equal(obscurity({ ghFollowers: 0, hnKarma: 0 }), 1.0);
  });

  test('1000 followers alone drives the followers term to (approximately) 0', () => {
    // log10(1+999)/3 = log10(1000)/3 = 3/3 = 1 -> followers_term = 0
    const result = obscurity({ ghFollowers: 999, hnKarma: 0 });
    // karma_term is still 1 (hnKarma=0) -> obscurity = (0 + 1) / 2 = 0.5
    assert.equal(result, 0.5);
  });

  test('10000 karma alone drives the karma term to (approximately) 0', () => {
    // log10(1+9999)/4 = log10(10000)/4 = 4/4 = 1 -> karma_term = 0
    const result = obscurity({ ghFollowers: 0, hnKarma: 9999 });
    assert.equal(result, 0.5);
  });

  test('a well-followed, high-karma founder approaches 0 (highly discovered)', () => {
    const result = obscurity({ ghFollowers: 999, hnKarma: 9999 });
    assert.equal(result, 0);
  });

  test('values beyond the clamp ceiling do not go negative -- clamped at the formula floor', () => {
    const result = obscurity({ ghFollowers: 10_000_000, hnKarma: 10_000_000 });
    assert.equal(result, 0);
  });

  test('the result is rounded to 4 decimal places', () => {
    const result = obscurity({ ghFollowers: 12, hnKarma: 34 });
    const decimals = String(result).split('.')[1] || '';
    assert.ok(decimals.length <= 4);
  });
});

describe('obscurity -- monotonicity', () => {
  test('increasing ghFollowers (karma held constant) never increases obscurity', () => {
    const steps = [0, 1, 5, 10, 50, 100, 500, 1000, 5000];
    let previous = Infinity;
    for (const gh of steps) {
      const current = obscurity({ ghFollowers: gh, hnKarma: 100 });
      assert.ok(current <= previous, `obscurity rose at ghFollowers=${gh}: ${previous} -> ${current}`);
      previous = current;
    }
  });

  test('increasing hnKarma (followers held constant) never increases obscurity', () => {
    const steps = [0, 1, 10, 100, 1000, 10000, 50000];
    let previous = Infinity;
    for (const karma of steps) {
      const current = obscurity({ ghFollowers: 100, hnKarma: karma });
      assert.ok(current <= previous, `obscurity rose at hnKarma=${karma}: ${previous} -> ${current}`);
      previous = current;
    }
  });
});

describe('obscurity -- average over OBSERVED terms only (design §6.4, REVISED)', () => {
  // The first version of this suite asserted "either input missing -> null",
  // which is the SUPERSEDED rule. It was corrected in the second spec-review
  // round: hn_karma is available for essentially every candidate but
  // gh_followers resolves only ~36% of the time, so "any missing -> null"
  // would blank the feature's headline column for the majority. These
  // assertions are checked term-for-term against radar_candidates in
  // db/schema.sql -- one formula, two implementations, verified to agree.

  test('missing ghFollowers -> the karma term alone, not null', () => {
    const { value, basis } = computeObscurity({ ghFollowers: null, hnKarma: 9 });
    assert.equal(value, 0.75);            // 1 - log10(10)/4
    assert.deepEqual(basis, ['hn_karma']);
    assert.equal(obscurity({ hnKarma: 9 }), 0.75);
    assert.equal(obscurity({ ghFollowers: undefined, hnKarma: 9 }), 0.75);
  });

  test('missing hnKarma -> the followers term alone, not null', () => {
    const { value, basis } = computeObscurity({ ghFollowers: 9, hnKarma: null });
    assert.equal(value, 0.6667);          // 1 - log10(10)/3
    assert.deepEqual(basis, ['gh_followers']);
    assert.equal(obscurity({ ghFollowers: 9 }), 0.6667);
  });

  test('both missing -> null, and basis is null too', () => {
    assert.deepEqual(computeObscurity({}), { value: null, basis: null });
    assert.equal(obscurity(undefined), null);
    assert.equal(obscurity(null), null);
  });

  test('THE LOAD-BEARING GUARD: absence must never inflate the result upward', () => {
    // Zero-substituting a missing gh_followers contributes a followers_term
    // of 1.0 ("maximally undiscovered") and drags the mean UP -- missing data
    // improving a candidate's rank, i.e. REQ-003 backwards. Absence must
    // shrink the term count instead.
    const karmaOnly = obscurity({ ghFollowers: null, hnKarma: 9 });      // 0.75
    const zeroSubstituted = obscurity({ ghFollowers: 0, hnKarma: 9 });   // (1.0 + 0.75)/2
    assert.equal(karmaOnly, 0.75);
    assert.equal(zeroSubstituted, 0.875);
    assert.ok(karmaOnly < zeroSubstituted,
      'a truly-missing input must not score higher than an observed zero');

    // Symmetric case, and the one that actually bites in production: 64% of
    // candidates have no resolvable GitHub at all.
    const followersOnly = obscurity({ ghFollowers: 9, hnKarma: null });  // 0.6667
    assert.ok(followersOnly < obscurity({ ghFollowers: 9, hnKarma: 0 }));
  });

  test('an observed zero is a real observation and DOES count', () => {
    // gh_followers = 0 is a genuine, common measurement for a cold-start
    // founder (one fixture author has exactly 0) -- it must enter the mean,
    // unlike a missing value which must not.
    const { value, basis } = computeObscurity({ ghFollowers: 0, hnKarma: 0 });
    assert.equal(value, 1);
    assert.deepEqual(basis, ['gh_followers', 'hn_karma']);
  });

  test('non-numeric inputs (string, NaN) are treated as unobserved, not coerced', () => {
    assert.deepEqual(computeObscurity({ ghFollowers: '10', hnKarma: 9 }).basis, ['hn_karma']);
    assert.deepEqual(computeObscurity({ ghFollowers: NaN, hnKarma: 9 }).basis, ['hn_karma']);
  });

  test('negative counts are treated as unobserved, not fed into log10', () => {
    assert.deepEqual(computeObscurity({ ghFollowers: -5, hnKarma: 9 }).basis, ['hn_karma']);
    assert.equal(computeObscurity({ ghFollowers: -5, hnKarma: -5 }).value, null);
  });

  test('REGRESSION (TRACKER.md task A1e): negative hn_karma locks to the exact ' +
    'measured production case, matching radar_candidates/api_founders after the ' +
    'SQL-side fix', () => {
    // founder d2e2c8fb-3abc-4f31-9c65-66ecc16066e4, live fixture: hn_karma=-2,
    // gh_followers=4. Before A1e, the SQL view's task-A1a log-domain guard
    // (`GREATEST(hn_karma, 0)`) folded a negative karma into karma_term=1
    // ("maximally obscure") instead of dropping it as unobserved, so the view
    // returned 0.8835 / {gh_followers,hn_karma} while this library -- which
    // never applied that clamp -- returned 0.767 / {gh_followers} for the
    // same input. A1e made the view match this file exactly; this test pins
    // the library side of that agreement so the two can never silently drift
    // apart again.
    const withFollowers = computeObscurity({ ghFollowers: 4, hnKarma: -2 });
    assert.equal(withFollowers.value, 0.767); // followers term only, karma term dropped
    assert.deepEqual(withFollowers.basis, ['gh_followers']);

    // Negative karma alone (no gh_followers observation either): no term is
    // observed, so the result is null/null, not 1.0/{hn_karma} (which is what
    // the pre-A1e view produced by treating a downvoted user as "unseen").
    const karmaOnly = computeObscurity({ ghFollowers: null, hnKarma: -2 });
    assert.equal(karmaOnly.value, null);
    assert.equal(karmaOnly.basis, null);
  });

  test('basis names match the metric_kinds slugs the SQL view reports', () => {
    // If these drift, feature 09 renders a basis the view never produces.
    assert.deepEqual(computeObscurity({ ghFollowers: 1, hnKarma: 1 }).basis,
      ['gh_followers', 'hn_karma']);
  });
});

describe('obscurity -- ignores every field other than the two declared inputs', () => {
  test('extraneous fields (including a founder-quality-shaped field) have zero effect on the result', () => {
    const base = obscurity({ ghFollowers: 42, hnKarma: 777 });
    const withExtras = obscurity({
      ghFollowers: 42,
      hnKarma: 777,
      founderScore: 999,
      trustScore: 1,
      value: 100,
      confidence: 1,
      obscurity: 0, // even a field literally named the same as the output
      hnPoints: 500,
      ghStars: 100000,
    });
    assert.equal(withExtras, base);
  });

  test('a founder-quality field cannot sneak in a nonzero result when the two real inputs are missing', () => {
    const result = obscurity({ founderScore: 100, trustScore: 1, ghFollowers: undefined, hnKarma: undefined });
    assert.equal(result, null);
  });
});
