# 05 · Truth-Gap Check & Trust Score — Implementation Plan (v2)

> Design: [`design.md`](design.md) — **approved** after three spec-review rounds.
> All technical detail (DDL, formulas, routing table, record shapes, prompt rules) lives there and is
> referenced by section, never restated here.
> **v2, T-5h00m.** Plan review returned ❌ with a recommendation to cut the Tavily and LLM branches.
> **Operator ruling: nothing is cut.** This version therefore keeps full scope and buys the time back
> from ordering, parallelism and a headless runner instead.

---

## 0. How full scope is made survivable

Three changes, none of which reduce what ships:

1. **A headless runner (`lib/f05/run.js`) lands early.** Without it, libraries are unreachable until
   the n8n stage — the exact trap feature 03 recorded: *"the plan's stated fallback (lib + fixture +
   psql demo) was false — without the n8n stage nothing ever calls the agents."* With it, the n8n
   workflows become thin wrappers over already-working code, which is where the 95 minutes of debug
   that feature 04 spent actually goes.
2. **Half the declared dependencies were fictitious.** B1 needs the view's *column contract* (frozen
   in design §7.1–§7.5), not the built view; B2 does not need the router. Five tasks start at T0
   instead of two. Feature 03 found and fixed the identical mistake in its own plan.
3. **Ordering, not cutting.** The deterministic core is completed and **committed** before the LLM
   and Tavily branches begin. Everything still gets built; if the clock beats us anyway, what is
   missing is the expendable part rather than the part 06 is blocked on.

---

## Wave T0 — seven tasks, **all parallel**, target 75 min

> ⚠️ **Two rules binding on every T0 agent:**
> 1. **Run only your own test file** — `node --test lib/f05/<yours>.test.js`, never the
>    `lib/f05/*.test.js` glob. Four agents are creating files in one new directory; the glob picks up
>    peers' half-written tests, so an agent sees a red build caused by someone else and may "fix" a
>    file it does not own. The full glob runs once, at B3. Feature 04 hit both halves of this.
> 2. **No persisted writes to the shared database.** Acceptance that needs INSERTs runs inside a
>    transaction that `ROLLBACK`s (the `smoke.sql` pattern). A1 is measuring the very claims B2 would
>    be writing to; concurrent writes make both checks race on shared state and neither agent would
>    know why it failed. Real persisted writes belong to B3.
> 3. Modules A2/A3/B1/B2 stay **zero-import** — C1a inlines them into n8n Code nodes, which cannot
>    `require()`. Only `run.js` (B3) may import freely.

### A1 · `claim_trust` view, `f05_host()`, config row, smoke assertions
**@database-engineer** · `db/schema.sql`, `db/seed.sql`, `db/tests/smoke.sql`

Per design §7.1–§7.5, §10. `DROP VIEW IF EXISTS` before `CREATE` (42P16 trap). The
`score_formulas('trust_v1','trust')` row carries the routing prefix map from design §4.1 **verbatim**
and is the single source of truth for routing. View reads it via `jsonb_array_elements` with a
**LEFT JOIN + literal fallbacks**. Exposes `derived_status`.

**Acceptance** — all four, each by SELECT:
- `./db/apply.sh` runs **twice** cleanly; `smoke.sql` green (banner `-- Feature 05`, ids `…0950`–`…0959`).
- `count(claim_trust) = count(claims)` — *not* a hardcoded 724; other terminals are writing claims live.
- **Zero** `founder.expertise.*` / `founder.leadership.*` rows with `derived_status='verified'`
  (the B1 regression from spec review: 373 sourced supports exist there and must not become verdicts).
- `founder.execution.provenance` → `contradicted`; `founder.execution.tech` → `contradicted`;
  `founder.expertise.insight` → **not** contradicted and **no** penalty applied.

### A2 · `lib/f05/router.js`
**@backend-developer** · Longest-prefix match, six classes, `default_class` `unverifiable` (design §4).

