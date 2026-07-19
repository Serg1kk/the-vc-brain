# Feature 11 workflow — `f11-purge` (GDPR erasure / delete-on-request)

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f11-workflow.py           # regenerate + syntax-check f11-purge.json
python3 n8n/build-f11-workflow.py --check   # check only, no write
```

Unlike f05/f08, this feature is a single small workflow, so the JS lives inline in the
generator script itself rather than a separate `lib/f11/` module family — but it is still
generated and syntax-checked, never hand-edited in the JSON, for the same reason: a pasted
Code node drifts silently from its source the first time either changes.

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f11-purge` | `I0b5WUnb76M2bD16` | 14 | Given `{ founder_id }`: validates the id, resolves erasure scope, calls `purge_founder()` (the one deletion door — `db/schema.sql`), best-effort deletes any deck file in Storage, re-verifies every row it captured before the call, and returns a verifiable receipt. |

Entry point: `POST /webhook/f11-purge` with `{ "founder_id": "<uuid>" }`.

## Why this reuses `purge_founder()` rather than reimplementing erasure

`db/schema.sql`'s `purge_founder(p_founder_id uuid)` is the **only** place in this schema
allowed to delete from the append-only tables (`scores`, `raw_signals`, `evidence`, `ai_runs`,
`events`, `memos`, `score_components`, `thesis_evaluations` — `forbid_mutation()` rejects
`UPDATE`/`DELETE` on all of them from any other caller, including a forged `vcbrain.purging`
GUC from a non-`postgres` session). It already implements the sole-founder-company scoping
rule (a multi-founder company's shared data is never touched by one co-founder's request), the
tombstone-merge rule (R3 — duplicate founders folded into one erasure), and the full FK-safe
delete ordering (interviews before cards, `thesis_evaluations` before scores, evidence→claims→
cards before raw_signals, …), fixed live more than once during this project (`docs/backlog/
TRACKER.md`, ~12:35 entry — the interviews/cards ordering bug that broke erasure for every
inbound applicant until it was found). Reimplementing any of that in a Code node would be a
second copy of load-bearing logic with no way to stay in sync with the first. This workflow
calls the RPC and nothing else touches a row directly — it only **reads**, before and after.

## Topology

```
Webhook
  -> Validate input                         (§ founder_id must be a well-formed UUID; no
  -> IF: valid?                                wildcards, no missing-field default)
       false -> Build validation error response -> Respond 400
       true  -> Resolve founder + capture pre-purge state
                  (read-only: resolves person_ids incl. merged-duplicate tombstones,
                   sole-founder companies/applications, and captures the PRIMARY KEY id
                   of every row in scope, across 20 tables/categories)
                -> IF: found?
                     false -> Build not-found error response -> Respond 404
                     true  -> Execute purge + build receipt
                                (POST /rpc/purge_founder, best-effort Storage cleanup,
                                 then re-checks every captured id -- never trusts the
                                 RPC's own "success" status alone)
                              -> IF: purge ok?
                                   false -> Build purge-failed error response -> Respond 500
                                   true  -> Respond 200 (the receipt)
```

**Why capture ids before, and re-check exactly those ids after, rather than re-deriving scope
post-purge:** once `purge_founder()` returns, the founder row (and everything under it) is
gone, so a `founder_id=eq.<id>` filter would trivially — and misleadingly — return empty
whether or not the underlying rows were actually removed. Capturing the primary-key id of every
row in scope *before* the call and checking survival of those *exact* ids afterward is the only
way the receipt is evidence rather than an assumption. This is the same standard the team
applied when verifying this workflow by hand (see below): *"A green response from the workflow
is not evidence; the empty result set is."*

## Request

```json
POST /webhook/f11-purge
{ "founder_id": "3fae2b1c-...-uuid" }
```

`founder_id` is the only accepted field. It must be a single, well-formed UUID string — no
arrays, no `"all"`, no `"*"`, no default when the field is missing. This is a destructive,
irreversible operation on exactly one identified person.

## Response — success (200)

