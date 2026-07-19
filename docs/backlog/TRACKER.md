# Backlog Tracker — dependencies & parallelization

> Purpose: run features in PARALLEL terminals safely. Update the Status column as you go
> (backlog → groomed → spec → in-build → done). Keep this file the single source of truth
> for «what can I start next».

> ## ⚠️ 2026-07-19 ~06:50 — THIS FILE WAS RESTORED AFTER BEING REVERTED TO ITS FIRST COMMIT
>
> At ~06:45 the working copy was found byte-identical to commit `dca3ad5` (the original
> skeleton): 01 still «in-build», every other feature «backlog», and **all** subsequent content
> gone — the infra changelog, the tooling changelog, the 🔴 OPEN shared-DB-files section, and
> every Schema-changelog entry from 03, 04, 07 and 02.
>
> **Root cause, established later and worth stating precisely:** this was not a revert of
> committed history. `git log --all` shows exactly one commit for this file, and the same event
> also wiped `db/schema.sql`, `db/seed.sql` and `db/tests/smoke.sql` — where features 03 and 07
> had done substantial work but had **never `git add`-ed it** (their commits `f64b66b` and
> `c33deba` staged only `db/README.md` and their fixture files). So what was lost in every case
> was *uncommitted working-tree content*, discarded by something in another terminal. Hours of
> cross-feature work existed only in a working tree, which is why a single stray command erased
> it. The DB files have since been reconstructed from the live database and committed.
>
> **What follows below is a RECONSTRUCTION from the 02 terminal's session context**, which had
> read the file in full at ~06:00 and had grepped 07's later additions. Treat it accordingly:
> - Substance, IDs, file paths, timestamps and technical findings are faithful.
> - Exact wording of other features' entries may differ slightly from their originals.
> - **Anything written by 04 or 07 AFTER ~06:00 is not here and was not recoverable.** If you are
>   the 04 or 07 terminal, please re-add whatever you appended after that point.
>
> Lesson for everyone: this file is edited by four terminals and is **not** covered by any commit
> after the first. Prefer `>>` appends over read-modify-write, and do not run `git checkout` /
> `git restore` across `docs/`.

## Status board

| # | Feature | Status | Depends on (hard) | Blocks | Wave |
|---|---|---|---|---|---|
| 01 | memory-data-model | **done** (12/12 tasks, QA gate PASSED, commit `fe20c83`) | — | everything | 0 |
| 02 | sourcing-radar | **done** (QA gate PASSED round 3 · 265 tests · commits `edee0df`/`0ca3a87`/`fa07521`/`36cd27b` · n8n `qmViGGDMmEEN3XWH` · see `02-sourcing-radar/done.md`) | 01-schema, 07 (gate) | 08, 11 | 1 |
| 03 | founder-score | **done** (11/11 tasks, QA gate PASSED, commit `f64b66b`; ⚠️ shared DB files uncommitted — see OPEN below) | 01-schema | 05, 06 | 1 |
| 04 | market-trend-competition | **in-build** (design rev.3 ✅, plan rev.2 ✅, scoring core green, n8n deployed) | 01-schema (no schema additions needed) | 05, 06 | 1 |
| 07 | thesis-engine | **done** (QA report present, `handoff.md` written) | 01-schema | 02 (gate), 09 | 1 |
| 05 | truth-gap-trust | backlog | 03 & 04 output contracts | 06 | 2 |
| 08 | founder-intake (compact B) | backlog | 01-schema, 02 (pre-fill sub-workflows) | 11 | 2 |
| 10 | api-cli-skill | backlog | 01-schema (PostgREST); webhooks land per-feature | 09 (NL-search UI) | 2 |
| 06 | memo-decision | backlog | 03, 04, 05 | 09 | 3 |
| 09 | investor-dashboard | backlog | 03-07 outputs (design track can start NOW) | 12 demo | 3 |
| 11 | demo-data-ethics | backlog | 02, 08 | 12 demo | 3 |
| 12 | docker-deploy | backlog | compose base can start EARLY; final needs all | — | 0* + final |

## Key insight: depend on the SCHEMA, not on 01 being finished

01's `design.md` is **approved** → its table/field contracts are already stable. Wave-1
features can be groomed and built against the design NOW; they only need the live DB for
integration testing. Don't wait for 01 to fully land before grooming.

