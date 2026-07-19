# Claude Design brief — Investor Dashboard (feature 09)

> **How this differs from [`lovable-brief.md`](lovable-brief.md).** That file is a build
> instruction: routes, frozen API contracts, acceptance criteria. This one is a **design** brief —
> it describes what the screens look like and why, in the language a visual tool works in. Use this
> in Claude Design; use the other when the design comes back and gets wired.
>
> **Feed it in order.** Prompt 1 establishes the world and the visual system. Prompts 2–6 are one
> screen each. Do not paste them all at once — the visual system in prompt 1 has to land first or
> every screen after it drifts.
>
> Design rationale for every decision below is in [`scoring-ux.md`](scoring-ux.md). If Claude
> Design pushes back on something, that file has the reason.

---

## Prompt 1 — the world, and the one idea everything hangs on

```
Design the investor-facing screens of "The VC Brain" — an operating system for a
venture fund that decides a $100,000 pre-seed investment within 24 hours.

THE USER. An investment manager at a small fund. Not technical. Opens this at 9am
with forty new companies waiting and thirty minutes before their first founder
call. They have been burned by tools that show a confident number with nothing
behind it, so their default posture toward any score is suspicion. Their two jobs
are: drop the non-viable fast, then walk into a call knowing exactly where to dig.

THE ONE IDEA. Every other product in this category renders one number with
authority. This one's entire claim is that it knows what it doesn't know. So the
design problem is not "make the numbers look trustworthy." It is:

    make ignorance legible without making it look like failure.

Every screen must answer three questions about every number, without being asked:
what produced it, what evidence is under it, and what we still don't know. A number
that can't answer all three doesn't get rendered as a number.

VISUAL LANGUAGE. Notion's approachability with a financial terminal's density.
Calm, information-dense, printed rather than app-like. Borders, never shadows.
Hairlines, generous whitespace between groups, tight within them. A serious
document you can scan, not a dashboard that performs.

Explicitly avoid: hero sections, marketing copy, gradients, glassmorphism, emoji,
illustrations, stock photography, animated blobs, confetti, card shadows, circular
gauges, pie charts, progress rings, and any "AI is thinking" animation.

PALETTE — this is the sponsor's brand, do not re-theme it:
  page          #FFFFFF   clean white
  panel         #F1EEE8   warm light grey
  panel alt     #ECE7F7   pale lavender
  hairline      #E4E0D6
  text          #0A0F3C   deep midnight navy
  muted text    #5B6079
  accent        #0A0F3C   navy — primary buttons are SQUARED, never pill
  secondary     #D3C7F5   lavender
  confirm       #15803D   used sparingly, confirmations only

Type: Inter. Body 15px/1.6. Labels 13px medium. Page titles 36px weight 500 at
-0.02em. Every number, score and badge in a monospace face with tabular figures so
columns align down a list of forty rows.

Signature element: a 2px navy rule as the divider between sections. It is the brand
device; use it as the primary section separator throughout.

Light theme only. Desktop only — design at 1440x900, must not break at 1280.

NO SEMANTIC COLOUR. There is no red/amber/green anywhere in this product, and this
is a deliberate position, not an oversight. Nothing here is "good" or "bad" — the
states are epistemic: supported, refuted, conflicting, unknown. Refuted is not red.
A founder we know nothing about is not a warning. Encode difference through shape,
fill, weight and hatching — never through alarm colour.

Start by designing the shell: a 240px left sidebar and a content area, plus the two
primitives every screen reuses — the provenance chip and the explain panel, both
described next.
```

---

## Prompt 2 — the two primitives

