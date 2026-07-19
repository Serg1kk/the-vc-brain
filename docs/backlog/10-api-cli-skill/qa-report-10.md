# 10 · API, CLI & Skill — Adversarial QA Report, Part 1 of 2

> Scope: the three `api_*` PostgREST views, `bin/vcbrain`, `docs/api.md`. **Out of scope for this
> pass**: `POST /webhook/f10-nl-search` (still being deployed by a parallel agent) — it gets part 2.
> Everything below is either a live SQL query against the running Supabase database, a rolled-back
> transaction (verified rolled back afterwards), a real `bin/vcbrain` invocation, or a real `curl`
> against the running PostgREST/Kong stack. None of the developers' 82 unit tests / 10 smoke
> assertions were re-run or relied on as evidence — they are referenced only where useful to point
> out *why* a defect below slipped past them.

## Verdict: **GATE FAILED**

One **CRITICAL** defect blocks: `api_applications`'s opt-out / merge-tombstone exclusion — the
same "no PII survives past opt-out" guarantee `api_founders` and `api_claims` correctly enforce —
is **structurally incapable of firing against the live corpus**. It is not "unlikely to fire" or
"fires late"; it was tested by opting out **every founder in the database simultaneously** and
zero of the 308 live applications were removed. This is a live-database, both-views-diverge,
reproducible-three-ways finding, not a hypothetical.

