# The VC Brain — MVP Roadmap (functional)

> Status: DRAFT v1 — scope options for the operator (Jul 18, ~23:15; ~16.5h to deadline,
> ~10-12 working hours). Technical part comes separately after the scope is picked. Before
> locking the chosen option — a NotebookLM pass (CLAUDE.md rule) + OSS-reference check.
> Russian version: [roadmap.ru.md](roadmap.ru.md).

## Givens (not up for debate)

- **API is mandatory** (operator requirement): service = web + API; agents connect via CLI
  (possibly MCP later) — fetch, update, search.
- Sponsor invariants: REQ-001..011 (`internal/Meetings/requirements.md`), scope rulings SCOPE-001..008.
- Time: ~10-12 solo working hours + **1.5-2h for submission artifacts** (3 videos + summary + zip).

## Personas (MVP)

| # | Persona | What they do | Key features |
|---|---|---|---|
| P1 | **Investment manager** (non-technical, primary — REQ-007) | Configures fund thesis, scans ranked feed, opens founder card, reads memo, decides | Thesis config · dashboard · founder card (axes+evidence) · memo · suggested deep-dive questions |
| P2 | **Agent / automation** (primary, on par with P1 — our differentiator) | Connects via API/CLI: submits candidates, reads scores+evidence, NL-search, watches | REST API · CLI · NL-search · watchlist (opt) · MCP (stretch) |
| P3 | **Founder-applicant** (secondary) | Submits minimal application (deck + name + artifact links), sees status, can delete data | Intake form · status · **opt-out (GDPR)** |
| — | *Hackathon judge* (design constraint, not a persona) | Sees the whole signal→decision path in 3 minutes | Demo script below |

## Scope options

### Option A — «Vertical Slice: Signal → Decision» ⭐ recommended
One living path end-to-end, on 3-5 REAL founders: signal/application → cold-start Founder
Score → 3 axes + per-claim Trust → memo → $100K recommendation. Sourcing inside the slice —
**one channel done deep** (GitHub hub → HN → personal site, identity resolution without ML).
Dashboard minimal but investor-grade.

- FOR: Investment Utility 30% (investor can actually act), Data 30% (channel depth + evidence),
  matches REC-001/REC-002 (Carl) and the Opus agent's advice; the demo tells one story.
- AGAINST: narrow sourcing front (1 channel), less «wow-breadth».

### Option B — «Sourcing-Heavy: Founder Radar»
Core = radar: continuous GitHub/HN scan → «founders you should know» discovery feed →
cold-start scoring + watchlist (Memory). Diligence/memo thin (score breakdown + evidence +
gaps, memo-lite).

- FOR: maximum bet on Carl's «sourcing = least competition»; Data 30%.
- AGAINST: risks Investment Utility 30% — memo-lite may not qualify as «decision-ready»;
  required memo sections (brief REQ) suffer.

### Option C — «Full Pipeline Thin» ❌ not recommended
All 4 stages + Thesis Engine + both tracks + committee. Exactly the RSK-001 anti-pattern
(«AI wrapper», 4 half-done modules) — listed for completeness.

**Recommendation: A with B's heart.** A vertical slice where the sourcing channel is one but
deep, and the depth IS our cold-start scoring (27 signals, RSK-002..004 mitigations). A and B
merge almost without loss if we don't build two channels.

## Functional map (option A+)