**Acceptance:** `node --test lib/f05/*.test.js` green (glob form mandatory). Covers
`founder.execution.tech` → `factual_static` **via catch-all**; `founder.expertise.insight` →
`qualitative`; `market.size_top_down` → `forecast`; `competition.status_quo_alternative` →
`qualitative`; unknown topic → `unverifiable` + unmatched signal.
**The module exports no built-in prefix map** — it is a required parameter, so the seed row cannot
drift from a second hardcoded copy. Tests supply a fixture copied verbatim from design §4.1.

### A3 · `lib/f05/quote_guard.js`
**@backend-developer** · Port from `internal/other-projects/due-diligence-agents` (**Apache 2.0**).
Numeric (±5%) and directional windowed negation branches; duration dropped (design §5.1a).

⚠️ **Before writing code, measure the call site**: count claims whose evidence is `deck_parse`-sourced
and carries `quote_verbatim`. If that is ~0, report back immediately — the module would be tested
dead code, and the demo must not claim it runs.

**Acceptance:** catches `"90 days"`↔`"30 days"`, `$2,000,000`↔`$5,000,000`, flipped negation; does
**not** fire on ±5% rounding or `"no later than"`.

### B1 · `lib/f05/trust.js` — rollup math
**@backend-developer** · Depends only on the **column contract** in design §7.1–§7.5 and §8.2, which
is frozen. Scope query §8.1 including the `company_id` restriction on route 3; verdict-eligible
denominator; `value`/`confidence`/`missing_flags`/`input_claim_ids`; insufficient-evidence branch.

**Acceptance:** unit tests prove gaps lower confidence but **not** value (REQ-003); an
all-qualitative application yields `not_assessable_count`, not a 430-entry array; below
`min_coverage` writes **no** `scores` row and one event.

### B2 · `lib/f05/verifiers.js` + `lib/f05/entity_gate.js`
**@backend-developer** · No dependency on A2.

- **entity_gate** (design §6) — the central guard against the >80% false-contradiction rate.
  Steps 1–2 deterministic (`raw_signal` FK; `companies.domain`/`aliases`); step 4 downgrade plus an
  auditable `context` row. **Step 3 (the entity-matcher LLM) is left as an unimplemented hook and is
  owned by C1b** — it serves the contradiction path, not the Tavily branch. C3 uses steps 1–2 only.
- GitHub provenance vs Show HN date (§5.1b) — phrasing fixed at *"consistent with a rewritten or
  imported history"*, never an accusation.
- Denominator extraction (§5.1c).
- Evidence-write helper: `content_hash` with `candidate_key` and **no `run_id`** (§10.1);
  `raw_signal_id` always non-NULL (§2.1).

**Acceptance:** runs offline against live `raw_signals`; every evidence row has non-NULL
`raw_signal_id`; running twice inserts no duplicates.

### C2 · Agent specs
**@backend-developer via the `ai-agent-builder` skill** · No code dependency; written now so the
n8n builder is never blocked waiting for a schema (feature 04 lost time to exactly that inversion).
`agents/contradiction-detector.md`, `agents/entity-matcher.md` per design §11.1 — query-conditioned,
K=2, pairwise not isolated grading, binary grounding question, §6.1 output shape, safety floor last,
**no confidence numbers** (§6.0b).

> **Commit checkpoint:** @devops commits `db/schema.sql`, `db/seed.sql`, `db/tests/smoke.sql` the
> moment A1 lands — before Wave T1 is dispatched. Three features previously lost hours of DDL that
> existed only in a working tree; the rule is "same hour you edit them".

---

## Wave T1 — the runner · sequential · target 45 min

### B3 · `lib/f05/run.js`
**@backend-developer** · Depends on A1, A2, B1, B2

Headless CLI, following the `lib/f02|f03|f07/run.js` precedent: read claims for an application →
route → verifiers → entity gate → write evidence → write events → rollup → `scores` + write-back.
Shells out to `psql`, may `require()` freely (only Code-node-bound modules must be import-free).