```
Two components appear on every screen. Design these before any screen.

── PRIMITIVE 1: THE PROVENANCE CHIP ──

Every number in this product carries exactly one chip saying how it was made. This
is the visual backbone of the whole design.

  ▦     RULE                  A published formula computed it from stored inputs.
                              Reproducible. Identical every run. No model involved
                              in the arithmetic.

  ▦◇    RULE ON MODEL INPUT   A deterministic formula, but at least one input was
                              extracted or judged by a language model. The
                              arithmetic is reproducible; the inputs are not.

  ◇     MODEL                 A language model read evidence and produced this
                              judgement. Not reproducible.

Requirements:
- ▦ and ◇ must be distinguishable ACROSS A WHOLE SCREEN AT A GLANCE, not on
  inspection. Scanning forty rows, the user should instantly see which column is
  machine judgement. Suggested: ▦ renders in text colour on the panel tone; ◇
  renders in muted text inside a hairline pill. Find something better if you can —
  but it must survive a screenshot and a video frame, not just a hover.
- A ◇ number never renders with more precision than it has. Model-derived values
  are bands or integers, never 73.4.
- The chip is clickable and opens primitive 2.

One line of copy that should appear wherever ▦◇ does, because it answers the user's
real question ("so is this just the AI's opinion?"):

    This number is computed from the evidence we hold. No AI model reports its own
    confidence anywhere in this system.

That is literally true of the system and it is the strongest sentence in the product.

── PRIMITIVE 2: THE EXPLAIN PANEL ──

A 420px right-side sheet, overlays content, closes on Escape. Opens from any number,
badge or chip anywhere in the product. Fixed structure, always these five parts in
this order:

  WHAT THIS NUMBER IS      One plain sentence. No jargon, no formula.

  HOW IT WAS PRODUCED      The chip, then either the formula with its named
                           constants and each input carrying its own value and
                           chip, or — for model judgements — which model, what it
                           was asked, and the exact evidence it was shown.

                           For formulas, render the arithmetic LITERALLY, each
                           term labelled and clickable:

                               base 0.90            strongest supporting evidence
                             × independence 0.70    1 independent source
                             − contradictions 0.00
                             = trust 0.63

  EVIDENCE                 Each row: the claim, its source as an outbound link,
                           its provenance tier, its verdict, the date collected.
                           Verbatim quotes shown as quotes, never summarised.

  WHAT WE DON'T KNOW       Missing inputs, and for each one, what would close it.
                           These strings come from the data and are already written
                           in investor language — render them as-is. They vary from
                           50 to 250 characters, so this cannot be a fixed-height
                           one-line chip.

  AUDIT                    When it was checked, which check ran, and the run id.

The explain panel is the product. Design it first and design it well — the demo
line is "click any number, see the exact source and when we checked it."
```

---

## Prompt 3 — the four states of "we don't know"

```
This is the most important screen-level detail in the product, and the one most
likely to be flattened into a grey blank. Four different things, four different
visual treatments. None of them may EVER render as 0, 0%, an empty bar, or a dash.

  NOT ASSESSED        No score exists for this axis at all.
                      → an empty hairline track with a 45° hatch pattern, never a
                        0%-filled bar. Labelled "Not assessed" with a one-line
                        reason. Sorting treats it as absent, never as zero.

  NOT CHECKED         Nothing has looked at this yet.
                      → muted italic. Offers "why?"

  SEARCHED — NOTHING FOUND    We ran a check and it came back empty.
                      → THIS IS A POSITIVE FINDING AND MUST LOOK LIKE ONE. It is
                        the difference between an ignorant system and a diligent
                        one. It gets its own component, described below.

  NOT DISCLOSED       The founder did not provide it.
                      → neutral, informational. Never phrased as their fault.

THE "SEARCHED, NOTHING FOUND" COMPONENT — design this carefully, it is a
differentiator:

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

  - Open circle. Never a warning triangle. Never red.
  - The last line is required copy, not decoration. It converts a scary-looking
    absence into a trust signal.
  - There is never a quote to show here. Absent is the only state — do not design
    a layout that degrades without one.
  - Needs an aggregate variant: when 74 claims share the same empty check, collapse
    to one line — "Provenance: checked 74 claims across GitHub, no commit history
    available." Ninety-six identical cards is noise, not transparency.

WHY THIS MATTERS: the judging rubric puts 30% on data architecture and explicitly
rewards a system that is honest about what it does not know. These four states are
that honesty made visible. In the live demo, "Not assessed" will be the single most
frequent state on screen — so it must look deliberate and informative, not broken.
```

---

## Prompt 4 — the feed

