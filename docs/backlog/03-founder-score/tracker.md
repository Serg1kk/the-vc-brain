# 03 · Founder Score — Execution Tracker

> **STATUS: IN BUILD** — plan rev 2 self-approved after review round 1; operator asleep from
> ~04:30 with full decision authority delegated to the orchestrator.
> Plan: [plan.md](plan.md) rev 2 · Spec: [design.md](design.md) rev 3 (spec review ✅).
> **Single writer of this file: the orchestrator (main session).** Agents report to the
> orchestrator; it updates on every dispatch, completion, failure and commit.
> Purpose: full recovery picture after any crash.
> **On completion the orchestrator writes `done.md` in this folder** — a second agent polls for
> it to start its own feature (operator instruction, ~04:45).

## Task board

| # | Task | Executor | Depends on | Status | Result / commit | Notes |
|---|------|----------|-----------|--------|-----------------|-------|
| A1 | DDL + purge extension + smoke | @database-engineer | — | **✅ done** | schema.sql L521-572, 658-710, 803-818 | **Orchestrator-verified:** tables live, smoke green, `UPDATE score_components` → P0001 on a real row (empty-table check was a false pass — trigger is per-row) |
| A2 | 4 agent specs (`ai-agent-builder`) | orchestrator in role | — | **✅ done** | `agents/` — README + 4 specs | EAP-structured; each has anchored criteria, explicit negative criteria, ≥2 desired + ≥1 undesired example, JSON schema. `expertise` also emits `pedigree`. All examples invented, never modelled on a real founder (RSK-004) |
| B1 | `lib/f03/scoring.js` + tests | @backend-developer | — | **✅ done** | `lib/f03/scoring.js`, 67/67 across f03, zero imports | Had the same array-vs-object config bug as B2; fixed. **Orchestrator-verified on the LIVE config:** I2 holds on a full 12-component set (value 100→100, confidence 1.0→**0.96**), all-unknown → `insufficient_evidence`/`value:null` without throwing, sparse set → coverage **0.17625** → `insufficient_evidence`, `Σ contribution` matches value (δ 0.00002), 2-dp scale respected |
| B2 | `lib/f03/gate.js` + tests | @backend-developer | — | **✅ done** | `lib/f03/gate.js` + 28/28 tests | **Orchestrator-verified against the LIVE `formula_v1` config, not the agent's fixtures:** registry resolves (12 components, weights correct), absent criteria → `cannot_assess`, and **the REQ-003 guard holds** — a pack with no `github_api` claim coerces both `not_met` verdicts to `cannot_assess`. That is spec-review blocker #3, now closed in running code. Zero imports confirmed. |
| B3a | `formula_v1` → `db/seed.sql` | @database-engineer | A1 | **✅ done** | seed.sql L72-169 | **Orchestrator-verified in DB:** 12 criteria, weights sum exactly 1.00000; per-subscorer 0.40000/0.30000/0.30000 |
| B3b | 3-founder fixture | @database-engineer | — | **✅ done (rev 3)** | `db/fixtures/03-founder-score.sql` — 3 founders, idempotent, 0 NULL `raw_signal_id`/`source` joins | Real founder's claims verified against live sources with quotes + URLs + dates (log #8). Sparse founder reworked to a **single `hn_algolia` source cluster** after the first bound proved unsound (log #18): **orchestrator-verified in the registry** that only L5 (0.06000) lists `hn_algolia` in `neg_src`, so max coverage = 0.06 vs floor 0.25 — a hard arithmetic bound holding for *any* model output, not an observation. Replay confirms `insufficient_evidence` / coverage 0.06. |
| B4 | `lib/f03/run.js` headless runner | @backend-developer | B1, B2 | **✅ done** | `lib/f03/run.js` + `db/fixtures/recorded/pieter-levels/*.json` | One live `--record` run; all 3 founders replay offline. Devon **29.16**/0.53 (R1+R2+R4 fired, 4 verdicts demoted), Kwame **insufficient_evidence** cov 0.17625, Pieter **67.96**/0.63. Replay reproduces value+confidence and correctly returns `trend: null` (same claim set) |
| D1 | E2E on 3 fixture founders | @backend-developer | A1, B3a, B3b, B4 | **✅ done** | folded into B4 | `Σ contribution` vs `value`: Devon δ0.00083, Pieter δ0.00296 — both inside the 0.005 bound; `ai_runs`×4 per run joinable by `run_id`; 12 `score_components` per run |
| C1 | n8n `f03-score-founder` (merged) | @n8n-workflow-builder | A2, B1, B2 | **✅ done** | `n8n/workflows/f03-score-founder.json` + `n8n/build-f03-workflow.py` generator, wf id `AlkzJ70zET7SiHkn`, active | Live run on Devon: **29.04**/0.50, R1+R2+R4 fired, Σcontribution == value exactly. **Orchestrator-verified independently:** no secret literals (only `$env.*`), all 16 gate + 12 scoring functions present in the pasted bodies, SOURCE OF TRUTH headers in place |
| E1 | QA gate (E1a+E1b merged) | @qa-engineer | B4 | **✅ GATE PASSED** | `qa-report-03.md` | All 8 mandatory cases passed with independently-built fixtures. 2 findings, neither an invariant violation. **F1 resolved** by the fixture rework that landed mid-gate — orchestrator re-ran QA's own attack against the current fixture and it now coerces to `cannot_assess` (coverage stays 0.06). **F2 fixed** (stale comment). Verification appended to the report. |
| F1 | Commit | @devops | GATE PASSED | **✅ done (partial, by design)** | `f64b66b` — 22 files | Code, fixtures, recordings, n8n all committed. **`db/schema.sql`, `db/seed.sql`, `db/tests/smoke.sql` deliberately NOT staged** — 07's DDL is interleaved and `smoke.sql` has a genuinely shared line that cannot be split (see decision log #22). Not pushed: operator asleep, publishing not authorised. |

