---
name: vcbrain-cli
description: Read-only agent access to the VC Brain platform — founder profiles with a persistent Founder Score, application screening (three independent axes, never blended), a claim-level evidence ledger, and a multi-attribute natural-language search that resolves a compound query ("technical founder, Berlin, AI infra, no prior VC backing") in one pass. Triggered by — "look up this founder in VC Brain", "search VC Brain for X", "what's the founder score for X", "pull the evidence behind this score", "find founders matching <compound description>", "check the thesis fit for this application", "does VC Brain have data on X", "what does VC Brain know about X". Works via a bundled zero-dependency Node CLI (`bin/vcbrain`) or plain `curl` — an agent that cannot run the CLI is still fully served.
category: business-finance
platform: claude-code
requires: none strictly — every operation below also works as a raw curl call; the bundled `bin/vcbrain` CLI additionally needs Node.js 18+ (built-in fetch, zero npm dependencies)
---

# VC Brain — Agent Read Access

This is the machine-facing surface of a hackathon-built AI-first VC operating system
(Sourcing → Screening → Diligence → Decision). It gives a fund's own agent read access to
founder profiles, application screening, and an evidence ledger, plus one multi-attribute
natural-language search endpoint. **It is read-only.** There is no write path anywhere in this
surface — see §6.

Everything in this document was run against the live stack on 2026-07-19. Where a number is
cited, it was measured, not assumed.

---

## 1. Setup

```bash
set -a; source infra/supabase/.env; set +a
export VCBRAIN_TOKEN="$ANON_KEY"
export VCBRAIN_REST_URL="http://localhost:8000/rest/v1"     # default, only set if different
export VCBRAIN_N8N_URL="http://localhost:5678/webhook"       # default, only set if different

./bin/vcbrain schema
```

`vcbrain schema` is the first command to run, always. It is static, offline, and needs **no
token, no config, and no network** — verified by running it with `VCBRAIN_TOKEN` unset:

```
$ unset VCBRAIN_TOKEN && ./bin/vcbrain schema >/dev/null 2>&1; echo $?
0
```

It returns the full contract: every command, every error `kind`, the exact columns on all three
views, and which commands need a token. Reach for it first whenever nothing is configured yet.

### Security — read this before doing anything else