```
Screen 1 of 5. The morning-triage screen. The user's question is "which five of
these forty do I open?"

SIDEBAR (240px):
  Wordmark "The VC Brain", text only, no logo.
  A single list — the feed — with a source FILTER above it, not separate
  destinations: [ All · Inbound · Radar ]. Default All.
  Then "Watchlist" as a genuinely separate destination below.
  Then a section headed SOURCE CHANNELS · 2 live, 3 documented:
      GitHub ✓   Hacker News ✓   LinkedIn 🔒   X 🔒   Product Hunt 🔒
  Locked channels use a DIFFERENT glyph, not a greyed version of the live one —
  greyed reads as "temporarily broken". They are clickable and open an honest
  panel. Never show a locked channel with a count, not even 0 — zero implies
  "connected and empty."
  Footer: the active thesis name, linking to the thesis screen.

CONTENT:
  Top bar — the search field and the thesis-lens control.
  Then the ranked list, organised in LANES (below).

DENSITY: roomy rows, 56px, about fourteen visible. Not a spreadsheet. Each row
expands in place via a chevron to a three-line evidence preview without navigating
away — triage means scanning, and a page load per candidate defeats it.

THE ROW, left to right:
  chevron · company name with founder name beneath · one-line description ·
  FOUR INDEPENDENT MINI-BARS · source badge · freshness · [SYNTHETIC] chip where
  applicable.

THE FOUR BARS are Founder, Market, Idea-vs-Market and Trust, each 48px, each with
its own trend arrow, single-letter headers on the column header row, and the
provenance chip in the header rather than per row.

  THERE IS NEVER A FIFTH COMBINED BAR. No average, no composite, no total, no
  overall score, anywhere in this product. Their DISAGREEMENT is what the investor
  is paying for. Do not add a summary number even if the layout seems to want one.

  Hovering a bar shows value, confidence and coverage together. Two of the four
  bars will render as "not assessed" hatching in the real data — design for that
  as the common case, not the exception.

THE LANES — the sort is not a single ordering:

  ┌ OFF-THESIS BUT EXCEPTIONAL ─────────────────────────── pinned to the top ┐
  │ Outside the stated mandate, but the founder scores in the top band.      │
  │ Shown so a strong founder is never silently filtered out.                │
  └──────────────────────────────────────────────────────────────────────────┘
  IN THESIS            sorted by fit
  OUTSIDE THESIS       down-ranked, NEVER hidden. Label it "Outside thesis",
                       never "rejected" — it means outside this fund's mandate,
                       not "bad company."
  NOT YET ASSESSABLE   a small lane at the bottom, with the reason.

Lane 1 is a product statement — give it visual distinction. It is the answer to
"how do you avoid missing the outlier?"

THE SEARCH FIELD. One wide input, no filter chips, no advanced drawer, no
dropdowns. Placeholder is the real benchmark query:

    technical founder, Berlin, AI infra, enterprise traction, no prior VC backing,
    top-tier accelerator

Resolving that in one pass is the requirement being demonstrated; visible filter UI
undercuts the claim. After a search, render THE PARSED PLAN above the results —
this is the highest-value component on the screen:

  Understood:   ● technical founder → founder expertise
                ◐ Berlin → country = DE          ⓘ widened: city → country
                ● AI infra → sector = ai-infra
  Not searched: ○ enterprise traction        no way to test this
                ○ no prior VC backing        no data source
                ○ top-tier accelerator       no data source

  Three chip classes, three glyphs. The half-filled one means "matched, but only
  after widening the question" — a Munich founder returned as a Berlin match is
  scope drift, so the widening must be visible and must carry its explanation
  inline.

  Understood chips are removable. Unresolved chips are NOT removable and never
  hidden — removing one does nothing and teaches the wrong model.

  Three of six fragments failing is the CORRECT behaviour on the sponsor's own
  query, and showing that honestly is the point. A search that hid them would
  answer a different question than the one asked, and look more confident for it.

RESULTS carry coverage BEFORE rank ("assessed 3 of 4 attributes", then the score),
because the ordering is confidence-band-first and a row showing only its rank will
look mis-sorted. Below the ranked list, a separate labelled section: "Below the
confidence floor — too little assessed to rank fairly. Shown, not dropped."
Never interleaved with the ranked results, never omitted.
```

---

## Prompt 5 — the founder card

