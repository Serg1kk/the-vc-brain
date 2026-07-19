# 02 · Sourcing Radar — Design

> **Status: COMPLETE (2026-07-19).** Sections 1–4 operator-approved before the pause;
> sections 5–8 written autonomously after feature 03 signalled `done.md` with
> `status: complete`, per the operator's standing instruction to proceed without further
> questions.
>
> Sections 1–4 were designed against the sponsor material alone; sections 5–7 are written
> against **03's now-fixed contract** (03 design §3 rubric, §4.7 topic vocabulary, §4.9 output
> shape) — which was the whole reason for the pause.
>
> Sources consulted (CLAUDE.md hard rule): intel trackers (REQ/SCOPE/SIG/RSK/PAIN/FACT/STUB),
> raw Q&A transcript (`internal/Carl qa session/transcription/Hack qa_original.txt`),
> `internal/research/data-sources.md` + `internal/research/tavily/*`, all 9 OSS clones,
> NotebookLM ×10 (early-stage framing), Exa ×6, plus `docs/backlog/TRACKER.md` cross-feature
> rulings and `docs/backlog/03-founder-score/{design.md,done.md}`.

---

## 0. Headline finding — the field cannot see our target segment

All nine OSS references structurally penalise the cold-start founder. This is in their code,
not in their marketing:

- **vantage** `vantage/services/ai.py:136-143`: no company description → `risk += 8`; no
  `employee_count` → `missing`; no traction/funding/hiring signal → `risk += 6` + `missing`.
  Final score is `overall = base − 0.15 × risk`, and `missing` entries drag `completeness`,
  which forces `confidence` to "low". A solo Show HN founder trips all three.
- **VCI** `skills/deal-sourcing-signals/scripts/signal_scorer.py`: `HIRING 0.25 + FUNDING 0.25`
  = half the weight. A pre-seed founder scores zero on both → achievable ceiling ≈ 50 → they are
  permanently stuck at `MONITOR` (the `ENGAGE` band starts at 45, `MOVE FAST` at 70).

