# Scoring UX — the per-score design specification (feature 09)

> **Why this file exists.** The dashboard renders five families of number, and they are
> epistemically different objects. A single universal score component would be the easiest thing to
> build and the wrong thing to ship: it would state, visually, that a persistent judgement about a
> person, a model's opinion about a market, and an arithmetic rollup over verified claims are the
> same kind of fact. They are not, and the investor's ability to act depends on telling them apart.
>
> This document specifies each one separately — what it is, what would misrepresent it, and what
> its component looks like. It is the source of truth for the design; `lovable-brief.md` is the
> build instruction derived from it.
>
> **Audience:** the designer (Claude Design / Lovable) and the frontend implementer.
> **Persona:** P1, a non-technical investment manager, 30–60 minutes before a founder call, whose
> stated emotional baseline is *distrust of black boxes*. In her own words the product's job is
> «in 30 min know where to dig». **Gaps are not this product's failure state — they are its
> payload.**

---

## 0. The five families at a glance

| Family | Subject | Persistence | The question it answers | The failure mode to design against |
|---|---|---|---|---|
| **Founder Score** (03) | a **person**, across all their companies | append-only, never resets | "How much builder-capability have we *evidenced*?" | confusing **absent** with **weak** |
| **Market / Idea-vs-Market** (04) | this application | per-application snapshot | "Is this a market worth a $100K check?" | confusing **opinion** with **data** |
| **Trust** (05) | every individual **claim** | recomputed live from evidence | "Is this specific statement true?" | confusing **unverified** with **false** |
| **Thesis fit** (07) | application × thesis | versioned per thesis | "Does this match what *this fund* buys?" | reading a fund preference as a quality judgement |
| **Obscurity** (02) | a radar candidate | recomputed on collection | "How invisible is this person to conventional databases?" | reading invisibility as **low quality** |

**Two rules bind all five.** They come from the sponsor and from upstream feature designs, and a QA
gate tests them:

1. **They never average into one number.** There is no composite anywhere in the schema,
   deliberately. Their *disagreement* is the signal the investor is paying for.
2. **No value is ever displayed or sorted without its confidence and coverage beside it.**

---

## 1. Founder Score — the evidence ledger

### 1.1 What it is

A 0–100 number attached to a **person**, not a company or a deal. It answers: *based on everything
we can actually observe about this human — code they shipped, products that are live, customers who
committed, how precisely they describe their buyer — how much builder-capability have we
evidenced?*

Four properties make it unlike every other number in the product:

- **Person-scoped.** Its subject is the founder; the application field is empty. Every other score
  is application-scoped.
- **Persists across companies.** The same person applying with a second startup produces a new row,
  not a replacement.
- **Never resets** — and this is enforced at the database grant level, not promised in prose.
  Updates and deletes raise an error; only a GDPR purge can remove it.
- **Sharpens with milestones.** Each run appends a row; the history of rows is what produces trend.

**It is an input, not a verdict.** It feeds the `founder` screening axis, which combines it with
founder-market-fit and competitor knowledge. **The UI must never label it "the Founder axis."**

### 1.2 What is under it — 12 criteria in 3 groups

Each criterion is a **binary question**, not a rating. Weights sum to exactly 1.00.

**Execution signals — group weight 0.40**

| ID | Weight | In plain English |
|---|---|---|
| E1 | 0.100 | Merged a pull request into a repo **they do not own**, within 12 months |
| E3 | 0.060 | Commits in ≥8 of the last 12 weeks — *consistency, not volume* |
| E4 | 0.100 | A live production URL actually responds — not merely a repository |
| E5 | 0.080 | Measured external usage: forks, dependents, downloads, transactions |
| E7 | 0.060 | Provenance clean: first-commit date consistent with account age, no earlier source for the flagship repo |

**Expertise signals — 0.30**

| ID | Weight | In plain English |
|---|---|---|
| X1 | 0.094 | Documented tenure in the **same vertical** as the startup |
| X2 | 0.075 | Insight specificity: says something about the industry an outsider could not guess |
| X5 | 0.056 | Describes competitors at **insider granularity** — where deals are lost, what breaks in production; not pricing-page level |
| X6 | 0.075 | Did substantial work **nobody asked for**, before any funding — *the highest-value cold-start signal* |

**Leadership & sales proxies — 0.30**

| ID | Weight | In plain English |
|---|---|---|
| L2 | 0.150 | First customers, LOI, or pilot evidence — the single heaviest criterion |
| L3 | 0.090 | ICP specificity: vertical + size + buyer role + trigger + current alternative |
| L5 | 0.060 | Written communication concise and structured under compression |

**Red flags — a separate stream that never subtracts points**

| ID | Flag | Demotes |
|---|---|---|
| R1 | Provenance spoofing: pusher ≠ author, backdated commits, repo predates account | E7, E1 → `not_met` |
| R2 | Star farming: high stars, ~0 forks, issues disabled | E5 → `self_asserted` |
| R4 | Claimed capability with no observable artifact (AI-washing) | E4, X2 → `self_asserted` |

A flag **demotes the verdict of the criteria it contradicts** rather than deducting points —
deducting would double-count against the Trust axis. **The UI must never render a flag as a
"−8 points" chip.**

### 1.3 The four verdicts — and why this is the whole design

| Verdict | In the denominator? | Credit | Effect on confidence |
|---|---|---|---|
| `met` (documented) | yes | 1.0 | ↑ |
| `met` (discovered) | yes | 0.8 | ↑ |
| `self_asserted` — claim exists, uncorroborated | yes | 0.3 | ↓ |
| `not_met` — established as absent **by a competent source** | yes | 0 | — |
| `cannot_assess` — no competent source was consulted | **no** | — | ↓↓ + recorded as a gap |

**The sponsor's invariant, made mechanical: missing data lowers confidence, never the score.** A
criterion marked `cannot_assess` leaves the denominator entirely and cannot drag the value down.

> A cold-start founder with no footprint does not get a low score — those criteria leave the
> denominator and he gets low **confidence**. A founder who *claims* traction without evidence gets
> **both** a lower score and lower confidence. Different failures, no longer conflated.

And it is not left to the model to honour: a `not_met` verdict is only legal if the evidence pack
actually contains a claim from the source competent to establish that absence. Otherwise the
backend **coerces it to `cannot_assess`**. Without that rule, two identical founders diverge purely
on crawl luck — the one whose GitHub we never fetched scores ~100, the one we did scores ~12.

**This is the most defensible thing in the product: the system distinguishes "we looked and it
isn't there" from "we never looked", in code, not in a prompt.** The UI's job is to keep that
distinction visible.

### 1.4 What it deliberately refuses to score

Worth designing a visible place for, because it is an argument, not an omission:

| Excluded | Why |
|---|---|
| GitHub stars, lines of code, commit volume, contribution graph | commit dates are unvalidated and graph-farming is a commodity. Stars appear **only** as red flag R2 |
| Headcount | an anti-signal in 2026 |
| Pitch polish, narrative quality | persuasion is devalued — AI writes a perfect deck |
| Age | data-minimisation red line, and empirically contested |
| Similarity to past funded winners | the survivorship anti-pattern |
| Education, school brand, employer prestige | in a 16,000-startup study, a model built **solely on founder education** was the single strongest predictor of *underperforming* investments |

**Pedigree is collected and displayed, but not scored** — and the design mandates it appear in a
separate `Pedigree (not scored)` block with the reason attached. This is a UI requirement, not a
flourish: it is a stronger answer to the survivorship question than silent omission — we collected
it, measured it, and can show why we do not use it.

Vibe-coded prototypes are handled structurally rather than by a dedicated criterion: E7 weights
provenance and E5 weights externally measured usage, neither of which a generated prototype
produces.

### 1.5 Coverage vs confidence — they diverge, and the divergence is information

- **Coverage** = *how much of the rubric we managed to look at.* Pure weight arithmetic. A founder
  with 4 of 12 criteria assessed has low coverage no matter how good those 4 look.
- **Confidence** = *how much to trust the number.* 55% coverage + 45% evidence quality.

A founder can have coverage 1.0 and confidence 0.55 if every verdict rested on self-assertion.
**Show both, always, and show what drives confidence** — a lone "0.55" cannot distinguish
"we looked at everything but nobody corroborated it" from "we looked at half of it and the half was
solid".

### 1.6 Determinism

**The architecture in one line: the model proposes booleans, the backend decides the number.**

- **Model** — four calls per run, one per group. Each returns, per criterion, a verdict, cited
  claim ids, an optional verbatim quote and a "what would close it" string. **The model never
  emits a number.** Unbounded numeric scores from language models are poorly calibrated;
  five-point ordinal scales reach only 38–58% exact accuracy; binary criteria produce the highest
  agreement. The only model-assigned quantity anywhere is red-flag severity.
