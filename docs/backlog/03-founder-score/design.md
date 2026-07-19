# 03 · Founder Score — Design

> Status: **rev 3 — spec review ✅ APPROVED WITH CHANGES; all changes applied.**
> rev 1 → NEEDS REWORK (5 blockers, all real). rev 2 → APPROVED WITH CHANGES (2 correctness
> findings + 8 smaller). rev 3 applies every one; no further re-review required.
> Sections 1-4 approved by operator 2026-07-19; scope cut to 12 criteria + 3 flags approved
> after review. Depends on: 01 (COMPLETE). Blocks: 05, 06, 09.
>
> QA must cover these as explicit cases (reviewer's instruction): a founder with all
> `self_asserted` verdicts produces a valid non-NaN `confidence`; a founder whose evidence has
> NULL `raw_signal_id` does **not** silently fall into `insufficient_evidence`; `purge_founder`
> succeeds against a founder holding parentless `score_components`.
> Sources consulted before any proposal (CLAUDE.md rule): intel base (`internal/Meetings/`,
> 27 signals + REQ/RSK/SCOPE/FACT), NotebookLM «HN6 C2 — The VC Brain (Maschmeyer)» (5 asks,
> early-stage framing), Exa (14 angles), 9 OSS references in `internal/other-projects/`.

## 0. What this feature is

An evidence-backed, persistent, versioned, explainable score for the **Founder** axis of a
founder with **no track record** — computed from primary public footprints and self-reported
claims already stored as `claims`/`evidence` by the Memory layer.

Carl, verbatim (FACT-007): assessing problem/product/market «is nowadays quite easy actually to
do with Claude», but «really assessing the founder, finding a good scoring — that's the hard part
of the challenge». This feature is the answer to that sentence.

Architecture in one line: **the model proposes booleans, the backend decides the number.**

## 1. Binding invariants

| # | Invariant | Source | Mechanism here |
|---|---|---|---|
| I1 | Axes are never averaged; the investor must see **how** each score was derived | REQ-002 | one `scores` row per axis + `score_components` exposing every criterion |
| I2 | Missing data lowers **confidence**, never the score | REQ-003 (Carl @1:10:40) | `CANNOT_ASSESS` excluded from the denominator, **and the verdict is backend-enforced** (§4.4) |
| I3 | Never fabricate; mark gaps explicitly | REQ-004 | `insufficient_evidence` status (§2.4) + `what_would_close_it` |
| I4 | Founder Score persists across startups, never resets | REQ-009 / FAQ-6 | subject = `founder_id`; `scores` append-only, UPDATE/DELETE raise `P0001` |
| I5 | Founder Score is an **input** to the `founder` screening axis, never a replacement | 01 design §4.1/§9 | 03 writes `founder_score` **only**; feature 04 composes the `founder` axis from it |
| I6 | Verbatim evidence must survive; LLM paraphrase may not replace it | REC-009 / RSK-003 | `quote_verbatim` separate from `rationale`, **substring-verified** (§4.4) |
| I7 | No survivorship features | RSK-004 | pedigree collected, displayed, not scored (§3.2) |
| I8 | Every AI call is ledgered before it is trusted | 01 design §6 | `ai_runs` written always, then validated, then `scores` |

## 2. Scoring model

### 2.1 Why not ask the LLM for a number

- **Exa (LLM-as-judge literature).** Unbounded numeric scores are poorly calibrated with high
  cross-run variance. Ordinal 5-point scales collapse toward the extremes: **85-93% adjacent
  accuracy but only 38-58% exact accuracy**. Binary criteria produce the highest human agreement.
  Production pattern: ask only yes/no, compute the weighted score **in code**.
- **OSS.** `vantage` (MIT) aggregates outside the model, stamping `prompt_version` +
  `formula_version` per row. `venture-capital-intelligence` (MIT): «Claude extracts → Python
  scores → Claude interprets → Python formats».
- **Intel base.** REQ-002 demands visible composition. One model-emitted number cannot satisfy
  «to see how you actually come up with the score».

### 2.2 The four-verdict model

Re-verification surfaced a conflict inside the operator's initial pick (tier as a multiplier on
value):

- **Against.** GRADE makes separating *quality of evidence* from *strength of recommendation* its
  **defining feature**: «Grading systems that fail to separate these judgements create confusion.»
  A silent `×0.5` inside `value` is that conflation, and it collides with I2.
- **For distinguishing by tier.** SIG-018 / SIG-014 are explicit weighting instructions from our
  own intel base: narrative down, verifiable artifacts up; «звёзды/форки без provenance — не вес,
  а флаг на проверку».

**Resolution: separate ABSENCE from WEAKNESS with a distinct verdict, not a hidden coefficient.**

| Verdict | In denominator? | `credit` | Confidence | Satisfies |
|---|---|---|---|---|
| `met`, tier `documented` | yes | 1.0 | ↑ | SIG-018 |
| `met`, tier `discovered` | yes | 0.8 | ↑ | SIG-018 |
| `self_asserted` — claim exists, uncorroborated | yes | 0.3 | ↓ | SIG-018 |
| `not_met` — established as absent **by a competent source** | yes | 0 | — | |
| `cannot_assess` — no competent source consulted | **no** | **n/a** | ↓↓ + `missing_flags` | **REQ-003 / I2** |

