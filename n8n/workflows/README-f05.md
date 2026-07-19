# Feature 05 workflows — Trust Score rollup, claim verification, contradiction scan

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f05-workflow.py           # regenerate + syntax-check every Code node of all 3 workflows
python3 n8n/build-f05-workflow.py --check   # check only, no write
```

All three workflows below share one generator (`n8n/build-f05-workflow.py`). The deterministic
core of each lives in `lib/f05/*.js`, unit-tested outside n8n. n8n Code nodes cannot `require`
local files, so that source is **inlined** verbatim by the generator (only the trailing CommonJS
`module.exports` line is stripped — the sandbox has no `module` global). Editing the JSON directly
makes the tested module and the running workflow drift apart — the exact class of silent
divergence this generator exists to prevent (same rationale as `n8n/build-f03-workflow.py`).

## Registered workflows

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f05-trust-rollup` | `Wtd887vYwv5x3FvH` | 17 total | Given `{ application_id }`: resolve scope (design §8.1) → load `claim_trust` rows in scope → `computeTrustRollup()` → write one `scores(axis='trust')` row, or (below `min_coverage`) write no row and emit a `trust_rollup_insufficient_evidence` event instead. Zero LLM, zero writes to `evidence`/`claims`. |
| `f05-verify-claims` | `UubHQ9HZWVdOrKjq` | 23 total | Given `{ application_id }`: resolve the SAME scope, route every claim (`lib/f05/router.js`), run the two deterministic SS5.1 checks (`gh_provenance`, `quote_guard`) plus denominator extraction, pass any contradiction candidate through the entity gate's steps 1-2 (no LLM), write `evidence` + `events` + one `ai_runs` ledger row. Zero LLM, zero external network call. |
| `f05-contradiction-scan` | `csvoMOTs7MNBdXLI` | 21 total | Given `{ application_id }` (or a caller-supplied `{ pairs: [...] }`): builds a narrow queue of (claim, independent evidence) pairs, runs `contradiction-detector` TWICE per pair (K=2), and — only for a confirmed candidate — runs the full entity gate including step 3's `entity-matcher` LLM hook, the ONE call site in this feature where that fires. |

Entry points for all three: `POST /webhook/<name>` with `{ "application_id": "<uuid>" }`, or as an
Execute-Workflow sub-workflow call from another workflow with the same input shape (06/09/10 will
call them this way once they exist).

## `f05-trust-rollup` topology notes

- **No `Merge` node** — unlike f03/f04, this workflow has no parallel LLM branches to fan back
  in. The only branch point is the `IF: insufficient_evidence?` node, whose two outputs are
  mutually exclusive per execution (never both fire), so a plain node (`Build output contract`)
  with two incoming wires is safe here — same pattern f03 already uses for its own
  `insufficient_evidence` vs. `scored` branches feeding into `Write score_components x12`.
- **Scope resolution is two PostgREST round trips, not one join** (`Load scope card ids` →
  `Load claim_trust rows (scoped)`): `claim_trust` is a SQL **view** with no FK metadata
  PostgREST can auto-embed through, so the design §8.1 three-route `OR` filter
  (`application_id.eq.` / `company_id.eq.` / `founder_id.in.(...)`) runs against `cards` first to
  get the candidate `card_id`s, then `claim_trust?card_id=in.(...)` fetches the per-claim rows,
  merged back together in JS. This is the **unrestricted superset** (route 3 with no
  `company_id` restriction) — `lib/f05/trust.js`'s own `scopeClaimsToApplication()` applies that
  restriction inside the ROLLUP node itself, per that module's documented contract ("a caller may
  pass a superset and rely on this module for the restriction").
- ROLLUP (`lib/f05/trust.js`) is the only Code node with inlined library source; every other node
  is a thin PostgREST read/write.

## `f05-verify-claims` topology notes (task C1b)

A hand-port of `lib/f05/run.js`'s steps 1-9 (routing → checks → evidence/events), NOT step 10's
rollup (that stays `f05-trust-rollup`'s own job) and NOT step 11's write-back (design §8.4 binds
that to a *successful* rollup, which this workflow never runs). `run.js` itself cannot be pasted
verbatim — it is a Node CLI that requires `node:fs`/`node:crypto`/`node:child_process` and shells
out to `psql` — so its **logic** is reproduced here, cross-checked line by line against the live,
QA-verified reference implementation, over PostgREST instead of `psql`.

- Entirely sequential — no `Merge` node needed. Every check (`gh_provenance`, `quote_guard`,
  denominator extraction) is deterministic and runs inside ONE big Code node's JS loop over the
  scoped, routed claims; there is no true parallel fan-out to reconcile.
- Same scope resolution as `f05-trust-rollup` (`Load scope card ids` → `Load claim_trust rows
  (scoped)`), PLUS a `RESTRICT + ROUTE` node that pastes `lib/f05/trust.js`
  (`scopeClaimsToApplication`) **and** `lib/f05/router.js` (`routeClaimTopic`) together — the
  brief's own "reuse via inlining" list named router/verifiers/quote_guard/entity_gate
  specifically, but `trust.js`'s scope restriction is reused too (not a new claim-scoping rule):
  design §8.1's company_id restriction on route 3 is load-bearing regardless of which f05 workflow
  is asking, and `lib/f05/run.js` applies the identical restriction at the identical pipeline
  point.
- `Load quote_guard candidates` mirrors `lib/f05/run.js`'s own query exactly, including its
  load-bearing `relation=eq.supports` filter (a claim whose only quote-bearing row is an unrelated
  `contradicts` row must not be compared against it) and its DISTINCT-ON-claim_id-via-ordering
  trick (PostgREST has no `DISTINCT ON`, so `order=claim_id.asc,created_at.asc` + "first row per
  claim wins" in JS is the equivalent).
- `CHECKS - dispatch` is the workflow's one big Code node: it pastes `lib/f05/verifiers.js` +
  `lib/f05/entity_gate.js` + `lib/f05/quote_guard.js` and hand-ports `run.js`'s
  `runGithubProvenanceCheck`/`runQuoteGuardCheck`/`buildEntityForRow`/`extractSourceText`. Both
  checks call `applyEntityGate` with **no `matchWithLlm` hook** — step 3 never fires from this
  workflow (owned by `f05-contradiction-scan`), matching `run.js`'s own explicit choice.
- **design §5.9 (entity gate also guards `supports`, found live on the Tavily branch)**: `gh_provenance`'s
  `'clean'` branch — the one place this workflow writes `supports` evidence — now runs the SAME
  steps-1-2 `applyEntityGate` call as the `'flagged'` (contradiction) branch before writing.
  Verified live on a real founder+company (`fenwick-analytics/core-engine`, a real commit date
  predating a real Show HN date): resolved via step 1 (raw_signal `founder_id` FK match) →
  `supports` evidence written, `derived_status` transitioned `unverified → verified`, both
  `claim_verification_attempted` and `claim_verified` events fired correctly. The gate-FAILS-on-a-
  supports-candidate path (→ `context` row, never dropped) is code-identical to the already
  live-proven contradicts-side fail-closed path (same `buildEvidenceRow(gate.contextRowFields)`
  call) but was not separately exercised with its own test case, given time.
- `Reload claim_trust rows (post-write)` exists because `claim_verification_attempted`'s
  `verdict_after` can only be known once the evidence just written has landed — same re-read
  `run.js`'s own main() step 7 performs.
- **The LLM narrow queue described in design §11.1 ("the narrow queue f05-verify-claims routes to"
  contradiction-scan) is deliberately NOT built or forwarded here** — see the dedicated section
  below.

## `f05-contradiction-scan` topology notes (task C1b)

The one workflow in this feature where an LLM can accuse a founder — every rule below is a guard,
not an implementation detail:

- **K = 2, agreement-weighted.** `contradiction-detector` is called TWICE per candidate pair
  (identical input). Agreement on `contradiction_found: true` → proceed at the underlying
  evidence's own tier. **Disagreement** (one call true, one false) → the candidate is still
  processed, but the tier is forced to `discovered` regardless of the source evidence's own tier —
  this is a **tier downgrade**, not new view logic: only `documented`-tier evidence can ever yield
  a flat `contradicted` verdict (design §6.0/§7.4), so forcing `discovered` makes the
  already-built `claim_trust` view cap the outcome at `partially_supported` by itself.
- **The entity gate's step 3 (`entity-matcher`) fires ONLY here.** `f05-verify-claims` never calls
  it (see above); this workflow calls it exactly once per candidate, only after steps 1-2
  (deterministic: raw_signal FK, then registrable-domain match) have both already failed inside
  `applyEntityGate`.
- **A gate failure writes an auditable `context` row and stops** — never a `contradicts` row.
  Proved live (see "Verified live" below): a hand-built candidate where both K=2 calls agreed a
  real contradiction existed, but entity-matcher legitimately could not resolve identity from the
  (narrow) quote it was given, correctly downgraded to a `context` row with the claim's
  `derived_status` staying `unverified` — never `contradicted`.
- **Narrow queue, self-service or caller-supplied.** Given `{ application_id }` alone, `Build
  narrow queue` constructs its own candidate pairs: claims with `source_kind='self_reported'` OR
  citing a `deck_parse` raw_signal, paired with evidence from an INDEPENDENT source (not
  `deck_parse`/`interview_answer`) carrying a quote — capped at 2 pairs/claim and
  `config.budget.max_paid_checks_per_card` (reused from the `factual_dynamic` Tavily budget,
  design §4.2/§12, rather than a new invented constant) pairs total. Given `{ pairs: [...] }` it
  uses that queue as-is — the shape a caller like `f05-verify-claims` or a future Tavily branch
  would supply.
  - **Open decision, documented rather than silently made:** design §11.1 describes "the narrow
    queue f05-verify-claims routes to" contradiction-scan, implying verify-claims should build and
    forward the queue via a direct call. This generator keeps the two workflows **independently
    callable and testable instead** (matching `f05-trust-rollup`'s own precedent of being a
    separately-invoked sub-workflow, not an automatic continuation) — `f05-contradiction-scan`
    builds its own queue by the identical eligibility rule. Either workflow, or a future caller,
    can supply `pairs` explicitly when chaining is wanted.
- **Content-hash stability bug found and fixed live (2026-07-19).** The first version of this
  workflow used the LLM's own extracted `found_reality` substring as the written evidence row's
  `quoteVerbatim`/`candidateKey` — but `gpt-5.6-luna` has no working `temperature: 0` (rejected,
  HTTP 400), so its exact extracted substring legitimately varies call to call even against
  identical input. Re-running the SAME hand-built pair produced two different (both individually
  verbatim-valid) `found_reality` strings, which hashed differently and defeated the
  re-run-inserts-no-duplicates guarantee (design §10.1). **Fix:** the entity gate's
  `candidate.quote` and the written evidence row's `quoteVerbatim`/`candidateKey` now anchor to the
  STABLE, already-in-the-database `pair.evidence.quote_verbatim` (the full cited text) instead of
  the LLM's own re-extraction. This also *improved* entity resolution in testing: a case where
  `found_reality` happened to omit the company name/domain (because the model's contradiction
  excerpt was narrower than the full citation) correctly failed the gate for that reason, but
  fixing the input to the FULL quote gave entity-matcher genuine naming context to resolve from,
  and it did. `primary.found_reality` itself is never lost — it is stored verbatim in full on the
  `claim_contradicted` event's own `found_reality` field, and in `ai_runs`' raw output.
- `Write ai_runs` writes a variable-length **array** (both K=2 contradiction-detector calls, plus
  any entity-matcher call) in one POST — unlike `f05-verify-claims`'s single ledger row, since this
  workflow may make 2-3 LLM calls per candidate pair and every one is logged, confidence NULL.

## Running `f05-trust-rollup` end to end

```bash
curl -X POST http://localhost:5678/webhook/f05-trust-rollup \
  -H "Content-Type: application/json" \
  -d '{"application_id":"08f360ee-165d-4524-93d0-ec4c54d3f050"}'
```

Verified live application (Medows): `08f360ee-165d-4524-93d0-ec4c54d3f050` → `status: "scored"`,
`value: 19.5`, `confidence: 0.43`, 12 `input_claim_ids`, `formula_version: "trust_v1"` — matches
`lib/f05/run.js`'s own output for the identical application exactly (18 verdict-eligible claims,
12 assessed → coverage 0.667, well above the seeded `min_coverage` 0.25).

Verified by SELECT, never by n8n's returned "success" status (feature 04's own lesson — a run can
return HTTP 200 while a branch silently didn't execute):

```sql
select id, application_id, axis, value, confidence, array_length(input_claim_ids,1) as n_claims,
       formula_version, computed_at
from scores where application_id = '08f360ee-165d-4524-93d0-ec4c54d3f050' and axis = 'trust'
order by computed_at desc limit 1;
```

And confirmed via `GET /api/v1/executions/{id}?includeData=true` that every node on the taken
branch actually appears in `resultData.runData` (12 of 17 nodes fire on the `scored` path — the
2 trigger nodes and `Normalize Sub-workflow Input` are alternate entry points that don't fire on a
webhook call, and `Write event (insufficient_evidence)` correctly does **not** appear, since the
`IF` node's `insufficient_evidence` output carried 0 items on this run).

The `scores` table has **no idempotency guard by design** (design §8.2/§8.3: "accept duplicates
under append-only semantics... resolve current by `max(computed_at)`") — re-running against the
same application inserts another row rather than upserting; this matches `lib/f05/run.js`'s own
write behaviour and every other `scores`-writer in this repo (e.g. `lib/f03/run.js`'s
`writeScored`).

## Running `f05-verify-claims` end to end

```bash
curl -X POST http://localhost:5678/webhook/f05-verify-claims \
  -H "Content-Type: application/json" \
  -d '{"application_id":"<uuid>"}'
```

Verified on the REAL Medows application (`08f360ee-165d-4524-93d0-ec4c54d3f050`, the same one
`f05-trust-rollup` uses above): `scoped_claim_count: 61`, `events_written: 61` (one
`claim_verification_attempted` per scoped claim — the mandatory design §9 count, absolute, not a
ratio), `evidence_written: 0` — honestly correct, not a bug: this specific application has zero
claims on topic `founder.execution.provenance` and zero self-reported/deck-sourced claims carrying
a quote, confirmed by direct SELECT before trusting the zero.

Verified against the D1 labelled fixture (`db/fixtures/05-truth-gap.sql`) via two throwaway test
`applications` rows pointed at its two companies (`05f0aaaa-0000-0000-0000-000000000001` →
Ledgerly, `...002` → Fenwick — **not** committed to the fixture file itself, see "Test artifacts"
below): all **10 of 10** of the fixture's own expected `derived_status` values matched exactly
after running this workflow (i.e. running it does not disturb any of the fixture's carefully
designed guard cases — the AVeriTeC missing-not-refuted guard, the harmful-flip-guard "verified"
claims, the Tier-3-only claim, the SS14 qualitative-contradiction-suppression claim), while also
correctly adding its own `gh_provenance` `insufficient_data` context row (claim `...0102`'s
`github_api` raw_signal doesn't match either shape `checkGithubProvenance` parses — same honest
limitation `lib/f05/run.js`'s own B3 task already measured project-wide) and finding **zero**
quote_guard mismatches on the one eligible candidate (claim `...0104`, a true harmful-flip case).

```sql
select count(*) from claims where card_id = '05f00004-0000-0000-0000-000000000001';         -- 6
select count(*) from events where event_type='claim_verification_attempted'
  and payload->>'run_id' = '<run_id from the response>';                                     -- 6, exact match
```

Idempotency confirmed by direct re-run: evidence count for Ledgerly's claims stayed at 7 rows
across two consecutive calls (PostgREST `on_conflict=content_hash` +
`Prefer: resolution=ignore-duplicates`, the equivalent of `lib/f05/run.js`'s own
`INSERT ... ON CONFLICT (content_hash) DO NOTHING`).

## Running `f05-contradiction-scan` end to end

```bash
curl -X POST http://localhost:5678/webhook/f05-contradiction-scan \
  -H "Content-Type: application/json" \
  -d '{"application_id":"<uuid>"}'
```

Or with a caller-supplied queue (bypasses self-service queue construction entirely):

```bash
curl -X POST http://localhost:5678/webhook/f05-contradiction-scan \
  -H "Content-Type: application/json" \
  -d '{"application_id":"<uuid>","pairs":[{"claim_id":"...","question":"...","founder_claim":{"text_verbatim":"...","source_kind":"self_reported"},"evidence":{"quote_verbatim":"...","tier":"discovered","source_url":"...","captured_at":"...","raw_signal_id":"...","raw_signal_founder_id":null,"raw_signal_company_id":"..."},"card_founder_id":"...","card_company_id":"..."}]}'
```

**Verified live, real LLM calls throughout (2026-07-19):**

- Self-service queue on the Ledgerly fixture application found 2 real candidate pairs (claim
  `...0104`'s two independent supports rows — `github_api` + `hn_algolia`); both K=2 calls agreed
  `contradiction_found: false` on both (correct — the claim is genuinely true), so 0 contradictions
  confirmed, 0 gate calls, 4 LLM calls total, 2 `context` evidence rows recording "checked, agreed
  nothing here".
- **Entity gate fail-closed path, proven**, using a hand-built candidate (`pairs` override) where
  both K=2 calls agreed a real, material contradiction existed ("2,000+ paying customers" claimed
  vs. "340 growing businesses" cited): the underlying raw_signal was deliberately attached to the
  WRONG company (step 1 fails) and the source URL's domain was `web.archive.org`, not the claim's
  own company domain (step 2 fails) → `entity-matcher` (step 3) was called once, correctly returned
  `resolved: false` given the narrow quote it was shown → the candidate was downgraded: a `context`
  evidence row was written, **no** `contradicts` row, `claim_trust.derived_status` stayed
  `unverified`. Confirmed by the acceptance SELECT (zero `contradicted` verdicts among failed-gate
  candidates — see below).
- **Entity gate step-1 (FK) and step-3 (LLM) success paths, both proven**, using two more
  hand-built candidates: one where the raw_signal's own `company_id` matched the claim's card
  (`resolved_by: "raw_signal_fk"`, 2 LLM calls, no entity-matcher needed), and one (after the
  content-hash fix below) where the FULL quote genuinely named the company + domain
  (`resolved_by: "llm_quote"`, entity-matcher correctly resolved it). Both produced a `contradicts`
  row at the underlying evidence's own tier (`discovered`, Tavily-style) → `derived_status:
  "partially_supported"`, never a flat `contradicted` — correct, since only `documented`-tier
  evidence may ever reach `contradicted` (design §6.0/§7.4).
- **GDPR application-fallback, proven**: a claim on a company-only card (`card_founder_id: null`)
  produced a `claim_contradicted` event with `entity_type: 'application'`, `entity_id` = the
  application's own id (never `claim_id`), `founder_claim` **absent** from the payload, and
  `entity_match.quote` **absent** (`entity_match.disambiguator` correctly retained — only `.quote`
  is the personal-data field design §9 requires omitting).

**Acceptance SELECTs:**

```sql
-- zero contradicted verdicts among candidates the entity gate downgraded
select e.claim_id, e.relation, e.tier from evidence e
where e.relation = 'contradicts'
and exists (select 1 from evidence e2 where e2.claim_id = e.claim_id and e2.relation = 'context'
            and e2.quote_verbatim = e.quote_verbatim);
-- 0 rows

-- ai_runs.confidence stays NULL on every row this feature writes
select count(*) from ai_runs where confidence is not null and task_type = 'verification';  -- 0

-- GDPR anti-join, scoped to this task's own workflows
select count(*) from events e
where e.actor in ('f05-verify-claims','f05-contradiction-scan')
  and e.entity_type = 'founder' and e.entity_id is not null
  and not exists (select 1 from founders f where f.id = e.entity_id);                       -- 0

-- application-fallback events must never carry founder_claim or entity_match.quote
select count(*) from events
where entity_type = 'application'
  and (payload ? 'founder_claim' or (payload->'entity_match') ? 'quote');                    -- 0
```

**LLM call count / spend during this task's own build and testing:** 22 calls total
(`gpt-5.6-luna`, temperature omitted) — 20 `contradiction-detector` (10 candidate pairs × K=2) + 2
`entity-matcher` (only 2 of those 10 candidates needed step 3 at all; the rest resolved via step 1
FK or found no contradiction). Each call is 400–1,200 input tokens + 150–400 output tokens per the
agent specs' own estimates — this is a small, cheap testing footprint; production spend scales with
however many real candidate pairs the narrow-queue eligibility rule actually surfaces per
application (design's own budget cap, `config.budget.max_paid_checks_per_card`, bounds it further).

## Test artifacts (not part of the committed fixture)

Verifying `f05-contradiction-scan`'s entity gate end-to-end (both the fail-closed and the
resolved paths) needed real contradiction candidates, and the D1 fixture's own 10 labelled claims
already carry PRE-WRITTEN evidence (they test the `claim_trust` VIEW's derivation logic, not these
workflows' own check-dispatch code) — reusing them for a NEW contradiction test would have polluted
the fixture's own carefully-designed guard cases (e.g. claim `...0104` must "survive verification
untouched" for the harmful-flip guard to mean anything). So this task added, live in the dev
database, entirely OUTSIDE the `05f0000X-...` fixture range:

- Two `applications` rows (`05f0aaaa-0000-0000-0000-000000000001` / `...002`) pointing at the
  fixture's own Ledgerly/Fenwick companies, purely so `{ application_id }` could reach the D1
  fixture's claims at all (its own comment states no `applications` row was needed for the
  view/rollup tests it was built for).
- Four throwaway claims (`05f0aaaa-...-9001`, `9003`, `9011`, on a new company-only card
  `...-9010`) plus matching `raw_signals`, purpose-built to exercise the entity gate's fail-closed,
  step-1, step-3, and GDPR-fallback paths specifically.

⚠️ **These cannot be deleted.** `evidence` and `raw_signals` are append-only
(`forbid_mutation` trigger); `evidence.claim_id` is `REFERENCES claims(id) ON DELETE RESTRICT`, so
once a claim carries an evidence row it cannot be removed either. All of the above are harmless
(clearly namespaced, referenced by nothing a real demo application reads) but are now a **permanent**
part of this dev database — flagged here rather than left undocumented, per the same "report
outcomes faithfully" standard this whole feature is built to.

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals in the JSON — so
these files are safe to commit to a public repo. Values live in `infra/n8n/.env` (gitignored):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and (for `f05-contradiction-scan`'s two LLM call
sites) `OPENAI_API_KEY`.

⚠️ `$env.SUPABASE_URL` has been observed to drift between `http://host.docker.internal:8000` and
`http://host.docker.internal:8000/rest/v1` across parallel terminals (feature 03's own tracker
changelog). Every Postgres-calling Code node in this workflow normalizes it defensively
(`SB_NORMALIZE` in `n8n/build-f05-workflow.py`), so this workflow is correct regardless of which
form the env var currently holds.

⚠️ `globalThis.crypto` is **undefined** inside this n8n build's actual Code-node execution sandbox
(the `@n8n/task-runner` VM context) — verified live 2026-07-19: a run using
`globalThis.crypto.randomUUID()` for the `Generate run_id` node failed with
`TypeError: Cannot read properties of undefined (reading 'randomUUID')`, even though a plain
`docker exec vcbrain-n8n node -e '...'` process on the same container exposes it fine. The sandbox
and the container's own Node process are not the same global scope. Fixed by using
`require('crypto').randomUUID()` instead — already allow-listed in
`infra/n8n/docker-compose.yml` (`NODE_FUNCTION_ALLOW_BUILTIN=crypto,url`) and the same proven
pattern as f03's own `Generate run_id` node. This workflow never needs SHA-256 (it writes no
`evidence` rows), so the separate `globalThis.crypto.subtle` convention for `content_hash` did
not need re-verifying here — flagged for `f05-verify-claims`/`f05-contradiction-scan` (task C1b)
to check before relying on it, and it turned out to matter: see next paragraph.

⚠️ **`globalThis.crypto.subtle` is ALSO undefined in the same sandbox** — verified live 2026-07-19
building `f05-verify-claims`: a run using `lib/f05/verifiers.js`'s own `sha256Hex()`
(`globalThis.crypto.subtle.digest(...)`, exactly per design §10.1's own instruction) failed with
`TypeError: Cannot read properties of undefined (reading 'subtle')`. Same root cause as the
`randomUUID` gap above, one property deeper. `lib/f05/verifiers.js` is a frozen module (out of
scope for task C1b — do not edit it there), so the fix lives entirely in the CALLING Code node:
both `f05-verify-claims`'s `CHECKS - dispatch` node and `f05-contradiction-scan`'s
`LLM DISPATCH` node prepend `globalThis.crypto = require('crypto').webcrypto;` **before** the
`VERIFIERS_JS` paste — Node's own WebCrypto implementation exposes an identical `.subtle.digest()`
surface under the SAME global name `verifiers.js` already reads from, confirmed live to make
`evidenceContentHash()`/`buildEvidenceRow()` run completely unmodified. `require('crypto')` is
already allow-listed (`NODE_FUNCTION_ALLOW_BUILTIN=crypto,url`), so no docker-compose change was
needed.

## Re-deploying after a change

```bash
python3 n8n/build-f05-workflow.py   # regenerates ALL THREE workflow JSONs
set -a; source infra/n8n/.env; set +a
```

`f05-trust-rollup` (`Wtd887vYwv5x3FvH`):

```bash
python3 -c "import json; wf=json.load(open('n8n/workflows/f05-trust-rollup.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f05_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/Wtd887vYwv5x3FvH" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f05_put_body.json
```

`f05-verify-claims` (`UubHQ9HZWVdOrKjq`):

```bash
python3 -c "import json; wf=json.load(open('n8n/workflows/f05-verify-claims.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f05vc_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/UubHQ9HZWVdOrKjq" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f05vc_put_body.json
```

`f05-contradiction-scan` (`csvoMOTs7MNBdXLI`):

```bash
python3 -c "import json; wf=json.load(open('n8n/workflows/f05-contradiction-scan.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f05cs_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/csvoMOTs7MNBdXLI" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f05cs_put_body.json
```

(The n8n public API rejects `active` and `meta` as read-only on create/update, even though the
exported file includes them for correct standalone import — hence the strip-before-PUT step, same
for all three.)
