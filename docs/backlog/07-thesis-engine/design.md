# 07 · Thesis Engine — Design

> Status: **rev.3** — after three review passes (two adversarial spec reviews, two DB reviews,
> the latter run empirically against the live database). Depends on 01 (schema applied).
> Reconciled with 02/03/04, which were designed and partly built in parallel terminals.
>
> Sources consumed before any proposal (CLAUDE.md «Правила проработки»): internal intel base,
> NotebookLM «HN6 C2 — The VC Brain (Maschmeyer)» (11 query angles), Exa (14 queries), the OSS
> clones in `internal/other-projects/` (20 repos).
>
> **rev.1 and rev.2 both shipped a REQ-003 violation in the fit formula** — first by subtraction,
> then by a data-dependent denominator. §3 explains why an arithmetic fix is impossible and what
> structural guarantee replaces it. §9 is the full audit trail.
>
> ⚠️ `db/schema.sql` is being edited concurrently by other feature terminals. Every line number
> below was verified on 2026-07-19 ~04:20 and **must be re-verified immediately before editing**.

## Decision log

---

### D-01 · Rule enforcement is per-rule (`hard` | `soft`), defaulting to `soft`

Every rule carries `enforcement`. `hard` auto-rejects; `soft` down-ranks and shows under
«Outside thesis», never hidden. `hard` is legal only for **fund-mandate binaries** (legal or
operational — embargoed geography, contractually excluded sector) and **fraud / AI-washing**,
declared through a required `hard_justification` enum.

**Why.** NotebookLM (Q4, Q8): only those two categories are safe to hard-reject; market sizing,
missing traction and founder pedigree must be soft — hard-filtering on market size is the
mechanism behind the classic misses, and pedigree filters «create a systemic bias loop». The same
source recommends the mechanism verbatim: an `enforcement: hard | soft` field on rule rows «so a
non-technical user cannot accidentally hard-reject on market size». **Commercial precedent**
(a vendor documenting its own product, not independent validation): Kruncher's Focus / Neutral /
Deal Breaker, where only deal-breakers exclude. **OSS**: vcbrain (MIT,
`packages/shared/src/types.ts:318`) splits `mustHaves` (flagged) from `dealBreakers`
(auto-flagged out).

**Rejected.** *Never reject anything* — forfeits half of REC-008. *Hard-code the two categories* —
collides with invariant #6 and FAQ-15.

---

### D-02 · Blind extraction → deterministic rule evaluation

(1) A cheap LLM call reads the supplied text and emits structured attributes **with no thesis in
its context**. (2) The backend evaluates the thesis's rules against those attributes in code.

**Why.** *Anti-sycophancy* (NotebookLM Q12): «our thesis is X, does this fit?» makes the model
«highly likely to hallucinate alignment… even if the evidence is weak». *Prompt bloat / claim
drift* (same source). *«Model proposes, backend decides»* (vantage, MIT) — already this project's
scoring pattern. *Compile once, execute frozen* (RULERS, arXiv). *Decoupled epistemic judgement*
(PassiveQA, arXiv). *Reuse*: attributes are thesis-independent, extracted once, evaluated against
any number of theses.

**Differentiation, stated honestly.** The OSS scout grepped 20 clones for
`auto_reject|hard_filter|prefilter|triage|knockout|disqualif` and found nothing — which
establishes those tokens are absent, not that the capability is. The accurate claim: «no reference
implements a pre-LLM deterministic gate under any naming we could find».

**Rejected.** *Pure deterministic, no LLM* — minimum intake is deck + company name (REQ-008).
*Single LLM classifier with the thesis in the prompt* — what all 20 clones do; the sycophancy
trap, plus instruction-only abstention measures ~10% incorrect abstentions, collapsing to 62% on
weaker models (arXiv composite-gating study).

---

### D-03 · Three-valued rule evaluation: `match` | `no_match` | `unknown`

A rule is `unknown` whenever **any** field its `expr` references is absent, null, in
`missing_fields`, or backed only by a claim with `verification_status='contradicted'`. `unknown`
rules contribute to no term of the fit formula and **a `hard` rule fires only on `match`**.

**Why.** rev.1's formula subtracted for «failed must_have», which an unextracted field satisfied,
so missing data lowered the score — and a hard deal-breaker on an unextracted `sector` could
auto-reject an application for having a thin deck. Under D-03 a firing hard rule is by
construction a confidently-observed fact.

**Bonus property, load-bearing for feature 02.** 02 places the gate in Tier 1, which must run
with no GitHub token and no LLM. Three-valued evaluation makes that path correct rather than
special-cased.

---

### D-04 · Outcome vocabulary — one enum, derived from the formula

rev.2 carried a «truth table» beside the formula and the two disagreed in three cells, and
`focus`/`no_match` had no legal `outcome` value at all. There is now **one** vocabulary, and the
table below *is* the formula's definition — not a parallel description of it.

`outcome ∈ satisfied | missed | triggered | unknown`

| `kind` | `expr` result | `outcome` | → `earned` | → `total` | → `penalty` | can force `failed` |
|---|---|---|---|---|---|---|
| `focus` | match | `satisfied` | `+weight` | `+weight` | — | no |
| `focus` | no_match | `missed` | — | `+weight` | — | no |
| `must_have` | match | `satisfied` | `+weight` | `+weight` | — | no |
| `must_have` | no_match | `missed` | — | `+weight` | — | **yes if `hard`** |
| `deal_breaker` | match | `triggered` | — | — | `+penalty` | **yes if `hard`** |
| `deal_breaker` | no_match | `satisfied` | — | — | — | no |
| `must_have` \| `focus` | any field unknown | `unknown` | — | `+weight` | — | **no** |
| `deal_breaker` | any field unknown | `unknown` | — | — | — | **no** |

Two things this table fixes beyond the contradiction: **`deal_breaker` weights never enter
`earned` or `total`** (rev.2 let a non-triggered deal-breaker *raise* fit and a triggered one be
penalised twice), and `unknown` contributes to `total` but not `earned` — which is what makes
coverage measurable (§3.2). `validate_thesis_config()` enforces `deal_breaker ⇒ weight = 0`.

`fired_rules[]` elements, the contract feature 06 reads:

```jsonc
{ "id": "R1", "label": "...", "kind": "deal_breaker", "enforcement": "hard",
  "outcome": "triggered", "field": "sector",
  "expected": ["gambling","adtech"], "observed": "gambling", "weight_applied": 0 }
```

`weight_applied` is **the weight actually contributed to `earned`** — the rule's `weight` when a
`must_have`/`focus` is `satisfied`, otherwise 0. (D-04's single JSON example is a `deal_breaker`,
whose weight is 0 by construction, so it does not disambiguate the general case; feature 06's memo
renderer reads this field.)

`focus` may never be `hard` (D-01 rationale: a focus miss is neither a legal constraint nor
fraud). Legal combinations: `deal_breaker`×{hard,soft}, `must_have`×{hard,soft}, `focus`×{soft}.

**`missing_fields` is the caller's responsibility, not the evaluator's.** D-03 says a field is
`unknown` if absent, null, in `missing_fields`, **or backed only by a `contradicted` claim** — but
the evaluator is a pure function with no database access. The calling workflow must therefore
resolve contradicted claims and fold them into `missing_fields` **before** invoking evaluation.
Stage D owns this; an evaluator that silently saw a contradicted claim as a good observation would
let a disproven attribute fire a hard rule.

### D-04a · The canonical worked cases

Recorded because they were hand-verified during review and then existed only in conversation —
the stage-B agent correctly refused to invent agreement with numbers it could not find. Thesis:
`must_have` (business_model eq b2b, w30), `focus` (sector in [ai-infra], w25), `focus`
(geography_region in [EU], w25), soft `deal_breaker` (`_text` contains casino, w0);
`base 50, min_coverage 0.5, strong_threshold 70, penalty 30`. `total = 80`.

| # | Situation | earned | evaluated | coverage | penalty | fit | verdict |
|---|---|---|---|---|---|---|---|
| 1 | all extracted, geography misses | 55 | 80 | 1.00 | 0 | 68.75 | `borderline` |
| 2 | business_model + sector unknown | 0 | 25 | 0.31 | 0 | 0 | `insufficient_evidence` |
| 3 | nothing extracted but `_text` | 0 | 0 | 0.00 | 0 | 0 | `insufficient_evidence` |
| 4 | all match, deal-breaker triggered | 80 | 80 | 1.00 | 30 | 70.00 | `borderline` (step 2b) |
| 5 | no must_have/focus rules at all | — | — | 1.00 | 0 | 50 (`fit.base`) | `borderline` |
| 6 | all match, nothing triggered | 80 | 80 | 1.00 | 0 | 100 | `passed` |

