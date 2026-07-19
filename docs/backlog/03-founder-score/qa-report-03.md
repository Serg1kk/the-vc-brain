# 03 · Founder Score — QA Report

> Independent QA gate. Executed against the live `supabase-db` instance (Supavisor
> pooler, `localhost:54322`) and `node lib/f03/run.js`. Per the QA brief: dev's own
> `lib/f03/*.test.js` (77 tests) and `db/tests/smoke.sql` were **not** re-run as
> evidence — they were treated as already-green and already orchestrator-verified.
> Every case below was independently constructed (own fixtures, own attack scripts, own
> `--recorded` payloads) and driven through the real surfaces: `psql` and `run.js`.
> **Zero live LLM calls made.**
>
> Mid-session correction from the coordinator was received and applied: per-founder
> `--recorded` directories (`devon-ashworth`, `kwame-asante`, `pieter-levels`) were used
> instead of replaying `pieter-levels` against all three founders. The cross-founder
> replay was additionally turned into its own exploratory test (see below).
>
> Working note: this is a live, shared dev database with other agents active in
> parallel. Mid-session, Kwame Asante's entire row set was purged by another process
> and later reappeared (re-seeded by another agent). This did not affect any of the
> evidence below — every mandatory case was captured immediately after the command
> that produced it, and the two cases needing destructive operations (purge) used
> QA-owned fixtures (`aaaaaaa2…`, `aaaaaaa3…`, `aaaaaaa6…`), never the shared `03f0…`
> dev fixture, which was only ever touched with read-only / idempotent runs.

## Environment

```
set -a; source infra/supabase/.env; set +a
DATABASE_URL="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@localhost:54322/postgres"
```
`psql` invoked with `-f -` (stdin) throughout, never `-c`, per the documented `:'var'`
interpolation gotcha on this psql 16.13 (Homebrew) build.

Reference values reproduced exactly on first try, confirming the environment/fixtures
are in the state the coordinator described:

| Founder | Command | status | value | confidence | coverage |
|---|---|---|---|---|---|
| Devon Ashworth | `run.js …0001 --recorded devon-ashworth` | scored | 29.16 | 0.53 | 0.715 |
| Kwame Asante | `run.js …0002 --recorded kwame-asante` | insufficient_evidence | null | null | 0.17625 |
| Pieter Levels | `run.js …0003 --recorded pieter-levels` | scored | 67.96 | 0.63 | 0.54 |

