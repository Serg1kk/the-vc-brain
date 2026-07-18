# 09 · Investor Dashboard (K1 triage + K2 pre-call)

Status: backlog · Depends on: 01-07

## What it is

The investor-facing SPA: **ranked feed** (inbound + radar, thesis lens, channel stubs) →
**founder/company card** (axes with trends, evidence ledger, gaps, market/competition tabs)
→ **memo view**. Primary contexts K1 (morning triage) and K2 (pre-call prep) per personas.md.

## Why (rubric & evidence)

- UX = 15% but gates trust: «Notion-level approachability + Bloomberg-level analytical depth»
  (brief §8); effortless for a NON-technical investor.
- REQ-002: several scores shown separately + how each was derived — the card IS this.
- Operator: multi-source dashboard with honest channel stubs («полноценный интерфейс виден»).
- Distrust of black boxes is P1's core emotion → evidence-on-click is the trust precondition.

## Where the idea comes from

- personas.md P1 contexts K1-K5; UX skeleton from the chat brainstorm (6 screens).
- reporting (Apache-2.0): `components/diligence/*`, `research-card.tsx` — the polished UI
  reference to redraw (not extract). vcbrain dashboard concept; sieve-mcp evidence typing
  badges. OSS-scout report (in flight) will add a borrow-map of card sections.
- Operator design path: Lovable AND Claude Design try the same task; front is a pure
  REST/Supabase consumer so both can compete without backend changes.

## Implementation view

Screens (SPA over Supabase REST + n8n webhooks):

1. **Feed**: sidebar Inbound/Radar/Watchlist + channels list (GitHub ✅, HN ✅, LinkedIn 🔒,
   X 🔒, ProductHunt 🔒 — stubs with honest tooltips); rows: name/company/one-liner,
   **4 axis mini-bars** (Founder/Market/Idea-vs-Market/Trust — never one number), trend
   arrows, source badge, freshness; thesis-lens switcher re-sorts live.
2. **Card**: hero with axes+trends; tabs: Evidence (ledger table: claim → source link →
   confidence → status badge), Market (category chip, trend arrow + cited facts, TAM sanity,
   bull/neutral/bear), Competition (table with threat levels), Interview (transcript +
   voice-artifact players), «What we don't know» honest block; **«Interview signals — next
   phase» placeholder block** (teaser: interview-derived scores, voice vs call comparison
   metrics); **manager notes/comments on the card** (feed the AI-suggested follow-up questions form — 08); actions: View memo · Suggest follow-up questions · delete-on-request (ethics).
3. **Memo view**: required sections, per-claim trust badges, deep-dive questions block,
   recommendation banner with thesis rules fired; export markdown.
4. **Thesis config** (07's form). 5. Founder-side screens live in 08.

Open UX questions to operator (pending from brainstorm): dashboard density (roomy rows with
expandable depth — my lean), live-preview split-screen in interview, demo first frame,
light/dark theme.

## Boundaries & stubs

No auth screens (single fund). Channel stubs clickable → «coming soon» panel with what the
channel would add. Mobile — not a target (judges watch desktop demo).

## Agents & work modes (orchestration — read before grooming)

- **Plan first:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (until ✅ APPROVED). Git/deploy — @devops ONLY.
- **UX/Design — @designer is the CENTER of this feature + UX-brainstorm with operator** (4 open questions: density, live-preview, demo first frame, theme). Prepares design brief + tokens for the Lovable vs Claude Design bake-off; investor-grade «Notion approachability + Bloomberg depth».
- **Build:** @frontend-developer — SPA over Supabase REST + n8n webhooks; pure REST so the front stays swappable.
- **AI logic:** none new here (renders 03-07 outputs). NL-search UI hits feature 10's endpoint.
- **Data model:** @database-engineer — read views only; no schema changes expected.
- **QA:** @qa-engineer — axes never collapse into one number anywhere in UI (REQ-002), evidence-on-click works for every rendered number, channel stubs honest.

## Open questions

- Lovable vs Claude Design bake-off — operator runs both, we pick; @designer agent prepares
  the design brief + tokens beforehand.
