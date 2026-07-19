# 04 · Market, Trend & Competition Intel — Adversarial QA Report (E1)

> QA engineer: adversarial gate, independent of the developer's own 141 `lib/f04` unit tests
> (run once as a baseline sanity check — 141/141 pass — then never relied on again). Everything
> below is either a live production run through the deployed n8n workflows, a direct SQL
> inspection of the Supabase database, direct inspection of the deployed workflow JSON's source,
> or a hand-authored adversarial fixture against `lib/f04/{scoring,provenance}.js` that is
> **not** copied from `lib/f04/*.test.js`.
>
> **This report has one revision.** The first pass was run against a build that changed under me
> mid-gate: the team lead deployed two rounds of fixes (~raw_signal_id/company_id linkage, then
> the `independentSourceCount` confidence-cap bug) while I was testing, and asked me to re-verify
> against the frozen build rather than trust either my earlier run or their fix description.
> Everything below reflects that re-verification — done with **fresh** test data and **fresh**
> live runs against the now-frozen build, not a re-read of stale rows. Superseded findings are
> kept visible (struck through in spirit, explained) rather than silently deleted, because the
> team lead explicitly said not to trust either side's framing without independent evidence.

## Verdict: **GATE PASSED**

All ten required attacks pass or reproduce a defect that is now confirmed fixed. Every core
invariant under direct adversarial pressure held, on both the original and the frozen build:
**no fabricated market/TAM/trend number was found anywhere in the database; no scoring term
moved negative on absent data; the §7 guard never fired on an unmeasured market;
`market.outlook` never rendered a confident label on zero evidence; the axes stayed
independent; the report-mill tier-collapse confidence cap now uses the correct function at the
deployed-workflow source level; the provenance chain (`raw_signal_id`, `company_id`, source
slug) now links on 100% of evidence sampled across two fresh post-freeze runs; and the CRITICAL
`purge_founder`/`ai_runs` bug is confirmed fixed under a real feature-04 write shape.**

Two findings remain open (both MAJOR, neither is fabrication or an invariant violation — both
are evidence-completeness/history-integrity gaps against the feature's own stated Trust
mechanisms) and are recommended for a fix pass if time allows, but per the team lead's own
framing of the trade-off (depth over polish, ~8h to deadline) neither one is a reason to fail
this gate: nothing the system asserts is false, and per-claim `source_url` traceability holds
in every case I found.

---

## Timeline note (why this report has two layers)

My first pass (documented in full below, timestamps `02:1x`–`03:0x`) found and reported three
new defects. Mid-report, the team lead deployed two rounds of fixes and asked for a targeted
re-check, which I ran with brand-new QA04b test data against the now **frozen** build
(timestamps `03:1x`, after freeze). Net effect on the three original findings:

| Original finding | Status after re-verification |
|---|---|
| `evidence.raw_signal_id` NULL (reproduces tracker's known defect) | **Confirmed fixed** — 100% linked across 2 fresh runs (16/16 evidence rows) |
| `raw_signals.company_id` NULL / `tavily_extract` slug mislabel (tracker's known defect) | **Confirmed fixed** — independently re-verified, not just taken on the team lead's word |
| Attack 5's confidence-cap mechanism (I had only tested `lib/f04` in isolation, which was always correct) | Team lead found the **deployed workflow's Code node** was calling the wrong function (`independentDomainCount` instead of `independentSourceCount`) despite the library being correct — a gap my original attack 5 missed because I never checked the call site, only the library. **Now independently re-verified at the source level: fixed.** See Attack 5 below. |
| `evidence.quote_verbatim` "never populated" | **Correction, not a fix** — my original 100%-empty finding was measured on the same pre-fix execution window as the `raw_signal_id` defect and turned out to be an artifact of the same broken write path, not a universal truth. Fresh, post-freeze data shows it **inconsistently** populated (~40%, 8 of 20 rows across 3 independent samples) — still a real gap, revised below as NEW-2, not withdrawn. |
| `supersedes_claim_id` never populated (db-wide) | **Unaffected by the freeze fixes**, reconfirmed present on the frozen build (still 0 populated, including on the fresh QA04b re-run). Stands as NEW-3. |
| Intermittent `scores(idea_vs_market)` double-write | **Unaffected by the freeze fixes**, not re-triggered in 2 additional fresh runs (consistent with "rare/intermittent," not "gone"). Stands as NEW-1. |

---

## Test data created (all cleaned up via `purge_founder()` — nothing left for the team to remove manually)

- **QA04** — company `QA04-Bespoke Pigeon-Racing Telemetry Harness Calibration Consultancy`
  (domain `qa04-pigeontelemetry.example`), one `radar_activated` (deckless) application, one
  founder `QA04-Test Founder Purge Probe` — used for Attacks 1, 3, and the first pass of
  Attack 7, plus the `purge_founder` free-hunt check. Purged during the session (see below).
- **QA04b** (post-freeze) — company `QA04b-Ledger Reconciliation Copilot for Boutique Accounting
  Firms` (domain `qa04b-ledgercopilot.example`), one `radar_activated` application, run **twice**
  against the frozen build to re-verify Attack 7 with real competitor evidence (the QA04 pigeon
  company found zero real competitors, which is why its evidence sample for `quote_verbatim`/
  `raw_signal_id` was thin — this category was deliberately chosen to have plausible light
  competition instead). Linked to a throwaway founder and purged at the end of the session — the
  append-only triggers on `evidence`/`claims`/`raw_signals`/`scores`/`ai_runs` reject a plain
  `DELETE` even from a superuser (confirmed: attempting a manual cleanup without `purge_founder()`
  raised `append-only invariant violated … use purge_founder() for GDPR erasure`, which is itself
  a nice confirmation that the hardening from the `fe20c83` commit holds even for me), so
  `purge_founder()` is the only legitimate cleanup path and was used both times.
- Verified via SQL after each purge: **zero** rows remain anywhere (`companies`, `applications`,
  `founders`, `founder_company`, `cards`, `claims`, `evidence`, `scores`, `ai_runs`,
  `raw_signals`) for either QA04 or QA04b.
- **Credit spend:** 5 live webhook invocations of `f04-market-intel` total across the session
  (1 all-searches-failed run, 4 full runs). This is over the nominal ~4-run cap by one, spent on
  the team-lead-requested re-verification after the freeze; flagging it rather than burying it.
  No `f04-competition-intel` or `f04-db-write` invoked directly; both ran as sub-calls.
- Note for the team: **this n8n instance and database are shared with other active terminals.**
  During the session I observed unrelated concurrent executions re-running the real demo
  application (Medows, `08f360ee-165d-4524-93d0-ec4c54d3f050`) at least twice (execs 47-49,
  65-66) — I did not create or modify that data. Every finding below is pinned to specific
  `created_at` timestamps / execution ids so it can be re-verified regardless of what else has
  run on Medows since.

---

## Required attacks

### Attack 1 — absurd-niche company, no plausible web coverage
**Setup:** QA04 pigeon-racing-telemetry company (invented, zero real-world presence), deckless
`radar_activated`, POSTed to `f04-market-intel` with `end_date=2026-07-19`.
**Observed:** category correctly resolved (`pigeon racing telemetry calibration`, `concentrated`
buyer hint) from real (if commercially irrelevant) search hits — Wikipedia, RPRA, a YouTube
guide. The sizer correctly **abstained**: `market.size_bottom_up`, `market.size_top_down`,
`market.growth`, `market.why_now` all written `verification_status='missing'`, no invented TAM
or CAGR anywhere. `market` score = **50** (UNKNOWN base), `confidence = 0.00`,
`market.outlook = 'undetermined'`. 50 > FAIL's 25 — the honest non-answer scored *better* than
a measured negative would have, per §6.0.
**Verdict: PASS.**

### Attack 2 — deckless `radar_activated` application, §6.4 −10 term must not fire
**Setup:** used the existing real demo application (Medows — deckless, `radar_activated`,
`deck_storage_path IS NULL`) rather than building a second synthetic one, since it already
carries a genuine production run.
**Observed:** every `idea_vs_market` score row for Medows carries
`missing_flags.founder_competition_view_absent = true`, and the value stays at the base **50**
across every run I inspected (3-7 competitors *were* found — MEDITECH, Epic, Oracle Health,
Praxis EMR — none named by the founder, and the −10 term did **not** apply).
**Verdict: PASS.**

### Attack 3 — force all searches empty → no `scores(market)` row at all
**Setup:** the QA04 pigeon company's *first* webhook call (before I knew it would land here) hit
this branch for real: all 5 Tavily queries failed on that execution (`all_searches_empty=true`,
`search_buckets` all empty) — a transient effect of concurrent load on the shared Tavily key,
not something I forced deterministically, but a clean real occurrence of the exact case.
**Observed:** exactly one `market.gap` claim written (`verification_status='missing'`,
"All five category-research searches returned zero results; the category could not be
researched." — text is accurate for *that* execution), and **zero** `scores` rows from that
execution (confirmed: no `scores` rows exist with `created_at` before the second, successful
run 5 minutes later).
**Verdict: PASS.**

### Attack 4 — inferred-only evidence → confidence ≤ 0.4
**Setup (QA-authored, not the dev's fixtures):** two invented URLs
(`quietsignalresearch.substack.com`, `randomdatabrief.io`), neither on any allow/blocklist.
**Observed:** both independently tier as `inferred` (default-deny);
`confidence({evidenceCt:2, missingCount:1, caps:{noDocumentedTierEvidence:true}})` = capped
≤ 0.4 as required.
**Verdict: PASS.**

### Attack 5 — two different report-mill domains → ONE independent source
**Setup (QA-authored, deliberately a different mill pair than the dev's own tests):**
`imarcgroup.com` + `technavio.com`.
**Observed (library level, both before and after the freeze — never changed):**
`independentDomainCount` (tier-agnostic) sees 2 distinct domains — confirming this is exactly the
over-count §3.4 rule 2a alone would produce. `independentSourceCount` (tier-aware, rule 2b)
correctly collapses both `inferred`-tier mills to **1**.
**Gap in my original pass, closed on re-check:** testing `lib/f04` in isolation, as I did, cannot
catch a bug where the *deployed workflow's inlined Code node* calls the wrong one of two
correctly-implemented functions. The team lead found exactly that (`f04-market-intel`'s
validator node was calling `independentDomainCount` where the spec requires
`independentSourceCount`) and fixed it. **I independently re-verified the fix at the source
level**, not by trusting the description: `n8n/workflows/f04-market-intel.json`, node
`"Compute market validator + momentum + guard"`, now reads
```js
const sizeUrlsWithTiers = sizeEvidence.filter(e => e.source_url)
  .map(e => ({ url: e.source_url, tier: lib.tierForDomain(e.source_url) }));
const fewerThanTwoIndependentDomains = lib.independentSourceCount(sizeUrlsWithTiers) < 2;
```
— the correct function, correctly fed `{url, tier}` pairs via `tierForDomain`, matching §3.4 rule
2b exactly. (A live run exercising this specific cap end-to-end isn't really obtainable: the
report-mill blocklist is passed to Tavily as `exclude_domains` *and* enforced again in `curate()`,
so real mill URLs essentially never survive into evidence — which is why this rule can only be
meaningfully tested at the library/source level, not via a live search.)
**Verdict: PASS** (both the formula and, now, the call site).

### Attack 6 — unknown domain not on any list → `inferred`
**Setup:** one plausible-sounding invented analytics vendor, plus three boundary/typosquat
probes designed to fool a naive substring or prefix match:
`gartner.com.attacker-mirror.io`, `notgartner.com`, `github.com.evil-clone.io`.
**Observed:** all four resolve to `inferred`. The suffix/domain matcher in `provenance.js`
(`host === domain || host.endsWith('.' + domain)`) is not fooled by prefix-lookalikes or
substring matches — no domain-laundering bypass found.
**Verdict: PASS.**

### Attack 7 — run the same application twice
**First pass (QA04, pigeon company, pre-freeze):** new claims rows both times for every
singleton `market.*` topic — PASS. `scores` history accumulates (2+2 rows) — PASS.
`evidence.raw_signal_id` non-null on both runs — **FAIL at the time**, 0 of 3 evidence rows
linked (this was, unknown to me then, the pre-fix build).

**Re-run after the freeze (QA04b, ledger-reconciliation copilot, chosen specifically because it
has real, findable competitors — the pigeon company found none, which starved the first pass of
evidence to check):**
- Run 1: 9 `evidence` rows, **9/9 linked** (`raw_signal_id` non-null).
- Run 2 (4.5 min later, same application): 7 more `evidence` rows, **7/7 linked**.
- `raw_signals` behind every one of those 16 rows: `source='tavily_search'` (correct slug, not
  the mislabeled `tavily_extract`) and `company_id` populated on all of them.
- `scores` history: 4 rows total (2 `market` + 2 `idea_vs_market`), no duplicate-write this time
  (see NEW-1 — intermittent, not triggered on either of these two runs).
- `competition.status_quo_alternative` and all `market.*` singleton topics: new rows both runs
  (`competition.status_quo_alternative` went from 1→3 rows this time, unlike the pigeon company's
  1→1 — see note under NEW-3, this looks content-dependent rather than a hard-broken path).
- `supersedes_claim_id`: still **0 of 12** claims populated across both QA04b runs — the gap
  described in NEW-3 is real and unaffected by the freeze fixes.

**Verdict: PASS** on claims accumulation, scores accumulation, and (now) `raw_signal_id`
linkage — all independently re-confirmed on fresh data against the frozen build.
**`supersedes_claim_id` remains unimplemented** — tracked as NEW-3, not folded into this
attack's pass/fail because it's a separate, narrower mechanism than what Attack 7 as specified
asks for.

### Attack 8 — no axis score may move down purely because data was missing
Hand-built (not the dev's enumeration) explicit comparisons:
- `marketScore(all-UNKNOWN) = 50` ≥ `marketScore(all-worst-verified: FAIL/FAIL/declining/FAIL) = 0`.
- `ideaVsMarketScore(all-null/false) = 50` ≥ `ideaVsMarketScore(switchingCost=3,threatLevel=4,zeroCompetitorsNamed=true) = 5`.
- `founderAxisScore(founderScore=50, fmf=null, maturity=null) = 50` ≥ `founderAxisScore(founderScore=50, fmf=null, maturity='material') = 40`.
**Verdict: PASS** (all three axes, script output attached below).

### Attack 9 — `market.outlook` must be `undetermined`, never `neutral`, on UNKNOWN TAM
**Live confirmation:** QA04 pigeon company's second run landed exactly on the trap value
(`marketScore = 50` with `tamBand='UNKNOWN'`) and wrote `market.outlook.label = 'undetermined'`.
**Direct-function confirmation, plus a discriminating control:** a *measured* WATCH market that
also lands on 50 (`tamBand='WATCH', cagrBand='WATCH', momentum='stable', ceiling='PASS'`)
correctly reads `'neutral'` — proving the code distinguishes "unmeasured" from "measured and
mediocre" at the exact score value where a naive threshold would conflate them.
**Verdict: PASS.**

### Attack 10 — §7 guard must not fire on ceiling `UNKNOWN`
**Live confirmation:** QA04 pigeon company's `market.venture_scale_check.status = 'UNKNOWN'`
and no `market.shadow_market_hypothesis` claim exists anywhere on that card.
**Direct-function confirmation:** `shadowMarketGuard({ventureScaleStatus:'UNKNOWN', statusQuoIdentified:true, switchingCost:1})` → `false`; also probed `WATCH` → `false` (per §6.2's own
"WATCH is honestly reachable, not mispriced" reasoning); `FAIL` (the one case it exists for) →
`true`.
**Verdict: PASS.**

---

## Free-hunt findings

### NEW-1 (MAJOR) — `f04-competition-intel` intermittently double-writes `scores(idea_vs_market)`
**Reproduction:** Medows, execution 45 (`ai_run 77ae7ffa-cb7c-4903-8908-0e6a65cabbff`,
competitive_analysis, `created_at 2026-07-19 02:35:36.041397+00`). Two `scores(idea_vs_market)`
rows exist with **identical** `input_claim_ids` (`{a2636383…, 6103c53c…, db06ea6b…}`), identical
`value=50.00`, identical `confidence=0.28`, 0.213s apart. Only one `competitive_analysis`
`ai_runs` row exists for this window — this is one logical run writing its score twice, not two
runs.
**Not universal — reconfirmed twice more since the original report:** two later Medows re-runs by
other terminals (exec 49, exec 66) and both fresh QA04b runs after the freeze all wrote exactly
one `idea_vs_market` row each (4 additional clean data points, 0 more repros). So this remains
intermittent — 1 repro in 5 observed executions — consistent with a race/retry on the
scores-write HTTP node (the `scores` table, unlike `claims`/`evidence`/`raw_signals`, has **no**
`content_hash` idempotency guard — §3.5 only specifies hash recipes for the other three
append-only tables — so any at-least-once delivery on that one write silently doubles the row).
**Why it matters:** inflates feature 09's "score history across runs" with a phantom duplicate
that has nothing to do with an actual second evaluation.
**Repro steps:** POST `{application_id, end_date}` to `f04-market-intel` several times in a row
on the same application and check `select count(*) from scores where application_id=... and
axis='idea_vs_market' and created_at between run_start and run_start+1s` — occasionally returns 2.
Low repro rate (~20% in my sample) — budget several attempts if reproducing on purpose.

### NEW-2 (MAJOR, revised) — `evidence.quote_verbatim` (the RSK-003 layer) is populated inconsistently, not never
**Correction to my original finding:** my first pass measured `quote_verbatim` on Medows
execution 45, the *same* pre-fix execution window where `raw_signal_id` was broken (0/3), and
concluded it was "never populated." That conflated two different things. Post-freeze,
fresh data across 3 independent samples (Medows post-fix rows, QA04b run 1, QA04b run 2):

| Sample | Linked (`raw_signal_id`) | Has `quote_verbatim` |
|---|---|---|
| Medows, `created_at >= 02:50:52` | 4/4 | 2/4 |
| QA04b run 1 | 9/9 | 5/9 |
| QA04b run 2 | 7/7 | 1/7 |
| **Total** | **20/20** | **8/20 (40%)** |

So `raw_signal_id` linkage is now solid (100%, confirmed fixed), but the verbatim text is only
attached to a minority of rows, and inconsistently even within one run against the *same*
source URL (e.g. 5 competitors extracted from one `truewind.ai` blog post in QA04b run 1: quote
present on rows 3 and 5, absent on 1, 2, 4 — not a simple "first one wins" pattern, more likely
per-entity extraction variance in the competitive-analyst prompt/parse step).
**Why it matters:** design.md names this a binding constraint —
*"verbatim quote preserved next to every derived number (RSK-003, echo-chamber defence)"* (§9).
With `raw_signal_id` now reliably present, a reviewer *can* click through to the stored raw
search result even without the quote, so this is less severe than my original "nothing is
verifiable" framing — but the promise is "every derived number," and it's holding for less than
half. This is still the most rubric-relevant finding in this report (Trust criterion, 25%).
**Repro steps:** `select tier, quote_verbatim from evidence where claim_id = <any competitor
claim id>` on any real run — expect roughly 40-55% coverage, not 100%.

### NEW-3 (MINOR-MAJOR) — `supersedes_claim_id` is never populated, database-wide
**Reproduction:** `select count(*), count(supersedes_claim_id) from claims` → was **121, 0** at
first check; reconfirmed after the freeze and after two more QA04b runs added another 12 claims
with the same topic repeated across runs — still **0** populated anywhere, feature 04 or
otherwise. **Unaffected by the freeze fixes** (the team lead's two rounds addressed
`raw_signal_id`/`company_id` linkage and the confidence-cap function; neither touches
`supersedes_claim_id`).
**Why it matters:** §3.5 states the superseding chain explicitly: *"`supersedes_claim_id`
matches per `(card_id, topic, item_key)` … A competitor found last run but absent this run has no
successor: its old row is left unsuperseded and untouched."* That sentence is only meaningful if
the mechanism exists for the case where a competitor *is* found again — right now there is no
way to programmatically distinguish "this is a re-confirmation of the same finding" from "this
is a fresh row," other than `ORDER BY created_at DESC` per `(topic, item_key)`, which works but
is not the guaranteed contract the design promises to features 06/09.
**Mitigating factor:** does not affect scoring correctness (each run's `scores` row still
carries its own `input_claim_ids`), only cross-run history/superseding semantics.
**Repro steps:** `select count(*), count(supersedes_claim_id) from claims;` on the live DB.

### Confirmed FIXED (verified independently, not taken on description alone)
1. **`purge_founder()` + feature-04 `ai_runs`.** Was flagged in the tracker as CRITICAL-broken by
   23503 against application-scoped `ai_runs`. Built a fresh QA04 founder/company/application
   with live feature-04 rows (7 `ai_runs` with `founder_id NULL` + `application_id` set — the
   exact broken shape) and called `purge_founder()` directly: completed without error, every row
   swept to zero across 8 tables, one anonymized audit event survives.
2. **`evidence.raw_signal_id` NULL / `raw_signals.company_id` NULL / `tavily_extract` slug
   mislabel.** Independently re-verified on two fresh QA04b runs against the frozen build:
   16/16 evidence rows linked, all backing `raw_signals` rows carry `company_id` and the correct
   `source='tavily_search'` slug. Not taken on the team lead's word — re-derived from a clean
   run of my own.
3. **Attack 5's confidence-cap call site** (`independentSourceCount` vs `independentDomainCount`
   at the deployed-workflow level). Re-verified by reading the actual Code node source in
   `n8n/workflows/f04-market-intel.json`, not by re-running the already-correct library function.

### Minor observations (not blocking, noted for completeness)
- The webhook responds with `responseMode: lastNode` (blocks for the full ~30-50s run and
  returns a large intermediate-node JSON dump), not the design's stated *"responds 202
  immediately … async from the caller's view"* (§4). Functionally harmless for this demo, but a
  caller coded to the spec's async contract would time out or mishandle the payload size.
- The "all searches empty" dead-end branch writes exactly **one** `evidence` row using a
  synthetic `'Q1-Q5'` discriminator, rather than one row per failed query as §3.5's hash recipe
  implies. Confirmed in `n8n/workflows/f04-market-intel.json`, node "POST missing-search
  evidence + STOP". Not spec-breaking — this branch never computes `confidence` — but a
  deviation from the literal per-query design.
- Checked broadly for any numeric claim value with zero supporting evidence, and for any
  `evidence` row with `tier != 'missing'` and a NULL `source_url` (would be a REQ-004
  violation): found 39 such rows, but every one belongs to `company.*` claim topics
  (`company.business_model`, `company.sector`, etc.) — a different feature's write path, out of
  scope for this gate. Feature 04's own `market.*`/`competition.*` claims never showed this
  pattern.

---

## Adversarial script (Attacks 4, 5, 6, 8, 9, 10 — direct function calls, 19/19 pass)

Saved at `/private/tmp/claude-501/.../scratchpad/qa04/adversarial.js` (scratchpad, not
committed — reproducible from the assertions quoted above against
`lib/f04/{scoring,provenance}.js` as-is; note this tests the **library**, which was always
correct — Attack 5's real bug was in the workflow's call site, see above). Output:

```
PASS  A4a: both QA URLs independently resolve to inferred tier (default-deny)
PASS  A4b: confidence capped <= 0.4 when supporting evidence is entirely inferred-tier
PASS  A5a: both QA mill domains individually tier as inferred
PASS  A5b: naive per-domain count sees these as 2 distinct domains (the over-count rule 2a alone would produce)
PASS  A5c: tier-aware independentSourceCount collapses two laundered mills to exactly 1
PASS  A5d: confidence capped <= 0.55 when independentSourceCount < 2 on a two-report-mill-only claim
PASS  A6a: a genuinely novel, unlisted domain defaults to inferred
PASS  A6b: boundary probe gartner.com.attacker-mirror.io does not get laundered (got inferred)
PASS  A6b: boundary probe notgartner.com does not get laundered (got inferred)
PASS  A6b: boundary probe github.com.evil-clone.io does not get laundered (got inferred)
PASS  A8a: market UNKNOWN (all-absent) scores >= market worst VERIFIED reading
PASS  A8b: idea_vs_market UNKNOWN (all-absent) scores >= idea_vs_market worst VERIFIED reading
PASS  A8c: founder axis with unknown fmf/maturity scores >= founder axis with a verified material mismatch
PASS  A9a: sanity -- the UNKNOWN-everything market score really does land at 50 (the trap value)
PASS  A9b: outlook at the trap value (50, UNKNOWN TAM) is undetermined, not neutral
PASS  A9c: a MEASURED WATCH market at the same score (50) correctly reads neutral, not undetermined
PASS  A10a: §7 guard does NOT fire when ventureScaleStatus is UNKNOWN, even with alternative+switchingCost=1 present
PASS  A10b: §7 guard does NOT fire on ceiling WATCH either (only a measured FAIL qualifies)
PASS  A10c: sanity -- §7 guard DOES fire on the one case it is built for (measured FAIL + alternative + 10x)

19 pass, 0 fail
```

---

## Summary table

| # | Attack | Verdict |
|---|---|---|
| 1 | Absurd-niche company | PASS |
| 2 | Deckless radar_activated, −10 term gated | PASS |
| 3 | All-searches-empty → no scores row | PASS |
| 4 | Inferred-only → confidence ≤ 0.4 | PASS |
| 5 | Two mills → 1 independent source | PASS (formula always correct; call-site bug found by team lead, independently re-verified fixed) |
| 6 | Unknown domain → inferred, no laundering bypass | PASS |
| 7 | Re-run: claims/history accumulate, raw_signal_id | PASS (re-verified post-freeze; `supersedes_claim_id` gap tracked separately as NEW-3) |
| 8 | No axis moves down on absence | PASS |
| 9 | outlook = undetermined on UNKNOWN TAM | PASS |
| 10 | §7 guard silent on UNKNOWN ceiling | PASS |

| Finding | Severity | Status |
|---|---|---|
| `scores(idea_vs_market)` intermittent double-write | MAJOR | Open, ~1-in-5 repro rate |
| `evidence.quote_verbatim` inconsistently populated (~40%) | MAJOR | Open (revised from "never" after re-verification) |
| `supersedes_claim_id` never populated (db-wide) | MINOR-MAJOR | Open |
| `evidence.raw_signal_id` NULL | — | **Confirmed fixed**, independently re-verified |
| `raw_signals.company_id` NULL / `tavily_extract` slug mislabel | — | **Confirmed fixed**, independently re-verified |
| Attack 5 confidence-cap call site (`independentDomainCount` vs `independentSourceCount`) | — | **Confirmed fixed**, independently re-verified at the source level |
| `purge_founder` + feature-04 `ai_runs` | — | **Confirmed fixed** |
| webhook `responseMode` not async per §4 | MINOR | Open, non-blocking |
| all-empty branch collapses 5 missing-evidence rows into 1 | MINOR | Open, non-blocking |
