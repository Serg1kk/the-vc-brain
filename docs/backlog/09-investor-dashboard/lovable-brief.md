# Lovable / Claude Design Build Brief — Investor Dashboard (feature 09)

> **Purpose of this file.** Everything a generative design tool needs to produce the
> investor-facing half of The VC Brain, in one place: product context, hard constraints, exact
> routes, frozen read contracts, the scoring-transparency model, exact copy, every screen state,
> and acceptance criteria.
>
> **Owner:** feature 09. **Status of contracts below:** frozen against features 01–07 and 10 as
> shipped. Sections marked ⏳ are pending a live-schema confirmation and must be re-checked before
> the front is wired — but they are already safe to *design* against.
>
> **How to use:**
> - **Lovable** — paste §1 as the first prompt, then feed §7–§12 screen by screen.
> - **Claude Design** — use the separate, visual-first prompt in
>   [`claude-design-brief.md`](claude-design-brief.md). Same product, different input format.
>
> **Companion:** [`../08-founder-intake-interview/lovable-brief.md`](../08-founder-intake-interview/lovable-brief.md)
> — the founder-facing half, already built and living in `web/`. This brief extends that same
> application. Read its §3.2, §3.3 and §5 before generating anything.

---

## 1. First prompt for Lovable (paste this verbatim)

```
Build the investor-facing part of an early-stage VC platform called "The VC Brain".

An investment manager at a pre-seed fund opens this in the morning with 40 new
applications waiting and 30 minutes before their first founder call. Two jobs:
triage the pile fast, then walk into a call knowing exactly where to dig.

The whole product is an argument against black-box scoring. Every number on every
screen must answer three questions without the user asking: what produced this
number, what evidence is under it, and what does the system NOT know. A number
that cannot answer all three does not get rendered as a number.

Design language: Notion's approachability with a financial terminal's density.
Calm, information-dense, no decoration. No hero sections, no marketing copy, no
gradients, no glassmorphism, no emoji, no stock photos, no illustrations, no
animated blobs, no confetti, no card shadows. Elevation is expressed with borders.

Stack: React + TypeScript + Vite + Tailwind + shadcn/ui with TanStack Router
(file-based routes in src/routes/). This is being added to an EXISTING app that
already owns /apply, /a/:token and /privacy — do not touch, restyle or re-route
those. Reuse the existing design tokens in src/styles.css and the existing
components/ui/* primitives. Put all new screens under /app/*.

This app only ever talks to a backend on localhost, so it must be rendered entirely
in the browser:
- No server-side data fetching. No route `loader`s, no `createServerFn`, no server
  functions, no SSR or prerender hook may call our API.
- Every API call happens in the browser, inside a component effect or a client query.
- `npm run build` must succeed with no .env file and with no network access.

CRITICAL CONSTRAINTS — do not violate any of these:
- Do NOT connect Lovable's native Supabase integration. Do NOT create a database,
  auth, or any backend. This is a pure frontend over an existing REST API.
- No authentication of any kind. No login, no signup, no accounts, no sessions.
  This is a single-fund internal tool.
- No mock data and no placeholder rows. Empty states must be real empty states.
- No analytics, no tracking, no cookie banner.
- Desktop-first: the primary viewport is 1440x900. It must not break at 1280, but
  mobile is explicitly not a target.

Routes (URLs are fixed):
  /app                    — redirect to /app/feed
  /app/feed               — ranked deal feed (the default screen)
  /app/f/:applicationId   — the company/founder card
  /app/f/:applicationId/memo — the investment memo
  /app/thesis             — fund thesis configuration

Name the route components exactly: Feed, Card, Memo, ThesisConfig.

I will give you each screen's exact fields, states and copy next. Start by
scaffolding the /app shell (persistent left sidebar + content area), the routing,
and a typed read-only API client module. Do not build screen internals yet.
```

---

## 2. Product context (so generated copy has the right tone)

The VC Brain scores pre-seed founders on **evidence rather than pedigree** — including founders
with no track record, who are invisible to Crunchbase-style databases. It decides a $100K check in
24 hours.

Three facts that shape every pixel:

1. **The user is a non-technical investment manager.** They will not read a formula. But they will
   refuse to act on a number they cannot interrogate. So: the surface is plain language, and one
   click below it is the machinery.
2. **The product's differentiator is honesty about its own limits.** A gap stated plainly scores
   higher with this audience than a confident number. The UI must make "we don't know" a
   first-class, well-designed state — not an error state, not a grey blank, not a zero.
3. **The scores must never be averaged into one.** Founder / Market / Idea-vs-Market are three
   independent axes, and their *disagreement* is the signal the investor is paying for. There is
   no overall number anywhere in this product, deliberately. Do not add one. Do not add a
   "composite", "total", or a single ring gauge that implies one.

Tone: direct, factual, no salesmanship, no hype adjectives, no exclamation marks. Never say
"powerful", "seamless", "AI-powered", "insights", or "journey". Label things what they are.

---

## 3. Hard technical constraints

### 3.1 This extends an existing application

`web/` already contains the founder-facing app (feature 08): TanStack Router, Tailwind v4,
shadcn/ui, `src/styles.css` holding the Maschmeyer palette, and `src/lib/api.ts`.

- **Route ownership:** `/apply*`, `/a/:token`, `/privacy` belong to feature 08 — do not modify.
  Feature 09 claims `/app/*` exclusively.
- **Shared, do not fork:** `src/styles.css` (tokens), `src/components/ui/*` (shadcn primitives),
  `src/lib/types.ts`.
- **New, 09-owned:** `src/routes/app.*`, `src/components/app/*`, `src/lib/investor-api.ts`.
- The founder app has no navigation into `/app/*` and must not gain one.

### 3.2 Environment variables

Already declared in `.env.example`; read via `import.meta.env`:

```
VITE_N8N_BASE_URL=http://localhost:5678
VITE_SUPABASE_REST_URL=http://localhost:8000/rest/v1
VITE_SUPABASE_ANON_KEY=
```

