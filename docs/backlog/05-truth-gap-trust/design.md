# 05 · Truth-Gap Check & Trust Score — Design

> Status: **for spec review** · 2026-07-19 · Owner: orchestrator session (05 terminal)
> Depends on: 01 (schema), 03 (founder score output), 04 (market/competition output)
> Blocks: 06 (memo), 09 (dashboard)
> Approach: **B — full claim router over every claim** (operator decision, 2026-07-19 ~09:05)

---

## 1. Scope and the invariants this feature exists to protect

Feature 05 is the diligence layer. It takes the claims other features produced, decides for each
one **what kind of checking it can honestly bear**, checks it against facts, records contradictions
as data, and rolls the result up into one application-level Trust axis.

Four sponsor invariants are load-bearing here. Every design decision below is traceable to one:

| ID | Invariant | How this design enforces it |
|---|---|---|
| **REQ-003** | Missing data → lower *confidence*, never the founder's score | 05 writes only `scores(axis='trust')`. `founder_score` is a different axis with a different writer (03) and is structurally unreachable from here. Gaps enter `missing_flags` and depress rollup `confidence`. |
| **REQ-004** | Never fabricate; mark gaps honestly | `unverifiable` router class writes an honest `missing` row and a deep-dive question. No branch may invent a value. |
| **REQ-002** | Scores are not collapsed early | `trust` is seeded `is_screening_axis = false` — it never blends into Founder / Market / Idea-vs-Market. |
| **Invariant #3** | Trust is per **claim**, not per company | Per-claim trust is a live-computed view. Only the *rollup* is stored, and only at application level. |

### 1.1 The primary technical risk, stated up front

Published fact-verification research says the two labels we care about most are the two nobody can
predict. On the AVeriTeC 2025 shared task **no system scored above 0.1** on *Not Enough Evidence*
or *Conflicting Evidence / Cherry-picking*; several teams dropped those labels entirely. In the
2024 human evaluation, of claims humans labelled NEE, systems answered **"Refuted" 60.3%** of the
time. Separately, REFNLI (1,143 expert-judged pairs) found that NLI models and few-shot LLMs alike
produce **>80% false contradictions** when evidence context does not actually match the subject.

Read against REQ-003/REQ-004 this says: **a naive verifier converts our honest gaps into false
accusations against founders.** That is the exact failure that costs us rubric points, and it is
why the router (§4) and the entity gate (§6) are structural rather than prompt-level.

---

## 2. Inputs — what already exists

Measured against the live database, 2026-07-19 ~08:55.

| Input | Volume | Notes |
|---|---|---|
| `claims` | **724** (652 `unverified`, 72 `missing`) | Nothing has been verified yet; the whole corpus is 05's queue. |
| `evidence` | 672 | Already tiered `documented`/`discovered`/`inferred`/`missing` with `strength` — feature 04 populated this precisely so 05's rollup is `f(tier, relation, strength)`. |
| `raw_signals` | 846 (`github_api` 260, `hn_algolia` 392, `tavily_extract` 170, `tavily_search` 14, `deck_parse` 10) | **The main asset.** Most static verification is a query against facts already collected, not a new external call. |
| `score_components` | 44 rows `verdict='self_asserted'` | 03's designated verification queue (indexed). |
| `ai_runs` | 24 rows carrying `red_flags[]` | 03 emits flags **for 05 to verify**; there is no red-flags table, they live in `ai_runs.output_json`. |
| `cards` | 126 (121 founder, 5 company) | 123 applications carry claims. |

### 2.1 Contracts inherited (binding, not negotiable)

- **`claims.verification_status` is unused by 03 and 04** — 03 never reads it; 04 only ever writes
  `unverified` or `missing`. The column is 05's to own.
- **`evidence.raw_signal_id` must always be populated** on rows 05 writes. 03's negative-capability
  guard resolves a claim's source through that column; when it is NULL it falls back to
  `claims.source_kind`, where `public` maps to a **wildcard** that matches any required source.
  A NULL there silently licenses `not_met` verdicts on criteria the evidence says nothing about.
- **04 already produces one contradiction**: `competition.founder_claim_mismatch`, with
  `nature ∈ factual|definitional|methodological|temporal|scope` and
  `severity ∈ minor|moderate|material`, deterministically assigned. It writes an accompanying
  `contradicts` evidence row **with no `source_url`, no `quote_verbatim`, no `raw_signal_id`.**
  05's rollup must accept unsourced contradiction rows rather than dropping them.
  ⚠️ Measured 2026-07-19: **this row has never fired live** — all three `contradicts` rows in the
  database carry a `source_url`. It is a designed-for shape, not an observed one, so **the demo must
  not depend on it.** The demo contradiction comes from `founder.execution.provenance` (documented,
  0.85, no supports → renders `contradicted`) and `founder.execution.tech` (documented, 0.75), both
  real and both reproducible today.
- **`verification_status='missing'` claims are deliberate data**, with human-readable
  `text_verbatim` — not absences to filter out.
- **An absent axis row means "not assessed", never zero.**
- 03's topic prefixes (`founder.execution.*`, `founder.expertise.*`, `founder.leadership.*`) are
  bound to its sub-scorers and must not be repurposed.

---

## 3. Vocabulary — two orthogonal axes, zero schema change

Both the internal intel review and the external research arrived independently at the same
conclusion: provenance ("where did this knowledge come from") and verdict ("is the assertion true")
are different axes, and **only the two-field form can express REQ-003 honestly** — `missing` is a
provenance state while `contradicted` is a verdict. Collapsing them forces us to fake one.

The schema from feature 01 already has this split. We add nothing.

**Verdict — `claims.verification_status`** (existing CHECK, mapped onto the AVeriTeC label set):

| Value | Label | Condition |
|---|---|---|
| `verified` | Supported | ≥1 **independent** `supports` at tier `documented`/`discovered`, no `contradicts` |
| `contradicted` | Refuted | ≥1 `contradicts` at **`documented` tier** that passed the entity gate (§6), with no supports — see §7.4, which is authoritative |
| `partially_supported` | Conflicting / Cherry-picked | both `supports` and `contradicts` present, or supported only under a narrower scope |
| `unverified` | Not Enough Evidence | default; whether or not a check was attempted |
| `missing` | First-class gap | "Cap table: not disclosed" (REQ-004) |

**Provenance — `evidence.tier`** (existing CHECK): `documented` / `discovered` / `inferred` /
`missing`. 05 populates it; it is never conflated with the verdict.

**"Verification attempted" needs no new enum value.** Feature 04 established the convention that a
search which ran and found nothing is recorded as `tier='missing', relation='context'`. The fact of
an attempt is therefore derivable from evidence. This deliberately avoids widening a CHECK
constraint that features 06 and 09 will read.

---

## 4. The router

