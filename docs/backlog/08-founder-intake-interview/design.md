# 08 · Founder Intake & Optional Gap Questions — Design

> Status: **rev.2 — awaiting operator approval.** Scope is compact option B (DEC-003).
> rev.1 went through an adversarial spec review that returned CHANGES REQUIRED with 19
> findings, 5 of them blockers; every one is folded in below and marked ⟨R-n⟩ where it changed
> a decision. Review verdict and full findings: `agents/spec-review-rev1.md`.
> Sources consulted per CLAUDE.md hard rule, all four legs, before any option was proposed:
> intel base (12 CLI queries + 11 trackers), NotebookLM ×10 (project notebook, early-stage
> framing), Exa ×11, OSS references (20 clones re-checked on disk for licence).
>
> **Operator decisions taken:** founder surface = Lovable SPA sharing one app with 09
> (`/apply*` + `/a/:token` ours, `/app/*` theirs) · gap questions presented as a plain optional
> form section, never framed as an interview · deck parsing = text-layer cascade into a vision
> fallback · local Docker only, no hosted version · payload limit raised rather than shrinking
> the upload contract ⟨R-10⟩.

## 1. What this feature is, and what it deliberately is not

The founder's entrance: a three-field application, a deck parsed into claims, and an optional
short set of questions generated from what the system could not learn on its own. Plus a
manager-initiated follow-up form delivered by share link.

**Not** an interview, not a chat, not voice, not a founder account, not a product surface.
REQ-007 is explicit that the platform belongs to the fund manager; this side is an entrance.
Every hour spent widening it is taken from features 04/05/06, where 55% of the rubric lives —
exactly the trade DEC-003 made.

### 1.1 The evidence that shaped the shape

- **A natural field experiment on 3,000+ applicants found asynchronous interview formats cut
  application continuation by over 50%, with the decline largest among the most qualified
  applicants and largest for women** (exe wp 2602, 2026-03). For a product whose thesis is
  finding people the market's filters miss, a component that filters hardest on the qualified
  contradicts its own purpose. The same study found the AI *assessment* out-predicted human
  recruiters — deterrence and accuracy are separable; we keep the second and drop the first.
- **Depth at pre-seed buys noise.** NotebookLM's corpus is consistent that AI cannot read
  resilience, vision or team dynamics; a longer question set manufactures false certainty about
  the traits it cannot measure while amplifying the conformity trap and "backward-similar" bias.

Hence: questions are **few, optional, gap-derived, never presented as an evaluation**.

### 1.2 What is genuinely novel

Across 20 OSS clones, greps for founder-facing follow-up, applicant status, and any GDPR/opt-out
concept return **zero hits**. `dealflow-questions` generates a diligence question list but ships
it to the investment team; `sieve-mcp` detects a gap and returns `'Need More Info'` for a human
to chase. **Nobody routes a machine-detected gap back to the founder as an answerable
question.** That connection is this feature's contribution.

## 2. Surfaces

| Route | Owner | What |
|---|---|---|
| `/apply` | 08 | Three required fields, optional artifacts, optional extra files |
| `/apply/questions` | 08 | 0–3 gap questions, optional, skippable ⟨R-3⟩ |
| `/apply/status` | 08 | Confirmation, timeline, honest deck-limitation notice |
| `/a/:token` | 08 | Manager-initiated follow-up questions |
| `/privacy` | 08 | Art. 14 disclosure; erasure control attaches here in feature 11 |
| `/app/*` | 09 | Investor dashboard — out of scope here |

Full UI contract, copy and states: [`lovable-brief.md`](lovable-brief.md), built and imported
into `web/`. That document is normative for the frontend; this one for the backend.

## 3. Write path — one owner, one door

**`f08-intake-submit` is the only writer of inbound applications.** The Lovable form and feature
10's CLI both call it; 10 has confirmed it will not write `applications` directly.

