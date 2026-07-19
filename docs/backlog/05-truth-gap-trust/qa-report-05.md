# 05 · Truth-Gap Check & Trust Score — QA Report (Pass 1 + Pass 2, adversarial)

> Scope pass 1: deterministic core only — `claim_trust` view, `lib/f05/{router,quote_guard,trust,
> entity_gate,verifiers,run}.js`, `db/fixtures/05-truth-gap.sql`.
> Scope pass 2 (final gate): everything landed since — `lib/f05/dynamic.js` (Tavily), `lib/f05/
> ingest_commits.js`, the three n8n workflows (`f05-verify-claims`, `f05-contradiction-scan`,
> `f05-trust-rollup`), the LLM contradiction path, and cross-feature/GDPR sweeps.
> Neither pass re-runs the developers' own tests as verification. Every finding below was produced
> by a query or attack the developers did not write.

## FINAL VERDICT: **GATE PASSED** (updated after independent re-verification of the fixes — see
"Pass 2, round 2" at the very bottom)

Pass 1 found two reproducible defects; round-2 re-verification confirmed Finding 1 fixed and Finding
2(a) fixed. Pass 2 found one new CRITICAL defect (Finding 3, LLM-path idempotency) plus context on
Findings 4/5. **All of Finding 3, Finding 2(b), and (found while re-attacking 2(b) independently) a
narrower residual of 2(b) have now been checked against fixed code, by me, live — see the final
section for the exact method (not the fixers' own counts) and the one narrow, disclosed residual
that remains.**

---

## Finding 1 (CRITICAL) — the application-scope predicate leaks a sibling application's entire Trust rollup

**What is wrong.** `docs/backlog/05-truth-gap-trust/design.md` §8.1 and its implementation in
`lib/f05/trust.js` (`isClaimInScope`, route 2) scope a claim into an application's rollup with:

```
row.card_company_id != null && row.card_company_id === ctx.companyId   // route 2, no other condition
```

Route 3 (the founder join) is explicitly restricted to avoid leaking a founder's *other* company's
claims (`card_company_id IS NULL OR card_company_id === ctx.companyId`, `lib/f05/trust.js:140-149`).
Route 2 carries no equivalent restriction on `card_application_id`. Design §8.1 assumes this is safe
because "company cards … are not attached to any specific application row" — but the live schema
does not enforce that, and it is false for the corpus's actual data: a `founder`-type card can (and
regularly does) carry **both** `company_id` and a specific, different `application_id`.

**Why this happens live, not just in theory.** `applications.kind = 'radar_activated'` rows are
created once per sourcing-radar activation event (feature 02); only one of them per company ever
gets promoted to carry real `cards`. The other activation rows are legitimate, distinct `applications`
rows for the same company, with **zero cards of their own**. Measured 2026-07-19:

```sql
WITH app_cards AS (
  SELECT a.id AS application_id, count(k.id) AS own_cards
  FROM applications a LEFT JOIN cards k ON k.application_id = a.id GROUP BY a.id
),
company_cards AS (SELECT company_id, count(*) c FROM cards WHERE company_id IS NOT NULL GROUP BY company_id)
SELECT count(*) FILTER (WHERE ac.own_cards = 0 AND cc.c > 0) AS leak_candidates,
       count(*) FILTER (WHERE ac.own_cards = 0 AND cc.c IS NULL) AS honestly_empty,
       count(*) AS total_applications
FROM app_cards ac LEFT JOIN company_cards cc ON cc.company_id = (SELECT company_id FROM applications WHERE id = ac.application_id);
```
→ **104 of 308 applications (34%)** have zero cards of their own *and* their company has cards
elsewhere — these are exactly route 2's leak candidates. (81 more are honestly empty — correctly
headed for `insufficient_evidence` — and 123 own real cards, matching design.md's own measured
"123 applications carry claims".) All 104 are `kind = 'radar_activated'`.

**Reproduced live, with a real write.** `a3413aa3-90ec-4591-978d-49040665ff7b` is "safehttp"'s
card-bearing application (28 claims, real GitHub-provenance evidence). Its sibling
`9f0268d3-f0f4-49ca-b1e3-e67fbf0e7977` is a *different* application row for the same company, with
**no cards of its own**:

```
node lib/f05/run.js 9f0268d3-f0f4-49ca-b1e3-e67fbf0e7977
```
```
[f05/run] superset=28 scoped=28
[f05/run] wrote 18 evidence row(s) (ON CONFLICT DO NOTHING)
[f05/run] wrote 46 event row(s)
[f05/run] wrote scores row 7e0c43c0-6e61-486c-b1ba-642211ace2fb value=62.71 confidence=0.7
```
`9f0268d3-…` now carries a fully "scored" Trust row — `value=62.71`, `confidence=0.70`,
`coverage=1.0` — **entirely computed from `a3413aa3-…`'s claims**, none of which belong to this
application. An investor opening this specific radar-activation record on the dashboard sees a
complete, confident Trust score for a submission on which zero of this feature's actual work has
been done. Reproduced a second time on a different company ("puffinsoft",
`993beb30-ffd8-4637-9556-9195448ae121`, a cardless sibling of `3dced4fa-cbf6-48c1-87ad-2467df5c4f2a`,
company `198d2999-f407-41cc-a29a-ed09da9cc013`, which has **7** sibling applications) — same leak,
here self-limiting only by chance because the borrowed set's coverage (0.083) happened to fall below
`min_coverage`.

**Invariant this violates.** Not one of REQ-002/003/004 directly, but the design's own §8.1 contract
("which claims belong to an application") and, materially, Investment Utility & Execution and Data
Architecture & Intelligence (dedup/ingestion correctness) — an investor cannot trust that a Trust
score on application X was computed from application X's own submission.

