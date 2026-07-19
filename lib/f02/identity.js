// lib/f02/identity.js
// SOURCE OF TRUTH: lib/f02/identity.js
//
// Five-tier identity-resolution cascade for feature 02 (Sourcing Radar),
// design.md §4.1 ("Revised cascade") -- the section the design calls
// "the decisive correction" and REQ-004's home: NO fuzzy string matching
// anywhere. A Show HN handle differing from a GitHub login
// (misilojakub/jmisilo, kaiwuTW/kaiwutech-TW, ...) is resolved on Show HN's
// own moderation-enforced authorship guarantee (tier 2), never on string
// similarity.
//
// Self-contained CommonJS, ZERO imports (docs/backlog/TRACKER.md hard
// convention -- n8n Code nodes cannot require() from this repo, and each
// lib/f02/*.js file is pasted into its OWN separate Code node, so no file
// here may depend on another at runtime). This file therefore carries its
// own small canonicalDomain()-equivalent (canonicalDomainForBlogMatch
// below) instead of requiring ./normalize.js -- the same duplication
// pattern lib/f04/provenance.js's sha256Hex/hashFields and
// lib/f07/hashes.js's sha256Hex/hashFields already establish in this repo:
// small pure helpers are copied per file, not shared. Kept deliberately
// narrow -- ONLY what tier 1 case 3 needs (host reduction + the
// generic-host guard for github.io/vercel.app/etc, so a founder's GitHub
// `blog` field pointing at their own *.github.io page does not falsely
// "match" an artifact also hosted there) -- lib/f02/normalize.js remains
// the source of truth for the FULL canonicalDomain implementation used
// everywhere else in this feature.

'use strict';

// ----------------------------------------------------------------------------
// Minimal domain reduction, scoped to tier 1 case 3 only -- see file header.
// Kept in lockstep with lib/f02/normalize.js's GENERIC_HOSTS by hand (no
// shared import is possible under the zero-imports constraint); a test in
// identity.test.js cross-checks the two lists stay equal.
// ----------------------------------------------------------------------------

const GENERIC_HOSTS_FOR_BLOG_MATCH = new Set([
  'github.com', 'github.io', 'gitlab.com',
  'vercel.app', 'netlify.app', 'pages.dev',
  'notion.site', 'substack.com', 'medium.com',
  'linkedin.com', 'twitter.com', 'x.com',
  'producthunt.com', 'ycombinator.com',
  'chromewebstore.google.com', 'apps.apple.com', 'play.google.com',
  'huggingface.co', 'replit.app', 'streamlit.app', 'herokuapp.com',
]);

const TWO_LABEL_SUFFIX_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);

function hostIsGenericOrSubdomainOfGeneric(host) {
  for (const generic of GENERIC_HOSTS_FOR_BLOG_MATCH) {
    if (host === generic || host.endsWith('.' + generic)) return true;
  }
  return false;
}

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

