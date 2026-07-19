# 07 · Thesis Engine (configurable fund lens)

Status: **DB + evaluator DONE** (2026-07-19, DB QA gate PASSED) · n8n workflows in progress ·
Depends on: 01 · Blocks: 02 (gate), 09 (lens)

**Working today, without n8n:** `node lib/f07/run.js <application_id> [--recorded <dir>] [--gate-text <file>]`
runs the whole gate end-to-end against Supabase. Verified live on the fixtures —
Nordkit → `passed` (fit 100), Fogline → `insufficient_evidence` (coverage 0.38, no score row
written), GameLoop → `borderline` via a soft deal-breaker.

Docs: [design.md](design.md) (rev.3a) · [plan.md](plan.md) · [tracker.md](tracker.md) ·
[handoff.md](handoff.md) — **read handoff.md if you own 02, 04, 06, 09 or 10** ·
[qa-report-07.md](qa-report-07.md)

## What it is

The fund's investment thesis as a configurable object: sectors, stage, geography, check size,
ownership targets, risk appetite. Works in three places: (a) **pre-filter gate** at intake
(cheap first door), (b) **lens on the feed** (thesis-fit sorting/filtering), (c) **context
for the memo** (recommendation is thesis-relative).

## Why (rubric & evidence)

- MVP-must per brief §Must-demonstrate 1: «every recommendation filtered and scored through a
  fund-specific lens»; hardcoding kills the pillar (FAQ-15 — configurable, explicitly).
- Open door + pre-filter (REC-003, Carl @47:30): «first door and second door… we are not
  interested in funding the next ice cream shop». Two-stage screening economics (REC-008):
  cheap text-only gate → expensive full analysis only past the gate.
- Their own example: B2B tech filter, rating 1-5, 4-5 pushed to humans (FACT-001/002).

## Where the idea comes from

- vcbrain **Thesis Studio** (MIT): must-haves / deal-breakers / weighted dimensions —
  the best OSS shape of this; adapt the schema, not the code.
- dealflow `firmstyle` config concept; Sequoia «Services as Software» piece stored in KB as
  an example thesis document to demo thesis-matching.

## Implementation view

- Supabase `thesis` table: one row per fund config {sectors[], stages[], geos[], check_range,
  ownership_target, risk_appetite, must_haves[], deal_breakers[], weights_json, version}.
- UI (09): simple config form, 6-8 fields + editable chips; changing thesis re-sorts the feed
  live (the «lens» wow-moment for the demo).
- n8n: **`thesis-gate`** sub-workflow (cheap LLM classify: in-thesis? deal-breaker hit? →
  pass/soft-fail with reason — soft-fail still stored, shown under «Outside thesis» so the
  open door stays visible); **`thesis-fit-score`** used by feed ranking and memo.
- Recommendation in memo cites which thesis rules fired.

## Boundaries & stubs

Single fund (no multi-tenancy). Thesis back-testing (vcbrain has it) — post-MVP note.

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **AI logic (MANDATORY `ai-agent-builder`):** thesis-gate classifier (cheap, in-thesis / deal-breaker with reason).
- **n8n (MANDATORY, two n8n agents):** `thesis-gate`, `thesis-fit-score`.
- **Data model:** @database-engineer — `thesis` config table (versioned); reconcile with 01.
- **UX/Design + UX-brainstorm with operator:** thesis config form + the «lens» interaction (thesis switch re-sorts feed live) — @designer designs, @frontend-developer builds.
- **QA:** @qa-engineer — soft-fail keeps open door (gray-out, not hide), gate reasons visible.

## Open questions — both RESOLVED

- **Default demo thesis** → yes, «B2B tech, pre-seed/seed, EU+US, $100K», mirroring the sponsor,
  with the stage mapped onto our schema (`pre_seed|seed`; theirs is late seed → Series A, out of
  scope). Seeded `active=true, is_default=true`. See design.md §7.
- **Deal-breakers: hard-hide or gray-out?** → gray-out, and no longer a lean: it is **D-01**, with
  reasoning and **DB-level enforcement**. `enforcement` is per-rule and defaults to `soft`; `hard`
  is legal only for mandate-fatal or fraud, and the validator rejects a `hard` rule without a
  valid `hard_justification` — including when the key is absent entirely, which is where a naive
  plpgsql check silently lets it through.

**Handed onward:** the anonymization vs founder-driven-assessment tension belongs to feature 03.

## Post-MVP (deliberately not built)

Thesis back-testing · miss-rate calibration (would require a labeled cohort we do not have —
shipping uncalibrated percentages would fabricate a metric) · input-side identity masking ·
boolean composition in `expr`.
