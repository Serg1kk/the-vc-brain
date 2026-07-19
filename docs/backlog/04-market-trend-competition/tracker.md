# 04 · Market, Trend & Competition Intel — Execution Tracker

> **STATUS: IN BUILD** — operator go 2026-07-19 ~04:05; operator asleep since ~04:04,
> orchestrator running autonomously.
>
> ⏱ **Timestamp correction (04:26):** entries below were originally written with clock
> estimates that had drifted ~1h fast. Corrected against agent message timestamps. Real
> elapsed: session opened 03:11, this correction at 04:26. Deadline 16:00 → ~11.5h remained
> at correction time.
> Plan: [plan.md](plan.md) · Spec: [design.md](design.md) rev.3.
> **Single writer of this file: the orchestrator (main session).** Agents report to the
> orchestrator; the orchestrator updates on every dispatch, completion, failure and commit.
> Purpose: full recovery picture after any crash.

## Task board

| # | Task | Executor | Depends on | Status | Result / commit | Notes |
|---|------|----------|-----------|--------|-----------------|-------|
| A1 | Registry seed (2 `signal_sources` rows) | @database-engineer | — | **DONE** | seed diff applied, 2 rows live, double-apply is a true no-op | **Found a cross-feature blocker:** smoke.sql asserted exact registry counts, contradicting 01 §4.1 extensibility — any feature adding a registry row trips it. Agent correctly stopped instead of editing a shared file. Orchestrator authorized presence+floor fix (not a count bump, which would re-break for 02/08/11). Announced in `docs/backlog/TRACKER.md`. |
| A2 | AI agent specs ×3 (`ai-agent-builder`) | orchestrator in role → delegated generation | — | **DONE — 15/15, verified** | schema valid + matches §3.3 field-for-field; guardrails (abstention, source_url, ranges, verbatim, incumbent-prohibition, unnamed-competitors) present in all three | ∥ with A1; EAP structure read by orchestrator, guardrails from §9 handed over verbatim |
| B1 | `lib/f04/scoring.js` + tests | @backend-developer | none (dep on A2 was not real) | **DONE — 92 tests, 0 fail, verified by orchestrator** | | **the gate that matters** — property test for §6.0; +`founderAxisScore` after the §6.6 scope change |
| B2 | `lib/f04/config.js` (constants) | @backend-developer | — | **DONE** | | **merged into the B1 dispatch** (orchestrator): scoring.js imports config.js — splitting one tightly-coupled module across two agents would collide on the same directory |
| C1 | n8n `f04-market-intel` | **orchestrator (taken over)** | B1, B2 | **DONE — id XVGJRXDHT8HMvxbv, 8 nodes, validator functionally tested** | | **C1+C2 merged into one dispatch** (orchestrator): they share the Execute Workflow contract and two agents would diverge on the interface. Started before B1 lands — topology first, Code-node bodies pasted in when `lib/f04` exists. |
| C2 | n8n `f04-competition-intel` (sub-wf) | @n8n-workflow-builder | C0 | **in progress** | | merged into the C1 dispatch, same owner |
| C0 | n8n `f04-db-write` (shared sub-wf) | **orchestrator (taken over)** | B1b | **DONE — id 3tKU8GFFkmSOiJBG, 7 nodes** | | promoted ahead of C1/C2 (plan-review CRITICAL: the original order was circular) |
| D1 | End-to-end run, 1 real company | @backend-developer | C3 | pending | | credits ≤ 15, pinned end_date |
| E1 | Adversarial QA gate | @qa-engineer | D1 | pending | | 8 required attacks; `qa-report-04.md` |
| R1 | Plan review | @implementation-plan-reviewer | — | **DONE — ❌ CHANGES REQUIRED, all applied → plan rev.2** | | 4 CRITICAL (C3 circular dep · `market.outlook` built nowhere · §3.2 vocabulary unowned · git absent) + ~15 MAJOR. **Caught an orchestrator error: the §6.0 test criterion was stated backwards.** |

## Design review history (phase 1, closed)

| Round | Reviewer | Verdict | Outcome |
|---|---|---|---|
| 1 | spec-reviewer-04 | ❌ CHANGES REQUIRED | 10 CRITICAL + 12 MAJOR + 9 MINOR → all applied in rev.2 |
| 2 | spec-reviewer-04 | ❌ CHANGES REQUIRED | 6 CRITICAL + 6 MAJOR + 6 MINOR → all applied in rev.3; CR-1/CR-2 found independently by the orchestrator before the review landed |
| 3 | spec-check-04b (fresh context, narrow brief) | running | judging the one disputed calibration + a final arithmetic/conformance audit |