## Decision log (autonomous rulings — operator delegated authority ~04:30)

1. **~04:20 · `scores(axis='founder')` → feature 04, not 06.** I first assigned it to 06, then
   found 04's terminal had already taken it with operator approval and had it inside a dispatched
   task spec, with a richer composition (design §6.6: `founder_score` + FMF + competitor-knowledge
   maturity). Two writers on one axis is a REQ-002 correctness failure, so I withdrew my
   assignment and released 06. Corrected in backlog TRACKER + 03 design §9 + plan.
2. **~04:35 · n8n Code nodes cannot import from the repo.** Verified
   `infra/n8n/docker-compose.yml` mounts only `n8n_data`; no repo bind-mount, no
   `NODE_FUNCTION_ALLOW_EXTERNAL`. `lib/f03/*.js` are therefore self-contained CommonJS with zero
   imports, pasted verbatim into Code nodes behind a `// SOURCE OF TRUTH` header. Matches what
   feature 04 independently did.
3. **~04:35 · Schedule.** Plan review estimated ~10.75h of critical path against a ~10h budget,
   which would leave 05/06/09 with nothing. Cuts taken: merged the two n8n workflows into one;
   moved B1/B2 to T0 (their dependency on A1 was fictitious — `config` is opaque jsonb); split
   B3 into config (B3a, seeded) and fixture (B3b); trimmed QA from 8 cases to 5 and split it so
   DB-level attacks run parallel to n8n. Revised critical path ≈ 6.5-7h.
4. **~04:35 · Added B4 `run.js`.** The plan's stated fallback («lib + fixture + psql demo») was
   false — without the n8n stage nothing ever calls the agents, so no `score_components` would
   exist and there would be nothing to film. A headless runner makes the fallback real, de-risks
   the n8n stage to a thin wrapper, and lets integration pass on recorded agent output instead of
   prompt-debugging against a live API at hour nine.
5. **~04:35 · Test runner pinned to `node --test`**, no `package.json`, no dependencies —
   rather than «check-then-create», which would have had two terminals guessing differently.
   Announced in backlog TRACKER for 04 to adopt.