This is exactly the rubric's stated tiebreaker and the brief's FAQ-10 ("how do you score a
first-time founder with no GitHub, no funding, no network? … do not make this an afterthought").
It is also a direct violation of REQ-003 (missing data → confidence down, never the score):
in vantage, missing data reduces the score itself via `risk`.

**Consequence for this design:** borrow the *machinery*, never the *signal vocabulary*.
See §9.

---

## 1. Scope — what feature 02 owns

SCOPE-001 (Carl, 00:12:33: "for the challenge the main part is actually the scoring"; ruling:
"sourcing is shown as a layer over the same scoring signals") sets a hard boundary:
**02 computes no scores at all.** It collects, normalises, resolves identity, and writes Memory.

| Owned by 02 | Not owned |
|---|---|
| `radar-scan`, `identity-resolve`, `radar-enrich` n8n workflows | Founder score formula → 03 |
| Writes to `raw_signals`, `founders`, `founder_identities`, `companies`, `founder_company`, `applications`, **`cards`**, **`claims`**, **`evidence`**, `metric_observations`, `events` | Weights and aggregation → 03 |
| Computes **obscurity** and **freshness** as observable facts | Feed ranking → 09 renders |
| Calls the thesis gate | The gate itself → 07 |
| robots.txt compliance, opt-out check at ingest | Ethics UI → 09 / 11 |

Test applied to every field: it must have a named consumer in 03/04/05. No consumer → not fetched.

## 2. Architecture — two cost tiers

Driven by REC-008 (cheap text-only gate first, expensive analysis only past it), PAIN-005
(supply glut → throughput is the demo metric), and InGa's staging-before-resolution pattern.

```
[cron / manual trigger]
        │
  TIER 0 — free, deterministic, no LLM, no key  (added after live measurement, §2.1)
  radar-scan
    HN Algolia  search_by_date?tags=show_hn
      &numericFilters=created_at_i>{14d},points>=2
        │ → drop hits with no url (2.8% — nothing to resolve)
        │ → order by created_at_i DESC, take gate_budget (config, default 120)
        │   ⚠ the cap is by RECENCY, never by points — a points cap would reinstate the
        │     already-visible bias the operator explicitly removed (§10 decision 2).
        │     The number dropped is logged, never silent.
        │ → for the SURVIVORS ONLY: create founders + companies + applications FIRST,
        │   then raw_signals(source='hn_algolia', company_id SET at insert)  ← §5.0 rule 0
        │   The discarded remainder yields COUNTERS ONLY, never rows: a raw_signals row
        │   with both FKs NULL can never be reached by purge_founder() and the table is
        │   append-only, so it would survive erasure forever.
        │
  TIER 1 — cheap, one extra call per surviving candidate
        │ → /items/{objectID}  — full comment tree in ONE request (FACT-011)
        │   NB: median num_comments is 0 (§2.1) — an absent thread is a `missing` claim,
        │   not a failure; it is the common case, not the edge case.
        │
  thesis-gate  (feature 07, mode:'keyword' — no LLM, no token)
        │  FOUR-way branch (§5.5c): passed | borderline | NULL  → advance
        │                           failed                      → stop
        │  keyword mode never returns `passed` by design, and NULL is a reachable
        │  post-gate state — advancing only on `passed` would advance nobody.
        │  Rejects are persisted too (REQ-009; base rates → RSK-004 defence).
        ▼
  TIER 2 — expensive, only past the gate
  identity-resolve   →   radar-enrich
                          GitHub (GraphQL if token, else REST unauth 60/h — §5.4)
                          Tavily /map → ONE batched /extract (≤20 URLs)
                          → cards + claims (verbatim) + evidence + metric_observations
```

Rationale:

1. **Tiers 0–1 need no `GITHUB_TOKEN`.** Without it the radar still runs — REST unauthenticated
   covers most of tier 2 at 60 req/h (§5.4). Degradation, not failure.
2. **Raw payload is persisted before processing.** If an LLM node or Tavily fails, the
   observation is already in Memory — resolution can be replayed without re-hitting the API.
   Satisfies REQ-009 and RSK-003 (verbatim before any paraphrase).
3. **Gate rejects are kept, not dropped.** Without them there is no base rate and we reproduce
   the survivorship bias we claim to defend against (RSK-004).

Secondary entry point `radar-github-graph` (small run over GitHub follower-quality) merges into
tier 2. Error posture from vantage: best-effort, never fatal — one source failing must not kill
the run; unresolved items are marked (`processing_status`), never deleted. Run counters
`{signals, candidates, resolved, duplicates, gated_out}` → `events` (observability + demo numbers).

### 2.1 Live measurement of the funnel (2026-07-19, real API)

The volume estimate in an earlier draft ("~40–80 candidates per run") was wrong by more than an
order of magnitude. Measured against the live endpoint, 14-day window, `points>=2`:

| Quantity | Measured |
|---|---|
| `nbHits` | **1380** (~100/day) |
| Returned in one page | 1000 (Algolia's ~1000-result ceiling — deeper needs time-slicing) |
| `url` host = `github.com` | **36.1%** |
| No `url` at all | 2.8% |
| Distinct non-GitHub hosts | **581** |
| Median `points` | **3** |
| Median `num_comments` | **0** |

Four consequences, all folded into the design above:

1. **A tier-0 deterministic bound is mandatory.** 1380 LLM gate calls per run is not affordable
   and not necessary. Rows are persisted for the survivors only — see §5.0 rule 0(a) for why
   persisting the discarded remainder would be a permanent GDPR residue rather than free memory.
2. **The cap must be by recency, not by points.** Capping by points would silently restore the
   already-visible bias the operator removed on purpose.
3. **The comment thread is the minority case, not the norm.** Median 0 comments means the
   coachability proxy (author's replies in their own thread) is *absent* for most candidates.
   It is a bonus signal, not a load-bearing one — an important correction to how §3 presented it.
4. **36.1% GitHub, 581-host tail** confirms the §4 correction empirically on fresh data: the
   product URL path is the majority path, and there is no dominant platform to special-case.
   (The 27% figure quoted in §4 is the 2012–2026 lifetime average; the current rate is higher
   but still a minority.)

## 3. Capture list — every field has a consumer

**GitHub GraphQL, one query per candidate:**

| Field | Consumer / rationale |
|---|---|
| `pullRequestContributionsByRepository`, filtered `owner != user` AND `merged` | strongest un-gameable signal → 03 |
| `totalPullRequestReviewContributions` | seniority: trusted to judge others' code → 03 |
| `contributionCalendar.weeks[].contributionDays[]` — **day array, never a sum** | series shape, not volume. The aggregate is precisely the trivially-gamed metric (green-calendar trap, `data-sources.md`) → 03 |
| `repositories(OWNER)`: `createdAt`, `pushedAt`, `isArchived`, `isFork`, `releases.totalCount` | agency / finished-vs-abandoned, survival ratio (SIG-011) → 03 |
| `repository.object(expression:"HEAD:")` — top-level file names | presence of `tests/`, `.github/workflows`, specs, LICENSE = **spec-driven development**, the replacement for the decayed "has a prototype" signal (NotebookLM Q7) → 03 |
| `homepageUrl` + HTTP liveness probe | shipped-vs-built (SIG-012) → 03 |
| `stargazerCount`, `forkCount` | stored **flagged as vanity**, never weighted (SIG-014); fork/star ratio > absolute → 03 |
| `languages(first:10){size}` (bytes) | stack depth vs scatter → 03 |
| `followers(first:50){nodes{login followers{totalCount}}}` | **obscurity + follower quality in one query** (~1 point). No curated seed list, no time snapshots needed |
| `createdAt`, `websiteUrl`, `twitterUsername`, `email` | profile age + identity hub |
| `location` (free text) | normalised to **country only** for the thesis geo filter (07). City is neither stored nor scored |

**HN Algolia:**

| Call | Purpose |
|---|---|
| `search_by_date?tags=show_hn&numericFilters=created_at_i>{14d},points>=2` | funnel head |
| `/items/{objectID}` | full comment tree, one request (FACT-011). Key extract: **author's own replies in their own thread** — a direct proxy for coachability that VCs normally only observe on a live call |
| `/users/{username}` → `karma` | reputation, expensive to fake |
| `search_by_date?tags=comment,author_{u}` (capped) | topic clustering over years = domain expertise vs dilettantism |

**Tavily:** `/map` on the artifact URL with `allow_external:false` (otherwise we pay for other
people's site structure) → prioritise `/about`, `/now`, `/blog`, `/changelog`, `/pricing` →
**one batched `/extract`, up to 20 URLs** (5 URLs per call = 1 credit; 5 separate calls = 5
credits). `/crawl` is **not used** — flagged invite-only in the `tavily-python` README and
unverified on our key.

**Deliberately not collected** (visible in-product): age, photo, gender, marital status, precise
address, and everything in GDPR Art. 9 (health, ethnicity, politics, religion, union membership,
orientation). The argument works twice: data minimisation under EDPB 03/2026 + CNIL, *and* a
defence against scoring bias — NotebookLM's "backward-similar investing" (models trained on past
winners reproduce their demographics).

**All text is stored verbatim.** `claims.text_verbatim` + quote and URL in `evidence`;
interpretation lives in a separate field. RSK-003: LLM paraphrase pulls a non-standard thesis
toward the median narrative, and slang can invert the sign (recorded case: "founder is cracked"
read as "broke under pressure").

Honest gaps in this section:
- The SIG-014 provenance triple (first-commit date vs repo creation date + cross-search for an
  earlier source) is **not obtainable in the main GraphQL query**. Earliest commit needs
  `history(last:1)` or a REST fallback on the last page. Planned as a separate step.
- ~~`points>=2` over 14 days yields ~40–80 candidates per run~~ — **measured wrong, corrected in
  §2.1: the real figure is 1380.** The heavy-tailed conclusion stands and strengthens: a large
  share have no resolvable GitHub (63.9% by measurement), which is a normal branch
  (`unresolved`), not an error. The 3–5 deep demo cards are picked from ~10 enriched, not from 3.

## 4. Artefact and identity resolution

**Superseded assumption (corrected by operator, twice).** The first draft treated the GitHub
repository as the artefact and name-matching as the primary identity path. Both were wrong:

- Measured: of **188,085 Show HN posts (2012 – Apr 2026), 51,338 = 27%** link to a GitHub repo.
  Nearly three quarters link to a product, a live demo, or a personal domain.
- Among **successful** posts (200+ points) the GitHub share rises to ~40%. So filtering on
  GitHub presence also biases toward the already-visible — two systemic biases in one place,
  both against our target segment.
- Brief FAQ-10 explicitly names the **founder with no GitHub** as the cold-start case.
  The original feature README's GitHub-hub cascade would have dropped such a founder out of the
  outbound track entirely.

**Corrected: the artefact is the URL in the post, whatever it points to.**

| Path | URL type | Share | Action |
|---|---|---|---|
| A | `github.com/{owner}/{repo}` | ~27% | repo owner is the identity anchor; full GitHub enrichment |
| B | any other domain — product, demo | **~73%** | **the product IS the artefact**: Tavily `/map` + `/extract` on `/about`, footer, `/changelog`, `/pricing`. If GitHub/social links appear there, enrich; if not, proceed without |
| C | no URL (text-only post) | remainder | HN-only card |

GitHub is demoted from gate to optional enrichment. It remains the identity hub *where present*,
because it genuinely exposes links as structured fields (`websiteUrl`, `twitterUsername`, `email`).

**What replaces it as the universal spine: the HN comment corpus.** The author's handle always
exists. `karma`, replies in their own thread, the multi-year comment corpus, Ask HN posts about
their own problem — none of this depends on GitHub or on the code being open. This is more
universal than GitHub, which the first draft underweighted.

**Reframe that resolves the closed-source worry:** for the shipped-vs-built signal, a live
closed-source product is *stronger* evidence than a public repo. SIG-012 never said "wrote code";
it says "shipped to production and got external traction". A working site with a changelog, a
pricing page and a passing liveness probe proves shipping better than a repo that may sit
untouched. The repo wins only on two specific signals: provenance (was it copied) and
collaboration (merged PRs into others' repos).

Therefore **absence of public code is not a negative fact** — it is absent data:
`claims.verification_status='missing'`, confidence down, score untouched (REQ-003) — **subject to
§5.0 rule 2**, which forbids emitting such a marker when no attempt signal exists at all. Confirmed by
Carl on unequal public footprint (01:03:39): flag missing information, never make anything up,
and rather recommend a call if it is otherwise a strong fit.

### 4.1 Identity resolution, grounded in measurement (n=18 live sample, 2026-07-19)

| Measured | Value | Consequence |
|---|---|---|
| Artefact owner is an **Organization**, not a User | **11%** (2/18) | a case the first draft did not handle at all |
| GitHub `blog` field populated | **44%** (8/18) | the "GitHub as identity hub via `websiteUrl`" path fails more often than it works |
| `hn_author` == `gh_owner`, case-insensitive | **39%** (7/18) | exact handle match is a minority event |

**The decisive correction.** Near-misses in the sample — `misilojakub` ↔ `jmisilo`,
`ashitesh_12` ↔ `AshiteshSingh`, `kaiwuTW` ↔ `kaiwutech-TW`, `shlokkshahh` ↔ `shlokkokk` — are
plainly the same person using different handles on different platforms. String similarity is the
wrong instrument for proving that, and fuzzy-matching it is precisely the error class REQ-004
forbids.

The proof is in the post itself. **Show HN's published guidelines require the submitter to be the
maker** ("The project must be something you've worked on personally and which you're around to
discuss"), and this is enforced by moderation. A Show HN submission linking to a repository is a
**declaration of authorship by the author**, not a coincidence of names. So the link
`hn_author → artefact_owner` is licensed by platform rules, and a handle match merely corroborates
it. The residual risk is not "two different people with similar names" but "someone submitted a
third party's project" — which the guidelines forbid and which is rare.

**Revised cascade:**

| Tier | Condition | Confidence | Action |
|---|---|---|---|
| 1 | Artefact owner (type `User`) **and** `hn_author == gh_login` case-insensitively | 0.95 | auto-link |
| 1 | Personal site links back to `news.ycombinator.com/user?id={hn}` — bidirectional declaration | 0.95 | auto-link |
| 2 | Artefact is a repo owned by a **`User`**, submitted as Show HN by that author — declared authorship per HN guidelines, no handle match required | **0.85** | auto-link; `discovered_via='showhn_declared_artifact'` |
| 3 | Artefact owner is an **`Organization`** | 0.60 | the **org becomes the `companies` row**, not the founder. Founder stays `unresolved`; `GET /repos/{o}/{r}/contributors` supplies candidate people, each written with `needs_review`. **No entity merge.** |
| 4 | Artefact is a non-GitHub product URL | — | product path (§4 path B); identity from `/about` + footer; frequently stays `unresolved` |
| 5 | Nothing resolvable | — | `unresolved`; candidate survives as an HN-only card |

Tier 2 is the load-bearing tier and it did not exist in the first draft. It converts the
61% of cases where handles differ from "unresolved" into "resolved at 0.85 on a platform-rule
basis" — without a single fuzzy string comparison.

**Consequence for the personal-site path:** with `blog` populated only 44% of the time, the site
crawl cannot depend on it. The Show HN `url` itself is frequently the personal or product site,
so the crawl seed is `coalesce(github.blog, artefact_url_if_not_github)` — and where the artefact
*is* a GitHub repo, `repo.homepage` is the third fallback.

Two principles above the table:

- **Attaching an identity and merging two entities are different acts.** Attaching a `github`
  identity at 0.85 is fine. Merging two existing `founders` rows requires ≥0.9 or manual review.
  The DB already guards this: `UNIQUE(kind, value)` on `founder_identities` prevents one GitHub
  login from spawning a second person; `merged_into_founder_id` keeps canonicalisation as a
  tombstone rather than a deletion.
- **Conflicts are not averaged.** Handle matches but the personal site shows a different name →
  that is not "0.7 on average", it is a contradiction. Record both observations and flag. A
  weighted mean can express uncertainty but cannot express conflict, and emits a
  confident-looking number where none is warranted.

Plus vantage's `canonical_domain` + `_GENERIC_HOSTS` guard, borrowed verbatim (MIT, stdlib only):
`github.io`, `vercel.app`, `notion.site`, `substack.com` etc. must never count as a company
domain, or half the cold-start founders merge into one company.

**Bias caveat, load-bearing.** NotebookLM surfaced a measured side effect of strict matching: in
a patent→LinkedIn linkage study, strict heuristics left **90% unmatched** and skewed the matched
set toward "corporate employees in technology sectors rather than independent inventors". That is
our target segment, inverted. Therefore: **strictness applies to linking, never to admission.**
A candidate with `unresolved` identity is not dropped — they enter the feed as HN-only with
honestly reduced confidence.

---

## 5. Output contract — the claims 03 actually consumes

This is the section the pause existed for. 03 defines the rubric (its design §3) and the topic
vocabulary (§4.7). The radar's whole job is to produce claims that land on those criteria.

### 5.0 Write contract — the three rules that decide whether any of this reaches 03

Added after spec review. Each of these was a defect that independently reduced the feature's
output to nothing useful.

**Rule 0 — every candidate gets a `founders` row, and every `raw_signals` row gets an FK.**

Two defects found in re-review, both structural:

*(a) GDPR.* `purge_founder()` deletes `raw_signals` **only** by `founder_id` or `company_id`, and
the table is append-only (`trg_raw_signals_forbid_mutation`) — so an FK left NULL at insert can
never be backfilled. Writing all ~1380 tier-0 hits with both columns NULL would deposit, every
run, a permanent residue of HN handles, titles and URLs that **survives erasure forever**. That
would make §7's ethics claims false at the pipeline's highest-volume write. TRACKER's ~06:50
cross-feature note states the standing rule: every `raw_signals` row wants at least one of
`founder_id` / `company_id` set **at insert time**.

Ruling: **`companies` + `applications` + `founders` are created for the `gate_budget` subset
*before* the tier-0 raw write, and `raw_signals.company_id` is set at insert.** For the discarded
remainder (recency-capped, not rejected) only **counters** are persisted, never rows — they were
never candidates, so REQ-009 is untouched and RSK-004's base rates are unaffected (base rates come
from *gate* outcomes, which all live inside the budget).

Acceptance criterion: *no radar-written `raw_signals` row has both `founder_id` and `company_id`
NULL.*

*(b) The unresolved majority.* Rule 1 below requires `cards.founder_id`, but §4.1 tiers 4–5 —
~64% of candidates by §2.1's measurement — end `unresolved`. Without a `founders` row those
candidates get no card, no claims, and §5.4 rows 3–4 plus §5.2's whole `insufficient_evidence`
argument become unreachable. That would void the cold-start path this feature exists for.

Ruling: **every candidate gets a `founders` row**, anchored on
`founder_identities(kind='hn', value=<handle>)` — `UNIQUE(kind, value)` makes the HN handle a safe
natural key. `founders.full_name` is `NOT NULL`, so it holds the HN handle until a better name
resolves. **`unresolved` in §4.1 means no *cross-platform* link — never the absence of a person.**

**Rule 1 — every claim hangs on a `cards` row whose `founder_id` is set.**
`claims.card_id` is `NOT NULL REFERENCES cards(id)`, and 03's read path is
`claims JOIN cards ON claims.card_id = cards.id WHERE cards.founder_id = $1` (03 §4.1). A claim on
a card with a NULL `founder_id` is **invisible to 03** — every reachable-weight number in §5 would
be zero. So: one `cards` row per founder, `card_type='founder'` (a seeded `card_types` slug),
`founder_id` always populated, `company_id`/`application_id` populated when known,
`status='prefilled'` (the radar pre-fills from public footprint; the founder confirms later in
feature 08).

> This supersedes 01 design §9, which says 02 writes "raw_signals + metric_observations +
> founder_identities **only**". That line is stale: 03's contract requires claims, claims require
> cards, and claims require evidence (rule 2).

**Rule 2 — no claim without evidence, and no evidence without `raw_signal_id`.**
03 §4.4 step 5 falls back to `claims.source_kind` when no `raw_signal` is reachable, and that
table maps `public` → **"any source (wildcard)"**. Since every radar claim is `source_kind='public'`,
a single evidence-less radar claim would license `not_met` on **every** criterion — including
L2 (0.150), L3 (0.090) and X5 (0.056), the three that §5.2 argues must safely become
`cannot_assess`. They would instead enter the denominator at zero credit and drag `value` down for
a founder whose only shortcoming is not having submitted a deck. That is REQ-003 inverted, and it
is precisely the defect §0 criticises `vantage` for.

Therefore, normatively:

1. Every claim the radar writes carries **≥1 `evidence` row with `raw_signal_id` populated**.
2. A `missing`-marker claim cites the raw signal of the **attempt** — the GitHub capability-check
   response, or the Tavily `/map` result that found no `/about` — with `relation='context'`,
   `tier='missing'`, `quote_verbatim=NULL`.
3. **If no raw signal exists at all** (the call was never made — e.g. no token), **write no claim.**
   Silence yields `cannot_assess`, which is the correct outcome. A marker claim is strictly worse
   than no claim here.

Acceptance criterion, testable: *no radar-written claim reaches 03 without a resolvable
`raw_signals.source`.*

**Rule 3 — append-only tables need a two-step insert.**
`raw_signals` and `evidence` carry `trg_*_forbid_mutation`, so `ON CONFLICT DO UPDATE` (what
PostgREST's `Prefer: resolution=merge-duplicates` emits) raises `P0001`. `ON CONFLICT DO NOTHING`
is correct but returns **zero rows** on a retry — leaving the workflow with no `raw_signal_id` to
attach evidence to, which manufactures exactly the evidence-less claims rule 2 forbids. Every
DB-write step is therefore: `INSERT … ON CONFLICT DO NOTHING`, then, if zero rows returned,
`SELECT id WHERE content_hash = $1`.

**Field defaults**, so no implementer has to guess:

| Column | Value | Why |
|---|---|---|
| `evidence.tier` | `signal_sources.base_tier` (`github_api`/`hn_algolia` = `documented`, `tavily_extract` = `discovered`) | 03 §4.4 step 6a coerces `met` → `self_asserted` when the best tier is `inferred`/`missing` (credit 1.0 → 0.3). Leaving this unstated is the single largest source of unexplained score variance |
| `evidence.tier` when the identity link is **below 0.85** | forced to `inferred` | the only lever that makes §4.1's "enters scoring at reduced confidence" real — 03 never reads `founder_identities.confidence`. Dragging `tier_mix` down *and* coercing `met` → `self_asserted` is exactly the intended semantics |
| `claims.source_kind` | `public` | always, for radar output |
| `claims.axis` | `NULL` | 03 routes by topic prefix, not by axis; setting it would imply an ownership the radar does not have |
| `claims.verification_status` | `unverified` | the schema default. Verification is feature 05's job; a `documented`-tier GitHub fact is still unverified *as a claim* |

### 5.1 Claim topic map

Every claim the radar writes uses one of these slugs. Routing in 03 is by **prefix**, and a claim
matching no prefix falls into the red-flags union pack rather than being dropped — but a claim
that lands in no sub-scorer's pack contributes to no criterion, so the slug matters.

| Topic slug | Feeds criterion | Source (`raw_signals.source`) | How the radar obtains it |
|---|---|---|---|
| `founder.execution.merged_pr_foreign` | **E1** (0.100) | `github_api` | `pullRequestContributionsByRepository`, filtered `owner != user` AND merged, ≤12 months |
| `founder.execution.commit_consistency` | **E3** (0.060) | `github_api` | `contributionCalendar` day array → count of the last 12 weeks having ≥1 commit |
| `founder.execution.live_product` | **E4** (0.100) | `tavily_extract` \| `github_api` | HTTP liveness probe on the artefact URL / `homepageUrl`; classified live / soft-404 / placeholder |
| `founder.execution.external_usage` | **E5** (0.080) | `github_api` | `forkCount`, dependents, release download counts — measured usage, never stars |
| `founder.execution.provenance` | **E7** (0.060) | `github_api` | repo `createdAt` vs earliest commit date vs account `createdAt` (see §5.3) |
| `founder.expertise.vertical_tenure` | **X1** (0.094) | `tavily_extract` | personal site `/about`, `/cv` — stated tenure, verbatim |
| `founder.expertise.insight_specificity` | **X2** (0.075) | `tavily_extract` \| `hn_algolia` | blog posts and HN comment corpus, verbatim |
| `founder.expertise.unasked_work` | **X6** (0.075) | `github_api` \| `tavily_extract` | substantial work predating any funding — repo history + site changelog |
| `founder.leadership.written_communication` | **L5** (0.060) | `hn_algolia` \| `tavily_extract` | Show HN post text, author's replies in their own thread, homepage stranger-test |

**Reachable weight: `0.40000 + 0.24375 + 0.06000` = 0.70375 of 1.00000.** A deliberate, honest
ceiling, not an oversight.

Two precision notes:

- **This is a ceiling, not a coverage prediction.** 03 routes by topic *prefix* to a sub-scorer;
  the suffix (`merged_pr_foreign`) is never parsed, and the agent decides which criterion a claim
  bears on. So 0.70375 is what the radar makes *available*, and §5.2's `min_coverage` argument
  depends on the agents actually using it.
- **E4's provenance slug.** A liveness probe is a plain HTTP GET, and `raw_signals.source` is a FK
  to `signal_sources` where no such slug exists. Ruling: **the probe is performed by Tavily**
  (`/extract` already fetches the page and its success/failure *is* the liveness answer — see
  §7.1's interpretation table), so it is recorded as `tavily_extract`, which is provenance-true.
  A separate `http_probe` slug is deliberately **not** added: E4's `neg_src` lives in
  `score_formulas.config`, seeded `ON CONFLICT (version, axis) DO NOTHING`, so editing the seed
  would not update the applied database — it would need a `formula_v2` row and an `active` flip,
  which is 03's territory and not worth a cross-feature migration for zero gain.

### 5.2 What the radar structurally cannot reach — and why that is correct

| Criterion | Weight | `neg_src` | Why the radar cannot serve it |
|---|---|---|---|
| **L2** first customers / LOI / pilot | 0.150 | `deck_parse` \| `interview_answer` | Customer evidence is not public. A founder's own claim of "5 pilots" exists only in a deck or an interview |
| **L3** ICP specificity | 0.090 | `deck_parse` \| `interview_answer` | Same |
| **X5** competitor insider granularity | 0.056 | `deck_parse` \| `interview_answer` | Same |

These three are exactly the criteria whose `neg_src` lists **only** founder-supplied sources. 03's
validation gate coerces `not_met` → `cannot_assess` when the licensing source is absent (03 §4.4),
so a radar-only founder is **not penalised** for them — they surface as `cannot_assess`, which
lowers confidence, never the value. This is REQ-003 executing end to end across two features
without either feature special-casing the other.

Coverage check against 03's `min_coverage` = 0.25 (below which 03 writes **no score at all**):
a radar-only founder with GitHub reaches ~0.70, and even the degraded HN-only path (§5.4) reaches
~0.135 from L5 + X2 — **below the threshold**. So an HN-only candidate with no resolvable
artefact legitimately produces `insufficient_evidence` rather than a fabricated number. That is
the designed outcome and feature 09 must render it as a state, not as a zero.

### 5.3 The E7 provenance triple

Flagged in §3 as not obtainable in the main GraphQL query. Resolution:

- `repository.createdAt` and `user.createdAt` come free in the main query.
- Earliest commit: `defaultBranchRef.target.history(last: 1) { nodes { committedDate } }` as a
  **second, narrow query** issued only for the flagship repo (the one the artefact URL points at),
  not for every repo. One extra query per candidate, ~1 point.
- Verdict written into `claims.value` as `{repo_created_at, first_commit_at, account_created_at,
  anomaly: "none"|"commits_predate_repo"|"repo_predates_account"}`.

The third leg of the triple in the intel base — a cross-search for an earlier source of the same
content — is **parked**, and the parking is recorded rather than silently dropped: it needs a code
similarity search across GitHub that neither the GraphQL API nor Tavily provides cheaply. R1
(provenance spoofing) in 03's red-flags stream still fires on the first two legs.

### 5.4 Graceful degradation ladder

Weights are quoted at the exact 5 dp 03 stores them at, and every row is shown summed — 03 chose
`numeric(6,5)` precisely so a judge can verify the addition, and rounding undercuts that claim.
(An earlier draft of this table was arithmetically wrong; caught in spec review.)

| Available | Claims produced | Reachable weight |
|---|---|---|
| HN + GitHub + personal site | all nine slugs | `0.40000 + 0.24375 + 0.06000` = **0.70375** |
| HN + GitHub, no site | drops X1 | `0.70375 − 0.09375` = **0.61000** |
| HN + site, no GitHub (**closed-source founder**) | E4 via `tavily_extract`, X1, X2, X6, L5 | `0.10000 + 0.09375 + 0.07500 + 0.07500 + 0.06000` = **0.40375** |
| HN only | X2, L5 | `0.07500 + 0.06000` = **0.13500** → below `min_coverage`, so `insufficient_evidence` |
| **No `GITHUB_TOKEN` — REST unauthenticated** | all nine, **E3 at reduced confidence** | **0.64375** guaranteed, up to **0.70375** if the events window covers E3 |

The last row is the operational reality at the time of writing (§10), and it is **considerably
better than the first draft assumed** — verified live:

- GraphQL requires authentication absolutely (no anonymous access), but **REST does not**:
  measured `core limit=60, remaining=60` per hour unauthenticated. At demo scale (3–5 founders ×
  ~4 calls) that is comfortably inside budget.
- REST covers: `GET /users/{login}` (identity hub, `blog`, `twitter_username`, `followers`,
  `created_at`), `GET /users/{login}/repos?sort=pushed` (E5 `forks_count`, `homepage` for E4,
  `created_at`/`pushed_at`/`archived` for X6), `GET /repos/{o}/{r}/commits?per_page=1&page=N`
  (E7 earliest commit), `GET /repos/{o}/{r}/contributors` (§4.1 tier 3).
- **E1** (merged PRs into foreign repos) via `GET /search/issues?q=author:{login}+type:pr+is:merged`
  — the Search API has a separate, tighter unauthenticated budget (10 req/min), which is fine for
  a handful of founders and unusable at scan scale. Gated behind the same capability check.
- **E3** (commit consistency across 12 weeks) is the one genuine casualty: the contribution
  calendar is GraphQL-only. REST's `/users/{u}/events` covers ~90 days / 300 events and is a
  partial substitute; the claim is emitted with lower `base_confidence` and an explicit note, or
  as `missing` when events are exhausted.

So the token is a pure enhancement with a measured, honest cost: without it the radar reaches
**0.64375–0.70375** instead of 0.70375, and one criterion degrades rather than disappears.
Every GitHub call sits behind a capability check that follows §5.0 rule 2 — a `missing` claim only
where an attempt actually produced a raw signal, and silence otherwise.

### 5.5 Gate contract with feature 07

Three problems at this seam, all found in spec review; the third would have made tier 2
unreachable in production.

**(a) The gate needs rows that tier 0 must create first.** `thesis_evaluations.application_id` is
`NOT NULL REFERENCES applications(id)`, so `companies` + `applications` must exist *before* the
gate runs — including for candidates about to be rejected (§2 rationale 3 requires rejects be
persisted for base rates). Defaults, stated so nobody guesses:

| Column | Value |
|---|---|
| `companies.name` | Show HN title, normalised (`normalizeName`) |
| `companies.domain` | `canonicalDomain(artifact_url)` or NULL. The schema has a plain `domain text UNIQUE`, and Postgres treats NULLs as distinct under it — so unlimited domainless candidates already coexist. **§9 borrow item 4 is satisfied by NULL semantics; no index change, no DDL.** (An earlier draft claimed a partial index `WHERE domain IS NOT NULL` exists here — it does not, and adding one to the contested `db/schema.sql` would be redundant.) |
| `companies.stage` | `'pre_seed'` — a **track-level assumption, not an observation**. Show HN is by construction pre-seed territory; the column is `NOT NULL CHECK (stage IN ('pre_seed','seed'))` so there is no "unknown" |
| `applications.kind` | `'radar_activated'` (deckless by definition; 01's inbound-only deck CHECK permits exactly this) |
| `applications.status` | `'sourced'` |

**(b) The gate needs something to read, and in tier 1 no claims exist yet.** The carrier is
`applications.artifact_links`, which §10 previously parked as having "no writer, no seed and no
agreed key shape anywhere in the repo". It is on tier 1's critical path, so the radar — its
natural first writer — fixes the shape here:

```json
{"source": "hn_showhn", "hn_item_id": "48964105",
 "hn_url": "https://news.ycombinator.com/item?id=48964105",
 "title": "Show HN: …", "story_text": "…",
 "artifact_url": "https://github.com/owner/repo",
 "artifact_kind": "github_repo|github_user|product|none",
 "repo": {"owner": "…", "name": "…"}, "homepage": null}
```

**(c) The branch must be four-way, not three.** Per `TRACKER.md` 2026-07-19 ~05:30 ("07 → 02,
ACTION NEEDED"): `thesis_gate = NULL` is a **reachable post-gate state** (written on the gate's own
`insufficient_evidence`), and tier 1 calls the gate in `mode: 'keyword'`, which **never returns
`passed` by design**. A design advancing only on `passed` therefore advances nobody — the radar
would produce zero enriched candidates while every workflow returned success.

Ruling: **tier 2 runs on `passed`, `borderline` and `NULL`.** Only `failed` stops. `NULL` is
treated as `borderline` and is recorded as such in the run counters so it is visible rather than
silent.

**Which surface 02 branches on** — the two disagree and picking the wrong one reintroduces the
bug: `thesis_evaluations.verdict` is four-valued and includes `insufficient_evidence`, while
`applications.thesis_gate` is three-valued plus NULL. **02 branches on the gate sub-workflow's
returned `verdict`.** `insufficient_evidence` (response) ≡ `NULL` (column); both take the advance
branch. Only `failed` stops. This is the open-door posture SCOPE-007 asks for anyway — Carl: "It should be an open door
first for everyone… but you may think about certain filters."

**Exact call shape**, read off the deployed workflow rather than inferred
(`f07-thesis-gate`, id `EQxi1lFF2bDjDByd`, active, 34 nodes). It has two entry points, and its
sub-workflow normaliser names this feature explicitly — *"Called by 08 (intake, mode='full') /
02 (radar Tier 1, mode='keyword')"*:

| Entry | Payload |
|---|---|
| Execute-Workflow sub-call (**what 02 uses**) | flat item, no wrapper: `{application_id, text, mode:'keyword', structured_hints:{geography_country}}` |
| `POST /webhook/f07-thesis-gate` | same object under `.body` |

`application_id` is required and throws if absent — which is precisely why §5.5(a)'s pre-gate
entity creation must run first. `text` carries the Show HN title + story text; `mode` defaults to
`'full'` if anything other than the literal `'keyword'` is sent, so it must be sent exactly.

Feature 03's scorer is likewise deployed and callable the same way (`f03-score-founder`,
id `AlkzJ70zET7SiHkn`, active) with `{founder_id}` — that is the end-to-end proof: a founder the
radar discovered, scored by the same pipeline an inbound applicant would use.

**(d) Two further requirements from 07's own handoff** (`07/handoff.md` §2, written directly to
this feature after 07 closed):

- **Geography is passed as `structured_hints.geography_country`, ISO-3166-1 alpha-2.** 07 matches
  at country level and derives the region itself — which is exactly why §3 normalises GitHub's
  free-text `location` to a country and stores nothing finer. The two decisions were made
  independently and happen to line up; the field name and the alpha-2 format are 07's, and are
  binding here.
- ⚠️ **`failed` is rare by construction.** Every compiled mandate rule in 07 is `soft`; only a
  hand-authored `hard` rule rejects, and the starting thesis has exactly one (gambling/adtech).
  **So the gate is not a volume filter.** Cost control in tier 1 is done entirely by §2's
  recency-ordered `gate_budget` cap, and no part of this design may assume the gate thins the
  funnel. Stated because the opposite assumption is the natural one to make from the word "gate".

## 6. Dedup, idempotency, freshness, obscurity

### 6.1 Idempotency — every write is replay-safe

Feature 01 already provides the guarantees; the radar's job is to compute the keys correctly.

| Table | Key | Radar's basis |
|---|---|---|
| `raw_signals` | `content_hash` UNIQUE | `sha256(source \|\| '::' \|\| source_id \|\| '::' \|\| observed_at)` — InGa's composite-id shape: `hn_algolia::48964105`, `github_api::octocat`, `tavily_extract::https://…`. **`observed_at` is defined per source** (below) — without that the hash changes every run and dedup silently never fires |
| `claims` | `content_hash` | `sha256(card_id \|\| topic \|\| text_verbatim)` |
| `evidence` | `content_hash` UNIQUE | `sha256(claim_id \|\| relation \|\| source_url \|\| quote_verbatim)` |
| `founder_identities` | `UNIQUE(kind, value)` | the DB-level dedup gate — re-ingesting a GitHub login cannot mint a second person |
| `metric_observations` | `UNIQUE NULLS NOT DISTINCT (metric, founder_id, company_id, observed_at)` | `observed_at` truncated to the hour, so a retry within the same scan window collapses |

**`observed_at` per source** (spec review found the earlier text self-contradictory — a fetch-time
value makes every re-run a fresh hash, which breaks §6.1's "no-op" promise, while an item-time
value makes §6.3's "re-observation appends a row" impossible):

| Source | `observed_at` | Effect |
|---|---|---|
| `hn_algolia` (story, thread) | the item's own `created_at` | stable forever → the same post can never duplicate |
| `github_api`, `tavily_extract` (snapshots) | `date_trunc('hour', now())` | a retry inside the hour collapses; a genuinely later scan appends a new observation, which is what makes velocity computable (§6.3) |

The same truncation is applied *inside* the hash, not only in the column.

All writes are `INSERT … ON CONFLICT DO NOTHING`, followed by the §5.0 rule 3 select-back. A
re-run of the same window is a no-op, not a double-count — the property vantage's `content_hash`
and reporting's migration comment both call out, and the one a cron-driven scan needs most.

### 6.2 Scan-window state without a new table

No new table. Each completed scan appends to `events`:

```
event_type = 'radar_scan_completed'
payload    = {window_start, window_end, counters:{signals, candidates, resolved,
              unresolved, duplicates, gated_out, enriched}}
actor      = 'n8n:f02-radar-scan:<execution_id>'
```

The next run reads `max(payload->>'window_end')` for its lower bound and defaults to `now() - 14d`
on an empty table. This doubles as the run ledger (vantage's `JobRun` counters) and gives the demo
its throughput numbers for free.

### 6.3 Freshness and re-scan

- **New candidates:** the 14-day Show HN window (§10 decision 2).
- **Re-observation of known candidates:** the same identity re-appearing is *signal*, not noise —
  SIG-025 (post-rejection updates are a rare persistence marker) and REC-010 (watchlist) both
  need it. A second `raw_signals` row with a later `observed_at` is written; `metric_observations`
  accumulate, which is what makes velocity computable later.
- **Velocity is deliberately not computed in the MVP.** With a single scan there is one snapshot
  per metric; a derivative over n=1 is noise dressed as insight. The time series is *recorded* so
  the derivative becomes available on the second run. vantage has exactly this gap (it stores
  `CompanyMetric` snapshots and never differentiates them); we record the gap rather than
  pretending otherwise.

### 6.4 Obscurity — an observable fact, not a score

Operator decision 3: obscurity is a separate axis, never folded into founder quality.

**It is not written to `scores`.** The TRACKER ruling is explicit that exactly one feature may
write a given axis and that `scores` has no `(subject, axis)` uniqueness, so two writers race
silently. 03 owns `founder_score`, 04 owns `founder` / `market` / `idea_vs_market`, 05 owns
`trust`. The radar writes **no axis at all** — consistent with §1 (02 computes no scores).

Instead, obscurity is derived deterministically in SQL from `metric_observations`, exposed as a
view for feature 09:

```
radar_candidates (view)
  founder_id, company_id, application_id,
  gh_followers, gh_notable_followers, hn_karma, hn_points, hn_comments,
  obscurity   numeric  -- 0..1, 1 = maximally undiscovered; NULL = unknown
  freshness   interval -- now() - first observed_at
  channel     text     -- 'hn_showhn' | 'github_graph'
```

**The formula, written out** (spec review: "monotone function of X and Y" is not a specification —
an implementer would have to invent it, and an invented formula is an unreviewed scoring decision
inside a feature whose §1 says it computes no scores):

```
followers_term = 1 − clamp(log10(1 + gh_followers) / 3, 0, 1)     -- 1000+ followers → 0
karma_term     = 1 − clamp(log10(1 + hn_karma)     / 4, 0, 1)     -- 10000+ karma   → 0
obscurity      = round((followers_term + karma_term) / 2, 4)
```

**Never 0-substitute a missing input.** This is the load-bearing rule: a founder with no
resolvable GitHub has no `gh_followers` observation, and substituting 0 would compute
`obscurity ≈ 1.0` — "maximally undiscovered" — floating them to the top of the feed. Missing data
would then *improve* a candidate's position, which is REQ-003 running backwards.

**Any-missing vs all-missing** (re-review caught the ambiguity, and it matters enormously):
`hn_karma` is always available — the HN handle always exists — while `gh_followers` resolves only
~36% of the time. Under an "any missing → NULL" reading the feature's headline column would be
blank for the majority of candidates. Ruling: **average over the observed terms only, and expose
what it was computed from.**

```
obscurity       = mean(observed terms)          -- 1 or 2 terms
obscurity_basis = text[]                        -- e.g. {hn_karma} or {gh_followers,hn_karma}
                = NULL only when NO term is observed
```

A single-term obscurity is honest (it says what it saw) and is not inflated by absence. Feature 09
renders `NULL` as "unknown", never as a high score, must not sort NULLs first, and should surface
`obscurity_basis` so a one-term value is visibly weaker than a two-term one.

**View mechanics, stated so the implementer does not have to choose:**
`metric_observations` accumulates one row per metric per scan by design (§6.3), so the view must
take the **latest observation per `(founder_id, metric)` by `observed_at`** and pivot those into
columns — a naive join would multiply rows and feed an arbitrary value into the formula.
`freshness` = `now() − min(raw_signals.observed_at)` scoped to that founder.

It is **not** an opinion about the founder — both inputs are raw public counts, explainable to a
judge in one sentence — and the feed shows it as its own column so the investor decides whether to
sort by it.

**Registry rows** — reconciled with what the view and the formula actually reference (spec review
found three drifts: `hn_karma` used but registered nowhere, `hn_num_comments` vs `hn_comments`, and
`site_last_modified` duplicating the already-seeded `site_updated`):

INSERT into `metric_kinds`: `gh_followers`, `gh_notable_followers`, `gh_forks`, `gh_dependents`,
**`hn_karma`**, `hn_comments`, `hn_author_replies`. **`site_updated` and `hn_points` are reused,
not duplicated** — both are already seeded with the same meaning.

The INSERT is safe with no smoke edit (04's 2026-07-19 ~04:07 change made registry assertions
presence-based rather than exact-count). **The VIEW, however, is DDL** and lands in
`db/schema.sql` — the file `TRACKER.md`'s 🔴 OPEN section records as jointly owned and uncommitted
by 03 and 07. 02 appends a `-- Feature 02:`-marked block matching their convention, announces it
in the Schema changelog, and **joins the open resolution rule: three features, one combined
commit, not two.**

`gh_notable_followers` is the follow-graph signal: of this account's followers, how many
themselves exceed a follower threshold. One GraphQL query
(`followers(first:50){nodes{login followers{totalCount}}}`), no curated seed list, no time
snapshots — the form that survives the 24-hour constraint (§10 decision 1).

## 7. Ethics layer — mechanics visible in the product

Not a slide. Four mechanisms in the pipeline, each cheap and each demonstrable.

1. **robots.txt is checked before any crawl, in a dedicated node.** `GET {origin}/robots.txt`,
   parse, and skip the URL if disallowed for `*`; the skip is recorded as an `events` row
   (`event_type='crawl_skipped_robots'`) so it is visible rather than silent. EDPB Guidelines
   03/2026 (07.07.2026) make this a **GDPR** matter, not merely a ToS one: robots.txt, ai.txt and
   CAPTCHAs are treated as indicators of the data subject's reasonable expectations and feed
   directly into the legitimate-interest balancing test. CNIL's 19.06.2025 checklist says the
   same. Showing the function is worth more than a paragraph claiming it.
2. **Opt-out is enforced at ingest, not only at display** — with one honest limit.
   Before writing anything, the pipeline checks `founders.opt_out_at IS NULL` for a matching
   identity and drops the candidate if set. **Opt-out and erasure are deliberately different
   operations:** opt-out sets `opt_out_at` and *keeps* the row as a suppression tombstone, which
   is what this check needs.

   Erasure (`purge_founder()`) hard-deletes the `founders` row, all `founder_identities` rows and
   all prior `events` for that entity, leaving one anonymised audit row with `payload='{}'` — by
   design, to avoid retaining PII. **Consequence, stated rather than hidden: after a true erasure
   the cron can re-discover the same Show HN post and re-ingest the same person.** The clean fix
   is a suppression record keyed by a salted hash of the identity value — no plaintext PII, but
   re-ingestion becomes checkable. That is **not built in this MVP**; it is recorded here and in
   §11 as a known limit, because a judge who follows the FK chain will find it, and claiming an
   enforcement the schema cannot deliver is worse than naming the gap.
3. **Data minimisation is enforced by the capture list, not by policy.** §3 fixes what is
   collected; age, photo, gender, marital status, precise location and all Art. 9 categories are
   absent from every query in this feature. `location` is normalised to country before storage.
4. **Source transparency comes free from the evidence ledger.** Every claim carries
   `evidence.source_url` and `evidence.raw_signal_id`, so "why does he score this" resolves to a
   clickable primary source. This is simultaneously the GDPR transparency answer and the rubric's
   Agentic Traceability stretch goal.

Honest boundary, stated in-product: for EU production this needs a documented legitimate-interest
assessment per EDPB 03/2026. The demo runs on freely accessible data with minimisation and
opt-out. We do not claim more.

**Not done, deliberately:** no fake accounts, no `li_at` cookie or authwall bypass, no CAPTCHA or
anti-bot circumvention, no login-gated scraping. hiQ v. LinkedIn is cited both ways in the pitch —
won on CFAA, lost on contract, and settled admitting possible CFAA liability specifically for fake
accounts.

### 7.1 External dependency validation (live, 2026-07-19, before build)

| Dependency | Result | Consequence for the build |
|---|---|---|
| HN Algolia `search_by_date` | HTTP 200, keyless, `nbHits=1380`, 1000-row page ceiling | tier 0 is safe; deeper paging needs time-slicing |
| HN Algolia `/items/{id}` | available | comment tree in one call, but median 0 comments (§2.1) |
| GitHub REST unauthenticated | `core limit=60 remaining=60`/h | demo scale fits; scan scale does not — capability-gated (§5.4) |
| GitHub GraphQL | requires auth absolutely | unavailable until a token exists; E3 degrades |
| Tavily `/extract` | 2 URLs → 1 credit; 1 success, 1 `failed_results` | documented degradation confirmed: a failed URL does not block a successful one |

**Personal-site crawl — three defects found by probing the real tier-1 fixture (`ayuhito`), all
of which would have shipped as silent no-ops:**

1. **GitHub's `blog` field carries no scheme.** The fixture holds `blog: 'ayuhito.com'`, not
   `https://ayuhito.com`. §4.1's "crawl seed = `github.blog`" is therefore not a URL. The seed
   must be scheme-normalised before use.
2. **`/map` returned zero URLs on live sites** (the sites themselves answer HTTP 200, and `/map`
   charged 0 credits). §3 treated `/map` → `/about` → `/blog` as *the* discovery path; on a
   small static personal site it discovers nothing. Tested on **both** sites in the fixture set
   (`ayuhito.com`, `rewindcup.com`) — zero results on each, so this is systematic for the site
   class we target, not a one-off. **Ruling: `/map` first; if it returns an empty list, fall
   back to extracting the ROOT page only.**
3. **Guessed conventional paths do not work and must not be attempted.** `/about` returned
   `404 page not found` and `/blog` `Failed to fetch url` on a site that plainly has neither.
   Guessing costs no credits (failures are not billed) but adds latency and pollutes
   `failed_results` with noise indistinguishable from real breakage.
4. **`repo.homepage` is not a personal-site seed.** The fixture's repo homepage is
   `https://pkg.go.dev/github.com/ayuhito/safehttp` — a package registry, not the founder's
   site. It is a valid **E4 liveness** target and nothing more; using it as the §4.1 third
   fallback for the site crawl would crawl pkg.go.dev.

The root extract, once reached, is genuinely productive: 305 characters containing
*"Hi, I'm Ayu. A Tokyo-based developer passionate about the open-source ecosystem and building
tools that prioritise improving the web"* — location and domain focus in one pass, which is X1
and X2 material.

Two further field observations that shape the crawl step:

- The successful extract returned **217 characters** — a thin landing page. Many Show HN products
  are a headline and a screenshot. Root-page extraction alone will not satisfy X1/X2, which is why
  `/map` to discover `/about` and `/blog` is a required step rather than an optimisation.
- The failing URL was a client-rendered SPA (`/#/` routing). This is the documented Tavily
  limitation, not a bug, and it must be classified as **"could not verify"**, never as
  "project is dead" — `data-sources.md` calls this out explicitly, and a false red flag on a
  founder is more costly than a missed signal.

### 7.2 n8n build constraints and cost ceiling

Three traps are already recorded in `TRACKER.md`'s Tooling changelog by features 03 and 04. This
feature hits all three, so they are named here rather than rediscovered at hour twenty.

1. **Fan-in requires an explicit `Merge` node** (TRACKER, 2026-07-19 ~05:05). Tier 2 fans out to
   GitHub and Tavily in parallel and reconverges — exactly the topology where wiring several
   branches into one plain node's input **executed only 1–2 of 4 branches while returning HTTP
   200**. Use `n8n-nodes-base.merge`, typeVersion 3.2, `mode: 'append'`, wiring branch *i* into
   input index *i*. (An IF/Switch reconverge, where only one branch is ever live, is fine as-is.)
2. **`SUPABASE_URL` drifts between the container and `infra/n8n/.env`** (TRACKER, ~05:00) — twice,
   live, from outside the owning terminal. Adopt 03's `SB_NORMALIZE` idiom in every Code node:
   `String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '')` before appending `/rest/v1/`.
   Correct under either convention, so the race stops mattering.
3. **Code nodes cannot `require()`** — the repo is not bind-mounted and `NODE_FUNCTION_ALLOW_EXTERNAL`
   is unset. §6.1 needs SHA-256, so it uses `globalThis.crypto.subtle.digest('SHA-256', …)`
   (async, no import), **not** `require('crypto')`. All node logic is self-contained CommonJS
   pasted verbatim behind a `// SOURCE OF TRUTH: lib/f02/<file>.js` header.

Standing rules: workflows prefixed `f02-`, exported to `n8n/workflows/`, secrets referenced only
via `$env.*` so exported JSON stays safe to commit.

**Tavily cost ceiling.** `/map` per candidate plus a batched `/extract` (5 URLs = 1 credit,
20 = 4) runs to roughly 200–400 credits per unbounded run against a 4000/month plan shared with
the operator's other pipelines — and `/usage` reports 0 due to aggregation lag, so an overrun is
invisible until it 429s mid-demo. Therefore: a hard per-run ceiling (`tavily_credit_budget`,
default 150) enforced in the workflow, with the running total accumulated from each response's
`usage.credits` and added to §6.2's `events` counters. It doubles as a demo metric.

## 8. Feed contract and stubs

- The radar writes `applications` rows with `kind='radar_activated'`, which are **deckless by
  definition** — feature 01's `applications_deck_required_for_inbound` CHECK already permits
  exactly this and no other track.
- Both tracks converge on one Screening funnel (SCOPE-006, brief §5 "Converge"). The radar creates
  no parallel funnel.
- Terminal state is **STUB-001**: a "suggested outreach" card with a draft message and a button
  that sends nothing. SCOPE-002/003 put real outreach out of scope in the sponsor's own words
  ("it's not like a sales outreaching tool"). Cold outreach, not cold investment.
- Channels **LinkedIn / X / ProductHunt / patents / accelerators** appear in feature 09's sidebar
  as honest stubs with a tooltip stating what each would add. GitHub and HN are the two that
  actually work. The research behind each stub is real (`internal/research/data-sources.md`
  documents why each was declined), so the tooltips are informative rather than decorative.

## 9. Borrow list (decided, licences verified)

All nine clones carry a LICENSE; Thesis-Agent is not cloned and is ideas-only.

1. `vantage/vantage/services/text.py` — port verbatim (MIT, stdlib only): `normalize_name`,
   `canonical_domain` + `_GENERIC_HOSTS`, `content_hash`, `similarity`, `embed`/`cosine`
   (the no-vector-DB semantic layer).
2. `vantage/services/entity_resolution.py` cascade — reimplement as ordered Supabase lookups;
   keep `resolver_method` + `confidence` + `evidence` columns for provenance.
3. VCI `signal_scorer.py` — *shape* only (exponential saturation + OR-threshold band),
   re-weighted for cold-start. **Do not borrow its signal vocabulary** (§0).
4. vcbrain partial unique index `WHERE domain IS NOT NULL` (domainless founders must not
   collide) + `source_channel`/`source_detail` provenance pair.
5. InGa composite id `<source>::<sourceId>` and raw-staging-before-resolution.
6. vantage `JobRun` counters — near-zero cost observability.
7. company-research-agent's first-party bypass: the founder's own site/README always survives
   the relevance filter regardless of score — decisive for cold-start, where third-party
   coverage is by definition near zero.

## 10. Operator decisions on record (2026-07-19)

1. **Funnel head: hybrid.** Show HN is the head; the GitHub follow-graph is an *enrichment
   signal*, not a discovery head. Re-verified: NotebookLM classifies follow-graph convergence as
   an anti-gaming **defence** (against star farming and upvote manipulation — "track *who*
   follows, not *how many*"), which is exactly the role it holds here. Removes the timestamp
   risk: GitHub exposes no follow timestamps, so convergence-over-30-days is not demonstrable in
   24h, whereas follower *quality at low follower count* is one query.
2. **Filter: fresh window, almost no threshold** — last ~14 days, `points >= 2`. Overrides
   `data-sources.md`'s `points>30` / 6 months, which contradicts FACT-003 ("only an idea and
   weeks of work, no traction") and selects the already-visible.
3. **Obscurity is a separate axis**, shown as its own column in the feed, never folded into
   founder quality (REQ-002 forbids collapsing). Corroborated by Exa (working scouting systems
   explicitly "penalise visibility") and by NotebookLM's "backward-similar investing" bias.
4. Sections 1, 2, 3 and revised 4 approved.

## 11. Open items and blockers

- **`GITHUB_TOKEN` absent from `.env`** (present: `OPENAI_API_KEY`, `TAVILY_API_KEY`,
  `ELEVENLABS_API_KEY`). GraphQL does not work at all without a token; REST drops to 60 req/h.
  Needs a classic PAT with **no scopes ticked** (public-only) → 5000 req/h. Operator action.
  **Downgraded from blocker to degradation** (autonomous decision, operator asleep): tier 0/1 is
  keyless by construction, **REST works unauthenticated at 60 req/h** (verified live), and every
  GitHub call sits behind a capability check that emits `missing` claims rather than throwing.
  With no token the radar reaches **0.64375–0.70375** instead of 0.70375 (§5.4) — one
  criterion (E3) degrades, nothing breaks. Adding the token later is one environment variable and
  changes no code. Confirmed absent from `.env`, `infra/n8n/.env` and `infra/supabase/.env`.
- ~~Feature 03's scoring input contract~~ — **RESOLVED**: 03 closed with `status: complete`;
  §5 above is written against its §3 rubric and §4.7 vocabulary.
- The **radar→inbound conversion seam is unspecified anywhere**: when a `radar_activated`
  application converts (the founder actually applies), does `kind` mutate and a deck get added,
  or is a second `applications` row created? `01/design.md` says "re-application = new row" but
  does not cover this case. Raise at 08 or here on resume.
- ~~`artifact_links jsonb` has no writer, no seed and no agreed key shape~~ — **RESOLVED in
  §5.5(b)**: the radar is the first writer and the key shape is fixed there. Feature 08 reads it
  for intake pre-fill.
- GitHub PAT scope confirmed as public-only classic token (was an open question in README).
- Show HN guidelines are helpful here: "Don't post landing pages or fundraisers", the project
  must be something "you've worked on personally and which you're around to discuss". Authorship
  is a platform norm backed by moderation, which reduces (but does not remove) the need for our
  own "did they post their own work" check.
