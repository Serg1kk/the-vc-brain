// lib/f04/provenance.js
//
// Provenance/evidence-tiering core for feature 04 -- everything the n8n write
// sub-workflow (`f04-db-write`, plan.md C0) needs to turn search results into
// hashed, tiered, deduplicated rows. Split out of scoring.js (plan.md rev.2,
// Decision D1) because it shares no state with the formulas: `tierForDomain`,
// `independentDomainCount`/`independentSourceCount`, `contentHash.*` and
// `curate` never see a score term, and the formulas never see a URL. Pure
// functions only -- no I/O, no n8n imports, no network.
//
// Authoritative source for every rule: docs/backlog/04-market-trend-competition/
// design.md rev.3, sections cited inline. All tunable numbers live in
// ./config.js.

'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const { DOMAIN_TIER_RULES, DEFAULT_DOMAIN_TIER, DEFAULT_DOMAIN_STRENGTH, CURATE } = config;

// ============================================================================
// Domain helpers
// ============================================================================

// Full hostname, lowercased, leading "www." stripped. This is the form
// DOMAIN_TIER_RULES and REPORT_MILL_BLOCKLIST are matched against (their
// entries can themselves be multi-label, e.g. "ncbi.nlm.nih.gov" or
// "patents.google.com" -- collapsing to an eTLD+1 here would break exact
// matches against those entries). See independenceDomainKey() below for the
// separate, eTLD+1-aware collapse used for independence counting.
function registrableDomain(url) {
  try {
    let host = new URL(url).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

function matchDomainRule(url) {
  const host = registrableDomain(url);
  if (!host) return null;
  for (const rule of DOMAIN_TIER_RULES) {
    if (rule.suffixes && rule.suffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
      return rule;
    }
    if (rule.domains && rule.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      return rule;
    }
  }
  return null;
}

// tierForDomain(url) -> 'documented' | 'discovered' | 'inferred'. Default-deny
// (§3.4): any domain matching no rule -- allow-listed or not, seen before or
// not -- is 'inferred'. This is the guarantee that makes a brand-new,
// never-seen report mill fail safe without needing to be on the blocklist
// (design.md's own live-probe example: astuteanalytica.com, relevance 0.92,
// not on the blocklist, still lands here).
function tierForDomain(url) {
  const rule = matchDomainRule(url);
  return rule ? rule.tier : DEFAULT_DOMAIN_TIER;
}

// evidence.strength for a given URL (§3.4's table has TWO strengths inside
// the 'documented' tier -- 0.90 for government/patents, 0.80 for named
// analyst firms/press -- so this cannot be derived from tierForDomain()'s
// bare tier string alone).
function evidenceStrengthForDomain(url) {
  const rule = matchDomainRule(url);
  return rule ? rule.strength : DEFAULT_DOMAIN_STRENGTH;
}

function isBlocklisted(url) {
  const host = registrableDomain(url);
  if (!host) return false;
  return config.REPORT_MILL_BLOCKLIST.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// ============================================================================
// §3.4 rule 2 -- "independence is counted by distinct registrable domain, not
// by citation count." This needs a real (if small) public-suffix awareness:
// "shop.example.co.uk" and "blog.example.co.uk" are the SAME registrable
// domain (example.co.uk), not two, and a naive "last two labels" rule would
// wrongly split them at "co.uk". The list below covers the common two-label
// public suffixes that plausibly appear in market/competitor research; it is
// deliberately NOT the same lookup as matchDomainRule() above, which needs
// full-hostname matching against multi-label allow-list entries instead.
// ============================================================================

const TWO_LABEL_PUBLIC_SUFFIXES = Object.freeze([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.za', 'co.in', 'co.jp', 'co.kr', 'com.br', 'com.mx', 'com.cn',
]);

function independenceDomainKey(url) {
  const host = registrableDomain(url);
  if (!host) return null;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LABEL_PUBLIC_SUFFIXES.includes(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

// independentDomainCount(urls) -- §3.4 rule 2's direct implementation: "five
// citations do not mean five independent sources." Two URLs on the same
// registrable domain (whether identical hosts, a bare/www pair, or two
// different subdomains) count once. Pure and tier-agnostic by design: this
// function only ever receives URLs, never evidence tier/strength, so
// "independence" here is strictly about distinct sources, not about how
// strong any one of them is -- that is §3.4 rule 1's job (the all-inferred
// confidence cap), enforced separately in the validator, not here.
function independentDomainCount(urls) {
  const keys = new Set();
  for (const url of urls || []) {
    const key = independenceDomainKey(url);
    if (key) keys.add(key);
  }
  return keys.size;
}

// independentSourceCount(urlsWithTiers) -- §3.4 rule 2, corrected: the
// original rule conflated two mechanisms design.md now separates.
//
//   2a. distinct registrable domain (documented/discovered tiers): a source
//       cited via several URLs/subdomains is one source. independentDomainCount
//       above is this half exactly, and stays URL-only/tier-agnostic.
//   2b. tier collapse (inferred tier): report mills recycle each other, so
//       two DIFFERENT mills agreeing is one number laundered twice, not two
//       confirmations -- this needs tier data, which independentDomainCount
//       deliberately does not have.
//
// `urlsWithTiers`: array of `{url, tier}` (tier: 'documented'|'discovered'|
// 'inferred'|'missing', matching evidence.tier's vocabulary). 'missing' rows
// carry no real URL per §3.5 and contribute nothing here, same as an
// unrecognized/absent tier.
//
//   count = |distinct registrable domains among tiers {documented, discovered}|
//         + (1 if any inferred-tier source is present, else 0)
//
// Reuses registrableDomain() (via independenceDomainKey()'s eTLD+1-aware
// collapse, for the same .co.uk/subdomain reasons as independentDomainCount).
function independentSourceCount(urlsWithTiers) {
  const strongDomains = new Set();
  let hasInferred = false;

  for (const item of urlsWithTiers || []) {
    if (!item || !item.url) continue;
    if (item.tier === 'documented' || item.tier === 'discovered') {
      const key = independenceDomainKey(item.url);
      if (key) strongDomains.add(key);
    } else if (item.tier === 'inferred') {
      hasInferred = true;
    }
    // 'missing' (or any other/absent tier) contributes nothing.
  }

  return strongDomains.size + (hasInferred ? 1 : 0);
}

// ============================================================================
// §3.5 -- content-hash recipes (idempotency on append-only, NOT NULL UNIQUE
// content_hash columns).
//
// design.md writes each recipe as `sha256(a ‖ b ‖ c)` -- concatenation, with
// no delimiter specified between fields. A delimiter is required here or
// "ab"+"c" and "a"+"bc" collide; NUL ( ) is used because it is
// vanishingly unlikely to appear in any of the source fields (URLs, slugs,
// uuids, ISO timestamps). This is an implementation detail design.md leaves
// unspecified, not a deviation from the recipe's field list or order.
// ============================================================================

const HASH_FIELD_DELIMITER = ' ';

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hashFields(...parts) {
  return sha256Hex(parts.map((part) => (part === null || part === undefined ? '' : String(part))).join(HASH_FIELD_DELIMITER));
}

const contentHash = {
  // raw_signals: sha256(source ‖ source_url ‖ query ‖ observed_at). Contains
  // NO ai_run_id and NO "now" component -- two runs with the same pinned
  // end_date (and hence the same observed_at fallback, §3.5) produce the
  // IDENTICAL hash. That is what makes "select-by-hash first, insert only if
  // absent, reuse the found id" work on a re-run; if this varied per run the
  // provenance chain (evidence.raw_signal_id) would break on the demo re-run.
  rawSignal({ source, source_url, query, observed_at }) {
    return hashFields(source, source_url, query, observed_at);
  },
  // claims: sha256(card_id ‖ topic ‖ ai_run_id ‖ item_key) -- item_key is what
  // keeps N-rows-per-run topics (competitors, tailwinds/headwinds) from
  // colliding; ai_run_id is what keeps a re-run's claims as NEW rows so
  // scores.trend has history.
  claim({ card_id, topic, ai_run_id, item_key }) {
    return hashFields(card_id, topic, ai_run_id, item_key);
  },
  // evidence: sha256(claim_id ‖ relation ‖ coalesce(source_url,'') ‖
  // coalesce(quote_verbatim,'') ‖ coalesce(query,'')) -- the `query`
  // discriminator is what keeps multiple tier='missing' rows (NULL url, NULL
  // quote) on one claim from colliding.
  evidence({ claim_id, relation, source_url, quote_verbatim, query }) {
    return hashFields(claim_id, relation, source_url ?? '', quote_verbatim ?? '', query ?? '');
  },
};

// ============================================================================
// §4 -- curator (score >= 0.4 gate, URL-normalised dedup, first-party
// exemption scoped to the relevance gate only, top-8 survivors).
//
// "bucket" (design.md §4's node-chain line: "top-8 per bucket") is not
// further defined in design.md beyond that one mention. This function
// curates ONE array of results (one bucket, e.g. one query's results) down
// to its top CURATE.TOP_N survivors; the caller (the n8n workflow) is
// expected to invoke it once per bucket/query, per the design's Q1-Q5 shape.
// Flagged to the team lead as a judgment call, not a blocking ambiguity.
// ============================================================================

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    let path = u.pathname.toLowerCase();
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${host}${path}`;
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

function curate(results, companyDomain) {
  const companyHost = companyDomain ? String(companyDomain).toLowerCase().replace(/^www\./, '') : null;

  const survivors = [];
  const indexByNormalizedUrl = new Map();

  for (const result of results || []) {
    if (!result || !result.url) continue;
    // Defense-in-depth: Tavily's exclude_domains is the primary blocklist
    // enforcement, but the curator "is still subject to the blocklist" (§4).
    if (isBlocklisted(result.url)) continue;

    const host = registrableDomain(result.url);
    const isFirstParty = Boolean(companyHost && host && (host === companyHost || host.endsWith(`.${companyHost}`)));
    const score = typeof result.score === 'number' ? result.score : 0;

    // First-party exemption bypasses ONLY the relevance gate -- it is still
    // deduplicated and still subject to the blocklist above (§4).
    if (!isFirstParty && score < CURATE.RELEVANCE_MIN) continue;

    const key = normalizeUrl(result.url);
    const candidate = { ...result, firstParty: isFirstParty };
    const existingIndex = indexByNormalizedUrl.get(key);
    if (existingIndex === undefined) {
      indexByNormalizedUrl.set(key, survivors.length);
      survivors.push(candidate);
    } else if (score > (typeof survivors[existingIndex].score === 'number' ? survivors[existingIndex].score : 0)) {
      survivors[existingIndex] = candidate; // keep the higher-scored duplicate
    }
  }

  survivors.sort((a, b) => (typeof b.score === 'number' ? b.score : 0) - (typeof a.score === 'number' ? a.score : 0));
  return survivors.slice(0, CURATE.TOP_N);
}

module.exports = {
  registrableDomain,
  tierForDomain,
  evidenceStrengthForDomain,
  independentDomainCount,
  independentSourceCount,
  normalizeUrl,
  contentHash,
  curate,
};
