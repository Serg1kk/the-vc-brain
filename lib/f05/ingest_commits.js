#!/usr/bin/env node
// lib/f05/ingest_commits.js
//
// Headless CLI for feature 05 task B4 (added mid-build, not in plan.md).
// Mirrors lib/f02/run.js's shape (a Node CLI, not a Code-node body -- it may
// require() freely) and lib/f05/run.js's own Postgres-access convention
// (shell out to `psql`, never PostgREST -- that file's own header explains
// why: it is this feature's established house style, and it is simpler than
// re-deriving a service-role key when DATABASE_URL is already the project's
// documented path, CLAUDE.md > Commands).
//
// WHY THIS FILE EXISTS: lib/f05/verifiers.js's checkGithubProvenance()
// (design.md SS5.1(b)) compares a repo's earliest commit author date against
// the Show HN submission date. Both were designed to already live in
// raw_signals -- but measured 2026-07-19, NEITHER supported payload shape was
// actually populated for the general corpus: raw_signals held repo metadata,
// user profiles and PR-search results (github_api), never a commits-endpoint
// payload. This file closes that gap so the check runs on real people
// instead of returning 'insufficient_data' on every live claim.
//
// Usage:
//   node lib/f05/ingest_commits.js [--write] [--now <iso>] [--limit N]
//   node lib/f05/ingest_commits.js --verify <founder_id>
//
//   (no flags)     Dry run: resolves the checkable founder set, fetches
//                  GitHub, prints a per-founder summary, writes nothing.
//   --write        Actually inserts the resulting raw_signals rows, via the
//                  same idempotent INSERT ... ON CONFLICT (content_hash) DO
//                  NOTHING RETURNING id pattern lib/f05/run.js already uses
//                  for evidence/events (batched as ONE jsonb -v parameter,
//                  unpacked server-side via jsonb_array_elements).
//   --now <iso>    Pins the hour-truncated observed_at snapshot used in the
//                  content_hash recipe (lib/f02/pipeline.js's own
//                  hourTrunc(now) idiom, reproduced locally below -- see that
//                  file's "Small pure helpers" section) -- so two --write
//                  runs given the SAME --now hash identically and the second
//                  is a true no-op, not merely "probably within the same
//                  wall-clock hour". Defaults to the real current time.
//   --limit N      Cap the number of founders processed (debugging only; the
//                  full checkable set is 33 -- see the fixture exclusion
//                  note below).
//   --verify <id>  Reads back whatever raw_signals (github_api + hn_algolia)
//                  already exist for one founder and calls
//                  checkGithubProvenance() on them directly, printing its
//                  real output -- the acceptance proof that a row THIS file
//                  wrote now feeds the consumer function correctly. Talks to
//                  the database only; makes no GitHub calls and needs no
//                  GITHUB_TOKEN.
//
// Env:
//   DATABASE_URL   read from process.env if set, else built from
//                  infra/supabase/.env's POOLER_TENANT_ID + POSTGRES_PASSWORD
//                  (Supavisor pooler on :54322 -- CLAUDE.md > Commands).
//   GITHUB_TOKEN   read from process.env if set, else parsed from the repo
//                  root .env (lib/f02/run.js's own getGithubToken()
//                  duplicated here -- never printed, never written to any
//                  file, never placed in a SQL or JSON literal; used only as
//                  an Authorization header value on outbound fetch() calls).
//
// docs/backlog/05-truth-gap-trust/design.md SS5.1(b), SS10.2.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { sha256Hex, extractEarliestCommitAuthorDate, checkGithubProvenance } = require('./verifiers.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// design.md SS12: feature 05's OWN labelled QA fixture reserves the
// `05f00001-...` id range for a synthetic company ("ledgerly/recon-engine")
// deliberately hand-authored so its earliest commit postdates its Show HN
// date -- the AVeriTeC-shaped test case, not a real founder. Measured
// 2026-07-19: this exact id is the only one of the 34 dual-signal founders
// in that range, and its github_api payload is a narrative `{note, ...}`
// object (neither shape checkGithubProvenance's extractor understands), and
// "ledgerly/recon-engine" does not exist on GitHub -- fetching it would just
// 404. Excluded here by its literal id (not a `LIKE '05f%'` pattern, which
// could in principle also match a real random uuid) so the exclusion is
// exact and auditable rather than fuzzy.
const FIXTURE_FOUNDER_IDS = new Set(['05f00001-0000-0000-0000-000000000001']);

