// lib/f02/ethics.js
// SOURCE OF TRUTH: lib/f02/ethics.js
//
// The two ethics mechanisms design.md §7 claims as *demonstrable product
// behaviour* rather than slide content: a robots.txt gate before any crawl,
// and an opt-out gate before any write. Both were specified in §7 and neither
// existed until this file -- found by pre-checking the feature's own QA brief
// instead of waiting for the gate to report it.
//
// Self-contained CommonJS, ZERO imports. The parsing is pure and unit-tested;
// network access is injected by the caller (`fetchFn`) so this file stays
// pasteable into an n8n Code node and testable without a socket.
//
// WHY THIS IS NOT DECORATION. EDPB Guidelines 03/2026 (07.07.2026) moved
// robots.txt from a ToS-etiquette question to a **GDPR** one: robots.txt,
// ai.txt and CAPTCHAs are treated as indicators of the data subject's
// reasonable expectations and feed directly into the legitimate-interest
// balancing test. CNIL's 19.06.2025 checklist says the same. Ignoring
// robots.txt is therefore not merely impolite -- it weakens the lawful basis
// for the whole pipeline. Design §7 item 1.

'use strict';

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

// Parses robots.txt into the rules that apply to `userAgent`, following the
// conventional precedence: a group matching the exact agent wins over the
// wildcard group; if neither exists, everything is allowed.
//
// Deliberately NOT a full RFC 9309 implementation -- no crawl-delay, no
// sitemap, no wildcard-in-path expansion beyond `*` and `$`. It errs toward
// DISALLOW on anything it cannot parse, which is the correct direction for a
// consent-adjacent check: a false skip costs us one candidate, a false crawl
// costs the lawful basis.
function parseRobotsTxt(text, userAgent) {
  const ua = String(userAgent || '*').toLowerCase();
  const groups = new Map(); // agent -> {allow: [], disallow: []}
  let current = [];

  // Consecutive `User-agent:` lines declare ONE group that shares the rule
  // block following them ("User-agent: a / User-agent: b / Disallow: /x"
  // disallows /x for both). `sawRuleSinceAgent` is what distinguishes a
  // continuing declaration from the start of a new group.
  let sawRuleSinceAgent = false;

  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [] });
      if (sawRuleSinceAgent) current = [];   // rules intervened -> this starts a new group
      current.push(groups.get(agent));
      sawRuleSinceAgent = false;
    } else if (field === 'allow' || field === 'disallow') {
      sawRuleSinceAgent = true;
      for (const g of current) {
        if (field === 'allow') g.allow.push(value);
        else g.disallow.push(value);
      }
    }
  }

  const group = groups.get(ua) || groups.get('*') || { allow: [], disallow: [] };
  return group;
}

// Converts a robots.txt path pattern to a matcher. Supports `*` (any run) and
// a trailing `$` (end anchor) -- the two extensions every major crawler honours.
function pathMatches(pattern, path) {
  if (pattern === '') return false; // `Disallow:` with an empty value means "allow all"
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('^' + escaped + (anchored ? '$' : ''));
  return re.test(path);
}

// isCrawlAllowed(robotsText, url, userAgent) -> {allowed, rule, reason}
// Longest-match-wins between Allow and Disallow, per the de-facto standard.
function isCrawlAllowed(robotsText, url, userAgent) {
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + (u.search || '');
  } catch (_e) {
    return { allowed: false, rule: null, reason: 'unparseable_url' };
  }

  const group = parseRobotsTxt(robotsText, userAgent);

  let bestDisallow = null;
  for (const p of group.disallow) {
    if (pathMatches(p, path) && (bestDisallow === null || p.length > bestDisallow.length)) bestDisallow = p;
  }
  let bestAllow = null;
  for (const p of group.allow) {
    if (pathMatches(p, path) && (bestAllow === null || p.length > bestAllow.length)) bestAllow = p;
  }

  if (bestDisallow === null) return { allowed: true, rule: bestAllow, reason: 'no_matching_disallow' };
  if (bestAllow !== null && bestAllow.length >= bestDisallow.length) {
    return { allowed: true, rule: bestAllow, reason: 'allow_overrides' };
  }
  return { allowed: false, rule: bestDisallow, reason: 'disallowed' };
}