| # | Step | Why it is where it is |
|---|---|---|
| 1 | Validate | caps, `sanitizeFilename`, `safeWebUrl` — verbatim from `reporting` (Apache-2.0) |
| 2 | **Upload deck + extra files to Storage** ⟨R-1⟩ | `deck_storage_path` must exist before step 4 |
| 3 | Resolve or create entities (§3.1) | FKs must exist before any raw write |
| 4 | `applications` (id = `intake_submission_id`) + `cards` | ⟨R-16⟩ |
| 5 | `raw_signals(source='deck_parse')`, both FKs set | append-only: a NULL FK can never be backfilled |
| 6 | Deck cascade (§5) → `claims` + `evidence` | |
| 7 | `f07-thesis-gate`, `mode:'full'` (§3.3) | |
| 8 | `applications.status → 'screening'`, `events` | column defaults to `'sourced'` ⟨R-17⟩ |

**Why entities strictly before the raw write:** `purge_founder()` sweeps `raw_signals` only by
`founder_id`/`company_id`, and the table is append-only — a NULL FK can never be backfilled, so
the row survives an erasure request permanently. Feature 02 found 9 such orphaned rows in the
live database; it is a GDPR defect, not a tidiness one. **This rule binds the gap-answer write
path in §7 identically** ⟨R-5⟩.

### 3.0 Storage ⟨R-1, R-2⟩

Bucket **`decks`**, private. Object key `<application_id>/<sha256-16>-<sanitized_filename>`.
Since `application_id` is the client-supplied `intake_submission_id` (§3.2), the path is known
before any row is written, which is what makes step 2 possible at all.

**The bucket does not exist** — verified live, `GET /storage/v1/bucket` returns `[]`, and no
code in the repo has ever called the storage API. It is **not** created by `db/apply.sh`, so the
cold-start reset sequence in `CLAUDE.md` will not create it either. Provisioning is therefore an
explicit task (`POST /storage/v1/bucket`, `{"name":"decks","public":false}`) owned by this
feature and added to the cold-start docs.

**Extra files are uploaded first and their base64 dropped from the item immediately** ⟨R-10⟩ —
`N8N_PAYLOAD_SIZE_MAX=192` permits a ~113 MB request, and carrying that through every downstream
node would hold several copies in a container sharing 7.7 GB with Supabase.

### 3.1 Identity resolution — honest about what it does and does not guarantee ⟨R-8⟩

Resolution order, first match wins:

1. **`artifact_links` → GitHub** — a `github.com/<owner>` or `/<owner>/<repo>` URL resolves to
   `founder_identities(kind='github', value=<owner>)`. **This is the case that matters for the
   demo:** feature 02 anchors radar-discovered candidates on `kind='hn'`/`github`, and without
   this step a founder the radar already found and scored would walk into intake and become a
   second, score-less person. That is the `ayuhito` narrative breaking on its own product.
2. **Email** — `founder_identities(kind='email', value=lower(email))`, `UNIQUE(kind,value)`.
3. Otherwise create a new founder, attaching the email identity.

On a match at (1), the email identity is attached to the **existing** founder.

**What this does not solve, stated rather than claimed away:**

- A shared company inbox (`founders@acme.dev`) merges two humans into one persistent Founder
  Score. Nothing in a three-field form can detect this.
- A founder re-applying from a different address with no GitHub link creates a second row and
  loses their history. `founders.merged_into_founder_id` exists for this; merging is manual and
  out of MVP scope.

So REQ-011 ("the score follows the person") holds **for founders reachable by a public identity
or a stable address**, not universally. rev.1 claimed it was satisfied structurally; that was
overstated.

Column defaults, because a three-field form cannot supply three `NOT NULL` columns ⟨R-4⟩:
`founders.full_name` ← deck-extracted founder name, falling back to the email local-part ·
`companies.stage` ← `'pre_seed'` · `founder_company.role` ← `'founder'` ·
`companies.domain` ← **NULL** at intake, never derived from the email domain (the column is
`UNIQUE`; deriving it makes a second founder at the same company a deterministic `23505`).

### 3.2 Idempotency ⟨R-15, R-16⟩

**`applications.id := intake_submission_id`.** A retry (the frontend re-sends the same id by
design) collides on the primary key — DB-level dedup, no new index, no race, consistent with
`content_hash UNIQUE` everywhere else in this schema. rev.1 proposed a `jsonb` lookup with no
constraint behind it; that was a read-then-insert race.

