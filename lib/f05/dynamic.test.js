// lib/f05/dynamic.test.js
//
// Tests for lib/f05/dynamic.js (feature 05, Truth-Gap Check & Trust Score,
// task C3 -- the `factual_dynamic` Tavily branch). Run with:
//   node --test lib/f05/dynamic.test.js
// -- NOT the lib/f05/*.test.js glob (plan.md Wave T0's binding rule; C3 runs
// after T0 but the rule's reasoning -- "own test file only" -- still applies
// whenever multiple agents' files share this one new directory).
//
// This file MAY require() -- only lib/f05/dynamic.js itself must stay
// import-free (pure logic, no fetch -- see that file's own header for why).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  registrableDomain,
  isSocialMediaHost,
  isCompanyDomain,
  classifySourceKind,
  tierForSourceKind,
  buildSearchQuery,
  filterByTemporalCutoff,
  dedupeByRegistrableHost,
  isClaimsOwnCitation,
  passesRelevanceGate,
  decideEvidenceAction,
  selectClaimsWithinBudget,
  buildQuoteVerbatim,
} = require('./dynamic.js');

// ============================================================================
// registrableDomain -- duplicated from lib/f05/entity_gate.js by design (this
// file's own header); same behaviour expected, spot-checked rather than
// re-proving entity_gate.test.js's full suite.
// ============================================================================

describe('registrableDomain', () => {
  test('reduces a full URL to eTLD+1, strips www.', () => {
    assert.equal(registrableDomain('https://www.medows.ai/blog'), 'medows.ai');
  });
  test('bare hostname input (companies.domain\'s own storage shape)', () => {
    assert.equal(registrableDomain('gameloop-thesis07.example'), 'gameloop-thesis07.example');
  });
});

// ============================================================================
// classifySourceKind / tierForSourceKind -- design.md SS5.2 rule 4 (social
// can never verify) and SS6.0 (Tier-3 self-reported founder site).
// ============================================================================

describe('classifySourceKind', () => {
  const company = { domain: 'gameloop-thesis07.example', aliases: ['old-gameloop.example'] };

  test('a genuine social-media host classifies as social_media', () => {
    assert.equal(classifySourceKind('https://x.com/someuser/status/123', company), 'social_media');
    assert.equal(classifySourceKind('https://www.reddit.com/r/startups/comments/abc', company), 'social_media');
    assert.equal(classifySourceKind('https://www.linkedin.com/posts/someone_update', company), 'social_media');
  });

  test('hacker news is NOT classified as social media -- already a documented, structured signal elsewhere in this feature', () => {
    assert.equal(classifySourceKind('https://news.ycombinator.com/item?id=123', company), 'third_party');
  });

  test('a medium/substack-style blog host is NOT classified as social media', () => {
    assert.equal(classifySourceKind('https://medium.com/@someone/post', company), 'third_party');
  });

  test('the company\'s own domain (or an alias) classifies as company_domain', () => {
    assert.equal(classifySourceKind('https://gameloop-thesis07.example/pricing', company), 'company_domain');
    assert.equal(classifySourceKind('https://old-gameloop.example/press', company), 'company_domain');
  });

  test('an unrelated third-party host classifies as third_party', () => {
    assert.equal(classifySourceKind('https://www.techcrunch.com/2024/01/01/gameloop-raises', company), 'third_party');
  });

  test('social-host precedence wins even if it happens to equal the stored company domain (defensive ordering)', () => {
    const weirdCompany = { domain: 'x.com', aliases: [] };
    assert.equal(classifySourceKind('https://x.com/gameloop', weirdCompany), 'social_media');
  });
});

describe('tierForSourceKind -- structural enforcement of rule 4 and SS6.0', () => {
  test('social_media and company_domain both cap at inferred (Tier-3, cannot verify or contradict alone)', () => {
    assert.equal(tierForSourceKind('social_media'), 'inferred');
    assert.equal(tierForSourceKind('company_domain'), 'inferred');
  });
  test('third_party is discovered (Tier-2) -- never documented, per this file\'s own scope-limit note', () => {
    assert.equal(tierForSourceKind('third_party'), 'discovered');
  });
});

// ============================================================================
// buildSearchQuery -- SS5.2 rule 2: no domain filtering at retrieval.
// ============================================================================

