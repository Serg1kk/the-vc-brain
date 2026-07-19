# 04 · Market, Trend & Competition Intel — Implementation Plan

> Status: **rev.2 — plan-review R1 applied** (2026-07-19 ~06:15). Operator gave go at ~05:05
> and full autonomy at ~05:50; revisions below are orchestrator decisions, logged in §Decisions.
> Spec: [design.md](design.md) rev.3 (+ §6.6 scope addition). Tracker: [tracker.md](tracker.md).

## Guiding decision

**The deterministic scoring core is built first, as standalone JS modules with a test harness —
before any n8n node exists.** Every defect three rounds of spec review found was in this
arithmetic. Arithmetic buried inside n8n Code nodes cannot be unit-tested, diffed, or attacked
by QA. As modules it can be, and the same source is then pasted into the Code nodes.

## Stages & parallelism

| Stage | Runs | Parallelisable? |
|---|---|---|
| A | Registry seed · AI agent specs | **A1 ∥ A2** — different files |
| B | Scoring core (`B1a`) · provenance core (`B1b`) | **B1a ∥ B1b** — disjoint files, no shared state |
| C | `f04-db-write` → `f04-competition-intel` → `f04-market-intel` | **Sequential.** See C-ordering note |
| D | Integration run on a real company | Sequential after C |
| E | QA gate | Sequential after D |
| F | Close: handoff, README pair, final commit | Sequential after E |

**C-ordering note (plan-review R1, CRITICAL).** The write path was originally last, but C1/C2's
acceptance both require reaching write nodes — a circular dependency. `f04-db-write` is now a
shared sub-workflow built first. Competition-intel is built before market-intel because
market-intel contains an Execute Workflow node targeting it, which needs its ID to exist.

**Shared-file convention for wave-1 (the "no shared files" claim was wrong).** `db/seed.sql` is
appended to by 02/03/07 as well, and all four run `db/apply.sh` against one live DB. Feature 04
appends at EOF under its own banner, never edits above it, and re-runs apply+smoke after
confirming the tail is still its own. A1's smoke-count collision was this class of problem
surfacing early.

---

## Task board

### Stage A — foundations

**A1. Registry seed** · @database-engineer · deps: none · **DONE**
Two `signal_sources` rows (§3.1). Uncovered and fixed two cross-cutting defects — see tracker.

**A2. AI agent specifications** · orchestrator in role (`ai-agent-builder`) · deps: none
Three agents per §9. *Acceptance:* five artifacts each; every output-schema field has a named
consumer in §3.2/§3.3; models match §9 (luna / sol / terra); `buyer_concentration` marked
non-authoritative in the categorizer spec; each prompt carries the §9 guardrails including a
worked **abstention** example.

### Stage B — deterministic core

