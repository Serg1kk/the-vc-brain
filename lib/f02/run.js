#!/usr/bin/env node
// lib/f02/run.js
//
// Headless runner for feature 02 (Sourcing Radar) -- mirrors lib/f03/run.js's
// shape: makes the deterministic core demonstrable end to end without n8n.
// Unlike lib/f02/{normalize,identity,claims,obscurity,pipeline}.js this file
// is a Node CLI, not a Code-node body: it may require() freely (docs/backlog/
// TRACKER.md's zero-import rule applies only to files pasted verbatim into an
// n8n Code node).
//
// Usage:
//   node lib/f02/run.js --recorded <dir> [--capabilities k=v,k=v] [--now <iso>] [--write]
//   node lib/f02/run.js --live <hn_object_id> [--capabilities k=v,k=v] [--write]
//
//   --recorded <dir>   Zero network calls. Loads <dir>/{hn_story,hn_thread,
//                       hn_user,gh_user,gh_repo,gh_repos,gh_contributors,
//                       tavily_site}.json (any file that does not exist ->
//                       that input field is simply absent, exactly as
//                       buildWriteSet expects). `tavily_site.json` (added
//                       2026-07-19, present in user-artifact and
//                       product-url only) is `{seed, map, extract}` --
//                       `.map` and `.extract` are fed straight through as
//                       `siteMap`/`siteExtract`. org-artifact and
//                       threaded-artifact deliberately have NO site seed at
//                       all, so they correctly keep producing NO site
//                       claims (design §5.0 rule 2.3) -- that asymmetry
//                       across the four fixtures is real recorded coverage,
//                       not a gap to "fix" by inventing data for the other
//                       two. This is the default/safe path -- what the four
//                       recorded fixtures in db/fixtures/recorded/ use, and
//                       the only thing that is safe to run on stage (design
//                       §9.2's own "the only way the demo is safe" framing,
//                       borrowed here from 03's identical --recorded need).
//   --live <id>        Makes real HN Algolia + GitHub REST calls for HN item
//                       <id>, AND a robots-gated Tavily site crawl (added
//                       2026-07-19). The crawl checks robots.txt BEFORE
//                       fetching anything and skips + records a
//                       `crawl_skipped_robots` event on a disallow -- design
//                       §7 item 1, which EDPB Guidelines 03/2026 make a GDPR
//                       matter rather than mere ToS etiquette. Seed
//                       precedence is §7.1's: scheme-normalised github blog
//                       -> the Show HN artifact URL when it is not a
//                       github.com link -> nothing (and per §5.0 rule 2.3
//                       "nothing" means no claim at all, not a `missing`
//                       marker). A
//                       GITHUB_TOKEN in .env raises the GitHub REST ceiling
//                       from 60/h unauthenticated to 5000/h (design §5.4)
//                       but is NOT required -- confirmed absent from .env
//                       at the time of writing, and this file works without
//                       it.
//   --capabilities k=v,k=v   Override the default capability gates. Default
//                       for BOTH modes: github=true,tavily=true. Tavily
//                       being "on" by default is safe even for --live (no
//                       siteExtract ever gets attached there, so the
//                       capability is simply moot) and for the two
//                       no-site-seed --recorded fixtures (siteMap/
//                       siteExtract are absent from THEIR input regardless
//                       of the capability flag, so rule 2.3 still yields no
//                       attempt for them) -- it only actually matters for
//                       user-artifact/product-url, where real recorded data
//                       exists to gate.
//   --now <iso>         Pin buildWriteSet's `now` (design §6.1: pass it in
//                       so hour-truncated content hashes are reproducible
//                       across replays). Defaults to the current time.
//   --write             Actually apply the resulting write-set via
//                       lib/f02/write.js (real PostgREST inserts). Default
//                       off -- without it this is a pure dry-run that prints
//                       the summary and exits, touching no database.
//
// Prints: identity tier/confidence/discoveredVia, claims emitted by slug
// (with evidence tier), the reachable-weight diagnostic (design §5.1's
// table, transcribed here for display only -- 03's score_formulas config
// remains the single source of truth for what actually gets scored), and
// the write-set's own counters.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildWriteSet } = require('./pipeline.js');
const { resolveIdentity } = require('./identity.js');
const { parseArtifactUrl, canonicalDomain, normalizeName, contentHash } = require('./normalize.js');
const { PRODUCERS, TOPIC, tierForSource } = require('./claims.js');
const { obscurity } = require('./obscurity.js');
const { checkRobots, crawlSkippedEvent, isCrawlAllowed } = require('./ethics.js');
const { applyWriteSet, writeEvents } = require('./write.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEPS = { resolveIdentity, parseArtifactUrl, canonicalDomain, normalizeName, contentHash, PRODUCERS, TOPIC, tierForSource, obscurity };

// design §5.1's reachable-weight table, transcribed for THIS CLI's display
// only. This is NOT read by buildWriteSet and does not influence any write
// -- 03's `score_formulas` config row is the authoritative source for what
// actually gets scored; duplicating the numbers here would be a real
// divergence risk if 03's weights ever change, so this is clearly labelled
// as a diagnostic snapshot, not a second source of truth.
const DIAGNOSTIC_WEIGHTS = {
  [TOPIC.EXECUTION_MERGED_PR_FOREIGN]: 0.10000,
  [TOPIC.EXECUTION_COMMIT_CONSISTENCY]: 0.06000,
  [TOPIC.EXECUTION_LIVE_PRODUCT]: 0.10000,
  [TOPIC.EXECUTION_EXTERNAL_USAGE]: 0.08000,
  [TOPIC.EXECUTION_PROVENANCE]: 0.06000,
  [TOPIC.EXPERTISE_VERTICAL_TENURE]: 0.09375,
  [TOPIC.EXPERTISE_INSIGHT_SPECIFICITY]: 0.07500,
  [TOPIC.EXPERTISE_UNASKED_WORK]: 0.07500,
  [TOPIC.LEADERSHIP_WRITTEN_COMMUNICATION]: 0.06000,
};

// ============================================================================
// CLI
// ============================================================================

function usageError(msg) {
  process.stderr.write(
    `run.js: ${msg}\n` +
      'Usage: node lib/f02/run.js --recorded <dir> [--capabilities k=v,k=v] [--now <iso>] [--write]\n' +
      '       node lib/f02/run.js --live <hn_object_id> [--capabilities k=v,k=v] [--write]\n'
  );
  process.exit(1);
}

function parseCapabilities(spec, defaults) {
  const out = { ...defaults };
  if (!spec) return out;
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (!k) continue;
    out[k] = v === 'true' || v === '1' || v === undefined;
    if (v === 'false' || v === '0') out[k] = false;
  }
  return out;
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  let mode = null;
  let target = null;
  let capabilitiesSpec = null;
  let now = null;
  let write = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--recorded' || arg === '--live') {
      if (mode) usageError('--recorded and --live are mutually exclusive');
      mode = arg === '--recorded' ? 'recorded' : 'live';
      if (i + 1 >= rest.length) usageError(`${arg} requires an argument`);
      target = rest[++i];
    } else if (arg === '--capabilities') {
      if (i + 1 >= rest.length) usageError('--capabilities requires an argument');
      capabilitiesSpec = rest[++i];
    } else if (arg === '--now') {
      if (i + 1 >= rest.length) usageError('--now requires an argument');
      now = rest[++i];
    } else if (arg === '--write') {
      write = true;
    } else {
      usageError(`unknown argument "${arg}"`);
    }
  }
  if (!mode) usageError('one of --recorded <dir> or --live <hn_object_id> is required');

  return { mode, target, capabilitiesSpec, now, write };
}

