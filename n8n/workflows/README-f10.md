# Feature 10 workflow — NL-search

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f10-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f10-workflow.py --check   # check only, no write
```

The deterministic executor lives in `lib/f10/{constants,plan,score}.js`, unit-tested (86 tests)
outside n8n. n8n Code nodes cannot `require` local files, so that source is **inlined**
verbatim into the "Validate plan" and "Score" nodes by the generator — each preceded by
`constants.js`'s own body (module.exports stripped) since both modules destructure from it and
each Code node needs its own copy, and each carrying a `// ===== SOURCE OF TRUTH: lib/f10/<file>.js`
header. The resolver's system prompt and JSON schema are pulled straight out of
`docs/backlog/10-api-cli-skill/agents/nl-search-resolver/*`, never retyped by hand. Editing the
JSON directly makes the tested modules / reviewed prompt and the running workflow drift apart —
the same reasoning as `n8n/build-f03-workflow.py` / `n8n/build-f07-workflow.py`.

## The pasted-copy drift trap — no automated check exists

`n8n/build-f10-workflow.py` reads `lib/f10/*.js` **fresh from disk on every run**, so the
generator itself never goes stale. What *can* go stale is the **deployed** workflow: if
`lib/f10/{constants,plan,score}.js` changes after the last `python3 n8n/build-f10-workflow.py`
+ `PUT /api/v1/workflows/{id}` cycle, the live n8n instance keeps serving the OLD pasted logic
indefinitely — n8n has no way to know the source file it was pasted from ever existed, let alone
changed. There is **no CI hook, no pre-commit check, no runtime assertion** that catches this;
the only symptom is the endpoint quietly computing wrong answers while returning `HTTP 200`.

This bit for real on 2026-07-19: `lib/f10/score.js` gained a `has_match`-leading sort term
(rev.6, fixing a live-discovered ordering defect — a founder with two `mismatch`es outranked
nine founders with a real `matched` attribute), but the deployed workflow kept running the
pre-fix comparator for roughly 20 minutes before the drift was caught by re-running Q2 live and
noticing the inverted top result. `grep -c hasMatch lib/f10/score.js` vs
`grep -c hasMatch n8n/workflows/f10-nl-search.json` is the fastest manual check; there is no
automated equivalent.

**Anyone editing `lib/f10/*.js` must, in the same sitting**: re-run
`python3 n8n/build-f10-workflow.py`, PUT the result to the workflow id below, and re-run Q1/Q2
live to confirm the fix actually shipped — a green `node --test lib/f10/*.test.js` proves the
*library* is correct, it proves nothing about what n8n is currently executing.

## Registered workflow

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f10-nl-search` | `x7qXnx2asXrGB0ye` | 15 (13 executable + 2 sticky notes) | design.md §5: `POST /webhook/f10-nl-search { query, limit }` → resolver LLM → deterministic plan validation → PostgREST fetch → deterministic scoring → response. **Active.** |

Entry point: `POST http://localhost:5678/webhook/f10-nl-search`, body `{ "query": "<nl>", "limit": 10 }`
(`limit` optional, defaults to 10). `responseMode: lastNode`.

## Topology

```
Webhook Trigger
  → Normalize input                (Code: query/limit validation, empty_query / limit_exceeded)
  → IF: input error?
      TRUE  → Build response
      FALSE → Build catalogue      (Code: PostgREST reads — claim-topic counts, structural-field
                                     fill counts, filtered to the documented taxonomy — + static
                                     vocabularies/metric_kinds from lib/f07/vocabulary.js)
              → Build resolver request   (Code: embeds the resolver's system prompt + wire schema)
              → OpenAI: nl-search-resolver (luna)   (httpRequest, gpt-5.6-luna, structured output)
              → Parse resolver response  (Code: extracts JSON, normalises strict-mode nulls)
              → Validate plan            (Code: lib/f10/plan.js + constants.js, verbatim)
              → IF: plan error?
                  TRUE  → Build response
                  FALSE → Fetch candidates   (Code: PostgREST fetch per plan descriptor + api_founders)
                          → IF: fetch error?
                              TRUE  → Build response
                              FALSE → Score            (Code: lib/f10/score.js + constants.js, verbatim)
                                      → Build response
```