**One reviewer recommendation deliberately rejected** (operator informed, ~03:58): recalibrating
§6.2's shares to break the `concentrated`-tier gate coincidence. Rejected because the proposed
calibration pushes ceiling PASS to $5B/$10B/$20B, failing nearly every pre-seed market and
making §7 fire constantly. The coincidence is instead documented explicitly in §6.2 with its
reasoning. Isolated in `config.js` → reversible as a constant change if judged wrong later.

## Empirical findings that changed the design

1. Live `/search` proved our OSS reference for TAM (VCI) targets exactly the domains
   practitioners call unusable → §1 rewritten, blocklist added.
2. Blocklist probe surfaced `astuteanalytica.com`, a report mill **not on the list** → static
   enumeration can never be complete → §3.4 unknown-domain **default-deny to `inferred`**.
3. `topic=news` returned `published_date` on 10/10 results (RFC 1123, not ISO) → momentum is
   computable; parsing note recorded in §5.
4. Orchestrator's own grid recomputation caught 3 of 6 wrong ceiling breakpoints in rev.2 and
   an undocumented reverse-direction gate disagreement.

## Cross-terminal events (feature 04 is not the only writer in this repo)

1. **Scope addition — 04 now owns `axis='founder'`** (operator approved ~04:02). Feature 03's
   terminal established that 03 writes `founder_score` only, leaving the application-scoped
   `founder` screening axis unowned — without it REQ-002's three axes are two. 03's reasoning
   for not writing it itself is sound (it would race us on a table with no
   `(application_id, axis)` uniqueness, and leak person data past GDPR erasure for multi-founder
   companies). Composition specified in design §6.6: `founder_score` + founder-market-fit
   (SIG-026) + competitor-knowledge maturity (SIG-024, reused from §8). **04 now writes three
   `scores` rows per run, not two.**
2. **`purge_founder()` collision risk.** Feature 03's design says it edits the same function in
   place in `db/schema.sql`. @database-engineer was instructed to re-read the function from disk
   before editing and integrate rather than overwrite, and to stop and report if the current
   version is ambiguous.
3. **`db/tests/smoke.sql` registry assertions fixed for everyone** (see backlog TRACKER.md).

## Cross-feature bug found by feature 04's review — affects 05/06/08 too

**`purge_founder()` breaks with 23503 on application-scoped `ai_runs`.** `ai_runs.application_id`
and `.company_id` are `ON DELETE RESTRICT`, but the function deletes `applications` and
`companies` *before* `ai_runs`, and sweeps `ai_runs` only by `founder_id`. Feature 04 is the
first writer of rows with `founder_id NULL, application_id` set, so the first GDPR/opt-out purge
of such a founder aborts. Feature 01's QA missed it because its smoke only ever inserted
`ai_runs` with `founder_id`. Verified against schema.sql by the orchestrator before dispatch.
Fix + a regression smoke case dispatched to @database-engineer.

## Event log

> Times are Europe/Minsk. Verified against agent message timestamps (UTC+3) at 04:26 after an
> earlier drift of ~1h was noticed and corrected.

- **03:11** · session start; phase 0 opened, 3 research agents dispatched (OSS scout, Exa, NotebookLM).
- **03:20** · NotebookLM agent's parallel fan-out failed (auth-path bug → 9 stub answers); re-run
  sequentially → 10/10 real answers, with honest grounding caveats reported.
- **03:30** · Tavily probes: live `/search` proved our OSS TAM reference targets report-mill
  domains; `topic=news` returned `published_date` 10/10; blocklist verified; `astuteanalytica.com`
  surfaced as an unlisted mill → default-deny tier rule added.
- **03:50** · operator decisions: scope **A+**, competitors stored as **claims** (zero migrations).
- **03:52** · design.md rev.1 written; spec-reviewer dispatched.
- **03:55** · provenance correction — NotebookLM's threat/switching rubrics were model-authored,
  not sourced; relabelled as our own rubric (agent-reported, self-caught).
- **03:56** · review round 1 → rev.2 (10 CRITICAL closed).
- **03:57** · orchestrator independently recomputed §6.2 and found 3 of 6 wrong breakpoints;
  review round 2 confirmed → rev.3 (6 CRITICAL closed).