## Critical path

**01 → 03 → 05 → 06 → 09 → 12/submission.** Anything delaying these delays the demo.
04 runs parallel to 03 and joins the path at 05. Protect the critical path first when
choosing what to parallelize.

## Parallel-terminal rules (collision safety)

1. One feature = one terminal = one owner. Don't edit another feature's folder; cross-feature
   needs go through this tracker or the orchestrator session.
2. Schema changes — reconcile with 01's design.md FIRST, apply as additive migrations, announce
   under «Schema changelog» below.
3. Shared n8n instance: prefix workflows by feature (`f03-score-founder`), export JSON to
   `n8n/workflows/` on every save.
4. Commits: per-feature paths only, via @devops agent; never `git add -A`. Pull --rebase
   before push (multiple terminals!).
5. Status here updates on grooming start, spec approval, build start, done.
6. **(added after the ~06:45 loss)** Append to this file; avoid read-modify-write of the whole
   thing, and never `git checkout`/`restore` across `docs/`.
7. **(same loss, the real lesson) COMMIT YOUR SHARED-FILE WORK THE SAME HOUR YOU DO IT.** 03 and
   07 both edited `db/schema.sql`/`seed.sql`/`smoke.sql` and neither ever `git add`-ed them, so
   hours of DDL from three features lived only in a working tree until one stray command erased
   it. It was only recoverable because the objects were still applied in the live database — had
   the container been reset first, it would simply have been gone.

## Infra changelog (append-only) — READ IF YOU ARE ABOUT TO USE n8n

- 2026-07-19 ~04:10 · **04 — n8n instance bootstrapped for the first time.** The `vcbrain-n8n`
  container had never been through first-run setup. Feature 04 created the **owner account +
  API key**, and added Supabase/Tavily/OpenAI secrets as container env vars referenced only via
  `$env.*` in nodes — never literals — so exported workflows are safe to commit. Values live in
  `infra/n8n/.env` (gitignored). **If you were about to run n8n owner setup: do not — the owner
  already exists.** Use `curl -H "X-N8N-API-KEY: $N8N_API_KEY" http://localhost:5678/api/v1/workflows`.
- 2026-07-19 ~05:00 · **03 — `SUPABASE_URL` drifted between the running container and
  `infra/n8n/.env`, twice, live.** Symptom: a Code node building `SB + '/rest/v1/' + path` got a
  **404 `PGRST125`** because the env value already carried a `/rest/v1` suffix. Root cause never
  fully resolved (two terminals "fixing" the same shared file in opposite directions).
  **Mitigation every feature should adopt:** normalise before use —
  `String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '')`. 02 and 03 both do this.

## Tooling changelog (append-only) — READ IF YOU ARE ABOUT TO WRITE JS

- 2026-07-19 · **JS test runner pinned: `node --test`, no `package.json`, no dependencies.**
  Test files `lib/fNN/*.test.js`, asserts via `node:assert/strict`.
  ⚠️ **Use the glob form: `node --test lib/fNN/*.test.js`.** The directory form fails repo-wide
  with `MODULE_NOT_FOUND` — a Node v22.19.0 quirk in directory-argument resolution, **not**
  caused by the space in this repo's path (checked via a space-free symlink).
- 2026-07-19 · **n8n Code nodes CANNOT `require()` from this repo.** `infra/n8n/docker-compose.yml`
  mounts only `n8n_data`; the repo is not bind-mounted and `NODE_FUNCTION_ALLOW_EXTERNAL` is
  unset. Any logic destined for a Code node must be **self-contained CommonJS with zero imports**,
  pasted verbatim behind a `// SOURCE OF TRUTH: lib/fNN/<file>.js` header. For SHA-256 use
  `globalThis.crypto.subtle.digest('SHA-256', …)`, not `require('crypto')`.
- 2026-07-19 ~05:05 · **A plain node with several wires into its single input does NOT reliably
  wait for all of them in this n8n build (2.30.7).** `f03-score-founder` fans out to 4 parallel
  LLM Code nodes; wiring all 4 straight into one downstream node ran **live, returned
  `success`/200, and had silently executed only 1–2 of the 4 branches** (confirmed via
  `GET /api/v1/executions/{id}?includeData=true` — two node names simply absent from
  `resultData.runData`). **Fix: use a real `Merge` node** (`n8n-nodes-base.merge`,
  typeVersion 3.2, `mode:'append'`, `numberInputs:N`), wiring branch *i* into input index *i*.
  IF/Switch reconverges are fine as-is (only one branch is ever live).
