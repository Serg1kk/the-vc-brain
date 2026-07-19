# 07 · Thesis Engine — QA Report (E1a, database layer)

> Independent adversarial QA gate on the database layer only (design.md §5, §8.3 items 4-9 and
> 16). All tests below were written from scratch against `design.md` and `plan.md` — none of
> `db/tests/smoke.sql` was read or reused before running my own SQL. `db/tests/smoke.sql` was
> only inspected afterward, to confirm the required regression signal (§ "Regression" below).
>
> Connection: `postgresql://postgres.your-tenant-id:<POSTGRES_PASSWORD>@localhost:54322/postgres`
> (Supavisor pooler, tenant-qualified username, per `CLAUDE.md`). Every test ran inside
> `BEGIN ... ROLLBACK` (with `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` between sub-cases so one expected
> failure didn't abort the rest of the block). The one exception — the real two-session
> concurrency race and the `purge_founder()` regression evidence — used committed state that was
> explicitly restored afterward; verified clean (see "Cleanup verification").

## Verdict

# GATE PASSED

All nine required attack items (design.md §8.3 items 4-9 and 16) passed. One **Major** defect was
found under free hunting (item 8.3 "free hunting" clause) — a real gap, currently reachable
through the public API, but it does not touch any of the load-bearing guarantees this gate exists
to protect (the NULL trap, D-04 legality, append-only, `purge_founder()`, activation atomicity,
coverage bounds), so it does not block this gate. It should be fixed before feature 09 (or any
other caller) starts writing thesis configs outside the single seeded row.

---

## Per-item results

### 1. The NULL trap (item 4) — PASS

`validate_thesis_config()` correctly rejects a `hard` rule whose `hard_justification` is absent,
`null`, `""`, or a valid-but-wrong string, and accepts a genuinely valid value.

```sql
-- absent key entirely
INSERT INTO theses (name, config) VALUES ('qa-null-trap-a', jsonb_build_object(
  'rules', jsonb_build_array(jsonb_build_object(
    'id','R1','kind','deal_breaker','enforcement','hard',
    'expr', jsonb_build_object('field','sector','op','in','value', jsonb_build_array('gambling')),
    'weight', 0, 'enabled', true))));
-- ERROR:  thesis config: hard rule R1 requires hard_justification, got <NULL>

-- hard_justification: null
-- ERROR:  thesis config: hard rule R1 requires hard_justification, got <NULL>

-- hard_justification: ""
-- ERROR:  thesis config: hard rule R1 requires hard_justification, got

-- hard_justification: "because_i_said_so"
-- ERROR:  thesis config: hard rule R1 requires hard_justification, got because_i_said_so

-- hard_justification: "mandate_fatal" (valid) -> ACCEPTED, count=1
```

The naive `NOT IN` trap the design worried about (`v_just NOT IN (...)` returning `NULL` for an
absent key, letting `IF NULL THEN` silently fall through) is not present — the `COALESCE(v_just,'')`
guard converts the absent/NULL case into `''`, which correctly fails the `NOT IN` check. Confirmed
by executing all four bad cases and one good case.

### 2. D-04 legality matrix (item 5) — PASS (7/7 sub-cases)

| Case | Expected | Result |
|---|---|---|
| `focus` + `hard` | rejected | `ERROR: thesis config: focus rule R1 may not be hard` |
| `deal_breaker` + weight 10 | rejected | `ERROR: thesis config: deal_breaker R1 must have weight 0` |
| `deal_breaker` + `hard` + weight 0 + valid justification | accepted | inserted, count=1 |
| `deal_breaker` + `soft` + weight 0 | accepted | inserted, count=1 |
| `must_have` + `hard` + valid justification | accepted | inserted, count=1 |
| `must_have` + `soft` | accepted | inserted, count=1 |
| `focus` + `soft` | accepted | inserted, count=1 |

No over-rejection on any of the four legal combinations D-04 lists.

### 3. Empty config accepted (item 6) — PASS

- `config = '{}'::jsonb` explicit — inserted cleanly.
- `config` omitted entirely (relying on the column `DEFAULT '{}'`) — inserted cleanly, `config`
  resolves to `{}`.
- `config = {"rules": []}` (empty array, distinct from `{}`) — inserted cleanly (loop body just
  never executes).

### 4. Activation (item 7) — PASS, including a genuine concurrency race

Sequential, in a rolled-back transaction:

- Inserted `default` v2 with `active=false` (the documented insert-side convention), called
  `activate_thesis_version(v2_id)`. Result: exactly 1 row satisfies `is_default AND active`
  afterward, and it is v2 (`version=2`). v1 correctly demoted to `active=false, is_default=false`.
- Raw `INSERT` of `default` v3 with `active` **omitted** (defaults to `true`) →
  `ERROR: duplicate key value violates unique constraint "uq_theses_active_name"`. Rejected, as
  required.
- `activate_thesis_version('00000000-0000-0000-0000-000000000000')` (nonexistent id) →
  `ERROR: activate_thesis_version: no such thesis id 00000000-0000-0000-0000-000000000000`.
- A raw `INSERT` of an entirely different-named thesis with `active=true, is_default=true` while
  the real default is still active → `ERROR: duplicate key value violates unique constraint
  "uq_theses_single_default"`. Confirms `is_default` is a **global** singleton (the partial index
  is `ON theses ((true)) WHERE is_default AND active`, not scoped by name), and that no sequence
  reachable through normal writes can produce two simultaneous defaults.

**Real concurrency test** (committed state, two actual concurrent psql sessions, not simulated):
inserted `default` v2 and v3 (both `active=false`), then fired
`BEGIN; SELECT pg_sleep(0.3); SELECT activate_thesis_version(v2); COMMIT;` and the same for v3
from two background processes launched together. Both committed with **no error** on either side.
End state: exactly one row (`decab8ba…`, v3 — whichever committed last) satisfied
`is_default AND active`; the other two rows were consistently `active=false, is_default=false`.
No zero-default state, no duplicate-default state, no unhandled exception. Restored by calling
`activate_thesis_version(v1_id)` and deleting the two extra rows; verified the table is back to
exactly the original single row.

### 5. Append-only (item 8) — PASS, tested as the actual roles, not superuser

`postgres` is a member of `anon`, `authenticated`, and `service_role` in this instance
(`pg_auth_members`), so `SET ROLE` was used to genuinely execute as each role rather than asserting
grants from a privileged session.

| Role | UPDATE | DELETE | TRUNCATE |
|---|---|---|---|
| `anon` | `ERROR: append-only invariant violated: UPDATE ... — use purge_founder()` | same, `DELETE` | `ERROR: permission denied for table thesis_evaluations` |
| `authenticated` | same trigger error | same | same permission-denied |
| `service_role` | same trigger error | same | same permission-denied |
| owner (`postgres`, no role switch) | same trigger error | same | (not tested — owner still has TRUNCATE, by design; the REVOKE targets the three PostgREST-facing roles, not the table owner) |

Notably `service_role` does **not** bypass this — `forbid_mutation()` is a plain `BEFORE` trigger,
not an RLS policy, so `service_role`'s usual RLS-bypass privilege is irrelevant here; it is blocked
by the same trigger as everyone else. Confirmed the row was untouched (`still-there-unmodified`)
after all nine attack attempts, then rolled back and confirmed the seeded row disappeared (count 0).

**Bonus attack on the purge bypass itself.** `forbid_mutation()`'s bypass requires
`current_setting('vcbrain.purging') = 'on' AND current_user = 'postgres'`. Since `vcbrain.purging`
is a plain (non-superuser-only) GUC, I forged it as `anon`:

```sql
SET ROLE anon; SET vcbrain.purging = 'on';
DELETE FROM thesis_evaluations WHERE input_fingerprint = 'qa-guc-forge-test';
-- ERROR: append-only invariant violated: DELETE ... (the forged GUC alone did not work)
```

Confirmed rejected — the `current_user = 'postgres'` half of the guard held. I also checked
whether any of `anon`/`authenticated`/`service_role` can `SET ROLE postgres` in this instance
(`pg_has_role(..., 'postgres', 'MEMBER')` for all three → `f`), so the bypass's safety is not just
theoretical here. **Caveat worth recording** (not a defect, an operational note): this safety
depends entirely on `postgres` never being granted to a PostgREST-facing role — nothing in the
schema enforces that; it is a convention, and the comment in `forbid_mutation()` slightly overstates
it by calling `postgres` "a superuser" (`pg_roles.rolsuper = false` for `postgres` in this
self-hosted instance — the actual bootstrap superuser is `supabase_admin`). The protection holds
today because of the specific role-membership graph, not because `postgres` is superuser.

### 6. `purge_founder()` (item 9) — PASS, 4/4 variations

All four built and torn down inside one outer rolled-back transaction, using `DO` blocks with
explicit assertions (not just "no error"):

1. **The exact reproducing combination**: sole application whose `thesis_evaluations` row
   references both a `scores` row and an `ai_runs` row. `purge_founder()` succeeded with no
   `23503`; verified zero rows remained in `founders`, `companies`, `founder_company`,
   `applications`, `scores`, `ai_runs`, and `thesis_evaluations` for every id created, and exactly
   one `founder_purged` event row was written.
2. **Evaluation row with no score** (`score_id NULL`, mirrors the `insufficient_evidence`/keyword
   persistence shape) — purge succeeded, evaluation row gone.
3. **Founder with two applications** on the same sole company, each with its own
   evaluation+score+ai_run — purge succeeded, both application subtrees and both evaluation rows
   gone.
4. **Multi-founder company** — two founders on one company, one shared application with a
   `thesis_evaluations` row. Purging founder 1 alone: founder 1's own rows (identity,
   `founder_company` edge, founder-scoped `scores` row) were removed; the **shared** company,
   application, `thesis_evaluations` row, and application-scoped `scores(thesis_fit)` row survived
   intact, and founder 2 was untouched. This is the correct behaviour — a shared company is not
   "sole-founder" and must not be swept.

