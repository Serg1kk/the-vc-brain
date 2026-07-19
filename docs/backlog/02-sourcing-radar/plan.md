# 02 · Sourcing Radar — Implementation Plan

> Design: [design.md](design.md) (complete). Details are referenced, never restated here.
> Conventions inherited from `docs/backlog/TRACKER.md`: `node --test lib/f02/*.test.js` (glob
> form — the directory form fails on Node v22.19.0), no `package.json`, no dependencies; n8n Code
> nodes are self-contained CommonJS with zero imports pasted verbatim behind a
> `// SOURCE OF TRUTH: lib/f02/<file>.js` header; PostgREST base URL normalised via the
> `SB_NORMALIZE` idiom (03 hit an env-drift race twice).

## Stages and parallelism

| Stage | Tasks | Parallel? | Depends on |
|---|---|---|---|
| A · deterministic core | 1–4 | tasks 1–4 sequential (2–4 import 1's helpers conceptually), but the whole stage is independent of B and C | design |
| B · DB surface | 5–6 | **parallel to A** | design |
| C · n8n workflow | 7–8 | after A (pastes A's code) and B (writes to its view/rows) | A, B |
| D · integration & fixtures | 9–10 | after C | C |
| E · QA gate | 11 | after D | D |
| F · close | 12 | after E | E |

Solo execution: A and B genuinely parallelise across two agents; C onward is sequential.

---

## Stage A — deterministic core (`lib/f02/`)

### Task 1 · `lib/f02/normalize.js`
Port from vantage `vantage/services/text.py` (MIT, stdlib-only) to self-contained CommonJS.
- `contentHash(parts[])` → sha256 hex over `parts.join('::')` (design §6.1)
- `canonicalDomain(url)` → registrable domain, `null` for `_GENERIC_HOSTS`
  (`github.com`, `github.io`, `vercel.app`, `netlify.app`, `notion.site`, `substack.com`,
  `medium.com`, `linkedin.com`, `twitter.com`, `x.com`, `producthunt.com`, `ycombinator.com`,
  `chromewebstore.google.com`, `apps.apple.com`, `play.google.com`, `huggingface.co`)
- `normalizeName(s)` → lower/trim, strip legal + AI-era suffixes (`ai`, `labs`, `technologies`, `inc`, `ltd`)
- `parseArtifactUrl(url)` → `{kind:'github_repo'|'github_user'|'product'|'none', owner, repo, host}`

**Acceptance:** unit tests cover the generic-host guard (a `github.io` page must not become a
company domain), sub-domain collapse, and hash stability across argument reordering.

### Task 2 · `lib/f02/identity.js`
Implements design §4.1's revised five-tier cascade.
- `resolveIdentity({hnAuthor, artifact, ghOwner, ghOwnerType, siteBacklink})` →
  `{tier, confidence, discoveredVia, needsReview, orgIsCompany}`
- Tier 2 (declared authorship, 0.85) is the load-bearing path — the majority case.
- Organization owner → `orgIsCompany: true`, founder `unresolved`, `needsReview: true`.
- **No fuzzy string matching anywhere.** A test asserts this explicitly.

**Acceptance:** table-driven tests over the 18 measured real pairs recorded in design §4.1
(`kaiwuTW`/`kaiwutech-TW`, `G3819`/`puffinsoft` (Organization), `geminimir`/`geminimir`, …),
asserting tier and confidence for each. Zero fuzzy matches produced.

### Task 3 · `lib/f02/claims.js`
Maps fetched facts onto design §5.1's nine topic slugs.
- One pure function per slug: input = the relevant fetched object, output =
  `{topic, text_verbatim, value, source_kind:'public', base_confidence, evidence:{tier, quote_verbatim, source_url}}`
  or `null` when the fact is absent.
- Absence produces a **`missing` claim**, never a zero and never a negative claim (REQ-003/004).
- Topic slugs must match design §5.1 exactly — 03 routes by prefix and a typo silently starves a
  criterion.

**Acceptance:** every slug in §5.1 has a producing function and a test; a test asserts that an
empty input object yields `missing` claims rather than throwing or emitting `not_met`.

### Task 4 · `lib/f02/obscurity.js`
Deterministic, explainable in one sentence (design §6.4).
- `obscurity({ghFollowers, hnKarma})` → `0..1`, monotone decreasing in both, no founder-quality
  input whatsoever.

**Acceptance:** monotonicity test; a test asserting the function ignores any field other than the
two declared inputs (guards against a score sneaking in through a side door).

---

## Stage B — DB surface

### Task 5 · registry rows + view
`db/seed.sql`: INSERT the seven `metric_kinds` from design §6.4
(`gh_followers`, `gh_notable_followers`, `gh_forks`, `gh_dependents`, **`hn_karma`**,
`hn_comments`, `hn_author_replies`), `ON CONFLICT DO NOTHING`. **`site_updated` and `hn_points`
are reused, not duplicated.** (An earlier draft of this line listed `site_last_modified` and
omitted `hn_karma` — design.md §6.4 is authoritative.)
`db/schema.sql`: `CREATE OR REPLACE VIEW radar_candidates` per design §6.4.

⚠️ **Shared-file protocol** (TRACKER, 03↔07 open item): anchor edits on text, never line numbers;
re-read immediately before editing; mark every addition `-- Feature 02:`. Registry assertions in
smoke are presence-based since 04's change — adding rows needs no smoke edit.

**Acceptance:** `./db/apply.sh` twice in a row is idempotent; the view returns rows for a seeded
founder.

### Task 6 · smoke coverage
Append one `DO $$` block to `db/tests/smoke.sql` in a **non-overlapping id range** (feature 02
uses `02f00001-…`), asserting: `raw_signals` `content_hash` collision is a no-op;
`metric_observations` retry within the same hour does not double-insert; `radar_candidates`
computes obscurity monotonically.

**Acceptance:** `psql -f db/tests/smoke.sql` green with 03's and 07's blocks present.

---

## Stage C — n8n

### Task 7 · `f02-radar-scan` (tiers 0–1)
Nodes: Cron/Manual → HTTP (HN Algolia, keyless) → Code `tier0-filter` (drop no-url, order by
recency, cap `gate_budget=120`, log the drop count) → Code `persist-raw-signals` (PostgREST,
**two-step insert per design §5.0 rule 3** — `ON CONFLICT DO NOTHING` returns no id on retry, so
select back by `content_hash`) → HTTP `/items/{id}` per survivor → Code `persist-thread`.
Writes the `radar_scan_completed` event with counters (design §6.2).

**Acceptance:** one live run persists `raw_signals` rows; a second identical run inserts zero new
rows **and every candidate still resolves to a `raw_signal_id`** (the retry case that would
otherwise manufacture evidence-less claims).

### Task 7a · pre-gate entity creation + gate call (design §5.5)
Added after spec review — the gate cannot run without these and the branch was wrong.
- Create `companies` (name = normalised Show HN title, `domain` = `canonicalDomain(artifact_url)`
  or NULL, `stage='pre_seed'` as a stated track-level assumption) and `applications`
  (`kind='radar_activated'`, `status='sourced'`, `artifact_links` per §5.5b's key shape) for
  **every** tier-0 survivor, including those about to be rejected.
- Call 07's gate with `mode: 'keyword'`.
- Branch **four ways**: `passed | borderline | NULL` → advance to tier 2; `failed` → stop.
  `NULL` counts as `borderline` and is recorded in the run counters, never silently dropped.

**Acceptance:** a keyword-mode run advances a non-zero number of candidates (the defect this task
exists to prevent is a run where everything returns success and nothing advances).

### Task 8 · `f02-identity-resolve` + `f02-radar-enrich`
Identity cascade (Task 2 code pasted verbatim) → GitHub REST behind a capability check
(`GITHUB_TOKEN` absent → REST unauthenticated → on 403/rate-limit → `missing` claims, never throw)
→ Tavily `/map` then a **single batched** `/extract` (≤20 URLs; batching is a 5× credit
difference) → Code `emit-claims` (Task 3) → PostgREST writes to `cards`, `claims`, `evidence`,
`metric_observations`, `founders`, `founder_identities`, `companies`, `applications`
(`kind='radar_activated'`).

⚠️ If any branch fans parallel work back into one node, use an explicit `Merge` node — plain
multi-wire input silently executes only some branches and still returns 200 (TRACKER, 03).

**Acceptance:** a founder resolved end-to-end has `claims` under the §5.1 slugs, every `evidence`
row carries a non-null `raw_signal_id`, and `robots.txt` denial is recorded as a
`crawl_skipped_robots` event.

---

## Stage D — integration and fixtures

### Task 9 · recorded fixtures + offline replay
Record real API responses for 3 candidates spanning the cases that matter:
one GitHub-`User` artefact, one **Organization** artefact, one non-GitHub product URL.
`node lib/f02/run.js <candidate> --recorded db/fixtures/recorded/<name>` replays with zero API
calls — the same pattern 03 used, and the only way the demo is safe on stage.

**Acceptance:** three replays produce deterministic, identical output across runs.

### Task 10 · end-to-end against the live DB
Run the full chain for the three fixtures; verify a `founder_score` can be produced by feature 03
from radar-only claims (the cross-feature proof), including that the HN-only case correctly yields
03's `insufficient_evidence` rather than an invented number.

**Acceptance:** at least one radar-discovered founder receives a real `scores` row from 03 with
`input_claim_ids` referencing radar claims.

---

## Stage E — QA gate

### Task 11 · independent adversarial pass (@qa-engineer)
Must not reuse the developer tests. Mandatory attack cases:
1. Re-run a completed scan — zero duplicate rows anywhere.
2. Organization-owned artefact — no founder is invented.
3. Handle mismatch (`kaiwuTW`/`kaiwutech-TW`) — resolved at tier 2, not by fuzzy matching.
4. `robots.txt` disallow — crawl skipped and the skip is recorded.
5. Absent GitHub data — `missing` claims, confidence down, **no score movement** (REQ-003).
6. `opt_out_at` set — candidate is not ingested at all.
7. Every `evidence` row has `raw_signal_id` populated (03's guard depends on it).
8. Obscurity ignores every input except followers and karma.

**Acceptance:** written `qa-report-02.md`, gate PASSED, findings fixed and independently re-checked.

## Stage F — close

### Task 12 · docs + commit (@devops)
Feature README status, tracker final, TRACKER.md status row and any changelog entries,
`done.md` with `status:` for downstream consumers (08 and 11 wait on this feature).
Commit per-feature paths only, never `git add -A`. **No push** without operator authorisation.

⚠️ The 03↔07 shared-DB-files commit is still open (TRACKER). If 02 is the terminal that finishes
last, it inherits the combined commit of `db/schema.sql`, `db/seed.sql`, `db/tests/smoke.sql`
covering all features, after `./db/apply.sh` twice and a green smoke run.
