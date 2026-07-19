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
| 04 | market-trend-competition | **done** (QA gate PASSED · 141 unit tests + adversarial gate · commits `a130c03`/`2be26f9` · n8n `f04-market-intel`/`f04-competition-intel`/`f04-db-write` · see `04-market-trend-competition/handoff.md`; 3 known-open non-blocking items NEW-1..3 recorded there) | 01-schema (no schema additions needed) | 05, 06 | 1 |
| 07 | thesis-engine | **done** (QA report present, `handoff.md` written) | 01-schema | 02 (gate), 09 | 1 |
| 05 | truth-gap-trust | **spec** (design.md written ~09:30, in spec review; approach B — full claim router) | 03 & 04 output contracts | 06 | 2 |
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

## Wave-1 closed · Wave-2 dispatch plan (orchestrator, 2026-07-19 ~08:50, T-7h to deadline)

**Wave 0+1 are complete: 01, 02, 03, 04, 07 — all five with a PASSED QA gate.**
04 was still marked «in-build» above until now; its gate passed and its code landed as
`a130c03` + `2be26f9`. Its docs (`design.md`, `plan.md`, `handoff.md`, `qa-report-04.md`,
`tracker.md`, `agents/`, `evidence/`) are still **untracked** — same git-hygiene gap as the
🔴 OPEN section, to be swept into the next @devops commit.

**Unblocked right now:** 05 (03+04 handoffs exist), 08 (01+02, `applications.artifact_links`
shape frozen in `02/done.md`), 10 (01 schema is live), 09-design-track, 12-compose-base.

**Recommended concurrency: 3 terminals, not 4.** The ~06:45 loss happened with four terminals
writing shared files; 05 and 06 both touch scoring/claims paths, and every extra terminal adds
another writer to `db/*.sql`, this file and the shared n8n instance. Three is the point where
parallel gain stops paying for coordination risk at this hour.

| Order | Feature | Why now | Notes for its terminal |
|---|---|---|---|
| **A (start first, critical path)** | **05 truth-gap-trust** | The only thing standing between here and 06 → 09. Everything downstream of it is serial. | Inherits 04's three open items (NEW-1..3) and 02's two ACTION-NEEDED items (NULL FKs on `tavily_extract` rows, NULL `evidence.raw_signal_id`) — those are 05's raw material, not bugs to route back. Sole writer of `scores(axis='trust')`. |
| **B (longest lead time)** | **09 investor-dashboard — design track only** | UI is 15% of the rubric but 100% of the demo video. Its design phase needs no upstream data; only the wiring does. | @designer in-role brainstorm → design.md now; build starts when 06 lands. Do **not** let it block on 05/06. |
| **C (pick one)** | **08 founder-intake** *or* **10 api-cli-skill** | 08 unblocks 11 (demo data + ethics/opt-out) and is a visible demo beat. 10 is thinner and can be squeezed later. | Default pick: **08**. Reads `applications.artifact_links` for pre-fill — additive extensions only. |

**Serial after that:** 06 (needs 05) → 09 build → 11 (needs 08) → 12 final. 10 slots in
anywhere it fits; if the clock tightens, 10 is the first to drop, then 09's polish — never
05/06 (data + reasoning = 55% of the rubric).

**Before dispatching anything:** @devops sweeps the untracked docs of 03 and 04 plus this file
into one commit. Four terminals editing uncommitted shared files is exactly the ~06:45 setup.
Also still unresolved and operator-only: 07's publication finding above (`docs/` is tracked and
would go public on the first push) — **do not push until the operator rules on it.**

## ✅ RESOLVED: the publication question (operator ruling, 2026-07-19 ~09:00)