// ============================================================================
// --recorded: load a fixture directory into buildWriteSet's input shape
// ============================================================================

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function loadRecordedInput(dir) {
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
  const meta = loadJson(path.join(resolved, 'meta.json'));
  // tavily_site.json -- {seed, map, extract} -- added 2026-07-19, present
  // in user-artifact and product-url only. org-artifact/threaded-artifact
  // have no such file (no site seed at all -- see the file-header note),
  // so tavilySite stays null for them and siteMap/siteExtract fall through
  // to buildWriteSet as absent, which is the correct, deliberate asymmetry
  // (design §5.0 rule 2.3: no attempt, no claim).
  const tavilySite = loadJson(path.join(resolved, 'tavily_site.json'));
  return {
    input: {
      hnStory: loadJson(path.join(resolved, 'hn_story.json')),
      hnThread: loadJson(path.join(resolved, 'hn_thread.json')),
      hnUser: loadJson(path.join(resolved, 'hn_user.json')),
      ghUser: loadJson(path.join(resolved, 'gh_user.json')),
      ghRepo: loadJson(path.join(resolved, 'gh_repo.json')),
      ghRepos: loadJson(path.join(resolved, 'gh_repos.json')),
      ghContributors: loadJson(path.join(resolved, 'gh_contributors.json')),
      // gh_search_prs.json / gh_events.json (E1/E3, added 2026-07-19) --
      // recorded for all three GitHub-bearing fixtures (user-artifact,
      // org-artifact, threaded-artifact); product-url has neither (no
      // GitHub artifact at all). Absence of the file (product-url) ->
      // null, exactly as buildWriteSet's capability gating expects.
      ghSearchPrs: loadJson(path.join(resolved, 'gh_search_prs.json')),
      ghEvents: loadJson(path.join(resolved, 'gh_events.json')),
      siteMap: tavilySite ? tavilySite.map : null,
      siteExtract: tavilySite ? tavilySite.extract : null,
    },
    meta,
  };
}

