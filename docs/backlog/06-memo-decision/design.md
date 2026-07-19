# 06 · Investment Memo & $100K Decision — Design

> Status: **draft, rev 2 (spec-review round 1 applied)** · Owner: feature-06 terminal · Depends on:
> 03, 04, 05, 07, 10 (all done, outputs live). Reconciled against the live DB and the frozen
> upstream contracts on 2026-07-19. This document is the source of truth for the `generate-memo`
> workflow and for the **`memos` row shape that feature 09 renders** (§4 is a frozen cross-feature
> contract, announced in `docs/backlog/TRACKER.md`).
>
> **Rev-2 changelog** (spec-review afd8d4f + research memo-research): pack propagation fixed (§5);
> financials/not-disclosed honesty decoupled from the drop-first LLM stage (§4.2/§5.3); decision
> node reworked into a 6-rule ordered cascade with a principled `pass` floor (§8); citation gate +
> `cited_claim_ids` now cover **every** `claim_ids[]` in the row (§9); typed-exception loophole
> closed (§9); contradiction/competition reads scoped and reconciled (§3.9/§3.10);
> `thesis_fired_rules` snapshotted for banner reproducibility (§4.4); LLM writers explicitly barred
> from emitting the recommendation verb (§6); `alwaysOutputData` on empty-normal selects (§9/§11).

