# Feature 01 — Memory & Data Model: Adversarial QA Report (Task 12)

> Independent pass, NOT reusing `db/tests/smoke.sql`. Every fixture below was created fresh by
> this QA pass (tagged `is_synthetic = true`, `qa_tag = 'qa-gate-12'` / `qa_test_kind` identity
> kind), attacked directly via `psql` and via PostgREST (Kong on `:8000`), then cleaned up either
> through `purge_founder()` (founder-linked rows) or via an outer `ROLLBACK` (disposable non-founder
> rows). A final full-table sweep (§7) confirms the database is clean except for the one
> permanent, anonymized `founder_purged` audit row this pass is entitled to leave behind.
>
> Environment: self-hosted Supabase (Postgres 17.6) via Supavisor pooler at `localhost:54322`
> (psql) and Kong at `http://localhost:8000/rest/v1/` (REST). Credentials read from
> `infra/supabase/.env` and used only as shell environment variables — never printed. All
> connection strings, keys, and passwords below are redacted (`<REDACTED>`).

## Verdict

**GATE PASSED.** (Originally filed as GATE FAILED — 1 MAJOR finding; the finding was fixed and
independently re-verified — see §10 "Resolution" at the end of this report. The finding text
below is kept as originally written, for history.)

**Original verdict at time of filing: GATE FAILED — 1 MAJOR finding.**

Every invariant attack explicitly listed in `plan.md` Task 12 (bullets 1–8) is rejected by the
database exactly as designed — append-only UPDATE/DELETE, the purge-bypass forgery, the memo
section CHECK, the duplicate-identity UNIQUE, and `purge_founder()`'s exhaustive cascade all
hold under direct SQL and under PostgREST with the `service_role` key. The non-collapse
guarantee is honestly convention-level as the design document itself states (§8 below).

However, one real, working bypass of the append-only invariant was found and is not covered by
anything in `db/tests/smoke.sql` or `plan.md`'s attack list: **`TRUNCATE` is not intercepted by
`forbid_mutation()`** (`BEFORE UPDATE OR DELETE` triggers do not fire on `TRUNCATE` in Postgres),
and **`service_role` holds the `TRUNCATE` privilege on all six append-only tables** (`scores`,
`raw_signals`, `evidence`, `ai_runs`, `events`, `memos`) — this is Supabase's default
`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role` provisioning, not something Task 9
added deliberately. A caller with the `SERVICE_ROLE_KEY` connected directly to Postgres (e.g. a
future n8n "Execute Query" node, a custom RPC, or a leaked service key used outside PostgREST —
PostgREST itself has no `TRUNCATE` verb, so this is not reachable through the REST surface today)
can wipe an entire append-only table in one statement, with no `P0001`, no audit trail, and no
recovery path other than backups. This directly contradicts the design's stated guarantee
("`UPDATE`/`DELETE` are rejected... for **any** caller, including `service_role`" — `db/README.md`
§"Append-only tables") for the one DDL statement that isn't `UPDATE` or `DELETE`.

This is a narrow, cheap fix (see §6) and does not require touching `forbid_mutation()`'s logic —
routing it back to Task 9 per the plan's acceptance criteria ("or findings fed back into Task 9")
rather than treating it as a schema redesign.

## 1. Append-only enforcement — UPDATE / DELETE via psql

| # | Attack | Expected | Result |
|---|---|---|---|
| 1 | `UPDATE scores` via psql | `P0001` | **PASS** |
| 2 | `DELETE FROM raw_signals` via psql | `P0001` | **PASS** |

Fixture (own, not from smoke.sql): a `founders` row tagged `qa-gate-12`, one `scores` row
(`founder_id` set, `axis='founder'`, `value=42`), one `raw_signals` row (`founder_id` set,
`content_hash='qa-gate-12-raw-founder'`).

```
$ psql "$DATABASE_URL" -c "UPDATE scores SET value = 99 WHERE id = '<qa_score_id>';"
ERROR:  append-only invariant violated: UPDATE on public.scores is not permitted (id=68750c65-c520-4ad6-bdf8-bd0c56b90e48) -- use purge_founder() for GDPR erasure
CONTEXT:  PL/pgSQL function forbid_mutation() line 19 at RAISE

$ psql "$DATABASE_URL" -c "DELETE FROM raw_signals WHERE id = '<qa_raw_signal_founder_id>';"
ERROR:  append-only invariant violated: DELETE on public.raw_signals is not permitted (id=48939f56-277c-44a1-b442-6353258bf77c) -- use purge_founder() for GDPR erasure
CONTEXT:  PL/pgSQL function forbid_mutation() line 19 at RAISE
```

