// lib/f08/identity.test.js
//
// Acceptance tests for lib/f08/identity.js, per docs/backlog/
// 08-founder-intake-interview/plan.md T6. Run with: node --test lib/f08/*.js
// (glob form -- the directory form fails with MODULE_NOT_FOUND on Node
// v22.19.0).
//
// This file MAY require() -- only lib/f08/identity.js itself must stay
// import-free (it gets pasted verbatim into an n8n Code node).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGithubOwner,
  extractFirstGithubOwner,
  normalizeEmail,
  emailLocalPart,
  defaultsForNewFounder,
  resolveFounderIdentity,
} = require('./identity.js');

const { parseGithubOwnerRepo } = require('./validate.js');

// A lookup table {kind: {value: founder_id}} turned into the async callback
// resolveFounderIdentity() expects -- the "caller supplies the database
// access" half of the contract, faked here.
function fakeLookup(table) {
  return async (kind, value) => (table[kind] && table[kind][value]) || null;
}

describe('parseGithubOwner / extractFirstGithubOwner', () => {
  test('extracts the owner from a repo URL', () => {
    assert.equal(parseGithubOwner('https://github.com/ayuhito/project'), 'ayuhito');
  });

  test('extracts the owner from an owner-only URL', () => {
    assert.equal(parseGithubOwner('https://github.com/ayuhito'), 'ayuhito');
  });

  test('non-github URL resolves to null', () => {
    assert.equal(parseGithubOwner('https://acme.dev'), null);
  });

  test('takes the FIRST github link in submission order', () => {
    const links = [{ url: 'https://acme.dev' }, { url: 'https://github.com/first' }, { url: 'https://github.com/second' }];
    assert.equal(extractFirstGithubOwner(links), 'first');
  });

  test('no github link anywhere -> null', () => {
    assert.equal(extractFirstGithubOwner([{ url: 'https://acme.dev' }]), null);
    assert.equal(extractFirstGithubOwner([]), null);
    assert.equal(extractFirstGithubOwner(undefined), null);
  });
});

describe('normalizeEmail / emailLocalPart', () => {
  test('lowercases and trims', () => {
    assert.equal(normalizeEmail('  Founder@Acme.DEV  '), 'founder@acme.dev');
  });

  test('empty/missing -> null', () => {
    assert.equal(normalizeEmail(''), null);
    assert.equal(normalizeEmail(undefined), null);
  });

  test('local part is everything before @', () => {
    assert.equal(emailLocalPart('Founder@Acme.dev'), 'founder');
  });
});

describe('defaultsForNewFounder -- design §3.1 NOT NULL defaults', () => {
  test('full_name from deck-extracted name when present', () => {
    const d = defaultsForNewFounder({ contact_email: 'founder@acme.dev', deck_extracted_name: 'Jane Founder' });
    assert.equal(d.full_name, 'Jane Founder');
  });

  test('full_name falls back to the email local-part when extraction produced nothing', () => {
    const d = defaultsForNewFounder({ contact_email: 'founder@acme.dev', deck_extracted_name: null });
    assert.equal(d.full_name, 'founder');
  });

  test('companies.stage is always pre_seed', () => {
    assert.equal(defaultsForNewFounder({ contact_email: 'a@b.com' }).companies_stage, 'pre_seed');
  });

  test('founder_company.role is always founder', () => {
    assert.equal(defaultsForNewFounder({ contact_email: 'a@b.com' }).founder_company_role, 'founder');
  });

  test('companies.domain is ALWAYS null -- never derived from the email domain', () => {
    const d = defaultsForNewFounder({ contact_email: 'founder@acme.dev' });
    assert.equal(d.companies_domain, null);
  });
});

