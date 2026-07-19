// lib/f02/write.js
//
// The PostgREST writer for feature 02 (Sourcing Radar). Takes ONE
// lib/f02/pipeline.js write-set (local refs, no real ids) and applies it to
// Supabase in FK order, resolving every "…Ref" to a real database uuid as
// it goes. NOT pure -- this file does real network I/O (`fetch`) -- and is
// therefore NOT a Code-node body: it is a Node CLI dependency, like
// lib/f03/run.js's own helpers, and MAY require() freely (docs/backlog/
// TRACKER.md's zero-import rule applies only to files pasted verbatim into
// an n8n Code node; this one is executed by `node`, never pasted).
//
// docs/backlog/02-sourcing-radar/design.md §5.0 rule 3 is this file's
// entire reason to exist:
//
//   "raw_signals and evidence carry trg_*_forbid_mutation, so `ON CONFLICT
//   DO UPDATE` ... raises P0001. `ON CONFLICT DO NOTHING` is correct but
//   returns ZERO ROWS on a retry -- leaving the workflow with no
//   raw_signal_id to attach evidence to ... Every DB-write step is
//   therefore: INSERT ... ON CONFLICT DO NOTHING, then, if zero rows
//   returned, SELECT id WHERE content_hash = $1."
//
// insertIdempotent() below is that exact two-step pattern, generalised to
// any natural key (content_hash for raw_signals/claims/evidence,
// (kind,value) for founder_identities, (metric,founder_id,company_id,
// observed_at) for metric_observations) -- every table in this file that
// HAS a real unique constraint goes through it. Two tables in the write-set
// do NOT have one at the schema level (`applications`, and `companies`
// when its `domain` is null) -- see the dedicated comments at their call
// sites for the honest, documented consequence of that gap.
//
// `SUPABASE_URL` env-drift idiom (TRACKER.md, hit live twice by 03 and 04):
// `String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '')`
// before appending `/rest/v1/` -- correct regardless of which convention
// the env var currently holds.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { contentHash } = require('./normalize.js');
const { isOptedOut } = require('./ethics.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ----------------------------------------------------------------------------
// .env loading (mirrors lib/f03/run.js's own minimal parser -- no dependencies)
// ----------------------------------------------------------------------------

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

// SUPABASE_URL: process.env first, else the documented HOST-facing default
// (CLAUDE.md > Commands: "Kong/REST 8000"). Deliberately does NOT fall back
// to infra/n8n/.env's SUPABASE_URL the way getServiceRoleKey() falls back
// to that file for the key: n8n's own SUPABASE_URL is baked in as
// `http://host.docker.internal:8000/...` -- a hostname that resolves ONLY
// from INSIDE a docker container reaching out to the host, and reliably
// fails with a bare `TypeError: fetch failed` when this CLI runs on the
// host itself (confirmed live, 2026-07-19, running this exact file).
// Reading that value here would silently reintroduce the exact SUPABASE_URL
// drift incident TRACKER.md already recorded once for 03/04 -- in the
// opposite direction (host trying to use a container-only hostname, rather
// than the container using a stale host value). sbNormalize() still runs
// on whatever this resolves to, so an explicit SUPABASE_URL env var (in
// either convention) remains correct either way.
function getSupabaseUrl() {
  return process.env.SUPABASE_URL || 'http://localhost:8000';
}

// SERVICE_ROLE_KEY: process.env (either name), then infra/n8n/.env
// (SUPABASE_SERVICE_ROLE_KEY), then infra/supabase/.env (SERVICE_ROLE_KEY,
// the un-prefixed name the Supabase compose stack itself uses).
function getServiceRoleKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.SERVICE_ROLE_KEY) return process.env.SERVICE_ROLE_KEY;
  const n8nEnv = parseDotEnv(path.join(REPO_ROOT, 'infra', 'n8n', '.env'));
  if (n8nEnv.SUPABASE_SERVICE_ROLE_KEY) return n8nEnv.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseEnv = parseDotEnv(path.join(REPO_ROOT, 'infra', 'supabase', '.env'));
  if (supabaseEnv.SERVICE_ROLE_KEY) return supabaseEnv.SERVICE_ROLE_KEY;
  throw new Error(
    'write.js: cannot find a service-role key -- set SUPABASE_SERVICE_ROLE_KEY, or ensure ' +
      'infra/n8n/.env or infra/supabase/.env has one (CLAUDE.md > Commands)'
  );
}