Connection used the credentials in `infra/supabase/.env` (`postgres.<POOLER_TENANT_ID>` through
the Supavisor pooler) — this session resolves to Postgres `current_user = 'postgres'` (verified
with `SELECT current_user;`), i.e. the actual superuser. The trigger still fires and blocks the
mutation even for the superuser, because `forbid_mutation()`'s bypass predicate requires the
purge GUC to be set, which it is not here — this is the correct baseline behavior before testing
the forged-GUC attack in §3.

## 2. Append-only enforcement — PATCH / DELETE via PostgREST (`service_role`)

| # | Attack | Expected | Result |
|---|---|---|---|
| 3a | `PATCH /rest/v1/scores?id=eq.<id>` with `service_role` key | 4xx, `P0001` body | **PASS** |
| 3b | `DELETE /rest/v1/raw_signals?id=eq.<id>` with `service_role` key | 4xx, `P0001` body | **PASS** |

```
$ curl -s -i -X PATCH "$REST_URL/scores?id=eq.<qa_score_id>" \
    -H "apikey: <REDACTED SERVICE_ROLE_KEY>" \
    -H "Authorization: Bearer <REDACTED SERVICE_ROLE_KEY>" \
    -H "Content-Type: application/json" \
    -d '{"value": 77}'

HTTP/1.1 400 Bad Request
Proxy-Status: PostgREST; error=P0001
{"code":"P0001","details":null,"hint":null,"message":"append-only invariant violated: UPDATE on public.scores is not permitted (id=68750c65-c520-4ad6-bdf8-bd0c56b90e48) -- use purge_founder() for GDPR erasure"}

$ curl -s -i -X DELETE "$REST_URL/raw_signals?id=eq.<qa_raw_signal_founder_id>" \
    -H "apikey: <REDACTED SERVICE_ROLE_KEY>" \
    -H "Authorization: Bearer <REDACTED SERVICE_ROLE_KEY>"

HTTP/1.1 400 Bad Request
Proxy-Status: PostgREST; error=P0001
{"code":"P0001","details":null,"hint":null,"message":"append-only invariant violated: DELETE on public.raw_signals is not permitted (id=48939f56-277c-44a1-b442-6353258bf77c) -- use purge_founder() for GDPR erasure"}
```

Both rows are confirmed still present and unmodified after these attempts (verified via §7's
final sweep, before purge).

## 3. Purge-bypass forgery (the "real R1 attack")

| # | Attack | Expected | Result |
|---|---|---|---|
| 4 | In a de-privileged session: `SET ROLE service_role; SET vcbrain.purging = 'on';` then `UPDATE scores` | still `P0001` | **PASS** |

```
$ psql "$DATABASE_URL" \
    -c "SET ROLE service_role;" \
    -c "SELECT current_user;"              --> service_role
    -c "SET vcbrain.purging = 'on';" \
    -c "SELECT current_setting('vcbrain.purging', true);"   --> on
    -c "UPDATE scores SET value = 1 WHERE id = '<qa_score_id>';"

ERROR:  append-only invariant violated: UPDATE on public.scores is not permitted (id=68750c65-c520-4ad6-bdf8-bd0c56b90e48) -- use purge_founder() for GDPR erasure
CONTEXT:  PL/pgSQL function forbid_mutation() line 19 at RAISE
```

The GUC was successfully forged (`current_setting('vcbrain.purging', true) = 'on'`), but the
second predicate (`current_user = 'postgres'`) does not hold once `SET ROLE service_role;` has
run — `current_user` correctly reports `service_role`, not `postgres`, and the mutation is
still rejected. This confirms the two-predicate design (plan.md Task 9 R1) actually holds against
a session that only has the ability to forge the GUC, not to become the function owner.

## 4. Memo required-section CHECK via REST

| # | Attack | Expected | Result |
|---|---|---|---|
| 5 | `POST /rest/v1/memos` with `sections` missing the `swot` key, `service_role` key | CHECK violation | **PASS** |

Fixture: an `applications` row (`kind='inbound'`, `deck_storage_path` set) under the QA fixture
company.