Re-application is still always a **new** row: it preserves the rejection → growth → return
trajectory that SIG-025 identifies as a rare positive signal (95–99% of founders vanish after a
first "no").

Consequently **every content hash 08 writes includes the `application_id`** — `raw_signals`,
`claims` and `evidence` all carry `content_hash NOT NULL UNIQUE`, and a founder re-applying with
the same deck would otherwise raise `23505` and fail the whole intake. A retry still dedupes
(same application id); a re-application does not (different one).

### 3.3 Calling the thesis gate ⟨R-17⟩

`mode:'full'` with the extracted deck text. On the `extraction_mode='none'` branch we send an
empty string: the gate returns `insufficient_evidence` and writes `thesis_gate = NULL`, which is
a reachable, correct, documented state (07 handoff §2) — recorded here as a deliberate choice,
not discovered at build time. 07's caller obligation (fold contradicted-claim fields into
`missing_fields` before calling) is trivially satisfied at intake, where no claim has been
contradicted yet.

## 4. Claim ownership

07 writes `company.*` claims (`sector`, `business_model`, `geography_country`, `stage_evidence`,
`what_is_built`) on **every** `mode:'full'` gate call, from the same deck text. **08 therefore
never writes `company.*`** — we write `founder.expertise.*` and `founder.leadership.*` only,
the territory of criteria X1, X2, X5, L2, L3. Vocabulary is 03's (design §4.7), already used by
02, so no new prefix and exactly one writer per topic family.

### 4.0 Per-criterion topic vocabulary — pinned here, because nothing else pins it

03's design §4.7 defines only **prefix**-level routing, never per-criterion slugs, and 03's own
fixture never exercises L2/L3/X5. These three strings are load-bearing: the coverage check in §6
matches on them, so a mismatch silently means gap questions are never suppressed even after they
are answered.

| Criterion | `claims.topic` |
|---|---|
| L2 | `founder.leadership.first_customers` |
| L3 | `founder.leadership.icp_specificity` |
| X5 | `founder.expertise.competitor_granularity` |

Confidence in these is better than "someone chose them": the extractor agent spec and the
selection module arrived at identical strings independently, and they match the house style of the
slugs 02 already writes at volume (`vertical_tenure`, `insight_specificity`, `unasked_work`).

**Live-database audit, 2026-07-19.** The canonical slugs dominate (66–124 claims each). Neither
`first_customers` nor `icp_specificity` appears **at all** — which is the design's own thesis
showing up in the data: no public source can reach L2 or L3, and 02 is so far the only writer.
Twelve claims sit under near-miss variants (`leadership.customers` ×2, `leadership.icp` ×2,
`expertise.competitors` ×1, …) — free-form leakage from LLM output. Matching stays **exact**: the
error is asymmetric, since a missed match costs one redundant question while a loose match
suppresses a question that needed asking.

Traction claims are restricted to those that actually anchor **L2 or L3** ⟨R-9⟩:
`topic_routing.prefix_map` routes every `founder.leadership.*` claim into the
`leadership-sales-proxies` sub-scorer at `max_claims_per_agent: 40`, so generic traction claims
would dilute that context pack rather than inform it.

**Every claim carries ≥1 `evidence` row with `raw_signal_id` populated** ⟨R-6⟩, including the
`missing` marker for an unreadable deck (`tier='missing'`). Deck-derived claims use
`source_kind='self_reported'`, **never `'public'`** — 03's negative-capability fallback maps
`'public'` to "any source (wildcard)", so a single evidence-less public claim licenses `not_met`
across every criterion, inverting REQ-003.

**Team composition is out of scope for the MVP** ⟨R-9⟩, stated rather than left implicit. 07's
topics do not include it and 08 does not add it, so co-founders named on a deck's team slide are
extracted by nobody and the memo renders team background as a gap. Consequence to be aware of:
`founder_company` gets one row per intake company, so every inbound company is "sole-founder" in
`purge_founder()`'s sense and the multi-founder branch of erasure is untravelled on this track.

`applications.artifact_links` is extended **additively only** (02 froze the shape): `source:
'intake_form'`, `intake_submission_id`, `founder_links[]`, `deck_filename`. Inbound rows
legitimately have **no `hn_item_id`**; consumers keying on it must tolerate its absence.