describe('buildSearchQuery', () => {
  test('combines company name and claim text, no include/exclude_domains anywhere in params', () => {
    const { query, params } = buildSearchQuery(
      { text_verbatim: 'GameLoop has been generating revenue from real users for the past five months.' },
      { name: 'GameLoop' }
    );
    assert.match(query, /^GameLoop /);
    assert.match(query, /generating revenue/);
    assert.equal(params.search_depth, 'basic');
    assert.equal(typeof params.max_results, 'number');
    assert.equal('include_domains' in params, false);
    assert.equal('exclude_domains' in params, false);
    assert.equal('topic' in params, false);
  });

  test('truncates an overlong combined query rather than sending it unbounded', () => {
    const longText = 'x'.repeat(1000);
    const { query } = buildSearchQuery({ text_verbatim: longText }, { name: 'Acme' });
    assert.ok(query.length <= 380);
  });

  test('tolerates a missing company name (still produces a usable query from claim text alone)', () => {
    const { query } = buildSearchQuery({ text_verbatim: 'a working prototype in daily use' }, null);
    assert.match(query, /working prototype/);
  });
});

// ============================================================================
// filterByTemporalCutoff -- SS5.2 rule 1, plus the measured-live "published_date
// is usually absent" reality (this task's own exploratory Tavily call,
// 2026-07-19, search_depth:'basic', no topic param -- three real results, zero
// published_date fields).
// ============================================================================

describe('filterByTemporalCutoff', () => {
  const cutoff = '2026-01-01T00:00:00.000Z';

  test('discards a result POSITIVELY dated after the cutoff', () => {
    const { kept, discarded } = filterByTemporalCutoff(
      [{ url: 'a', published_date: '2026-06-01T00:00:00.000Z' }],
      cutoff
    );
    assert.deepEqual(kept, []);
    assert.equal(discarded.length, 1);
  });

  test('keeps a result dated before or on the cutoff', () => {
    const { kept } = filterByTemporalCutoff(
      [{ url: 'a', published_date: '2025-06-01T00:00:00.000Z' }, { url: 'b', published_date: cutoff }],
      cutoff
    );
    assert.equal(kept.length, 2);
  });

  test('keeps a result with NO published_date at all -- the common case, not discarded on unknown metadata', () => {
    const { kept, discarded } = filterByTemporalCutoff([{ url: 'a' }], cutoff);
    assert.equal(kept.length, 1);
    assert.equal(discarded.length, 0);
  });

  test('an unparseable published_date string is treated the same as absent (kept, not discarded)', () => {
    const { kept } = filterByTemporalCutoff([{ url: 'a', published_date: 'not-a-date' }], cutoff);
    assert.equal(kept.length, 1);
  });

  test('a missing/invalid cutoff never discards anything (fails open, matching the router\'s own fail-safe posture)', () => {
    const { kept, discarded } = filterByTemporalCutoff([{ url: 'a', published_date: '2099-01-01T00:00:00.000Z' }], null);
    assert.equal(kept.length, 1);
    assert.equal(discarded.length, 0);
  });
});

// ============================================================================
// dedupeByRegistrableHost -- SS7.3: independence counts sources, not mentions.
// ============================================================================

describe('dedupeByRegistrableHost', () => {
  test('collapses two pages on the SAME host to one, keeping the higher-scored one', () => {
    const results = [
      { url: 'https://blog.acme.example/1', score: 0.5 },
      { url: 'https://blog.acme.example/2', score: 0.9 },
    ];
    const out = dedupeByRegistrableHost(results);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://blog.acme.example/2');
  });

  test('keeps one entry per DISTINCT host', () => {
    const results = [
      { url: 'https://techcrunch.com/x', score: 0.8 },
      { url: 'https://acme.example/about', score: 0.6 },
    ];
    assert.equal(dedupeByRegistrableHost(results).length, 2);
  });

  test('a host-less (unparseable url) result never collides with another host-less result', () => {
    const results = [{ url: '' }, { url: null }];
    assert.equal(dedupeByRegistrableHost(results).length, 2);
  });
});

// ============================================================================
// isClaimsOwnCitation -- measured live 2026-07-19 against the real Photo AI /
// Pieter Levels traction claim: a Tavily search for the claim text re-
// surfaced the EXACT url the claim itself cites inline as its own footnote.
// ============================================================================

