// lib/f08/identity.js
// SOURCE OF TRUTH: lib/f08/identity.js
//
// Founder identity resolution for feature 08 (Founder Intake), design.md
// §3.1 ("Identity resolution -- honest about what it does and does not
// guarantee"). THE most important module in this feature (plan.md T6): a
// radar-discovered founder (feature 02, anchored on `founder_identities
// (kind='hn'/'github', ...)`) who then applies through this form must
// resolve to the SAME `founders` row, or they walk into their own
// application as a second, score-less person -- the exact narrative the
// project's demo (`ayuhito`) leads with.
//
// This file does NOT talk to the database. It is a pure decision function:
// given the submitted payload and a caller-supplied async `lookupIdentity`
// callback (real Postgres/PostgREST lookup in production, a canned fake in
// tests), it returns what to do -- never what was done. "The n8n workflow
// supplies the database access; this stays testable offline" (plan.md T6).
//
// Self-contained CommonJS, ZERO imports/requires (docs/backlog/TRACKER.md
// hard convention). The github-URL parser below is a deliberate small
// DUPLICATE of lib/f08/validate.js's `parseAbsoluteHttpUrl` -- each
// lib/f08/*.js file is pasted into its OWN separate n8n Code node, so
// neither may require() the other. Same "small pure helpers copied per
// file" pattern lib/f02/identity.js and lib/f04/provenance.js already
// establish in this repo (see lib/f02/identity.js's header for the
// precedent) -- a cross-check test in identity.test.js keeps the two copies
// honest against each other.
//
// Manual regex/string parsing, NOT `new URL()` -- `URL` is undefined in
// this project's n8n Code-node sandbox (confirmed live, docs/backlog/
// 02-sourcing-radar/done.md's carried-risk section: a swallowed
// ReferenceError from a missing `URL` global silently classified every
// artifact as `kind:'none'`). See lib/f08/validate.js's header for the
// full incident and the team lead's correction. No try/catch appears
// below for the same reason stated there: nothing here can throw on
// well-formed JS input, so there is no ReferenceError-shaped failure left
// to swallow.

'use strict';

// ----------------------------------------------------------------------------
// Small duplicate of validate.js's github URL parser -- see file header.
// ----------------------------------------------------------------------------