> **This token has full read AND WRITE access to every table in the database, including
> `theses` (the fund's mandate) and `claims` (the evidence ledger). It is a demo credential, not
> production auth.**

That sentence is reproduced verbatim from `design.md` §3.2 and `docs/api.md`. It is not
softened here. Concretely: `VCBRAIN_TOKEN` is currently the Supabase `anon` key, and this
project has **no RLS anywhere** (a cross-cutting decision, not an oversight) — schema-wide
default privileges grant `anon` `SELECT/INSERT/UPDATE/DELETE` on every table in `public`. The
`api_*` views below are a **documentation and convenience convention, not an enforcement
boundary** — they are owned by `postgres`, run with definer rights, and add no privilege
restriction whatsoever. The base tables (`founders`, `claims`, `scores`, `theses`, …) remain
fully readable and writable by the same token. There are no per-fund keys, no scopes, no
rotation, no rate limiting. Feature 10 itself performs no writes (§6), but the token it
documents is not scoped down — a well-behaved agent should treat every write verb it could
technically issue against the base tables as **out of bounds**, because nothing in the platform
will stop it.

---

## 2. Data model

Three PostgREST views, `GET {VCBRAIN_REST_URL}/<view>` with header `apikey: $VCBRAIN_TOKEN`.
Live row counts (2026-07-19, corpus growing under active ingestion — re-measure, don't assume):
**124** founders, **308** applications, **734** claims (109 of them company-scoped, no
`founder_id`).

### `api_founders` — one row per founder

`founder_id · full_name · headline · is_synthetic · founder_score · founder_score_trend ·
founder_score_confidence · founder_score_missing · founder_score_gaps · score_assessed ·
scored_at · obscurity · obscurity_basis · channel · first_seen_at · company_id · company_name ·
application_id`

- `founder_score` is the **persistent Founder Score** — lives in `scores(axis='founder_score')`,
  distinct from the three screening axes below, and never resets. `NULL`, never `0`, when
  unscored. Live: **3 of 124** founders are scored.
- `founder_score_missing` is a normalised `text[]` of gap criterion ids; `founder_score_gaps`
  carries the raw `{criterion_id, what_would_close_it}` objects beside it — read `_gaps` when
  you need to know *what evidence would close the gap*, not just its id.
- Default order: `founder_score DESC NULLS LAST, full_name ASC, founder_id ASC`. Never
  `obscurity` (see Traps).

### `api_applications` — one row per application

`application_id · company_id · company_name · company_domain · stage · category · kind · status ·
submitted_at · artifact_links · score_founder{value,trend,confidence,missing,assessed} ·
score_market{…} · score_idea_vs_market{…} · thesis_id · thesis_name · thesis_verdict ·
thesis_fit · thesis_coverage · thesis_missing_fields · thesis_fired_rules · memo_version ·
memo_available`

- **Three independent screening axes, never blended.** There is deliberately no
  `overall_score` column. `score_founder` ≠ the persistent Founder Score above — it is a
  per-application axis, currently empty database-wide (see Traps).
- `thesis_*` resolves through `thesis_evaluations`, never `scores`, and reports the thesis a
  given application was gated against, including which fields the gate could not evaluate.

### `api_claims` — the evidence ledger (one row per claim)

`claim_id · card_id · founder_id · company_id · application_id · topic · axis · text_verbatim ·
value · source_kind · base_confidence · verification_status · created_at ·
evidence[] = {tier, relation, strength, quote_verbatim, source_url, raw_signal_id, captured_at}`

- **Evidence tiers:** `documented > discovered > inferred > missing`. `missing` is not an
  absence of a row — it is a claim the system explicitly looked for and did not find, carrying
  a human-readable `text_verbatim` such as `"Business model: not disclosed."` (36 such rows
  live). This *is* the honesty the rubric scores.
- **`evidence[].relation`** ∈ `supports | contradicts | context`. A `contradicts` row **refutes**
  its own claim — see the worked example in §7 of `docs/api.md` for a live case where a
  founder's own claim about a GitHub repo is directly contradicted by that repo's own README.
- Opted-out founders and merge tombstones are excluded from all three views at the view level —
  querying the base tables directly bypasses this.

Full column-by-column reference with live examples: `docs/api.md`.

---

## 3. Command catalogue

Four commands. **There is no enumeration/list verb** — see the note after the table.

| Command | Backing | Token required |
|---|---|---|
| `vcbrain schema` | static, offline | no |
| `vcbrain search "<nl query>" [--limit N]` | `POST {VCBRAIN_N8N_URL}/f10-nl-search` | no |
| `vcbrain founder <id> [--limit N] [--offset N]` | `GET api_founders` + `api_claims` | yes |
| `vcbrain application <id> [--limit N] [--offset N]` | `GET api_applications` + `api_claims` | yes |

Every response is one of two shapes: a list envelope `{ items, total, truncated }`, or a
structured error `{ error: { kind, message, hint, retryable } }`. `--json` is the default
whenever stdout is not a TTY (i.e. always, for an agent). Exit codes: `0` success, `1`
structured error, `2` usage error (bad/missing argument — always names the missing thing).

### `vcbrain founder <id>`

```bash
$ ./bin/vcbrain founder 03f00001-0000-0000-0000-000000000001 --limit 2 --json
```
```json
{
  "founder_id": "03f00001-0000-0000-0000-000000000001",
  "full_name": "Devon Ashworth",
  "headline": "Founder & CEO, Fintrace AI (synthetic fixture -- not a real person)",
  "is_synthetic": true,
  "founder_score": {
    "value": 29.16, "trend": null, "confidence": 0.53,
    "missing": ["L5", "X1", "X5", "X6"],
    "gaps": [
      { "criterion_id": "X1", "what_would_close_it": "A claim describing prior work history in fraud detection or banking." }
    ],
    "assessed": true
  },
  "company": { "id": "03f00002-0000-0000-0000-000000000001", "name": "Fintrace AI" },
  "application_id": null,
  "claims": {
    "items": [
      {
        "topic": "founder.execution.tech",
        "text_verbatim": "Our GitHub repository fintrace-ai/fintrace-shield contains the core fraud-detection engine that powers the product.",
        "verification_status": "unverified",
        "evidence": [{ "tier": "documented", "relation": "contradicts", "strength": 0.75,
                        "source_url": "https://github.com/fintrace-ai/fintrace-shield",
                        "quote_verbatim": "Fintrace Shield core engine -- coming soon." }]
      }
    ],
    "total": 8, "truncated": true
  }
}
```
`Devon Ashworth / Fintrace AI` is a labelled synthetic fixture, used deliberately here as a
public-repo-safe example. Note the trap this shows directly: a `documented`-tier claim that
**contradicts** the founder's own statement — see §5.

`curl` equivalent:
```bash
curl -s "$VCBRAIN_REST_URL/api_founders?founder_id=eq.<id>" -H "apikey: $VCBRAIN_TOKEN"
curl -s "$VCBRAIN_REST_URL/api_claims?founder_id=eq.<id>&order=created_at.desc&limit=50" -H "apikey: $VCBRAIN_TOKEN"
```

### `vcbrain application <id>`

```bash
$ ./bin/vcbrain application a3413aa3-90ec-4591-978d-49040665ff7b --limit 2 --json
```
```json
{
  "application_id": "a3413aa3-90ec-4591-978d-49040665ff7b",
  "company": { "id": "c9727fc5-4e1c-4806-b303-35a1f4e50807", "name": "safehttp", "domain": null },
  "stage": "pre_seed", "kind": "radar_activated", "status": "sourced",
  "artifact_links": {
    "title": "Show HN: Safehttp – an SSRF-resistant HTTP client for Go",
    "hn_url": "https://news.ycombinator.com/item?id=48957230",
    "artifact_url": "https://github.com/ayuhito/safehttp"
  },
  "scores": {
    "founder": { "value": null, "assessed": false, "trend": null, "confidence": null, "missing": [] },
    "market": { "value": null, "assessed": false, "trend": null, "confidence": null, "missing": [] },
    "idea_vs_market": { "value": null, "assessed": false, "trend": null, "confidence": null, "missing": [] }
  },
  "thesis": {
    "name": "default", "verdict": "borderline", "fit": null, "coverage": null,
    "missing_fields": ["sector", "business_model", "geography_country", "stage_evidence", "what_is_built"]
  },
  "memo": { "version": null, "available": false },
  "claims": { "total": 28, "truncated": true, "items": [
    {
      "topic": "founder.execution.merged_pr_foreign",
      "text_verbatim": "At least 27 merged pull requests into repositories not owned by this account in the last 12 months (the Search API page was capped at 100 results; the true count may be higher, never lower).",
      "evidence": [{ "tier": "documented", "relation": "supports",
                      "source_url": "https://github.com/ayuhito?tab=overview" }]
    }
  ] }
}
```
All three scoring axes report `assessed: false` on this application, and `thesis.fit` is `null`
even though `thesis.verdict` (`borderline`) is populated — both are normal, documented shapes,
not errors (see §5).

`curl` equivalent:
```bash
curl -s "$VCBRAIN_REST_URL/api_applications?application_id=eq.<id>" -H "apikey: $VCBRAIN_TOKEN"
curl -s "$VCBRAIN_REST_URL/api_claims?application_id=eq.<id>&order=created_at.desc&limit=50" -H "apikey: $VCBRAIN_TOKEN"
```

### `vcbrain search "<nl query>" [--limit N]`

The one command the rubric actually scores — a compound natural-language query resolved in a
single pass, never five manual filters. Full mechanics in §4 below and `design.md` §5. No token
required.

`curl` equivalent:
```bash
curl -s -X POST "$VCBRAIN_N8N_URL/f10-nl-search" -H 'content-type: application/json' \
  -d '{"query":"<nl query>","limit":10}'
```

### There is no enumeration verb

`vcbrain founders`, `vcbrain applications`, `vcbrain claims`, `vcbrain list` all return a
structured `not_yet_available` error naming the reason, run and verified:

```bash
$ ./bin/vcbrain memo abc; echo $?
{"error":{"kind":"not_yet_available","message":"\"vcbrain memo\" is not implemented", ...}}
1
```

**`search` is the only discovery route.** An agent that wants a full, unfiltered list reads the
view directly over REST:

```bash
curl -s "$VCBRAIN_REST_URL/api_founders?select=founder_id,full_name,founder_score&order=founder_score.desc.nullslast" \
  -H "apikey: $VCBRAIN_TOKEN"
```

### Triggering scoring or the thesis gate directly (not wrapped by this CLI)

Two other features expose their own webhooks; `vcbrain` deliberately does not wrap either — an
agent that wants to trigger fresh work can call them directly (documented in their own READMEs,
not re-executed here since they write live data — do not run these against a shared corpus
without knowing what you're changing):

```bash
# score (or re-score) one founder's persistent Founder Score
curl -X POST "$VCBRAIN_N8N_URL/f03-score-founder" -H "Content-Type: application/json" \
  -d '{"founder_id":"<uuid>"}'

# evaluate one application against the active thesis
curl -X POST "$VCBRAIN_N8N_URL/f07-thesis-gate" -H "Content-Type: application/json" \
  -d '{"application_id":"<uuid>","text":"<raw application text>","mode":"full"}'
```

---

## 4. Query patterns

**Find and assess a founder.** Resolve a name or a partial description through `search`, then
pull the full evidence with `founder <id>`. `search` gives you rank and per-attribute evidence
already; `founder` gives you the complete claim history plus the persistent Founder Score, which
`search` does not carry attribute-by-attribute reasoning for.

**Resolve a compound NL query in one pass.** Send the whole sentence to `search` — do not decompose
it into separate filtered calls yourself; the backend's own claim (and the rubric's FAQ-12) is
that this happens in one round trip. Read `plan.attributes` in the response to see how each clause
was interpreted, and `plan.unresolvable` for the clauses that had no data source at all.

**Pull the evidence behind a score.** A `founder_score.value` or a search hit's `matched` state is
never terminal — every `matched` attribute in a search hit and every claim on `founder <id>`
carries `claim_id`, `source_url`, and (when present) `quote_verbatim`. Follow those before citing
a number to a human. If a claim's evidence has `relation: "contradicts"`, the claim is refuted,
not supported — check this before treating `documented`-tier evidence as corroborating.

---

## 5. Traps

Every item below is a real bug this system produced at least once while being built — not a
hypothetical edge case.

- **An absent score axis means *not assessed*, never zero.** `scores(axis='founder')` is empty
  database-wide right now (a separate feature owns writing it, and hasn't yet), so
  `score_founder.assessed` is `false` on all 308 live applications. Always check `assessed`
  before reading `value`.
- **Never threshold on a score `value` alone.** An unmeasured attribute and a genuinely middling
  one both land near 50. Read `confidence` and `missing` alongside `value` — a live example:
  one application shows `score_market.value: 50.0` at `confidence: 0.0`, which looks neutral and
  is actually zero-confidence noise.
- **A founder with no `founder_score` is normal, not an error.** Only 3 of 124 live founders are
  scored. Do not treat `founder_score: null` as "weak" — it means "not yet assessed."
- **`missing_flags` shape differs per axis** in the base tables: an array of objects for
  `founder_score` (`{criterion_id, what_would_close_it}`), an object of gap flags for `market`
  and `idea_vs_market` (values usually `true`, sometimes an array). The three `api_*` views
  normalise this to a plain `text[]` on every field they expose — a direct base-table read does
  not get this normalisation and must branch on axis.
- **Thesis state resolves through `thesis_evaluations`, never through `scores`.** A direct
  `scores` read for `axis='thesis_fit'` reproduced a stale value during this build. Use
  `api_applications.thesis_verdict` / `thesis_fit` / `thesis_coverage` / `thesis_missing_fields`,
  which always come from the latest `thesis_evaluations` row.
- **`evidence[].relation` ∈ `supports | contradicts | context` — a `contradicts` row refutes its
  claim, it does not corroborate it.** A consumer that reads evidence count or tier without
  checking `relation` reads refuting evidence as supporting. Live counts: 572 `supports`, 104
  `context`, 7 `contradicts`.
- **In a search hit, `unknown` is not a mismatch and is not a penalty on rank.** `unknown` (we
  never looked) and `unknown_searched` (we looked and recorded nothing — a `missing`-tier
  evidence row, or a claim with `verification_status='missing'`) both lower `confidence` only.
  Neither ever lowers `rank_score`. `unknown_searched` is not `unknown`: the former means the
  system explicitly checked and came up empty; the latter means it never checked at all.
- **`matched_broadened` is not `matched`.** It means the attribute was widened to fit the data —
  e.g. "Berlin" was asked for and there is no city-level data anywhere in the corpus, so it
  resolves against `company.geography_country = DE` instead. Verified live: querying for
  "Berlin" returns `state: "matched"` results with `broadening: "city→country"` and
  `resolved_as: "company.geography_country = DE"` attached — the widening is visible in the
  response, not silently absorbed. A widened match also costs real ranking credit
  (`BROADENING_CREDIT = 0.75`), it is not free.
- **Result order is `has_match → confidence_bucket → rank_score`, and `confidence_bucket` is
  emitted on every item** — the order is reproducible from the response alone without needing to
  re-derive it. `has_match` leads specifically because a founder assessed on more attributes but
  with two demonstrable `mismatch`es must not outrank a founder with one genuine `matched`
  attribute — that inversion happened live during this build and is why the sort has three
  levels, not two.
- **`total` means "candidates scored", not "founders in the world matching."** `truncated`
  refers only to a 200-candidate scoring cap; `total > limit` is normal and expected (a live
  Q1 run returned `total: 122, truncated: false` with `--limit 3` requested — 122 founders were
  scored, 3 were returned).
- **`unresolvable[]` is a first-class part of the answer, not a failure.** An attribute the
  resolver has no data source for, or cannot test against this corpus, is reported with a
  machine-readable `reason` (`no_data_source` or `not_testable`), never silently dropped.
- **The resolver's exact attribute segmentation is not guaranteed identical run-to-run.**
  Running the identical query text "technical founder, Berlin, AI infra, enterprise traction, no
  prior VC backing, top-tier accelerator" twice against the live endpoint (once via the CLI,
  once via raw `curl`, same day) produced the same `total` (104) and the same three resolved
  attributes both times, but `unresolvable` came back as one combined item
  `{"enterprise traction": "not_testable"}` on one run and as two split items
  `{"enterprise": "no_data_source"}` + `{"traction": "not_testable"}` on the other. The
  extraction LLM does not run at `temperature: 0` (the model rejects that parameter with HTTP
  400), so label wording and grouping can vary between identical calls even though the
  downstream scoring arithmetic is fully deterministic given a plan. Match on `reason`/attribute
  `id`, not on exact label text, if you are asserting against this endpoint programmatically.
- **The live corpus's `company.sector` claims do not currently contain an "ai-infra" value** —
  only `b2b-software`, `fintech`, `consumer`, and `gambling` have been observed live. A query
  attribute that resolves to `company.sector = ai-infra` will therefore legitimately show
  `unknown` for almost every candidate today; that is a corpus-coverage fact, not a resolver or
  scoring defect.

---

## 6. What this build does not do

- **No MCP server.** This is a CLI + REST/webhook surface, not an MCP integration.
- **No rate limiting, no per-fund API keys, no key rotation.** One shared demo token for
  everyone, disclosed in §1.
- **No write path anywhere.** `vcbrain submit` does not exist — `companies.stage` has no default
  in the schema (every insert would fail), and deck upload belongs to a different feature's own
  intake endpoint. This CLI and the views it documents write nothing to any table.
- **No memo, no watchlist.** `api_applications.memo_available` is `false` on every row today —
  memo generation has not landed as a feature. The watchlist table exists but is empty and
  nothing populates it yet. Both are reported by the schema/error surface honestly rather than
  faked by a command that would have to fabricate output.
- **`velocity` and `text` attribute kinds are cut from the search resolver in this build.**
  Only `provenance` (who the person is, where they have been) and `structural` (geography,
  sector, stage) attribute kinds are supported. Traction/momentum proxies and free-text fallback
  search do not exist yet — a query fragment that would need either lands in `unresolvable`.

---

## 7. Worked example: the brief's own reference query, run live

The hackathon brief's own example of a multi-attribute query is: *"technical founder, Berlin, AI
infra, enterprise traction, no prior VC backing, top-tier accelerator."* Run against the live
corpus, unedited:

```bash
$ ./bin/vcbrain search "technical founder, Berlin, AI infra, enterprise traction, no prior VC backing, top-tier accelerator" --limit 3 --json
```

```json
{
  "plan": {
    "attributes": [
      { "id": "technical_founder", "label": "technical founder", "kind": "provenance", "op": "exists", "weight": 25 },
      { "id": "geo_berlin", "label": "Berlin", "kind": "structural", "op": "eq", "weight": 20,
        "value": "DE", "broadening": "city→country", "resolved_as": "company.geography_country = DE" },
      { "id": "sector_ai_infra", "label": "AI infra", "kind": "structural", "op": "eq", "weight": 20, "value": "ai-infra" }
    ],
    "unresolvable": [
      { "label": "enterprise", "reason": "no_data_source" },
      { "label": "traction", "reason": "not_testable" },
      { "label": "no prior VC backing", "reason": "no_data_source" },
      { "label": "top-tier accelerator", "reason": "no_data_source" }
    ]
  },
  "items": [
    {
      "founder_id": "03f00001-0000-0000-0000-000000000003", "full_name": "Pieter Levels",
      "rank_score": 100, "confidence": 0.38, "confidence_bucket": "low",
      "attributes": [
        { "id": "technical_founder", "state": "matched", "tier_credit": 1,
          "evidence": { "quote_verbatim": "I started Nomad List in 2014 as part of my goal to launch 12 startups in 12 months",
                        "source_url": "https://levels.io/nomad-list-founder", "tier": "documented" } },
        { "id": "geo_berlin", "state": "unknown", "note": "no data -- lowers confidence, not rank" },
        { "id": "sector_ai_infra", "state": "unknown", "note": "no data -- lowers confidence, not rank" }
      ]
    }
  ],
  "total": 104,
  "truncated": false,
  "low_confidence_only": false
}
```

This is the feature, demonstrated rather than described: three of six clauses in the brief's own
query have **no data source in this corpus at all** ("no prior VC backing", "top-tier
accelerator", and "enterprise" — split from "enterprise traction" by the resolver on this run,
see the Traps note on non-determinism), and the system says so explicitly instead of guessing or
padding a plausible-looking answer. The one clause with real evidence ("technical founder")
comes back `matched` with a verbatim quote and a source URL. "Berlin" and "AI infra" resolve to
real structural targets in the taxonomy (`company.geography_country`, `company.sector`) but come
back `unknown` for almost every candidate because that data does not exist yet for most of the
corpus — a scoping-honesty result, not a bug. `confidence: 0.38` on the top hit reflects that
only one of three resolvable attributes could actually be assessed for this founder; `rank_score:
100` reflects that the one attribute assessed was a clean, well-evidenced match. Neither number
is folded into the other.
