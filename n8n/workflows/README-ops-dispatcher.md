# ops-diligence-dispatcher — automatic diligence-chain scheduler

**Do not hand-edit the JSON as generated code.** Unlike the feature (`f0N-*`) workflows in this
directory, this one has no `lib/*.js` generator behind it — it is a thin ops/scheduling workflow,
hand-authored to match the HTTP-node and PostgREST-parsing conventions established in
`f04-market-intel.json` (see `README-f04.md`). If you change it, edit the JSON directly and
re-deploy per "Deploy / activate" below.

## Purpose

The diligence stage (`f04-market-intel` → `f05-verify-claims` → `f05-contradiction-scan` →
`f05-trust-rollup` → `f06-generate-memo`) is otherwise manual: an operator has to `curl` each of
those five webhooks in order, by hand, for every application that reaches `status='screening'`.

`ops-diligence-dispatcher` runs on a **Schedule Trigger, every minute**, and automates exactly
that hand sequence for **one application per tick**:

1. Find applications that are `status='screening'`, created **after the CUTOFF constant** (see
   below), that don't already have a `scores(axis='market')` row and haven't already been picked
   up by an earlier tick.
2. Write a `diligence_dispatched` guard event **before** calling anything, so an overlapping next
   tick can never double-pick the same application.
3. Call the five diligence webhooks in order, each with `{ "application_id": "<uuid>" }`, tolerating
   individual step failures (`onError: continueRegularOutput`) so one bad step doesn't abort the
   rest of the chain.
4. Write a `diligence_completed` guard event when the chain finishes.

If there is no eligible application on a given tick, the workflow takes a clean no-op path
(`Candidate found?` → `STOP: no candidates`) and ends — this is the expected, normal outcome most
minutes.

## The CUTOFF constant — why it exists and what it is

```
CUTOFF = 2026-07-19T12:12:55Z
```

Hardcoded into the `GET pending applications` node's URL expression (`created_at=gt.<CUTOFF>`).

**Why:** the local database has ~10 old QA-fixture applications sitting in `status='screening'`
with no market score, left over from earlier feature QA rounds (`db/apply.sh` seeds and
subsequent manual testing). Without a cutoff, the very first tick after deploying this workflow
would silently mass-process that entire backlog — five OpenAI/Tavily-calling webhooks fired per
fixture, against data nobody asked to re-diligence. The CUTOFF pins the dispatcher to **only ever
pick up applications submitted after this workflow was deployed**, never the pre-existing backlog.

If you redeploy this workflow later (e.g. after a `db` reset, or to pick up a code change), **you
must bump CUTOFF to a fresh timestamp at redeploy time** — otherwise whatever accumulated in
`screening` since the last deploy becomes an instant backlog dump on the next tick. There is no
mechanism that infers "now" at deploy time; it is a literal string baked into the JSON.

## The event guard — why the dispatch event is written *before* the chain

`f04-market-intel` alone can run 1–4 minutes end to end (Tavily search + extract + two OpenAI
calls, see `README-f04.md`); the full five-step chain is comfortably longer than the one-minute
tick interval. Ticks *will* overlap in flight. The `Pick next candidate` node excludes any
application that already has a `diligence_dispatched` event (`GET dispatch guard events`,
`event_type=eq.diligence_dispatched&entity_type=eq.application`) — and the `POST guard event
(diligence_dispatched)` node writes that event **as the very first side effect of the true
branch**, before any of the five webhook calls fire. That ordering is what makes the guard work:
if the guard write happened after the chain (or not at all), a second tick starting while the
first is still mid-chain would see no guard event yet and pick the same application again.

`diligence_completed` is written at the end for observability (a way to see, from `events` alone,
which applications finished vs. are still mid-chain vs. never started) — it is not read by any
guard logic in this workflow.

Both events are matched against `db/schema.sql`'s `events` table shape exactly:
`event_type`, `entity_type`, `entity_id`, `payload` (jsonb, default `{}`), `actor`. No other
columns are required (`id`, `created_at` are defaulted by the table).

## Node graph

```
Schedule: every minute (cron * * * * *)
  → GET pending applications         (status=eq.screening, created_at=gt.<CUTOFF>)
  → Extract pending applications     (Code: parse PostgREST text response)
  → GET market scores                (axis=eq.market, application_id=not.is.null)
  → Extract market scores            (Code)
  → GET dispatch guard events        (event_type=eq.diligence_dispatched, entity_type=eq.application)
  → Extract dispatch guard events    (Code)
  → Pick next candidate              (Code: pending − scored − dispatched, oldest first, take exactly one)
  → Candidate found? (IF)
      ├─ true  → POST guard event (diligence_dispatched)
      │            → Carry application_id (post-guard)
      │            → POST /webhook/f04-market-intel        (timeout 300s, onError continueRegularOutput)
      │            → Carry application_id (post-f04-market-intel)
      │            → POST /webhook/f05-verify-claims        (timeout 120s, onError continueRegularOutput)
      │            → Carry application_id (post-f05-verify-claims)
      │            → POST /webhook/f05-contradiction-scan   (timeout 180s, onError continueRegularOutput)
      │            → Carry application_id (post-f05-contradiction-scan)
      │            → POST /webhook/f05-trust-rollup          (timeout 120s, onError continueRegularOutput)
      │            → Carry application_id (post-f05-trust-rollup)
      │            → POST /webhook/f06-generate-memo          (timeout 300s, onError continueRegularOutput)
      │            → Carry application_id (post-f06-generate-memo)
      │            → POST completion event (diligence_completed)
      └─ false → STOP: no candidates (NoOp)
```