```
Screen 2 of 5. The pre-call screen. Thirty minutes, and the user needs to know
where to dig.

HERO:
  Company, founder, one-liner, source badge, [SYNTHETIC] chip if applicable.
  The four axes rendered large, each with its value, provenance chip, trend, and
  CONFIDENCE AND COVERAGE BESIDE THE VALUE — always, never separated across a
  layout boundary. If a container is too narrow for both, show neither; show the
  label instead.

  Then the single most useful sentence on the card — a disagreement callout,
  present whenever the axes diverge:

      The axes disagree: strong founder, weak idea-vs-market fit.
      That gap is the thing to probe on the call.

  This turns the no-averaging constraint from a limitation into the card's best
  feature. Design it as a real element, not a footnote.

TABS: Evidence · Market · Competition · Interview · What we don't know

── EVIDENCE — the ledger, and the heart of the card ──
A dense table: claim · source · tier · verdict · trust · collected.
Grouped BY TOPIC, not chronologically — the investor thinks in topics.
A filter row above: All · Refuted · Conflicting · Not disclosed · Searched—nothing
found. That last filter shows diligence and must not be buried.

Verdict badges — five values, exact words, three visually distinct families:
  VERIFIED              positive, restrained
  CONTRADICTED          serious and specific, NOT alarm — it is one claim
                        disagreeing with one document
  CONFLICTING EVIDENCE  attention
  NOT VERIFIED          NEUTRAL GREY, same weight as body text
  NOT DISCLOSED         neutral, informational

  "Not verified" is the default state of three-quarters of all claims. Style it as
  a warning and you have flagged the entire application.

Two qualifier pills that REPLACE the verdict rather than sitting beside it:
  FORECAST — for market-size estimates. They are unfalsifiable projections and
             will never carry a verdict. Without this label the UI penalises
             completely normal founder behaviour.
  JUDGEMENT — NOT VERIFIABLE — for claims about how someone writes, what they
             know, how they lead.

TRUST IS NOT A PERCENTAGE AND NOT A GAUGE. Per claim, render it as a four-pip
meter beside the verdict:

      VERIFIED  ●●○○  1 independent source · documented

  The pips are: has support · documented tier · one independent source · two or
  more. The raw number appears only inside the explain panel next to the equation
  that produced it. Reason: a completely true, well-evidenced claim scores 0.63 on
  this scale, and "63%" reads as "the system is 63% sure this is true" — which is
  wrong in a way that damages good founders.

At card level, trust is a SEGMENTED BAR, deliberately unlike the other axes so
nobody averages it in their head:

      TRUST  ████████░░░░▓▒  63%  ·  coverage 64% (189 of 297 checkable claims)
             139 verified · 4 contradicted · 0 conflicting · 36 not disclosed

  The segments ARE the mandatory disagreement breakdown, so the context is
  structural rather than a caption someone can delete.

A REQUIRED BANNER on this tab, because it covers 58% of all claims:

      58% of the claims on this company are judgements — how the founder writes,
      what they know, how they lead. We show the evidence behind them and where it
      came from, but we do not issue verdicts on judgement. That is a deliberate
      limit, not a gap.

  Without it the card reads as 58% failure. With it, it reads as the most honest
  tool on the table.

── MARKET ──
Category chip marked "inferred from application, not researched" with a dotted
underline — it is determined before any search runs and is the least-grounded
output in the product while currently looking like the most confident.

The score and its confidence as ONE indivisible object: the number large, the
confidence directly beneath in the same optical block. When confidence is very low,
THE NUMBER ITSELF renders in an outline weight rather than solid. This is the only
treatment that survives a screenshot and a video frame; a tooltip survives neither.
It matters because an unresearched market and a middling one both score exactly 50.

Bull/neutral/bear as a POSITIONAL SCALE MARKER, never a chip:

      bear        neutral        bullish
      ├─────────────●─────────────────────┤
                    52

  Fixed track, all positions always named, marker at the actual value — so "how
  bullish" is read from geometry rather than from a word, and adjacent cards
  become comparable at a glance. A hollow ring marker means low confidence.
  When it could not be assessed at all, the TRACK IS REPLACED by a dashed empty
  rail with "not assessed — no TAM established". A fourth chip colour would hide
  the difference between "middling" and "couldn't tell".

Market size renders as TWO GATES SIDE BY SIDE, never merged, with the disagreement
spelled out — that disagreement is the most investor-legible idea in the feature:

      Market size            Reachability
      TAM  $1.2B – $2.8B     Implied exit  $24M
           PASS                            FAIL
           ─────────────────────────────────────
           same market, different answer — 2% of 500k+
           long-tail buyers is not 2% of 4,000 enterprises

  Market-size numerals take a visibly different type treatment from every other
  number on the page — italic, or a leading ~, plus a persistent Forecast label
  needing no hover. They are projections; a verified revenue figure is not.

── COMPETITION ──
LEAD with the unnamed-competitor callout above the table — it is the highest-value
output of the whole analysis:

      Found and not mentioned by the founder — 4
      MEDITECH · Oracle Health · Epic · Microsoft Nuance DAX

Columns: Name · Category · Mentioned · Threat · Switching · Sources(n).
"Mentioned" is a COLUMN, not a corner badge — it is the axis the analysis exists
to compute.

Threat renders AS A WORD, never a number: Disruptive · Intercepting · Niche ·
Red ocean. The underlying scale is inverted (1 is the best position), so any badge
that darkens with the number inverts the meaning.

A null threat gets its own glyph and the words "— not assessable", never a blank
cell. An empty cell reads as an oversight; that reads as a decision.

A footer line under the table, ALWAYS, even when the table is full:
      Adjacent: searched, none found · Build-vs-buy: found · Named-by-founder: n/a
Without it, an empty competitor table reads as "no competition" — the exact
founder claim this analysis exists to contradict.

── WHAT WE DON'T KNOW ──
Three grouped lists: searched-nothing-found (with which sources and when) ·
not-checked-yet (with what would trigger a check) · not-disclosed (each with its
"what would close it" string, verbatim).

MAKE THIS THE BEST-DESIGNED TAB ON THE CARD, not the leftover one. It is the
direct visual answer to the thing the sponsor said he cares about most.

── CONTRADICTIONS ──
A persistent bordered strip below the hero when any exist: "2 contradictions found
— worth raising on the call", expanding to a list.

Framing rule, absolute: TWO VERBATIM COLUMNS WITH NO VERB BETWEEN THEM. What the
deck says on the left, what the source says on the right, both quoted, both with
clickable sources. The juxtaposition IS the finding. Never generate a sentence
connecting them. Never the words false, misleading, inflated, misrepresented.
Lead with the question the contradiction raises, not the verdict:
"Can you walk us through your work history in retail prior to 2021?"
```

