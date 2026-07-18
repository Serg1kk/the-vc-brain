# 08 · Founder Intake & Interview Agent (voice-enabled)

Status: backlog · Depends on: 01, 02 · The founder-side heart (two-sidedness)

## What it is

The founder's entrance: a **minimal application form** (deck + company name + optional
artifact links) followed by a **chat interview with an LLM agent** that arrives pre-filled
from public footprints, asks ONLY about the card's gaps, supports **voice input (ElevenLabs
STT) and TTS playback**, and builds the company/founder/team cards live on screen. Plus a
**real share-link second interview** the investor can request (email delivery mocked). Voice
originals stored as provenance artifacts.

## Why (rubric & evidence)

- Operator decision (Jul 19): FULL cycle, voice in/out in MVP, «Voice agent — next phase» note.
- Founder's #1 pain: time + repetition, not rejection (SeedForge 4,690-pain research: 37%
  timeline drag; «same 15 questions 20 times, no shared infrastructure for founder proof») —
  the card IS that infrastructure; «prove once».
- Brief minimum: deck + company name; over-collecting counts against (REQ-008, FAQ-4). Form
  asks for artifacts — «GitHub, jupyter NB, replit app — 100x more useful than a deck»
  (REC-014, t.me/eaccchat/47812).
- Interview guardrails (research-locked in roadmap): disclosure upfront + human-review note ·
  questions only from gaps · pre-fill before asking · answers = self-reported claims (low base
  confidence, NOT scored for eloquence — SIG-018) · outcome immediately · duration stated +
  progress bar · «request a human» button · known deterrence risk mitigated (interview after
  form, not a wall).
- Precedents: Parley (FACT-012, 40+ VCs — demand proven), SeedForge Living Profile; NONE of
  the 9 OSS references have a founder-facing interview → differentiation.
- Zapier Ezra pilot: 97% completion at 4.5/5 when opt-in + human-reviewed; fraud avoids
  completing interviews → the interview doubles as a fraud filter.

## Where the idea comes from

- IDEA-002 (hacker Zahil @28:24, confirmed by KB), operator's two-sided vision (personas.md
  P2 + «Two-sidedness» section). Abandon-mid-interview = itself a founder signal (operator).
- Voice provenance: spoken answers harder to fake than pasted text; stored originals may have
  legal value (operator, Jul 19).

## Implementation view

n8n + Supabase + frontend chat component:

1. **`intake-form`** (frontend → Supabase): minimal fields; creates company+founder+card rows;
   triggers `identity-resolve` + pre-fill scan (feature 02 sub-workflows).
2. **`interview-agent`** (n8n, webhook per message; prompts via ai-agent-builder): context =
   card + gaps list; picks next question from highest-value gap; each answer → claim
   (source_kind: interview|voice, verbatim preserved); updates card completeness → frontend
   live-preview re-renders (Supabase realtime or polling).
3. **Voice**: mic button → audio → n8n webhook → ElevenLabs STT → text into the same flow;
   original audio → Supabase Storage (`voice_artifacts`); TTS button per agent message →
   ElevenLabs TTS via backend proxy (key never in browser).
4. **`follow-up-interview`**: investor clicks «Request follow-up» on card → generates
   share_token link (real, opens interview scoped to selected gaps) → email delivery MOCKED
   (show the composed email + link in UI).
5. Finish: immediate status screen («card complete, verdict within 24h») + opt-out link.

## Boundaries & stubs

Email sending mocked. Voice AGENT (hears intonation/latency, counters LLM-assisted answers) —
post-MVP with its own text-vs-voice risk analysis (roadmap parking lot). No auth for founders —
share_token links only.

## Open questions

- Interview length cap (5-7 questions?) and gap-priority order — groom.
- Live-preview split-screen (UX question #2 to operator — pending answer).
- Deck parsing depth in MVP: text extraction only vs slide-by-slide claims (I lean text-only
  + claims extraction; visual parsing post-MVP).