```jsonc
{
  "ok": true,
  "founder_id": "3fae2b1c-...",
  "purged_at": "2026-07-19T09:52:37.536Z",
  "complete": false,                  // true only if EVERY captured row was actually removed
  "audit_event": {                    // the one anonymized row purge_founder() itself writes
    "id": "bacb7aab-...",
    "event_type": "founder_purged",
    "created_at": "2026-07-19T09:52:37.438656+00:00"
  },
  "tables": {
    "founders":             { "before": 1, "deleted": 1, "retained": 0 },
    "founder_identities":   { "before": 2, "deleted": 2, "retained": 0 },
    "founder_company":      { "before": 1, "deleted": 1, "retained": 0 },
    "companies":            { "before": 1, "deleted": 1, "retained": 0 },
    "applications":         { "before": 1, "deleted": 1, "retained": 0 },
    "cards":                { "before": 1, "deleted": 1, "retained": 0 },
    "claims":               { "before": 2, "deleted": 2, "retained": 0 },
    "evidence":             { "before": 2, "deleted": 2, "retained": 0 },
    "scores":               { "before": 1, "deleted": 1, "retained": 0 },
    "score_components":     { "before": 1, "deleted": 1, "retained": 0 },
    "ai_runs":               { "before": 1, "deleted": 1, "retained": 0 },
    "raw_signals":          { "before": 1, "deleted": 1, "retained": 0 },
    "metric_observations":  { "before": 1, "deleted": 1, "retained": 0 },
    "watchlist":            { "before": 1, "deleted": 1, "retained": 0 },
    "interviews":           { "before": 1, "deleted": 1, "retained": 0 },
    "voice_artifacts":      { "before": 1, "deleted": 1, "retained": 0 },
    "memos":                { "before": 1, "deleted": 1, "retained": 0 },
    "thesis_evaluations":   { "before": 1, "deleted": 1, "retained": 0 },
    "events_founder":       { "before": 1, "deleted": 1, "retained": 0 },
    "events_application":   { "before": 2, "deleted": 0, "retained": 2,
      "reason": "purge_founder() currently clears audit events only where entity_type='founder'. These rows were written with entity_type='application' by feature 05's claim-verification and contradiction-scan pipeline (company-only cards, or application-scoped contradictions) and are not yet reachable by erasure. Extending purge_founder() to also clear entity_type='application' events for this founder's own applications has been proposed to the schema owner; this receipt reports the gap honestly rather than claiming a complete erasure." }
  },
  "storage": { "attempted": 1, "deleted": 1, "failed": [] },
  "retained": [
    { "table": "events_application", "count": 2, "reason": "<same text as above>" }
  ]
}
```

**How the UI should render this:** `complete` is the single boolean to gate the confirmation
copy on. If `false`, show the `retained` array's reasons verbatim — do not round `complete:
false` up to a success message. `tables` is the full per-table breakdown for an expandable
"details" affordance; `retained` is the same information pre-filtered to only the rows that
need a user-facing callout.

## Response — error (400 / 404 / 500)

Exact shape, matching feature 08's §4.5 convention:

```json
{ "error": { "code": "invalid_input", "message": "founder_id is required and must be a non-empty string. This endpoint erases exactly one person; there is no bulk or wildcard form." } }
```

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `invalid_input` | `founder_id` missing, empty, non-string, or not a well-formed UUID |
| 404 | `not_found` | No `founders` row exists for that id (already erased, or never existed) |
| 500 | `purge_failed` | `purge_founder()` itself raised — the RPC's exception rolls back its whole transaction, so a 500 here means **nothing was deleted**, not a partial erasure |

Never a stack trace, never a raw Postgres error string, in any of the three.

## The known defect: ~events rows unreachable by `purge_founder()`

**Confirmed live against the shared demo database at investigation time (2026-07-19):** 909
`events` rows carry `entity_type='application'` (`claim_verification_attempted` 868,
`thesis_gate_insufficient_evidence` 27, `trust_rollup_insufficient_evidence` 8,
`claim_contradicted` 2, `claim_verified` 2, plus 2 unrelated). `purge_founder()` (`db/
schema.sql`) deletes from `events` only `WHERE entity_type = 'founder'`
(`docs/backlog/TRACKER.md`'s own ~11:40 entry recorded this at ~190 rows earlier in the day;
the pipelines that write them — `f05-verify-claims`, `f05-contradiction-scan` — have run
substantially more since). 909 of 910 `entity_type='application'` rows resolve to a real,
live `applications.id` (one orphan, unrelated to this defect).

**Decision: extend the purge (option a), not just report the gap (option b) — but ship
both, because I cannot land the schema change myself.** `db/schema.sql` is owned by another
agent this session; I am not editing it. The SQL below is the exact, minimal fix, handed to
the team lead to route:

```sql
-- Replace the existing line (db/schema.sql, purge_founder(), the founder-scope events sweep,
-- immediately before the founder_identities/founders deletes):
--   DELETE FROM events WHERE entity_type = 'founder' AND entity_id = ANY(v_person_ids);
-- with:
DELETE FROM events
 WHERE (entity_type = 'founder' AND entity_id = ANY(v_person_ids))
    OR (entity_type = 'application' AND entity_id = ANY(v_sole_app_ids));