All three `IF: *error?` gates are mutually exclusive per execution (only one branch of any single
IF ever runs) and converge on the single terminal **Build response** node without a Merge node —
the same sanctioned pattern `f07-thesis-gate.json`'s "Build attributes for evaluation" node
already uses for its own keyword/full-mode fan-in (two wires into one node's input, both from
IF branches that never both fire). No node in this workflow fans out into *parallel*
simultaneously-executing branches that need to reconverge, so a real `Merge` node is not needed
anywhere here.

## Schema deviation from the agent artifact — read before editing the resolver call

`nl-search-resolver-agent-json-schema.json` is the canonical, documented contract (root
`oneOf: [plan, error]`, `attribute.value`/`broadening`/`resolved_as` genuinely optional). The
schema actually sent to OpenAI (`text.format.schema` in "Build resolver request") is a
**transformed subset**, built by `build_wire_schema()` in `n8n/build-f10-workflow.py`, for three
reasons discovered live on 2026-07-19 while building this workflow (see the script's own
module docstring for the fuller rationale):

1. **OpenAI Structured Outputs rejects a root-level `oneOf`/`anyOf` union** — verified live:
   `"schema must be a JSON Schema of 'type: object', got 'type: None'."` The root schema sent to
   the API is the `plan` shape only. This is safe here specifically because this workflow's own
   upstream nodes make the schema's `error` branch (`empty_query`/`no_catalogue`) unreachable
   before the LLM is ever called — "Normalize input" rejects an empty query first, and
   "Build catalogue" always builds a real, non-empty catalogue. `lib/f10/plan.js`'s
   `validatePlan()` still handles `rawPlan.error_code !== undefined` defensively and completely
   unmodified, for any future caller of the same prompt/schema pair outside this n8n workflow.
2. **OpenAI strict mode rejects `allOf`** (the attribute's negative-requires-`not_exists` /
   op-requires-`value` conditionals) — verified live: `"'allOf' is not permitted."` Dropped from
   the wire schema; `lib/f10/plan.js`'s `validateAttributeShape()`/`validatePlan()` re-implements
   both checks in JS, matching the "if/then/allOf unsupported in strict mode, enforced downstream
   instead" pattern feature 07's own `thesis-attribute-extractor-agent-model-recommendations.md`
   already documents for the identical class of constraint.
3. **OpenAI strict mode requires every property to be `required`** (no true-optional keys). The
   wire schema widens `value`/`broadening`/`resolved_as` to `[...,"null"]` and adds them to
   `required`. Consequence: the model must now emit those three keys as literal JSON `null` when
   not applicable, never omit them — but `lib/f10/plan.js`'s `validateAttributeShape()` was
   written expecting "not applicable" to mean the key is **absent**, not `null` (`attr.value
   !== undefined` is `true` for an explicit `null`, which the original shape check would
   incorrectly treat as "value present but wrong type" and reject as `resolver_failed`).
   "Parse resolver response" therefore deletes `value`/`broadening`/`resolved_as` whenever the
   LLM sent them as `null`, restoring the exact shape `plan.js` was built against, **before**
   `validatePlan()` (pasted verbatim, unmodified) ever sees it. This is workflow-layer plumbing
   around untrusted LLM output, not a change to the tested module — consistent with the task's
   "do not modify the logic while pasting" constraint.

The `$STRIP_KEYWORDS` denylist (`minLength`/`maxLength`/`pattern`/`uniqueItems`/`maxItems`/
`$schema`/`title`) is the same one `n8n/build-f07-workflow.py` found live for the identical
class of strict-mode incompatibility.

## Catalogue filtering — a second live-discovered bug, fixed before shipping