// GitHub's own polite-use floor for this run (team lead instruction): stop
// dispatching new requests once headroom drops below this, rather than
// racing the hourly ceiling.
const RATE_LIMIT_FLOOR = 200;

// ============================================================================
// .env / DATABASE_URL (duplicated from lib/f05/run.js and lib/f02/run.js
// rather than required from either -- this project's own established
// pattern for these few lines: lib/f02/run.js, lib/f02/write.js and
// lib/f05/run.js each carry their own copy rather than share one, and
// lib/f05/run.js's private helpers are not exported for another file to
// reuse, so duplication here is the same choice those three files already
// made, not a new one).
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

function getDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = parseDotEnv(path.join(REPO_ROOT, 'infra', 'supabase', '.env'));
  const tenant = env.POOLER_TENANT_ID;
  const password = env.POSTGRES_PASSWORD;
  if (!tenant || !password) {
    throw new Error(
      'ingest_commits.js: cannot build DATABASE_URL -- set DATABASE_URL explicitly, or ensure ' +
        'infra/supabase/.env has POOLER_TENANT_ID and POSTGRES_PASSWORD (CLAUDE.md > Commands)'
    );
  }
  return 'postgresql://postgres.' + tenant + ':' + password + '@localhost:54322/postgres';
}

// GITHUB_TOKEN -- never returned to a caller that logs it; only ever spread
// into a fetch() Authorization header below. lib/f02/run.js's own
// getGithubToken(), reproduced verbatim.
function getGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const env = parseDotEnv(path.join(REPO_ROOT, '.env'));
  return env.GITHUB_TOKEN || null;
}

// ============================================================================
// Postgres access via psql -- IDENTICAL rationale and shape to
// lib/f05/run.js's own psqlRun/pgQueryJson/pgExec/uuidArrayLiteral (that
// file's header spells out the safety argument: every parameter travels
// through `-v NAME=value`, referenced via `:'NAME'` -- psql's own
// quote_literal-equivalent substitution -- never string-concatenated into
// the SQL text; spawnSync passes argv as an array, so no shell ever
// re-interprets it either). Reproduced here rather than required from that
// file because run.js exports none of these -- they are that file's own
// private helpers, and it is task B4's OWN instruction not to modify B3's
// file to add an export surface it does not otherwise need.
// ============================================================================