- **Backend** — a validation gate then overrides the model on eight counts: enum legality, unknown
  criteria dropped, absent criteria inserted as `cannot_assess`, hallucinated citations dropped,
  the negative-capability check, red-flag demotion, evidence tier assignment (**never the model's**),
  and verbatim-quote substring verification. Then pure arithmetic produces coverage, value,
  confidence, contributions and trend with zero model involvement.

**Chip: `▦◇` — rule on model input.** The arithmetic is reproducible; the boolean inputs are not.

One honest caveat the UI must not overstate: the temperature parameter is omitted rather than set
to zero (the model rejects zero), so sampling can still flip a verdict between live runs. **Do not
imply bit-identical reproducibility.**

### 1.7 The `insufficient_evidence` branch

When coverage falls below 0.25, or nothing was assessed at all, **no score row is written at all.**
There is no way to write "unknown" into the column: writing 0 violates the missing-data invariant,
writing 50 invents a number, and crashing kills the demo. So the system writes no number — but it
**does** write the four model runs and all twelve per-criterion verdicts, plus an event recording
why.

**Consequence for the UI: the breakdown exists even when the number does not.** The ledger renders
in full; only the headline number is replaced.

What it means to the investor: *"We have not seen enough to put a number on this person — and here
is precisely what would change that."*

### 1.8 The gap strings

Each `cannot_assess` criterion carries a `what_would_close_it` string. Real examples:

> "A GitHub API record of a merged PR authored by the founder into a repository they do not own."

> "Evidence of a real customer commitment, such as a paying customer, signed LOI, named
> organisation running a pilot with an outcome, measured waitlist conversion, or documented
> discovery interviews showing consistent demand."

> "A claim specifying the target vertical, company size, buyer role, triggering problem or event,
> and current alternative, narrowly enough for a stranger to identify fifty matching companies."

⚠️ **Two design constraints from real data.** Length varies from ~50 to ~250 characters — **do not
design a fixed-height single-line chip.** And a minority of these strings are backend-generated
fallbacks that leak engineer vocabulary ("sub-scorer", "criterion E7"). Either the UI maps those to
human copy or the product accepts that a few gap lines read like log output. Flag for the
copywriter, not the designer.

These strings are also the direct input to the memo's "where to dig" questions — the same content
serves triage and call prep.

### 1.9 Trend

Computed against the **immediately preceding row for the same person**: ≥ +3.0 → improving,
≤ −3.0 → declining, otherwise stable.

**There is no time window.** Trend is *event-spaced*, not time-spaced — the previous row might be
from an hour ago or three months ago.

Trend is **null** when there is no prior row, when the prior row used a different formula version,
or when the inputs were identical (so re-running the workflow cannot manufacture a "stable"). Null
rather than "stable" is deliberate: *"stable" is a claim about history we have not earned.*

**At demo time most founders will have a null trend.**

### 1.10 What would misrepresent this score — the adversarial list

Every one of these is a way a plausible UI silently breaks an invariant.

1. **Rendering the value as a percentage or a completion bar.** It is a weighted credit ratio over
   *only the criteria we could assess*. "62%" reads as "62% of the way to good".
2. **Sorting the feed by raw value.** This is the design's own named landmine: correctly
   implementing the missing-data invariant means **one `met` with everything else unknown yields
   100.00 at confidence ≈ 0.05**. Sort by raw value and *the least-known founders rank highest.*
   **Default sort must be value within confidence bands** (high ≥ 0.7 > medium ≥ 0.45 > low). My
   recommendation: do not offer a raw-value sort control at all.
3. **Rendering "no score" as 0, "—", "N/A", or a grey blank.** It is a positive finding with its own
   event and its own gap list.
4. **Rendering it as "not yet scored", a spinner, or "pending".** The run completed. We looked and
   declined to guess.
5. **Showing `cannot_assess` as a zero, a red X, or a failing mark.** Absent ≠ negative.
6. **Giving `not_met` and `cannot_assess` a shared treatment.** The entire negative-capability
   machinery exists to keep them apart.
7. **Showing a green check for both `met` and `self_asserted`.** Self-asserted is penalised twice
   on purpose — lower credit *and* lower confidence.
8. **Averaging it with Market or Idea-vs-Market.**
9. **Labelling it "the Founder axis."** It is an input to that axis.
10. **Presenting it as a prediction or a probability.** There is no calibration behind it. The
    feature's own closing note is blunt: *we can say the scoring is evidence-backed, explainable
    and reproducible; we cannot say it is accurate.* Any copy reading "likelihood", "chance of",
    "predicted" is an overclaim.
11. **Comparing scores computed under different formula versions.** They are stamped precisely
    because they are not comparable.
12. **Drawing trend as a time-series line chart.** It is event-spaced; a time axis implies a rate of
    change that does not exist.
13. **Rendering a null trend as "stable" or a flat line.**
14. **Showing confidence as one number with no breakdown.**
15. **Styling the model's `rationale` like the verified `quote_verbatim`.** They are separate fields
    precisely to stop a paraphrase being laundered as a quote.
16. **Showing a quote without its source link.**
17. **Putting pedigree next to the score without the "not scored" framing.** Ex-Palantir adjacent to
    a 72 reads as contributing to the 72.
18. **Rendering a red flag as a point deduction.**
19. **Hiding `demoted_by`.** When star-farming demotes a criterion, an investor seeing only the
    final verdict has lost the most interesting fact on the page.
20. **Implying the 12 criteria are the complete rubric.** 12 of 24 designed criteria are parked.
    Coverage 1.0 means "everything we currently ask", not "everything worth asking".
21. **Claiming the negative-capability check is question-level.** It is source-level: one GitHub
    claim licenses `not_met` across several criteria even if it addresses none of them
    specifically. Tooltip copy saying "we verified this specific question" would be false.

### 1.11 The component

**Founder Score must not look like a gauge.** Its entire value is *composition* — the sponsor
requires the investor see **how** it was derived. A dial ships exactly the black box P1 distrusts.

Give it a **persistent identity chip that appears wherever the person appears** — feed row, card
header, memo header — distinct in shape from application-scoped scores. A rounded rectangle with a
person glyph, versus a tile treatment for application-scoped axes. When the investor sees the same
chip on two different deals, "the score follows the person" lands without a tooltip.

#### At rest — one row, ~72px, three zones

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⌾ FOUNDER SCORE · person-scoped                            formula_v1  ⌄     │
│                                                                              │
│   67.96      ▓▓▓▓▓▓▓▓▓▓░░░░░░  confidence 0.63     ●  7 of 12 assessed        │
│   ───────    coverage │ evidence quality           coverage 0.54             │
│   not a %                                                                    │
│                                                       5 gaps ▸ what closes   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Zone 1 — the number, decimals kept.** `67.96`, not `68`. Decimals are an honesty signal: round
numbers read as judgements, `67.96` reads as computed. Beneath it, in muted micro-copy, a literal
disclaimer: **"weighted score over 7 assessed criteria — not a percentage, not a prediction."**
Put it in the component. Pre-empting the two misreadings costs 20px and buys the component's
credibility with a reader whose baseline is distrust.

**Zone 2 — confidence as a *segmented* bar, never a smooth gradient.** Two labelled segments in one
track: coverage (55%) and evidence quality (45%). This makes the composition legible at rest.
Colour by band, not continuously, because the bands are the ranking key.

**Zone 3 — coverage as a discrete count.** **"7 of 12 assessed"** — a count of criteria, which a
non-technical reader parses instantly and cannot mistake for a grade. The decimal sits underneath
as the machine-readable value. Then the affordance that does the real work: **"5 gaps ▸ what would
close them"**.

**Trend, when present:** a directional chevron with an *event* framing, not a time framing —
`▲ improving · +8.2 since 3 new signals`. When trend is null, **render nothing at all.** No flat
line, no dash, no "stable". Absence of the element is the honest rendering of an unearned claim.

#### The `insufficient_evidence` variant — same footprint, same prominence

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⌾ FOUNDER SCORE · person-scoped                            formula_v1  ⌄     │
│                                                                              │
│   Not enough evidence to score                     ●  1 of 12 assessed        │
│   ─────────────────────────────                    coverage 0.06             │
│   We looked. We are not guessing.                  below the 0.25 threshold  │
│                                                                              │
│   ▸ 11 things that would produce a score                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**This is the component's best moment, not its worst.** Same height, same weight, same prominence
as a scored founder — deliberately. Demoting it visually teaches the investor it is a failure.

The copy **"We looked. We are not guessing."** is the product's thesis in five words, and it is
exactly what differentiates us from every tool that would have printed a 50. Keep it verbatim.

The expand affordance changes wording from "gaps" to **"11 things that would produce a score"** —
turning a dead end into a task list.

#### On expand — the ledger

A table, one row per criterion, grouped by the three families, group weight in each header.

```
EXECUTION SIGNALS                                                weight 0.40
──────────────────────────────────────────────────────────────────────────────
✓  Merged a PR into someone else's repo (12mo)      documented   +14.93  ▸
   "merged 4 PRs into apache/arrow"  ↗ github.com/…

◐  Live production URL responds                     self-asserted  +4.48  ▸
   ⚑ demoted by R4 · claimed capability, no observable artifact
   "Real-time protection you can trust."  ↗ fintrace.io

○  Measured external usage                          — not assessed  —     ▸
   ▸ What would close it: "Independent usage evidence such as download
     counts, dependent packages, transaction records, or named users."
──────────────────────────────────────────────────────────────────────────────
                                          Σ contributions = 67.96  ✓ verified
```

**Four visually orthogonal verdict marks — the single most important decision in this component.**
They must not sit on one colour ramp, because they are not one dimension:

| Verdict | Mark | Treatment | Reads as |
|---|---|---|---|
| `met` | **✓ filled** | solid, full opacity | "evidenced" |
| `self_asserted` | **◐ half-filled** | outlined, hatched fill | "they say so; nobody else does" |
| `not_met` | **✗ outlined** | solid outline, high contrast | "we checked; it isn't there" |
| `cannot_assess` | **○ empty ring, dashed** | **achromatic, desaturated** | "we haven't looked" |

**`cannot_assess` must be achromatic.** The moment it takes on a warning colour it reads as a
failing grade and the sponsor's invariant dies at the UI layer. Dashed ring, grey — the visual
language of "not yet", not "no".

And **`not_met` — a finding — must read as *more* confident than `cannot_assess`**, which inverts
the usual convention that grey is softer than red. That inversion is the point of the whole
feature, and it is the detail most likely to be lost in generation. Call it out explicitly to the
tool.

**Per row at rest:** verdict mark · the criterion **in plain English** (never "E1" as the primary
label — the ID goes in a monospace micro-tag for the technical reader) · evidence tier as a word ·
contribution in signed percentage points.

**Per row on expand:** the substring-verified quote in a **quote treatment with its source link** —
indented, distinct face; and the model's rationale in a clearly **secondary, labelled "model
interpretation"** treatment. These two must never share styling. Where a flag demoted the verdict,
show it inline with its name.

**The footer is the trust move.** `Σ contributions = 67.96 ✓ verified`. The design guarantees the
contributions sum to the value; surfacing that as a live, checkable footer lets the investor — and
a judge — audit the arithmetic by reading. **No other score in this product can offer that.** Make
it a visible affordance, not a hidden property.

#### Two adjacent blocks, both required

**`Pedigree (not scored)`** — visually separated, quieter container, reason **inline and not behind
a tooltip**:

> Ex-employer and serial-founder status are collected and shown for context. They are excluded from
> the score: models built on founder pedigree were the strongest predictor of underperforming
> investments in a 16,000-startup study.

Bury that in a tooltip and the strongest methodological argument the product makes is lost.

**`Personality (research)`** — greyed stub, no interaction, explicitly parked.

#### In the feed

A founder row shows **value + confidence band + "n of 12"** as an inseparable triad. Never the
number alone.

**Founders with insufficient evidence appear in the feed**, in their own band below "low", labelled
"not enough evidence" — **never filtered out.** Filtering them is precisely how a fund misses the
invisible outlier, which is this persona's stated primary fear.

---

## 2. Market, Idea-vs-Market and Competition

### 2.0 The one thing to fix before anything else — the 50/50 collision

**An unresearched market and a measured, middling market both score exactly 50.**

This is deliberate and correct: under the sponsor's invariant, absence must never score worse than
a verified negative. But it makes the market value **uninterpretable in isolation**, and every
production run so far has landed on exactly this number — one real company scored `market 50` at
**confidence 0.00**.

> A decision node that reads `value >= 50` treats "we could not research this category" as
> equivalent to "this market is adequate."

The two are distinguishable **only** by confidence and the missing-data flags. Therefore:

**A UI that renders "Market: 50" without confidence adjacent and equally prominent is actively
lying.** This is not a styling preference. It is the highest-severity requirement in this document,
and it drives the component design in §2.7.

### 2.1 What each output is

| Output | In plain English |
|---|---|
| **Market trend** | Not an opinion — a count. We ask a news search "who raised money in this category this year", bucket the **dated** results into the last 90 days vs the 90 before, and call it *improving* at ≥1.5×. Under 3 dated events we refuse to call it. |
| **TAM sanity check** | Two questions, deliberately never merged. (a) *Is this market big enough?* TAM ≥ $1B pass, $500M–1B watch, below fail. (b) *Could this company ever reach enough of it?* TAM × a realistic share (0.4–2%, set by how concentrated the buyers are) × a 5× exit multiple; ≥$100M implied exit pass, below $30M fail. **The same $1B market can pass one gate and fail the other, and that disagreement is the product.** |
| **Bull / neutral / bear** | A one-word label derived *arithmetically* from the market score: ≥70 bullish, 40–70 neutral, below 40 bear. Plus a fourth value, **`undetermined`**, used when no TAM was ever established — because an unresearched market scores exactly 50 and would otherwise print a confident "neutral" on zero evidence. |
| **Competitors + threat levels** | Companies we **found in retrieved documents**, never recalled from model memory, each tagged direct/adjacent/incumbent/alternative, each flagged with whether the founder named them, rated 1–4 on danger and 1–3 on switching cost. **The highest-value item is the ones the founder did not mention.** |
| **Idea-vs-Market axis** | A 0–100 number answering "is this product defensible in this market": starts at 50, moves on switching cost, threat level, evidenced accumulating advantage, displaced status quo, and −10 if the founder named zero competitors while we found ≥2. |

### 2.2 The grounding split — three epistemic classes that currently look identical

This is the section that should drive the design. Three different kinds of statement leave this
feature and the database does not distinguish them.

**Class A — deterministic arithmetic, no model.** All three score values, confidence, the market
trend histogram, the TAM and CAGR bands, the venture-scale check, buyer concentration, the outlook
label, evidence tier and strength, mismatch severity. **Chip `▦`.**

**Class B — model judgement grounded in retrieved documents.** TAM ranges, buyer counts, ARPU,
assumptions, CAGR, why-now, tailwinds and headwinds, every competitor record, threat level,
switching cost. Both models are instructed that the retrieved document set is their only admissible
world, and the competitor schema **requires at least one source URL per competitor — a structural
guarantee that no competitor is recalled from training data.** **Chip `◇`, grounded.**

**Class C — model judgement with NO retrieval at all. The one the UI must not hide.**

The market categoriser runs **before any search executes.** Its own specification says so:

> **No web search has run when this agent executes.** It sees only what the company said about
> itself.

It produces the market category, the ICP, the buyer unit. And here is why it matters more than it
looks: **the category is interpolated directly into all five subsequent search queries.** Every
downstream "fact" is retrieved through a frame the model invented from a one-liner. If the category
is wrong, the whole evidence chain is confidently wrong.

**The category is the least-grounded output in the feature and is currently rendered as the most
confident one — a solid chip at the top of the panel.** Fixing that is a design task, not a
backend one.

**Class D — an undocumented heuristic found in the build.** The founder-market-fit term is naive
substring keyword overlap: split the category on non-alphanumerics, keep words over 3 characters,
test whether any appears anywhere in the expertise text. The implementing node's own comment admits
it is a judgement call the design never specified. **Do not label this "domain expertise verified"
anywhere in the UI.**

### 2.3 Forecast vs fact — they sit side by side in the same panel

TAM claims are classified **`forecast`** downstream, and the class exists for exactly one reason:

> `forecast` behaves exactly as `qualitative` at verdict time. It exists as a separate class name
> **only so the UI can label it "Forecast"** rather than merely "unverified". Optimistic TAM is
> **expected noise at pre-seed, not a punishable lie** — attempting to "verify" a projection
> against search results is itself a fabrication path, because a forecast, an allegation and a
> confirmed fact all read identically in a model's output.

Consequences:

- **TAM never receives a verdict, ever.** It never enters the verification queue.
- **CAGR *is* verdict-eligible** — it is classified as a dynamic fact. So TAM and growth rate sit
  adjacent in the same panel with **different epistemic status**.
- Forecast and qualitative claims are **excluded from the trust rollup denominator** and counted
  separately. A card can be 90% forecast and still show a healthy trust ratio.

**The label is designed to exist. Use it.**

### 2.4 Facts with no citation, structurally

Evidence rows are created for market sizing, growth, why-now, tailwinds, headwinds and trend.
**Nothing else gets one.** These are therefore written with **zero evidence rows**:

- `market.category` — model-invented, pre-search (Class C)
- the venture-scale check — derived arithmetic
- the outlook label — derived
- the shadow-market hypothesis — derived

There is **no field that says "this assertion has no evidence."** The UI must derive it by counting
evidence rows per claim and treating zero as its own state — otherwise a generic "show sources"
affordance returns an empty list on the most prominent chip in the panel.

⚠️ Two related traps:

- On derived claims the text field holds a **human-readable assertion, not a quotation.** Never
  render it inside quote marks.
- The market-trend "quote" is not a quote — the build stores a truncated search snippet. Do not put
  it in a quotation treatment.

### 2.5 Threat level is inverted

**1 is the best position for the startup, 4 is the worst.**

| Value | Meaning |
|---|---|
| 1 | Disruptive innovation — incumbents neutralised |
| 2 | Upstream interception |
| 3 | Blue-ocean niche — copyable |
| 4 | Perfect competition / red ocean — a red flag at pre-seed |

Any sort-ascending table, any "1–4 severity" mental model, any badge that darkens with the number
**inverts the meaning**. **Never show the bare integer.**

Switching cost: 1 = crosses the 10× threshold and the switch happens · 2 = 10–20% better, such a
switch very rarely happens · 3 = zero differentiation.

⚠️ **Provenance asymmetry worth knowing if the UI ever shows a methodology tooltip:** the
switching-cost rubric comes from the research corpus; the threat-level rubric is **our own
invention**, and the design states it must never be attributed to Porter in the memo or the pitch.

### 2.6 What would misrepresent these outputs

1. **The 50/50 collision** — §2.0. Highest severity.
2. **A confident bull stance on one uncited source.** The math permits it: the *label* is computed
   from the value, not from confidence. **A bullish badge at confidence 0.3 must be visually
   impossible to mistake for one at 0.9.**
3. **A TAM rendered with the same authority as a verified revenue figure.** TAM never gets a
   verdict; revenue does. **TAM must be typographically distinguishable from a checked number,
   always, with no hover required.**
4. **A competitor list that looks exhaustive.** It is the top-8-per-bucket survivors of five
   searches against a model-invented category. The data carries `searched_none_found` vs
   `not_searched` precisely so the difference is expressible — *"`searched_none_found` is a
   FINDING; `not_searched` is a HOLE."* **Drop that field and an empty competitor table reads as
   "no competition" — the exact founder claim this feature exists to contradict.**
5. **Treating two passing venture-scale gates as two confirmations.** At $1B in a concentrated
   market the gates coincide arithmetically — it is one gate reported twice, and the design says so
   explicitly.
6. **A trend arrow drawn on three news articles.** The floor is 3 events; at 1 prior / 2 recent the
   ratio is 2.0 and reads "improving". The scoring term was deliberately capped at ±4 because a
   swing of 8 on three articles over-weights a signal the spec itself calls thin. **The arrow
   carries no such self-limitation — put the event counts on the face of the component.**
7. **Styling `undetermined` as a fourth flavour of neutral.** It is the difference between "we
   assessed this as middling" and "we could not assess this". The guard fired in production on the
   very first real company.
8. **Showing the bare threat integer** — §2.5.
9. **An absent axis rendered as zero.** *Rendering a missing row as 0 inverts the invariant — it
   converts our honesty about ignorance into a penalty against the founder.*
10. **Averaging the axes**, under any label, including a sort key called "overall".

### 2.7 The components

#### (a) The market panel — at rest

1. **Category chip — marked as pre-research.** Dotted underline plus the literal label
   `inferred from application, not researched`. This is the least-defensible output in the feature
   and is currently positioned as the most confident. **Do not let a chip's visual solidity imply
   grounding it does not have.**
2. **The score-confidence pair — one indivisible object.** `50` set large, and immediately beneath
   it in the *same optical block* — not a separate column — `confidence 0.00` with a bar.
   **When confidence is below 0.2, the score numeral itself renders in an outline/ghost weight
   rather than solid.**

   This is the only mechanism that survives a screenshot, a demo-video frame, and a judge glancing
   for two seconds. A tooltip survives none of those.

   > **Layout rule that follows from this:** if a container is too narrow to show value and
   > confidence together, show **neither** — show the label instead. They must never be separated
   > across a layout boundary.
3. **Outlook** — the scale marker in (c).
4. **Trend — never a bare arrow.** `↑ improving · 6 recent vs 3 prior (90d)`. On a thin signal,
   replace the arrow entirely with `too few events to call (2 of 3 needed)`. Where most events were
   undated, show the arrow but append `· 8 undated events excluded`.

**Below, the TAM block — two gates side by side, never merged:**

```
Market size            Reachability
TAM  $1.2B – $2.8B     Implied exit  $24M
     PASS                            FAIL
     ─────────────────────────────────────
     same market, different answer — 2% of 500k+
     long-tail buyers is not 2% of 4,000 enterprises
```

That explanatory line is not decoration. The disagreement between the two gates is the single most
investor-legible idea the feature produces. Give it real estate.

**TAM numerals take a distinct type treatment from every other number on the page** — italic, or a
preceding `~`, plus a persistent `Forecast` label that needs no hover. Highest-leverage single
decision in this panel.

**On expand:** assumptions verbatim, ARPU basis, buyer count with its source URL, the scenarios
array showing what the founder's own 10% and 20% assumptions would imply beside our calibrated
share, per-number evidence rows with tier badges, and the honest-gaps list.

**Gaps render as content, not as empty state.** *A memo that states its gaps scores more trusted,
not less.* Same type size as findings. A greyed-out "no data" treatment inverts the whole thesis.

#### (b) The competition table

**Lead with the unnamed-competitor callout above the table** — the design calls it the highest-value
output verbatim: *"The most valuable output of competitive research is usually the competitors the
company did NOT mention."*

```
Found and not mentioned by the founder — 4
MEDITECH · Oracle Health · Epic · Microsoft Nuance DAX
```

**Columns at rest:** Name · Category · **Mentioned** · Threat · Switching · Sources(n).

- **"Mentioned" is a column, not a badge in a corner.** It is the axis the whole sub-workflow exists
  to compute.
- **Threat renders as a word, never the integer:** `Disruptive` / `Intercepting` / `Niche` /
  `Red ocean`. Row order carries rank; the label carries meaning.
- **A null threat or switching cost is a first-class value with its own glyph, not a blank cell.**
  An empty cell reads as an oversight; `— not assessable` reads as a decision.
- **Sources(n)** — one source and five sources must not look alike.
- **Bucket coverage renders as a footer under the table, always, even when the table is full:**
  `Adjacent: searched, none found · Build-vs-buy: found · Named-by-founder: not applicable`.

**Design for the 40% quote case explicitly.** Verbatim quotes are populated on only ~40% of
evidence rows — measured, and inconsistent even within a single run against the same source. But
the raw-signal link is now 100% present. So design **two legitimate states**:

- **quoted** → the sentence in a quotation treatment with source domain and tier badge
- **sourced only** → `source: fdic.gov · documented tier · open stored result →`

**The second must not look like a degraded first.** It is a different, still-honourable level of
traceability. This matters because "click any number, see the sentence" is a headline demo beat —
and if half the hovers come up empty, the trust affordance actively damages trust.

#### (c) Bull / neutral / bear without a traffic light

Semantic colour is forbidden by the brand and would be wrong here anyway: a green "bullish" chip
next to a green "verified" badge would claim a kinship that does not exist — one is a threshold on
a possibly-unmeasured score, the other is a checked fact.

**Use a positional scale marker, not a chip:**

```
bear        neutral        bullish
├─────────────●─────────────────────┤
              52
```

- Fixed track, always the same width, all three positions always named. The marker sits at the
  score's actual position, so *how* bullish is read from geometry rather than from a word. Adjacent
  cards become comparable at a glance — exactly what a ranked feed needs and what a chip cannot
  give.
- **`undetermined` is not a fourth position. It replaces the track:** a dashed empty rail, no
  marker, and the label `not assessed — no TAM established` where the number would be. The
  difference between "middling" and "could not assess" must be a difference in *component*, not in
  colour or copy.
- **Confidence modulates the marker, not the track:** high → solid dot; low → hollow ring; below
  0.2 → hollow ring on a dashed rail. A judge scrubbing the demo with the sound off should be able
  to tell a well-evidenced bull from a guessed one.

### 2.8 Three visual languages that must not be interchangeable

| | Question it answers | Form | Why that form |
|---|---|---|---|
| **Founder score** | *How good is this person?* Persistent, follows the human, never resets | **Numeric + ledger + history** | It accretes. Show accretion. |
| **Market outlook** | *What is this category doing?* | **Positional scale marker**, no history line | It is a position, not a trajectory. |
| **Trust** | *Is this specific sentence true?* | **Small inline glyph attached to a claim** | It attaches to text and must never float free of the sentence it judges. |

**Hard rule: a trust badge must never appear at card level.** The moment a company shows
"Trust: 72" as a headline number, the per-claim invariant is dead and the feature's central claim
with it.

### 2.9 Data realities the design must absorb

- **Trend exists only on the market axis.** The build writes null trend on idea-vs-market and on
  founder. **Do not draw a trend arrow on the other two.**
- **The founder axis was implemented and has never written a row.** The code path exists and is
  correct; it terminates before writing whenever no founder score resolves, which is currently
  always. Its *default* rendered state is "not assessed" with the reason surfaced.
- **Score rows can duplicate.** The scores table has no idempotency guard, and an HTTP retry was
  observed writing two identical rows 0.2s apart. **Dedupe history by run, or collapse points
  within the same second; never plot raw row count** — a sparkline would show an evaluation that
  never happened.
- **Nothing records "this run re-confirmed the same finding".** Re-running an application produces
  new competitor rows that look like new discoveries. A naive "what changed since last run" view
  would report every competitor as newly found every time. **Do not build that view.**
- **Three legacy evidence rows have no traceable source and cannot be repaired** (append-only).
  The UI needs a `source unavailable` state for them — not a crash, not a silent blank.
- **Nothing reads `verified` yet** database-wide. Verification status cannot be used as a ranking
  signal until the trust feature lands.

## 3. Trust and the evidence ledger

> **The governing principle for this whole section: this feature's product is not a score, it is a
> receipt.** Every competitor can show a confidence number. Almost none can show the arithmetic and
> click through to the exact row. **Design the receipt first; the number is a summary of it.**

### 3.0 Two decisions that override the obvious approach

**(a) Do not render trust as a percentage.** This is the biggest trap in the product and it took
live measurement to find.

The formula caps a single-source claim at 0.70 × base. Measured against the live corpus:

| Independent sources | Max trust at documented tier |
|---|---|
| 0 | 0.45 |
| **1** | **0.63** |
| 2 | 0.77 |
| 3+ | 0.90 |

**137 of 139 verified claims in the live database have exactly one independent source. The maximum
trust value anywhere in the corpus is 0.72.**

So a perfectly true, well-evidenced, documented, `verified` claim scores **0.63**. Render that as
"**63%**" and a non-technical investor reads *"the system is 63% sure this is true"* — which is
wrong in a way that **actively damages good founders**, and it hits the entire verified set, not an
edge case. It actually means "confirmed by one documented source".

**(b) Trust must not be a score-shaped chip.** Rendering it as a third circular gauge beside
Founder and Market invites exactly one reading — "the third thing we rate the company on" — and the
investor will average the three in their head. That is the sponsor's forbidden collapse, performed
by the user instead of by us. **Trust is a different kind of object and must look like one.**

### 3.1 What the trust layer actually is

Per-claim, never per-company. Every claim is assigned **exactly one class before any verdict model
runs** — the decision "this claim cannot honestly bear a verdict" is made by an auditable table, not
by a model.

| Class | Meaning | Can ever be `contradicted`? | Live count |
|---|---|---|---|
| `factual_static` | checkable against evidence already collected | yes | 267 |
| `factual_dynamic` | needs a live search, capped at 5 paid checks per card | yes | 30 |
| `qualitative` | judgement — provenance and confidence only | **no, structurally** | **424** |
| `forecast` | behaves exactly as qualitative; exists **only so the UI can label it "Forecast"** | **no** | 12 |
| `unverifiable` | no proxy exists → honest gap + a deep-dive question | **no** | 1 |
| `precomputed` | carries an upstream verdict | n/a | **0 — never fired live** |

**The number that should reshape the design: 424 of 734 claims — 58% — are judgement claims that
can never carry a verdict.** They are pinned to "not verified" by design. Without an explicit
explanation on screen, an investor sees a wall of grey and concludes the system failed. It did not.

**And: 555 of 734 claims (76%) read `unverified` today.** Any UI that styles `unverified` as a
warning is flagging three-quarters of every application.

### 3.2 The trust number is ours, not the model's — say so on screen

An explicit design ban: **models return discrete verdicts and verbatim quotes only. Every number in
this feature is computed from evidence structure** — tier, relation, independent-source count —
never from model certainty. The confidence column on model runs stays permanently null, and the
fixture honours it even on a deterministic run.

Why the ban exists: asking a model to rate its own certainty produces noise. Single-shot verbalised
confidence measured as the **worst-calibrated** method across 12 models and 4 prompt styles, and
systematically overconfident. The same reasoning drives running the contradiction detector twice
with **disagreement downgrading `contradicted` → `partially_supported`** — panel disagreement is
logged as signal, never averaged away.

```
base 0.90            ← strongest supporting evidence (documented tier)
× independence 0.70  ← 1 independent source
− contradictions 0.00
= trust 0.63
```

**Render that arithmetic literally in the explain panel, with every term clickable**, and put one
line of standing copy beneath it:

> **This number is computed from the evidence we hold. No AI model reports its own confidence
> anywhere in this system.**

That sentence is the single most differentiating thing on the screen, and it is the answer to
"so it's just the AI's opinion?"

### 3.3 The subtle rule a naive UI will get wrong

The verdict table is evaluated **top-down**, and row 2 pins every qualitative and forecast claim to
`unverified` **before the contradiction rows are ever reached**. So a documented-tier contradiction
on a judgement claim **never becomes a `contradicted` verdict**.

**But the trust number still drops 0.30**, because the penalty counts contradictions regardless of
class.

> **Suppressing the verdict on a judgement claim is correct; suppressing the finding is not.**

**Therefore the dashboard must read the contradiction EVENT set in addition to the verdict set**,
or the finding appears nowhere at all while the number silently moves. Contradictions on
qualitative claims surface as **deep-dive questions**, never as accusations.

Two related encoded rules: `discovered`-tier evidence caps at `partially_supported` and can never
produce `contradicted` — **including feature 04's mismatch**, which is deck-vs-search comparison,
not primary evidence. And a mixed-evidence claim (support *and* contradiction) reads
`partially_supported`, never flatly refuted — that row sits deliberately above the refutation row.

⚠️ **`partially_supported` has zero live instances.** The Conflicting state — the one the rubric
cares most about — exists only in code. Design it; do not build the demo around it.

### 3.4 The two guards worth showing off

**The entity gate.** Protects against the system finding a page about a *different company with a
similar name* and calling the founder a liar. Measured research put false-contradiction rates
**above 80%** when evidence context does not actually match the subject. So **no `contradicted`
verdict may be written until the evidence is proven to be about this entity**, by one of three
ordered deterministic methods: a foreign-key match, a registrable-domain match, or a model quote
that must name the company *and* a disambiguator. Supporting evidence is deliberately **not** gated
— corroborating the wrong entity is not the failure mode this prevents; mistakenly refuting one is.

A rejected candidate is **never silently dropped** — it becomes a queryable context row.

**UI reading:** *"We found something that looked like it contradicted this, but we could not prove
it was about this company, so we are not counting it against them."* It must not be shown as a
contradiction, must not move the number, must not appear in a risk section. It belongs in the
drill-down under **"Discarded — could not confirm this is about this company"**.
**Showing that the system rejected its own weak accusations is a stronger trust signal than any
badge.**

**Quote guard.** Detects fabrication signatures in citations: `"90 days"` → `"30 days"`,
`"$2,000,000"` → `"$5,000,000"`, a flipped negation. Fuzzy citation matching waves all of these
through at 0.93–0.99 similarity because it scores the best-aligning window. A salient token present
in the quote but unsupported by the source is a **positive fabrication signature, not a mere
non-match** — categorically different from "the world disagrees with this claim", and it deserves
its own badge showing **both strings side by side**, because that comparison *is* the evidence.

⚠️ **It does not run yet.** The call site is unwired. **Do not ship UI implying this check ran** —
not in the interface, not in the memo, not in the video.

### 3.5 What would misrepresent trust

1. **A single clean trust percentage.** Explicitly banned and binding: *a single Trust percentage
   that hides disagreement is not stronger for being cleaner.* Wherever the value appears it must
   carry counts of contradicted, conflicting and not-disclosed claims, plus coverage.
2. **Rendering trust as a percentage of truth** — §3.0(a). Hits the entire verified set.
3. **Treating `unverified` as refuted.** This is the feature's named primary risk, with numbers: on
   a human-evaluated benchmark, of claims humans labelled *Not Enough Evidence*, systems answered
   **"Refuted" 60.3% of the time**; on the following year's task **no system scored above 0.1** on
   the Not-Enough-Evidence or Conflicting categories. Any red styling or risk-section inclusion for
   `unverified` reproduces that failure at the UI layer after the backend structurally prevented
   it — **on 76% of all claims**.
4. **Treating a forecast as a failed verification.** TAM emerges as unverified *by construction*.
   Optimistic TAM is expected noise at pre-seed, not a punishable lie. **A UI without the Forecast
   label actively penalises normal founder behaviour.**
5. **Reading the stored status column instead of `derived_status`.** **Measured: 143 of 734 claims
   (19.5%) read differently today** — 139 claims are verified in the view but still unverified in
   the table, and **all 4 contradicted claims read unverified in the table.** A UI reading the
   stored column shows **zero contradictions and zero verified claims.** It is the most natural
   mistake available (the stored column has the obvious name) and it silently produces a completely
   different product.
6. **High trust over tiny coverage.** The value is a mean over *assessed* claims only, so gaps never
   drag it down — deliberate. Consequence: one checked claim that verified cleanly shows ≈63 at
   coverage ≈0.02. **Sorting a deal list by trust value alone systematically ranks the
   least-investigated companies at the top.**
7. **Rendering an absent trust row as 0.** Below the coverage floor **no row is written at all** and
   an event is emitted instead. A 0% trust badge on a company we simply did not investigate is the
   worst single output this system could produce.
8. **Losing the qualitative contradiction** — §3.3.
9. **Penalising invisibility.** Evidence absent → confidence down, **value untouched**. Only a
   confirmed primary-source contradiction moves the value. The justification is one-sided label
   noise: in venture data, observed successes are reliable but observed "failures" usually mean "no
   exit yet", so naive models systematically penalise stealth and delayed-exit companies. **For a
   system built to find founders before the market sees them, penalising invisibility would reject
   exactly the outliers we exist to catch.**
10. **Showing an entity-gate rejection as a contradiction** — that is the defamation the gate exists
    to prevent.
11. **Implying checks ran that did not.** Three measured gaps: quote guard is unwired; the GitHub
    provenance check returns `insufficient_data` on **every live claim** because the corpus holds no
    commit-level signal; the precomputed class has never fired. **Listing these as active checks is
    fabricating at the interface layer the exact thing the feature exists to prevent.**
12. **Presenting one accuracy number.** The metric is deliberately **two** numbers — helpful fixes
    and harmful flips, instrumented separately. Always-on verification measured **2.2% harmful
    flips** and a 4.17-point accuracy drop on a standard benchmark. *A build that raises helpful
    fixes while also raising harmful flips is not an improvement.* One blended number hides exactly
    the failure that matters.

### 3.6 The components

#### (a) Claim-level trust — a decomposed meter, not a number

```
VERIFIED  ●●○○  1 independent source · documented
```

A four-pip meter driven by the arithmetic, not invented: pip 1 = has any support · pip 2 =
documented/discovered tier · pip 3 = ≥1 independent source · pip 4 = ≥2 independent sources. **The
raw decimal appears only inside the explain panel, next to the equation that produced it.** This
preserves the honest ordering the formula gives while refusing the false precision a percentage
implies.

#### (b) The badge system — three orthogonal families, not nine colours on one scale

**Family A — verdict** (primary, solid):

| Badge | Tone | Live count |
|---|---|---|
| `VERIFIED` | positive, restrained | 139 |
| `CONTRADICTED` | serious, **not alarm** | 4 |
| `CONFLICTING EVIDENCE` | attention | 0 (code only) |
| `NOT VERIFIED` | **neutral grey, same weight as body text** | 555 |
| `NOT DISCLOSED` | neutral, informational | 36 |

**Family B — class qualifier** (outline pill, only when it changes the reading):

- **`Forecast`** — replaces the verdict badge entirely for TAM claims. A TAM shows `FORECAST` and
  **no verdict at all**.
- **`Judgement — not verifiable`** — covers the 424 qualitative claims. Copy must own it:
  *"We do not verify judgement claims. Here is the evidence behind it and where it came from."*
- **`Not disclosed`** — for declared gaps.

**Family C — provenance tier** (small, quiet, always present), each with its plain-language gloss:
documented = "primary record — filing, commit, direct inspection" · discovered = "third-party
observation" · inferred = "self-reported" · missing = "we looked, nothing found".

**Every badge is click-through to its audit row.** That is the rubric's top stretch goal and it is a
one-line requirement with outsized payoff.

#### (c) The evidence ledger

One row per evidence row, grouped by claim. Columns: relation · quote (verbatim, never paraphrased)
· source host with link-out · kind (friendly name) · tier pip · **independent?** · checked-at.

**The "independent?" column does more anti-hype work than any badge**: deck and interview sources
render an explicit *"self-reported — does not count toward independence"*.

Sort contradictions first, then supports by tier, then context rows.

**Design the empty state first.** 103 of 672 evidence rows have no quote at all — that is the norm
for the searched-nothing-found category, not a degradation.

#### (d) The explain panel — four stacked sections

1. **The arithmetic, rendered literally** (§3.2), every term clickable, constants read from config
   so it can never drift from the view.
2. **Why this verdict** — the rule that fired, in plain language. It is a fixed table of eight
   branches; write eight strings and ship them. *"Pinned to Not Verified: this is a judgement
   claim, and we do not issue verdicts on judgement."*
3. **The evidence ledger**, scoped to this claim.
4. **Audit trail** — checked-at, which check, run id, verdict before → after. This is the demo line:
   *click any number, see the exact source and when we checked it.*

#### (e) Card-level trust — a segmented evidence bar, never a gauge

```
TRUST   ████████░░░░▓▒  63%  ·  coverage 64% (189 of 297 checkable claims)
        139 verified · 4 contradicted · 0 conflicting · 36 not disclosed
```

**The segments *are* the disagreement breakdown the binding rule requires** — so the mandatory
context is structural, not a caption someone can delete. The percentage lives inside the bar's
context, never alone, **never sortable on its own**.

At rest: bar, percentage, coverage, four counts. On hover: segment tooltip with topics. On click:
the claim list filtered to that segment.

⚠️ Coverage is **persisted inside the score's flags**, not recomputed — the score row is a snapshot
while the view is live, so a consumer that recomputes will drift from the number sitting next to it.
**Read it, do not recompute it.** Also: duplicate rollup rows are accepted by design; **"current"
resolves by latest computed-at** or the UI will occasionally render a stale duplicate.

#### (f) `NoResultRecord` — "we searched and found nothing"

The operator singled this out and the data justifies it: **103 evidence rows across 101 claims, the
third-largest evidence category in the database.** It is the visible proof that the system knows
the difference between *checked and empty* and *never checked*.

```
┌─────────────────────────────────────────────────────────────┐
│ ⃝  We looked and found nothing                              │
│                                                              │
│    Checked  GitHub API · github.com/ayuhito/safehttp        │
│    When     19 Jul 2026, 14:22                              │
│    Looking for   commit history predating the Show HN post  │
│    Result   no commit-level data available                  │
│                                                              │
│    This does not count against the founder.        [details] │
└─────────────────────────────────────────────────────────────┘
```

- **Neutral iconography — an open circle. Never a warning triangle, never red.**
- **The trailing line is required copy, not decoration.** It converts a scary-looking absence into a
  trust signal.
- **The quote field is null on 100% of these rows.** Absent is the only state — do not design a
  layout that degrades without it.
- **Aggregate variant is mandatory:** 74 of the 103 sit on one topic. At card level collapse to
  *"Provenance: checked 74 claims across GitHub, no commit history available."* Ninety-six identical
  cards is noise, not transparency.
- ⚠️ **Dependency to state plainly to the designer:** the event that carries "what we were looking
  for" **has zero rows today** — its writer is unshipped. Design the full component against the
  event payload; ship a reduced two-line variant (source + date) if it slips.

#### (g) Three more named components

**`NotAssessedPanel`** — replaces the trust bar entirely when coverage is below the floor. Reads the
insufficient-evidence event and says: *"Not enough evidence to score trust. We could check 12 of 60
checkable claims (20%), below our 25% threshold."* **Never a 0%.**

**`JudgementNotice`** — one card-level banner covering the 58%:

> 58% of the claims on this company are judgements — how the founder writes, what they know, how
> they lead. We show the evidence behind them and where it came from, but we do not issue verdicts
> on judgement. That is a deliberate limit, not a gap.

**Without this banner the dashboard reads as 58% failure. With it, it reads as the most honest tool
on the table.**

**`DiscardedFindings`** — collapsed, drill-down only. *"1 possible contradiction discarded: we could
not confirm the source was about this company."*

### 3.7 State of the data — what is populated today

- **Zero trust rollup rows exist.** The rollup runner is unshipped. Every card-level trust number is
  currently unpopulated.
- **Zero `claim_verification_attempted` events.** See (f).
- **Zero `partially_supported` claims.**
- **Zero `precomputed` claims** — feature 04's mismatch has never fired.
- Live verdicts: 139 verified · 555 unverified · 36 not disclosed · **4 contradicted**.
- The one live contradiction event is the fixture's.

**Design implication:** the demo's trust story rests on the per-claim ledger and the four real
contradictions, not on a card-level rollup number. Build the ledger first.

## 4. Thesis fit — a ledger of rules, not a score

### 4.1 What it is, and why it must sit apart from the three axes

> *"Of the things this fund said it cares about, how many does this company demonstrably satisfy?"*

It is a **mandate-alignment measure, not a quality judgement**, 0–100, and it is the one fully
deterministic number in the product — the evaluator is a pure function with no database access.

**The distinction that must drive the layout:** Founder, Market and Idea-vs-Market are claims about
*the company*. Thesis fit is a claim about *the fit between this company and this fund's stated
mandate*. **It changes when the fund edits its thesis, without anything about the company
changing.** Two different funds get two different numbers for the same startup.

**Therefore: never render it in the same visual group as the three axes.** It belongs in the lane
structure of the feed and in its own panel on the card — not as a fourth bar.

### 4.2 The config, and which fields do nothing

Full shape is in [`data-contracts.md`](data-contracts.md) §7. What matters for the form:

**Inert — stored, but nothing reads them:** `check_size_usd` · `ownership_target_pct` ·
**`risk_appetite`** · `schema_version`.

⚠️ `risk_appetite` is the one most likely to be missed — it looks like a scoring input and is not.
It needs the same *Recorded, not yet applied to scoring* label as the other two.

**`geos` is NOT inert** and must not be labelled as such: it does nothing for the thesis rules, but
it is read at runtime by market research to build search queries. Label it
*Used by market research to build search queries.*

**`exceptional_lane` is inert in the backend** — it is a **UI-only lane spec**, and it depends on
founder scores existing. Until enough founders are scored, the lane renders empty. That is expected,
not broken.

### 4.3 The rule model — three kinds, and the outcome that matters most

| Kind | On match | On no-match | When any referenced field is unknown |
|---|---|---|---|
| `focus` | `satisfied`, adds weight to earned **and** total | `missed`, adds to total only | `unknown`, adds to total only |
| `must_have` | `satisfied`, adds to both | `missed`; **forces `failed` if hard** | `unknown`, adds to total only |
| `deal_breaker` | `triggered`; **forces `failed` if hard** | `satisfied`, no effect | `unknown`, **no effect** |

Deal-breaker weights never enter earned or total — a fix for an earlier bug where a *non-triggered*
deal-breaker actually raised the fit.

**The headline guarantee, and the best sentence to put on the screen:**

> **A hard rule fires only on a confirmed match. An unextracted field can never cause a rejection.**

A rule is `unknown` when its field is absent, null, listed as missing, **or backed only by a
contradicted claim**. Sentinel values count as unknown — a business model literally classified
"unknown" is not an observation. But `sector: 'other'` is **deliberately not** a sentinel: it is a
real determination carrying a quote, so it yields a genuine no-match.

```
fit      = total > 0 ? clamp(100 × earned/total − penalty, 0, 100) : base
coverage = total > 0 ? evaluated / total : 1.0        # NULL in keyword mode
```

### 4.4 What would misrepresent thesis fit

1. **Reading the score table directly returns stale numbers** — reproduced twice in QA. Always
   resolve through the evaluations table. Full procedure in `data-contracts.md` §6.
2. **A low fit reading as "bad company."** It means *outside this fund's stated mandate*. The lane
   label is **"Outside thesis," never "rejected."**
3. **Building a prominent "Rejected" counter.** `failed` is **rare by construction** — every
   compiled mandate rule is soft, so only a hand-authored hard rule rejects, and the seeded thesis
   has exactly one. The design says so explicitly *so nobody discovers at demo time that the
   gated-out count is approximately zero.* Do not put a big number on a screen that will read `0`.
4. **Rendering writer-internal keys as gaps** — read the nested `missing_fields` array; never render
   an underscore-prefixed key. A consumer enumerating the object *would show an investor a hash as a
   missing data point.*
5. **Implying reproducibility** — the same application run twice produced `borderline` (coverage
   0.81) and `failed` (coverage 1.00), because the sector classified differently.
6. **`outcome: "unknown"` shown as a pass or a miss.**
7. **An absent founder score reading as a low one** in the exceptional lane.

### 4.5 The component — a ledger grouped by outcome

```
WHY THIS FIT — 68.75  ·  coverage 100%  ·  ▦ Rule

TRIGGERED   ⛔ Excluded sector: gambling        deal-breaker · hard
                expected one of [gambling, adtech] — observed "gambling"
MISSED      ○  EU or US                        focus · soft · weight 20
                expected one of [EU, US] — observed "APAC"
SATISFIED   ●  B2B focus                       focus · soft · weight 25 → +25
                expected "b2b" — observed "b2b"
COULD NOT CHECK
            ◌  Stage is pre-seed or seed       focus · soft · weight 20
                stage_evidence was not found in the submitted material
```

- **Four outcome groups, never three.** `unknown` is a first-class row with its own glyph and its
  copy is **"could not check", never "did not match".** This is the highest-value line on the panel
  and the one a generated UI will collapse into "missed" if not told otherwise.
- **Show `expected` vs `observed` on every row, including satisfied ones.** It is what makes the
  number auditable at a glance and it costs one line.
- **Show the weight actually applied, not the nominal weight.** Deal-breakers are always weight 0
  by construction — render them as a flag, never as a weight bar.
- **Coverage sits next to the fit number, never elsewhere.**
- **When the verdict is `insufficient_evidence`, suppress the number entirely** and lead with the
  gaps: *"Not assessable against this thesis — we could check 31% of it. Missing: business_model,
  sector."* The rules panel still renders below, every row `unknown`. **Never a 0.**
- **When the evaluation ran in keyword mode, say so:** *"Screened on keywords only — no deck was
  read. This can rule a company out, never in."* Otherwise a `borderline` with a null fit looks
  broken rather than deliberate.

### 4.6 The config form

1. **Group by what actually does something.** An *Applied to scoring* section (sectors,
   geographies, stages, keywords, rules, fit tuning) and a visually demoted *Recorded only* block
   (check size, ownership target, risk appetite). Put `geos` in the applied group with its own
   sublabel.
2. **Show the compiled rule preview live** — a read-only panel under the mandate section:
   *"Your mandate compiles to 5 soft rules: M_sector (w20), M_geography (w20), M_stage (w20),
   M_poskw (w20), M_negkw (deal-breaker, w0). Total weight: 105."*
   This is the killer affordance: it makes the mandate weight legible, makes rule emission visible
   (clear a keyword list, watch a rule disappear), and makes the denominator of every fit number
   inspectable. Without it, the fit-tuning fields are numbers with no visible effect.
3. **Make `hard` expensive to select.** Enforcement defaults to soft; choosing hard reveals a
   **required** radio (`Legally or contractually excluded` / `Fraud or misrepresentation`) plus one
   line of consequence copy: *"A hard rule auto-rejects. It fires only when the attribute was
   actually observed; an unread deck can never trigger it."*
   **Disable `hard` entirely on focus rules** — the combination is illegal and the database will
   reject it.
4. **The button says `Publish new version`, never `Save`**, and shows the version it will create.
   A plain Save invites the raw-insert path, which is a guaranteed constraint violation.
5. **Guard weights client-side.** QA found the database validator does not type- or range-check
   weights on focus and must-have rules — it accepts `'thirty'`, `-50`, and arrays.

---

## 5. Obscurity and the radar

### 5.1 Obscurity is a fact, not a score

The header comment on the view sets the frame: obscurity is *an observable fact derived from
observations, never a score.* **It is written to no scoring axis at all.**

```
followers_term = 1 − clamp(log10(1 + gh_followers) / 3, 0, 1)   # 999+ followers → 0
karma_term     = 1 − clamp(log10(1 + hn_karma)     / 4, 0, 1)   # 9999+ karma    → 0
obscurity      = mean(OBSERVED terms only)
```

**Exactly two inputs**, guarded by a test. Followers-of-note, post points and comment counts are
visible in the view and contribute **nothing** — that is the "obscurity is never folded into founder
quality" invariant enforced structurally rather than by convention.

**`obscurity_basis` has exactly four values:** both terms · followers only · karma only · NULL.
Its stated purpose is so **the dashboard can show that a one-term value is weaker evidence than a
two-term one.** Render it — it is the cheapest honesty win in the whole feature and the data is
already there.

**The NULL-vs-zero rule, stated identically in three separate files:**

> **Absolutely forbidden: zero-substituting a missing input.** Substituting 0 computes obscurity
> ≈ 1.0 ("maximally undiscovered"), floating exactly the founders with the least data to the top of
> the feed. **Absence must shrink the term count the mean is taken over, never contribute a value
> to it.**

### 5.2 ⚠️ A live defect the design must work around

The SQL and the JavaScript disagree about negative karma, and the SQL is what production reads.

A floor was added to the view (`log(1 + GREATEST(hn_karma, 0))`) because one real founder has
`hn_karma = -2` and the unguarded logarithm **aborted any query that materialised the column** —
which plain row counts did not catch, because the planner prunes unused columns.

But the floor changed the meaning. The library treats negative karma as **unobserved** (term
omitted → unknown). The view treats it as **observed and maximally obscure** (→ 1.0).

**So a downvoted HN user currently renders at the very top of an obscurity-sorted feed.** This is
the exact failure the NULL-vs-zero rule exists to prevent, re-entered through a different door.

**Defend against it in the UI until it is reconciled:** treat `obscurity >= 0.99` with a
karma-only basis as suspicious and render the basis chip prominently. A perfect 1.0 from a single
karma term is more likely a downvoted account than a discovery.

### 5.3 What would misrepresent the radar

1. **Obscurity read as low quality.** It is the opposite — the entire thesis is finding people
   before conventional databases do. **Design it as a proud column, not a warning.**
2. **NULL obscurity sorted first.** *A founder with no data must not outrank one with data.*
   **NULL sorts LAST under every sort direction** — this needs an explicit comparator rule, because
   naive ascending sorts put nulls first and that is precisely the forbidden inversion.
3. **Obscurity as the default sort.** The database already refuses this and documents why: inbound
   founders have no radar fields, so an obscurity-first sort floats them up as "maximally
   undiscovered". Make it an opt-in sort with a one-line explainer.
4. **A GitHub-sourced candidate looking "verified."** GitHub here runs **unauthenticated at 60
   requests/hour**, resolves for only ~36% of candidates, and its evidence is forced to the weakest
   tier below 0.85 identity confidence. **A source badge means "this signal came from GitHub", not
   "this person is confirmed."**
5. **Merging source provenance with evidence quality.** A candidate can be `github_api` **and**
   `inferred` at the same time. Two orthogonal facts, two separate visual treatments.
6. **A failed crawl reading as "the project is dead."** It must be classified as *could not
   verify* — *a false red flag on a founder is more costly than a missed signal.*
7. **Absence of public code as a negative fact.** It is absent data: gap recorded, confidence down,
   score untouched.
8. **`freshness` labelled as activity.** It is **first-seen, not last-active** — there is no
   last-activity data anywhere in the view. Copy it as `first seen 4d ago`. Writing "active 4d ago"
   would be a fabrication.
9. **Stars and forks as achievement.** Stored, flagged as vanity, never weighted.

### 5.4 Identity resolution — and the state that is 64% of the corpus

Five tiers, **zero fuzzy matching by mandate** — only exact equality or structural facts:
handle match (0.95) · site backlink (0.95) · blog-domain match (0.90) · Show HN declared artifact
(0.85) · org-owned (0.60, needs review) · unresolved (null).

**Exact handle match is a minority event — 39%.** The Show HN tier is load-bearing: it converts the
61% where handles differ into 0.85 confidence without a single fuzzy comparison, justified by
platform rule rather than inference (Show HN's guidelines require the submitter to be the maker).

**Critical for copy: "unresolved" ≠ "no person."** It means *no cross-platform link*, never "no
person", and it never blocks a founder record. **~64% of candidates end unresolved — the normal
branch, not an error.**

Render three states, and make the third neutral:
`linked via GitHub (0.95)` · `linked via Show HN declaration (0.85)` · **`HN-only`**.

**Copy the third as `HN-only`, never `unverified`.** It applies to two-thirds of the corpus.

### 5.5 The radar row

```
▸  ada-lovelace                              obscurity ▦ 0.88  ██████████░░
   safehttp · "Show HN: SafeHTTP — a Go HTTP client…"      basis: karma only
   ⚑ hn_algolia   first seen 4d ago   identity: HN-only (no cross-platform link)
```

Obscurity gets **a bar, a number, and a basis chip — all three**. Two-term and one-term bases render
at visibly different weights (filled vs hairline chip), not as a tooltip.

### 5.6 Channels

**Two separate facts that must not merge:** *where it came from* (the channel badge, factual, click
through to the raw signal) and *how good the evidence is* (the tier badge). If the badge design
makes GitHub rows look authoritative, the two have been merged.

Live: Hacker News (the universal spine — the author handle always exists, and their own replies in
their own thread are described as *a direct proxy for coachability that VCs normally only observe
on a live call*) and GitHub (demoted from gate to optional enrichment).

**Not connected:** LinkedIn, X, Product Hunt, patents, accelerators. The research behind each
refusal is real, so the panels are informative rather than decorative.

Three additions to the locked-channel panel spec in the brief:

- **Locked channels use a different glyph, not a greyed version of the live one.** Greyed reads as
  "temporarily unavailable".
- **The sidebar states the ratio inline** — `SOURCE CHANNELS · 2 live, 3 documented` — so nobody has
  to hover to learn it.
- **Never show a locked channel with a candidate count, not even `0`.** Zero implies "connected and
  empty".

**Deliberately absent: velocity and momentum.** *With a single scan there is one snapshot per
metric; a derivative over n=1 is noise dressed as insight.* Do not design a momentum arrow for the
radar.

---

## 6. NL-search — the parsed plan is the product

### 6.1 The acceptance criterion, which is also the design brief

The sponsor's benchmark query is *"technical founder, Berlin, AI infra, enterprise traction, no
prior VC backing, top-tier accelerator."* Of its six fragments, **three resolve and three do not** —
there is no funding topic, no accelerator topic, and no testable traction field in the corpus.

The feature's own acceptance criterion is the sharpest sentence in the project:

> **The benchmark query returning no rows is a bug; the benchmark query returning confident rows is
> a worse bug.**

**Consequence for the demo: show two queries.** One corpus-fitted query carries the "it works"
story; the benchmark query carries the honesty story. Both are needed and the second is the one that
scores on the Trust criterion.

### 6.2 The five states — the only fully-built "we looked and found nothing"

| State | Rank effect | Confidence effect |
|---|---|---|
| `matched` | + weight × tier credit | raises assessed |
| `matched_broadened` | + weight × credit × 0.75 | raises assessed |
| `mismatch` | 0 | raises assessed |
| `unknown` — never looked | **0, genuinely free** | lowers confidence only |
| `unknown_searched` — **looked, found nothing** | **0, identical** | lowers confidence only |

Missing data is **neutral, never a penalty, never an exclusion**. An earlier revision divided by
total weight instead of assessed weight, which made *"we have no data"* and *"he demonstrably
fails"* rank identically. Regression tests now lock the gap: one match + two unknown scores **100**;
one match + two mismatch scores **≈38.5**.

**Nothing is ever excluded by a mismatch** — *it cannot silently hide a founder.*

### 6.3 Three different fates for "the system didn't understand that"

They feel identical to the user and only one is recoverable.

| Fate | Trigger | What the user sees |
|---|---|---|
| **A** — listed as unresolvable | the resolver declines to map a fragment | search proceeds; the fragment costs nothing |
| **B** — promoted to unresolvable | a negative attribute whose target family has zero rows corpus-wide | same as A, decided deterministically |
| **C** — **whole-plan rejection** | the resolver mapped a fragment to something outside the taxonomy | **blank screen, not retryable, no partial results** |

Fate C exists deliberately: a mis-mapped attribute is *a stronger signal that the resolver
mis-fired* than an unmapped one, so the whole plan is rejected rather than one attribute silently
dropped.

**Do not render Fate C as a generic failure.** Copy it as:
*"The search couldn't be interpreted safely, so nothing was run rather than running the wrong
search."* Keep the original query on screen and editable.

### 6.4 What would misrepresent a search

1. **Silently dropping an unparsed constraint.** *Silent dropping is how a search quietly answers a
   different question than the one asked.* With half the benchmark's attributes failing, hiding the
   unresolvable list answers a materially different question — and looks more confident for it.
2. **Rendering `matched_broadened` as `matched`.** A Munich founder returned as a "Berlin" match is
   scope drift. The 0.75 credit multiplier exists so the widening *costs something in the ranking,
   not only in the label.*
3. **Rendering `unknown` like `mismatch`.**
4. **Collapsing `unknown` and `unknown_searched`.** The second is the product.
5. **Reading `total` as "founders in the world matching."** It means *candidates scored.*
6. **Confidence inflation via citation count** — *five citations are not five independent sources.*
7. **Rendering a null rank as 0.** Null means nothing was assessed.

### 6.5 The components

**Search box:** one wide field, the benchmark query as placeholder, **no filter chips, no advanced
drawer, no dropdowns.** One-pass resolution *is* the requirement being demonstrated; visible filter
UI undercuts the claim it exists to make.

**The parsed plan — render it above the results, always, even on zero hits:**

```
Understood:   ● technical founder → founder.expertise.*
              ◐ Berlin → company.geography_country = DE          ⓘ widened: city → country
              ● AI infra → company.sector = ai-infra
Not searched: ○ enterprise traction        no way to test this
              ○ no prior VC backing        no data source
              ○ top-tier accelerator       no data source
```

- **`matched_broadened` gets its own glyph and its own inline explanation**, using the stored
  `resolved_as` string verbatim. It is guaranteed present whenever broadening is set. Two words of
  UI that close a scope-drift hole the backend spent a whole revision on.
- **Unresolved chips are muted but never hidden — and, correcting the earlier draft of the build
  brief, never removable.** Only *understood* chips are removable. Removing an already-unresolved
  chip does nothing and teaches the user the wrong model.
- **Show the human-readable reason, not the enum:** `no_data_source` → *we hold no data of this
  kind*; `not_testable` → *no way to test this against what we hold*.

**Result list:**

- **Two tiers, never interleaved:** ranked items, then a labelled low-confidence section with a
  header explaining the floor — *"Below the confidence floor — too little assessed to rank fairly.
  Shown, not dropped."* Dropping them would hide exactly the sparse-footprint cold-start founder
  the product exists to find.
- **Per row, show coverage BEFORE rank.** The sort is bucket-first, so a row showing only the rank
  will appear mis-sorted (92.5 above 100) and read as a bug. Lead with `assessed 3 of 4 attributes`.
  This makes the ordering self-explanatory from the returned data — the exact property the bucket
  field was added to guarantee.

  > The bucket-first ordering was found by simulating against the live corpus, not by review: three
  > adversarial review rounds missed it. Rank alone is *match rate among what we could assess*, so
  > a founder assessed on one attribute that matched scores **100**, while the one founder
  > satisfying all four benchmark attributes scores **92.5**. Rank-first puts the people we know
  > least about at the head.

- ⚠️ **Sort the bucket ordinal, never the bucket string.** Alphabetically `'high' < 'low' < 'mid'`,
  so a naive descending string sort yields mid → low → high — *the exact inversion of intent,
  silently, on a list that still looks plausible.*
- **Expand in place** shows the per-attribute ledger with the verbatim quote and a real outbound
  link per matched attribute. Negative attributes carry claim ids and no quote — the proof is *"we
  investigated this area"*, not a quotation, so the copy differs.

---

## 7. The applications list — one feed, not two screens

The operator asked whether an applications list exists. It does as a table; it should **not** as a
separate screen.

**Radar candidates and applications are not two populations.** Every radar candidate already has an
application row, created up front before the thesis gate even runs. They are one population with a
`kind` column, viewed at two grains: the radar view is founder-grain and carries obscurity, channel
and first-seen; the applications view is application-grain and carries the axes, thesis state and
memo availability.

**Build one feed. Four reasons, strongest first:**

1. **The sponsor already ruled on it.** *Covering both tracks with separate mechanics is not
   necessary — scoring covers both.* Two screens spend UI budget on the one thing the sponsor
   explicitly said not to build twice, in a rubric where UX is 15% and data plus reasoning is 55%.
2. **The data model already merged them**, deliberately. A separate inbound screen re-splits at the
   UI layer what the schema unified, using a predicate (`kind='inbound'`) that means nothing to the
   investor. Their question is *"which five of these forty do I open?"* — and that does not partition
   by acquisition channel.
3. **Two screens make the product's best story invisible.** The strongest beat in this build is a
   founder discovered by the radar who never applied, has no deck, appears in no startup database —
   and was **scored by the same pipeline an inbound applicant goes through**, traceable end to end
   from score to claims to evidence to raw signals. That story only lands if the outbound-sourced
   founder appears *in the same ranked list, judged by the same machinery*. Separate screens
   architecturally assert they are different kinds of thing, which is the opposite of the claim.
4. **Separate screens invite a fabricated pipeline.** A dedicated applications screen implies a
   kanban across sourced → screening → diligence → decision. **Four of those six statuses are never
   written by anything.** You would be rendering a pipeline that cannot advance.

**Concretely:**

- **One route.** Source is a **filter** (`All · Inbound · Radar`), defaulting to All — not three
  sidebar destinations.
- **Watchlist stays a separate route**, because it is a genuinely different table with different
  semantics (alert conditions, next-check timing), not a filtered view of the same rows.
- **Every row carries a source badge regardless of the active filter**, so provenance never depends
  on which filter is on.
- **Columns adapt, rows do not split.** Obscurity and first-seen are meaningful for radar rows and
  null for inbound; deck and memo availability are the reverse. Render the union with honest empty
  states rather than two row components.
- **The thesis lens is the primary sort, not the source.** Lanes cut across both kinds — that is
  the point.
- **Do not render status as a pipeline.** Only two of six statuses ever occur. Show it as a quiet
  chip, or omit it from the feed entirely and surface it on the card. A four-stage progress
  indicator where nothing reaches stage three is exactly what a judge will click.
- **`kind` needs one line of copy**, because "radar" is not self-explanatory:
  **`Found by outbound scanning — this founder has not applied.`** That single sentence is the
  differentiator the challenge is scored on, and it belongs in the UI rather than only in the pitch.
