// lib/f02/normalize.js
// SOURCE OF TRUTH: lib/f02/normalize.js
//
// Text/domain/hash primitives for feature 02 (Sourcing Radar), ported
// (semantics-preserving, NOT copied -- source is Python) from vantage's
// `vantage/services/text.py` (MIT, stdlib only) per design.md §9 borrow
// item 1 and plan.md Task 1.
//
// Self-contained CommonJS. ZERO imports, zero dependencies -- this file's
// body is pasted verbatim into an n8n Code node behind this header
// (docs/backlog/TRACKER.md hard convention); n8n's sandbox cannot
// require() from the repo. SHA-256 therefore uses the Web Crypto global
// (`globalThis.crypto.subtle`), available unflagged in Node 22 and in
// n8n's Code-node sandbox, instead of `require('node:crypto')` -- a
// deliberate divergence from lib/f04/provenance.js and lib/f07/hashes.js,
// which predate this constraint being confirmed live in an n8n Code node.
// Every hashing function here is therefore ASYNC where its f03/f04/f07
// counterpart is sync; callers must `await` it.

'use strict';

// ============================================================================
// contentHash -- design.md §6.1: "sha256(source || '::' || source_id ||
// '::' || observed_at)" for raw_signals, and the analogous recipes for
// claims/evidence in the same table. The '::' delimiter is design's OWN
// choice, not an implementation detail (contrast lib/f04/provenance.js and
// lib/f07/hashes.js, which use a NUL/space delimiter because THEIR design
// docs left the join character unspecified -- 02's design.md spells '::'
// out explicitly, so every recipe built with this helper uses the same
// one).
// ============================================================================

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// contentHash(parts) -- parts: an array of values (any type coerced to
// string; null/undefined become ''), joined with '::' per design §6.1,
// then hashed. A bare non-array value is also accepted and treated as a
// single-element array, so a one-field caller does not have to remember to
// wrap it. Argument ORDER matters (§6.1's recipes are positional, e.g.
// `source || '::' || source_id || '::' || observed_at` is not the same
// hash as the fields reordered) -- callers must pass parts in the recipe's
// own order.
async function contentHash(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  const basis = list
    .map((part) => (part === null || part === undefined ? '' : String(part)))
    .join('::');
  return sha256Hex(basis);
}

// ============================================================================
// canonicalDomain -- design.md §4.1 ("vantage's canonical_domain +
// _GENERIC_HOSTS guard, borrowed verbatim") + plan.md Task 1's explicit
// host list, which is a SUPERSET of vantage's own _GENERIC_HOSTS extended
// for this project's actual candidate pool: gitlab.com, netlify.app,
// pages.dev, chromewebstore.google.com, apps.apple.com, play.google.com,
// huggingface.co, replit.app, streamlit.app, herokuapp.com are not in
// vantage's original set and are added here on the task brief's explicit
// instruction.
// ============================================================================

const GENERIC_HOSTS = new Set([
  'github.com', 'github.io', 'gitlab.com',
  'vercel.app', 'netlify.app', 'pages.dev',
  'notion.site', 'substack.com', 'medium.com',
  'linkedin.com', 'twitter.com', 'x.com',
  'producthunt.com', 'ycombinator.com',
  'chromewebstore.google.com', 'apps.apple.com', 'play.google.com',
  'huggingface.co', 'replit.app', 'streamlit.app', 'herokuapp.com',
]);

// Second-level labels that, paired with a 2-letter final label, mean the
// PUBLIC SUFFIX is 2 labels wide (co.uk, com.au, co.jp, ...) rather than 1
// (.com, .io, ...) -- vantage's own heuristic (text.py:60), ported as-is
// rather than hardcoding a country list: "sub.acme.co.uk" reduces to
// "acme.co.uk" because 'co' + a 2-letter TLD ('uk') is caught here, not
// because ".co.uk" itself is enumerated anywhere. Deliberately the same
// "short hardcoded list is fine and correct here" pragmatism the task
// brief calls for, not a full public-suffix-list dependency.
const TWO_LABEL_SUFFIX_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);

// True when `host` IS `genericHost` or a subdomain of it (host is already
// www-stripped by the caller). Matching against the FULL host, before any
// label reduction, is what makes the 3-label consumer-marketplace entries
// (chromewebstore.google.com, apps.apple.com, play.google.com) work
// correctly: reduceToRootDomain() alone would collapse
// "chromewebstore.google.com" to "google.com", which is NOT itself in
// GENERIC_HOSTS, so the generic check must run first, against the
// unreduced host.
function hostIsGenericOrSubdomainOfGeneric(host) {
  for (const generic of GENERIC_HOSTS) {
    if (host === generic || host.endsWith('.' + generic)) return true;
  }
  return false;
}