6. **~04:35 · `formula_v1` moved from fixture to `db/seed.sql`.** It is product configuration, not
   demo data: `apply.sh` runs schema+seed only, so feature 12's cold-start reset would otherwise
   leave `score_formulas` empty and the feature dead.

7. **~04:30 · Three integration contract mismatches — `gate.js` adapts, not the others.**
   Parallel dispatch produced exactly the class of bug it is prone to: B2 started before A2 (agent
   specs) and B3a (seed config) existed, so it guessed. Found by orchestrator inspection of the
   live DB and the finished specs, not by any agent: (a) `config.criteria` is a jsonb **array**,
   gate assumed an object — its `isPlainObject` check made the whole registry read as empty, so
   every criterion would have fallen through as unknown; (b) `config.red_flags` likewise;
   (c) agent output keys are `verdicts`/`flags`/`flag_id` (per A2) vs the assumed
   `criteria`/`red_flags`/`id`. Ruling: **gate.js absorbs all three** and keeps the old shapes as
   fallbacks — the DB config and the agent specs are contracts other features read, so they stay
   put. Also ruled in B2's favour on its two open judgment calls (keep citations on demotion; keep
   `demoted_by` set even when the step-5 re-check reverts — a flag firing is a fact worth
   recording).
8. **~04:35 · Real founder in the fixture must be verified, not recalled.** B3b honestly disclosed
   it had no web tool and had compiled facts about a real person from memory, leaving
   `quote_verbatim` NULL rather than inventing words. Correct instinct, but shipping unsourced
   claims about a living person while pitching «we cite the exact data point behind every claim»
   is the precise hypocrisy a judge would catch — and it left the I6 verbatim-substring path
   unexercised on the only real profile. Orchestrator ran Exa: **facts confirmed**, and real
   quotes with source URLs and dates handed back for a rework pass. Synthetic founders untouched.
9. **~04:30 · `node --test <dir>` is broken repo-wide** — Node's directory-glob resolution trips
   on the space in `.../ProdfeatAI Brand/...`. Affects `lib/f04/` identically, so it is the path,
   not our code. Documented convention corrected to the glob form
   `node --test lib/f03/*.test.js` in plan.md and the backlog TRACKER, so no later agent
   rediscovers it.

10. **~04:45 · A spec error found by verifying rather than trusting.** design §2.3 claimed
    `Σ contribution` reproduces `value` "to within 1e-4". That is arithmetically impossible once
    `value` is rounded to `numeric(5,2)` — the bound is half a rounding step (≤ 0.005). The code
    was right; my spec sentence was wrong. Corrected in design §2.3 rather than bending the code
    to a false claim. Caught because a first, sloppier version of my own check "failed" and I
    re-derived it instead of filing a bug.
11. **~04:45 · The first I2 check I wrote was degenerate.** Passing only 4 components made
    `all_weight` (which is summed over the whole 12-criterion registry, not over the passed array)
    invariant, so adding `cannot_assess` changed nothing and the test looked like a failure.
    Re-run on a full 12-component set — what `gate.js` actually emits — it passes properly:
    value 100 → 100, confidence 1.0 → 0.96. Recording it because the same trap would catch QA.
12. **~04:50 · E1a not dispatched in parallel with C1 as planned.** Its DB-level cases all need a
    way to actually produce a score, which is `run.js` (B4, still in flight). Dispatching QA
    against a missing runner would have burned an agent on flailing. QA now runs as one gate
    (E1a + E1b) once B4 lands. Costs a little parallelism, buys a QA pass that can actually
    execute.

13. **~05:10 · Reported flaky test investigated and dismissed with evidence.** B4 saw one
    `scoring.test.js` failure early in the session, then 6 clean runs. I re-ran the suite 12×:
    49/49 every time. Cause is structural, not statistical — the randomized property tests use
    `mulberry32` seeded with a constant, and neither `scoring.js` nor `gate.js` contains
    `Math.random` or `Date.now`, so the suite **cannot** be flaky by construction. B4's failure was
    a snapshot of `scoring.js` mid-rework while B1 was still editing it. No defect.