function canonicalDomainForBlogMatch(urlOrHost) {
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

// ----------------------------------------------------------------------------
// resolveIdentity -- design §4.1 cascade table, checked top to bottom,
// first match wins. No step below compares two strings for SIMILARITY --
// only for EXACT equality (case-insensitively, where the design says so)
// or for structural facts (ghOwnerType, artifact.kind). That is the whole
// of REQ-004 as far as this file is concerned.
//
// design §5.0 rule 0(b) (added in spec re-review, AFTER this file's first
// draft): a candidate reaching tier 3/4/5 here still gets a `founders` row
// upstream, anchored on `founder_identities(kind='hn', value=hnAuthor)`.
// "unresolved" in this file's cascade means NO CROSS-PLATFORM LINK to a
// GitHub identity -- it never means "no person" and never blocks a
// `founders` row from being created. This function itself creates nothing
// (writes are the caller's job); the field below that encodes this is
// `crossPlatformLinked`, not `founderResolvable` -- the earlier name was
// renamed for exactly this reason, so a later reader does not mistake
// `false` here for "drop the candidate".
//
// resolveIdentity({hnAuthor, artifact, ghOwnerType, siteBacklinkHnUser,
//   ghBlogDomain}) -> {tier, confidence, discoveredVia, needsReview,
//   orgIsCompany, crossPlatformLinked}
//
//   hnAuthor           -- HN username of the Show HN submitter (string)
//   artifact           -- parseArtifactUrl()'s shape PLUS the original
//                         `url` (design §4.1's tier-1-case-3 condition is
//                         stated against `artifact.url`, not just its
//                         parsed host): {kind, owner, repo, host, url}
//   ghOwnerType        -- 'User' | 'Organization' | null -- from a live
//                         GitHub API call on `artifact.owner`, when the
//                         artifact is a github_repo/github_user
//   siteBacklinkHnUser -- the HN username found in a backlink from the
//                         artifact's own site to
//                         news.ycombinator.com/user?id={hn} (tier 1 case
//                         2), or null/undefined if no such backlink was
//                         found/checked
//   ghBlogDomain       -- canonicalDomain() of the GitHub profile's `blog`
//                         field (already computed by the caller via
//                         lib/f02/normalize.js -- this file does not read
//                         the raw blog URL, only its already-canonicalized
//                         domain, to avoid a second GENERIC_HOSTS list
//                         drifting semantically out of sync with
//                         normalize.js's -- see the cross-check test)
//
// design §4.1 note: "attaching an identity and merging two entities are
// different acts" -- resolveIdentity() only ever proposes a tier/confidence
// for ONE artifact-founder pair; it never merges or writes anything.

function eqCaseInsensitive(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function resolveIdentity({ hnAuthor, artifact, ghOwnerType, siteBacklinkHnUser, ghBlogDomain } = {}) {
  const art = artifact || {};

  // ---- tier 1 / 0.95, case 1 -- exact handle match on a User-owned artifact.
  if (ghOwnerType === 'User' && art.owner && eqCaseInsensitive(hnAuthor, art.owner)) {
    return {
      tier: 1,
      confidence: 0.95,
      discoveredVia: 'handle_match',
      needsReview: false,
      orgIsCompany: false,
      crossPlatformLinked: true,
    };
  }

  // ---- tier 1 / 0.95, case 2 -- bidirectional site backlink declaration.
  if (siteBacklinkHnUser && hnAuthor && eqCaseInsensitive(siteBacklinkHnUser, hnAuthor)) {
    return {
      tier: 1,
      confidence: 0.95,
      discoveredVia: 'site_backlink_bidirectional',
      needsReview: false,
      orgIsCompany: false,
      crossPlatformLinked: true,
    };
  }

  // ---- tier 1 / 0.90, case 3 -- GitHub profile `blog` domain matches the
  // artifact's own domain.
  if (ghBlogDomain && art.url) {
    const artifactDomain = canonicalDomainForBlogMatch(art.url);
    if (artifactDomain && artifactDomain === ghBlogDomain) {
      return {
        tier: 1,
        confidence: 0.90,
        discoveredVia: 'gh_blog_domain_match',
        needsReview: false,
        orgIsCompany: false,
        crossPlatformLinked: true,
      };
    }
  }

  // ---- tier 2 / 0.85 -- declared authorship (design §4.1's load-bearing
  // majority path). No handle comparison at all: Show HN's own guidelines
  // license this link, a mismatched handle is not evidence against it.
  if (art.kind === 'github_repo' && ghOwnerType === 'User') {
    return {
      tier: 2,
      confidence: 0.85,
      discoveredVia: 'showhn_declared_artifact',
      needsReview: false,
      orgIsCompany: false,
      crossPlatformLinked: true,
    };
  }

  // ---- tier 3 / 0.60 -- Organization-owned artifact. The ORG becomes the
  // `companies` row; the person is still created (§5.0 rule 0(b), from the
  // HN handle) but stays cross-platform-`unresolved` (design §4.1 tier 3:
  // "No entity merge").
  if (ghOwnerType === 'Organization') {
    return {
      tier: 3,
      confidence: 0.60,
      discoveredVia: 'github_org_owner',
      needsReview: true,
      orgIsCompany: true,
      crossPlatformLinked: false,
    };
  }

  // ---- tier 4 -- non-GitHub product URL. Identity path B (design §4):
  // frequently stays cross-platform-unresolved.
  if (art.kind === 'product') {
    return {
      tier: 4,
      confidence: null,
      discoveredVia: 'product_url_unresolved',
      needsReview: false,
      orgIsCompany: false,
      crossPlatformLinked: false,
    };
  }

  // ---- tier 5 -- nothing cross-platform resolvable. Per §5.0 rule 0(b)
  // the candidate STILL gets a `founders` row (from the HN handle) and
  // survives as an HN-only card (design §4.1 bias caveat: strictness
  // applies to LINKING, never to ADMISSION).
  return {
    tier: 5,
    confidence: null,
    discoveredVia: 'unresolved',
    needsReview: false,
    orgIsCompany: false,
    crossPlatformLinked: false,
  };
}

module.exports = {
  resolveIdentity,
  canonicalDomainForBlogMatch,
  GENERIC_HOSTS_FOR_BLOG_MATCH,
};