**Schema changes: none** — but that claim is about DDL only. Two operational prerequisites are
not schema and must not be skipped: the `decks` bucket (§3.0) and `N8N_PAYLOAD_SIZE_MAX` (§5.1).

### 4.1 What erasure reaches, and what it does not ⟨R-5⟩

`purge_founder()` sweeps `raw_signals`, `events`, `ai_runs` and the application subtree. To stay
inside its reach, 08 commits to:

- **every `events` row uses `entity_type='founder'` + the founder id** — the sweep matches
  nothing else (02 cross-feature rule 2), and an `entity_type='application'` row would carry the
  company name permanently out of reach;
- **every `ai_runs` row carries `application_id` and `founder_id`**;
- **gap-answer `raw_signals` carry both FKs at insert**, exactly as the deck write does.

**Known limitation, disclosed not hidden:** `purge_founder()` does not delete Storage objects.
The deck — containing the founder's name and email — survives erasure, and because the
`applications` row holding `deck_storage_path` is deleted, the file becomes unfindable as well
as undeleted. The honest fix is a companion storage sweep keyed on the `<application_id>/`
prefix; whether it ships in MVP is a build-time call, and if it does not, it is stated in the
feature's `done.md` rather than left for a judge to find.

## 5. Deck parsing — a cascade whose honesty is the point

Verified on the live n8n 2.30.7 instance: `ExtractFromFile` supports pdf, csv, html, json, ics,
ods, rtf, text, xls/xlsx, xml — **no pptx, no docx** — and its PDF path reads the text layer only.

```
base64 → Convert to File (binary) → ExtractFromFile (text layer)
    → chars < threshold?  ── no ──→ extraction_mode = 'text_layer'
              │ yes
              ↓
      pages as images → multimodal model → extraction_mode = 'vision'
              │ still nothing
              ↓
      extraction_mode = 'none', warning = 'image_only_deck'
```

Cascade shape from `Deal_flow_analyzer` (MIT), second stage swapped to a vision model per
`reporting` (Apache-2.0). Both stages stay inside n8n; no backend service needed.

**`extraction_mode` is stored on every claim and caps its confidence.** Measured accuracy is
72–80% from a text layer against 56–64% from images alone, dropping to ~4% on
extract-then-compute tasks across frontier models. Two non-negotiable consequences:

1. **The extractor never computes a derived metric.** Stated values are stored verbatim with
   their span. Both documented frontier failure modes compound: read the wrong value, then apply
   the wrong operation to it.
2. **Confidence comes from the evidence, never the model's self-report.** Minimum signal: does
   the extracted string appear verbatim in the source? No supporting span → near-zero confidence
   and a hallucination flag. LLM self-reported confidence is uncalibrated — models assign 0.9+
   to fabricated fields.

An image-only deck is stored, labelled, and written as a `missing` claim **with evidence**
(§4). Declaring that we could not read it scores better against the rubric's Data criterion
("honest about what it does not know") than silently demoing only clean text PDFs.

Non-PDF extra files are stored and labelled "not parsed in this version" (DEC-003 permits this
explicitly), never implied to be analysed.

### 5.1 n8n mechanics that the build hits immediately ⟨R-18⟩

- **base64 → binary:** `ExtractFromFile` reads a binary property; the contract delivers base64
  in JSON. A `Convert to File` node sits between webhook and extractor.
- **CORS:** the SPA runs on its own dev-server origin and posts to `localhost:5678`. Verified on
  the live container: `N8N_CORS_ALLOW_ORIGIN` is **not set**. Without it every call fails in the
  browser and nowhere else — curl tests stay green, which is what makes this expensive to find.
- **`N8N_PAYLOAD_SIZE_MAX=192`** ⟨R-10⟩ — also not currently set (default 16 MB). Both go into
  `infra/n8n/docker-compose.yml`, which is a **shared file**: announce in `docs/backlog/TRACKER.md`
  before editing.
- **`rate_limited`** is a frozen error code with nothing behind it yet; implemented as a simple
  per-email counter in the workflow, or the code is removed from the contract.

## 6. Gap questions — deterministic selection, LLM only for phrasing

