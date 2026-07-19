# QA Report — Feature 11 (Demo Data & Ethics Layer)

> Independent adversarial pass against the live stack (Supabase Postgres via the Supavisor
> pooler on `localhost:54322`, PostgREST on `localhost:8000`), run 2026-07-19. This is **not**
> a re-run of the developers' own tests — every query below was written from scratch against
> `db/fixtures/11-demo-data.sql`, `docs/backlog/11-demo-data-ethics/fixture-notes.md` and
> `db/schema.sql`, and the erasure test deliberately constructs a repro the fixture itself does
> not contain (see Ethics Invariant 3). All destructive testing ran inside `BEGIN … ROLLBACK`;
> nothing in this report altered live data — verified by re-checking row counts after every
> transactional test.

**VERDICT: GATE PASSED.** All 10 fixture scenarios reproduce live through the actual scoring/
thesis/trust pipelines (not just as inert seed rows), all four ethics invariants hold, and the
previously-flagged "missing founder-card → broken badge read path" bug class does not recur on
any of the 10 records. Zero BLOCKER findings. Two non-blocking notes (documentation/framing
nuances, no functional impact) are recorded below.

---

## Environment

| Item | Value |
|---|---|
| Postgres | `PostgreSQL 17.6` via Supavisor pooler, `postgresql://postgres.<tenant>@localhost:54322/postgres` |
| PostgREST | `http://localhost:8000/rest/v1/`, confirmed live (`api_founders`/`api_applications` queried over HTTP with `ANON_KEY`) |
| Fixture state | `db/fixtures/11-demo-data.sql` already applied — 10 companies, 10 founders, 10 applications in the `11f0…` UUID range, all `is_synthetic=true` |
| Pipelines run against the fixture | Confirmed run (not just seeded): `founder_score` (4/5 radar founders have a real `scores` row + `score_components`; the 5th correctly has none), thesis engine (`thesis_evaluations` rows exist for 4/5 inbound applications), trust (`claim_trust` view computes live per claim) |
| Destructive testing | `purge_founder()` exercised twice inside `BEGIN…ROLLBACK`; live founder count for `11f00007-0000-0000-0000-000000000001` confirmed unchanged (`=1`) after rollback |

---

## The 10 scenarios

### 1. Voltaic Labs / Jonas Reiter — documented contradiction

**PASS.**

```sql
-- claim_contradicted event, full rich payload
select payload from events where id='11f0000a-0000-0000-0000-000000000101';
-- trust path reflecting the contradiction
select * from claim_trust where claim_id='11f00004-0000-0000-0000-000000000104';
```