One **MAJOR** defect in `docs/api.md` compounds it: the document's own prose confidently explains
away the *symptom* of the bug above ("a corpus-connectivity gap, not a view bug") using numbers
(`company_id` "5 of 124 filled", `application_id` "0 of 124 filled") that are now false — a
same-file fix (`db/schema.sql`'s "Task A1c") shipped after the doc was written and silently
invalidated the doc's central explanatory claim about its own view.

Everything else attacked — all four `missing`/absent-axis invariants, dedup, evidence-relation
truthfulness, thesis-vs-scores staleness, all 15 CLI attacks, and every other `curl` example in
`docs/api.md` — held. See §"What held" below; it is long, and the two failures are narrow and
specific, not symptomatic of a broadly fragile build.

---

## Environment

```bash
set -a; source infra/supabase/.env; set +a
export PG="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@localhost:54322/postgres"
export VCBRAIN_TOKEN="$ANON_KEY"
```
`docker ps` confirmed `vcbrain-n8n` and the full `supabase-*` stack healthy throughout. Live
corpus at test time: 124 founders, 308 applications, 734 claims (109 company-scoped), 683 evidence
rows — all counts re-measured live, not assumed from `docs/api.md`.

---

## CRITICAL — `api_applications` opt-out/tombstone exclusion is dead code against real data

**Contract under test** (`design.md` §4, the "Global rule for all views" table, restated in
`docs/api.md` §3): opting a founder out, or marking them a merge-tombstone, must remove them —
and by the `api_applications` subject-resolution rule, their **company's applications** — from
all three views. `docs/api.md` states this in the imperative: *"Opted-out founders and merge
tombstones are excluded by the views themselves."*

**What the SQL actually does** (`db/schema.sql:1436-1555`): `api_applications`'s exclusion is a
two-branch `WHERE`, both branches keyed **exclusively off `founder_company.is_current`**:

```sql
WHERE NOT EXISTS (SELECT 1 FROM current_founders cf WHERE cf.company_id = a.company_id)  -- retained: no current founders at all
   OR EXISTS ( ... cf JOIN founders f ... AND f.opt_out_at IS NULL AND f.merged_into_founder_id IS NULL )  -- retained: >=1 clean current founder
```
where `current_founders AS (SELECT ... FROM founder_company fc WHERE fc.is_current)`.

**The root-cause fact, already known and documented in this same file** (comment on
`founder_cards` CTE inside `api_founders`, `db/schema.sql:1348-1371`, "Task A1c"): `founder_company`
has **exactly 5 rows total, all synthetic 03/05 test fixtures**; feature 02 — which wrote the
*entire* live founder/company/application corpus — **never writes to `founder_company` at all**.
`api_founders` was already patched to resolve `company_id`/`application_id` through `cards`
instead, specifically because of this gap. **The equivalent fix was never applied to
`api_applications`'s exclusion logic**, which still reads only `founder_company`.

### Reproduction 1 — single opted-out founder, rolled back

```sql
BEGIN;
SELECT founder_id, application_id FROM api_founders
  WHERE application_id IS NOT NULL AND founder_id IN (SELECT founder_id FROM api_claims WHERE founder_id IS NOT NULL) LIMIT 1 \gset
-- target founder: a0c5d430-cc68-4de6-bbbf-2f733f8b4da0  app: a3413aa3-90ec-4591-978d-49040665ff7b
SELECT count(*) FROM api_founders  WHERE founder_id = :'founder_id'::uuid;      --  1 (before)
SELECT count(*) FROM api_claims    WHERE founder_id = :'founder_id'::uuid;      -- 28 (before)
SELECT count(*) FROM api_applications WHERE application_id = :'application_id'::uuid;  -- 1 (before)

UPDATE founders SET opt_out_at = now() WHERE id = :'founder_id'::uuid;

SELECT count(*) FROM api_founders  WHERE founder_id = :'founder_id'::uuid;      --  0  (correct: excluded)
SELECT count(*) FROM api_claims    WHERE founder_id = :'founder_id'::uuid;      --  0  (correct: excluded)
SELECT count(*) FROM api_applications WHERE application_id = :'application_id'::uuid;  --  1  (WRONG: still present)
ROLLBACK;
```
Verified this founder's *only* link to the company/application is a `cards` row
(`card_type='founder', company_id=c972…, application_id=a341…`) — `founder_company` has **zero**
rows for this founder, and the company's `founder_company` (`current_founders`) set is **empty**,
so the application is retained via the "no current founders at all" branch regardless of the
founder's opt-out flag.

### Reproduction 2 — merge tombstone, same founder-linkage shape, rolled back

```sql
BEGIN;
SELECT founder_id, application_id FROM api_founders WHERE application_id IS NOT NULL LIMIT 1 OFFSET 1 \gset
-- target: ae8123bf-372a-4fa2-8190-be319a9d211d  app: d9c4693b-45a0-4b31-86db-13b9b659a794
INSERT INTO founders (id, full_name) VALUES ('88888888-0000-0000-0000-000000000099', 'QA Canonical Merge Target');
UPDATE founders SET merged_into_founder_id = '88888888-0000-0000-0000-000000000099' WHERE id = :'founder_id'::uuid;

SELECT count(*) FROM api_founders     WHERE founder_id = :'founder_id'::uuid;          -- 0 (correct)
SELECT count(*) FROM api_applications WHERE application_id = :'application_id'::uuid;  -- 1 (WRONG)
ROLLBACK;
```

### Reproduction 3 — maximal proof: opt out the *entire* corpus, rolled back

```sql
BEGIN;
SELECT count(*) FROM api_applications;  -- 308 (before)
SELECT count(*) FROM api_founders;      -- 124 (before)

UPDATE founders SET opt_out_at = now();   -- ALL 124 founders

SELECT count(*) FROM api_founders;      --   0  (correct: everyone excluded)
SELECT count(*) FROM api_applications;  -- 308  (WRONG: nobody excluded — should be near-zero)
ROLLBACK;
```
Post-rollback check: `SELECT count(*) FROM founders WHERE opt_out_at IS NOT NULL;` → `0`. Clean.

Confirmed structurally, not just by absence of an effect: every one of the 5 `founder_company`
rows in the database points at a company with **zero** rows in `applications`
(`app_count=0` for all 5, checked directly), so the "retained only when at least one current
founder is clean" branch can, by construction of the current corpus, **never fire on any live
application** — the `founder_company`-only exclusion is dead code against real data, not merely
under-triggered.

**Impact.** This is a GDPR/opt-out-adjacent guarantee the design doc calls out by name as required
("must not be served through the public surface") and the rubric's honesty/trust axis cares about
directly — a fund's agent reading `api_applications` today gets a company's screening data even
after every founder tied to it has opted out. It is exactly the class of bug the design doc's own
changelog says was already caught and fixed **twice** on the other two views (rev.2 review B1, an
inverted filter; rev.4 review round 3 F1, an inner-join-in-disguise) — this is a third instance of
the same failure mode, in the one view whose exclusion logic was never updated after the
`founder_company` → `cards` linkage problem was diagnosed and fixed *elsewhere in the same file*.

**Why the developers' own tests didn't catch it.** `db/tests/smoke.sql` (~line 1665) *does* assert
the opt-out/merge-tombstone exclusion on `api_applications`, and that assertion passes — because
its fixture explicitly `INSERT`s a `founder_company` row to make the founder "current"
(`INSERT INTO founder_company (founder_id, company_id, role, is_current) VALUES (..., true)`,
line 1676-1677). That is a path **zero real founders in the live corpus take** (`founder_company`
has 5 rows, all synthetic, all pointing at application-less companies). The smoke test is
internally correct and still green; it is testing a linkage mechanism the real data doesn't use.

**Severity: CRITICAL. Blocks the gate.**

---

## MAJOR — `docs/api.md` is now factually wrong about its own view, and it's live on GitHub

`docs/api.md` §2.1 (`api_founders` column table):

| Column | Doc's claim | Live measurement (2026-07-19, this pass) |
|---|---|---|
| `company_id` | "5 of 124 filled" | **123 of 124 filled** |
| `application_id` | "0 of 124 filled live" | **118 of 124 filled** |

```sql
SELECT count(*) FILTER (WHERE company_id IS NOT NULL) AS company_filled,
       count(*) FILTER (WHERE application_id IS NOT NULL) AS app_filled,
       count(*) FROM api_founders;
--  123 |  118 | 124
```

§3's closing "Live finding, not in the design doc's numbers" paragraph goes further and builds an
explanation on top of the stale numbers: *"`api_founders.application_id` is NULL on all 124
founders today (`company_id` is filled on only 5 of them)... This is a corpus-connectivity gap,
not a view bug."* That paragraph describes a database state that no longer exists — it was true
when written, and became false the moment the "Task A1c" fix (switching `api_founders`'s
company/application source from `founder_company` to `cards`) shipped, without `docs/api.md` being
regenerated. `docs/api.md`'s own preamble states *"Every value shown below was pulled from the live
database... this is deliberate: an honest 'we don't have this yet' is worth more to a consumer than
a column that looks populated... but is NULL on every row in practice"* — the inverse failure mode
has now happened: a column that **is** populated is being described as empty, in a document whose
entire value proposition is "believe these numbers because we measured them."

**Note the compounding effect with the CRITICAL finding above:** the paragraph's *specific* closing
sub-claim ("every one of the 308 `api_applications` rows today is retained through the 'company has
no current founders' branch, not the 'founder is not opted out' branch") happens to still be
literally true right now — but for a much more troubling reason than the doc implies. The doc frames
it as *"the two pipelines... have not yet produced an overlapping row"* (i.e., a temporary
data-population gap that self-resolves as 08 and 02 converge). It is not temporary: it is a
structural property of the view's SQL (§ above) that will not resolve on its own even after 08
ships, because 08's founders will *also* need an explicit `founder_company.is_current` row — which
nothing in the current write path produces — to ever be gated by opt-out at all.

**Not attacked further, correctly, per the task brief's live-and-growing warning:** `docs/api.md`
§4 worked example 3 (evidence ledger for founder `03f00001-…-001`) now returns 5 rows live instead
of the 2 shown in the doc (feature 05 added 3 more `contradicts`-evidence claims for the same
founder since the doc was written). This is cosmetic corpus drift, explicitly disclosed as a
snapshot in the doc's preamble, and every *other* number in the doc (evidence tier counts 276/265/
103/39, company-scoped claims 109, missing claims 36, `axis` distribution 654/48/19/13,
`base_confidence` NULL count 113, all four worked examples' JSON bodies, all `api_applications`
counts, view row totals 124/308/734) verified byte-for-byte accurate against live data — see the
full curl transcript below. Only the `api_founders.company_id`/`application_id` claim, and the
prose built on it, is actually wrong.

**Severity: MAJOR.** Not a runtime defect, but a false, load-bearing claim in a document that is
already public and whose only value is "you can trust these specific numbers." Cheap to fix (two
cells + one paragraph), and independent of the CRITICAL fix above — but ships confusing framing to
a judge in the meantime, and its own words gesture right past a real bug without naming it.

---

## What held — full adversarial pass, item by item

### Invariants (Attack list 1-9)

1. **No blended score.** `information_schema.columns` on `api_applications` — 21 columns, no
   `overall_score`, confirmed live. CLI `application` payload wraps the three axes in a `scores{}`
   object with no derived aggregate anywhere in `bin/vcbrain`.
2. **Absent axis renders NULL, not 0.** `score_founder.value` is `NULL` on all 308 rows (0 axis
   ever written) — verified `count(*) FILTER (WHERE score_founder->>'value'='0') = 0` and
   `assessed='true'` count = 0. Reproduced the documented `value=50, confidence=0` "looks middling,
   is actually zero-confidence-noise" trap live on application `08f360ee-…` via both raw `curl` and
   `vcbrain application`.
3. **Unscored founder → NULL, never 0.** `count(*) FILTER (WHERE founder_score = 0) = 0` across all
   124 founders; 121 unscored founders all show `founder_score IS NULL AND score_assessed=false`.
   Confirmed at the CLI layer too: `vcbrain founder <unscored-id>` → `{"value": null, "gaps": null,
   "assessed": false}`.
4. **No raw objects / no `_`-prefixed keys, all four axes.** `jsonb_typeof` is `array` on
   `score_founder`/`score_market`/`score_idea_vs_market`.`missing` and on `founder_score_missing`;
   zero elements matching `\_%` found by direct `jsonb_array_elements`/`unnest` scans across all
   four, and zero non-string elements inside any `missing` array. `thesis_missing_fields` (native
   `text[]`, not `missing_flags`-derived) also has zero `_`-prefixed entries.
5. **Thesis state from `thesis_evaluations`, not `scores`.** Reproduced the documented stale-value
   case live: application `07f00002-…-004` — `api_applications.thesis_fit` is `NULL` (confirmed via
   explicit `IS NULL` check, not just a blank `psql -t` cell), `thesis_verdict='borderline'`, while
   a direct `scores(axis='thesis_fit')` read for the same application returns a stale `8.10` from a
   prior run. The view correctly avoids the stale value.
6. **`api_founders` stays one row per founder under duplication pressure.** Inserted a second
   `card_type='founder'` row for an existing founder inside a rolled-back transaction —
   `api_founders` still returned exactly 1 row for that `founder_id` before rollback. Rolled back
   cleanly.
7. **Opt-out/merge-tombstone — `api_founders` and `api_claims` correctly enforce it; `api_applications`
   does not.** See CRITICAL finding above — this attack is what found it. The founder- and
   claim-level halves of the guarantee are solid (both went 1→0 and 28→0 respectively in
   Reproduction 1); only the application half fails.
8. **Company-scoped claims survive; shared-card opt-out is conservative (correct).** Live count of
   `founder_id IS NULL` claims: 109 (matches `docs/api.md` exactly). Constructed a card carrying
   *both* `founder_id` and `company_id` (the documented "a card can carry more than one at once"
   shape) with one claim on it, inside a rolled-back transaction: before opt-out the claim is
   present (1 row); after opting out the founder on that shared card, the claim disappears (0 rows).
   This is the *documented* rule working as specified (subject = card's `founder_id` when
   non-NULL) — company data on a founder-tagged card is conservatively hidden with its founder,
   not a bug.
9. **`evidence[].relation` exposed truthfully.** `api_claims`'s aggregated `evidence[].relation`
   counts (supports 572 / context 104 / contradicts 7) match the raw `evidence` table exactly —
   no relabeling, no filtering by relation. Pulled the specific `contradicts` example from
   `docs/api.md` §4 live (founder `03f00001-…-001`, claims `…102`/`…104`, GitHub "coming soon" /
   first-commit-predates-account evidence) and it still reads `relation: "contradicts"` correctly
   (plus one newer contradicts claim, `…103`, added since the doc was written — see MAJOR finding).

### CLI contract (Attack list 10-15)

10. **Malformed input.** Non-UUID id, SQL-injection string (`'; DROP TABLE founders; --`), 10KB
    argument, unicode (`日本語テスト🎉`), empty string, embedded newline, full-width unicode digit
    (`５`) as `--limit` — every one produced a clean structured JSON error (`upstream_error`/
    `usage_error` as appropriate), never a crash. PostgREST rejects the injection payload as an
    invalid `uuid` literal (`22P02`) — parameterized, not concatenated, confirmed at the HTTP layer.
    `--limit 0` → `{items:[], total:8, truncated:true}` (honest, not silently empty). `--limit -5`
    → `usage_error`/exit 2. `--limit 99999` → `limit_exceeded`/exit 1. `--offset 99999` on an
    8-claim founder → PostgREST `416`/`PGRST103`, surfaced as `upstream_error` — see spec-gap note
    below (not a defect, since `--offset` exactly at the total returns a clean empty list).
11. **Non-JSON to stdout: none found.** Pointed `VCBRAIN_REST_URL` at Kong's root (401, JSON),
    Supabase Studio's 404 handler (JSON), an unroutable host (`localhost:1`, connection refused),
    and `https://example.com` (200, real HTML body) — every resulting CLI error body parsed as
    valid JSON via `python3 -c "import json; json.load(...)"`. No stack trace, no HTML, ever
    reached stdout.
12. **`vcbrain schema` — no token, no network, garbage URL.** Ran with `VCBRAIN_TOKEN`/
    `VCBRAIN_REST_URL`/`VCBRAIN_N8N_URL` all unset (`env -u ...`), with `VCBRAIN_REST_URL` pointed
    at a non-resolving host, and at an unroutable IP (`10.255.255.1:1`, would hang on a real
    connection attempt). All three produced byte-identical output to the baseline in **18ms**,
    confirming `schema` makes zero network calls, as designed.
13. **Bad/expired/empty token.** Empty → `missing_token`, `retryable:false` (correct — no server
    round-trip happens). Garbage string and a syntactically-valid-but-bogus JWT → both `401` from
    PostgREST, surfaced as `upstream_error`, `retryable:false` (correct — resubmitting the same bad
    token would never succeed).
14. **Silent truncation: none found.** `--limit 0` on an 8-claim founder → `items:[]`, `total:8`,
    `truncated:true`. `--limit 10` on a 28-claim founder → `total:28`, `truncated:true`, 10 items.
    `--offset` exactly at the total → `items:[]`, `total:8`, `truncated:false` (correct: nothing
    left to page, and it isn't lying about it). Every list response — `founder.claims`,
    `application.claims` — carries an honest `total`/`truncated` pair in every scenario tried.
15. **Exit codes.** Verified 13 distinct scenarios: `0` for `schema`/`founder`/`application`/
    `search` success; `1` for `not_found`, `empty_query`, `not_yet_available` (`memo`), bad token;
    `2` for no command, unknown command, missing required arg, unrecognized flag, extra positional
    args, non-integer `--limit`, negative `--limit`, float `--limit`. All consistent with §6.2.

### Documentation (Attack 16)

Executed **every** `curl` example in `docs/api.md` (§2.1-§2.3, §4 worked examples 1-4): all run,
all return valid JSON, and — aside from the `company_id`/`application_id` fill-rate claim (MAJOR
finding above) and worked-example-3's now-5-row-not-2-row result (cosmetic drift, disclosed) —
every stated live count and every worked-example JSON body matches live output exactly, including:
row totals (124/308/734), `founder_score` presence (3/124, same 3 founders, same values 75.00/
67.96/29.16), the `score_market=50/confidence=0` trap example, `score_founder`/`score_market`/
`score_idea_vs_market` assessed counts (0/1/1 of 308), company-scoped claim count (109), missing
claim count (36), `axis` distribution (654 NULL / 48 market / 19 founder_score / 13
idea_vs_market), `base_confidence` NULL count (113), evidence tier counts (documented 276 /
discovered 265 / missing 103 / inferred 39), and evidence `quote_verbatim`/`source_url` fill
(388/643 of 683). Column lists in `bin/vcbrain schema`'s `views{}` payload were diffed against
live `information_schema.columns` for all three views — identical, no drift.

---

## Distinguishing defect vs. spec gap vs. cosmetic

- **Defect (contract violated):** `api_applications` opt-out/tombstone exclusion (CRITICAL);
  `docs/api.md`'s `company_id`/`application_id` fill-rate claim and dependent prose (MAJOR).
- **Spec gap (contract silent, not necessarily wrong):** `--offset` beyond the claims total returns
  a hard `upstream_error` (PostgREST 416) instead of the graceful empty-list shape used when
  `offset == total`; `design.md`/§6 does not specify which is correct. Worth a decision, not a
  blocker.
- **Cosmetic (disclosed drift, not misleading):** `docs/api.md` worked example 3 now under-counts
  live evidence rows for one founder because the corpus grew after the doc was written — the doc's
  own preamble already frames every number as a timestamped snapshot.

---

## Gate verdict

**GATE FAILED for part 1.**

**Blocking:** the CRITICAL `api_applications` opt-out/merge-tombstone finding. It reproduces
100% of the time, three independent ways (single founder, merge tombstone, whole-corpus sweep),
is structural (not probabilistic — the `founder_company` table cannot, by construction of the
current write paths, ever gate a real application), and violates a guarantee the design doc states
in the imperative and the published `docs/api.md` asserts is already true.

**Recommended alongside the fix:** correct the two stale numbers (and the paragraph built on them)
in `docs/api.md` §2.1/§3 — cheap, and currently the document's own words obscure the CRITICAL bug
rather than pointing at it.

**Not blocking, for the record:** the `--offset`-beyond-end inconsistency (spec gap) and the
worked-example row-count drift (cosmetic, self-disclosed) — neither violates a documented contract
and neither should hold up a re-gate once the CRITICAL item is fixed.

No fixture created during this pass was left committed to the database — every SQL test above ran
inside `BEGIN; ... ROLLBACK;`, and the whole-corpus opt-out sweep was verified clean afterwards
(`SELECT count(*) FROM founders WHERE opt_out_at IS NOT NULL` → `0`). No files were modified; this
report only.
