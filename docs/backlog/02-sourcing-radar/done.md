# Feature 02 · Sourcing Radar — DONE

```
status: complete
completed_at: 2026-07-19 ~08:30 Minsk
qa_gate: PASSED (round 3; rounds 1 and 2 FAILED — see qa-report-02.md, history kept)
commits: edee0df (DB restore, 02+03+07) · 0ca3a87 (feature) · fa07521 (publication gate) · 36cd27b (QA round-2 fixes)
tests: 265 (node --test lib/f02/*.test.js)
n8n: f02-radar-scan, id qmViGGDMmEEN3XWH, 22 nodes, deployed
```

If you are a downstream feature (**08 intake**, **11 demo data**), read this whole page before you
start. `status` is `complete`, but there is one carried risk and several contracts that bind you.

---

## What the radar produces

Full normative shape: `design.md` §5. Summary:

- **`founders`** — one per candidate, **always**, anchored on
  `founder_identities(kind='hn', value=<handle>)`. `full_name` holds the HN handle until a better
  name resolves. "Unresolved" in §4.1 means no *cross-platform* link, **never** the absence of a
  person.
- **`companies` + `applications`** (`kind='radar_activated'`, deckless by definition) created
  *before* the raw write. **`applications` is deduplicated by `artifact_links.hn_item_id`**, and the
  company is resolved *through* the application — see the carried contract below.
- **`cards`** — one per founder, `card_type='founder'`, `founder_id` always set. 03 reads through
  this join; a card without `founder_id` makes every claim invisible to scoring.
- **`claims` + `evidence`** — nine topic slugs under `founder.execution.*` / `.expertise.*` /
  `.leadership.*` (design §5.1). **Every claim carries ≥1 evidence row with `raw_signal_id`
  populated.** Verified live: 225 claims, 0 without evidence, all 9 slugs in use.
- **`metric_observations`** — `gh_followers`, `gh_forks`, `hn_karma`, `hn_comments`,
  `hn_author_replies`. Founder-scoped; `company_id` deliberately NULL.
- **`radar_candidates`** (VIEW) — feed-facing: obscurity, `obscurity_basis`, freshness, channel.

### ⚠️ Four things that will bite you if you assume otherwise

1. **`artifact_links` has no `hn_author` key.** The shape is
   `{source, hn_item_id, hn_url, title, story_text, artifact_url, artifact_kind, repo:{owner,name}, homepage}`.
   If feature 08 needs the founder for pre-fill, join through the application's company → card →
   founder, or add the key additively. This is a real gap in §5.5(b), recorded rather than papered over.
2. **A radar-only founder legitimately scores `insufficient_evidence`.** L2, L3 and X5 need a deck
   or an interview, which the radar cannot produce; 03 returns `cannot_assess` for them, never
   `not_met`. Coverage below 0.25 means no score row at all — that is the designed cold-start
   outcome, not a failure. Handle the state; do not render it as zero.
3. **`companies` identity is anchored on `hn_item_id`, not on the name.** The name can legitimately
   change (a Tier-2 pass that resolves an Organization renames it in place). Do not key anything on
   `companies.name`.
4. **Obscurity averages over OBSERVED terms only**, and `obscurity_basis` says which. A one-term
   value is weaker evidence than a two-term one. **Never sort NULLs first** — a founder with no data
   must not outrank one with data.

---

## Cross-feature rules established here — binding on everyone

1. **Every `raw_signals` row must carry `founder_id` or `company_id` AT INSERT TIME.**
   `purge_founder()` sweeps only by those columns and the table is append-only, so a NULL FK can
   never be backfilled and the row survives erasure permanently.
2. **Every `events` row about a person must use `entity_type='founder'` + the founder id.** The
   purge sweep matches nothing else; any other `entity_type` is structurally unreachable by erasure.
3. **Never write a claim without evidence.** `claims.source_kind='public'` maps to "any source
   (wildcard)" in 03's fallback, so one evidence-less claim licenses `not_met` on *every* criterion —
   REQ-003 inverted. If no attempt was made, write no claim at all (not a `missing` marker).
