// lib/f05/verifiers.test.js
//
// Tests for lib/f05/verifiers.js (feature 05, Truth-Gap Check & Trust Score,
// task B2). Run with: node --test lib/f05/verifiers.test.js -- ⚠️ NOT the
// lib/f05/*.test.js glob: three other T0 agents are creating files in this
// same new directory right now (plan.md Wave T0 binding rule).
//
// This file MAY require() -- only lib/f05/verifiers.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).
//
// The final describe block ("buildEvidenceRow -- live transactional
// idempotency proof") does real INSERTs against the live database inside a
// single transaction that ROLLBACKs (the db/tests/smoke.sql pattern) --
// per the team lead's explicit instruction, since acceptance needing INSERTs
// must never leave persisted writes for another concurrently-running T0
// agent to race against. It requires DATABASE_URL in the environment and
// SKIPS (not fails) when absent, so this file still runs green in a shell
// that has not sourced it -- see the CLAUDE.md "Commands" section for the
// exact one-liner that builds it from infra/supabase/.env.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const {
  sha256Hex,
  evidenceContentHash,
  buildEvidenceRow,
  extractEarliestCommitAuthorDate,
  extractShowHnSubmittedAt,
  checkGithubProvenance,
  extractDenominator,
} = require('./verifiers.js');

// ============================================================================
// sha256Hex / evidenceContentHash -- SS10.1's recipe.
// ============================================================================

