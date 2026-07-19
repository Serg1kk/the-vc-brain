# Feature 10 — done. Contracts for downstream consumers

> QA gate **PASSED** (3 rounds, `qa-report-10.md`). 2026-07-19.
> Read this before consuming anything feature 10 produces — especially **feature 09**
> (investor dashboard), which reads `api_founders` and `radar_candidates` directly.

## What exists

| Artefact | Path | Notes |
|---|---|---|
| Three read views | `db/schema.sql` (`-- Feature 10:`) | `api_founders`, `api_applications`, `api_claims` — live over PostgREST at `/rest/v1/` |
| NL-search workflow | `n8n/workflows/f10-nl-search.json` | id `x7qXnx2asXrGB0ye`, active, `POST /webhook/f10-nl-search` |
| Scorer library | `lib/f10/{constants,plan,score}.js` | 99 unit tests, pure, zero deps |
| CLI | `bin/vcbrain` | `schema`, `search`, `founder <id>`, `application <id>` |
| Claude skill | `skills/vcbrain-cli/SKILL.md` | submission artefact |
| REST reference | `docs/api.md` | every example executed before being written |

**Feature 10 writes no data.** It is a read surface. The only DDL it owns is the three views,
plus two fixes to `radar_candidates` (a feature 02 object — see below).

## Contracts you must not get wrong

Each of these is a defect that actually occurred here. They are enforced inside the views where
possible, so the documented path cannot violate them — but reading base tables bypasses that.

1. **Three screening axes never collapse.** `api_applications` has three separate objects and
   deliberately **no `overall_score`**. Do not compute one.
2. **An absent axis means "not assessed", never zero** — `assessed: false`.
   `scores(axis='founder')` is empty database-wide (04 owns it and never wrote a row), so
   `score_founder.assessed` is `false` on every application. **This will hit 06 and 09 too.**
3. **Never threshold on a score `value` alone.** Unmeasured and middling both land near 50; read
   `confidence` and `missing` alongside it.
4. **No `founder_score` is normal, not an error** — a small minority of founders are scored.
5. **`missing_flags` shape differs per axis in the base tables** (array of objects for
   `founder_score` carrying `{criterion_id, what_would_close_it}`; objects of gap flags for the
   others). The views normalise all of them to a plain string array; `api_founders.founder_score_gaps`
   preserves the rich form, and `what_would_close_it` is the most investor-useful field in it.
6. **Thesis state resolves through `thesis_evaluations`, never `scores`** — a direct `scores` read
   returns a stale value.
7. **`evidence[].relation` ∈ `supports | contradicts | context`.** A `contradicts` row *refutes*
   its claim. Ignoring `relation` reads refuting evidence as supporting — this was a live defect.
8. **`quote_verbatim` is a real source quote or `null`.** It never contains our own claim text;
   `claim_text` is the separate field for that, and `quote_source` says which you have. Roughly a
   third of supporting evidence has no real quote — that absence is honest, not a gap to fill.
9. **Opted-out founders and merge tombstones are excluded by all three views.** Exclusion is
   **company-scoped** for applications: an application is excluded when every founder reachable
   from its company has opted out, and retained when the company has no linked founder at all.

## Search response semantics (`f10-nl-search`)

- Result order is `has_match → confidence_bucket → rank_score → founder_id`, and
  `confidence_bucket` is emitted on every item so the order is reproducible from the response alone.
- `rank_score` is match rate **among what was assessed**; `confidence` is how much of the query
  could be assessed; `evidence_quality` is source strength. **Three separate numbers, never fused.**
- Per-attribute states: `matched` · `matched_broadened` (the attribute was widened to fit the data,
  e.g. a city asked for and a country matched) · `mismatch` · `unknown` (we never looked) ·
  `unknown_searched` (we looked and found nothing). `unknown` never lowers `rank_score`.
- `unresolvable[]` is a first-class answer with a machine-readable `reason`. A negative attribute
  whose subject matter the corpus never records is reported there rather than satisfied — otherwise
  every founder would receive a fabricated match on an unchecked fact.
- `total` = candidates scored, not founders in the world. `truncated` refers to the 200-candidate
  cap; `total > limit` is normal.
- The endpoint never returns an unexplained empty list.

## Two fixes made to feature 02's `radar_candidates` (it is closed, no live terminal)

Both are marked in `db/schema.sql` and announced in `docs/backlog/TRACKER.md`.

1. **Log-domain guard.** The view computed `log(1 + hn_karma)` with no floor, and one founder has a
   genuine `hn_karma = -2` (HN karma legitimately goes negative). Any query that materialised
   `obscurity` aborted entirely. `count(*)` alone survived because the planner prunes the column —
   which is why 02's own smoke tests never caught it.
2. **Negative karma is UNOBSERVED**, aligning SQL with `lib/f02/obscurity.js`, which had disagreed.
   The term is excluded from the mean and `hn_karma` is dropped from `obscurity_basis`. Rationale:
   the metric maps *positive visibility* onto obscurity, so a negative value is outside its domain —
   it says the person was seen and poorly received, which is a fact about reception, not discovery.
   Calling them "maximally obscure" would assert nobody found them.
3. **`radar_candidates` deduplicated.** `cards` has no unique constraint on
   `(founder_id, card_type)`, and the view returned two rows for a founder with two founder cards,
   blending different `company_id`/`application_id`. Now `DISTINCT ON (founder_id)` with a
   deterministic tiebreak. **Note for 09:** `freshness` is exposed only on `radar_candidates`, not
   on `api_founders` (which carries `first_seen_at` instead).

## Traps for whoever touches this next

- **The pasted-copy drift trap.** `lib/f10/{constants,plan,score}.js` are pasted verbatim into n8n
  Code nodes; n8n cannot `require()` from this repo. They drift **silently** — this fired twice in
  one afternoon, and both times the unit tests were green while the live endpoint served stale
  logic. "The descriptor contract did not change" does **not** imply "no re-paste needed": any edit
  to any of the three files requires re-running `n8n/build-f10-workflow.py`, re-exporting, and
  re-running both acceptance queries. Cheapest detector: grep the *live* workflow (via the n8n API,
  not the tracked file) for a symbol only present in the current library.
- **n8n returns `200` with an empty array on a bad API key**, not `401` — indistinguishable from
  "every workflow was deleted". `N8N_API_KEY` lives in `infra/n8n/.env`, not `infra/supabase/.env`.
- **Never key identity on `companies.name`** — there are 4 distinct companies named `safehttp` and 3
  named `puffinsoft`. A name-scoped verification query is meaningless. (This is 02's documented
  gotcha; it still caught me in my own repro.)
- **A green test proves nothing until you have watched it fail.** The original opt-out assertion
  passed for hours while testing a code path no real founder takes, because its fixture hand-inserted
  a `founder_company` row. Every regression lock in this feature has now been verified by reverting
  the fix and confirming the test fails loudly.
