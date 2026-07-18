# 01 · Memory & Data Model (Supabase)

Status: backlog · Depends on: — · Blocks: everything

> **Design approved (2026-07-19): [design.md](design.md)** — supersedes the
> «Implementation view» section below.

## What it is

The persistent Memory layer of The VC Brain in **Supabase (Postgres)**: founders, companies,
cards, claims with evidence, versioned scores, watchlist, interviews and voice artifacts.
«Nothing is thrown away» — deduplicated, timestamped, source-tagged (challenge brief, Memory
pillar). PostgREST gives a REST surface over these tables for free (feeds feature 10).

## Why (rubric & evidence)

- Data Architecture & Intelligence = **30%** of judging; the brief's note: generic ingestion
  scores low unless it serves the cold-start case.
- Sponsor requirements: Founder Score **persists across applications and is never reset**
  (REQ-011/FAQ-6); memory layer to iterate/train on later (REQ-009, Carl @57:38).
- Trend requirement: each axis shows trend over time → scores must be **append-only versions**,
  not overwrites.

## Where the idea comes from

- Challenge brief §2 Memory pillar; Carl Q&A (internal/Meetings/requirements.md REQ-009).
- **vantage (MIT)**: append-only versioned scores with `prompt_version`+`formula_version`,
  `ai_outputs` ledger — carry this pattern into Postgres tables.
- InGa: persistent tenant memory concept; reporting: supabase/migrations as schema reference.
- Intel: REC-010 (watchlist), REC-013 (evidence ledger), SIG-025 (post-rejection trajectory).

## Implementation view

Supabase tables (first cut):

- `founders` (id, name, links{github,hn,site,li,x}, created_at) + `companies` (id, name,
  founder_ids, category, stage, source_track: inbound|radar)
- `cards` (id, subject_type: founder|company|team, subject_id, status, completeness)
- `claims` (id, card_id, axis: founder|market|idea_vs_market|trust, text_verbatim, source_kind:
  self_reported|public|interview|voice, source_url, confidence 0-1, verification_status:
  verified|unverified|contradicted|missing, evidence_quote, created_at) — **the evidence ledger**
- `scores` (id, subject_id, axis, value, trend, formula_version, prompt_version, inputs_json,
  created_at) — **append-only**; current score = latest row per (subject, axis). Never UPDATE.
- `interviews` (id, card_id, kind: first|follow_up, share_token, transcript_json, status)
- `voice_artifacts` (id, interview_id, question_id, storage_path, duration) → Supabase Storage
- `watchlist` (subject_id, reason, last_scored_at) · `events` (audit trail: what ran when)

n8n side: workflows write ONLY through Supabase API (service key), never raw SQL from many
places — one «DB-write» sub-workflow per entity keeps writes consistent («model proposes,
backend decides»: LLM output → validation node → insert).

## Boundaries & stubs

No vector DB (operator's call — plain Postgres + FTS is enough for MVP NL-search grounding).
No multi-tenancy/auth beyond a single fund + service tokens. No migrations tooling — schema.sql
applied once, changes additive.

## Open questions

- Supabase local (docker-compose full stack) vs operator's existing self-hosted instance for
  dev — decide in feature 12.
- Do we store raw GitHub/HN JSON snapshots (provenance) or only extracted claims? (I lean:
  store raw in a `raw_snapshots` table — cheap, and provenance is our differentiator.)
