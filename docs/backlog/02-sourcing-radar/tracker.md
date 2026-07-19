# 02 · Sourcing Radar — Execution Tracker

> Single writer: the orchestrator session. Agents report back; they never edit this file.
> Plan: [plan.md](plan.md) · Design: [design.md](design.md)

## Task board

| # | Task | Executor | Depends | Status | Result / commit | Notes |
|---|---|---|---|---|---|---|
| 1 | `lib/f02/normalize.js` | @backend-developer | — | **done** | 149 tests green | vantage port, MIT, stdlib only |
| 2 | `lib/f02/identity.js` | @backend-developer | 1 | **done** | 149 tests green | 5-tier cascade, no fuzzy matching |
| 3 | `lib/f02/claims.js` | @backend-developer | 1 | **done** | 149 tests green | 9 topic slugs from design §5.1 |
| 4 | `lib/f02/obscurity.js` | @backend-developer | — | **done** | 149 tests green | followers + karma only |
| 5 | registry rows + `radar_candidates` view | @database-engineer | — | **done** | seed +7 metrics; view w/ `obscurity_basis` | verified independently |
| 6 | smoke coverage | @database-engineer | 5 | **done** | 5 assertions, id range `02f00001-…` | smoke green with 03/04/07 blocks present |
| 7 | `f02-radar-scan` (tiers 0–1) | n8n-workflow-builder | 1,5 | **done** | wf `qmViGGDMmEEN3XWH`, 22 nodes | generator `build-f02-workflow.py` |
| 7a | pre-gate entities + four-way gate branch | n8n-workflow-builder | 7 | **done** | gate returns `borderline`, advances | verified on live rows |
| 8 | `f02-identity-resolve` + `f02-radar-enrich` | n8n-workflow-builder | 2,3,7 | **done** | folded into the one workflow | real `Merge` node 3.2, 2 inputs |
| 9 | recorded fixtures + offline replay | @backend-developer | 8 | **done** | 4 fixtures + `run.js --recorded` | all four tiers replay offline |
| 10 | end-to-end vs live DB + 03 cross-check | orchestrator | 9 | **done** | ayuhito scored **60.76**, conf 0.61 | full traceability verified |
| 11 | QA gate | @qa-engineer | 10 | **✅ GATE PASSED (round 3)** | 3 rounds, 6 findings, all resolved or disclosed | `qa-report-02.md` |
| 12 | docs + commit + `done.md` | @devops | 11 | **done** | 4 commits + `done.md` | NOT pushed — operator decision pending |

## Event log

- 2026-07-19 ~05:58 · Feature 03 signalled `done.md` (`status: complete`, QA PASSED, commit
  `f64b66b`). Feature 02 resumed from PAUSED per operator's standing autonomous instruction.
- 2026-07-19 ~06:05 · Design §5–§8 written against 03's fixed contract (§3 rubric, §4.7 topic
  vocabulary, §4.9 output shape). Spec review dispatched.
- 2026-07-19 ~06:15 · **Live measurement corrected two design assumptions.** Funnel volume is
  1380/14d, not the estimated 40–80 (design §2.1) → deterministic tier-0 cap by *recency* added
  (capping by points would restore the already-visible bias the operator removed). Median
  `num_comments` is 0 → the comment-thread signal is a bonus, not load-bearing.
- 2026-07-19 ~06:25 · **Identity cascade rewritten on measured data** (n=18): owner is an
  Organization in 11% of cases (unhandled in the first draft), `blog` populated only 44%,
  exact handle match only 39%. New tier 2 (declared authorship per Show HN guidelines, 0.85)
  carries the majority and removes every fuzzy string comparison. Design §4.1.
- 2026-07-19 ~06:30 · External dependencies validated live (design §7.1). **GitHub REST works
  unauthenticated at 60 req/h** → the missing `GITHUB_TOKEN` drops from blocker to degradation,
  reachable weight ~0.61 instead of ~0.70; only E3 degrades.
- 2026-07-19 ~06:40 · plan.md written, tracker created.
- 2026-07-19 ~06:16 · **SPEC REVIEW ROUND 1: ISSUES FOUND — 3 BLOCKERs, 13 MAJORs.** All three
  blockers verified against primary sources before accepting (trust-but-verify):
  - **B1 — no writer for `cards`.** `claims.card_id` is NOT NULL and 03 reads via
    `claims JOIN cards ON … WHERE cards.founder_id = $1`. §1's ownership table omitted `cards`
    and `evidence` entirely → every radar claim would have been **invisible to 03** and every
    reachable-weight figure in §5 would be zero. Fixed: new §5.0 rule 1.
  - **B2 — REQ-003 inversion via the `public` wildcard.** Confirmed verbatim in 03 §4.4 step 5:
    `source_kind='public'` → "any source (wildcard)". One evidence-less radar claim would license
    `not_met` on L2/L3/X5 — the three criteria §5.2 argues are safely `cannot_assess` — dragging
    the score down for a founder whose only shortcoming is not having submitted a deck. Exactly
    the defect §0 criticises vantage for. Fixed: §5.0 rule 2 (no claim without evidence +
    `raw_signal_id`; no attempt → no claim at all).
  - **B3 — tier 2 unreachable.** Confirmed in TRACKER 05:30 "07 → 02, ACTION NEEDED" (added after
    this terminal last read the file): `thesis_gate = NULL` is reachable, and keyword mode
    "never returns `passed` by design". Advancing only on `passed` would have advanced nobody
    while every workflow returned success. Fixed: §5.5 four-way branch (passed | borderline |
    NULL advance; only `failed` stops).
  - **M1 — arithmetic wrong.** Reachable weight is 0.70375, not 0.700; the no-GitHub row is
    0.40375, not 0.31. Recomputed and shown summed at 5 dp throughout.
  - Also fixed: M2 (`observed_at` defined per source), M3 (two-step insert — append-only tables
    return no id on `ON CONFLICT DO NOTHING`), M4/M5 (`evidence.tier` defaults; identity
    confidence made real by forcing `inferred` below 0.85 — 03 never reads
    `founder_identities.confidence`), M6 (VIEW is DDL → 02 joins the 03↔07 combined-commit rule),
    M7 (obscurity formula written out; **missing input → NULL, never 0** — zero-substitution would
    float data-less founders to the top of the feed, REQ-003 backwards), M8 (registry drift:
    `hn_karma` unregistered, `hn_num_comments`/`hn_comments` mismatch, `site_last_modified`
    duplicating seeded `site_updated`), M9 (companies/applications defaults), M10 (opt-out is
    defeated by `purge_founder` — now stated as a known limit rather than claimed as enforcement),
    M11 (liveness probe has no `signal_sources` slug → recorded as `tavily_extract`; a new slug
    would need a `formula_v2` because `score_formulas` is seeded ON CONFLICT DO NOTHING),
    M12 (n8n Merge-node / SUPABASE_URL-drift / no-require traps), M13 (Tavily credit ceiling).