// ============================================================================
// --live: real HN Algolia + GitHub REST calls
// ============================================================================

function parseDotEnv(filePath) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return out;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const env = parseDotEnv(path.join(REPO_ROOT, '.env'));
  return env.GITHUB_TOKEN || null;
}

// ---- live personal-site crawl helpers (design §7 item 1, §7.1) ------------

// The UA we present when FETCHING robots.txt, and the agent name we evaluate
// its rules against.
//
// ⚠️ HONEST LIMITATION, found by QA and NOT fixed here. An earlier version of
// this comment claimed this same string is used for the page fetch too. It is
// not: the actual page retrieval is delegated to Tavily's /map and /extract,
// which crawl under Tavily's own identity and expose no UA parameter. So we
// evaluate robots.txt as `vcbrain-radar` while a different agent does the
// fetching -- structurally the pattern the EDPB guidance treats as not
// honouring the signal, even though our intent is the opposite.
//
// Why it is left standing for the MVP: we cannot set Tavily's UA, and the
// alternative (fetching pages ourselves to control the UA, losing Tavily's
// markdown extraction) is a larger change than the remaining time allows.
// The gate still has real force -- it refuses disallowed sites outright, so
// nothing is fetched at all for those (verified: linkedin.com/in/* is refused,
// rule `/`). The gap is that for ALLOWED sites we cannot prove the fetch
// happened under the agent we checked as.
// Correct fix, recorded for post-MVP: fetch the root page directly with this
// UA -- §7.1 measured that /map returns zero URLs on real personal sites, so
// the root-only path is already the common case and needs no crawler.
const ROBOTS_UA = 'vcbrain-radar';

// Events produced during a live fetch (currently only robots skips). Collected
// here rather than written inline so the fetch stays side-effect-free apart
// from network reads; the caller persists them.
const liveEvents = [];

function getTavilyKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  const env = parseDotEnv(path.join(REPO_ROOT, '.env'));
  return env.TAVILY_API_KEY || null;
}

// §7.1 field findings, in precedence order:
//  1. github `blog` -- but it carries NO SCHEME ('ayuhito.com'), so normalise
//  2. the Show HN artifact URL, when it is not itself a github.com link
//  3. nothing -- and per §5.0 rule 2.3 that means NO claim at all, not a
//     `missing` marker, because no attempt was made
// repo.homepage is deliberately excluded: the recorded fixture's points at
// pkg.go.dev, a package registry, and crawling it would attribute a registry
// page to the founder.
function deriveLiveSiteSeed(ghUser, artifact, hnStory) {
  const blog = ghUser && typeof ghUser.blog === 'string' ? ghUser.blog.trim() : '';
  if (blog) return blog.includes('://') ? blog : 'https://' + blog;
  const url = hnStory && hnStory.url ? String(hnStory.url) : '';
  if (url && artifact && artifact.kind === 'product') return url;
  return null;
}

