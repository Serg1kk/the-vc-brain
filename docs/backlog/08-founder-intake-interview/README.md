# 08 · Founder Intake & Optional Gap Questions

Status: **in build** · Depends on: 01 (schema), 02 (pre-fill contract) · Blocks: 11

Design: [`design.md`](design.md) rev.2 · Plan: [`plan.md`](plan.md) rev.2 ·
Frontend contract: [`lovable-brief.md`](lovable-brief.md) · Execution: [`tracker.md`](tracker.md)

## What it is

The founder's entrance to the system:

1. **A three-field application** — company name, contact email, deck. Optional artifact links
   and optional extra files. Nothing else is required, ever.
2. **The deck parsed into claims**, with an honest declaration when it cannot be read.
3. **Up to three optional questions**, generated from what the system could not learn on its
   own. Skippable in one click.
4. **An immediate status screen** — the product's promise is a verdict within 24 hours.
5. **A manager-initiated follow-up form** delivered by share link (email delivery mocked).

## What it is not

Not an interview, not a chat, not voice, not a founder account, not a product surface. REQ-007
puts the platform in the fund manager's hands; this side is a door, and every hour spent
widening it is taken from features 04/05/06, where most of the judging weight sits.

## Why it is shaped this way

**The questions are optional and are never called an interview.** A natural field experiment on
3,000+ applicants found async interview formats cut application continuation by over 50%, and
the drop was largest among the *most qualified* applicants and largest for women. A product whose
whole thesis is finding people the market's filters miss cannot afford a component that filters
hardest on the qualified. The same study found the AI *assessment* out-predicted human
recruiters — deterrence and accuracy are separable, so we keep the second and drop the first.

**The three questions are not arbitrary.** They are selected by arithmetic, not by a model:
the scoring formula's registry is read, and the criteria kept are those no public source can
reach — `neg_src ⊆ {deck_parse, interview_answer}`. Exactly three qualify: first customers
(L2, weight 0.150), ICP specificity (L3, 0.090), and insider-level competitor knowledge
(X5, 0.056). Together that is **0.296 of the founder score that public sourcing structurally
cannot see.** The radar's own end-to-end proof is limited by exactly these criteria: a founder
discovered with no application scored 60.76 at coverage 0.395 against a 0.704 ceiling. So the
questions are the mechanism that lifts coverage, and the lift is measurable on screen. An LLM
only phrases them; the choice of what to ask is explainable and immune to eloquence.

**Skipping lowers confidence, never the score.** Penalising a skip conflates stealth with
failure — the one-sided label-noise trap — and it would punish exactly the heads-down builders
this product exists to find.

**Answers are never scored for eloquence.** They are scored on whether they yield a checkable
fact: a name, a number, a date. There is no AI-text detector anywhere in the system, deliberately:
the best available accuracy is unusable, polished human writing is indistinguishable from
generated, and the errors land disproportionately on non-native English speakers.

## What is genuinely new here

Across 20 open-source VC tools surveyed, searches for founder-facing follow-up, applicant status,
and any GDPR or opt-out concept return **zero results**. One project generates a diligence
question list — and ships it to the investment team. Another detects a gap and returns
"Need More Info" for a human to chase. **Nobody routes a machine-detected gap back to the founder
as an answerable question.** That connection is this feature's contribution.

## Honest boundaries

| Item | Status |
|---|---|
| Email sending | Mocked — the composed message and link are shown, nothing is sent |
| Non-PDF uploads | Stored and labelled unparsed; only PDFs are read automatically |
| Image-only decks | Detected and declared, with extraction confidence capped |
| Voice input | Not built. A short "next phase" note, and nothing records audio |
| Founder accounts | None. Share tokens only |
| Team composition | Not extracted by this feature; the memo renders it as a gap |
| Erasure of stored files | The deletion function does not sweep object storage — disclosed, not hidden |

## Where the numbers come from

Grounding for every claim above lives in [`design.md`](design.md) and the source passes behind
it: the project's internal requirement base, ten NotebookLM queries under an explicit early-stage
frame, eleven external research queries, and a re-reading of the twenty open-source references.
The design then went through an adversarial spec review that returned 19 findings, five of them
blocking — all of which proved real and all of which are folded in
([`agents/spec-review-rev1.md`](agents/spec-review-rev1.md)).
