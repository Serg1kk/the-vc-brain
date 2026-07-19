// lib/f05/dynamic.js
// SOURCE OF TRUTH: lib/f05/dynamic.js
//
// The `factual_dynamic` verification branch for feature 05 (Truth-Gap Check
// & Trust Score) -- design.md SS5.2, SS10.2. docs/backlog/05-truth-gap-trust/
// plan.md, task C3.
//
// Self-contained CommonJS. ZERO imports -- pure logic only (query building,
// temporal filtering, source classification, independence-relevant
// deduplication and verdict decision), no I/O, no `fetch`, no `Date.now()`,
// no `Math.random()`, no top-level side effects, so this file COULD be
// pasted verbatim into an n8n Code node the same way lib/f05/{router,trust,
// entity_gate,quote_guard}.js already are.
//
// The one thing this file deliberately does NOT own is the live Tavily HTTP
// call itself (team lead's own instruction: "if that is impractical for HTTP
// calls, keep the pure logic ... in a zero-import module and let run.js own
// the actual fetch"). fetch() does not exist inside n8n's Code-node sandbox
// (lib/f02/pipeline.js's own header makes the identical point about
// process.env there), so a module that both builds queries AND performs them
// could never be pasted into a Code node as-is -- keeping the fetch OUTSIDE
// this file is what keeps everything ELSE in it n8n-portable. lib/f05/run.js
// (task B3, which may require() freely) is the caller that owns
// fetch()/psql and wires this module's decisions to real network + DB calls.
//
// ============================================================================
// Why this branch is the one the design spends three paragraphs warning
// about (design.md SS5.2, restated by the team lead's own task brief):
//
//   1. TEMPORAL: without a published-after-the-claim-date filter, a deck
//      "verifies itself" through an article that merely repeats it back.
//   2. SOURCE TIER enters at VERDICT time, never at RETRIEVAL time:
//      credibility-weighted filtering has been measured degrading
//      performance by removing the counter-evidence needed to catch a lie.
//      buildSearchQuery() below therefore carries NO include_domains/
//      exclude_domains -- every result Tavily returns is kept for
//      CONSIDERATION; classifySourceKind() only affects what TIER a result
//      is written at, never whether it is searched for or fetched at all.
//      The founder's own site is a first-class citizen of that search, not
//      an excluded one (see classifySourceKind's 'company_domain' branch).
//   3. INDEPENDENCE counts SOURCES, not MENTIONS (design SS7.3): the
//      claim_trust VIEW already implements the authoritative rule
//      (`count(DISTINCT (rs.source, f05_host(e.source_url)))`), but because
//      every evidence row THIS branch writes shares one raw_signals.source
//      slug ('tavily_search'), the (source, host) tuple the view groups on
//      varies ONLY by host for this branch's own contribution -- so
//      dedupeByRegistrableHost() below, applied before any row is written,
//      is what keeps three pages from the SAME domain from masquerading as
//      three independent corroborations before the view even sees them.
//   4. A SOCIAL-MEDIA-SOURCED claim can NEVER reach `verified` (the
//      Builder.ai lesson: the viral, checkable-sounding "700 engineers faked
//      the AI" claim was ITSELF false, traced by the FT to a single X post,
//      while the real fraud -- invoice round-tripping -- was nowhere near as
//      viral). tierForSourceKind() structurally enforces this: a
//      social-media host is ALWAYS written at tier='inferred', which the
//      claim_trust view's own SS7.4 verdict table excludes from
//      `n_supports_docdisc` (documented/discovered only) -- so no amount of
//      social "support" can ever satisfy the view's `verified` condition,
//      and no social "contradiction" can satisfy its
//      documented/discovered-only `n_contradicts_counting` either. The block
//      is symmetric on purpose: trusting social signal in EITHER direction
//      is the Builder.ai failure mode.
// ============================================================================
//
// ============================================================================
// A companion, deliberate SCOPE LIMIT, recorded rather than silently assumed
// (matching this project's own established style -- see e.g.
// lib/f05/verifiers.js's GH_PROVENANCE_GAP_THRESHOLD_DAYS header):
//
// This branch NEVER writes a `documented`-tier (Tier-1) contradiction.
// design.md SS6.0's Tier-1 examples are "registry filings, patents, grants,
// domain registrations, commits, direct codebase inspection" -- a plain
// Tavily /search hit is essentially never one of those; it is ordinary
// third-party observational content (Tier 2, "web traffic, app-store rank,
// hiring velocity, reviews, social sentiment"). design.md SS7.4 ALREADY
// rules on the structurally identical case for feature 04's own
// deck-vs-search comparison: "derived from deck-versus-search comparison,
// which is not Tier-1 behavioural evidence under our own hierarchy... lands
// partially_supported and never [is] promoted to a flat 'contradicted'".
// The SAME reasoning applies here, so tierForSourceKind()'s one non-social,
// non-founder-domain branch ('third_party') is pinned to 'discovered', never
// 'documented' -- a genuine factual_dynamic contradiction from THIS
// implementation therefore always caps at `partially_supported` via the
// view's own SS7.4 table, never a flat `contradicted`. A future extension
// that specifically recognises registry/filing-shaped URLs (opencorporates,
// a Secretary of State filing search, a trademark database) could
// legitimately earn `documented` tier and hence reach `contradicted` --
// design.md SS4's class table says factual_dynamic "may emit contradicted"
// in that STRUCTURAL sense (unlike qualitative/forecast/unverifiable, which
// can NEVER emit it regardless of what evidence is found) -- but building
// that detector is out of this MVP's scope, and is flagged here rather than
// silently narrowing what the design allows.
// ============================================================================