// The SB_NORMALIZE idiom itself (TRACKER.md, 03/04's shared incident).
function sbNormalize(rawUrl) {
  return String(rawUrl || '').replace(/\/rest\/v1\/?$/, '');
}

// ----------------------------------------------------------------------------
// Thin PostgREST client
// ----------------------------------------------------------------------------

function makeClient({ supabaseUrl, serviceRoleKey } = {}) {
  const base = sbNormalize(supabaseUrl || getSupabaseUrl());
  const key = serviceRoleKey || getServiceRoleKey();

  async function restRequest(method, pathAndQuery, { body, prefer } = {}) {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (_e) {
        throw new Error(`write.js: PostgREST returned non-JSON (status ${res.status}) for ${method} ${pathAndQuery}: ${text.slice(0, 500)}`);
      }
    }
    if (!res.ok) {
      throw new Error(`write.js: PostgREST ${res.status} for ${method} ${pathAndQuery}: ${JSON.stringify(json || text).slice(0, 1000)}`);
    }
    return json;
  }

  // selectOne -- GET one row (or null) matching `filters` (PostgREST
  // operator syntax, e.g. { kind: 'eq.hn', value: 'eq.ayuhito' }).
  // ⚠️ ALWAYS ordered. `limit=1` with no ORDER BY lets Postgres return ANY
  // matching row, and that non-determinism is not theoretical: with four
  // pre-existing `companies` rows all named `safehttp` (duplicates created
  // before company dedup existed), consecutive identical runs resolved to
  // DIFFERENT company ids -- so the application dedup, which is scoped to
  // company_id, hit on one run and missed on the next. The symptom looked
  // like a flaky dedup; the cause was an unordered lookup.
  //
  // `created_at.asc` makes the OLDEST match canonical: stable across runs,
  // and it converges on the first row ever created rather than drifting to
  // whatever was written most recently.
  async function selectOne(table, filters, select, { order = 'created_at.asc' } = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters || {})) params.append(k, v);
    if (select) params.set('select', select);
    if (order) params.set('order', order);
    params.set('limit', '1');
    const rows = await restRequest('GET', `${table}?${params.toString()}`);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  // insertAlways -- plain POST, no ON CONFLICT clause. Used ONLY for the
  // two tables in this write-set with no real DB-level unique constraint
  // to lean on (`applications` always; `companies` when domain is null) --
  // see the honest-limitation comments at each call site in
  // applyWriteSet() below. `return=representation` so the real id comes
  // back in the same call.
  async function insertAlways(table, row, { select = 'id' } = {}) {
    const params = new URLSearchParams();
    if (select) params.set('select', select);
    const rows = await restRequest('POST', `${table}?${params.toString()}`, {
      body: row,
      prefer: 'return=representation',
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`write.js: insertAlways(${table}) returned no row`);
    }
    return rows[0];
  }

  // insertIdempotent -- design §5.0 rule 3's exact two-step pattern.
  // `conflictColumns` is a comma-separated column list matching a REAL
  // unique constraint (content_hash; kind,value; metric,founder_id,
  // company_id,observed_at). `matchFilters` is the PostgREST-filter form of
  // that SAME natural key, used ONLY for the select-back on an empty
  // response. Returns { row, created } -- `created` is false when a prior
  // run's row was found instead (idempotent no-op, exactly what a retried
  // n8n workflow needs).
  async function insertIdempotent(table, row, { conflictColumns, matchFilters, select = 'id' } = {}) {
    const params = new URLSearchParams();
    params.set('on_conflict', conflictColumns);
    if (select) params.set('select', select);
    const rows = await restRequest('POST', `${table}?${params.toString()}`, {
      body: row,
      // resolution=ignore-duplicates -- INSERT ... ON CONFLICT DO NOTHING.
      // NEVER resolution=merge-duplicates here: raw_signals/evidence carry
      // trg_*_forbid_mutation and an UPDATE-shaped upsert raises P0001
      // (design §5.0 rule 3's own opening line).
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { row: rows[0], created: true };
    }
    // Zero rows back -- the conflict fired (or, defensively, some other
    // silent reason). Select back by the natural key rather than assuming
    // which.
    const found = await selectOne(table, matchFilters, select);
    if (!found) {
      throw new Error(
        `write.js: insertIdempotent(${table}) returned zero rows and the natural-key select-back ` +
          `also found nothing -- matchFilters=${JSON.stringify(matchFilters)}`
      );
    }
    return { row: found, created: false };
  }

  return { restRequest, selectOne, insertAlways, insertIdempotent };
}

