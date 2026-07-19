// lib/f05/entity_gate.test.js
//
// Tests for lib/f05/entity_gate.js (feature 05, Truth-Gap Check & Trust
// Score, task B2). Run with: node --test lib/f05/entity_gate.test.js
// -- ⚠️ NOT the lib/f05/*.test.js glob: three other T0 agents are creating
// files in this same new directory right now (plan.md Wave T0 binding rule).
//
// This file MAY require() -- only lib/f05/entity_gate.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { applyEntityGate, domainMatchesEntity, registrableDomain } = require('./entity_gate.js');

// ============================================================================
// registrableDomain -- eTLD+1 reduction, both URL and bare-host input forms
// (companies.domain is stored bare, e.g. "photoai.com" -- measured live
// 2026-07-19; candidate.sourceUrl is a full URL).
// ============================================================================

describe('registrableDomain', () => {
  test('reduces a full URL to its eTLD+1, stripping www.', () => {
    assert.equal(registrableDomain('https://www.photoai.com/pricing'), 'photoai.com');
    assert.equal(registrableDomain('https://blog.photoai.com/post-1'), 'photoai.com');
  });
  test('accepts a bare hostname (the shape companies.domain is stored in)', () => {
    assert.equal(registrableDomain('photoai.com'), 'photoai.com');
    assert.equal(registrableDomain('fintrace-ai.example'), 'fintrace-ai.example');
  });
  test('two-label public suffixes reduce to the last THREE labels, not two', () => {
    assert.equal(registrableDomain('https://shop.example.co.uk'), 'example.co.uk');
  });
  test('a bare host with no dot at all is not a domain', () => {
    assert.equal(registrableDomain('localhost'), null);
  });
  test('empty/unparseable input returns null, never throws', () => {
    assert.equal(registrableDomain(''), null);
    assert.equal(registrableDomain(null), null);
    assert.equal(registrableDomain(undefined), null);
  });
});

// ============================================================================
// domainMatchesEntity -- design.md SS6 step 2.
// ============================================================================

describe('domainMatchesEntity -- SS6 step 2', () => {
  const entity = { companyDomain: 'acme.example', companyAliases: ['old-acme.example'] };

  test('matches a subdomain of companies.domain', () => {
    assert.equal(domainMatchesEntity('https://blog.acme.example/post', entity), 'acme.example');
  });
  test('matches an entry in companies.aliases', () => {
    assert.equal(domainMatchesEntity('https://old-acme.example/press', entity), 'old-acme.example');
  });
  test('a similarly-named but unrelated domain does NOT match -- the exact >80%-false-contradiction failure mode', () => {
    assert.equal(domainMatchesEntity('https://acme-corp-of-ohio.example/news', entity), null);
  });
  test('no sourceUrl at all -> null, never throws', () => {
    assert.equal(domainMatchesEntity(null, entity), null);
    assert.equal(domainMatchesEntity(undefined, entity), null);
  });
  test('entity with no companyDomain/companyAliases at all -> null', () => {
    assert.equal(domainMatchesEntity('https://acme.example/page', {}), null);
  });
});

// ============================================================================
// applyEntityGate -- the four ordered, fail-closed steps.
// ============================================================================

describe('applyEntityGate -- step 1: raw_signal_id FK resolution', () => {
  test('founder_id FK match resolves by construction', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-1',
      candidate: { sourceUrl: 'https://unrelated.example/page', quote: 'X actually does Y', tier: 'discovered' },
      rawSignal: { id: 'rs-1', founderId: 'founder-A', companyId: null },
      entity: { founderId: 'founder-A', companyId: 'company-A', companyDomain: 'acme.example' },
    });
    assert.equal(result.resolved, true);
    assert.equal(result.entityMatch.resolved_by, 'raw_signal_fk');
    assert.equal(result.downgradedTo, null);
    assert.equal(result.contextRowFields, null);
  });

  test('company_id FK match resolves by construction', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-1b',
      candidate: { sourceUrl: null, quote: 'quote', tier: 'documented' },
      rawSignal: { id: 'rs-1b', founderId: null, companyId: 'company-A' },
      entity: { founderId: 'founder-A', companyId: 'company-A' },
    });
    assert.equal(result.resolved, true);
    assert.equal(result.entityMatch.resolved_by, 'raw_signal_fk');
  });

  test('a raw_signal FK pointing at a DIFFERENT entity does not resolve step 1 -- falls through, does not early-fail', async () => {
    // No domain match either here, so this must land on step 4.
    const result = await applyEntityGate({
      claimId: 'claim-1c',
      candidate: { sourceUrl: 'https://nowhere.example/x', quote: 'quote', tier: 'discovered' },
      rawSignal: { id: 'rs-1c', founderId: 'founder-OTHER', companyId: 'company-OTHER' },
      entity: { founderId: 'founder-A', companyId: 'company-A' },
    });
    assert.equal(result.resolved, false);
    assert.equal(result.contextRowFields.rawSignalId, 'rs-1c'); // raw_signal_id still carried through
  });

  test('no raw_signal at all (null) does not throw -- step 1 simply does not apply', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-1d',
      candidate: { sourceUrl: 'https://acme.example/page', quote: 'quote', tier: 'documented' },
      rawSignal: null,
      entity: { companyDomain: 'acme.example' },
    });
    assert.equal(result.resolved, true); // saved by step 2's domain match instead
    assert.equal(result.entityMatch.resolved_by, 'domain');
  });
});

