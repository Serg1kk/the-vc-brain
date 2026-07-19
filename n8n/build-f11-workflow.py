#!/usr/bin/env python3
"""
Build feature-11 n8n workflow JSON (f11-purge, GDPR erasure) from source.

Single-purpose workflow, small enough to hand-maintain the JS inline in this generator
rather than a separate lib/f11/ + a full inline-from-tested-module pipeline (the pattern
f05/f08 use for their much larger workflow families) -- but still generated, not hand-edited,
so the JSON stays syntax-checked and reproducible. Run after any change to the JS below:

    python3 n8n/build-f11-workflow.py           # regenerate n8n/workflows/f11-purge.json
    python3 n8n/build-f11-workflow.py --check   # syntax-check every Code node, no write

Secrets: container env vars referenced only via $env.* (SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY) -- never literals -- so the exported JSON is safe to commit,
same convention as every other feature's workflow.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'workflows', 'f11-purge.json')

WORKFLOW_ID = 'f11PurgeGdprErasure01'  # placeholder id used only for standalone-import re-creation


def nid(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def code_node(name, js, x, y, mode='runOnceForAllItems'):
    return {
        'parameters': {'mode': mode, 'jsCode': js},
        'id': nid(name), 'name': name, 'type': 'n8n-nodes-base.code',
        'typeVersion': 2, 'position': [x, y],
    }


def if_node(name, expr, x, y):
    return {
        'parameters': {
            'conditions': {
                'options': {'caseSensitive': True, 'leftValue': '', 'typeValidation': 'loose'},
                'conditions': [{
                    'id': str(uuid.uuid4()),
                    'leftValue': '={{ ' + expr + ' }}',
                    'rightValue': True,
                    'operator': {'type': 'boolean', 'operation': 'equals'},
                }],
                'combinator': 'and',
            },
            'options': {},
        },
        'id': nid(name), 'name': name, 'type': 'n8n-nodes-base.if',
        'typeVersion': 2, 'position': [x, y],
    }


def respond_node(name, code, x, y):
    return {
        'parameters': {'respondWith': 'firstIncomingItem', 'options': {'responseCode': code}},
        'id': nid(name), 'name': name, 'type': 'n8n-nodes-base.respondToWebhook',
        'typeVersion': 1.1, 'position': [x, y],
    }


# ============================================================================
# JS bodies
# ============================================================================

VALIDATE_INPUT_JS = r"""
// SOURCE OF TRUTH: n8n/build-f11-workflow.py (VALIDATE_INPUT_JS)
//
// f11-purge (docs/backlog/11-demo-data-ethics/README.md §3, GDPR delete-on-request):
// this is a destructive, irreversible endpoint, so the only acceptable input is an explicit,
// unambiguous person id. No wildcards, no "purge all", no default-to-delete on a missing field
// -- reject anything that is not a single well-formed UUID string.

const item = $input.first().json;
const body = item.body || {};

function fail(code, message) {
  return { __valid: false, error: { code, message } };
}

const raw = body.founder_id;
if (typeof raw !== 'string' || raw.trim().length === 0) {
  return [{ json: fail(
    'invalid_input',
    'founder_id is required and must be a non-empty string. This endpoint erases exactly one person; there is no bulk or wildcard form.'
  ) }];
}
const founderId = raw.trim();
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
if (!UUID_RE.test(founderId)) {
  return [{ json: fail('invalid_input', 'founder_id must be a well-formed UUID.') }];
}
return [{ json: { __valid: true, founder_id: founderId } }];
"""

BUILD_ERROR_JS = r"""
const err = $json.error || { code: 'internal_error', message: 'Something went wrong on our side.' };
return [{ json: { error: { code: err.code, message: err.message } } }];
"""

RESOLVE_SCOPE_JS = r"""
// SOURCE OF TRUTH: n8n/build-f11-workflow.py (RESOLVE_SCOPE_JS)
//
// Read-only pass: resolves exactly the scope db/schema.sql's purge_founder() will act on --
// this founder plus any duplicate tombstones merged into it (design.md R3), and every
// sole-founder company/application reachable from that person set (a multi-founder company's
// shared data is never touched by one co-founder's erasure request, same rule purge_founder()
// itself applies) -- and captures the PRIMARY KEY id of every row currently in scope, table by
// table. This is the "before" half of the verifiable receipt: the next node re-checks these
// EXACT ids after calling purge_founder(), rather than re-deriving scope through founder_id
// filters that would trivially (and misleadingly) return empty once the founder row is gone.
//
// Also captures events(entity_type='application') for this person's own applications -- NOT
// part of purge_founder()'s current delete scope (docs/backlog/TRACKER.md, ~11:40 and ~12:45
// entries: it only clears entity_type='founder'). Captured here regardless of whether a schema
// fix has landed by the time this runs -- the after-check in the next node reports the outcome
// honestly either way, rather than assuming success.

