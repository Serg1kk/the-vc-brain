# Feature 06 workflows — investment memo & $100K decision

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f06-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f06-workflow.py --check   # check only, no write
```

The deterministic core lives in `lib/f06/{context,decision,assemble}.js`, unit-tested outside n8n
(`node --test lib/f06/*.test.js` — 109 tests: 35 context, 43 decision, 31 assemble). n8n's
Code-node sandbox cannot `require()` a repo file, so this generator pastes each module's body
**verbatim** into the Code node that needs it (`module.exports` and every `'use strict';` stripped
— see the generator's own `_strip_use_strict()` docstring for why the latter is load-bearing, not
cosmetic). Editing the JSON directly makes the tested module and the running workflow drift apart
— the exact class of silent divergence this generator exists to prevent.

The four LLM section-writer agents (system prompt + JSON schema) are pulled straight out of
`docs/backlog/06-memo-decision/agents/*`, never retyped by hand. Design source of truth:
`docs/backlog/06-memo-decision/design.md` (§5 is the node graph this generator was built against).

## Registered workflow

| Workflow | id | Nodes | Status |
|---|---|---|---|
| `f06-generate-memo` | *(pending — not yet deployed)* | 19 | generated, syntax-checked, **not deployed** |

Deploy/verify/git is @devops's job (plan.md task T6), not this generator's — see "First deploy"
below.

## Node graph (design.md §5)

```
Webhook  POST /webhook/f06-generate-memo  { application_id, thesis_id? }
  -> Normalize Webhook Input   (Code -- extracts application_id, generates run_id)
  -> Context pack [A]          (Code, deterministic -- lib/f06/context.js §3; also builds the
  |                              4 per-agent pack_slice payloads, agents/README.md's shared
  |                              input contract)
  -> IF: pack error?
       true  -> Respond: pack error (404)                                  [no downstream]
       false -> fan out to all four LLM section-writers (ALL FOUR ALWAYS RUN, design §5.3):
                  LLM: memo-descriptive (B1)    -> snapshot, problem_product, traction
                  LLM: memo-analytical  (B2)    -> hypotheses, swot
                  LLM: memo-optional    (B3)    -> risk_matrix, competition, financials_lite
                                                    (sentinel {_sentinel:true,...:null} when
                                                    no qualifying input)
                  LLM: deep-dive-questions (B4) -> deep_dive_questions
                -> Merge   (real n8n-nodes-base.merge, typeVersion 3.2, mode:'append',
                            numberInputs:4 -- branch i -> input i)
                -> Decision [C]      (Code, deterministic -- lib/f06/decision.js §8, decide())
                -> Assemble + write [D]  (Code -- lib/f06/assemble.js §9: merge by key, back-fill
                |                         required sections, citation gate, typed-exception guard,
                |                         version read + INSERT + memo_generated event)
                -> IF: assemble error?
                     true  -> Respond: assemble error (422)
                     false -> Respond: success (200)  { memo_id, application_id, version,
                                                         recommendation }
```

`responseMode: 'responseNode'` (not `'lastNode'`) — same deliberate deviation
`n8n/workflows/README-f08.md` documents for the same reason: `web/src/lib/api.ts`'s `request()`
throws on `!res.ok`, reading `error.code`/`error.message` off a non-2xx status only. `lastNode`
mode can only ever emit HTTP 200, which would make this workflow's 404/422 paths unreachable by
any future caller.

## Design-ambiguity resolutions made while building this generator

Flagged here, not silently assumed:

1. **`deep-dive-questions` has no `*-json-schema.json` file in this repo** (the other three agents
   each ship one; this directory has only `deep-dive-questions-prompts.txt`). Reconstructed in
   `build-f06-workflow.py` (`QUESTIONS_SCHEMA_RAW`) from two sources that agree byte-for-byte on
   the shape: the prompt's own `## OUTPUT FORMAT` block and design.md §4.3's frozen
   `deep_dive_questions` column shape. No `minItems`/`maxItems` (§4.3 says "5-7 items", but OpenAI
   strict mode rejects array-length keywords — `docs/backlog/TRACKER.md` 2026-07-19 ~11:20); the
   prompt's own instruction ("Cap at 7") is the sole enforcement, matching every other agent here.
2. **`strict:true`, not `strict:false`.** 02/03/04/05 all use `strict:false` for their own
   `json_schema` response_format calls; this feature's own `agents/README.md` explicitly asks for
   `strict:true` + a recursive `strictify()` (this generator's version, independently
   re-implementing `build-f08-workflow.py`'s `sanitize_schema_for_strict_mode()` widened to the
   TRACKER entry's full keyword list). Verified structurally (not against the live API — no
   deployed instance to call for this task): every one of the four post-`strictify()` schemas has
   `additionalProperties:false` and `required` == `properties` keys on every object, recursively,
   and no `oneOf`/`allOf`/`min*`/`max*`/`pattern`/`format` anywhere.
3. **`(application_id, version)` 23505-race retry — UNVERIFIED LIVE.** `Assemble + write`'s
   `isUniqueViolation()` is a best-effort match against every shape PostgREST's `{code:"23505",
   ...}` body has been seen to surface as elsewhere in this codebase, plus a message-substring
   fallback. No deployed n8n instance was available to this task to trigger a real concurrent
   `f06-generate-memo` submit for the same `application_id` and confirm the thrown error's exact
   shape. **Flagged to @devops/@qa-engineer:** confirm this against a real race before relying on
   it in the demo; if it's wrong, the symptom is a spurious `23505` bubbling up as an uncaught
   node error on the (rare) regeneration race, not a silent data-integrity bug.
4. **Two HTTP status classes only (404, 422), not a fully-enumerated code table.** design.md §10
   specifies "404-shaped" for application-not-found; it does not specify a status for a citation-
   gate/typed-exception-guard rejection. `Respond: pack error` (404) covers both `not_found` and
   `bad_request` (missing `application_id`) — a purist would want 400 for the latter; folded into
   one branch to keep the graph minimal per the task brief's exact node list, not gold-plated.
   `Respond: assemble error` (422) is this generator's own choice for a well-formed request that
   fails content validation.
5. **LLM-node failure -> graceful degradation, not a hard crash.** Each `[B]` node's `try/catch`
   falls back to an empty/sentinel object on any request/parse failure (`{}` for B1/B2,
   `{_sentinel:true,...:null}` for B3, `{deep_dive_questions:[]}` for B4) rather than throwing and
   failing the whole n8n execution with no HTTP response. This is the same posture spec-review
   should-fix #1 put into `lib/f06/assemble.js` (task A of this build — see below): a missing
   required section from ANY cause, including an LLM-node outage, is back-filled by `[D]`, never a
   whole-memo failure. Not explicitly specified in the node graph brief; added because the back-fill
   guarantee is hollow if an upstream node can still crash the execution before `[D]` ever runs.

## Task A — `lib/f06/assemble.js` patch (spec-review should-fix #1)

`checkRequiredSections()` (a hard gate) was replaced with `backfillRequiredSections()` (never
rejects): a missing/empty required section — any of `snapshot`/`hypotheses`/`problem_product`/
`traction`, or any of `swot`'s four arrays — gets exactly one deterministic `structural` statement
inserted (fixed text, `claim_ids:[]`, no `$`/digit, so it can never trip the typed-exception guard)
instead of failing the whole memo. Only the citation gate and the typed-exception guard can still
return `{error}`. `lib/f06/assemble.test.js` updated to match (28 -> 31 tests, all green): the
three old "-> rejection" cases became "-> back-filled with a structural line" assertions, plus a
new `backfillRequiredSections` direct-call suite and an empty-pack-memo acceptance test
(design.md §10's "no claims at all still writes a memo" edge case).

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals — safe to commit.
Values live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`OPENAI_API_KEY`. `gpt-5.6-luna` (all four section-writer agents) omits `temperature` entirely
(rejects `0` — the same cross-feature rule 03/04/05/08 already documented).

## First deploy

```bash
set -a; source infra/n8n/.env; set +a
python3 -c "
import json
d = json.load(open('n8n/workflows/f06-generate-memo.json'))
# n8n's public API rejects active/pinData/meta/id/versionId/tags as read-only on create
# (n8n/README-f08.md's own note) -- strip before POST.
payload = {k: v for k, v in d.items() if k in ('name', 'nodes', 'connections', 'settings')}
json.dump(payload, open('/tmp/f06-generate-memo_post.json', 'w'))
"
curl -s -X POST "http://localhost:5678/api/v1/workflows" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f06-generate-memo_post.json | python3 -c \
     "import json,sys; d=json.load(sys.stdin); print('f06-generate-memo', d.get('id'), d.get('message'))"
# Record the returned id in this README's table above, then activate it:
# curl -X POST "http://localhost:5678/api/v1/workflows/<id>/activate" -H "X-N8N-API-KEY: $N8N_API_KEY"
```

## Re-deploying after a change (once an id exists)

```bash
python3 n8n/build-f06-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "
import json
d = json.load(open('n8n/workflows/f06-generate-memo.json'))
payload = {k: v for k, v in d.items() if k in ('name', 'nodes', 'connections', 'settings')}
json.dump(payload, open('/tmp/f06-generate-memo_put.json', 'w'))
"
curl -s -X PUT "http://localhost:5678/api/v1/workflows/<id>" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f06-generate-memo_put.json | python3 -c \
     "import json,sys; d=json.load(sys.stdin); print('f06-generate-memo', d.get('id'), d.get('message'))"
```

## Runbook note (design.md §10)

`f05-trust-rollup` must have already run for the target `application_id`, or the `trust` axis
reads as not-assessed and `Decision` [C] fires `D3` (`watchlist`) on every application — this is
the honest, correct behaviour (I2: absent is never zero), not a bug, but it means a demo walkthrough
should run `f05-trust-rollup` first if a `proceed`/`pass` recommendation is the point being shown.
