# The VC Brain — Personas (AJTBD)

> Built with the operator's AJTBD framework (Job Graph, Job Structure, Segmentation).
> A segment = people with similar Core Jobs + the same expected outcome + similar success
> criteria. Big Jobs above are motivational context. Different contexts → different active
> jobs and different communication. Status: DRAFT — the primary MVP context is the operator's
> pick (see questions in chat). Russian version: [personas.ru.md](personas.ru.md).

---

## P1 · Investment manager at an early-stage fund (human, primary)

**Segment root:** investment managers/partners at funds moving into very-early ($100K checks),
whose Core Job is *«get an evidence-backed verdict on a specific founder/startup that I can
trust and act on — in hours, not weeks»*. Expected outcome: decision made/defended, calendar
not burned, nothing important missed. Success criteria: speed · per-claim traceability ·
honesty about gaps · never miss an outlier.

**Big Jobs above Core (motivation, stable for decades):**
- *Find the next Cursor before the rest of the market* → carry, reputation, league position.
- *Never miss a strong founder nobody sees* (fear of the miss).
- *Recommend deals I won't be ashamed of before partners/IC* (reputational defense).
- *Get through the growing inflow without burning the calendar* (vibe-code-era supply glut, PAIN-005).

**Graph around the Core Job:**
- Previous Jobs (before us): learn the founder exists · gather scattered traces · book a call.
  Today — manual; Crunchbase/Dealroom are blind at this stage (PAIN-002).
- Next Jobs (after us): founder call (our memo prepares the questions — REC-005) · IC defense ·
  term sheet · (downstream — out of scope).
- Sibling Small Jobs (we don't do, but sit next to): reference calls · valuation negotiation ·
  legal DD.

**Contexts (which job is active and what communication fits):**

| # | Context | Active job | Success criteria | Product communication |
|---|---|---|---|---|
| K1 | **Inbound triage** (morning pile of applications) | quickly drop the non-viable, spot the worthy | speed, no misses, cheap | ranked feed, short verdicts, thesis filter |
| K2 | **Pre-call prep** (30-60 min per founder) | in 30 min know where to dig | precise deep-dive questions, gaps surfaced | full memo + suggested questions + evidence |
| K3 | **Proactive radar** (discovery) | find names that aren't in the databases | novelty, cold-start evidence | «founders you should know» feed |
| K4 | **Defending the decision** (IC/partner) | justify the recommendation | every claim → source | memo export, per-claim trust breakdown |
| K5 | **Watchlist** (after passes) | don't lose the ones who grow | trend alerts | «founder score went up: look again» |

**Emotions before:** anxiety of missing · inflow fatigue · distrust of «black boxes»
(hence evidence and separate axes are not features — they are the trust precondition).
**After:** control, confidence, «I came to the call prepared».

**Consideration Set (what actually competes in P1's head):** DIY (Excel + manual googling +
an intern) — the main competitor · Crunchbase/Dealroom (blind at early) · Parley (matchmaking
by dialogue, not evidence scoring) · in-house tools of large funds (Grizzly — unavailable to
a mid-size fund). Consideration Activator: «your next Cursor is currently invisible to your
tools — we see him through primary footprints».

---

## P2 · Cold-start founder-applicant (human, secondary — but feeds P1)

> Enriched with Exa research (Jul 18): SeedForge original research 05.2026 — 4,690 founder
> pains from LinkedIn/X/Reddit/Quora; Pear VC (Slush keynote); Founder Institute (250k+
> founders); Gompers et al. 2020 (885 VCs). Key fact: **the #1 pain is NOT rejection (3.5% of
> mentions) but «timeline drag» (37%)** — how long it takes to get ANY answer.

**Segment root:** solo/small teams, often solo+AI, no track record and no network; Core Job —
*«prove my startup is real ONCE — and get a fast honest verdict»*. Expected outcome: an answer
in 24h instead of the 142-day average raise. Success criteria: minimal effort to enter · speed
of the answer · transparent criteria · judged on merit, not connections.