describe('applyEntityGate -- step 2: registrable-domain match', () => {
  test('candidate source domain matching companies.domain resolves', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-2',
      candidate: { sourceUrl: 'https://blog.acme.example/post-1', quote: 'Acme pivoted in March', tier: 'discovered' },
      rawSignal: { id: 'rs-2', founderId: 'founder-OTHER', companyId: 'company-OTHER' },
      entity: { founderId: 'founder-A', companyId: 'company-A', companyDomain: 'acme.example' },
    });
    assert.equal(result.resolved, true);
    assert.equal(result.entityMatch.resolved_by, 'domain');
    assert.equal(result.entityMatch.disambiguator, 'acme.example');
  });

  test('candidate source domain matching a companies.aliases entry resolves', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-2b',
      candidate: { sourceUrl: 'https://old-acme.example/press', quote: 'legacy brand mention', tier: 'discovered' },
      rawSignal: null,
      entity: { companyDomain: 'acme.example', companyAliases: ['old-acme.example'] },
    });
    assert.equal(result.resolved, true);
    assert.equal(result.entityMatch.disambiguator, 'old-acme.example');
  });
});

describe('applyEntityGate -- step 3: injected LLM hook (owned by task C1b; optional here)', () => {
  test('omitted hook -- step 3 is skipped entirely, falls straight to step 4', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-3a',
      candidate: { sourceUrl: 'https://nowhere.example/x', quote: 'quote', tier: 'discovered' },
      rawSignal: null,
      entity: {},
      // matchWithLlm intentionally omitted
    });
    assert.equal(result.resolved, false);
    assert.equal(result.downgradedTo, 'unverified');
  });

  test('hook returns a valid { quote, disambiguator } -> resolves as llm_quote', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-3b',
      candidate: { sourceUrl: 'https://news.example/story', quote: 'Acme (acme.example) laid off staff', tier: 'discovered' },
      rawSignal: null,
      entity: { companyDomain: 'acme.example' },
      matchWithLlm: async () => ({ quote: 'Acme (acme.example) laid off staff', disambiguator: 'acme.example' }),
    });
    assert.equal(result.resolved, true);
    assert.equal(result.entityMatch.resolved_by, 'llm_quote');
    assert.equal(result.entityMatch.disambiguator, 'acme.example');
  });

  test('hook returns null -- treated exactly like "no hook", falls to step 4, never throws', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-3c',
      candidate: { sourceUrl: null, quote: 'quote', tier: 'discovered' },
      rawSignal: null,
      entity: {},
      matchWithLlm: async () => null,
    });
    assert.equal(result.resolved, false);
  });

  test('hook returns a malformed shape (missing disambiguator) -- rejected structurally, falls to step 4', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-3d',
      candidate: { sourceUrl: null, quote: 'quote', tier: 'discovered' },
      rawSignal: null,
      entity: {},
      matchWithLlm: async () => ({ quote: 'something' }), // no disambiguator
    });
    assert.equal(result.resolved, false);
  });

  test('hook returns an empty-string quote/disambiguator -- rejected (non-empty required), falls to step 4', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-3e',
      candidate: { sourceUrl: null, quote: 'quote', tier: 'discovered' },
      rawSignal: null,
      entity: {},
      matchWithLlm: async () => ({ quote: '  ', disambiguator: '' }),
    });
    assert.equal(result.resolved, false);
  });
});