1. **Thesis Engine (config)** — sectors / stage / geo / check size / risk. Configurable
   (invariant #6), simple form. Filters and colors everything below.
2. **Intake (inbound)** — form: deck + company name (brief minimum) + optional artifact links
   (repo, live URL, demo) — «artifacts > slides» (REC-014). Two-stage gate: cheap thesis
   pre-filter → full scoring (REC-008, SCOPE-007).
3. **Sourcing Radar (outbound, 1 channel deep)** — GitHub profile as the hub → HN → personal
   site; discovery feed; «suggested outreach» stub card (STUB-001). Both tracks → one funnel.
4. **Founder Score (the core)** — cold-start branch; signals: shipped-vs-built, provenance
   checks, agency/completion, domain expertise 40+, GTM; anti-signals: GitHub stars, headcount,
   pitch polish. Score is persistent (Memory), trended, never reset (sponsor REQ).
5. **3 axes + Trust** — Founder / Market / Idea-vs-Market separately (REQ-002) + per-claim
   Trust (REQ-003: missing → confidence down). Validator agent (GVC pattern, REC-007) — stretch.
6. **Memo + Decision** — required sections: snapshot, hypotheses, SWOT, problem & product,
   traction; gaps flagged honestly (REQ-004); suggested deep-dive questions for the call
   (REC-005); $100K recommendation with conditions.
7. **Experience (P1)** — dashboard (ranked + trend) → founder card (score breakdown + evidence
   ledger) → memo view. Notion-approachability.
8. **API-first (P2)** — REST: submit / get score+evidence / get memo / **NL-search**
   («technical founder, Berlin, AI infra, no prior VC backing» in one query — brief REQ)
   + CLI wrapper. MCP — stretch.
9. **Data Ethics layer** — public data only, opt-out button, data minimisation
   (the pitch plan from `internal/research/data-sources.md`) — cheap, judges love it.

## What we honestly stub (per the intel base)

Real outreach (draft card) · reference calls (proxies / «unavailable») · financials/cap table
(«not disclosed») · investment committee and social-personality (stretch) · downstream — never.

## Demo script (3 min, for the video and the final)

Thesis config → radar found a real founder (not on Crunchbase!) → score with per-axis evidence →
NL-search → memo with gaps and deep-dive questions → «the investor acts». Closing slide:
**«3 naive mistakes we did NOT make»** (vibe-coding signal decay / LLM echo chamber /
survivorship bias — RSK-002..004 with sources).

## Phasing (functional milestones, no tech)

| Phase | Milestone (verifiable) | ~time |
|---|---|---|
| 1 | Score of one REAL founder with an evidence ledger, served through the API | 3-4h |
| 2 | Funnel: intake + radar → same scores; memo generated with required sections | 3-4h |
| 3 | Dashboard + NL-search + ethics layer + polish | 2-3h |
| 4 | **Submission**: 3 videos (demo/tech/team), 150-300-word summary, zip, Discord | 1.5-2h |

## DECISIONS (operator, Jul 18 ~23:40)

1. **Scope: Option A+** (vertical slice, one deep sourcing channel), with a **multi-source
   dashboard** where non-implemented channels appear as honest stubs — the UI shows the full
   multi-channel vision.
2. **P1 primary context: K1+K2** (inbound triage → pre-call prep). K3 radar works on one
   channel; other channels stubbed in the dashboard.
3. **Founder-side agent: FULL cycle.** Interview at application time (live LLM agent) + a real
   share-link second interview requested by the VC (email sending mocked). Cards (company /
   founder / team) are generated during the first interview, **pre-filled from public
   footprints** («we already found your GitHub — confirm and fill the gaps»).
   **Voice input/output in the chat (MVP):** a mic button (ElevenLabs STT) to speak answers and
   TTS playback of the agent's questions — speaking is easier than typing (less mid-chat
   abandonment), and **voice originals are stored as evidence artifacts**: a spoken answer has
   provenance a copy-pasted text doesn't (possible legal value; abandoning mid-interview is
   itself a founder signal). UI carries a note: **«Voice agent — next phase»**.
4. **Demo data:** 3-5 real founders (HN Show HN / GitHub) + 1-2 synthetic profiles with
   seeded contradictions (to safely demo truth-gap / red flags).
5. **API: REST + CLI + a ready-made Claude skill for the CLI** — the skill ships full docs:
   how to work with the CLI, database structure, available methods, query patterns; a fund's
   agent plugs in a token from their system and works with the service. MCP — not in MVP.
6. **Tech stack — OPERATOR OVERRIDE (Jul 19): n8n + Supabase hybrid.** All product workflows,
   automations, assistants and agents are built as **visual n8n workflows** (visible and
   understandable, not code); backend code only as a thin layer where n8n is awkward.
   Database — **Supabase** (Postgres; PostgREST gives REST out of the box; storage for voice
   artifacts). No vector DB for now (operator will call it if needed). Frontend — SPA
   (Lovable / Claude Design experiment) over Supabase REST + n8n webhooks. CLI + Claude skill
   on top of the same REST surface. docker-compose locally (operator's familiar
   n8n+Supabase self-hosted setup), VPS at the end. n8n work goes ONLY through the operator's
   global agents: `n8n-requirements-orchestrator` → `n8n-workflow-builder`.
   *(Architect's earlier FastAPI+SQLite comparison kept as reference; its key borrow — vantage's
   «model proposes, backend decides» + append-only versioned scores — carries over as the
   scoring pattern inside n8n/Supabase.)*