describe('sha256Hex', () => {
  test('produces a 64-char lowercase hex digest', async () => {
    const digest = await sha256Hex('hello');
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
  test('is deterministic', async () => {
    assert.equal(await sha256Hex('same input'), await sha256Hex('same input'));
  });
});

describe('evidenceContentHash -- SS10.1 recipe (claim_id, relation, source_url, quote, check_id, candidate_key)', () => {
  const base = { claimId: 'claim-1', relation: 'contradicts', sourceUrl: 'https://x.example/a', quote: 'the quote', checkId: 'gh_provenance', candidateKey: 'candidate-1' };

  test('deterministic for identical inputs', async () => {
    assert.equal(await evidenceContentHash(base), await evidenceContentHash({ ...base }));
  });

  test('every one of the six fields is load-bearing', async () => {
    const h0 = await evidenceContentHash(base);
    assert.notEqual(await evidenceContentHash({ ...base, claimId: 'claim-2' }), h0);
    assert.notEqual(await evidenceContentHash({ ...base, relation: 'context' }), h0);
    assert.notEqual(await evidenceContentHash({ ...base, sourceUrl: 'https://x.example/b' }), h0);
    assert.notEqual(await evidenceContentHash({ ...base, quote: 'a different quote' }), h0);
    assert.notEqual(await evidenceContentHash({ ...base, checkId: 'denominator_extraction' }), h0);
    assert.notEqual(await evidenceContentHash({ ...base, candidateKey: 'candidate-2' }), h0);
  });

  test('check_id + candidate_key are what let two NULL-source_url/NULL-quote rows on the same claim coexist (SS10.1)', async () => {
    const rowA = { claimId: 'claim-3', relation: 'context', sourceUrl: null, quote: null, checkId: 'entity_gate', candidateKey: 'candidate text A' };
    const rowB = { claimId: 'claim-3', relation: 'context', sourceUrl: null, quote: null, checkId: 'entity_gate', candidateKey: 'candidate text B' };
    assert.notEqual(await evidenceContentHash(rowA), await evidenceContentHash(rowB));
  });

  test('this recipe accepts no run_id parameter at all -- structurally incapable of the redelivery-doubles-the-penalty defect (SS10.1 warning)', async () => {
    // Passing an extra, unrecognized `runId` field must not change the hash
    // at all -- evidenceContentHash only ever reads the six named fields.
    const withExtraRunId = { ...base, runId: 'run-11111111-1111-1111-1111-111111111111' };
    const withDifferentRunId = { ...base, runId: 'run-22222222-2222-2222-2222-222222222222' };
    assert.equal(await evidenceContentHash(withExtraRunId), await evidenceContentHash(withDifferentRunId));
    assert.equal(await evidenceContentHash(withExtraRunId), await evidenceContentHash(base));
  });
});

// ============================================================================
// buildEvidenceRow -- the evidence-write helper.
// ============================================================================

describe('buildEvidenceRow -- validation (fail-closed, SS2.1)', () => {
  const valid = { claimId: 'claim-1', relation: 'contradicts', tier: 'documented', rawSignalId: 'rs-1', checkId: 'gh_provenance' };

  test('a fully valid row builds successfully', async () => {
    const row = await buildEvidenceRow(valid);
    assert.equal(row.claim_id, 'claim-1');
    assert.equal(row.raw_signal_id, 'rs-1');
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  });

  test('rejects a missing raw_signal_id -- SS2.1: "must always be populated on rows 05 writes"', async () => {
    await assert.rejects(() => buildEvidenceRow({ ...valid, rawSignalId: undefined }), /rawSignalId is required/);
    await assert.rejects(() => buildEvidenceRow({ ...valid, rawSignalId: null }), /rawSignalId is required/);
  });

  test('rejects a missing claimId', async () => {
    await assert.rejects(() => buildEvidenceRow({ ...valid, claimId: undefined }), /claimId is required/);
  });

  test('rejects an invalid relation (not in the evidence CHECK constraint enum)', async () => {
    await assert.rejects(() => buildEvidenceRow({ ...valid, relation: 'refutes' }), /relation must be one of/);
  });

  test('rejects an invalid tier', async () => {
    await assert.rejects(() => buildEvidenceRow({ ...valid, tier: 'confirmed' }), /tier must be one of/);
  });

  test('rejects a missing checkId', async () => {
    await assert.rejects(() => buildEvidenceRow({ ...valid, checkId: undefined }), /checkId is required/);
  });
});

describe('buildEvidenceRow -- snake_case row shape and nullable fields', () => {
  test('strength/quote_verbatim/source_url default to null, not undefined, when omitted', async () => {
    const row = await buildEvidenceRow({ claimId: 'claim-2', relation: 'context', tier: 'inferred', rawSignalId: 'rs-2', checkId: 'denominator_extraction' });
    assert.equal(row.strength, null);
    assert.equal(row.quote_verbatim, null);
    assert.equal(row.source_url, null);
  });

  test('never sets captured_at/id/created_at -- those are DB-assigned defaults (no Date.now() anywhere in this file)', async () => {
    const row = await buildEvidenceRow({ claimId: 'claim-3', relation: 'supports', tier: 'documented', rawSignalId: 'rs-3', checkId: 'gh_provenance', strength: 0.9 });
    assert.equal('captured_at' in row, false);
    assert.equal('id' in row, false);
    assert.equal('created_at' in row, false);
  });
});

describe('buildEvidenceRow -- candidateKey defaulting and idempotency (pure, no DB)', () => {
  test('candidateKey defaults to checkId when omitted -- identical calls hash identically (a single-candidate-per-claim check need not invent a key)', async () => {
    const params = { claimId: 'claim-4', relation: 'contradicts', tier: 'documented', rawSignalId: 'rs-4', checkId: 'gh_provenance' };
    const row1 = await buildEvidenceRow(params);
    const row2 = await buildEvidenceRow({ ...params });
    assert.equal(row1.content_hash, row2.content_hash); // this IS the property that makes "insert twice, no duplicate" possible
  });

  test('an explicit candidateKey overrides the checkId default and changes the hash', async () => {
    const base = { claimId: 'claim-5', relation: 'context', tier: 'discovered', rawSignalId: 'rs-5', checkId: 'entity_gate' };
    const rowDefault = await buildEvidenceRow(base);
    const rowExplicit = await buildEvidenceRow({ ...base, candidateKey: 'a specific failed candidate quote' });
    assert.notEqual(rowDefault.content_hash, rowExplicit.content_hash);
  });
});

// ============================================================================
// SS5.1(b) -- GitHub provenance vs. Show HN date. Fixtures below are REAL
// payload shapes read from the live database 2026-07-19 (trimmed to the
// fields this file actually reads; irrelevant GitHub API noise fields
// omitted for readability, not because they matter to extraction).
// ============================================================================

describe('extractShowHnSubmittedAt -- real hn_algolia payload shapes (measured live 2026-07-19)', () => {
  // Real Algolia "story" hit, source_url
  // https://github.com/ayuhito/safehttp, source=hn_algolia.
  const realShowHnStory = {
    url: 'https://github.com/ayuhito/safehttp',
    _tags: ['story', 'author_ayuhito', 'story_48957230', 'show_hn'],
    title: 'Show HN: Safehttp – an SSRF-resistant HTTP client for Go',
    author: 'ayuhito',
    points: 4,
    objectID: '48957230',
    story_id: 48957230,
    created_at: '2026-07-18T11:54:57Z',
    updated_at: '2026-07-18T13:32:02Z',
    created_at_i: 1784375697,
    num_comments: 0,
  };

  test('extracts created_at from a real show_hn-tagged story hit', () => {
    assert.equal(extractShowHnSubmittedAt(realShowHnStory), '2026-07-18T11:54:57Z');
  });

  test('falls back to created_at_i (unix seconds) when created_at is absent', () => {
    const { created_at, ...withoutCreatedAt } = realShowHnStory;
    const result = extractShowHnSubmittedAt(withoutCreatedAt);
    assert.equal(result, new Date(1784375697 * 1000).toISOString());
  });

  test('a story NOT tagged show_hn returns null (an ordinary submission, not a Show HN post)', () => {
    const notShowHn = { ...realShowHnStory, _tags: ['story', 'author_ayuhito'] };
    assert.equal(extractShowHnSubmittedAt(notShowHn), null);
  });

  test('graceful degradation on the comment-hit shape (real live row: parent_item/comment_text, no _tags at all)', () => {
    const realCommentHit = { parent_item: 'f03fixture203', comment_text: 'Free forever for one pipeline. Paid tier is $29/mo for unlimited. No sales call.' };
    assert.equal(extractShowHnSubmittedAt(realCommentHit), null);
  });

  test('graceful degradation on the synthesized identity-stub shape (real live row: {note, hn_username}, "not queried live via the Algolia API")', () => {
    const realStubRow = { note: 'Well-known, long-standing HN identity consistent with the GitHub/X/site handle levelsio. Not queried live via the Algolia API.', hn_username: 'levelsio' };
    assert.equal(extractShowHnSubmittedAt(realStubRow), null);
  });

  test('graceful degradation on the minimal {story_title, points} stub shape (also observed live)', () => {
    assert.equal(extractShowHnSubmittedAt({ points: 4, story_title: 'Show HN: Ridgeline -- flag schema drift before it breaks your pipeline' }), null);
  });

  test('null/undefined/array payload -> null, never throws', () => {
    assert.equal(extractShowHnSubmittedAt(null), null);
    assert.equal(extractShowHnSubmittedAt(undefined), null);
    assert.equal(extractShowHnSubmittedAt([1, 2, 3]), null);
  });

  test('multiple hn_algolia rows for one company -- checkGithubProvenance picks the EARLIEST show_hn date among them', () => {
    const laterRelaunchPost = { ...realShowHnStory, created_at: '2026-08-01T00:00:00Z', created_at_i: 1785715200, objectID: '99999999' };
    const result = checkGithubProvenance({
      commitPayloads: { first_commit_at: '2026-07-01T00:00:00Z' },
      hnPayloads: [laterRelaunchPost, realShowHnStory],
    });
    assert.equal(result.showHnSubmittedAt, '2026-07-18T11:54:57Z'); // the EARLIER of the two, not the later relaunch post
  });
});

describe('extractEarliestCommitAuthorDate -- two supported payload shapes', () => {
  test('shape (a): the real GitHub REST commits API -- array of { commit: { author: { date } } } objects', () => {
    const commits = [
      { sha: 'a', commit: { author: { date: '2026-03-01T00:00:00Z' }, committer: { date: '2026-03-01T00:00:00Z' } } },
      { sha: 'b', commit: { author: { date: '2026-01-10T00:00:00Z' }, committer: { date: '2026-05-01T00:00:00Z' } } }, // earliest author date, but a LATE committer date
    ];
    assert.equal(extractEarliestCommitAuthorDate(commits), '2026-01-10T00:00:00Z');
  });

  test('shape (b): the simplified single-object shape -- REAL, live in db/fixtures/03-founder-score.sql (feature 03\'s unrelated "provenance-spoofing bait" fixture, first_commit_at/author_account_created_at)', () => {
    const realFixtureShape = {
      repo: 'fintrace-ai/fintrace-shield',
      first_commit_at: '2024-01-15T00:00:00Z',
      author_account_created_at: '2024-06-01T00:00:00Z',
      note: 'first commit predates author account creation -- classic backdating signature',
    };
    assert.equal(extractEarliestCommitAuthorDate(realFixtureShape), '2024-01-15T00:00:00Z');
  });

  test('a bare shape-(a) commits array passed DIRECTLY (not wrapped in an outer array) is correctly recognised as ONE payload, not a list', () => {
    const commits = [{ commit: { author: { date: '2026-02-01T00:00:00Z' } } }];
    assert.equal(extractEarliestCommitAuthorDate(commits), '2026-02-01T00:00:00Z');
  });

  test('a LIST of several shape-(b) objects (multiple repos) -- earliest wins', () => {
    const list = [{ first_commit_at: '2024-01-15T00:00:00Z' }, { first_commit_at: '2023-06-01T00:00:00Z' }];
    assert.equal(extractEarliestCommitAuthorDate(list), '2023-06-01T00:00:00Z');
  });

  test('a mixed list -- a shape-(b) object alongside a shape-(a) commits array -- both are read correctly', () => {
    const commits = [{ commit: { author: { date: '2026-03-01T00:00:00Z' } } }];
    const list = [{ first_commit_at: '2024-01-15T00:00:00Z' }, commits];
    assert.equal(extractEarliestCommitAuthorDate(list), '2024-01-15T00:00:00Z');
  });

  test('a LIST of several shape-(a) commit arrays (multiple repos, each with real commit history) -- earliest wins across all of them', () => {
    const repoA = [{ commit: { author: { date: '2026-03-01T00:00:00Z' } } }];
    const repoB = [{ commit: { author: { date: '2020-01-01T00:00:00Z' } } }];
    assert.equal(extractEarliestCommitAuthorDate([repoA, repoB]), '2020-01-01T00:00:00Z');
  });

  test('malformed/empty input never throws', () => {
    assert.equal(extractEarliestCommitAuthorDate(null), null);
    assert.equal(extractEarliestCommitAuthorDate([]), null);
    assert.equal(extractEarliestCommitAuthorDate([{}, { commit: {} }, { commit: { author: {} } }]), null);
  });
});

describe('checkGithubProvenance -- SS5.1(b): fixed phrasing, never an accusation', () => {
  const hnPayload = { _tags: ['story', 'show_hn'], created_at: '2026-07-18T11:54:57Z' };

  test('insufficient data -- missing commit info -> status insufficient_data, no relation/tier assigned', () => {
    const result = checkGithubProvenance({ commitPayloads: null, hnPayloads: hnPayload });
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.relation, null);
    assert.equal(result.tier, null);
  });

  test('insufficient data -- missing Show HN info -> status insufficient_data', () => {
    const result = checkGithubProvenance({ commitPayloads: { first_commit_at: '2026-01-01T00:00:00Z' }, hnPayloads: { note: 'stub, not queried live' } });
    assert.equal(result.status, 'insufficient_data');
  });

  test('clean case: earliest commit predates the Show HN date -> supports, Tier-1 documented', () => {
    const result = checkGithubProvenance({ commitPayloads: { first_commit_at: '2026-01-01T00:00:00Z' }, hnPayloads: hnPayload });
    assert.equal(result.status, 'clean');
    assert.equal(result.relation, 'supports');
    assert.equal(result.tier, 'documented');
  });

  test('a gap under the threshold is still clean, not flagged (default 60 days)', () => {
    const result = checkGithubProvenance({ commitPayloads: { first_commit_at: '2026-08-15T00:00:00Z' }, hnPayloads: hnPayload }); // ~28 days after
    assert.equal(result.status, 'clean');
    assert.ok(result.gapDays < 60);
  });

  test('flagged case: earliest commit postdates the Show HN date by MONTHS -> contradicts, and the FIXED phrase appears verbatim', () => {
    const result = checkGithubProvenance({ commitPayloads: { first_commit_at: '2027-01-20T00:00:00Z' }, hnPayloads: hnPayload });
    assert.equal(result.status, 'flagged');
    assert.equal(result.relation, 'contradicts');
    assert.equal(result.tier, 'documented');
    assert.ok(result.summary.includes('consistent with a rewritten or imported history'));
    assert.equal(result.summary.toLowerCase().includes('fraud'), false); // never an accusation
    assert.equal(result.summary.toLowerCase().includes('lied'), false);
    assert.equal(result.summary.toLowerCase().includes('fake'), false);
  });

  test('the threshold is configurable via thresholdDays', () => {
    const params = { commitPayloads: { first_commit_at: '2026-08-15T00:00:00Z' }, hnPayloads: hnPayload }; // ~28 days after
    assert.equal(checkGithubProvenance(params).status, 'clean');
    assert.equal(checkGithubProvenance({ ...params, thresholdDays: 10 }).status, 'flagged');
  });

  test('checkId always matches design.md SS4.1 router prefix_map\'s "check": "gh_provenance" verbatim', () => {
    assert.equal(checkGithubProvenance({ commitPayloads: null, hnPayloads: null }).checkId, 'gh_provenance');
  });
});

// ============================================================================
// SS5.1(c) -- denominator extraction. Every text sample below is a REAL
// claims.text_verbatim string (or a real excerpt of one), read from the live
// database 2026-07-19 -- not invented test prose.
// ============================================================================

describe('extractDenominator -- the Presto/SEC lesson, against real claim text', () => {
  test('the exact live founder.expertise.insight claim (fraud-catch accuracy) -- NEITHER percentage has a denominator, both cap the claim', () => {
    const text = 'We use a proprietary transformer-based architecture, fine-tuned on transaction sequences, achieving 94% fraud-catch accuracy -- well above the roughly 70% typical of the rule-based legacy systems banks currently run.';
    const result = extractDenominator(text);
    assert.equal(result.hasPercentageClaim, true);
    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0].raw, '94%');
    assert.equal(result.matches[0].hasDenominator, false);
    assert.equal(result.matches[1].raw, '70%');
    assert.equal(result.matches[1].hasDenominator, false);
    assert.equal(result.cappedAtUnverified, true);
    assert.equal(result.deepDiveQuestions.length, 2);
  });

  test('a stated sample size resolves the denominator ("40% of our 1,200 beta users renewed")', () => {
    const result = extractDenominator('40% of our 1,200 beta users renewed.');
    assert.equal(result.matches[0].hasDenominator, true);
    assert.equal(result.matches[0].denominatorExcerpt, '1,200');
    assert.equal(result.cappedAtUnverified, false);
    assert.equal(result.deepDiveQuestions.length, 0);
  });

  test('a real live claim excerpt with a vague percentage and no nearby count ("Using 75% of GPU via PodVirt") caps the claim', () => {
    const result = extractDenominator('Using 75% of GPU via PodVirt - pay only for what you use.');
    assert.equal(result.matches[0].hasDenominator, false);
    assert.equal(result.cappedAtUnverified, true);
  });

  test('a real live claim excerpt with an adjacent sample size ("1,099 reqs ... 0.3% failure rate") resolves the denominator', () => {
    const result = extractDenominator('Highest cache hit rate at 99.99%, driving cost efficiency. 1,099 reqs · 2h 26m · 0.3% failure rate');
    assert.equal(result.matches.length, 2);
    assert.equal(result.matches.every((m) => m.hasDenominator), true);
    assert.equal(result.cappedAtUnverified, false);
  });

  test('exactly 100% is a boundary/absolute claim, excluded entirely -- real live corpus phrasings ("100% offline", "100% private") never trip this check', () => {
    assert.equal(extractDenominator('Show HN: PixelUp – A 100% offline, lightweight AI video upscaler for Windows').hasPercentageClaim, false);
    assert.equal(extractDenominator('60 free tools · 100% private · No signup').hasPercentageClaim, false);
    assert.equal(extractDenominator('ONNX Runtime · 100% Client-Side Clone any voice.').hasPercentageClaim, false);
  });

  test('no percentage at all -> hasPercentageClaim false, never capped', () => {
    const result = extractDenominator('We build developer tools for infrastructure automation.');
    assert.equal(result.hasPercentageClaim, false);
    assert.equal(result.cappedAtUnverified, false);
  });

  test('a decimal percentage close to but not exactly the 0/100 boundary is still checked (99.99% is not excluded)', () => {
    const result = extractDenominator('Cache hit rate: 99.99%.');
    assert.equal(result.hasPercentageClaim, true);
    assert.equal(result.matches[0].value, 99.99);
  });

  test("the digits of the percentage figure itself never satisfy its own denominator search (regression: '94%' must not find '9' or '4' inside itself)", () => {
    const result = extractDenominator('Conversion improved to 94% this quarter.');
    assert.equal(result.matches[0].hasDenominator, false);
  });

  test('deepDiveQuestion text names the exact percentage and asks for the missing base', () => {
    const result = extractDenominator('Achieved 42% growth.');
    assert.match(result.matches[0].deepDiveQuestion, /42%/);
    assert.match(result.matches[0].deepDiveQuestion, /denominator/i);
  });

  test('non-string input degrades gracefully, never throws', () => {
    assert.equal(extractDenominator(null).hasPercentageClaim, false);
    assert.equal(extractDenominator(undefined).hasPercentageClaim, false);
  });
});