const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;

async function pg(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const opts = { method, url: SB + '/rest/v1/' + path, headers, json: true };
  if (body !== undefined) opts.body = body;
  return await this.helpers.httpRequest(opts);
}
async function pgGet(path) { return await pg.call(this, 'GET', path); }

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Rows for `column IN (values)`, chunked to keep query strings bounded.
async function selectWhereIn(table, column, values, select) {
  if (!values || values.length === 0) return [];
  const sel = select || 'id';
  let out = [];
  for (const part of chunkArr(values, 150)) {
    const rows = await pgGet.call(this, table + '?select=' + sel + '&' + column + '=in.(' + part.join(',') + ')');
    out = out.concat(rows);
  }
  return out;
}

// Rows matching ANY of several `col IN (values)` fragments (skips empty fragments),
// de-duplicated by id -- a row can legitimately match more than one fragment (e.g. a card
// carrying both founder_id AND application_id inside scope).
async function selectWhereAnyIn(table, colValuePairs, select) {
  const sel = select || 'id';
  const seen = new Map();
  for (const [col, values] of colValuePairs) {
    if (!values || values.length === 0) continue;
    for (const part of chunkArr(values, 150)) {
      const rows = await pgGet.call(this, table + '?select=' + sel + '&' + col + '=in.(' + part.join(',') + ')');
      for (const r of rows) seen.set(r.id, r);
    }
  }
  return Array.from(seen.values());
}

async function eventsWhere(entityType, ids) {
  if (!ids || ids.length === 0) return [];
  let out = [];
  for (const part of chunkArr(ids, 150)) {
    const rows = await pgGet.call(this, 'events?select=id&entity_type=eq.' + entityType + '&entity_id=in.(' + part.join(',') + ')');
    out = out.concat(rows);
  }
  return out;
}

const founderId = $json.founder_id;

// ---- Load the founder itself ----
const founderRows = await pgGet.call(this, 'founders?select=id,full_name,is_synthetic,merged_into_founder_id&id=eq.' + founderId);
if (!founderRows || founderRows.length === 0) {
  return [{ json: { ok: false, error: { code: 'not_found', message: 'No founder found for the given id.' } } }];
}
const founder = founderRows[0];

// ---- Person set: this founder + any duplicate tombstones merged into it ----
const tombstones = await pgGet.call(this, 'founders?select=id&merged_into_founder_id=eq.' + founderId);
const personIds = [founderId, ...tombstones.map((r) => r.id)];

// ---- Sole-founder companies ----
const fcForPerson = await selectWhereIn.call(this, 'founder_company', 'founder_id', personIds, 'id,founder_id,company_id');
const candidateCompanyIds = Array.from(new Set(fcForPerson.map((r) => r.company_id)));
const fcForCompanies = await selectWhereIn.call(this, 'founder_company', 'company_id', candidateCompanyIds, 'founder_id,company_id');
const foundersByCompany = new Map();
for (const r of fcForCompanies) {
  if (!foundersByCompany.has(r.company_id)) foundersByCompany.set(r.company_id, []);
  foundersByCompany.get(r.company_id).push(r.founder_id);
}
const personSet = new Set(personIds);
const soleCompanyIds = candidateCompanyIds.filter((cid) =>
  (foundersByCompany.get(cid) || []).every((fid) => personSet.has(fid))
);

// ---- Applications under those sole-founder companies ----
const soleApps = await selectWhereIn.call(this, 'applications', 'company_id', soleCompanyIds, 'id,deck_storage_path,kind');
const soleAppIds = soleApps.map((a) => a.id);
const deckPaths = soleApps.filter((a) => a.deck_storage_path).map((a) => a.deck_storage_path);

// ---- Cards in scope: founder-direct OR sole-company OR sole-application ----
const cards = await selectWhereAnyIn.call(this, 'cards', [
  ['founder_id', personIds],
  ['company_id', soleCompanyIds],
  ['application_id', soleAppIds],
]);
const cardIds = cards.map((c) => c.id);