'use strict';

// ============================================================================
// Registrable-domain (eTLD+1) extraction -- duplicated from
// lib/f05/entity_gate.js rather than required from it, per this project's own
// stated convention for zero-import Code-node-bound modules (that file's own
// header: "every SOURCE-OF-TRUTH file in this repo must stay independently
// zero-import"; lib/f05/trust.js's header cites the identical precedent).
// Kept intentionally IN SYNC with entity_gate.js's own copy -- if one changes
// the public-suffix list, so should the other.
// ============================================================================

const TWO_LABEL_PUBLIC_SUFFIXES = Object.freeze([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.za', 'co.in', 'co.jp', 'co.kr', 'com.br', 'com.mx',
]);

function hostFromUrlOrHost(urlOrHost) {
  if (!urlOrHost) return null;
  let raw = String(urlOrHost).trim().toLowerCase();
  if (!raw) return null;
  if (!raw.includes('://')) raw = 'http://' + raw;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch (_e) {
    return null;
  }
  if (host.startsWith('www.')) host = host.slice(4);
  return host || null;
}

function registrableDomain(urlOrHost) {
  const host = hostFromUrlOrHost(urlOrHost);
  if (!host || !host.includes('.')) return null;
  const labels = host.split('.');
  if (labels.length >= 3) {
    const lastTwo = labels.slice(-2).join('.');
    if (TWO_LABEL_PUBLIC_SUFFIXES.indexOf(lastTwo) !== -1) {
      return labels.slice(-3).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

// ============================================================================
// Source classification
// ============================================================================

// Genuine social-network / reactive-posting platforms only -- deliberately
// EXCLUDES news.ycombinator.com (this project's own hn_algolia source is
// already treated as a documented-tier, structured signal elsewhere in this
// feature, e.g. lib/f05/verifiers.js's checkGithubProvenance; re-classifying
// it as "social media" here would contradict that existing, reviewed
// treatment) and excludes general blog-hosting platforms (medium.com,
// substack.com) -- a hosted long-form post is closer to first-person
// journalism than to the "a random reactive post went viral" Builder.ai
// failure mode this list exists to guard against. Not exhaustive by design
// (same "simplicity over precision, bounded blast radius" tradeoff as
// lib/f05/verifiers.js's DENOMINATOR_WINDOW_CHARS): missing a fringe platform
// only means that ONE platform is (wrongly) treated as third_party/discovered
// rather than social_media/inferred -- every OTHER guard in this feature
// (entity gate, tier gating, router class gating) still applies.
const SOCIAL_MEDIA_DOMAINS = Object.freeze([
  'twitter.com', 'x.com', 'reddit.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'threads.net', 'linkedin.com', 'mastodon.social', 'quora.com',
]);

function isSocialMediaHost(url) {
  const domain = registrableDomain(url);
  return domain !== null && SOCIAL_MEDIA_DOMAINS.indexOf(domain) !== -1;
}

// isCompanyDomain -- true when `url`'s registrable domain matches the
// company's own `companyDomain` or one of `companyAliases` (same comparison
// entity_gate.js's domainMatchesEntity performs for step 2 of the
// contradiction gate; duplicated here for the same zero-shared-import
// reason, applied to a DIFFERENT question -- "is this the object of the
// check" rather than "does this resolve the entity gate").
function isCompanyDomain(url, company) {
  const candidate = registrableDomain(url);
  if (!candidate) return false;
  const companyDomain = registrableDomain(company && company.domain);
  if (companyDomain && companyDomain === candidate) return true;
  const aliases = (company && Array.isArray(company.aliases)) ? company.aliases : [];
  for (let i = 0; i < aliases.length; i++) {
    if (registrableDomain(aliases[i]) === candidate) return true;
  }
  return false;
}

// classifySourceKind(url, company) -> 'social_media' | 'company_domain' | 'third_party'
//
// Order matters: a company that (implausibly) used a social-platform URL as
// its OWN `companies.domain` value would still be caught by the social check
// first -- but design.md SS5.2's "the founder's own site is never excluded,
// it is the object of the check" is about a company's OWN marketing/product
// site, not a company-run social account, so social-first is the correct
// precedence for this project's own Tier mapping (SS6.0: social sentiment is
// Tier-2 defaults elsewhere in the design, but THIS feature's own explicit
// override -- rule 4, restated at this file's header -- is that a
// social-media-SOURCED individual post/claim must never single-handedly
// verify OR contradict; company-run social accounts are not exempted from
// that override just because the company itself posted).
function classifySourceKind(url, company) {
  if (isSocialMediaHost(url)) return 'social_media';
  if (isCompanyDomain(url, company)) return 'company_domain';
  return 'third_party';
}

// tierForSourceKind -- structural enforcement of rule 4 (social) and SS6.0's
// Tier-3 self-reported mapping (company's own site): both are pinned to
// 'inferred', which the claim_trust view's SS7.4 table excludes from
// n_supports_docdisc (documented/discovered only) and from
// n_contradicts_counting (also documented/discovered only) -- so neither can
// move a claim's verdict in EITHER direction, only its audit trail.
// 'third_party' is 'discovered' (Tier-2, matching signal_sources.base_tier
// for tavily_search/tavily_news) -- see this file's header note on why it is
// never 'documented' in this implementation.
function tierForSourceKind(kind) {
  if (kind === 'social_media' || kind === 'company_domain') return 'inferred';
  return 'discovered';
}

// ============================================================================
// Query construction -- design.md SS5.2 rule 2: NO include_domains/
// exclude_domains. `params` carries only shape/cost controls (search_depth,
// max_results, include_usage so the caller can meter credits) -- never a
// domain filter, and never a `topic`/`time_range` restriction either (unlike
// e.g. n8n/workflow_defs.py's MI_SEARCH, which legitimately narrows to
// topic='news' for ITS OWN momentum-histogram purpose -- narrowing to news
// here would ALSO exclude the company's own site and GitHub/forum posts from
// consideration, which is exactly the "aggressive filtering removes the
// counter-evidence you need" failure design.md SS5.2 warns against).
const SEARCH_DEPTH = 'basic';
const MAX_RESULTS = 8;
const MAX_QUERY_CHARS = 380; // Tavily rejects an overlong query; comfortably under its limit.

function buildSearchQuery(claim, company) {
  const companyName = (company && typeof company.name === 'string') ? company.name.trim() : '';
  const claimText = (claim && typeof claim.text_verbatim === 'string') ? claim.text_verbatim.trim() : '';
  const raw = [companyName, claimText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    query: raw.slice(0, MAX_QUERY_CHARS),
    params: { search_depth: SEARCH_DEPTH, max_results: MAX_RESULTS, include_usage: true },
  };
}

// ============================================================================
// Temporal filter -- design.md SS5.2 rule 1.
//
// `result.published_date` is Tavily's own field when present. Measured
// live 2026-07-19 (this task's own exploratory call, `search_depth:'basic'`,
// no `topic` param): ABSENT on every result -- matching
// n8n/workflow_defs.py's own comment that topic='news' is "the only Tavily
// mode that returns published_date" for feature 04's unrelated market-intel
// search. Since this branch deliberately does not narrow to topic='news'
// (see buildSearchQuery's header -- that would itself be a retrieval-time
// filter), an unknown publish date is the COMMON case here, not the
// exception, and must be handled as a real branch, not a rare fallback.
//
// Policy (recorded, not silently assumed): a result is DISCARDED only when
// its published date is POSITIVELY KNOWN to be after the cutoff. A result
// with no parseable date is KEPT. This is the same "absence of evidence is
// not evidence of absence" reasoning design.md SS6.0a applies to missing
// data generally, extended here to missing METADATA specifically: discarding
// every undated result would gut this branch to near-zero given Tavily's own
// measured date coverage, which is a worse failure than occasionally keeping
// an undated result that (rarely) turns out to postdate the claim. The
// entity gate and quote-salience mismatch check downstream (owned by
// lib/f05/run.js) are what catch a genuinely wrong or circular match; this
// filter's job is only to catch the KNOWN "an article that merely repeats a
// dated claim back" case design.md's own example describes.
function filterByTemporalCutoff(results, cutoffIso) {
  const cutoffMs = cutoffIso ? Date.parse(cutoffIso) : NaN;
  const kept = [];
  const discarded = [];
  const list = Array.isArray(results) ? results : [];
  for (const r of list) {
    const publishedMs = r && typeof r.published_date === 'string' ? Date.parse(r.published_date) : NaN;
    if (Number.isFinite(cutoffMs) && Number.isFinite(publishedMs) && publishedMs > cutoffMs) {
      discarded.push(r);
    } else {
      kept.push(r);
    }
  }
  return { kept, discarded };
}

// ============================================================================
// Independence de-duplication -- design.md SS7.3, applied BEFORE any evidence
// row is written (see this file's header, point 3). One result per distinct
// registrable host survives; ties broken by Tavily's own relevance `score`
// (highest first), then by array order for full determinism.
// ============================================================================

function dedupeByRegistrableHost(results) {
  const list = Array.isArray(results) ? results.slice() : [];
  list.sort((a, b) => {
    const sa = typeof (a && a.score) === 'number' ? a.score : -Infinity;
    const sb = typeof (b && b.score) === 'number' ? b.score : -Infinity;
    return sb - sa;
  });
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const domain = registrableDomain(r && r.url);
    const key = domain || ('no-host:' + out.length); // a host-less result never collides with another
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ============================================================================
// Relevance gate -- deterministic, zero-LLM proxy for "is this result even
// about the same subject", applied BEFORE a result is allowed to become
// evidence at all (independent of, and prior to, the entity gate -- which
// governs only whether a CONTRADICTION candidate may stand, design.md SS6).
//
// Measured live 2026-07-19 (this task's own exploratory call against the
// fictional company "GameLoop"): a plain company-name query returned THREE
// results, none of them about our company -- two unrelated real mini-casino-
// game vendors that merely share generic industry keywords, and
// gameloop.com, the REAL, unrelated Android emulator product that happens to
// share the fictional company's name. All three would sail through a
// similarity-only match; this gate exists specifically to catch that class
// of false positive before it is ever written as evidence.
//
// Deliberately simple (same "bounded blast radius" tradeoff as
// lib/f05/verifiers.js's denominator window), but a NAME MATCH ALONE IS NOT
// ENOUGH -- measured live, 2026-07-19, against exactly this scenario: a
// company-name-only query for the fictional "GameLoop" returned
// `https://www.gameloop.com`, the REAL, unrelated Android-emulator product,
// whose title ("...GameLoop Official 2025") satisfies a bare name match
// outright. So this gate requires BOTH:
//   1. the company name (or a non-generic token of it) appears in the
//      result's title/content, AND
//   2. at least min(2, available) DISTINCTIVE keywords drawn from the
//      CLAIM's own text (>=5 chars, not on the generic stoplist below) also
//      appear there.
//
// ⚠️ Requiring only ONE keyword match (an earlier version of this gate) was
// measured live 2026-07-19 -- via an ACTUAL run of lib/f05/run.js against
// this exact claim, not merely a synthetic test -- to still be insufficient:
// the SAME real gameloop.com result surfaced a DIFFERENT page ("...MOBA, FPS,
// RPG, racing MOBILE games on PC with GameLoop...") whose only overlap with
// the claim's distinctive-keyword set {mobile, publishers, money, betting,
// casino, white, label} is the single word "mobile" -- generic enough, in a
// mobile-gaming claim, to appear in an unrelated mobile-gaming product's copy
// too. That single-keyword version incorrectly wrote this as `supports`
// evidence and flipped two real claims to `verified` before this fix landed
// (docs/backlog/05-truth-gap-trust/qa-report-05.md and this task's own report
// record the incident and the affected evidence rows, which predate this fix
// and could not be deleted -- evidence/raw_signals are append-only by
// design). Requiring TWO independent distinctive-keyword hits (not merely
// two occurrences of the same one) is a meaningfully higher bar a single
// generic overlapping word cannot clear alone, while a claim contributing
// fewer than two distinctive keywords in the first place still falls back to
// whatever it has (min(2, available), never impossible-to-pass).
// This is still necessarily imperfect (it does NOT prove the result is about
// the right "GameLoop" the way registrable-domain match or the entity gate
// would -- see classifySourceKind/applyEntityGate for those); a SUPPORTS
// candidate is never entity-gated (design.md SS6's own documented scope:
// "supports evidence carries no false-accusation risk"), so this remains the
// ONLY defence against a false-positive SUPPORT, and a sufficiently generic
// claim (one contributing zero distinctive keywords) falls back to a
// name-only check -- flagged here rather than silently overstated.
function normalizeForMatch(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// A handful of generic corporate-suffix tokens that are not distinctive
// enough alone to anchor a name match ("Labs", "Inc", "AI"...) -- stripped
// before checking whether ANY remaining token of the company name survives
// in the result text. Company names in this corpus are short (one or two
// words), so requiring the FULL normalized name as a substring is the
// primary check; this stoplist only backs off to a single-token match when
// the full-name substring check fails outright.
const GENERIC_NAME_TOKENS = new Set(['inc', 'labs', 'ai', 'io', 'app', 'the', 'co']);

// Words too generic to count as a "distinctive" claim keyword even past the
// 5-char length floor -- common connective/business filler that would appear
// in almost any company's marketing copy regardless of what it actually
// does, and would therefore defeat condition 2's whole purpose (the "game"/
// "games" entries are exactly what let the emulator's Call-of-Duty/Moto X3M
// copy nearly pass in the measured example above, since the claim text
// itself contains "game publishers"/"mini-games").
const GENERIC_CLAIM_KEYWORDS = new Set([
  'about', 'their', 'these', 'those', 'which', 'where', 'there', 'other',
  'lets', 'that', 'have', 'been', 'from', 'with', 'into', 'inside', 'existing',
  'game', 'games', 'product', 'products', 'company', 'platform', 'service',
  'users', 'customers', 'people', 'team', 'teams', 'daily', 'partners',
]);

function distinctiveKeywords(claimText, companyName) {
  const nameTokens = new Set(normalizeForMatch(companyName).split(' ').filter(Boolean));
  const words = normalizeForMatch(claimText).split(' ');
  const out = new Set();
  for (const w of words) {
    if (w.length >= 5 && !GENERIC_CLAIM_KEYWORDS.has(w) && !nameTokens.has(w)) out.add(w);
  }
  return Array.from(out);
}

// isClaimsOwnCitation -- this corpus's own convention (measured live
// 2026-07-19, the founder.execution.traction claim on Photo AI/Pieter
// Levels) is to embed the SOURCE URL inline in the claim text itself, e.g.
// `..."1,872 paying customers making $61,808 per month" (levels.io/photoai-
// 14000-lines-raw-php-revenue, 2023-07-03)`. A Tavily search for that exact
// claim text can (and, measured live, does) re-surface that SAME url as a
// "result" -- which is not independent corroboration at all, it is the
// claim finding its own footnote, exactly the "a deck verifies itself
// through an article that merely repeats it" failure design.md SS5.2's
// temporal filter exists to catch, one step further upstream (a self-
// citation rather than a later article quoting the self-citation). Checked
// as a simple, deliberately permissive substring test -- host + path, no
// scheme/www -- so trailing punctuation or a `www.` prefix on either side
// does not defeat it.
function isClaimsOwnCitation(claimText, url) {
  if (!url) return false;
  const bare = String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  if (!bare) return false;
  return normalizeForMatch(claimText).includes(normalizeForMatch(bare));
}

function passesRelevanceGate(companyName, claimText, result) {
  const name = normalizeForMatch(companyName);
  if (!name) return false; // no company name to anchor on -- cannot be checked at all
  const haystack = normalizeForMatch((result && result.title) || '') + ' ' + normalizeForMatch((result && result.content) || '');
  const nameTokens = name.split(' ').filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t));
  const nameMatches = haystack.includes(name) || nameTokens.some((t) => haystack.includes(t));
  if (!nameMatches) return false;

  const keywords = distinctiveKeywords(claimText, companyName);
  if (keywords.length === 0) return true; // claim text offered nothing more distinctive than the name itself
  const hits = keywords.filter((k) => haystack.includes(k)).length;
  const required = Math.min(2, keywords.length); // see this function's header: ONE match measured live to be insufficient
  return hits >= required;
}

// ============================================================================
// Verdict decision -- the deterministic, zero-LLM support/contradict call.
// `hasMismatch` is computed by the CALLER (lib/f05/run.js reuses
// lib/f05/quote_guard.js's own quoteSalienceMismatches(claimText, resultText)
// -- the same ±5% numeric-tolerance / windowed-negation logic already built
// and reviewed for factual_static's deck-quote check, applied here to an
// independent web result instead of a deck citation; NOT duplicated into
// this file, since run.js may require() freely and duplicating ~150 lines of
// regex logic across two zero-import modules would be a real, ongoing
// maintenance cost for no benefit run.js's own free require() doesn't already
// avoid). This function's OWN job is only the part design.md SS4/SS6
// actually gate on: which relation and tier the finding is written at.
function decideEvidenceAction({ hasMismatch, sourceKind }) {
  return {
    action: hasMismatch ? 'contradicts' : 'supports',
    tier: tierForSourceKind(sourceKind),
  };
}

// ============================================================================
// Budget enforcement -- design.md SS12 "capped per card in config"
// (score_formulas('trust_v1','trust').config.budget.max_paid_checks_per_card,
// seed.sql placeholder 5). Pure grouping + cap: ONE "paid check" = one claim
// that gets a live Tavily call (not one per evidence row written from it).
// Deterministic ordering (by claim_id, ascending) so which claims are
// "within budget" on a card carrying more than the cap is reproducible
// across re-runs, not an accident of array order from the DB.
function selectClaimsWithinBudget(claims, maxPerCard) {
  const cap = typeof maxPerCard === 'number' && maxPerCard >= 0 ? maxPerCard : Infinity;
  const byCard = new Map();
  for (const c of (Array.isArray(claims) ? claims : [])) {
    const key = c.card_id;
    if (!byCard.has(key)) byCard.set(key, []);
    byCard.get(key).push(c);
  }
  const withinBudget = [];
  const overBudget = [];
  for (const [, group] of byCard) {
    const sorted = group.slice().sort((a, b) => (a.claim_id < b.claim_id ? -1 : a.claim_id > b.claim_id ? 1 : 0));
    sorted.forEach((c, i) => {
      if (i < cap) withinBudget.push(c);
      else overBudget.push(c);
    });
  }
  return { withinBudget, overBudget };
}

// ============================================================================
// Stable quote_verbatim -- evidence.content_hash (lib/f05/verifiers.js's
// evidenceContentHash, SS10.1) includes the `quote` field DIRECTLY, and this
// branch's re-run idempotency acceptance (task C3's own criterion 3) depends
// on that quote being IDENTICAL across two runs of the SAME live search.
// Tavily's `content` field is an extraction/highlight snippet that can, in
// principle, vary slightly between two calls to the same query even when the
// underlying page has not changed; `title` is far more stable in practice.
// This is a deliberate, documented tradeoff (title over content) for
// content_hash STABILITY, not a claim that title is a richer audit citation
// -- the full `content` snippet is still what feeds passesRelevanceGate/the
// mismatch check upstream, it is simply not what gets PERSISTED as the quote.
function buildQuoteVerbatim(result) {
  const title = result && typeof result.title === 'string' ? result.title.trim() : '';
  if (title) return title.replace(/\s+/g, ' ').slice(0, 300);
  const host = registrableDomain(result && result.url);
  return host ? `(untitled result at ${host})` : '(untitled result, no host)';
}

module.exports = {
  SOCIAL_MEDIA_DOMAINS,
  registrableDomain,
  isSocialMediaHost,
  isCompanyDomain,
  classifySourceKind,
  tierForSourceKind,
  SEARCH_DEPTH,
  MAX_RESULTS,
  buildSearchQuery,
  filterByTemporalCutoff,
  dedupeByRegistrableHost,
  isClaimsOwnCitation,
  passesRelevanceGate,
  decideEvidenceAction,
  selectClaimsWithinBudget,
  buildQuoteVerbatim,
};