- **03:58** · spec-check-04b (fresh context) → CHANGES REQUIRED: **upheld** the §6.2 calibration
  against round 2's objection and sharpened it (gates coincide only at PASS; WATCH floors differ,
  so the tier is not degenerate); found the `purge_founder`/`ai_runs` CRITICAL, the stale factor
  column, and a real §6.0 violation via undated news. All applied.
- **04:00** · plan-review R1 → CHANGES REQUIRED → plan rev.2. Caught an **orchestrator error**
  (§6.0 criterion stated backwards) and three specified-but-unbuilt items (`market.outlook`,
  the §3.2 topic vocabulary, `independentDomainCount`).
- **04:02** · cross-terminal scope addition accepted: 04 owns `axis='founder'`; design §6.6 written.
- **04:04** · **operator went to sleep, delegating full autonomy.** Standing rules: depth over
  polish; cut stretch goals before invariants; nothing irreversible (no push, no force, no
  cross-feature edits without a tracker entry).
- **04:05** · **operator go**; tracker created; Stage A + plan review dispatched.
- **04:06** · `purge_founder` fix verified on disk in correct order (ai_runs before
  applications/companies); full smoke green.
- **04:07** · A1's smoke.sql exact-count blocker → presence+floor fix authorized and announced
  in backlog TRACKER.md (cross-cutting: unblocks 02/05/06/08 too).
- **04:10** · **n8n had never been bootstrapped** (0 users, first-run setup pending) — that, not
  agent failure, explains the quiet hour. Owner + API key + `$env.*` secrets created; announced
  in backlog TRACKER.md so other terminals do not repeat setup.
- **04:15** · B1/B2 DONE, 92 tests verified by orchestrator. Commits 3ae789f (db) + b901117
  (scoring core) via @devops. No push, per standing instruction.
- **04:22** · A2 DONE 15/15 — the competitive-analyst schema had been blocking the n8n builder,
  which had started hand-deriving it from the prompt; divergence avoided.
- **04:24** · **caught a red build the agent had reported as green**: `provenance.js` split +
  two renames left `scoring.test.js` importing moved symbols → 68/92. Orchestrator fixed the
  imports with aliases → 92/92 again. Second instance this session of a report diverging from
  disk state; every agent result is re-run rather than read.
- **04:26** · timestamp drift (~1h fast) noticed and corrected across this file. ~11.5h to
  deadline. n8n builder validating the API with throwaway smoke workflows before the real build.
- **04:45** · orchestrator **took over the n8n build** after ~1h with no workflow registered and
  three unanswered status checks. Built `f04-db-write` (7 nodes) and `f04-market-intel`
  (8 nodes) as a **generator** (`n8n/build-workflows.py` + `workflow_defs.py`) rather than
  hand-written JSON: the scoring core is unit-tested in `lib/f04`, n8n Code nodes cannot
  `require` local files, so the source is inlined — and hand-edited JSON would let the tested
  module and the running workflow drift apart. The generator `node --check`s every node and
  immediately caught an inlining collision (config + scoring re-declaring the same consts).
- **04:50** · validator node functionally tested outside n8n against the **real abstained sizer
  output** from the live probe: `value=50` (UNKNOWN base, not FAIL 25 — REQ-003 held on live
  data), `confidence=0.09`, six missing_flags, `size_bottom_up` and `why_now` written `MISSING`.
  Verified the fabrication-by-label guard: score 50 + UNKNOWN TAM → `undetermined`; score 50 +
  measured WATCH TAM → `neutral`. Same number, different label, because one is measured.
- **04:55** · commits cad7ab1 (provenance/founder-axis/tier-counting) + 9edc5bd (workflows).
- **05:00** · **near-miss caught:** `provenance.js` uses global `new URL(...)`, which the n8n
  Code-node sandbox does not expose — `NODE_FUNCTION_ALLOW_BUILTIN=url` permits `require('url')`
  but injects no global. It passes every syntax check and throws ReferenceError only at
  runtime, i.e. it would have failed first in front of judges. Generator now prepends a
  `const { URL } = require('url')` shim; both workflows redeployed.