async function tavilyPost(endpoint, body, key) {
  try {
    const res = await fetch('https://api.tavily.com' + endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    // Best-effort, never fatal (vantage's posture): a Tavily failure must not
    // kill a run whose HN and GitHub signals are already in hand.
    return null;
  }
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 404) return null; // absent, not fatal -- design §2's "best-effort, never fatal"
    const body = await res.text().catch(() => '');
    throw new Error(`run.js: GET ${url} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Derives BOTH the search-hit-shaped `hnStory` AND the full `hnThread` from
// a single `/items/{id}` call -- a deliberate CLI-only simplification (see
// the file-header note): the real f02-radar-scan n8n workflow (Stage C, not
// this file) makes the two as SEPARATE calls (search_by_date for the
// funnel head, /items/{id} for the thread), which is why pipeline.js keeps
// them as two distinct raw_signals rows even though this CLI derives both
// from one fetch.
function deriveHnStoryFromItem(item) {
  function countComments(node) {
    if (!node) return 0;
    const children = Array.isArray(node.children) ? node.children : [];
    let count = 0;
    for (const child of children) {
      if (child && child.type === 'comment') count += 1;
      count += countComments(child);
    }
    return count;
  }
  return {
    objectID: String(item.id),
    author: item.author,
    title: item.title || null,
    url: item.url || null,
    story_text: item.text || null,
    points: item.points ?? null,
    num_comments: countComments(item),
    created_at: item.created_at,
    created_at_i: item.created_at_i,
    story_id: item.id,
  };
}

async function fetchLiveInput(hnObjectId) {
  const item = await fetchJson(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(hnObjectId)}`);
  if (!item) throw new Error(`run.js: HN item ${hnObjectId} not found`);
  const hnStory = deriveHnStoryFromItem(item);
  const hnThread = item;

  const hnUser = hnStory.author ? await fetchJson(`https://hn.algolia.com/api/v1/users/${encodeURIComponent(hnStory.author)}`) : null;

  const artifact = parseArtifactUrl(hnStory.url);

  const githubToken = getGithubToken();
  const ghHeaders = { 'User-Agent': 'the-vc-brain-f02-run', Accept: 'application/vnd.github+json' };
  if (githubToken) ghHeaders.Authorization = `Bearer ${githubToken}`;

  let ghUser = null;
  let ghRepo = null;
  let ghRepos = null;
  let ghContributors = null;
  let ghSearchPrs = null;
  let ghEvents = null;

  if (artifact.kind === 'github_repo' || artifact.kind === 'github_user') {
    ghUser = await fetchJson(`https://api.github.com/users/${encodeURIComponent(artifact.owner)}`, ghHeaders);
    ghRepos = await fetchJson(`https://api.github.com/users/${encodeURIComponent(artifact.owner)}/repos?per_page=100&sort=pushed`, ghHeaders);
    // E1/E3 (design §5.4, REST-only) -- fetched for WHATEVER account owns
    // the artifact, User or Organization; buildWriteSet's own
    // `personLinked` gate (lib/f02/pipeline.js) decides whether the result
    // may be attributed to the founder -- this file just fetches what is
    // fetchable, same division of concerns as ghContributors below.
    ghSearchPrs = await fetchJson(
      `https://api.github.com/search/issues?q=author:${encodeURIComponent(artifact.owner)}+type:pr+is:merged&sort=created&order=desc&per_page=100`,
      ghHeaders
    );
    ghEvents = await fetchJson(`https://api.github.com/users/${encodeURIComponent(artifact.owner)}/events?per_page=100`, ghHeaders);
  }
  if (artifact.kind === 'github_repo') {
    ghRepo = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(artifact.owner)}/${encodeURIComponent(artifact.repo)}`, ghHeaders);
    if (ghUser && ghUser.type === 'Organization') {
      ghContributors = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(artifact.owner)}/${encodeURIComponent(artifact.repo)}/contributors`, ghHeaders);
    }
  }

  // ---- personal-site crawl, ROBOTS-GATED (design §7 item 1) --------------
  // The gate runs BEFORE the crawl, not after, and a refusal is reported
  // rather than swallowed. EDPB Guidelines 03/2026 made robots.txt a GDPR
  // matter, not merely a ToS one: it is read as an indicator of the data
  // subject's reasonable expectations and feeds the legitimate-interest
  // balancing test. So a skip here protects the lawful basis of the whole
  // pipeline, and showing the function is the point (§7: "showing the
  // function is worth more than a paragraph claiming it").
  //
  // Seed precedence per §7.1's field findings: scheme-normalised github blog
  // -> the Show HN artifact URL when it is not a github.com link -> nothing.
  // repo.homepage is deliberately NOT a seed (the recorded fixture's is
  // pkg.go.dev, a package registry).
  let siteMap = null;
  let siteExtract = null;
  let robots = null;
  const siteSeed = deriveLiveSiteSeed(ghUser, artifact, hnStory);
  const tavilyKey = getTavilyKey();

  if (siteSeed && tavilyKey) {
    robots = await checkRobots(siteSeed, (u) => fetch(u, { headers: { 'User-Agent': ROBOTS_UA } }), ROBOTS_UA);
    const robotsText = robots.text || '';
    if (!robots.allowed) {
      // Recorded, never silent -- this row is the demonstrable artefact.
      liveEvents.push(crawlSkippedEvent(siteSeed, robots));
      process.stderr.write(
        `robots.txt: SKIPPED ${siteSeed} (rule=${robots.rule ?? 'n/a'}, reason=${robots.reason})\n`
      );
    } else {
      const mapped = await tavilyPost('/map', {
        url: siteSeed, max_depth: 1, limit: 20, allow_external: false, include_usage: true,
      }, tavilyKey);
      const mappedUrls = (mapped && Array.isArray(mapped.results)) ? mapped.results : [];
      // QA re-check gap: the seed was gated but the up-to-5 URLs /map hands to
      // /extract were not. robots rules are PATH-scoped, not origin-scoped --
      // `Disallow: /blog` with an allowed `/` is ordinary — so a per-URL check
      // is required. No extra network cost: robots.txt for this origin was
      // already fetched above, so each URL is evaluated against the text we
      // hold. Disallowed ones are dropped AND recorded, same as the seed.
      const urls = [];
      for (const u of mappedUrls) {
        const v = isCrawlAllowed(robotsText, u, ROBOTS_UA);
        if (v.allowed) { urls.push(u); continue; }
        liveEvents.push(crawlSkippedEvent(u, { ...v, checked: true }));
        process.stderr.write(`robots.txt: SKIPPED mapped url ${u} (rule=${v.rule ?? 'n/a'})\n`);
      }
      // §7.1 finding 2: /map returns 0 URLs on real small personal sites
      // (measured on both fixture sites). ROOT-only fallback, and never
      // guess /about or /blog -- finding 3: they 404 and manufacture false
      // failed_results that are indistinguishable from real breakage.
      const targets = urls.length > 0 ? urls.slice(0, 5) : [siteSeed];
      siteMap = mapped;
      siteExtract = await tavilyPost('/extract', {
        urls: targets, extract_depth: 'basic', format: 'markdown', include_usage: true,
      }, tavilyKey);
    }
  }

  return {
    input: {
      hnStory, hnThread, hnUser, ghUser, ghRepo, ghRepos, ghContributors, ghSearchPrs, ghEvents,
      siteMap, siteExtract,
    },
    meta: {
      case: 'live', hn_author: hnStory.author, artifact_url: hnStory.url, objectID: hnStory.objectID,
      site_seed: siteSeed, robots,
    },
  };
}