**This task owns the five design elements that had no owner**, each with its own acceptance:
- `claim_verification_attempted` event — **mandatory**, one per routed claim (§9).
- `router_unmatched_topic` event row (§4.1).
- **Qualitative-contradiction path** (§14): a documented-tier contradiction on a `qualitative` claim
  leaves the verdict `unverified` **and** still writes a `claim_contradicted` event — otherwise the
  finding reaches neither memo nor dashboard.
- **GDPR event helper** (§9): a single writer, `entity_id` always `founders.id`; on the
  `entity_type='application'` fallback the payload **omits** `founder_claim` and `entity_match.quote`.
- `ai_runs` writes (`task_type='verification'`, `confidence` NULL per §11.1).

**Acceptance — every line a SELECT against a NAMED application, because vague criteria pass on
no-ops.** "One event per routed claim" is satisfied by routing 3 claims and skipping 700; non-NULL
`value`/`confidence` is satisfied by `value=0, confidence=0, input_claim_ids={}`.

1. `count(claim_verification_attempted events) = count(claims in scope)` using the §8.1 scope query —
   an **absolute** count, not a ratio.
2. Exactly one `scores(axis='trust')` row, with `array_length(input_claim_ids,1) > 0` and equal to the
   assessed count.
3. **Run twice → identical `value`, zero duplicate evidence rows.** B3 is the thing that actually gets
   re-run during the demo, and it is otherwise the only task with no idempotency check.
4. **GDPR anti-join:** zero rows in `events` where `entity_type='founder'` and `entity_id` is not a
   `founders.id`. This one is uncorrectable after the fact — `events` is append-only, so a wrong
   `entity_id` is permanently invisible to `purge_founder()`.
5. Zero `entity_type='application'` events whose payload contains `founder_claim` or
   `entity_match.quote`.
6. `ai_runs` rows exist for the run with `confidence IS NULL`.
7. One `router_unmatched_topic` row from a deliberately injected unknown topic.
8. **Qualitative-contradiction path, exercised now rather than at T3:** inside a rolled-back
   transaction, insert a documented-tier `contradicts` on a `qualitative` claim and assert the verdict
   stays `unverified` **and** a `claim_contradicted` event is written. No live row covers this case;
   an element owned but unassertable until D1 lands is not really owned.

---

## Wave T2 — n8n and the paid branch · **C1a ∥ C3**, then C1b · target 120 min

### C1a · Generator + `f05-trust-rollup`
**@n8n-workflow-builder** · The only workflow 06 is blocked on.
`n8n/build-f05-workflow.py` inlines `lib/f05/*.js` — self-contained CommonJS, zero imports,
`// SOURCE OF TRUTH` headers. Real `Merge` node; `$env.SUPABASE_URL` normalised; `gpt-5.6-luna`
without `temperature`; secrets via `$env.*`; `globalThis.crypto.subtle` for SHA-256.

**Acceptance:** one live run on a **named** application writes exactly one `scores(axis='trust')`
row — **verified by SELECT, never by n8n's success status.** Feature 04 lost an hour to workflows
returning `success` while silently executing 1–2 of 4 branches.

### C3 · `factual_dynamic` branch (Tavily)
**@backend-developer** · ∥ with C1a · Design §5.2, §10.2.
Temporal filter; source tier at verdict time; independence by slug; social-sourced claims barred from
`verified`. Writes `raw_signals` **first, with `founder_id`/`company_id` at insert** — the append-only
GDPR rule that already cost feature 04 nine permanently unpurgeable rows.

**Acceptance:** a capped run produces evidence with non-NULL `raw_signal_id`; zero `raw_signals` rows
with both FKs NULL; re-run inserts no duplicates.

### C1b · `f05-verify-claims` + `f05-contradiction-scan`
**@n8n-workflow-builder** · After C1a and C3.
**Acceptance:** N evidence rows all with non-NULL `raw_signal_id`; one `claim_verification_attempted`
event per routed claim; contradiction-scan produces **zero** `contradicted` verdicts that failed the
entity gate — checked by SELECT against the gate's `context` rows.

---

## Wave T3 — calibration, QA, close · target 120 min

### D1 ∥ D2 (independent; only D3 needs both)