function psqlRun(databaseUrl, sql, vars) {
  const args = [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tA'];
  for (const [k, v] of Object.entries(vars || {})) {
    args.push('-v', k + '=' + v);
  }
  args.push('-f', '-');
  const res = spawnSync('psql', args, { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    throw new Error('ingest_commits.js: failed to spawn psql (' + res.error.message + ')');
  }
  if (res.status !== 0) {
    throw new Error(
      'ingest_commits.js: psql exited ' + res.status + ':\n' + (res.stderr || '').trim() + '\n--- SQL ---\n' + sql
    );
  }
  return res.stdout;
}

function pgQueryJson(databaseUrl, sql, vars) {
  const out = psqlRun(databaseUrl, sql, vars).trim();
  if (!out) return null;
  return JSON.parse(out);
}

function pgExec(databaseUrl, sql, vars) {
  return psqlRun(databaseUrl, sql, vars);
}

function uuidArrayLiteral(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  return '{' + list.join(',') + '}';
}

// ============================================================================
// hourTrunc -- lib/f02/pipeline.js's own helper, reproduced verbatim (same
// file, same reasoning: two --write runs given the same --now must hash
// identically; the project's convention is to keep this a local one-liner
// per file rather than a cross-feature require).
// ============================================================================

function hourTrunc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// ============================================================================
// raw_signals content_hash -- lib/f02/normalize.js's OWN recipe
// (`sha256(source || '::' || source_id || '::' || observed_at)`), NOT
// lib/f05/verifiers.js's evidence recipe (that one hashes a different table,
// under a delimiter design.md SS10.1 left unspecified; f02's design.md SS6.1
// pins '::' explicitly for raw_signals). This row lands in the SAME
// raw_signals table f02 already writes to, so it hashes under f02's own
// convention rather than inventing a second one for one table. sha256Hex
// itself is reused from lib/f05/verifiers.js (delimiter-agnostic -- it just
// hashes a string; the join character lives here, not there), which is
// ordinary within-feature reuse, not the cross-feature coupling the
// PostgREST-helper duplication above was avoiding.
// ============================================================================

async function rawSignalContentHash(parts) {
  const basis = (Array.isArray(parts) ? parts : [parts])
    .map((p) => (p === null || p === undefined ? '' : String(p)))
    .join('::');
  return sha256Hex(basis);
}

// ============================================================================
// Repo resolution -- design brief: "Get each founder's repo from the
// existing github_api payloads ... and/or applications.artifact_links
// (shape {repo:{owner,name}, ...})". Three tiers, tried in order; measured
// against the live 33-founder corpus 2026-07-19, tiers 1+2 alone resolve
// 33/33 -- tier 3 is kept as an honest last resort for a founder shape this
// corpus does not currently contain (see its own header note below), not
// exercised today.
// ============================================================================

// Tier 1: applications.artifact_links.repo.{owner,name} -- the structured
// field pipeline.js populates when it resolved the Show HN artifact as a
// github_repo AT WRITE TIME. Most direct when present.
function repoFromArtifactLinksField(artifactLinks) {
  const repo = artifactLinks && typeof artifactLinks === 'object' ? artifactLinks.repo : null;
  if (!repo || typeof repo !== 'object') return null;
  const owner = typeof repo.owner === 'string' ? repo.owner.trim() : '';
  const name = typeof repo.name === 'string' ? repo.name.trim() : '';
  if (!owner || !name) return null;
  return { owner, repo: name };
}

// Tier 2: regex the artifact_url itself. Measured 2026-07-19: 16 of the 33
// real founders have a NULL `.repo` sub-object even though `.artifact_url`
// is plainly a github.com/{owner}/{repo} link -- pipeline.js's artifact-kind
// classification (a company-sourcing concept: site vs product vs none) is
// evidently a DIFFERENT judgment from "is this URL parseable as a github
// repo", and the former does not gate the latter. Rather than treat that as
// a bug to chase, this tier recovers the same fact pipeline.js's own
// parseArtifactUrl() would have, directly from the URL string already sitting
// in the row.
const GITHUB_REPO_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

function repoFromArtifactUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = GITHUB_REPO_URL_RE.exec(url.trim());
  if (!m) return null; // e.g. a bare github.com/{user} profile link -- one path segment, no match
  return { owner: m[1], repo: m[2] };
}

// Tier 3 -- LAST RESORT, never exercised against the live corpus measured
// 2026-07-19 (tiers 1+2 covered 33/33). Kept so a future founder whose only
// github trace is a cross-linked profile -- no repo-shaped Show HN artifact
// at all -- still resolves instead of silently vanishing from the checkable
// set, per the design brief's explicit "and/or ... github_api payloads"
// instruction. Scans every github_api raw_signals payload already on file
// for this founder (single-object rows like a direct repo fetch, AND
// repo objects embedded one level inside an array or an `.items` list, e.g.
// a repos listing or a search-results wrapper) for anything shaped like a
// real GitHub repo object, restricted to ones this founder's own GitHub
// login actually owns, excluding forks, preferring the most recently pushed.
function looksLikeRepoObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x) && typeof x.full_name === 'string' && x.full_name.includes('/') && x.fork !== true;
}

function looksLikeUserProfileObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x) && typeof x.login === 'string' && typeof x.full_name !== 'string';
}

function collectRepoCandidates(payload, out) {
  if (!payload) return;
  if (Array.isArray(payload)) {
    for (const item of payload) collectRepoCandidates(item, out);
    return;
  }
  if (typeof payload !== 'object') return;
  if (looksLikeRepoObject(payload)) {
    const slash = payload.full_name.indexOf('/');
    out.push({
      owner: payload.full_name.slice(0, slash),
      repo: payload.full_name.slice(slash + 1),
      pushedAt: typeof payload.pushed_at === 'string' ? payload.pushed_at : null,
    });
  }
  // One level of nested arrays only (e.g. a search-results wrapper's
  // `.items`) -- harmless to descend into regardless, since a non-repo
  // element simply never satisfies looksLikeRepoObject().
  for (const key of Object.keys(payload)) {
    if (Array.isArray(payload[key])) collectRepoCandidates(payload[key], out);
  }
}

function repoFromGithubApiPayloads(payloads) {
  let login = null;
  for (const p of payloads) {
    if (looksLikeUserProfileObject(p)) {
      login = p.login;
      break;
    }
  }
  const candidates = [];
  for (const p of payloads) collectRepoCandidates(p, candidates);
  const owned = login ? candidates.filter((c) => c.owner.toLowerCase() === login.toLowerCase()) : candidates;
  if (owned.length === 0) return null;
  owned.sort((a, b) => {
    const ap = a.pushedAt ? Date.parse(a.pushedAt) : -Infinity;
    const bp = b.pushedAt ? Date.parse(b.pushedAt) : -Infinity;
    if (bp !== ap) return bp - ap; // most recently pushed first
    return a.repo.localeCompare(b.repo); // deterministic tie-break
  });
  return { owner: owned[0].owner, repo: owned[0].repo };
}

// ============================================================================
// GitHub REST -- earliest commit, per design.md SS5.1(b): "GET
// /repos/{owner}/{repo}/commits?per_page=1 then follow the Link: rel="last"
// header to the final page". Handles 404 (renamed/deleted), 409 (empty
// repository -- GitHub's real status for /commits on a repo with zero
// commits) and 451 (unavailable for legal reasons) by skipping, never by
// fabricating a date.
// ============================================================================

function parseLinkHeader(headerValue) {
  const out = {};
  if (!headerValue) return out;
  for (const part of headerValue.split(',')) {
    const m = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

async function githubGet(url, headers) {
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, reason: 'network_error: ' + err.message, rateRemaining: null };
  }
  const rrHeader = res.headers.get('x-ratelimit-remaining');
  const rateRemaining = rrHeader === null ? null : Number(rrHeader);
  if (res.status === 404) return { ok: false, reason: 'not_found (renamed or deleted)', rateRemaining };
  if (res.status === 409) return { ok: false, reason: 'empty_repository (409)', rateRemaining };
  if (res.status === 451) return { ok: false, reason: 'unavailable_for_legal_reasons (451)', rateRemaining };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `http_${res.status}: ${body.slice(0, 200)}`, rateRemaining };
  }
  const json = await res.json();
  return { ok: true, json, linkHeader: res.headers.get('link'), rateRemaining };
}