Verdict strings are **lowercase** everywhere — prompts, JSON schema, contract, and the
`score_components.verdict` CHECK. The gate lowercases defensively anyway (§4.4).

A cold-start founder with no footprint does not get a low score — those criteria leave the
denominator and he gets low **confidence**. A founder who *claims* traction without evidence gets
both a lower score and lower confidence. Different failures, no longer conflated.

### 2.3 Aggregation formula (`formula_v1`)

```
assessed        = {met, self_asserted, not_met}          # cannot_assess excluded
assessed_weight = Σ(weight)[assessed]
all_weight      = Σ(weight)[all criteria]
coverage        = assessed_weight / all_weight

# ---- guard: no arithmetic on an empty basis (see §2.4) ----
if assessed_weight == 0 or coverage < min_coverage:  ->  insufficient_evidence

value      = Σ(weight × credit)[assessed] / assessed_weight × 100
tier_mix   = Σ(weight × tier_factor)[assessed] / assessed_weight
confidence = clamp(0.55 × coverage + 0.45 × tier_mix, 0, 1)

missing_flags = [ {criterion_id, what_would_close_it}, … ]  for every cannot_assess
```

Both divisions use the **same** denominator `assessed_weight`, which the guard proves non-zero.
There is no second division to protect.

`tier_mix` runs over **all assessed** criteria, not just the positive ones, taking `tier_factor`
from the tier of the source that established the verdict. A `not_met` established by a
`documented` GitHub fetch is high-quality evidence and must raise confidence, not cap it —
otherwise a fully-investigated founder with all-negative findings would top out at
`confidence = 0.55`, which is backwards and would make well-supported "pass" calls look soft.

Constants, all stored in `score_formulas.config`, none in code:

```
tier_factor   = { documented: 1.0, discovered: 0.7, inferred: 0.4, missing: 0.0 }
credit        = { met_documented: 1.0, met_discovered: 0.8, self_asserted: 0.3, not_met: 0.0 }
min_coverage  = 0.25
trend_epsilon = 3.0
max_claims_per_agent = 40
```

Note the credit map has no `met_inferred` / `met_missing` entry **by construction**: §4.4 step 5a
coerces such a verdict to `self_asserted` before aggregation, so the case cannot reach the formula.

`contribution` is stored in percentage points so that the breakdown is directly checkable:

```
contribution = weight × credit / assessed_weight × 100      ⇒   Σ contribution == value
```

`value` is computed from **unrounded** terms and rounded once at the end. `Σ contribution`
therefore reproduces the **unrounded** value exactly, and the stored 2-dp `value` to within half a
rounding step (≤ 0.005) — not to 1e-4, which an earlier revision of this document claimed and
which is arithmetically impossible once `value` is rounded to `numeric(5,2)`. Any test asserting
this identity must compare against the unrounded value, or use a 0.005 tolerance.

This identity is the property that lets a judge verify the arithmetic by summing the rows on
screen.

**Rounding discipline:** `value` → round 2dp, clamp [0,100]; `confidence` → round 2dp, clamp [0,1];
applied in the aggregate node *before* insert. `numeric(5,2)` would otherwise reject a
float-computed 100.005.

### 2.4 The `insufficient_evidence` branch

`scores.value` is `numeric(5,2) NOT NULL CHECK (value BETWEEN 0 AND 100)` — there is no way to
write "unknown". Writing `0` violates I2, writing `50` violates I3, and crashing kills the demo on
the most likely hand-entered founder. So:

**When `assessed_weight == 0` or `coverage < min_coverage`, no `scores` row is inserted at all.**
`ai_runs` and `score_components` are still written **with their actual verdicts** — only the
`scores` row is skipped. (All-`cannot_assess` is merely the `assessed_weight == 0` sub-case, not
the branch as a whole; rewriting genuine verdicts to `cannot_assess` would destroy evidence we do
have, which is fabrication in the opposite direction from the one I3 guards against.)

The §4.9 contract returns:

```jsonc
{ "status": "insufficient_evidence", "value": null, "confidence": null,
  "coverage": 0.12, "missing": [ … ] }
```

**Persistence of the branch.** The absence of a `scores` row is indistinguishable from «never
scored», which defeats the point. So this branch additionally writes one `events` row —
`event_type='founder_score_insufficient_evidence'`, `entity_type='founder'`, `entity_id=founder_id`,
`payload={run_id, coverage, missing}`. `events` already exists, is append-only, and costs one
INSERT, giving 06/09/10 a timestamped, queryable marker.

This is the only branch that is simultaneously honest (REQ-004), non-punitive (REQ-003), and
compatible with a NOT NULL column. Consumers 06 and 09 must handle `status`.

### 2.5 Ranking — a consequence that must not surprise feature 09

Correctly implementing I2 means one `met` with everything else `cannot_assess` yields
`value = 100.00` at `confidence ≈ 0.05`. If 09 sorts on `value`, the least-known founders rank
highest.

Two rules, binding on 09: **(a)** `value` is never displayed or sorted without `confidence` and
`coverage` beside it; **(b)** the default feed ranking key is `value` sorted *within* confidence
bands (`high ≥ 0.7 > medium ≥ 0.45 > low`), not raw `value`. The `min_coverage` floor already
removes the worst offenders by refusing them a number at all.

### 2.6 Sub-scorer weights

Positive axis only; `red-flags` carries no positive weight.

