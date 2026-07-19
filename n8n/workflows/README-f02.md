# Feature 02 workflow — Sourcing Radar

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f02-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f02-workflow.py --check   # check only, no write
```

The deterministic core lives in `lib/f02/{normalize,identity,claims,obscurity,pipeline,
ethics}.js` and `lib/f02/write.js`'s `applyWriteSet`, unit-tested (212+ tests) outside n8n.
n8n Code nodes cannot `require()` local files, so that source is **inlined** into the Code
nodes by the generator (only the trailing CommonJS `module.exports` line is stripped, or —
for `write.js`, which is a Node-CLI file with real `require()` calls at its top — the single
function this workflow needs is extracted by brace-matching instead of pasting the whole
file). Editing the generated JSON directly makes the tested modules and the running workflow
drift apart — the exact class of defect this generator exists to prevent.

## Registered workflow

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f02-radar-scan` | `qmViGGDMmEEN3XWH` | 22 | design §2's full topology: Tier 0 (deterministic filter) → loop → Tier 1 (pre-gate entity creation) → opt-out gate → thesis gate → Tier 2 (GitHub + Tavily enrichment, parallel, Merge-synchronized) → persist → run counters. |

Entry points: Manual Trigger or Schedule Trigger (cron `0 */6 * * *`), both wired to the same
HN Algolia search node. No webhook — this is a scan job, not a request/response service.

## Topology notes

- **Tier 0** (`Tier 0 - deterministic filter`) drops hits with no `url`, sorts survivors by
  `created_at_i` DESC, and caps at `gate_budget` (`$env.GATE_BUDGET`, default **120**) — the
  cap is by recency, never by points (design §2/§10 decision 2). The dropped count is always
  logged into `counters0`, never silent.
- **Tier 1** (`Tier 1 - create entities + raw signals`) calls `buildWriteSet` +
  `applyWriteSet` ONCE with `capabilities: {github:false, tavily:false}` — founders,
  companies, applications (+ HN-sourced raw signals/claims/metrics) exist **before** the gate
  runs, satisfying design §5.5(a). `application_id` from this pass is what the gate is called
  against.
- **Opt-out gate** (`IF: opted out?`): `applyWriteSet` now (as of a concurrent-terminal
  addition to `lib/f02/write.js`/`lib/f02/ethics.js`, design §7 item 2) returns
  `{blocked: true, ...}` **before writing anything** when a matching identity's founder has
  `opt_out_at` set. A blocked candidate has no `application_id` and routes straight to the
  loop-back, never to the gate.
- **Gate** (`Gate: f07-thesis-gate`, sub-workflow call, id `EQxi1lFF2bDjDByd`) runs in
  `mode: 'keyword'` — no LLM, no GitHub token. The returned `verdict` is FOUR-valued; only
  `'failed'` stops (`IF: verdict != failed`) — keyword mode never returns `'passed'` by
  design, so gating on `'passed'` would advance nobody (design §5.5(c)).
- **Tier 2** fans out to `Tier 2 - GitHub enrichment` and `Tier 2 - Tavily enrichment` as
  genuinely parallel branches, reconverging through an actual `n8n-nodes-base.merge` node
  (`mode: 'append', numberInputs: 2`) — **not** multiple wires into one node's input. See
  `docs/backlog/TRACKER.md` ~05:05: that pattern silently executed only 1–2 of N parallel
  branches in this exact n8n build when tried by feature 03. Live-verified here too: the
  Merge node ran once per loop iteration, every time, in a 3-candidate smoke run.
- The GitHub node also fetches `ghSearchPrs` (Search API, E1 merged-PR-foreign) and
  `ghEvents` (`/users/{login}/events`, E3 commit-consistency-fallback) — `lib/f02/pipeline.js`
  gates both on `personLinked` (a confirmed person-level identity, never an Organization)
  internally, so it is safe to always fetch them for github-kind candidates.
- The Tavily node checks `robots.txt` before crawling (`lib/f02/ethics.js`'s `checkRobots`,
  design §7 item 1 — "robots.txt is checked before any crawl, in a dedicated node"; this IS
  that node) and persists a `crawl_skipped_robots` event when disallowed. `/map` runs first;
  if it returns zero URLs (systematic on small static sites — reproduced live against the
  same two fixture sites design §7.1 recorded), it falls back to extracting the ROOT page
  only. A hard per-run Tavily credit ceiling (`$env.TAVILY_CREDIT_BUDGET`, default 150) is
  enforced via `$getWorkflowStaticData('global')`, reset once per run in Tier 0.