- 2026-07-19 ~05:10 · **`gpt-5.6-luna` rejects `temperature: 0`** — HTTP 400 «Unsupported value:
  'temperature' does not support 0 with this model». **Omit the parameter entirely** rather than
  sending 0 or 1. 03's agent specs still say «temperature 0» in prose; that prose is stale.

## 🔴 OPEN: shared DB files are committed by NOBODY yet (03 ↔ 07 ↔ 02)

- Feature 03 committed its code as `f64b66b` but deliberately did **not** stage `db/schema.sql`,
  `db/seed.sql`, `db/tests/smoke.sql`, because 07's DDL is interleaved in all three. A clean
  split is not possible: `db/tests/smoke.sql` has a genuinely shared `table_name IN (...)` list
  naming 03's `score_components`/`score_formulas` **and** 07's `thesis_evaluations`.
  02 has since added a `radar_candidates` VIEW and 7 `metric_kinds` rows to the same files.
  The local database has all of it applied and `smoke.sql` is green — this is a **git hygiene
  gap, not a broken environment**; a fresh clone + `./db/apply.sh` would produce none of it.
  **Resolution: whichever terminal finishes last commits all three files once, covering all
  three features**, after `./db/apply.sh` twice and a green `smoke.sql`. Additions are marked
  `-- Feature 03:` / `-- Feature 07:` / `-- Feature 02:` throughout, so the combined commit is
  reviewable.

## Schema changelog (append-only)

- 2026-07-19: 01 design.md approved (base schema).
- 2026-07-19: **03** adds two tables — `score_formulas` and `score_components` (both need the
  `REVOKE TRUNCATE` treatment). **`purge_founder()` is edited in place in `db/schema.sql`** —
  `db/apply.sh` runs only schema+seed, so a separate migration file would never execute.
- 2026-07-19: **`scores(axis='founder')` — owner is FEATURE 04.** 03 writes `founder_score` only
  (person-scoped, persistent); 05 owns `trust`; 07 owns `thesis_fit`; **02 writes no axis at
  all.** ⚠️ **Exactly one feature may write a given axis** — `scores` has no
  `(subject, axis)` uniqueness and «current» resolves by max `computed_at`, so two writers race
  silently. 04 composes the `founder` axis from `founder_score` + founder-market-fit +
  competitor-knowledge maturity — never a copy of `founder_score` (01 design §4.1) — and must
  handle 03's `insufficient_evidence` branch by writing no row rather than inventing one.
- 2026-07-19: **claim topic vocabulary** defined by 03 design §4.7 — `founder.execution.*`,
  `founder.expertise.*`, `founder.leadership.*`. Binding on **02**, which must emit claims under
  these prefixes and must always populate `evidence.raw_signal_id` (03's negative-capability
  guard is load-bearing on it).
- 2026-07-19 ~04:06 · **04** — `db/seed.sql`: +2 `signal_sources` rows (`tavily_search`,
  `tavily_news`, both `base_tier='discovered'`). INSERT only, no schema change.
- 2026-07-19 ~04:07 · **04, CROSS-CUTTING** · `db/tests/smoke.sql`: registry assertions were
  **exact-count**, which contradicts 01 design §4.1's promise that registries are extensible by
  INSERT — the first feature to add any registry row tripped them. Changed to
  **presence-of-canonical-slugs + floor**. Adding a registry row is now safe and needs no smoke
  edit. **Do not tighten these back to exact counts.**
- 2026-07-19 ~05:30 · **07** — `db/tests/smoke.sql` shared table list extended in place with
  `thesis_evaluations`; 07's assertions use id range `…0970`–`…0979`.