> **Rev-2.1 addendum** (Exa + NotebookLM pass, both strongly confirm rev 2; NBLM independently
> reproduced the cascade): (a) a **fatal-contradiction tier** — an objectively-confirmed material
> *factual* fabrication routes to `pass`, not `watchlist` (§8 D1b); (b) framed explicitly as a
> pre-seed **deal memo** (1-2 pp), not a formal IC memo — our strongest anti-padding stance (§1);
> (c) an explicit, judge-facing note that we **reject proxy-valuation** of missing financials on
> purpose (§4.1); (d) the decision `rationale` must narrate *why* across disagreeing axes, rendering
> the deterministic node's own reasoning (§8). External validation (no change): `presidio-hardened-
> angellist` 4-tier pre-seed rubric maps ~1:1 to our vocab; NuScore "rules anchor the floor, ranking
> lives upstream" confirms our hybrid.

## 1. What this builds

A pre-seed **deal memo** (1-2 pages, required sections only — deliberately *not* a formal 8-20 pp IC
memo; that framing is our anti-padding defence, I5) plus a deterministic $100K recommendation.
One n8n workflow, **`f06-generate-memo`**, triggered per application, that:

1. Gathers a deterministic **context pack** from the live read surfaces (§3).
2. Writes the five **required** memo sections + the three **optional** ones, each sentence traced
   to `claim_id`s only — a section-writer **cannot introduce an uncited fact** (§6, §9).
3. Derives **5–7 deep-dive questions** from the gaps and contradictions (§7).
4. Runs a **deterministic decision node** (no LLM) over the axis scores + trust + thesis fit →
   one of `proceed | proceed-with-conditions | pass | watchlist` + conditions + $100K rationale (§8).
5. Validates that every cited claim exists in the pack, assembles the `memos` row, computes the
   next `version`, and INSERTs it (§9).

The memo **screen** (`/app/f/:applicationId/memo`) is **not ours** — feature 09 builds it against
the §4 contract. We write rows; 09 reads them. We touch only `n8n/workflows/f06-*`, `lib/f06/`,
`docs/backlog/06-memo-decision/`.

## 2. Invariants (binding — breaking any loses rubric points)

- **I1. Three screening axes are never averaged.** `founder`, `market`, `idea_vs_market` enter the
  decision and the memo independently; disagreement is shown as-is. No `overall_score` anywhere
  (schema smoke tests raise on an axis named `overall`/`total`/`combined`).
- **I2. Absent ≠ zero.** A missing score row means *not assessed* — a distinct state, never 0, never
  a penalty for our honesty about ignorance.
- **I3. Trust is per-claim.** Every factual statement carries a `claim_id`; 09 resolves its
  `derived_status` badge live from `claim_trust`. A `fact` statement with no claim is a bug; the only
  claim-free statements are the explicitly typed `not_disclosed` / `benchmark` / `structural` (§4.1),
  and those are guarded against smuggling facts (§9).
- **I4. No fabrication.** No financials/cap-table → literal `Cap table: not disclosed` (guaranteed
  in `gaps.not_disclosed`, computed deterministically — §4.2) + benchmark comparables as a labelled
  *range, not a valuation* (§4.1). Never invent a number or a table.
- **I5. Padding counts against us.** A section with nothing to say says so in one line. Length ≠ rigor.
- **I6. Decision node is deterministic.** Recommendation is a rule over numbers, not an LLM call.
  **The LLM section-writers are barred from emitting the recommendation verb at all** (§6) — only the
  rule engine produces it. (OSS `reporting` bans an LLM final recommendation outright; we survive
  that critique only because ours is rules + framed as *recommendation ≠ decision*, REQ-001.)
- **I7. Required sections only** are guaranteed present: `snapshot`, `hypotheses`, `swot`,
  `problem_product`, `traction` (matches `memos_sections_check`). Optional sections appear only when
  their inputs exist.
- **I8. Recommendation vocabulary is exactly** `proceed | proceed-with-conditions | pass |
    watchlist` (hyphens). Constraint migrated + verified live (operator ruling 12:20). External
    anchor: OSS `reporting/rubric.yaml` conventional options map 1:1 — *Strong yes → proceed to IC*
    / *Yes with conditions* / *Pass — track* / *Pass* (Apache-2.0).

## 3. Inputs — the context pack (deterministic, zero-LLM)

All reads go through PostgREST at `$env.SUPABASE_URL` (already ends in `/rest/v1`) with the
service-role key, mirroring the f04/f05 `pg()` helper. **Every empty-select branch below is a
NORMAL path here, not an error** — the version read is empty at v1, the trust read is empty when
trust is unassessed, the claims read is empty for an empty-pack memo. Each such node sets
`alwaysOutputData` so an empty result does not kill the branch (the f04 05:20–06:20 bug class).

| # | What | Read | Resolution rule |
|---|---|---|---|
| 3.1 | Application + company | `api_applications?application_id=eq.<id>` (one row) | Source of `company_name`, `stage`, `category`, `kind`, `status`, `artifact_links`, `thesis_*`, `score_*`, `is_synthetic`, `memo_version`. Not-found ⇒ error envelope, no write. |
| 3.2 | Three screening axes | from 3.1: `score_founder`, `score_market`, `score_idea_vs_market` (jsonb `{value,trend,confidence,missing,assessed}`) | Use `assessed` verbatim. `assessed=false` ⇒ **not assessed**, `value` NULL. **Never coerce to 0.** (`score_founder.assessed` is `false` on every app today — expect it.) |
| 3.3 | Person founder score | `api_founders?application_id=eq.<id>` → `founder_score`, `_trend`, `_confidence`, `founder_score_gaps` (raw `[{criterion_id,what_would_close_it}]`) | Distinct subject from the `founder` axis (§F5). NULL ⇒ not assessed. **Teams have several rows for one application** — keep all founder-ids (used in 3.9). |
| 3.4 | Trust axis | `scores?application_id=eq.<id>&axis=eq.trust&order=computed_at.desc,id.desc&limit=1` | `api_applications` does **not** expose trust — read `scores` directly. No row ⇒ trust not assessed. `value`, `confidence`, and `missing_flags.coverage`. **Documented exception to the "never parse `missing_flags` raw" guard**: trust has no `api_*` view, so `coverage` is read from the raw object here (only `.coverage`, no `_`-prefixed keys). |
| 3.5 | Thesis fit | from 3.1: `thesis_verdict`, `thesis_fit`, `thesis_coverage`, `thesis_missing_fields`, `thesis_fired_rules` | `api_applications` already resolves the **stale-thesis trap** (latest eval; `score_id IS NULL`/`insufficient_evidence` ⇒ NULL fit). Use it — do not re-derive from `scores`. |
| 3.6 | Claims + evidence | `api_claims?application_id=eq.<id>&order=created_at.desc` **UNION** `api_claims?founder_id=in.(<founder-id set from 3.3>)` (paged, cap 1000, deduped by `claim_id`) | The corpus of citable facts: `topic`, `text_verbatim`, `value`, `source_kind`, `evidence[]` (with `source_url`). This defines the **allowed claim-id set** (§9). **The founder-scoped union is load-bearing:** `cards.application_id` is nullable and founder-provenance claims are normally queried by `founder_id`, so a founder-scoped contradiction (§3.9) can reference a claim whose card has `application_id NULL`. Without the union, §9.1's hard citation gate would reject the whole memo on that pack-sourced id. The union makes `allowed_claim_ids` a **superset** of everything §3.9/§8 can reference. |
| 3.7 | Per-claim trust | `claim_trust?claim_id=in.(<ids from 3.6>)` | `derived_status` (authoritative), `router_class`, `trust`, `n_contradicts`, `n_independent`. Joined to 3.6 by `claim_id`. **Read `derived_status`, never `claims.verification_status`.** |
| 3.8 | Honest gaps | subset of 3.6 where `verification_status='missing'` (served, never filtered) + `missing` arrays from 3.2 + `thesis_missing_fields` + `founder_score_gaps` | Become the memo's honest-gaps (§4.2) and feed deep-dive questions. |
| 3.9 | Contradictions | **(a)** `events?event_type=eq.claim_contradicted&entity_type=eq.founder&entity_id=in.(<founder-id set from 3.3>)` **and** `…&entity_type=eq.application&entity_id=eq.<application_id>` — **query BOTH shapes** (company claims are written under `entity_type='founder'`), scoped by id, and cover **all co-founders**. **(b)** claims from 3.7 where `derived_status ∈ {contradicted, partially_supported}`. | The event payload is the richest object in the system (`nature`, `severity`, `founder_claim`, `found_reality`, `question`). **`material` (§8) = any `derived_status='contradicted'` (documented-tier by construction) OR any event with `severity='material'`** — source (b) has no `severity` field, so a documented contradiction counts as material even without an event. **`fatal` (§8 D1b) = an event with `nature='factual'` AND `severity='material'`** (a proven false material claim — fabrication / AI-washing / claim-to-code delta / related-party). Source (b) has no `nature`, so it can never be classed fatal — the conservative default (a documented contradiction with no event stays evidentiary → watchlist, never an auto-`pass`). The pack exposes both `material_contradictions` and `fatal_contradictions` counts. |
| 3.10 | Competition | subset of 3.6 where `topic IN ('competition.competitor','competition.status_quo_alternative','competition.founder_claim_mismatch')` | `competition.competitor.value.company_mentioned` → renamed **`named_by_founder`** in the memo (do not invent a source field). `status_quo_alternative` ("the real competitor is a spreadsheet") renders as a statement. A competitor the founder did **not** name is the high-value output — flagged separately. |

**`scores` duplicates exist** — "current" is always `ORDER BY computed_at DESC, id DESC LIMIT 1`
(3.4). `computed_at` alone can tie inside one execution.

## 4. FROZEN CONTRACT — the `memos` row shape (feature 09 renders this)

DB shape is fixed (`memos` DDL): `sections jsonb` (must contain the 5 required keys), `gaps jsonb`,
`cited_claim_ids uuid[]`, `recommendation text` (4-value CHECK), `conditions jsonb`,
`deep_dive_questions jsonb`, `version int` (we compute next), append-only. **No new columns needed.**
This section freezes the jsonb shapes inside those columns.

### 4.1 `sections` — the memo body

The unit of prose is a **statement** so 09 can attach a per-sentence trust badge + click-through
(I3). Modelled on OSS `reporting`'s `paragraph_record` (Apache-2.0): a statement carries its sources
and its type; the `contains_projection/unverified/contradiction` booleans `reporting` stores are
**derived live** by 09 from `claim_trust.derived_status`, so we don't duplicate them.

```jsonc
// statement — the atomic renderable unit
{ "text": "Merged 40+ PRs into PyTorch over 18 months.",
  "claim_ids": ["<uuid>", ...],          // ⩾1 for kind:"fact"; [] only for the typed exceptions
  "kind": "fact" | "not_disclosed" | "benchmark" | "structural" }