const claims = await selectWhereIn.call(this, 'claims', 'card_id', cardIds);
const claimIds = claims.map((c) => c.id);
const evidence = await selectWhereIn.call(this, 'evidence', 'claim_id', claimIds);

const scores = await selectWhereAnyIn.call(this, 'scores', [
  ['founder_id', personIds],
  ['application_id', soleAppIds],
]);
const scoreIds = scores.map((s) => s.id);
const scoreComponents = await selectWhereAnyIn.call(this, 'score_components', [
  ['founder_id', personIds],
  ['score_id', scoreIds],
]);

const aiRuns = await selectWhereAnyIn.call(this, 'ai_runs', [
  ['founder_id', personIds],
  ['application_id', soleAppIds],
  ['company_id', soleCompanyIds],
]);
const rawSignals = await selectWhereAnyIn.call(this, 'raw_signals', [
  ['founder_id', personIds],
  ['company_id', soleCompanyIds],
]);
const metricObservations = await selectWhereAnyIn.call(this, 'metric_observations', [
  ['founder_id', personIds],
  ['company_id', soleCompanyIds],
]);
const watchlist = await selectWhereAnyIn.call(this, 'watchlist', [
  ['founder_id', personIds],
  ['company_id', soleCompanyIds],
]);

const interviews = await selectWhereAnyIn.call(this, 'interviews', [
  ['application_id', soleAppIds],
  ['card_id', cardIds],
]);
const interviewIds = interviews.map((i) => i.id);
const voiceArtifacts = await selectWhereIn.call(this, 'voice_artifacts', 'interview_id', interviewIds);

const memos = await selectWhereIn.call(this, 'memos', 'application_id', soleAppIds);
const thesisEvaluations = await selectWhereIn.call(this, 'thesis_evaluations', 'application_id', soleAppIds);

const founderRowsAll = await selectWhereIn.call(this, 'founders', 'id', personIds);
const founderIdentities = await selectWhereIn.call(this, 'founder_identities', 'founder_id', personIds);
const companiesRows = await selectWhereIn.call(this, 'companies', 'id', soleCompanyIds);

const eventsFounder = await eventsWhere.call(this, 'founder', personIds);
const eventsApplication = await eventsWhere.call(this, 'application', soleAppIds);

const before = {
  founders: founderRowsAll.map((r) => r.id),
  founder_identities: founderIdentities.map((r) => r.id),
  founder_company: fcForPerson.map((r) => r.id),
  companies: companiesRows.map((r) => r.id),
  applications: soleAppIds,
  cards: cardIds,
  claims: claimIds,
  evidence: evidence.map((r) => r.id),
  scores: scoreIds,
  score_components: scoreComponents.map((r) => r.id),
  ai_runs: aiRuns.map((r) => r.id),
  raw_signals: rawSignals.map((r) => r.id),
  metric_observations: metricObservations.map((r) => r.id),
  watchlist: watchlist.map((r) => r.id),
  interviews: interviewIds,
  voice_artifacts: voiceArtifacts.map((r) => r.id),
  memos: memos.map((r) => r.id),
  thesis_evaluations: thesisEvaluations.map((r) => r.id),
  events_founder: eventsFounder.map((r) => r.id),
  events_application: eventsApplication.map((r) => r.id),
};

return [{
  json: {
    ok: true,
    founder_id: founderId,
    founder_full_name: founder.full_name,
    founder_is_synthetic: founder.is_synthetic,
    deck_storage_paths: deckPaths,
    before,
  },
}];
"""

EXECUTE_PURGE_JS = r"""
// SOURCE OF TRUTH: n8n/build-f11-workflow.py (EXECUTE_PURGE_JS)
//
// Calls the ONLY deletion door (db/schema.sql, purge_founder()) -- never reimplements erasure
// here -- then a best-effort Storage cleanup for any deck file this person's own applications
// carried, then re-checks EVERY id the previous node captured before the call to build a
// verifiable receipt: what was actually deleted, what survived, and why. A response is never
// built from the RPC's own "success" status alone (that lesson is recorded twice in
// docs/backlog/TRACKER.md -- a green n8n execution has been shown to hide a branch that never
// ran) -- every count below is a real re-read of the database taken after the call.

const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;