The first working draft fed the resolver **every** topic present in the raw `claims` table
(734 rows live). The live corpus also carries real, non-empty topics no target in this build
resolves against — `company.business_model` (9 rows), `company.stage_evidence` (9 rows),
`market.*`, `competition.*`, `round.cap_table`, `traction.*`, and every `.gap`-suffixed topic.
Live-tested against Q2: the resolver reasonably mapped a query fragment onto
`company.business_model` (it exists, it has rows, nothing told the resolver it wasn't a
supported *structural* target), and `lib/f10/plan.js`'s `validateTarget()` correctly rejected it
as `invalid_target` — **correctly**, per the module's own documented behaviour. But
`invalid_target` is a **whole-plan** rejection (`plan.js`'s own doc comment), so this single
out-of-taxonomy topic turned Q2's entire response into a hard error with zero items — exactly
the `"Q2 returning no rows is a bug"` case design.md §5.8 forbids, produced by an entirely
different mechanism than the corpus-sparsity case §5.8 was written to cover.

Fix: "Build catalogue" now filters `claim_topics` to exactly the documented taxonomy before it
ever reaches the resolver — the three provenance prefixes (`founder.expertise.` /
`founder.execution.` / `founder.leadership.`) and the two structural topics
(`company.sector` / `company.geography_country`), mirroring `lib/f10/plan.js`'s own
`PROVENANCE_TOPIC_PREFIXES` / `STRUCTURAL_TOPICS` constants (duplicated here rather than shared,
since "Build catalogue" runs before any plan exists to import from). Everything outside that
taxonomy is now invisible to the resolver, so an unsupported fragment correctly lands in
`unresolvable` (`no_data_source` / `not_testable`) instead of surfacing as `invalid_target`.
Re-tested live after the fix: Q2 now returns a populated, honestly-degraded response (see below).

## `target.type: "column"` — an unexercised, best-effort path

`lib/f10/plan.js`'s own comment flags `companies.stage`'s column-descriptor path as "not fully
specified... no worked example ever uses `target.type:'column'`, Q1/Q2 do not exercise it."
"Fetch candidates" implements a best-effort adaptation for completeness (fetch the matching
companies — the descriptor's own filter already applies the `eq` server-side — join to the
current founder via `founder_company.is_current`, and reshape each row into the claims-row shape
`score.js`'s `classifyRow()`/`evalOpMatch()` expect, with a synthetic `documented`/`supports`
evidence entry carrying no real `claim_id`/`quote_verbatim`/`source_url`). This is workflow-level
plumbing, not a change to `lib/f10/score.js`, and it is **not covered by lib/f10's 82 tests** —
flagged here rather than silently assumed correct, per the same standard the rest of this
feature holds itself to.

## PostgREST access pattern

Every Supabase read is Code-node-wrapped `this.helpers.httpRequest` (never the standalone
`n8n-nodes-base.httpRequest` node), matching f03/f04/f07's own house convention — see
`README-f07.md`'s "Topology notes" for why (the standalone node's array-unwrapping is
inconsistent for empty-array responses). `$env.SUPABASE_URL` is normalised defensively in both
Code nodes that call PostgREST (`String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '')`),
the same drift-guard 02/03 both carry.