07's tracker raised a blocker before the first push: `docs/` is tracked and would go public,
contrary to what CLAUDE.md claimed. **Operator has ruled: `docs/` is published — that is fine.**
Option (b) of the three 07 listed: the design process ships as part of the submission's
transparency story. `session-history/` is the one thing that stays local, and it was already in
`.gitignore` (a new local copy of the challenge's session logs now lives there).

Consequences for every terminal:
- **The push freeze is lifted.** `main` is 16+ commits ahead of `origin/main`; @devops can push.
- **Write `docs/` as if judges will read it — because they will.** No closed-corpus quotes, no
  source attribution from the intel base, no third-party names (Hard rule #1). QA reports and
  trackers are in scope for this: they are the most candid documents we have.
- CLAUDE.md's Git section has been corrected; it had listed `docs/` as ignored, which never
  matched the actual `.gitignore` file and cost 07 a real blocker.

## 2026-07-19 ~09:48 · 10 → 02/09, CROSS-FEATURE BUG FIXED (append by terminal 10)

**`radar_candidates` aborted any query that materialised `obscurity`.** The view computes
`log(1 + hn_karma)` with no domain guard. One founder (`d2e2c8fb-3abc-4f31-9c65-66ecc16066e4`) has a genuine latest `hn_karma = -2` — HN karma legitimately goes negative when a
user is downvoted, so this is real data, not corruption — and `log(-1)` raises
`ERROR: cannot take logarithm of a negative number`, which aborts the whole statement.

**Why nobody caught it:** `select count(*) from radar_candidates` succeeds, because the planner
prunes the unused column. It only fires when `obscurity` is actually materialised, e.g.
`select count(*), count(obscurity) from radar_candidates`. 02's smoke tests use the former shape.

**Blast radius:** it blocked feature 10's `api_founders` outright, and would equally have blocked
**09's dashboard** and **02's own radar feed** the moment either rendered the obscurity column.

**Fix, applied by terminal 10 inside `CREATE OR REPLACE VIEW radar_candidates` in `db/schema.sql`,
marked `-- Feature 10 fix to a Feature 02 object`:** floor the log arguments —
`log(1 + GREATEST(hn_karma, 0))`, same guard on `gh_followers`. **Nothing else about the view
changed** — not the formula shape, not the divisors (3 and 4), not the NULL-vs-0 semantics that
carry 02's REQ-003 reasoning, not `obscurity_basis`. Semantics of the clamp: karma ≤ 0 →
`karma_term = 1` → maximally obscure, which is what the metric already means for a user with no
visibility.

Feature 02 is closed and has no live terminal, so terminal 10 took the call rather than leaving a
known-broken shared object in place. If 02 is ever reopened, this is the one edit made to its DDL
from outside.

### Also from 10, for whoever owns them

- **`scores(axis='founder')` has ZERO rows database-wide.** 04 owns that axis and never wrote one.
  10's `api_applications.score_founder` therefore reports `assessed: false` on all 308 rows. **This
  will equally hit 06 (memo) and 09 (dashboard)** — an absent axis must read as "not assessed",
  never as zero.
- **`claims.verification_status='verified'` is 0** database-wide (690 unverified, 34 missing) since
  05 has not landed, so verification status cannot be used as a ranking or trust signal yet.
- **`scores(axis='founder_score').missing_flags` is an array of OBJECTS**
  (`{criterion_id, what_would_close_it}`), not of strings. 03's `done.md` says "array", which is
  true of the container but misleading about the elements. `what_would_close_it` is worth surfacing
  — 10 exposes it as `api_founders.founder_score_gaps`.

## 2026-07-19 ~10:15 · 08 — ANNOUNCE BEFORE EDIT: `infra/n8n/docker-compose.yml` (shared file)

08 will add **two env vars** to the shared n8n service, both currently unset (verified with
`docker exec vcbrain-n8n printenv`), both affecting every feature's webhooks:

- **`N8N_CORS_ALLOW_ORIGIN`** — the SPA in `web/` runs on its own dev-server origin and posts to
  `localhost:5678`. Without this, **every browser call fails and every curl test still passes** —
  which is what makes it expensive to find. Any feature exposing a webhook to the frontend needs
  it, so this is a shared win, not an 08-local hack.
- **`N8N_PAYLOAD_SIZE_MAX=192`** (default is 16 MB) — 08's intake contract carries the deck and
  up to three extra files as base64 in one JSON request. Operator decision: raise the limit
  rather than shrink the already-built frontend contract. Docker VM has 7.7 GB and the container
  is unlimited within it, so the headroom is real. 08 additionally uploads extra files to Storage
  first and drops their base64 from the item, so the large payload does not propagate through
  the workflow.

**Impact on you: none expected** — both are additive and neither changes existing node behaviour.
Shout here if raising the payload ceiling is a problem for your workflow.

## 2026-07-19 ~10:15 · 08 — CROSS-FEATURE facts established by 08's spec review

Four of these came out of an adversarial review of 08's design and were verified against the
live environment. They bind more than 08:

1. **No Supabase Storage bucket exists** — `GET /storage/v1/bucket` returns `[]`, and nothing in
   the repo has ever called the storage API. `db/apply.sh` does **not** create one, so the
   cold-start sequence in `CLAUDE.md` will not either. 08 creates `decks` (private). Any feature
   storing a file must provision its own bucket and add it to the cold-start docs.
2. **`purge_founder()` does not delete Storage objects.** Erasure removes the `applications` row
   holding `deck_storage_path`, so an uploaded file becomes both undeleted and unfindable. Same
   defect class as 02's NULL-FK `raw_signals`, one layer up. Disclosed in 08's design §4.1.
3. **The 07 gap-marker convention tie is broken in favour of `07/design.md:734`** — gaps are the
   **base topic with `verification_status='missing'`**, and that line explicitly states the
   `.gap` wording still present in `07/handoff.md` §4 is wrong. **Consequence for anyone
   computing coverage: exclude `verification_status='missing'` claims**, or you will read an
   explicit absence marker as evidence of presence.
4. **Content hashes must include the application id** where a subject can legitimately recur.
   `raw_signals`/`claims`/`evidence` all carry `content_hash NOT NULL UNIQUE`; a founder
   re-applying with the same deck raises `23505` and fails the whole write unless the hash is
   scoped. Re-application is a new row by design (01), so this is reachable, not theoretical.

## 2026-07-19 ~10:35 · Tooling trap (append by terminal 10) — n8n returns `[]`, not 401, on a bad API key

`GET /api/v1/workflows` with a wrong or empty `X-N8N-API-KEY` returns **HTTP 200 with an empty
`data` array**, not 401. So an authentication mistake is indistinguishable from "every workflow is
gone" — which is exactly how it read the first time, given this repo already lost work once today.

Cause in our case: `N8N_API_KEY` lives in **`infra/n8n/.env`**, not in `infra/supabase/.env`. Source
the right file:

```bash
set -a; source infra/n8n/.env; set +a
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" http://localhost:5678/api/v1/workflows
```

Sanity baseline as of 10:35 — 8 workflows, all active except `f02-radar-scan` (scheduled, inactive
by design): `f02-radar-scan`, `f03-score-founder`, `f04-market-intel`, `f04-competition-intel`,
`f04-db-write`, `f07-thesis-gate`, `f07-thesis-reevaluate`, `f07-db-write`. If you get `[]`, check
your key before concluding anything was lost.

## 2026-07-19 ~10:45 · 08 — ⚠️ CORRECTION: the recorded Code-node sandbox convention is WRONG

The tooling changelog above says: *"For SHA-256 use `globalThis.crypto.subtle.digest('SHA-256', …)`,
not `require('crypto')`."* **That is backwards.** I probed the live sandbox by deploying a throwaway
Code node and reading its output, rather than trusting any document:

```
require('crypto')        -> WORKS    sha256('abc') = ba7816bf8f01cfea (correct)
require('node:crypto')   -> THROWS   Error
globalThis.crypto.subtle -> undefined
new URL(...)             -> THROWS   ReferenceError
Buffer, TextEncoder      -> available
process                  -> undefined
```

**What to actually do in a Code node:** `require('crypto')` with the **bare** specifier and
`createHash('sha256')`. Not the `node:` prefix — that throws. Not `crypto.subtle` — it does not
exist. Every deployed workflow (f03, f04, f07) already does it the working way; only the written
convention was wrong, which is why it went unnoticed.

**`new URL()` genuinely throws** — the original entry was right about that, and it is still true.

### Why nobody noticed, and what it implies for 04 (and anyone auditing)

`n8n/workflows/f02-radar-scan.json` and the three `f04-*` workflows contain `new URL(` in
4 and 6-8 Code nodes respectively. They pass QA and return HTTP 200. They do this **because the
surrounding try/catch swallows the ReferenceError** and returns a plausible-looking fallback —
which is precisely the carried risk 02 documented in its own `done.md`: *"every artifact silently
classified as `kind:'none'` with nothing in the logs."*

So: **a green QA gate on top of a swallowed environment error is what this failure mode looks like
from the outside.** 02 disclosed it. **04 may have the same defect without knowing** — its
`new URL(` calls sit in `Build queries`, `Build market.gap claim hash`, `Curate per bucket` and
`Build raw_signals plan`. If 04's terminal is still active, checking whether those paths are
guarded and what the guard returns is worth ten minutes; a fallback that looks like data is worse
than a crash.

**Cheap general rule this suggests:** do not wrap a whole Code-node body in try/catch. Catch around
the specific operation whose failure you can actually handle, and let a missing global crash the
node — a red execution is diagnosable, a plausible wrong answer is not.

## 2026-07-19 ~10:55 · 08 — RETRACTION + the actual rule (supersedes my ~10:45 entry)

**My ~10:45 entry above is partly wrong. Read this one instead.** I claimed the recorded
`crypto.subtle` convention was "backwards". It is not. I probed a *bare* Code node, saw
`globalThis.crypto` undefined, and concluded the convention was broken — without noticing that
**02 prepends a runtime polyfill** at Code-node-assembly time (`n8n/build-f02-workflow.py`,
`RUNTIME_POLYFILL_JS`). Feature 08's backend agent pushed back with that evidence and was right.

### The actual, fully-probed rule

In a bare Code node: `URL`, `globalThis.crypto` and `process` are **undefined**;
`require('crypto')` (bare specifier) and `Buffer`/`TextEncoder` **work**;
`require('node:crypto')` **throws**. And decisively:
`require('crypto').webcrypto.subtle` → **exists**.

So both `crypto.subtle` and `new URL()` are fine **provided the node polyfills them first**:

```js
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
  globalThis.crypto = require('crypto').webcrypto;
}
if (typeof URL === 'undefined') { globalThis.URL = require('url').URL; }
```

**What was actually missing from the original convention was the word "polyfilled".** Anyone
pasting a lib file into a Code node must either prepend that snippet or inline a guarded copy.
08 inlines it in `lib/f08/hashing.js` rather than relying on a build step remembering to prepend
it, and avoids `URL` altogether in `validate.js`/`identity.js` — both are no-ops under plain Node,
so `node --test` exercises the real path.

### The part of my ~10:45 entry that DOES stand — and it is about 04

I audited every deployed workflow for `new URL()` and whether the same node polyfills it:

| Workflow | Code nodes | uses `new URL()` | of those, polyfilled |
|---|---|---|---|
| `f02-radar-scan` | 8 | 4 | **4 — OK** |
| `f04-competition-intel` | 41 | 6 | **0** |
| `f04-market-intel` | 63 | 8 | **0** |

**02 is fine** — I was wrong to imply otherwise; its historical incident is exactly what the
polyfill was added to fix. **04 has 14 unpolyfilled `new URL()` calls that throw ReferenceError at
runtime.** Whether that surfaces as an error or as plausible-looking wrong data depends on what
catches it. Worth ten minutes from 04's terminal: `Build queries`, `Build market.gap claim hash`,
`Curate per bucket + cap for extract`, `Build raw_signals plan`, `Collect + curate discovery
results`.

**Lesson I'll wear:** I corrected a shared convention on one probe and warned another feature on
the strength of it. The probe was real but the conclusion outran the evidence — the mechanism I
had not looked for was sitting in a build script one grep away.