**D1 · Labelled fixture** — **@database-engineer** · `db/fixtures/05-truth-gap.sql`, ids `05f00001-…`
6–10 claims with known ground truth (design §12): genuinely contradicted · true-and-evidenced (these
measure harmful flips) · honest gaps that must stay `missing` · one Tier-3-only claim that must not
reach `verified` · one **documented-tier contradiction on a qualitative claim**, the case no live row
covers.

**D2 · `min_coverage` calibration** — **@database-engineer**
**Acceptance is a number, not a note:** record the measured `verdict_eligible` distribution, and
choose `min_coverage` as the value at which the **named demo application produces a trust row**,
stated with the count behind it. ⚠️ The measured 77% (561/724) is **not** the input — it counts
claims carrying evidence; the denominator is a class filter nearer 41%.

### D3 · QA gate — **@qa-engineer** · ⚠️ **starts the moment B3 is green, in parallel with T2**

Scheduling decision (adopted from plan review): the wave targets sum to ~360 min against the
remaining clock, and feature 04's gate measured **130 minutes** plus three post-QA fixes. Leaving D3
until after C1b would put the gate's *end* past the deadline. So D3 runs in **two passes**:

- **Pass 1, against the deterministic core**, dispatched as soon as B3 is green — concurrent with
  C1a/C3/C1b. This is where the invariants live, so it is where the gate matters most.
- **Pass 2, narrow**, over the LLM and Tavily paths once C1b and C3 land.

This removes no deliverable; it recovers roughly 90 minutes of the overrun.
Independent adversarial pass; never reruns the dev tests. Must attack: no fabrication path; a gap
never renders as an accusation; contradiction lowers Trust deterministically; one audit event per
verification; `entity_id` always `founders.id` on personal-payload events; helpful-fixes vs
harmful-flips reported as **two separate numbers** from D1.

⚠️ **Plus a feature-07 regression check** (see Cross-feature below): after the first rollup, re-run
07's thesis gate on the demo application and confirm its verdict is unchanged, or intentionally and
knowingly changed.

Output `qa-report-05.md` → finding → fix → independent re-check until GATE PASSED.

### D4 · Close — **@devops**
Per-feature paths, no `git add -A`, no push without instruction. Plus **`NOTICE` at repo root**
naming both Apache-2.0 sources — `due-diligence-agents` and `reporting` (design §15). Public repo,
legal obligation, five minutes. Acceptance: file exists and names both.

---

## Parallelism map

```
T0  A1 ∥ A2 ∥ A3 ∥ B1 ∥ B2 ∥ C2     (6 agents)  → @devops commit checkpoint
T1  B3                              (runner — unblocks everything downstream)
T2  C1a ∥ C3  →  C1b                (2 agents, then 1)
T3  D1 ∥ D2  →  D3  →  D4
```

---

## Cross-feature obligations

- ⚠️ **Feature 07 reads `claims.verification_status` at runtime** (`verification_status=eq.contradicted`
  in its gate; `isUsable()` excludes `missing`/`contradicted`). Design §2.1's claim that the column is
  "unused" named only 03 and 04 and is **wrong about 07**, which built this integration deliberately
  for us. Consequences: **§8.4's write-back moves from "best-effort" to the never-cut set** — without
  it 07's integration is dead code — and 05 can flip `company.*` claims to `contradicted` and thereby
  change a *closed* feature's gate verdicts hours before the demo. Hence D3's regression check.
- `docs/backlog/TRACKER.md`: Schema changelog entry naming the `claim_trust` view, the `trust_v1`
  config row and `f05_host()`; status row → done.
- **Commit shared DB files the same hour they are edited** (checkpoint after A1, not only at D4).
- `done.md` must tell 06 and 09: read `derived_status`, not `verification_status`; read the
  contradiction **event** set in addition to the verdict set; an absent trust row means *not
  assessed*; the rollup is never displayed without its disagreement breakdown; badge vocabulary
  including the **"Forecast"** label goes into **09's `lovable-brief.md`** (root CLAUDE.md hard rule #10).
- Duplicate `scores` rows are accepted by design; "current" resolves by `max(computed_at)` (§8.3).