Unlike the founder flow, **the investor dashboard reads Supabase (PostgREST) directly.** Every
read in §5 is a PostgREST call with the `apikey` and `Authorization: Bearer` headers set to
`VITE_SUPABASE_ANON_KEY`. Writes (thesis publish, follow-up suggestion, delete-on-request) go through the
n8n webhooks in §6.

### 3.3 Local-only, forever

The entire product runs on one machine in Docker. Supabase, n8n and this frontend are all local;
the deliverable is a demo video recorded against that local stack plus source on GitHub. Nothing is
deployed. A page served from `https://*.lovable.app` cannot call `http://localhost` — browsers
block it as mixed content. **Lovable's preview is a design surface only.** Therefore: no absolute
URLs, no CDN assets, no external fonts, no service worker, `npm run build` must pass with no `.env`.

---

## 4. The scoring-transparency model — READ THIS BEFORE ANY SCREEN

This is the intellectual core of the product and the reason the dashboard exists. Get this wrong
and every screen is wrong.

The system knows things in **two orthogonal dimensions**, and the UI must never conflate them:

- **How was this produced?** (provenance of the *computation*) — §4.1
- **How well do we know it?** (provenance and verdict of the *evidence*) — §4.2

### 4.1 Computation provenance — the three chips

Every number rendered anywhere carries exactly one chip. The chip is a small monospace glyph +
label, inline with the number, never a tooltip-only affordance. Clicking it opens the explain panel
(§4.4).

| Chip | Label | Meaning | Examples |
|---|---|---|---|
| `▦` | **Rule** | Computed by a published deterministic formula from stored inputs. Re-runnable, reproducible, identical every time. No model involved in the arithmetic. | `thesis_fit` (pure evaluator over stored attributes) · trust rollup arithmetic · radar `obscurity` · card completeness · coverage |
| `▦◇` | **Rule on model input** | A deterministic formula, but at least one *input* was extracted or judged by a language model. The arithmetic is reproducible; the inputs are not. | `founder_score` (rule formula over model-judged criteria) · `trust` per-claim value (formula constants, model-judged verdict) |
| `◇` | **Model** | A language model read evidence and produced this judgement or text. Not reproducible. | market bull/neutral/bear stance · competitor threat level · memo prose · deep-dive questions · claim verdicts |

**Design requirement, non-negotiable:** `▦` and `◇` must be distinguishable **at a glance across a
whole screen**, not only on inspection. A feed of 40 rows must let the investor see instantly which
column is machine judgement. Recommended treatment: `▦` renders in `--text` on the surface tone,
`◇` renders in `--text-muted` inside a hairline-bordered pill. Do **not** use colour alone (fails
contrast and colour-blind users) and do **not** use red/green — nothing here is good or bad.

**The one rule that must never break:** a `◇` number may never be presented with more precision
than it has. Model-produced scores render as bands or integers, never as `73.4`.

> **Why this matters for judging:** the sponsor's rubric puts 25% on "Intelligent Analysis & Trust"
> and explicitly rewards a system that is *honest about what it does not know*. The chip system is
> that honesty made visible, and it is the single most demo-able idea on this screen.

**One fact that makes the chip system defensible rather than decorative:** **no language model
anywhere in this product emits a confidence number.** Every confidence and trust value is computed
by us from the structure of the evidence — how many independent sources, at what provenance tier,
agreeing or disagreeing. The model's job is to judge *what a source says*; the arithmetic of *how
much that is worth* is always ours. This is an explicit design ban, not an accident, and it is why
a `◇` judgement can still feed a `▦` number.

The explain panel should say this in one plain sentence wherever a `▦◇` chip appears, because it is
the answer to the investor's real question — "so is this just the AI's opinion?" — and the answer
is no.

### 4.2 Knowledge state — the five verdicts and four tiers

Frozen vocabulary, carried verbatim from feature 05's design §3. **Do not invent, rename, merge or
add values.**

**Verdict** (what the evidence says about the claim) — read the column `derived_status`:

| Value | UI label | Meaning |
|---|---|---|
| `verified` | **Supported** | ≥1 independent supporting source at documented/discovered tier, nothing contradicting |
| `contradicted` | **Refuted** | a documented-tier source contradicts it, nothing supports it |
| `partially_supported` | **Conflicting** | both supporting and contradicting evidence, or supported only under a narrower scope |
| `unverified` | **Not enough evidence** | the default state |
| `missing` | **Not disclosed** | a first-class, deliberate gap — e.g. "Cap table: not disclosed" |

**Provenance tier** (where the knowledge came from) — the column `tier`:
`documented` / `discovered` / `inferred` / `missing`.

**Plus one label that is not a verdict:** `Forecast` — applied to forecast-class claims such as a
TAM estimate, so that an unverifiable projection never reads as a failed verification.

### 4.3 The four states of "we don't know" — the highest-value detail on this screen

The operator asked specifically for this and it is where most dashboards lie. These four are
different things and must be **visually different**:

| State | How to detect it | UI label | Treatment |
|---|---|---|---|
| **Not assessed** | no `scores` row exists for that axis | `Not assessed` | The axis bar renders as an empty hairline track with a diagonal hatch, never a 0%-filled bar. Sorting treats it as absent, never as zero. |
| **Not checked** | claim has no evidence rows at all | `Not checked` | Muted italic. Offer the "why?" — nothing has looked at this yet. |
| **Searched, nothing found** | an evidence row exists with `tier='missing'` and `relation='context'`, or a `claim_verification_attempted` event exists | `Searched — nothing found` | **This is a positive finding and must look like one.** Show which sources were searched and when. It is the difference between an ignorant system and a diligent one, and it is worth a dedicated component. |

