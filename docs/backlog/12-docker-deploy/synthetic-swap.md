# Synthetic-only swap — extraction procedure

Status: tooling built + validated (read-only prep). **Not yet run against the server.**
Owner: @database-engineer (this doc + `db/synthetic-extract/`) · executed later by
@devops once feature 11 finishes generating the demo dataset (see tracker.md's
"DATA POLICY CHANGE" entry).

## 0. Why

`tracker.md`'s **DATA POLICY CHANGE** entry (2026-07-19): the first deploy loaded the FULL
local DB — 93% real people, sourced from public GitHub/HN/web by the hackathon's own
pipelines. Ethics red line: no AI-generated claims about real people on a public URL. Ruling:
wait for feature 11 to finish generating the curated synthetic dataset, then **one clean
swap** — wipe remote person-data, load synthetic-only. This doc is that swap's procedure;
`db/synthetic-extract/{extract.sh,load.sh}` is the tooling. Both were built AND run
end-to-end in this pass (read-only against local, and a full apply→load→smoke cycle against
a disposable throwaway Postgres — never against `supabase-db` itself or the server). Nothing
here has touched local dev or the server.

## 1. What "synthetic demo subset" means, precisely

Three root sets, everything else derived by FK closure (SS2):

| Root set | Predicate | Local count (2026-07-19) |
|---|---|---|
| Founders | `founders.is_synthetic = true` | 14 |
| Companies | `companies.is_synthetic = true` | 18 |
| Applications | `applications.id::text LIKE '11f0%'` (feature-11 curated demo journey) | 10 |

**Reconciliation the brief asked for:** does every `11f0%` application link (via
`company_id`) to a synthetic company? **Yes, all 10, zero exceptions** — verified by direct
join. So the applications predicate is a proper subset of "synthetic company's applications",
not a mismatched one.

**What that subset check also surfaced (not asked for, but load-bearing):** company/founder
`is_synthetic = true` is **broader** than "has a curated application". The 18 synthetic
companies break down by originating fixture (id prefix = feature that created it, documented
convention in `db/fixtures/*.sql`):

| Prefix | Feature | Founders | Companies | Applications | Has curated (`11f0%`) app? |
|---|---|---|---|---|---|
| `03f0` | 03 founder-score | 2 (Devon Ashworth, Kwame Asante) | 2 (Fintrace AI, Ridgeline Data) | 0 | — (registry-only fixture, `db/fixtures/03-founder-score.sql`, never applied by `apply.sh`) |
| `05f0` | 05 truth-gap/trust | 2 (Priya Kessler, Tomasz Wieckowski) | 2 (Ledgerly, Fenwick Analytics) | 2 (`05f0aaaa%`) | No |
| `07f0` | 07 thesis-engine | 0 | 4 (Nordkit, Fogline, StakeCircle, GameLoop) | 4 (`07f0%`) | No |
| `11f0` | 11 demo-data | 10 (Jonas Reiter … Yuki Andersen) | 10 (Voltaic Labs … patchbay) | 10 (`11f0%`) | Yes — all 10 |

So of the 14 synthetic founders, only 10 belong to the curated demo journey; 4 are leftover
test fixtures from features 03/05. Of the 18 synthetic companies, 10 have a curated
application, 6 have a **non-curated** synthetic application (real pipeline runs — ai_runs,
thesis_evaluations, scores, cards — exist against them, see SS3), and 2 (`03f0`) have no
application at all.