async function pg(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const opts = { method, url: SB + '/rest/v1/' + path, headers, json: true };
  if (body !== undefined) opts.body = body;
  return await this.helpers.httpRequest(opts);
}
async function pgGet(path) { return await pg.call(this, 'GET', path); }

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function survivors(table, ids) {
  if (!ids || ids.length === 0) return [];
  let out = [];
  for (const part of chunkArr(ids, 150)) {
    const rows = await pgGet.call(this, table + '?select=id&id=in.(' + part.join(',') + ')');
    out = out.concat(rows.map((r) => r.id));
  }
  return out;
}

const founderId = $json.founder_id;
const before = $json.before;
const deckPaths = $json.deck_storage_paths || [];

// ---- Call the ONLY deletion door ----
try {
  await pg.call(this, 'POST', 'rpc/purge_founder', { p_founder_id: founderId });
} catch (e) {
  console.log('purge_founder RPC failed: ' + (e && e.message ? e.message : String(e)));
  return [{
    json: {
      ok: false,
      error: {
        code: 'purge_failed',
        message: 'The erasure could not be completed. purge_founder() raised an error and the transaction was rolled back, so no data for this founder was deleted.',
      },
    },
  }];
}

// ---- Best-effort Storage cleanup ----
// Known gap (docs/backlog/TRACKER.md, 08's ~12:45 entry): purge_founder() clears database rows
// only, never Storage objects, so an uploaded deck otherwise survives its own applications row.
// Best-effort and non-blocking -- a missing bucket/object is reported honestly, never swallowed.
const storageAttempts = [];
for (const path of deckPaths) {
  try {
    await this.helpers.httpRequest({
      method: 'DELETE',
      url: SB + '/storage/v1/object/decks/' + path.split('/').map(encodeURIComponent).join('/'),
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY },
    });
    storageAttempts.push({ path, deleted: true });
  } catch (e) {
    storageAttempts.push({ path, deleted: false, reason: 'delete_failed' });
  }
}

// ---- Verify: re-check every id captured before the purge ----
const TABLE_FOR = {
  founders: 'founders', founder_identities: 'founder_identities', founder_company: 'founder_company',
  companies: 'companies', applications: 'applications', cards: 'cards', claims: 'claims',
  evidence: 'evidence', scores: 'scores', score_components: 'score_components', ai_runs: 'ai_runs',
  raw_signals: 'raw_signals', metric_observations: 'metric_observations', watchlist: 'watchlist',
  interviews: 'interviews', voice_artifacts: 'voice_artifacts', memos: 'memos',
  thesis_evaluations: 'thesis_evaluations', events_founder: 'events', events_application: 'events',
};

const RETENTION_REASONS = {
  events_application:
    "purge_founder() currently clears audit events only where entity_type='founder'. These rows " +
    "were written with entity_type='application' by feature 05's claim-verification and " +
    "contradiction-scan pipeline (company-only cards, or application-scoped contradictions) and " +
    "are not yet reachable by erasure. Extending purge_founder() to also clear " +
    "entity_type='application' events for this founder's own applications has been proposed to " +
    "the schema owner; this receipt reports the gap honestly rather than claiming a complete erasure.",
};

const tables = {};
const retained = [];
let allClear = true;
for (const key of Object.keys(TABLE_FOR)) {
  const beforeIds = before[key] || [];
  const afterIds = await survivors.call(this, TABLE_FOR[key], beforeIds);
  const entry = { before: beforeIds.length, deleted: beforeIds.length - afterIds.length, retained: afterIds.length };
  if (afterIds.length > 0) {
    allClear = false;
    entry.reason = RETENTION_REASONS[key] ||
      'These rows unexpectedly survived erasure. Reported honestly rather than hidden -- this indicates a gap in purge_founder() not yet accounted for by this workflow.';
    retained.push({ table: key, count: afterIds.length, reason: entry.reason });
  }
  tables[key] = entry;
}

// The one anonymized audit row purge_founder() itself writes.
let auditEvent = null;
try {
  const rows = await pgGet.call(this,
    'events?select=id,event_type,created_at&event_type=eq.founder_purged&entity_type=eq.founder&entity_id=eq.' + founderId +
    '&order=created_at.desc&limit=1');
  if (rows && rows[0]) auditEvent = rows[0];
} catch (e) { /* non-fatal -- the receipt stands on the table counts, not on this lookup */ }

const storageComplete = storageAttempts.every((s) => s.deleted);