```
$ curl -s -i -X POST "$REST_URL/memos" \
    -H "apikey: <REDACTED SERVICE_ROLE_KEY>" -H "Authorization: Bearer <REDACTED SERVICE_ROLE_KEY>" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d '{"application_id":"<qa_application_id>","version":1,"sections":{"snapshot":{},"hypotheses":{},"problem_product":{},"traction":{}}}'

HTTP/1.1 400 Bad Request
Proxy-Status: PostgREST; error=23514
{"code":"23514","details":"Failing row contains (...).","hint":null,"message":"new row for relation \"memos\" violates check constraint \"memos_sections_check\""}
```

Verified with a follow-up `GET /rest/v1/memos?application_id=eq.<qa_application_id>` → `[]`: no
partial row was left behind.

## 5. Duplicate founder identity via REST

| # | Attack | Expected | Result |
|---|---|---|---|
| 6 | `POST /rest/v1/founder_identities` re-using an existing `(kind, value)` pair, `service_role` key | 409 / unique violation | **PASS** |

```
$ curl -s -i -X POST "$REST_URL/founder_identities" \
    -H "apikey: <REDACTED SERVICE_ROLE_KEY>" -H "Authorization: Bearer <REDACTED SERVICE_ROLE_KEY>" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d '{"founder_id":"<qa_founder_id>","kind":"qa_test_kind","value":"qa-attack-value-gate12"}'

HTTP/1.1 409 Conflict
Proxy-Status: PostgREST; error=23505
{"code":"23505","details":"Key (kind, value)=(qa_test_kind, qa-attack-value-gate12) already exists.","hint":null,"message":"duplicate key value violates unique constraint \"founder_identities_kind_value_key\""}
```

## 6. Additional attacks (not required by the plan, run for coverage)

| # | Attack | Expected | Result |
|---|---|---|---|
| A | `scores.axis` not in `score_axes` registry | `23503` FK violation | **PASS** — `scores_axis_fkey` |
| B | `scores.value = 150` (out of 0–100 bound) | `23514` | **PASS** — `scores_value_check` |
| C | `scores` with both `founder_id` AND `application_id` set | `23514` | **PASS** — `scores_subject_xor` |
| C' | `scores` with neither `founder_id` nor `application_id` set | `23514` | **PASS** — `scores_subject_xor` |
| D | `companies.stage = 'series_b'` | `23514` | **PASS** — `companies_stage_check` |
| E | `founder_identities.confidence = -0.5` | `23514` | **PASS** — `founder_identities_confidence_check` |
| F | Duplicate `(founder_id, company_id)` in `founder_company` | `23505` | **PASS** — `founder_company_founder_id_company_id_key` |
| G | `TRUNCATE scores` as `service_role` | expected `42501 insufficient_privilege` | **FAIL — MAJOR** (see below) |

All of A–F ran inside an outer `BEGIN; ... ROLLBACK;` against disposable, non-founder fixture
rows (fresh throwaway `founders`/`companies`/`applications` created and destroyed within the same
rolled-back transaction) — nothing from this block persists.

**G — TRUNCATE bypass (MAJOR finding).** Run inside the same rolled-back transaction as a safety
net:

```sql
BEGIN;
SET ROLE service_role;
TRUNCATE scores;   -- no error raised, statement succeeds at the SQL level
RESET ROLE;
ROLLBACK;          -- undoes it regardless of the finding above
```

Root cause confirmed via a direct grants query (`information_schema.role_table_grants`):
`service_role` holds `TRUNCATE` on all six append-only tables:

```
   grantee    | table_name  | privilege_type
--------------+-------------+----------------
 service_role | ai_runs     | TRUNCATE
 service_role | events      | TRUNCATE
 service_role | evidence    | TRUNCATE
 service_role | memos       | TRUNCATE
 service_role | raw_signals | TRUNCATE
 service_role | scores      | TRUNCATE
```

