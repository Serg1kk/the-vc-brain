// lib/f08/hashing.test.js
//
// Acceptance tests for lib/f08/hashing.js, per docs/backlog/
// 08-founder-intake-interview/plan.md T7. Run with: node --test lib/f08/*.js
// (glob form -- the directory form fails with MODULE_NOT_FOUND on Node
// v22.19.0).
//
// This file MAY require() -- only lib/f08/hashing.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).
//
// SYNCHRONOUS as of the team-lead's live-sandbox-probe correction
// (docs/backlog/TRACKER.md, ~10:45): `globalThis.crypto.subtle` does not
// exist in this project's n8n Code-node sandbox at all; `require('crypto')`
// (bare specifier) + `createHash('sha256')` does, and is synchronous, so no
// test below `await`s a hashing.js export any more.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sha256Hex, hashFields, contentHash } = require('./hashing.js');

describe('sha256Hex / hashFields', () => {
  test('matches the known SHA-256("abc") test vector -- the same one the live-sandbox probe used', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('returns a 64-char lowercase hex string', () => {
    const h = sha256Hex('hello');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('hashFields is stable across repeated calls with the same input', () => {
    const a = hashFields('a', 'b', 'c');
    const b = hashFields('a', 'b', 'c');
    assert.equal(a, b);
  });

  test('the delimiter prevents a naive concatenation collision', () => {
    const a = hashFields('ab', 'c');
    const b = hashFields('a', 'bc');
    assert.notEqual(a, b);
  });

  test('null/undefined parts hash as empty string', () => {
    const a = hashFields('x', null, 'y');
    const b = hashFields('x', '', 'y');
    assert.equal(a, b);
  });
});

describe('contentHash.rawSignal -- design §3.2, application_id-scoped', () => {
  test('AC: same application + same deck -> identical hash (a retry dedupes)', () => {
    const a = contentHash.rawSignal({ application_id: 'app-1', source: 'deck_parse', content_key: 'deckbytes==' });
    const b = contentHash.rawSignal({ application_id: 'app-1', source: 'deck_parse', content_key: 'deckbytes==' });
    assert.equal(a, b);
  });

  test('AC: different application + same deck -> different hash (re-application succeeds instead of raising 23505)', () => {
    const a = contentHash.rawSignal({ application_id: 'app-1', source: 'deck_parse', content_key: 'deckbytes==' });
    const b = contentHash.rawSignal({ application_id: 'app-2', source: 'deck_parse', content_key: 'deckbytes==' });
    assert.notEqual(a, b);
  });

  test('a different source with the same application+content still differs', () => {
    const a = contentHash.rawSignal({ application_id: 'app-1', source: 'deck_parse', content_key: 'x' });
    const b = contentHash.rawSignal({ application_id: 'app-1', source: 'interview_answer', content_key: 'x' });
    assert.notEqual(a, b);
  });

  test('works for a gap-answer raw_signal keyed on criterion_id+answer', () => {
    const h = contentHash.rawSignal({
      application_id: 'app-1',
      source: 'interview_answer',
      content_key: 'L2::We landed our first pilot in March.',
    });
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('contentHash.claim -- application_id-scoped', () => {
  test('same application+card+topic -> identical hash', () => {
    const a = contentHash.claim({ application_id: 'app-1', card_id: 'card-1', topic: 'founder.leadership.first_customers' });
    const b = contentHash.claim({ application_id: 'app-1', card_id: 'card-1', topic: 'founder.leadership.first_customers' });
    assert.equal(a, b);
  });

  test('different application -> different hash even with the same card_id/topic', () => {
    const a = contentHash.claim({ application_id: 'app-1', card_id: 'card-1', topic: 'founder.leadership.first_customers' });
    const b = contentHash.claim({ application_id: 'app-2', card_id: 'card-1', topic: 'founder.leadership.first_customers' });
    assert.notEqual(a, b);
  });

  test('item_key null/undefined/"" all normalize to the same "_" placeholder', () => {
    const base = { application_id: 'app-1', card_id: 'card-1', topic: 't' };
    const a = contentHash.claim({ ...base, item_key: null });
    const b = contentHash.claim({ ...base, item_key: undefined });
    const c = contentHash.claim({ ...base });
    const d = contentHash.claim({ ...base, item_key: '' });
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(c, d);
  });
});

describe('contentHash.evidence -- application_id-scoped, discriminates on raw_signal_id', () => {
  test('same inputs -> identical hash', () => {
    const a = contentHash.evidence({ application_id: 'app-1', claim_id: 'claim-1', relation: 'supports', raw_signal_id: 'raw-1' });
    const b = contentHash.evidence({ application_id: 'app-1', claim_id: 'claim-1', relation: 'supports', raw_signal_id: 'raw-1' });
    assert.equal(a, b);
  });

  test('a second evidence row for the same claim from a different raw_signal does not collide', () => {
    const a = contentHash.evidence({ application_id: 'app-1', claim_id: 'claim-1', relation: 'supports', raw_signal_id: 'raw-deck' });
    const b = contentHash.evidence({ application_id: 'app-1', claim_id: 'claim-1', relation: 'supports', raw_signal_id: 'raw-interview' });
    assert.notEqual(a, b);
  });

  test('different application -> different hash', () => {
    const a = contentHash.evidence({ application_id: 'app-1', claim_id: 'claim-1', relation: 'supports', raw_signal_id: 'raw-1' });
    const b = contentHash.evidence({ application_id: 'app-2', claim_id: 'claim-1', relation: 'supports', raw_signal_id: 'raw-1' });
    assert.notEqual(a, b);
  });
});

// ============================================================================
// Proves this file does not touch `globalThis.crypto` at all any more (the
// earlier version did, via a polyfill guard -- removed per the team lead's
// live-sandbox probe, which found `globalThis.crypto.subtle` does not exist
// in this sandbox even after that assignment). `require('crypto')` is a
// module-local `const`, resolved once at `require()` time and never read
// off any global -- deleting `globalThis.crypto` afterward must have zero
// effect on already-loaded OR freshly-reloaded instances of this module.
// ============================================================================

describe('hashing.js does not read globalThis.crypto', () => {
  test('still produces the correct digest with globalThis.crypto deleted', () => {
    const hadCrypto = Object.prototype.hasOwnProperty.call(globalThis, 'crypto');
    const originalCrypto = globalThis.crypto;
    delete globalThis.crypto;
    try {
      assert.equal(typeof globalThis.crypto, 'undefined', 'test setup failed to actually remove crypto');
      assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      if (hadCrypto) globalThis.crypto = originalCrypto;
    }
  });

  test('a fresh require() of the module, with globalThis.crypto deleted first, also works', () => {
    const modulePath = require.resolve('./hashing.js');
    const hadCrypto = Object.prototype.hasOwnProperty.call(globalThis, 'crypto');
    const originalCrypto = globalThis.crypto;
    delete globalThis.crypto;
    delete require.cache[modulePath];
    try {
      const reloaded = require('./hashing.js');
      assert.equal(reloaded.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      if (hadCrypto) globalThis.crypto = originalCrypto;
      delete require.cache[modulePath];
      require('./hashing.js'); // leave module state as any later test in this file/process expects
    }
  });
});