**Selection is code, not a model.** Read `score_formulas.config.criteria` (a jsonb **array**,
filtered to `axis='founder_score' AND active`); take criteria whose `neg_src` contains **only**
`deck_parse` and `interview_answer`; drop any already covered; rank by `weight`.

Against the live seeded config, exactly **three** criteria qualify ⟨R-3⟩:

| Criterion | Weight | Anchor |
|---|---|---|
| L2 | 0.15000 | First customers / LOI / pilot evidence |
| L3 | 0.09000 | ICP specificity: vertical + size + buyer role + trigger + alternative |
| X5 | 0.05625 | Competitors at insider granularity |

X1 (0.09375) and X2 (0.07500) carry `tavily_extract` in `neg_src` — public sources can reach
them, so they fail this rule and are **not** asked. rev.1 listed all five while its own
arithmetic (0.296 = 0.05625 + 0.15 + 0.09) described only three; the table was wrong, the rule
was right.

**0.296 of the founder-score weight is unreachable by any public source.** The radar's own proof
(`ayuhito`: 60.76, coverage 0.395 against a 0.704 ceiling) is limited by exactly these criteria.
Three questions are not decoration — they are the mechanism that lifts coverage, measurably, on
screen. So `gap_questions` is `0..3`, never 5; the frontend copy already says "at most three"
and needs no change.

**The coverage check excludes claims with `verification_status='missing'`** ⟨R-7⟩. 07 writes gap
markers as claims on every full gate call, so a naive "does a claim exist for this topic?" would
read an explicit *absence* marker as coverage and suppress precisely the question worth asking.
Convention tie-break: `07/design.md:734` is authoritative — **base topic + `verification_status
='missing'`**, and it states the `.gap` suffix in `07/handoff.md` §4 was wrong. Handle both
shapes defensively.

Why deterministic selection beyond speed: it makes the choice explainable and immune to
eloquence, and implements the Information Gain rule NotebookLM surfaced — ask only where the
answer moves the decision.

**Never asked**, per NotebookLM and Exa both: TAM, revenue projections, competitor lists,
anything forward-looking. Asking a founder to invent a number is zero information gain, and
feature 04 synthesises those independently anyway.

### 6.1 `card_completeness` ⟨R-12⟩

Closed here rather than left open, because the frontend contract returns it.

`cards.completeness` = **covered weight ÷ reachable weight**, over the three-criterion set
above. It is **08's number and not 03's `coverage`** — 03 computes coverage across all twelve
criteria against a 0.704 public ceiling. The two must never be rendered as the same quantity;
the dashboard shows this one as "how complete your card is", not as a score.

## 7. AI components (specified via `ai-agent-builder`, per the mandate)

| Agent | Input | Output | Notes |
|---|---|---|---|
| `deck-claims-extractor` | deck text or page images + `extraction_mode` | claims with verbatim spans | binary/structured extraction, never a 1–10 grade; no derived metrics; span-grounded confidence |
| `gap-question-phraser` | selected criteria (id, anchor, weight) + card context | `{criterion_id, question, why, placeholder}` ×0–3 ⟨R-11⟩ | Mom Test register: past behaviour and structural facts, never opinions or promises |

`placeholder` is frontend-visible (`lovable-brief.md` §7.2 renders it on the textarea) and is
therefore part of the agent's output schema, not an afterthought.

Answers land as claims with `source_kind='interview'`, low base confidence, `text_verbatim`
preserved word-for-word (REC-009 / RSK-003 — LLM paraphrase re-centres outliers toward the
median and can invert meaning), each with an `evidence` row pointing at its `raw_signal`, and
**that raw_signal carries both FKs at insert** (§4.1).

Every model call writes `ai_runs` first; target tables are written only after validation passes
("model proposes, backend decides"). `gpt-5.6-luna` rejects `temperature: 0` — omit the
parameter entirely rather than sending 0.

## 8. Persisting what was asked ⟨R-13⟩

Every generated question set is written to **`interviews.transcript`** with per-question
answered/skipped state: `kind='first'` for the intake set, `kind='follow_up'` for the
manager-initiated one. Without this, `open_questions` in the status contract and `questions[]`
in the follow-up contract have no source — the frontend passes them in router state, which by
design does not survive the refresh the brief requires.