### 7. Coverage CHECK (item 16) — PASS

```sql
coverage = 1.01  -- ERROR: violates check constraint "thesis_evaluations_coverage_check"
coverage = -0.1  -- ERROR: violates check constraint "thesis_evaluations_coverage_check"
coverage = NULL  -- accepted (evaluation_mode='keyword' row), coverage reads back NULL
coverage = 0.00  -- accepted (boundary)
coverage = 1.00  -- accepted (boundary)
```

Boundaries are inclusive and correct; out-of-range rejected in both directions; `NULL` explicitly
permitted as keyword mode requires.

### 8. Free hunting — 1 defect found (see Defects), everything else clean

Additional attacks, all behaving correctly:

- FK gaps: nonexistent `thesis_id`, `application_id`, `score_id`, `extraction_ai_run_id` on
  `thesis_evaluations` all rejected with the expected FK violation.
- `evaluation_mode` CHECK: `'quick'` rejected.
- `verdict` CHECK: `'maybe'` rejected.
- `UNIQUE (application_id, thesis_id, input_fingerprint)`: exact duplicate rejected.
- Same `(application_id, thesis_id)`, different `input_fingerprint`: **both** rows accepted — this
  is the re-evaluation-without-a-version-bump case (§6.1's motivating scenario) and it works at the
  schema level.
- Two different-named theses both `active=true` simultaneously: accepted (by design —
  `uq_theses_active_name` is scoped per name; only `is_default` is global).
- The seeded default thesis re-validates cleanly on a genuine content-changing `UPDATE`
  (`jsonb_set(config, '{schema_version}', '1')`), confirming the trigger really re-runs full
  validation on update, not just insert.

## Defects found

### D1 — Major: `weight` is not type/range-checked for `must_have` or `focus` rules

`validate_thesis_config()` only ever touches `weight` inside the `deal_breaker` branch
(`COALESCE((v_rule->>'weight')::numeric, 0) <> 0`). For `must_have` and `focus` rules — the two
kinds whose weights actually drive the `earned`/`total` arithmetic in §3.1 — nothing checks that
`weight` is present, numeric, or non-negative.

Reproduced:

```sql
-- string weight on a must_have rule -- ACCEPTED
INSERT INTO theses (name, config) VALUES ('qa-w1', jsonb_build_object('rules', jsonb_build_array(
  jsonb_build_object('id','R1','kind','must_have','enforcement','soft',
    'expr', jsonb_build_object('field','business_model','op','eq','value','b2b'),
    'weight', 'thirty', 'enabled', true))));
-- INSERT 0 1 -- config->'rules'->0->'weight' = "thirty"

-- weight key entirely absent on a focus rule -- ACCEPTED
-- (has_weight_key = false, row still inserted)

-- negative weight (-50) on a must_have rule -- ACCEPTED

-- a JSON array [1,2,3] as weight on a focus rule -- ACCEPTED
```

As a side note, the `deal_breaker` branch's own weight handling isn't clean either: a non-numeric
weight there doesn't hit the intended `RAISE EXCEPTION 'thesis config: deal_breaker % must have
weight 0'` message — the `::numeric` cast fails first with a raw, less friendly Postgres error
(`ERROR: invalid input syntax for type numeric: "zero"`, pointing at line 25 of the function). It
still rejects the row, so this half is functionally safe, just cosmetically inconsistent with the
rest of the validator's error style.

**Why it matters.** `weight` for `must_have`/`focus` rules feeds directly into `total`, `earned`,
and therefore `fit` and `coverage` (§3.1, §3.2) — the exact arithmetic this feature's design
document (D-07, §9's audit trail) says has already been gotten wrong twice. A non-numeric,
missing, or negative weight reaching the JS evaluator (`lib/f07/rules.js`) would either throw at
evaluation time or silently produce `NaN`/negative `fit`/`coverage > 1`, which is precisely the
class of defect §3.2 calls out as breaking two CHECK constraints. This is reachable **today**
through the public API, not just a hypothetical future risk: `anon` currently holds `INSERT` and
`UPDATE` on `theses` (confirmed via `information_schema.role_table_grants`; `theses` has
`relrowsecurity = false`, same as every other table in this project — this is a pre-existing,
project-wide posture, not something feature 07 introduced, but it does mean the gap is not
gated behind an admin-only path).

**Suggested fix**, small and localized to `validate_thesis_config()` — for every rule kind, before
the existing `deal_breaker`-specific check:

```sql
IF jsonb_typeof(v_rule->'weight') <> 'number' THEN
  RAISE EXCEPTION 'thesis config: rule % weight must be a number, got %', v_rule->>'id', v_rule->'weight';
END IF;
IF (v_rule->>'weight')::numeric < 0 THEN
  RAISE EXCEPTION 'thesis config: rule % weight must be >= 0, got %', v_rule->>'id', v_rule->>'weight';
END IF;
```

placed before the kind-specific checks, this also fixes the `deal_breaker` cosmetic issue for free
(the type check fires first, with a clean message, before the numeric cast that currently raises
the raw Postgres error).

**Recommendation:** fix before Stage D or feature 09 exposes any write path to `theses.config`
beyond the single seeded row. Does not block E1a — none of the nine required attack items are
affected, and the currently-shipped seed config is well-formed (verified: all rule weights in the
seeded default thesis are integers).

## Regression

Ran `db/tests/smoke.sql` in full (`psql -v ON_ERROR_STOP=1 -f db/tests/smoke.sql`) after all of the
above — completed cleanly with no `RAISE EXCEPTION` reaching the top level, single rolled-back
transaction as designed. Confirms feature 07's additions did not regress features 01-06's
assertions.

## `db/apply.sh` idempotency — verified independently

Ran `./db/apply.sh` twice in a row (not the builder's word — actually executed):

```
Run 1: ... INSERT 0 0  (x8, one per seed statement)  ... Done.
Run 2: ... INSERT 0 0  (x8, identical)                ... Done.
```

Row counts identical before/after both runs: `theses=1`, `thesis_evaluations=0`,
`score_axes(slug='thesis_fit')=1`. All DDL statements (`CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION/TRIGGER`, `REVOKE`) are safely re-runnable by construction, and the
seed's `ON CONFLICT DO NOTHING` inserted zero new rows on both runs. Confirmed genuinely
idempotent, not merely "should be."

## Cleanup verification

Every rolled-back transaction was checked with a post-`ROLLBACK` `SELECT count(*)` for its own
test artifacts (all zero). The one committed-state test (activation concurrency, §4) was restored
by explicitly reactivating the original default version and deleting the two extra rows created
for the race; verified back to the single original row
(`a0a94997-a8e4-470f-b676-d10a21990757`, version 1, `active=true`, `is_default=true`) before moving
on. Final check at the end of this session: `theses` has exactly 1 row (the original default),
`thesis_evaluations` has 0 rows, and `founders`/`companies` contain only the pre-existing
`03f0000...`/`07f0000...`/`aaaaaaa2...` fixture rows that predate this QA session (feature 03's and
feature 07's own `db/fixtures/07-thesis-engine.sql`, `db/fixtures/03-founder-score.sql` data, not
QA residue) plus one unrelated row (`Medows`) also present before this session started. No
QA-created data remains in the database.

---

## E1b

> Independent adversarial QA gate on the contract and behaviour layer (design.md §8.3 items 1, 2,
> 3, 10, 11, 12, 13, 14, 15) — the runner (`lib/f07/run.js`), the three live n8n workflows
> (`f07-thesis-gate`, `f07-thesis-reevaluate`, `f07-db-write`), and the deterministic evaluator
> (`lib/f07/rules.js` / `vocabulary.js`) they share. All tests below were written from scratch
> against `design.md` and `handoff.md` — none of `lib/f07/*.test.js` was read or reused before
> writing or running any of the scripts/queries below. E1a (database layer, §8.3 items 4–9, 16)
> already passed and is not repeated here.
>
> Connection: `postgresql://postgres.your-tenant-id:<POSTGRES_PASSWORD>@localhost:54322/postgres`
> (Supavisor pooler). n8n: `http://localhost:5678`, webhooks called directly with `curl`. All
> DB-level attack/repro work used disposable test companies/applications (`aaaaaaaa/bbbbbbbb-...
> -e1b1` through `-e1b5`, `is_synthetic=true`), created and fully deleted by me in this session —
> never the shipped `07f0...` fixtures, which I only ever `SELECT`ed. Deletes against the four
> append-only tables (`thesis_evaluations`, `scores`, `ai_runs`, `raw_signals`, `evidence`, `events`)
> used the same `SET LOCAL vcbrain.purging = 'on'` bypass E1a exercised and verified — the only
> other route available now that `TRUNCATE`/bare `UPDATE`/`DELETE` are correctly revoked/trapped.

## Verdict

# GATE FAILED

Eight of nine required attack items pass. **Item 11 (resume) fails**, confirmed reproducible
against the live, currently-deployed `f07-thesis-gate` workflow: a crash between two adjacent,
non-transactional Code nodes (`Write scores (thesis_fit)` → `Write thesis_evaluations`) leaves a
permanently orphaned, duplicate `scores(thesis_fit)` row that no `thesis_evaluations` row will ever
reference — the exact class of defect run.js's own source comments say the ordering exists to
prevent, present in the workflow that does not have that ordering. Two further **Major** defects
were found under free hunting, both structural and both live: (a) `_text` is folded from claims in
both `f07-thesis-gate` and `f07-thesis-reevaluate`, directly contradicting design.md §1.1's
explicit, twice-corrected "not a concatenation of claims" invariant; (b) the D-07 coverage-gate
guarantee (item 1) holds at the `applications.thesis_gate` cache level but not at the `scores`
table level, which the design itself designates a valid, documented query surface for "current
thesis_fit" — a stale, superseded, still-passing `scores` row survives a later
`insufficient_evidence` re-run undetected.

**A note on timing.** This is a live, shared, actively-building environment. `lib/f07/run.js` was
edited (and `f07-thesis-gate`/`f07-thesis-reevaluate` were redeployed to n8n, `updatedAt
2026-07-19T03:16:19Z`) partway through this QA session, apparently by a teammate continuing build
work concurrently — not by me; I made no source edits and no workflow deploys. One finding below
(D3, run.js's `raw_signals.payload`) was true when I first read the file and had already been fixed
by the time I ran a live `--recorded` check of it minutes later; I report it as found-then-fixed,
not as an open defect, and re-ran my two most severe findings (item 11, and the `_text` claim-fold)
fresh against the post-redeploy workflow before writing this up — both reproduce identically on
the current, currently-live system (evidence below is from the *second*, post-redeploy run).

---

## Per-item results

### Item 1 — Coverage protection (D-07) — PASS, with a Major completeness gap adjacent to it

Fresh company/application (`QA-E1b-CoverageCo`, no `07f0...` fixture touched). Ran `f07-thesis-gate`
twice against the same `application_id`:

```
Run 1 (full text, all 5 attributes clear, on-thesis):
  curl -X POST http://localhost:5678/webhook/f07-thesis-gate -d '{"application_id":"...e1b1",
    "mode":"full","text":"Voltra Systems builds infrastructure and developer tools for backend
    engineering teams. ... headquartered in Berlin, Germany. ... working prototype ..."}'
  -> verdict=passed, fit=100, coverage=1.00
  DB: 1 scores row (100.00/1.00), applications.thesis_gate='passed', 1 thesis_evaluations row.

Run 2 (SAME application, deliberately unextractable text):
  curl ... -d '{"application_id":"...e1b1","mode":"full","text":"Quietly building something new."}'
  -> verdict=insufficient_evidence, fit=0, coverage=0.190 (only M_poskw resolves via _text; all
     four other gateable fields correctly `unknown`)
```

After run 2, verified directly in the DB:

```sql
select count(*) from scores where application_id='...e1b1';            -- 1 (still just run 1's row)
select thesis_gate, thesis_id from applications where id='...e1b1';    -- NULL, thesis_id set
select id, verdict, coverage, input_fingerprint from thesis_evaluations
  where application_id='...e1b1';  -- 2 distinct rows, distinct fingerprints (passed, then
                                    -- insufficient_evidence) -- append-only history intact
select event_type from events where entity_id='...e1b1';
  -- thesis_gate_insufficient_evidence, with coverage/missing_fields in payload
```

The guarantee **as stated in D-07** holds at the level 07 controls: no second `scores` row, and
`applications.thesis_gate` is genuinely rewritten to NULL (an actual write, matching D-05), so the
sparse run leaves the ranking rather than sinking into it. This is the exact invariant that broke
in rev.1/rev.2 and it does not break here.

**Major gap, found while confirming this (not one of the 16 numbered items, but directly
adjacent to #1's own guarantee):** run 1's `scores` row is never retracted, marked stale, or
superseded — it simply sits there. A query joining `applications` to `scores(thesis_fit)`, which is
exactly the shape §5.3/§10 document as the supported way to resolve "current thesis_fit" ("the row
with the greatest `computed_at` per `(application_id, axis, thesis_id)`"), still returns it:

```sql
select a.id, a.thesis_gate, s.value as thesis_fit, s.computed_at
from applications a join scores s on s.application_id=a.id and s.axis='thesis_fit'
where a.id='...e1b1' order by s.computed_at desc;
--                  id                  | thesis_gate | thesis_fit |          computed_at
-- ...e1b1                              |    (NULL)   |     100.00 | 2026-07-19 03:04:42...
```

`applications.thesis_gate` is NULL (correct, current state), but a naive "latest `scores` row per
key" query — the one convention 07 itself documents for 09/10 to use — still surfaces a 100.00
fit for an application that just left the ranking. The `insufficient_evidence` branch deliberately
writes no new `scores` row (correctly, per §2's table), but nothing in the schema or the handoff
tells a consumer that "latest row" and "current state" can diverge the moment a re-evaluation
degrades to `insufficient_evidence` — the "latest existing row" is not the same thing as "the
latest evaluation's row" when the latest evaluation wrote none. As long as every consumer gates on
`applications.thesis_gate IS NOT NULL` *before* ever touching `scores`, this is harmless; nothing
currently enforces that ordering, and §5.3/§10 explicitly bless direct `scores` queries. Recommend:
either document this ordering requirement explicitly in the 09/10 handoff sections (currently they
warn about mixing theses, not about this), or have the coverage-gate branch write a
`superseded_by`/`retracted_at` marker (or simply also write a `scores` row with a value that reads
as "not ranked", e.g. `NULL` `value` if the column allowed it — it does not, `value` is `NOT NULL`
per `db/schema.sql`) so "no live row for the current fingerprint" is queryable without also
re-deriving "did anything supersede this" from `thesis_evaluations`.

### Item 2 — `unknown` cannot reject — PASS

Tested directly against `lib/f07/rules.js`'s actual exported `evaluateThesis()` (not
`rules.test.js`), fed the real seeded thesis config (pulled live from `theses.config`), with
`sector` deliberately excluded — once via `missingFields:['sector']`, once via simply omitting the
key from `attributes` entirely (the two distinct paths `resolveField` supports) — while every other
gateable attribute (`business_model`, `geography_country`, `stage_evidence`, `_text`) was populated
well enough to keep `coverage` **above** `min_coverage` (0.81), so the test isolates D-03 from the
coverage gate (item 1) rather than confounding the two:

```
R1 (hard, kind=deal_breaker, field=sector) -> outcome: "unknown", observed: null
verdict: "passed" (never "failed")
coverage: 0.8095... >= min_coverage (0.5)
```

Both variants (missing via `missingFields` array, missing via absent key) independently confirm a
hard rule referencing an unextracted field can never fire. A live corroboration also exists: the
`Fogline` fixture (`07f0...0002`, pre-existing, read-only) hits `insufficient_evidence` for the same
structural reason and has never once produced `failed` across the 3 runs already in the DB before
this session.

### Item 3 — Open door — PASS

Same direct call to `rules.js`, `sector:"consumer"` (outside R1's hard list) plus `_text` containing
"casino"/"betting" (trips `M_negkw`, a **soft** deal-breaker by construction — D-01/§1.2):

```
R1        -> outcome: "satisfied" (does not fire; sector not in its list)
M_negkw   -> outcome: "triggered"
verdict:  "borderline"
fired_rules: non-empty, all 2 relevant rules present and visible
```

A second, adjacent case (D-04a case 4 / §9's rev.3a step-2b regression) was also run: every
`must_have`/`focus` rule matching plus one triggered soft deal-breaker lands **fit exactly on
`strong_threshold` (70)** and the verdict is still `borderline`, never `passed` — confirms §2 step
2b is live in the shipped code, not just in the design prose. A companion sanity check confirmed
keyword mode can still legitimately reach `failed` via a hard rule fed through `structured_hints`
(so "never passed" isn't achieved by silently disabling `failed` too).

### Item 10 — Idempotency — PASS

Fresh application (`QA-E1b-IdempotencyCo`), `f07-thesis-gate` called **twice in a row** with
byte-identical `text`:

```
call 1 -> evaluation_id: 228d7926-...
call 2 -> evaluation_id: 228d7926-...   (SAME id)
```

```sql
select count(*) from thesis_evaluations where application_id='...e1b2';  -- 1
select count(*) from scores where application_id='...e1b2';             -- 1
select count(*) from ai_runs where application_id='...e1b2';             -- 1
select count(*) from raw_signals where company_id='...e1b2';             -- 1
select topic, source_kind, count(*) from claims where card_id=... group by topic, source_kind;
  -- 5 rows, each count=1 (sector/business_model/geography_country/stage_evidence/what_is_built,
  -- all self_reported, none duplicated)
select count(*) from evidence where claim_id in (...);                  -- 5
```

Exactly one row everywhere on the clean double-call path. (Item 11 below shows this stops holding
once the retry happens *inside* a specific narrow crash window rather than as a full clean re-call.)

### Item 11 — Resume — **FAIL** (confirmed, reproducible, re-confirmed post-redeploy)

Design §6.2 states a retry must converge to exactly one row per table regardless of which node a
prior run died after. n8n has no cross-node transaction (stated as a known risk in §6.2 itself), so
I simulated the two node-adjacency crash points that matter by reproducing their **observable DB
state** exactly (not by guessing) — for a genuine "died between node X and node Y" crash, the only
difference from a clean run is which rows exist afterward, and I constructed exactly that state
using the same `vcbrain.purging` bypass used for cleanup, then re-invoked the workflow to see if it
converges.

**Crash point A — died after `Write scores (thesis_fit)`, before `Write thesis_evaluations`
(FAILS):**

```
Fresh application (...e1b5). Gate call -> evaluation E1=6c6c1ca0..., score S1=4501fe92... (fit 100).
Simulate the crash: DELETE FROM thesis_evaluations WHERE id='6c6c1ca0...' (via the purging bypass),
  leaving S1 in place -- exactly the state a real crash between those two nodes would leave, since
  "Write scores" already committed and "Write thesis_evaluations" never ran.
Retry: same application_id, same text (curl to the SAME webhook, same payload) ->
  evaluation_id: 94ca084e-... (NEW, different from E1)

select id, value, computed_at from scores where application_id='...e1b5' order by computed_at;
  4501fe92-... | 100.00 | 03:18:51   <- S1, ORPHANED: no thesis_evaluations row references it anymore
  f93d6b28-... | 100.00 | 03:19:07   <- S2, referenced by the new evaluation

select id, score_id from thesis_evaluations where application_id='...e1b5';
  94ca084e-... | f93d6b28-...        <- only 1 evaluation row, but 2 scores rows exist
```

Root cause: `Check existing evaluation` looks up `thesis_evaluations` only, by
`(application_id, thesis_id, input_fingerprint)`. When that row does not exist (because it died
before being written), the workflow treats the retry as brand new and re-runs `Decide scores write`
→ `Write scores (thesis_fit)` unconditionally — a plain `POST` with **no existence check**, because
`scores` has no natural dedup key (§5.3: "scores has no uniqueness for any axis"). `lib/f07/run.js`
avoids exactly this by checking `existingEvaluation` **before** ever calling
`writeScoreIfEligible()` (its own comment names the risk explicitly: *"an orphaned second score no
thesis_evaluations row would ever reference"*) — the live workflow's node graph puts the equivalent
guard in the wrong place: `Write scores` is upstream of, not gated by, the same existence check that
correctly protects `thesis_evaluations` itself. This reproduced identically both before and after
the mid-session workflow redeploy (`updatedAt 2026-07-19T03:16:19Z`) — the evidence above is from
the **second**, post-redeploy run, re-verified specifically because the workflow file changed under
me mid-session.

**Crash point B — died after `Write thesis_evaluations`, before `Write applications cache`
(PASSES, as designed):**

```
Manually reverted applications.thesis_gate/thesis_id to NULL for the same application (simulating
that exact crash point, evaluation+scores already durably written).
Retry (same text) -> evaluation_id: 88528f00-... (SAME id as the existing row -- correctly reused)

select thesis_gate, thesis_id from applications where id='...e1b1';  -- 'passed', thesis_id set (healed)
select count(*) from scores where application_id='...e1b1';          -- unchanged, no 3rd row added
select count(*) from thesis_evaluations where application_id='...e1b1'; -- unchanged, no 3rd row added
```

This path works exactly as §6.2 describes: `Use existing evaluation` → straight to
`Write applications cache`, healing the stale/NULL cache without touching `scores`/
`thesis_evaluations` again. Claims/evidence/`ai_runs` were unaffected by either crash simulation in
both scenarios (dedup by content hash held throughout — no duplicate claims in either case).

**Verdict for item 11: FAIL.** One of the two node-adjacency crash points converges correctly; the
other durably duplicates a `scores` row with no corresponding evaluation-table trail, which is
precisely "does not leave a stale... reference" inverted (a live orphan, not a stale cache) and
precisely the failure mode item 11 was written to catch. Severity: **Major** — not an immediate
correctness crisis today (nothing currently reads `scores` without going through
`thesis_evaluations` or the `applications` cache first), but it silently accumulates permanently
undeletable (`scores` is append-only) orphaned rows on every occurrence of this specific,
realistic n8n failure mode, and compounds with the item-1-adjacent finding above: an orphaned
`scores` row is indistinguishable, at the table level, from a legitimately-current one.

### Item 12 — Re-evaluation without a version bump — PASS

Using the item-10 application (already gated once, `business_model="b2b"` claim present):

```sql
update claims set verification_status='contradicted' where id='...' ; -- the company.business_model claim
```

```
curl -X POST http://localhost:5678/webhook/f07-thesis-reevaluate -d '{"application_id":"...e1b2"}'
-> evaluation_id: 5726e720-... (NEW, different from the original 228d7926-...)
   verdict: passed, fit: 76.19, coverage: 0.76 (down from 1.00)
   R2 (must_have/focus, field=business_model): outcome "unknown", observed null
     -- NOT "missed" -- confirms D-03's "contradicted -> unknown" mechanism, not a rejection
```

```sql
select count(*) from thesis_evaluations where application_id='...e1b2'; -- 2 (no UNIQUE violation)
select count(*) from scores where application_id='...e1b2';             -- 2 (both non-insufficient verdicts, both scored)
select count(*) from ai_runs where application_id='...e1b2';            -- 1 (unchanged -- reevaluate never calls the LLM)
select count(*) from claims where card_id=...;                          -- 5 (unchanged -- reevaluate never writes claims)
```

Claim reverted to `unverified` immediately after (see Cleanup). Exactly the behaviour §6.1/§8.3
item 12 specify: a second append-only row, not a UNIQUE violation, with the contradicted field
correctly reclassified rather than counted as a miss.

### Item 13 — Anti-sycophancy, structural — PASS

Not tested behaviourally (per instruction — the extractor is non-deterministic). Checked
structurally, two ways:

1. **Data shape, live.** `ai_runs.output_json` for a real gate call (`jsonb_pretty`) contains
   exactly `{reasoning, sector, business_model, geography_country, stage_evidence, what_is_built,
   quotes, missing_fields}` — no `theses`, `config`, `rules`, `mandate`, or thesis id anywhere in
   the persisted row.
2. **Code shape + execution order, on disk.** Parsed `f07-thesis-gate.json`'s `connections` graph
   directly: `Build extractor request → OpenAI: thesis-attribute-extractor (luna) → Parse extractor
   response → ... → Build attributes for evaluation → Resolve contradicted claims → Load default
   thesis → Evaluate thesis`. **`Load default thesis` is strictly downstream of the extractor
   call** — the thesis config is not even fetched from the DB until after the LLM has already
   returned, so it cannot be in the request the LLM saw regardless of what the code does with it
   later. Grepped `Build extractor request`'s own `jsCode` for `thesis`/`config`/`mandate`/`rules`:
   the only hits are the schema's own `$id` string (`.../thesis-attribute-extractor.output.json`)
   and the agent's own name — identifier text, not configuration content.

Both checks independently confirm the anti-sycophancy structural guarantee as it is actually built,
not merely as documented.

### Item 14 — Keyword mode — PASS

Fresh application (`QA-E1b-KeywordCo`), called with `mode:'keyword'` and `structured_hints` crafted
to be maximally favourable (`sector:'b2b-software', business_model:'b2b', geography_country:'US',
stage_evidence:'prototype'`, gate text containing both positive keywords, no negative ones) — i.e.
the best possible case for a false "passed":

```
-> verdict: "borderline" (fit computed as 100 internally but never consulted -- §2 step 3 is
    full-mode only), coverage: null
```

```sql
select count(*) from ai_runs where application_id='...e1b3';     -- 0 -- no LLM call at all
select count(*) from scores where application_id='...e1b3';     -- 0
select verdict, evaluation_mode, coverage, score_id from thesis_evaluations where application_id='...e1b3';
  -- borderline | keyword | (NULL) | (NULL)
select thesis_gate from applications where id='...e1b3';        -- 'borderline' (not NULL, not passed)
select count(*) from cards where application_id='...e1b3';      -- 0 -- keyword mode never invokes f07-db-write
```

Confirms all four required properties simultaneously on the single best-case input: never
`passed`, no LLM call, zero `scores` rows, `coverage` NULL end to end (response and DB agree). A
companion direct `rules.js` check confirmed keyword mode *can* still reach `failed` via a hard rule
fed through `structured_hints` — so "never passed" isn't secretly achieved by disabling `failed`
too.

### Item 15 — Vocabulary agreement — PASS

Programmatic diff (not eyeballed) across four independently-authored sources:

```
extractor schema top-level fields:     [sector, business_model, geography_country, stage_evidence, what_is_built]
extractor schema quotes{} fields:      [same 5, same order]
extractor schema missing_fields enum:  [same 5]
vocabulary.js ATTRIBUTES (non-derived, excl. _text): [same 5]
lib/f07/run.js EXTRACTION_FIELDS:      [same 5]
-> all four sets sort-equal, byte-for-byte on every key name.
```

Also confirmed every field `rules.js`'s `compileMandateRules()` can reference (`sector`,
`geography_region`, `stage`, `_text`) exists in `vocabulary.ATTRIBUTES`, including the two derived
fields the extractor never emits directly (`geography_region`, `stage`) — the derivation boundary
(`region_of`/`stage_of`) is exactly where the design says it should be, not duplicated into the
extractor's own output contract.

---

## Defects found

### D1 — Major (breaks item 11, required): resume duplicates an orphaned `scores` row

See item 11 above for the full reproduction. Root cause: `f07-thesis-gate`'s `Write scores
(thesis_fit)` node writes unconditionally on any path where `Check existing evaluation` finds
nothing, but `scores` has no dedup key of its own — unlike every other write in the pipeline
(`ai_runs`, `raw_signals`, `claims`, `evidence`), which are all select-by-hash-first. `lib/f07/run.js`
gets this right (existing-evaluation check gates the score write, not just the evaluation write);
the live n8n workflow's node graph does not mirror that ordering. **Suggested fix**: move the
`scores` existence check earlier, or (simpler, matching the pattern already used everywhere else in
this pipeline) give `Write scores` its own idempotency key —
`(application_id, thesis_id, input_fingerprint)` composited into a lookup before the `POST`, exactly
like `Check existing evaluation` already does for `thesis_evaluations` one node later.

### D2 — Major (adjacent to item 1): stale `scores` row survives a later `insufficient_evidence` re-run

See item 1 above. The `applications.thesis_gate` cache is correctly NULLed by 07 itself; the
`scores` table — which §5.3/§10 explicitly document as a valid "current thesis_fit" query surface —
retains the prior, now-superseded passing row with nothing marking it stale. Recommend documenting
the "always check `applications.thesis_gate` before trusting a `scores(thesis_fit)` row" ordering
explicitly for 09/10, since neither handoff section currently states it.

### D3 — Informational, found-then-fixed during this session, not currently open

At the start of this session, `lib/f07/run.js`'s `writeRawSignal()` wrote `payload: {mode}` only —
no `text` key — diverging from the live `f07-db-write` workflow's own `Write raw_signal` node
(`payload: {text: inp.gate_text || ''}`) and from `handoff.md`'s "same code path" claim for run.js.
Since `_text` recovery on re-evaluation depends entirely on `raw_signals.payload.text` (§1.1), any
application originally gated via `run.js` rather than the workflow would have gone permanently blind
on every `_text` rule (`M_poskw`, `M_negkw`, any hand-authored one) on its first re-evaluation. By
the time I ran a `--recorded` verification of this (using a disposable application, no LLM cost),
`run.js` had already been edited (`writeRawSignal` now takes and stores `gateText`; file mtime
06:08:26, after my initial read but before my recorded-mode run) — presumably by a teammate
continuing build work concurrently, not by me. Re-ran the check live: `raw_signals.payload` for the
test application now correctly contains `"text": "..."`. Reporting for the record since I found it
independently via code read before it was fixed, not because it is still open.

### D4 — Free hunting, Major: `_text` is folded from claims in both live workflows, contradicting the stated invariant

design.md §1.1, normative: **"`_text` is the gate's raw input text ... not a concatenation of
claims. It is deliberately the unprocessed input: keyword rules exist to catch what the extractor
might normalize away, so deriving `_text` from extracted claims would defeat their purpose."** This
was explicitly re-corrected at least twice more in-repo: `lib/f07/vocabulary.js`'s
`synthesize_text(gateText)` takes only the raw text (no claim input at all), and `run.js`'s own
comment block cites a dated "team-lead correction, 2026-07-19" establishing exactly this. `run.js`'s
behaviour matches the invariant — verified live (item 1's `--recorded` run: `_text` in the response
was the raw gate text, unmodified).

**Both live n8n workflows do the opposite.** `f07-thesis-gate.json`'s `Build attributes for
evaluation` node:

```js
// _text synthesis (SS1.1): the gate's raw input text, plus what_is_built folded in when
// present. Purely additive, never derived from claims.
const synthesized = [inp.gate_text, attributes.what_is_built]
  .filter(p => typeof p === 'string' && p.trim().length > 0).join(' ').trim();
```

`f07-thesis-reevaluate.json`'s `Build attributes from current claims` node does the identical thing,
with a comment stating the opposite immediately above it ("resolves from the stored
`raw_signals.payload` ... NEVER from claims") and then folding `attributes.what_is_built` (a claim
value) in anyway.

**Reproduced live, twice** (once pre-redeploy, once post-redeploy at `updatedAt
2026-07-19T03:16:19Z`, to make sure the finding still holds against the currently-deployed code):
sent gate text without the phrase "developer tools"/"infrastructure" verbatim as a trailing
sentence; the returned `fired_rules[].observed` for `M_poskw`/`M_negkw` showed the raw text **plus**
an appended, reworded sentence matching the extracted `what_is_built` value — e.g. input ending
"...three pilot customers." returned `_text` ending "...three pilot customers. Developer tools and
infrastructure for platform engineering teams." (the latter never appeared in the input; it is the
model's own paraphrase of `what_is_built`). Confirmed via direct `thesis_evaluations.fired_rules`
inspection in the DB, not just the HTTP response.

**Why this matters**, beyond the stated-invariant violation itself: (a) `what_is_built` is
explicitly "not gateable" (§1.1) — this gives it backdoor gating power over `_text`-based rules
anyway; (b) feature 06's memo renderer reads `fired_rules[].observed` as evidence — it is no longer
"the raw input we saw," it is raw input plus an LLM paraphrase, undermining the verbatim-quote trust
story the rest of the design is built around; (c) for `f07-thesis-reevaluate` specifically, if a
`what_is_built` claim is ever superseded/corrected between the original gate and a later
re-evaluation, `_text` would change even though `raw_signals.payload.text` — the thing re-evaluation
is supposed to hold fixed — did not, silently un-fixing the "replay against the same original input"
property §6.1 promises. This did not corrupt any of my other test results (in every other test
either `what_is_built` was absent, or its content happened not to change the substantive
match/no-match outcome of `M_poskw`/`M_negkw`), but it is a live, structural, two-workflow defect,
independent of everything else in this report. **Suggested fix**: delete the
`, attributes.what_is_built` join term in both nodes' `_text` synthesis; `_text` should be
`inp.gate_text` (gate) / the recovered `raw_signals.payload.text` (reevaluate) alone, exactly as
`vocabulary.synthesize_text()` already does it.

### On the GameLoop ambiguity (asked directly, not a numbered item)

Reviewed the fixture and the extractor's actual behaviour (from README-f07.md's own live-verified
log, corroborated by re-reading the fixture and the prompt's Instruction 5). My assessment: **the
fixture is fine; the extraction prompt has a real gap.** GameLoop's described product — an SDK that
lets *other companies'* casino partners add real-money betting mini-games — is a "picks-and-shovels"
B2B infrastructure business whose *customers* touch gambling, not a gambling operator itself. R1's
own justification (`hard_justification: mandate_fatal`, §1.3: "fund-mandate binaries... embargoed
geography, contractually excluded sector") reads naturally as being about what the *company itself*
does, not about whether any of its described use cases mention a regulated vertical — many real
funds happily back the infrastructure vendor while passing on the regulated operator. The prompt's
Instruction 5 (self-label-override: trust the described product over the founder's self-label) is
good anti-sycophancy design in general, but it has no separate instruction for "the company enables
X for its customers" vs. "the company does X" — a distinction the current negative criteria don't
isolate the way they isolate the self-label case. I'd keep the fixture exactly as is (it is
correctly surfacing a real, non-hypothetical judgment call a hard mandate rule will hit in
production) and add a sixth instruction/negative-criterion to the extractor prompt distinguishing
"operates in sector X" from "sells tooling/infrastructure to sector X," so a B2B vendor's `sector`
classification tracks what the company *is*, not every vertical its described feature set could
touch. This is a recommendation for whoever owns the extraction agent next, not a blocking finding
against this gate — the deterministic evaluator did exactly what the design specifies given the
sector value it was handed either way.

## Cleanup

All test data was created under five disposable, `is_synthetic=true` companies/applications
(`aaaaaaaa/bbbbbbbb-0000-0000-0000-00000000e1b1` through `e1b5`) and fully removed at the end of the
session, in FK-safe order, using the same `vcbrain.purging` GUC bypass E1a exercised for the
append-only tables (`events` → `evidence` → `thesis_evaluations` → `scores` → `claims` → `ai_runs`
→ `raw_signals` → `cards` → `applications` → `companies`). Verified after cleanup:

```sql
select count(*) from companies   where id::text like 'aaaaaaaa-0000-0000-0000-00000000e1b%';  -- 0
select count(*) from applications where id::text like 'bbbbbbbb-0000-0000-0000-00000000e1b%'; -- 0
select id, name, version, active, is_default from theses;
  -- a0a94997-a8e4-470f-b676-d10a21990757 | default | 1 | t | t   -- unchanged, the one original row
```

The one claim I contradicted for item 12 (`company.business_model` on `...e1b2`) was reverted to
`unverified` immediately after that test, before the application itself was deleted.

**Two rows are NOT back to the exact count I found at session start, and I did not touch them.**
`thesis_evaluations` reads 11 (was 9) and `scores(axis='thesis_fit')` reads 8 (was 6) — the two
extra rows (`af872fd9...`/`0bae27f9...` on Fogline `07f0...0002`, `199d4b28...`/`a7e2b4f4...` on
StakeCircle `07f0...0003`) were created at timestamps (`03:05:15`, `03:12:21`) falling inside my
test session, against fixture application IDs I never called or referenced in any of my own test
payloads. This is concurrent activity from another process against the same shared dev database,
not QA residue — I left it exactly as I found it rather than guess at deleting someone else's
in-progress work. `founders`/`companies` fixture rows (`03f0...`, `07f0...`, `aaaaaaa2...`, `Medows`)
are otherwise unchanged from E1a's own recorded baseline.

---

## E1b — re-verification after D3 (fix for item 11 + D4)

> The three `f07-*` workflows were redeployed twice more while the above was already written:
> `updatedAt 2026-07-19T03:16:19Z` (seven unrelated changes — see the team lead's note; re-verified
> above, no regression) and, mid-way through *this* re-verification pass, again at
> `2026-07-19T03:28:48Z` — the D3 fix for item 11 and D4. Both redeploys were confirmed via the n8n
> API (`updatedAt`) cross-checked against `n8n/workflows/*.json` mtimes, not assumed. Everything
> below was run fresh, after `03:28:48Z`, on new disposable applications (`...e1b6` through
> `...e1bb`) — none of the evidence above (pre-`03:16:19Z`) is relied on for this verdict.

### Item 11 — Resume — now **PASS** (was FAIL)

Re-ran the exact crash-point-A reproduction from the original finding (`Write scores` succeeds,
`thesis_evaluations` row deleted via the `vcbrain.purging` bypass to reproduce the crash's
observable state, then retried with byte-identical input):

```
gate call 1 -> evaluation 0dd0fca6-..., score 3c5782c0-... (fit 100)
simulated crash: DELETE FROM thesis_evaluations WHERE id='0dd0fca6-...' (scores row left in place)
retry (same application_id, same text) -> evaluation c345aaf6-... (NEW row)

select id, value from scores where application_id='...e1bb';            -- 1 row: 3c5782c0 (REUSED, not duplicated)
select id, score_id from thesis_evaluations where application_id='...e1bb'; -- 1 row: c345aaf6 -> 3c5782c0
select count(*) from claims where card_id=...;                          -- 5, unchanged (no duplication)
select count(*) from ai_runs where application_id='...e1bb';            -- 1, unchanged
select thesis_gate from applications where id='...e1bb';                -- 'passed'
```

The retry now correctly finds and reuses the orphaned `scores` row instead of minting a second one.
Crash-point-B (died after `thesis_evaluations`, before the cache write) was also re-run on a
separate application (`...e1b6`) post-redeploy and still heals correctly (same evaluation id reused,
cache correctly restored, no extra rows) — unchanged from before, as expected since D3 didn't touch
that path.

### D4 (`_text` claim-folding) — now **fixed** (was Major)

Re-ran the original reproduction on a fresh application, full-mode, with `what_is_built`
extractable:

```
gate call -> fired_rules[M_poskw].observed == the raw gate text, verbatim, nothing appended.
```

Confirmed on both workflows: `f07-thesis-gate` directly (above), and `f07-thesis-reevaluate` via the
multi-`raw_signals` test below, whose `_text` also came back as pure raw text with no paraphrase
folded in.

### Item 12 — re-run with the multi-`raw_signals` scenario the team lead flagged

Not part of the original 9 items' minimum bar, but specifically called out as newly relevant: an
application gated **twice** with different text (two distinct `raw_signals` rows, second one
mentioning "casino"/"betting"), then one claim contradicted, then `f07-thesis-reevaluate`:

```sql
select payload->>'text' from raw_signals where company_id='...e1b8' order by observed_at;
-- row 1 (older): "...Lisbon, Portugal..." (no negative keywords)
-- row 2 (newer): "...casino and betting integrations... Lisbon Portugal..."
```

```
reevaluate -> _text == row 2's text (the MOST RECENT one with a text key) verbatim
  -> M_negkw: triggered (correctly reflects the newer text's content)
  -> business_model: "unknown" (contradicted claim, not "missed")
  -> verdict: borderline
```

Confirms `_text` resolution now deterministically prefers the most recent `raw_signals` row that
actually carries a `text` key, not whichever row a `find()` over an unordered list happened to hit
first — exactly the fix the team lead described. `thesis_evaluations`/`scores` counts for this
application after both gate calls + the reevaluate: 3 evaluations, 2 scores (the two full-mode
gate calls; the reevaluate's `borderline` verdict also scores) — all distinct, no duplication.

### Items 1, 10, 13, 14 — re-run, no regressions

All re-run fresh against `03:28:48Z` on new applications, full detail omitted for brevity (same
shape as the original section above, same result):

- **Item 1**: full run → `passed`, 1 `scores` row; second run on the same application with sparse
  text → `insufficient_evidence`, `scores` count stays at 1, `thesis_gate` written NULL.
- **Item 10**: two identical calls → same `evaluation_id` both times; `thesis_evaluations`=1,
  `scores`=1, `ai_runs`=1, `raw_signals`=1, `claims`=5 (no duplicates) — the "select-by-`input_hash`
  -first" change to `ai_runs` did not regress dedup.
- **Item 13**: `ai_runs.output_json` now has the new shape `{input:{gate_text,structured_hints},
  extraction:{...}}` live-confirmed — a direct, single-field structural check (`output_json.input`
  contains only `gate_text`/`structured_hints`, no thesis field) rather than the inference the
  original write-up relied on. `evidence.strength = 0.90` for `tier='documented'` also confirmed
  (was `NULL` pre-redeploy) — consistent with the team lead's changelog, not a QA item itself.
- **Item 14**: keyword mode, favorable `structured_hints` → `borderline` (never `passed`),
  `coverage` NULL, 0 `ai_runs`, 0 `scores`, 0 `cards`.

Items 2, 3, 15 were not re-run — they exercise `lib/f07/rules.js`/`vocabulary.js` directly, never
the n8n workflows, and nothing in either redeploy touched those files (`rules.js`/`vocabulary.js`
mtimes unchanged throughout this session).

### D2 (stale `scores` row on `insufficient_evidence`) — resolved at the contract level

`handoff.md` §6 now carries an explicit correction ("Do NOT read `scores` directly for the current
thesis fit. Go through `thesis_evaluations`") with the resolution procedure spelled out. This is a
consumer-contract fix, not a code fix — there is nothing further for this gate to test; the
underlying mechanics (`scores` has no uniqueness, a superseded row is never retracted) are
unchanged and cannot be, structurally, but the documented reading procedure now prevents a
consumer from being misled by it. Recorded as resolved, not re-opened.

## Revised verdict

# GATE PASSED

All nine required attack items (1, 2, 3, 10, 11, 12, 13, 14, 15) now pass against the currently
deployed workflows (`updatedAt 2026-07-19T03:28:48Z`, confirmed live). D1 (item 11) and D4 (`_text`
folding) are fixed and re-verified with fresh reproductions of the original failing scenarios, not
merely re-read from source. D2 (stale `scores` row) is resolved at the handoff-contract level. D3
(`run.js` raw_signal payload) was found-then-fixed mid-session, as previously reported, and remains
non-open. No new defects surfaced in this re-verification round.

## Cleanup (second pass)

Six more disposable, `is_synthetic=true` companies/applications (`...e1b6` through `...e1bb`) were
created for this re-verification round and fully removed afterward, same FK-safe order and
`vcbrain.purging` bypass as before. Post-cleanup: 0 QA companies/applications remain;
`theses` still shows exactly the one original row. `thesis_evaluations` now reads 13 and
`scores(axis='thesis_fit')` reads 10 (were 11/8 after the first cleanup) — the two further new rows
(`11edf5c0...`, `ce83561e...`, both `application_id = 07f0...0001`, Nordkit) were created during
this round by, again, activity I did not initiate — left untouched for the same reason as before.

---

## Item 11 — one more targeted re-check, against `updatedAt 2026-07-19T03:34:07Z`

Requested specifically because that redeploy renamed the fix's own keying field
(`missing_flags.input_fingerprint` → `missing_flags._f07_input_fingerprint`, namespaced so 05/06/09
never render a raw hash as a genuine missing-data point) — the exact field the item-11 fix keys its
existence check on, so "just a rename" was not taken on trust.

Fresh disposable application (`...e1bc`), same crash-point-A repro as both prior rounds:

```
gate call -> evaluation d68133dd-..., score 516714a0-...
select missing_flags from scores where application_id='...e1bc';
  -- {"missing_fields": [], "_f07_input_fingerprint": "e02ae29f..."}   <- rename confirmed live, and
  --   correctly separate from the genuine "missing_fields" key feature 01 owns
simulated crash: DELETE FROM thesis_evaluations WHERE id='d68133dd-...' (scores row left orphaned)
retry (identical application_id, identical text) -> evaluation f615efb4-... (NEW row)

select id from scores where application_id='...e1bc';              -- 1 row: 516714a0 (REUSED)
select id, score_id from thesis_evaluations where application_id='...e1bc'; -- 1 row: f615efb4 -> 516714a0
select count(*) from claims where card_id=...;                     -- 5, unchanged
select count(*) from ai_runs where application_id='...e1bc';        -- 1, unchanged
```

Converges correctly: one `scores` row, reused rather than duplicated; one new `thesis_evaluations`
row pointing at it; no duplicate claims or `ai_runs`. The key rename did not disturb the select-first
lookup. Item 11 holds against `03:34:07Z`. Test data (`...e1bc` company/application and all
descendants) created and fully removed in the same pass; DB otherwise unchanged from the prior
cleanup's end state.

**Verdict unchanged: GATE PASSED**, now confirmed against `updatedAt 2026-07-19T03:34:07Z`.