**Fix (not applied — reporting only, per instructions).** Route 2 needs the same restriction route 3
already has: `card_company_id = ctx.companyId AND (card_application_id IS NULL OR card_application_id
= ctx.applicationId)`, in both `design.md` §8.1's SQL and `lib/f05/trust.js`'s `isClaimInScope`.

**Cleanup note.** This pass wrote real rows while demonstrating the bug (see "State changes" below);
they were produced through the actual application code path, not corrupted data, and are left in
place per the QA brief (destructive cleanup was not requested and these are legitimate appends).

---

## Finding 2 (MAJOR) — `quote_guard.js` has two structural false-positive classes; dormant today, not fixed

`lib/f05/quote_guard.js` is the fabrication-detection module design.md §5.1(a) calls "load-bearing"
and ports "verbatim" from an external Apache-2.0 source. Two of its four salience checks misfire on
ordinary, true, pre-seed-deck language:

**(a) Numeric ranges.** `CURRENCY_RE`, `DURATION_RE` and `PERCENT_RE` all require the number to sit
immediately adjacent to its unit/currency/percent marker. A range like "$1-2 million" only yields a
token for the second number ("$1" is followed by `-2`, not a unit, so it is extracted as a bare,
unit-less $1). Confirmed live:

```js
quoteSalienceMismatches('We raised $1-2 million in our seed round.',
                         'The company raised $1.5 million in a seed round led by a local angel syndicate.')
// -> [ 'currency $1 in quote not supported by source' ]

quoteSalienceMismatches('We grew revenue by 10-15% quarter over quarter.',
                         'Quarterly revenue growth was approximately 12% for the company.')
// -> [ 'percentage 15% in quote not supported by source' ]

quoteSalienceMismatches('Runway of 12-18 months at current burn.',
                         'The company reported approximately 14 months of runway remaining.')
// -> [ "duration '18 months' in quote not supported by source" ]
```
All three source claims are **true** (the range legitimately contains the point figure the
independent source reports); all three are flagged as fabrication signatures.