---

## Prompt 6 — the founder score, the memo, the thesis form

```
Three remaining surfaces.

── THE FOUNDER SCORE COMPONENT ──
This one is unlike the others: it is attached to a PERSON, persists across
companies, and never resets. Give it a persistent identity chip — a rounded
rectangle with a person glyph — that appears wherever that person appears, visually
distinct from the tile treatment used for company-scoped scores. Seeing the same
chip on two different deals is how "the score follows the person" lands without
explanation.

It must NOT look like a gauge. Its whole value is composition.

At rest, one row, three zones:

  ⌾ FOUNDER SCORE · person-scoped                          formula_v1  ⌄

   67.96      ▓▓▓▓▓▓▓▓▓▓░░░░░░  confidence 0.63    ●  7 of 12 assessed
   ───────    coverage │ evidence quality           coverage 0.54
   not a %
                                                   5 gaps ▸ what closes

  Keep the decimals — round numbers read as judgements, 67.96 reads as computed.
  Under the number, literal micro-copy: "weighted score over 7 assessed criteria —
  not a percentage, not a prediction."
  Confidence is a SEGMENTED bar with two labelled parts, never a smooth gradient.
  Coverage is a COUNT ("7 of 12 assessed"), which a non-technical reader parses
  instantly and cannot mistake for a grade.

When there isn't enough evidence to score at all — SAME SIZE, SAME PROMINENCE:

   Not enough evidence to score                    ●  1 of 12 assessed
   ─────────────────────────────                   coverage 0.06
   We looked. We are not guessing.                 below the 0.25 threshold

   ▸ 11 things that would produce a score

  This is the component's best moment, not its worst. Demote it visually and you
  teach the user it is a failure. "We looked. We are not guessing." is the
  product's thesis in five words — keep it verbatim.

Expanded, it becomes a ledger — one row per criterion, grouped by family, with
FOUR VISUALLY ORTHOGONAL MARKS that must not sit on one colour ramp:

  ✓ filled        evidenced
  ◐ half-filled   they say so; nobody else does
  ✗ outlined      we checked; it isn't there
  ○ dashed ring   we haven't looked  ← MUST BE ACHROMATIC

  The dashed ring taking any warning colour would turn "we haven't looked" into a
  failing grade, which inverts the product's core principle. And the outlined ✗ —
  a real finding — must read as MORE confident than the dashed ring, inverting the
  usual convention that grey is softer than red. That inversion is the point.

Criterion labels in plain English, never the internal ID as the primary label.
The verified quote and the model's interpretation must NEVER share styling — they
are separate fields precisely so a paraphrase cannot be laundered as a quote.

Footer, and it is the trust move: "Σ contributions = 67.96 ✓ verified" — the rows
sum to the headline, so the arithmetic can be audited by reading. No other score
in the product can offer that.

Below it, a quieter but required block with its reason INLINE, not in a tooltip:

  PEDIGREE (NOT SCORED)
  Ex-employer and serial-founder status are collected and shown for context. They
  are excluded from the score: models built on founder pedigree were the strongest
  predictor of underperforming investments in a 16,000-startup study.

── THE MEMO ──
A document, not a dashboard. Single column, 760px, generous leading, print-friendly.

Five required sections in this order, nothing added: Company snapshot · Investment
hypotheses · SWOT · Problem & product · Traction & KPIs. Padding counts against us
— a section with nothing to say says so in one line rather than being filled.

Every factual sentence carries its verdict badge inline and clicks through to the
explain panel. A memo sentence with no traceable claim behind it is a bug.

A "Where to dig" block — five to seven questions, each with the gap it closes
stated beneath. This is what makes the memo worth reading before a call; give it
real design weight.

A recommendation banner using three values only — Invest, Pass, Watch — with the
thesis rules that fired listed beneath. Rules that could not be evaluated are
listed as "could not be evaluated", never folded into pass or miss. Use the panel
tones and a navy rule; NOT a colour-coded verdict strip.

The prose is model-written and the recommendation is a deterministic rule — chip
them differently. That contrast is worth pointing at in the demo: the writing is a
model, the decision is a rule.

Where numbers do not exist, the memo says "Cap table: not disclosed" and shows
benchmark comparables. Never a fabricated figure, never an empty table.

── THE THESIS FORM ──
The fund's configurable mandate. Two groups, and the split is the honest part:

  APPLIED TO SCORING   sectors, geographies, stages, keywords, rules, fit tuning
  RECORDED ONLY        check size, ownership target, risk appetite
                       (labelled "Recorded, not yet applied to scoring")

Under the mandate section, a live read-only preview — the killer affordance:

  Your mandate compiles to 5 soft rules:
  M_sector (w20) · M_geography (w20) · M_stage (w20) · M_poskw (w20) ·
  M_negkw (deal-breaker, w0).     Total weight: 105

Clear a keyword list and watch a rule disappear. Without this, the tuning fields
are numbers with no visible effect.

Rules are a table with a small add-form, never a JSON editor. Enforcement defaults
to "soft"; choosing "hard" reveals a REQUIRED justification radio plus one line:
"A hard rule auto-rejects. It fires only when the attribute was actually observed;
an unread deck can never trigger it."

The button says "Publish new version", never "Save", and shows the version number
it will create. Changing the active thesis re-sorts the feed live.
```

---

## What to bring back

Whatever Claude Design produces, the wiring needs these to be intact — check before exporting:

- [ ] No combined, average or overall score anywhere, in any label.
- [ ] The three provenance chips are distinguishable across a full screen, without colour alone.
- [ ] Four visually distinct not-known states; none renders as `0`, an empty bar or a dash.
- [ ] Trust is a pip meter per claim and a segmented bar per card — never a percentage alone, never
      a gauge.
- [ ] `cannot_assess` in the founder ledger is achromatic, and `not_met` reads as *more* confident
      than it.
- [ ] Verdict and tier words match the five/four vocabularies exactly — no invented or renamed
      values.
- [ ] Contradictions are two verbatim columns with no verb between them.
- [ ] The market score and its confidence are never separated across a layout boundary.
- [ ] Locked channels have their own glyph and no counts.
- [ ] Every number opens the explain panel.

Anything Claude Design "improves" by adding a summary number, a traffic light, or a single
confidence percentage is a regression — those three are the failures this product exists to
prevent, and a judge will test all three.