```

Rationale for scoping the second clause to `v_sole_app_ids` (not every application referencing
this founder anywhere): it is the exact same "sole ownership" boundary `purge_founder()`
already applies to every other company/application-scoped delete in the function (companies,
raw_signals, memos, thesis_evaluations, …) — a multi-founder company's shared application
events stay intact for the co-founder who did not request erasure, consistent with the rest of
the function's own stated design. `v_sole_app_ids` is already computed earlier in the function
body (used by the `interviews`/`memos`/`scores`/`ai_runs`/`thesis_evaluations` sweeps), so no
new variable or ordering constraint is introduced — this is a pure `WHERE`-clause extension of
an existing statement, and `entity_id` on `events` carries no FK, so there is no delete-order
hazard to reason about (confirmed against the function's own DEFERRABLE-FK commentary).

**Until that lands, this workflow does not overclaim.** It reports `entity_type='application'`
events it captured before the call and re-checks after; if they survive (which they will, on
the current unpatched function), the response says so explicitly, per-row-count, with the exact
reason, and `complete: false`. If the fix above lands, the exact same code re-checks the exact
same ids and will report `retained: 0` / `complete: true` on the next call, with no workflow
change required — the receipt is generated by re-reading the database, not by assuming a
schema version.

## Storage cleanup (bonus, not in the original defect list)

`purge_founder()` never touches Supabase Storage — `docs/backlog/TRACKER.md`'s 08 ~12:45 entry
already flagged this: an uploaded deck survives its own `applications` row once that row is
gone, becoming both undeleted and unfindable. Since "prove it deleted" was the standard for
this whole feature, the workflow also best-effort deletes any `deck_storage_path` it captured
(`DELETE /storage/v1/object/decks/<path>`), non-blocking — a missing bucket/object is reported
in `storage.failed`, never silently swallowed, and never fails the overall request (a missing
deck file is not a reason to fail an otherwise-successful database erasure).

## Verified live (2026-07-19) — throwaway synthetic founder, not one of the 10 demo fixtures

Fixture: founder `22220000-0000-0000-0000-000000000001` ("ZZZ PURGE TEST DELETE ME",
`is_synthetic=true`), with one row in every table `purge_founder()` touches — `founder_identities`
(2), `founder_company`, `companies`, `applications` (inbound, real deck uploaded to Storage),
`cards`, `claims` (2), `evidence` (2), `scores`, `score_components`, `ai_runs`, `raw_signals`,
`metric_observations`, `watchlist`, `interviews`, `voice_artifacts`, `memos`,
`thesis_evaluations`, one `events` row at `entity_type='founder'`, and two `events` rows at
`entity_type='application'` simulating the defect (`claim_verification_attempted`,
`claim_contradicted`, matching what `f05-verify-claims`/`f05-contradiction-scan` actually write).

**Before (independent `psql`, not the workflow's own count) — every table 1–2 rows present,
Storage object present (`HTTP 200`).**

**Called `POST /webhook/f11-purge {"founder_id":"22220000-...-000000000001"}` once.**

**After (independent `psql` re-query by primary-key id, not by re-deriving scope through the
now-deleted founder) — 19 of 20 tables at exactly 0 rows:** `founders`, `founder_identities`,
`founder_company`, `companies`, `applications`, `cards`, `claims`, `evidence`, `scores`,
`score_components`, `ai_runs`, `raw_signals`, `metric_observations`, `watchlist`, `interviews`,
`voice_artifacts`, `memos`, `thesis_evaluations`, `events` (old founder-scope row — replaced by
exactly **one** new anonymized `founder_purged` audit row, no PII in its payload). The Storage
object: `GET /storage/v1/object/info/decks/...` → `404 not_found`, and a bucket listing of the
`zzz-purge-test/` prefix returned `[]` — genuinely deleted, not merely unlinked.

**The one table that did NOT reach zero, exactly as predicted:** `events` at
`entity_type='application'` — 2 rows before, 2 rows after, matching the workflow's own receipt
exactly. This is the live reproduction of the defect above, not a workflow bug.

**Failure path, also verified live, no data touched:**
- Missing `founder_id` → `400 invalid_input`.
- `founder_id: "*"` / `"all"` → `400 invalid_input` (rejected by the UUID-shape check — no
  wildcard or bulk form is reachable).
- Well-formed but nonexistent UUID (`00000000-0000-0000-0000-000000000000`) → `404 not_found`.

**The ten demo-fixture founders (`11f0…` id range) were confirmed present and untouched**
before and after this test (`count = 10` both times) — this workflow was never pointed at them.

The two leftover `entity_type='application'` events and the throwaway founder's own audit event
were removed afterward as a courtesy (the same `vcbrain.purging` bypass `purge_founder()` uses
internally, run once by hand as `postgres` in a single transaction) so no test debris was left
in the shared demo database; this cleanup is not part of the workflow and is not repeatable
through the API.

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals — safe to commit.
Values live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
`$env.SUPABASE_URL` is normalized defensively in every node
(`String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '')`) per the project-wide drift
warning in `docs/backlog/TRACKER.md`.

## Re-deploying after a change

```bash
python3 n8n/build-f11-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "import json; wf=json.load(open('n8n/workflows/f11-purge.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f11_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/I0b5WUnb76M2bD16" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f11_put_body.json
```