**Feature backlog: [`docs/backlog/`](backlog/) — 11 MVP features (01-11), one folder each with a
detailed README. Grooming/spec/plan per feature happens in separate terminals.**

### Founder-interview guardrails (from Exa research, Jul 18 — non-negotiable)

Research: Greenhouse 2026 (2,950 seekers), Recruiting Tech Reviews 2026 (2,587 + 614 baseline),
Zapier Ezra pilot, field experiment (3,000+ applicants, exe wp 2602).

- **Disclose upfront**: «an AI agent interviews you; here's what we evaluate; ~10-15 min;
  a human investor reviews everything before any decision». Disclosure + human-alternative
  = +1.4 experience points, re-apply swing +80pp. 70% of candidates today are NOT told — cheap win.
- **Questions ONLY from the card's gaps** — generic question sets are the #1 completion killer;
  personalized questions are our differentiator («not the same 15 questions again»).
- **Pre-fill before asking** — the agent arrives knowing the public footprint; the founder
  confirms instead of retyping. Shorter interview → less of chat-AI's 28% mid-process abandonment.
- **Answers = self-reported claims**, low base confidence, verified by truth-gap; the interview
  is NOT scored for eloquence (SIG-018: persuasion is devalued; 22% of candidates already use
  LLMs live). Bonus: fraud avoids completing interviews (Zapier: only 5% flagged) — the
  interview doubles as a fraud filter.
- **Outcome immediately** after completion (status + timeline) — 51% of AI-interviewed
  candidates today never hear back; silence is the #1 complaint. Ours answers in 24h by design.
- **Duration stated upfront + progress bar** (duration uncertainty = deferral → permanent drop).
- **«Request a human» button** (can be a stub) — 46% want the option; most never use it.
- ⚠️ **Known risk:** async interviews deter applicants (-50% continuation in the field
  experiment, worst for women) — mitigations: pre-fill (short), disclosure, human option,
  and the interview being optional-after-form, not a wall.

## External services policy (operator, Jul 19)

**Buy/connect over build:** we do NOT build our own databases — we plug into existing
services and use them to the maximum. Operator can add subscriptions if a service is worth it.

In the product now: **OpenAI** (reasoning/scoring) · **Tavily** (search/research/crawl) ·
**ElevenLabs** (STT/TTS in the interview chat) · **GitHub API** + **HN Algolia** (free, sourcing core).
Free candidates to plug next (from data-sources research + OSS references): **YC OSS API**
(~2.3k B2B startups — ground-truth cohort) · **Adzuna** (hiring velocity — «#1 breakout
predictor» per Thesis-Agent) · ProductHunt GraphQL (non-commercial ToS ok for hackathon) ·
USPTO/EPO patents · Wikipedia pageviews. Paid founder/company data providers (Crunchbase,
Harmonic, Specter, PDL) — post-MVP, only if a concrete gap demands it.

## Post-MVP (parking lot — operator, Jul 19)

- **Voice interview agent** (replaces the text chat for interviews): modern voice models hear
  intonation, hesitation, latency, «is he searching/reading while answering» — a natural
  counter to LLM-assisted answering that text chat cannot detect. Needs its own work item:
  **detailed risk analysis «text agent vs voice agent»** (gaming resistance, deterrence/drop-off,
  accessibility, bias of voice-based judgments, legal/consent for voice analysis). Explicitly
  out of the 24h scope; the MVP UI carries a «Voice agent — next phase» note.
- Второе интервью email-делivery по-настоящему; MCP-сервер; остальные sourcing-каналы
  из дашборда-заглушек.

## Open questions (для tech phase)

- OQ-001: exact intake form composition (fields + thesis gate).
- OQ-002: GitHub metric formula replacing devalued volume (which 5-7 signals in MVP scoring).
- Which real founders exactly (fresh HN Show HN picks) — select during build.
- Project NotebookLM notebook is not created yet — create it at tech-phase start and run the
  roadmap through it (CLAUDE.md rule; flagged honestly, not skipped silently).
