# Feature 05 workflow — Trust Score rollup

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f05-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f05-workflow.py --check   # check only, no write
```

The deterministic core lives in `lib/f05/trust.js` (`computeTrustRollup`), unit-tested outside
n8n. n8n Code nodes cannot `require` local files, so that source is **inlined** into the ROLLUP
node by the generator (only the trailing CommonJS `module.exports` line is stripped — the
sandbox has no `module` global). Editing the JSON directly makes the tested module and the
running workflow drift apart — the exact class of silent divergence this generator exists to
prevent (same rationale as `n8n/build-f03-workflow.py`).

This is **the only workflow feature 06 is blocked on** (plan.md task C1a). It does not run any
of feature 05's evidence-writing checks (`gh_provenance`, `quote_guard`) — those live in the
separate `f05-verify-claims` / `f05-contradiction-scan` workflows (task C1b). This workflow only
reads whatever `claim_trust` already shows and rolls it up: zero LLM, zero writes to `evidence` or
`claims`.

## Registered workflow

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f05-trust-rollup` | `Wtd887vYwv5x3FvH` | 12 code/DB nodes + 1 IF + 2 triggers + 2 sticky notes (17 total) | Given `{ application_id }`: resolve scope (design §8.1) → load `claim_trust` rows in scope → `computeTrustRollup()` → write one `scores(axis='trust')` row, or (below `min_coverage`) write no row and emit a `trust_rollup_insufficient_evidence` event instead. |

Entry points: `POST /webhook/f05-trust-rollup` with `{ "application_id": "<uuid>" }`, or as an
Execute-Workflow sub-workflow call from another workflow with the same input shape (06/09/10 will
call it this way once they exist).

## Topology notes

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
  is a thin PostgREST read/write, hand-written per this workflow's own shape (no other `lib/f05/*`
  module applies to a pure rollup — router/verifiers/quote_guard/entity_gate belong to
  `f05-verify-claims`, task C1b).

## Running one application end to end

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

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals in the JSON — so
these files are safe to commit to a public repo. Values live in `infra/n8n/.env` (gitignored):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

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
`evidence` rows), so the separate `globalThis.crypto.subtle` convention for `content_hash` does
not apply here — noted for whoever builds `f05-verify-claims` (task C1b) next, since that
workflow will need to re-verify whether the same sandbox gap affects `crypto.subtle` before
relying on it.

## Re-deploying after a change

```bash
python3 n8n/build-f05-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "import json; wf=json.load(open('n8n/workflows/f05-trust-rollup.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f05_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/Wtd887vYwv5x3FvH" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f05_put_body.json
```

(The n8n public API rejects `active` and `meta` as read-only on create/update, even though the
exported file includes them for correct standalone import — hence the strip-before-PUT step.)