**Both root predicates come straight from the brief** (`is_synthetic` for
founders/companies, `11f0%` for applications) and both are followed literally below. The
practical effect: the 4 non-curated founders and the person-scoped signals of the 6
non-curated companies **are kept** (they're `is_synthetic = true`), but everything scoped
*through* their non-curated `application_id` is **excluded** (see SS3). This is a **flag
worth operator confirmation before the live swap**, not a silent call — see SS6.

## 2. Row-inclusion rule: AND, not OR

A downstream row survives only if **every non-null person-linking FK column on it** resolves
into a kept id (and at least one such column is non-null — an all-NULL row isn't
person-data). Concretely, for a table with `founder_id`/`company_id`/`application_id`:

```sql
(founder_id IS NULL OR founder_id IN keep_founders)
AND (company_id IS NULL OR company_id IN keep_companies)
AND (application_id IS NULL OR application_id IN keep_applications)
AND (founder_id IS NOT NULL OR company_id IS NOT NULL OR application_id IS NOT NULL)
```

This is both the **leak-safe** rule (a kept row can never carry a reference to an excluded —
i.e. real — founder/company) and the **FK-safe** rule (nothing kept can ever dangle, because
anything outside the keep-set was never selected in the first place). Verified empirically:
zero rows anywhere in the schema mix a synthetic reference with a real one on the same row
(checked `cards`, `ai_runs`, `scores`, `raw_signals`, `metric_observations`, `founder_company`,
`evidence.raw_signal_id` cross-links, `score_components`, `interviews`) — `founder_id` and
`company_id` always agree on synthetic-ness when both are set. **The one place AND-scoping
actually does work** (not just belt-and-suspenders) is `application_id`: see SS3.

## 3. The leakage/consistency risk this predicate had to catch

85 `ai_runs` rows, 20 `scores` rows, 14 `thesis_evaluations` rows, and 4 `cards` rows have
`company_id` (or `founder_id`) in the synthetic set **but** `application_id` pointing at one
of the 6 non-curated applications (`05f0aaaa%`/`07f0%` — real pipeline test runs against
those fixture companies, task-typed `verification`/`thesis_extraction`). Under the literal
`applications` predicate (`11f0%` only), those 6 applications are **excluded**. An OR-scoped
predicate ("keep if founder OR company OR application is in the keep-set") would have tried
to keep these rows anyway — and then dangled on `application_id` at load time, because the
application row itself isn't in the extract. The AND-scoped predicate above **correctly
excludes all of them**: verified zero dangling references in the actual extract (SS5).

Net effect: 6 of the 18 synthetic companies (Nordkit, Fogline, StakeCircle, GameLoop,
Ledgerly, Fenwick Analytics) and the 4 non-curated founders show up in the swapped DB with
their base substrate (cards without `application_id`, `raw_signals`, `metric_observations`,
`founder_company` edges) but **without** any scores/thesis-evals/memos/ai_runs, because those
were all scoped through the excluded application. If that's undesirable for how the demo
looks (a company card with no score behind it), the fix is a one-line predicate change in
`extract.sh` — widen `keep_applications` to "any application whose company is synthetic"
(16 apps, not 10) — not a redesign. **Flagging for operator/team-lead confirmation before the
live swap; not decided here** (Hard rule #6 — no silent default on a product-visible choice).

## 4. The `theses` id gotcha (found in testing, not hypothetical)

`theses` is registry data (seeded by `db/apply.sh`/`db/seed.sql`, `ON CONFLICT (name,
version) DO NOTHING`) with **one exception** the other 5 registry tables don't have: its `id`
is `gen_random_uuid()`, not a stable natural key (`score_axes`/`card_types`/`metric_kinds`/
`signal_sources` key off `slug`; `theses` doesn't). `applications.thesis_id` /
`scores.thesis_id` / `thesis_evaluations.thesis_id` carry the **local** random id. A fresh
`apply.sh` run on the target generates its **own** new random id for the same `('default',
1)` — a straight dangling-FK / natural-key-collision risk. This is the **exact** failure the
original full-DB restore already hit (`tracker.md` S0-A: "data-only dump re-inserts lookup
rows apply.sh seeds → PK collision" / S1-A2: "truncate+clean reload after a seed-vs-dump
thesis UNIQUE conflict").

Resolution (`db/synthetic-extract/{extract.sh,load.sh}`):
- `extract.sh` pulls only the `theses` row(s) **actually referenced** by the kept
  applications/scores/thesis_evaluations (dynamic, by FK — not a hardcoded `('default', 1)`
  guess). Locally, that's exactly **one row** (id `a0a94997-…`, `('default', 1)`).
- `load.sh` truncates `theses` (along with every other person-data table, one `TRUNCATE`
  statement) and reloads it with its **original local id**, so the FK references in the
  extract's `applications`/`scores`/`thesis_evaluations` resolve without any remap step.

**Second-order bug this surfaced, only visible by actually running it:** the referenced local
`theses` row (`a0a94997-…`, v1) is **inactive** locally — it was superseded by a v2
activation (`activate_thesis_version()`) sometime after the kept applications were scored
against it. Loading it verbatim leaves the target with **zero** active+default thesis, which
breaks `db/seed.sql`'s own stated invariant ("the gate cannot run without a thesis... without
a row satisfying both [is_default AND active], the gate has nothing to load"), and is exactly
what `db/tests/smoke.sql`'s `uq_theses_single_default` assertion is built to catch — it did,
first run. Fixed in `load.sh`: after loading the extracted theses row(s), a `DO` block
promotes the best candidate (highest version, preferring `is_default`) to `active = true,
is_default = true` if nothing loaded already satisfies that; if the extract carried zero
theses rows at all (nothing referenced one yet), it falls back to `db/seed.sql`'s own literal
`default`/v1 config inline (kept in sync with that file by hand, same stance the repo already
takes for the `claim_trust` view's documented literal duplicate).

## 5. Which tables come from where

| Source | Tables |
|---|---|
| `db/apply.sh` (schema + registry, unconditional, run FIRST on target) | `score_axes`, `card_types`, `metric_kinds`, `signal_sources`, `score_formulas` |
| `db/apply.sh`, then **overwritten** by the extract (SS4) | `theses` |
| Extract (`db/synthetic-extract/`), truncate + load, FK order | `founders`, `companies`, `applications`, `founder_company`, `founder_identities`, `cards`, `raw_signals`, `claims`, `evidence`, `scores`, `score_components`, `ai_runs`, `thesis_evaluations`, `memos`, `interviews`, `voice_artifacts`, `metric_observations`, `watchlist`, `events` |
| Neither (created via Storage REST API, not SQL) | `decks` bucket — `design.md` SS7 step 3, unchanged by this doc |

## 6. Runtime steps (for whoever runs the live swap)

1. Confirm feature 11's generation pass is what you want captured (SS7 tells you exactly
   what's done vs partial as of this validation pass — re-check before the real run, since
   11 is still writing).
2. **Decide SS3's open question** (10-app vs 16-app `keep_applications`) before running —
   default in the committed script is the literal 10-app (`11f0%`) reading from the brief.
3. On a machine with `docker exec` access to the **local** `supabase-db` (never the server):
   ```bash
   ./db/synthetic-extract/extract.sh /path/to/extract-out
   ```
   Read-only against local (`SELECT` + `\copy TO` only); writes CSVs to
   `/path/to/extract-out`. Re-runnable any time — flag-based, picks up whatever feature 11
   has generated by then.
4. Get `/path/to/extract-out` onto whatever machine will run `load.sh` against the remote
   (e.g. `scp`, same as the original dump in `design.md` SS7 step 1).
5. On the target: `db/apply.sh` first (schema + registry + `theses` seed — SS5).
6. Then:
   ```bash
   DATABASE_URL="postgresql://...vcbrain-db.../postgres" \
     ./db/synthetic-extract/load.sh /path/to/extract-out
   ```
   **Destructive** — truncates all person-data tables (+ `theses`) on the target first. Runs
   inside one transaction (`BEGIN … COMMIT`, `ON_ERROR_STOP=1`) with a post-load assertion
   (zero `is_synthetic = false` founders/companies, zero non-`11f0%` applications) that rolls
   back the whole load if it ever fires — a failed run leaves the target exactly as it was
   before, never half-truncated.
7. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/smoke.sql` — expect **one** known
   failure, not a regression: the task-A1e "radar_candidates obscurity" assertion
   (`db/tests/smoke.sql:2122`) is pinned to a specific **real** founder id
   (`d2e2c8fb-3abc-4f31-9c65-66ecc16066e4`, `hn_karma = -2`) that cannot exist in any
   synthetic-only dataset by construction. Confirmed by actually running the whole suite
   against a loaded target (SS8) — every other assertion in the ~2100-line file passed.
   Either skip/allowlist that one assertion for the post-swap check, or leave it as a known,
   explained red — not something `load.sh` can fix (it's a smoke-fixture choice, not a data
   defect).

## 7. Current would-extract row counts (local, read-only, 2026-07-19)

Produced by `extract.sh`'s own manifest — re-run it for a fresh number any time:

| Table | Kept | Local total |
|---|---|---|
| theses | 1 | 2 |
| founders | 14 | 167 |
| companies | 18 | 250 |
| applications | 10 | 359 |
| founder_company | 14 | 55 |
| founder_identities | 11 | 202 |
| cards | 25 | 224 |
| raw_signals | 92 | 1033 |
| claims | 194 | 1280 |
| evidence | 98 | 1038 |
| scores | 46 | 134 |
| score_components | 360 | 972 |
| ai_runs | 173 | 602 |
| thesis_evaluations | 5 | 243 |
| memos | 2 | 6 |
| interviews | 0 | 40 |
| voice_artifacts | 0 | 0 |
| metric_observations | 17 | 526 |
| watchlist | 0 | 0 |
| events | 165 | 1273 |

## 8. Is feature 11's generation done? (measured, not guessed)

The **base fixture** (`db/fixtures/11-demo-data.sql`) is complete and stable: all 10 curated
applications have exactly their `company` + `founder` cards (20 cards total), plus claims/
raw_signals/evidence per its own design ("NO scores/score_components/thesis_evaluations/
memos here — those are the pipelines' job"). What's still **partial** is the downstream
pipeline pass over that substrate, measured per curated application:

| Axis / artifact | Coverage across the 10 curated apps |
|---|---|
| `market`, `idea_vs_market` | 10/10 |
| `trust` | 9/10 |
| `thesis_fit` | 4/10 |
| `founder` (3-axis screening) | 2/10 |
| `thesis_evaluations` (verdict) | 5/10 |
| `memos` | 1/10 (tracewire, 2 versions) |
| `interviews` | 0/10 (none exist for any synthetic founder yet) |
| founder-level `founder_score` (Memory layer) | 5 of 14 synthetic founders (11 rows total — trend history, not 1/founder) |

So: **not done**. `market`/`idea_vs_market` are essentially finished; `founder` axis,
`thesis_fit`, `founder_score`, and memos are the ones still running. Re-run `extract.sh`
closer to swap time to capture wherever this lands — the predicates don't need touching for
that, they're flag-based (SS1).

## 9. Real-data leakage: verified zero, three ways

1. **By construction** — every predicate in `extract.sh` is AND-scoped against the three root
   keep-sets (SS2); nothing outside them can be selected.
2. **By direct check** — no row anywhere in the schema was found mixing a synthetic and a
   real `founder_id`/`company_id` reference (SS2, the actual query results are in the
   session, not reproduced here — re-run is one query per table if you want to re-verify).
3. **By integration test** — loaded the extract into a disposable, throwaway
   `supabase/postgres:17.6.1.136` container (never `supabase-db`, never the server; removed
   after) via `db/apply.sh` then `load.sh`, then queried the result directly:
   `founders.is_synthetic` = `{true: 14}` only, `companies.is_synthetic` = `{true: 18}` only,
   zero exceptions, and `db/tests/smoke.sql` ran clean except the one known-unrelated
   assertion (SS6 step 7).

## 10. Confirmed: SELECT-only, no server access

Every statement extract.sh runs against `supabase-db` is `SELECT`/`CREATE TEMP TABLE ... AS
SELECT`/`\copy ... TO` — nothing mutates the local database, and `supabase-db` itself was
never stopped, restarted, or touched outside a `docker exec` read. The integration test in
SS9.3 ran against a **separate, disposable** container (`synth-swap-test-pg`, removed after);
`supabase-db` was not involved in it. No `ssh` to any server was made at any point in this
pass.