// ----------------------------------------------------------------------------
// applyWriteSet -- resolves every local ref in a lib/f02/pipeline.js
// write-set to a real uuid, in FK order, and performs the actual inserts.
// ----------------------------------------------------------------------------

async function applyWriteSet(writeSet, opts = {}) {
  const client = opts.client || makeClient(opts);
  const ids = {}; // local ref -> real uuid
  const warnings = [];
  const created = { founder: false, company: false, application: false, card: false, rawSignals: 0, claims: 0, evidence: 0, metrics: 0 };

  // ---- 1. founder, resolved via the HN identity's natural key ------------
  const hnIdentity = writeSet.identities.find((i) => i.kind === 'hn');
  if (!hnIdentity) {
    throw new Error('write.js: writeSet.identities has no kind="hn" entry (design §5.0 rule 0(b) violation upstream)');
  }
  const existingHn = await client.selectOne('founder_identities', { kind: 'eq.hn', value: `eq.${hnIdentity.value}` }, 'founder_id');

  // ---- 1a. OPT-OUT GATE (design §7 item 2) -------------------------------
  // Enforced at INGEST, before any mutation -- not merely at display time.
  // Checked against every identity in the write set, not just the HN one: a
  // founder who opted out after we linked their GitHub must stay suppressed
  // even if a later Show HN post arrives under a handle we have not seen.
  //
  // Opt-out and erasure are deliberately different operations. Opt-out sets
  // `founders.opt_out_at` and KEEPS the row as a suppression tombstone, which
  // is what makes this check possible. `purge_founder()` hard-deletes, so
  // after a true erasure the same person CAN be re-ingested by a later scan --
  // a limit design §7 states openly rather than papering over. Do not "fix"
  // that here by resurrecting rows; the honest fix is a salted-hash
  // suppression list and it is out of MVP scope.
  {
    const identityRows = [];
    for (const ident of writeSet.identities) {
      const hit = await client.selectOne(
        'founder_identities',
        { kind: `eq.${ident.kind}`, value: `eq.${ident.value}` },
        'founder_id,kind,value',
      );
      if (!hit) continue;
      const founder = await client.selectOne('founders', { id: `eq.${hit.founder_id}` }, 'id,opt_out_at');
      identityRows.push({ kind: hit.kind, value: hit.value, founder_opt_out_at: founder && founder.opt_out_at });
    }
    const optOut = isOptedOut(identityRows);
    if (optOut.blocked) {
      // Nothing is written -- not even the raw signal. The whole point is that
      // an opted-out person leaves no new trace in Memory.
      return {
        blocked: true,
        reason: 'opt_out',
        matchedIdentity: optOut.matchedIdentity,
        optedOutAt: optOut.optedOutAt,
        ids: {},
        created,
        warnings: warnings.concat(['ingest suppressed: founders.opt_out_at is set for ' +
          optOut.matchedIdentity.kind + ':' + optOut.matchedIdentity.value]),
      };
    }
  }
  let founderId;
  if (existingHn) {
    founderId = existingHn.founder_id;
  } else {
    const founderRow = await client.insertAlways('founders', { full_name: writeSet.founder.full_name }, { select: 'id' });
    founderId = founderRow.id;
    created.founder = true;
    // Two-step, defensively -- a concurrent run of the SAME candidate could
    // have won the (kind,value) race between our SELECT above and now.
    const { row: identityRow, created: identityCreated } = await client.insertIdempotent(
      'founder_identities',
      { founder_id: founderId, kind: 'hn', value: hnIdentity.value },
      { conflictColumns: 'kind,value', matchFilters: { kind: 'eq.hn', value: `eq.${hnIdentity.value}` }, select: 'founder_id' }
    );
    if (!identityCreated && identityRow.founder_id !== founderId) {
      // Lost the race: someone else's founder row is now canonical for this
      // HN handle. Use theirs, and orphan the founders row we just
      // speculatively created (RESTRICT-deleted founders are never
      // reachable from here; flagged rather than silently deleted --
      // deleting a row this function itself just created but no longer
      // needs is a cleanup nicety, not a correctness requirement, and is
      // explicitly out of scope for a single-writer MVP).
      warnings.push(`founder race: created founder ${founderId} but hn identity ${hnIdentity.value} already belonged to ${identityRow.founder_id}; using the existing founder`);
      founderId = identityRow.founder_id;
    }
  }
  ids.founder = founderId;

  // ---- GitHub identity, ONLY when the write-set says it is cross-platform
  // linked. design §4.1: "attaching an identity and merging two entities
  // are different acts" -- a conflicting pre-existing github identity
  // pointing at a DIFFERENT founder is flagged, never auto-merged.
  const ghIdentity = writeSet.identities.find((i) => i.kind === 'github');
  if (ghIdentity) {
    const { row: ghRow, created: ghCreated } = await client.insertIdempotent(
      'founder_identities',
      { founder_id: founderId, kind: 'github', value: ghIdentity.value, confidence: writeSet.decisions.identityConfidence, discovered_via: writeSet.decisions.discoveredVia },
      { conflictColumns: 'kind,value', matchFilters: { kind: 'eq.github', value: `eq.${ghIdentity.value}` }, select: 'founder_id' }
    );
    if (!ghCreated && ghRow.founder_id !== founderId) {
      warnings.push(
        `identity conflict, not merged (design §4.1): github identity ${ghIdentity.value} already belongs to founder ${ghRow.founder_id}, ` +
          `not this run's founder ${founderId}. Recorded as a warning, not auto-merged -- design requires >=0.9 confidence or manual review for that.`
      );
    }
  }

  // ---- 2. company ----------------------------------------------------------
  // vcbrain's partial unique index is `UNIQUE (domain) WHERE domain IS NOT
  // NULL` -- ON CONFLICT (domain) is a REAL, race-safe natural key ONLY
  // when domain is set, so that path stays the primary one.
  //
  // When domain is null (the majority case: github.com is always
  // generic-host-guarded to null), there is no real unique constraint to
  // lean on. FIX (coordinator instruction, 2026-07-19, "without touching
  // the schema"): `companies.normalized_name` is a GENERATED column
  // (`lower(trim(name))`, db/schema.sql) -- application-level dedup via a
  // plain SELECT-then-INSERT against it, now that pipeline.js's company-
  // name derivation (companies.name precedence fix, same date) produces a
  // STABLE name for a given candidate (the repo name / domain label)
  // instead of a Show HN headline that could vary in phrasing. This is
  // deliberately NOT the same pattern as insertIdempotent()'s ON CONFLICT
  // two-step -- Postgres cannot target ON CONFLICT at a column with no
  // real unique index/constraint backing it, only a GENERATED expression,
  // so this is check-then-create, not insert-then-select-back. That
  // leaves a genuine (small) race window between the SELECT and the
  // INSERT that a real unique constraint would close -- accepted per the
  // coordinator's explicit "do not invent a new unique index; that is a
  // schema decision for a reviewed change" ruling, and flagged via
  // warnings[] below rather than presented as equivalent to a DB
  // constraint.
  let companyId;
  if (writeSet.company.domain) {
    const { row: companyRow, created: companyCreated } = await client.insertIdempotent(
      'companies',
      { name: writeSet.company.name, domain: writeSet.company.domain, stage: writeSet.company.stage },
      { conflictColumns: 'domain', matchFilters: { domain: `eq.${writeSet.company.domain}` }, select: 'id' }
    );
    companyId = companyRow.id;
    created.company = companyCreated;
  } else {
    const normalizedName = String(writeSet.company.name || '').trim().toLowerCase();
    const existingCompany = await client.selectOne('companies', { normalized_name: `eq.${normalizedName}` }, 'id');
    if (existingCompany) {
      companyId = existingCompany.id;
      created.company = false;
    } else {
      warnings.push(
        `companies row for "${writeSet.company.name}" has no domain -- reused via application-level normalized_name dedup, ` +
          'not a schema constraint (design §5.5(a) gap, documented not hidden); a race between two concurrent runs of the ' +
          'SAME new candidate remains possible (no ON CONFLICT target exists for a GENERATED column without a real unique index)'
      );
      const companyRow = await client.insertAlways(
        'companies',
        { name: writeSet.company.name, domain: null, stage: writeSet.company.stage },
        { select: 'id' }
      );
      companyId = companyRow.id;
      created.company = true;
    }
  }
  ids.company = companyId;

  // ---- 3. application --------------------------------------------------------
  // `applications` has no unique constraint at the schema level. An earlier
  // version of this block cited 01/design.md's "re-application = new row" as
  // licence to insert unconditionally -- that was a MISREADING, and QA proved
  // its cost live (up to 10 duplicate rows for one company).
  //
  // 01's rule is about a FOUNDER genuinely re-applying: a second, later inbound
  // submission that must preserve the rejection→growth→return trajectory
  // (SIG-025). It says nothing about the radar re-scanning the SAME Show HN
  // post, which is a retry and must be a no-op — design §6.1's whole
  // idempotency stance ("a re-run of the same window is a no-op, not a
  // double-count").
  //
  // The natural key is therefore the HN item id carried in artifact_links
  // (§5.5b's shape), scoped to this company and this track. Application-level
  // dedup, like `companies` above — a real partial unique index would be the
  // schema-level answer, but `db/schema.sql` is under a three-feature combined
  // commit and adding DDL here is not this feature's call to make.
  const hnItemId = writeSet.application.artifact_links
    && writeSet.application.artifact_links.hn_item_id;
  let applicationId = null;
  if (hnItemId) {
    const existingApp = await client.selectOne(
      'applications',
      {
        company_id: `eq.${companyId}`,
        kind: `eq.${writeSet.application.kind}`,
        'artifact_links->>hn_item_id': `eq.${hnItemId}`,
      },
      'id'
    );
    if (existingApp) applicationId = existingApp.id;
  } else {
    warnings.push('application not deduplicated: artifact_links.hn_item_id absent');
  }
  if (!applicationId) {
    const applicationRow = await client.insertAlways(
      'applications',
      {
        company_id: companyId,
        kind: writeSet.application.kind,
        status: writeSet.application.status,
        artifact_links: writeSet.application.artifact_links,
      },
      { select: 'id' }
    );
    applicationId = applicationRow.id;
    created.application = true;
  }
  ids.application = applicationId;

  // ---- 4. card (design §5.0 rule 1 -- ONE per founder) ------------------
  const existingCard = await client.selectOne(
    'cards',
    { founder_id: `eq.${founderId}`, card_type: 'eq.founder' },
    'id'
  );
  let cardId;
  if (existingCard) {
    cardId = existingCard.id;
  } else {
    const cardRow = await client.insertAlways(
      'cards',
      { card_type: 'founder', founder_id: founderId, company_id: companyId, application_id: ids.application, status: 'prefilled' },
      { select: 'id' }
    );
    cardId = cardRow.id;
    created.card = true;
  }
  ids.card = cardId;

  // ---- 5. raw signals (design §5.0 rule 0(a) + §6.1) ---------------------
  for (const rs of writeSet.rawSignals) {
    const founderIdForRow = rs.founderRef ? founderId : null;
    const companyIdForRow = rs.companyRef ? companyId : null;
    if (!founderIdForRow && !companyIdForRow) {
      // Defensive re-assertion of design §5.0 rule 0(a) at the LAST point
      // before insert -- pipeline.js already asserts this at build time,
      // but a caller could in principle hand-construct a write-set that
      // skips pipeline.js entirely.
      throw new Error(`write.js: raw signal ${rs.ref} has neither founder_id nor company_id (design §5.0 rule 0(a))`);
    }
    // eslint-disable-next-line no-await-in-loop -- sequential by design:
    // later rows never depend on earlier ones here, but keeping this a
    // simple loop (not Promise.all) keeps error attribution ("which raw
    // signal failed") unambiguous, which matters more than the small
    // latency win at this row count (a handful per candidate).
    const { row, created: wasCreated } = await client.insertIdempotent(
      'raw_signals',
      {
        source: rs.source,
        source_url: rs.source_url ?? null,
        payload: rs.payload ?? {},
        content_hash: rs.content_hash,
        founder_id: founderIdForRow,
        company_id: companyIdForRow,
        observed_at: rs.observed_at,
      },
      { conflictColumns: 'content_hash', matchFilters: { content_hash: `eq.${rs.content_hash}` }, select: 'id' }
    );
    ids[rs.ref] = row.id;
    if (wasCreated) created.rawSignals += 1;
  }

  // ---- 6. claims + evidence (design §5.0 rules 1 + 2, §6.1) --------------
  for (const { claim, evidence } of writeSet.claims) {
    const rawSignalId = ids[evidence.raw_signal_ref];
    if (!rawSignalId) {
      // The same invariant pipeline.js already asserts at build time --
      // re-checked here because this is the last point before the FK
      // actually gets written, and a hand-built write-set (bypassing
      // pipeline.js) would not have had that check run at all.
      throw new Error(`write.js: claim ${claim.topic} cites raw_signal_ref ${JSON.stringify(evidence.raw_signal_ref)} which was never resolved to a real raw_signals id (design §5.0 rule 2)`);
    }

    const isMissing = evidence.tier === 'missing';
    // Missing-marker claims ARE hashed and DO go through the idempotent
    // two-step, exactly like every other claim.
    //
    // An earlier version of this block special-cased them, citing
    // db/schema.sql's note that `claims.content_hash` is nullable for a
    // "synthesized/derived missing marker claim [with] no underlying raw
    // content to hash". That reads the comment too literally: it explains why
    // the column is NULLABLE, not that a marker must be left unhashed. The
    // hash is a claim's IDENTITY, not a digest of upstream bytes -- and a
    // marker's identity, (card_id, topic, sentinel text), is perfectly stable
    // and hashable with the same formula.
    //
    // The cost of the old reading was measured: two identical passes over the
    // four fixtures drifted +4 claims and +4 evidence rows, one marker per
    // fixture, forever, on every retry. That was the ONLY remaining
    // idempotency leak after the company/application fixes, and it was being
    // carried as "the schema's documented accepted consequence" when it was
    // simply avoidable.
    let claimId;
    {
      const claimHash = await contentHash([cardId, claim.topic, claim.text_verbatim]);
      const { row: claimRow, created: claimCreated } = await client.insertIdempotent(
        'claims',
        {
          card_id: cardId,
          topic: claim.topic,
          text_verbatim: claim.text_verbatim,
          value: claim.value ?? null,
          axis: null,
          source_kind: claim.source_kind,
          base_confidence: claim.base_confidence,
          content_hash: claimHash,
        },
        { conflictColumns: 'content_hash', matchFilters: { content_hash: `eq.${claimHash}` }, select: 'id' }
      );
      claimId = claimRow.id;
      if (claimCreated) created.claims += 1;
    }
    ids[claim.ref] = claimId;

    const evidenceHash = await contentHash([claimId, evidence.relation, evidence.source_url, evidence.quote_verbatim]);
    const { created: evidenceCreated } = await client.insertIdempotent(
      'evidence',
      {
        claim_id: claimId,
        relation: evidence.relation,
        tier: evidence.tier,
        quote_verbatim: evidence.quote_verbatim ?? null,
        source_url: evidence.source_url ?? null,
        raw_signal_id: rawSignalId,
        content_hash: evidenceHash,
      },
      { conflictColumns: 'content_hash', matchFilters: { content_hash: `eq.${evidenceHash}` }, select: 'id' }
    );
    if (evidenceCreated) created.evidence += 1;
  }

  // ---- 7. metric_observations (design §6.1) -------------------------------
  for (const m of writeSet.metrics) {
    const founderIdForRow = m.founderRef ? founderId : null;
    const companyIdForRow = m.companyRef ? companyId : null;
    // eslint-disable-next-line no-await-in-loop -- see the raw_signals loop's note; same reasoning.
    const { created: metricCreated } = await client.insertIdempotent(
      'metric_observations',
      { founder_id: founderIdForRow, company_id: companyIdForRow, metric: m.metric, value: m.value, observed_at: m.observed_at },
      {
        conflictColumns: 'metric,founder_id,company_id,observed_at',
        matchFilters: {
          metric: `eq.${m.metric}`,
          founder_id: founderIdForRow ? `eq.${founderIdForRow}` : 'is.null',
          company_id: companyIdForRow ? `eq.${companyIdForRow}` : 'is.null',
          observed_at: `eq.${m.observed_at}`,
        },
        select: 'id',
      }
    );
    if (metricCreated) created.metrics += 1;
  }

  return { ids, warnings, created };
}

