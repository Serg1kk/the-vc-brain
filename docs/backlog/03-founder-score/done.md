# Feature 03 · Founder Score — DONE

```
status: complete
completed_at: 2026-07-19 ~05:55 Minsk
qa_gate: PASSED (8/8 mandatory cases, qa-report-03.md)
commit: f64b66b  (code only — see CAVEAT below; not pushed)
tests: 77 unit (node --test lib/f03/*.test.js) + db/tests/smoke.sql green
```

If you are the agent waiting on this file: **read this whole page before you start.** The
`status` above is `complete`, but there is one caveat and several contracts that bind you.

---

## What 03 produces — the contract you consume

Full normative shape: `design.md` §4.9. Summary:

- **`scores`** rows with `axis='founder_score'`, subject = **the person** (`founder_id` set,
  `application_id` NULL). Append-only: UPDATE/DELETE raise `P0001`. Carries `value` (0-100),
  `confidence` (0-1), `trend`, `missing_flags` (a JSON **array**), `input_claim_ids`,
  `formula_version`, `prompt_version`, `model`.
- **`score_components`** — one append-only row per criterion (12 per run), joined by `run_id`.
  This is the per-criterion breakdown: `verdict`, `weight`, `credit`, `contribution`,
  `evidence_tier`, `claim_ids`, `quote_verbatim`, `rationale`, `what_would_close_it`,
  `demoted_by`. This table **is** the answer to REQ-002 ("show how you got the score").
- **`ai_runs`** — 4 rows per run (one per sub-scorer), joinable via `output_json->>'run_id'`.
  The red-flags agent's output lives here; **`red_flags[]` has no table of its own.**
- **`score_formulas`** — versioned weights/criteria registry, one active row per axis.

### ⚠️ Three things that will bite you if you assume otherwise

1. **A founder may legitimately have NO `scores` row.** When evidence coverage falls below
   `min_coverage` (0.25), 03 writes **no score at all** and instead writes one `events` row with
   `event_type='founder_score_insufficient_evidence'`. This is the cold-start branch and it is a
   feature, not a failure — inventing a number there would violate REQ-004. Handle
   `status: "insufficient_evidence"` explicitly; do not treat a missing score as "not yet scored".
2. **`missing_flags` is an ARRAY**, not the `'{}'` object the column default would suggest.
3. **`config.criteria` and `config.red_flags` in `score_formulas` are jsonb ARRAYS**, not objects
   keyed by id. Both `lib/f03/*.js` normalize either shape; if you write your own reader, don't
   assume.

---

## Cross-feature rules established during 03 — binding on everyone

1. **`scores(axis='founder')` belongs to feature 04**, not to 03 and not to 06. 03 writes
   `founder_score` only. `scores` has no `(application_id, axis)` uniqueness and "current"
   resolves by `max(computed_at)`, so **two writers on one axis race silently.**
2. **`claims.topic` prefixes** are defined by 03 design §4.7 and are load-bearing for routing:
   `founder.execution.*` · `founder.expertise.*` · `founder.leadership.*`. If you produce claims,
   use them.
3. **Always populate `evidence.raw_signal_id`.** The column is nullable, but 03's REQ-003 guard
   resolves a claim's source through it. There is a documented `claims.source_kind` fallback, but
   relying on it loses precision.
4. **n8n Code nodes cannot `require()` from this repo** — the container has no bind-mount. Logic
   destined for a Code node must be self-contained CommonJS with zero imports, pasted verbatim.
5. **Test runner is `node --test lib/fNN/*.test.js`** — glob form. The directory form fails
   repo-wide (Node v22.19.0 quirk). No `package.json`, no dependencies.
6. **n8n: wire parallel branches through an explicit `Merge` node.** Four parallel nodes feeding
   one downstream node silently executed only 1-2 of them and still returned HTTP 200.
7. **`gpt-5.6-luna` rejects `temperature: 0`** (HTTP 400). Omit the parameter entirely.

All of these are also recorded in `docs/backlog/TRACKER.md`.

---

## ✅ The shared-DB caveat is now CLOSED (updated ~07:00)

Earlier revisions of this file warned that `db/schema.sql`, `db/seed.sql` and
`db/tests/smoke.sql` were applied but uncommitted (07's DDL interleaved; one genuinely shared
`smoke.sql` line). That is resolved, via an unpleasant route worth knowing about:

At ~06:45 those three files were **wiped in the working tree** by something in another terminal.
Because 03 and 07 had never `git add`-ed them, hours of DDL from three features existed only as
uncommitted working-tree content and were briefly gone. They were recoverable **only because the
objects were still applied in the live database** — a container reset first would have destroyed
them outright. They have been reconstructed and committed as **`edee0df`** ("restore schema/seed/
smoke lost from the working tree (features 02+03+07)").

**Re-verified after the restore**, so you can rely on it: `purge_founder`'s `score_components`
sweep present, `REVOKE TRUNCATE ON score_components, score_formulas` present, `./db/apply.sh`
clean, `smoke.sql` green, 77 unit tests passing, e2e replay unchanged
(Kwame → `insufficient_evidence`, coverage 0.06).

**The lesson, now rule 7 in `docs/backlog/TRACKER.md`: commit shared-file work the same hour you
do it.** Nothing here was lost to a bad merge or a bad revert — it was lost because it was never
staged.

Nothing has been pushed. The operator was asleep and did not authorise publishing.

---

## How to see it work

```bash
set -a; source infra/supabase/.env; set +a
export DATABASE_URL="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@localhost:54322/postgres"

# offline replay, zero API calls, three founders covering all three outcomes:
node lib/f03/run.js 03f00001-0000-0000-0000-000000000001 --recorded db/fixtures/recorded/devon-ashworth
node lib/f03/run.js 03f00001-0000-0000-0000-000000000002 --recorded db/fixtures/recorded/kwame-asante
node lib/f03/run.js 03f00001-0000-0000-0000-000000000003 --recorded db/fixtures/recorded/pieter-levels
```

Expected: `scored` 29.16 (three red flags firing, five verdicts demoted) ·
`insufficient_evidence` coverage 0.06 (no score invented) · `scored` 67.96.

n8n workflow `f03-score-founder` (id `AlkzJ70zET7SiHkn`) is deployed and active on the shared
instance, and was verified with a live end-to-end run.

---

## Honest limits — do not overclaim these in a demo or video

- **The rubric is unvalidated against human judgement.** No Cohen's κ pass was run (design §7
  parks it). We can say the scoring is evidence-backed, explainable and reproducible. We cannot
  say it is *accurate*.
- **The negative-capability check is source-level, not question-level** (design §8 item 5). One
  `github_api` claim licenses `not_met` across all five execution criteria even if it addresses
  none of them specifically. Accepted tradeoff — it removes the crawl-luck asymmetry — but a judge
  may ask, and QA demonstrated its blast radius (`qa-report-03.md` Finding 1).
- **12 of the designed 24 criteria and 3 of 6 red flags are parked**, with per-item reasons in
  design §3. E8 (AI-era correction behaviour) was cut precisely because it is unproven territory.
- Only the founder axis is built here. Market, idea-vs-market and Trust live in 04 and 05.
