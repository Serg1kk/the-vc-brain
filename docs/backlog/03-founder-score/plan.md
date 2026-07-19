# 03 · Founder Score — Implementation Plan (rev 2)

> Spec: [design.md](design.md) rev 3 (spec review ✅). Plan review round 1 → NEEDS REWORK
> (2 blockers + a stale cross-feature ruling); rev 2 applies all 16 findings.
> Operating **autonomously** — operator asleep from ~04:30, full decision authority delegated to
> the orchestrator. Every ruling taken along the way is recorded in `tracker.md`'s decision log.
> Deadline 16:00 Minsk. Critical path 01 → **03** → 05 → 06 → 09. Feature 04 runs concurrently.
> Executors are subagents. Git via @devops only.

## Guiding decisions

1. **The deterministic core (`lib/f03/`) is written and unit-tested before anything else.** It is
   the only place the invariants can be enforced, it is what a judge is shown as «the place with
   no LLM in it», and it needs no API key, no n8n and no database to test.
2. **A headless runner (`run.js`) is a first-class deliverable, not a fallback.** It makes the
   product demonstrable end-to-end without n8n, de-risks the n8n stage to near zero, and lets
   integration pass on recorded agent output instead of burning credits and prompt-debugging time
   at hour nine.
3. **n8n Code nodes cannot import from the repo.** `infra/n8n/docker-compose.yml` mounts only
   `n8n_data`; the repo is not bind-mounted and `NODE_FUNCTION_ALLOW_EXTERNAL` is unset. So
   `lib/f03/*.js` are authored as **self-contained CommonJS with zero imports and no top-level
   side effects**, and their bodies are **pasted verbatim** into Code nodes with a
   `// SOURCE OF TRUTH` header. Same approach feature 04 took.