// checkRobots(url, fetchFn, userAgent) -> {allowed, checked, status, rule, reason}
//
// Fetch failures are treated as ALLOWED and flagged `checked:false`. That is
// deliberate and is the standard reading: a site with no robots.txt (404) has
// expressed no objection, and an unreachable robots.txt must not be
// indistinguishable from a disallow -- §7.1's rule that "could not verify"
// and "objects to crawling" are different outcomes and must not be conflated.
// The `checked` flag is what makes the difference auditable afterwards.
async function checkRobots(url, fetchFn, userAgent) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (_e) {
    return { allowed: false, checked: false, status: null, rule: null, reason: 'unparseable_url' };
  }

  try {
    const res = await fetchFn(origin + '/robots.txt');
    const status = res && typeof res.status === 'number' ? res.status : null;
    if (status !== 200) {
      return { allowed: true, checked: true, status, rule: null, reason: 'no_robots_txt' };
    }
    const text = typeof res.text === 'function' ? await res.text() : String(res.body || '');
    const verdict = isCrawlAllowed(text, url, userAgent);
    return { allowed: verdict.allowed, checked: true, status, rule: verdict.rule, reason: verdict.reason };
  } catch (e) {
    return { allowed: true, checked: false, status: null, rule: null, reason: 'fetch_failed:' + (e && e.message) };
  }
}

// The events row a skip produces. Design §7 item 1: the skip is recorded so it
// is visible rather than silent -- "showing the function is worth more than a
// paragraph claiming it".
//
// ⚠️ `entity_type` is 'founder', NOT 'url'. QA found the original 'url' value
// made this row **structurally unreachable by erasure**: `purge_founder()`
// sweeps events with exactly
//   DELETE FROM events WHERE entity_type = 'founder' AND entity_id = ANY (...)
// so any other entity_type can never match, and a skipped-crawl row carries a
// real personal-site URL in its payload -- personal data surviving a deletion
// request. Confirmed live: such a row survived two subsequent purge calls.
// `entity_id` is left null here because the founder row does not exist yet at
// robots-check time; the caller fills it in before persisting (run.js), which
// is the only point where the id is known.
function crawlSkippedEvent(url, verdict) {
  return {
    event_type: 'crawl_skipped_robots',
    entity_type: 'founder',
    entity_id: null,
    payload: { url: url, rule: verdict.rule, reason: verdict.reason, checked: verdict.checked },
    actor: 'lib/f02/ethics.js:checkRobots',
  };
}

// ---------------------------------------------------------------------------
// opt-out
// ---------------------------------------------------------------------------

// isOptedOut(identityRows) -> {blocked, matchedIdentity}
//
// Design §7 item 2. Opt-out and erasure are deliberately DIFFERENT operations:
// opt-out sets `founders.opt_out_at` and KEEPS the row as a suppression
// tombstone, which is exactly what this check needs to work. Erasure
// (`purge_founder()`) hard-deletes the row, so after a true erasure the same
// person CAN be re-ingested by a later scan -- a limit design §7 states openly
// rather than papering over. Do not "fix" that here by resurrecting rows; the
// honest fix is a salted-hash suppression list, which is out of MVP scope.
//
// `identityRows` are `founder_identities` rows already joined to their founder,
// each carrying `founder_opt_out_at`. The caller supplies them; this function
// is pure so the rule is testable without a database.
function isOptedOut(identityRows) {
  const rows = Array.isArray(identityRows) ? identityRows : [];
  for (const r of rows) {
    if (r && r.founder_opt_out_at) {
      return { blocked: true, matchedIdentity: { kind: r.kind, value: r.value }, optedOutAt: r.founder_opt_out_at };
    }
  }
  return { blocked: false, matchedIdentity: null, optedOutAt: null };
}

module.exports = {
  parseRobotsTxt,
  pathMatches,
  isCrawlAllowed,
  checkRobots,
  crawlSkippedEvent,
  isOptedOut,
};
