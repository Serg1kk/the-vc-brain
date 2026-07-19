// lib/f02/pipeline.js
// SOURCE OF TRUTH: lib/f02/pipeline.js
//
// The deterministic assembler for feature 02 (Sourcing Radar), stage C's
// "deterministic half": turns one candidate's already-fetched raw data
// (HN Algolia + GitHub REST + optional Tavily) into a write-set a caller
// can apply top-down without forward references. PURE -- no I/O, no
// network, no Date.now()/Math.random() (the caller passes `now` explicitly,
// design.md §6.1's own requirement so this file stays testable). The one
// concession to purity is that it is ASYNC: lib/f02/normalize.js's
// contentHash() is itself async (Web Crypto's crypto.subtle.digest has no
// synchronous form), and this file calls it once per raw signal.
//
// Self-contained CommonJS, ZERO imports (docs/backlog/TRACKER.md hard
// convention -- n8n Code nodes cannot require() from this repo). Instead of
// require(), every helper this file needs from normalize.js/identity.js/
// claims.js/obscurity.js is DEPENDENCY-INJECTED via the `deps` argument:
//
//   deps = {
//     resolveIdentity,     // lib/f02/identity.js
//     parseArtifactUrl,    // lib/f02/normalize.js
//     canonicalDomain,     // lib/f02/normalize.js
//     normalizeName,       // lib/f02/normalize.js
//     contentHash,         // lib/f02/normalize.js (ASYNC)
//     PRODUCERS,           // lib/f02/claims.js
//     TOPIC,               // lib/f02/claims.js
//     tierForSource,       // lib/f02/claims.js
//     obscurity,           // lib/f02/obscurity.js
//   }
//
// Tests pass these straight from the real modules (require() is fine in a
// *test* file). In production the n8n generator concatenates all five
// SOURCE-OF-TRUTH files into ONE Code node body in dependency order, so by
// the time this file's own top-level code runs, every name above is simply
// in scope as a plain function -- no wiring needed there either. This is
// the same "duplicate a tiny helper per file" reasoning that produced
// lib/f02/identity.js's own canonicalDomainForBlogMatch, generalised: DI
// instead of duplication, because these dependencies are too large/many to
// duplicate sanely.
//
// docs/backlog/02-sourcing-radar/design.md §5.0 (write contract) and §6.1
// (idempotency) are the two sections every binding rule below cites.
//
// ============================================================================
// buildWriteSet(input, deps) -> Promise<WriteSet>
//
// input = {
//   hnStory,            // REQUIRED. Algolia search-hit shape: {author, title,
//                        // url, story_text?, points, num_comments, objectID,
//                        // created_at, created_at_i, story_id}
//   hnThread,            // optional. /items/{objectID} shape: a tree,
//                        // {author, type:'story', text, children:[...]},
//                        // each child {author, type:'comment', text,
//                        // created_at, children:[...]}
//   hnUser,              // optional. {about, karma, username}
//   ghUser,               // optional. GitHub REST /users/{login} raw response
//   ghRepo,               // optional. GitHub REST /repos/{o}/{r} raw response
//                        // (the FLAGSHIP repo the artifact URL points at)
//   ghRepos,              // optional. array, GitHub REST /users/{login}/repos
//   ghContributors,        // optional. array, GitHub REST
//                        // /repos/{o}/{r}/contributors (design §4.1 tier 3)
//   ghSearchPrs,          // optional. GitHub Search API raw response,
//                        // `/search/issues?q=author:{login}+type:pr+
//                        // is:merged` (design §5.4, E1). Feeds a claim
//                        // ONLY when `personLinked` (see below) -- see
//                        // that variable's own comment for why presence
//                        // alone is not enough.
//   ghEvents,             // optional. array, GitHub REST
//                        // `/users/{login}/events` raw response (design
//                        // §5.4, E3). Same `personLinked` gate as above.
//   siteMap,              // optional. Tavily /map result for the derived
//                        // site-crawl seed (see deriveSiteCrawlSeed below)
//   siteExtract,          // optional. Tavily /extract result for that seed
//   livenessStatus,        // optional. pre-classified 'live'|'soft_404'|
//                        // 'placeholder'|'could_not_verify', when a caller
//                        // already ran the HTTP liveness probe itself
//   capabilities: { github: bool, tavily: bool },  // authoritative gates --
//                        // see the capability-gating note below
//   siteBacklinkHnUser,     // optional extension point, design §4.1 tier-1
//                        // case 2 -- not derivable from any of these
//                        // fixtures (needs a real site crawl checking for a
//                        // backlink to the HN profile), so a caller
//                        // supplies it directly when it has one
//   now,                  // optional ISO timestamp. Defaults to
//                        // new Date().toISOString() when omitted, but a
//                        // caller SHOULD always pass it (design §6.1: pass
//                        // `now` in via input so this function stays pure)
// }
//
// Capability gating (design §5.0 rule 2.3, read literally): `capabilities`
// is the SINGLE source of truth for "was an attempt made at all". If
// capabilities.github is false, every gh* field is treated as absent for
// EVERY purpose in this file -- identity resolution AND claim-building --
// even if a caller (a stale re-run, a hand-built test) left real GitHub
// data sitting on the input object. This is what makes "capabilities.github
// = false -> GitHub claims absent, never `missing`" a structural guarantee
// rather than a per-producer habit: the *fact* objects those producers see
// simply never carry `attempted: true` for a gh*-sourced signal when the
// capability is off, so rule 2.3's "no attempt -> null, no claim" fires
// through claims.js unchanged. Same treatment for capabilities.tavily.
//
// Site-crawl seed (added after a live field probe against the ayuhito
// fixture, recorded design.md §7.1): the GitHub `blog` field carries NO
// SCHEME ("ayuhito.com", not "https://ayuhito.com") -- prepend https://
// before treating it as a URL, then still run it through canonicalDomain()
// for the ordinary generic-host guard (a *.github.io/*.vercel.app blog
// value must not become a "personal site"). `repo.homepage` is a LIVENESS
// TARGET (E4), never a site-crawl seed -- the field probe found it pointing
// at pkg.go.dev, a package registry, not the founder's own site; using it
// here would misattribute someone else's page content. Precedence:
// normalised github.blog -> else the Show HN artifact_url when it is NOT a
// github.com URL -> else nothing (no attempt, per rule 2.3, not `missing`).
// deriveSiteCrawlSeed() is exported standalone so a caller (run.js --live,
// or a future n8n node) can compute WHAT to fetch before this function ever
// runs; buildWriteSet() itself only consumes whatever siteExtract the
// caller already fetched -- it never issues a Tavily call itself.
//
// Return shape -- one `WriteSet`, ordered so a writer can apply it top-down:
//
//   {
//     founder:    { ref, full_name },
//     identities: [ { ref, founderRef, kind:'hn'|'github', value } ],
//     company:    { ref, name, domain, stage:'pre_seed' },
//     application:{ ref, founderRef, companyRef, kind:'radar_activated',
//                   status:'sourced', artifact_links: {...design §5.5(b)} },
//     card:       { ref, founderRef, companyRef, applicationRef,
//                   card_type:'founder', status:'prefilled' },
//     rawSignals: [ { ref, founderRef, companyRef, source, source_url,
//                     source_id, observed_at, content_hash, payload,
//                     tierHint } ],
//     claims:     [ { claim: {ref, cardRef, topic, text_verbatim, value,
//                              source_kind, base_confidence},
//                     evidence: {tier, relation, quote_verbatim, source_url,
//                                raw_signal_ref, claimRef} } ],
//     metrics:    [ { ref, founderRef, companyRef, metric, value,
//                     observed_at } ],
//     counters:   { rawSignalsWritten, claimsWritten, missingClaimsWritten,
//                   metricsWritten, claimsBySlug },
//     decisions:  { identityTier, identityConfidence, discoveredVia,
//                   crossPlatformLinked, orgIsCompany, needsReview,
//                   obscurity, siteCrawlSeed },
//   }
//
// Every "…Ref" field is a LOCAL string key (e.g. 'founder', 'rs-gh-repo',
// 'claim:founder.execution.merged_pr_foreign'), NOT a real database id --
// this function never touches a database. lib/f02/write.js resolves these
// to real UUIDs as it inserts in FK order and substitutes them into
// dependent rows (content_hash for claims/evidence, which the design §6.1
// recipe keys on the REAL card_id/claim_id, is therefore computed by
// write.js at insert time, not here -- this file cannot know a real id in
// advance without contradicting its own purity).
// ============================================================================