## 9. Follow-up by share link

Manager leaves notes on the card → the system proposes questions → a share link is generated.
**Email delivery is mocked** (STUB-001, SCOPE-003): the composed message and link are shown in
the UI, nothing is sent.

Token handling at the floor the research sets: 32 bytes from a CSPRNG; **only the SHA-256 hash
is stored** in `interviews.share_token` (`text UNIQUE`, compatible with a hex digest); 24h
validity derived from `created_at` (signup-class, not login-class); **consumed on POST, never on
GET**, because corporate mail scanners prefetch links and would silently burn them. "Consumed"
is `interviews.status='completed'`, which is also what `already_answered` reads.

Deliberately **not** device-bound: founders open links on a different device than the request
came from. Stated rather than defaulted into.

Honest limitation for the judges: with email mocked we can demonstrate token mechanics but
cannot exercise the failure modes that actually break magic-link systems, which are
email-channel problems.

## 10. Guardrails — the list QA verifies one by one

1. AI involvement disclosed up front, verbatim copy, non-dismissible (EU AI Act transparency).
2. A human reviews before any decision; **the system never issues an AI rejection.**
3. Questions come only from real card gaps — no fixed question set.
4. Pre-filled from the public footprint; the founder confirms rather than retypes.
5. Optional and never a gate; skipping is one click, with no friction or guilt prompt.
6. Duration stated up front; question count visible before starting.
7. **Skip → confidence down, score untouched** (REQ-003). Penalising a skip is the one-sided
   label-noise trap: it conflates stealth with failure, and heads-down builders are exactly the
   population we are trying not to lose.
8. Answers **never scored for eloquence** (SIG-018): scored on whether they yield checkable
   claims — a name, a number, a date.
9. **No AI-text detector anywhere.** Best available accuracy is unusable (9% FPR at 26% TPR when
   OpenAI withdrew its own), polished-human text is indistinguishable from generated, and errors
   land disproportionately on non-native English speakers — precisely the population a
   cold-start global sourcing product must not penalise.
10. Outcome shown immediately; the 24h answer is the product's promise to the founder.

**Known tension, recorded rather than resolved:** gap-driven questions are inherently
criteria-transparent ("your deck doesn't state X" reveals what is scored), and disclosed criteria
measurably increase deceptive impression management. We accept it: the transparency serves the
founder, and defences against gaming live in evidence verification (feature 05), not in question
phrasing.

## 11. Boundaries & stubs

| Item | Status |
|---|---|
| Email sending | Mocked — composed message + link shown (STUB-001) |
| Non-PDF uploads | Stored, honestly labelled unparsed (DEC-003) |
| Voice input / TTS | Not built. Static next-phase panel only |
| AI Interview | UI teaser, explicitly next-phase |
| Founder auth | None. Share tokens only |
| Team composition | Out of scope; memo renders it as a gap ⟨R-9⟩ |
| Storage erasure | Not swept by `purge_founder()`; disclosed (§4.1) ⟨R-5⟩ |
| Opt-out control | Disclosure text here; the erasure control is feature 11's |
| References | "Unavailable at this stage" (STUB-003) |

**The privacy page's contact channel** ⟨R-14⟩: `lovable-brief.md` §10 currently routes erasure
requests to "reply to the confirmation email you received" — and email is mocked, so that channel
does not exist. This is the one page making legal commitments, and a judge will read it. Copy is
corrected to name the channel that exists in this build; feature 11 attaches the actual control
to the same page.

**On the teaser panel, honestly:** IDEA-002 carries an unresolved review flag in the intel base —
Carl never endorsed the AI-interview idea, he redirected to REQ-001 ("must work without a call").
The async gap questions are compatible with that. The teaser is an operator decision with no
sponsor backing, so it is framed as a future phase and nothing judged depends on it.

## 12. Open items

- Threshold for the text-layer → vision fallback: set empirically during build against the demo
  decks, not guessed here.
- Whether the Storage erasure sweep (§4.1) ships in MVP or is disclosed as a limitation.
- The feature README's body still describes the superseded full-cycle plan (voice, real email,
  chat interview) and contradicts its own header. Rewrite before close — it will mis-drive any
  agent that reads it.