- 2026-07-19 ~06:18 · Design revised, re-review dispatched. Stages A and B dispatched in parallel.
- 2026-07-19 ~06:20 · **Four fixtures recorded from the live 14-day window** (Task 9 pulled
  forward — it removes the demo's dependency on live APIs and needed no builder output):
  | case | hn_author → gh_owner | why this case |
  |---|---|---|
  | `user-artifact` | `ayuhito` → `ayuhito` | tier 1, exact handle match, `blog` set |
  | `org-artifact` | `G3819` → `puffinsoft` (**Organization**) | tier 3 — org becomes the company, founder unresolved |
  | `product-url` | `iamdavidoti` → rewindcup.com | path B, no GitHub at all |
  | `threaded-artifact` | `vforno` → `JustVugg` | tier 2 declared authorship; **240 comments, 65 top-level** — the only fixture that exercises FACT-011 |
  The first three all recorded `thread_kids=0`, re-confirming §2.1's median-0 finding on the
  chosen sample — which is exactly why the fourth was added: without it the comment path would
  have shipped untested. `vforno` has **zero top-level author replies** despite 240 comments,
  which is itself a (negative) coachability observation the pipeline must represent honestly.
- 2026-07-19 ~06:22 · B1 re-verified directly against `db/schema.sql`: `claims.card_id` is
  `NOT NULL REFERENCES cards(id)` (line 275) while `cards.founder_id` is nullable (line 260).
  The blocker was real — a card without `founder_id` makes every claim invisible to 03's join.
- 2026-07-19 ~06:22 · 07's `handoff.md` §2 found (written directly to this feature after 07
  closed) → two binding additions folded into design §5.5(d): geography passes as
  `structured_hints.geography_country` in **ISO-3166-1 alpha-2**, and **`failed` is rare by
  construction** (every compiled rule is `soft`; one hard rule in the starting thesis), so the
  gate is *not* a volume filter — all tier-1 cost control rests on the recency cap.
  Gate entry point confirmed: `POST /webhook/f07-thesis-gate` or an Execute-Workflow sub-call.
  03's entry point likewise confirmed: `POST /webhook/f03-score-founder` with `{founder_id}`.
- 2026-07-19 ~06:25 · **SPEC REVIEW ROUND 2: 13/17 prior findings fully resolved, arithmetic
  verified exact — but TWO NEW BLOCKERs**, both structural, both fixed:
  - **N1 — tier-0 `raw_signals` were permanently unreachable by GDPR erasure.** `purge_founder()`
    deletes `raw_signals` only by `founder_id`/`company_id`; the table is append-only so a NULL FK
    can never be backfilled. Writing all ~1380 hits with both NULL would deposit, every run, a
    permanent residue of HN handles/titles/URLs surviving erasure — while §7 claimed ethics as
    "mechanics visible in the product". Fixed: entities created for the capped survivor set
    *before* the raw write, `company_id` set at insert; the discarded remainder yields counters
    only. New acceptance criterion: no radar `raw_signals` row has both FKs NULL.
  - **N2 — rule 1 orphaned the unresolved majority.** `cards.founder_id` mandatory + ~64% of
    candidates ending `unresolved` = no card, no claims, and §5.4 rows 3–4 plus the whole
    `insufficient_evidence` path unreachable — voiding the cold-start differentiator. Fixed:
    every candidate gets a `founders` row anchored on `founder_identities(kind='hn')`;
    `unresolved` means no *cross-platform* link, never the absence of a person.
  - Also fixed: N3 (02 branches on the returned `verdict`, not the column — the two surfaces
    disagree and picking wrong reintroduces B3), N4 (§11 stale figures), N5 (the claimed partial
    unique index does not exist; plain UNIQUE already admits unlimited NULL domains), N6
    (**obscurity now averages over observed terms only** + `obscurity_basis[]` — the earlier
    "any missing → NULL" would have blanked the column for the majority, since `hn_karma` is
    always present but `gh_followers` only ~36%; view mechanics pinned to latest-per-metric),
    N7 (three cross-feature entries appended to `docs/backlog/TRACKER.md`).
  - Reviewer confirmed clean: obscurity formula range/monotonicity, §5.0 rule 2.3 vs the
    degradation ladder, all five ladder rows against §5.1's source table, and every CHECK /
    NOT NULL / UNIQUE claim against `db/schema.sql`.
  - Mid-flight spec change relayed to the in-progress @database-engineer (obscurity semantics +
    view mechanics) so the view is not built to the superseded rule.