4. **Do not key an entity's identity on a value that depends on how much data you happened to have.**
   Every idempotency defect found here was this one mistake in a different costume: an unordered
   `selectOne`, unhashed missing-markers, name-based company dedup, and finally a company split
   across two n8n phases.
5. **Commit shared-file work the same hour you do it.** Hours of DDL from three features lived only
   in a working tree and were erased by one stray command; it was recoverable only because the
   objects were still applied in the live database.

---

## 🟡 CARRIED RISK — one thing deliberately not fixed

**`try/catch` blocks that swallow environment defects**, in `ghGet`, `robotsFetchFn` and the Tavily
calls inside the n8n workflow. This is the exact shape of a bug that already bit: `URL` is undefined
in the n8n JS sandbox, `parseArtifactUrl`'s own catch swallowed it, and **every artifact silently
classified as `kind:'none'` with nothing in the logs**. The catch was written for bad input, not for
a missing global, so it converted an environment defect into a silent wrong answer.

QA confirmed the pattern recurs in three more places and judged it **not gate-blocking** — not proven
active, disclosed rather than hidden, cheap and well-understood to fix. Worst is `ghGet`: zero
diagnostic trace and it gates most of the GitHub-derived score weight.

**Recommended first follow-up.** If a later feature sees GitHub-derived criteria unexpectedly empty,
look here before anywhere else.

---

## How to see it work

```bash
set -a; source infra/supabase/.env; set +a
export DATABASE_URL="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@localhost:54322/postgres"

# offline replay, zero API calls, four cases covering all identity tiers:
node lib/f02/run.js --recorded db/fixtures/recorded/user-artifact       # tier 1, exact handle match
node lib/f02/run.js --recorded db/fixtures/recorded/threaded-artifact   # tier 2, declared authorship
node lib/f02/run.js --recorded db/fixtures/recorded/org-artifact        # tier 3, Organization
node lib/f02/run.js --recorded db/fixtures/recorded/product-url         # tier 4, no GitHub at all

# add --write to apply to Supabase (fully idempotent: two passes, zero drift)
```

Expected reachable weight: 0.64375 · 0.27500 · 0.21500 · 0.40375 of the 0.70375 ceiling.

**The end-to-end proof:** `ayuhito` — discovered by the radar, never applied, no deck, in no startup
database — scored by the same feature-03 pipeline an inbound applicant would use:
**`status: scored`, value 60.76, confidence 0.61, coverage 0.395**. Contributions reproduce the
total exactly (`E1 25.31646 + E4 20.25316 + L5 15.18987`). Traceability verified in SQL: score →
16 `input_claim_ids` → all 16 carry evidence → 5 raw signals → 3 sources.

---

## Honest limits — do not overclaim these

- **robots.txt is checked as `vcbrain-radar`, but Tavily fetches the page under its own identity.**
  We refuse disallowed sites outright (verified: `linkedin.com/in/*` is refused, rule `/`), but for
  allowed sites we cannot prove the fetch happened under the agent we checked as. Post-MVP fix:
  fetch the root ourselves — §7.1 measured that `/map` returns zero URLs on real personal sites, so
  root-only is already the common path.
- **Opt-out is enforced at ingest; erasure is not re-ingest-proof.** `purge_founder()` hard-deletes,
  so a later scan can rediscover the same person. The honest fix is a salted-hash suppression list;
  it is out of MVP scope and stated in §7 rather than hidden.
- **The reachable-weight ceiling is 0.70375, not 1.0.** L2/L3/X5 need founder-supplied evidence.
  That is a designed boundary, not a shortfall.
- **`/map` returns zero URLs on real personal sites** (measured on both fixture sites). The crawl
  falls back to the root page; it does not discover `/about` or `/blog` on small static sites.
- **E3 degrades on the REST path.** GitHub's events feed spans ~90 days nominally, but for active
  accounts it exhausts in under 24 hours (measured: `ayuhito` <1 day, `JustVugg` ~4 days). Confidence
  scales to the observed window and `text_verbatim` states it.
- **No `GITHUB_TOKEN` is configured.** Everything above was achieved on unauthenticated REST at
  60 req/h. A classic PAT with zero scopes raises it to 5000/h and restores GraphQL; it is one
  environment variable and changes no code.