describe('applyEntityGate -- step 4: downgrade + auditable context row (the >80%-false-contradiction guard)', () => {
  test('a similarly-named but unrelated source is downgraded, never silently dropped', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-4',
      candidate: {
        sourceUrl: 'https://acme-corp-of-ohio.example/news',
        quote: 'Acme Corp of Ohio filed for bankruptcy',
        tier: 'discovered',
      },
      rawSignal: { id: 'rs-4', founderId: 'founder-OTHER', companyId: 'company-OTHER' },
      entity: { founderId: 'founder-A', companyId: 'company-A', companyDomain: 'acme.example' },
    });
    assert.equal(result.resolved, false);
    assert.equal(result.downgradedTo, 'unverified');
    assert.deepEqual(result.contextRowFields, {
      claimId: 'claim-4',
      relation: 'context',
      tier: 'discovered',
      quoteVerbatim: 'Acme Corp of Ohio filed for bankruptcy',
      sourceUrl: 'https://acme-corp-of-ohio.example/news',
      rawSignalId: 'rs-4',
      checkId: 'entity_gate',
      candidateKey: 'Acme Corp of Ohio filed for bankruptcy', // SS10.1: candidate text itself
    });
  });

  test('contextRowFields.candidateKey differs across two different failed candidates on the same claim -- no content_hash collision', async () => {
    const r1 = await applyEntityGate({
      claimId: 'claim-5',
      candidate: { sourceUrl: null, quote: 'candidate A text', tier: 'discovered' },
      rawSignal: { id: 'rs-5a' },
      entity: {},
    });
    const r2 = await applyEntityGate({
      claimId: 'claim-5',
      candidate: { sourceUrl: null, quote: 'candidate B text', tier: 'discovered' },
      rawSignal: { id: 'rs-5b' },
      entity: {},
    });
    assert.notEqual(r1.contextRowFields.candidateKey, r2.contextRowFields.candidateKey);
  });

  test('rawSignalId is null in contextRowFields when no rawSignal was supplied at all (caller/buildEvidenceRow enforces the non-NULL invariant, not this file)', async () => {
    const result = await applyEntityGate({
      claimId: 'claim-6',
      candidate: { sourceUrl: null, quote: 'quote', tier: 'discovered' },
      rawSignal: null,
      entity: {},
    });
    assert.equal(result.resolved, false);
    assert.equal(result.contextRowFields.rawSignalId, null);
  });
});

// ============================================================================
// Integration: a step-4 downgrade's contextRowFields feeds directly into
// lib/f05/verifiers.js's buildEvidenceRow() (the two modules stay mutually
// zero-import; only THIS test file may require both).
// ============================================================================

describe('integration -- contextRowFields composes with verifiers.buildEvidenceRow', () => {
  test('a full downgrade round-trips into a valid evidence row with non-NULL raw_signal_id', async () => {
    const { buildEvidenceRow } = require('./verifiers.js');
    const gateResult = await applyEntityGate({
      claimId: 'claim-7',
      candidate: { sourceUrl: 'https://acme-corp-of-ohio.example/news', quote: 'Acme Corp of Ohio filed for bankruptcy', tier: 'discovered' },
      rawSignal: { id: 'rs-7', founderId: 'founder-OTHER' },
      entity: { founderId: 'founder-A' },
    });
    assert.equal(gateResult.resolved, false);
    const row = await buildEvidenceRow(gateResult.contextRowFields);
    assert.equal(row.raw_signal_id, 'rs-7');
    assert.equal(row.relation, 'context');
    assert.equal(row.claim_id, 'claim-7');
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  });

  test('buildEvidenceRow REFUSES a downgrade row with no raw_signal_id at all (fail-closed, SS2.1)', async () => {
    const { buildEvidenceRow } = require('./verifiers.js');
    const gateResult = await applyEntityGate({
      claimId: 'claim-8',
      candidate: { sourceUrl: null, quote: 'quote', tier: 'discovered' },
      rawSignal: null, // no raw_signal reachable at all
      entity: {},
    });
    assert.equal(gateResult.contextRowFields.rawSignalId, null);
    await assert.rejects(() => buildEvidenceRow(gateResult.contextRowFields), /rawSignalId is required/);
  });
});