| Sub-scorer | Weight | Rationale |
|---|---|---|
| `execution-signals` | 0.40 | REQ-011 + SIG-021: founder axis dominates; execution is its most observable half |
| `expertise-signals` | 0.30 | SIG-026, SIG-016; Azoulay's industry-proximity gradient |
| `leadership-sales-proxies` | 0.30 | SIG-003/004/005/020 — Carl's own three questions |

**Emergent property, deliberate:** a non-technical founder scores `cannot_assess` across most `E*`
criteria; they leave the denominator and the score is driven by expertise + leadership rather than
zeroed. This closes PAIN-008 without a special-case branch.

## 3. The rubric — 12 criteria + 3 flags

Cut from 24+6 after review (scope realism at ~10h remaining across ten features). REQ-002 concerns
the **visibility** of composition, not the criterion count. Every criterion traces to an
intel-base signal or a cited external source.

`raw` = integer share within its sub-scorer. `weight = subscorer_weight × raw / Σ(raw)`, computed
once and stored. Integers are used so the stored weights are exact at 5 dp and
`Σ score_components.contribution` reproduces `scores.value` on recomputation — the property that
makes the arithmetic checkable by a judge.

`neg_src` = the source that must be present in the context pack for `not_met` to be permissible;
absent it, the gate coerces to `cannot_assess` (§4.4). This is what makes I2 enforced rather than
hoped for.

### A · execution-signals (0.40)

| ID | raw | weight | Criterion | neg_src | Source |
|---|---|---|---|---|---|
| E1 | 5 | 0.10000 | Merged PR into a repo they do not own, within 12 months | `github_api` | Exa §4; RSK-002 |
| E3 | 3 | 0.06000 | Commits present in ≥8 of the last 12 weeks (consistency, not volume) | `github_api` | Exa §4 (<1 commit/week = decay) |
| E4 | 5 | 0.10000 | A live production URL responds — not merely a repository | `tavily_extract` \| `github_api` | SIG-012 |
| E5 | 4 | 0.08000 | Measured external usage: forks / dependents / downloads / transactions | `github_api` | IDEA-004, SIG-012 |
| E7 | 3 | 0.06000 | Provenance clean: first-commit date consistent with account age; no earlier source for the flagship repo | `github_api` | SIG-014 |

### B · expertise-signals (0.30)

| ID | raw | weight | Criterion | neg_src | Source |
|---|---|---|---|---|---|
| X1 | 5 | 0.09375 | Documented tenure in the **same vertical** as the startup | `deck_parse` \| `interview_answer` \| `tavily_extract` | Azoulay et al., 2.7M founders: 0.11% → 0.26%, monotonic in industry proximity |
| X2 | 4 | 0.07500 | Insight specificity: states something about the industry an outsider could not guess | `deck_parse` \| `interview_answer` \| `tavily_extract` | EF; KnownWeil |
| X5 | 3 | 0.05625 | Describes competitors at insider granularity (where deals are lost, what breaks in production) rather than pricing-page level | `deck_parse` \| `interview_answer` | SIG-024; Exa §11 |
| X6 | 4 | 0.07500 | Did substantial work nobody asked for, before any funding | `github_api` \| `tavily_extract` | Exa §1 — highest-value cold-start signal |

### C · leadership-sales-proxies (0.30)

| ID | raw | weight | Criterion | neg_src | Source |
|---|---|---|---|---|---|
| L2 | 5 | 0.15000 | First customers / LOI / pilot evidence | `deck_parse` \| `interview_answer` | SIG-020 |
| L3 | 3 | 0.09000 | ICP specificity: vertical + size + buyer role + trigger + current alternative | `deck_parse` \| `interview_answer` | Exa §11 («could a stranger find 50 matching companies?») |
| L5 | 2 | 0.06000 | Written communication concise and structured under compression (Show HN, homepage stranger-test) | `hn_algolia` \| `tavily_extract` | Antler; SIG-004 |

Weights sum to 0.40 / 0.30 / 0.30 = 1.00 exactly.

### D · red-flags — separate stream, never subtracted from value

| ID | Flag | `contradicts` | `demote_to` | Source |
|---|---|---|---|---|
| R1 | Provenance spoofing: pusher ≠ author, backdated commits, repo predates account | E7, E1 | `not_met` | Exa §4 |
| R2 | Star farming: high stars, ~0 forks, issues disabled | E5 | `self_asserted` | Exa §4 (gitgauge) |
| R4 | Claimed capability with no observable artifact (AI-washing) | E4, X2 | `self_asserted` | FACT-010 (BuilderAI: $445M passed human diligence incl. Microsoft) |

A flag never subtracts points — that would double-count against the Trust axis owned by feature
05. It **demotes the verdict of the criteria it contradicts**, per the table, and is emitted in
`red_flags[]` for 05 to verify. This executes SIG-014 literally: «не вес, а флаг на проверку».
Severity tiers 1/2/3 follow the verified.vc model.

**Demotion runs inside the validation gate (§4.4 step 6), not inside an agent.** The four LLM calls
remain genuinely parallel; the red-flags agent's output is applied to the other three agents'
verdicts afterwards, in code.

Parked with reasons: E8 (AI-era correction behaviour — §8.3 concedes it is unproven territory,
making it the most expensive and least defensible item), E2, E6, X3, X4, L1, L4, L6, L7, and R3,
R5, R6 (the latter three need longitudinal data the fixture will not have).