> ⚠️ **Honest note on the third state, and it is a design instruction, not a caveat.** The
> `claim_verification_attempted` event that would fully separate *searched* from *never checked*
> has **zero rows today** — its writer is the last unshipped piece of feature 05. Right now the
> distinction is only populatable for the ~34 claims where feature 04 deliberately wrote a
> `missing` status; the other ~690 `unverified` claims cannot yet be told apart.
>
> **Build the third state anyway and let it render empty.** Do not collapse it into "Not checked"
> to avoid an empty list. A system that has a named place for "we looked and found nothing" and
> honestly shows it is currently unpopulated is the exact behaviour the rubric rewards; a system
> that quietly merges the two is the failure mode the whole product argues against.
| **Not disclosed** | verdict `missing` | `Not disclosed` | Neutral. Never phrased as the founder's fault. |

**Absolute rule: none of these four may ever render as `0`, `0%`, an empty bar, or a dash.** An
absent number and a low number are opposite findings and a dashboard that renders them identically
is exactly the failure this product exists to prevent.

Where an axis is not assessed, the system also records *why* — look for an event of type
`<axis>_insufficient_evidence` (e.g. `trust_rollup_insufficient_evidence`) and surface its reason
in the explain panel.

### 4.4 The explain panel — one component, used everywhere

Every number, badge and chip on every screen is click-through to the same right-side sheet
(420px, overlays content, dismissable with Esc). It has a fixed structure:

```
┌─ WHAT THIS NUMBER IS ────────────────────────────┐
│ Plain-language sentence. No jargon, no formula.   │
├─ HOW IT WAS PRODUCED ────────────────────────────┤
│ ▦ Rule / ▦◇ Rule on model input / ◇ Model        │
│ For ▦ and ▦◇: the formula, its named constants,  │
│   and each input with its own value and chip.    │
│ For ◇ and ▦◇: which model, what it was asked to  │
│   judge, and the exact evidence it was shown.    │
├─ EVIDENCE ───────────────────────────────────────┤
│ Each row: claim text → source link → tier badge  │
│ → verdict badge → collected-at date.             │
│ Verbatim quote where one exists, never a summary.│
├─ WHAT WE DON'T KNOW ─────────────────────────────┤
│ Missing inputs, and for each: what would close it│
│ (the system stores this — render it verbatim).   │
├─ COVERAGE & CONFIDENCE ──────────────────────────┤
│ Coverage x% · Confidence y — always both, always │
│ next to the value. Never the value alone.        │
└──────────────────────────────────────────────────┘
```

The "what would close it" strings come from the data (`missing_flags[].what_would_close_it`) and
are already written in investor language. Render them as-is; do not rewrite.

### 4.5 Three display rules that are binding, not stylistic

These come from upstream feature designs and a QA gate tests them:

1. **The axes never collapse into one number.** No average, no composite, no total, no single
   overall ring. Anywhere. (Sponsor invariant REQ-002.)
2. **A trust rollup may never be displayed alone.** Wherever the trust value appears it must be
   accompanied by the disagreement breakdown — counts of *Refuted*, *Conflicting* and
   *Not disclosed* claims, plus coverage. A clean number over a contested evidence base is the
   exact failure this feature exists to prevent. (Feature 05 design §14.1.)
