# Backlog Tracker — dependencies & parallelization

> Purpose: run features in PARALLEL terminals safely. Update the Status column as you go
> (backlog → groomed → spec → in-build → done). Keep this file the single source of truth
> for «what can I start next».

## Status board

| # | Feature | Status | Depends on (hard) | Blocks | Wave |
|---|---|---|---|---|---|
| 01 | memory-data-model | **in-build** (design ✅ approved) | — | everything | 0 |
| 02 | sourcing-radar | backlog | 01-schema | 08, 11 | 1 |
| 03 | founder-score | backlog | 01-schema | 05, 06 | 1 |
| 04 | market-trend-competition | backlog | 01-schema (+likely schema additions!) | 05, 06 | 1 |
| 07 | thesis-engine | backlog | 01-schema | 02 (gate), 09 | 1 |
| 05 | truth-gap-trust | backlog | 03 & 04 output contracts | 06 | 2 |
| 08 | founder-intake (compact B) | backlog | 01-schema, 02 (pre-fill sub-workflows) | 11 | 2 |
| 10 | api-cli-skill | backlog | 01-schema (PostgREST); webhooks land per-feature | 09 (NL-search UI) | 2 |
| 06 | memo-decision | backlog | 03, 04, 05 | 09 | 3 |
| 09 | investor-dashboard | backlog | 03-07 outputs (design track can start NOW) | 12 demo | 3 |
| 11 | demo-data-ethics | backlog | 02, 08 | 12 demo | 3 |
| 12 | docker-deploy | backlog | compose base can start EARLY; final needs all | — | 0* + final |

## Key insight: depend on the SCHEMA, not on 01 being finished

01's `design.md` is **approved** → its table/field contracts are already stable. Wave-1
features can be groomed and built against the design NOW; they only need the live DB for
integration testing. Don't wait for 01 to fully land before grooming.

## Waves (what to run in parallel terminals)

**Wave 0 — already running:** 01 (operator). Optional early-starts in spare terminals:
- **12-lite**: bring up the base docker-compose (n8n + Supabase) — EVERY wave-1 feature needs
  the running instances; doing it now removes the shared bottleneck.
- **09-design track**: @designer brief + Lovable vs Claude Design bake-off needs NO backend —
  only the 4 open UX questions answered. Can run fully parallel to everything.

**Wave 1 — the moment 01 schema is applied (3-4 parallel terminals max for solo+agents):**
- **03 founder-score** (highest rubric value — the core)
- **04 market-trend-competition** (⚠️ likely schema additions: competitor entity, why_now —
  reconcile with 01 FIRST, then it's independent)
- **07 thesis-engine** (small; unblocks the radar's gate and the feed lens)
- **02 sourcing-radar** (start right after 07's gate contract, or stub the gate with
  pass-through and swap later)

**Wave 2 — as wave-1 contracts stabilize:**
- **05 truth-gap** (needs 03/04 claim+score output shapes — contracts, not finished features)
- **08 founder-intake** (needs 02's identity-resolve/pre-fill sub-workflows)
- **10 api-cli-skill** (PostgREST views can start from schema alone; add action webhooks as
  features land; the Claude-skill docs can be drafted early)

**Wave 3 — assembly:**
- **06 memo** (consumes 03+04+05) → **09 dashboard build** (consumes everything; design
  already done in wave 0) → **11 demo-data** (radar pre-warm + synthetics) → **12 final
  deploy + submission artifacts (3 videos, summary, zip — protect 1.5-2h!)**

## Critical path

**01 → 03 → 05 → 06 → 09 → 12/submission.** Anything delaying these delays the demo.
04 runs parallel to 03 and joins the path at 05. Protect the critical path first when
choosing what to parallelize.

## Parallel-terminal rules (collision safety)

1. One feature = one terminal = one owner. Don't edit another feature's folder; cross-feature
   needs go through this tracker or the orchestrator session.
2. Schema changes (04's competitor entity, 06's memos table) — reconcile with 01's design.md
   FIRST, apply as additive migrations, announce in this file (append a line under «Schema
   changelog» below).
3. Shared n8n instance: prefix workflows by feature (`f03-score-founder`), export JSON to
   `n8n/workflows/` on every save.
4. Commits: per-feature paths only, via @devops agent; never `git add -A`. Pull --rebase
   before push (multiple terminals!).
5. Status here updates on grooming start, spec approval, build start, done.

## Schema changelog (append-only)

- 2026-07-19: 01 design.md approved (base schema).