### 3.1 Deliberately NOT scored

| Excluded | Why |
|---|---|
| GitHub stars, LOC, commit volume, contribution graph | RSK-002, SIG-014; `GIT_AUTHOR_DATE` is unvalidated, graph-farming is a commodity |
| Headcount | SIG-019 — anti-signal in 2026 |
| Pitch polish / narrative quality | SIG-018 — persuasion is devalued; AI writes a perfect deck |
| Age | data-minimisation red line; empirically contested |
| Similarity to past funded winners | RSK-004 — the Evertrace anti-pattern |
| **Education, school brand, employer prestige** | Davenport (16k startups / $9B): a model built **solely on founder education** was the single strongest predictor of **underperforming** investments. Inside YC, pedigree explains <4% of funding variation |

### 3.2 Pedigree — collected, displayed, not scored

SIG-001 (ex-Palantir / ex-SpaceX) and SIG-002 (serial founder) were named by the sponsor as
predictors. The external evidence says the opposite, and they are the mechanism behind RSK-004.

Ruling: extract and display them in a separate `Pedigree (not scored)` block with the reason; keep
them out of `value`. The investor sees everything Carl named; the number is not moved by it. A
stronger answer to the survivorship question than silent omission — we collected it, measured it,
and can show why we do not use it.

## 4. Data contract

### 4.1 Read side (existing, from feature 01)

Claims attach to `cards`, never to founders directly:

```sql
claims c JOIN cards k ON c.card_id = k.id
LEFT JOIN evidence e ON e.claim_id = c.id
WHERE k.founder_id = $1
```

Consumed: `claims.text_verbatim`, `.topic`, `.value`, `.source_kind`, `.base_confidence`,
`.verification_status`; `evidence.tier`, `.strength`, `.quote_verbatim`, `.source_url`;
`raw_signals.source` (for the `neg_src` check — this is the field `neg_src` matches against).

`cards.founder_id` / `company_id` / `application_id` are three independent nullable columns with
no XOR — a card may carry more than one.

### 4.2 Schema additions

⚠️ **Not purely additive.** Two new tables are additive, but `purge_founder()` must be edited **in
place in `db/schema.sql`** — it hardcodes its delete list, and `db/apply.sh` applies only
`schema.sql` + `seed.sql`, so a separate migration file would never run. `purge_founder` is the
one feature-01 object this feature touches.

```sql
CREATE TABLE IF NOT EXISTS score_formulas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     text NOT NULL,
  axis        text NOT NULL REFERENCES score_axes(slug) ON DELETE RESTRICT,
  config      jsonb NOT NULL,   -- weights, credits, tier_factors, min_coverage,
                                -- trend_epsilon, criteria registry (incl. neg_src),
                                -- red-flag contradicts/demote_to map, context-pack caps
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, axis)
);
-- exactly one active formula per axis; §5 says "load active row", singular
CREATE UNIQUE INDEX IF NOT EXISTS uq_score_formulas_active_axis
  ON score_formulas (axis) WHERE active;

CREATE TABLE IF NOT EXISTS score_components (   -- append-only
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  score_id        uuid REFERENCES scores(id) ON DELETE RESTRICT,   -- NULL on insufficient_evidence
  founder_id      uuid NOT NULL REFERENCES founders(id) ON DELETE RESTRICT,  -- purge anchor
  run_id          uuid NOT NULL,                                   -- groups one workflow run
  subscorer       text NOT NULL,
  criterion_id    text NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN
                    ('met','self_asserted','not_met','cannot_assess')),
  weight          numeric(6,5) NOT NULL,
  credit          numeric(3,2),
  contribution    numeric(8,5),   -- percentage points; Σ == scores.value
  evidence_tier   text CHECK (evidence_tier IN
                    ('documented','discovered','inferred','missing')),
  claim_ids       uuid[] NOT NULL DEFAULT '{}',
  quote_verbatim  text,                 -- first-source quote, substring-verified (I6)
  rationale       text,                 -- LLM interpretation — separate field (RSK-003)
  what_would_close_it text,             -- populated for cannot_assess (Grizzz pattern)
  demoted_by      text,                 -- red-flag id, if the verdict was demoted (§3 D)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS idx_score_components_score_id ON score_components (score_id);
CREATE INDEX IF NOT EXISTS idx_score_components_founder  ON score_components (founder_id);
CREATE INDEX IF NOT EXISTS idx_score_components_verdict  ON score_components (verdict);
```

`weight numeric(6,5)` (not `4,3`): 0.30 × 5/16 = 0.09375 needs 5 dp. At 3 dp the stored weights no
longer sum to their sub-scorer weight and `score_components` stops reproducing `scores.value`,
which breaks the determinism test and the "judges can verify the arithmetic" claim.

`contribution numeric(8,5)` (not `7,5`): contribution is in percentage points, so a run whose
assessed set is a single criterion yields 100.00000 — one digit more than `numeric(7,5)` holds.
Today `min_coverage = 0.25` exceeds the largest single weight (L2 = 0.15) so that cannot occur,
but `min_coverage` is a **config value** and lowering it below 0.15 would overflow the column.
The wider type removes the trap rather than documenting it.

`score_id` is nullable and `founder_id` + `run_id` carry the identity, because the
`insufficient_evidence` branch (§2.4) writes components with no parent score. `UNIQUE` is on
`(run_id, criterion_id)` for the same reason.