- 2026-07-19 ~06:30 · **Stage A done, verified independently**: `node --test lib/f02/*.test.js`
  → **149 tests, 149 pass**; zero `require()` outside comments in all four library files;
  SOURCE OF TRUTH headers present. Agent self-corrected two things mid-flight: applied Rule 0(b)
  (`founderResolvable` → `crossPlatformLinked`, 16 User / 2 Organization split asserted), and
  fixed the false-positive "no fuzzy matching" test that was matching its own header prose —
  now strips comments before the regex, following `build-f03-workflow.py`'s `require()`-freedom
  precedent. Notable defensive touch in `claims.js`: `founderExecutionExternalUsage` refuses
  `stars` as an input *field* rather than merely ignoring it, "so a caller cannot smuggle them
  in" (SIG-014).
- 2026-07-19 ~06:30 · **Stage B verified independently** beyond the agent's own report: view
  columns confirmed incl. `obscurity_basis`; `metric_kinds` = 12; `./db/apply.sh` twice clean;
  smoke green alongside 03/04/07 blocks. Ran my own rolled-back REQ-003 probe with different
  values than the agent used — followers-only(9) → **0.6667**, i.e. exactly the single observed
  term. A 0-substituted karma term would have produced 0.8333 and floated a data-less founder
  *up* the feed; it does not. Two-term(9,9) → 0.7083 matches `(1−log₁₀(10)/3 + 1−log₁₀(10)/4)/2`
  by hand. Zero-term → NULL.
- 2026-07-19 ~06:31 · Stage C deterministic half dispatched to the same agent (context retained):
  `pipeline.js` (pure `buildWriteSet`, dependency-injected so it stays zero-import), `write.js`
  (PostgREST two-step insert + `SB_NORMALIZE`), `run.js` (fixture replay CLI).
- 2026-07-19 ~06:33 · **Probed the personal-site path against live APIs before building it —
  four defects that would have shipped as silent no-ops** (design §7.1):
  1. GitHub's `blog` field has **no scheme** (`ayuhito.com`, not `https://ayuhito.com`), so
     §4.1's "crawl seed = github.blog" was not a URL.
  2. **`/map` returns 0 URLs on real small personal sites** — confirmed on *both* fixture sites,
     each answering HTTP 200. The design treated `/map` as *the* discovery path. Now: `/map`
     first, ROOT-only fallback when empty.
  3. Guessed conventional paths do not work — `/about` → 404, `/blog` → fetch failure on a site
     that has neither. Free in credits but manufactures false `failed_results`, which collides
     with the §7.1 rule that a failed fetch means "could not verify", never "project is dead".
  4. **`repo.homepage` is not a site seed** — the fixture's is `pkg.go.dev/...`, a package
     registry. Valid E4 liveness target only; using it as a crawl fallback would crawl pkg.go.dev
     and attribute it to the founder.
  Tavily responses recorded into the fixtures: 2 of 4 have a site (`ayuhito.com` 305 chars,
  `rewindcup.com` 254 chars — the ayuhito root alone yields location and domain focus, i.e. real
  X1/X2 material); the other 2 have **no site seed at all**, which exercises §5.0 rule 2.3
  (no attempt → no claim, not a `missing` marker) on real data.
- 2026-07-19 ~06:36 · **Stage C deterministic half done** — `pipeline.js` (pure `buildWriteSet`,
  DI so it stays zero-import), `write.js` (PostgREST two-step insert), `run.js` (replay CLI).
  **212 tests green.** All four fixtures replay offline and land on the intended tiers:
  `user-artifact` t1/0.95 · `threaded-artifact` t2/0.85 (declared authorship) ·
  `org-artifact` t3/0.60 (org→company, `needsReview`) · `product-url` t4 (unresolved, survives).
  The agent found three real bugs through live verification rather than unit tests alone:
  `text_verbatim: null` violating a `NOT NULL`; `write.js` defaulting to the container-only
  `host.docker.internal` URL; and `metric_observations` losing idempotency because a churning
  `company_id` was part of its natural key.