return [{
  json: {
    ok: true,
    founder_id: founderId,
    purged_at: new Date().toISOString(),
    complete: allClear && storageComplete,
    audit_event: auditEvent,
    tables,
    storage: {
      attempted: deckPaths.length,
      deleted: storageAttempts.filter((s) => s.deleted).length,
      failed: storageAttempts.filter((s) => !s.deleted),
    },
    retained,
  },
}];
"""


def build():
    x0 = -1600
    y = 0
    col = 240

    nodes = []
    conns = {}

    def add(node):
        nodes.append(node)
        return node['name']

    def wire(src, dst, src_out=0):
        conns.setdefault(src, {'main': []})
        while len(conns[src]['main']) <= src_out:
            conns[src]['main'].append([])
        conns[src]['main'][src_out].append({'node': dst, 'type': 'main', 'index': 0})

    webhook = add({
        'parameters': {'httpMethod': 'POST', 'path': 'f11-purge', 'responseMode': 'responseNode', 'options': {}},
        'id': nid('Webhook: f11-purge'), 'name': 'Webhook: f11-purge', 'type': 'n8n-nodes-base.webhook',
        'typeVersion': 2.1, 'position': [x0, y],
    })

    validate = add(code_node('Validate input', VALIDATE_INPUT_JS, x0 + col, y))
    wire(webhook, validate)

    if_valid = add(if_node('IF: valid?', '$json.__valid', x0 + col * 2, y))
    wire(validate, if_valid)

    build_400 = add(code_node('Build validation error response', BUILD_ERROR_JS, x0 + col * 3, y + 220))
    wire(if_valid, build_400, src_out=1)
    respond_400 = add(respond_node('Respond: bad request (400)', 400, x0 + col * 4, y + 220))
    wire(build_400, respond_400)

    resolve = add(code_node('Resolve founder + capture pre-purge state', RESOLVE_SCOPE_JS, x0 + col * 3, y))
    wire(if_valid, resolve, src_out=0)

    if_found = add(if_node('IF: found?', '$json.ok', x0 + col * 4, y))
    wire(resolve, if_found)

    build_404 = add(code_node('Build not-found error response', BUILD_ERROR_JS, x0 + col * 5, y + 220))
    wire(if_found, build_404, src_out=1)
    respond_404 = add(respond_node('Respond: not found (404)', 404, x0 + col * 6, y + 220))
    wire(build_404, respond_404)

    execute = add(code_node('Execute purge + build receipt', EXECUTE_PURGE_JS, x0 + col * 5, y))
    wire(if_found, execute, src_out=0)

    if_ok = add(if_node('IF: purge ok?', '$json.ok', x0 + col * 6, y))
    wire(execute, if_ok)

    build_500 = add(code_node('Build purge-failed error response', BUILD_ERROR_JS, x0 + col * 7, y + 220))
    wire(if_ok, build_500, src_out=1)
    respond_500 = add(respond_node('Respond: internal error (500)', 500, x0 + col * 8, y + 220))
    wire(build_500, respond_500)

    respond_200 = add(respond_node('Respond: success', 200, x0 + col * 7, y))
    wire(if_ok, respond_200, src_out=0)

    workflow = {
        'name': 'f11-purge',
        'nodes': nodes,
        'connections': conns,
        'active': False,
        'settings': {'executionOrder': 'v1', 'saveManualExecutions': True, 'timezone': 'UTC'},
        'pinData': {},
        'tags': [],
        'versionId': str(uuid.uuid4()),
        'meta': {'templateCredsSetupCompleted': True},
    }
    return workflow


def check_syntax(workflow):
    ok = True
    for n in workflow['nodes']:
        if n['type'] != 'n8n-nodes-base.code':
            continue
        js = n['parameters']['jsCode']
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            # Wrap in an async IIFE so top-level `await` (used throughout) parses under `node -c`.
            f.write('(async function(){\n' + js + '\n})();')
            path = f.name
        try:
            subprocess.run(['node', '-c', path], check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as e:
            ok = False
            print('SYNTAX ERROR in node %r:\n%s' % (n['name'], e.stderr), file=sys.stderr)
        finally:
            os.unlink(path)
    return ok


if __name__ == '__main__':
    wf = build()
    check_only = '--check' in sys.argv
    syntax_ok = check_syntax(wf)
    if not syntax_ok:
        sys.exit(1)
    if check_only:
        print('OK: %d nodes, all Code nodes syntax-checked clean.' % len(wf['nodes']))
        sys.exit(0)
    with open(OUT, 'w') as f:
        json.dump(wf, f, indent=2)
        f.write('\n')
    print('Wrote %s (%d nodes)' % (OUT, len(wf['nodes'])))