```

- `fact` — claim-backed assertion. `claim_ids` non-empty, **every id ∈ the pack's allowed set** (§9
  rejects otherwise). 09 renders the `derived_status` badge.
- `not_disclosed` — an honest absence (`"Cap table: not disclosed."`). `claim_ids` may be `[]`.
- `benchmark` — a comparable used in place of a missing number, phrased as a **labelled range, never
  a point valuation**: `"Comparable pre-seed AI-infra rounds in 2025 closed at ~$8–12M post (range,
  not a valuation; survivorship-biased)."` `claim_ids` `[]`; rendered as a neutral comparable.
  **Deliberate rejection, stated so judges see it is a choice:** an academic approach (NBLM) argues
  for *inferring* a pre-money valuation from non-financial proxies (investor social capital, expected
  syndicate size) when financials are absent. We reject it — it smuggles unverifiable proxies and
  violates I4 (honesty > fabrication). A caveated range is context; an inferred valuation is a
  fabricated number.
- `structural` — connective prose with **no factual assertion**. Used sparingly.

```jsonc
"sections": {
  "snapshot":        { "statements": [ <statement>, ... ] },   // what/who-for/where, stage, $100K ask, one-line thesis-fit
  "hypotheses":      { "statements": [ ... ] },                // value mechanism + why-now, each a statement
  "swot":            { "strengths":  [ <statement>, ... ],
                       "weaknesses": [ ... ], "opportunities": [ ... ], "threats": [ ... ] },
  "problem_product": { "statements": [ ... ] },                // what EXISTS (live URL/repo) vs claimed/roadmap
  "traction":        { "statements": [ ... ] },                // HARD split: company-stated vs verified; unverified keeps its badge, never dropped
  // ── optional, present only when inputs exist (I7); absent key ⇒ 09 renders nothing ──
  "risk_matrix":     { "risks": [ { "text": "...", "severity": "minor|moderate|material",
                                    "likelihood": "low|medium|high", "claim_ids": [ ... ] }, ... ] },
  "competition":     { "statements": [ ... ],
                       "competitors": [ { "name": "...", "named_by_founder": true|false,
                                          "claim_ids": [ ... ] }, ... ] },
  "financials_lite": { "statements": [ ... ] }                 // benchmark + not_disclosed statements only
}
```

