# 05 · Truth-Gap Check & Trust Score — DONE / Handoff

> For features **06 (memo)** and **09 (dashboard)**, which are blocked on this one.
> Design: [`design.md`](design.md) · Plan: [`plan.md`](plan.md) · Execution: [`tracker.md`](tracker.md)
> QA: [`qa-report-05.md`](qa-report-05.md)

---

## 1. What to read, in one line each

| Thing | Where |
|---|---|
| Per-claim trust + verdict | SQL view **`claim_trust`** — read it straight through PostgREST |
| Application-level Trust axis | `scores` where `axis='trust'` |
| Contradiction records (structured) | `events` where `event_type='claim_contradicted'` |
| Audit trail ("when did we check this?") | `events`, one row per claim per run |
| Deterministic core (source of truth) | `lib/f05/*.js`, 197 tests |
| Workflows | `f05-trust-rollup` · `f05-verify-claims` · `f05-contradiction-scan` |

---

## 2. Five rules you must follow — each of these is a way to get it wrong

### 2.1 Read `derived_status`, **not** `claims.verification_status`
The view's own column is authoritative. `claims.verification_status` is a best-effort write-back
(design §8.4) and may lag.

### 2.2 An absent trust row means **not assessed** — never zero
If `scores(axis='trust')` has no row for an application, check for a
`trust_rollup_insufficient_evidence` event. Rendering absence as `0` inverts REQ-003, which is the
sponsor invariant this whole feature exists to protect.

### 2.3 Never display the rollup value alone
Wherever `value` appears, **coverage and the disagreement breakdown must appear beside it** — counts
of `contradicted`, `partially_supported` and `missing`. `coverage` is persisted inside
`missing_flags` precisely so you can show it without recomputing (a recomputation would drift, since
the score row is a snapshot and the view is live).

A clean number over a contested evidence base is the failure this feature exists to prevent. This is
REQ-002's do-not-collapse rule applied one level down.

### 2.4 Read the contradiction **event** set in addition to the verdict set
A contradiction on a `qualitative` claim legitimately never becomes a `contradicted` *verdict* — the
router class gate suppresses it — but it still lowers the trust number and it is still a real
finding. If you build your risk section from verdicts alone, that finding appears **nowhere**.

```sql
SELECT payload FROM events
WHERE event_type = 'claim_contradicted'
  AND entity_type = 'founder' AND entity_id = ANY(:founder_ids)
ORDER BY created_at DESC;     -- payload->>'claim_id' selects one claim
```
Company-scoped contradictions (`competition.*`, `market.*`) are written with the card's founder in
`entity_id`; where a company card has no resolvable founder they use
`entity_type='application'` (that payload carries no personal data by construction). Query both.

### 2.5 Do not render a trust row whose application has no claims in scope
There is one known stale row in the database (see §5). A trust row is only meaningful alongside the
`input_claim_ids` that produced it.

---

## 3. The vocabulary — for badges

**Verdict** (`derived_status`), mapped onto the AVeriTeC label set:

| Value | Means |
|---|---|
| `verified` | Supported — independent evidence at documented/discovered tier, no contradiction |
| `contradicted` | Refuted — documented-tier contradiction that passed the entity gate |
| `partially_supported` | Conflicting / cherry-picked — support **and** contradiction both present |
| `unverified` | Not enough evidence |
| `missing` | A first-class gap ("Cap table: not disclosed") |

**Provenance** (`evidence.tier`), a separate axis: `documented` / `discovered` / `inferred` /
`missing`. Never conflate the two — `missing` is a provenance state, `contradicted` is a verdict,
and only the two-field form expresses REQ-003 honestly.

**Plus a `Forecast` label** for `router_class='forecast'` claims (TAM and similar), so a projection
never reads as a failed verification.

