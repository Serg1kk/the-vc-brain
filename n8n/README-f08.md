# Feature 08 workflows — Founder Intake

**Do not hand-edit the JSON in this directory.** All six workflows are generated:

```bash
python3 n8n/build-f08-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f08-workflow.py --check   # check only, no write
```

The deterministic core lives in `lib/f08/{validate,identity,hashing,gaps,completeness}.js`,
unit-tested outside n8n. n8n Code nodes cannot `require()` a repo file, so this generator pastes
each source file verbatim into the Code nodes that need it (module.exports stripped). The two
AI components (`deck-claims-extractor`, `gap-question-phraser`) have their system prompts and
JSON schemas pulled straight out of `docs/backlog/08-founder-intake-interview/agents/*`, never
retyped by hand. Spec this generator was built against:
`docs/backlog/08-founder-intake-interview/n8n-spec.md`.

## Registered workflows

| Workflow | id | Nodes | Priority | Status |
|---|---|---|---|---|
| `f08-intake-submit` | `AOSJGp1WtyklOg8A` | 53 | 1 (critical path) | **built, deployed, verified live** |
| `f08-gap-answers` | `NozMliP7TSLCQNrc` | 22 | 2 (headline claim) | **built, deployed, verified live** |
| `f08-application-status` | `S2GGy48ZGPoKtcPr` | 13 | 3 | **built, deployed, verified live** |
| `f08-followup-create` | `eWIitXaz1kfCMjKY` | 22 | 4 (lowest, not cut) | **built, deployed, verified live** |
| `f08-followup` | `faIkBLyDGdiXTQpY` | 15 | 4 (lowest, not cut) | **built, deployed, verified live** |
| `f08-followup-answers` | `mu172HUPZJSzYGSh` | 22 | 4 (lowest, not cut) | **built, deployed, verified live** |

All six are active on the running instance and were exercised against real data (a real PDF
pitch deck, a real OpenAI call on both models, a real founder → gap-answer → follow-up →
`card_completeness` journey 0.00 → 0.81 → 1.00). Nothing was cut.

Entry points (all under `http://localhost:5678/webhook/...`, matching `lovable-brief.md` §4
verbatim):

- `POST /f08-intake-submit`
- `POST /f08-gap-answers`
- `GET /f08-application-status?application_id=<uuid>`
- `POST /f08-followup-create` — **not** a frozen `lovable-brief.md` contract (that document only
  specifies the founder-facing GET/POST pair below). This is the minimal manager-side token
  producer `plan.md` T19 calls for so the other two have a real row to exercise against, ahead of
  feature 09's real dashboard. Input: `{application_id, asked_by?, note?}`. Output:
  `{token, questions, estimated_minutes}` — `token` is the only place the raw (unhashed) share
  token is ever returned.
- `GET /f08-followup?token=<token>` (never consumes)
- `POST /f08-followup-answers` (consumes the token)

## Deviation from 02/03/04/07's own convention — and why