- 2026-07-19 ~06:37 · **🔴 ORCHESTRATION DEFECT (mine, not an agent's) — caught and fixed.**
  The revised obscurity semantics from review round 2 were relayed to the terminal building the
  SQL view but **not** to the one building `lib/f02/obscurity.js`. Result: two implementations of
  one formula silently disagreed — the view returned **0.8807** for a karma-only founder while
  the JS returned **null**. Since 64% of candidates have no resolvable GitHub, that is the
  majority path, and the CLI/tests would have reported "unknown" for exactly the population the
  feature exists to surface. Found by hand-checking a fixture whose karma was plainly present
  (=2) against a `null` output rather than trusting the green suite.
  Fixed: `obscurity.js` rewritten to average over observed terms, `computeObscurity()` added
  returning `{value, basis}` mirroring `obscurity_basis`; stale assertions in `obscurity.test.js`
  and `pipeline.test.js` replaced with ones that assert the anti-inflation property directly
  (`karma-only 0.75 < zero-substituted 0.875`). Verified JS ≡ SQL on four input pairs.
  **Lesson: a mid-flight spec change must be broadcast to every terminal touching that spec, not
  just the one that surfaced it.** Two implementations of one formula need an explicit
  cross-check test, which is now what the basis-name assertion provides.
- 2026-07-19 ~06:38 · Three follow-ups dispatched: wire the recorded `tavily_site.json` (X1/X2/E4
  currently report "no attempt", so reachable weight sits at 0.215 of the 0.70375 ceiling);
  fix `companies.name` derivation (a Show HN headline is not a project name — `threaded-artifact`
  yields "getting glm 5.2 running on my slow computer" where the project is `colibri`); and
  application-level company dedup via the generated `normalized_name` column, since
  `canonicalDomain` correctly nulls github.com and leaves no natural key (QA attack case 1).
- 2026-07-19 ~06:41 · **END-TO-END CROSS-FEATURE PROOF (Task 10, first pass).** Called the live
  `POST /webhook/f03-score-founder` with a founder the RADAR discovered (`ayuhito`, no inbound
  application, no deck) → HTTP 200 in 20s, structured §4.9 contract returned. The two features
  compose through the database with no special-casing on either side.
  Verdict distribution over the 12 criteria: **10 `cannot_assess` · 1 `not_met` · 1 `met`**,
  coverage 0.14 → `status: insufficient_evidence`, **no score invented**.
  Reading it correctly (a first, cruder check mis-flagged this):
  - The single `not_met` is **E5** with `evidence_tier='documented'` — the radar genuinely
    observed via GitHub that there is no measured external usage. A negative verdict licensed by
    a real observation is exactly what 03's `neg_src` mechanism exists to permit; it is not a
    missing-data penalty.
  - **L2, L3 and X5 — the three criteria whose `neg_src` lists only `deck_parse` /
    `interview_answer` — all returned `cannot_assess`, not `not_met`.** That is blocker B2's fix
    working in production across the feature boundary: a radar-only founder is not punished for
    having submitted no deck. §5.2 predicted precisely this and the prediction held on live data.
  - `insufficient_evidence` at coverage 0.14 is the designed outcome for a founder whose site
    data is not yet wired (§5.4's HN+GitHub-without-site row) — not a failure. It rises above
    03's `min_coverage` of 0.25 once the recorded Tavily fixtures are wired in (in flight).
- 2026-07-19 ~06:40 · **Live DB audit found two invariant violations — both belong to feature 04,
  none to 02** (02: 47 `raw_signals`, zero offenders). 9 `tavily_extract` rows with both FKs NULL
  (permanently unreachable by `purge_founder()`), and 3 `evidence` rows with NULL `raw_signal_id`
  on `competition.competitor` claims. Same two defect classes 02's own review caught as blockers
  N1 and B2. Reported to 04 via `docs/backlog/TRACKER.md` with reproduction queries.
- 2026-07-19 ~06:43 · **Three follow-ups landed — 227 tests green.** Reachable weight per fixture,
  verified on disk: `user-artifact` **0.48375** · `product-url` **0.40375** · `org-artifact` and
  `threaded-artifact` 0.21500 (no site fixture — the asymmetry is deliberate coverage of §5.0
  rule 2.3, not a gap). `product-url` landing on 0.40375 is a satisfying closure: that is exactly
  design §5.4's "HN + site, no GitHub" row, the figure the spec reviewer forced us to recompute
  from a wrong 0.31 — the corrected arithmetic and the running code now agree to 5 dp.
  `companies.name` fixed (`colibri`, not the Show HN headline) and company dedup added via the
  generated `normalized_name` column; second `--write` runs create zero companies, zero raw
  signals, zero metrics. The only remaining non-idempotent write is missing-marker claims, whose
  `content_hash` is NULL by the schema's own documented design — not a defect this feature
  introduced.
  The agent also self-corrected something the spec could not have surfaced: **X6's evidence
  precedence**. Seeing the real recorded pages showed both are "About me" bios (because `/map`
  returned 0 URLs, the crawl never reached a changelog), so using one as evidence of "substantial
  work nobody asked for" was a topic mismatch. Repo-date now wins; the bio is last resort.
- 2026-07-19 ~06:44 · **Second end-to-end run after wiring the site claims:** coverage
  **0.14 → 0.235**, verdicts `9 cannot_assess · 2 met · 1 not_met`. Still below 03's
  `min_coverage` of 0.25, so still `insufficient_evidence` — honest, and exactly what the
  degradation ladder predicts, but a demo is stronger with at least one radar-discovered founder
  carrying a real score. The two criteria standing in the way are precisely the two §5.4 promises
  and nobody wired: **E1** (merged PRs into foreign repos, 0.10) and **E3** (commit consistency,
  0.06), both reachable on unauthenticated REST. Dispatched.
  Worth noting for feature 06: 03's response carries a `what_would_close_it` sentence per missing
  criterion (e.g. *"Independent usage data such as dependent repositories or packages, download
  counts, transaction records…"*). That is ready-made REC-005 material — the memo's
  "where to dig on the call" section can be assembled from it directly rather than re-derived.
- 2026-07-19 ~06:50 · **INCIDENT — `docs/backlog/TRACKER.md` was reverted to its first commit and
  restored from this session's context.** Found while correcting my own drifted timestamps: the
  working copy was byte-identical to `dca3ad5` (01 still «in-build», everything else «backlog»),
  meaning the infra changelog, tooling changelog, 🔴 OPEN shared-DB section and every Schema
  changelog entry from 03/04/07/02 were gone. `git log --all` shows exactly one commit for that
  path, so there was nothing newer to restore from — most likely a `git checkout`/`restore`
  across `docs/` in another terminal.
  Restored by reconstruction from this terminal's context (it had read the file in full at ~06:00
  and grepped 07's later additions), with a prominent banner stating it IS a reconstruction, that
  other features' wording may differ, and that **anything 04 or 07 appended after ~06:00 was not
  recoverable and must be re-added by them.** Added rule 6 to the parallel-terminal rules:
  append rather than read-modify-write, and never `git checkout` across `docs/`.
  Worth stating plainly: the lost content was not bookkeeping. It held the Merge-node silent-
  failure finding, the `SUPABASE_URL` drift, the `node --test` glob quirk and the
  `gpt-5.6-luna` temperature rejection — four traps that cost real terminal-hours to discover
  and would each have been rediscovered from scratch.
- 2026-07-19 ~06:47 · Own timestamps in this tracker corrected: entries had drifted ~3h ahead of
  wall clock (writing 09:40 at 06:44). Remapped monotonically into the real window so the
  handoff record is not misleading to the operator or to neighbouring terminals.
- 2026-07-19 ~06:58 · **E1 + E3 wired REST-only — 246 tests green.** The agent made a call I had
  not briefed and that prevents a real correctness bug: E1/E3 are gated on `personLinked`
  (`crossPlatformLinked && ghUser.type === 'User'`), not merely on data presence. Unlike E5/E7
  which describe the *artifact*, E1/E3 describe a *specific person's* activity — without the gate,
  the organisation `puffinsoft`'s merged PRs and push events would have been attributed to
  `G3819`, an unconfirmed HN poster. That is precisely the entity merge §4.1 forbids at tier 3.
  Verified in the DB: G3819 has **zero** E1/E3 claim rows; `ayuhito` and `vforno` have two each.
  Honest coverage handling, from live data rather than assumption: `ayuhito`'s 100-event REST page
  spans **under 24 hours** and `JustVugg`'s ~4.1 days (both hyperactive accounts exhaust the page
  immediately), so E3's `base_confidence` now scales continuously toward the *observed* window and
  `text_verbatim` states the real coverage, instead of reusing design §5.4's "~90 days" phrasing
  which would have been false here. E1 reports "**At least** 77 merged pull requests" with a
  `truncated` flag when Search API `total_count` (945) exceeds the fetched page.
  Reachable weight now: `user-artifact` **0.64375** — landing exactly on §5.4's documented
  "no GITHUB_TOKEN, REST unauthenticated" *guaranteed floor*, not its ceiling, because the events
  window genuinely does not cover E3 · `product-url` 0.40375 · `threaded-artifact` 0.27500 ·
  `org-artifact` 0.21500 (unchanged — the `personLinked` refusal is correct, not a regression).
- 2026-07-19 ~07:02 · **🏁 TASK 10 DONE — the demo's central claim now holds on live data.**
  `ayuhito` — discovered by the radar, never applied, no deck, in no startup database — scored by
  the same feature-03 pipeline an inbound applicant would use:
  **`status: scored` · value 60.76 · confidence 0.61 · coverage 0.395** (up from 0.14 → 0.235 →
  0.395 as the site and GitHub paths were wired). Contributions reproduce the total exactly:
  `E1 25.31646 + E4 20.25316 + L5 15.18987 = 60.75949`.
  Verdicts `3 met · 2 not_met · 7 cannot_assess`, and both `not_met`s carry a real
  `evidence_tier` (`documented`/`discovered`) — i.e. licensed by observation, never by absence.
  **Traceability chain verified in SQL:** score → 16 `input_claim_ids` → all 16 carry evidence →
  5 distinct `raw_signals` → 3 sources (`github_api`, `hn_algolia`, `tavily_extract`). Every
  number behind the score clicks through to a primary source, which is the rubric's Agentic
  Traceability stretch goal demonstrated across a feature boundary rather than asserted.
- 2026-07-19 ~07:10 · **Two §7 ethics mechanisms were CLAIMED BY THE DESIGN AND DID NOT EXIST.**
  Found by pre-checking the feature's own QA brief rather than waiting for the gate to report it:
  `grep -rn "robots" lib/f02/` and `grep -rn "opt_out" lib/f02/` both returned nothing, while
  design §7 presents both as "mechanics visible in the product, not a slide". Built and wired:
  - **`lib/f02/ethics.js`** (+17 tests) — robots.txt parser with group precedence, longest-match
    Allow/Disallow, `*` and `$`, and the `Disallow:` (empty value) = allow-all case that is the
    commonest way a naive parser blocks an entire site. Crucially it keeps **"could not verify"
    and "objects to crawling" distinguishable**: a fetch failure returns `allowed:true` with
    `checked:false`, because §7.1's rule is that a failed fetch is never "project is dead" and
    never "objects". A skip emits a `crawl_skipped_robots` event so it is auditable, not silent.
  - **opt-out gate wired into `write.js` at ingest**, before any mutation, checked across *every*
    identity in the write-set rather than just the HN one. Verified live: set
    `founders.opt_out_at` on `ayuhito` → re-ingest returned `blocked: opt_out`, every `created`
    counter 0, and `raw_signals` stayed at 80 rows. Restored afterwards.
  - **robots-gated live site crawl added to `run.js --live`** (it previously made no Tavily calls
    at all, so the gate had nothing to guard). Seed precedence follows §7.1's field findings;
    `repo.homepage` deliberately excluded.
  Verified against real sites: `linkedin.com/in/*` → **BLOCKED, rule `/`** · `ayuhito.com`,
  `news.ycombinator.com`, `rewindcup.com` → allowed. The LinkedIn refusal is the judge-facing
  artefact: our documented decision not to scrape LinkedIn is now enforced by the code rather
  than asserted in a document. 263 tests green.
  Worth stating plainly: **the design claimed both mechanisms for hours while neither existed.**
  A design doc asserting behaviour is not evidence of behaviour, and this feature's own §7 was
  the least-verified section precisely because it read as settled.
- 2026-07-19 ~07:18 · **Self-audit found the ethics fix was itself half-done.** Having just built
  `crawlSkippedEvent()`, I checked whether anything actually persists it — nothing did, and
  `write.js` had no `events` writer at all. So design §7's "the skip is recorded so it is visible
  rather than silent" was *still* false, and §6.2's `radar_scan_completed` run counters had no
  writer either. Added `writeEvents()` (plain INSERT — `events` is append-only with no natural
  key, so a second run legitimately appends a second ledger row; that is a run ledger working,
  not an idempotency violation) and wired both into `run.js --write`, including when the opt-out
  gate suppressed the ingest — an opted-out person leaves no new trace, but the run still
  happened and the ledger must show that it did.
  Verified live: `radar_scan_completed` rows 0 → 1, payload carrying real counters
  (`rawSignalsWritten: 5, claimsWritten: 5, metricsWritten: 3` and the per-slug breakdown).
  Flagged the same question to the QA agent rather than only fixing it quietly — «does the skip
  actually reach `events`, or does it merely construct an object nobody persists» is exactly the
  probe that should stay in an independent auditor's hands.
- 2026-07-19 ~07:30 · **QA GATE ROUND 1: FAILED — 4 findings, all real.** The agent generated its
  own evidence throughout (isolated scratch database, live probes) rather than re-running dev
  tests, and disclosed that the DB was under concurrent modification during its run.
  1. **🔴 CRITICAL — the whole DB surface is uncommitted.** Verified independently and it is
     WORSE than reported: the same revert that truncated `docs/backlog/TRACKER.md` also hit
     `db/`. `grep -c "Feature 02\|Feature 03\|Feature 07"` returns **0** in `db/schema.sql`,
     `db/seed.sql` and `db/tests/smoke.sql`. Four objects exist ONLY in the live database:
     `score_formulas`, `score_components` (03), `thesis_evaluations` (07), `radar_candidates`
     (02) — plus seed rows and smoke blocks. **A fresh clone + `./db/apply.sh` creates none of
     the scoring tables**, which is exactly what a judge gets from the repo and the zip, so this
     breaks the submission for three features, not one. 03 and 07 are done and their terminals
     are gone, so under the standing "last terminal commits all three files" rule this is ours.
     Recovery dispatched to @database-engineer: the live DB still holds everything, and
     container-side `pg_dump` 17.6 works (host's is 16.13 — version mismatch).
  2. **MAJOR — radar `events` escaped erasure.** `purge_founder()` sweeps events with exactly
     `entity_type = 'founder' AND entity_id = ANY(...)`, so my `crawl_skipped_robots`
     (`entity_type='url'`) and `radar_scan_completed` (`'application'`) rows could never match —
     and a skip row carries a real personal-site URL. QA confirmed one survived two purge calls.
     **FIXED**: both bound to `entity_type='founder'` with the id filled in at persist time (the
     founder does not exist yet at robots-check time).
  3. **MAJOR — the UA-consistency claim was false.** The code asserted robots is checked and the
     page fetched under the same agent; in fact Tavily performs the fetch under its own
     uncontrolled identity. **Not fixable in the MVP** (we cannot set Tavily's UA). The false
     claim is removed and replaced with the honest limitation plus the correct post-MVP fix —
     fetch the root ourselves, which §7.1 already measured as the common path since `/map`
     returns zero URLs on real personal sites. The gate still refuses disallowed sites outright.
  4. **MAJOR — duplicate rows. FIXED, and the root cause was not what it looked like.**
     `selectOne` issued `limit=1` with **no `ORDER BY`**, so with four legacy `safehttp`
     companies Postgres returned different rows on identical consecutive queries — the
     application dedup hit on one run and missed on the next. Symptom looked like flaky dedup;
     cause was an unordered lookup. Now ordered `created_at.asc` (oldest match is canonical).
     Also removed the missing-marker claim special case: it skipped hashing entirely, citing the
     schema's note that `content_hash` is nullable for markers — but that note explains why the
     column *may* be null, not that a marker must be left unhashed. A claim's hash is its
     identity, and `(card_id, topic, sentinel)` is perfectly stable. That "documented accepted
     consequence" was costing +4 claims and +4 evidence rows on every retry, forever.
     **Result: two full passes over all four fixtures now produce ZERO drift across all eight
     tables** (76/89/195/80/341/272/217/270 twice).
  263 tests green throughout. QA re-check to be dispatched once the DB restoration lands.
- 2026-07-19 ~07:40 · **n8n workflow done — `f02-radar-scan`, id `qmViGGDMmEEN3XWH`, 22 nodes.**
  Generator `n8n/build-f02-workflow.py` reads `lib/f02/*.js` fresh at build time and pastes them
  verbatim (03's pattern), so the tested modules and the running workflow cannot drift.
  Verified independently: registered, syntax check 0 failures across all 7 Code nodes, a real
  `Merge` node (`n8n-nodes-base.merge` 3.2, 2 inputs) for the Tier-2 fan-in, an `executeWorkflow`
  node calling 07's gate, and 4 sticky notes labelling the tiers on canvas.
  **Four live bugs the builder found and fixed — all invisible to unit tests:**
  1. `globalThis.crypto` undefined in this build's JS Task Runner sandbox → polyfilled from
     `require('crypto').webcrypto`.
  2. **`URL` undefined — and `parseArtifactUrl`'s own try/catch swallowed it**, so every artifact
     silently classified as `kind:'none'` with nothing in the logs. The catch was written for bad
     input, not for a missing global; it turned an environment defect into a silent wrong answer.
  3. `URLSearchParams` undefined → same treatment.
  4. `parseArtifactUrl()` does not set `.url` on its return (only `buildWriteSet` does), so the
     Tavily node calling it directly got `no_seed` for every candidate.
- 2026-07-19 ~07:45 · **Live scan verified against the database.** 68 founders discovered by the
  n8n run in ~30 minutes, **all 68 carrying claims** across all three topic prefixes. Feature-02
  invariants, scoped to its own nine slugs: **225 claims · 0 without evidence · 0 evidence
  without `raw_signal_id` · all 9 slugs in use · 0 `raw_signals` with both FKs null.**
  Two false alarms of my own worth recording, since both looked like real defects:
  (a) "founders not growing" was a measurement artifact — I sampled twice *after* the burst;
  (b) "109 claims on cards without founder_id" are all `market.*`/`company.*`/`competition.*` on
  `card_type='company'` cards, i.e. features 04 and 07, where a null `founder_id` is correct.
  A third check found 3 evidence-less `founder.*` claims — those are **03's fixture rows**
  (Devon Ashworth, Pieter Levels, created 01:30/01:38, topics outside 02's slug vocabulary).
  Lesson: a whole-table invariant query in a shared database attributes nothing on its own.
- 2026-07-19 ~07:55 · **DB restoration complete and verified — root cause corrected.** My earlier
  note guessed a `git checkout` over `docs/`. The truth is sharper: features 03 and 07 **never
  committed** their `db/` work at all (their commits staged only `db/README.md` and fixtures), and
  02 had committed nothing to `db/` either. So the loss was of *uncommitted working-tree content*,
  not of history — which is exactly why it was unrecoverable from git and why a single stray
  command could erase hours of three features' work.
  Restored from the live database (container-side `pg_dump` 17.6): `score_formulas`,
  `score_components` (03), `thesis_evaluations` + `theses.is_default` + `validate_thesis_config()`
  + `activate_thesis_version()` (07), `radar_candidates` (02), plus `purge_founder()` wholesale
  (it carried 04's fix, 03's `score_components` two-pass sweep and 07's `thesis_evaluations`
  sweep), the enforcement layer read from `information_schema` rather than from prose, and the
  seed rows. The agent's own first pass introduced one real bug — it co-located the
  `forbid_mutation` triggers with each table, before `forbid_mutation()` is defined — and caught
  it in its own scratch-DB test rather than in review.
  **I verified the test that actually matters myself: a brand-new database, `schema.sql` +
  `seed.sql` only → 25 tables, 1 view, all four previously-lost objects present, seeds correct
  (12 `metric_kinds`, 1 `score_formulas`, 1 `theses`).** That is what a judge cloning the repo
  gets. Committing immediately via @devops — a commit is the only real protection, and its
  absence is precisely what caused this.
- 2026-07-19 ~08:05 · **Committed — the work is finally protected.** `edee0df`
  *fix(db): restore schema/seed/smoke lost from the working tree (features 02+03+07)* and
  `0ca3a87` *feat(02): sourcing radar — lib/f02 core, recorded fixtures, n8n workflow* (52 files).
  Verified independently rather than on the agent's word: both commits present in sequence,
  **zero literal-secret pattern hits** across the full diffs, nothing from `docs/`/`internal/`/
  `.env`/`volumes/` staged, and the committed `db/schema.sql` really does carry the restored
  objects (30 references to `radar_candidates`/`score_components`/`thesis_evaluations`).
  **Not pushed** — the operator is asleep and has not authorised publishing.
  Minor inaccuracy left standing: commit `0ca3a87`'s message says "191 acceptance tests" where
  the suite is 263. Not amended — rewriting history in a repo with several live terminals is a
  worse risk than a wrong number in a message, and the real count is recorded here.
- 2026-07-19 ~08:15 · **🔴 PUBLICATION-GATE VIOLATION FOUND — AND IT IS ALREADY LIVE ON THE
  PUBLIC REPO. Needs the operator's decision; I have gone as far as I safely can alone.**
  Noticed while checking commit hygiene: `docs/` is **not** in `.gitignore` (51 files tracked),
  although the project CLAUDE.md states it is. `internal/` IS correctly ignored — 0 tracked files
  — so the research corpus and intel base are safe. But `docs/` is published, and
  `git ls-tree origin/main` shows **42 files already pushed** to the public
  `github.com/Serg1kk/the-vc-brain`.
  Among them, six backlog READMEs had violated the publication gate: direct links to closed-corpus
  sources and explicit attribution of concepts to restricted materials. Hard rule #1 forbids
  exactly this disclosure. Three of the six violations are confirmed present on the remote right
  now (03, 05 and 08's `README.md`).
  No keys, no personal names, no `internal/` content is exposed — the leak is source attribution,
  not secrets.
  **What I did:** sanitised all six files in the working tree — removed the closed-corpus links and
  the by-name attribution, kept our own tracker IDs (`SIG-012`, `RSK-002`, `REC-007`, `REC-014`),
  which are internal identifiers and harmless. Zero residual references across all tracked docs.
  Files belong to features 03/05/08, whose terminals are gone; this is a cross-cutting compliance
  fix, not a feature edit.
  **What I did NOT do, deliberately:** rewrite public history. A normal push corrects the tip;
  purging the already-published commits needs a force-push or recreating the repo. That is
  irreversible and outward-facing, so it is the operator's call, not mine.
  **Operator decision needed before any further push:** (a) accept the sanitised tip and leave
  history as-is, (b) force-push a rewritten history, or (c) decide `docs/` should not be published
  at all and add it to `.gitignore` + `git rm --cached`. Note that CLAUDE.md's own gate says
  «публикуем код + английские доки», which argues for (a) — but 18 of the tracked docs are
  Russian `.ru.md` internal pairs, which argues that (c) deserves a look.
- 2026-07-19 ~08:40 · **QA RE-CHECK: findings 1, 2 and 4 confirmed fixed on the agent's OWN
  evidence** (its scratch DB reproduced my 25-tables/1-view/12+1+1 numbers exactly; it built its
  own founder, attached both event types, purged, and saw them gone; its own 2×4×8 snapshot test
  showed zero drift). Finding 3 it concurred is not independently gate-blocking. It also noted the
  `applications` fix went further than I described.
  **But GATE stayed FAILED on a NEW critical it proved live — and it is a genuinely instructive
  bug.** The n8n workflow calls `buildWriteSet` twice: Tier 1 with `capabilities.github=false`,
  Tier 2 with full data. My company-name precedence keys on the artifact owner's TYPE — which
  Tier 1 cannot know. So for Organization-owned artifacts, Tier 1 names the company after the REPO
  and Tier 2 after the ORG: two names, two rows, the founder's card pinned to the Tier-1
  fabrication while the real organisation sits orphaned. Design §4.1 tier 3 violated in production,
  **3 of 3 org-owned candidates** (`kaiT2en`, `brainwavesio`, `astrio-labs`).
  Root cause worth naming: I keyed an entity's identity on a value that **depends on how much data
  we happened to have**. Every idempotency fix earlier today was the same mistake in a different
  costume (unordered `selectOne`, unhashed markers, name-based company dedup).
  **Fixed** with a phase-invariant anchor: `applications` is already deduplicated by
  `hn_item_id`, which is identical in both phases, so the company is now resolved *through the
  application* rather than re-derived from a name. Divergence becomes a rename, never a split
  (`companies` is mutable, so Tier 2 corrects the name in place). Verified: both phases resolve to
  the same company id, zero new rows, card points at `puffinsoft` not `peek-cli`.
  Also closed the adjacent gap QA found unprompted: `checkRobots` gated only the seed URL while
  `/map` hands up to 5 more to `/extract`, and robots rules are **path**-scoped
  (`Disallow: /blog` under an allowed `/` is ordinary). `checkRobots` now returns the fetched
  text so every mapped URL is evaluated against it with no extra request; refusals are dropped
  and recorded. +2 regression tests, one asserting the seed-only check would have differed.
  265 tests green · workflow regenerated and redeployed (`qmViGGDMmEEN3XWH`), anchor confirmed
  present in both write nodes of the live copy.
  Left standing, documented not fixed: QA's structural finding that the catch-swallows-
  environment-defect pattern recurs in `ghGet`, `robotsFetchFn` and the Tavily calls — the same
  shape as the already-fixed `URL`-undefined bug. Not proven active; recorded honestly.
- 2026-07-19 ~08:30 · **✅ QA GATE PASSED (round 3). FEATURE 02 COMPLETE.**
  The gate took three rounds and found six defects; the report keeps all three verdicts
  (FAILED → FAILED → PASSED) rather than only the last.
  Round 3 verified both round-2 fixes on the agent's own evidence, and the company-split fix turned
  out to do more than stop the bleeding: re-running the four real candidates it was found on
  **self-healed** their cards onto the correct organisation instead of the fabricated repo-named
  company. I confirmed the shape of that independently — `peek-cli` now has **zero** cards pointing
  at it while `puffinsoft` carries two founders; the leftover duplicate company rows
  (`inklate`, `brainwavesio`, `astrio-labs`, each ×2) are pre-fix orphans with no cards.
  Robots per-URL gating was verified by QA against a **live published** `robots.txt`
  (`voronoigo.com`) where 2 of 4 mapped URLs are disallowed under an allowed seed — proving the
  seed-only check genuinely diverges in practice, not merely in principle.
  One risk carried forward explicitly rather than silently dropped: the catch-swallows-
  environment-defect pattern in `ghGet` / `robotsFetchFn` / the Tavily calls. QA judged it not
  gate-blocking (not proven active, disclosed, cheap to fix) and recommended it as the first
  follow-up, `ghGet` first for blast radius. It is named in `done.md` under CARRIED RISK.
  Final state: **265 tests · 4 commits · n8n `qmViGGDMmEEN3XWH` deployed · `done.md` written for
  downstream 08 and 11 · nothing pushed.**