4. **Test runner is `node --test`** (built into Node 18+) with `node:assert/strict`, CommonJS,
   files `lib/f03/*.test.js`, run as **`node --test lib/f03/*.test.js`** (glob form — the
   directory form fails repo-wide because Node's directory-glob resolution trips on the space in
   this repo's path). **No `package.json`, no dependencies, no install step.** This is pinned, not
   «check-then-create» — two terminals guessing independently would diverge. Announced in
   `docs/backlog/TRACKER.md` so 04 can adopt it.

## Cross-feature coordination (feature 04 is in build in a parallel terminal)

| Shared thing | Risk | Rule |
|---|---|---|
| `db/schema.sql` `purge_founder()` | 04 already landed an `ai_runs` fix inside it; **design §4.2's "~L782" anchor is already stale (now L791)** | **Anchor on text, never line numbers.** Insert immediately after `v_sole_app_ids := COALESCE(v_sole_app_ids, '{}');` and before `DELETE FROM voice_artifacts`. If surrounding text does not match design §4.2's quoted context — **stop and report, do not guess.** |
| `db/tests/smoke.sql` purge fixture | it is a **single shared `DO $$` block**; 04 is inserting a regression case into it right now | 03 does **not** edit that block. Append a **new, separate `DO $$` block** after the existing purge assertions, using its own founder id range `…0940`–`…0949`. Disjoint ranges make both terminals' edits non-overlapping appends. |
| `db/tests/smoke.sql` L845 TRUNCATE-grant list | hardcoded table list, shared line | Extend the `table_name IN (...)` list in place; re-read immediately before editing; announce in TRACKER. |
| `db/tests/smoke.sql` registry assertions | 04 hit this: exact counts contradict 01 §4.1 extensibility | Presence/floor assertions only. Never exact counts. |
| `db/seed.sql` | 04 adds `signal_sources` rows | 03 appends the `formula_v1` row (B3a). `ON CONFLICT DO NOTHING`. |
| `scores` axis ownership | **RESOLVED: 04 owns `axis='founder'`** | 03 writes `founder_score` **only**. Never add the other row. |
| test runner / `package.json` | both terminals may create one | Pinned to `node --test`, no `package.json` (guiding decision 4). |
| n8n instance | shared | Prefix `f03-`; export to `n8n/workflows/`. |

## Stages & parallelism

```
T0  ──┬── A1  DDL + purge + smoke            @database-engineer
      ├── A2  4 agent specs                  orchestrator in role (ai-agent-builder)
      ├── B1  lib/f03/scoring.js + tests     @backend-developer
      ├── B2  lib/f03/gate.js + tests        @backend-developer
      ├── B3a formula_v1 → seed.sql          @database-engineer
      └── B3b 3-founder fixture              @database-engineer
             │
      ┌──────┴── B4  lib/f03/run.js headless runner   @backend-developer   (needs B1,B2)
      │          │
      │          ├── D1  e2e on 3 fixture founders, --recorded   @backend-developer (needs A1,B3a,B3b,B4)
      │          │
      │          └── C1  n8n f03-score-founder (single merged wf) @n8n-workflow-builder (needs A2,B1,B2)
      │
      └── E1a QA: DB-level attacks   @qa-engineer   (needs A1,B3b)   ∥ C1
                 │
                 └── E1b QA: contract-level   @qa-engineer   (needs D1)
                            │
                            └── F1 commit   @devops   (needs GATE PASSED)
```

A1 ∥ A2 ∥ B1 ∥ B2 ∥ B3a ∥ B3b all start at T0 — none depends on another. (B1/B2 were previously
declared to depend on A1 «for config shape»; that edge was fictitious — `config` is an opaque
jsonb column and the shape lives in design §2.3/§3. Removing it takes 1.5h off the critical path.)

**C1 and D1 are independent of each other** and run concurrently. C1 is no longer two workflows:
merging the aggregate sub-workflow into the main one removes the Execute-Workflow wiring and the
ordering problem where C1 needed C2's workflow id to exist. Design §5's rationale for the split
(«the formula must be demonstrable as the place with no LLM») is satisfied by a clearly labelled,
visually separated deterministic Code-node section on one canvas.

## Task board

### A1 · DDL, purge extension, smoke — @database-engineer

- `score_formulas` + `score_components` per design §4.2 exactly: `uq_score_formulas_active_axis`,
  `founder_id NOT NULL`, `weight numeric(6,5)`, `contribution numeric(8,5)`,
  `UNIQUE (run_id, criterion_id)`, nullable `score_id`.
- `trg_score_components_forbid_mutation` + `REVOKE TRUNCATE` on **both** tables. (Self-hosted
  Supabase grants TRUNCATE at `CREATE TABLE` time — not optional.)
- Extend `purge_founder()` **in place, anchored on text** per the coordination table.
  `founder_id` sweep first (catches parentless `insufficient_evidence` rows), then `score_id`.
- Smoke: new separate `DO $$` block, id range `…0940`–`…0949` — append-only rejection,
  TRUNCATE denied to all three roles, `purge_founder` succeeds against a founder holding
  **parentless** `score_components`, `uq_score_formulas_active_axis` rejects a second active row.
- Update `db/README.md` purge-contract + append-only sections, and add the fixture invocation to
  `CLAUDE.md > Commands` (design §6 requires it and nothing else owns it).

*Acceptance:* `./db/apply.sh` idempotent on second run; `smoke.sql` green; manual
`UPDATE score_components` raises `P0001`; `TRUNCATE` as `service_role` denied.

### A2 · Four agent specifications — orchestrator in role, `ai-agent-builder` skill

One spec each: `execution-signals` (E1,E3,E4,E5,E7), `expertise-signals` (X1,X2,X5,X6),
`leadership-sales-proxies` (L2,L3,L5), `red-flags` (R1,R2,R4). Each carries input contract (pack
shape, design §4.7), system prompt, JSON output schema, model + params, and design §4.8's
guardrails **verbatim**: `reasoning` before `verdict`, every criterion anchored with what `met`
concretely looks like, negative criteria explicit, lowercase verdict enum, one concern per agent.

Agents must be told they may **not** assign `evidence_tier` or decide `not_met` eligibility —
both are backend decisions (design §4.4 steps 5, 6a).

**`expertise-signals` additionally emits the `pedigree` object** (`prior_companies`,
`notable_employers`) — it already reads the tenure/employer claims. It carries no verdict and no
weight; the aggregator passes it through with fixed `scored: false` + the design §3.2 note. This
is the plan's answer to RSK-004 and design §8.2 flags it for the tech video, so an empty block
would be worse than none.

*Acceptance:* 4 specs under `docs/backlog/03-founder-score/agents/`; each output schema validates
against the `score_components` column set.

### B1 · `lib/f03/scoring.js` + tests — @backend-developer

Self-contained CommonJS, zero imports, no side effects (guiding decision 3). Implements design
§2.3 / §2.4 / §4.5: `aggregate(components, config) → {status, value, confidence, coverage, trend, missing}`.

Property tests — each maps to an invariant and **these are the acceptance criteria**:

| Test | Invariant |
|---|---|
| adding a `cannot_assess` criterion leaves `value` identical **and strictly lowers `confidence`** | **I2 / REQ-003** — the load-bearing one, both halves |
| `assessed_weight == 0` → `status: insufficient_evidence`, `value: null`, no throw | §2.4 |
| `coverage < min_coverage` → same | §2.4 |
| all verdicts `self_asserted` → `confidence` valid in [0,1], not NaN | review finding |
| `Σ contribution == value` within 1e-4 | §2.3 — judge-checkable arithmetic |
| `value ∈ [0,100]`, `confidence ∈ [0,1]` over 1000 random sets | column CHECKs |
| over 1000 random sets, `value` and `confidence` have scale ≤ 2 (`Number(v.toFixed(2)) === v`) | §2.3 — `numeric(5,2)` rejects a float-computed 100.005 |
| `Δ = ±(ε+0.1)` → `improving` / `declining`; `\|Δ\| < ε` → `stable` | §4.5 positive path |
| no prior row → `trend: null` (not `'stable'`) | §4.5 |
| identical `input_claim_ids` set, any order → `trend: null` | §4.5 |
| differing `formula_version` → `trend: null` | §4.5 |
| config weights sum to 1.00000 | §3 |

### B2 · `lib/f03/gate.js` + tests — @backend-developer

Design §4.4 steps 1-8 **in order**, including 6a and the step-5 re-application after demotion.
Pure: `(rawAgentOutputs, contextPacks, config) → components[]`. Same self-contained constraint.

Tests, one per step, plus specifically:

- `met` with empty `claim_ids` → `cannot_assess` (vantage guard).
- one hallucinated `claim_id` alongside two valid → verdict **survives**, bad id dropped.
- `not_met` with no `neg_src`-matching claim → `cannot_assess`.
- `not_met` reaching its source only via the `source_kind` fallback → **permitted** (the nullable
  `evidence.raw_signal_id` must not silently null the branch).
- `met` whose best evidence tier is `inferred` → coerced to `self_asserted` (step 6a).
- `quote_verbatim` not a substring of the cited claim → nulled, `rationale` kept (**I6 / RSK-003**).
- a sub-scorer returning an error object → its criteria become `cannot_assess` with
  `what_would_close_it`; the others still aggregate (step 8).
- uppercase `MET` → accepted, lowercased.
- red-flag demotion to `not_met` is re-checked by step 5 (ordering guard).

### B3a · `formula_v1` config row → `db/seed.sql` — @database-engineer

**Configuration, not fixture.** It must exist in every environment: `apply.sh` runs
`schema.sql` + `seed.sql` only, and feature 12's cold-start reset would otherwise leave
`score_formulas` empty and the feature dead. Appended to `seed.sql` with `ON CONFLICT DO NOTHING`.

Contents: weights, credits, `tier_factors`, `min_coverage`, `trend_epsilon`,
`max_claims_per_agent`, the criteria registry (id, subscorer, raw, weight, `neg_src`, anchor text)
and the red-flag `contradicts`/`demote_to` map — transcribed from design §2.3 + §3.

### B3b · 3-founder fixture — @database-engineer

`db/fixtures/03-founder-score.sql` per design §6: 1 synthetic with seeded contradictions
(`is_synthetic=true`), 1 deliberately sparse (exercises `insufficient_evidence`), 1 real from a
recent Show HN (public signals only).

**Build the synthetic and sparse founders first** — they are fully deterministic. The real founder
is the last step: if it overruns, two founders still demo the feature.

**Every `evidence` row sets `raw_signal_id`** (`neg_src` is load-bearing on it, and the column is
nullable — a fixture that omits it would exercise only the fallback and hide a real defect).
`raw_signals.source` from seeded slugs; `claims.topic` uses design §4.7 prefixes. Satisfy the
NOT NULL / UNIQUE list in design §6. Idempotent, rerunnable.

### B4 · `lib/f03/run.js` — headless runner — @backend-developer · needs B1, B2

`node lib/f03/run.js <founder_id> [--recorded <dir>]`. Reads claims⋈cards⋈evidence⋈raw_signals
from Postgres; builds the 4 routed context packs (§4.7 — including the cap, the tier-then-recency
ordering, the formatting normalisation, and recording each pack's `claim_ids`); calls the 4 agents
(or loads recorded JSON when `--recorded` is set); runs `gate.js` then `scoring.js`; writes
`ai_runs` ×4 (with `run_id` echoed into each `output_json`) + `scores` ×1 + `score_components` ×12,
or the `events` row on the `insufficient_evidence` branch; prints the §4.9 contract.
`scores.missing_flags` receives the `missing` **array** verbatim (never the `'{}'` object default).

This is what makes the product demonstrable without n8n, and what lets D1 pass deterministically.

*Acceptance:* end-to-end on all 3 fixture founders with `--recorded`, zero API calls, correct rows.

### C1 · n8n `f03-score-founder` (single merged workflow) — @n8n-workflow-builder · needs A2, B1, B2

Webhook + sub-workflow entry; claims⋈cards⋈evidence⋈raw_signals query; 4 routed context packs;
4 parallel LLM nodes; `ai_runs` ×4 written **before** validation; gate Code node; deterministic
aggregation Code node (visually separated and labelled — this is the no-LLM section); DB writes;
returns the §4.9 contract. Generates `run_id` once per run.

Code node bodies are **pasted verbatim** from `lib/f03/gate.js` and `lib/f03/scoring.js` with the
`// SOURCE OF TRUTH: lib/f03/<file>.js — do not edit here, edit there and re-paste` header.

*Acceptance:* exported to `n8n/workflows/`; pasted bodies byte-identical to the file bodies.

### D1 · End-to-end on the 3 fixture founders — @backend-developer · needs A1, B3a, B3b, B4

Run via `run.js --recorded`. Expected: real → `scored` with a mixed verdict set; synthetic → at
least one red flag fires and demotes a verdict; sparse → `insufficient_evidence`, no `scores` row,
one `events` row. Verify in psql: `Σ score_components.contribution == scores.value`; `ai_runs` has
4 rows per run joinable by `run_id`; `input_claim_ids` matches the union of pack ids.

**Exactly one live (non-recorded) run** is reserved, for the demo video — not for debugging.

### E1a · QA, DB-level — @qa-engineer · needs A1, B3b · ∥ C1

Independent attacks, psql + REST. **Do not re-derive A1's smoke assertions** — confirm that block
is green and move on.

1. Founder whose evidence has NULL `raw_signal_id` → does **not** silently become
   `insufficient_evidence`; the `source_kind` fallback fires.
2. **REQ-003:** two founders identical except one has strictly more `cannot_assess` criteria →
   identical `value`, strictly lower `confidence`. The invariant the whole feature rests on.
3. No fabrication: no code path invents a numeric value when evidence is absent.

### E1b · QA, contract-level — @qa-engineer · needs D1

4. Founder with all `self_asserted` verdicts → valid non-NaN `confidence`, insert accepted.
5. **REQ-002:** `founder_score` is never averaged with another axis anywhere; the breakdown is
   retrievable per criterion.

Output `qa-report-03.md`. Finding → fix by the owning builder → **independent re-check** → repeat
until GATE PASSED.

### F1 · Commit — @devops · needs GATE PASSED

Feature-03 paths only, never `git add -A`. Remote `Serg1kk/the-vc-brain` only; `.gitignore`
untouched. **No push** (operator asleep; pushing is outward-facing and was not authorised).
Other terminals active — `pull --rebase` first.

## Risks

| Risk | Mitigation |
|---|---|
| **Stage D prompt-debugging against a live API at hour nine** — the single likeliest schedule killer | B4's `--recorded` mode: D1 passes deterministically on recorded output; exactly one live run, saved for the video |
| `db/schema.sql` / `smoke.sql` concurrent edit with 04 | text anchors not line numbers; separate `DO` block with a disjoint id range; stop-and-report on ambiguity |
| n8n stage overruns | C1 is now a thin wrapper around logic already proven end-to-end by B4; the product demos without it |
| B3b fixture overruns on the real founder | synthetic + sparse built first and are fully deterministic |
| $50 OpenAI credits shared with other pipelines | recorded-mode default; 3 founders × 4 calls when live; no loops |

## Out of scope (design §7)

Social-personality analysis (SCOPE-005, greyed stub) · prediction intervals · external claim
verification (feature 05) · the 12 parked criteria and 3 parked flags · YC-directory calibration ·
Cohen's κ validation · `scores(axis='founder')` — **owned by feature 04**.