describe('resolveFounderIdentity -- design §3.1 cascade', () => {
  test('AC: a github owner matching an existing identity returns attach, with an email identity to add, and creates no second founder', async () => {
    const lookup = fakeLookup({ github: { ayuhito: 'founder-123' } });
    const result = await resolveFounderIdentity(
      { contact_email: 'ayuhito@newmail.dev', artifact_links: [{ url: 'https://github.com/ayuhito/project' }] },
      lookup
    );
    assert.equal(result.action, 'attach');
    assert.equal(result.founder_id, 'founder-123');
    assert.deepEqual(result.identities_to_write, [{ kind: 'email', value: 'ayuhito@newmail.dev' }]);
  });

  test('AC: a payload with neither a github nor an email match returns create', async () => {
    const lookup = fakeLookup({});
    const result = await resolveFounderIdentity(
      { contact_email: 'new-founder@acme.dev', artifact_links: [] },
      lookup
    );
    assert.equal(result.action, 'create');
    assert.equal(result.founder_id, null);
  });

  test('email match (no github match) attaches to the founder found via email', async () => {
    const lookup = fakeLookup({ email: { 'founder@acme.dev': 'founder-456' } });
    const result = await resolveFounderIdentity({ contact_email: 'Founder@Acme.dev', artifact_links: [] }, lookup);
    assert.equal(result.action, 'attach');
    assert.equal(result.founder_id, 'founder-456');
  });

  test('email matches AND payload carries an unmatched github owner -> the github identity is attached too', async () => {
    const lookup = fakeLookup({ email: { 'founder@acme.dev': 'founder-456' } }); // github lookup returns nothing
    const result = await resolveFounderIdentity(
      { contact_email: 'founder@acme.dev', artifact_links: [{ url: 'https://github.com/newhandle' }] },
      lookup
    );
    assert.equal(result.action, 'attach');
    assert.equal(result.founder_id, 'founder-456');
    assert.deepEqual(result.identities_to_write, [{ kind: 'github', value: 'newhandle' }]);
  });

  test('create path writes both identities when a github owner is present and unmatched', async () => {
    const lookup = fakeLookup({});
    const result = await resolveFounderIdentity(
      { contact_email: 'new@acme.dev', artifact_links: [{ url: 'https://github.com/brandnew' }] },
      lookup
    );
    assert.equal(result.action, 'create');
    assert.deepEqual(result.identities_to_write, [
      { kind: 'email', value: 'new@acme.dev' },
      { kind: 'github', value: 'brandnew' },
    ]);
    assert.equal(result.defaults.companies_domain, null);
  });

  test('github match takes priority even when email ALSO independently matches a different founder', async () => {
    // This is the case §3.1 exists for: a radar-discovered founder applies.
    // Even if their submitted email happens to already be attached to some
    // OTHER founder row (e.g. a data quirk), the github match must win --
    // "first match wins", not "most matches wins".
    const lookup = fakeLookup({
      github: { ayuhito: 'radar-founder' },
      email: { 'ayuhito@personal.dev': 'unrelated-founder' },
    });
    const result = await resolveFounderIdentity(
      { contact_email: 'ayuhito@personal.dev', artifact_links: [{ url: 'https://github.com/ayuhito' }] },
      lookup
    );
    assert.equal(result.founder_id, 'radar-founder');
  });

  test('no email and no github -> create with an empty identities_to_write', async () => {
    const lookup = fakeLookup({});
    const result = await resolveFounderIdentity({ contact_email: '', artifact_links: [] }, lookup);
    assert.equal(result.action, 'create');
    assert.deepEqual(result.identities_to_write, []);
  });
});

// ============================================================================
// identity.js's own duplicated github-URL parser (parseGithubOwner) must
// agree with validate.js's parseGithubOwnerRepo on the owner it extracts --
// zero-imports forbids sharing the parser directly (see identity.js's
// header), same pattern lib/f02/identity.test.js uses to cross-check its
// own duplicated helper against lib/f02/normalize.js.
// ============================================================================

describe('parseGithubOwner stays consistent with validate.js', () => {
  test('agrees with parseGithubOwnerRepo on the owner for a sample of URLs', () => {
    const samples = [
      'https://github.com/ayuhito/project',
      'https://github.com/ayuhito',
      'github.com/acme/core.git',
      'https://acme.dev',
      'not a url at all',
    ];
    for (const url of samples) {
      assert.equal(parseGithubOwner(url), parseGithubOwnerRepo(url).owner, `disagreement on ${url}`);
    }
  });
});

// ============================================================================
// Proves this file does not depend on the `URL` global -- same rationale as
// validate.test.js's identical block: `URL` is undefined in this project's
// n8n Code-node sandbox (confirmed live, docs/backlog/02-sourcing-radar/
// done.md), and `node --test` alone cannot catch that class of bug since
// real Node has `URL` natively.
// ============================================================================

describe('identity.js does not depend on the URL global', () => {
  test('parseGithubOwner and resolveFounderIdentity still work with globalThis.URL deleted', async () => {
    const originalUrl = globalThis.URL;
    const hadUrl = Object.prototype.hasOwnProperty.call(globalThis, 'URL');
    delete globalThis.URL;
    try {
      assert.equal(typeof globalThis.URL, 'undefined', 'test setup failed to actually remove URL');

      assert.equal(parseGithubOwner('https://github.com/ayuhito/project'), 'ayuhito');
      assert.equal(parseGithubOwner('github.com/ayuhito'), 'ayuhito');
      assert.equal(parseGithubOwner('https://acme.dev'), null);

      const lookup = fakeLookup({ github: { ayuhito: 'founder-123' } });
      const result = await resolveFounderIdentity(
        { contact_email: 'ayuhito@newmail.dev', artifact_links: [{ url: 'https://github.com/ayuhito/project' }] },
        lookup
      );
      assert.equal(result.action, 'attach');
      assert.equal(result.founder_id, 'founder-123');
    } finally {
      if (hadUrl) globalThis.URL = originalUrl;
    }
  });
});