**Mandatory hardening** (feature 01's QA gate found exactly this class of hole):

```sql
CREATE OR REPLACE TRIGGER trg_score_components_forbid_mutation
  BEFORE UPDATE OR DELETE ON score_components
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

REVOKE TRUNCATE ON score_components, score_formulas FROM anon, authenticated, service_role;
```

Self-hosted Supabase grants TRUNCATE to those roles via `ALTER DEFAULT PRIVILEGES` at
`CREATE TABLE` time — every new append-only table must revoke it explicitly.

**`purge_founder()` extension.** `score_components.score_id → scores(id)` is `ON DELETE RESTRICT`,
so children must go first or the purge raises 23503. There are **two** `DELETE FROM scores`
statements in the function (`schema.sql` ~L774 for `v_sole_app_ids`, ~L782 for `v_person_ids`).
The insertion window is **after `v_sole_app_ids` is populated (~L728) and before the first
`DELETE FROM scores` (~L774)**:

```sql
DELETE FROM score_components WHERE founder_id = ANY(v_person_ids);
DELETE FROM score_components WHERE score_id IN (
  SELECT id FROM scores WHERE founder_id = ANY(v_person_ids)
                           OR application_id = ANY(v_sole_app_ids)
);
```

The `founder_id` sweep runs first and catches `insufficient_evidence` rows that have no parent
score. Also required: extend `db/tests/smoke.sql` with append-only + TRUNCATE + purge assertions
for both new tables, and update the purge contract section of `db/README.md`. Feature 01's QA gate
caught the TRUNCATE hole *because* smoke covered it; adding two append-only tables with no smoke
assertions would regress that.

### 4.3 Write side — one run produces

1. **`ai_runs` × 4** — one per sub-scorer, `task_type='scoring'`, `output_json` = raw verdicts,
   `disagreement` reserved for cross-run divergence (RSK-003). Written **always**, pre-validation (I8).
2. **`scores` × 1** — `axis='founder_score'`, `founder_id` set, `application_id` NULL. Stamps
   `formula_version`, `prompt_version`, `model`, `input_claim_ids`, `missing_flags`, `trend`,
   `confidence`. Skipped entirely on `insufficient_evidence` (§2.4).
3. **`score_components` × 12** — the full breakdown, always written.

**Only `founder_score` is written.** 01 design §9 assigns feature 03 exactly that, and nothing
else. Feature 04 reads the latest `founder_score` row and composes the `founder` screening axis
from it plus application-scoped evidence. Writing a derived `axis='founder'` row here would
contradict that handoff, race feature 04 on a table with no `(application_id, axis)` uniqueness,
and — since `purge_founder` only sweeps application-scoped scores for *sole-founder* companies —
leak person-derived data past a GDPR erasure for multi-founder companies.

### 4.4 Validation gate — «model proposes, backend decides»

A Code node, **not prompt instructions**. `reporting` (Apache-2.0) showed prompt-level
prohibitions get violated and closed the hole in three layers; one code layer is our proportionate
version. Steps, in order:

1. **Normalize.** Lowercase `verdict`; trim `criterion_id`. (The prompts emit lowercase, but a
   model returning `MET` must not fail the CHECK at hour nine.)
2. **Enum.** Verdict outside the four values → `cannot_assess`.
3. **Registry.** Unknown `criterion_id` → drop and log. A criterion absent from the response →
   inserted as `cannot_assess`. Absence is always recorded explicitly, never silently missing.
4. **Citation.** Drop any `claim_id` not present in that agent's context pack, **then** coerce
   `met` / `self_asserted` to `cannot_assess` only if no cited id survives. (Dropping first matters:
   one hallucinated id must not nullify an otherwise well-evidenced verdict.) This is vantage's
   no-empty-evidence guard.
5. **Negative-capability (this is what makes I2 real).** `not_met` is only permissible if the
   pack contains a claim whose source matches the criterion's `neg_src`. Otherwise →
   **coerced to `cannot_assess`**.
   *Why:* for nearly every criterion, "we looked and it is not there" and "we never looked" are
   indistinguishable from inside the pack. Leaving that call to the model would put the entire
   REQ-003 guarantee on an unspecifiable judgement — and 01 design §8 pitfall #4 and §9 handed
   this exact hazard ("never write a negative claim for absence") to feature 03 by name.
   Without this rule, two identical founders diverge purely on crawl luck: the one we never
   fetched GitHub for scores ~100, the one we did scores ~12.

   **Source resolution, in order.** The primary path is
   `claims → evidence.raw_signal_id → raw_signals.source`, matched against the seeded
   `signal_sources` slugs. But `evidence.raw_signal_id` is **nullable** (schema.sql:320) and
   nothing yet enforces the convention, so an unguarded join would silently route every founder
   into `insufficient_evidence`. Documented fallback when no `raw_signal` is reachable, mapping
   `claims.source_kind` → permitted source:

   | `claims.source_kind` | treated as |
   |---|---|
   | `self_reported`, `derived` | `deck_parse` |
   | `interview`, `voice` | `interview_answer` |
   | `public` | any source (wildcard) |

   ⚠️ `claims.source_kind` and `signal_sources.slug` are **different vocabularies**; `neg_src`
   uses the second. Implementing from §3's table alone and reaching for `source_kind` yields zero
   matches — hence this explicit mapping.

   **Honest limitation:** the check is **source-level, not question-level**. One `github_api`
   claim licenses `not_met` across E1/E3/E5/E7 even if it says nothing about merged PRs. This is
   an accepted approximation — it removes the crawl-luck asymmetry, which was the actual defect —
   and it is recorded in §8 because a judge may ask.
6. **Red-flag demotion.** Apply §3 D's `contradicts` / `demote_to` map to the verdicts from the
   other three agents; record `demoted_by`. **Then re-apply step 5**, because R1 demotes *to*
   `not_met` — the one verdict step 5 exists to police. Safe today (R1 fires only from GitHub
   evidence and its targets both carry `neg_src: github_api`), but the ordering would otherwise
   let a future flag breach I2 silently.
6a. **Assign `evidence_tier` — backend, never the model** (same logic as the verdict):
   - `met` → best `evidence.tier` among the cited claims. **If that best tier is `inferred` or
     `missing`, coerce the verdict to `self_asserted`** — a claim we only inferred is not
     corroboration. This is also what keeps the credit map total (§2.3).
   - `self_asserted` → tier `missing` (`tier_factor` 0.0), correctly dragging confidence down
     while still counting toward `value` at credit 0.3.
   - `not_met` → best `evidence.tier` of the `neg_src`-matching claim found in step 5.
   - `cannot_assess` → tier NULL (excluded from every sum).

   Without this, `tier_mix` — which since §2.3 runs over *all* assessed criteria — has no defined
   input for `self_asserted` or `not_met` rows, yielding NaN and a rejected insert against
   `numeric(3,2) CHECK (confidence BETWEEN 0 AND 1)`.
7. **Verbatim integrity (I6).** `quote_verbatim` must be an exact substring of the cited claim's
   `text_verbatim` or of one of that claim's `evidence.quote_verbatim` values. Otherwise set NULL
   and keep only `rationale`. Both strings are already in the pack — a string comparison, not a
   query. This is the only thing standing between RSK-003 and a paraphrase laundered as a quote.
8. **Partial failure.** A sub-scorer that errors or times out → **all of its criteria recorded as
   `cannot_assess`** with `what_would_close_it = "sub-scorer <name> failed; rerun"`; aggregation
   proceeds on the rest; the failure is recorded in `ai_runs`. All-or-nothing applies only to the
   aggregation step. One flaky agent must not deny a score to a founder we have good data on —
   that is the same logic as I2.

### 4.5 Trend

Compare against the previous `founder_score` row for the same `founder_id` by `computed_at`:

```
Δ ≥ +trend_epsilon  → 'improving'
Δ ≤ -trend_epsilon  → 'declining'
otherwise           → 'stable'
```

`trend = NULL` when any of: no prior row; the prior row's `formula_version` differs from the
current one; the prior row's `input_claim_ids` is the **same set** as this run's (compared
order-insensitively — `uuid[]` equality in Postgres is order-sensitive and would miss it).

`NULL` rather than `'stable'` on a first score is deliberate — «stable» is a claim about history we
have not earned. The other two guards protect the same honesty: a Δ measured across two different
formulas is not a trend, and re-running the workflow on unchanged claims (which append-only
storage permits and we intentionally allow) must not manufacture a `stable` that came from
clicking the button twice.

### 4.6 Persistence

Given by the schema, not by application logic: subject is `founder_id`; `scores` is append-only
with UPDATE/DELETE raising `P0001`, bypassable only with `vcbrain.purging='on'` **and**
`current_user='postgres'`. A new startup by the same person produces new claims → a new run → a
new row. History follows the person and cannot be reset — REQ-009/FAQ-6.

`founder_company.is_current` flipping is the mechanism by which the score follows a person across
companies (01 design §5.3).

### 4.7 Context pack

Built per sub-scorer, not once globally — §4.4 step 4 checks membership against *that agent's*
pack, and sending every claim to every agent quadruples spend and can overflow the prompt.

- **Routing** by `claims.topic` prefix. 01 design §11 left the topic vocabulary open and feature
  02 does not exist yet, so **this document defines it** — the fixture, the routing code and
  feature 02 all depend on the table below:

  | Topic prefix | Sub-scorer |
  |---|---|
  | `founder.execution.*` | `execution-signals` |
  | `founder.expertise.*` | `expertise-signals` |
  | `founder.leadership.*` | `leadership-sales-proxies` |
  | *(union of all claims)* | `red-flags` — needs cross-cutting visibility to spot contradictions |

  **Fallback:** a claim matching no prefix goes to the union pack rather than being dropped —
  otherwise criteria silently starve as the vocabulary drifts.
- **Cap:** `max_claims_per_agent` (config, default 40), ordered by `evidence.tier`
  (documented → discovered → inferred) then `claims.created_at` desc.
- Each claim enters as: `claim_id`, `text_verbatim`, `topic`, `source_kind`,
  `raw_signals.source`, best `evidence.tier`, `evidence.quote_verbatim`, `source_url`.
- The exact `claim_ids` in each pack are recorded on the run so step 4's membership check and
  `scores.input_claim_ids` have a definite basis.
- Formatting is normalized before judging — style bias is the **dominant** judge bias (0.10-0.76,
  vs ≤0.04 for position bias) and favours markdown; a raw scraped footprint must not lose to a
  well-formatted deck on presentation alone.

### 4.8 Model & prompts

All four sub-scorers: **`gpt-5.6-luna`**, **temperature omitted**. (Originally specified as
temperature 0; the model **rejects** it with HTTP 400 — «Unsupported value: 'temperature' does not
support 0 with this model» — verified live 2026-07-19. The parameter is omitted rather than sent
as 0 or 1. Determinism of the *score* never depended on it: the model emits only booleans and
citations, and every number is computed in `lib/f03/scoring.js`, which is deterministic by
construction. Sampling variance can still flip a verdict — which is why recorded fixtures exist.)
Exa's judge literature: a mid-tier model
with debiasing reached the highest human agreement of any configuration tested (71.0%, κ=0.549) at
~15× lower cost than the best frontier setup — decisive on $50 of shared credits.

All four agents specified via the `ai-agent-builder` skill (CLAUDE.md — prompts are product
artifacts, not improvisation). Rules: `reasoning` field **before** `verdict` in the schema; every
criterion anchored with a concrete definition of what `met` looks like, never a bare label;
negative criteria stated explicitly to counteract sycophancy; one sub-scorer = one concern.

### 4.9 Output contract — normative shape (consumed by 09, 06, 10)

```jsonc
{
  "status": "scored",                    // | "insufficient_evidence"
  "founder_id": "…", "run_id": "…", "score_id": "…",   // score_id null when insufficient
  "axis": "founder_score",
  "value": 62.50,                        // null when insufficient
  "confidence": 0.48,                    // null when insufficient
  "coverage": 0.67,
  "trend": null,
  "formula_version": "formula_v1", "prompt_version": "p1-2026.07", "model": "gpt-5.6-luna",
  "subscorers": [
    { "name": "execution-signals", "weight": 0.40, "criteria": [
      { "id": "E1", "verdict": "met", "credit": 1.0, "weight": 0.10000,
        "contribution": 14.92537, "evidence_tier": "documented",
        "claim_ids": ["…"], "quote_verbatim": "…", "rationale": "…", "demoted_by": null }
    ]}
  ],
  "missing": [ { "criterion_id": "L2", "what_would_close_it": "…" } ],
  "red_flags": [ { "id": "R4", "severity": 2, "contradicts": ["E4"], "evidence": ["…"] } ],
  "pedigree": { "prior_companies": [], "notable_employers": [], "scored": false,
                "note": "Displayed for context. Not scored — see design §3.2." }
}
```

`scores.missing_flags` stores the `missing` array verbatim — always supplied explicitly, so
consumers never see the column default `{}` (an object) where they expect `[]`.
Field names match `score_components` columns (`evidence_tier`, not `tier`).

Contract details a builder will otherwise have to invent:

- **`run_id`** is generated by the orchestrator (one UUID per run of `f03-score-founder`) and
  passed to the aggregate node. It is also echoed into each `ai_runs.output_json` so the four
  ledger rows join to the components. It is deliberately not `ai_runs.n8n_execution_id`, which is
  `text` and scoped to a single node.
- **`red_flags[]` has no table.** It lives in the red-flags sub-scorer's `ai_runs.output_json`
  (queryable jsonb). Feature 05 reads it there — stated explicitly so 05 does not go looking for
  a table that does not exist.
- **`severity`** (1/2/3, verified.vc tiers) is emitted by the red-flags agent, not assigned by the
  backend — severity is a judgement about the flag, unlike tier and verdict which are facts about
  evidence.
- **`coverage` is queryable without this payload**, since feature 09 reads Postgres, not the n8n
  response: `Σ weight WHERE verdict <> 'cannot_assess' / Σ weight`, grouped by `run_id` over
  `score_components`. Feature 10 should expose it on the `latest_founder_score` view.

## 5. n8n topology

Built via `n8n-requirements-orchestrator` → `n8n-workflow-builder` (CLAUDE.md: never assembled by
hand). Prefixed `f03-`, exported to `n8n/workflows/`.

### `f03-score-founder` — orchestrator

Callable by webhook and as a sub-workflow from 02 (radar) and 08 (intake).

```
input: founder_id
 → Supabase: claims ⋈ cards ⋈ evidence ⋈ raw_signals    (§4.1)
 → build 4 routed context packs, record pack claim_ids   (§4.7)
 → 4 PARALLEL LLM nodes: execution · expertise · leadership-sales · red-flags
 → write ai_runs × 4                                     (always, pre-validation)
 → Code: validation gate, steps 1-8                      (§4.4)
 → call f03-aggregate-score
```

`application_id` is deliberately not an input: 03 scores the **person**, and a founder may map to
several applications. Feature 04 resolves application context when it composes the `founder` axis.

### `f03-aggregate-score` — deterministic

A separate sub-workflow **on purpose**: the formula must be demonstrable to judges as the place
where no LLM is involved.

```
load active row from score_formulas (unique per axis)
 → guard: assessed_weight == 0 or coverage < min_coverage → insufficient_evidence  (§2.4)
 → value, tier_mix, confidence; round + clamp             (§2.3)
 → trend vs previous row, with the three NULL guards      (§4.5)
 → write scores × 1 (unless insufficient) + score_components × 12   (§4.3)
 → return the §4.9 contract
```

## 6. Test data

Feature 02 is not built, so the database holds zero claims. Feature 03 ships its own fixture at
`db/fixtures/03-founder-score.sql`, separate from `seed.sql` (registry-only by design; demo data
belongs to feature 11):

- **1 real founder** from a recent Show HN + GitHub, selected by hand, public signals only.
- **1 synthetic founder** (`is_synthetic = true`) with **seeded contradictions**, carrying the
  red-flag and `self_asserted` demo without alleging anything about a real person.
- A **third, deliberately sparse** founder (2-3 claims only) to exercise the
  `insufficient_evidence` branch — the cold-start case is the feature's flagship claim and must be
  visibly correct, not merely handled.
- All rows at the `claims` + `evidence` level — exactly the contract feature 02 will produce, so
  03 needs no rework when the radar lands.

Fixture obligations that will otherwise bite:

- **Every `evidence` row must set `raw_signal_id`** — `neg_src` (§4.4 step 5) is load-bearing on
  it, and the column is nullable. A fixture that omits it exercises only the fallback path and
  would hide a real defect.
- `raw_signals.source` must be one of the seeded `signal_sources` slugs (`github_api`,
  `hn_algolia`, `tavily_extract`, `deck_parse`, `interview_answer`, `manual`).
- `claims.topic` must use the §4.7 prefixes, or routing starves.
- `evidence.content_hash` is `NOT NULL UNIQUE`; `raw_signals.content_hash` likewise and
  `observed_at` is `NOT NULL` with no default.
- `cards.card_type` must be a seeded slug (`company` / `founder` / `team`); `companies.stage` must
  be `pre_seed` or `seed`.

Not applied by `apply.sh`. Explicit invocation, to be added to CLAUDE.md > Commands:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/fixtures/03-founder-score.sql
```

Ethics: public signals only; no Art. 9 categories; no age; opt-out honoured via `purge_founder()`.

## 7. Boundaries & stubs

| Item | Ruling |
|---|---|
| Social-personality analysis from tweets | SCOPE-005 — the sponsor called it a stretch, «not a must-have». Greyed `Personality (research)` block in the UI; no code |
| Prediction intervals | Not built. Honest `confidence` instead |
| External verification of claims | Feature 05. 03 tags tier and emits `red_flags[]` downstream |
| 12 parked criteria + 3 parked flags | §3, with per-item reasons |
| YC-directory calibration pass | Parked (~1h). Strong slide; revisit only if 06/09 land early |
| Cohen's κ validation on 30-50 hand-labelled cases | Parked. Exa names it a real differentiator almost nobody at a hackathon will have |

## 8. Known tensions, recorded honestly

1. **`reporting` (Apache-2.0) refuses to let a model score the team at all** — `mode:
   partner_only`, enforced in prompt, in a coercion function, and by a DB constraint. A production
   VC tool concluded the founder axis is precisely the one a model should not score. Our answer is
   posture, not disagreement: we score, and we surface every criterion, its evidence, and its
   confidence so the partner can override on sight. Worth saying aloud in the tech video rather
   than hoping no judge raises it.
2. **Is the founder the right thing to score?** Gompers et al. (885 VCs): team most important for
   47%, cited as a success driver by 96%. Davenport's revealed-error data points the other way at
   the margin. Reconciliation: the founder attributes that *mislead* (education, pedigree) differ
   from those that *predict* (specific-industry experience). §3.1/§3.2 score the latter, exclude
   the former.
3. **No source quantifies the AI-era capability signal.** Every 2026 source agrees the signal moved
   out of the artifact; nobody has published a validated metric for judging AI-assisted work from
   public artifacts alone. E8 was our attempt and is now parked precisely because it is unproven.
4. **Five founder-relevant intel signals carry `⚑ На ревью` flags** (SIG-003 ambiguous proxy;
   SIG-014/016/022/024 unverified quotes, several from LightRAG graph synthesis without an exact
   URL). Criteria resting on them are marked in the criteria registry so a citation's weakness is
   visible rather than laundered.
5. **The negative-capability check is source-level, not question-level** (§4.4 step 5). One
   `github_api` claim licenses `not_met` across E1/E3/E5/E7 even if it says nothing about merged
   PRs specifically. A finer check would need per-criterion field presence, which the claim
   vocabulary does not yet support. Accepted because it removes the crawl-luck asymmetry — the
   actual defect — at the cost of occasionally permitting a negative on thin grounds. Recorded
   here rather than hidden, since a judge may ask.

## 9. Handoff

- **04 market/competition owns the `founder` screening axis** (`axis='founder'`,
  `application_id`), composing it per its design §6.6 from the latest `founder_score` row +
  founder-market-fit + competitor-knowledge maturity — **not** by copying the value (Founder
  Score is an input to that axis, never a replacement — 01 design §4.1). 03 does not write that
  row (§4.3). 04 must handle §2.4's `insufficient_evidence` branch: no `founder_score` row → no
  `founder` row, rather than an invented one. Ruling recorded in `docs/backlog/TRACKER.md`.
- **05 truth-gap** consumes `red_flags[]` and `self_asserted` verdicts as its verification queue.
- **06 memo** consumes §4.9; `missing[]` feeds the deep-dive-questions agent directly (REC-005 —
  the memo must say where to dig). Must handle `status: "insufficient_evidence"`.
- **09 dashboard** renders `score_components` as the evidence-on-click breakdown; must obey the
  §2.5 ranking rules; hosts the `Pedigree (not scored)` block and the greyed
  `Personality (research)` stub.
- **10 API** gets `score_components` over PostgREST for free; a `latest_founder_score` view is the
  natural companion and should be planned there.