**B1a. `lib/f04/config.js` + `lib/f04/scoring.js` + tests** · @backend-developer · **deps: none**
(*not* A2 — every signature takes primitives already typed in §6/§3.3; the agent schemas read
from the same source and do not define them. Field-name mapping is C's job.)
Functions: `tamBand` · `cagrBand` · `deriveConcentration` · `ventureScaleCheck` · `momentum` ·
`marketScore` · `ideaVsMarketScore` · `founderAxisScore` (§6.6) · `confidence` · `outlook` ·
`shadowMarketGuard`.

*Acceptance:*
1. **Ceiling grid** over tamLow ∈ {100M, 300M, 400M, 600M, 1B, 1.5B, 2B, 3B, 5B, 10B} × three
   tiers: PASS at $1B/$2B/$5B, FAIL below $300M/$600M/$1.5B, FAIL/PASS ratio 0.30 in every tier.
2. **§6.1's own TAM gate** asserted separately: PASS ≥$1B / WATCH [$500M,$1B) / FAIL <$500M —
   plus the two documented cross-gate disagreements, which are §6.2's central claim and were
   previously untested: `$1B long_tail` → §6.1 PASS **and** ceiling FAIL; `$400M concentrated`
   → §6.1 FAIL **and** ceiling WATCH.
3. **The §6.0 property test — stated correctly this time.** The original wording («absence must
   never decrease the value») was **wrong** and unimplementable: CAGR PASS +10 → UNKNOWN 0
   decreases by 10, as do momentum and switching_cost. What REQ-003 actually requires is that
   **absence never scores worse than a verified negative**. Assert, over an enumeration (not a
   sample) of term combinations:
   `value(term = UNKNOWN) ≥ value(term = that term's worst verified reading)` **and** every
   unknown branch contributes exactly 0.
4. `founderAxisScore({founderScore: null, …})` → **`null`**, not 0. A person 03 has not scored
   gets no founder axis row, never a zero one.
5. Ranges: market 0…84; idea max exactly 100 and reachable (the +8 nonlinearity is deliberate).
6. `momentum`: thin-signal branch wins at recent+prior < 3 even when the ratio reads improving;
   RFC 1123 parsing (`"Fri, 26 Jun 2026 06:06:36 GMT"` — the real Tavily format, verified live);
   unparseable/absent date → undated, never `now()`; **undated-majority forces the term to 0**.
7. **Confidence cap ordering:** `evidence_ct=0` (cap 0.15) + §7 guard fires → **0.10** (floor),
   not 0.15. §7 applies after §6.5's caps; the reverse order silently restores confidence.
8. `outlook`: `tamBand=UNKNOWN` → **`undetermined`**, not `neutral` (value is exactly 50 there,
   so a naive threshold returns neutral — that is the bug this case exists to catch).
9. `shadowMarketGuard`: fires on FAIL + alternative + switching_cost 1; does **not** fire on
   ceiling UNKNOWN (a hypothesis on an absent TAM is REQ-004 fabrication); does **not** fire on
   ceiling WATCH ($400M concentrated).

**B1b. `lib/f04/provenance.js` + tests** · @backend-developer · deps: none · **∥ with B1a**
`tierForDomain` · `independentDomainCount` · `contentHash.rawSignal/claim/evidence` · `curate`.
Split from B1a because it shares no state with the formulas, and it is what `f04-db-write`
actually needs — so splitting unblocks Stage C earlier. Different files → no conflict.

*Acceptance:*
1. `tierForDomain('https://astuteanalytica.com/…')` → `inferred` (unknown-domain default-deny —
   this exact domain surfaced in a live probe and was **not** on the blocklist).
2. `independentDomainCount`: two report mills → **1**; a `.co.uk` pair and a subdomain pair
   handled by registrable domain, not by string.
3. Hashes: two competitors in one run → different claim hashes; two `tier='missing'` evidence
   rows on one claim from different queries → different evidence hashes; **two runs with the
   same pinned `end_date` → identical `raw_signals` hashes** (this is what makes
   select-by-hash work, and its absence is C0's headline failure mode).
4. `curate`: first-party URL at score 0.1 survives the relevance gate; the same first-party URL
   twice → one row; blocklisted domain at score 0.9 → dropped.

**B1c. `lib/f04/fixtures/`** · @backend-developer · with B1a/B1b
Nobody owned the fixture set, yet B's tests, C2's standalone run and all of E1 need it.

### Stage C — n8n workflows (@n8n-workflow-builder, one owner: they share contracts)

**C0. `f04-db-write`** (shared sub-workflow) · deps: B1b
Every Supabase write per §3.5/§3.6: card preflight · `raw_signals` select-by-hash→insert →
**always with `company_id`**, `observed_at = coalesce(published_date, end_date)` · `claims` with
`item_key` hashes, per-item `supersedes`, NOT NULL `text_verbatim`, `base_confidence` per
source_kind · `evidence` with `strength` from the §3.4 tier table · three `scores` rows ·
`ai_runs` always, carrying `output_json.config` and `.credits`.
*Acceptance:* two runs → new claims both times; **non-null `raw_signal_id` on every evidence row
both times**; a competitor in both runs → run-2 supersedes run-1; a competitor in run 1 only →
run-1 row left unsuperseded and unmodified; a run writing 3 tailwinds + 4 competitors → 7 rows,
no 23505.

**C1. `f04-competition-intel`** · deps: C0 — §8, incl. the missing-target guard and the
four-case severity ladder enumerated as assertions.

**C2. `f04-market-intel`** · deps: C0, C1 — §4's chain, five queries, `exclude_domains`, pinned
`end_date`, single batched `/extract`, all five error branches as real node paths, the §7 guard,
`concentration_revised` reconciliation, and the **full §3.2 topic vocabulary** as an explicit
write checklist (previously unowned: `why_now` with its typed `catalyst_kind`, tailwinds,
headwinds, `size_top_down`, `venture_scale_check`, `trend`, `shadow_market_hypothesis`,
`outlook`).
*Acceptance for C1+C2:* exported JSON at `n8n/workflows/f04-*.json`, credentials stripped
(submission needs a public repo, and workflows otherwise live only in a Docker volume).

### Stage D — integration

**D1. End-to-end on one real company** · @backend-developer · deps: C2
*Acceptance:* three `scores` rows; every claim traceable claim → evidence → raw_signal →
source_url; credits ≤ 15; every numeric claim's `source_url` resolves to a live page containing
the figure; `prompt_version` on the score row matches the A2 spec file's version string.

### Stage E — QA gate

**E1. Adversarial QA** · @qa-engineer · deps: D1 · independent attacks, never a re-run of B's
unit tests. The 8 original attacks, **minus** the old attack 8 (it duplicated B1 criterion 3 and
inherited its wrong wording), **plus** five the review found uncovered:
§7 false-positive on ceiling UNKNOWN · incumbent-anchored TAM → UNKNOWN not FAIL ·
N-rows-per-run hash collision (3 tailwinds + 4 competitors) · undated-majority news →
flag raised, no improving bias · `outlook = 'undetermined'` on UNKNOWN TAM.
*Acceptance:* `qa-report-04.md`, GATE PASSED, every finding → fix → **independent** re-check.

### Stage F — close

**F1. Handoff + README pair + final commit** · orchestrator → @devops
`handoff.md` carrying §11's four downstream contracts — especially 06's two must-honour rules
(never threshold on `scores.value` alone; an absent axis row means «not assessed», not zero).
Without it 06 renders our honesty about ignorance as a zero, the precise inversion of REQ-003.
Feature README status updated **EN + RU in the same pass** (CLAUDE.md rule; `README.ru.md`
already exists here).

### Git — @devops only, and it was missing entirely

Commit points: after A1 · after Stage B · after each of C0/C1/C2 · after D1 · after E1 · F1
closing commit. Per-feature paths only, never `git add -A` (three other features share this repo
in parallel terminals). **No push** — operator's standing instruction.

---

## Decisions log

| # | Decision | Why |
|---|---|---|
| D1 | B1+B2 merged, then re-split as B1a/B1b | scoring.js imports config.js — that seam collides; provenance.js shares no state — that seam doesn't, and splitting it unblocks C0 |
| D2 | C1+C2 merged to one owner, order C0 → competition → market | they share the Execute Workflow contract; two owners would diverge on the interface |
| D3 | Momentum window fixed at 90/180d constant, not thesis-configurable | §12 open item; constants live in `config.js`, so it stays a one-line change if the demo wants otherwise |
| D4 | Second-model disagreement check (§12) dropped unless QA clears early | stretch; the rubric pays for depth on what exists, not for breadth of half-built checks |
| D5 | `axis='founder'` accepted from feature 03's terminal, full composition | operator-approved ~05:40; without it REQ-002's three axes are two |