// fetchEarliestCommitPayload -- ONE or TWO GitHub calls per repo: the first
// page (per_page=1) to discover whether more than one page exists at all,
// and -- only when it does -- the `rel="last"` page, which IS the earliest
// commit by GitHub's own newest-first default ordering. When there is no
// `rel="last"` link the repo has exactly one page of results at per_page=1,
// so that lone commit is trivially both newest and earliest -- no second
// call needed. Returns the bare commits-array response UNMODIFIED (shape
// (a) in lib/f05/verifiers.js's extractEarliestCommitAuthorDate -- it
// already carries both commit.author.date and commit.committer.date, and
// both timezone offsets embedded in each ISO string, with zero
// transformation needed).
async function fetchEarliestCommitPayload(owner, repo, ghHeaders) {
  const firstUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`;
  const first = await githubGet(firstUrl, ghHeaders);
  if (!first.ok) return first;

  const links = parseLinkHeader(first.linkHeader);
  if (!links.last) {
    return { ok: true, payload: first.json, rateRemaining: first.rateRemaining };
  }
  const last = await githubGet(links.last, ghHeaders);
  if (!last.ok) return last;
  return { ok: true, payload: last.json, rateRemaining: last.rateRemaining };
}

// ============================================================================
// Reads
// ============================================================================

// The checkable set: founders carrying BOTH a github_api and an hn_algolia
// raw_signals row (34 measured 2026-07-19, minus the one fixture id above =
// 33 real founders), joined once to their founder-card's application for
// tier 1/2 repo resolution -- one round trip, not one per founder.
function loadCheckableFounders(databaseUrl) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT DISTINCT ON (rs.founder_id)
        rs.founder_id,
        c.company_id,
        a.artifact_links AS artifact_links
      FROM raw_signals rs
      JOIN cards c ON c.founder_id = rs.founder_id AND c.card_type = 'founder'
      LEFT JOIN applications a ON a.id = c.application_id
      WHERE rs.source = 'github_api' AND rs.founder_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM raw_signals rs2
          WHERE rs2.founder_id = rs.founder_id AND rs2.source = 'hn_algolia'
        )
      ORDER BY rs.founder_id
    ) t;`;
  return pgQueryJson(databaseUrl, sql, {}) || [];
}

// Tier-3 fallback data -- fetched lazily, one founder at a time, only when
// tiers 1/2 both miss (never happens against today's corpus; see that
// tier's own header note).
function loadGithubApiPayloads(databaseUrl, founderId) {
  const sql = `
    SELECT COALESCE(json_agg(payload), '[]'::json)
    FROM raw_signals WHERE founder_id = :'founder_id'::uuid AND source = 'github_api';`;
  return pgQueryJson(databaseUrl, sql, { founder_id: founderId }) || [];
}