describe('isClaimsOwnCitation', () => {
  const claimText =
    'Pieter Levels has publicly disclosed measured usage and revenue for Photo AI in his own writing: ' +
    '"It has 1,872 paying customers making $61,808 per month" (levels.io/photoai-14000-lines-raw-php-revenue, 2023-07-03).';

  test('the claim\'s own inline-cited url is recognised, scheme/www-insensitive', () => {
    assert.equal(isClaimsOwnCitation(claimText, 'https://levels.io/photoai-14000-lines-raw-php-revenue'), true);
    assert.equal(isClaimsOwnCitation(claimText, 'https://www.levels.io/photoai-14000-lines-raw-php-revenue'), true);
  });

  test('an INDEPENDENT third-party url discussing the same claim is NOT flagged as a self-citation', () => {
    assert.equal(isClaimsOwnCitation(claimText, 'https://getlatka.com/companies/photoai.io'), false);
  });

  test('a claim with no embedded url never flags anything', () => {
    assert.equal(isClaimsOwnCitation('a working prototype in daily use', 'https://techcrunch.com/x'), false);
  });

  test('tolerates a missing/empty url', () => {
    assert.equal(isClaimsOwnCitation(claimText, ''), false);
    assert.equal(isClaimsOwnCitation(claimText, null), false);
  });
});

// ============================================================================
// passesRelevanceGate -- the "GameLoop the emulator vs GameLoop the startup"
// false-positive measured live in this task's own exploratory Tavily call
// (real query, real response, 2026-07-19): a bare company-name query for the
// fictional "GameLoop" returned `https://www.gameloop.com`, the REAL,
// unrelated Android-emulator product, titled "...GameLoop Official 2025" --
// a name-only gate would have passed it as supporting evidence.
// ============================================================================

const GAMELOOP_CLAIM_TEXT =
  'GameLoop lets mobile game publishers add real-money betting mini-games that their casino partners can white-label inside existing apps.';

describe('passesRelevanceGate', () => {
  test('passes when the company name AND a distinctive claim keyword both appear', () => {
    assert.equal(
      passesRelevanceGate('GameLoop', GAMELOOP_CLAIM_TEXT, {
        title: 'GameLoop raises seed round',
        content: 'GameLoop today announced a new white-label casino partnership for mobile publishers.',
      }),
      true
    );
  });

  test('REGRESSION (measured live 2026-07-19): the real, unrelated GameLoop-the-emulator result is correctly REJECTED', () => {
    assert.equal(
      passesRelevanceGate('GameLoop', GAMELOOP_CLAIM_TEXT, {
        title: 'The Best Android Emulator for PC | GameLoop Official 2025',
        content:
          "The Thrill of Call of Duty on the Go. Don't Hold Back, Battle in Style. Welcome to the Game III. Play Online. Moto X3M Bike Race Game.",
      }),
      false
    );
  });

  test('fails when neither title nor content mentions the company at all', () => {
    assert.equal(
      passesRelevanceGate('GameLoop', GAMELOOP_CLAIM_TEXT, {
        title: 'Mini Casino Game Development',
        content: 'Deploy lightweight, mobile-first casino games designed for instant play.',
      }),
      false
    );
  });

  test('with no company name to anchor on, nothing can pass (cannot be checked at all)', () => {
    assert.equal(passesRelevanceGate('', GAMELOOP_CLAIM_TEXT, { title: 'anything', content: 'anything' }), false);
    assert.equal(passesRelevanceGate(null, GAMELOOP_CLAIM_TEXT, { title: 'anything', content: 'anything' }), false);
  });

  test('a claim contributing no distinctive keywords falls back to a name-only match', () => {
    assert.equal(
      passesRelevanceGate('Acme', 'Acme is a company.', { title: 'Acme launches', content: 'Acme today.' }),
      true
    );
  });

  // LIVE INCIDENT, 2026-07-19: an earlier version of this gate (single-hit
  // threshold) passed this EXACT real Tavily result during an actual
  // lib/f05/run.js run against application 07f00002-0000-0000-0000-
  // 000000000004 (GameLoop), writing it as `supports` evidence and flipping
  // two real claims to `verified` before the min(2, available) fix below
  // landed. The bad evidence/raw_signals/events/scores rows from that run
  // could not be deleted afterward (append-only tables, forbid_mutation
  // trigger) -- reported to the team lead rather than corrected by bypassing
  // that trigger. This test pins the fix so the SAME payload can never
  // silently regress it.
  test('REGRESSION (live incident, 2026-07-19): a real gameloop.com page overlapping on only "mobile" is rejected', () => {
    assert.equal(
      passesRelevanceGate('GameLoop', GAMELOOP_CLAIM_TEXT, {
        title: 'Search and dowload all mobile games on ...',
        content:
          'Free download and play your favorite action, MOBA, FPS, RPG, racing mobile games on PC with GameLoop. ' +
          'Come to play and enjoy the ultimate game experience',
      }),
      false
    );
  });
});