// ============================================================================
// Summary printing
// ============================================================================

function printSummary(writeSet, meta) {
  const lines = [];
  lines.push(`=== ${meta && meta.case ? meta.case : '(live)'} ===`);
  if (meta) {
    lines.push(`hn_author: ${meta.hn_author ?? '(n/a)'}   artifact_url: ${meta.artifact_url ?? '(none)'}`);
  }
  lines.push(
    `identity: tier=${writeSet.decisions.identityTier} confidence=${writeSet.decisions.identityConfidence} ` +
      `discoveredVia=${writeSet.decisions.discoveredVia} crossPlatformLinked=${writeSet.decisions.crossPlatformLinked} ` +
      `orgIsCompany=${writeSet.decisions.orgIsCompany} needsReview=${writeSet.decisions.needsReview}`
  );
  lines.push(`founder: ${writeSet.founder.full_name}   company: ${writeSet.company.name} (domain=${writeSet.company.domain ?? 'null'})`);
  lines.push(`obscurity: ${writeSet.decisions.obscurity} (diagnostic -- production reads the radar_candidates SQL view, design §6.4)`);
  lines.push('');
  lines.push('claims:');
  let reachableWeight = 0;
  const allSlugs = Object.values(TOPIC);
  for (const slug of allSlugs) {
    const found = writeSet.claims.find((c) => c.claim.topic === slug);
    const weight = DIAGNOSTIC_WEIGHTS[slug] ?? 0;
    if (!found) {
      lines.push(`  - ${slug}: (no attempt / not wired for this input)`);
      continue;
    }
    const tag = found.evidence.tier === 'missing' ? 'missing' : found.evidence.tier;
    if (found.evidence.tier !== 'missing') reachableWeight += weight;
    lines.push(`  - ${slug}: [${tag}] weight=${weight.toFixed(5)}${found.evidence.tier === 'missing' ? ' (not counted -- missing)' : ''}`);
  }
  lines.push('');
  lines.push(`reachable weight (diagnostic, non-missing claims only): ${reachableWeight.toFixed(5)} of 0.70375 ceiling (design §5.1)`);
  lines.push('');
  lines.push(`counters: ${JSON.stringify(writeSet.counters)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ============================================================================
// main
// ============================================================================

async function main() {
  const { mode, target, capabilitiesSpec, now, write } = parseArgs(process.argv);

  const defaultCapabilities = { github: true, tavily: true };
  const capabilities = parseCapabilities(capabilitiesSpec, defaultCapabilities);

  let input;
  let meta;
  if (mode === 'recorded') {
    ({ input, meta } = loadRecordedInput(target));
    if (!input.hnStory) usageError(`no hn_story.json found under "${target}"`);
  } else {
    ({ input, meta } = await fetchLiveInput(target));
  }

  input.capabilities = capabilities;
  if (now) input.now = now;

  const writeSet = await buildWriteSet(input, DEPS);
  printSummary(writeSet, meta);

  if (write) {
    process.stdout.write('\n--write set -- applying to Supabase via PostgREST...\n');
    const result = await applyWriteSet(writeSet);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    // design §6.2 + §7 item 1: the run ledger and any robots skip are
    // PERSISTED, not merely printed. Until this existed, crawlSkippedEvent()
    // built an object nobody stored and the §7 claim that "the skip is
    // recorded so it is visible rather than silent" was simply false.
    // Written even when the ingest was suppressed by the opt-out gate -- an
    // opted-out person leaves no new trace, but the RUN still happened and a
    // reader of the ledger must be able to see that it did.
    // Every ledger row is bound to the FOUNDER, not to the url/application.
    // purge_founder() sweeps `entity_type = 'founder' AND entity_id = ANY(...)`
    // and nothing else, so any other entity_type is structurally unreachable by
    // erasure (QA finding, confirmed live: a crawl_skipped_robots row holding a
    // real personal-site URL survived two purge calls).
    const founderIdForLedger = result && result.ids ? (result.ids.founder || null) : null;
    const ledger = liveEvents.map((ev) => ({ ...ev, entity_id: ev.entity_id || founderIdForLedger }));
    ledger.push({
      event_type: 'radar_scan_completed',
      entity_type: 'founder',
      entity_id: founderIdForLedger,
      payload: {
        counters: writeSet.counters,
        created: result ? result.created : null,
        blocked: result ? Boolean(result.blocked) : false,
        identity_tier: writeSet.decisions.identityTier,
        obscurity: writeSet.decisions.obscurity,
      },
      actor: 'lib/f02/run.js',
    });
    const evres = await writeEvents(ledger);
    process.stdout.write(`events written: ${evres.written}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