**Empty-but-required rule (I5):** a required section with nothing to say ships exactly one
`structural` statement (e.g. `"Traction: nothing verifiable disclosed at this stage."`) — never an
empty array, never padding.

### 4.2 `gaps` — the honest what-we-don't-know block (Stage-1, deterministic)

Computed in `[A]`/`[D]` without the LLM, so the I4 not-disclosed guarantee **survives even if the
optional LLM sections are dropped** for the clock.

```jsonc
"gaps": {
  "not_disclosed":  [ { "topic": "financials", "text": "Cap table: not disclosed." }, ... ],
  "missing_axes":   [ "founder", "trust" ],            // axes with assessed=false / no row
  "missing_fields": [ "stage_evidence", ... ],         // union of thesis_missing_fields + founder_score_gaps criteria
  "low_coverage":   { "trust": 0.31, "thesis": null }, // numeric where known, null when N/A
  "contradictions": [ { "claim_id": "<uuid>", "severity": "material",
                        "nature": "temporal", "topic": "founder.execution.provenance" }, ... ]
}
```

**`not_disclosed` trigger set (deterministic, so I4 is guaranteed):** `[A]`/`[D]` always emit a
`not_disclosed` line for each of a fixed topic list that has no supporting claim — at minimum
`financials` (`"Cap table: not disclosed."`) and `revenue`; extended by any `thesis_missing_fields`
/ `founder_score_gaps` topic that maps to a disclosure gap. The list is a named constant so the
guarantee does not depend on the LLM.

**09's Financials block reads `sections.financials_lite` when present, else falls back to
`gaps.not_disclosed` entries with `topic='financials'`** — so "Cap table: not disclosed" always
renders (announced to 09 in TRACKER).

### 4.3 `deep_dive_questions` — the "Where to dig" block

```jsonc
"deep_dive_questions": [
  { "question": "Walk us through your work history in retail analytics prior to 2021.",
    "closes_gap": "Resolves the provenance contradiction between the deck and Companies House.",
    "gap_kind": "contradiction" | "missing" | "ambiguous",
    "claim_ids": [ "<uuid>", ... ] },                  // may be []; if non-empty, gate-validated (§9)
  ... 5–7 items
]
```

### 4.4 `conditions` — decision rationale + $100K conditions

The `$100K` figure has no schema column (§F3); it lives here. **`thesis_fired_rules` is snapshotted**
so the recommendation banner is reproducible from the immutable memo (the live thesis eval can change
after generation — the stale-thesis trap in reverse). 09 renders the banner's fired rules **from this
snapshot, not live** `api_applications`.

```jsonc
// Example is self-consistent with §8: no material contradiction (D2 would fire watchlist otherwise),
// idea_vs_market and trust below their STRONG thresholds → D6 proceed-with-conditions.
"conditions": {
  "check_size_usd": 100000,
  "rationale": "Thesis passed and market is strong; idea-market fit (55) and trust (55) are middling
                and no material contradiction stands — proceed, conditioned on closing those two.",
  "items": [ { "text": "Diligence idea-market fit: currently 55 — pressure-test the wedge with 3 design partners.",
               "closes": "idea_vs_market below strong threshold",
               "claim_ids": [ "<uuid>" ] },
             { "text": "Raise evidence coverage on the two low-trust traction topics before wiring the check.",
               "closes": "trust 55, coverage 0.67",
               "claim_ids": [ "<uuid>" ] } ],           // [] for pass / clean proceed
  "decision_inputs": {                                   // traceability snapshot — exact numbers the RULE saw
    "thesis_verdict": "passed", "thesis_fit": 71.0,
    "thesis_fired_rules": [ /* verbatim snapshot of §3.5 fired_rules[] */ ],
    "axes": { "founder": null, "market": 68.0, "idea_vs_market": 55.0 },
    "founder_score": 34.0, "trust": 55.0, "trust_coverage": 0.667, "trust_confidence": 0.61,
    "material_contradictions": 0, "rule_fired": "D6" },
  "thresholds_version": "f06-2026.07"
}
```