'use strict';

// ----------------------------------------------------------------------------
// Small pure helpers
// ----------------------------------------------------------------------------

function hourTrunc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// HN item text arrives as HTML (design's own recorded fixtures: `<p>`
// paragraph breaks, `<a href=...>` links, `&#x27;`/`&quot;`/`&#x2F;`
// entities). Un-mangling this encoding is NOT paraphrase (design §3's
// verbatim rule is about not having an LLM re-word the CONTENT) -- it is
// recovering what the person actually typed before HN's renderer escaped
// it. Anchor tags keep their visible text and drop the URL (the URL is
// redundant with `artifact_url`, already stored structurally elsewhere).
const HTML_ENTITIES = Object.freeze({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#x27;': "'", '&#39;': "'", '&#x2F;': '/', '&nbsp;': ' ',
});

function decodeHnHtml(text) {
  if (typeof text !== 'string') return text;
  let out = text
    .replace(/<p>/gi, '\n\n')
    .replace(/<a\s[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '');
  out = out.replace(/&#x27;|&#39;|&amp;|&lt;|&gt;|&quot;|&#x2F;|&nbsp;/g, (m) => HTML_ENTITIES[m] || m);
  return out.trim();
}

// Recursive walk over the /items/{id} comment TREE (children is an array of
// nested node objects, not an array of ids -- confirmed against the
// recorded threaded-artifact fixture). Visits the root too; callers filter
// on type==='comment' to exclude it.
function walkThreadNodes(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) walkThreadNodes(child, visit);
}

// collectAuthorReplies -- design §3/§5.1's "author's own replies in their
// own thread", the coachability proxy. Returns raw (still HTML-encoded)
// text, in thread order; caller decodes.
function collectAuthorReplies(hnThread, hnAuthor) {
  const replies = [];
  if (!hnThread || !hnAuthor) return replies;
  walkThreadNodes(hnThread, (node) => {
    if (
      node.type === 'comment' &&
      typeof node.author === 'string' &&
      node.author === hnAuthor &&
      typeof node.text === 'string' &&
      node.text.trim()
    ) {
      replies.push(node.text.trim());
    }
  });
  return replies;
}

// deriveCompanyTitleSegment -- design §5.5(a): "companies.name = Show HN
// title, normalised". The RAW title ("Show HN: Safehttp – an SSRF-resistant
// HTTP client for Go") is a POST title, not a company name -- design does
// not spell out a segmentation step, so this is this file's own documented
// judgment call: strip a leading "Show HN:" moderation prefix (present on
// every Show HN post by construction) and take the segment before the
// first " – "/" — "/" - " or ":" separator, which is where Show HN titles
// conventionally put the product name. Titles with neither separator
// (a narrative sentence, e.g. "Getting GLM 5.2 running on my slow
// computer") fall through unsegmented -- an honest limitation, not a bug:
// there is no clean name to extract, so the caller still gets SOMETHING
// (normalizeName() applied to the whole remaining string) rather than a
// throw.
function deriveCompanyTitleSegment(title) {
  if (!title) return '';
  let s = String(title).trim();
  s = s.replace(/^show\s+hn\s*[:\-–—]\s*/i, '');
  const dashMatch = s.match(/^(.*?)\s+[\-–—]\s+/);
  if (dashMatch && dashMatch[1]) return dashMatch[1].trim();
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0) return s.slice(0, colonIdx).trim();
  return s;
}

// deriveSiteCrawlSeed -- see the file-header note above (design §7.1 field
// findings, 2026-07-19). `ghUser` here is expected to ALREADY be
// capability-gated by the caller (buildWriteSet passes its own `effGhUser`,
// never the raw one) -- this function itself has no opinion on
// capabilities, only on which field wins when both are present.
function deriveSiteCrawlSeed(ghUser, artifact, deps) {
  if (ghUser && typeof ghUser.blog === 'string') {
    const raw = ghUser.blog.trim();
    if (raw) {
      const withScheme = raw.includes('://') ? raw : `https://${raw}`;
      const domain = deps.canonicalDomain(withScheme);
      if (domain) return withScheme; // generic-host guard passed -- a real personal domain
    }
  }
  if (artifact && artifact.url && artifact.host && artifact.host !== 'github.com') {
    return artifact.url;
  }
  return null;
}