3. **A score value is never shown or sorted without its confidence and coverage beside it.**
   (Feature 03's rule for its own axis, applied everywhere.)

### 4.6 Synthetic data must always be badged

Part of the demo corpus is synthetic profiles with deliberately seeded contradictions. Any row or
card whose subject is flagged synthetic renders a persistent `SYNTHETIC` chip in the header — feed
row, card hero and memo header. It must never be possible to see a synthetic record without the
badge. This is a hard QA gate, not a nicety.

---

## 5. Frozen read contracts (PostgREST)

Base: `${VITE_SUPABASE_REST_URL}`. All reads are `GET` with headers
`apikey: <anon key>` and `Authorization: Bearer <anon key>`. PostgREST syntax applies:
`?select=`, `?order=`, `?<col>=eq.<value>`, `Range` headers for pagination.

📄 **Exact column lists, types, value vocabularies and query examples are frozen in
[`data-contracts.md`](data-contracts.md)** — verified against the live schema and confirmed
returning HTTP 200 over REST. That file is the contract; this section is the summary and the
gotchas. **The implementer must read it before wiring anything.**

📄 **Why each number is rendered the way it is — including the per-score component specifications —
is in [`scoring-ux.md`](scoring-ux.md).** That file is the design rationale; read it before
drawing a single score.

### 5.1 `GET /radar_candidates` — the feed source

The outbound-sourcing feed view. Per-row: founder and company identity, the source channel that
surfaced them, freshness, and an **`obscurity`** score — a deterministic `▦` measure of how
invisible this person is to conventional databases. Obscurity is a *feature*, not a defect: the
whole thesis is finding people before Crunchbase does. Design it as a proud column, not a warning.

### 5.2 `GET /api_applications` — the inbound feed source

Per-application row with the axis scores denormalised. Critical semantics:

- Each axis is reported with an explicit **assessed / not-assessed** flag. `assessed: false` means
  render §4.3's *Not assessed* state — never zero.
- `score_founder` is `assessed: false` on **every row today**, and the reason is worth understanding
  because it changes the copy. The writer exists and is correct: feature 04 composes the `founder`
  axis but is gated on a `founder_score` existing for someone on the application, and feature 03 has
  so far scored 3 founders out of 122. **The axis is empty by cascade, not by omission** — it fills
  itself as scoring coverage grows.
  **This is not a bug to design around — it is the exact case the Not-assessed state exists for,
  and it will be visible in the demo.** Design that state to look deliberate and informative,
  because it is the one the judges will see most. Its explain panel should say plainly:
  `Not assessed — no founder score exists yet for anyone on this application.` Never
  `Score: 0` and never a blank cell.

### 5.3 `GET /api_founders` — the person-scoped view

Carries the persistent `founder_score` (which follows the person across companies and is never
reset), its components, its trend, and **`founder_score_gaps`** — the array of
`{criterion_id, what_would_close_it}` objects behind §4.4's "what would close it" block.

⚠️ `missing_flags` is an array of **objects**, not strings. Rendering it as strings prints
`[object Object]` to an investor.

### 5.4 `GET /claim_trust` — per-claim trust, the card's Evidence tab

One row per claim, carrying the claim text, its `derived_status` (§4.2), its evidence tier and its
trust value.

⚠️ **Read `derived_status`, not `claims.verification_status`.** The view's own column is
authoritative; the table column is a best-effort write-back and may lag. A dashboard reading the
stale one shows an investor a verdict the system has already revised.

⚠️ **`claim_trust` alone cannot build the evidence ledger.** It exposes `card_id` and no other
subject column — no `founder_id`, no `company_id`, no `application_id` — and critically **no
`source_url`**. The ledger table in §9.2 requires a join to **`api_claims` on `claim_id`**, which
supplies the three subject columns and the `evidence[]` array carrying `source_url`. Plan the data
layer for two joined reads, not one.

⚠️ `base` is nullable (it is null when no supporting evidence row exists); `trust` is never null
because it coalesces. **A null `base` with a non-null `trust` is the "nothing supports this yet"
case** and must not render as a computed-looking zero.

### 5.5 `GET /events` — contradictions and the audit trail

```
GET /events?event_type=eq.claim_contradicted&entity_id=eq.<founder_id>&order=created_at.desc
```

⚠️ **The contradiction event set must be read *in addition to* the verdict set, not instead of it.**
A contradiction on a *qualitative* claim legitimately never becomes a `contradicted` verdict, yet a
documented-tier one still lowers the trust number. A UI built on verdicts alone would show a
finding nowhere on the screen. Surface these as **deep-dive questions rather than accusations** —
"worth asking about on the call", never "the founder is lying".

Company-scoped contradictions (`competition.*`, `market.*`) are still written with
`entity_type='founder'`; when a company card has no resolvable founder they are written with
`entity_type='application'`. **Query both shapes.**

`events` is also the click-through target for every badge in the product — it is the audit trail.

### 5.6 `GET /thesis_evaluations` — thesis fit and the feed lanes

⚠️ **Never read the `scores` table directly for current thesis fit.** `scores` is append-only with
no uniqueness on `(application_id, axis)`, so "latest row" is not "current verdict". A QA run
reproduced the failure: an application scored 100, was re-run, degraded to `insufficient_evidence`,
correctly wrote no new score row — and a direct `scores` query still returned **100** for an
application the system can no longer assess.

Correct resolution, in order:

1. Take the latest `thesis_evaluations` row for `(application_id, thesis_id)`.
2. If `verdict = 'insufficient_evidence'` **or** `score_id IS NULL` → render **Not assessed**. Do
   not fall back to an older number.
3. Otherwise follow that row's `score_id`.

`thesis_id` matters: several theses can be active at once, and a naive "latest per application"
silently mixes them.

**Two different verdict columns exist and they are not interchangeable:**

- `thesis_evaluations.verdict` — **four values, never null**:
  `passed | borderline | failed | insufficient_evidence`. **Render from this one.**
- `applications.thesis_gate` — three values **plus null** (`passed | borderline | failed`), where
  **null is the `insufficient_evidence` state**, encoded that way so an existing CHECK constraint
  would not break. Treat `thesis_gate IS NULL` as *not assessed*, never as *no gate was run*.

> **Demo-honesty note worth designing for.** The attribute extractor that feeds the thesis gate is
> not bit-reproducible — the model rejects a zero-temperature setting, and a live measurement
> recorded the same application returning `borderline` on one run and `failed` on another because
> the sector classified differently. **The framing that survives scrutiny is: the reasoning is
> deterministic and auditable; the perception is not.** The UI supports that framing by chipping the
> extracted attributes `◇` and the fit computation `▦` — visibly separating the part that can wobble
> from the part that cannot. A keyword-only mode exists that is deterministic end to end and is the
> safer choice if a thesis result needs to be reproducible on camera.

`fired_rules[]` element shape, for the memo's recommendation block:

```jsonc
{ "id": "R1", "label": "Excluded sector: gambling",
  "kind": "deal_breaker" | "must_have" | "focus",
  "enforcement": "hard" | "soft",
  "outcome": "satisfied" | "missed" | "triggered" | "unknown",
  "field": "sector", "expected": ["gambling","adtech"], "observed": "gambling",
  "weight_applied": 0 }
```

`outcome: "unknown"` means the rule could not be evaluated — **say so honestly**; never render it
as a pass or a miss.

⚠️ On `thesis_fit` score rows, read `missing_flags.missing_fields` (the nested array) — **do not
iterate `missing_flags` itself.** Any key prefixed with `_` is writer-internal and must never be
rendered; a consumer that enumerates the object shows the investor a hash as a missing data point.

---

## 6. Frozen write contracts (n8n webhooks)

Base: `${VITE_N8N_BASE_URL}`. JSON in, JSON out. Error shape is feature 08's §4.5:
`{ "error": { "code": "...", "message": "Human-readable, safe to display." } }`. Never render a raw
stack trace or JSON blob.

| Endpoint | Purpose | Screen |
|---|---|---|
| `POST /webhook/f09-suggest-followup` | Turn the card's gaps into a suggested follow-up question set | Card |
| `POST /webhook/f10-nl-search` | Natural-language search over the corpus | Feed |
| `POST /rpc/activate_thesis_version` *(PostgREST RPC, not n8n)* | Publish a thesis version | Thesis config |
| `POST /webhook/f11-purge` | Delete-on-request (GDPR erasure) | Card |

⏳ Exact request/response bodies land with each owning feature. **Design every one of these as an
optimistic-UI-free, explicit request with a visible pending state** — they are slow (they call
models) and a silent optimistic update would lie about work that has not happened.

🚫 **Manager notes are CUT — operator decision, Jul 19. Do not build them.** There is no notes or
comments table anywhere in the schema (absent, not empty), and adding one is out of scope for the
remaining clock. No notes panel, no comment rail, no annotation affordance on the card. The
follow-up question suggestion is driven by the card's **gaps alone**, which is where it gets its
value anyway.

⚠️ **The deck file cannot be rendered.** No Supabase Storage bucket is provisioned for the investor
side, so any "view the deck" affordance on the card would 404. Either omit it or render it as an
explicitly disabled control with an honest label.

⚠️ **Thesis publish protocol — getting this wrong is a guaranteed error.** To publish a new thesis
version: `INSERT` the row with **`active = false` explicitly** (the column defaults to `true`, so
omitting it is a deterministic unique-constraint violation), *then* call
`POST /rpc/activate_thesis_version`. Never raw-INSERT an active row, and never flip
`active`/`is_default` by hand — the RPC moves them together in one transaction, and splitting them
can leave the gate with no thesis to load.

---

## 7. Design tokens

**Inherit `web/src/styles.css` unchanged.** It is the source of truth and holds the sponsor's
(Maschmeyer Group) palette. Do not re-theme; this is the sponsor's brand.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FFFFFF` | page |
| `--surface` | `#F1EEE8` | warm light-gray panel — the content-card feel |
| `--surface-2` | `#ECE7F7` | pale lavender panel |
| `--border` | `#E4E0D6` | hairlines |
| `--text` | `#0A0F3C` | deep midnight navy |
| `--text-muted` | `#5B6079` | helper text, secondary metrics |
| `--accent` | `#0A0F3C` | primary action, focus ring — squared dark-navy buttons |
| `--lavender` | `#D3C7F5` | secondary accent |
| `--warn` | `#0A0F3C` | **navy, not orange** — brand rule: limitations use a navy rule, never a warning colour |
| `--ok` | `#15803D` | confirmation only |

- **Type:** `Inter`, then system stack. Body 15px/1.6, labels 13px medium, `h1` 36px/1.12 weight
  500 at −0.02em. **Add one monospace face** (`ui-monospace`, system stack — no webfont) for every
  number, chip and score. Numbers must be tabular-figure aligned in the feed.
- **Radius:** 4/6/8/12px, default 6px. Buttons **squared**, never pill.
- **Brand device:** `.ms-rule` — a 2px navy top border, used as a section divider. Carry it into the
  dashboard as the divider between card sections. It is the signature element; keep it.
- **Elevation:** borders, never shadows.
- **Motion:** 150ms ease-out on hover/focus only. No entrance animations, no scroll effects, no
  skeleton shimmer — use a plain determinate progress indicator.
- Light theme only. A `dark` custom-variant is declared but no dark token block exists; adding one
  is not in scope.

### 7.1 New tokens this feature needs

The founder app is a form; this is a data surface. Add — and **only** these:

| Token | Value | Use |
|---|---|---|
| `--track` | `#E4E0D6` | unfilled portion of an axis bar |
| `--track-hatch` | 45° 2px hatch in `--border` | the **Not assessed** bar state (§4.3) |
| `--chip-rule` | `--text` on `--surface` | the `▦` chip |
| `--chip-model` | `--text-muted` on `--bg` + 1px `--border` | the `◇` chip |
| `--row-h` | `56px` | feed row height (see density ruling, §8.1) |

**Do not introduce a red/green/amber semantic palette.** Nothing in this product is good or bad —
it is supported, refuted, conflicting or unknown, and those are epistemic states, not alarms.
Refuted is not red. This is a deliberate and defensible design position; state it in the demo.

---

## 8. Screen 1 — `/app/feed`

The morning-triage screen. The investor's question is "which five of these 40 do I open?"

### 8.1 Layout

Two-pane, persistent left sidebar (`240px`) + content.

**Sidebar:**
- Wordmark "The VC Brain" (text only, no logo asset).
- **One feed list**, with a source **filter** above it — `All · Inbound · Radar`, defaulting to
  All. **Not three destinations.** Inbound and radar are one population with a `kind` column: every
  radar candidate already has an application row, created before the thesis gate even runs.
  Splitting them across screens re-divides at the UI layer what the schema deliberately unified,
  and it hides the product's best story — an outbound-discovered founder who never applied, scored
  by the same pipeline as an inbound one, in the same ranked list. Full reasoning in
  [`scoring-ux.md`](scoring-ux.md) §7.
- **Watchlist is a separate destination** below the feed — it is a genuinely different table with
  different semantics (alert conditions, next-check timing), not a filtered view of the same rows.
- Section header `SOURCE CHANNELS · 2 live, 3 documented` and the channel list:
  `GitHub ✓` · `Hacker News ✓` · `LinkedIn 🔒` · `X 🔒` · `Product Hunt 🔒`
  Locked channels are **clickable** and open an honest panel (§12.4). They are not decoration:
  they show the multi-channel architecture while being truthful that two channels are live.
  **Locked channels use a different glyph, not a greyed version of the live one** — greyed reads as
  "temporarily unavailable" — and **never carry a count, not even `0`**, because zero implies
  "connected and empty".
- Footer: link to `/app/thesis` showing the active thesis name.

**Content:**
- Top bar: the **NL-search field** (§8.4) and the **thesis-lens switcher**.
- Then the ranked list.

**Density ruling: roomy rows with expandable depth.** `--row-h` 56px, ~14 rows visible at 900px.
Not a spreadsheet. Each row expands in place (chevron) to a 3-line evidence preview without
navigating away — triage means scanning, and a navigation round-trip per candidate defeats it.

### 8.2 The row

Left to right:

1. Expand chevron.
2. Company name (15px `--text`) with founder name beneath (13px `--text-muted`).
3. One-line description.
4. **Four independent axis mini-bars** — `Founder` · `Market` · `Idea-vs-Market` · `Trust` —
   each 48px wide, labelled by a single letter above on the header row, each with its own trend
   arrow (▲ improving / ▼ declining / — stable). **Never a fifth combined bar.** Each bar carries
   its computation chip (§4.1) in the column header, not per row.
   Any axis with no score row renders the hatched Not-assessed track (§4.3).
5. Source badge (which channel surfaced them) + freshness ("collected 4h ago").
6. `SYNTHETIC` chip where applicable (§4.6).

Hovering a mini-bar shows value · confidence · coverage. Clicking it opens the explain panel (§4.4)
without leaving the feed.

### 8.3 The thesis lens — three lanes, frozen spec

Owned by feature 07, rendered here. Sorting is **not** a single ordering:

1. **In thesis** — verdict `passed`, sorted by `thesis_fit` descending.
2. **Outside thesis** — verdict `borderline`, down-ranked, **never hidden**. Label the lane
   "Outside thesis", not "rejected".
3. **Off-thesis but exceptional** — **pinned above both**. Verdict `borderline` *and* a
   `founder_score` at or above the thesis's `exceptional_lane.min_value`. These rows are **removed
   from** lane 2, not duplicated.

Lane 3 is a product statement and should be visually distinctive: a lane header reading
`OFF-THESIS BUT EXCEPTIONAL` with one line of copy — `Outside the stated mandate, but the founder
scores in the top band. Shown so a strong founder is never silently filtered out.`

⚠️ An **absent** `founder_score` excludes a row from lane 3 **without implying a low score** — the
scoring feature writes no row at all for insufficient evidence. The lane must not render those rows
as "didn't qualify".

Applications whose thesis evaluation is `insufficient_evidence` get their own small lane at the
bottom: `Not yet assessable` with the reason.

### 8.4 NL-search

A single wide field, placeholder:
`technical founder, Berlin, AI infra, enterprise traction, no prior VC backing, top-tier accelerator`

This is the sponsor's own benchmark query and it must resolve **in one pass** — no filter chips to
click, no advanced-search drawer, no five dropdowns. That is the requirement being demonstrated.

After a search, render **the parsed plan above the results** — the single best trust affordance on
the screen. It proves the query was understood rather than keyword-matched, and it makes a miss
debuggable by the user instead of mysterious. **Three chip classes, three glyphs:**

```
Understood:   ● technical founder → founder expertise
              ◐ Berlin → country = DE          ⓘ widened: city → country
              ● AI infra → sector = ai-infra
Not searched: ○ enterprise traction        no way to test this
              ○ no prior VC backing        no data source
              ○ top-tier accelerator       no data source
```

- **The half-filled glyph means "matched only after widening the question".** A Munich founder
  returned as a Berlin match is scope drift — the widening must be visible and must carry its
  explanation inline, using the stored `resolved_as` string verbatim. The backend guarantees that
  string is present whenever broadening is set, and a 0.75 credit multiplier exists so the widening
  *costs something in the ranking, not only in the label.*
- **Understood chips are removable. Unresolved chips are not.** Removing an already-unresolved chip
  does nothing to the query and teaches the user the wrong mental model.
- **Show the human-readable reason, never the enum** — `no_data_source` → *we hold no data of this
  kind*; `not_testable` → *no way to test this against what we hold*.

**Three of six fragments failing on the sponsor's own query is the correct behaviour**, and showing
it honestly is the point. The feature's own acceptance criterion: *the benchmark query returning no
rows is a bug; the benchmark query returning confident rows is a worse bug.*

⚠️ **Three different failure modes exist and only one is recoverable.** A fragment the resolver
declined to map, and a fragment it mapped to something outside the taxonomy, look identical to the
user — but the second **rejects the whole plan** and is not retryable. Do not render it as a
generic error. Copy it as: *"The search couldn't be interpreted safely, so nothing was run rather
than running the wrong search."* Keep the original query on screen and editable.

### 8.5 States

- **Empty feed:** `No applications yet.` plus one line pointing at the radar.
- **Empty after search:** `No founders match that description.` plus the parsed plan still visible
  and a `Clear search` action. Never a blank screen.
- **Loading:** determinate progress bar under the top bar. Rows do not shimmer.
- **Failed read:** an inline bordered notice with the API message and a `Retry` button. The
  previously loaded rows stay on screen.

---

## 9. Screen 2 — `/app/f/:applicationId` — the card

The pre-call screen. The investor has 30 minutes and needs to know where to dig.

### 9.1 Hero

- Company name, founder name(s), one-liner, source badge, `SYNTHETIC` chip if applicable.
- **The four axes, large**, each with: value, its computation chip, its trend, and
  **confidence + coverage rendered beside the value, always** (§4.5 rule 3).
- **A one-line disagreement callout when the axes disagree** — e.g.
  `The axes disagree: strong founder, weak idea-vs-market fit. That gap is the thing to probe on
  the call.` This turns the do-not-average invariant from a constraint into the card's most useful
  sentence.
- Actions: `View memo` · `Suggest follow-up questions` · overflow menu with `Delete this person's
  data` (§9.7).

### 9.2 Tabs

`Evidence` · `Market` · `Competition` · `Interview` · `What we don't know`

**Evidence** — the ledger, and the heart of the card. A dense table:

| Claim | Source | Tier | Verdict | Trust | Collected |
|---|---|---|---|---|---|

- Verdict badges use §4.2's five labels verbatim. Tier badges use the four tier words.
- `Forecast`-class claims carry the `Forecast` label instead of a verdict.
- Every row is click-through to the explain panel; the source cell is a real outbound link.
- Verbatim quotes are shown as quotes, never paraphrased.
- **Group by topic** (`founder.execution.*`, `founder.expertise.*`, `company.*`, `market.*`,
  `competition.*`), not chronologically. The investor thinks in topics.
- A filter row above: `All` · `Refuted` · `Conflicting` · `Not disclosed` · `Searched — nothing
  found`. The last filter is the one that shows diligence and should not be buried.

**Market** — category, trend arrow with cited facts beneath each, TAM sanity check, and the
bull / neutral / bear stance. Every stance is `◇` and must be chipped as such; the facts under it
are individually cited.

**Competition** — a table of competitors with threat levels. Threat level is `◇`. Each competitor
row links to its evidence.

**Interview** — the founder's gap answers, verbatim, labelled as **self-reported claims with low
base confidence**. Do **not** score them for eloquence, and do not display any writing-quality
indicator. Beneath the transcript, the mandatory next-phase teaser (§9.5).

**What we don't know** — the honesty tab, and a headline feature. Three grouped lists:
- *Searched, nothing found* — with which sources were searched and when.
- *Not checked yet* — with what would trigger a check.
- *Not disclosed* — with, for each, the stored `what_would_close_it` string rendered verbatim.

This tab should be the best-designed thing on the card, not the leftover one. It is the direct
visual answer to the sponsor's "the system is honest about what it does not know".

### 9.3 Contradictions

Surfaced as a persistent bordered strip below the hero when any exist, reading e.g.
`2 contradictions found — worth raising on the call`, expanding into the list.

**Framing rule:** contradictions on qualitative claims appear as **questions to ask**, never as
accusations. Copy pattern: `The deck says X; a public source from <date> says Y. Worth asking
about.` Never `The founder misrepresented…`.

### 9.4 Suggested follow-up questions

**No notes panel — see §6.** The `Suggest follow-up questions` action in the hero reads
the card's gaps and returns a composed question set. That composed set is shown in a
modal with an email preview and a `Send` button — **and the send is a labelled stub**: the modal
carries a small line `Not sent — email delivery is not enabled in this build.` Do not fake a sent
confirmation.

### 9.5 Next-phase teaser (mandatory)

A bordered muted card with a `NEXT PHASE` eyebrow, no interactive element inside:

```
NEXT PHASE — Interview signals

Founders will answer in their own voice. Spoken answers will be scored on a separate
axis and shown alongside the evidence we gather ourselves — never merged into it.
Hesitation, pacing and latency carry signal that written answers cannot.

Not available yet.
```

### 9.6 States

- **Not assessed axes** — the case that will be visible in the demo (§5.2). The hero renders
  hatched tracks with the label `Not assessed` and a one-line reason from the corresponding
  `*_insufficient_evidence` event.
- **No evidence at all** (a brand-new application) — the Evidence tab shows
  `Nothing collected yet. Collection runs on a schedule.` Not an error.
- **Card not found** — plain page, link back to the feed.

### 9.7 Delete-on-request (GDPR)

In the overflow menu, labelled `Delete this person's data`. Opens a confirm dialog naming exactly
what will be erased and stating it is irreversible. This is an ethics feature and a scoring one —
it should look considered, not bolted on.

---

## 10. Screen 3 — `/app/f/:applicationId/memo`

A document, not a dashboard. Single column, `max-w-[760px]`, generous leading, print-friendly.

**Required sections, in this order** (from the sponsor's brief — do not reorder, do not add):

1. Company snapshot
2. Investment hypotheses
3. SWOT
4. Problem & product
5. Traction & KPIs

Optional and included only when there is real content: risk matrix · competition · financials-lite.
**Padding counts against us — length is not rigor.** If a section has nothing to say, it says so in
one line rather than being filled.

Additional required blocks:

- **Per-claim trust badges inline in the prose.** Every factual sentence carries its verdict badge
  and is click-through to the explain panel. A memo sentence with no traceable claim behind it is a
  bug.
- **"Where to dig" block** — 5–7 deep-dive questions, each with the gap it closes stated beneath.
  This is the block that makes the memo worth reading before a call; give it real design weight.
- **Recommendation banner** — one of `Proceed` / `Proceed with conditions` / `Pass` / `Watchlist`,
  with the thesis rules that fired listed beneath it (from `fired_rules[]`, §5.6). Rules with
  `outcome: "unknown"` are listed as `could not be evaluated`, never folded into pass or miss.
  The banner uses `--surface`/`--surface-2` and a navy rule — **not a colour-coded verdict strip.**
- **Financials** — where numbers do not exist, the memo says `Cap table: not disclosed` and shows
  benchmark comparables instead. Never a fabricated figure, never an empty table.
- **Export markdown** button, top right.

Memo generation is `◇` end-to-end apart from the recommendation, which is a deterministic decision
over the axis scores, trust and thesis fit — **chip the recommendation `▦` and the prose `◇`.**
That contrast is worth pointing at in the demo: the writing is a model, the decision is a rule.

⏳ Feature 06 is not yet built. Design the memo view against this structure; when no memo row
exists, render `No memo generated yet` with a `Generate memo` action.

---

## 11. Screen 4 — `/app/thesis`

The configurable fund thesis. Its existence is a sponsor requirement — the system must not be
hardcoded to one fund.

Form sections, all editable:

- **Mandate** — `stages` (multi: `pre_seed`, `seed`), `sectors` (chips), `geographies` /
  `geos` (country codes), `risk_appetite`, `check_size_usd` {min, max}, `ownership_target_pct`.
- **Keywords** — `positive_keywords`, `negative_keywords` (chip inputs).
- **Rules** — a table of rules, each with label, kind (`deal_breaker` / `must_have` / `focus`),
  enforcement (`hard` / `soft`), weight, and an enabled toggle. Adding a rule is a small form, not
  a JSON editor.
- **Fit tuning** — `base`, `min_coverage`, `mandate_weight`, `strong_threshold`,
  `soft_deal_breaker_penalty`.
- **Exceptional lane** — `axis`, `aggregate`, `min_value`. One line of copy explaining what it does:
  `A founder scoring at or above this is shown even when the company is outside the mandate.`

Two honesty requirements:

- **Three fields are stored but do not affect scoring today** — `check_size_usd`,
  `ownership_target_pct` and **`risk_appetite`**. Label all three
  `Recorded, not yet applied to scoring` and group them in a visually demoted block. Do not let the
  UI imply they filter anything.
  ⚠️ `risk_appetite` is the one most likely to be missed: it looks like a scoring input and is not.
- **`geos` is NOT inert and must not be labelled as such.** It does nothing for the thesis rules but
  is read at runtime by market research to build search queries. Sublabel it
  `Used by market research to build search queries` and keep it in the applied group.
- **`exceptional_lane` is inert in the backend** — it is a UI-only lane spec that depends on founder
  scores existing. Until enough founders are scored, lane 3 renders empty. That is expected.
- **Publishing is versioned.** The action is `Publish new version`, not `Save`, and it shows the
  version number it will create. Follow §6's INSERT-inactive-then-RPC protocol exactly.

Changing the active thesis **re-sorts the feed live** — show that, it is a demo beat.

---

## 12. Every state that must exist

Generated apps ship the happy path only. All of these are required.

### 12.1 Not assessed
Covered in §4.3. The single most important state in this product. Hatched track, explicit label,
reason from the event, never zero, never sorted as zero.

### 12.2 Loading
Determinate progress bar, never a spinner alone for more than 2 seconds without a label. No
skeleton shimmer. Never block the whole screen for a partial read — render what has arrived.

### 12.3 Read failure
Inline bordered notice with the API `message` when present, otherwise
`Something went wrong on our side. Try again.` Previously loaded content stays. Never a raw JSON
blob or stack trace.

### 12.4 Locked source channel
Clicking a 🔒 channel opens a panel:
```
LinkedIn — not connected in this build

What it would add: employment history and role tenure, which would strengthen the
domain-expertise signal and help resolve identity across sources.

Why it is not here: it needs an access path we would not take without permission.
```
Honest, specific, and different per channel. Never the words "coming soon" alone.

### 12.5 Slow write (follow-up suggestion, memo generation)
Explicit pending state on the control, disabled while in flight, and a labelled result. **No
optimistic UI** — these call models and take real seconds; pretending otherwise is the one lie the
product cannot afford.

### 12.6 Contradiction present
§9.3's strip. Present on the card and echoed in the memo's risk section.

### 12.7 Empty everything
Every list has a designed empty state with a real sentence explaining why it is empty and what
would fill it. No blank panels, no "—".

---

## 13. Explicitly out of scope — do not build

- Any founder-facing screen. `/apply*`, `/a/:token`, `/privacy` exist and belong to feature 08.
- Login, signup, accounts, sessions, roles, permissions.
- **Any single combined score, composite, total, overall rating, or one-number gauge.**
- Portfolio monitoring, follow-on tracking, fund ops, exit analysis, cap-table mechanics, cohort
  or churn analytics. All explicitly out of the challenge scope.
- Charts for their own sake. No pie charts anywhere. No time-series unless the data has ≥3 real
  points.
- Dark theme.
- Mobile layouts.
- Notifications, email sending, real-time subscriptions, websockets.
- Any "AI is thinking" animation, typing indicator, avatar, or chat metaphor.
- Sending anything to an external host.

---

## 14. Acceptance criteria

**Structure**
- [ ] `npm install && npm run build` succeeds with no `.env` present and no network.
- [ ] No absolute URL, API key or hostname hardcoded anywhere in `src/`.
- [ ] No route `loader`, server function or prerender hook calls the API.
- [ ] Feature 08's routes and files are untouched; all new screens live under `/app/*`.
- [ ] `src/styles.css` tokens reused; only §7.1's tokens added.
- [ ] No external `<script>`, `<link>`, font CDN or image host.

**The transparency model — the ones that actually matter**
- [ ] Every rendered number carries exactly one computation chip (`▦` / `▦◇` / `◇`).
- [ ] `▦` and `◇` are distinguishable across a full feed at a glance, without colour alone.
- [ ] No screen anywhere shows a combined, average or overall score.
- [ ] The trust rollup never appears without its disagreement breakdown and coverage.
- [ ] No score value is shown or sorted without confidence and coverage beside it.
- [ ] *Not assessed*, *Not checked*, *Searched — nothing found* and *Not disclosed* are four
      visually distinct states, and none of them ever renders as `0`, an empty bar or a dash.
- [ ] Every number, badge and chip opens the explain panel, and the panel always shows evidence
      or states plainly that there is none.
- [ ] Synthetic records render the `SYNTHETIC` chip in feed row, card hero and memo header.
- [ ] Verdict and tier labels match §4.2 verbatim — no invented, renamed or merged values.
- [ ] Contradictions are phrased as questions to ask, never as accusations.
- [ ] Locked channels open an honest, channel-specific panel — never bare "coming soon".

**Flow**
- [ ] `/app` redirects to `/app/feed`.
- [ ] The three thesis lanes render per §8.3, lane 3 pinned, lane-3 rows absent from lane 2.
- [ ] NL-search renders the parsed plan above results, with unresolved attributes marked.
- [ ] Changing the active thesis re-sorts the feed without a page reload.
- [ ] Thesis publish uses INSERT-inactive-then-RPC; never a raw active INSERT.
- [ ] The memo renders the five required sections in order and nothing padded.

**Quality**
- [ ] Every state in §12 is reachable and styled.
- [ ] Full keyboard operation; visible focus rings; explain panel closes on Esc.
- [ ] Contrast ≥ 4.5:1 throughout.
- [ ] Usable at 1280px with no horizontal scrolling; 1440x900 is the design target.
- [ ] No console errors or warnings on any route.

---

## 15. Notes for whoever integrates the export

- The feed, the card and the memo are three separate reads; do not build a single god-query.
- Everything in §5 is read-only and cacheable for the session. Only §6 mutates.
- The `⏳` markers in §5 and §6 are the only places a contract may still shift. Everything else was
  frozen by the upstream features and is tested by their QA gates.
- If the clock runs out, cut in this order: thesis config form → memo export → follow-up suggestion →
  NL-search plan chips. **Never** cut the explain panel or the four not-known states — they are the
  feature.