23 nodes total. Every `Carry application_id (post-*)` node discards whatever the previous HTTP
call returned and rebuilds `{ application_id }` from `$('Pick next candidate')` — the five webhook
calls have different response shapes (and may have errored, per `onError`), so nothing downstream
ever reads a webhook's own response body; `application_id` is the only thing threaded through the
whole chain.

The three `GET .../Extract ...` pairs follow `f04-market-intel.json`'s established convention
exactly: every PostgREST `httpRequest` node sets `options.response.response.responseFormat: "text"`
and the following Code node does its own `JSON.parse(item.json.data)` with a `try/catch` — never
relying on n8n's built-in array-unwrapping for an HTTP response, which that workflow's own
comments document as inconsistent (0 items vs. 1 item with `json={}`) for empty-array PostgREST
responses.

### Why an IF/NoOp guard instead of returning an empty array from "Pick next candidate"

The spec allowed either. This workflow uses the same `IF → NoOp` pattern as
`f04-market-intel.json`'s `Application found?` / `STOP: application not found`, not the
empty-array approach, because several Code nodes downstream of "Pick next candidate" (the `Carry
application_id (post-*)` nodes, and "Pick next candidate" itself) call `$input.first()` /
`$('Pick next candidate').first()` — which throws if 0 items reach it. "Pick next candidate"
therefore always emits exactly 1 item (`candidate_found: true|false`), and `Candidate found?`
branches explicitly, mirroring the codebase's proven convention rather than depending on n8n's
zero-item propagation semantics holding for a Code-node-heavy chain.

## Cost bound: one application per tick

`Pick next candidate` takes exactly one candidate, oldest `created_at` first, even if several are
eligible. Combined with the every-minute schedule this drains a queue of N eligible applications
over N ticks (worst case ~N minutes, bounded by the slowest step — `f04-market-intel` or
`f06-generate-memo` at up to 300s) rather than firing five OpenAI/Tavily-calling webhooks per
application all at once. This keeps API spend per tick predictable regardless of queue depth.

## Deploy / activate (any instance)

```bash
set -a; source infra/n8n/.env; set +a

# Create (first deploy only — this file has no id baked in from server yet)
curl -s -X POST "http://localhost:5678/api/v1/workflows" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @n8n/workflows/ops-diligence-dispatcher.json

# Activate (use the "id" from the create response above)
curl -s -X POST "http://localhost:5678/api/v1/workflows/<id>/activate" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json"
```

Local instance deployed id: **`YzzELyQ354kR4jJf`**.

**Before re-deploying to a fresh/reset instance:** bump the `CUTOFF` constant in the `GET pending
applications` node's `url` expression to the current UTC time (see "The CUTOFF constant" above) —
do not reuse an old timestamp, or the first tick after deploy will mass-process whatever backlog
has accumulated in `screening` since that old timestamp.

**Prerequisite:** the five webhooks this workflow calls
(`f04-market-intel`, `f05-verify-claims`, `f05-contradiction-scan`, `f05-trust-rollup`,
`f06-generate-memo`) must themselves be **active** on the target instance — this workflow calls
their `POST /webhook/<name>` production URLs, not their test URLs. Check with:

```bash
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" http://localhost:5678/api/v1/workflows \
  | python3 -c "import json,sys; [print(w['name'], w['active']) for w in json.load(sys.stdin)['data']]"
```

## Disable

```bash
set -a; source infra/n8n/.env; set +a
curl -s -X POST "http://localhost:5678/api/v1/workflows/YzzELyQ354kR4jJf/deactivate" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json"
```

Deactivating stops the Schedule Trigger from firing (no new ticks); it does not cancel a
diligence chain already mid-flight on a tick that already started. There is no separate
"pause" state — deactivate is the only stop control.

## Credentials

Same convention as every other workflow in this directory (`README-f04.md`): secrets are
container env vars referenced as `$env.*` in nodes, never literals — `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`. The five self-calls to `http://localhost:5678/webhook/<name>` need
no credentials — they're plain HTTP within the same container, and the target webhooks don't
require auth (they run inside the trusted local n8n instance).