// ============================================================================
// buildEvidenceRow -- LIVE transactional idempotency proof.
//
// ⚠️ Per the team lead's explicit instruction: runs inside ONE transaction
// that ROLLBACKs (the db/tests/smoke.sql pattern) -- inserts the SAME
// logical evidence row TWICE via `INSERT ... ON CONFLICT (content_hash) DO
// NOTHING`, asserts the second is a no-op (count stays 1), asserts
// raw_signal_id is non-NULL on every row this suite writes, then rolls back
// everything. Nothing here is left in the database.
//
// Requires DATABASE_URL in the environment (see this repo's CLAUDE.md
// "Commands" section for the exact one-liner against infra/supabase/.env).
// Skips (not fails) when DATABASE_URL is unset, so this file stays runnable
// standalone.
// ============================================================================

describe('buildEvidenceRow -- live transactional idempotency proof (DATABASE_URL required)', () => {
  const databaseUrl = process.env.DATABASE_URL;

  test('inserting the same content_hash twice inside one transaction collapses to one row; every row has non-NULL raw_signal_id; ROLLBACK leaves no trace', async (t) => {
    if (!databaseUrl) {
      t.skip('DATABASE_URL not set -- see CLAUDE.md "Commands": PW=$(grep -m1 \'^POSTGRES_PASSWORD=\' infra/supabase/.env | cut -d= -f2-); TEN=$(grep -m1 \'^POOLER_TENANT_ID=\' infra/supabase/.env | cut -d= -f2-); export DATABASE_URL="postgresql://postgres.${TEN}:${PW}@localhost:54322/postgres"');
      return;
    }

    // Real, existing, live claim/raw_signal ids (feature 03's demo fixture,
    // db/fixtures/03-founder-score.sql) -- confirmed present 2026-07-19.
    // Reusing them is safe: this whole test runs inside one transaction that
    // is rolled back at the end, so no second row survives against them.
    const claimId = '03f00006-0000-0000-0000-000000000104';
    const rawSignalId = '03f00007-0000-0000-0000-000000000104';

    const rowParams = {
      claimId,
      relation: 'context',
      tier: 'inferred',
      rawSignalId,
      quoteVerbatim: 'idempotency-proof candidate text (lib/f05/verifiers.test.js)',
      sourceUrl: null,
      checkId: 'test_idempotency_proof',
      candidateKey: 'same-candidate',
    };

    const row1 = await buildEvidenceRow(rowParams);
    const row2 = await buildEvidenceRow({ ...rowParams }); // identical logical inputs
    assert.equal(row1.content_hash, row2.content_hash); // the property that MAKES the DB-level idempotency below possible

    const escape = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
    const insertOnce = (row) =>
      `INSERT INTO evidence (claim_id, relation, tier, strength, quote_verbatim, source_url, raw_signal_id, content_hash) ` +
      `VALUES (${escape(row.claim_id)}, ${escape(row.relation)}, ${escape(row.tier)}, ${escape(row.strength)}, ` +
      `${escape(row.quote_verbatim)}, ${escape(row.source_url)}, ${escape(row.raw_signal_id)}, ${escape(row.content_hash)}) ` +
      `ON CONFLICT (content_hash) DO NOTHING;`;

    const sql = [
      'BEGIN;',
      insertOnce(row1),
      insertOnce(row2), // same content_hash -- must be a no-op, not a second row
      `SELECT count(*) AS n FROM evidence WHERE content_hash = ${escape(row1.content_hash)};`,
      `SELECT count(*) AS non_null_raw_signal_id FROM evidence WHERE content_hash = ${escape(row1.content_hash)} AND raw_signal_id IS NOT NULL;`,
      'ROLLBACK;',
    ].join('\n');

    // -q (quiet) suppresses psql's own BEGIN/INSERT 0 n/ROLLBACK command-tag
    // lines, leaving ONLY the two SELECT results on stdout.
    const output = execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q'], { input: sql, encoding: 'utf8' });
    const counts = output.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);

    // First line is the row's own idempotency count; second is the non-NULL
    // raw_signal_id count for that same row -- both must be exactly 1.
    assert.deepEqual(counts, [1, 1]);
  });
});