- **05:20-06:20** · **D1 integration: seven debug rounds, all seven bugs hidden behind `status: success`.**
  n8n reported success while the database stayed empty; only checking rows caught it. In order:
  (1) all 33 Supabase URLs missing `/rest/v1` → Kong 401, error body flowed on as data;
  (2) 17 Code nodes tested `Array.isArray($input.first().json)` — n8n unwraps a JSON array into
  separate items, so that is the first *object* and the test is always false, silently nulling
  every lookup; (3) PostgREST replies arrive in **four** shapes from one node type (bare array /
  unwrapped items / `{body}` / `{data:"[]"}` as an unparsed string) — one normaliser now handles
  all four; (4) 17 GET nodes lacked `alwaysOutputData`, so an empty result — the *normal* case for
  select-then-insert — killed the branch; (5) the n8n public API **strips** `alwaysOutputData` and
  `options` on PUT, so the working deploy sequence is **CLI `import:workflow` → PUT → activate**;
  (6) a prompt-builder overwrote `documents` with its stringified form, crashing the next node on
  `.map` *after* the LLM had already run and spent credits; (7) `$env.SUPABASE_URL` was changed
  mid-flight to already include `/rest/v1`, so my own fix double-applied — two correct fixes to
  one problem produced a third bug. Convention now pinned in a code comment.
- **06:20** · **END-TO-END GREEN (exec 44, 78 nodes).** Real company (Medows, Show HN, pre-seed,
  deckless radar entry). Found **MEDITECH / Oracle Health / Epic (incumbent) + Microsoft Nuance
  DAX (adjacent)** — none named by the founder, which is the feature's headline output. Wrote
  honest gaps everywhere else: `size_bottom_up` missing, `why_now` missing, `growth` missing,
  **`market.outlook = undetermined`** (fabrication-by-label guard firing in production).
  `market` 50 @ confidence 0.00, `idea_vs_market` 50 @ 0.18-0.37 — absence moved confidence, never
  the score. Terminated correctly at `SKIP: no founder_score row (not assessed)` per §6.6.
- **06:25** · Workflow ownership resolved: the builder's **108-node market-intel + 61-node
  competition-intel are the keepers** (proper visual graphs per CLAUDE.md; they implement §7, both
  error branches and §6.6, which my 8-node stopgap did not). My stopgap is deleted;
  `workflow_defs.py` trimmed to emit **only** `f04-db-write` so it can never overwrite them.
- **06:25** · Agent schemas fixed **at source** and verified against the live OpenAI API in
  `strict: true` — all three ACCEPTED. `oneOf`→`anyOf` (nullable pattern), dropped unsupported
  `format:"uri"`, completed `required` with nullable types. Replaces the builder's in-memory
  patching, which would have left specification and running system quietly disagreeing.

## Defects raised and then RETRACTED — orchestrator attribution error

I reported two defects to the workflow builder and both were **my analysis errors, not bugs in
the build**. Recorded because the reasoning matters more than the outcome:

1. «`raw_signals.company_id` NULL on 16 rows» — those rows are **feature 03's**, not ours. They
   are `source='tavily_extract'` and founder-scoped (Pieter Levels ×6, Devon Ashworth ×1). I
   assumed every `tavily_*` row was ours because we own the `tavily_search`/`tavily_news` slugs,
   but `tavily_extract` was seeded by feature 01 and 03 uses it. Feature 04 wrote **zero**
   raw_signals on exec 44 — correctly, since the sizer abstained and Q5 failed, so there was
   nothing to write. The builder's `__noop` sentinel handled it exactly as designed.
2. «`evidence.raw_signal_id` NULL» — same suspected misattribution; deferred to QA to test on a
   run where the sizer actually produces evidence, rather than asking for a fix on a guess.

Lesson worth keeping: owning a *source slug* is not the same as owning the *rows*. Check
attribution before assigning a defect — an agent sent hunting a bug that isn't in its code loses
the same hour as one that is.

## Cross-feature finding raised to feature 03 (real, not ours)

9 `raw_signals` rows have **both** `founder_id` and `company_id` NULL. `purge_founder()` sweeps
that table by one or the other, so such rows are **unreachable by GDPR erasure** and survive a
purge with `source_url` and `payload` intact — breaking feature 01 §5.4's «single deletion door»
guarantee. Writer belongs to 03's terminal; recorded in `docs/backlog/TRACKER.md` so it does not
ship.

- **06:45** · Workflow ownership settled for good. The builder twice constructed detailed theories
  on false premises (that a third party was competing with it; that my deleted stopgap was «someone's
  refactor of my work»). Corrected both times with verified ground truth rather than argument:
  `XVGJRXDHT8HMvxbv` returns 404, three f04 workflows are live, two are the builder's and canonical.
  Declined its proposal to refactor `f04-competition-intel` onto the shared write sub-workflow —
  correct as engineering, wrong as a trade with ~9h left. Recorded post-MVP.