Case 4 is the one that forced step 2b: without it, fit lands **exactly** on
`strong_threshold` and a company matching a deal-breaker reaches the top lane.

---

### D-05 · No fourth value on `applications.thesis_gate`

`applications.thesis_gate` keeps its shipped three values plus NULL (CHECK verified live as
still 3-valued). The four-state verdict lives in `thesis_evaluations.verdict`, 07's own
append-only table. On `insufficient_evidence` the workflow **writes `thesis_gate = NULL`** — an
actual write, not a skip — and emits an `events` row.

**Why.** (a) Feature 02 branches on exactly three values (`02/design.md:72-76`) and is another
owner's folder. (b) Feature 03 solved the identical problem without a new enum
(`03/design.md:139-166`): no `scores` row, plus an `events` row. (c) `thesis_gate` is nullable by
design, so «could not gate» already has a representation.

**Honest limitation.** NULL falls through 02's three-way branch exactly as a fourth enum value
would. D-05 avoids the *schema change and the announcement burden*, not the fall-through. 02 must
be told that NULL is a reachable post-gate state — a TRACKER changelog entry and a §8.2 row are
owed, and until 02 handles it, a NULL-gated application simply does not advance to Tier 2, which
is the safe direction.

**Consequences — corrected.** rev.2 claimed «no edit to a feature-01 object». False: §5.5 adds a
column and two indexes to `theses` and §5.6 adds a trigger to it. What D-05 avoids is changing a
CHECK that another in-build feature branches on.

---

### D-06 · Reproducibility by config snapshot, not immutability

`theses.config` stays mutable; every evaluation stores the effective config in
`thesis_evaluations.thesis_config_snapshot`.

**Why.** `theses` is the one config table feature 01 built **mutable** — it carries `updated_at`
(`db/schema.sql:174`), the marker 01 uses to separate mutable from append-only (compare `scores`,
`:357-358`). Feature 04 solved the same reproducibility problem the cheaper way, echoing config
into the run record (`04/design.md:104-108`). Snapshotting also covers a case freezing does not:
a config edited *before* it was ever referenced.

---

### D-07 · Missing data is handled structurally, not arithmetically

**This is the decision rev.1 and rev.2 both got wrong.** The desired property — «making a rule
`unknown` must never lower `fit`» — is **unachievable for any fit measure normalized over
evaluated rules**, and the two candidate arithmetic fixes both fail:

- *Credit unknowns at 0.5* (the second reviewer's proposal): a rule that was `satisfied`
  (weight 30 → 30) becomes `unknown` (→ 15). Fit drops. Property violated.
- *Credit unknowns at 1.0*: an application where nothing was extracted scores 100. Absurd, and it
  would rank thin decks first.

The rev.2 formula divided by the evaluated weight, which made the denominator data-dependent, so
an application with 2 of 3 fields missing scored **0** while the same application fully extracted
scored **68.75** — the REQ-003 violation relocated, not removed.

**The guarantee we actually make, stated precisely:**

> An application is never **ranked** on a fit computed from less than `fit.min_coverage` of the
> thesis's total rule weight. Insufficient data removes an application from the ranking and routes
> it to enrichment; it never places it at the bottom of the ranking.

`confidence` is redefined as **thesis coverage** — `evaluated_weight / total_weight`, i.e. «how
much of *this thesis* could we actually check?» — which is the natural notion and makes the defer
decision catch the failure case automatically (the example above has coverage 25/80 = 0.31,
below any sane threshold → `insufficient_evidence`, unranked). rev.2's `required_fields` count was
a thesis-independent proxy that missed it.

**Scope note.** REQ-003 and invariant #4 speak about the *founder score*. `thesis_fit` is not a
founder score — it measures alignment to a fund mandate. But the harm REQ-003 guards against is
real here too: the feed sorts by `thesis_fit desc`, so a sparse application would sink to the
bottom, reproducing exactly the Berg/Koelbel/Rigobon trap where ratings reward disclosure quality
rather than performance. The coverage gate is what prevents that.

---

## §1 · The `theses.config` contract

`theses` exists from feature 01: `id, name, config jsonb, version int, active bool,
UNIQUE (name, version)` (`db/schema.sql:167-176`).

```jsonc
{
  "schema_version": 1,

  "mandate": {
    "stages":        ["pre_seed", "seed"],
    "geographies":   ["EU", "US"],
    "sectors":       ["b2b-software", "ai-infra", "devtools"],
    "risk_appetite": "high",
    "check_size_usd":       { "min": 50000, "max": 150000 },
    "ownership_target_pct": null
  },

  // Alias consumed by feature 04, which is already in build and reads
  // `theses.config.geos` at runtime (04/design.md:371). Country codes, because
  // 04 interpolates them into a Tavily query where a region token is far weaker.
  // `GB` is deliberately absent: region_of('GB') is `UK`, a distinct region from
  // `EU`, so including it here while mandate.geographies is ["EU","US"] would
  // make 04 source British companies that then soft-miss the compiled M_geo
  // rule -- the same class of defect §1.1 exists to prevent. Widen
  // mandate.geographies to include "UK" first if UK sourcing is ever wanted.
  "geos": ["DE", "FR", "NL", "US"],

  "positive_keywords": ["developer tools", "infrastructure"],
  "negative_keywords": ["casino", "betting"],

  "rules": [
    { "id": "R1", "label": "Excluded sector: gambling",
      "kind": "deal_breaker", "enforcement": "hard",
      "hard_justification": "mandate_fatal",
      "expr": { "field": "sector", "op": "in", "value": ["gambling", "adtech"] },
      "weight": 0, "enabled": true },

    { "id": "R2", "label": "B2B focus",
      "kind": "focus", "enforcement": "soft",
      "expr": { "field": "business_model", "op": "eq", "value": "b2b" },
      "weight": 25, "enabled": true }
  ],

  "fit": {
    "base": 50,                       // returned when total_weight = 0 (thesis expresses no opinion)
    "mandate_weight": 20,
    "soft_deal_breaker_penalty": 30,
    "strong_threshold": 70,
    "min_coverage": 0.5               // D-07: below this the application is not ranked
  },

  "exceptional_lane": { "axis": "founder_score", "aggregate": "max", "min_value": 75 }
}
```

`kind ∈ deal_breaker | must_have | focus`; `enforcement ∈ hard | soft` (legality per D-04);
`hard_justification ∈ mandate_fatal | fraud`, **required** when `enforcement = hard`;
`expr.op ∈ eq | in | gte | lte | contains | exists`, with optional `"negate": true`.
`confidence` as a config block is **gone** — coverage is computed from rule weights (D-07), so
there is nothing left to configure but `fit.min_coverage`.

### §1.1 Attribute vocabulary — normative

The key names below are identical across extractor output and `expr.field`. Nothing else is
gateable. rev.2 carried geography in three incompatible forms, which made a German B2B company
soft-fail the geography rule of the shipped default thesis.

| Key | Type | Value set | Notes |
|---|---|---|---|
| `sector` | single | `b2b-software`, `ai-infra`, `devtools`, `fintech`, `healthtech`, `consumer`, `marketplace`, `gambling`, `adtech`, `other` | closed; `other` is legal and common |
| `business_model` | single | `b2b`, `b2c`, `b2b2c`, `marketplace`, `open_source`, `unknown` | |
| `geography_country` | single | ISO-3166-1 alpha-2 | **country only** — 02 normalizes GitHub location to country «for the thesis geo filter (07)» (`02/design.md:113`) |
| `geography_region` | derived | `EU`, `US`, `UK`, `APAC`, `LATAM`, `MEA`, `other` | `region_of(country)`, applied before evaluation |
| `stage` | derived | `pre_seed`, `seed` | from `stage_evidence` |
| `stage_evidence` | single | `idea`, `prototype`, `early_revenue`, `scaling` | OpenVC company-state, not round names |
| `what_is_built` | text | free | **not gateable**; feeds memo and claims only |
| `_text` | text | free | **synthetic**, see below. Only `contains` and `exists` are defined on it |

**`_text` — resolution, normative.** `_text` is **the gate's raw input text** (the `text` parameter),
not a concatenation of claims. It is deliberately the unprocessed input: keyword rules exist to
catch what the extractor might normalize away, so deriving `_text` from extracted claims would
defeat their purpose.

In **`f07-thesis-reevaluate` there is no input text** — the workflow does not re-extract. `_text`
there resolves from the stored `raw_signals.payload` for that application (the original input is
preserved there by §5.4 step 3). If no such row exists, `_text` is **absent**, and every `_text`
rule is therefore `unknown` (D-03) — never a miss. A re-evaluation must not conclude «no
negative keyword found» from text it never saw.

**Which row, when there are several** (gap found live, 2026-07-19): an application legitimately
accumulates multiple `raw_signals` rows — one per gate call with different input text, plus the
fixture's own row, plus rows written before `payload.text` existed. The original wording said «the
stored payload» as if there were exactly one. Normative resolution:

> `_text` resolves from the **most recent `raw_signals` row for the application that actually
> carries a `text` key**. Rows without one are skipped rather than treated as empty text.

Skipping rather than reading-as-empty is the load-bearing half: an empty `_text` would make every
keyword rule evaluate to `no_match` («no negative keyword found»), which is a *conclusion*. A
skipped row leaves `_text` absent, which is `unknown` — the honest state. This also makes the
pre-`text` legacy rows degrade correctly instead of silently clearing a deal-breaker.

`stage_evidence → stage`: `idea | prototype → pre_seed`; `early_revenue → seed`; `scaling →`
**no mapping** — yields `unknown` on stage rules, never a rejection.

**`contains` semantics**, dispatched on the field's declared type: on a **text** field with an
**array** operand it is substring-match-on-any-element (OR); on a text field with a string operand,
substring match; on a **multi-valued** field, array membership. An **empty array operand yields
`unknown`** — an empty keyword list expresses no opinion and must not be readable as a miss.

### §1.2 Mandate → rule compilation — normative

Lazy, at evaluation time. **All compiled rules are `soft` by construction** — a sector or
geography mismatch is neither a legal constraint nor fraud, so compiling them `hard` would
contradict D-01, SCOPE-007's open door, and the «Off-thesis but exceptional» lane. Hard rules can
only come from hand-authored `rules[]` entries carrying a `hard_justification`.

| Mandate field | Compiles to | Emitted only when |
|---|---|---|
| `sectors` | `{id:"M_sector", kind:"focus", enforcement:"soft", weight: fit.mandate_weight, expr:{field:"sector", op:"in", value: mandate.sectors}}` | array non-empty |
| `geographies` | same shape, `id:"M_geography"`, `field:"geography_region"` | array non-empty |
| `stages` | same shape, `id:"M_stage"`, `field:"stage"` | array non-empty |
| `positive_keywords` | `{id:"M_poskw", kind:"focus", …, expr:{field:"_text", op:"contains", value: positive_keywords}}` | array non-empty |
| `negative_keywords` | `{id:"M_negkw", kind:"deal_breaker", enforcement:"soft", weight: 0, expr:{field:"_text", op:"contains", value: negative_keywords}}` | array non-empty |
| `check_size_usd`, `ownership_target_pct`, `risk_appetite`, `geos` | **nothing** | — |

The «only when non-empty» column matters: rev.2 compiled keyword rules unconditionally, so an
empty `positive_keywords` produced a permanently-`missed` rule that silently depressed every fit.

### §1.3 Three deliberate choices

1. **`check_size_usd` / `ownership_target_pct` are stored but inert.** The brief requires them as
   configurable dimensions; NotebookLM (Q10) is unambiguous that at pre-seed they are noise and
   filtering on them «risks rejecting highly promising founders simply because the AI cannot
   mathematically justify the valuation using non-existent revenue data».
2. **`expr` is an evaluable contract, not a hint.** vcbrain's `rule` is free text nothing parses —
   which is why vcbrain has no cheap gate.
3. **No miss-rate dial, and no `strictness` enum.** The ECIS 2024 tunable miss rate (1% miss →
   rejects 23%; 10% → 57%) is the most demo-friendly idea the research produced, but the
   percentages need calibration against a labeled cohort we do not have; shipping them fabricates
   a metric (REQ-004). rev.1's `strictness` replacement appeared in prose and in no schema — cut.
   `fit.strong_threshold` does the job honestly.

---

## §2 · Verdict — an ordered decision procedure

First match wins:

```
1.  any rule with outcome=triggered or missed, and enforcement=hard   → failed
2.  coverage < fit.min_coverage  (full mode only)                     → insufficient_evidence
2b. any soft deal_breaker with outcome=triggered                      → borderline
3.  fit >= fit.strong_threshold  (full mode only)                     → passed
4.  otherwise                                                         → borderline
```

Step 3 is **full-mode only**, for the same reason as step 2: §6.1 states keyword mode never
returns `passed`, and without the annotation §2 and §6.1 contradict each other for any keyword-mode
case whose fit happens to clear the threshold — which is reachable, not hypothetical.

Exhaustive by construction (step 4 is unconditional) and exclusive by ordering.

**Step 2b is not redundant with the penalty.** `soft_deal_breaker_penalty` is a nudge, not a
guarantee: a thesis where every rule matches scores 100, and a single triggered soft deal-breaker
leaves exactly 70 — which clears `strong_threshold` and puts a company matching a deal-breaker in
the **top** lane. D-01 says soft deal-breakers «down-rank and show under Outside thesis», and
§8.3 test 3 asserts it; without 2b the formula silently contradicts both.

**Why `failed` outranks `insufficient_evidence`.** Under D-03 a hard rule fires only when every
field it references was extracted, so a firing hard rule is a confidently-observed embargo or
fraud fact and auto-rejecting on it is legitimate even at low overall coverage. We never reject on
a half-read deck, because a half-read deck yields `unknown`, and `unknown` cannot fire a hard
rule. The guarantee is structural, not a threshold negotiation.

**Persistence per verdict:**

| Verdict | `thesis_evaluations.verdict` | `applications.thesis_gate` | `applications.thesis_id` | `scores(thesis_fit)` | `events` |
|---|---|---|---|---|---|
| `passed` | `passed` | `passed` | set | written | — |
| `borderline` | `borderline` | `borderline` | set | written | — |
| `failed` | `failed` | `failed` | set | written | — |
| `insufficient_evidence` | `insufficient_evidence` | **written as NULL** | set | **not written** | `thesis_gate_insufficient_evidence` |
| *any verdict in `keyword` mode except `failed`* | as computed | as computed | set | **not written** (§6.1) | — |

`thesis_id` is set in all four cases — feature 04 branches on it for its geography fallback
(`04/design.md:371`), and a gated application has a known thesis even when the verdict is
inconclusive. Not writing a `scores` row on insufficient evidence follows 03's precedent and 04's
consumer contract: **an absent axis row means «not assessed», not zero** (`04/design.md:886-889`).
Failed verdicts are persisted in full — 02 needs them for base rates and the RSK-004 survivorship
defence (`02/design.md:89-91`).

---

## §3 · Fit and coverage

### §3.1 The formula

```
total    = Σ weight(enabled must_have + focus rules)          // thesis-constant, incl. unknown
earned   = Σ weight(rules with outcome = satisfied)
penalty  = fit.soft_deal_breaker_penalty × count(soft deal_breakers with outcome = triggered)

fit = total > 0 ? clamp(100 × earned / total − penalty, 0, 100)
                : fit.base
```

`deal_breaker` weights never enter `earned` or `total` (D-04). `fit.base` covers the genuinely
empty case — a thesis with no `must_have` and no `focus` rules expresses no opinion, so the
neutral midpoint is honest and a 0 would read as «bad fit».

### §3.2 Coverage replaces the confidence fraction

```
evaluated = Σ weight(enabled must_have + focus rules with outcome != unknown)
coverage  = total > 0 ? evaluated / total : 1.0        // NULL in keyword mode (§6.1)
```

`enabled` is load-bearing in both `total` and `evaluated`: dropping it from one side lets a
disabled rule enter `evaluated` but not `total`, producing `coverage > 1` and violating the CHECK
on both `thesis_evaluations.coverage` and `scores.confidence`.

`coverage` drives the `insufficient_evidence` branch (§2 step 2) and is what lands in
`scores.confidence` (`numeric(3,2)`, matching `db/schema.sql:346`). rev.2's four-field count
produced only {0, 0.25, 0.5, 0.75, 1} against thresholds 0.5 and 0.7 — an **empty** band between
them, one dead key, and one real rule dressed as two decimals. That was the same fabricated
precision §1.3 refuses on principle.

**Citations, corrected.** The Confidence Gate Theorem (arXiv) shows abstention gates behave well
under *structural* uncertainty (cold start, sparsity), supporting abstaining over guessing. It
does **not** establish that any particular counting rule *is* a confidence — ours is our choice
and is uncalibrated. Phillips et al. (arXiv) support the negative half: model-internal confidence
is unreliable («confidently wrong regime»), so a self-reported `confidence: 0.87` is unusable.

---

## §4 · Extraction AI logic

Full agent artifacts (system prompt, input spec, output schema, model choice) are produced through
the global **`ai-agent-builder`** skill at build time.

**Model** `gpt-5.6-luna`. `prompt_version = 'f07-extract-v1'` — referenced by §5.4's retry-stable
`ai_runs.input_hash`, and unassigned in rev.3, which left that hash undefined.

**Cost — measured, and the research figure does not survive contact.** NotebookLM put the gate at
**$0.0014 per deal** (single-source MIRAGE-VC, pricing apparently conflating tiers — already
flagged as order-of-magnitude only). Cashed out against the actual artifact: the system prompt
measures 6,800 tokens, giving **≈$0.011 per gated application** — about **8× the cited figure**,
or ≈$1.10 per 100 applications. The two-stage economics still hold comfortably, but **$0.0014
must not appear in front of judges.**

**Sentinel values are not observations.** `business_model: 'unknown'` is a legal value in §1.1's
closed set, and comparing it *as a value* against `{op:'eq', value:'b2b'}` yields `no_match` —
which would put its weight in `total` but not `earned` and **lower `fit` because the model could
not tell**. D-03 defines unknown-ness by absence and did not anticipate a sentinel inside the
vocabulary. The evaluator therefore treats sentinel values as `unknown`, identically to an absent
field. **`sector: 'other'` is deliberately NOT a sentinel** — it is a real determination carrying
a quote, so it must yield `no_match`; conflating the two would let a thin deck be auto-rejected.

**Output schema** (`temperature=0`, structured output, `reasoning` first — field order is
load-bearing):

```jsonc
{ "reasoning": "...",
  "sector": "b2b-software", "business_model": "b2b",
  "geography_country": "DE", "stage_evidence": "prototype",
  "what_is_built": "...",
  "quotes": { "sector": "we sell to enterprise IT teams", "geography_country": "Berlin, Germany" },
  "missing_fields": ["stage_evidence"] }
```

`quotes` is required: `claims.text_verbatim` is NOT NULL and a normalized label is not a verbatim
span. Any field the model cannot ground in a quote belongs in `missing_fields`.

**One source recommendation deliberately not followed.** NotebookLM's «If evidence is
insufficient, reason cautiously but still decide» is backwards for an extractor — it would push
the model to guess sector and geography when the text states neither. It belongs in the memo agent
(feature 06), where a decision is mandatory.

**Adopted:** the explicit push-back instruction; negative criteria alongside positive ones;
reasoning before verdict.

> ⚠️ **`temperature=0` is NOT achievable — the gate is not reproducible.** `gpt-5.6-luna` rejects
> the `temperature` parameter outright (independently hit by features 03 and 04 before us), so it
> is omitted rather than forced. Consequence, observed live during stage D: **the same application
> ran twice in `full` mode produced two different verdicts** — GameLoop returned `borderline`
> (coverage 0.81) on one run and `failed` (coverage 1.00) on another, because the extractor
> classified `sector` differently each time.
>
> This breaks two things the design assumed. (a) §5.1's `input_fingerprint` distinguishes a retry
> from a genuine re-evaluation — but a *re-extraction* of unchanged input can now legitimately
> yield different claims, and the claim hash does not include the extracted value, so a stale
> value can survive. (b) «Run it twice, get the same answer» is not a property we can claim to a
> judge. What *is* reproducible: the evaluator (`lib/f07/rules.js`) is fully deterministic given
> attributes, and `mode='keyword'` is deterministic end to end because it makes no LLM call.
>
> Not fixable within this stack. Honest framing for the demo: the **reasoning** is deterministic
> and auditable; the **perception** is not, which is exactly why every extracted attribute carries
> a quote and lands in the evidence ledger rather than being trusted.

**Anonymization — claim corrected.** rev.1 sold this as «free for the gate». It is not: the input
includes deck and page text, a team slide carries founder names, and the model ingests them, so
entity-memorization bias (the MIRAGE-VC mechanism) is **not** mitigated by not asking. True claim:
**the gate's output schema contains no identity fields, and no identity attribute can influence a
rule** — §1.1 has no person-derived key. Input-side masking needs an NER pass; post-MVP. The
masking-vs-founder-driven-assessment tension belongs to **feature 03**.

---

## §5 · Persistence

### §5.1 `thesis_evaluations`

```sql
CREATE TABLE IF NOT EXISTS thesis_evaluations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  thesis_id              uuid NOT NULL REFERENCES theses(id) ON DELETE RESTRICT,
  thesis_version         int  NOT NULL,
  -- Retry-stable hash of the evaluated inputs; see §5.4. Distinguishes a retry
  -- (same fingerprint -> dedup) from a legitimate re-evaluation after claims
  -- changed (new fingerprint -> new row), without a version bump.
  input_fingerprint      text NOT NULL,
  -- Which mode produced this row. Makes a NULL `coverage` interpretable ("we
  -- never extracted, by design") rather than ambiguous, and marks the rows that
  -- deliberately carry no scores row (§6.1).
  evaluation_mode        text NOT NULL DEFAULT 'full'
                           CHECK (evaluation_mode IN ('full','keyword')),
  verdict                text NOT NULL
                           CHECK (verdict IN ('passed','failed','borderline','insufficient_evidence')),
  score_id               uuid REFERENCES scores(id) ON DELETE RESTRICT,
  fired_rules            jsonb NOT NULL DEFAULT '[]'::jsonb,
  extracted_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  thesis_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_fields         text[] NOT NULL DEFAULT '{}',
  coverage               numeric(3,2) CHECK (coverage BETWEEN 0 AND 1),
  extraction_ai_run_id   uuid REFERENCES ai_runs(id) ON DELETE RESTRICT,
  formula_version        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Append-only: no updated_at.
  UNIQUE (application_id, thesis_id, input_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_thesis_evaluations_thesis_id
  ON thesis_evaluations (thesis_id);
CREATE INDEX IF NOT EXISTS idx_thesis_evaluations_score_id
  ON thesis_evaluations (score_id) WHERE score_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thesis_evaluations_extraction_ai_run_id
  ON thesis_evaluations (extraction_ai_run_id) WHERE extraction_ai_run_id IS NOT NULL;

CREATE OR REPLACE TRIGGER trg_thesis_evaluations_forbid_mutation
  BEFORE UPDATE OR DELETE ON thesis_evaluations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

REVOKE TRUNCATE ON thesis_evaluations FROM anon, authenticated, service_role;
```

No separate `application_id` index — the UNIQUE serves it as a leftmost prefix, which is the only
shape `purge_founder()` queries.

**Why the fingerprint is in the key.** rev.2 used `UNIQUE (application_id, thesis_id)`, which
blocked §6.1's own motivating scenario: feature 05 flips a claim to `contradicted`, and
re-evaluating against the *same* thesis row must produce a new verdict. With `forbid_mutation` the
row cannot be updated either, so the feature's headline behaviour was impossible.

**REVOKE is a new statement**, not an edit to Task 9's existing REVOKE line — self-hosted Supabase
grants TRUNCATE via schema-wide default privileges at `CREATE TABLE` time, so every new
append-only table must revoke explicitly (schema comment; came out of feature 01's QA gate,
commit `fe20c83`).

### §5.2 `purge_founder()` — BLOCKER if the placement is wrong

`thesis_evaluations` RESTRICTs against **three** parents — `applications`, `scores` and `ai_runs` —
and `purge_founder()` deletes `scores` **first**. rev.2 placed the sweep after the `ai_runs`
delete, which the DB reviewer reproduced empirically against the live database:

```
scores DELETE raised: update or delete on table "scores" violates foreign key constraint
"thesis_evaluations_score_id_fkey" on table "thesis_evaluations"
```

Correct placement: after `DELETE FROM founder_company` (`db/schema.sql:855` as of 04:20) and
before the sole-founder subtree block that begins at `:860`:

```sql
-- thesis_evaluations RESTRICTs against applications, scores AND ai_runs, so it
-- must be swept before all three. `scores` (below) is the earliest of them --
-- sweeping any later reproduces the 23503 this file already fixed once for ai_runs.
DELETE FROM thesis_evaluations WHERE application_id = ANY (v_sole_app_ids);
```

⚠️ **Concurrent edits.** Feature 03's `score_components` sweeps are already on disk (`:813-814`);
`db/schema.sql` was last modified 04:20 by another terminal. **Re-read the function immediately
before editing and integrate rather than overwrite.** (rev.2 stated feature 04 had edited this
function — it had not; the edits present are 03's.)

A regression fixture modelled on `db/tests/smoke.sql:986-1032` (the `ai_runs` precedent) is
required in the same commit.

### §5.3 `scores(axis='thesis_fit')`

Compatible with no schema change beyond a registry INSERT — verified against the live database.
`axis` is an FK to `score_axes` (`:343`); `value numeric(5,2) CHECK BETWEEN 0 AND 100` (`:344`)
and `confidence numeric(3,2) CHECK BETWEEN 0 AND 1` (`:346`) already match; `scores_subject_xor`
(`:359-361`) is satisfied by an application-scoped row with `founder_id` NULL.

```sql
INSERT INTO score_axes (slug, label, description, is_screening_axis) VALUES
  ('thesis_fit', 'Thesis Fit',
   'Deterministic thesis-fit score from feature 07 rule evaluation; independent of the three screening axes (invariant #1), never blended.',
   false)
ON CONFLICT (slug) DO NOTHING;
```

`is_screening_axis = false` is required: the three screening axes are fixed per REQ-002. Smoke
needs no edit — 04 relaxed the registry assertions to presence-plus-floor
(`db/tests/smoke.sql:115-122`). Tripwire respected: smoke raises on an axis named `overall`,
`total` or `combined` (`:175-183`).

07 is the **sole writer** of `thesis_fit`. Because several theses may be active, «current
thesis_fit» resolves per `(application_id, axis, thesis_id)` — a **documented query convention,
not a constraint** (`scores` has no uniqueness for any axis; pre-existing `TRACKER.md:101-103`
risk).

> ⚠️ **Corrected after the E1b gate: «current thesis_fit» must be resolved THROUGH
> `thesis_evaluations`, never by reading `scores` directly.**
>
> The earlier wording blessed querying `scores` for the current fit. That is wrong, and QA
> reproduced the consequence: an application scored `passed` at 100, then re-run and degraded to
> `insufficient_evidence`. `applications.thesis_gate` correctly went NULL and **no new `scores`
> row was written** (as designed — an absent row means «not assessed»), but the *old* row is still
> the latest one for that `(application_id, axis, thesis_id)`, so the blessed query happily
> returns a stale **100.00** for an application the system currently cannot assess.
>
> `scores` is append-only, so retracting the row is not an option and would be the wrong instinct
> anyway — the historical fact «this scored 100 under that evidence» remains true. What changed is
> which row is *current*, and only `thesis_evaluations` knows that.
>
> **Correct resolution:** take the latest `thesis_evaluations` row for
> `(application_id, thesis_id)`; if its `verdict` is `insufficient_evidence` (or its `score_id` is
> NULL), the current thesis fit is **not assessed** — not the last number that happened to be
> written. Otherwise follow its `score_id`. Consumers must never reach `scores` for this axis
> without going through the evaluation row first.

Owed as a TRACKER changelog entry.

### §5.4 The `claims` write path — with retry-stable hashes

Real DDL: `claims.card_id NOT NULL`, `claims.text_verbatim NOT NULL`, `claims.content_hash UNIQUE`
(`:273-303`); `raw_signals.observed_at NOT NULL` with no default and `raw_signals.content_hash
NOT NULL UNIQUE` (`:243-248`); `evidence.content_hash NOT NULL UNIQUE` (`:324`).

Ordered write path. **Every step is select-by-hash-first, then insert** — not
`ON CONFLICT DO NOTHING`, which returns zero rows over PostgREST and nulls the provenance FK
(`04/design.md:240`).

| # | Table | Key fields | `content_hash` |
|---|---|---|---|
| 1 | `ai_runs` | `task_type='thesis_extraction'`, `model`, `prompt_version`, `input_hash` | — (keyed by `input_hash`) |
| 2 | `cards` | preflight, see below | — |
| 3 | `raw_signals` | `source='deck_parse'`, **`observed_at` = the gate invocation timestamp, never `now()`** | `sha256(application_id ‖ input_text_hash ‖ prompt_version)` |
| 4 | `claims` | `topic` under `company.*`, `text_verbatim` = the actual quoted span, `value` = normalized label, `source_kind='self_reported'`, `axis` NULL | `sha256(card_id ‖ topic ‖ raw_signal_id ‖ item_key)` |
| 5 | `evidence` | `raw_signal_id` set, `relation='supports'`, `tier='documented'` | `sha256(claim_id ‖ relation)` |

**The hash correction that matters.** rev.2 used `sha256(card_id ‖ topic ‖ ai_run_id ‖ item_key)`,
copied from 04 — but 04 includes `ai_run_id` **deliberately, to force new rows on re-run so
`scores.trend` has history** (`04/design.md:240`). Since step 1 writes a fresh `ai_runs` row on
every attempt, that recipe guarantees a *different* hash per retry: dedup never fires and every
`company.*` claim duplicates, compounding into 03/04/05. Anchoring on `raw_signal_id` fixes it —
`raw_signals`' own hash is retry-stable, so a retry resolves the same row and therefore the same
claim hashes. **07 diverges from 04 here on purpose**: 04 wants re-run history for a trended
score; 07 wants retry-safety for a gate that has no trend. Do not «harmonise» this back.

`item_key` is `'_'` for singleton topics; mandatory whenever a topic can hold N rows per run.

**Gap claims dedup by `(card_id, topic)`, not by hash.** A gap has `content_hash = NULL` by design
(feature 01: «a synthesized/derived `missing` marker claim has no underlying raw content to
hash»), and Postgres treats NULLs as distinct, so the hash cannot serve as the key for these rows.
Same «never blind-insert» principle, different key — applied to the one table where the usual key
does not exist. Additionally the lookup must filter `source_kind = 'derived'`: since gaps now sit
on the base topic (§5.4.1), a real `self_reported` observation from an earlier run would otherwise
be mistaken for an existing gap and the gap would silently never be written.

**The two base hashes the table above depends on**, which rev.3 left undefined — without them
`raw_signals` retry-stability cannot even be asserted:

```
input_text_hash      = sha256(input text, trimmed, internal whitespace collapsed to single spaces)
ai_runs.input_hash   = sha256(application_id ‖ input_text_hash ‖ prompt_version ‖ model)
```

The normalization is the point: an extra newline in a re-fetched deck must not read as new input.

**Card preflight**, reusing 04's resolution verbatim (`04/design.md:262-278`) — the `ORDER BY` is
load-bearing:
`SELECT id FROM cards WHERE application_id = :app AND card_type = 'company' ORDER BY created_at ASC LIMIT 1`,
insert if absent. Sharing the card with 04 is fine (rows are append-only).

`input_fingerprint` for §5.1 = `sha256(sorted list of contributing claim content_hashes ‖ thesis_config_snapshot hash)`.

#### §5.4.1 `company.*` — a new topic prefix owned by 07

No company-level prefix existed. `market.*` and `competition.*` are feature 04's;
`founder.execution|expertise|leadership.*` are 03's. 07 defines and owns `company.sector`,
`company.business_model`, `company.geography_country`, `company.stage_evidence`,
`company.what_is_built`.

**Gaps use the BASE topic with `verification_status = 'missing'`** — *not* a `.gap` suffix
(corrected 2026-07-19; the earlier `.gap` wording was wrong). Feature 01, which owns the schema,
defines a gap as «a claim row with status `missing`» on the topic it is a gap *about*, so a
consumer querying `company.sector` finds the row and can see the attribute was looked for and not
found. A `.gap` suffix would duplicate into the topic string what `verification_status` already
carries, and would hide the gap from exactly the query that should surface it.

Feature 04's `*.gap` convention is **not** in conflict: it applies where there is no base topic to
attach to (e.g. `market.gap` when a whole category could not be researched). Every gap 07 writes is
about a known §1.1 attribute, so the base-topic form always applies here.

### §5.5 Two additive objects on `theses`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_theses_active_name ON theses (name) WHERE active;

ALTER TABLE theses ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- Tied to `active`: a default that is not active is useless to the gate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_theses_single_default
  ON theses ((true)) WHERE is_default AND active;
```

`is_default` resolves an ambiguity rev.1 left open: several theses may be active (the multi-thesis
property NL search needs), but the gate judges by exactly one. Others are evaluated on demand.

**Activation must be an atomic RPC.** With `active NOT NULL DEFAULT true`, inserting v2 while v1
is active violates `uq_theses_active_name` deterministically, and PostgREST cannot transact across
statements. Splitting it into two REST calls is worse than the race: a crash between them leaves
**zero** active rows. The version below was tested by the DB reviewer against the live database.

```sql
CREATE OR REPLACE FUNCTION activate_thesis_version(p_thesis_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_name        text;
  v_was_default boolean;
BEGIN
  SELECT name INTO v_name FROM theses WHERE id = p_thesis_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'activate_thesis_version: no such thesis id %', p_thesis_id;
  END IF;

  -- is_default and active must move together for the same lineage, or a version
  -- bump on the default thesis leaves it default-but-inactive and zero rows
  -- satisfy (is_default AND active) -- the gate then has nothing to load.
  SELECT is_default INTO v_was_default
  FROM theses WHERE name = v_name AND id <> p_thesis_id AND is_default;

  UPDATE theses SET active = false WHERE name = v_name AND active AND id <> p_thesis_id;
  UPDATE theses SET active = true  WHERE id = p_thesis_id;

  IF COALESCE(v_was_default, false) THEN
    UPDATE theses SET is_default = false WHERE name = v_name AND is_default AND id <> p_thesis_id;
    UPDATE theses SET is_default = true  WHERE id = p_thesis_id;
  END IF;
END;
$$;
```

`SECURITY DEFINER` + pinned `search_path` match `purge_founder()`'s posture (`:758-761`) — without
them any holder of the anon key could flip which thesis the fund judges by.

**Insert side, explicitly:** feature 09 must INSERT the new version with `active = false` (the
column defaults to `true`, so omitting it is a deterministic 23505), then call the RPC.

### §5.6 `validate_thesis_config()`

rev.2 described this in prose only. The NULL trap is the whole point and must be visible in code:
`v_rule->>'hard_justification' NOT IN (...)` is **NULL**, not TRUE, when the key is absent, and
`IF NULL THEN` does not execute — so a `hard` rule with no justification at all, the exact case
D-01 exists to block, would pass silently.

```sql
CREATE OR REPLACE FUNCTION validate_thesis_config() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rule jsonb; v_seen_ids text[] := '{}';
  v_kind text; v_enf text; v_just text; v_op text; v_value jsonb;
BEGIN
  -- An empty config is a valid inert thesis the gate refuses to load. Without
  -- this, the column's own DEFAULT '{}' would be rejected and any feature
  -- creating a bare thesis row (08, 09, 11, tests) would fail.
  IF NEW.config IS NULL OR NEW.config = '{}'::jsonb THEN RETURN NEW; END IF;

  FOR v_rule IN SELECT jsonb_array_elements(COALESCE(NEW.config->'rules', '[]'::jsonb)) LOOP
    v_kind := v_rule->>'kind';  v_enf := v_rule->>'enforcement';
    v_just := v_rule->>'hard_justification';
    v_op   := v_rule->'expr'->>'op';  v_value := v_rule->'expr'->'value';

    IF COALESCE(v_kind,'') NOT IN ('deal_breaker','must_have','focus') THEN
      RAISE EXCEPTION 'thesis config: unknown rule kind % (id=%)', v_kind, v_rule->>'id'; END IF;
    IF COALESCE(v_enf,'') NOT IN ('hard','soft') THEN
      RAISE EXCEPTION 'thesis config: unknown enforcement % (id=%)', v_enf, v_rule->>'id'; END IF;
    IF v_kind = 'focus' AND v_enf = 'hard' THEN                                    -- D-04
      RAISE EXCEPTION 'thesis config: focus rule % may not be hard', v_rule->>'id'; END IF;
    IF v_enf = 'hard' AND COALESCE(v_just,'') NOT IN ('mandate_fatal','fraud') THEN -- the NULL trap
      RAISE EXCEPTION 'thesis config: hard rule % requires hard_justification, got %',
        v_rule->>'id', v_just; END IF;
    IF v_kind = 'deal_breaker' AND COALESCE((v_rule->>'weight')::numeric, 0) <> 0 THEN  -- D-04
      RAISE EXCEPTION 'thesis config: deal_breaker % must have weight 0', v_rule->>'id'; END IF;
    IF COALESCE(v_op,'') NOT IN ('eq','in','gte','lte','contains','exists') THEN
      RAISE EXCEPTION 'thesis config: unsupported op % (id=%)', v_op, v_rule->>'id'; END IF;
    IF v_op IN ('gte','lte') AND jsonb_typeof(v_value) <> 'number' THEN
      RAISE EXCEPTION 'thesis config: op % requires a numeric value (id=%)', v_op, v_rule->>'id'; END IF;
    IF v_op = 'in' AND jsonb_typeof(v_value) <> 'array' THEN
      RAISE EXCEPTION 'thesis config: op "in" requires an array value (id=%)', v_rule->>'id'; END IF;
    IF v_rule->>'id' = ANY (v_seen_ids) THEN
      RAISE EXCEPTION 'thesis config: duplicate rule id %', v_rule->>'id'; END IF;
    v_seen_ids := array_append(v_seen_ids, v_rule->>'id');
  END LOOP;
  RETURN NEW;
END; $$;

CREATE OR REPLACE TRIGGER trg_theses_validate_config
  BEFORE INSERT OR UPDATE ON theses FOR EACH ROW EXECUTE FUNCTION validate_thesis_config();
```

`contains`'s type dispatch (§1.1) is **deliberately not validated here** — the trigger would need
a copy of the attribute-type table, which would then drift. It is checked at evaluation time; an
`expr` whose operand type does not fit its field yields `unknown`, never a crash.

---

## §6 · Workflows and feed

### §6.1 Two workflows, two modes

**`f07-thesis-gate`** — called by 08 (intake, `mode: 'full'`) and 02 (radar Tier 1,
`mode: 'keyword'`).

```
{application_id, text, mode, structured_hints?}
  mode='full':    ai_runs → cards → raw_signals → claims → evidence      (§5.4)
  mode='keyword': no LLM call at all; only _text rules and structured_hints evaluate
  → load default thesis (is_default AND active), compile mandate → rules  (§1.2)
  → three-valued evaluation (D-03) → fit + coverage (§3)
  → verdict procedure (§2)
  → scores(thesis_fit) unless insufficient_evidence, + thesis_evaluations
  → write applications.thesis_gate (NULL on insufficient_evidence) + thesis_id
  → events: gated_out counter | thesis_gate_insufficient_evidence
  → {verdict, fit, coverage, fired_rules, missing_fields}
```

**Why two modes.** §8.2 promises 02 a Tier 1 with «no LLM, no GitHub token, HN text only», and
02's own design puts the gate before any enrichment spend. rev.2's single path always called the
extractor. Simply skipping it would be worse: every attribute becomes `unknown`, coverage → 0, and
**every** Tier-1 candidate returns `insufficient_evidence`, so 02's funnel produces no verdicts at
all and its `gated_out` counter stays 0.

In `keyword` mode the coverage gate is **bypassed** (there is no extraction to be short of) and the
verdict collapses to `failed` (a negative-keyword hit on a hard rule) or `borderline` (everything
else). **Keyword mode never returns `passed`** — it is a cheap negative filter, not an endorsement.
This keeps 02's three-way branch total.

**Keyword mode writes no `scores(thesis_fit)` row, and writes `coverage = NULL`.** Without this
rule the mode reintroduces exactly the defect D-07 exists to prevent: every Tier-1 candidate
evaluates its `must_have`/`focus` rules to `unknown`, so `coverage = 0.00` and `fit = 0`, and a
`borderline` verdict would write a `scores` row that ranks the **entire radar population** at
`thesis_fit = 0` — mutually indistinguishable and buried beneath every inbound application. That
is the disclosure-quality trap D-07 cites as its own justification, re-entered through the back
door. Keyword-mode rows therefore persist exactly like `insufficient_evidence` (§2's table): the
evaluation row is written in full, the score row is not. `failed` is the one verdict that still
persists normally, because a negative-keyword hit is a real observation.

Feature 02 is unaffected — it branches on the returned verdict, not on the feed.

**`structured_hints` — shape, normative.** A partial map of §1.1 attribute keys the caller already
knows, so the gate need not re-derive them. Every key optional; unknown keys ignored; values must
come from §1.1's closed sets or the field is treated as absent. Feature 02 supplies
`{ geography_country }` from its GitHub-location normalization. Hints are merged **under**
extraction output in `full` mode (a grounded extraction wins over a caller's guess) and are the
**only** attribute source in `keyword` mode.

```jsonc
{ "geography_country": "DE", "sector": "devtools" }   // any subset of §1.1's gateable keys
```

**Input contract.** 07 does **not** build a deck parser: `deck_parse` exists only as a
`signal_sources` slug with no owning feature and no implementation anywhere in the repo, and
building one absorbs another feature's scope. The gate takes **text** plus optional structured
hints; callers supply what they have.

**`f07-thesis-reevaluate`** — **does not re-extract**. Reads current claims, evaluates against a
given thesis version, writes new `thesis_evaluations` rows (a new `input_fingerprint`; §5.1).
Existing rows are never touched. This delivers what NotebookLM calls the highest-value named
workflow: automatically «resurface deals that we qualified out in the past».

Re-evaluation reads **current claims**, not the frozen snapshot: 05 writes `contradicts` evidence
and flips `verification_status`, and corrections arrive via `supersedes_claim_id`. Reflecting what
we now know is the point. `contradicted` claims are treated as `unknown` (D-03) — a contradicted
attribute is precisely «we do not reliably know this», so it must not fire a hard rule.
`extracted_snapshot` exists purely to reproduce the historical row.

### §6.2 Retry and resume semantics

n8n has no cross-node transaction, so this is stated rather than left to the implementer:

> **Every step is attempted unconditionally on every run, regardless of whether its upstream
> dependency was freshly written or found pre-existing on this call.** «Found existing» never
> means «nothing left to do».

Without this rule a run that died after inserting `thesis_evaluations` but before updating the
`applications` cache would be stuck forever: the retry finds the evaluation row, concludes it is
done, and the application stays invisible in every feed lane. Each step is independently keyed
(§5.4), so unconditional re-attempts converge rather than duplicate.

### §6.3 History, and what the pointer is

«History is never rewritten» applies to `thesis_evaluations`, `scores`, `ai_runs`, `claims`.
`applications.thesis_gate` / `thesis_id` are a **cache of the current verdict**, written on every
evaluation — rev.1 asserted both «pointer to current state» and «never UPDATEs», which cannot both
hold. `applications.thesis_id` stays nullable: 04 assumes it is often NULL with a defined fallback
(`04/design.md:371`), and 01 made it nullable so minimal intake need not depend on a seeded thesis
(REQ-008, smoke-tested at `db/tests/smoke.sql:279-302`).

Kruncher states the user-facing semantics verbatim: «New investment criteria will only apply to
future analyses. Existing company reports under a previous criteria will remain unchanged.»

### §6.4 Feed lanes

Default sort `thesis_fit desc` within `passed`; `borderline` below as **«Outside thesis»** —
down-ranked, never hidden.

**«Off-thesis but exceptional»** pinned above both: verdict `borderline` **and** an
`exceptional_lane` score at or above `min_value`. Lane-3 rows are **removed from** lane 2, not
duplicated (rev.2 rendered every lane-3 row in both, with opposite priority).

The axis is `founder_score`, written by 03 and **founder-scoped** (`founder_id` set,
`application_id` NULL — guaranteed by `scores_subject_xor`), while the lane filters applications.
The join is therefore explicit:
`applications → companies → founder_company → founders → scores(axis='founder_score')`,
aggregated by **`max` over current founders** (`founder_company.is_current`), configurable via
`exceptional_lane.aggregate`. **An absent `founder_score` excludes from the lane without implying
a low score** — 03 guarantees the row is absent for insufficient-evidence founders
(`03/design.md` §2.4), and 04's consumer contract says an absent axis row means «not assessed».

This lane is the anti-portfolio affordance made literal: Bessemer's anti-portfolio (Zoom, Tesla,
Google, PayPal) is almost entirely **thesis-shaped rejections rather than quality judgements**.

**Dependency:** needs `founder_score` from 03. Until 03 lands the lane renders empty.

---

## §7 · The starting thesis

«B2B tech · pre-seed/seed · EU+US · $100K», mirroring the sponsor's mandate with the stage mapped
onto our schema (`companies.stage ∈ pre_seed|seed`; theirs is late seed → Series A, out of scope).
Seeded with **`active = true` and `is_default = true`** — without a default row satisfying
`is_default AND active`, the gate has nothing to load and every call fails (rev.2 omitted this).

⚠️ **The migration and this seed must land in the same commit.** `is_default` defaults to `false`,
so immediately after §5.5 runs, zero rows satisfy `is_default AND active` and the gate is dead
until the seed executes. Verified live during the rev.3 SQL check.

The gate cannot run without a thesis, so this row is *system configuration*, not demo data, and
ships in 07's SQL. Its SQL comment must not cite internal FACT-/REQ- ids or characterize the
sponsor's private mandate — `db/` is public, `internal/` is not (CLAUDE.md publication gate).

**Templates** («Sponsor mirror», «Deep tech spinout», «Pre-formation stealth») — nice-to-have,
first on the cut list.

---

## §8 · Boundaries, contracts, QA

### §8.1 Boundaries

No multi-tenancy. `expr` has **no boolean composition** (AND/OR/NOT across predicates) — only
`negate` on a single predicate; «at least one of X or Y» is inexpressible, accepted for MVP.
Thesis back-testing **post-MVP** (an honest replay requires re-invoking the agent; the cheap
version reads the already-computed distribution while looking more substantial than it is).
Miss-rate calibration post-MVP. Input-side identity masking post-MVP.

**`failed` is rare by construction, and that is a policy choice.** All compiled mandate rules are
`soft` (§1.2), so `failed` requires a hand-authored `hard` rule — in the starting thesis, exactly
one (gambling/adtech). Stated here so nobody discovers at demo time that `gated_out ≈ 0`. If a
higher rejection rate is wanted, the mechanism is a `fit` floor in the verdict procedure, and it
should be a deliberate D-01 amendment rather than something that emerges.

### §8.2 Cross-feature contracts

| Feature | Consumes / produces |
|---|---|
| 02 radar | calls `f07-thesis-gate` with `mode='keyword'` in Tier 1 — no LLM, no GitHub token; branches on 3 values; **must also handle `thesis_gate = NULL`** (D-05); needs failed verdicts persisted and a `gated_out` counter |
| 04 market | reads `theses.config.geos` at runtime (`04/design.md:371`) — the alias in §1 exists for it; reads `applications.thesis_id`, which stays nullable |
| 08 intake | calls `f07-thesis-gate` with `mode='full'` and deck text |
| 03 / 05 | consume `company.*` claims; 05 verifies them via `evidence` |
| 06 memo | reads `thesis_evaluations.fired_rules` (shape fixed in D-04) |
| 09 dashboard | three feed lanes + config form; INSERTs versions with `active=false` then calls `activate_thesis_version` |
| 10 API | `theses`, `thesis_evaluations` via PostgREST |

**Build conventions inherited from 03/04** (non-negotiable): n8n Code nodes cannot import from the
repo — no bind-mount, no `NODE_FUNCTION_ALLOW_EXTERNAL` — so evaluator logic lives in
`lib/f07/*.js` as self-contained zero-import CommonJS behind a `// SOURCE OF TRUTH` header, pasted
verbatim into Code nodes. Tests under `node --test`, no `package.json`, no dependencies. Workflows
named `f07-*`, exported to `n8n/workflows/`, which already holds `f04-db-write.json`,
`f04-market-intel.json` and `README-f04.md`. `f04-db-write.json` is a sub-workflow invoked via
`executeWorkflowTrigger` — the shape `f07-db-write` should mirror, and its card-preflight step is
already the one §5.4 borrows verbatim, so check whether it can be **called** rather than copied.

### §8.3 What @qa-engineer must attack — independently, never the dev's own tests

1. **Coverage protection (D-07).** Two runs of one application against one thesis, the second with
   two extracted fields removed: the sparse run must land `insufficient_evidence` and write **no**
   `scores` row — it must never appear ranked below the full run. This is the invariant rev.1 and
   rev.2 both broke; assert the *guarantee as stated in D-07*, not «fit does not drop».
2. **`unknown` cannot reject.** Hard deal-breaker on `sector` + an application where sector was not
   extracted → `insufficient_evidence`, never `failed`.
3. **Open door.** A soft deal-breaker yields `borderline`, visible under «Outside thesis».
4. **D-01 at the DB level, including the NULL case.** `enforcement='hard'` with
   `hard_justification` **absent entirely** must be rejected — not merely an invalid value.
5. **D-04 legality.** `focus`+`hard` rejected; `deal_breaker` with non-zero weight rejected.
6. **Empty config accepted** (§5.6 early return) and such a thesis is not loadable by the gate.
7. **Activation.** After a version bump on the default thesis, exactly one row satisfies
   `is_default AND active`, and it is the new version. A raw INSERT with `active` defaulted is
   rejected. Mid-call failure never leaves zero active or zero default rows.
8. **Append-only.** UPDATE/DELETE on `thesis_evaluations` refused; TRUNCATE revoked for all three
   roles.
9. **`purge_founder()` works** with `thesis_evaluations` rows present — regression fixture modelled
   on `db/tests/smoke.sql:986-1032`, with the evaluation row referencing both a `scores` row and an
   `ai_runs` row (that is the combination that reproduced the 23503).
10. **Idempotency.** Running `f07-thesis-gate` twice produces exactly one evaluation row, one
    `scores` row, and **no duplicated claims** — this is the test the rev.2 hash recipe failed.
11. **Resume.** Kill the workflow after each node; the retry converges to exactly one row per
    table and leaves no application with an evaluation row but a stale cache (§6.2).
12. **Re-evaluation without a version bump** (05 contradicts a claim) produces a *second*
    evaluation row rather than a UNIQUE violation.
13. **Anti-sycophancy — structural.** Assert the extraction `ai_runs` prompt payload contains **no
    thesis fields**. rev.1's «identical to the character» test was vacuous under caching and flaky
    without it.
14. **Keyword mode never returns `passed`**, never calls the LLM, writes **no** `scores` row, and
    writes `coverage = NULL` — assert the radar population is absent from the ranked feed.
15. **Soft deal-breaker cannot reach the top lane.** A thesis where every rule matches plus one
    triggered soft deal-breaker scores exactly `strong_threshold`; assert the verdict is
    `borderline` (§2 step 2b), not `passed`.
16. **`coverage` never exceeds 1** when a rule is `enabled: false` (§3.2).

### §8.4 README open questions — resolved

*Default demo thesis* → yes, mirrors the sponsor (§7). *Deal-breakers hard-hide or gray-out?* →
gray-out, now D-01 with DB enforcement.

**Handed onward:** anonymization vs founder-driven assessment → feature 03.

### §8.5 Scope and cut order

Cuttable under time pressure, in order: templates (§7) → «Off-thesis but exceptional» lane (§6.4)
→ `f07-thesis-reevaluate` (§6.1). Non-cuttable core: extraction → three-valued rules → verdict
procedure → append-only evaluation rows → the `purge_founder()` patch (§5.2, a correctness
obligation, not a feature).

**TRACKER changelog entries owed** (rule 2): the new table with its REVOKE/trigger; the
`purge_founder()` edit; the `thesis_fit` registry row and sole-writer claim; `uq_theses_active_name`,
`is_default`, `uq_theses_single_default` and the `activate_thesis_version` RPC; the `company.*`
claim prefix; the «current thesis_fit resolves per (application_id, axis, thesis_id)» convention;
and **the notice to 02 that `thesis_gate = NULL` is a reachable post-gate state**.

---

## §9 · Revision audit trail

### rev.3a — corrections from the focused math/SQL verification

The six-case hand computation confirmed the formula and that D-07 holds for `full` mode. Four
defects surfaced anyway:

| # | Defect | Fix |
|---|---|---|
| 1 | **`keyword` mode re-entered the D-07 violation.** coverage 0.00 → `borderline` → a `scores` row → the whole radar population ranked at `thesis_fit = 0` | keyword mode writes no `scores` row and `coverage = NULL`; new `evaluation_mode` column makes the NULL interpretable (§5.1, §6.1) |
| 2 | **A triggered soft deal-breaker could reach the top lane.** All rules matching plus one trigger = exactly 70.00 = `strong_threshold` → `passed`, contradicting D-01 and §8.3 test 3 | §2 step 2b |
| 3 | §3.2 omitted `enabled`, so a disabled rule could push `coverage > 1` and violate two CHECKs | added |
| 4 | D-04's `unknown` row said «*any*» kind adds to `total`, contradicting §3.1 for `deal_breaker` | row split by kind |

SQL verified by execution against the live database inside a rolled-back transaction: all three
blocks clean, `forbid_mutation()` signature matches, `ON theses ((true)) WHERE is_default AND
active` valid and enforcing, the validator blocks all three target cases including the NULL trap,
and `activate_thesis_version` leaves exactly one `is_default AND active` row after a bump.

### rev.2 → rev.3

| # | rev.2 said | rev.3 says | Forced by |
|---|---|---|---|
| 1 | normalized ratio fixes REQ-003 | **D-07**: no arithmetic fix exists; coverage gate + explicit guarantee | spec review 2 — worked example: 68.75 → 0 purely on missing fields |
| 2 | truth table beside the formula | one table that *is* the formula (D-04) | spec review 2 — three contradicting cells; `focus`/`no_match` had no legal outcome |
| 3 | ratio over all applicable rules | `deal_breaker` weights excluded; validator enforces weight 0 | spec review 2 — a non-triggered deal-breaker *raised* fit; a triggered one was penalised twice |
| 4 | `_text` used, undefined | `_text` in §1.1; `contains` semantics; empty array → `unknown`; keyword rules compiled only when non-empty | spec review 2 |
| 5 | claims path «fully specified» | `evidence.content_hash` and `raw_signals.observed_at` specified; select-first on all three | spec review 2 + DB review 2 — both NOT NULL, both omitted |
| 6 | claims hash includes `ai_run_id` | anchored on `raw_signal_id` | both reviews — 04 includes `ai_run_id` *deliberately to defeat* dedup; retries duplicated every claim |
| 7 | purge sweep after `ai_runs` | before the `scores` delete (`:855`) | DB review 2 — **reproduced live**: 23503 on `thesis_evaluations_score_id_fkey` |
| 8 | «04 already edited `purge_founder`» | the edits on disk are 03's | spec review 2 — factual error |
| 9 | `UNIQUE (application_id, thesis_id)` | + `input_fingerprint` | spec review 2 — blocked re-evaluation without a version bump, i.e. §6.1's own motivating case |
| 10 | RPC touches `active` only | migrates `is_default` too; index tied to `active` | DB review 2 — **reproduced live**: after a bump, `is_default AND active` → 0 rows |
| 11 | single workflow path | `mode: keyword | full` | spec review 2 — §8.2 promised 02 a no-LLM Tier 1 that did not exist; skipping the extractor would return `insufficient_evidence` for every candidate |
| 12 | «left NULL» | explicit NULL **write**; 02 notified | spec review 2 — ambiguous on re-gate, and NULL falls through 02's branch |
| 13 | no `geos` key | `geos` alias added | spec review 2 — 04 is in build and reads `theses.config.geos` |
| 14 | lane axis named, join implicit | explicit join + `max` aggregation + absent≠low | spec review 2 — `founder_score` is founder-scoped, the lane filters applications |
| 15 | validator in prose | actual plpgsql, with the empty-config early return | DB review 2 — «cannot verify a fix that isn't written down»; the DEFAULT `'{}'` would have been rejected |
| 16 | no resume semantics | §6.2 unconditional-retry rule | DB review 2 |
| 17 | RPC unqualified | `SECURITY DEFINER` + pinned `search_path`; INSERT must set `active=false` | spec review 2 — anon key could flip the fund's thesis |
| 18 | starting thesis, no flags | `active=true, is_default=true` | spec review 2 — a fresh DB otherwise has zero defaults and the gate cannot run |
| 19 | «no edit to a feature-01 object» | corrected — three edits to `theses` | spec review 2 |
| 20 | `failed` rate unexamined | §8.1 states it is rare by construction | spec review 2 |

### rev.1 → rev.2

Recorded so the reasoning is not re-litigated: three-valued evaluation replacing subtraction;
ordered verdict procedure replacing prose; the attribute vocabulary table (geography was `EU` /
`DE` / `Berlin` in three sections); explicit mandate compilation; `is_default` + activation RPC;
dropping the fourth `thesis_gate` enum value in favour of 03's `events` precedent; config snapshot
instead of an immutability trigger; `REVOKE TRUNCATE` + `forbid_mutation` for the new table;
integer thresholds replacing fabricated decimals; the `strictness` enum cut; the normalized
formula; lane 3 removed from lane 2; the pointer redefined as a cache; `contradicted` → `unknown`;
the anonymization claim downgraded to the output schema; the structural anti-sycophancy test;
Kruncher relabelled commercial precedent; the grep-based differentiation claim softened.