Observed: `claim_contradicted` event exists with the full payload asserted in the fixture —
`founder_claim`, `found_reality`, `question`, `severity`, `nature`, `entity_match` (all the
fields feature 05's design calls "the richest UI object in the system," design.md §9). The
`claim_trust` view resolves this claim to `n_supports=1, n_contradicts=1, contradiction_penalty
=0.3000, trust=0.0000, derived_status='partially_supported'`. This is **not** `derived_status=
'contradicted'`, and that is correct per design.md §7.4's own rule table: `contradicts>0 AND
supports>0 → partially_supported` (the "Conflicting/Cherry-picked" case), reserving literal
`contradicted` for a documented-tier contradiction with zero supports. The deck's own claim text
counts as a `supports` row for itself, so this claim structurally can never resolve to bare
`contradicted` — the event type (`claim_contradicted`) is the correct signal to key UI off, and
it fires exactly once, with `verdict_before='unverified'`, `verdict_after='contradicted'`.

### 2. Cassia Health / Femke de Winter — not-disclosed gap

**PASS.**

```sql
select id, topic, verification_status, source_kind, content_hash
from claims where id='11f00004-0000-0000-0000-000000000205';
select * from claim_trust where claim_id='11f00004-0000-0000-0000-000000000205';
```

Observed: `company.stage_evidence` is a first-class row (`text_verbatim='Product stage: not
disclosed.'`), `verification_status='missing'`, `source_kind='derived'`, `content_hash=NULL`
(gaps have no content to hash, per the fixture's own column-shape convention). `claim_trust`
resolves it to `derived_status='missing', trust=0.0000` — never rendered as false "confirmed
absence," never silently omitted.

### 3. Kelpgrid / Nikolaj Brandt — outside thesis, never rejected

**PASS**, with one framing note (non-blocking).

```sql
select verdict, coverage, missing_fields from thesis_evaluations
where application_id='11f00002-0000-0000-0000-000000000003';
-- confirm 'rejected' is not even a legal value
select conname, pg_get_constraintdef(oid) from pg_constraint
where conname ilike '%verdict%' and conrelid='thesis_evaluations'::regclass;
```

Observed: `verdict='borderline', coverage=1.00`. `thesis_evaluations.verdict` has a `CHECK`
constraint of `('passed','failed','borderline','insufficient_evidence')` — `'rejected'` is not a
legal value anywhere in the schema, so this scenario cannot land there even by a future bug.
`applications.status` for Kelpgrid is `'sourced'`, not `'pass'`. **Framing note:** the fixture's
own README/design language ("outside thesis geographies (DK)") suggested the geography axis
would be the driver; live, the active thesis's `mandate.geographies=["EU","US"]` is a
*region*-level check and Denmark satisfies it (`M_geography: satisfied`). The actual driver of
the `borderline` verdict is the **sector** mismatch (`climate-energy` → `M_sector: missed`,
expected `["b2b-software","ai-infra","devtools"]`). `theses.config.geos=["DE","FR","NL","US"]`
(country-level, excludes DK) exists on the same thesis row but is consumed by feature 04's
market scorer, not by the thesis-fit engine's own verdict — so Kelpgrid is functionally
"outside thesis" for a slightly different reason (sector, not the country-level geo list) than
the fixture's own comment implies. The observable behavior the invariant actually requires
(`borderline`, never `rejected`) is exactly right; this is a documentation nuance, not a defect.

### 4. Ledgerline / Claire Bosquet — forecast claim, never verdict-eligible

**PASS.**

```sql
select * from claim_trust where claim_id='11f00004-0000-0000-0000-000000000404'; -- TAM
select * from claim_trust where claim_id='11f00004-0000-0000-0000-000000000406'; -- qualitative
select event_type, payload->>'verdict_after' from events
where payload->>'claim_id'='11f00004-0000-0000-0000-000000000404';
```

Observed: `market.size_tam` resolves to `router_class='forecast'`, `derived_status='unverified'`
(matches design.md §5.3/§7.4's rule: qualitative/forecast/unverifiable claims "never write
supports/contradicts... never enter the factual verification queue and never produce a
verdict" — enforced live, not just documented). The one `claim_verification_attempted` event
against it also stays `unverified→unverified`, confirming it was never routed toward a
verdict. `claims.verification_status` (the stored column, post best-effort write-back) is also
`unverified`, so this holds even for consumers reading the raw table instead of the view. The
qualitative `founder.leadership.compression` claim on the founder card resolves the same way
(`router_class='qualitative'`, `derived_status='unverified'`).

### 5. Playdrift / Marcus Vale — insufficient_evidence by construction

**PASS.**

```sql
select verdict, coverage, missing_fields from thesis_evaluations
where application_id='11f00002-0000-0000-0000-000000000005';
```

Observed: `verdict='insufficient_evidence', coverage=0.38, missing_fields=
{business_model,geography_country,stage_evidence}` — exactly 3 of the 5 tracked company
attributes (`sector`, `what_is_built` present; `business_model`, `geography_country`,
`stage_evidence` missing), matching the fixture's "3 of 5 attributes missing" design exactly.

### 6. tracewire / Mila Sørensen — flagship radar story

**PASS.**

```sql
select founder_score, confidence from scores where founder_id='11f00007-0000-0000-0000-000000000006';
-- 82.80 / 0.54, confirmed
select criterion_id, verdict, evidence_tier from score_components sc join scores s on s.id=sc.score_id
where s.founder_id='11f00007-0000-0000-0000-000000000006';
select tier, quote_verbatim from evidence where id='11f00006-0000-0000-0000-000000000605';
```

Observed: `founder_score=82.80` (exact match to the acceptance value). `score_components` shows
`E1/E3/E5` all `verdict='met', evidence_tier='documented'` — the documented-tier execution
signals the scenario calls for. The searched-nothing-found provenance row
(`11f00006-…-605`) has `tier='missing', quote_verbatim=NULL, relation='context'` — a genuine
"searched, found nothing" row, not a never-checked omission.

### 7. quietgpu / Andrei Balan — HN-only identity, low-confidence normal branch

**PASS.**

```sql
select kind, value from founder_identities where founder_id='11f00007-0000-0000-0000-000000000007';
select value, confidence from scores where founder_id='11f00007-0000-0000-0000-000000000007';
select criterion_id, verdict, evidence_tier from score_components sc join scores s on s.id=sc.score_id
where s.founder_id='11f00007-0000-0000-0000-000000000007';
```

Observed: exactly one `founder_identities` row (`kind='hn'`), **no `github` row exists** — the
HN-only narrative holds; nothing in the live data would let a github cross-link leak in.
`founder_score=23.68, confidence=0.22` (exact match). `score_components` shows **no criterion at
`documented` tier** (all `cannot_assess`/`self_asserted`/`discovered`) — consistent with a
founder who has zero corroborated GitHub signal, an honestly low-confidence score rather than a
score dressed up as more certain than its evidence supports.

### 8. saltmarsh / Priya Raman — low-obscurity, strong documented execution

**PASS.**

```sql
select value, confidence from scores where founder_id='11f00007-0000-0000-0000-000000000008';
select criterion_id, verdict, evidence_tier from score_components sc join scores s on s.id=sc.score_id
where s.founder_id='11f00007-0000-0000-0000-000000000008';
```

Observed: `founder_score=82.44` (exact match). `E1` (merged PR into `postgres/postgres`), `E4`
(live product URL), `E5` (external usage/dependents) all `verdict='met', evidence_tier=
'documented'`.

### 9. ferrofluid / Tomás Aguiar — star-farming red flag R2

**PASS — the marquee scenario, verified in full.**

```sql
select value, confidence from scores where founder_id='11f00007-0000-0000-0000-000000000009';
select criterion_id, verdict, evidence_tier, demoted_by, credit
from score_components sc join scores s on s.id=sc.score_id
where s.founder_id='11f00007-0000-0000-0000-000000000009' and sc.criterion_id='E5';
```

Observed: `founder_score=71.62` (exact match) on a **real `scores` row**
(`dbf21c6d-a485-48ee-9a81-3c2fd282b0ef`). On the `score_components` row actually attached to
that score: `criterion_id='E5', verdict='self_asserted', evidence_tier='missing', demoted_by=
'R2', credit=0.30`. This is exactly the claimed shape — the red flag is attached to the
**scored** row, not a side artifact that gets discarded before the score is finalized. The same
raw snapshot (9,200 stars / 3 forks / issues disabled) produces one `supports` (0.40) and one
`contradicts` (0.85) evidence row against the same claim, which is what triggers the demotion.

### 10. patchbay / Yuki Andersen — cold start, honest zero

**PASS.**

```sql
select count(*) from scores where founder_id='11f00007-0000-0000-0000-00000000000a'; -- 0
select event_type, payload from events where entity_id='11f00007-0000-0000-0000-00000000000a';
```

Observed: **zero rows** in `scores` for this founder — confirmed as the correct outcome
(REQ-003), not a bug. Two `founder_score_insufficient_evidence` events exist: the fixture-seeded
one (`coverage=0.06`) **and a second one written by an actual live pipeline run**
(`run_id='8e444b97-…'`, full `missing` array of 12 criteria each with `what_would_close_it` text)
— i.e. this is not just a hand-seeded event sitting next to inert data, the scoring pipeline was
actually executed against this founder and independently arrived at the same
insufficient-evidence outcome.

---

## Ethics / compliance invariants

### Invariant 1 — REQ-004: SYNTHETIC badge can never be missing

**PASS, adversarially confirmed for all 10 records, both by direct SQL and over PostgREST.**

```sql
select founder_id, full_name, is_synthetic, company_name, application_id
from api_founders where founder_id::text like '11f0%';   -- 10/10 rows, is_synthetic=t, no NULLs

select application_id, company_name, is_synthetic
from api_applications where application_id::text like '11f0%';  -- 10/10 rows, is_synthetic=t

select rc.founder_id, af.is_synthetic from radar_candidates rc
join api_founders af on af.founder_id=rc.founder_id
where rc.founder_id::text like '11f0%';  -- 10/10, is_synthetic=t
```

Confirmed live over PostgREST (`curl http://localhost:8000/rest/v1/api_founders?founder_id=in.(…)`
and the same for `api_applications`) — all 10 founders and all 10 applications resolve
`is_synthetic=true` with populated `company_name`/`application_id`, none NULL. This directly
targets the previously-fixed bug class (schema.sql's own Task-11-addendum comment on
`api_applications.is_synthetic`, and the fixture's own comments on Cassia/Kelpgrid/Ledgerline/
Playdrift's founder cards, all describing this exact failure mode being caught and fixed on
2026-07-19): I found **zero** of the 10 records where the badge read path fails. Every founder
card row exists, every `api_founders`/`api_applications` join resolves.

### Invariant 2 — no synthetic row resembles a real person/company

**PASS.**

```sql
select name, domain from companies where id::text like '11f0%' and domain not like '%.example';  -- 0 rows
select 'founder_identities' as tbl, value, url from founder_identities where founder_id::text like '11f0%'
  and url !~ '(github.com|news.ycombinator.com|\.example)'
union all select 'evidence', quote_verbatim, source_url from evidence where id::text like '11f0%'
  and source_url !~ '(github.com|news.ycombinator.com|\.example)'
union all select 'raw_signals', source, source_url from raw_signals where id::text like '11f0%'
  and source_url !~ '(github.com|news.ycombinator.com|\.example)';  -- all three: 0 rows
select full_name, (profile->>'note') like '%Fictional person%' from founders where id::text like '11f0%';  -- 10/10 true
select name, (profile->>'note') like '%Fictional company%' from companies where id::text like '11f0%';  -- 10/10 true
```

All 10 company domains end in `.example`. Every non-`.example` URL in the fixture resolves to
`github.com` or `news.ycombinator.com` under fixture-specific, clearly-fabricated handles
(`jreiter-voltaic`, `mila-tracewire`, `taguiar-ff`, etc.) — none collide with the fixture's own
`.example` convention violated. Every one of the 10 founders and 10 companies carries an
explicit `"Fictional person"` / `"Fictional company"` disclaimer in `profile`.

### Invariant 3 — right to erasure works

**PASS — including a repro the fixture itself doesn't natively contain.**

None of the 10 fixture founders carry a native `interviews` row (feature 08 intake never ran
against any of them), so the specific "interviews before cards" ordering bug the task flagged
could not be exercised against the fixture as shipped. Rather than take the fix on faith (or
reuse the developers' own `db/tests/smoke.sql` regression fixture), I constructed an independent
adversarial repro **inside `BEGIN…ROLLBACK`**: attached a fresh `interviews` row (+ a
`voice_artifacts` child) to Jonas Reiter's existing founder card, then ran `purge_founder()`.

```sql
BEGIN;
INSERT INTO interviews (id, application_id, card_id, kind, status)
VALUES ('99999999-1111-0000-0000-000000000001',
        '11f00002-0000-0000-0000-000000000001',
        '11f00003-0000-0000-0000-000000000102', 'first', 'completed');
INSERT INTO voice_artifacts (id, interview_id, storage_path)
VALUES ('99999999-1111-0000-0000-000000000002',
        '99999999-1111-0000-0000-000000000001', 's3://voice/qa-test/jonas.wav');
SELECT purge_founder('11f00007-0000-0000-0000-000000000001');
-- ... row-count checks (see below) ...
ROLLBACK;
```

Result: `purge_founder()` completed with **no FK violation** (no exception raised). Post-purge,
inside the same transaction: `founders`, `cards` (both company- and founder-scoped, since Jonas
is Voltaic's sole founder), `interviews`, `voice_artifacts`, `founder_identities`,
`founder_company`, `raw_signals`, `claims`, `evidence` — all **0** for this founder/company.
`companies`/`applications` for Voltaic Labs are also gone (correct: sole-founder company). Prior
application-scoped events (including the `claim_contradicted` event from Scenario 1) are gone —
`0` remaining. Exactly **one** anonymized audit row survives: `event_type='founder_purged',
entity_type='founder', entity_id='11f0…0001', payload='{}'` (no PII). After `ROLLBACK`,
confirmed live data unaffected: `select count(*) from founders where id='11f0…0001'` → `1`
(unchanged), and the throwaway test interview (`99999999-…`) does not exist.

### Invariant 4 — data minimisation

**PASS.**

```bash
grep -inE '\b(age|date_of_birth|dob|photo|gender|ethnicit[a-z]*|religio[a-z]*|disabilit[a-z]*|sexual[a-z]*|race|nationality)\b' \
  db/fixtures/11-demo-data.sql db/schema.sql
```

Zero matches (word-boundary regex, to avoid false positives like `stage`/`manage` matching a
loose `age` substring). Every claim topic in the fixture is a professional-capability signal
(`founder.execution.*`, `founder.expertise.*`, `founder.leadership.*`, `company.*`); the schema
itself has no age/photo/gender/ethnicity/religion/disability/sexual-orientation/nationality
column anywhere.

---

## Findings table

| Severity | What | Repro | Expected / Actual |
|---|---|---|---|
| Non-blocking note | Kelpgrid's "outside thesis geography" framing in `README.md`/`design.md` doesn't match the live driver of its `borderline` verdict | See Scenario 3 above | Expected (per fixture comment): geography drives the miss. Actual: `M_geography` is `satisfied` (DK counts as EU at region level); `M_sector` (`climate-energy`→`other`) is what drives `borderline`. Functional outcome (`borderline`, never `rejected`) is still correct — this is a doc/comment nuance, not a data or pipeline defect. Belongs to whoever owns fixture-notes.md/README.md wording, not a re-open of feature 07 or 11's data. |
| Non-blocking note | `thesis_evaluations` has no rows at all for the 5 radar-activated applications (tracewire, quietgpu, saltmarsh, ferrofluid, patchbay) | `select * from thesis_evaluations where application_id in (…the 5 radar app ids…)` → 0 rows | Not called out as required by any of the 10 acceptance scenarios (which only specify founder_score outcomes for the radar 5) — flagging only in case a future feature assumes every application has a thesis verdict. Out of feature 11's scope as tested; not a blocker for this gate. |

No BLOCKER or MAJOR findings.

---

## Quality Gate Sign-off

- [x] All 10 fixture-notes.md scenarios reproduce live (not just as seeded rows — 4 read through
      real `scores`/`score_components`, 4 through real `thesis_evaluations`, 1 through a real
      `claim_contradicted` event + `claim_trust` computation, 1 through a real second
      `founder_score_insufficient_evidence` event from an actual pipeline run)
- [x] REQ-004 SYNTHETIC badge read path resolves for all 10 records, confirmed via `psql` and
      live PostgREST HTTP calls
- [x] No synthetic row references or resembles a real person/company (`.example` domains,
      fictional disclaimers, no non-fixture URLs)
- [x] Right to erasure (`purge_founder()`) verified with an adversarial repro not present in the
      fixture itself (added `interviews`/`voice_artifacts` row), inside `BEGIN…ROLLBACK`; live
      data confirmed unaffected afterward
- [x] Data minimisation: zero age/DOB/photo/gender/ethnicity/religion/disability/sexual-
      orientation/nationality fields anywhere in the fixture or schema

## GATE: PASSED