- **06:50** · Commit a130c03 supersedes the stale 8-node artifact in 9edc5bd; verified nothing from
  `db/` or feature 03 was staged.
- **06:55** · **E1 QA gate dispatched** — 10 required attacks plus free hunting, explicitly told not
  to re-run the developer's own tests.

## FEATURE COMPLETE — 2026-07-19 ~09:05

**QA gate PASSED.** All 10 adversarial attacks executed; no invariant broke under pressure.

Final state: 141 unit tests green · `f04-market-intel` (111 nodes), `f04-competition-intel` (64),
`f04-db-write` (7) all live and matching disk · 15 agent artifacts, schemas accepted by the live
OpenAI API in strict mode · zero schema migrations.

### Three post-QA fixes, all verified before deploy

1. **`independentSourceCount` swapped in for `independentDomainCount`** on the §6.5 confidence
   cap. Domain counting rated two *different* report mills as 2 independent sources, clearing the
   ≤0.55 cap — when the rule exists precisely because two mills agreeing is one number laundered
   twice. Caught my own error mid-fix: the call site was updated before the inlined bundle
   exported the function, which passes every syntax check and throws only at runtime.
2. **`quote_verbatim` carried into competitor evidence** (builder). Two loops wrote rows for the
   same claim; one hardcoded `null` without checking whether the other had the quote. This is the
   RSK-003 verbatim layer and the «click any number, see the sentence» demo beat.
3. **Evidence deduped by `(claim, relation, source_url)`.** The builder flagged this as cosmetic
   and did not fix it; verification showed it was not. `evidenceCt` is derived from the plan's
   item count, and confidence rises steeply with it (1 → 0.452, 6 → 0.910, cap 6). One URL
   appeared **6×** on a single competitor claim, reporting maxed-out confidence off a single
   source — the same «one source counted repeatedly as independent support» failure that §3.4
   rule 2b exists to prevent, committed by our own writer. A later row carrying a quote now
   upgrades the earlier bare one in place instead of adding a duplicate.

### Deliberately NOT fixed (recorded in handoff.md)

- Intermittent duplicate `scores(idea_vs_market)` in one execution — harmless under append-only
  semantics («current» = max `computed_at`); the proper fix is a `content_hash` guard on `scores`,
  i.e. a schema change, which is the wrong trade at this hour.
- `supersedes_claim_id` NULL on all claims **DB-wide** — a shared gap across features, not ours
  to close unilaterally.

### Two QA findings corrected by independent verification

QA reported `evidence.raw_signal_id` NULL «on every row» and `quote_verbatim` at «0/3». Scoped to
feature-04 rows both were wrong in detail: 8 of 11 linked (the 3 unlinked all predate the Merge
fix), and 2 of 11 quoted. The same attribution trap I fell into earlier — in a database shared by
four features, an unscoped query does not say what it appears to say.

### Final state, verified 09:30

Last live run: 3 evidence rows / **3 distinct (claim,url) pairs** — dedupe holds — all 3 linked
to `raw_signals`. `idea_vs_market` 50 @ 0.28, `market` 50 @ 0.00. Founder axis correctly absent.

**The builder's dedupe implementation replaced mine and is strictly better.** Mine keyed on
`(claim, relation, source_url || '')`, which would have collapsed multiple `context`/`missing`
rows on one claim into a single row — quietly destroying exactly the honest-gap records REQ-004
exists to produce. Its version excludes rows without a `source_url` from the dedupe entirely.
It also caught a regression in its own earlier quote fix: the `marker|url` lookup did not filter
by relation, so a `contradicts` quote could be attached to a `supports` row for the same URL.

**QA corrected its own finding too** — `quote_verbatim` «never populated (0%)» was measured in the
same pre-fix window as the raw_signal_id bug and was entangled with it. Fresh post-freeze
sampling: ~40% (8/20), inconsistent within a single run. Still open, still MAJOR, but the honest
number is «inconsistent», not «never». Both agents correcting their own reported findings, unprompted,
is the single best process outcome of this feature.

### Open, recorded, not fixed
- NEW-1 `scores(idea_vs_market)` intermittent double-write (~1 in 5 runs) — no `content_hash` on
  `scores`; harmless under append-only, fix is a schema change.
- NEW-2 `quote_verbatim` populated ~40% of the time — depends on agent output, not the write path.
- NEW-3 `supersedes_claim_id` NULL DB-wide — shared gap, not 04's to close alone.
All three are in `handoff.md` so 05/06 inherit the knowledge rather than rediscovering it.
