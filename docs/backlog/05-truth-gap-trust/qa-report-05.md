# 05 · Truth-Gap Check & Trust Score — QA Report (Pass 1, adversarial)

> Scope: deterministic core only — `claim_trust` view, `lib/f05/{router,quote_guard,trust,entity_gate,verifiers,run}.js`,
> `db/fixtures/05-truth-gap.sql`. n8n workflow and the Tavily branch are pass 2's job.
> This pass does not re-run the developers' own tests as verification. Every finding below was
> produced by a query or attack the developers did not write.

## Verdict: **GATE BLOCKED** (updated after round-2 re-verification — see that section)

Round 1 found two reproducible defects, both root-caused to specific lines of code, both capable of
producing exactly the failure mode this feature exists to prevent (a wrong or fabricated signal
reaching an investor). Finding 1 was not hypothetical — it was demonstrated against the live database
with a real `scores` row it produced. Finding 2 was dormant in the current corpus but a structural
property of `quote_guard.js`, not a data fluke.

**Round 2 (independent re-verification of both fixes, see bottom section): Finding 1 is fixed,
including against a case the fixers had not checked, with one theoretical (currently dormant)
over-narrowing risk noted. Finding 2(a) (numeric ranges) is fixed. Finding 2(b) (negation) is only
partially fixed — a new, distinct false-positive path reaching the same real `contradicts` write path
was found and reproduced. Gate stays BLOCKED on 2(b) until that is addressed.**

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
