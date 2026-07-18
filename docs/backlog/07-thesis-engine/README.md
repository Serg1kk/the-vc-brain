# 07 · Thesis Engine (configurable fund lens)

Status: backlog · Depends on: 01

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

## Open questions

- Default demo thesis: «B2B tech, pre-seed/seed, EU+US, $100K» (mirrors sponsor) — confirm.
- Do deal-breakers hard-hide or gray-out candidates? (I lean gray-out — open-door optics.)