Every prior workflow's webhook uses `responseMode:"lastNode"`, which can only ever emit HTTP 200.
`web/src/lib/api.ts`'s `request()` throws on `!res.ok`, reading `error.code`/`error.message` only
on a non-2xx status — copying the `lastNode` pattern here would make every frozen error code
(400/404/413/429/500) unreachable by the frontend. Every webhook in this feature therefore uses
`responseMode:"responseNode"` with explicit `n8n-nodes-base.respondToWebhook` nodes
(`typeVersion 1.1`), one literal status code per node (`firstIncomingItem` mode — every upstream
Code node builds the *exact* response object as its own `$json`, so the respond node just
serializes it verbatim; no dynamic-expression response body anywhere, sidestepping the `{{ }}`
brace-truncation risk 07's README documents for deeply nested JSON).

## Two infra bugs found live while verifying the critical path, not by inspection

Both were **the actual reason `f08-intake-submit` failed on the first two live attempts** — not
theoretical risks flagged in the spec, but real 500s reproduced, root-caused, and fixed against
the running stack.

### 1. Supabase Storage's `decks` bucket 500'd on every upload

`POST /storage/v1/object/decks/...` returned `500 {"message":"The file system does not support
extended attributes or has the feature disabled."}` on every single call, including a bare `curl`
upload with no n8n involved. Root cause: `infra/supabase/docker-compose.yml`'s `storage` and
`imgproxy` services bind-mounted `./volumes/storage:/var/lib/storage` — a well-documented upstream
issue (`supabase/supabase` #10977, #10745, #20096, #30742): the file-storage backend stores
content-type/cache-control via POSIX xattr, and Docker Desktop for Mac's bind-mount filesystem
does not support xattr. The maintainers' own fix is a **named Docker volume** instead of a bind
mount. Applied: `infra/supabase/docker-compose.yml` now mounts a new `storage-data` named volume
on both services; verified live that uploads succeed after `docker compose up -d storage
imgproxy`. The old bind-mounted directory was empty, so nothing was migrated or lost.

### 2. Three separate OpenAI structured-output schema rejections

All three are fixed in `n8n/build-f08-workflow.py`'s `sanitize_schema_for_strict_mode()` /
`build_openai_request_body_js()`, not in the agent spec docs (which were written without live
verification against the real API):

1. `deck-claims-extractor`'s `founder_identity` field uses `oneOf: [null, object]` — OpenAI's
   strict mode rejects `oneOf` outright ("not permitted"; only `anyOf` is supported). Renamed.
2. `deck-claims-extractor`'s `claims[].value` is deliberately untyped (`{"type":["object","null"]}`,
   no fixed `properties` — "a small structured echo of arbitrary shape" per the agent's own input
   spec, varying per topic). Strict mode requires `additionalProperties:false` on every object
   schema, which cannot be satisfied without abandoning the field's actual purpose. Both
   `deck-claims-extractor` calls (text_layer and vision) now use `strict:false`; the Code node's
   own span-verification already treats the model's output defensively regardless.
3. `gap-question-phraser`'s schema is `type:"array"` at the top level — n8n-spec.md SS7 asserted
   this must be sent "verbatim, not wrapped." Verified live this is wrong: OpenAI's `/v1/responses`
   rejects a non-object root schema ("schema must be a JSON Schema of 'type: object', got 'type:
   array'"). Wrapped in `{type:"object", properties:{questions:<array schema>}, required:
   ["questions"]}`; the parse nodes read `parsed.questions`. The agent's own prompt still describes
   a bare array as the output format, which is harmless — strict enforcement dictates the actual
   wire shape regardless of the prompt text.

## One n8n sandbox bug found live, not documented anywhere before this build

**A leading `'use strict';` directive silently breaks `this` binding for every PostgREST call in
the same Code node.** Every `lib/f08/*.js` file opens with its own `'use strict';` (correct for
the file in isolation). `PG_HELPER_JS`'s `pg()`/`pgGet()` helpers depend on n8n's Code-node sandbox
binding top-level `this` to the execution context (`this.helpers.httpRequest`) — sloppy-mode
behavior. If a lib file bundled **first** in a given node's concatenated script puts `'use
strict'` as the actual first statement of the whole script, it strict-modes the entire node:
top-level `this` becomes `undefined`, and `pg.call(this, ...)` throws `"Cannot read properties of
undefined (reading 'helpers')"` — reproduced live on `f08-intake-submit`'s "Select gap criteria +
write completeness" node (`GAPS_JS` was bundled before `PG_HELPER_JS` there). Fixed generally:
`lib_bundle()` now strips every `'use strict';` line from every file it bundles (see the function's
own docstring) — safer than relying on "always put `PG_HELPER_JS` first," which is exactly the
convention that broke silently the first time an edit reordered it.

A second, unrelated context-loss bug was found and fixed the same way: `n8n-nodes-base.
convertToFile`'s `toBinary` operation returns an **empty** `json` object (only the binary property
is set) — unlike `n8n-nodes-base.extractFromFile`'s own `keepSource:'json'` default, which merges
the extraction result into the *incoming* item. Every field set before "Convert to File"
(`application_id`, `founder_id`, `card_id`, `deck`, `company_name`, ...) was silently gone by the
time "Write founder claims + evidence" ran. Fixed by recovering context via a named-node lookup
(`$('Write raw_signals (deck_parse)').first().json`) in "Compute chars_extracted," the first node
after the binary conversion — the same pattern already used everywhere else in this feature
whenever a node's output *replaces* rather than *merges* the upstream item.

## Verification performed (not just a green 200)

Per the team lead's brief: a green 200 is not evidence a workflow ran end to end — 03's own
history is a multi-wire reconvergence that silently executed only 1–2 of 4 branches while still
returning success. For every one of the six workflows, `GET /api/v1/executions/{id}?
includeData=true` was fetched after a real run and every expected node name for that run's branch
was confirmed present in `resultData.runData` (not just the last node). Concretely, on
`f08-intake-submit`'s full happy-path run (execution 411), all 34 nodes on that branch appear,
including the fire-and-forget rescore trigger (`Trigger f03-score-founder rescore` →
`Write events (rescore_triggered)`) wired *after* `Respond: success`.

Data-integrity invariant checked directly against Postgres, scoped to feature 08's own writes
(the founder card only — a **pre-existing, out-of-scope** violation was found on the *company*
card from `f07-thesis-gate`'s own gap-writing path, see "Cross-feature finding" below):

```sql
select c.id, c.topic, c.source_kind, e.id as evidence_id, e.raw_signal_id
from claims c left join evidence e on e.claim_id = c.id
where c.card_id = '<founder card id>'
  and (e.id is null or e.raw_signal_id is null or c.source_kind = 'public');
-- 0 rows, confirmed after intake-submit, gap-answers, and follow-up-answers each ran
```

End-to-end journey exercised against one real synthetic founder (`SmartKart Test Co 4`,
`application_id 5e059377-a831-41bd-bc2c-b3fa2b83cc07`, a real PDF from
`internal/other-projects/pitch-deck-analyzer/pitch_decks/SmartKart-1.pdf`):

1. `f08-intake-submit` — real GitHub link resolved a new founder, real deck parsed
   (`extraction_mode:"text_layer"`, 11 pages, 4062 chars), real `gpt-5.6-luna` call wrote 0 real
   founder.* claims (deck genuinely said nothing about them) + 5 honest `missing` markers,
   real `gpt-5.6-terra` call phrased 3 personalized gap questions referencing "SmartKart" by
   name, `card_completeness = 0.00`. Idempotent retry with the same `intake_submission_id`
   returned the identical response in 0.1 s (vs. ~14 s for the real run).
2. `f08-gap-answers` — answered L2 + L3, skipped X5. `card_completeness: 0.00 → 0.81`
   (`0.24/0.29625`, exactly `(0.15+0.09)/0.29625`). A duplicate delivery of the identical request
   correctly hit the "already completed" idempotent replay branch rather than double-writing.
3. `f08-followup-create` — selection logic correctly excluded the two now-covered criteria and
   proposed exactly the one still open (`X5`).
4. `f08-followup` (GET) — returned the real question, `already_answered:false`; an unknown token
   returned `{valid:false,reason:"unknown"}` at **HTTP 200**, per `lovable-brief.md` §4.4.
5. `f08-followup-answers` (POST) — answered X5, consuming the token. `card_completeness: 0.81 →
   1.00`. A replay of the same token returned the identical result; an invalid token returned
   `{error:{code:"internal",message:"This link is no longer valid."}}` at HTTP 404, exactly per
   `n8n-spec.md` §10.2's own documented assumption.
6. `f03-score-founder` fired (fire-and-forget) after both real writes; both times returned
   `insufficient_evidence` (`scores` table: 0 rows for this founder) — the correct, expected
   outcome for a synthetic founder with almost no public footprint, not a failure.

Other error paths verified directly: `invalid_input` (missing company name) → 400,
`unsupported_file_type` (non-PDF deck) → 400, `not_found` (unknown `application_id`, all three
relevant endpoints) → 404 with a clean body (an earlier build leaked internal `__`-prefixed
fields into the 404 response on `f08-gap-answers` and `f08-application-status`; fixed with a
dedicated "Build not-found response" node on every not-found branch, same discipline the
validation-error branches already had).

## Cross-feature finding (not fixed here — out of this feature's folder)

The invariant check above, run **unscoped** (every claim on the application, not just the founder
card), found 2 violating rows — both on the *company* card, both written by `f07-thesis-gate`
(`company.geography_country`, `company.stage_evidence`, both `source_kind:'derived'`,
`verification_status:'missing'`, **no evidence row at all**). Traced to `n8n/build-f07-workflow.py`'s
own `D0_EVIDENCE_JS`: `if (!c || c.is_gap) continue;` — 07's write path explicitly skips writing
an evidence row for its own gap/absence claims. This is a pre-existing defect in an already-deployed
workflow (`f07-db-write`, id `7pEtpy8sS3VLgVt2`), not something this build introduced or touched —
flagged here for whoever owns feature 07 next, not fixed, per the instruction not to edit another
feature's folder.

## Constants (`n8n/build-f08-workflow.py`, no source names them — tune empirically)

| Constant | Value |
|---|---|
| `DECK_TEXT_THRESHOLD_CHARS` | 200 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SEC` | 5 / 60 |
| `BASE_CONFIDENCE_INTERVIEW` | 0.30 |
| `VERDICT_ETA_HOURS` / `ESTIMATED_MINUTES` | 24 / 2 |

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals — safe to commit.
Values live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`OPENAI_API_KEY`. `gpt-5.6-luna` (text_layer extraction) and `gpt-5.6-terra` (vision extraction +
gap-question-phraser) both omit `temperature` entirely (rejects `0` — the same cross-feature rule
03/04/07 already documented).

## Re-deploying after a change

```bash
python3 n8n/build-f08-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "
import json
ids = {
  'f08-intake-submit': 'AOSJGp1WtyklOg8A', 'f08-gap-answers': 'NozMliP7TSLCQNrc',
  'f08-application-status': 'S2GGy48ZGPoKtcPr', 'f08-followup-create': 'eWIitXaz1kfCMjKY',
  'f08-followup': 'faIkBLyDGdiXTQpY', 'f08-followup-answers': 'mu172HUPZJSzYGSh',
}
for name, wid in ids.items():
    d = json.load(open(f'n8n/workflows/{name}.json'))
    payload = {k: v for k, v in d.items() if k in ('name','nodes','connections','settings','staticData')}
    json.dump(payload, open(f'/tmp/{name}_put.json', 'w'))
"
for pair in "f08-intake-submit:AOSJGp1WtyklOg8A" "f08-gap-answers:NozMliP7TSLCQNrc" \
            "f08-application-status:S2GGy48ZGPoKtcPr" "f08-followup-create:eWIitXaz1kfCMjKY" \
            "f08-followup:faIkBLyDGdiXTQpY" "f08-followup-answers:mu172HUPZJSzYGSh"; do
  name="${pair%%:*}"; id="${pair##*:}"
  curl -s -X PUT "http://localhost:5678/api/v1/workflows/$id" -H "X-N8N-API-KEY: $N8N_API_KEY" \
       -H "Content-Type: application/json" -d @"/tmp/${name}_put.json" | python3 -c \
       "import json,sys; d=json.load(sys.stdin); print('$name', d.get('id'), d.get('message'))"
done
```

(The n8n public API rejects `active`/`pinData`/`meta`/`id`/`versionId`/`tags` as read-only on
create/update — strip before PUT, same as 03/07's own READMEs document. A `PUT` does not need a
separate `/activate` call afterward if the workflow was already active.)