// ============================================================================
// buildQuoteVerbatim -- stability tradeoff for evidence.content_hash (see
// this function's own header in lib/f05/dynamic.js).
// ============================================================================

describe('buildQuoteVerbatim', () => {
  test('uses the result title, whitespace-normalized', () => {
    assert.equal(buildQuoteVerbatim({ title: '  GameLoop   raises seed round  ', url: 'https://techcrunch.com/x' }), 'GameLoop raises seed round');
  });
  test('falls back to a host-referencing string when there is no title', () => {
    assert.equal(buildQuoteVerbatim({ url: 'https://techcrunch.com/x' }), '(untitled result at techcrunch.com)');
  });
  test('never throws on a fully empty result', () => {
    assert.equal(buildQuoteVerbatim({}), '(untitled result, no host)');
  });
});

// ============================================================================
// decideEvidenceAction -- the deterministic support/contradict call.
// ============================================================================

describe('decideEvidenceAction', () => {
  test('no mismatch -> supports, tier follows source kind', () => {
    assert.deepEqual(decideEvidenceAction({ hasMismatch: false, sourceKind: 'third_party' }), { action: 'supports', tier: 'discovered' });
  });
  test('a mismatch -> contradicts, still tier-gated by source kind', () => {
    assert.deepEqual(decideEvidenceAction({ hasMismatch: true, sourceKind: 'third_party' }), { action: 'contradicts', tier: 'discovered' });
  });
  test('a social-media mismatch still resolves to inferred tier -- structurally inert either direction (rule 4)', () => {
    assert.deepEqual(decideEvidenceAction({ hasMismatch: true, sourceKind: 'social_media' }), { action: 'contradicts', tier: 'inferred' });
  });
});

// ============================================================================
// selectClaimsWithinBudget -- design.md SS12, seed.sql's
// budget.max_paid_checks_per_card.
// ============================================================================

describe('selectClaimsWithinBudget', () => {
  test('a card at or under the cap: every claim is within budget', () => {
    const claims = [{ claim_id: 'a', card_id: 'card-1' }, { claim_id: 'b', card_id: 'card-1' }];
    const { withinBudget, overBudget } = selectClaimsWithinBudget(claims, 5);
    assert.equal(withinBudget.length, 2);
    assert.equal(overBudget.length, 0);
  });

  test('a card OVER the cap: only the first N (by claim_id, ascending) are within budget', () => {
    const claims = [
      { claim_id: 'c', card_id: 'card-1' },
      { claim_id: 'a', card_id: 'card-1' },
      { claim_id: 'b', card_id: 'card-1' },
    ];
    const { withinBudget, overBudget } = selectClaimsWithinBudget(claims, 2);
    assert.deepEqual(withinBudget.map((c) => c.claim_id), ['a', 'b']);
    assert.deepEqual(overBudget.map((c) => c.claim_id), ['c']);
  });

  test('the cap applies PER CARD, independently -- a second card is never penalised by the first\'s volume', () => {
    const claims = [
      { claim_id: 'a', card_id: 'card-1' }, { claim_id: 'b', card_id: 'card-1' }, { claim_id: 'c', card_id: 'card-1' },
      { claim_id: 'x', card_id: 'card-2' },
    ];
    const { withinBudget, overBudget } = selectClaimsWithinBudget(claims, 2);
    assert.equal(withinBudget.length, 3); // a,b (card-1) + x (card-2)
    assert.equal(overBudget.length, 1); // c (card-1)
    assert.ok(withinBudget.some((c) => c.claim_id === 'x'));
  });

  test('deterministic across repeated calls given the same input order', () => {
    const claims = [{ claim_id: 'z', card_id: 'card-1' }, { claim_id: 'a', card_id: 'card-1' }];
    const first = selectClaimsWithinBudget(claims, 1);
    const second = selectClaimsWithinBudget(claims, 1);
    assert.deepEqual(first.withinBudget.map((c) => c.claim_id), second.withinBudget.map((c) => c.claim_id));
  });
});