`recommendation` = one of the four strings (top-level column, **always non-null from us** — §8 is
total; the DB column is nullable but the guarantee is app-level). `cited_claim_ids` = the deduped
union of **every** `claim_ids` appearing anywhere in the row — `sections`, `deep_dive_questions`,
`conditions.items`, `gaps.contradictions` — so 09/10 resolve the whole ledger in one read (§9.4).

## 5. Workflow architecture — `f06-generate-memo`

Built by the **same Python generator pattern** as f04/f05 (`n8n/build-f06-workflow.py`): lib logic
in `lib/f06/*.js` (unit-tested `node --test`), inlined **verbatim** into Code nodes (sandbox can't
`require()` repo files). Code nodes may `require('crypto')` (bare specifier); `crypto.subtle`/`URL`
need the polyfill snippet if used. Structured LLM output runs through a recursive `strictify()` at
embed time (else opaque HTTP 400 — TRACKER 11:20).

```
Webhook  POST /webhook/f06-generate-memo  { application_id, thesis_id? }
  │
  ▼
[A] Context pack        Code, deterministic — §3 reads; assembles the pack + allowed_claim_ids +
  │                     gaps (§4.2). Early-exit on app-not-found. RETURNS the full pack as one item.
  ├───────────────┬───────────────┬───────────────┬───────────────┐
  ▼               ▼               ▼               ▼               (each Bi main-input = [A]'s pack)
[B1] Descriptive  [B2] Analytical [B3] Optional   [B4] Deep-dive
  snapshot·         hypotheses·     risk_matrix·    questions (§7)
  problem_product·  swot            competition·
  traction          (LLM luna)      financials_lite (LLM luna)
  (LLM luna)                        (LLM luna;
                                     sentinel {} if
                                     no inputs — §5.3)
  │               │               │               │
  └───────────────┴──────┬────────┴───────────────┘
                         ▼
            [M] Merge  (n8n-nodes-base.merge, typeVersion 3.2, mode:'append', numberInputs:4)
                         ▼
            [C] Decision  Code, DETERMINISTIC — lib/f06/decision.js (§8).
                          Main input = Merge. Reads $('Context pack').first().json for the NUMBERS
                          (Merge carries only prose). RETURNS one item { decision:{…§4.4…} }.
                         ▼
            [D] Assemble + validate + version + write  Code (§9).
                Main input = [C] (decision). Reads $('Merge').all() for the 4 section groups and
                $('Context pack').first().json for pack/gaps/allowed_claim_ids. Runs the citation
                gate over ALL claim_ids, enforces the 5 keys + the typed-exception guard, computes
                next version, INSERTs memos, emits `memo_generated`.
                         ▼
            Respond  { memo_id, application_id, version, recommendation }
```

**§5.1 Pack propagation (spec-review blocker 1).** An n8n node emits what it *returns*, not its
input. `[C]` and `[D]` need the pack numbers/ids, which live in `[A]` — so they reach back with the
`$('Context pack')` node reference (valid because `[A]` is an ancestor of both via the
`[A]→…→Merge→[C]→[D]` chain). `[D]` likewise reads the four section groups with `$('Merge').all()`.
Nothing load-bearing is threaded through the append-Merge (which only carries prose).

**§5.2 Fan-in uses a real `Merge` node.** A plain node with 4 wires silently runs 1–2 branches in
this n8n build (TRACKER) — the f03 bug. Branch *i* → input *i*.

**§5.3 All four B-nodes ALWAYS execute** (spec-review blocker/should-fix 6). `[B3]` is *conditional
in content, not in execution*: when the pack has no optional inputs it returns a **sentinel `{}`**,
so the `numberInputs:4` append-Merge always sees all four inputs and never stalls. `[D]` treats an
absent/empty optional section as "omit the key" (I7). Optional-input rules: `competition` needs ≥1
`competition.*` claim; `risk_matrix` needs ≥1 contradiction or ≥1 material gap; `financials_lite`
renders whenever there is a not-disclosed financial topic or a usable benchmark — and its I4
honesty is anyway guaranteed in `gaps.not_disclosed` regardless of whether the section ships.

**§5.4 Section grouping — 3 LLM narrative nodes, not 8.** README says "one LLM node each"; I group by
cognitive type (descriptive / analytical / optional). Rationale: 8 LLM nodes + an 8-way Merge is more
surface to build, strictify and QA under a 3h clock for no reliability gain — each node already scopes
its own allowed-claim set, which is what the invariant needs. *Deliberate README deviation, recorded.*

## 6. Section-writer agents (via `ai-agent-builder`)

Three narrative agents ([B1]/[B2]/[B3]) + the questions agent ([B4]). Full artifacts (system prompt,
input spec, output JSON schema, model card) live in `agents/`, authored through the
`ai-agent-builder` skill — **not hand-written**. Design-level contract:

- **Model** `gpt-5.6-luna`; `temperature` **omitted** (luna rejects `0`). Structured output,
  `strict:true`, schema through `strictify()`.
- **Input** = only that agent's slice of the pack: the relevant claims (`claim_id`, `topic`,
  `text_verbatim`, `value`, `source_kind`, `derived_status`) + the axis/thesis summary + the
  **allowed claim-id set**. Every `fact` statement must cite ⩾1 id **from that set only**.
- **Output** = the §4.1 section objects. Where a fact is absent, emit `not_disclosed`/`benchmark`
  (I4), never invent. Padding explicitly penalised (I5).
- **The verb is forbidden.** No section-writer may output any of `proceed/…/pass/watchlist` or an
  equivalent recommendation — that is the rule engine's sole output (I6). Enforced by prompt **and**
  by a QA assertion that no section text contains a recommendation verb.
- **Citation is enforced downstream too** (§9) — the prompt is the soft gate, `[D]` is the hard gate.

## 7. Deep-dive-questions agent ([B4], via `ai-agent-builder`)

Input: gaps (§3.8) + contradictions (§3.9) + `ambiguous` claims (`derived_status ∈ {unverified,
partially_supported}` on a resolvable `router_class`) + the weakest assessed screening axis. Output:
5–7 items (§4.3), each naming the gap it closes + the `claim_id`s it sits on. Patterns borrowed from
OSS (MIT `vantage._founder_questions`, Apache `reporting` qa rules): keep a `covered` set so a
question already implied by a standard one is not re-asked; **cap at 7**; where a claim already
answers a question, ask the *verification* follow-up instead of the raw question. Contradiction items
reuse the ready-made neutral `question` from the `claim_contradicted` payload (never an accusation).

## 8. Decision node — deterministic (`lib/f06/decision.js`, unit-tested)

**No LLM.** Pure total function of the pack's numbers; never averages (I1); mirrors 07's shipped
ordered-cascade style for reviewability. Thresholds are **named constants** (`DECISION_CONFIG`,
`thresholds_version:"f06-2026.07"`), demo-tuned — the one editable place answering the README's open
"what combo → proceed" question.

Inputs: `thesis_verdict`, `thesis_fit`, `thesis_fired_rules` (§3.5); three screening axes each
`{value, assessed}` (§3.2); `trust {value, assessed, coverage, confidence}` (§3.4);
`material_contradictions` and `fatal_contradictions` (§3.9). **`founder_score`
(§3.3) is snapshotted into `decision_inputs` for traceability but is deliberately decision-inert
(narrative-only):** it is sparse (assessed on 14 of 164 founders) and person-scoped, so gating on it
would penalise unscored founders — the founder axis composes it upstream (04), and the memo surfaces
it in prose. This is a deliberate cold-start posture per I2, not an oversight.

Constants: `TRUST_FLOOR=40` · `STRONG_TRUST=60` · `AXIS_HIGH=60` · `AXIS_LOW=40` ·
`CONF_FLOOR=0.45` · `MIN_TRUST_COVERAGE=0.25`.

**Rule (first match wins) — the cold-start posture: `pass` = a KNOWN no, `watchlist` = an UNKNOWN.**

```
D1  thesis_verdict == 'failed'                                            → pass
      A hard mandate-fatal deal-breaker fired (embargoed geo / excluded sector / fraud). Not
      conditionable and NOT rescued by an exceptional founder — the exceptional lane is a
      feed-visibility mechanism, backend-inert today. Scores are moot; the thesis already rejected.

D1b fatal_contradictions > 0                                             → pass
      An objectively-confirmed material FACTUAL fabrication (nature='factual' AND severity='material':
      claim-to-code delta / AI-washing / related-party). A proven false material claim is a known no,
      NOT a "dig deeper" — routing it to watchlist would be the calibration error NBLM flagged. A
      material but NON-factual contradiction (temporal/scope/methodological/definitional) is
      evidentiary, not fatal, and stays at D2. Config-gated (`ENABLE_FATAL_CONTRADICTION_PASS`,
      default true); fires only on an explicit `claim_contradicted` event, so it is conservative on
      current live data (events fixture-only) — the demo's provenance contradiction, if temporal,
      correctly stays watchlist.

D2  material_contradictions > 0  OR  (trust.assessed AND trust.value < TRUST_FLOOR)  → watchlist
      A live documented contradiction or floor-level trust is never a proceed and never a pass —
      it is "dig first". condition = resolve the contradiction / raise trust coverage.

D3  NOT decidable                                                        → watchlist
      decidable requires ALL of:
        · thesis_verdict ∈ {passed, borderline}   (not insufficient_evidence, not NULL-gate)
        · trust.assessed AND trust.coverage >= MIN_TRUST_COVERAGE AND trust.confidence >= CONF_FLOOR
        · at least TWO of the three screening axes assessed
      "We cannot responsibly decide in 24h" — the honest cold-start answer, NOT a silent pass. (I2)

D4  any ASSESSED structural axis (market OR idea_vs_market) < AXIS_LOW   → pass
      A genuinely-small market or absent idea-market fit, that we actually MEASURED, is a known no
      (Pass — track). Reached only when decidable (D3 passed), so we never pass-reject on thin DATA —
      a measured structural collapse is a known-no, not thin evidence. The founder axis is
      assessed=false on every app today (no value to gate on), so it never triggers D4; a decidable
      deal with no structural collapse falls to D5/D6. (answers README/§design open fork, source-backed)

D5  STRONG                                                               → proceed
      thesis_verdict=='passed' AND every ASSESSED screening axis >= AXIS_HIGH AND
      trust.value >= STRONG_TRUST AND material_contradictions == 0.

D6  otherwise (decidable, mixed)                             → proceed-with-conditions
      conditions.items built deterministically from exactly what fell short:
        · each assessed axis < AXIS_HIGH        → "diligence <axis>: currently <value>"
        · each fired soft deal-breaker / borderline rule → name it (from thesis_fired_rules)
        · trust in [TRUST_FLOOR, STRONG_TRUST)  → "raise evidence coverage on <low-trust topics>"
```