⚠️ **This vocabulary, the evidence-on-click pattern and §2.3's display rule are inputs to 09's
`lovable-brief.md`** and must be carried there verbatim as frozen contracts (root CLAUDE.md hard
rule #10), not re-derived.

---

## 4. What the system actually did — honest numbers

| | |
|---|---|
| Claims routed | **all of them** — the corpus grew from 724 to **951** during the build as other terminals kept sourcing, and `count(claim_trust) = count(claims)` held throughout. The view is live, not a snapshot; it routes and scores whatever is in the table when you query it |
| Classes (measured at 724) | qualitative 424 · factual_static 267 · factual_dynamic 30 · forecast 12 · unverifiable 1 |
| `min_coverage` | **0.25** — calibrated, not inherited. The distribution over the 117 applications with verdict-eligible claims is sharply bimodal (median 1.00; 72 apps at ≥0.9) and 0.25 sits in the valley between the sparse tail (ceiling 0.1429) and the next cluster. 7 of 117 fall below and correctly write no row |
| Paid external checks | ~40–50 possible; **20 Tavily credits** actually spent |
| Provenance checks on real founders | **32 checked, 31 clean, 0 flagged, 1 insufficient data** |
| Live LLM calls (contradiction path) | 7 |
| Tests | **197, zero failures** |

**Zero flagged on provenance is the honest result, not a shortfall.** The check ran on 32 real
founders using commit-level GitHub data ingested for this purpose, comparing each repo's earliest
commit against an independent anchor the founder does not control (their Show HN date). Nothing
suspicious was found. We did not go looking for a case to force into the demo.

Likewise the Tavily branch produced **0 verdicts on 15 checkable claims** — correct, because those
fixtures are fictional companies with no public footprint. Its positive path was validated against a
real founder's traction claim, where genuine third-party corroboration was found and a social-media
source carrying a *conflicting* revenue figure was correctly tiered so it could neither verify nor
contradict.

---

## 5. Known limitations — state these, do not paper over them

1. **The entity gate is fail-shut on third-party `supports`.** Measured: 0 of 5 live candidates
   survive, *including 3 genuine third-party sources*. Only gate steps 1–2 run on that path; step 1
   cannot resolve (we deliberately withhold our own insert-time FK) and step 2 only matches the
   company's own domain — but third-party corroboration is by definition not on that domain.
   Under-claiming is the right direction to err, but this is not the end state. **Fix: wire gate
   step 3 (the LLM entity-matcher, spec in `agents/entity-matcher.md`) into the supports path.**
2. **One stale score row cannot be retracted.** `scores.id=7e0c43c0-…` (`value=62.71`) was written by
   QA's own demonstration of a since-fixed bug. We deliberately did **not** delete it: `scores` is
   append-only and the only bypass exists for GDPR erasure — using it to tidy a demo would break a
   guarantee we make to the judges. **Design gap this exposed:** a wrongly-computed score cannot be
   retracted at all, because "absence ≠ zero" also forbids writing a corrective placeholder.
   Post-MVP this needs a `superseded_by` column or a retraction event type.
3. **Two stale `supports` rows** from the pre-fix same-name incident, same reasoning, self-healing at
   the scores layer via `max(computed_at)`.
4. **`quote_guard` negation detection is lexical, not semantic** — a paraphrased flip
   ("has not launched publicly" vs "went live to the public") is missed **by design**. Deliberate
   false-negative bias: a false accusation against a truthful founder breaks REQ-004, and that costs
   more than a missed catch.
5. **Duplicate `scores` rows are accepted by design** (§8.3) — `scores` has no idempotency guard and
   a real one needs an advisory lock. "Current" resolves by `max(computed_at)`.
6. **Route-2 scope over-narrowing (theoretical, zero live cases).** If a company is ever re-screened
   under a second application expected to inherit an enduring company-level card, that claim is now
   excluded. QA searched the corpus and found no instance today.
7. **No validation against human judgement.** Evidence-backed, explainable and reproducible is not
   the same as accurate. No κ pass was run.
8. **The Tavily `factual_dynamic` check lives in the CLI runner, not in the deployed n8n workflow.**
   `f05-verify-claims` contains no Tavily code; `lib/f05/dynamic.js` + `run.js` do. Not a correctness
   risk — an unchecked `factual_dynamic` claim simply stays an honest gap — but **the memo and video
   must say "the CLI runner", not "the workflow", for this specific check.**
9. **"32 founders checked, 31 clean" describes the check's *capability*, not the corpus's *persisted
   state*.** 52 of 72 eligible founder×card pairs have not been re-run since `ingest_commits.js`
   landed. If the demo shows live dashboard numbers rather than a narrated walkthrough, run a full
   pass first.
10. **Three stale `contradicts` rows on a throwaway test claim** (`05f0aaaa-…-009003`) from before the
    LLM-hash fix, leaving it at `trust=0.0000` when it was genuinely contradicted once. Append-only,
    not deleted, on the same reasoning as §5.2. No demo application reads that entity.

---

## 6. Cross-feature notes

- **Feature 07 reads `claims.verification_status` live** (`=eq.contradicted` in its thesis gate;
  `isUsable()` excludes `missing`/`contradicted`). 07 is closed, so our write-back can move its
  verdicts. Regression-checked at the QA gate.
- **Sole writer of `scores(axis='trust')`.** We never touch `founder_score` (03), `market` /
  `idea_vs_market` / `founder` (04) or `thesis_fit` (07).
- **Schema additions:** the `claim_trust` view, `f05_host()`, and one `score_formulas` row. **No new
  tables**, therefore no `REVOKE TRUNCATE` and no `purge_founder()` edit.
- **Licences:** `quote_guard.js` is a port of Apache-2.0 `due-diligence-agents`; the claim /
  contradiction record vocabulary follows Apache-2.0 `reporting`. Both require attribution in the
  repo-root `NOTICE`.

---

## 7. Running it

```bash
# headless, whole pipeline for one application
node lib/f05/run.js <application_id>

# the rollup alone, via n8n
curl -X POST http://localhost:5678/webhook/f05-trust-rollup \
  -H "Content-Type: application/json" -d '{"application_id":"<uuid>"}'

# tests — the glob form is mandatory
node --test lib/f05/*.test.js

# labelled ground-truth fixture (idempotent, not applied by apply.sh)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/05-truth-gap.sql
```

Demo application: **Medows** `08f360ee-165d-4524-93d0-ec4c54d3f050` → trust **19.50**, confidence
**0.43**, 12 input claims, coverage 0.667.

Two real, reproducible contradictions live in the corpus today:
`founder.execution.provenance` and `founder.execution.tech`, both documented-tier.
**The demo must not depend on feature 04's `competition.founder_claim_mismatch`** — that path has
never fired live.