Exploratory cross-founder replay (Devon scored against **Pieter's** recorded output,
i.e. every cited `claim_id` foreign to Devon's pack): all 12 criteria correctly
coerced to `cannot_assess` via step 4's citation check → `insufficient_evidence`,
coverage `0`. The gate correctly refuses foreign evidence rather than fabricating a
score from it. PASS (defensive behaviour confirmed, not a bug).

---

## Mandatory case 1 — REQ-003 / I2 (identical `value`, strictly lower `confidence`)

**What I did.** Loaded the **live** `formula_v1` config from `score_formulas` (not a
hand-rolled mini-config — the documented trap). Built two independently-authored full
12-criterion component sets by calling `applyGate()` itself (not hand-set
credit/evidence_tier), using my own fabricated claim IDs/text, disjoint from any dev
fixture. Script: `case1_req003.js`.

- **Founder A**: all 12 criteria `met`/`documented` (perfect coverage).
- **Founder B**: identical, except criterion `X6` (weight 0.075, mid-tier, chosen
  independently of whatever the dev's own test used) is withheld entirely →
  `cannot_assess`.

**Output:**
```
Founder A (all 12 met/documented):      value=100 confidence=1    coverage=1
Founder B (A minus X6 -> cannot_assess): value=100 confidence=0.96 coverage=0.925
value identical: true ( 100 vs 100 )
confidence strictly lower: true ( 1 -> 0.96 )
```

**Exploratory extension (not required, done to find the boundary of the claim).** With
a genuinely non-uniform baseline (met/credit-1.0 alternating with self_asserted/
credit-0.3), withholding a previously-assessed criterion **does** change `value`
(65 → 61.11) — expected and correct: the design's I2 guarantee is that criteria which
never entered the denominator can't move `value`; it is not a claim that downgrading an
already-assessed criterion is value-neutral in general (that would erase real evidence,
which would itself violate I3). Documented for completeness, not a failure.

**PASS.** Both halves of the invariant hold on a real, full-registry construction.

---

## Mandatory case 2 — missing `raw_signal_id` must not silently produce `insufficient_evidence`

**What I did.** Inserted an independent founder (`aaaaaaa2-0000-0000-0000-000000000001`,
"Quinn NullSignal") with 3 claims whose **every** `evidence` row has `raw_signal_id
IS NULL` (verified by direct query before running). One claim uses `source_kind:
'interview'` for criterion `L2` (neg_src `deck_parse|interview_answer` — the fallback
maps `interview` → `interview_answer`, a match). Crafted my own `--recorded` payload
emitting `not_met` for `L2` citing that claim, plus `met` verdicts for `E1`/`X1` to
cross `min_coverage`.

```
node lib/f03/run.js aaaaaaa2-0000-0000-0000-000000000001 --recorded <qa dir>
[f03/run] status=scored value=56.36 confidence=0.64 coverage=0.34375 trend=null
```
```
L2 not_met documented 0 0   <- verdict SURVIVED, evidence_tier assigned, not coerced
```

**Negative control (discriminating, not a blanket pass).** Same mechanism, `gate.js`
called directly: a claim with `raw_signal_id NULL`, `source_kind: 'derived'` (fallback
→ `deck_parse`) cited for a `not_met` on `E1` (neg_src `github_api` only — no match) →
correctly coerced to `cannot_assess`, `what_would_close_it`: *"criterion E1: not_met
requires a claim sourced from github_api; none found in pack"*.

**PASS.** The `claims.source_kind` fallback fires when it should and only when it
should; the founder is `scored`, not silently swallowed into `insufficient_evidence`.

---

## Mandatory case 3 — `purge_founder()` vs parentless `score_components`

**What I did.** Built an independent, deliberately-sparse founder
(`aaaaaaa3-0000-0000-0000-000000000001`, "Rory Sparsedata") — not the shared Kwame
fixture, since that is still needed by other in-flight work and this test is
destructive. Same technique as the dev fixture (3 lowest-weight criteria, `E3+X5+L5 =
0.17625 < min_coverage 0.25`). Ran via `run.js --recorded`, confirmed
`insufficient_evidence`, then purged.

```
[f03/run] status=insufficient_evidence value=null confidence=null coverage=0.17625
[f03/run] wrote events row (insufficient_evidence, no scores row)
```
Pre-purge: `score_components` = 12 rows, **12 parentless** (`score_id IS NULL`).
```sql
select purge_founder('aaaaaaa3-0000-0000-0000-000000000001'::uuid);
-- exit 0, no error
```
Post-purge orphan sweep:
```
 sc | founder | cards | claims_via_cards | ai_runs
----+---------+-------+------------------+---------
  0 |       0 |     0 |                0 |       0
```

**PASS.** No `23503`, zero orphaned rows in any related table.

---

## Mandatory case 4 — no fabrication

**What I did.** Combined (a) case 3's fresh sparse-founder run — `no scores row`
logged explicitly by `run.js`, all 12 `score_components` parentless with `credit`/
`contribution`/`evidence_tier` all `NULL` on `cannot_assess` rows — with (b) a
database-wide sweep for fabrication patterns.

```sql
-- any cannot_assess row carrying a numeric stand-in?
select count(*) from score_components
  where verdict='cannot_assess' and (credit is not null or contribution is not null);
-- => 0

-- any assessed row MISSING its credit (silently null where it should be set)?
select count(*) from score_components where verdict<>'cannot_assess' and credit is null;
-- => 0

-- any scores.value ever written as 0 or 50 (classic "stand-in for unknown" values)?
select count(*) from scores where axis='founder_score' and value in (0,50);
-- => 0 rows
```

**PASS.** No code path anywhere in the current `scores`/`score_components` data invents
a numeric value for absent evidence; the `insufficient_evidence` branch produces
exactly the contract design §2.4 specifies (no `scores` row + one `events` row).

---

## Mandatory case 5 — REQ-002: axes never averaged, composition visible

**What I did.** Grepped `lib/f03/*.js` for any axis literal other than `'founder_score'`
— the only other axis string present is `'founder'` inside the **event_type/entity_type**
tuple for the unrelated `founder_score_insufficient_evidence` event, not a `scores`
write. Checked live DB: every `scores` row currently in the entire database (11 rows
across all founders/runs at time of check) has `axis='founder_score'`,
`application_id IS NULL`. No averaging code exists anywhere in `gate.js`/`scoring.js`/
`run.js` — `aggregate()` computes exactly one weighted mean, over criteria, never over
axes.

Breakdown retrievability, demonstrated via the real consumer path (SQL join, not the
JSON contract):
```sql
select s.founder_id, s.axis, s.value, sc.criterion_id, sc.verdict, sc.contribution
from scores s join score_components sc on sc.score_id = s.id
where s.id = 'e6a32249-...' order by sc.criterion_id;
-- 12 rows returned, one per criterion, Σcontribution reproduces s.value
```

**PASS.**

---

## Mandatory case 6 — append-only enforcement

**What I did.** Own fixture (`aaaaaaa6-…`), one **real** `score_components` row
inserted first (the documented empty-table false-pass trap avoided). Attacked UPDATE,
DELETE, and TRUNCATE (as `anon`, `authenticated`, **and** `service_role` — the dev's own
smoke only covers `service_role`) against both `score_components` and `score_formulas`.

```
UPDATE score_components SET rationale='qa-attack' WHERE id=...;
ERROR: append-only invariant violated: UPDATE on public.score_components is not
permitted (id=aaaaaaa6-...) -- use purge_founder() for GDPR erasure

DELETE FROM score_components WHERE id=...;
ERROR: append-only invariant violated: DELETE on public.score_components ...

SET ROLE anon;          TRUNCATE score_components;  ERROR: permission denied for table score_components
SET ROLE authenticated;  TRUNCATE score_components;  ERROR: permission denied for table score_components
SET ROLE service_role;   TRUNCATE score_components;  ERROR: permission denied for table score_components
SET ROLE anon;           TRUNCATE score_formulas;    ERROR: permission denied for table score_formulas
SET ROLE authenticated;  TRUNCATE score_formulas;    ERROR: permission denied for table score_formulas
SET ROLE service_role;   TRUNCATE score_formulas;    ERROR: permission denied for table score_formulas
```
Row confirmed intact after all 8 attacks. `forbid_mutation()`'s `RAISE EXCEPTION`
carries no explicit SQLSTATE → defaults to `P0001` per plpgsql convention (confirmed by
the literal error text, which is `forbid_mutation()`'s own message). TRUNCATE denials
are all `permission denied for table …`, Postgres's canonical `42501` text.

**PASS.** All 8/8 attacks correctly denied, including the two roles (`anon`,
`authenticated`) the dev's own smoke suite does not exercise.

---

## Mandatory case 7 — determinism

**What I did.** Ran Devon Ashworth through `run.js --recorded devon-ashworth` **twice**
in immediate succession (fresh `run_id` each time), normalized both output contracts
(stripped `run_id`/`score_id`/timestamps) and diffed.

```
run2: status=scored value=29.16 confidence=0.53 coverage=0.715 trend=null
run3: status=scored value=29.16 confidence=0.53 coverage=0.715 trend=null
diff run2.normalized vs run3.normalized  ->  IDENTICAL
```
Diff covered `value`, `confidence`, `coverage`, `trend`, and the full 12-criterion
`[id, verdict, credit, contribution]` breakdown — byte-identical.

**PASS.** Same components + same config → identical output; replaying the same founder
in `--recorded` mode reproduces value/confidence exactly.

---

## Mandatory case 8 — arithmetic integrity (Σcontribution vs value, tolerance 0.005)

**What I did.** Computed `Σ score_components.contribution` against `scores.value` for
every scored run I personally triggered (not reusing dev's numbers).

| Run | value | Σcontribution | δ | within 0.005? |
|---|---|---|---|---|
| Devon (fresh) | 29.16 | 29.16083 | 0.00083 | yes |
| Pieter (fresh) | 67.96 | 67.96296 | 0.00296 | yes |
| Quinn (case 2) | 56.36 | 56.36364 | 0.00364 | yes |
| Kwame + adjacent-X2 probe (see Finding 1) | 48.96 | 48.95523 | **0.00477** | yes (close to the edge) |

**PASS.** All within the documented 0.005 bound. The Kwame-adjacent run's δ (0.00477)
is close enough to the boundary to confirm the 0.005 tolerance is correctly sized, not
generously padded — and that the old, superseded "1e-4" spec claim (design decision
log #10) really was arithmetically impossible, exactly as the orchestrator concluded.

---

## Exploratory attacks (per "also worth attacking")

### A. `quote_verbatim` paraphrase-laundering (I6 / RSK-003)

Crafted a `met` verdict on `E4` citing a real claim, but with `quote_verbatim` set to an
embellished paraphrase ("our enterprise-grade production deployment guarantees a
99.99% uptime SLA") that is **not** a substring of either the claim's `text_verbatim` or
its evidence `quote_verbatim`.

```json
"quote_verbatim": null,          // correctly nulled
"rationale": "Founder has a live, stable production deployment.",  // kept
"verdict": "met"                 // unaffected -- the VERDICT isn't punished, only the quote
```
Positive control: Pieter Levels's real recorded output carries 9 genuine
`quote_verbatim` values, all exact substrings of their source claims (confirmed by
inspection) — the check is discriminating, not over-aggressive.

**PASS.**

### B. `missing_flags` array-vs-object default

```sql
select jsonb_typeof(missing_flags) from scores where axis='founder_score';
-- 'array' for all 11 rows currently in the database, never 'object'
```
The column default genuinely is `'{}'::jsonb` (an object) — confirming the risk named
in the brief is real in principle — but `writeScored()` always supplies the `missing`
array explicitly via `COALESCE(j->'missing_flags','[]'::jsonb)`, so no row has ever hit
the default in practice.

**PASS.**

### C. NULL `founder_id` on `score_components`

```sql
select count(*) from score_components where founder_id is null;  -- => 0
```
Column is `NOT NULL` at the schema level; purge path is unconditionally reachable for
every row. **PASS.**

### D. Not_met written where no competent source was consulted (highest-value target)

Built directly on Case 2's negative control (E1/`github_api`-only neg_src correctly
refused a `derived`→`deck_parse`-sourced citation). Went further with a second,
**more consequential** construction — see **Finding 1** below. Net result: `gate.js`
never lets a `not_met` stand with **zero** valid citations (case 2's negative control),
but the accepted "source-level, not question-level" approximation (design §4.4 step 5,
§8 item 5) does let a `not_met` stand on a **real, cited** claim whose source matches
the criterion's declared `neg_src` even when that claim's actual content addresses a
different (adjacent) criterion. This is documented and accepted by design — but its
real-world reach turned out to be large enough to flip the feature's flagship cold-start
demo founder out of `insufficient_evidence` entirely. Full writeup below.

### E. Devon's R1/E1 fixture comment (stale-documentation check)

Confirmed via a **fresh, independently-triggered** run (not reused from dev/tracker):
```
E1 not_met demoted_by=R1 credit=0
```
The fixture's inline comment ("R1 demoting E7 (and E1, latent — E1 has no claim here
so the demotion is a no-op for it)") is **inaccurate**. Actual mechanism, confirmed:
step 6 demotes E1 unconditionally (per its `contradicts` list); step 5's
**re-application** then finds a `github_api`-sourced claim elsewhere in Devon's
execution-signals pack (used for E3/E7), so the `not_met` survives rather than
reverting to `cannot_assess`. This matches `gate.js`'s documented intent exactly (§4.4
step 6's comment: *"the ordering would otherwise let a future flag breach I2
silently"*) — the code is right, the fixture's inline comment is stale.

---

## Findings

### Finding 1 (MAJOR — robustness/documentation, not an invariant violation) — the sparse-founder "guaranteed insufficient_evidence" claim is fixture-locked, not structural

**Severity:** Major
**Component:** Backend (`lib/f03/gate.js` step 5's accepted approximation) +
`db/fixtures/03-founder-score.sql` / `docs/backlog/03-founder-score/plan.md` (B3b)
documentation

**What I found.** `db/fixtures/03-founder-score.sql`'s Kwame Asante comment and
plan.md/tracker both assert the sparse founder is `insufficient_evidence` "by
construction... independent of how the LLM judges any individual claim." That claim is
**not accurate**: it only holds if the model addresses **exactly** the 3 criteria the
fixture was designed around (`E3`, `X5`, `L5`). If the model additionally renders a
verdict for an **adjacent** criterion sharing the same evidence pack (e.g. `X2`, which
sits in the same `expertise-signals` bucket as `X5` and shares Kwame's only expertise
claim), coverage can cross `min_coverage` and the founder flips from
`insufficient_evidence` to `scored`.

This is licensed by `gate.js` doing exactly what the design says it should: X2's
declared `neg_src` legitimately includes `interview_answer`, and the cited claim (202)
genuinely exists and is genuinely about the founder — it just answers a **different**
question (competitor granularity, X5's criterion) than the one it's being used to
close out (industry insight specificity, X2's criterion). Design §4.4 step 5 and §8
item 5 explicitly name and accept this "source-level, not question-level" tradeoff. So
this is **not a code defect** — `gate.js` and `scoring.js` both behaved exactly to
spec in every check above (I2, no-fabrication, arithmetic integrity all held on this
very run). It is a demonstration that the tradeoff's blast radius reaches further than
the fixture's own claim about its robustness suggests.

**Reproduction (self-contained, independent of any historic DB row):**
```bash
# Copy the 3 locked recorded files for execution/leadership/red-flags unchanged.
# Modify expertise-signals.json ONLY: add a not_met verdict for X2, citing the
# SAME claim (03f00006-...-202) that X5's own met verdict already cites.
node lib/f03/run.js 03f00001-0000-0000-0000-000000000002 --recorded <modified dir>
# =>
[f03/run] status=scored value=48.96 confidence=0.41 coverage=0.25125 trend=null
```
(A near-identical event — `status=scored, value=23.88, confidence=0.45` — is also
present in the live DB's history at `scores.id=dac84087-…`, `run_id=3982a756-…`,
predating this session's final locked recording; not used as primary evidence per the
"don't treat historic rows as defect evidence" instruction, but consistent with an
independent, freshly-triggered reproduction above.)

**Why it matters.** Design §6 calls the cold-start branch "the feature's flagship
claim [that] must be visibly correct, not merely handled." Plan.md D1 reserves
**exactly one live (non-recorded) LLM call for the demo video**. If that live call
lands on a sparse founder and the expertise (or any) sub-scorer renders one adjacent
verdict beyond its designed 3-claim scope, the demo would show a scored value instead
of the intended `insufficient_evidence` moment — the exact scenario the fixture was
built to make "guaranteed," not probabilistic.

**Recommendation (not applied — QA does not fix code):** either (a) tighten `X2`'s
`neg_src` to drop `interview_answer` given how much overlap it creates with `X5` in
practice, (b) add an explicit prompt instruction to `expertise-signals` telling it not
to render a verdict for a criterion when the only available evidence was written for
a sibling criterion, or (c) simply correct the "guaranteed... independent of how the
LLM judges" language in the fixture comment and plan.md/tracker to state the actual,
narrower guarantee (coverage from the 3 designed criteria alone cannot exceed 0.17625,
regardless of their verdict polarity — that part **is** structurally guaranteed;
adjacent-criterion leakage is not).

### Finding 2 (Minor — stale documentation, no functional impact)

**Severity:** Minor
**Component:** `db/fixtures/03-founder-score.sql` (comment only)

Devon Ashworth's fixture header comment (line ~37) claims R1's demotion of `E1` is "a
no-op" because E1 has no claim in the fixture. Confirmed via a fresh run this is
incorrect: `E1` lands `not_met`, `demoted_by=R1`. Root cause: step 6 demotes
unconditionally, and step 5's re-application finds an unrelated `github_api`-sourced
claim elsewhere in the pack (used for E3/E7) that licenses the `not_met` to stand. This
is exactly gate.js's documented intent — only the comment is wrong.

**Reproduction:** `node lib/f03/run.js 03f00001-…0001 --recorded devon-ashworth`, then
inspect `E1`'s component: `verdict=not_met, demoted_by=R1, credit=0`.

**Recommendation:** update the comment to read something like: *"R1 demoting E7 and,
via the pack-wide neg_src re-check (E1's github_api claim exists elsewhere in the
pack), E1 as well — both land not_met, not merely E7."*

---

## Quality gate checklist

- [x] All 8 mandatory cases executed independently, through real surfaces (psql,
      `run.js`), not by re-running dev's own test suite
- [x] I2/REQ-003 holds on a full 12-criterion live-config construction
- [x] `raw_signal_id`-NULL fallback fires correctly and is discriminating
- [x] `purge_founder()` clean against parentless `score_components`, no `23503`, no
      orphans
- [x] No fabrication anywhere in current `scores`/`score_components` data
- [x] REQ-002: single axis, no averaging, full breakdown retrievable
- [x] Append-only enforced for UPDATE/DELETE (`P0001`) and TRUNCATE (`42501`) across
      all three roles, on a real (non-empty) row
- [x] Determinism confirmed on repeated `--recorded` replay
- [x] Arithmetic tolerance (0.005) holds across every run I triggered, including one
      run within 0.0003 of the boundary
- [x] I6 verbatim-substring guard discriminates correctly (paraphrase rejected, real
      quotes preserved)
- [x] `missing_flags` never lands as the `'{}'` object default in practice
- [x] No NULL `founder_id` on `score_components`
- [ ] Finding 1 (Major) open — flagship cold-start guarantee is fixture-locked, not
      structural; recommend addressing before the reserved live demo run
- [ ] Finding 2 (Minor) open — stale fixture comment

**No binding invariant (I1–I8, REQ-002, REQ-003) was violated by any test in this
report.** Both findings are about the robustness of a *documented, accepted* design
tradeoff and a stale code comment, not about code doing something the spec forbids.

## Verdict

**GATE PASSED** — with Finding 1 flagged for the owning builder to address (or at
minimum, correct the overclaiming documentation) before the single live demo run in
D1 is recorded, and Finding 2 as a trivial comment fix. Neither finding blocks
shipping; re-check on request once addressed.

---

## Post-gate verification by the orchestrator (2026-07-19 ~05:50)

### Finding 1 — RESOLVED. Verified, not assumed.

QA ran concurrently with a fixture rework that landed mid-gate, so Finding 1 was found against
the **previous** Kwame Asante. Its reproduction cites claim `03f00006-…-202`, sourced from
`interview_answer`, which no longer exists: the sparse founder was reworked to a **single
`hn_algolia` source cluster** precisely because the old three-source spread over-licensed
`not_met` (tracker decision log #18, #20).

QA's exact attack, re-run against the current fixture — inject an extra `X2` `not_met` into the
recorded `expertise-signals` output, citing a real live claim:

```
live claim: 03f00006-0000-0000-0000-000000000203
injected X2 not_met citing 03f00006-0000-0000-0000-000000000203
RESULT status: insufficient_evidence  coverage: 0.06  value: None
X2 final verdict: cannot_assess
```

The adjacent-criterion leakage is now structurally impossible for this founder, not merely
unobserved: `X2`'s `neg_src` does not include `hn_algolia`, so gate.js step 5 coerces the
injected `not_met` to `cannot_assess`. Confirmed against the registry itself — of all 12
criteria, **only `L5` (weight 0.06000) lists `hn_algolia`**, and none lists `manual`:

```
L5 | 0.06000 | ["hn_algolia", "tavily_extract"]
```

So the worst-case coverage for a founder whose claims come only from `hn_algolia` is **0.06**
against a `min_coverage` floor of **0.25** — a hard arithmetic bound over every possible model
output, which is what "by construction" should have meant the first time.

**QA's underlying critique was correct and is retained**: the guarantee is a property of the
*fixture's source composition* interacting with the registry, not of the scoring engine. A
different sparse founder whose claims happened to come from `github_api` would not enjoy it.
Design §8 item 5 already records the source-level-vs-question-level approximation as an accepted
tradeoff; this finding is the concrete demonstration of its blast radius, and it is worth keeping
in the report for exactly that reason.

Kwame's recorded fixtures were also regenerated from a fresh live run, because the reconstructed
ones cited the deleted claims and produced the right answer for partly the wrong reason
(decision log #21).

### Finding 2 — FIXED

The stale inline comment about R1's demotion of E1 being "a no-op" has been corrected in
`db/fixtures/03-founder-score.sql`. QA's observed behaviour (E1 lands `not_met`) is what
`gate.js` documents it should do: step 6 demotes unconditionally, and step 5's re-application
finds a source-level `neg_src` match in the execution pack.

### Gate status

**GATE PASSED** stands. Both findings closed: Finding 1 by the fixture rework (verified above by
re-running QA's own attack), Finding 2 by a comment correction.