Every claim is assigned exactly one class **before any verdict model runs**. This is the structural
answer to §1.1: the decision "this claim cannot honestly bear a verdict" is made by an auditable
table, not by a model's softmax.

| Class | Verification | May emit `contradicted`? | External cost |
|---|---|---|---|
| `factual_static` | Against `raw_signals` already in the database, plus stable public APIs | yes | **none** |
| `factual_dynamic` | Tavily search, capped per card | yes | paid |
| `qualitative` | Provenance and confidence only — **no verdict is ever produced** | **no, structurally** | none |
| `unverifiable` | Honest `missing` + a deep-dive question for 06 | **no, structurally** | none |
| `forecast` | Behaves exactly as `qualitative`, with a distinct display label ("Forecast") | **no, structurally** | none |
| `precomputed` | Already carries a verdict from upstream (04's mismatch); ingested, not re-checked | n/a | none |

**Six class names, one vocabulary** — `factual_static`, `factual_dynamic`, `qualitative`,
`forecast`, `unverifiable`, `precomputed`. `forecast` is a first-class name rather than a subtype so
that a builder writing `class IN (…)` has exactly one list to work from.

**`precomputed` touches no verification branch.** Those claims are read-only inputs to the view and
to the rollup; §5's four branches never process them. Named here because §8.2 counts them as
verdict-eligible and a builder would otherwise look for a fifth branch.

### 4.1 Routing mechanism

**Longest-prefix match against a table in `score_formulas.config.router.prefix_map`.** The 49
distinct topics live in the database today are fully covered by the table, so in practice the
router costs nothing and is fully auditable. An LLM classifier (§9.3) is the fallback for topics
the table does not know — honest extensibility, not the default path.

```jsonc
"router": {
  "prefix_map": [
    { "prefix": "founder.execution.merged_pr_foreign",  "class": "factual_static",  "check": "gh_merged_pr" },
    { "prefix": "founder.execution.commit_consistency", "class": "factual_static",  "check": "gh_commit_weeks" },
    { "prefix": "founder.execution.provenance",         "class": "factual_static",  "check": "gh_provenance" },
    { "prefix": "founder.execution.live_product",       "class": "factual_static",  "check": "url_liveness" },
    { "prefix": "founder.execution.external_usage",     "class": "factual_static",  "check": "gh_dependents" },
    { "prefix": "founder.execution.traction",           "class": "factual_dynamic", "check": "web_traction" },
    { "prefix": "founder.execution.",                   "class": "factual_static" },
    { "prefix": "founder.expertise.",                   "class": "qualitative" },
    { "prefix": "founder.leadership.",                  "class": "qualitative" },
    { "prefix": "market.size_",                         "class": "forecast" },
    { "prefix": "market.growth",                        "class": "factual_dynamic" },
    { "prefix": "market.",                              "class": "qualitative" },
    { "prefix": "competition.founder_claim_mismatch",   "class": "precomputed" },
    { "prefix": "competition.competitor",               "class": "factual_static",  "check": "competitor_exists" },
    { "prefix": "competition.",                         "class": "qualitative" },
    { "prefix": "company.geography_country",            "class": "factual_static" },
    { "prefix": "company.what_is_built",                "class": "factual_dynamic" },
    { "prefix": "company.stage_evidence",               "class": "factual_dynamic" },
    { "prefix": "company.sector",                       "class": "qualitative" },
    { "prefix": "company.business_model",               "class": "qualitative" },
    { "prefix": "round.",                               "class": "unverifiable" },
    { "prefix": "traction.",                            "class": "factual_dynamic" }
  ],
  "default_class": "unverifiable"
}
```

**`default_class` is `unverifiable`, i.e. fail-safe and free.** An unknown topic produces an honest
gap and a deep-dive question — never a verdict, never a paid call. `competition.status_quo_alternative`
is live 04 vocabulary that matched none of the specific entries, which is exactly the case the
catch-all rows above and this default now cover. An LLM classifier remains a possible later upgrade;
it is **not** in MVP, and the corresponding agent spec is cut.

⚠️ **The default is fail-safe but must not be fail-silent.** Every prefix family therefore carries a
catch-all (`founder.execution.`, `founder.expertise.`, `founder.leadership.`, `competition.`,
`market.`), and any topic that still reaches `default_class` emits a **`router_unmatched_topic`
event**. Without it an unrecognised factual topic degrades into a permanent silent gap with no
signal that the router simply did not know it.

This is not hypothetical. `founder.execution.tech` carries a live `documented`-tier contradiction and
matched none of the specific `founder.execution.*` leaves; before the catch-all above was added it
would have been pinned to `unverified` and its contradiction would never have reached the investor.

### 4.2 Why this makes approach B affordable

Applying the table to the live corpus:

| Class | ≈ claims | Paid calls |
|---|---|---|
| `qualitative` (incl. `forecast`) | ~430 — 124 `written_communication`, 98 `unasked_work`, 73 `vertical_tenure`, 66 `insight_specificity`, market outlook/trend, plus the 18 `market.size_*` TAM claims moved here by §4.2a and the `company.sector`/`business_model` set | 0 |
| `factual_static` | ~240 — 72 `provenance`, 71 `live_product`, 34 `external_usage`, 33 `merged_pr_foreign`, 25 `commit_consistency` | 0 |
| `factual_dynamic` | ~40–50 — deck-sourced traction and stage claims, `market.growth`, `company.what_is_built` | **the only paid branch** |
| `unverifiable` / `precomputed` | the rest, plus anything the table does not match | 0 |

Full coverage of all 652 unverified claims at roughly 40–50 paid checks. Counts are approximate and
must be re-derived against the live database before the budget cap is locked.

### 4.2a Forecasts are separated from facts *before* the verification queue

`market.size_*` (TAM) is routed to the `forecast` class, not `factual_dynamic`. `forecast` behaves
exactly as `qualitative` at verdict time (§7.4 row 1) and enters the same branch (§5.3); it exists as
a separate class name only so the UI can label it "Forecast" rather than merely "unverified".
Optimistic TAM is **expected noise at pre-seed, not a punishable lie** — attempting to "verify" a
projection against search results is itself a fabrication path, because a forecast, an allegation
and a confirmed fact all read identically in a model's output. Forecasts are tagged and shown as
forecasts. They never enter the factual verification queue and never produce a verdict.

The same applies to any claim about future capability. This is the router's second structural
honesty guarantee, alongside §4.3.

### 4.3 The qualitative guarantee is enforced by construction

The `qualitative`, `forecast` and `unverifiable` branches **never write `supports` or `contradicts`
evidence rows — only `context`.**

⚠️ **That alone is not sufficient, and an earlier draft of this design was wrong to claim it was.**
It constrains only the evidence *05* writes; features 02, 04 and 07 have already written sourced
`supports` rows on these very topics. The guarantee is therefore enforced **in the view**, by
gating the verdict on the router class — see §7.1, which carries the measured evidence. Both halves
are needed: the branches do not manufacture verdict-bearing evidence, and the view refuses to turn
anyone else's into a verdict.

---

## 5. The four verification branches

### 5.1 `factual_static` — deterministic, against facts already collected

Four sub-checks, all zero-LLM, all writing `evidence` with `raw_signal_id` populated:

**(a) `quote_guard` — fabrication signature detection.** A JS port of `quote_salience_mismatches`
from `due-diligence-agents` (Apache 2.0; NOTICE required). Its premise is the failure mode our
trust layer must survive: fuzzy citation matching at 0.85 similarity "waves through small but
*material* adversarial edits" — `"90 days"` → `"30 days"`, `"$2,000,000"` → `"$5,000,000"`, a
flipped negation — all of which score 0.93–0.99 and pass. A salient token present in the claim but
unsupported by the source is a **positive contradiction**, not a mere non-match.

Port these choices verbatim, they are load-bearing:
- ±5% numeric tolerance ("rounding and magnitude phrasing are not fabrication")
- 15% duration tolerance for cross-unit comparison
- **directional, windowed** negation check — flags only when the *quote* asserts a negation absent
  from the aligned ±240-character source window
- deliberately narrow strong-negation regex, excluding bare "no" so it does not fire on
  "no later than"

This also closes a real gap: 03's gate only substring-checks quotes, which the above edits survive.

**Scoped for the clock:** applied to **deck-sourced claims only** — `quote_verbatim` is populated on
roughly 40% of evidence rows project-wide, and deck claims are where the fabrication risk actually
concentrates. Measured 2026-07-19: **44 claims** carry a quote and are deck-sourced or
self-reported, so the module has a live call site.

> **Correction, recorded rather than quietly fixed:** an earlier draft dropped the duration branch on
> the stated grounds that "durations are rare in this corpus". That was an assumption, never
> measured, and it is very likely wrong — deck claims are full of durations ("12-month runway",
> "90-day pilot"). It also contradicted this same section's own required test case, since
> `"90 days"` → `"30 days"` **is** the duration branch and no other extractor catches it. All four
> branches ship.

**(b) GitHub provenance vs independent anchors — reduced to one comparison for MVP.**

> **Scope ruling:** the full forensic suite below is the largest single effort item in this feature
> and yields no verdict by its own admission (§13: "consistent with" phrasing only). **MVP ships
> exactly one check: earliest commit author date versus the Show HN submission date**, both of which
> are already in `raw_signals` — zero new API calls. The rest is documented here as the designed
> shape and is built only if the clock allows.

Git stores two timestamps per commit —
`author date` (survives rebase) and `committer date` (rewritten by rebase/amend/cherry-pick), both
returned by `GET /repos/{owner}/{repo}/commits`. Signals: committer date earlier than author date;
author timezone ≠ committer timezone; committer dates clustered in a narrow window while author
dates spread over months (the signature of a squashed import).

**Both timestamps are fully user-controlled (`git commit --date`), and commits squashed before push
are simply not observable.** Therefore the output phrasing is fixed: *"consistent with a rewritten
or imported history"* — **never** an accusation. The actionable finding comes from **anchors the
founder does not control**: the Show HN submission date (392 `hn_algolia` signals already in the
database), the site's first capture, package-registry first publish. A repository whose earliest
commit postdates the company's first public trace by months is the finding.

**(c) Denominator extraction.** Every rate or percentage claim has its definition and denominator
extracted. This is the Presto lesson from SEC enforcement: "95% without intervention" turned out to
mean *without intervention by restaurant staff* — the number was real, the definition was
misleading. No denominator → the claim cannot reach `verified`; it caps at `unverified` and
generates a deep-dive question.

**(d) ~~Vanity-metric check~~ — cut from MVP.** Star-to-fork ratio and dependents count would
duplicate feature 03's existing red flag R2, which already demotes on this signal. Re-scoring it
here would double-count against the Trust axis — the exact thing 03's design forbids.

### 5.2 `factual_dynamic` — Tavily, capped

- **Temporal filter:** discard evidence published *after* the claim's date. Without it a deck
  "verifies itself" through an article that merely repeats it.
- **Source tier enters at verdict time, not at retrieval.** Credibility-weighted *filtering* has
  been shown to degrade performance — aggressive filtering removes the counter-evidence needed to
  detect the lie. The founder's own site is never excluded: it is the object of the check.
- **Count independent sources, not mentions.** Repetition is the strongest source of false
  corroboration for LLMs. Independence is counted per §7.3's source-slug rule, with `deck_parse` and
  `interview_answer` excluded entirely — self-reported material corroborates nothing.
- **Social-media-sourced claims can never reach `verified`.** This is the sharpest lesson of the
  Builder.ai case: the viral, checkable-sounding "700 engineers faked the AI" claim was itself
  **false** (traced by the FT to a single X post), while the real fraud was round-tripping with
  VerSe. A system scraping social media for red flags would have amplified the fabrication.

### 5.3 `qualitative` (and `forecast`) — no verdict, ever

Records provenance and adjusts confidence. Writes only `context` evidence. Cannot contradict.
**`forecast` claims enter this same branch** — the class differs only in its display label, so §11's
topology stays at four branches.

### 5.4 `unverifiable` — honest gap

Sets/keeps `verification_status='missing'` with a human-readable `text_verbatim`, and emits a
deep-dive question consumed by 06. This is STUB-003's pattern generalised: where no proxy exists,
say so.

---

## 6. The entity-resolution gate

**No `contradicted` verdict may be written until the evidence is proven to be about this entity.**
This is the guard against the >80% false-contradiction rate. Deterministic, ordered, fail-closed:

1. The evidence's `raw_signal_id` carries a `founder_id`/`company_id` FK → resolved by construction.
2. Else the source's registrable domain matches `companies.domain` or an entry in
   `companies.aliases`.
3. Else the model must return an explicit `entity_match` containing a **verbatim quote naming the
   company or founder** *and* a disambiguator (domain, founder name, or product name).
4. Else → downgrade `contradicted` → `unverified`, and write a `context` evidence row recording
   that a contradiction candidate failed the gate. The candidate is not silently dropped; the
   attempt is auditable.

### 6.0 Only primary evidence may contradict a founder

An independent evidence hierarchy — behavioural/transactional data ("what people do") above
third-party observational data above self-reported data ("what companies say they are") — carries
one rule we adopt directly:

**Only Tier-1 evidence may produce a `contradicted` verdict.**

| Tier | Examples | Our mapping | Power |
|---|---|---|---|
| **Tier 1** — primary behavioural / transactional | registry filings, patents, grants, domain registrations, commits, direct codebase inspection | `evidence.tier = 'documented'` | **may contradict; lowers the Trust value** |
| **Tier 2** — third-party observational | web traffic, app-store rank, hiring velocity, reviews, social sentiment | `evidence.tier = 'discovered'` | corroborates; absence lowers **confidence only** |
| **Tier 3** — self-reported | decks, business plans, press releases, and founder-edited database profiles | `evidence.tier = 'inferred'` / `source_kind='self_reported'` | **zero standalone confidence; can never verify itself** |

A `discovered`- or `inferred`-tier contradiction caps at `partially_supported` and raises a
deep-dive question instead of an accusation. This is a second, independent guard on the >80%
false-contradiction rate, and it is the reason a Tier-3 claim can never bootstrap itself into
`verified`.

### 6.0a Gaps and contradictions are asymmetric — deliberately

REQ-003 governs **missing data**, and nothing else. Its scope must not be over-extended into
"nothing ever lowers anything", which would throw away the strongest signal we have:

| Situation | Effect |
|---|---|
| Evidence absent (no footprint, stealth mode) | rollup **confidence** down · `missing_flags` populated · **Trust value untouched** |
| Tier-1 contradiction confirmed | **Trust value down** via `contradiction_penalty` · surfaced to the investor |

Feature 03 states the other half of this contract: "a flag never subtracts points — that would
double-count against the Trust axis owned by feature 05". So contradictions are priced **here, once**,
in the Trust axis — never in the founder's score, and never twice.

The formal justification for the left-hand row is one-sided label noise: in venture data, observed
successes are reliable but observed "failures" usually mean "no exit yet", so naive models
systematically penalise stealth and delayed-exit companies. Positive-Unlabelled estimation treats
observed negatives as *unlabelled* and down-weights their penalty. Absence of evidence is not
evidence of absence — and for a system built to find founders **before** the market sees them,
penalising invisibility would reject exactly the outliers we exist to catch.

### 6.0b No LLM in this feature ever emits a confidence number

Asking a model to rate its own certainty on a numeric scale produces noise — different models hold
incompatible internal representations of abstract scales, and model confidence is not the same
thing as evidence. Therefore:

- Models return **discrete verdicts and verbatim quotes only.**
- Every number in this feature — per-claim trust, rollup value, rollup confidence — is computed by
  §7's formula from **evidence structure** (tier, relation, strength, independent-domain count),
  i.e. from *data quality*, never from model certainty.
- Panel disagreement is **logged as signal, never averaged away.**

Two further conditions on the contradiction detector:

- **Query-conditioned.** Contradiction is only meaningful relative to a question — two documents
  can be non-contradictory in general and contradictory about "what is their ARR". The question is
  carried in the prompt and stored on the record; removing it causes sharp accuracy drops.
- **K = 2, agreement-weighted.** Single-shot verbalized confidence is the *worst* calibration
  method measured (12 LLMs × 4 prompt styles) and is systematically overconfident. Two samples with
  agreement weighting buys roughly +10 AUROC points at K=2. **Disagreement between the two runs on
  a `contradicted` verdict downgrades it to `partially_supported`.**

### 6.1 Contradiction record shape

Deliberately identical to feature 04's, so 06 and 09 read one shape:

```jsonc
{
  "nature":   "factual | definitional | methodological | temporal | scope",
  "severity": "minor | moderate | material",
  "founder_claim": "<verbatim>",
  "found_reality": "<verbatim>",
  "question":      "<the question the contradiction is conditioned on>",
  "entity_match": {
    "resolved_by":   "raw_signal_fk | domain | llm_quote",
    "quote":         "<verbatim quote naming the entity>",
    "disambiguator": "<domain | founder name | product name>"
  }
}
```

Framing rule inherited from `reporting`'s `contradiction_record`: *neutral framing of the
discrepancy; **do not editorialize on intent***. We report what does not match. We never assert why.

### 6.2 Where the record physically lives

`evidence` has **no jsonb column** (`id, claim_id, relation, strength, tier, quote_verbatim,
source_url, raw_signal_id, captured_at, content_hash, created_at`), and 05 does not create claims,
so §6.1's object cannot go where feature 04 put its own (`claims.value`). Ruling, so no builder has
to invent one:

| Field | Home |
|---|---|
| the full §6.1 object | **`events.payload`** on the `claim_contradicted` event — the structured, queryable record |
| `found_reality` | also `evidence.quote_verbatim` on the `contradicts` row (verbatim, per REC-009) |
| `founder_claim` | already the claim's own `text_verbatim` |
| the LLM run | `ai_runs.output_json`, joined by `run_id` |

The `claim_contradicted` payload is the **union** of §9's audit fields
(`claim_id, class, check, verdict_before, verdict_after, source_url, checked_at, run_id`) and the
§6.1 object — one event, one payload, both specs satisfied.

06 and 09 read the structured record from `events` via `idx_events_entity`; the exact query is
given in §14. This keeps the schema untouched and keeps `entity_match` — which carries the whole
auditability claim of §6 — readable per claim rather than buried in a model log.

---

## 7. Per-claim trust — computed live

Feature 01's design is binding: per-claim trust "is always computed live from `evidence` and is
never stored per company". Implementation is a **SQL view `claim_trust`** — one source of truth,
read by 06 and 09 straight through PostgREST at no cost, testable in `smoke.sql`, and it keeps the
math out of n8n rather than duplicated inside it.

### 7.1 The view must know the router class — verdicts are gated on it, not on evidence alone

⚠️ **This is the single most important correction in this design, and it was verified against live
data.** An earlier draft argued the qualitative guarantee was "enforced by construction" because
05's qualitative branches write only `context` evidence. **That argument is false**: the view reads
*all* evidence on a claim, and features 02/04/07 have already written `supports` rows on exactly
the topics the router classes as qualitative.

Measured 2026-07-19, sourced `supports` at `documented`/`discovered` tier on router-qualitative
topics:

| Topic | strong sourced supports |
|---|---|
| `founder.leadership.written_communication` | 123 |
| `founder.expertise.unasked_work` | 90 |
| `founder.expertise.insight_specificity` | 64 |
| `founder.expertise.vertical_tenure` | 64 |
| `company.sector` / `company.business_model` | 17 (unsourced) |
| others | 15 |

Under an evidence-only formula every one of these renders **`verified`** on day one, before 05
checks anything: *"founder writes concisely — VERIFIED (one GitHub URL)"*. That is precisely the
REQ-004 overclaim this feature exists to prevent.

**Therefore the view materialises the router class** (the same prefix table, as a `VALUES` list
inside the view or read from `score_formulas`) and gates the verdict on it:

> **Upstream `supports` rows are inputs to the trust *number*. They are never inputs to the
> *verdict* of a `qualitative`, `forecast` or `unverifiable` claim.**

Those classes are pinned to `unverified` (or `missing`) regardless of what evidence exists. The
trust number is still computed and still shown — what is withheld is the claim to have *verified*
a judgement.

### 7.2 Formula

```
tier_default_strength:  documented 0.90 · discovered 0.80 · inferred 0.60 · missing 0.00

base                  = max over supports of coalesce(strength, tier_default_strength(tier))
n_independent         = count of DISTINCT independent sources among supports (§7.3)
independence_factor   = 0.50                                        when n_independent = 0
                      = min(1.0, 0.70 + 0.15 × (n_independent − 1))  otherwise
n_contradicts_counting = count of contradicts rows at tier documented OR discovered
                         -- inferred/missing contradictions contribute 0; they are context, not evidence
contradiction_penalty = min(0.80, 0.30 × n_contradicts_counting)

trust = clamp(base × independence_factor − contradiction_penalty, 0, 1)
```

`n_contradicts_counting` uses **the same tier gate as the verdict** (§7.4): a contradiction too weak
to change the verdict is also too weak to move the number. Without this the `inferred`-tier
contradiction live on `founder.expertise.insight` would silently cost that claim 0.30 of trust while
being formally recorded as "context only".

### 7.3 Independence — defined off the source slug, not the domain

Registrable-domain (eTLD+1) extraction is not available in pure SQL, and a domain-level rule
mis-fits this corpus anyway: a founder's own repository is founder-controlled *content* on a
non-founder *domain*, and GitHub/HN are the origin of most claims — so counting domains would score
founder self-assertions as independent corroboration.

Independence is therefore counted as **distinct `raw_signals.source` slugs** (`github_api`,
`hn_algolia`, `tavily_extract`, `tavily_search`, `tavily_news`, `deck_parse`, `interview_answer`),
with `deck_parse` and `interview_answer` **excluded from the count entirely** — self-reported
material can corroborate nothing. Stated as one expression, so there is nothing to interpret:

```sql
n_independent = count(DISTINCT (rs.source, f05_host(e.source_url)))
                FILTER (WHERE e.relation = 'supports'
                          AND rs.source NOT IN ('deck_parse','interview_answer'))
```

`f05_host(url)` is a named SQL helper doing simple hostname extraction — documented as an
approximation, **not** a public-suffix implementation. A NULL `source_url` collapses to one entry per
slug, which is the intended behaviour.

### 7.4 Derived verdict — gated on class *and* tier

| Condition (evaluated top-down) | `verification_status` |
|---|---|
| class ∈ {`qualitative`, `forecast`, `unverifiable`} | `missing` if already `missing`, else **`unverified`** — never anything else |
| already `missing` and no `contradicts` | `missing` (an honest gap is never upgraded away) |
| already `missing` and `contradicts` > 0 | `missing` + contradiction surfaced separately — **a gap is never converted into an accusation** |
| `contradicts` (documented or discovered) > 0 **and** `supports` > 0 | `partially_supported` — the Conflicting / Cherry-picked case |
| `contradicts` at tier `documented` > 0 (no supports) | `contradicted` |
| `contradicts` at tier `discovered` > 0 | `partially_supported` (+ deep-dive question) |
| `contradicts` at tier `inferred`/`missing` only | verdict unchanged; recorded as context only |
| `supports` > 0 with tier ∈ (`documented`,`discovered`) and `n_independent ≥ 1` | `verified` |
| otherwise | `unverified` |

The mixed-evidence row sits **above** the flat-refutation row deliberately: evidence pointing both
ways is the most decision-relevant state an investor sees, and it is the AVeriTeC
"Conflicting / Cherry-picking" label §1.1 makes a point of caring about. A claim with strong support
*and* a documented contradiction must never read as flatly refuted.

Three deliberate corrections encoded here:

- **The verified rule tests the tier explicitly, not a numeric threshold.** `inferred` sits at
  exactly 0.60 in `tier_default_strength`, so a `base ≥ 0.60` rule would let a single inferred-tier
  row verify a self-reported claim — defeating §6.0's "Tier-3 can never verify itself".
- **Only `documented` (Tier-1) evidence yields `contradicted`**, per §6.0. `discovered` evidence
  caps at `partially_supported`. This applies to feature 04's `competition.founder_claim_mismatch`
  as well: it is derived from deck-versus-search comparison, which is not Tier-1 behavioural
  evidence under our own hierarchy, so it lands `partially_supported` and raises a question rather
  than an accusation. It remains fully visible to the investor. Ruling made explicitly rather than
  left to the tier the writer happens to pick.

The derived column is aliased **`derived_status`** in the view, so it never collides with
`claims.verification_status` in the select list. Consumers read `derived_status`.

### 7.5 Configuration and failure mode

Constants live in the `score_formulas` row `('trust_v1','trust')`. The view **`LEFT JOIN`s** that
row and falls back to the literals above when it is absent. An inner join would make a fresh clone
without seed data return **zero rows**, so 06 and 09 would see "no claims" instead of an error —
silent wrongness is worse than a hardcoded default.

**The REQ-003 property, stated explicitly:** a claim with no evidence yields low trust, which
lowers the *rollup's confidence*. It cannot lower any founder's score, because 05 does not write
that axis.

---

## 8. The trust rollup

Written by `f05-trust-rollup`, zero LLM, subject = **application** (per 01 design §4.1, the `trust`
axis is an application-level rollup).

### 8.1 Which claims belong to an application

`cards.application_id` is nullable and feature 02 creates founder-subject cards, so this must be
stated rather than guessed — it determines both `coverage` and `input_claim_ids`:

```sql
-- claims in scope for application :app
claims c JOIN cards k ON k.id = c.card_id
WHERE k.application_id = :app
   OR k.company_id     = (SELECT company_id FROM applications WHERE id = :app)
   OR (k.founder_id IN (SELECT fc.founder_id FROM founder_company fc
                        WHERE fc.company_id = (SELECT company_id FROM applications WHERE id = :app))
       AND (k.company_id IS NULL
            OR k.company_id = (SELECT company_id FROM applications WHERE id = :app)))
```

⚠️ The `company_id` restriction on route 3 is load-bearing. Feature 03's entire premise is that a
founder **persists across startups**, so an unrestricted founder join would pull cards belonging to
that person's *other* company into this application's rollup — inflating coverage and polluting
`input_claim_ids` with claims about a different startup. Person-scoped claims (`company_id IS NULL`)
are in scope; another company's are not.

Claims on cards reachable by none of these three routes are **out of scope** for the rollup and are
neither counted in coverage nor listed in `missing_flags`.

### 8.2 Formula

```
verdict_eligible = claims whose router class ∈ {factual_static, factual_dynamic, precomputed}
assessed         = verdict_eligible claims carrying ≥1 supports or contradicts row
coverage         = assessed / verdict_eligible                 -- NOT / all claims
value            = 100 × mean(trust) over assessed             -- gaps never drag the value down
confidence       = clamp(coverage × mean(independence_factor over assessed), 0, 1)
missing_flags    = [ VERDICT-ELIGIBLE topics with derived_status missing or unverified ]
                   + { not_assessable_count: <count of qualitative/forecast/unverifiable claims> }
input_claim_ids  = the assessed claims
```

⚠️ **The denominator is verdict-eligible claims only.** Qualitative, forecast and unverifiable
claims can never carry supports/contradicts by design (§4.3, §7.1); counting them would make
coverage structurally low for reasons that are not knowledge gaps, and with ~430 of ~724 claims in
those classes it would drive `confidence` toward ~0.2 everywhere and push applications below
`min_coverage` — writing **no trust row at all** and rendering "not assessed" across the demo. They
are reported in `missing_flags` as *not assessable*, which is honest, rather than counted as
*unassessed*, which is not.

The first clause is scoped to **verdict-eligible** claims. Without that scoping it would sweep in
every qualitative claim — §7.4 row 1 pins all ~430 of them to `unverified` — producing a
~430-entry `missing_flags` array on every application, which 09 would then render. The count of
not-assessable claims is honest; the list of them is noise.

`min_coverage` starts at 0.25 (matching 03) but **must be re-derived against live data before being
locked** — it was calibrated for a different denominator. Note that the measured 561/724 (77%)
figure is *not* the right calibration input: it counts claims carrying evidence, whereas
`verdict_eligible` is a class filter sitting nearer 294/724 (~41%).

Row shape: `axis='trust'`, `application_id` set, `founder_id` NULL, `formula_version='trust_v1'`,
`model` NULL on the deterministic path.

**If `coverage < min_coverage`, no `scores` row is written at all.** Instead an `events` row
`trust_rollup_insufficient_evidence` is emitted. The project sets this precedent twice already
(`founder_score_insufficient_evidence`, `thesis_gate_insufficient_evidence`). Absence is not zero,
and it must stay distinguishable from "never computed".

### 8.3 Duplicate rollup rows: accepted, not guarded

`scores` has no `content_hash` idempotency guard, and feature 04's QA caught a live double-write —
two identical rows 0.213 s apart on at-least-once delivery. A pre-write `SELECT` over PostgREST is
**not** a guard: it loses that same race, and "inside the current run window" would wrongly block a
legitimate re-run tomorrow. A real fix is `pg_advisory_xact_lock` inside an RPC, which does not fit
the remaining clock.

Ruling: **accept duplicates under append-only semantics and resolve "current" by `max(computed_at)`,
which is already the project-wide convention for this table.** Stated in the handoff so 06 and 09
do not discover it themselves.

### 8.4 Write-back of `verification_status`

The view is authoritative. But anything reading `claims` directly — the obvious thing to do, and
what §3's table describes — would otherwise see pre-05 state forever. So after a successful rollup,
`f05-trust-rollup` writes `derived_status` back into `claims.verification_status` **best-effort**:
`claims` is the one table in our path with no `forbid_mutation` trigger precisely because feature 01
intended this column to be recomputed. A failed write-back is logged and never blocks the rollup —
the view remains correct regardless.

---

## 9. Audit trail — Agentic Traceability

The rubric's top stretch goal is citing the exact data point behind every conclusion. Every
verification leaves three traces:

| Trace | Content |
|---|---|
| `evidence` | the substance: `quote_verbatim` + `source_url` + `tier` + `strength` + `raw_signal_id` |
| `ai_runs` | any LLM step: `task_type='verification'`, `model`, `prompt_version`, `output_json` incl. `run_id` — the anti-black-box ledger pattern, already project convention |
| `events` | one per claim: `claim_verified` / `claim_contradicted` / `claim_verification_attempted`, payload `{claim_id, class, check, verdict_before, verdict_after, source_url, checked_at, run_id}` |

This is what makes the demo line real: *click any number → see the exact source and when we checked
it.* The `events` row is what supplies "when".

⚠️ **GDPR constraint — both halves matter.** `purge_founder()` deletes
`WHERE entity_type='founder' AND entity_id = ANY(v_person_ids)`. So it is not enough to set
`entity_type='founder'`:

- `entity_id` **must be `founders.id`** — never `claim_id`, which is the natural mistake given the
  payload is claim-shaped. `claim_id` goes **in the payload**.
- `entity_type='application'` is used by exactly two paths: the rollup event, and the
  no-resolvable-founder fallback for company-card contradictions (§14). **On that fallback the union
  payload must omit `founder_claim` and `entity_match.quote`** — the "carries no personal data"
  safety argument is what makes an unpurgeable event acceptable, so it has to be true rather than
  assumed.

Full event list written by this feature: `claim_verified`, `claim_contradicted`,
`claim_verification_attempted`, `router_unmatched_topic` (§4.1),
`trust_rollup_insufficient_evidence` (§8.2).

An event with the right `entity_type` but a `claim_id` in `entity_id` is missed by the sweep, and
`events` is append-only — so it survives an erasure request permanently, with no way to correct it.

`claim_verification_attempted` is **mandatory**, not optional: a check that ran and found nothing
writes `tier='missing', relation='context'` evidence, which the rollup counts as *not assessed*.
The event is then the only trace distinguishing "we looked and found nothing" from "never routed".

---

## 10. Data model changes — deliberately minimal

**No new tables.** Everything fits `claims` / `evidence` / `scores` / `events` / `ai_runs`.

| Change | File | Marker |
|---|---|---|
| `DROP VIEW IF EXISTS claim_trust;` **then** `CREATE VIEW claim_trust` | `db/schema.sql` | `-- Feature 05:` |
| `score_formulas` row `('trust_v1','trust')` — router table, trust constants, thresholds, budget caps | `db/seed.sql` | `-- Feature 05:` |
| Demo fixture, UUIDs in the `05f00001-…` range | `db/fixtures/05-truth-gap.sql` | new file |
| Assertions | `db/tests/smoke.sql` | `-- Feature 05` banner before `ROLLBACK` |

Adding no table is a deliberate benefit, not laziness: **no `REVOKE TRUNCATE` is required and
`purge_founder()` does not need editing** — we do not touch the function that already broke once
under feature 04.

`DROP VIEW IF EXISTS` before `CREATE` is not pedantry: `CREATE OR REPLACE VIEW` fails with **42P16**
the moment a column's name, type or position changes, and `claim_trust` will certainly be iterated
during the build. `db/schema.sql` is shared with three other terminals, and a second
`./db/apply.sh` that errors would block all of them.

Smoke assertions use the `-- Feature 05` banner before `ROLLBACK`, with fixture ids reserved in the
range **`…0950`–`…0959`** (07 used `…0970`–`…0979`), fixed now so a parallel terminal cannot collide.

### 10.2 Persisting `factual_dynamic` results

Feature 05 is bound to always populate `evidence.raw_signal_id` (§2.1), so Tavily results **must**
be written to `raw_signals` first (`source='tavily_search'`, already seeded) and the evidence row
pointed at them.

⚠️ Cross-cutting GDPR rule, restated because it has already cost this project real damage: the row
**must carry `founder_id` and/or `company_id` at insert time.** `raw_signals` is append-only and
`purge_founder()` deletes only by those FKs, so a NULL can never be backfilled and the row survives
an erasure request forever. Feature 04 left nine such orphan rows. Create or resolve the entity
*before* the raw write.

### 10.1 The `content_hash` collision that must be handled

`evidence.content_hash` is `NOT NULL UNIQUE`, computed over
`claim_id + relation + source_url + quote`. Several rows 05 writes legitimately have **NULL
`source_url` and NULL `quote_verbatim`** — entity-gate failures, and the same shape 04 already uses
for its mismatch row. Two such rows on one claim would collide and the second insert would be lost.

Feature 04 solved this with a discriminator inside the hash recipe — and critically, with a
**content** discriminator (`query`), not a run id. 05 does the same:

```
content_hash = sha256(claim_id ‖ relation ‖ coalesce(source_url,'') ‖ coalesce(quote,'')
                       ‖ check_id ‖ candidate_key)
```

⚠️ **`run_id` must NOT appear in this recipe**, even though it is tempting. `run_id` is unique per
execution, so an at-least-once *redelivery* — the exact threat this guard exists for — produces a
new hash and a duplicate row. Duplicate `supports` rows are harmless (`base` is a `max`), but a
duplicate `contradicts` doubles `contradiction_penalty` from 0.30 to 0.60 and halves a claim's
trust because a webhook fired twice.

`candidate_key` is stable content: the check's own key, or for entity-gate-failure rows the
candidate text itself, which also goes in `quote_verbatim` so two distinct candidates on one claim
separate naturally.

Note the tooling constraint: in n8n Code nodes use `globalThis.crypto.subtle.digest('SHA-256', …)`,
never `require('crypto')`.

---

## 11. n8n topology

| Workflow | Role |
|---|---|
| `f05-verify-claims` | card's claims → **ROUTE** (Code node, deterministic table) → 4 branches → **Merge** → write `evidence` + `events` |
| `f05-contradiction-scan` | LLM detector on the narrow queue; entity gate as a Code node **before any write**; K = 2 |
| `f05-trust-rollup` | zero LLM: `SELECT` from `claim_trust` → `scores` row, or the insufficient-evidence event |

A real `Merge` node (`n8n-nodes-base.merge`, typeVersion 3.2, `mode:'append'`, `numberInputs:N`,
branch *i* → input index *i*) is **mandatory**, not cosmetic: in this n8n build several wires into a
single input do not reliably wait for all branches — feature 03 observed a live run return HTTP 200
having silently executed only 1–2 of 4 branches.

Inherited conventions:
- Generator `n8n/build-f05-workflow.py` inlines `lib/f05/*.js` into Code nodes; n8n cannot
  `require()` from this repo (no bind-mount), so that source must be **self-contained CommonJS with
  zero imports**, carrying a `// SOURCE OF TRUTH: lib/f05/<file>.js` header.
- Normalise defensively: `String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '')`.
- `gpt-5.6-luna` **rejects `temperature: 0`** — omit the parameter entirely.
- Secrets only via `$env.*`, never literals, so exported JSON stays safe to commit.
- Tests: `node --test lib/f05/*.test.js` — **the glob form is mandatory**, the directory form fails
  repo-wide on Node v22.19.0.

### 11.1 AI agent specs

All AI logic goes through the `ai-agent-builder` skill, with artifacts in
`docs/backlog/05-truth-gap-trust/agents/`:

1. **`contradiction-detector`** — query-conditioned, K=2, output constrained to §6.1's shape,
   mandatory verbatim quotes on both sides. Two prompt-shape rules, both load-bearing:
   - **Pairwise, never isolated grading.** Input A = the founder's claim, input B = the retrieved
     evidence or observed artifact; the task is to *map contradictions between two given inputs*.
     Models are poor at grading a claim in a vacuum and markedly better at comparing two inputs.
   - **Binary grounding extraction, never abstract scoring.** The grounding check is literally
     *"Is there information used in this claim that is not present in the source text? (Yes/No)"* —
     a binary question, stable across model versions, instead of a 1–10 rating.
   The detector must also survive adversarial blindspots (large judge models will confidently rate
   obviously-wrong inputs as excellent) and sycophancy (drifting toward confirming the founder) —
   which is why the deterministic checks in §5.1 run first and the entity gate runs after.
2. **`entity-matcher`** — resolves step 3 of the entity gate; may only answer from a supplied quote.

~~3. `claim-classifier-fallback`~~ — **cut.** With `default_class: "unverifiable"` and the
prefix catch-alls (§4.1), an unmatched topic already has correct, free, fail-safe behaviour.

A safety floor is appended last to every assembled prompt (citation mandate, anti-fabrication,
untrusted-document rule) so that configuration can never remove it.

Consequence of §6.0b, stated so no builder helpfully fills it in: **`ai_runs.confidence` stays NULL
on every row 05 writes.** Confidence in this feature is computed from evidence structure, never
reported by a model.

---

## 12. Budget and the metric that decides quality

Paid checks are capped per card in config. But the number that matters is not cost:

**Instrument helpful fixes and harmful flips separately from the first commit.** Always-on
verification has been measured introducing **2.2% harmful flips** (correct → incorrect) on MATH500,
and on CommonsenseQA it **dropped accuracy by 4.17 points**. For us a harmful flip is flagging a
**true** founder claim as contradicted — precisely the REQ-004 failure.

Feature 11, which was to supply seeded contradictions, is still backlog — so **05 builds its own
labelled fixture**, in `db/fixtures/05-truth-gap.sql` (ids in the `05f00001-…` range per §10; the
`…0950`–`…0959` reservation is for `smoke.sql` only, a different file): 6–10 claims with known
ground truth, deliberately mixed —

- 2–3 claims that are **genuinely contradicted** by their evidence (must be caught)
- 3–4 claims that are **true and adequately evidenced** (must survive untouched — these are what
  measure harmful flips)
- 1–2 claims that are **honest gaps** (must land `missing`, never `contradicted` — the AVeriTeC
  failure mode from §1.1)
- 1 claim whose only support is Tier-3 self-reported (must **not** reach `verified` — §6.0)

Both numbers go into the QA gate. A build that raises helpful fixes while also raising harmful flips
is not an improvement.

**If the fixture is not built, the metric is dropped from the memo and the video** rather than
reported without ground truth behind it. Publishing an uncalibrated accuracy number would be the
same fabrication this feature exists to prevent, one level up.

---

## 13. Honest limits — these go in the memo, not under the rug

- No validation against human judgement; no Cohen's κ pass. Evidence-backed, explainable and
  reproducible is **not** the same as accurate.
- GitHub provenance cannot see squashes performed before push, and both git timestamps are
  user-controlled. Findings are phrased as "consistent with", never as accusation.
- Qualitative claims are never verified — by design, not an omission.
- Reference calls → STUB-003, "references: unavailable at this stage".
- The adversarial committee (IDEA-003 / SCOPE-008, sponsor-blessed as a stretch) is **out of MVP**;
  built only if the clock allows.
- Contradictions are **investor-visible only** in MVP; founder-visible is post-MVP (operator
  decision, 2026-07-19).

---

## 14. Handoff to 06 and 09

- **06 (memo)** reads `claim_trust` for per-claim badges, the `contradicted` /
  `partially_supported` set for its risk section, and `missing`-status claims plus denominator gaps
  as the raw material for "questions to dig deeper on the call" (REC-005).
- **09 (dashboard)** reads `claim_trust` directly through PostgREST. Badge vocabulary: §3's five
  verdict values, plus the four provenance tiers, plus a **"Forecast"** label for `forecast`-class
  claims (so a TAM estimate never reads as a failed verification). Every badge is click-through to
  its `events` row.
- **Read `derived_status`, not `verification_status`.** The view's own column is authoritative;
  `claims.verification_status` is a best-effort write-back (§8.4) and may lag.
- ⚠️ **Read the contradiction EVENT set in addition to the verdict set.** A contradiction on a
  `qualitative` claim legitimately never becomes a `contradicted` verdict (§7.4 row 1), yet a
  **documented-tier** one still lowers the trust number. If 06 built its risk section from the
  verdict alone, that finding would appear nowhere in the memo or the dashboard.
  *(The one qualitative contradiction live today — `founder.expertise.insight` — is `inferred` tier,
  so per §7.2 it moves neither the verdict nor the number. The rule matters for the documented case,
  which the fixture in §12 must therefore cover.)*
  **Suppressing the verdict on a judgement claim is correct; suppressing the finding is not.**
  Contradictions on qualitative claims surface as deep-dive questions rather than as accusations.

- Structured contradiction records (§6.2):

  ```sql
  SELECT payload FROM events
  WHERE event_type = 'claim_contradicted'
    AND entity_type = 'founder'
    AND entity_id = ANY(:founder_ids)    -- all founders on the application (§8.1)
  ORDER BY created_at DESC;              -- payload->>'claim_id' selects one claim
  ```

  Contradictions on company-scoped claims (`competition.*`, `market.*`) live on company cards, but
  the event is still written with `entity_type='founder'` and the card's founder in `entity_id`,
  because that is the only shape `purge_founder()` sweeps (§9). **When a company card has no
  resolvable founder**, the event is written `entity_type='application'` with `entity_id` = the
  application — safe only because such a payload carries no personal data. Both cases must be
  queried.
- **Both**: an absent `scores(axis='trust')` row means *not assessed* — check for the
  `trust_rollup_insufficient_evidence` event. It must never render as zero.

Feature 05 has **no UI surface of its own** — it ships a view, three workflows and an audit trail.
The badge vocabulary, the evidence-on-click pattern and §14.1's display rule are therefore inputs to
**feature 09's `lovable-brief.md`**, and must be carried there verbatim as frozen API contracts
rather than re-derived. Flagged here so the requirement is not lost at the handoff.

### 14.1 The rollup may never be displayed alone — binding on 06 and 09

A single Trust percentage that hides disagreement is not stronger for being cleaner. This is the
same principle as the sponsor's do-not-collapse-the-axes invariant (REQ-002), applied one level
down at claim level.

Wherever the rollup `value` appears it **must** be accompanied by the disagreement breakdown:
counts of `contradicted`, `partially_supported` and `missing` claims, plus `coverage`. Feature 03
states the identical rule for its own axis — value must never be shown or sorted without confidence
and coverage beside it. A clean number over a contested evidence base is the failure this whole
feature exists to prevent.

---

## 15. Sources

Internal: `internal/Meetings/{requirements,recommendations,risks,scoring-signals,sponsor-facts,scope-rulings,stub-candidates}.md`
(REQ-002/003/004/009, REC-005/006/007/009/013, RSK-002/003/004, SIG-007/014/018/024, FACT-010/011/014,
SCOPE-008, STUB-003, IDEA-003, PAIN-003/004).

OSS references — licences verified in-clone:
- `reporting` (**Apache 2.0**) — `claim_record`, `finding_record`, `contradiction_record`,
  `source_quality_tiers`, `flag_low_confidence_when`. Adopted near-verbatim; NOTICE required.
- `due-diligence-agents` (**Apache 2.0**) — `quote_guard.py` ported to JS; safety-floor and
  single-severity-authority patterns. NOTICE required.
- `vantage` (**MIT**) — `AIOutput` ledger shape; `missing_data` as a first-class score field.
- `InGa` (**MIT**) — `supports`/`contradicts` as typed edges.
- `sieve-mcp` (**MIT**) — ⚠️ borrow-map correction: **there is no code to borrow.** The
  Documented/Discovered/Inferred/Missing typology exists only as four words of README prose; the
  clone is a thin client against a closed hosted API. `reporting` supersedes it as our source.

External research (2024–2026): AVeriTeC 2024/2025 shared tasks and human evaluation; REFNLI;
ClaimCheck; SAFE; DnDScore; RARR; VCSC and CoCoA calibration; selective-verification harmful-flip
measurements; Builder.ai reporting and the FT correction of the viral claim; SEC/DOJ AI-washing
enforcement (Delphia, Rimar, Kubient, Presto, Nate); git forensic techniques.

NotebookLM (project notebook, 13 questions, all with the mandated pre-seed / cold-start framing) —
contributed §6.0's three-tier evidence hierarchy, §6.0a's one-sided-label-noise / PU-estimation
justification, §6.0b's ban on model-emitted confidence numbers, §4.2a's speculation-before-
verification split, and §11.1's binary-grounding and pairwise-comparison prompt shapes. It also
corrected a scope error in an earlier draft of this design, which had routed TAM claims into the
factual verification queue.

⚠️ Two caveats recorded rather than smoothed over: the Builder.ai case is **not** in the notebook
corpus by name — its facts here come from external research only. And the A–F severity bands the
corpus offers apply specifically to a codebase-evaluation score; extending them to all claim types
would be our extrapolation, so this design does not use them.

**Publication note:** SIG-014 and SIG-024 carry unverified-quote review flags and several intel
items derive from a closed corpus. They shaped this design; they must not be quoted as evidence in
public artifacts.