14. **~05:00 · The recorded agent output was checked for substance, not just presence.** Real
    model output, reasoning tied to actual claim UUIDs, and the cold-start behaviour is visibly
    correct: for the real founder E1/E3/E7 came back `cannot_assess` (the fixture deliberately has
    no PR/commit-cadence data) rather than penalised, E5 landed `self_asserted` (revenue claimed on
    the founder's own blog, uncorroborated), and `red-flags` returned empty for a legitimate
    profile. REQ-003 is observably working on live output, not just in unit tests.

15. **~05:20 · Recorded fixtures reconstructed from the `ai_runs` ledger — no new API spend.**
    Only Pieter had recordings, but the demo's strongest asset is Devon's red-flag demotion, which
    had only ever run live. Since `ai_runs` stores each agent's raw `output_json` by design (I8),
    the recordings were recoverable straight from the database for both Devon and Kwame. Replay
    reproduces Devon exactly: **29.16 / 0.53 / coverage 0.715**, R1+R2+R4 firing, 5 demotions with
    correct attribution (E1←R1, E4←R4, E5←R2, E7←R1, X2←R4). The append-only AI ledger paid for
    itself the first time it was needed.
16. **~05:20 · I mis-instructed QA and corrected it mid-flight.** I told QA to replay all three
    founders against Pieter's recordings. Cross-feeding one founder's agent output into another's
    context pack makes every cited `claim_id` fail the pack-membership check, so all 12 criteria
    coerce to `cannot_assess` — correct defensive behaviour that reads exactly like a bug. Sent
    corrected per-founder paths plus reference values, and turned the mistake into an extra test
    case: a deliberate cross-founder replay MUST degrade to `cannot_assess` and must never score.

17. **~05:30 · `gpt-5.6-luna` rejects `temperature: 0` (HTTP 400).** Found live by C1. design §4.8
    and all four agent specs prescribed it, so the docs were stale against working code the moment
    the workflow ran. Corrected in design §4.8, `agents/README.md` and all four spec files:
    the parameter is **omitted entirely**, not sent as 0 or 1. Worth stating plainly — score
    determinism never rested on temperature. The agents emit only booleans and citations; every
    number comes from `scoring.js`, which has no clock and no RNG. Sampling can still flip an
    individual verdict, which is exactly what `db/fixtures/recorded/` pins down.
18. **~05:30 · The sparse founder's «guaranteed by construction» proof was wrong.** B3b bounded
    Kwame's coverage at 0.17625 by assuming only the three criteria that *have* claims could be
    assessed. But `not_met` also enters `assessed_weight`, and step 5 licenses `not_met` at
    **source level, not question level** (§4.4 step 5, acknowledged as an approximation in §8.5) —
    so three claims spanning three sources license negatives across many more criteria. The live
    n8n run duly produced `scored` at coverage 0.25125, just over the floor: the flagship
    cold-start demo was non-deterministic. Fix dispatched — give Kwame a **single source cluster**
    (`hn_algolia`), which is both what a real Show-HN-discovered founder looks like and what makes
    the bound hold in the worst case rather than the expected case. Requested a worst-case proof
    this time, checked against the registry's actual `neg_src` values.
19. **~05:25 · n8n silently ran only 1-2 of 4 parallel branches** (C1's finding). Wiring four
    parallel nodes straight into one downstream node returned HTTP 200 with most branches never
    executed — a silent-wrong-answer failure, the worst kind. Fixed with an explicit `Merge` node
    (`mode: append, numberInputs: 4`). Not in the design anywhere; recorded in the backlog TRACKER
    so other features do not lose an hour to it.

20. **~05:40 · Sparse-founder bound re-derived properly, and the fixture got more realistic in the
    process.** Kwame's three claims spanned three sources, and because the `neg_src` check is
    source-level, a single `github_api` claim licensed `not_met` across **all five** execution
    criteria. Reworked to a single `hn_algolia` cluster — which is also what a founder discovered
    from one Show HN post actually looks like. Verified in the registry: exactly one criterion (L5,
    0.06000) lists `hn_algolia`, none lists `manual`, so **max coverage = 0.06 against a 0.25
    floor, for every possible model output**. The fix improved realism and determinism together
    rather than trading one for the other.
21. **~05:45 · Kwame's recordings regenerated with one small live run.** They had been
    reconstructed against his previous claim set and cited two now-deleted claims. The gate's
    citation check dropped them and still produced `insufficient_evidence` — the right answer for
    partly the wrong reason, which is exactly the kind of thing that survives into a demo and then
    embarrasses you under questioning. His pack is 2 claims, so the re-record was cheap. Fresh
    recordings cite a live claim and replay to `insufficient_evidence` / coverage 0.06.

22. **~05:50 · Shared DB files left uncommitted, deliberately, and escalated rather than forced.**
    @devops committed feature 03's code as `f64b66b` but left `db/schema.sql`, `db/seed.sql` and
    `db/tests/smoke.sql` unstaged because feature 07's DDL is interleaved in all three — then
    asserted "the 07 team will handle these", which is an assumption, not a fact: nobody owns that
    commit. I checked whether a surgical split was possible. It is not: `smoke.sql` has a
    genuinely shared line — one `table_name IN (...)` list naming 03's `score_components`/
    `score_formulas` **and** 07's `thesis_evaluations` together — so committing only our half
    would reference a nonexistent table and break smoke on a fresh clone. Forcing it would trade
    a hygiene gap for a broken test. Escalated to the backlog TRACKER under an explicit OPEN
    heading with the resolution rule (whoever finishes second commits all three, covering both
    features, after re-running apply+smoke). Impact is git hygiene only — the live DB has
    everything applied and smoke is green.
23. **~05:50 · QA's Finding 1 was verified as resolved rather than waved through.** QA ran
    concurrently with the Kwame rework, so its repro cited a claim that no longer exists. I re-ran
    QA's *exact* attack — injecting an adjacent-criterion `not_met` for X2 citing a live claim —
    against the current fixture: it coerces to `cannot_assess`, coverage stays 0.06, status stays
    `insufficient_evidence`. QA's underlying critique (the guarantee is a property of the
    fixture's source composition, not of the engine) is correct and is kept in the report.

## Event log

- **~03:20** Phase 0 sources complete: intel base (27 signals + REQ/RSK/SCOPE/FACT), NotebookLM
  ×5 (one degenerate answer discarded), Exa ×14 angles, 9 OSS references, live schema digest.
- **~03:40** Design sections 1-4 approved by operator in sequence. Rulings: four-verdict model
  (`SELF_ASSERTED` instead of a hidden tier multiplier, resolving GRADE vs SIG-018); pedigree
  collected/displayed/not scored.
- **~03:55** design.md rev 1 → spec review **NEEDS REWORK**, 5 blockers, all real (two
  divide-by-zero on the flagship cold-start path, per-criterion weights absent, `not_met` vs
  `cannot_assess` left to the model defeating REQ-003, second `scores` row contradicting 01 §9).
- **~04:10** design.md rev 2 → **APPROVED WITH CHANGES** (2 correctness findings + 8 smaller).
  rev 3 applied all of them. Reviewer verified the weight table, the arithmetic and the
  `purge_founder` line numbers by hand.
- **~04:15** Operator approved design. Overstepped by editing feature 04's README (it is in build
  in another terminal) — reverted, routed through backlog TRACKER instead, per the
  one-feature-one-owner rule.
- **~04:30** Operator delegated full autonomy and went to sleep.
- **~04:40** plan.md rev 1 → plan review **NEEDS REWORK** (n8n import impossible; schedule
  consumed the whole window; stale axis ruling). rev 2 applies all 16 findings.
- **~04:50** Stage T0 dispatched: A1, A2, B1, B2, B3a, B3b in parallel.