// Reduce a full hostname to its registrable root (vantage text.py:58-62,
// ported): sub.sub.acme.co.uk -> acme.co.uk ; sub.acme.com -> acme.com.
function reduceToRootDomain(host) {
  const labels = host.split('.');
  if (
    labels.length >= 3 &&
    TWO_LABEL_SUFFIX_SECOND_LEVEL.has(labels[labels.length - 2]) &&
    labels[labels.length - 1].length === 2
  ) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

// canonicalDomain(url) -> registrable domain, or null for: empty input, an
// unparseable URL, a bare host with no dot, or any GENERIC_HOSTS entry (or
// subdomain thereof) -- design §4.1: "must never count as a company
// domain, or half the cold-start founders merge into one company."
function canonicalDomain(urlOrHost) {
  if (!urlOrHost) return null;
  let raw = String(urlOrHost).trim().toLowerCase();
  if (!raw) return null;
  if (!raw.includes('://')) raw = 'http://' + raw;

  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || !host.includes('.')) return null;

  if (hostIsGenericOrSubdomainOfGeneric(host)) return null;

  return reduceToRootDomain(host);
}

// ============================================================================
// normalizeName -- plan.md Task 1: "lower/trim, strip legal + AI-era
// suffixes". This project's OWN suffix list (task brief), narrower than
// vantage's larger _LEGAL_SUFFIXES set on purpose: vantage's set includes
// generic corporate suffixes (corp, plc, gmbh's siblings ag/sa/srl/bv,
// software, systems) this project's candidate pool (solo/small pre-seed
// teams, frequently ".ai"/".io"/".app"-branded) does not need, plus
// AI-era suffixes (ai, labs, technologies, hq) vantage never anticipated.
// ============================================================================

const NAME_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'gmbh', 'ai', 'labs',
  'technologies', 'technology', 'io', 'app', 'hq',
]);

function normalizeName(name) {
  if (!name) return '';
  let s = String(name).toLowerCase().trim();
  s = s.replace(/[^\w\s&.-]/g, ' '); // vantage text.py:34, ported as-is
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length && NAME_SUFFIXES.has(tokens[tokens.length - 1].replace(/\.$/, ''))) {
    tokens.pop();
  }
  return tokens.join(' ').trim();
}

// ============================================================================
// parseArtifactUrl -- design.md §4 ("the artefact is the URL in the post,
// whatever it points to") + §4.1's path table (A: github repo, B: any
// other domain = product, C: no url). plan.md Task 1's four-kind enum.
// ============================================================================

function emptyArtifact(host) {
  return { kind: 'none', owner: null, repo: null, host: host || null };
}

function parseArtifactUrl(url) {
  if (!url) return emptyArtifact(null);

  let raw = String(url).trim();
  if (!raw) return emptyArtifact(null);
  if (!raw.includes('://')) raw = 'http://' + raw;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return emptyArtifact(null);
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  if (host !== 'github.com') {
    return { kind: 'product', owner: null, repo: null, host };
  }

  // design §4 path A: github.com/{owner}/{repo}. A bare "github.com" URL
  // with NO path segment at all resolves NOTHING (kind 'none') rather than
  // a hollow 'github_user' with owner:null -- an owner-only URL
  // (github.com/{owner}) DOES carry an owner and is 'github_user' (§4.1's
  // "artefact owner is a User/Organization" case, e.g. a Show HN post
  // linking straight to a profile rather than a specific repo); identity.js
  // callers need to tell "profile link" and "nothing at all" apart.
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return emptyArtifact(host);

  const owner = segments[0];
  if (segments.length === 1) {
    return { kind: 'github_user', owner, repo: null, host };
  }
  const repo = segments[1].replace(/\.git$/i, '');
  return { kind: 'github_repo', owner, repo, host };
}

module.exports = {
  sha256Hex,
  contentHash,
  canonicalDomain,
  normalizeName,
  parseArtifactUrl,
  // Exported for tests and for lib/f02/identity.js's independent duplicate
  // (see that file's header for why it cannot require() this one) to stay
  // checkable against.
  reduceToRootDomain,
  hostIsGenericOrSubdomainOfGeneric,
};