// ----------------------------------------------------------------------------
// events writer
// ----------------------------------------------------------------------------

// writeEvents(events, opts) -> {written}
//
// design §6.2 (run counters) and §7 item 1 (a robots skip "is recorded so it
// is visible rather than silent"). Both claims were false until this existed:
// `crawlSkippedEvent()` constructed an object that nobody persisted, and the
// `radar_scan_completed` counters had no writer at all.
//
// `events` is append-only (trg_events_forbid_mutation) and has no natural key,
// so this is a plain INSERT with no ON CONFLICT -- re-running a scan
// legitimately appends a second run record. That is the point of a run ledger;
// it is not the idempotency violation the other tables would have.
async function writeEvents(events, opts = {}) {
  const client = opts.client || makeClient(opts);
  const rows = (Array.isArray(events) ? events : []).filter(Boolean);
  if (rows.length === 0) return { written: 0 };
  for (const ev of rows) {
    await client.insertAlways('events', {
      event_type: ev.event_type,
      entity_type: ev.entity_type ?? null,
      entity_id: ev.entity_id ?? null,
      payload: ev.payload ?? {},
      actor: ev.actor ?? null,
    }, { select: 'id' });
  }
  return { written: rows.length };
}

module.exports = {
  makeClient,
  applyWriteSet,
  getSupabaseUrl,
  getServiceRoleKey,
  sbNormalize,
  writeEvents,
};
