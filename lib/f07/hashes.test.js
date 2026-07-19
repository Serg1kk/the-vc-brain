// lib/f07/hashes.test.js
//
// Tests for lib/f07/hashes.js (feature 07, Thesis Engine, Stage B, task
// B1c). Run with: node --test lib/f07/hashes.test.js

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  PROMPT_VERSION,
  sha256Hex,
  hashFields,
  normalizeText,
  inputTextHash,
  stableStringify,
  thesisConfigSnapshotHash,
  contentHash,
  inputFingerprint,
} = require('./hashes');

describe('PROMPT_VERSION', () => {
  test('is the pinned constant f07-extract-v1 (team-lead correction, 2026-07-19)', () => {
    assert.equal(PROMPT_VERSION, 'f07-extract-v1');
  });
});

describe('sha256Hex / hashFields -- basic shape', () => {
  test('sha256Hex produces a 64-char lowercase hex digest', () => {
    const digest = sha256Hex('hello');
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
  test('hashFields is deterministic and null/undefined parts hash as empty string, not the literal "null"/"undefined"', () => {
    assert.equal(hashFields('a', null, 'b'), hashFields('a', undefined, 'b'));
    assert.equal(hashFields('a', null, 'b'), hashFields('a', '', 'b'));
  });
  test('hashFields is sensitive to which positional argument carries a value ("ab"+"c" vs "a"+"bc" do not collide)', () => {
    assert.notEqual(hashFields('ab', 'c'), hashFields('a', 'bc'));
  });
});

describe('normalizeText / inputTextHash -- retry-stability under insignificant whitespace differences', () => {
  test('trims and collapses runs of whitespace (spaces, tabs, newlines) to one space', () => {
    assert.equal(normalizeText('  Hello   world  \n\n  '), 'Hello world');
    assert.equal(normalizeText('Hello\tworld'), 'Hello world');
  });
  test('null/undefined normalize to the empty string, not "null"/"undefined"', () => {
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
  });
  test('two logically-identical decks with different line-wrapping hash IDENTICALLY -- this is the property the retry-stability argument rests on', () => {
    const a = 'We build developer tools\nfor infrastructure automation.';
    const b = 'We build developer tools   for infrastructure automation.  ';
    assert.equal(inputTextHash(a), inputTextHash(b));
  });
  test('a genuine content difference still changes the hash', () => {
    assert.notEqual(inputTextHash('developer tools'), inputTextHash('infrastructure tools'));
  });
});

describe('stableStringify / thesisConfigSnapshotHash -- independent of object key insertion order', () => {
  test('two objects with the same key/value pairs in different insertion order stringify identically', () => {
    const a = { fit: { base: 50, min_coverage: 0.5 }, mandate: { sectors: ['ai-infra'] } };
    const b = { mandate: { sectors: ['ai-infra'] }, fit: { min_coverage: 0.5, base: 50 } };
    assert.equal(stableStringify(a), stableStringify(b));
    assert.equal(thesisConfigSnapshotHash(a), thesisConfigSnapshotHash(b));
  });
  test('array order IS significant (arrays are not sorted, only object keys are)', () => {
    assert.notEqual(stableStringify(['a', 'b']), stableStringify(['b', 'a']));
  });
  test('a genuine content difference changes the hash', () => {
    assert.notEqual(thesisConfigSnapshotHash({ fit: { base: 50 } }), thesisConfigSnapshotHash({ fit: { base: 51 } }));
  });
  test('null/absent config hashes as the empty object, deterministically', () => {
    assert.equal(thesisConfigSnapshotHash(null), thesisConfigSnapshotHash({}));
    assert.equal(thesisConfigSnapshotHash(undefined), thesisConfigSnapshotHash({}));
  });
});

// ============================================================================
// contentHash.aiRun -- ai_runs.input_hash. Deterministic; every one of its
// four inputs is load-bearing.
// ============================================================================

describe('contentHash.aiRun', () => {
  const base = { application_id: 'app-1', input_text_hash: inputTextHash('some deck text'), prompt_version: PROMPT_VERSION, model: 'gpt-5.6-luna' };

  test('deterministic for identical inputs', () => {
    assert.equal(contentHash.aiRun(base), contentHash.aiRun({ ...base }));
  });
  test('each of the four fields is load-bearing', () => {
    const h0 = contentHash.aiRun(base);
    assert.notEqual(contentHash.aiRun({ ...base, application_id: 'app-2' }), h0);
    assert.notEqual(contentHash.aiRun({ ...base, input_text_hash: inputTextHash('other text') }), h0);
    assert.notEqual(contentHash.aiRun({ ...base, prompt_version: 'f07-extract-v2' }), h0);
    assert.notEqual(contentHash.aiRun({ ...base, model: 'gpt-5.6-terra' }), h0);
  });
});

// ============================================================================
// THE regression tests (scope-amendment's explicit requirement): two retries
// of one gate call produce identical raw_signals and claims hashes DESPITE a
// fresh ai_runs row on each attempt. Modeled here by giving "attempt 1" and
// "attempt 2" two different simulated ai_run_ids -- neither contentHash.
// rawSignal nor contentHash.claim accepts an ai_run_id parameter at all, so
// this is really a test that the recipes are STRUCTURALLY incapable of
// varying with it, not just that they happen to agree by coincidence.
// ============================================================================

describe('retry-stability -- raw_signals and claims hash identically across retries, regardless of a fresh ai_runs row each time', () => {
  const applicationId = '07f00002-0000-0000-0000-000000000001';
  const gateText = 'We build developer tools for infrastructure automation.';
  const textHash = inputTextHash(gateText);

  test('contentHash.rawSignal is identical across two attempts that each opened their own ai_runs row', () => {
    // Attempt 1 and attempt 2 simulate two separate ai_runs inserts (e.g. a
    // workflow retry that re-opens the preflight node) -- the ai_run ids
    // below are never passed to rawSignal() at all.
    const attempt1AiRunId = 'ai-run-11111111-1111-1111-1111-111111111111';
    const attempt2AiRunId = 'ai-run-22222222-2222-2222-2222-222222222222';
    assert.notEqual(attempt1AiRunId, attempt2AiRunId); // sanity: the two attempts really did differ

    const hash1 = contentHash.rawSignal({ application_id: applicationId, input_text_hash: textHash, prompt_version: PROMPT_VERSION });
    const hash2 = contentHash.rawSignal({ application_id: applicationId, input_text_hash: textHash, prompt_version: PROMPT_VERSION });
    assert.equal(hash1, hash2);
  });

  test('contentHash.claim is identical across two attempts, ANCHORED on a retry-stable raw_signal_id, not on the differing ai_run_id', () => {
    // raw_signal_id resolves via the retry-stable hash above (select-by-
    // hash-first, §5.4), so both attempts arrive at the SAME raw_signal_id
    // even though each attempt's own ai_runs row differs.
    const sharedRawSignalId = 'raw-signal-33333333-3333-3333-3333-333333333333';
    const claimAttempt1 = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: sharedRawSignalId, item_key: '_' });
    const claimAttempt2 = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: sharedRawSignalId, item_key: '_' });
    assert.equal(claimAttempt1, claimAttempt2);
  });

  test('CONTRAST -- reproducing lib/f04/provenance.js\'s ai_run_id-anchored recipe (inline, not imported) WOULD have broken retry-stability; this is the exact defect §5.4 documents avoiding', () => {
    // This recreates 04's `claim({card_id, topic, ai_run_id, item_key})`
    // shape locally, purely to demonstrate the contrast -- it is NOT
    // imported from provenance.js and 07's hashes.js contains no such
    // function. See hashes.js's `contentHash.claim` comment for why 04's
    // choice is deliberate for 04 and wrong for 07.
    const f04StyleClaimHash = ({ card_id, topic, ai_run_id, item_key }) =>
      crypto.createHash('sha256').update([card_id, topic, ai_run_id, item_key].map((p) => p ?? '').join(' '), 'utf8').digest('hex');

    const attempt1 = f04StyleClaimHash({ card_id: 'card-1', topic: 'company.sector', ai_run_id: 'ai-run-11111111-1111-1111-1111-111111111111', item_key: '_' });
    const attempt2 = f04StyleClaimHash({ card_id: 'card-1', topic: 'company.sector', ai_run_id: 'ai-run-22222222-2222-2222-2222-222222222222', item_key: '_' });
    assert.notEqual(attempt1, attempt2); // the defect: two retries, two different claim rows
  });
});