`BEFORE UPDATE OR DELETE` triggers do not fire on `TRUNCATE` (a Postgres-level fact, not a bug
in `forbid_mutation()`'s logic) — the trigger simply never runs for this statement, so the
`current_user`/GUC check in §3 is never reached and offers no protection here. Because
PostgREST does not expose a `TRUNCATE` verb, this is **not** reachable directly through the REST
surface today; it is reachable by anyone who can run raw SQL as `service_role` — a role a future
n8n "Execute Query" node or custom RPC will plausibly hold, and the exact role the design
document names as the one enforcement must hold against.

**Recommended fix (routed to Task 9, not attempted by this QA pass per scope):**
`REVOKE TRUNCATE ON scores, raw_signals, evidence, ai_runs, events, memos FROM service_role, anon;`
appended to `db/schema.sql` — three lines, no change to `forbid_mutation()` or any existing
trigger, safely re-appliable like the rest of the file. (An event trigger on
`ddl_command_start` filtering the `TRUNCATE TABLE` tag is a heavier alternative if a future
elevated role also needs blocking, but the `REVOKE` is sufficient for the current role set.)

This transaction was rolled back before any commit — the pre/post row count in `scores` was
verified unchanged (`SELECT id, value FROM scores;` still showed the single QA fixture row with
its original value after this test, and the grants query above confirms the mechanism without
needing to actually destroy data).

## 7. Non-collapse honesty note (REQ-002, M4)

Stated plainly, as required: **REQ-002 non-collapse is convention-level at the DB, not
structural.** The `score_axes` registry is deliberately INSERT-extensible (design.md §2 — "adding
a type is an INSERT, not a migration"), so nothing in the schema structurally blocks someone from
adding an `overall`/aggregate axis later. The DB-level guarantees are exactly the two the plan
names:

```sql
-- (a) the seed contains no aggregate axis
SELECT count(*) FROM score_axes WHERE slug IN ('overall','total','combined');
--> 0

-- (b) scores are stored one row per axis -- collapse can only happen at render time
```

Verified live, and additionally demonstrated that the registry genuinely has no CHECK preventing
this (inside a rolled-back transaction, so nothing persists):

```sql
BEGIN;
INSERT INTO score_axes (slug, label, is_screening_axis)
VALUES ('overall', 'QA probe -- would collapse the 3 axes if a writer used it', false);
-- INSERT 0 1, no error
SELECT slug FROM score_axes WHERE slug = 'overall';  --> overall
ROLLBACK;
SELECT count(*) FROM score_axes WHERE slug IN ('overall','total','combined');  --> 0
```

This reconciles design.md §1's "structurally impossible" wording for this one invariant, exactly
as the plan asks: the schema makes collapse *inconvenient and off by default*, not impossible for
a future writer who chooses to add and populate an aggregate axis. No fix is proposed for this —
it is documented, intentional, extensibility-first design, not a bug.

## 8. `purge_founder()` sanity — exhaustive cascade + delete-order hazard

| # | Attack | Expected | Result |
|---|---|---|---|
| 8 | `purge_founder()` on a fixture founder wired across every table in its footprint | zero founder-linked rows remain except one anonymized event | **PASS** |

Fixture (own, more complete than the plan's minimum "identity + one claim via a card + one
score" — deliberately also wired the delete-order hazard plan.md Task 9 flags as binding): one
`founders` row; one `founder_identities` row; a sole-founder `companies` row (via
`founder_company`); an `applications` row (inbound, minimal intake) under that company; a
`cards` → `claims` pair (`founder_id` on the card); a **company-scoped** `raw_signals` row; a
**founder-scoped** `raw_signals` row; an `evidence` row whose `claim_id` points at the
founder-side claim but whose `raw_signal_id` points at the **company-scoped** raw signal — the
exact cross-subtree wiring ("founder-scoped evidence → company-scoped raw_signal") the plan
calls out as a hazard that must be exercised; and a founder-scoped `scores` row.

Pre-purge (11 targeted rows, each count = 1):

```
founders | founder_identities | companies | founder_company | applications | cards | claims
raw_signals_founder | raw_signals_company | evidence | scores
--> all 1
```

```
$ psql "$DATABASE_URL" -c "SELECT purge_founder('<qa_founder_id>');"
 purge_founder
---------------

(1 row)
```

No error — despite the cross-subtree evidence→raw_signal link, confirming the plan's required
ordering (sweep ALL evidence→claims→cards before deleting ANY raw_signals) is implemented
correctly.

Post-purge, all 11 targeted rows = 0. Broader sweep across every founder_id-bearing table
(`founders`, `founder_identities`, `scores`, `raw_signals`, `ai_runs`, `metric_observations`,
`watchlist`, `cards`) for this founder id = 0 total rows.

Audit trail: exactly one `events` row survives for this founder:

```
 event_type      | entity_type | entity_id                            | payload | actor
 founder_purged   | founder     | 35aae2c3-b06c-4655-8b6d-4c711450dd88 | {}      | purge_founder
```

No PII in the payload, as contracted.

## 9. Final cleanup verification

Full row-count sweep across every table in the schema after all attacks:

```
ai_runs=0  applications=0  cards=0  claims=0  companies=0  evidence=0
founder_company=0  founder_identities=0  founders=0  interviews=0  memos=0
metric_observations=0  raw_signals=0  scores=0  voice_artifacts=0  watchlist=0
score_axes(overall/total/combined)=0
events=2
```

`events` holds 2 rows: this QA pass's own `founder_purged` audit row (§8) and one pre-existing
`founder_purged` row (`entity_id='88888888-0000-0000-0000-000000000001'`, timestamped before this
QA session started) left over from the database engineer's own earlier `purge_founder()`
verification — not created by this pass and correctly left untouched, since both are legitimate,
permanent, anonymized audit rows and not fixture debris. No other row from any attack in this
report persists anywhere in the database.

## Summary of findings for Task 9 follow-up

1. **MAJOR** — `TRUNCATE` on the six append-only tables is not blocked for `service_role`
   (Postgres `BEFORE` triggers don't fire on `TRUNCATE`; `service_role` holds the privilege via
   Supabase's default schema-wide grant). Fix: `REVOKE TRUNCATE ... FROM service_role, anon;` on
   `scores, raw_signals, evidence, ai_runs, events, memos` in `db/schema.sql`. Not reachable via
   PostgREST today (no `TRUNCATE` verb), but reachable via any future raw-SQL access path using
   the service role. **RESOLVED — see §10.**

All other invariant attacks in Task 12's required set, plus the eight additional creative
attacks, are correctly rejected by the schema exactly as designed.

## 10. Resolution — TRUNCATE finding re-verified fixed

The database engineer applied the fix to `db/schema.sql` (Step 1, appended after the six
`forbid_mutation()` triggers, before Step 2):

```sql
REVOKE TRUNCATE ON scores, raw_signals, evidence, ai_runs, events, memos
  FROM anon, authenticated, service_role;
```

Widened from the originally-recommended `service_role, anon` to all three PostgREST-facing roles
after the engineer found (via `pg_default_acl`) that `authenticated` held the same default
`TRUNCATE` grant `anon`/`service_role` did — not something this QA pass's original grants query
had scoped to check, since Task 12's attack list only names `service_role`. `postgres` is
correctly left untouched (table owner, REVOKE against an owner is a no-op, `purge_founder()` runs
`DELETE` under that role and never `TRUNCATE`). A belt-and-suspenders `BEFORE TRUNCATE` statement
trigger was considered and deliberately skipped, with reasoning matching my finding: the `REVOKE`
alone is sufficient for the current role set, and Postgres rejects a privilege-less `TRUNCATE`
before any trigger would even run.

**Independent re-verification (fresh session, new fixtures/attacks, not reusing anything from the
original finding beyond the target tables):**

```
$ psql "$DATABASE_URL" -c "select grantee, table_name, privilege_type
    from information_schema.role_table_grants
    where grantee in ('anon','authenticated','service_role')
      and table_name in ('scores','raw_signals','evidence','ai_runs','events','memos')
      and privilege_type='TRUNCATE';"

 grantee | table_name | privilege_type
---------+------------+----------------
(0 rows)
```

```sql
BEGIN;
SET ROLE service_role;
TRUNCATE scores;        -- now: ERROR 42501 permission denied for table scores
RESET ROLE;

SET ROLE authenticated;
TRUNCATE raw_signals;   -- now: ERROR 42501 permission denied for table raw_signals
RESET ROLE;

SET ROLE anon;          -- spot-check beyond what was asked, third PostgREST-facing role
TRUNCATE evidence;      -- now: ERROR 42501 permission denied for table evidence
RESET ROLE;
ROLLBACK;
```

All three roles now correctly receive `42501 insufficient_privilege` instead of a silent
success. Post-check row counts (`scores`, `raw_signals`, `evidence`, `events`) confirm the
database is unchanged by this re-verification — `events` still holds exactly the same 2
pre-existing legitimate `founder_purged` audit rows as before (§9), nothing new.

**Final verdict: GATE PASSED.** All invariant attacks in Task 12's required set (1–8), all eight
additional creative attacks (§6 A–F plus this TRUNCATE re-check), and the non-collapse honesty
note are accounted for. No open findings remain.
