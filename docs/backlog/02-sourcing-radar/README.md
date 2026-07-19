# 02 · Sourcing Radar (GitHub + HN, one channel deep)

Status: **DONE** (2026-07-19 · QA gate PASSED · 265 tests · see [done.md](done.md)) · Depends on: 01 (schema), 07 (thesis gate)

> **Design of record: [design.md](design.md)** — it supersedes the "Implementation view" below,
> which was written before the sponsor material and the live APIs were checked. Nine assumptions
> in this README turned out to be wrong on contact with real data; §2.1, §4.1 and §7.1 of the
> design record each one with its measurement. Notably: the funnel is ~1380 candidates per
> 14-day window (not 40–80), only ~36% of Show HN posts link to GitHub (so the product URL is
> the majority path, not the repo), the artifact owner is an Organization 11% of the time, and
> Tavily `/map` returns zero URLs on real personal sites.
>
> Proof it works end to end: a founder discovered by the radar — who never applied and has no
> deck — carries a real Founder Score of **60.76** (confidence 0.61) produced by feature 03's
> pipeline, with all 16 cited claims tracing back through evidence to 5 raw signals across 3
> sources. See [tracker.md](tracker.md).

## What it is

The outbound track: an n8n workflow that continuously (cron) scans **HN Show HN + GitHub**,
resolves identities (GitHub profile as the hub), builds founder/company records with claims,
and feeds the discovery feed «founders you should know». Other channels (LinkedIn, X,
ProductHunt, patents…) appear in the dashboard as honest **stubs** — the UI shows the
multi-channel vision, one channel actually works deep.

## Why (rubric & evidence)

- Sourcing is the **most important MVP part** per the brief; Carl: depth of ONE channel beats
  breadth (REC-001, Q&A @1:00:22). Judges score data richness and smart sourcing ideas, not polish.
- The sponsor's blindness is exactly here: early teams are not on Crunchbase/Dealroom
  (PAIN-002, Carl @1:03:03) — primary footprints are the only place they're visible.
- Cold-start tiebreaker (rubric note): radar finds people BEFORE any track record exists.

## Where the idea comes from

- `internal/research/data-sources.md` — the full stack decision: GitHub GraphQL (free,
  5k req/h, richest honest signals), HN Algolia (free, no key, `tags=show_hn` = a ready-made
  «built and showed» funnel), Tavily crawl for personal sites. Legal red lines documented there.
- **Identity resolution without ML** (same doc): HN username → GitHub login → profile.blog →
  personal site → LinkedIn/X links in footer. GitHub profile is the hub.
- Thesis-Agent README (no-license, ideas only): 12-source table, hiring-velocity as predictor.
- Intel: FACT-011 (hidden signals live in community comments), SIG-015 (hackathon-signal decay).

## Implementation view

n8n workflows (built via n8n-requirements-orchestrator → n8n-workflow-builder):

1. **`radar-scan`** (cron, ~15min in demo mode): HN Algolia `show_hn` fresh items → filter
   (thesis pre-gate from feature 07) → for each: GitHub user lookup (GraphQL: profile, repos,
   contributionsCollection, languages) → Tavily extract on personal site → write claims to
   Supabase (raw snapshots + extracted claims, source-tagged).
2. **`identity-resolve`** (sub-workflow): the cascade above; confidence per link; ambiguous →
   flag, never guess.
3. **`radar-score-trigger`**: new/updated card → calls feature 03 scoring workflow → if score
   crosses thesis threshold → appears in discovery feed + «suggested outreach» stub card
   (STUB-001: draft message shown, nothing sent — outreach is out of scope SCOPE-002/003).

Rate limits are non-issues at demo scale (GitHub 5k/h, HN 10k/h). robots.txt respect in the
crawl node — visibly, it's a judged ethics point.

## Boundaries & stubs

Channels LinkedIn / X / ProductHunt / patents / accelerators: sidebar entries with «coming
soon» + honest tooltip (what it would add). No real outreach. No continuous 24/7 crawling —
cron with modest windows; demo pre-warmed with a seeded scan.

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **AI logic (MANDATORY `ai-agent-builder`):** thesis pre-gate classifier, footprint-extraction agents (GitHub/HN/site → claims).
- **n8n (MANDATORY `n8n-requirements-orchestrator` → `n8n-workflow-builder`):** `radar-scan`, `identity-resolve`, `radar-score-trigger`.
- **Data model:** @database-engineer — writes claims/raw_snapshots; any schema change must be reconciled with feature 01.
- **UX/Design:** not here (feed UI lives in 09). No frontend work.
- **QA:** @qa-engineer — identity-resolution correctness (no guessed links), rate-limit behavior, robots.txt respect visible.

## Open questions

- Which HN window for the live demo (last 48h Show HN?) — pick during build; pre-select 3-5
  real founders from it (feature 11).
- GitHub PAT scope: public-only classic token (create at build time).