// ============================================================================
// contentHash.evidence -- design.md §5.4 row 5 (gap #1 from the team lead's
// second message: "has no test -- add one").
// ============================================================================

describe('contentHash.evidence', () => {
  test('deterministic for identical inputs', () => {
    const args = { claim_id: 'claim-1', relation: 'supports' };
    assert.equal(contentHash.evidence(args), contentHash.evidence({ ...args }));
  });
  test('claim_id and relation are both load-bearing', () => {
    const h0 = contentHash.evidence({ claim_id: 'claim-1', relation: 'supports' });
    assert.notEqual(contentHash.evidence({ claim_id: 'claim-2', relation: 'supports' }), h0);
    assert.notEqual(contentHash.evidence({ claim_id: 'claim-1', relation: 'context' }), h0);
  });
});

describe('contentHash.claim -- item_key defaults to "_" for singleton topics', () => {
  test('item_key omitted, null, or empty string all hash the same as an explicit "_"', () => {
    const explicit = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1', item_key: '_' });
    assert.equal(contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1' }), explicit);
    assert.equal(contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1', item_key: null }), explicit);
    assert.equal(contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1', item_key: '' }), explicit);
  });
  test('a real item_key changes the hash relative to the "_" default', () => {
    const singleton = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1' });
    const itemized = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1', item_key: 'competitor-1' });
    assert.notEqual(singleton, itemized);
  });
});

// ============================================================================
// inputFingerprint (§5.1) -- stable under claim reordering, changes when a
// claim changes.
// ============================================================================

describe('inputFingerprint -- §5.1', () => {
  const configSnapshot = { fit: { base: 50, strong_threshold: 70 }, rules: [{ id: 'R1' }] };
  const claimHashA = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-1' });
  const claimHashB = contentHash.claim({ card_id: 'card-1', topic: 'company.business_model', raw_signal_id: 'rs-1' });
  const claimHashC = contentHash.claim({ card_id: 'card-1', topic: 'company.geography_country', raw_signal_id: 'rs-1' });

  test('is stable under reordering of the contributing claim content_hashes', () => {
    const forward = inputFingerprint({ claimContentHashes: [claimHashA, claimHashB, claimHashC], thesisConfigSnapshot: configSnapshot });
    const shuffled = inputFingerprint({ claimContentHashes: [claimHashC, claimHashA, claimHashB], thesisConfigSnapshot: configSnapshot });
    assert.equal(forward, shuffled);
  });

  test('flipping one claim (05 contradicts it, a new claim content_hash results) changes the fingerprint', () => {
    const before = inputFingerprint({ claimContentHashes: [claimHashA, claimHashB, claimHashC], thesisConfigSnapshot: configSnapshot });
    const claimHashARevised = contentHash.claim({ card_id: 'card-1', topic: 'company.sector', raw_signal_id: 'rs-2' }); // e.g. re-extracted under a new raw_signal
    const after = inputFingerprint({ claimContentHashes: [claimHashARevised, claimHashB, claimHashC], thesisConfigSnapshot: configSnapshot });
    assert.notEqual(before, after);
  });

  test('a thesis config change (e.g. a version bump) changes the fingerprint even with the same claims', () => {
    const before = inputFingerprint({ claimContentHashes: [claimHashA, claimHashB], thesisConfigSnapshot: configSnapshot });
    const after = inputFingerprint({ claimContentHashes: [claimHashA, claimHashB], thesisConfigSnapshot: { ...configSnapshot, rules: [{ id: 'R1' }, { id: 'R2' }] } });
    assert.notEqual(before, after);
  });

  test('an empty claim list still fingerprints deterministically (e.g. the all-null extraction record)', () => {
    const first = inputFingerprint({ claimContentHashes: [], thesisConfigSnapshot: configSnapshot });
    const second = inputFingerprint({ claimContentHashes: [], thesisConfigSnapshot: configSnapshot });
    assert.equal(first, second);
  });
});