**Why this ordering:** D2 (contradiction/low-trust) precedes D4 (structural pass) so we never
pass-reject on possibly-contradicted data; D3 (not-decidable) precedes D4 so a "known no" is only
declared when we actually know enough (≥2 axes assessed, decent confidence). Disagreement drives
D5→D6 and names the weak axis as a condition — market 68 + idea-market 40 never becomes "54" (I1).
Output `{ recommendation, conditions:{…§4.4…} }`; `rule_fired` recorded in `decision_inputs` for
traceability. Never NULL.

**`conditions.rationale` is a deterministic conflict-arbitration narrative** — the decision node
composes it from templated fragments that name the axes and WHY the verb was chosen across their
disagreement (e.g. *"market strong (68) but idea-market fit thin (40) and no material contradiction —
proceed only once the wedge is validated"*). It renders the RULE'S OWN reasoning; **no LLM re-derives
it** (I6). This is the human-readable "why" NBLM flagged as essential and distinct from the per-axis
chips 09 shows.

## 9. Validate, assemble, version, write ([D], deterministic)

1. **Citation gate (DROP + LOG, not whole-memo reject — revised after T6's live finding).** Collect
   **every** claim id anywhere in the assembled row — `sections` (incl. SWOT arrays,
   `risk_matrix.risks`, `competition.competitors`), `deep_dive_questions[].claim_ids`,
   `conditions.items[].claim_ids`, and `gaps.contradictions[].claim_id` (**singular key**). Any
   statement/item citing an id **not** in the pack's `allowed_claim_ids` → **drop that statement/item**
   and record it in `dropped_statements[]` (with its text + offending ids); the memo still assembles.
   **I3 is preserved exactly** — no uncited fact ever renders — but a single LLM citation slip no
   longer nukes the whole memo (T6 measured ~40% of live runs hitting a whole-memo reject; graceful
   degradation matches the product's absent≠zero / back-fill philosophy). The drop is **logged, not
   silent**: `dropped_statements` count + details go into the `memo_generated` event payload, so a
   systematic hallucination is still visible. Gate is safe for pack-sourced ids (`gaps.contradictions`,
   `conditions`) because §3.6 makes `allowed_claim_ids` a superset; the real target is a **hallucinated**
   id in an LLM-authored block. If dropping empties a required section, the back-fill (step 3) covers it.
2. **Typed-exception guard (DROP + LOG, same revision).** A `not_disclosed` or `structural` statement
   whose text contains a company-specific figure (a `$`, or digit+unit) is **dropped and logged** (not
   whole-memo rejected) — those kinds exist to state absence/connective prose, not to smuggle an
   uncited number. `benchmark` may carry numbers but its text must match the *range + "not a valuation"*
   template (§4.1); a benchmark failing that is dropped+logged too. Also enforced as a QA assertion.
   **The only hard errors that abort a write are structural** (application not found, DB failure) —
   never a content slip.
3. **Required-key gate — BACK-FILL, never reject** (spec-review should-fix #1). For each of the five
   required keys (and each of the four SWOT arrays), if missing or empty, `[D]` **deterministically
   inserts one `structural` line** (e.g. `"Snapshot: nothing disclosed at this stage."`) rather than
   rejecting. The writer's prompt is the first line of defence (it should emit the honest line), but
   §10 guarantees an empty-pack memo still writes, and an LLM omission of a required section must
   never hard-fail the whole memo ("the prompt can slip, this cannot"). So a required section is
   always back-fillable and never causes a rejection — only the citation gate (step 1) and the
   typed-exception guard (step 2) reject. Stricter than `memos_sections_check`, which only tests key
   existence (§F9).
4. **Version.** `next = COALESCE(MAX(version),0)+1` (`memos?application_id=eq.<id>&select=version&
   order=version.desc&limit=1`, `alwaysOutputData` — empty at v1 is normal). Regeneration = a new
   row; append-only, no update.
5. **`cited_claim_ids`** = deduped union from step 1 (all blocks, not just sections).
6. **INSERT** (service role). On the `(application_id, version)` unique race, retry once with `next+1`.
7. **Emit event** `memo_generated`, `entity_type='application'`, `entity_id=<app>`, payload
   `{ memo_id, version, recommendation, rule_fired, run_id, n8n_execution_id }` — lights up
   `api_applications.memo_available`/`memo_version`.

## 10. Edge & not-assessed states (all handled, not happy-path only)

| State | Behaviour |
|---|---|
| Application not found | Error envelope `{error:{code,message}}`, 404-shaped. No row. |
| No claims at all (empty pack) | Still writes a memo: every required section = one `not_disclosed`/`structural` line; `recommendation=watchlist` (D3 — nothing decidable); `gaps` lists everything missing. An honest empty memo beats no memo. |
| `founder` axis absent (every app today, §F5) | `missing_axes` includes `founder`; decision uses the two assessed axes; memo leans on the **person** `founder_score` where present, labelled as a different subject. |
| Trust not assessed / below min coverage | D3 → `watchlist`; memo states trust could not be established and why. **Demo runbook: `f05-trust-rollup` must have been run on the app first, or D3 fires `watchlist` on all of them.** |
| Thesis `insufficient_evidence` / NULL gate | Not decidable (D3) → `watchlist`. Never a stale-score fallback (§3.5). |
| Contradiction present | `risk_matrix` + a deep-dive question + (if material) a D2/D6 condition. Company-scoped ones queried under both entity shapes (§3.9). |
| Synthetic application (`is_synthetic`) | Memo generated normally; 09 badges it. No content special-casing. |

## 11. Reuse from the codebase

- **`pg()` PostgREST helper** — inlined shape from f04/f05 `workflow_defs.py`.
- **Merge-node fan-in, `strictify()`, crypto/URL polyfills, luna-no-temperature, `alwaysOutputData`
  on empty-normal selects** — all from the TRACKER tooling changelog; not re-litigated.
- **`f10_normalize_missing_flags` semantics** — read the already-normalised `api_*` arrays rather
  than re-parsing the 4-shape `missing_flags` (the one raw exception is trust `.coverage`, §3.4).
- **`claim_contradicted` payload** — its `question` seeds deep-dive questions (§7).
- **OSS patterns folded** (licenses respected — verbatim only from MIT/Apache): `reporting`
  paragraph-record citation shape + 4-verb options (Apache-2.0); `vantage` question dedup +
  confidence-separate-from-score (MIT); `vcbrain` conviction-independent-of-score, i.e. a fatal flag
  overrides good scores — our D1/D2 gates (MIT); `sieve` Documented/Discovered/Inferred/Missing
  stage-calibrated evidence typing (MIT). **Not lifted:** vantage/vcbrain single-weighted-score
  aggregation (violates I1).

## 12. Build staging (for the plan — protects the priority)

Operator priority: *a working generate-memo with honest gaps beats rich formatting.* Staged so the
required core ships first and the clock can stop after it with a demoable feature:

- **Stage 1 (must-ship):** `lib/f06/decision.js` + tests · [A] context pack (incl. deterministic
  `gaps`, so I4 honesty is present) · [B1] descriptive · [B2] analytical · [B4] questions ·
  [C] decision · [D] write. Five required sections, honest gaps, deterministic recommendation.
- **Stage 2 (chosen scope, drop-first if clock tightens):** [B3] optional sections (risk_matrix,
  competition, financials_lite). Dropping it does NOT drop the not-disclosed honesty (§4.2).
- **Stage 3:** independent QA gate, then close.

## 13. Open decisions for the operator

**None blocking.** The earlier fork — *does `pass` ever come from weak scores?* — is resolved by the
sources (OSS `reporting`/`vantage` "pass = known-no" vs "watchlist = unknown", and the pre-seed
cold-start posture): D4 makes a **measured** structural-axis collapse a `pass`, while a thin founder
signal stays `watchlist`. Thresholds are demo-tunable in `DECISION_CONFIG` without reopening the
design. Will surface to the operator at the design gate for a yes/no, not as an open question.