- **`Tier 2 - Build write set + persist`** calls `buildWriteSet` + `applyWriteSet` a
  **second** time, now with full capabilities — see the in-node comment for why this is safe
  (idempotent for founder/card/cards/most raw_signals/claims/metrics) except for one
  documented, harmless gap: `applications` has no natural key in `write.js`, so this second
  pass always creates a second, inert `applications` row per candidate (never referenced by
  `thesis_evaluations`, never read by 03's founder_id-scoped queries). Not hidden — surfaced
  in the run's `duplicates` counter and here.
- **`Loop candidates (Split in Batches)`**: `batchSize: 1`. Its `done` output (index 0) fires
  once, carrying the concatenation of every loop-body iteration's own output — feeds
  `Run counters -> events` directly. Both `Tier 2` success and the two skip paths
  (`Rejected - skip Tier 2`, `Opted out - skip`) wire back into the SAME node's single input —
  an exclusive IF/Switch reconverge is fine with multiple wires (TRACKER.md), unlike the
  genuinely parallel GitHub/Tavily fan-in above.

## Runtime discoveries (live, 2026-07-19, deploying THIS workflow)

This n8n build (`n8n-nodes-base` bundled with the container) executes Code nodes through
`@n8n/task-runner`'s **JS Task Runner** sandbox, not the classic in-process vm2 sandbox f03's
`SB_NORMALIZE`/`PG_HELPER` idiom and this feature's own `lib/f02/*.js` header comments were
written against. Confirmed by reading `js-task-runner.js` inside the running container and by
cross-checking failing live executions against the same code run in a controlled Node `vm`
context with the missing globals actually present. Three gaps, all fixed by a `typeof`-guarded
polyfill (`RUNTIME_POLYFILL_JS` in the generator) sourced from the SAME already-allow-listed
`crypto`/`url` builtins (`NODE_FUNCTION_ALLOW_BUILTIN=crypto,url`,
`infra/n8n/docker-compose.yml`) rather than any new require target:

1. **`globalThis.crypto` is undefined.** `normalize.js`'s `sha256Hex()` (`globalThis.crypto.
   subtle.digest(...)`) threw `Cannot read properties of undefined (reading 'subtle')`.
   Fixed: `globalThis.crypto = require('crypto').webcrypto` (bare `'crypto'`, not
   `'node:crypto'` — the require-resolver does an exact string match against the allow-list,
   and `'node:crypto'` is rejected live even with `crypto` allow-listed).
2. **`URL` is undefined** — and this one was **silently swallowed**, not thrown. Every
   `parseArtifactUrl()`/`canonicalDomain()` call wraps `new URL(...)` in its own
   `try { ... } catch { return emptyArtifact(null) / null; }`, written for genuinely
   unparseable input strings — but the same catch also swallows `ReferenceError: URL is not
   defined`, so every artifact silently resolved to `kind: 'none'` / `domain: null` instead of
   throwing. No error in the logs; identity resolution and site-crawl-seed selection were both
   just quietly wrong (a `github.com/owner/repo` URL classified as `'none'`, a product URL's
   `host` came back `null`). Caught by cross-checking a live execution's `artifact_kind`
   against the same code run in a Node `vm` with `URL` actually present. Fixed:
   `globalThis.URL = require('url').URL`.
3. **`URLSearchParams` is undefined.** Threw directly (not swallowed) inside
   `makeN8nSupabaseClient`'s query-string building. Fixed:
   `globalThis.URLSearchParams = require('url').URLSearchParams`.

A fourth, non-sandbox bug found by the same live-vs-vm cross-check: `parseArtifactUrl()`
itself returns `{kind, owner, repo, host}` with **no `.url` field** — `pipeline.js`'s
`buildWriteSet` adds it itself (`artifact.url = artifactUrl`) right after calling it, because
`deriveSiteCrawlSeed()` and identity tier-1-case-3 both key off `artifact.url`. The
`Tier 2 - Tavily enrichment` node calls `parseArtifactUrl` directly (outside `buildWriteSet`,
since GitHub/Tavily run before the second `buildWriteSet` pass) and had not replicated that
one-line fixup — every candidate's site-crawl seed silently computed as `null`
(`tavilySkipped: 'no_seed'`) regardless of artifact kind. Fixed by adding the same
`artifact.url = tier1ctx.hnStory.url;` line in that node.

Also carried over from f03/f04: `$getWorkflowStaticData(type)` is a **global function** in
this sandbox, not `this.getWorkflowStaticData(...)` — confirmed by reading the running
container's own `buildContext()`, which sets `$getWorkflowStaticData` on the vm context but
never `this.getWorkflowStaticData`.

None of these required touching `lib/f02/*.js` — every fix is a `typeof`-guarded global
polyfill or a one-line replication of a fixup `pipeline.js` already does internally,
documented in the generator's own comments at each call site.

## Verified live (2026-07-19)

A `GATE_BUDGET=3` smoke build (`F02_TEST_GATE_BUDGET=3 python3 n8n/build-f02-workflow.py`)
was deployed and manually executed via n8n's internal run endpoint (the public REST API has
no "run now" call for a Manual-Trigger-only workflow); the resulting execution was fetched
back via `GET /api/v1/executions/{id}?includeData=true` and its `resultData.runData` inspected
node-by-node — this is exactly the check that caught feature 03's silent Merge-node defect,
repeated here.

Result: **every node in the main path executed** (`Manual Trigger` → `HTTP: HN Algolia
search` → `Tier 0` → `Loop candidates` ×4 (3 iterations + done) → `HTTP: HN item tree` ×3 →
`HTTP: HN user karma` ×3 → `Tier 1` ×3 → `IF: opted out?` ×3 → `Gate: f07-thesis-gate` ×3 →
`IF: verdict != failed` ×3 → `Tier 2 - GitHub enrichment` ×3 → `Tier 2 - Tavily enrichment` ×3
→ `Merge Tier 2 branches` ×3 → `Tier 2 - Build write set + persist` ×3 → `Run counters ->
events` ×1), status `success`, and real rows landed in Supabase — confirmed by direct query
(founders/companies/applications/claims/evidence/raw_signals/metric_observations counts all
grew across test runs; one candidate's claim set inspected directly showed real, well-formed
`founder.execution.*`/`founder.expertise.*`/`founder.leadership.*` rows with correct
`evidence.tier`, `evidence.source`, and verbatim text). The `Rejected - skip Tier 2` and
`Opted out - skip` branches were not exercised in this sample (keyword-mode `'failed'` is rare
by construction — design §5.5(d) — and no founder in this fresh dataset has `opt_out_at` set)
but pass `--check` and share the exact loop-back wiring already proven live for the two
branches that did fire.

The deployed workflow (`qmViGGDMmEEN3XWH`) was rebuilt and redeployed with the real
`GATE_BUDGET` default (120, no override) after this smoke test.

## Known, documented limitations

- **Second `applications` row per enriched candidate** (see the Tier 2 topology note above) —
  a real but inert duplicate, not a correctness defect.
- **Tavily site-crawl seed for GitHub-hosted artifacts.** `deriveSiteCrawlSeed(ghUser,
  artifact, deps)` prefers the GitHub profile's `blog` field (design §4.1: populated ~44% of
  the time), but the Tavily node runs in parallel with the GitHub node and cannot see its
  output yet. It is called with `ghUser: null`, which correctly still covers the majority
  product-URL path (~73% of candidates, design §4) but yields no seed for github-hosted
  artifacts — E4/X1/X2/X6 degrade to "no attempt" for that subset rather than crawling a
  `blog` field the GitHub branch hasn't fetched yet. A sequential-then-parallel redesign would
  close this at the cost of the clean two-branch Merge topology; not built for this MVP.
- **`structured_hints.geography_country` is always `null`** in the gate call. GitHub
  `location` (design §3's normalisation target) is not known until Tier 2, which runs *after*
  the gate by construction (the gate needs `application_id` from Tier 1). Geography is simply
  a `missing_fields` entry for every radar-sourced candidate; not fabricated, not silently
  dropped.

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals — safe to
commit. Values live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `TAVILY_API_KEY`. `GITHUB_TOKEN` is not configured (design §11) —
every GitHub call runs unauthenticated (60 req/h) and degrades gracefully, never throws.

## Re-deploying after a change

```bash
python3 n8n/build-f02-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "import json; wf=json.load(open('n8n/workflows/f02-radar-scan.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f02_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/qmViGGDMmEEN3XWH" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f02_put_body.json
```

(The n8n public API rejects `active` and `meta` as read-only on create/update, even though the
exported file includes them for correct standalone import — hence the strip-before-PUT step.)

Manually triggering an execution (the public REST API has no "run now" endpoint for a
Manual-Trigger-only workflow — only webhook-triggered workflows can be POSTed to directly):

```bash
# log in once, keep the cookie jar
curl -c /tmp/n8n_cookies.txt -X POST "http://localhost:5678/rest/login" \
  -H "Content-Type: application/json" \
  -d "{\"emailOrLdapLoginId\":\"$N8N_OWNER_EMAIL\",\"password\":\"$N8N_OWNER_PASSWORD\"}"

# fetch the full workflow def, then POST it back to the internal "run" endpoint
curl -b /tmp/n8n_cookies.txt "http://localhost:5678/rest/workflows/qmViGGDMmEEN3XWH" -o /tmp/wf.json
python3 -c "import json; d=json.load(open('/tmp/wf.json')); json.dump({'workflowData': d['data'], 'startNodes':[{'name':'Manual Trigger','sourceData':None}], 'triggerToStartFrom':{'name':'Manual Trigger'}}, open('/tmp/run.json','w'))"
curl -b /tmp/n8n_cookies.txt -X POST "http://localhost:5678/rest/workflows/qmViGGDMmEEN3XWH/run" \
  -H "Content-Type: application/json" -d @/tmp/run.json
```