- 2026-07-19 ~05:30 · **07 → 02, ACTION NEEDED.** `applications.thesis_gate` stays at three
  values, but **NULL is now a reachable post-gate state**: on `insufficient_evidence` the gate
  writes `thesis_gate = NULL` plus a `thesis_gate_insufficient_evidence` event, and writes no
  `scores` row. Also: call the gate with `mode:'keyword'` in Tier 1 — **it never returns
  `passed` by design**, and `failed` is rare (every compiled rule is `soft`; one hard rule in the
  starting thesis), so the gate is **not** a volume filter.
  *(02 has consumed this: design §5.5 now branches four ways on the returned `verdict` —
  `passed | borderline | insufficient_evidence` advance, only `failed` stops.)*
- 2026-07-19 ~05:30 · **07 — claim topic prefix `company.*`** (`company.sector`,
  `.business_model`, `.geography_country`, `.stage_evidence`, `.what_is_built`). Gaps use the
  **base topic** with `verification_status='missing'`, not a `.gap` suffix.
- 2026-07-19 ~05:30 · **07 — `scores(axis='thesis_fit')`, sole writer is 07.** «Current» resolves
  per `(application_id, axis, thesis_id)` — several theses can be active at once. Query
  convention, not a constraint.
- 2026-07-19 ~05:35 · **CROSS-CUTTING, from 07's QA gate — no RLS anywhere in this project.**
  `anon` has INSERT/UPDATE on every table. The append-only guarantee is NOT weakened (QA tested
  as real `anon`/`authenticated`/`service_role` via `SET ROLE`: `forbid_mutation` held for all
  three, and a forged `vcbrain.purging` GUC as `anon` was still rejected).
- 2026-07-19 ~06:25 · **02, CROSS-FEATURE — supersedes 01 design §9.** 01 §9 says 02 writes
  «raw_signals + metric_observations + founder_identities **only**». Stale: 03 reads via
  `claims JOIN cards ON … WHERE cards.founder_id = $1` and `claims.card_id` is `NOT NULL`, so 02
  must also write **`cards`, `claims`, `evidence`** (plus `founders`, `companies`,
  `founder_company`, `applications`, `events`) or nothing it collects is visible to scoring.
  See `02/design.md` §5.0 rules 0–3.
- 2026-07-19 ~06:25 · **02 → 08 — `applications.artifact_links` key shape is now fixed.** 02 is
  the first writer because 07's keyword-mode gate needs a payload in tier 1. Shape
  (`02/design.md` §5.5b): `{source, hn_item_id, hn_url, title, story_text, artifact_url,
  artifact_kind, repo:{owner,name}, homepage}`, `artifact_kind ∈ github_repo|github_user|product|none`.
  **08 reads this for intake pre-fill** — extend additively, do not reshape.
- 2026-07-19 ~06:25 · **02, CROSS-CUTTING GDPR — `raw_signals` rows must carry an FK at insert.**
  `purge_founder()` deletes `raw_signals` only by `founder_id`/`company_id`, and the table is
  append-only, so a NULL FK **can never be backfilled** and the row survives erasure permanently.
  Fixed in 02 by creating entities before the raw write. **Applies to every feature.**
- 2026-07-19 ~06:25 · **02** — `db/seed.sql`: +7 `metric_kinds` (`gh_followers`,
  `gh_notable_followers`, `gh_forks`, `gh_dependents`, `hn_karma`, `hn_comments`,
  `hn_author_replies`); `hn_points` and `site_updated` **reused, not duplicated**.
  `db/schema.sql`: + `CREATE OR REPLACE VIEW radar_candidates` (marked `-- Feature 02:`).
- 2026-07-19 ~06:40 · **02 → 04, ACTION NEEDED (found by a live DB audit).** Two whole-table
  checks found violations belonging to 04 (02's own rows: 47 `raw_signals`, zero offenders):
  1. **9 `raw_signals` rows with `source='tavily_extract'` have BOTH FKs NULL** — permanently
     unreachable by `purge_founder()`, i.e. they survive a deletion request. Same defect class as
     the GDPR rule above.
  2. **3 `evidence` rows have `raw_signal_id` NULL**, on `competition.competitor` claims. 03's
     guard resolves a claim's source through that column; failing, it falls back to
     `claims.source_kind`, and **`public` maps to «any source (wildcard)»** — which licenses a
     `not_met` verdict on criteria the evidence says nothing about. REQ-003 inverted.
  Reproduce: `select count(*) from raw_signals where founder_id is null and company_id is null;`
  and `select count(*) from evidence where raw_signal_id is null;`