`pgCount()` (in "Build catalogue") uses `Prefer: count=exact` + `returnFullResponse: true` to
read the `Content-Range` response header for server-side row counts, rather than downloading
full tables — `companies`/`founders` filled/total counts are computed this way without ever
fetching a row.

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals in the JSON — safe
to commit to a public repo. Values live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`. `gpt-5.6-luna` rejects an explicit `temperature`
parameter (HTTP 400) — omitted entirely from the resolver's request body, per
`nl-search-resolver-agent-model-recommendations.md`.

## Live-verified results (2026-07-19)

Run via `curl -X POST http://localhost:5678/webhook/f10-nl-search -d '{"query": "...", "limit": 10}'`
against the live corpus (122 founders at the time of the first run, 124 after 08's inbound
ingestion advanced between runs — `api_founders`'s own count, not a fixture).

| Query | Resolver plan | Result |
|---|---|---|
| **Q1** — "technical founder who ships to production, has external usage of their code, merged PRs into other people's repositories, strong written communication" | 5 `provenance` attributes (`technical_founder` → `founder.expertise.*`, `ships_to_production` → `founder.execution.live_product`, `external_code_usage` → `founder.execution.external_usage`, `merged_foreign_prs` → `founder.execution.merged_pr_foreign`, `strong_written_communication` → `founder.leadership.written_communication`), `unresolvable: []` | `total: 122`, `truncated: false`, `items: 10` populated with per-attribute evidence (top rank_score 100 @ confidence 0.80, one founder at 5/5 matched), `low_confidence: 19`. Every node ran (`GET /api/v1/executions/{id}?includeData=true` confirmed all 13 executable nodes, all three `IF` gates on the false/no-error branch). |
| **Q2** — "technical founder, Berlin, AI infra, enterprise traction, no prior VC backing, top-tier accelerator" | 3 attributes (`technical_founder` provenance; `geo_berlin` structural, `broadening: "city→country"`, `resolved_as: "company.geography_country = DE"`; `sector_ai_infra` structural) + `unresolvable: [{"enterprise traction", "not_testable"}, {"no prior VC backing", "no_data_source"}, {"top-tier accelerator", "no_data_source"}]` | `total: 104`, `truncated: false`, `low_confidence_only: false`, `items: 10`, `low_confidence: 6`. Top items show `technical_founder: matched` with real evidence and `geo_berlin`/`sector_ai_infra: unknown` on all but a handful — the honest-degradation shape design.md §5.8 requires. Neither zero rows nor over-confident rows. |

Error envelope, also live-verified (`{"error":{"kind","message","hint","retryable"}}`, §5.7):
`empty_query` for a blank/whitespace query, `limit_exceeded` for `limit: 5000` (> the 1000
`PGRST_DB_MAX_ROWS` default).

### Re-sync after `lib/f10/score.js` rev.6 (`has_match`-leading sort), same day

The Q2 run above (pre-rev.6) put a founder with two demonstrable `mismatch`es at position 1 —
`rank_score: 0`, bucket `mid` (coverage 0.67) — above nine founders with a real `matched`
attribute at `rank_score: 100` but bucket `low` (coverage 0.33). Bucket-first ordering optimised
for "how much we assessed" over "does it match", and that inverts at the edge; `lib/f10/score.js`
rev.6 adds a leading `has_match = rank_score > 0` sort term (86 tests, including two deliberately
opposed regressions: the original "1-of-4 rank 100 must not outrank 4-of-4 rank 92.5" and the new
"rank 0 must not outrank rank 100"). Re-synced per "The pasted-copy drift trap" above: re-ran
`n8n/build-f10-workflow.py` (confirmed via per-node jsCode byte diff that **only** the "Score"
node changed — `plan.js`/`constants.js` were not stale, `git diff --stat` on those two files was
empty), PUT to `x7qXnx2asXrGB0ye`, re-ran both queries live.

Q1 (nothing in it had `rank_score: 0`) was byte-for-byte identical before/after — same 10 names in
the same order, same `rank_score` list. Q2's inversion is gone:

| # | rank_score | bucket | coverage | state mix | name |
|---|---|---|---|---|---|
| 1 | 100 | low | 0.33 | `matched:1, unknown:2` | Pieter Levels |
| 2 | 100 | low | 0.33 | `matched:1, unknown:2` | rangerwolf |
| 3 | 100 | low | 0.33 | `matched:1, unknown:2` | tastyeffectco |

The previous #1 (two `mismatch`es, `rank_score: 0`, bucket `mid`) no longer appears in the
top 10 or in `low_confidence[]` — `has_match` sank it below every real match in the full
104-candidate scored set, exactly as designed. Execution data (`GET
/api/v1/executions/{id}?includeData=true`, executions 360/361) confirmed all 13 executable nodes
ran on both re-runs, all three `IF` gates on the false/no-error branch — same verification method
as the original build.

## Re-deploying after a change

```bash
python3 n8n/build-f10-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "
import json
d = json.load(open('n8n/workflows/f10-nl-search.json'))
for k in ('active','pinData','meta','id','versionId','tags'): d.pop(k, None)
json.dump(d, open('/tmp/f10_put.json','w'))
"
curl -X PUT "$N8N_URL/api/v1/workflows/x7qXnx2asXrGB0ye" -H "X-N8N-API-KEY: $N8N_API_KEY" \
     -H "Content-Type: application/json" -d @/tmp/f10_put.json
```

(Same read-only-field strip as f07's README documents — the n8n public API rejects
`active`/`pinData`/`meta`/`id`/`versionId`/`tags` on update even though the exported file
includes them for standalone import.)