**(b) Common true negation.** `NEGATION_RE`'s modal-auxiliary clause
(`(?:shall|will|would|may|can|must|does|do|is|are|was|were|has|have)\s+not`) is far broader than the
"liability-flip" cases the file header cites as its justification ("shall indemnify" → "shall not
indemnify"). It also matches ordinary, honest pre-seed disclosures:

```js
quoteSalienceMismatches('The company does not currently generate revenue.',
                         'Nordkit is developer tooling and infrastructure that lets backend teams trace and debug distributed systems in production.')
// -> [ 'negation mismatch: quote asserts a negation absent from the cited source passage' ]
```
Any claim phrased "we do/does not …", "we have not …", "is not yet …" — exactly the honest,
self-aware limitation disclosures REQ-004/REQ-003 want to *reward*, not punish — trips this the
moment the (paraphrased, independently-collected) source doesn't happen to restate the identical
negation, which is the normal case.

**This is not academic — traced end-to-end through the real write path.** `runQuoteGuardCheck`
(`lib/f05/run.js`) feeds a mismatch straight into `applyEntityGate` using the **same `raw_signal_id`
the claim's own citation already points to** (`candidate.raw_signal_id`/`candidate.rs_founder_id` in
`loadQuoteGuardCandidates`'s query). Confirmed live that this resolves trivially at gate step 1
(`raw_signal_fk`) — it can never reach step 4's downgrade, because the "contradicting" source and the
claim's own founder are, by construction, the same entity:

```js
applyEntityGate({ claimId: 'x',
  candidate: { sourceUrl: '…', quote: "duration '18 months' in quote not supported by source", tier: 'documented' },
  rawSignal: { id: 'rs-1', founderId: 'founder-42', companyId: null },
  entity: { founderId: 'founder-42', companyId: null } })
// -> { resolved: true, entityMatch: { resolved_by: 'raw_signal_fk', ... } }
```
So a range- or negation-triggered false mismatch **does** become a real, documented-tier `contradicts`
evidence row. Because the claim already carries the `supports` row it was quoted from (that's the
precondition for even entering `loadQuoteGuardCandidates`), the view's mixed-evidence rule
(§7.4 row 3, independently verified by me — see below) fires: `derived_status` lands
`partially_supported`, not flatly `contradicted`, but `contradiction_penalty` (−0.30 trust) is still
applied to a claim that was **true**. This is precisely the harmful-flip failure design §12 built the
labelled fixture to catch, and it is not in that fixture's ground truth.

**Currently dormant, not fixed.** Searched the live corpus's entire quote_guard candidate pool for any
range-phrased claim text (`text_verbatim ~ '[0-9]+[ ]?[-–][ ]?[0-9]+'`): zero matches. `quote_guard_checks_run`
across every application I ran (Medows, safehttp, Fogline, puffinsoft) never hit a range or a
qualifying negation, so no live evidence row has been corrupted by this yet. But it is a property of
the regex, not of today's data — the instant a founder's deck (or new demo/synthetic data) phrases a
figure as a range, or states a true limitation with "do/does/has not," this fires.

**Invariant this risks.** REQ-004 ("never fabricate") and the AVeriTeC framing design §1.1 itself
leads with — a true claim rendered as evidence-conflicted, with a real trust penalty attached.

---

## Helpful-fixes vs. harmful-flips — the two required numbers

From `db/fixtures/05-truth-gap.sql`'s 10 labelled claims, independently re-queried by me against the
live `claim_trust` view (not taking the developers' word for it):

```sql
SELECT claim_id, topic, router_class, derived_status, n_supports, n_contradicts, trust
FROM claim_trust WHERE claim_id::text LIKE '05f00005-%' ORDER BY claim_id;
```
All 10 rows matched the fixture header's expectation table exactly:

- **Helpful fixes: 2/2 (100%)** — the two genuinely-contradicted claims (`…0101`, `…0102`) both
  render `contradicted`.
- **Harmful flips (on this fixture): 0/4 (0%)** — the four true-and-evidenced claims (`…0103`,
  `…0104`, `…0201`, `…0202`) all render `verified`, untouched.
- Both honest-gap claims (`…0105` round.cap_table, `…0106` traction.customer_references) render
  `missing`, never `contradicted` — the AVeriTeC NEI-to-Refuted guard holds.
- Tier-3-only claim (`…0203`) never reaches `verified`. Qualitative-class documented contradiction
  (`…0204`) stays `unverified`, verdict correctly suppressed.

**Caveat that belongs next to this number, not omitted:** this 0% harmful-flip figure is scoped to
the 10 labelled claims, none of which use range-phrased or common-negation language. Finding 2 above
is a harmful-flip source this fixture's ground truth does not exercise at all — the true corpus-wide
harmful-flip rate, once `quote_guard` runs against realistic deck text, is not yet known and is very
likely above 0%.

---

## Attacked and could NOT break (evidence this belongs in the submission too)

- **D1's fixture, independently re-verified** — all 10/10 claims match their documented expectation
  exactly (query above).
- **Idempotency of the rollup VALUE.** Ran `node lib/f05/run.js 08f360ee-165d-4524-93d0-ec4c54d3f050`
  (Medows) twice back to back: `value=19.5, confidence=0.43` both times, `0` new evidence rows written
  on the second run (content_hash `ON CONFLICT DO NOTHING` held). Events and `scores` rows do
  duplicate on each run (accepted by design §8.3 — "resolve current by `max(computed_at)`"), but the
  **number never drifts**, which is what actually matters.
- **Tier-3 self-verification guard.** Tried to make an `inferred`-tier support (even with an
  overridden high `strength`, which the view's `base` formula would honor) render `verified` — the
  view's verified rule (§7.4 row 7) gates on **tier membership** (`documented`/`discovered`), not on
  `strength`, so this is structurally blocked regardless of strength value. (Checked the live data
  too: every `inferred`-tier support's explicit `strength` is ≤0.40, so this isn't even live-exploitable
  today — but the guard holds by construction either way.)
- **`precomputed`-class contradiction cap — untested by any existing test, verified directly by me.**
  `grep -n "precomputed" db/tests/smoke.sql db/fixtures/05-truth-gap.sql` returns **nothing** — this
  branch (added proactively by A1, flagged in the tracker as "§7.4 lacked an explicit row") had zero
  test coverage. Built and ran my own probe in a rolled-back transaction: a `competition.founder_claim_mismatch`
  claim (routes to `precomputed`) with a documented-tier contradiction and zero supports renders
  `partially_supported`, never `contradicted`. Holds.
- **NULL `source_url` + NULL `raw_signal_id` contradicts row — the "04 mismatch" shape design says
  "has never fired live," and no smoke.sql fixture populates NULL `source_url`.** Built and ran my own
  probe (rolled back): renders `contradicted` correctly, no crash; a second such NULL/NULL row on the
  same claim (distinguished only by `content_hash`, as §10.1 requires from the writer) both count,
  `n_contradicts_counting=2`, `contradiction_penalty=0.60` — correct arithmetic, no collision.
- **GDPR entity routing.** Audited every event written by my own test runs (423 rows,
  `actor='lib/f05/run.js'`): zero broken FKs (`entity_type='founder'` always resolves to a real
  `founders.id`; `entity_type='application'` always resolves to a real `applications.id`), zero cases
  of `entity_id` holding a `claim_id`, zero `entity_type='application'` `claim_contradicted` payloads
  (none fired in my runs, so nothing to leak — but the code path was exercised for `attempted`/
  `unmatched_topic` events and stayed clean).
- **Feature-07 regression.** `SELECT * FROM claims WHERE topic LIKE 'company.%' AND
  verification_status='contradicted'` → **0 rows**, before and after every run I performed. 07's live
  `verification_status=eq.contradicted` gate (`n8n/build-f07-workflow.py:810`) is unaffected.
- **Missing → confidence only, never founder_score.** Every write path in `run.js` (`writeScoreRow`)
  hardcodes `axis='trust'`; no code path in this feature touches `scores(axis='founder_score')`.
- **`min_coverage` gate ordering.** Confirmed live on "puffinsoft" (`993beb30-…`): coverage `0.083 <
  0.25` → **no `scores` row written**, only `trust_rollup_insufficient_evidence`. The guard fires
  before any mean is computed, so a low-coverage application can't produce a misleadingly-precise
  number.

---

## State changes made during this pass (transparency, not a request for cleanup)

Ran the real `node lib/f05/run.js <application_id>` against live applications the developers did not
test, through the actual application code path (no manual DB surgery, no truncation, nothing deleted):

- `993beb30-ffd8-4637-9556-9195448ae121` (puffinsoft duplicate) — insufficient_evidence, 11 evidence,
  15 events, 1 ai_runs row.
- `08f360ee-165d-4524-93d0-ec4c54d3f050` (Medows) — run twice; 2 more `scored` rows (5th/6th on this
  application; 4 already existed from prior dev runs), 122 events, 2 ai_runs rows, 0 new evidence.
- `07f00002-0000-0000-0000-000000000002` (Fogline) — insufficient_evidence, 0 evidence, 13 events,
  1 ai_runs row.
- `9f0268d3-f0f4-49ca-b1e3-e67fbf0e7977` (safehttp duplicate, Finding 1's proof) — **scored**,
  18 evidence, 46 events, 1 ai_runs row, 1 `scores` row (`7e0c43c0-6e61-486c-b1ba-642211ace2fb`).

All three boundary-condition SQL probes (precomputed cap, NULL/NULL contradicts, mixed-evidence
smoke-equivalent) ran inside `BEGIN; … ROLLBACK;` and left no trace.

---

## Re-verification, round 2 — both fixes checked independently, not by re-running the fixers' tests

### Finding 1 fix — CONFIRMED, plus one residual (currently dormant) over-narrowing risk

`isClaimInScope` route 2 in `lib/f05/trust.js` now reads
`card_company_id === ctx.companyId && (card_application_id == null || card_application_id === ctx.applicationId)`.
Verified directly against the live database, not against the fixers' own claim:

- **The exact leak app re-run.** `node lib/f05/run.js 9f0268d3-f0f4-49ca-b1e3-e67fbf0e7977` now
  reports `superset=28 scoped=0`, writes **zero** new evidence/events, and the coverage-gate correctly
  produces `insufficient_evidence` (no new `scores` row). `SELECT count(*), max(computed_at) FROM
  scores WHERE application_id='9f0268d3-…' AND axis='trust'` is still `1 / 2026-07-19 08:06:43` — the
  one stale row from my original demonstration, untouched (see "known-open" note below).
- **A different, previously-untouched leak candidate.** Picked `0399594b-b1ac-46db-8a96-7dd2f0154891`
  fresh from the 104-candidate list (company `0aaff77f-…`, whose real cards of 7 claims live under
  sibling application `e795eed5-f1d2-453e-9d24-fddd6a82ddc7`) — neither I nor, as far as the tracker
  shows, the fixers had run this one. `superset=7 scoped=0`, `insufficient_evidence`, no scores row.
  Fix generalizes past the one case I originally named.
- **Legitimate application unchanged.** Re-ran Medows (`08f360ee-…`):
  `value=19.5, confidence=0.43, coverage=0.667, verdict_eligible_count=18, assessed_count=12` — bit
  for bit identical to the pre-fix numbers in this report's Finding-1 section.
- **Attacked for over-narrowing (the failure mode nobody had tried).** Searched the live corpus for
  the shape that would prove the fix now excludes claims that should be in scope: (a) any company
  whose cards span **more than one** distinct non-null `application_id` (a genuinely shared
  company-level card across two real applications) — **zero found**; (b) any company with both an
  `inbound` and a `radar_activated` application (the most plausible real re-application shape) —
  **zero found** (304 `radar_activated` / 9 `inbound`, no overlap). So there is **no live
  over-narrowing case today.** But the shape is real and worth recording rather than discovering
  later — confirmed with a direct, pure-function probe (no DB writes):

  ```js
  const row = { card_company_id: 'company-1', card_application_id: 'app-A1', card_founder_id: null };
  isClaimInScope(row, { applicationId: 'app-A1', companyId: 'company-1', founderIds: [] }); // -> true
  isClaimInScope(row, { applicationId: 'app-A2', companyId: 'company-1', founderIds: [] }); // -> false
  ```
  If a company is ever legitimately re-screened as a **second, real** application (not a
  pre-screening `radar_activated` echo) and that second application is expected to inherit an
  enduring company-level card (sector, geography, etc.) created under the first application rather
  than recollecting it from zero, this fix will now silently exclude it — same "quietly renders less
  than it should" shape as Finding 1, mirrored. Not exploitable in the current corpus (feature 02
  evidently gives every real application its own fresh card set today), but worth a one-line note in
  `06`/`09`'s handoff so it isn't rediscovered as a surprise later if that assumption ever changes.

**Verdict on Finding 1: fixed for every case tested, including one the fixers hadn't checked. No live
regression. One theoretical, currently-dormant boundary noted for the record.**

### Finding 2 fix — 2(a) fully fixed; 2(b) only partially fixed, one surviving false positive found

**2(a), numeric ranges — confirmed fixed, real catches still fire.**

```js
quoteSalienceMismatches('We raised $1-2 million in our seed round.',
                         'The company raised $1.5 million in a seed round led by a local angel syndicate.') // -> []
quoteSalienceMismatches('We grew revenue by 10-15% quarter over quarter.',
                         'Quarterly revenue growth was approximately 12% for the company.')                 // -> []
quoteSalienceMismatches('Runway of 12-18 months at current burn.',
                         'The company reported approximately 14 months of runway remaining.')                // -> []
// real catches, unaffected by the range fix:
quoteSalienceMismatches('We closed the deal in just 90 days.',
                         'The negotiation and signing process took 30 days from first contact.')
  // -> ["duration '90 days' in quote not supported by source"]
quoteSalienceMismatches('We raised $2,000,000 in our seed round.',
                         'The company disclosed a seed round of $5,000,000 in regulatory filings.')
  // -> ['currency $2000000 in quote not supported by source']
```

**2(b), negation — NOT fully fixed. A surviving false positive, distinct from the one originally
reported.** My original "does not currently generate revenue" case (source entirely silent on the
topic) is now correctly clean. But the fix's "positive assertion" rule extracts up to 4 loose content
words following the negation cue as the "predicate," and flags if **any one** of them appears
un-negated **anywhere** in the aligned source window — not whether the source actually asserts the
opposite of the *specific thing being negated*. An incidental, topically-adjacent noun is enough:

```js
quoteSalienceMismatches(
  'We have no paying customers yet and do not charge for the beta.',
  'The product is currently in closed beta with five design-partner teams providing feedback on the core workflow.'
)
// -> ['negation mismatch: source positively asserts the opposite of a negation in the quote']
```
Both sentences are consistent, honest, and true (no paying customers; a beta with unpaid design
partners) — there is no contradiction here at all. Isolated the exact cause:

```js
quoteSalienceMismatches('We do not charge for the beta.',
                         'The product is currently in closed beta with five design-partner teams.')
// -> same false positive
quoteSalienceMismatches('We do not charge for the beta.',
                         'The product is currently in a closed pilot with five design-partner teams.')
// -> [] (clean once "beta" is removed from the source)
```
The negated predicate is "charge" (what's actually being denied); the source never mentions charging
at all and should be clean. But `negationPredicateWords()` also collects the *following* word "beta"
(a topic noun, not part of what's being negated) into the same 4-word predicate set, and the
"flipped" check is an `.some(...)` over all of them — so "beta" appearing anywhere un-negated in the
source (here, in an unrelated sentence about the product's own beta status) is enough to flag the
whole quote, even though the source never speaks to charging at all. This reaches the same real
`contradicts` write path as before (same raw_signal reuse → entity gate resolves trivially at step 1,
as already shown in this report) — it is not a cosmetic residual, it is the same REQ-004 exposure
Finding 2 originally reported, just narrowed from two failure classes to one.

**Requested false-negative probe — a genuine fabrication now missed, confirmed:**

```js
quoteSalienceMismatches('The product has not launched publicly yet.',
                         'The product went live to the public in March and has been available for purchase since.')
// -> []
```
This is a real, substantive contradiction (the product demonstrably has launched) missed because the
source paraphrases with "went live" rather than repeating "launched"/"publicly" verbatim — exactly
the trade-off the code's own comment states it is deliberately biased toward ("missing a real
fabrication costs one finding, while a false accusation … breaks REQ-004"). Two adjacent attempts at
the same class (a paraphrased competitor denial, a paraphrased customer-signing denial) were in fact
still caught, only because an incidental keyword ("market", "enterprise"/"customer") happened to
recur in the source — which, per the finding above, is exactly the mechanism producing false
positives elsewhere. The false-negative rate for genuinely well-paraphrased fabrication and the
false-positive rate for topically-adjacent true statements are two faces of the same design choice
(matching on incidental words rather than the actual negated relationship) and should be evaluated
together, not as two independent trade-offs.

**Verdict on Finding 2: 2(a) is fixed. 2(b) reduced the false-positive surface but did not close it —
recommend against calling this sub-finding resolved.**

---

# Pass 2 — the final gate: LLM path, Tavily, cross-feature, GDPR

Everything new since pass 1 was read in full: `lib/f05/dynamic.js`, `lib/f05/ingest_commits.js`,
`n8n/build-f05-workflow.py`'s three workflow builders (`build()` / `f05-trust-rollup`,
`build_verify_claims()`, `build_contradiction_scan()`), and `design.md` §5.9/§6.0b. Then attacked
against the live database and the live Tavily/OpenAI endpoints — not against the generators' own
unit tests.

## Finding 3 (CRITICAL) — the LLM contradiction path is not idempotent; re-running it drives a claim's trust to zero

**What is wrong.** `f05-contradiction-scan`'s duplicate guard (`evidence.content_hash`, per design
§10.1) is built on `candidateKey = primary.found_reality` — the LLM's own generated text describing
what it found. Every other check in this feature keys `candidateKey` off **stable, byte-identical
content** (a GitHub commit date, a fixed regex-extracted mismatch string) — content_hash is safe to
rely on for dedup precisely because two runs over the same data produce the identical string. An LLM
call does not have that property: asked the same question against the same evidence twice, it
paraphrases differently. That breaks the one invariant `content_hash` exists to protect.

**Reproduced against live data, not constructed.** This already happened, in ordinary use, before I
touched anything — I found it by inspecting the database, not by forcing it:

```sql
SELECT id, relation, tier, quote_verbatim, content_hash, created_at
FROM evidence WHERE claim_id = '05f0aaaa-0000-0000-0000-000000009003' ORDER BY created_at;
```
Three **distinct** `contradicts` evidence rows, three distinct `content_hash` values, all citing the
exact same underlying claim and the exact same underlying evidence, from five separate
`f05-contradiction-scan` invocations over five minutes (08:36–08:41):

| created_at | found_reality (verbatim) |
|---|---|
| 08:36:53 | "a rolling 30-day total of 4,200 processed transactions" |
| 08:37:27 | "a rolling 30-day total of 4,200 processed transactions **across all connected accounts**" |
| 08:41:35 | "System status page reports a rolling 30-day total of 4,200 processed transactions across all connected accounts." |

(A 4th and 5th invocation happened to reproduce wording already seen, so they deduplicated — the
guard isn't *never* effective, it's **unreliably** effective, which is arguably worse: it creates the
appearance of a working safeguard.)

**Measured effect on the claim right now:**
```sql
SELECT n_contradicts, n_contradicts_counting, contradiction_penalty, trust, derived_status
FROM claim_trust WHERE claim_id = '05f0aaaa-0000-0000-0000-000000009003';
-- n_contradicts=3, n_contradicts_counting=3, contradiction_penalty=0.8000 (hit the 0.30×n cap), trust=0.0000
```
This is exactly the failure design §10.1 built the `content_hash` discriminator to prevent, stated
almost verbatim in `lib/f05/verifiers.js`'s own header: *"a duplicate `contradicts` row doubles
`contradiction_penalty` from 0.30 to 0.60 and halves a claim's trust because a webhook fired twice."*
Here it did not merely double — three non-deduplicated re-detections of **the same single real
finding** hit the hard cap and zeroed the claim's trust out completely. (In this instance the
underlying claim genuinely was contradicted — a company claiming "over one million transactions/month"
against an independent source reporting ~4,200/30 days is a real, large discrepancy, and `derived_status`
correctly stays `partially_supported` rather than a flat `contradicted` because the underlying evidence
tier is `discovered`, not `documented` — so this specific case is not a harmful-flip demonstration. It
is, however, a live demonstration that the exact same true finding can be made to cost a claim 3× the
trust penalty it should, purely by invoking the workflow more than once — which will happen the moment
anyone retries a failed call, re-triggers a scan by hand, or an at-least-once webhook fires twice, the
precise scenario design §10.1 was written to guard against.**

**Root cause, precisely.** `n8n/build-f05-workflow.py`'s `build_contradiction_scan()`, the "LLM
DISPATCH" node: `primary = found1 ? call1.contradiction : call2.contradiction`, then
`candidateKey: primary.found_reality` at the evidence-write call. Confirmed via the `ai_runs` ledger
that k_index=0 and k_index=1 genuinely returned **different verbatim text** for the same
question/evidence pair within a single invocation too (08:37:27: k0 says "...across all connected
accounts", k1 omits that clause) — both scored `contradiction_found: true`, so `agree = found1 ===
found2` reads `true`, and **K=2 "agreement" is therefore checked on the boolean flag only, never on
whether the two calls agree on content.** `primary` is always call1's version when call1 says true,
so call2's (possibly differently-worded, possibly more/less complete) finding is silently discarded —
matching the design's own stated rule ("if both, call1's"), but meaning the persisted text, and hence
the content_hash, is only as stable as a single LLM call's phrasing, never actually cross-checked
between the two.

**Invariant this violates.** The idempotency requirement stated directly in the brief for this pass,
and design §10.1's own explicit purpose for `content_hash`'s discriminator fields.

**Fix (reporting only, not applied):** `candidateKey` for an LLM-sourced contradiction needs to be
built from something stable across repeated calls over the same input — e.g. a hash of
`(claim_id, evidence.raw_signal_id or quote_verbatim, question)` rather than of the model's own
prose — so a re-run of the same comparison always collapses to the same row regardless of how the
model happens to phrase its finding that particular time.

## Finding 4 (confirmed, self-disclosed, precisely characterized) — the Tavily branch's entity gate is currently 100% fail-shut on third-party evidence, not merely under-performing

The team already found and disclosed this (`done.md` "Known limitation #1", `tracker.md`'s own
"HEADLINE KNOWN LIMITATION" section) before I looked: 0 of 5 live `supports`/`contradicts` candidates
from a genuine Tavily search have ever survived the entity gate, including 3 non-adversarial,
genuinely-independent third-party sources. My job was to confirm it's real and find its actual shape,
not take the disclosure at face value.

**Confirmed via direct code read**, not just the prose: `lib/f05/run.js`'s `runFactualDynamicCheck`
calls `applyEntityGate({ claimId, candidate, rawSignal: { id: rawSignalId }, entity })` with **no
`matchWithLlm` param** — step 3 (the LLM entity-matcher, the team's own proposed fix) is not wired
into this call site. Step 1 cannot resolve (the code deliberately omits `founderId`/`companyId` on
`rawSignal` here, on purpose, so a same-name adversarial match can't trivially self-certify — see the
file's own comment). Step 2 only matches the company's own domain, which a third-party source is
definitionally not on.

**Confirmed live, with a fresh, previously-unexamined case — and I can now state the actual shape
precisely, which the disclosure did not:** since `tierForSourceKind` pins **both** `social_media` and
`company_domain` results to `inferred` (excluded from `n_supports_docdisc`/`n_contradicts_counting`
regardless of gate outcome — they can never move a verdict), and `third_party` results are the
**only** source kind that could ever reach `discovered` tier and move a verdict, and **every**
`third_party` candidate must pass the very gate that structurally cannot resolve it — the practical
consequence is not "reduced effectiveness," it is: **as currently wired, the Tavily `factual_dynamic`
branch cannot produce a single verdict-moving `supports` or `contradicts` row from genuine independent
evidence, in either direction, at all.** It can only ever write `inferred`-tier (verdict-inert) rows
or gate-failure `context` rows. Verified this precisely by tracing every possible `sourceKind` →
`tier` → gate-requirement path in `lib/f05/dynamic.js`+`entity_gate.js`, not by sampling outcomes.

Live reproduction against a fresh case the fixers hadn't measured: re-ran the CLI runner against
GameLoop (`07f00002-…-0004`) after the fix landed — `dynamic_checks_run=4, dynamic_credits_used=4,
dynamic_evidence_written=0`. Traced exactly where each of the 8 raw Tavily results per query was
dropped (a standalone script calling `passesRelevanceGate` directly): the two real `gameloop.com`
Android-emulator pages that caused the original incident are now correctly rejected by the
**pre-filter**, before the entity gate is even reached — confirming that half of the fix. But every
other result was rejected too, because GameLoop is a fictional `.example` company with no real
footprint to find — this specific case doesn't exercise the entity-gate-rejects-genuine-evidence path
(there is no genuine evidence for a fictional company). The genuine-third-party-source measurement
(`getlatka`/YouTube/a blog) instead comes from the team's own earlier validation against a **real**
founder (traced to Medows' company via `raw_signals.company_id`, historical rows predating this fix)
— consistent with, and confirming, the disclosed number.

**Verdict: real, accurately disclosed, not gate-blocking on its own** — it fails in the safe direction
(under-claim, never a false `verified`/`contradicted`), exactly the REQ-003/004 trade-off this whole
feature is built around, and the fix (wire entity-matcher into this path too) is already scoped. I am
restating it here with the precise, now-fully-traced severity ("zero capability," not "reduced
capability") so it is not underestimated in planning, and confirming the team's own number rather than
taking it on faith.

## Finding 5 (gap, not a bug per se) — the deployed n8n `f05-verify-claims` workflow has no Tavily/`factual_dynamic` branch at all

`grep -c "tavily\|dynamic" n8n/build-f05-workflow.py` inside `build_verify_claims()`'s ~740 lines:
**zero hits.** The CHECKS node there is a hand-port of `lib/f05/run.js`'s `runGithubProvenanceCheck` /
`runQuoteGuardCheck` only — the entire `factual_dynamic` (Tavily) branch exists **only** in the
headless CLI runner (`lib/f05/run.js`), not in the production n8n workflow the team lead's own message
lists as "active" (`UubHQ9HZWVdOrKjq`). This is not silent-fabrication risk (a `factual_dynamic` claim
simply gets no evidence from this workflow and stays an honest `unverified` gap, same as any other
unchecked claim — REQ-003-safe), but it is a real gap between what the CLI can demonstrate and what
the deployed production path actually does, worth knowing before claiming in the memo/video that
"the n8n workflow checks Tavily-sourced traction claims" — today, only running `node lib/f05/run.js`
does that; triggering the webhook does not.

## Confirmed clean / already fixed — restated precisely, not re-taken on faith

- **Entity gate cannot be bypassed on the write side.** Read all three workflows' write sites for a
  `contradicts`-relation row (`lib/f05/run.js`'s two CLI checks + the Tavily branch;
  `f05-verify-claims`'s hand-ported CHECKS node; `f05-contradiction-scan`'s LLM DISPATCH node) —
  every single one is `if (gate.resolved) { write contradicts row } else { write context row,
  never contradicts }`. No syntactic path writes a `contradicts` row outside that branch in any of
  the three workflows or the CLI.
- **`ai_runs.confidence` is NULL on every row this feature has ever written — checked exhaustively,
  not sampled.**
  ```sql
  SELECT count(*) FROM ai_runs WHERE confidence IS NOT NULL
    AND (output_json->>'agent' IN ('contradiction-detector','entity-matcher') OR model IN ('deterministic:f05_run','deterministic:f05_verify_claims'));
  -- 0, against 37 total feature-05 rows (22 + 4 + 10 + 1)
  ```
- **GDPR — raw_signals FK-null count is exactly 9, all `tavily_extract` (feature 04's, pre-existing),
  zero of feature 05's own 16 `tavily_search` rows have both FKs NULL.**
- **GDPR — events entity routing.** Zero `events` rows anywhere in the database have
  `entity_type='application'` with a broken `entity_id`. The only `entity_type='founder'` rows with a
  non-resolving `entity_id` are 10 legitimate `founder_purged` tombstones (by construction — the
  founder no longer exists once purged) plus one unrelated feature-02 event with a NULL entity_id;
  none belong to feature 05. Zero `claim_contradicted` events on the `entity_type='application'`
  fallback carry `founder_claim` or `entity_match.quote`.
- **Feature 07 regression — checked with live, current data, both of 07's own read patterns
  specifically, on the exact application (GameLoop) where 05's write-back changed a stored value.**
  07's gap-detection query (`claims?...&topic=like.company.*&verification_status=eq.contradicted`)
  returns 0 rows today, same as before any of this feature's activity — no `company.*` claim has ever
  been written `contradicted`. Separately, `company.what_is_built` on GameLoop's card was written back
  from `unverified` to `verified` by 05 (an artifact of the pre-fix same-name incident) — but 07's
  `isUsable()` (`verification_status !== 'missing' && !== 'contradicted' && source_kind !== 'derived'`)
  passes identically either way, so this specific write-back changes nothing 07 reads differently. I
  did not re-invoke `lib/f07/run.js` itself (it requires a `--recorded` fixture directory I was not
  set up to supply correctly, and misusing another feature's runner risked writing a wrong evaluation
  into a closed feature's table for the wrong reason) — this is a direct, read-only reproduction of
  both of 07's actual queries against current data, which answers the same question without that risk.
- **Idempotency of the CLI/deterministic paths, re-verified including the new Tavily branch.** Ran
  Medows twice (`19.5/0.43` both times, 0 new evidence) and GameLoop twice post-fix (`51/0.49` both
  times, `dynamic_checks_run=4` both times — 4 fresh, real Tavily calls each run, genuinely
  non-cached — yet 0 new evidence rows and an identical trust value). The non-idempotency lives
  specifically in the LLM path (Finding 3), not in the deterministic checks or the Tavily fetch/dedup
  logic, which behave correctly under repetition.
- **GitHub provenance is genuinely running, not a silent no-op — verified by making it run, twice,
  against founders the existing "31 clean" measurement had not touched.** Ran
  `node lib/f05/run.js b355a09c-30fd-47f5-822e-617c449a6a85` and a second, different application —
  both produced a fresh, correctly-dated, real `documented`/`supports` comparison (not a stub, not
  `insufficient_data`), confirming the check function itself works on real commit + Show HN data.
  **However:** cross-referencing which (founder, card) pairs actually have both qualifying inputs
  (72, by card) against how many still show zero evidence at all (52) shows most of the corpus has
  simply never been (re-)run since `ingest_commits.js` landed new commit data — the "32 checked, 31
  clean" figure describes what happens when the check runs, correctly, not the corpus's current
  persisted state. Worth a full re-run pass before the demo if the video/memo will show live
  dashboard numbers rather than a narrated single-application walkthrough.
- **The two residual `verified` claims from the pre-fix GameLoop incident are still live and
  uncorrected** (`done.md`'s own "Known limitation #3") — confirmed still rendering `verified` right
  now, confirmed harmless to 07 (above), confirmed `scores`/`evidence` append-only semantics make them
  uncorrectable without a retraction mechanism that doesn't exist yet. Not new; restated because it's
  still true.

## Helpful fixes vs. harmful flips — restated against the current code

Unchanged from round 1, re-verified against the current `claim_trust` view (unaffected by anything
landed since): **2/2 helpful fixes (100%), 0/4 harmful flips (0%)** on `db/fixtures/05-truth-gap.sql`'s
10 labelled claims. The live LLM contradiction case examined above (Finding 3) is not a labelled
fixture claim and is not counted in this figure, but it is worth noting directly: the underlying
finding it repeatedly re-detected was itself a genuine, large discrepancy (~1,000,000/month claimed vs.
~4,200/30-days independently reported) — i.e. this session's live LLM activity produced 0 observed
harmful flips, only the idempotency defect described in Finding 3.

## Final call

**GATE BLOCKED on Finding 3** (LLM-path idempotency — CRITICAL, live-reproduced, directly costs a
claim's trust score on ordinary re-invocation) and **Finding 2(b)** from pass 1 (negation false
positive, still open). Findings 4 and 5 are known/disclosed or fail-safe and do not block on their
own, but belong in the submission's honest-limitations section. Everything listed under "Confirmed
clean" above is real, independently-attacked evidence for the submission — it is not padding.

---

## Pass 2, round 2 — independent re-verification of the fixes (not the fixers' own counts)

The team lead reported Finding 3 fixed (independently, by C1b, discovered via its own idempotency
testing before my report landed — messages crossed) and asked for a final call on F3/F4/F5. Re-verified
each myself, live, rather than accepting either side's report.

**Finding 3 — CLOSED, independently confirmed.**
- Code: `n8n/build-f05-workflow.py`'s LLM DISPATCH node now anchors both the entity-gate candidate and
  the written evidence row to `pair.evidence.quote_verbatim` / `pair.evidence.raw_signal_id` — data
  already stable in the database before the LLM call — not to `primary.found_reality` (the model's own
  variable extraction). `found_reality` is preserved in full on the `claim_contradicted` event payload
  and in `ai_runs`; it is only out of the `content_hash` path. This is exactly the fix I recommended.
- **I did not trust the workflow's own reported `evidence_written` count** — it is `rows.length` (the
  attempted batch size), not the number of rows that survived `ON CONFLICT`, which is precisely the
  "count didn't move because nothing ran" false-pass shape the team lead flagged on their own first
  (invalid) attempt. I hit the live webhook myself, twice, independently:
  ```
  curl -X POST http://localhost:5678/webhook/f05-contradiction-scan \
    -d '{"application_id":"05f0aaaa-0000-0000-0000-000000000001"}'
  ```
  Ground truth via direct SQL before/after each call: `evidence` table-wide **939 → 939 → 939**;
  the affected claim's own evidence rows **3 → 3 → 3**; `claim_trust.trust` for that claim held at
  `0.0000` (unchanged, not further degraded) across both of my calls. Zero new rows, twice, verified
  independently of the workflow's self-reported numbers.
- **Stale-rows-non-blocking, independently confirmed, not just accepted:** checked directly —
  `05f0aaaa-0000-0000-0000-000000000001` is a real `applications` row (company "Ledgerly",
  `companies.is_synthetic = true`) with **zero** `scores(axis='trust')` rows, **zero** `memos`, **zero**
  `thesis_evaluations` — nothing in this feature or any downstream one has ever surfaced this specific
  claim's trust value anywhere a judge or dashboard would see it. Agreed: append-only, GDPR-erasure-only
  bypass, non-blocking, on the strength of my own check of those three tables, not the assertion alone.

**Finding 4 — agreed non-blocking**, unchanged from my own pass-2 characterization.

**Finding 5 — agreed non-blocking**, unchanged from my own pass-2 characterization. The `done.md`
correction (CLI runner, not "the n8n workflow", for the Tavily check) is the right fix for the memo/video.

**Finding 2(b) (negation false positive) — also fixed since my last report, not mentioned in the
team lead's message, found by re-testing it as part of this same pass.** `lib/f05/quote_guard.js`'s
negation check no longer collects up to 4 loosely-gathered words as its "predicate" — it now derives
exactly **one** precise predicate per negation and requires the source to positively assert that
same single word. Re-ran my original bug case:
```js
quoteSalienceMismatches('We have no paying customers yet and do not charge for the beta.',
                         'The product is currently in closed beta with five design-partner teams...')
// -> [] (clean — was a false positive in round 1)
```
Real catches (duration fabrication, genuine `shall/shall not indemnify` flip) still fire correctly.
**Attacked the round-2 fix further, on my own initiative** (not something either side had reported):
narrowing from "any of 4 words" to "the one precise predicate" reduces the false-positive surface
substantially but does not eliminate the underlying limitation — a coincidental, unrelated use of that
*same single word* elsewhere in the source can still trigger it:
```js
quoteSalienceMismatches('We have no obligation to provide refunds after 30 days.',
  'Our refund policy allows customers to request a refund within 30 days of purchase, and our ' +
  'support team helps with the obligation of documentation.')
// -> still flags ("obligation" collides, unrelated to the refund-obligation claim)
```
This is a real, narrower residual of the same lexical-not-semantic limitation `done.md`'s own
limitation #4 already discloses (false negatives on paraphrase) — the fix has shrunk the false-positive
surface from "any of 4 loosely-collected words" to "the one selected word," which is a large,
genuine reduction, but has not closed it to zero. **I am not blocking on this narrower residual**: it
requires a much rarer coincidence than round 1's bug, it fails in the same direction the whole feature
is built to tolerate (a missed or over-cautious flag, not a fabricated number/date), and it belongs
in the same disclosed "lexical, not semantic" limitation already in `done.md` rather than as a new,
separate item — but it should be named there precisely (both the false-negative *and* this narrow
false-positive residual are the same root cause) rather than only the false-negative half.

### Revised final call

**GATE PASSED.** Finding 1 (fixed, re-verified against a fresh case). Finding 2(a) (fixed). Finding
2(b) (fixed to a narrow, disclosed, non-blocking residual — recommend `done.md`'s limitation #4 be
worded to cover both directions). Finding 3 (fixed, independently re-verified live via ground-truth SQL,
not the workflow's own self-reported counts). Finding 4 and 5 (real, disclosed, non-blocking,
independently confirmed and precisely characterized). The stale artifacts (one `scores` row, two
`verified` claims from the pre-entity-gate-fix GameLoop incident, three duplicate LLM-path evidence
rows) are all confirmed genuinely inert — none reachable from any `scores` row, memo, or
thesis_evaluation a judge would see — and are correctly left in place, documented, under this
project's own append-only/GDPR-erasure-only rule rather than quietly cleaned up.
