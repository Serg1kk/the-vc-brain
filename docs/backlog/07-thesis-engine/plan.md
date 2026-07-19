# 07 · Thesis Engine — Implementation Plan (rev.2)

> Against `design.md` **rev.3a**. The plan cites design sections rather than duplicating DDL —
> the design is the single source of truth. Where a cited section is prose rather than complete
> SQL (A5's seed, the hash recipes), this plan says more, because "see the design" is not
> executable there.
>
> ⚠️ **Three files are shared with the 02/03/04 terminals**: `db/schema.sql`, `db/seed.sql`,
> `db/tests/smoke.sql`. Stage A owns **07's additions** to them, not the files. Protocols in A0.

## Stages and parallelism

```
Stage A (database) ─┐
Stage B (lib/f07)  ─┼─ parallel; disjoint paths within 07
Stage C (agents/)  ─┘
        ↓
     E1a (DB QA) ── runs as soon as A + A7 land, in parallel with D
        ↓
Stage D (n8n) → E1b (contract QA) → Stage F (close)
```

`lib/` holds only `f03/` and `f04/`, so stage B collides with nothing. Stage A's `schema.sql`
edits are appends plus one surgical insertion; `seed.sql` and `smoke.sql` need the protocols in A0.

**Cut order** (revised — B4 changes it materially): templates *(not planned — no task exists;
they are a future idea, not a cut)* → «Off-thesis but exceptional» lane → `f07-thesis-reevaluate`
→ **the n8n stage D entirely**. Non-cuttable: A1-A7, B1-B4.

⚠️ **Cutting stage D is not free, and the earlier framing («costs polish, not the feature») was
wrong.** It is true only for 07's own demo, which B4 can drive from the command line. But §8.2 has
**features 02 and 08 calling `f07-thesis-gate` as an n8n workflow with no other integration
point** — cutting D silently breaks both consumers. If D is cut, that must be announced in the
TRACKER, not absorbed quietly. Likewise §8.3 item 11 (kill the workflow after each node) is
unrunnable without n8n and dies with stage D; E1b's «or B4 if D is cut» fallback does not cover it.

---

## Stage A · Database — @database-engineer (sequential, single agent)

### A0 · Shared-file protocols (read before touching anything)

- `db/schema.sql` — re-read each target region immediately before editing; integrate, never
  overwrite. Anchors verified 04:20 and re-verified by the plan reviewer (`founder_company` at
  `:855`, `voice_artifacts` at `:860`).
- `db/seed.sql` — **append at EOF under a `-- Feature 07` banner.** Feature 04 established this
  after a collision; 03 appended `formula_v1` at `:91`, 04 appended `signal_sources` at `:66`.
- `db/tests/smoke.sql` — new assertions go in **new separate `DO $$` blocks** with a declared
  disjoint id range. **07 claims `…0970`–`…0979`** (03 holds `…0940`–`…0949`; 04 is inserting into
  the shared purge fixture). One exception: `smoke.sql:845` is a hardcoded shared table list that
  must be **extended in place** to assert A1's TRUNCATE revocation — re-read, edit, and announce
  in the TRACKER, per the protocol 03 established for that exact line.

| # | Task | Design ref | Acceptance |
|---|---|---|---|
| A1 | `thesis_evaluations` + 3 indexes + `forbid_mutation` trigger + `REVOKE TRUNCATE` | §5.1 | `apply.sh` twice in a row clean; UNIQUE on `(application_id, thesis_id, input_fingerprint)`; UPDATE and DELETE raise `P0001`; TRUNCATE denied to all three roles, asserted via the extended `smoke.sql:845` list |
| A2 | `uq_theses_active_name`, `is_default`, `uq_theses_single_default`, `activate_thesis_version()` | §5.5 | RPC is `SECURITY DEFINER` with pinned `search_path`; after a version bump on the default thesis exactly one row satisfies `is_default AND active` and it is the new version; an INSERT with `active` defaulted is rejected |
| A3 | `validate_thesis_config()` + trigger | §5.6 | rejects `hard` with **absent** `hard_justification`, `focus`+`hard`, non-zero `deal_breaker` weight, duplicate ids, bad ops, bad operand types; **accepts** `config = '{}'` |
| A4 | `purge_founder()` patch | §5.2 | **Re-read the function first.** Sweep lands before the `scores` delete. Purge succeeds with an evaluation row referencing both a `scores` row and an `ai_runs` row — that combination is what reproduced the 23503 |
| A5 | `score_axes` row `thesis_fit` + starting thesis, **both in `db/seed.sql`** (that is where the other axes live, `:23`) | **§1** (the config JSON — *not* §5.3/§7, which contain no config), §5.3, §7 | idempotent (`ON CONFLICT DO NOTHING`); **must ship in the same commit as A2** (`is_default` defaults false, so between A2 and A5 the gate is dead); the seeded config is the **full §1 JSON**: `schema_version`, the whole `mandate` block, `geos`, `positive_keywords`, `negative_keywords`, **`rules[]` including R1 (gambling `deal_breaker`/`hard`/`mandate_fatal`) and R2 (b2b `focus`/soft/25)**, `fit{base, mandate_weight, soft_deal_breaker_penalty, strong_threshold, min_coverage}`, `exceptional_lane`; survives `validate_thesis_config()`; exactly one row satisfies `is_default AND active` on a cold start; SQL comments cite no internal FACT-/REQ- ids (public-repo gate) |
| A6 | `db/tests/smoke.sql` extensions | §8.3 items 4-9, 16 | new assertions pass **and the full pre-existing suite still passes** — that is the regression signal. Includes: default thesis exists, is unique, and `config ? 'geos'` |
| A7 | `db/fixtures/07-thesis-engine.sql` | §8.3 | **Four** applications: one fully extractable (all five `company.*` attributes); one deliberately sparse (coverage < 0.5 → `insufficient_evidence`); one gambling-sector (trips the **hard** R1); and one whose text carries a negative keyword but whose `sector` is **not** in R1's list — without the fourth, «soft deal-breaker yields `borderline`» has no target, because R1 fires first on the gambling fixture and returns `failed`. Idempotent, own id range. Not applied by `apply.sh` — explicit invocation, mirroring `db/fixtures/03-founder-score.sql` |

**A7 was missing from rev.1 of this plan** and without it §8.3 items 1, 2, 3, 10, 11 and 12 cannot
be executed at all — every one needs an application with claims and a repeatable input. Features
03 and 04 both hit this; 07 is not going to rediscover it at QA time.

**A4 remains the highest-risk task.** It is a correctness obligation, not a feature: get it wrong
and the GDPR deletion path throws `23503` for any application that passed the gate.

---

## Stage B · Evaluator library — @backend-developer (parallel)

Zero-import CommonJS behind a `// SOURCE OF TRUTH` header (n8n Code nodes cannot import from the
repo); tests under `node --test`, no `package.json`, no dependencies. All inherited from 03/04.

| # | Task | Design ref | Acceptance |
|---|---|---|---|
| B1 | `lib/f07/vocabulary.js` — §1.1 keys and value sets, `region_of()`, `stage_evidence → stage` | §1.1 | `scaling` maps to nothing and yields `unknown`; `region_of()` covers every country in the seed's `geos`; an unmapped country returns `other`, never throws |
| B1c | `lib/f07/hashes.js` — all four recipes | §5.4 | **two retries of one gate call produce identical `raw_signals` and `claims` hashes despite a fresh `ai_runs` row per attempt**; `input_fingerprint` stable under claim reordering; a flipped claim changes it. Mirrors the tested `lib/f04/provenance.js` |
| B2 | `lib/f07/rules.js` — compilation, three-valued evaluation, fit, coverage, verdict, both modes | §1.2, D-03, D-04, §2, §3, §6.1 | one assertion per D-04 table row, one case per verdict-procedure step (2b included), plus: `failed` outranks `insufficient_evidence`; deal_breaker weights excluded from `earned`/`total`; penalty and clamp; `fit.base` when `total=0`; `coverage=1.0` when `total=0`; `negate`; `contains` type dispatch; **keyword-mode collapse** (never `passed`, `coverage` null); **`_text` synthesis** |
| B3 | `lib/f07/rules.test.js` | §3, D-07 | the six worked cases, **plus the D-07 property test** |
| B4 | `lib/f07/run.js` — headless runner | §6.1 | `node lib/f07/run.js <application_id> [--recorded <dir>]` loads the thesis, compiles, evaluates, writes every row, prints the §6.1 return contract. `--recorded` replays a saved extraction so nobody burns shared OpenAI credits debugging |

**B4 is a first-class deliverable, not a fallback.** Feature 03 built the equivalent deliberately,
and it is what let them integrate against recorded output instead of debugging a live API late.
It is also what makes the cut list coherent: without it, "only A and B completed" means tables and
pure functions with no caller — nothing evaluates an application, so there is nothing to
demonstrate.

**B3's property test is the one that matters.** Two revisions shipped a REQ-003 violation here, so
it asserts the guarantee as D-07 states it — *never ranked on a fit computed from less than
`min_coverage`* — not the weaker and false "fit does not drop".

---

## Stage C · Extraction agent — `ai-agent-builder` skill (parallel)

| # | Task | Design ref | Acceptance |
|---|---|---|---|
| C1 | Input spec, system prompt, output JSON schema, model choice, decision log → `docs/backlog/07-thesis-engine/agents/` | §4, D-02, §1.1 | `reasoning` first; `quotes` structurally required per gateable field; **the thesis appears nowhere in the prompt**; the «still decide» directive absent; `temperature=0`; values from §1.1's closed sets |

---

## Stage D · n8n — @n8n-workflow-builder (depends on A + B + C)

| # | Task | Design ref | Acceptance |
|---|---|---|---|
| D0 | `f07-db-write` sub-workflow — the §5.4 write path only | §5.4, §6.2 | select-by-hash-first on every table; expected row counts per call; **first check whether `n8n/workflows/f04-db-write.json` can be called rather than duplicated** — its card preflight is already the one §5.4 borrows verbatim |
| D1 | `f07-thesis-gate`, both modes, **including the extraction validator node** | §6.1, §6.2, agents/…-input-spec.md | `mode='keyword'` makes **no** LLM call, never returns `passed`, writes **zero** `scores` rows and `coverage = NULL`; `mode='full'` per-verdict row counts, especially `insufficient_evidence` → `thesis_gate` written as NULL, one `events` row, **zero** `scores` rows; a second identical run changes nothing. **The validator node is not optional**: OpenAI strict structured outputs cannot express the biconditional «`quotes.X` non-null ⇔ `X` non-null ⇔ `X ∉ missing_fields`» (no `if`/`then`/`allOf`), so the schema guarantees presence and enums but *not* grounding. Without the node an ungrounded value reaches a NOT NULL `claims.text_verbatim`. Its four checks are fully specified in the extractor's input spec |
| D2 | `f07-thesis-reevaluate` | §6.1 | does not re-extract; reads current claims; `contradicted` → `unknown`; writes new rows only |

Splitting D0 out follows feature 04, which hit exactly this and marked the fix critical: a single
task covering two modes, a five-step write path, three write targets, the cache write and the
events row is four to eight hours, not one task.

Evaluator logic is pasted from `lib/f07/*.js` verbatim, never reimplemented in a node.

---

## Stage E · QA — @qa-engineer

Split so the database layer is not held hostage to n8n:

| # | Task | Depends | Scope |
|---|---|---|---|
| E1a | DB attacks — §8.3 items 4-9, 16 | **A + A7 only** | validator NULL trap, D-04 legality, empty config, activation, append-only, `purge_founder`, coverage ≤ 1. Runs in parallel with stage D |
| E1b | Contract attacks — §8.3 items 1, 2, 3, 10-15 | D (or B4 if D is cut) | coverage protection, `unknown` cannot reject, open door, idempotency, resume, re-evaluation, anti-sycophancy, keyword mode, step 2b |

**The QA agent writes its own tests and must not reuse stage B's** — B's tests come from the same
reasoning that produced the code, and that reasoning has been wrong twice.

Priority if the clock runs short: item 1 (coverage protection), 2 (`unknown` cannot reject),
9 (`purge_founder`), 10 (idempotency), 4 (the NULL trap). Those five cover every defect the design
reviews actually caught.

Output `qa-report-07.md`. Loop: finding → fix by the owning builder → **independent re-check** →
until GATE PASSED.

---

## Stage F · Close — @devops + orchestrator

| # | Task | Notes |
|---|---|---|
| F1 | `docs/backlog/TRACKER.md` — status + all owed Schema changelog entries (§8.5), **plus the `smoke.sql:845` edit announcement** | the notice that `thesis_gate = NULL` is reachable is the one another terminal actually needs |
| F2 | `db/README.md` — the new append-only table, the four hash recipes, the `SECURITY DEFINER` RPC, the `purge_founder()` change | 01 established it as the reference the n8n builder and the feature-10 CLI read; 03 updates it too |
| F3 | `handoff.md` in the feature folder | the §6.1 call contract, `fired_rules[]` shape for 06, the NULL notice for 02, the «current thesis_fit resolves per `(application_id, axis, thesis_id)`» convention. 07 has seven consumers — more than any other feature — and TRACKER lines alone are too thin |
| F4 | Feature README status, EN + RU together | the pair must not drift |
| F5 | Commit via @devops, per-feature paths only, never `git add -A` | **Commit only — do not push.** `docs/` appears tracked by the repo CLAUDE.md describes as the public `the-vc-brain` remote; pushing would publish internal docs. Surface to the operator |
| F6 | Learnings → `.claude/agent-learnings/`; decisions → process-meetings intel base | |

**Feed lanes (§6.4) are delegated to feature 09**, not built here — 07 owns the spec (including
the explicit `applications → companies → founder_company → founders → scores(axis='founder_score')`
join, `max` over `is_current`, and «absent ≠ low»), 09 owns the query and the UI. F3's handoff
carries it. It is therefore **not** a cut item — it was never in 07's build.

---

## Risks

1. **Concurrent edits to three shared files.** Mitigation: A0's protocols; one agent for stage A;
   `apply.sh` run twice at the end.
2. **`purge_founder()` contended by three features.** Integrate, never overwrite; the smoke
   regression fixture proves the result.
3. **The scoring math has been wrong twice.** B3's property test and E1b item 1 are written
   independently of each other, on purpose.
4. **Feature 02 does not handle `thesis_gate = NULL`.** Not fixable from this terminal. F1 + F3
   carry the notice. Safe direction: a NULL-gated application does not advance.
5. **Live-API debugging burns shared credits.** Mitigation: B4's `--recorded` mode.
6. **B1 and C1 independently transcribe §1.1's key names.** Mitigation: E1b asserts the extractor
   schema's field names are byte-identical to `vocabulary.js`'s exported key list.