// normalizeSiteExtract -- the `results`/`failed_results` batch envelope is
// now CONFIRMED live (db/fixtures/recorded/{user-artifact,product-url}/
// tavily_site.json's `.extract` field, added 2026-07-19) -- this function
// still also accepts a single bare {url, raw_content} object defensively,
// for a caller that hands this file one already-unwrapped result rather
// than the full envelope (e.g. a hand-built test fixture). `attempted` is
// true whenever there is EITHER a successful result OR a recorded failure
// -- both mean the call was actually issued (rule 2.3's bar), as distinct
// from siteExtract being
// entirely absent (capability off, or the call was never made).
function normalizeSiteExtract(siteExtract) {
  if (!siteExtract) return { attempted: false, succeeded: false, url: null, quote: null };

  const results = Array.isArray(siteExtract.results)
    ? siteExtract.results
    : (siteExtract.url || siteExtract.raw_content ? [siteExtract] : []);
  const failed = Array.isArray(siteExtract.failed_results) ? siteExtract.failed_results : [];

  const attempted = results.length > 0 || failed.length > 0;
  if (!attempted) return { attempted: false, succeeded: false, url: null, quote: null };

  const hit = results.find((r) => r && typeof r.raw_content === 'string' && r.raw_content.trim().length > 0);
  if (!hit) {
    // §7.1: a failed fetch is "could not verify", never "project is dead".
    return { attempted: true, succeeded: false, url: (failed[0] && failed[0].url) || null, quote: null };
  }

  const decoded = hit.raw_content.trim().replace(/\s+/g, ' ');
  const quote = decoded.length > 600 ? `${decoded.slice(0, 600)}…` : decoded;
  return { attempted: true, succeeded: true, url: hit.url || null, quote };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ----------------------------------------------------------------------------
// E1/E3 REST computation helpers (design §5.4's REST-only path, wired
// 2026-07-19 -- both signals were the last two of the nine slugs left
// permanently un-attemptable; wiring them is what took a real founder
// (ayuhito, verified against 03) from `insufficient_evidence` to a scored
// result). Pure -- no I/O; the actual HTTP calls happen in lib/f02/run.js
// (--live) or are replayed from a recorded fixture (--recorded).
// ----------------------------------------------------------------------------

function ownerFromRepositoryUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/repos\/([^/]+)\//);
  return m ? m[1] : null;
}

// computeMergedForeignPrs -- E1, design §5.4: GitHub Search API
// `/search/issues?q=author:{login}+type:pr+is:merged`. This project fetches
// ONE page (`per_page=100`, `sort=created&order=desc` -- the endpoint's
// default sort is best-match relevance, a poor fit for a "last 12 months"
// filter over a capped page) and does NOT paginate through `total_count`
// (the Search API's own ~10 req/min unauthenticated ceiling, design §5.4,
// makes deep paging expensive at scan scale). Keeps items whose repo OWNER
// != login (a merge into the account's OWN repo is not this signal) AND
// whose merge/close date falls within the 12 months ending at `now`.
//
// `truncated` = the API reports more total matches than fit on this page --
// found LIVE against a genuinely prolific account: ayuhito's `total_count`
// was 945, and the 100 returned items span only ~126 of the needed 365
// days. This can only ever UNDERCOUNT (a PR outside the fetched page is
// simply invisible, never double-counted), so the qualitative claim ("this
// person merges PRs into others' repos") is not weakened by it -- only the
// exact number is a lower bound, phrased as "at least N" by claims.js.
function computeMergedForeignPrs(ghSearchPrs, { login, now }) {
  const items = Array.isArray(ghSearchPrs && ghSearchPrs.items) ? ghSearchPrs.items : [];
  if (items.length === 0) return null;

  const nowDate = new Date(now);
  const cutoff = new Date(nowDate);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);

  const foreign = [];
  for (const item of items) {
    const owner = ownerFromRepositoryUrl(item && item.repository_url);
    if (!owner || owner.toLowerCase() === String(login || '').toLowerCase()) continue;
    const mergedAt = item.pull_request && item.pull_request.merged_at;
    const dateStr = mergedAt || item.closed_at;
    const date = dateStr ? new Date(dateStr) : null;
    if (!date || Number.isNaN(date.getTime()) || date < cutoff || date > nowDate) continue;
    foreign.push(item.html_url || null);
  }

  const totalCount = typeof (ghSearchPrs && ghSearchPrs.total_count) === 'number' ? ghSearchPrs.total_count : items.length;
  return {
    mergedForeignPrCount: foreign.length,
    truncated: totalCount > items.length,
    examples: foreign.filter(Boolean).slice(0, 5),
  };
}

// ISO 8601 week-year key ("2026-W29") -- the standard nearest-Thursday
// algorithm. Used to count DISTINCT weeks containing a PushEvent without
// depending on any particular week-start convention.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to the Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// computeCommitConsistency -- E3, design §5.4: REST `/users/{u}/events`
// substitute for the GraphQL-only contribution calendar. Counts DISTINCT
// ISO weeks containing a PushEvent within the 12-week (84-day) window
// ending at `now`. `coverageDays` is the ACTUAL span this page covers
// (newest minus oldest event timestamp) -- found LIVE to be far short of
// the "~90-day" figure design §5.4 quotes, for two genuinely high-activity
// accounts: ayuhito's 100 most recent events span ~21 HOURS, JustVugg's
// span ~37 hours. The 100-event page this project fetches (not GitHub's
// full up-to-300-event allowance) exhausts almost immediately for a very
// active account -- a REAL outcome, not a defect, represented honestly via
// `coverageDays`/`partial` (claims.js scales `base_confidence` down toward
// the true visibility rather than a flat "partial" value) instead of
// silently assuming the typical case held.
function computeCommitConsistency(ghEvents, { now }) {
  const events = Array.isArray(ghEvents) ? ghEvents : [];
  if (events.length === 0) return null; // fetched, genuinely empty -- a real outcome for a low-activity/dormant account

  const timestamps = events
    .map((e) => (e && e.created_at ? new Date(e.created_at) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));
  if (timestamps.length === 0) return null;

  const newestMs = Math.max(...timestamps.map((d) => d.getTime()));
  const oldestMs = Math.min(...timestamps.map((d) => d.getTime()));
  const coverageDays = Math.round(((newestMs - oldestMs) / 86400000) * 10) / 10;

  const nowDate = new Date(now);
  const windowStart = new Date(nowDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - 84);

  const weeksWithPush = new Set();
  for (const e of events) {
    if (!e || e.type !== 'PushEvent' || !e.created_at) continue;
    const d = new Date(e.created_at);
    if (Number.isNaN(d.getTime()) || d < windowStart || d > nowDate) continue;
    weeksWithPush.add(isoWeekKey(d));
  }

  return {
    weeksWithCommitCount: weeksWithPush.size,
    weeksObserved: 12,
    partial: coverageDays < 84,
    coverageDays,
  };
}