// --verify support -- both raw_signals sources already on file for one
// founder, exactly as checkGithubProvenance's two params expect them.
function loadProvenanceRawSignalsForFounder(databaseUrl, founderId) {
  const sql = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
      SELECT source, payload FROM raw_signals
      WHERE founder_id = :'founder_id'::uuid AND source IN ('github_api', 'hn_algolia')
    ) t;`;
  const rows = pgQueryJson(databaseUrl, sql, { founder_id: founderId }) || [];
  const commitPayloads = rows.filter((r) => r.source === 'github_api').map((r) => r.payload);
  const hnPayloads = rows.filter((r) => r.source === 'hn_algolia').map((r) => r.payload);
  return { commitPayloads, hnPayloads };
}

// ============================================================================
// Writes -- ONE batched INSERT, matching lib/f05/run.js's own
// writeEvidenceRows/writeEvents shape (a whole array travels as ONE jsonb -v
// parameter, unpacked server-side via jsonb_array_elements). ON CONFLICT
// (content_hash) DO NOTHING RETURNING id is sufficient here (unlike
// lib/f02/write.js's two-step insertIdempotent) because nothing else in
// THIS file needs to resolve a pre-existing row's real id afterward -- task
// B4's brief is raw_signals only, no evidence FK to attach.
// ============================================================================

function insertRawSignals(databaseUrl, rows) {
  if (!rows.length) return { insertedIds: [] };
  const sql = `
    INSERT INTO raw_signals (source, source_url, payload, content_hash, founder_id, company_id, observed_at)
    SELECT
      r->>'source', r->>'source_url', r->'payload', r->>'content_hash',
      (r->>'founder_id')::uuid, NULLIF(r->>'company_id', '')::uuid, (r->>'observed_at')::timestamptz
    FROM jsonb_array_elements(:'rows_json'::jsonb) AS r
    ON CONFLICT (content_hash) DO NOTHING
    RETURNING id;`;
  const out = psqlRun(databaseUrl, sql, { rows_json: JSON.stringify(rows) }).trim();
  const insertedIds = out ? out.split('\n').filter(Boolean) : [];
  return { insertedIds };
}

// ============================================================================
// CLI
// ============================================================================

function usageError(msg) {
  process.stderr.write(
    'ingest_commits.js: ' + msg + '\n' +
      'Usage: node lib/f05/ingest_commits.js [--write] [--now <iso>] [--limit N]\n' +
      '       node lib/f05/ingest_commits.js --verify <founder_id>\n'
  );
  process.exit(1);
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  let write = false;
  let now = null;
  let limit = null;
  let verify = null;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--write') write = true;
    else if (arg === '--now') {
      if (i + 1 >= rest.length) usageError('--now requires an argument');
      now = rest[++i];
    } else if (arg === '--limit') {
      if (i + 1 >= rest.length) usageError('--limit requires an argument');
      limit = Number(rest[++i]);
      if (!Number.isInteger(limit) || limit < 0) usageError('--limit must be a non-negative integer');
    } else if (arg === '--verify') {
      if (i + 1 >= rest.length) usageError('--verify requires a founder_id argument');
      verify = rest[++i];
      if (!UUID_RE.test(verify)) usageError('--verify <founder_id> must be a UUID, got "' + verify + '"');
    } else {
      usageError('unknown argument "' + arg + '"');
    }
  }
  return { write, now, limit, verify };
}

async function runVerify(databaseUrl, founderId) {
  const { commitPayloads, hnPayloads } = loadProvenanceRawSignalsForFounder(databaseUrl, founderId);
  const result = checkGithubProvenance({ commitPayloads, hnPayloads });
  process.stdout.write(JSON.stringify({ founder_id: founderId, ...result }, null, 2) + '\n');
}

async function main() {
  const { write, now, limit, verify } = parseArgs(process.argv);
  const databaseUrl = getDatabaseUrl();

  if (verify) {
    await runVerify(databaseUrl, verify);
    return;
  }

  const githubToken = getGithubToken();
  if (!githubToken) {
    usageError('GITHUB_TOKEN not found in process.env or repo-root .env -- required for --live GitHub calls');
  }
  const ghHeaders = {
    'User-Agent': 'the-vc-brain-f05-ingest-commits',
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + githubToken,
  };

  const observedAtSnapshot = hourTrunc(now || new Date().toISOString());

  const allCheckable = loadCheckableFounders(databaseUrl);
  let founders = allCheckable.filter((f) => !FIXTURE_FOUNDER_IDS.has(f.founder_id));
  const excludedFixtureCount = allCheckable.length - founders.length;
  if (typeof limit === 'number') founders = founders.slice(0, limit);

  process.stderr.write(
    `[ingest_commits] checkable founders: ${founders.length} (excluded ${excludedFixtureCount} feature-05 fixture id(s))\n`
  );

  const detail = [];
  const rowsToInsert = [];
  let rateRemaining = null;
  let rateLimitedStop = false;

  for (const founder of founders) {
    if (rateRemaining !== null && rateRemaining < RATE_LIMIT_FLOOR) {
      rateLimitedStop = true;
      process.stderr.write(
        `[ingest_commits] X-RateLimit-Remaining ${rateRemaining} < ${RATE_LIMIT_FLOOR} -- stopping early, ` +
          `${founders.length - detail.length} founder(s) not attempted\n`
      );
      break;
    }

    let resolved = repoFromArtifactLinksField(founder.artifact_links);
    let resolutionTier = resolved ? 1 : null;
    if (!resolved) {
      resolved = repoFromArtifactUrl(founder.artifact_links && founder.artifact_links.artifact_url);
      if (resolved) resolutionTier = 2;
    }
    if (!resolved) {
      const payloads = loadGithubApiPayloads(databaseUrl, founder.founder_id);
      resolved = repoFromGithubApiPayloads(payloads);
      if (resolved) resolutionTier = 3;
    }

    if (!resolved) {
      detail.push({ founder_id: founder.founder_id, status: 'skipped', reason: 'no resolvable repo (tiers 1-3 all missed)' });
      continue;
    }

    const { owner, repo } = resolved;
    const fetchResult = await fetchEarliestCommitPayload(owner, repo, ghHeaders);
    if (typeof fetchResult.rateRemaining === 'number') rateRemaining = fetchResult.rateRemaining;

    if (!fetchResult.ok) {
      detail.push({ founder_id: founder.founder_id, owner, repo, resolution_tier: resolutionTier, status: 'skipped', reason: fetchResult.reason });
      continue;
    }

    const earliestAuthorDate = extractEarliestCommitAuthorDate(fetchResult.payload);
    const firstCommit = Array.isArray(fetchResult.payload) ? fetchResult.payload[0] : null;
    const sourceUrl = (firstCommit && firstCommit.html_url) || `https://github.com/${owner}/${repo}/commits`;
    // Deliberately NOT founder-scoped (matches lib/f02/normalize.js's own
    // repo:/repos:/contributors: sourceIds, none of which include a founder
    // id either): the fact this row records -- "repo X's earliest commit" --
    // is a property of the REPO, not of whichever founder record happens to
    // be asking about it. ⚠️ Observed live, 2026-07-19: when two DIFFERENT
    // founder cards resolve (independently, via tiers 1/2 above) to the
    // EXACT same repo -- founders c6aaaec3.../e776347c... both -> puffinsoft/
    // peek-cli, the same upstream founder/company dedup gap class documented
    // in lib/f02/write.js's "PHASE-INVARIANT ANCHOR" comment, not introduced
    // here -- this hash correctly collapses their two observations of the
    // identical GitHub fact into ONE row rather than writing the same
    // payload twice under two different hashes. The second founder's own
    // checkGithubProvenance() then legitimately reads 'insufficient_data'
    // until the upstream dedup is fixed; that is reported, not silently
    // dropped (see the task's acceptance report). raw_signals carries
    // trg_raw_signals_forbid_mutation (db/schema.sql), so once such a
    // collision lands it cannot be retroactively re-split by editing this
    // recipe after the fact -- documented here rather than "fixed" in a way
    // that would strand the rows already written under the old scheme.
    const sourceId = `commits:${owner}/${repo}`;
    const contentHash = await rawSignalContentHash(['github_api', sourceId, observedAtSnapshot]);

    rowsToInsert.push({
      source: 'github_api',
      source_url: sourceUrl,
      payload: fetchResult.payload,
      content_hash: contentHash,
      founder_id: founder.founder_id,
      company_id: founder.company_id,
      observed_at: observedAtSnapshot,
    });

    detail.push({
      founder_id: founder.founder_id,
      owner,
      repo,
      resolution_tier: resolutionTier,
      status: 'ok',
      earliest_commit_author_date: earliestAuthorDate,
    });
  }

  let insertedIds = [];
  if (write) {
    ({ insertedIds } = insertRawSignals(databaseUrl, rowsToInsert));
    process.stderr.write(`[ingest_commits] wrote ${insertedIds.length} of ${rowsToInsert.length} raw_signals row(s) (rest already present -- idempotent no-op)\n`);
  }

  const summary = {
    attempted: founders.length,
    excluded_fixture: excludedFixtureCount,
    resolved_ok: detail.filter((d) => d.status === 'ok').length,
    skipped: detail.filter((d) => d.status === 'skipped').length,
    rate_limited_stop: rateLimitedStop,
    rows_built: rowsToInsert.length,
    rows_inserted: write ? insertedIds.length : null,
    dry_run: !write,
    detail,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('ingest_commits.js: FATAL: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  hourTrunc,
  rawSignalContentHash,
  repoFromArtifactLinksField,
  repoFromArtifactUrl,
  repoFromGithubApiPayloads,
  parseLinkHeader,
  FIXTURE_FOUNDER_IDS,
};