**Big Jobs above Core (by pain frequency from research):**
- *Get back to building* — «fundraising is a 6-month pause on actual building»; 53% of all
  pains are about time (drag + repetition + friction). The hottest Big Job.
- *Prove myself once, not 30 times* — «every investor starts from zero, the same 15 questions
  20 times, no shared infrastructure for founder proof» (Repetition Trap, 73% co-occurrence
  with timeline drag). Our founder card IS that infrastructure.
- *Understand the black box's rules* — The Unknown: unknown criteria, no feedback on
  rejection, ghosting. «That creates a black box for founders».
- *Get the first money before the window closes* (PAIN-001) — 2.1% meeting conversion,
  20-25 investors × 2-3 meetings per decision.
- *Be seen on merit, not network* (PAIN-007) — «if you don't know people who can introduce
  you, you're starting from zero»; cold outreach barely works (200 emails → 2 meetings).
- *Protect my psyche* — The Psyche: sleepless nights before pitches, «survival mode»; from our
  KB: founders hire a buffer person to read rejections.

**Graph:** Previous — built, accumulated traces (GitHub, launches), learned «investor
language» («show me the money»: proof of outcomes, not effort). Next — follow-up interview →
call → term sheet. Siblings / indirect competitors for the same Big Jobs — accelerators,
grants, warm-intro hunting (lawyers/accountants as the «backdoor»), bootstrap from revenue,
**the DIY grind** (30 investors × 6 months) — the main competitor; new direct ones: SeedForge
(Living Profile), Platvix (deck score + verify + investor matching), Parley.

**Contexts:**

| # | Context | Active job | Communication |
|---|---|---|---|
| K0 | Pre-raise (building) | accumulate proof density («what's measurable and money-adjacent weekly?») | «your score grows with every release» — the card lives before the raise |
| K1 | First application | apply in minutes (deck + name + artifacts; «artifacts > slides») | minimal form, card-completeness progress bar |
| K2 | Fund's follow-up | pass the agent's personalized interview via share link (email) | questions FROM the card's gaps — not «the same 15 questions» |
| K3 | After a pass | show the trajectory → re-score (watchlist) | honest reason + «the score is alive, not a verdict»; updates instead of vanishing |
| K4 | Privacy | delete my data | opt-out button (GDPR) |

**Emotions before:** exhaustion from repeating themselves · black-box anxiety · fear of
silence. **After:** clarity and a next step; «every investor arrives informed» — proved it
once. The K3 mechanic converts rejection pain into our Memory layer (SIG-025 + REC-010):
95-99% vanish after a «no» — investors themselves flag the ones who keep sending updates as
a rare signal.

**What the founder does NOT want (anti-jobs):** another long form · another «evaluator» that
answers with silence · a public rating of his failures he can't control (→ card privacy,
sharing via his own link).

---

## P3 · Agent integrator (NOT a human, primary on par with P1 — operator requirement)

**Core Job:** *«programmatically submit a candidate, get score+evidence+memo, search with an
NL query, watch for changes — no human in the loop»*. Success criteria: stable API contract ·
evidence in every response (machine-verifiable) · idempotency · honest confidence fields.
Its owner's Big Jobs: embed The VC Brain into their pipeline (a client fund, a scout network,
an analyst bot). Communication: OpenAPI docs, CLI, (stretch) MCP.

---

## Two-sidedness of the product (operator's vision, Jul 18)

The product serves both sides, but **asymmetrically**: the platform belongs to the fund
(REQ-007); the founder side is an intake agent SERVING P1's jobs (cuts screening time,
sharpens the card, prepares the call). Compatible with the invariants: the interview is
asynchronous text, NOT a call (REQ-001 ok) · the base form stays minimal, the interview is a
progressive addition (REQ-008 ok) · precedents: Parley (FACT-012), IDEA-002 (confirmed by two
sources). Fairness bonus: the feedback loop for the founder = the brief's «equitable capital
allocation» — a strong pitch narrative.