function parseGithubOwner(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;

  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(candidate);
  if (!m) return null;

  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  const authority = m[2];
  if (!authority || authority.indexOf('@') !== -1) return null; // empty or credentialed -- reject

  const colonIndex = authority.indexOf(':');
  const hostPart = colonIndex === -1 ? authority : authority.slice(0, colonIndex);
  const portPart = colonIndex === -1 ? '' : authority.slice(colonIndex + 1);
  if (portPart && !/^\d+$/.test(portPart)) return null;
  if (!/^[a-zA-Z0-9.-]+$/.test(hostPart)) return null;

  let host = hostPart.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (host !== 'github.com') return null;

  const pathOnly = m[3].split(/[?#]/)[0] || '';
  const segments = pathOnly.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0];
}

// Design §3.1 case 1 is stated against "artifact_links → GitHub", singular,
// with no tie-break rule for a payload carrying more than one github.com
// link -- taking the FIRST one (in submission order) is this file's own,
// documented choice, not something design.md specifies.
function extractFirstGithubOwner(artifactLinks) {
  const list = Array.isArray(artifactLinks) ? artifactLinks : [];
  for (const item of list) {
    const url = item && typeof item === 'object' ? item.url : item;
    const owner = parseGithubOwner(url);
    if (owner) return owner;
  }
  return null;
}

function normalizeEmail(email) {
  const trimmed = String(email == null ? '' : email).trim().toLowerCase();
  return trimmed || null;
}

function emailLocalPart(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const at = normalized.indexOf('@');
  return at > 0 ? normalized.slice(0, at) : normalized;
}

// ----------------------------------------------------------------------------
// Column defaults design.md §3.1 fixes, because a three-field form cannot
// supply three NOT NULL columns. Exported standalone (in addition to being
// folded into resolveFounderIdentity()'s `create` branch below) so each
// default is independently testable and independently reviewable.
// ----------------------------------------------------------------------------

function defaultsForNewFounder({ contact_email, deck_extracted_name } = {}) {
  const deckName = typeof deck_extracted_name === 'string' ? deck_extracted_name.trim() : '';
  return {
    // deck-extracted founder name, falling back to the email local-part.
    full_name: deckName || emailLocalPart(contact_email) || 'Unknown founder',
    // Early-stage only (operator decision baked into companies.stage's own
    // CHECK constraint, db/schema.sql) -- intake never supplies a stage.
    companies_stage: 'pre_seed',
    founder_company_role: 'founder',
    // NEVER derived from the email domain: companies.domain is UNIQUE, and
    // deriving it would make a second founder at the same company (e.g. two
    // co-founders applying separately, or the shared-inbox case §3.1 itself
    // names) a deterministic 23505 on their very first insert.
    companies_domain: null,
  };
}

// ----------------------------------------------------------------------------
// resolveFounderIdentity -- design.md §3.1's cascade, first match wins.
//
// resolveFounderIdentity(payload, lookupIdentity) -> Promise<{
//   action: 'attach' | 'create',
//   founder_id: string | null,          // set on 'attach', null on 'create'
//   identities_to_write: [{kind, value}],
//   defaults: {...} | null,             // only meaningful on 'create'
// }>
//
//   payload.contact_email    -- required; the form's one stable identifier.
//   payload.artifact_links   -- optional array of {url[, kind]} (already
//                                validated/normalized by lib/f08/validate.js
//                                upstream in the write path -- design.md §3
//                                step 3 runs after step 1's Validate).
//   payload.deck_extracted_name -- optional; the deck-claims-extractor
//                                agent's output (design.md §7), or null/
//                                undefined if extraction produced nothing.
//                                This file does no extraction itself.
//
//   lookupIdentity(kind, value) -> Promise<founder_id | null> -- caller-
//   supplied. `kind` is 'github' or 'email'; `value` is already normalized
//   (lowercased owner/email) by this file before the call, so the caller's
//   lookup can do a bare equality match against
//   `founder_identities(kind, value)` (UNIQUE(kind, value), db/schema.sql).
//
// design.md §3.1, verbatim on ordering: "1. artifact_links → GitHub ...
// 2. Email ... 3. Otherwise create a new founder, attaching the email
// identity. On a match at (1), the email identity is attached to the
// existing founder."
//
// Extension beyond that literal text, documented rather than silently
// assumed: if resolution lands on a match at step 2 (email) and the payload
// ALSO carries a github owner that step 1's lookup found NO match for, that
// github identity is attached too (it cannot collide -- step 1 already
// proved no OTHER founder owns it) rather than silently dropped. Symmetric
// reasoning applies on `create`: a github owner present in the payload with
// no existing match is written as a fresh identity on the new founder, so a
// LATER radar pass or re-application can resolve back to this same person --
// otherwise the github-first rule this file exists for would only ever run
// in one direction (radar-then-intake), never (intake-then-radar). Neither
// extension is spelled out in design.md §3.1's prose; both follow directly
// from its own stated purpose and are called out here for review rather
// than assumed silently.
async function resolveFounderIdentity(payload, lookupIdentity) {
  const p = payload || {};
  const githubOwner = extractFirstGithubOwner(p.artifact_links);
  const email = normalizeEmail(p.contact_email);

  // ---- step 1: github.com owner parsed from artifact_links.
  if (githubOwner) {
    const founderId = await lookupIdentity('github', githubOwner);
    if (founderId) {
      const identities = [];
      if (email) identities.push({ kind: 'email', value: email });
      return { action: 'attach', founder_id: founderId, identities_to_write: identities, defaults: null };
    }
  }

  // ---- step 2: email.
  if (email) {
    const founderId = await lookupIdentity('email', email);
    if (founderId) {
      const identities = [];
      // Safe to attach: step 1 above already proved no OTHER founder owns
      // this github identity (or there was none in the payload at all).
      if (githubOwner) identities.push({ kind: 'github', value: githubOwner });
      return { action: 'attach', founder_id: founderId, identities_to_write: identities, defaults: null };
    }
  }

  // ---- step 3: create.
  const identities = [];
  if (email) identities.push({ kind: 'email', value: email });
  if (githubOwner) identities.push({ kind: 'github', value: githubOwner });
  return {
    action: 'create',
    founder_id: null,
    identities_to_write: identities,
    defaults: defaultsForNewFounder({ contact_email: p.contact_email, deck_extracted_name: p.deck_extracted_name }),
  };
}

module.exports = {
  parseGithubOwner,
  extractFirstGithubOwner,
  normalizeEmail,
  emailLocalPart,
  defaultsForNewFounder,
  resolveFounderIdentity,
};