// ----------------------------------------------------------------------------
// buildWriteSet
// ----------------------------------------------------------------------------

async function buildWriteSet(input, deps) {
  if (!input || !input.hnStory || !input.hnStory.author) {
    throw new Error('buildWriteSet: input.hnStory.author is required (every branch is optional except hnStory)');
  }

  const hnStory = input.hnStory;
  const hnThread = input.hnThread || null;
  const hnUser = input.hnUser || null;
  const capabilities = input.capabilities || {};

  const now = typeof input.now === 'string' && input.now ? input.now : new Date().toISOString();
  const observedAtSnapshot = hourTrunc(now);

  const githubEnabled = capabilities.github === true;
  const tavilyEnabled = capabilities.tavily === true;

  // design §5.0 rule 2.3, read literally: capabilities is authoritative
  // over mere field presence (see file-header note).
  const effGhUser = githubEnabled ? input.ghUser || null : null;
  const effGhRepo = githubEnabled ? input.ghRepo || null : null;
  const effGhRepos = githubEnabled && Array.isArray(input.ghRepos) && input.ghRepos.length > 0 ? input.ghRepos : null;
  const effGhContributors =
    githubEnabled && Array.isArray(input.ghContributors) && input.ghContributors.length > 0 ? input.ghContributors : null;
  // ghSearchPrs (GitHub Search API, E1) / ghEvents (REST /events, E3) --
  // design §5.4's REST-only path for both signals. Presence alone does NOT
  // license attributing them to the founder -- see `personLinked` below,
  // computed once `identity` is known.
  const effGhSearchPrs = githubEnabled ? input.ghSearchPrs || null : null;
  const effGhEvents = githubEnabled && Array.isArray(input.ghEvents) ? input.ghEvents : null;
  const effSiteMap = tavilyEnabled ? input.siteMap || null : null;
  const effSiteExtract = tavilyEnabled ? input.siteExtract || null : null;
  const effLivenessStatus = tavilyEnabled ? input.livenessStatus || null : null;

  const hnAuthor = hnStory.author;
  const artifactUrl = hnStory.url || null;
  const artifact = deps.parseArtifactUrl(artifactUrl);
  artifact.url = artifactUrl; // identity.js tier-1 case 3 needs the ORIGINAL url, not just {kind,owner,repo,host}

  const ghOwnerType = effGhUser && effGhUser.type ? effGhUser.type : undefined;
  const ghBlogDomain = effGhUser && effGhUser.blog ? deps.canonicalDomain(effGhUser.blog) : null; // canonicalDomain() itself already tolerates a scheme-less host (normalize.js prepends http://), so no extra normalisation is needed for THIS particular call -- deriveSiteCrawlSeed below needs the scheme for a different reason (it returns a fetchable URL, not just a domain for comparison).
  const siteBacklinkHnUser = input.siteBacklinkHnUser || null;

  const identity = deps.resolveIdentity({
    hnAuthor,
    artifact,
    ghOwnerType,
    siteBacklinkHnUser,
    ghBlogDomain,
  });

  // personLinked -- E1/E3 are PERSON-scoped GitHub activity signals (a
  // specific login's OWN merged PRs / push events), unlike E5/E7, which
  // describe the ARTIFACT (fork count, repo creation date) and are safe to
  // attribute regardless of identity confirmation -- a repo's fork count
  // is a fact about the thing shown, not an assertion about a specific
  // person's activity. Attaching E1/E3 to the founder's card therefore
  // requires a CONFIRMED person-level GitHub identity: crossPlatformLinked
  // AND the linked account is a real User, never an Organization -- design
  // §4.1 tier 3's "No entity merge" ruling extended to this pair of
  // signals specifically. org-artifact is the concrete case this guards:
  // puffinsoft (the repo's ORG owner) has its own real, fetchable GitHub
  // PR/events data (recorded in its fixture for replay completeness, same
  // as gh_contributors already was), but crossPlatformLinked is false for
  // that candidate (design §4.1 tier 3) -- attributing an ORGANIZATION's
  // personal-identity-scoped activity to G3819 (an unconfirmed HN poster)
  // would be exactly the entity merge design forbids. E1/E3 therefore
  // correctly produce NO ATTEMPT for that candidate, structurally
  // identical to product-url's total absence of GitHub data, for a
  // different but equally principled reason -- see the dedicated test.
  const personLinked = identity.crossPlatformLinked === true && effGhUser && effGhUser.type === 'User';

  // ---- founder + identities (design §5.0 rule 0(b) -- ALWAYS) ----------
  const founder = { ref: 'founder', full_name: hnAuthor };
  const identities = [{ ref: 'identity:hn', founderRef: 'founder', kind: 'hn', value: hnAuthor }];
  if (identity.crossPlatformLinked && effGhUser && effGhUser.login) {
    identities.push({ ref: 'identity:github', founderRef: 'founder', kind: 'github', value: effGhUser.login });
  }

  // ---- company (design §5.5(a) -- ALWAYS, before any gate/raw write) ----
  //
  // Name precedence, REVISED 2026-07-19 (coordinator finding, live):
  // threaded-artifact was yielding "getting glm 5.2 running on my slow
  // computer" -- the Show HN HEADLINE, not the project ("colibri"). The
  // title-segment heuristic (deriveCompanyTitleSegment) is a reasonable
  // reading of "Show HN title, normalised" but fails whenever the title
  // describes what was DONE rather than naming the thing built -- which is
  // common (narrative titles have no clean "Name – tagline"/"Name:
  // description" split for the segmenter to find, so it falls through
  // unsegmented, verbatim). A name the founder or the repo already carries
  // is more reliable than parsing prose:
  //   1. Organization-owned artifact -> the org's own login (unchanged --
  //      design §4.1 tier 3's explicit ruling, not affected by this fix).
  //   2. A GitHub repo artifact -> the repo's OWN name (colibri, safehttp,
  //      peek-cli) -- what the founder actually called the thing.
  //   3. A real (non-generic-host) product domain -> its registrable
  //      label (rewindcup.com -> "rewindcup").
  //   4. Otherwise -> the title-segment heuristic, unchanged, as the last
  //      resort for a text-only or unresolvable candidate.
  // The raw title is NEVER lost -- it still lands verbatim in
  // application.artifact_links.title regardless of which branch wins here.
  const companyDomain = deps.canonicalDomain(artifactUrl);
  let companyName;
  if (identity.orgIsCompany) {
    const orgLogin = (effGhUser && effGhUser.login) || artifact.owner || hnAuthor;
    companyName = deps.normalizeName(orgLogin) || orgLogin;
  } else if (artifact.kind === 'github_repo' && artifact.repo) {
    companyName = deps.normalizeName(artifact.repo) || artifact.repo;
  } else if (companyDomain) {
    const domainLabel = companyDomain.split('.')[0];
    companyName = deps.normalizeName(domainLabel) || domainLabel;
  } else {
    const segment = deriveCompanyTitleSegment(hnStory.title);
    companyName = deps.normalizeName(segment) || segment || hnAuthor;
  }
  const company = {
    ref: 'company',
    name: companyName,
    domain: companyDomain,
    stage: 'pre_seed',
  };

  // ---- application (design §5.5(b) exact artifact_links shape) ----------
  const application = {
    ref: 'application',
    founderRef: 'founder',
    companyRef: 'company',
    kind: 'radar_activated',
    status: 'sourced',
    artifact_links: {
      source: 'hn_showhn',
      hn_item_id: String(hnStory.objectID),
      hn_url: `https://news.ycombinator.com/item?id=${hnStory.objectID}`,
      title: hnStory.title || null,
      story_text: hnStory.story_text ?? (hnThread && hnThread.text) ?? null,
      artifact_url: artifactUrl,
      artifact_kind: artifact.kind,
      repo: artifact.kind === 'github_repo' ? { owner: artifact.owner, name: artifact.repo } : null,
      homepage: (effGhRepo && effGhRepo.homepage) || null,
    },
  };

  // ---- card (design §5.0 rule 1) ----------------------------------------
  const card = {
    ref: 'card',
    founderRef: 'founder',
    companyRef: 'company',
    applicationRef: 'application',
    card_type: 'founder',
    status: 'prefilled',
  };

  // ---- site-crawl seed (design §7.1 field findings) ----------------------
  const siteSeed = deriveSiteCrawlSeed(effGhUser, artifact, deps);
  const extractInfo = normalizeSiteExtract(effSiteExtract);

  // ---- raw signals (design §6.1 idempotency; §2 rationale 2: "raw payload
  // is persisted before processing" -- every descriptor below carries the
  // ACTUAL fetched object as `payload`, not just its derived identity,
  // so a downstream failure (an LLM node, a Tavily retry) can replay from
  // Memory without re-hitting the source API) -----------------------------
  const rawDescriptors = [
    { ref: 'rs-hn-story', source: 'hn_algolia', sourceId: String(hnStory.objectID), observedAt: hnStory.created_at, sourceUrl: `https://news.ycombinator.com/item?id=${hnStory.objectID}`, payload: hnStory },
  ];
  if (hnThread) {
    rawDescriptors.push({
      ref: 'rs-hn-thread', source: 'hn_algolia', sourceId: `${hnStory.objectID}#thread`, observedAt: hnStory.created_at,
      sourceUrl: `https://news.ycombinator.com/item?id=${hnStory.objectID}`, payload: hnThread,
    });
  }
  if (hnUser) {
    rawDescriptors.push({
      ref: 'rs-hn-user', source: 'hn_algolia', sourceId: `user:${hnUser.username || hnAuthor}`, observedAt: observedAtSnapshot,
      sourceUrl: `https://news.ycombinator.com/user?id=${hnUser.username || hnAuthor}`, payload: hnUser,
    });
  }
  if (effGhUser) {
    rawDescriptors.push({
      ref: 'rs-gh-user', source: 'github_api', sourceId: `user:${effGhUser.login}`, observedAt: observedAtSnapshot,
      sourceUrl: effGhUser.html_url || null, payload: effGhUser,
    });
  }
  if (effGhRepo && artifact.kind === 'github_repo') {
    rawDescriptors.push({
      ref: 'rs-gh-repo', source: 'github_api', sourceId: `repo:${artifact.owner}/${artifact.repo}`, observedAt: observedAtSnapshot,
      sourceUrl: effGhRepo.html_url || artifactUrl, payload: effGhRepo,
    });
  }
  if (effGhRepos) {
    rawDescriptors.push({
      ref: 'rs-gh-repos', source: 'github_api', sourceId: `repos:${artifact.owner || (effGhUser && effGhUser.login)}`, observedAt: observedAtSnapshot,
      sourceUrl: (effGhUser && effGhUser.html_url) || null, payload: effGhRepos,
    });
  }
  if (effGhContributors && artifact.kind === 'github_repo') {
    rawDescriptors.push({
      ref: 'rs-gh-contributors', source: 'github_api', sourceId: `contributors:${artifact.owner}/${artifact.repo}`, observedAt: observedAtSnapshot,
      sourceUrl: effGhRepo ? effGhRepo.html_url : artifactUrl, payload: effGhContributors,
    });
  }
  // rs-gh-search-prs / rs-gh-events -- recorded whenever the DATA was
  // fetched, regardless of `personLinked` (design §2's "raw payload is
  // persisted before processing" applies to observation, not attribution;
  // gh_contributors already sets this precedent for org-artifact). Only
  // the CLAIM below (E1/E3) is gated on personLinked.
  if (effGhSearchPrs) {
    const searchLogin = (effGhUser && effGhUser.login) || artifact.owner;
    rawDescriptors.push({
      ref: 'rs-gh-search-prs', source: 'github_api', sourceId: `search-prs:${searchLogin}`, observedAt: observedAtSnapshot,
      sourceUrl: `https://github.com/search?q=author%3A${searchLogin}+type%3Apr+is%3Amerged&type=pullrequests`,
      payload: effGhSearchPrs,
    });
  }
  if (effGhEvents) {
    const eventsLogin = (effGhUser && effGhUser.login) || artifact.owner;
    rawDescriptors.push({
      ref: 'rs-gh-events', source: 'github_api', sourceId: `events:${eventsLogin}`, observedAt: observedAtSnapshot,
      sourceUrl: `https://github.com/${eventsLogin}`, payload: effGhEvents,
    });
  }
  if (effSiteMap) {
    rawDescriptors.push({
      ref: 'rs-site-map', source: 'tavily_extract', sourceId: `map:${siteSeed || artifactUrl}`, observedAt: observedAtSnapshot,
      sourceUrl: siteSeed || artifactUrl, payload: effSiteMap,
    });
  }
  if (extractInfo.attempted) {
    rawDescriptors.push({
      ref: 'rs-site-extract',
      source: 'tavily_extract',
      sourceId: `extract:${extractInfo.url || siteSeed || artifactUrl}`,
      observedAt: observedAtSnapshot,
      sourceUrl: extractInfo.url || siteSeed || artifactUrl,
      payload: effSiteExtract,
    });
  }
  if (effLivenessStatus) {
    rawDescriptors.push({
      ref: 'rs-liveness', source: 'tavily_extract', sourceId: `liveness:${artifactUrl}`, observedAt: observedAtSnapshot,
      sourceUrl: artifactUrl, payload: { status: effLivenessStatus },
    });
  }

  const rawSignals = [];
  for (const d of rawDescriptors) {
    // eslint-disable-next-line no-await-in-loop -- a handful of rows per
    // candidate; sequential await keeps this file's only async dependency
    // (contentHash) simple and matches lib/f02/normalize.test.js's own
    // sequential-await style.
    const contentHash = await deps.contentHash([d.source, d.sourceId, d.observedAt]);
    rawSignals.push({
      ref: d.ref,
      founderRef: 'founder',
      companyRef: 'company',
      source: d.source,
      source_url: d.sourceUrl ?? null,
      source_id: d.sourceId,
      observed_at: d.observedAt,
      content_hash: contentHash,
      payload: d.payload ?? {},
      tierHint: deps.tierForSource(d.source, identity.confidence),
    });
  }

  // design §5.0 rule 0(a), ASSERTED here, not only tested: every raw_signals
  // row this function emits carries a resolvable founder/company reference.
  // Both are always set above (this candidate already has a founder and a
  // company by construction, per rules 0(b) and §5.5(a)) -- this loop is
  // the load-bearing guard against a future edit accidentally emitting a
  // descriptor that forgets one.
  for (const rs of rawSignals) {
    if (!rs.founderRef && !rs.companyRef) {
      throw new Error(`buildWriteSet: raw signal ${rs.ref} has neither founderRef nor companyRef (design §5.0 rule 0(a))`);
    }
  }

  const rawSignalRefs = new Set(rawSignals.map((rs) => rs.ref));
  function signalRef(ref) {
    return rawSignalRefs.has(ref) ? ref : null;
  }

  // ---- claims (design §5.1's nine slugs, via the injected PRODUCERS) ----
  const claims = [];
  function pushClaim(topic, fact) {
    const producer = deps.PRODUCERS[topic];
    if (typeof producer !== 'function') {
      throw new Error(`buildWriteSet: no producer registered for topic ${JSON.stringify(topic)}`);
    }
    const result = producer(fact, { identityConfidence: identity.confidence });
    if (!result) return; // rule 2.3 -- no attempt (or nothing found on attempt) -> nothing to write
    const { evidence, ...claimFields } = result;
    const claimRef = `claim:${topic}`;
    claims.push({
      claim: { ref: claimRef, cardRef: 'card', ...claimFields },
      evidence: { ...evidence, claimRef },
    });
  }

  const replies = collectAuthorReplies(hnThread, hnAuthor).map(decodeHnHtml);

  // E1 merged_pr_foreign -- WIRED 2026-07-19 (coordinator instruction):
  // GitHub Search API, REST-only (design §5.4 -- no token needed). Gated
  // on `personLinked`, NOT merely `effGhSearchPrs` presence -- see that
  // variable's own comment. org-artifact's puffinsoft data is recorded and
  // observed (the raw signal above) but never attributed to G3819.
  if (personLinked && effGhSearchPrs && signalRef('rs-gh-search-prs')) {
    // computeMergedForeignPrs() returns null only when the page had zero
    // items at all; claims.js's own producer already turns a zero COUNT
    // (from either "no items fetched" or "items existed but none
    // qualified") into a missing-marker, so both cases collapse into one
    // call here -- no need to special-case the null return separately.
    const merged = computeMergedForeignPrs(effGhSearchPrs, { login: effGhUser.login, now }) || { mergedForeignPrCount: 0 };
    pushClaim(deps.TOPIC.EXECUTION_MERGED_PR_FOREIGN, {
      attempted: true,
      rawSignalRef: 'rs-gh-search-prs',
      mergedForeignPrCount: merged.mergedForeignPrCount,
      truncated: merged.truncated,
      examples: merged.examples,
      sourceUrl: `https://github.com/${effGhUser.login}?tab=overview`,
    });
  } else {
    pushClaim(deps.TOPIC.EXECUTION_MERGED_PR_FOREIGN, { attempted: false });
  }

  // E3 commit_consistency -- WIRED 2026-07-19 (coordinator instruction):
  // REST /users/{u}/events, same personLinked gate and the same reasoning.
  if (personLinked && effGhEvents && signalRef('rs-gh-events')) {
    // computeCommitConsistency() returns null when the feed is fetched but
    // genuinely empty (a real outcome for a low-activity/dormant account,
    // per the coordinator's explicit instruction not to dress this up as
    // coverage we do not have) -- claims.js's producer already turns an
    // absent weeksWithCommitCount into a missing-marker, so that case needs
    // no special handling here either.
    const consistency = computeCommitConsistency(effGhEvents, { now }) || {};
    pushClaim(deps.TOPIC.EXECUTION_COMMIT_CONSISTENCY, {
      attempted: true,
      rawSignalRef: 'rs-gh-events',
      weeksWithCommitCount: consistency.weeksWithCommitCount,
      weeksObserved: consistency.weeksObserved,
      partial: consistency.partial,
      coverageDays: consistency.coverageDays,
      sourceUrl: `https://github.com/${effGhUser.login}`,
    });
  } else {
    pushClaim(deps.TOPIC.EXECUTION_COMMIT_CONSISTENCY, { attempted: false });
  }

  // E4 live_product -- design §5.1's own ruling: ALWAYS source
  // tavily_extract, never github_api (the probe IS the Tavily fetch;
  // repo.homepage is only ever an input URL to probe, never itself
  // evidence -- see the file-header note on why it is excluded from the
  // site-crawl seed too).
  const e4Ref = signalRef('rs-liveness') || signalRef('rs-site-extract');
  if (e4Ref) {
    const status = effLivenessStatus || (extractInfo.succeeded ? 'live' : 'could_not_verify');
    pushClaim(deps.TOPIC.EXECUTION_LIVE_PRODUCT, {
      attempted: true,
      rawSignalRef: e4Ref,
      status,
      source: 'tavily_extract',
      sourceUrl: extractInfo.url || siteSeed || artifactUrl,
    });
  } else {
    pushClaim(deps.TOPIC.EXECUTION_LIVE_PRODUCT, { attempted: false });
  }

  // E5 external_usage -- forks only, from a repo we actually fetched. Never
  // stars (SIG-014, enforced in claims.js itself -- this file does not even
  // read stargazers_count).
  if (effGhRepo && signalRef('rs-gh-repo')) {
    pushClaim(deps.TOPIC.EXECUTION_EXTERNAL_USAGE, {
      attempted: true,
      rawSignalRef: 'rs-gh-repo',
      forkCount: numOrNull(effGhRepo.forks_count),
      sourceUrl: effGhRepo.html_url || artifactUrl,
    });
  } else {
    pushClaim(deps.TOPIC.EXECUTION_EXTERNAL_USAGE, { attempted: false });
  }

  // E7 provenance -- design §5.3's triple. `firstCommitAt` is deliberately
  // never populated from this input shape (the second, narrow query design
  // §5.3 calls for is not part of {ghUser, ghRepo, ghRepos,
  // ghContributors}) -- claims.js's own producer correctly turns "attempted
  // but incomplete" into a missing-marker rather than silence, which is the
  // right outcome here: we DID fetch real GitHub data (a real raw_signal
  // exists to cite), we just don't have the earliest-commit leg yet.
  if (effGhRepo && effGhUser && signalRef('rs-gh-repo')) {
    pushClaim(deps.TOPIC.EXECUTION_PROVENANCE, {
      attempted: true,
      rawSignalRef: 'rs-gh-repo',
      repoCreatedAt: effGhRepo.created_at || null,
      accountCreatedAt: effGhUser.created_at || null,
      firstCommitAt: null,
      sourceUrl: effGhRepo.html_url || artifactUrl,
    });
  } else {
    pushClaim(deps.TOPIC.EXECUTION_PROVENANCE, { attempted: false });
  }

  // X1 vertical_tenure -- personal-site quote only; never derived from the
  // GitHub bio (design §5.1 names tavily_extract as the sole source).
  if (extractInfo.attempted && signalRef('rs-site-extract')) {
    pushClaim(deps.TOPIC.EXPERTISE_VERTICAL_TENURE, {
      attempted: true,
      rawSignalRef: 'rs-site-extract',
      quoteVerbatim: extractInfo.quote,
      sourceUrl: extractInfo.url || siteSeed,
    });
  } else {
    pushClaim(deps.TOPIC.EXPERTISE_VERTICAL_TENURE, { attempted: false });
  }

  // X2 insight_specificity -- REVISED 2026-07-19 (coordinator instruction):
  // now wired to the site extract, sharing the SAME quote X1 reads --
  // design §5.1 lists X2's source as tavily_extract | hn_algolia, and one
  // extracted page can legitimately back both "stated tenure" (X1) and
  // "domain-focus insight" (X2) as two independently-assessed claims on two
  // different criteria; that is not double-counting, it is two different
  // sub-scorers reading the same evidence for two different questions. The
  // multi-year HN comment-corpus search (`search_by_date?tags=comment,
  // author_{u}`, design §3) is STILL not part of this input shape and
  // remains unwired -- a single in-thread reply (used for L5 below) stays
  // deliberately excluded from X2 for the same reason as before: one reply
  // is too thin a basis for "sustained expertise across years".
  if (extractInfo.attempted && extractInfo.quote && signalRef('rs-site-extract')) {
    pushClaim(deps.TOPIC.EXPERTISE_INSIGHT_SPECIFICITY, {
      attempted: true,
      rawSignalRef: 'rs-site-extract',
      quoteVerbatim: extractInfo.quote,
      source: 'tavily_extract',
      sourceUrl: extractInfo.url || siteSeed,
    });
  } else {
    pushClaim(deps.TOPIC.EXPERTISE_INSIGHT_SPECIFICITY, { attempted: false });
  }

  // X6 unasked_work -- precedence REVISED 2026-07-19: the repo's own
  // creation date (a real, attempted, github_api fact -- "earliest known
  // public artifact") now wins WHEN AVAILABLE, with the site quote only as
  // a last resort when no GitHub repo exists at all (the product-url
  // path). Reversed from this file's first draft after seeing what the
  // actually-recorded site content looks like: both real fixtures'
  // extracted pages are "About me" bios (the only page found -- both
  // /map calls returned 0 URLs, so the crawl never reached a real
  // changelog), not the "site changelog" design §5.1 names as X6's
  // tavily_extract source. A bio quote is a defensible X1/X2 signal but is
  // NOT evidence of "substantial work predating any funding event" --
  // using it for X6 would be a topic mismatch this file can avoid simply
  // by preferring the structural fact when one exists. (Neither branch
  // itself verifies "predates any funding event" -- no funding-event data
  // exists anywhere in this pipeline for a cold-start candidate --
  // documented simplification, not a design requirement, unchanged from
  // the first draft.)
  if (effGhRepo && signalRef('rs-gh-repo')) {
    pushClaim(deps.TOPIC.EXPERTISE_UNASKED_WORK, {
      attempted: true,
      rawSignalRef: 'rs-gh-repo',
      earliestArtifactDate: effGhRepo.created_at || null,
      source: 'github_api',
      sourceUrl: effGhRepo.html_url || artifactUrl,
    });
  } else if (extractInfo.attempted && extractInfo.quote && signalRef('rs-site-extract')) {
    pushClaim(deps.TOPIC.EXPERTISE_UNASKED_WORK, {
      attempted: true,
      rawSignalRef: 'rs-site-extract',
      quoteVerbatim: extractInfo.quote,
      source: 'tavily_extract',
      sourceUrl: extractInfo.url || siteSeed,
    });
  } else {
    pushClaim(deps.TOPIC.EXPERTISE_UNASKED_WORK, { attempted: false });
  }

  // L5 written_communication -- ALWAYS attempted: hnStory is mandatory, so
  // there is always at least a title to cite verbatim. Preference order:
  // (1) the founder's own reply inside their own thread -- design's
  //     explicit coachability proxy, the strongest of the three -- (2) the
  //     Show HN post body, (3) the title as the final, always-present
  //     fallback.
  {
    let quote;
    let ref;
    if (replies.length > 0 && signalRef('rs-hn-thread')) {
      quote = replies[0];
      ref = 'rs-hn-thread';
    } else {
      const body = hnStory.story_text || (hnThread && hnThread.text) || null;
      quote = decodeHnHtml(body || hnStory.title || '');
      ref = 'rs-hn-story';
    }
    pushClaim(deps.TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION, {
      attempted: true,
      rawSignalRef: ref,
      quoteVerbatim: quote,
      source: 'hn_algolia',
      sourceUrl: `https://news.ycombinator.com/item?id=${hnStory.objectID}`,
    });
  }

  // design §5.0 rule 2, ASSERTED here, not only tested: every claim this
  // function emits must cite a raw_signal_ref that resolves to a row this
  // SAME call also emitted. This is the one invariant the coordinator
  // flagged as load-bearing for feature 03 -- if it breaks silently, a
  // claim ships with an unresolvable evidence pointer and inverts REQ-003
  // downstream.
  for (const { claim, evidence } of claims) {
    if (!rawSignalRefs.has(evidence.raw_signal_ref)) {
      throw new Error(
        `buildWriteSet: claim ${claim.topic} cites raw_signal_ref ${JSON.stringify(evidence.raw_signal_ref)}, ` +
          'which was never emitted as a raw signal in this same write-set (design §5.0 rule 2)'
      );
    }
  }

  // ---- metrics (design §6.4 registry -- never emit what was not observed) ----
  //
  // founder-scoped ONLY -- companyRef is deliberately NOT set here (found
  // live, 2026-07-19, running lib/f02/write.js against the real DB): all
  // five registered metrics (gh_followers, gh_forks, hn_karma, hn_comments,
  // hn_author_replies) are genuinely observations OF THE FOUNDER, not of
  // the company as an entity. Attaching companyRef would also have been
  // actively HARMFUL to idempotency, independent of that semantic point --
  // `metric_observations`' own UNIQUE constraint is
  // `NULLS NOT DISTINCT (metric, founder_id, company_id, observed_at)`.
  // `companies` has no natural key when `domain` is null (design §5.5(a)'s
  // partial-unique-index gap, warned about at write.js's company-insert
  // call site), so a domain-less candidate mints a NEW company_id on every
  // re-run -- and since that churning id was part of the natural key,
  // EVERY metric_observations row silently duplicated on every retry
  // (confirmed live: a second `--write` of the SAME fixture reported
  // `created.metrics: 5`, not 0). Leaving company_id NULL sidesteps the
  // churn entirely and lets NULLS NOT DISTINCT do its job: founder_id alone
  // (stable, correctly deduped via founder_identities) is enough of a
  // natural key for a founder-scoped metric.
  const metrics = [];
  function pushMetric(metric, value) {
    if (value === null || value === undefined) return;
    metrics.push({ ref: `metric:${metric}`, founderRef: 'founder', metric, value, observed_at: observedAtSnapshot });
  }
  pushMetric('gh_followers', effGhUser ? numOrNull(effGhUser.followers) : null);
  pushMetric('gh_forks', effGhRepo ? numOrNull(effGhRepo.forks_count) : null);
  pushMetric('hn_karma', hnUser ? numOrNull(hnUser.karma) : null);
  pushMetric('hn_comments', numOrNull(hnStory.num_comments));
  pushMetric('hn_author_replies', hnThread ? replies.length : null);

  // ---- decisions (identity cascade result + the obscurity diagnostic) ----
  // Obscurity is NOT written to `scores` (design §6.4: "02 computes no
  // scores at all") and production's source of truth is the
  // `radar_candidates` SQL VIEW computed from metric_observations, not this
  // field -- this is a pure-function ECHO of the exact same two inputs
  // (useful for run.js's CLI summary and for tests), computed from the
  // SAME values just pushed to `metrics` above so the two can never drift.
  const ghFollowersForObscurity = effGhUser ? numOrNull(effGhUser.followers) : null;
  const hnKarmaForObscurity = hnUser ? numOrNull(hnUser.karma) : null;

  const decisions = {
    identityTier: identity.tier,
    identityConfidence: identity.confidence,
    discoveredVia: identity.discoveredVia,
    crossPlatformLinked: identity.crossPlatformLinked,
    orgIsCompany: identity.orgIsCompany,
    needsReview: identity.needsReview,
    obscurity: deps.obscurity({ ghFollowers: ghFollowersForObscurity, hnKarma: hnKarmaForObscurity }),
    siteCrawlSeed: siteSeed,
  };

  // ---- counters -----------------------------------------------------------
  const claimsBySlug = {};
  let missingClaimsWritten = 0;
  for (const { claim, evidence } of claims) {
    claimsBySlug[claim.topic] = (claimsBySlug[claim.topic] || 0) + 1;
    if (evidence.tier === 'missing') missingClaimsWritten += 1;
  }
  const counters = {
    rawSignalsWritten: rawSignals.length,
    claimsWritten: claims.length,
    missingClaimsWritten,
    metricsWritten: metrics.length,
    claimsBySlug,
  };

  return { founder, identities, company, application, card, rawSignals, claims, metrics, counters, decisions };
}

module.exports = {
  buildWriteSet,
  deriveSiteCrawlSeed,
  deriveCompanyTitleSegment,
  decodeHnHtml,
  collectAuthorReplies,
  normalizeSiteExtract,
  hourTrunc,
  computeMergedForeignPrs,
  computeCommitConsistency,
  isoWeekKey,
};
