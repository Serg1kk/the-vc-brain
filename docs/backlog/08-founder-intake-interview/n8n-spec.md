# 08 · Founder Intake — n8n Workflow Specification

> Written against `design.md` rev.2, `lovable-brief.md` §4 (frozen), `plan.md` T10–T13, and the
> live conventions established by features 02/03/04/07 (`n8n/workflows/README-f0*.md`,
> `docs/backlog/TRACKER.md`). The frontend (`web/`) is already built against `web/src/lib/api.ts`
> and `web/src/lib/types.ts` — read alongside this spec; every response shape below is
> transcribed from those files, not re-derived.
>
> **Audience:** whoever builds `n8n/build-f08-workflow.py` (the pattern every prior feature
> used — a Python generator that inlines `lib/f08/*.js` into Code nodes and pastes agent system
> prompts from `docs/backlog/08-founder-intake-interview/agents/*/`, never hand-edited JSON in
> `n8n/workflows/`). This document is node-by-node; it does not re-derive product rationale
> already settled in `design.md` — read that first for *why*, this for *how*.
>
> **Revision note (this pass):** `lib/f08/{validate,identity,hashing,gaps,completeness}.js` and
> both agent folders (`deck-claims-extractor`, `gap-question-phraser`) now exist and are read
> directly below — function names, signatures and exact model choices in this revision are
> transcribed from the real files, not guessed. Three of the five lib files were marked `rework` in
> `tracker.md` (T5 `validate.js`, T6 `identity.js`, T7 `hashing.js`); the specific defects
> (`new URL()` in `identity.js`) are called out at their exact wiring point below (§3) rather than
> assumed fixed. `hashing.js`'s own fix (§0.1) switched it to `require('crypto').createHash` —
> synchronous, no polyfill of any kind needed — after its own header traced through why the
> earlier `globalThis.crypto.subtle` framing, though it did work when probed live, was more
> mechanism than this feature needed. This pass also folds in eleven corrections from an
> adversarial plan review (five urgent, six follow-up) and adds a fifth workflow,
> `f08-followup-create` (§10.3, plan.md T19), that the first pass missed entirely.

## 0. Conventions this spec inherits (do not re-derive, do not deviate without flagging)

| Convention | Source | Applies here as |
|---|---|---|
| Generator script, not hand-edited JSON | 02/03/04/07 READMEs | `n8n/build-f08-workflow.py`, inlines `lib/f08/*.js` + `agents/*/`, syntax-checks every Code node, `--check` flag |
| Code nodes cannot `require()` from the repo | TRACKER.md tooling changelog | Every `lib/f08/*.js` file pasted verbatim behind `// SOURCE OF TRUTH: lib/f08/<file>.js`, zero imports |
| Hashing is `require('crypto').createHash`, synchronous, **no polyfill** — see §0.1 | `hashing.js`'s own header, corrected via `tracker.md` ~10:45 | Every Code node calling `sha256Hex`/`hashFields`/`contentHash.*` just calls them directly — no guard block, no `await` |
| PostgREST calls are Code-node-wrapped (`this.helpers.httpRequest`), never a standalone HTTP Request node | 07 README "Topology notes" | Every Supabase read/write in this spec is inside a Code node. Standalone `httpRequest` nodes are reserved for the two OpenAI calls (deck-claims-extractor, gap-question-phraser) and the Supabase Storage upload (§0.2) |
| A plain node with several wires into one input does not reliably wait for all of them | TRACKER.md ~05:05, reproduced by 02/03 | Any genuine parallel fan-out reconverges through `n8n-nodes-base.merge` (`typeVersion 3.2`, `mode:'append'`, `numberInputs:N`), branch *i* → input *i*. IF/Switch reconverges (exclusive branches) are fine with plain multi-wire input |
| `gpt-5.6-luna` rejects `temperature:0` | TRACKER.md ~05:10 | Every OpenAI request body in this spec omits `temperature` entirely |
| `$env.SUPABASE_URL` drift (`/rest/v1` suffix sometimes present) | TRACKER.md ~05:00 | Every Code node touching it normalizes: `String($env.SUPABASE_URL||'').replace(/\/rest\/v1\/?$/,'')` |
| Secrets referenced only via `$env.*`, never literals | all four prior READMEs | Same here: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` — no new env vars needed beyond the two devops is already adding (`N8N_CORS_ALLOW_ORIGIN`, `N8N_PAYLOAD_SIZE_MAX=192`) |
| `claims.axis = null` for founder-topic claims | `lib/f02/write.js:598` | 08 follows the same convention — `score_formulas.config.criteria[].axis` (the string `'founder_score'`) is a config-internal field, unrelated to the `claims.axis` column, which references `score_axes.slug` and stays `NULL` here exactly as it does for 02 |
| Select-existing-by-hash before insert, never blind-insert | 07 README ("`ai_runs` IS select-by-input_hash-first"), `lib/f07/run.js`'s claims/gap writer | Every table with a `content_hash` in this spec is select-first |
| `_`-prefixed keys inside a jsonb column are writer-internal plumbing, never rendered as data | 07 README, team-lead ruling (`_f07_input_fingerprint`, not bare) | 08's own internal cache key is `_f08_deck_meta` (§3, step 15), same naming discipline |
| Always `ORDER BY` a select-one lookup | `lib/f02/write.js` comment (unordered lookup caused a live non-determinism bug) | Every "does this already exist" select in this spec carries an explicit `order=created_at.asc&limit=1` (oldest-canonical, matching 02's convention) |

### 0.1 Hashing and URL parsing — neither needs a polyfill (corrected in this revision)

**Hashing (`hashing.js`) — no polyfill, no `await`.** This spec's earlier drafts described a
`globalThis.crypto.subtle` Web-Crypto polyfill (mirroring 02's own fix for a different problem).
`hashing.js`'s own header now documents the corrected mechanism directly, and this is worth
transcribing precisely because a wrong explanation living in a file headed "SOURCE OF TRUTH" is
exactly how that earlier convention got established in the first place: the webcrypto polyfill
**did** work when actually probed live (`globalThis.crypto = require('crypto').webcrypto` then
`await globalThis.crypto.subtle.digest(...)` produced a correct digest) — switching away from it
was not "the polyfill was broken," it was "simpler and already proven": `hashing.js` now uses
Node's classic, synchronous crypto module directly:

```js
const crypto = require('crypto');
// sha256Hex(text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
```

`require('crypto')` (the **bare** specifier — `require('node:crypto')` throws in this sandbox, a
separate live-confirmed finding) is on this container's `NODE_FUNCTION_ALLOW_BUILTIN` allow-list
already, so **no polyfill, no global mutation, no guard block of any kind is needed** — every Code
node just calls `sha256Hex`/`hashFields`/`contentHash.*` directly. This also matches
`lib/f04/provenance.js`'s and `lib/f07/hashes.js`'s own long-standing convention (both already used
`createHash`), so `hashing.js` now aligns with the rest of the repo rather than diverging from it.

**`contentHash.*` (and `sha256Hex`/`hashFields`) are synchronous, not `async`.** `createHash` has
no async form — **no call site in this spec awaits them**, and none should. If any code node
built from this spec still has an `await` in front of a `contentHash.*`/`sha256Hex` call, remove
it (harmless in JS — `await` on a non-promise is a no-op — but it signals the node was written
against the earlier, superseded mechanism).

**URL parsing (`identity.js`/`validate.js`) — also no polyfill, by design, not by luck.** Unlike
02, `lib/f08/*.js` does not use `new URL()` at all — by an explicit team-lead correction to
`plan.md` T5 ("`URL` is undefined in the n8n Code sandbox... reimplement without `URL` rather than
lean on a Code-node polyfill block"). `lib/f08/validate.js`'s own `parseAbsoluteHttpUrl` is a
hand-written regex/string parser with **no `try/catch` and no `URL` reference anywhere** (its
header comment explains why: 02 found live that `new URL()`'s `ReferenceError` was silently
swallowed by an existing `try/catch` written for genuinely-unparseable input, degrading into a
wrong-but-plausible answer with nothing in the logs). Confirm before building the generator that
`identity.js` has fully switched to the same parser (its own header records this as the fix in
flight) — `grep -n "new URL" lib/f08/*.js` should return nothing.

### 0.1b Node type/version table (verify each against the live node picker before relying on it — 08 is the first feature to use several of these)

| Node type | typeVersion used elsewhere in this repo | New to 08 |
|---|---|---|
| `n8n-nodes-base.webhook` | 2.1 (03, 07) | — |
| `n8n-nodes-base.code` | 2 (all four) | — |
| `n8n-nodes-base.if` | 2 (all four) | — |
| `n8n-nodes-base.merge` | 3.2 (02, 03) | — |
| `n8n-nodes-base.executeWorkflow` | 1.2 (04, 07) | — |
| `n8n-nodes-base.httpRequest` | 4.1 (02, 04, 07) | — |
| `n8n-nodes-base.respondToWebhook` | none | **yes** — propose `1.1`; no prior workflow needed variable per-branch HTTP status, see §0.3 |
| `n8n-nodes-base.convertToFile` | none | **yes** — propose `1.1` |
| `n8n-nodes-base.extractFromFile` | none | **yes** — propose `1` |

### 0.2 Supabase Storage upload — new to this repo, no code has ever called it

Per `docs/backlog/TRACKER.md` (~10:15, 08's own spec-review finding): the `decks` bucket does not
exist yet and nothing in the repo has called `/storage/v1/*`. A separate devops task provisions
the bucket (per the team lead's brief, assume it exists by the time this workflow runs). The
upload call itself, inside a Code node using `this.helpers.httpRequest`:

```
POST {SB}/storage/v1/object/decks/<application_id>/<sha256_16>-<sanitized_filename>
Headers: apikey: <SERVICE_ROLE_KEY>, Authorization: Bearer <SERVICE_ROLE_KEY>,
         Content-Type: <mime>
Body:    Buffer.from(base64, 'base64')   -- raw binary, NOT JSON
```

Same `SB = normalize($env.SUPABASE_URL)` as every PostgREST call (§0). `sha256_16` = first 16 hex
chars of `sha256(base64)` (`lib/f08/hashing.js`). `sanitized_filename` = `sanitizeFilename(filename)`
(`lib/f08/validate.js`, ported from `reporting`, per plan.md T5). On any non-2xx from Storage,
treat as `internal` (§0.4) — this is infrastructure, not a founder-input problem.

`Buffer` is assumed to be a global in this n8n build's Code-node sandbox (a standard Node global —
unlike `URL`/`URLSearchParams`, which 02's own README documents as stripped by the JS Task Runner
sandbox; `hashing.js`'s corrected mechanism, §0.1, shows plain `require('crypto')` works directly
with no such gap, so `Buffer` being similarly fine is the reasonable prior, not yet independently
confirmed). **Verify live before trusting this** — if `Buffer` is missing, the same
`typeof`-guarded pattern 02 used for `URL` applies (`globalThis.Buffer = require('buffer').Buffer`
— `'buffer'` is not currently on the `NODE_FUNCTION_ALLOW_BUILTIN` allow-list in
`infra/n8n/docker-compose.yml`, so this would need a devops addition to that list, flagged here
rather than discovered mid-build).

### 0.3 Why this workflow needs `respondToWebhook`, when 02/03/04/07 never did

Every prior workflow's webhook node uses `responseMode:"lastNode", options:{}` — the response body
is just whatever the last node returns, always HTTP 200. That was fine because none of those
workflows is called by a browser `fetch()` that branches on status. **08 is different, and this is
a deliberate, load-bearing deviation, not an invented preference:**

`web/src/lib/api.ts`'s shared `request()` function does `if (!res.ok) throw new ApiError(...)` —
reading `error.code`/`error.message` from the body **only on a non-2xx status**. A success response
(including the deliberately-200 `{valid:false}` follow-up-token case, per `lovable-brief.md` §4.4:
*"Invalid or expired token → HTTP 200 ... do not treat this as a network error"*) must be exactly
200; every genuine failure must be non-2xx or the frontend silently treats an error body as a
success and renders garbage into the UI.

`responseMode:"lastNode"` cannot vary the status code per branch. **Every webhook trigger in this
spec therefore uses `responseMode:"responseNode"`**, with an explicit `n8n-nodes-base.respondToWebhook`
node at the end of every branch, each setting its own `options.responseCode`. This is the one
structural difference from the 02/03/04/07 pattern; everything else (Code-node-wrapped PostgREST,
Merge over multi-wire, env-var secrets) carries over unchanged.

**HTTP status mapping** — confirmed by the team lead's review (not specified numerically anywhere
in `design.md`/`lovable-brief.md` itself, but now a settled decision, not this spec's own guess):

| Response | HTTP status |
|---|---|
| Any success shape (incl. `{valid:false,...}` on `f08-followup` GET — **by design, not an error**) | **200** |
| `invalid_input`, `unsupported_file_type`, `invalid_email` (§0.4) | **400** |
| `deck_too_large` (§0.4 — payload-too-large semantics) | **413** |
| `rate_limited` | **429** |
| `not_found` (application/token genuinely absent where the contract has no `valid:false` escape hatch — `f08-application-status`, `f08-followup-answers` past expiry) | **404** |
| `internal` | **500** |

### 0.3.1 Catch-all error branch — mandatory on every one of the five workflows

Every Code node in this spec that calls an external service (Supabase Storage, PostgREST, or
OpenAI) must set `onError: 'continueErrorOutput'` (n8n's "Continue (using error output)" node
setting) rather than left on its default `stopWorkflow`. Wire **every such node's error output**
into one shared `Handle unexpected error` Code node per workflow, which formats
`{error:{code:'internal', message:"Something went wrong on our side. Your answers are still here
— try again."}}` — the exact copy already committed in `lovable-brief.md` §9.5, so the same string
reaches the founder whether the failure came from Postgres, Storage or OpenAI — feeding a single
`Respond: internal error` node (500). Without this, an uncaught node exception returns n8n's own
default error page (occasionally with a stack trace), which `lovable-brief.md` §4.5 explicitly
forbids showing the founder ("Never show a raw stack trace or JSON blob"). This adds one node
(`Handle unexpected error` → `Respond: internal error`) to each of the five node tables below,
referenced there as "(+ error output → shared internal-error responder)" rather than re-drawn at
every single risky node to keep the tables readable.

### 0.3.2 Required post-build verification

A green HTTP 200 is not evidence a workflow actually ran end to end in this build — 03's own
history (`docs/backlog/TRACKER.md` ~05:05) is a multi-wire reconvergence that silently executed
only 1–2 of 4 branches while still returning `success`/200. **After the first live run of each of
the five workflows, fetch `GET /api/v1/executions/{id}?includeData=true` and confirm every
expected node name for that run's branch appears in `resultData.runData`** — this is the exact
check that caught 03's defect and is the check 02/07 also ran before trusting their own Merge
points. Pay particular attention to: the `Merge: extraction + thesis gate` point if the
recommended parallelization (§5) is built, and every `onError:'continueErrorOutput'` branch added
in §0.3.1 — confirm the error path itself executes (deliberately break one call, e.g. a wrong
Storage path, and verify `Handle unexpected error` → `Respond: internal error` both appear in the
run data) rather than assuming the wiring is correct because the happy path works.

### 0.5 CORS — verified working, no per-node work needed

The team lead ran a live preflight check: `OPTIONS` against a running webhook with `Origin:
http://localhost:5173` returned **204** with `Access-Control-Allow-Origin:
http://localhost:5173` and `Access-Control-Allow-Methods: OPTIONS, POST`. **`N8N_CORS_ALLOW_ORIGIN`
is confirmed the effective mechanism in this n8n build (2.30.7)** — it handles the preflight and
the actual response headers for every webhook automatically, success or error alike. **Do not add
per-node `options.allowedOrigins` or any header-setting logic to any node in this spec** — it
would be redundant with what the container-level env var already does, and is not needed.

**Confirmed allowed origins (T2, `docs/backlog/08-founder-intake-interview/tracker.md`):
`http://localhost:5173` and `http://localhost:3000`** — Vite's and CRA's respective default dev
ports. **The end-to-end check (§0.3.2) must run the frontend on the default Vite port
(`cd web && npm run dev`, port `5173`)** — a dev server started on any other port will get a real
CORS failure that looks identical to a backend bug, and this is the exact class of thing 02's
README warns "curl tests stay green, which is what makes this expensive to find."

### 0.4 Error codes — what `lib/f08/validate.js` actually produces (corrected from this spec's first pass)

`lovable-brief.md` §4.5 freezes `deck_too_large | unsupported_file_type | invalid_email |
rate_limited | internal` and states *"any unknown code → show `message` if present, otherwise the
generic failure copy"*. **This spec's first pass invented additional codes
(`deck_required`, `invalid_company_name`, `too_many_artifact_links`, …) that do not match the real
`lib/f08/validate.js` — corrected here to the actual, already-built implementation:**

| Code | Where it actually fires (`validate.js`, read directly) |
|---|---|
| `invalid_input` | `intake_submission_id` missing/not a UUID shape; `company_name` empty after trim or >120 chars |
| `invalid_email` (frozen) | `contact_email` missing, >254 chars, or fails the RFC-ish regex |
| `unsupported_file_type` (frozen) | `deck` missing entirely, **or** present but not identifiable as a PDF (`mime==='application/pdf'` or `.pdf` filename), **or** missing `base64` — `validate.js` uses this one frozen code for all three "no usable deck" cases, there is no separate `deck_required` |
| `deck_too_large` (frozen) | `deck.base64` decodes (by length estimate, `base64ByteLength`, no actual decode) to >10 MB |

**`artifact_links` and `extra_files` never produce an error at all** — every bad or oversized row
is silently dropped/capped (`validateArtifactLink` returns `null` and is filtered out;
`validateExtraFile` likewise), matching `lovable-brief.md`'s own "empty rows are dropped silently,
not flagged" instruction extended to every row this backend cannot safely store. **There is no
`invalid_artifact_link`, `too_many_artifact_links`, `too_many_extra_files` or
`extra_file_too_large` code in this build** — this spec's first pass was wrong to invent them, and
the "Validate input" node (§2, step 2) must call `validateIntakePayload(payload)` as written and
trust its `{ok:false, error:{code, message}}` shape verbatim rather than re-deriving error codes.

Two codes remain genuinely additive (not produced by `validate.js`, produced elsewhere in the
workflow, both already scoped in §0.3's status table): `rate_limited` (the in-memory counter, §1)
and `not_found` (`f08-application-status`, `f08-followup-answers` past expiry — no application/
token row at all, where the response contract has no `valid:false` escape hatch).

## 1. `lib/f08/*.js` → Code node map (T5–T9, per `plan.md`) — exact exports, read from the real files

All five files exist now (`tracker.md`: T5/T6/T7 marked `rework`, T8/T9 `done` — see §0.1 for the
`identity.js` fix in flight). Function names/signatures below are transcribed directly from the
source, not re-derived, so a builder can call them exactly as written.

| Module | Key exports a Code node calls | Used by |
|---|---|---|
| `validate.js` | `validateIntakePayload(payload) → {ok, value\|error}` (the one entry point for `f08-intake-submit`'s own payload); standalone `sanitizeFilename`, `safeWebUrl`, `inferArtifactKind`, `parseGithubOwnerRepo`, `base64ByteLength` for other call sites (Storage path naming, `identity.js`'s wiring) | Every workflow's first Code node validates its own smaller payload shape by hand (no single `validateIntakePayload`-equivalent exists for gap-answers/followup/status — those are simple enough to inline) |
| `identity.js` | `resolveFounderIdentity(payload, lookupIdentity) → Promise<{action:'attach'\|'create', founder_id, identities_to_write, defaults}>` — a **pure decision function**; it does no DB I/O itself. The Code node supplies `lookupIdentity(kind, value)` as an inline async callback wrapping `this.helpers.httpRequest` against `founder_identities`, then applies the returned `action` (§3) | `f08-intake-submit` only |
| `hashing.js` | `sha256Hex(text)`, `hashFields(...parts)`, `contentHash.rawSignal({application_id,source,content_key})`, `contentHash.claim({application_id,card_id,topic,item_key})`, `contentHash.evidence({application_id,claim_id,relation,raw_signal_id})` — **all synchronous** (`require('crypto').createHash`, §0.1), no `await`, no polyfill | Every workflow, everywhere a `content_hash` is written — always salted with `application_id` per the file's own header rationale |
| `gaps.js` | `selectGapCriteria({criteria, claims, cap=3}) → criterion objects (id, weight, anchor, neg_src, subscorer, topic)[]`, ranked, already carrying the resolved `topic` string | `f08-intake-submit`, `f08-followup-create` (§10.3) — **not** re-run by `f08-gap-answers`/`f08-followup-answers` (those consume an already-selected set from `interviews.transcript`, they don't re-select) |
| `completeness.js` | `cardCompleteness({criteria, claims}) → number` (0..1, already rounded via its own `round2`, `Number(value.toFixed(2))`) | `f08-intake-submit`, `f08-gap-answers`, `f08-followup-answers`, `f08-application-status` — always called fresh against current `claims`, never cached (§6) |

**Both `gaps.js` and `completeness.js` need the SAME two inputs** (`criteria` from
`score_formulas.config.criteria`, `claims` for the relevant card) — one shared "fetch criteria +
fetch current claims" Code node per workflow can feed both calls; no need to fetch twice.

Two things live in the workflow's own generator, not in a testable `lib/f08/*.js` file, because
they are n8n-runtime-specific (workflow static data, not pure functions the way `gaps.js` etc.
are):

- **Rate limiting** (`f08-intake-submit` only) — `$getWorkflowStaticData('global')`, an in-memory
  `{ emailCounts: { [lowercased_email]: [timestamp, ...] } }` map, sliding 60 s window, max 5
  requests/email. Resets on container restart — acceptable for a hackathon demo, same class of
  limitation as 02's Tavily credit budget (`$getWorkflowStaticData`, reset once per run).
- **Idempotency short-circuit** (`f08-intake-submit`) — the "does this application already exist"
  check and cached-response reconstruction, §3 step 3.

## 2. `f08-intake-submit` — the only writer of inbound applications

25 nodes (parallel-branch count depends on whether the Merge-optimization in step 13 is taken —
see the note in §5), plus the shared catch-all pair from §0.3.1. Full step sequence:

| # | Node | Type | Purpose |
|---|---|---|---|
| 1 | `Webhook: f08-intake-submit` | webhook | `POST /webhook/f08-intake-submit`, `responseMode:"responseNode"` |
| 2 | `Validate input` | code (`validate.js`) | Calls `validateIntakePayload(payload)` verbatim. Returns `{ok:true, value:{...normalized}}` or `{ok:false, error:{code, message}}` — the real shape, not a re-derived one (§0.4) |
| 3 | `IF: valid?` | if | false → 4a (respond, status per §0.3's table keyed on `error.code` — `deck_too_large`→413, else 400); true → 4 |
| 4 | `Idempotency check` | code (PostgREST GET, `this.helpers.httpRequest`) | `applications?id=eq.<intake_submission_id>&select=*&order=created_at.asc&limit=1`. **Runs before rate limiting, deliberately (§2.1a)** |
| 5 | `IF: application exists?` | if | true → 5a (cached response, respond 200); false → 6 |
| 6 | `Rate limit check` | code | Sliding-window per-email counter (workflow static data) — only genuinely-new submissions reach this |
| 7 | `IF: rate limited?` | if | true → 7a (respond 429 `rate_limited`); false → 8 |
| 8 | `Upload deck + extra files to Storage` | code (§0.2) | Deck first, then each extra file; **drops `extra_files[].base64` from the item immediately after upload** (⟨R-10⟩ — deck's own base64 stays, needed by step 10) |
| 9 | `Resolve or create entities` | code (`identity.js`) | §3 cascade. Wraps `resolveFounderIdentity(payload, lookupIdentity)`, applies the returned `action` |
| 10 | `Insert applications + cards` | code | `applications` (`id=intake_submission_id`, `kind='inbound'` — the CHECK-constraint-bearing column §2.0 names explicitly, `deck_storage_path`, `artifact_links`), then `cards` (`card_type='founder'` — the exact registry slug, `status='prefilled'`). **If this insert fails for any reason other than the idempotency PK collision already handled at step 4/5, respond 500 `internal`** — nothing upstream (steps 8–9) has touched `applications`/`cards` yet, so no application-subtree row is left half-written |
| 11 | `Write raw_signals (deck_parse)` | code (`hashing.js`) | One row, `payload={deck_storage_path, filename, mime}` — no `extraction_mode` here, see note below |
| 12 | `Deck cascade` | convertToFile → extractFromFile → code (threshold IF) → [vision branch] | §4 below, own sub-table |
| 13 | `Merge: extraction + thesis gate` (recommended, not mandatory) | merge | See note in §5 |
| 14 | `Write founder claims + evidence` | code (`hashing.js`) | From deck-claims-extractor output, §4.1 |
| 15 | `Update founders.full_name` | code | Only if `action==='create'` at step 9 **and** the extractor returned a non-null `founder_identity` (§3) |
| 16 | `Fetch score_formulas + current claims` | code | Feeds both `gaps.js` and `completeness.js` (§1) in one round-trip |
| 17 | `Select 0–3 gap criteria` | code (`gaps.js`) | `selectGapCriteria({criteria, claims, cap:3})` |
| 18 | `Write cards.completeness (initial)` | code (`completeness.js`) | `cardCompleteness({criteria, claims})` — whatever the deck itself already covered, before any gap question is asked |
| 19 | `IF: any gap criteria?` | if | false → skip to 21 with `gap_questions:[]`; true → gap-question-phraser call (§7) |
| 20 | `Write interviews (kind='first')` | code | Persists the question set, §8 |
| 21 | `Update applications.status → 'screening'`, write `events` | code | `event_type='application_submitted'`, `entity_type='founder'` |
| 22 | `Cache deck meta on applications.artifact_links` | code | Writes `_f08_deck_meta` (§2.2) |
| 23 | `Build IntakeResponse` | code | Assembles the exact §4.1 shape, `deck.pages`/`chars_extracted` = **0, never null**, on the `none` branch (§4) |
| 24 | `Respond: success` | respondToWebhook | 200 |
| 25 (optional, recommended — not mandated by any corrective finding, see §9.2) | `Trigger f03-score-founder`, write `events` | executeWorkflow + code | Wired **after** node 24, fire-and-forget — §9.2's T20 mechanism applies here too, for the same reason: a brand-new founder's first score should exist as early as possible for 09's dashboard |

Plus, per §0.3.1: every one of steps 4/6/8/9/10/11/12/13/14/16/17/18/20/21/22 that calls Storage,
PostgREST or OpenAI wires its error output to the shared `Handle unexpected error` →
`Respond: internal error` pair (not separately numbered above, to keep this table readable).

### Why the numbers don't match `design.md`'s 8-row table 1:1

`design.md` §3 lists 8 conceptual steps; this spec expands them into ~25 nodes because it also
covers validation, idempotency, rate limiting and response-building, which the design table
folds into "1 Validate" and doesn't enumerate. No step here contradicts the design's ordering
constraint (**entities before any raw write**, ⟨step 9 before step 11⟩) or its idempotency
model (⟨step 10's `id=intake_submission_id` is the PK-collision gate⟩).

### 2.0 `applications.kind`/`cards.card_type` — the constraint-bearing columns, named explicitly

Per the plan review's own instruction to name these rather than leave them implicit:
**`applications.kind = 'inbound'`** always (the `CHECK` in `db/schema.sql` also allows
`'radar_activated'`, which is 02's track, never 08's) and **`cards.card_type = 'founder'`** (the
exact `card_types` registry slug — the other two seeded slugs, `company` and `team`, are not used
by this feature; 08 writes `founder.expertise.*`/`founder.leadership.*` claims only, so every card
it creates is the `founder`-type one).

### 2.1a Idempotency runs before rate limiting — not an arbitrary ordering choice

The plan review's own framing: *"a long serial chain under a 90 s client abort makes
timeout-then-retry likely, not an edge case."* If the rate-limit check (step 6) ran **before** the
idempotency check (step 4), a founder whose connection stalls and retries several times would be
charged against their rate-limit budget for every retry of the **same** application — plausibly
locking themselves out of their own resubmission. Checking idempotency first means every retry of
an already-completed (or in-flight-but-already-row-created) application short-circuits for free,
**before** it can ever count against the limiter; only a genuinely new `intake_submission_id`
reaches the rate-limit gate at all.

### 2.1 The idempotency cache — a deliberate refinement, flagged

`design.md` says a retry "collides on the primary key" and must return "the existing result, not
an error" but does not specify the mechanism. This spec caches only the two fields that cannot be
cheaply reconstructed from current DB state — `extraction_mode`, `pages`, `chars_extracted`,
`warning` (nothing in the schema stores these numbers anywhere else) — inside
`applications.artifact_links._f08_deck_meta`, written once at step 22. **Everything else in the
cached response is re-read live** (`status`, `card_completeness` via `completeness.js`,
`gap_questions` via the `interviews(kind='first')` row's still-pending questions,
`extra_files_stored` via `artifact_links.extra_file_paths` length), which is more correct than a
frozen snapshot would be (e.g. `status` reflects any downstream change, not the value at
submission time). The `_`-prefix follows the exact `_f07_input_fingerprint` convention (07 README)
— internal plumbing inside a jsonb column that other features must never render as founder data.

### 2.2 `applications.artifact_links` shape 08 writes — the name collision the plan review caught

The request's `artifact_links` field is an **array** of `{url, kind}`; the column of the same name
is a jsonb **object** whose shape feature 02 already froze
(`{source, hn_item_id, hn_url, title, story_text, artifact_url, artifact_kind, repo, homepage}`).
**Writing the request array straight into `applications.artifact_links` overwrites that object and
breaks every consumer keying on `source`/`artifact_kind`** on a `radar_activated` row — not a risk
for an `inbound` row specifically (08 always creates a fresh row, never touches an existing
`radar_activated` one), but the wrong habit to establish since a future feature copying this
pattern onto an existing row would collide for real. 08's own shape, additive on 02's `source`
convention, never a reshape of the array itself:

```jsonc
{
  "source": "intake_form",
  "intake_submission_id": "<uuid>",
  "founder_links": [ { "url": "...", "kind": "github_repo" }, ... ],  // from request artifact_links, verbatim
  "deck_filename": "acme-deck.pdf",
  "extra_file_paths": [ "<application_id>/<sha256_16>-demo.mp4" ],   // Storage keys, so extra_files_stored
                                                                       // (response field) is `.length` of this,
                                                                       // never a separate counter to keep in sync
  "_f08_deck_meta": { "extraction_mode": "text_layer", "pages": 14, "chars_extracted": 8412, "warning": null }
}
```

**`kind` tolerance, stated once so it isn't re-litigated per call site:** `validate.js`'s
`inferArtifactKind` (the authoritative, backend-side re-derivation — see §0.4) only ever produces
`github_repo | github_user | product | other`. **It never produces `'none'`** — that is 02's own
vocabulary for its *own* `artifact_kind` field on a different application track, not a value this
feature's `founder_links[].kind` will ever carry. There is no real mismatch to reconcile inside
08's own write path; the tolerance the plan review flagged matters only if some future consumer
reads `founder_links[].kind` expecting 02's four-value enum (`github_repo|github_user|product|none`)
instead of `validate.js`'s (`github_repo|github_user|product|other`) — worth stating defensively
here so nobody downstream is surprised by `'other'` where they expected `'none'`.

## 3. Entity resolution (`identity.js`, step 9) — the ordering problem, resolved

`identity.js` exports `resolveFounderIdentity(payload, lookupIdentity)` — a **pure decision
function that does no DB I/O itself**. The Code node's job is to build `lookupIdentity(kind,
value)` as an inline async callback (a `this.helpers.httpRequest` PostgREST GET against
`founder_identities`, returning a bare `founder_id | null`), call
`resolveFounderIdentity({contact_email, artifact_links, deck_extracted_name}, lookupIdentity)`,
and then act on the returned `{action:'attach'|'create', founder_id, identities_to_write,
defaults}`:

- **`action:'attach'`** — `founder_id` is already resolved; `POST founder_identities` each entry
  in `identities_to_write` (select-first on `(kind,value)` to avoid a `23505` if an identity is
  already attached to someone — `resolveFounderIdentity` itself already only proposes identities it
  has proven don't belong to a *different* founder, per its own header comment on the symmetric
  extension beyond `design.md` §3.1's literal text).
- **`action:'create'`** — `POST founders` using `defaults` (see below), then `POST
  founder_identities` each entry in `identities_to_write`.

`design.md` §3.1 says `founders.full_name` should be the **deck-extracted** name, falling back to
the email local-part — but entity creation (step 9) runs **before** the deck cascade (step 12)
extracts anything, because `raw_signals`/`claims`/`evidence` all need `founder_id` to exist first
(the GDPR NULL-FK rule, binding on every feature per `TRACKER.md`). `defaultsForNewFounder({
contact_email, deck_extracted_name})` accepts an optional `deck_extracted_name` and is agnostic to
*when* it's called — this spec resolves the ordering conflict as a two-phase write, not a
reordering of the GDPR-load-bearing constraint:

1. **Step 9 (before cascade):** call `resolveFounderIdentity` with `deck_extracted_name` **omitted**
   (it isn't known yet) — on `action:'create'`, `defaults.full_name` resolves to the email
   local-part (`defaultsForNewFounder`'s own fallback) or the literal string `'Unknown founder'` if
   even that is empty. On `action:'attach'`, no name is ever touched — an existing founder's
   `full_name` may already be curated from radar data, and overwriting it with deck text on every
   re-application would be a regression, not a feature.
2. **Step 15 (after cascade):** if `action` was `'create'` **and** the extractor returned a
   non-null `founder_identity`, `UPDATE founders SET full_name = <deck's
   founder_identity.full_name> WHERE id = founder_id`. `founders` is a mutable table (no
   `forbid_mutation` trigger on it), so this single follow-up `UPDATE` is legal and cheap.
   `founder_identity` itself is never written as a claim (per the extractor's own input spec).

**Critical, easy-to-miss detail on the GitHub-match lookup (`lookupIdentity('github', owner)`):**
02 writes `founder_identities(kind='github', value=<ghUser.login>)` with the **login's natural
GitHub casing** (`lib/f02/write.js:340`, `lib/f02/pipeline.js:496` — `value: effGhUser.login`, not
lowercased). A URL like `github.com/ayuhito/repo` typically arrives lowercase from the founder's
own paste. `founder_identities(kind,value)` is a **plain-text `UNIQUE`**, case-**sensitive** by
default in Postgres. **A case-sensitive `eq.` lookup here would silently miss the exact match this
feature exists to make** — the `ayuhito` cross-feature narrative design.md §3.1 calls "the case
that matters for the demo" would quietly fail. `lookupIdentity`'s GitHub branch must use
PostgREST's `ilike` operator with **no wildcard characters** (`value=ilike.<owner>` — `ilike` with
no `%`/`*` in the operand is an exact case-insensitive match, not a substring search),
`order=created_at.asc&limit=1` per the always-ordered convention. The email branch already
lowercases at write time on both sides (`design.md` §3.1: `value=lower(email)`), so a plain `eq.`
is correct there — `resolveFounderIdentity` itself already normalizes `contact_email` via its own
`normalizeEmail()` before ever calling `lookupIdentity('email', ...)`.

**Company:** this spec always creates a **new** `companies` row per intake submission
(`name=company_name.trim()`, `stage='pre_seed'`, `domain=NULL` — never derived from the email
domain, per `design.md` §3.1's explicit `UNIQUE` collision warning, and matching
`defaultsForNewFounder`'s own `companies_domain: null` field). `design.md` is silent on
company-level dedup for 08 (only founder-level dedup is specified); this spec does not invent one,
matching 02's own accepted "second `applications` row per candidate... a real but inert
duplicate" precedent rather than building a fragile name-matching heuristic under time pressure.
**Flagged as an assumption** — if the operator wants company reuse for a founder re-applying with
the literal same company name, that is a follow-up decision, not implied by anything read here.

`founder_company`: select-first on `(founder_id, company_id)` (the table's own `UNIQUE`), else
`POST {founder_id, company_id, role: defaults.founder_company_role, is_current:true,
source:'intake_form'}`. `confidence` left `NULL` (no basis to assert one at intake).

## 4. Deck cascade (step 12) — text layer → vision → honest absence

```
Convert to File (binary from deck.base64)
  → Extract From File (pdf; text property + numpages)
  → chars_extracted = text.length
  → IF chars_extracted >= DECK_TEXT_THRESHOLD_CHARS (proposed 200 — §12 of design.md:
    "set empirically during build", tune against real demo decks)
       │yes                                              │no
       ↓                                                  ↓
  extraction_mode='text_layer'          Vision fallback attempt (see below)
```

**Model split — corrected in this revision.** `agents/deck-claims-extractor/
deck-claims-extractor-agent-model-recommendations.md` (now built) specifies **`gpt-5.6-luna` on
the `text_layer` branch and `gpt-5.6-terra` (multimodal) on the `vision` branch** — this spec's
first pass wrongly used `luna` uniformly. The reasoning recorded there: `luna` is the closed-vocab
extraction/classification workhorse and every string it returns is span-verified anyway, but its
multimodal support is **not verified** (`deck-claims-extractor-agent-tbd-items.md` TBD-1), so the
rarer, more expensive vision branch uses the safer general-purpose tier instead. Both branches omit
`temperature` entirely (same reason as everywhere else in this repo) and both use the same
`/v1/responses` + `text.format.json_schema(strict:true)` request shape as 07's own extractor
(§0's conventions). The `vision` branch's confidence cap (`mode_cap: 0.64`) is fixed regardless of
model — "a better model does not raise that cap: the cap describes the channel, not the reader"
(the model-recommendations doc's own words).

**Vision mechanism — a load-bearing assumption, flagged clearly.** `design.md` §5 describes
"pages as images → multimodal model", but **this n8n build has no PDF-rasterization node** (no
bind mount, no external binary, `ExtractFromFile` reads text only) and no other feature has ever
needed one. Rather than invent a rasterization pipeline this environment cannot run, this spec
sends the **original PDF directly** as an `input_file` content part (`{"type":"input_file",
"filename":..., "file_data":"data:application/pdf;base64,<...>"}`) to `gpt-5.6-terra` over
`/v1/responses` — OpenAI's Responses API renders PDF pages as images internally for multimodal
models, which satisfies the design's intent ("read the deck visually") without n8n doing any
rendering itself. **This must be verified live before the demo** — if `gpt-5.6-terra` rejects
`input_file` or the container has no route to render it, `plan.md`'s own cut order already
sanctions dropping this branch entirely: *"the vision fallback in T10 (keeping the honest
`image_only_deck` declaration, which is the part that scores)"* is explicitly the **first** thing
to cut under time pressure, not a corner this spec is quietly taking — go straight from
`chars_extracted < threshold` to `extraction_mode='none'`, `warning='image_only_deck'`, and skip
straight to writing the five `missing` claims (§4.1) if vision proves infeasible. If kept, the plan
review caps it at ~6 pages to bound the 90 s budget.

**Failure-reason → response-warning mapping** (from the extractor's own JSON schema,
`agents/deck-claims-extractor/deck-claims-extractor-agent-json-schema.json`):

| Model `failure_reason` | Final `extraction_mode` | Response `deck.warning` |
|---|---|---|
| `null`, `claims` or `founder_identity` non-empty | `text_layer` or `vision` (whichever path ran) | `null` |
| `no_text_extracted` (vision path found nothing usable) | `none` | `image_only_deck` |
| `unreadable_input`, **or** `Convert to File`/`Extract From File` threw | `none` | `extraction_failed` |

A thrown error from `Convert to File`/`Extract From File` (genuinely corrupt binary, not just a
sparse deck) is caught via the node's own `onError: continueErrorOutput` (or an enclosing
try/catch in a wrapping Code node) and routed straight to the `extraction_failed` row of the table
above — vision is not attempted on a file that couldn't even be converted.

**On any `none` outcome, `deck.pages` and `deck.chars_extracted` in the response are `0`, never
`null`** — `IntakeResponse.deck.pages`/`.chars_extracted` are non-nullable `number` in
`web/src/lib/types.ts`, and `Extract From File` genuinely produces neither value when it never ran
(the crash case) or produced only a sparse/zero-length string (the honest-empty-deck case). `0` is
the correct, type-safe value in both — never leave the field `undefined`/`null` and never omit it.

### 4.1 Writing claims + evidence from the extractor's output

For each item in `claims[]` (deck-claims-extractor output, ≤15 total, mapped 1:1 by
`criterion_id` to `topic` per its own schema's `allOf` constraints):

```
claims: {
  card_id: <the 'founder' card from step 10>, topic, text_verbatim, value,
  axis: null, source_kind: 'self_reported' (never 'public' — ⟨R-6⟩ negative-capability guard),
  base_confidence: span_factor × mode_cap (agent input-spec table: 0.80 text_layer / 0.64 vision,
    ×1.00 exact substring / ×0.90 near-verbatim / claim DROPPED if quote_verbatim not found —
    recorded instead in ai_runs.output_json.hallucination_flags[]),
  verification_status: 'unverified',
  content_hash: contentHash.claim({application_id, card_id, topic, item_key: null})  -- salted
    with application_id so a genuine re-application (new application row) does not collide with an
    earlier one over the same deck content (⟨R-15⟩); select-first on this hash before inserting.
}
evidence: {
  claim_id, relation:'supports', tier: 'documented' (text_layer) | 'inferred' (vision),
  strength: null (no strength convention given for self_reported deck claims; leave null rather
    than invent one — 03's negative-capability guard reads source_kind, not strength, for this path),
  quote_verbatim, source_url: null, raw_signal_id: <the step-11 raw_signals row's id>,
  content_hash: contentHash.evidence({application_id, claim_id, relation:'supports', raw_signal_id})
}
```

**Absence markers** — for each of the 5 topics **not** present in `claims[]` (closed set:
`founder.expertise.vertical_tenure`, `.insight_specificity`, `.competitor_granularity`,
`founder.leadership.first_customers`, `.icp_specificity`), following `lib/f07/run.js`'s exact
precedent for its own `company.*` gap claims (`GAP_LABELS`, `source_kind:'derived'`,
`content_hash: null`, select-first on `(card_id, topic, source_kind=eq.derived)`):

```
claims: { card_id, topic, text_verbatim: '<label>: not stated in the deck.',
          value: null, axis: null, source_kind: 'derived', verification_status: 'missing',
          content_hash: null }
evidence: { claim_id, relation:'context', tier:'missing', quote_verbatim: null, source_url: null,
            raw_signal_id: <the step-11 raw_signals row>,
            content_hash: contentHash.evidence({application_id, claim_id, relation:'context', raw_signal_id}) }
            -- evidence.content_hash is NOT NULL in the schema even here (unlike claims.content_hash,
            which is nullable) -- hashing.js's own generic evidence() recipe already covers this case
            (the missing marker's raw_signal_id still points at the step-11 row), so no bespoke
            recipe is needed (§13, item 7 — this spec's first pass wrongly invented one).
```

An `ai_runs` row is written **before** any of the above (`task_type:'extraction'`, `model:
'gpt-5.6-luna'` on the `text_layer` branch / `'gpt-5.6-terra'` on the `vision` branch, `founder_id`,
`company_id`, `application_id`, `output_json`), select-by-`input_hash`-first exactly like 07's
`writeAiRun()` — "model proposes, backend decides" (design §7). `extraction_mode='none'` (either
honestly-empty-deck or crash) skips the model call entirely and writes only the five absence
markers, per `design.md` §5's cascade diagram.

### 4.2 The invariant every write above must satisfy — checked by an exact query, not by inspection

Per the plan review, restated as this feature's own binding rule (`design.md` §4, and the same
class of defect 02/04's QA already found live twice — 9 `raw_signals` rows and 3 `evidence` rows
with the identical shape of bug): **every claim 08 writes must have ≥1 `evidence` row with
`raw_signal_id` populated, and no claim may ever carry `source_kind='public'`** — 03's
negative-capability fallback maps `'public'` to "any source (wildcard)", so one evidence-less
public claim silently licenses a `not_met` verdict on **every** criterion, inverting REQ-003. This
is checkable directly and should be, on every claim card this workflow writes to:

```sql
select count(*)
from claims c
left join evidence e on e.claim_id = c.id
where c.card_id = <card_id>
  and (e.id is null or e.raw_signal_id is null or c.source_kind = 'public');
-- must return 0
```

Run this (parameterized on the just-created card) as part of §0.3.2's post-build verification, not
only at QA time — it is the cheapest possible check that steps 11/14 actually wired
`raw_signal_id` correctly, and it would have caught 02/04's exact historical bug immediately.

## 5. Calling `f07-thesis-gate` (step 13's Merge branch, or a plain sequential call)

**Exact input contract**, confirmed from `07/design.md` §6.1 (not `gate_text` — that name is an
internal variable inside 07's own Code nodes, never the wire format): `{application_id, text,
mode, structured_hints?}`, called as an `n8n-nodes-base.executeWorkflow` sub-workflow call
(`workflowId: EQxi1lFF2bDjDByd`, per `n8n/workflows/README-f07.md`), fields flat, no `.body`
wrapper. 08 supplies no `structured_hints` (it has none to offer, unlike 02's
`geography_country`). `mode:'full'`.

**What `text` to send — a refinement of design.md's literal wording, flagged.** §3.3 says "on the
`extraction_mode='none'` branch we send an empty string," which literally covers only the
crash/zero-chars case. This spec sends **whatever `Extract From File` actually produced**,
independent of 08's own `text_layer`/`vision` branching — even a deck that falls under 08's
`DECK_TEXT_THRESHOLD_CHARS` (too sparse for 08's own extractor) may still be non-empty and useful
to 07's independent `company.*` extraction, which tolerates sparse input by design ("Sparse text
is the NORMAL case, not a defective one" — 07's own system prompt). Only a genuine zero-character
result (crash, or truly blank PDF) sends `text: ''`, which 07 handles as a documented, correct
`insufficient_evidence` outcome (07 design §2, D-07).

07's response: `{verdict, fit, coverage, fired_rules, missing_fields}` — 08 does **not** read or
act on `verdict`/`fit` (that is 07's own persistence procedure's business — it already writes
`applications.thesis_gate`, `scores(axis='thesis_fit')`, `thesis_evaluations` internally per its
"Write applications cache" node). 08 only needs the call to have happened; nothing in the
`IntakeResponse` shape surfaces thesis fit.

**Recommended parallelization (optional, not mandatory).** `deck-claims-extractor` (§4) and
`f07-thesis-gate` are mutually independent — both read the same extracted text and
`application_id`, neither depends on the other's output. Running them as two genuinely parallel
branches (an `n8n-nodes-base.merge`, `mode:'append'`, `numberInputs:2`) shaves real latency off
the 90 s intake-submit timeout (`lovable-brief.md` §4 — deck submit is the one endpoint budgeted
for "parses a PDF **and** calls a model," suggesting one model call in the critical path was the
original mental model, not two sequential ones). **If build time is tight, running them
sequentially is equally correct against every acceptance criterion in `plan.md` T10** — this is a
latency optimization, not a behavior this spec requires.

## 6. `card_completeness` (`completeness.js`) — computed at steps 16–18 and beyond

`cardCompleteness({criteria, claims})` = `covered_weight ÷ reachable_weight` over exactly
`{L2: 0.15000, L3: 0.09000, X5: 0.05625}` (`reachable_weight = 0.29625`, fixed — read live from
`score_formulas.config.criteria` rather than hardcoded, so a config change is honored without a
code change). "Covered" = a `claims` row exists for that criterion's mapped topic with
`verification_status <> 'missing'`. The function's own `round2` is `Number(value.toFixed(2))` —
**L2 alone → `0.15/0.29625 = 0.50631...` → `0.51`, not `0.505`** (this spec's first pass rounded
wrong; `plan.md`'s own T9 correction states this exact value and rounding rule, matching
`completeness.js`'s live code directly). Recomputed **fresh from the claims table's current
state** every time it is needed (intake-submit's initial write at step 18, gap-answers,
followup-answers, followup-create, application-status) — never cached as a delta, so a later
correction (05's truth-gap work flipping a `verification_status`, or this feature's own T20 rescore
trigger writing new claims) is reflected automatically without any caller needing to know about
it.

## 7. Gap questions — `gaps.js` (selection) + `gap-question-phraser` (phrasing) — both now built (T4 done)

**Selection (`gaps.js`, step 17), pure and deterministic:** `GET
score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`
→ `config.criteria` → `selectGapCriteria({criteria, claims, cap:3})` (§1) → keep entries whose
`neg_src` is a subset of `{'deck_parse','interview_answer'}` → drop any whose mapped topic already
has a non-`missing` claim (from §4.1's write) → sort by `weight` DESC → cap at 3. Against the live
seed, this always yields exactly `[L2, L3, X5]` **minus whatever the deck itself already
covered** — 0 to 3 entries, each already carrying `{id, anchor, weight, topic}`.

**IF 0 criteria selected:** skip the LLM call entirely, `gap_questions: []` in the response; still
write the `interviews` row with an empty `questions` array (§8) so `f08-gap-answers`/
`f08-application-status` never need a "does a `first` interview exist at all" branch.

**IF 1–3 selected → `gap-question-phraser`** (standalone `httpRequest` node, `gpt-5.6-terra`,
`temperature` omitted, `/v1/responses` + `text.format.json_schema(strict:true)` — same shape as
`deck-claims-extractor`'s call, request body built in a preceding Code node exactly like 07's
`Build extractor request` → `__extractor_request_body` → `jsonBody: {{
JSON.stringify($json.__extractor_request_body) }}` idiom, to sidestep the `{{ }}`
brace-truncation bug 07's README documents). **Note: the output schema's top-level type is
`array`, not an object with a `questions` key** — `gap-question-phraser-agent-json-schema.json`'s
`$schema`/`type` are `"array"` directly; the `json_schema.schema` field in the request body must be
that array schema verbatim, not wrapped.

**Input — `card_context` + `selected_criteria`, exact shape from the agent's own input spec:**

```jsonc
{
  "card_context": {
    "company_name": "Acme Robotics",                 // from the validated payload
    "what_is_built": "Route planning for regional carriers", // from 07's company.what_is_built claim; null if absent
    "sector": "logistics",                            // from 07's company.sector claim; null if absent
    "geography_country": "DE",                        // from 07's company.geography_country claim; null if absent
    "deck_readable": true,                             // extraction_mode !== 'none' — LOAD-BEARING, see below
    "public_footprint": [ { "kind": "github_repo", "url": "..." } ], // straight from validated artifact_links, no DB call
    "known_claims": [ { "topic": "founder.expertise.vertical_tenure", "text_verbatim": "..." } ] // ≤8, from step 14's OWN claims output, in-memory — no extra round-trip
  },
  "selected_criteria": [ { "criterion_id": "L2", "anchor": "First customers / LOI / pilot evidence", "weight": 0.15 } ]
}
```

`what_is_built`/`sector`/`geography_country` require a small `GET claims?card_id=eq.<card_id>&
topic=in.(company.what_is_built,company.sector,company.geography_country)` **after** the Merge
point (§5) — 07's own sub-workflow call has already written these by the time execution reaches
this node, since `executeWorkflow` waits for completion by default. `deck_readable` is a straight
boolean off the already-known `extraction_mode`.

**`deck_readable` is load-bearing** (the agent's own D-2): on the `extraction_mode='none'` branch
every topic is `missing`, so a naive `why` line reads "your deck doesn't name a first customer" —
false, and instantly catchable by a founder who knows their own deck. `deck_readable:false`
forbids the model from claiming the deck said nothing.

**Output validation gate — enforced in code, not left to the prompt** (the agent's own D-3, "the
one constraint in feature 08 with a measured cost attached to violating it"):

1. Exactly one item per `criterion_id` sent, **same order**, no extras, no omissions.
2. Length caps: `question` ≤140, `why` ≤120, `placeholder` ≤120 chars.
3. **Forbidden-substring scan, case-insensitive, stems not whole words** (inflections are the
   leak): `interview`, `assess`, `evaluat`, `screening`, `screen`, `" test"`, `vetting`,
   `candidate`, `applicant`, `"your score"`, `ranking` — scanned over all three string fields.
4. Exactly one `?` character in `question`.

**On any validation failure for one item, substitute the static per-criterion fallback rather than
dropping the question or failing the call** (the agent's own D-4 — "a dropped question silently
forfeits up to 0.15 of reachable founder-score weight… a slightly less personal question beats a
missing one"). Fallback text, verbatim from `gap-question-phraser-agent-tbd-items.md`:

| Criterion | question | why | placeholder |
|---|---|---|---|
| L2 | Who is using it today, and how did the first one find you? | Nothing we found publicly shows who is using it yet. | A name, a date, and how the conversation started is enough. |
| L3 | Who was the last person who really wanted this, and what were they using before? | We couldn't tell from public sources who actually signs. | Their job title, their company size, and what they did instead is plenty. |
| X5 | When someone chose a different tool over yours, what did they pick and what did it do better? | We can find who your competitors are; we can't find where you actually lose. | One specific instance is more useful than a full comparison. |

`ai_runs` row written first, `task_type:'question_generation'` (the agent's own input-spec
wording — this spec's first pass invented `'gap_question_phrasing'`, corrected here), carrying
`application_id` and `founder_id`, same select-by-hash-first discipline as everywhere else.

**This same node/logic is called a second time**, unchanged, from `f08-followup-create` (§10.3,
plan.md T19) — one agent serves both call sites (the agent's own D-7), so this section is the one
place its wiring needs describing.

## 8. Persisting the question set — `interviews` (step 20)

One row per application at intake time, **always written even if `questions` is empty** (keeps
`f08-gap-answers` and `f08-application-status` from needing a "does a `first` interview exist at
all" branch):

```
INSERT interviews {
  application_id, card_id: <founder card>, kind: 'first', status: 'pending',
  transcript: { "questions": [
    { "criterion_id": "L2", "question": "...", "why": "...", "placeholder": "...",
      "status": "pending", "answer_text": null }, ...
  ] }
}
```

`disclosed_at` — set to `now()` at this same insert (the AI-disclosure banner is shown on `/apply`
before submission, so disclosure has already happened by the time this row exists; there is no
later "disclosure" event for the `first` kind to mark).

**`transcript.meta` (`asked_by`/`note`) does not apply to `kind='first'`** — those two fields exist
only on the `kind='follow_up'` shape (§10.1/§10.3), where `lovable-brief.md` §4.4's contract
actually surfaces them. Do not add an empty `meta` object here; the `first`-kind transcript is
exactly `{questions:[...]}`, nothing else.

## 9. `f08-gap-answers`

11 nodes (10 + the T20 rescore trigger), plus the shared catch-all pair (§0.3.1):

| # | Node | Type | Purpose |
|---|---|---|---|
| 1 | `Webhook: f08-gap-answers` | webhook | POST, `responseMode:"responseNode"` |
| 2 | `Validate input` | code | `application_id` is a UUID; each `answers[]` item has `criterion_id`/`question`/`answer_text`; `skipped_criterion_ids[]` are strings |
| 3 | `IF: valid?` | if | false → respond 400 |
| 4 | `Fetch application + first interview` | code | `applications` join `interviews(kind='first')`, `order=created_at.asc&limit=1` on the interview |
| 5 | `IF: application found?` | if | false → respond 404 `not_found` |
| 6 | `IF: interview already completed?` | if | true → 7 (idempotent replay); false → 8 |
| 7 | `Build replay response` | code | Recompute `card_completeness` fresh (§6, `completeness.js`); reuse stored `accepted`/`skipped` counts from `transcript`; → respond 200. No re-write, no rescore trigger — nothing changed. |
| 8 | `Write answer claims + evidence + raw_signals` | code (`hashing.js`) | Per answered item, §9.1 below |
| 9 | `Update interviews (status='completed')` | code | Merge per-question `status`/`answer_text` into `transcript`, `completed_at=now()` |
| 10 | `Recompute completeness, write events, respond` | code + respondToWebhook | `completeness.js` (§6); `events(event_type='gap_answers_submitted', entity_type='founder')`; build `{accepted, skipped, card_completeness, status, verdict_eta_hours:24}` → 200 |
| 11 | `Trigger f03-score-founder rescore` | executeWorkflow + code | Wired **after** node 10's `Respond` — see §9.2 (T20) |

### 9.1 Writing an answered gap question

```
raw_signals: { source:'interview_answer', payload:{criterion_id, question, answer_text},
  founder_id, company_id, observed_at: now(),
  content_hash: contentHash.rawSignal({application_id, source:'interview_answer', content_key: criterion_id+'::answer'}) }
claims: { card_id, topic: <criterion_id mapped back to its topic, same map as §4.1's schema>,
  text_verbatim: answer_text (verbatim, word-for-word — REC-009/RSK-003, never paraphrased),
  value: null, axis: null, source_kind:'interview', base_confidence: 0.30 (proposed — matches
    the `credit.self_asserted` anchor already in this exact `score_formulas` config; no other
    "low base confidence for an unverified self-report" number exists anywhere else in this
    schema to borrow instead), verification_status:'unverified',
  content_hash: contentHash.claim({application_id, card_id, topic, item_key: 'interview'}) }
evidence: { claim_id, relation:'supports', tier:'discovered' (signal_sources.interview_answer.
    base_tier), quote_verbatim: answer_text, source_url: null, raw_signal_id: <the row above>,
  content_hash: contentHash.evidence({application_id, claim_id, relation:'supports', raw_signal_id}) }
```

A **skipped** `criterion_id` writes nothing new — the existing `missing`-verification claim from
§4.1 already carries the lowered confidence guardrail #7 requires ("skip → confidence down, score
untouched"); skipping is the absence of an opportunity to improve it, not a new fact to record.
Only `interviews.transcript`'s per-question `status` changes to `'skipped'`.

### 9.2 Recomputing the founder score after answers land (T20) — the feature's headline claim

**Nothing in this spec's first pass triggered a rescore at all**, per the plan review: `design.md`
§6 promises the three questions "lift coverage, measurably, on screen," and `scores(axis=
'founder_score')` held **zero rows for the resolved founder** database-wide until something calls
`f03-score-founder`. A deck-less founder legitimately scores `insufficient_evidence` *because*
L2/L3/X5 are unreachable; step 8 above writes exactly the claims that close them; without this
step, nobody ever re-scores, and the claim that answering questions moves the number is never
actually demonstrated.

**Mechanism — "respond, then keep working," not a second request the client waits on.** Node 11 is
wired **after** node 10's `Respond: success` in the connection graph. n8n sends the HTTP response
as soon as a `respondToWebhook` node executes, but the workflow execution continues to whatever is
wired after it — so `f08-gap-answers`'s **15 s** client timeout (`web/src/lib/api.ts`,
`DEFAULT_TIMEOUT_MS`) is measured only against reaching node 10, never against node 11's own
duration. This matters concretely: `f03-score-founder` fans out to 4 parallel `luna` sub-scorers
plus GATE/AGGREGATE (`n8n/workflows/README-f03.md`) and could easily exceed 15 s on its own —
blocking the response on it would blow the contract.

**Call shape**, per `n8n/workflows/README-f03.md`'s own documented entry point: `executeWorkflow`
sub-workflow call, `workflowId: AlkzJ70zET7SiHkn`, input `{founder_id}` **only** — 03 scores the
person, not an application, and `application_id` is deliberately not part of its input contract.

**08 does not read or act on the response at all** — `insufficient_evidence` afterwards (e.g. a
founder still below `min_coverage` even with the new claims) is a **valid, expected outcome**, not
a failure to handle; 03's own gate writes no `scores` row in that case, and 08 must not invent one
or treat a non-`scored` result as an error. Node 11 is followed by a plain `events` write
(`event_type:'rescore_triggered', entity_type:'founder'`) regardless of what 03 returned, purely
for auditability — the AC that coverage measurably rises belongs to QA (§0.3.2/T15), verified by
comparing a founder's `scores(axis='founder_score')` row before and after this call, not by
anything 08 itself inspects.

**The same trigger belongs on `f08-followup-answers`** (§10.2) for the identical reason — a
manager-initiated follow-up also writes new founder claims and should also feed back into the
score. **Extending it to `f08-intake-submit` itself (§2, node 25) is this spec's own recommended
addition, not something the plan review's T20 asked for explicitly** — reasoned here because a
GitHub-matched founder (radar-enriched, execution-signal claims already present) gains real
scoring value from an intake-time rescore even before any gap question is answered, while a
brand-new founder's rescore will usually (correctly) return `insufficient_evidence` — a cheap,
honest no-op, not a wasted call in the sense that matters (it costs one background workflow
execution, not anything in the response path).

## 10. `f08-followup` (GET, never consumes) and `f08-followup-answers` (POST, consumes)

### 10.1 `f08-followup`

| # | Node | Type | Purpose |
|---|---|---|---|
| 1 | `Webhook: f08-followup` | webhook | GET, `responseMode:"responseNode"`; token from `$json.query.token` |
| 2 | `IF: token param present?` | if | false → respond 400 |
| 3 | `Hash token, look up interview` | code (`hashing.js`) | `sha256Hex(token)`; `GET interviews?kind=eq.follow_up&share_token=eq.<hash>&select=*&order=created_at.asc&limit=1`. **Read-only — never touches `status`** |
| 4 | `IF: found?` | if | false → respond 200 `{valid:false, reason:'unknown'}` |
| 5 | `IF: now() - created_at > 24h?` | if | true → respond 200 `{valid:false, reason:'expired'}` |
| 6 | `Build FollowUpGetResponse` | code | Join `applications`→`companies` for `company_name`; `asked_by` = `transcript.meta?.asked_by ?? "The investor reviewing your application"` (the brief's literal default, used whenever the creator left it unset); `note` = `transcript.meta?.note ?? null`; `questions` = `transcript.questions` projected to `{criterion_id, question, why, placeholder}` (internal `status`/`answer_text` stripped — same `_`-style plumbing-hiding discipline as elsewhere); `already_answered = (status === 'completed')` |
| 7 | `Respond: success` | respondToWebhook | 200 |

**`asked_by`/`note` live under `interviews.transcript.meta`** (plan review correction — `interviews`
has no dedicated column for either): `transcript = {meta:{asked_by, note}, questions:[...]}` for
`kind='follow_up'` rows, written once at creation by `f08-followup-create` (§10.3) — 08 now owns
that write path, not a downstream consumer.

### 10.2 `f08-followup-answers`

12 nodes (10 shared with `f08-gap-answers`'s shape, §9, + a rescore trigger, §9.2), plus the
shared catch-all pair (§0.3.1). Same shape as `f08-gap-answers` with two differences: lookup is by
`share_token` hash instead of `application_id`, and **this is the point the token is consumed**
(`interviews.status → 'completed'`). An invalid/expired token at POST time (a race — the founder
opened the link, waited past 24h, then submitted) has no `valid:false` escape hatch in this
endpoint's frozen response shape (§4.4 only defines that shape for the GET); this spec maps it to
`{error:{code:'not_found', message:"This link is no longer valid."}}`, HTTP **404** — corrected
from this pass's earlier draft, which mismatched code (`internal`) against status (claimed 404,
but §0.3's own table maps `internal`→500); `not_found` is the code that actually belongs at 404 in
§0.3's table, and it fits this case exactly (the token genuinely no longer resolves to anything).
The frontend's generic §9.5 failure card renders `message` verbatim regardless of code, which is
exactly the copy a founder in this edge case needs.

**Same T20 rescore trigger as §9.2, wired after this workflow's own `Respond: success`** — a
manager-initiated follow-up also writes new founder claims (§9.1's shape, unchanged) and should
feed back into `scores(axis='founder_score')` for the same reason gap-answers does.

`f08-followup-create` (§10.3, plan.md T19) is the producer of the `follow_up` interview row and
its token — **this spec's first pass wrongly said that producer was out of scope for 08 ("feature
09's dashboard, or a manual DB insert"); the plan review corrected this: without it, this endpoint
pair is untestable and QA's token attacks (T15) have no real target, so T19 is now inside 08's own
scope.**

### 10.3 `f08-followup-create` — NEW in this revision, closes plan.md T19

**Not in `lovable-brief.md`'s five frozen contracts** — this endpoint is investor/manager-facing,
not called by the founder-facing SPA at all, so its request/response shape is this spec's own
design, not a frozen one. Per `plan.md` T19's own framing: *"without it T12 ships untestable and
T15's token attacks have no target — the manager-side producer lives in feature 09, which is not
built. Minimal: `application_id` + optional note → questions via T8/T4 → `interviews` row + token
→ returns the link. That link is also the mocked-email artefact STUB-001 promises, so it pays for
itself twice."*

`POST /webhook/f08-followup-create` — `{application_id, note?}` (`note` ≤2000 chars, free text,
stored verbatim, **never sent to the phraser model** — the agent's own input spec has no `note`
field; D-7's "same agent serves both call sites" is about the question-generation shape only, not
about incorporating a manager's free text into it. Production tier for that is `sol`, explicitly
deferred, per the model-recommendations doc's own "Premium" note).

9 nodes, plus the shared catch-all pair (§0.3.1):

| # | Node | Type | Purpose |
|---|---|---|---|
| 1 | `Webhook: f08-followup-create` | webhook | POST, `responseMode:"responseNode"` |
| 2 | `Validate input` | code | `application_id` is a UUID; `note` (if present) ≤2000 chars |
| 3 | `IF: valid?` | if | false → respond 400 |
| 4 | `Fetch application + founder card + current claims` | code | Same shape as §2's step 16 — feeds `gaps.js` |
| 5 | `IF: application found?` | if | false → respond 404 `not_found` |
| 6 | `Select 0–3 gap criteria` | code (`gaps.js`) | `selectGapCriteria({criteria, claims, cap:3})` — re-run against **current** state, not the intake-time snapshot; more time has passed and coverage may have changed (e.g. a prior `f08-gap-answers` call already closed one) |
| 7 | `gap-question-phraser call` (only if step 6 selected ≥1) | httpRequest + code | Identical wiring to §7 — same model (`terra`), same validation gate, same D-4 fallback. `card_context` rebuilt fresh (07's `company.*` claims, `deck_readable`, `public_footprint` from `applications.artifact_links.founder_links`, `known_claims` from the current claims fetched in step 4) |
| 8 | `Generate token + write interviews (kind='follow_up')` | code (`hashing.js` + Web Crypto) | See below |
| 9 | `Build response, respond` | code + respondToWebhook | `{interview_id, token, share_url, questions, expires_at}` → 200 |

**Token generation** — design.md §9's floor, applied here since this is where the token is minted:
32 random bytes via `require('crypto').randomBytes(32).toString('hex')` (same classic `crypto`
module `hashing.js` already uses, §0.1 — no separate Web Crypto call, no polyfill) for the **raw**
token returned to the caller; **only `sha256Hex(raw_token)` is stored** in
`interviews.share_token` (`text UNIQUE`, matches a hex digest). `expires_at` is derived, not
stored — `created_at + 24h`, computed identically by every reader (§10.1, §10.2).

```
INSERT interviews {
  application_id, card_id: <founder card>, kind: 'follow_up', status: 'pending',
  share_token: sha256Hex(raw_token), disclosed_at: now(),
  transcript: {
    meta: { asked_by: "The investor reviewing your application", note: note ?? null },
    questions: [ { criterion_id, question, why, placeholder, status:'pending', answer_text:null }, ... ]
  }
}
```

**`share_url`** — needs a base URL for the founder-facing app, which nothing in this stack
currently provides as an env var (the SPA is a local dev server with no fixed public origin).
**New env var this spec introduces: `$env.FOUNDER_APP_BASE_URL`**, defaulting to
`http://localhost:5173` (§0.5's confirmed Vite port) if unset. `share_url =
"${FOUNDER_APP_BASE_URL}/a/${raw_token}"`. Since STUB-001 mocks email delivery, this response
**is** the "composed message and link" the brief says gets shown in the UI (`design.md` §9) — 08's
job ends at returning it; whichever surface calls this endpoint (feature 09's dashboard, or a
`curl` for the demo/QA) is responsible for displaying it.

If step 6 selects **zero** criteria (everything already covered — a real, if unlikely, case for a
follow-up requested well after the founder answered everything), this workflow still creates the
`interviews` row with an empty `questions` array rather than special-casing "nothing to ask" —
consistent with §8's "always write the row" rule, and it leaves the decision of whether to
generate a followup with nothing new to ask to whichever UI calls this endpoint, not to 08 itself.

## 11. `f08-application-status` (GET)

| # | Node | Type | Purpose |
|---|---|---|---|
| 1 | `Webhook: f08-application-status` | webhook | GET, `responseMode:"responseNode"`; `application_id` from `$json.query.application_id` |
| 2 | `IF: application_id present + looks like a UUID?` | if | false → respond 400 |
| 3 | `Fetch application + company + card + first interview` | code | `applications` join `companies` (name), join `cards` (completeness, via the founder card), join `interviews(kind='first')` |
| 4 | `IF: found?` | if | false → respond 404 `not_found` |
| 5 | `Compute open_questions` | code | `0` if no `first` interview or `status='completed'`; else count of `transcript.questions[].status === 'pending'` |
| 6 | `Recompute card_completeness fresh` | code (`completeness.js`) | Same live-recompute discipline as §6 — never trust a stale cached number here, this endpoint's whole purpose is "current truth after a refresh" |
| 7 | `Build StatusResponse, respond` | code + respondToWebhook | `{application_id, company_name, status, submitted_at: applications.created_at, verdict_eta_hours:24, card_completeness, open_questions}` → 200 |

## 12. Constants this spec introduces (no source names them — proposed values, tune empirically)

| Constant | Value | Basis |
|---|---|---|
| `DECK_TEXT_THRESHOLD_CHARS` | 200 | `design.md` §12 explicitly defers this to build-time measurement against real demo decks — this is a starting point, not a researched number |
| `RATE_LIMIT_MAX` | 5 requests | per `design.md` §5.1's "simple per-email counter," no number given (§0's status table confirms the code is real, not just theoretical) |
| `RATE_LIMIT_WINDOW_SEC` | 60 | same |
| `BASE_CONFIDENCE_INTERVIEW` | 0.30 | borrowed from this exact `score_formulas` config's own `credit.self_asserted` anchor (§9.1) |
| `VERDICT_ETA_HOURS` | 24 | matches all founder-facing copy already committed in `web/` |
| `ESTIMATED_MINUTES` | 2 | same |
| `FOLLOWUP_NOTE_MAX_CHARS` | 2000 | this spec's own cap for `f08-followup-create`'s `note` field (§10.3) — no upstream source bounds it |
| `$env.FOUNDER_APP_BASE_URL` (new env var, not a constant) | default `http://localhost:5173` | needed to build `share_url` in `f08-followup-create` (§10.3); §0.5 confirms `:5173` as the working CORS-allowed origin, so it doubles as a sane default |

Token size (32 bytes) and validity window (24h) for `f08-followup-create` are **not** proposed
values — they're `design.md` §9's own stated floor, not invented here.

## 13. Assumptions — everything this spec decided where the source documents were silent or ambiguous

**Resolved by the plan review since the first pass (no longer open, kept here as a record):** the
`responseMode`/status-code mapping (now confirmed, §0.3), that CORS needs no per-node work (§0.5),
that the retry-replay behavior is required not optional (§2.1a/§2.1), that `f08-followup-create`
is inside 08's scope (§10.3), that a rescore trigger is required on `f08-gap-answers`/
`f08-followup-answers` (§9.2), and that `interviews.transcript.meta` is the home for
`asked_by`/`note` (§10.1). What remains below are this spec's own genuinely open calls.

1. **The exact HTTP status numbers (400/413/429/404/500, §0.3)** — that *some* per-branch status
   scheme is required is now confirmed by the plan review, not a guess; the specific numbers
   chosen are still this spec's own reasonable convention, not individually specified upstream.
2. **Vision fallback = OpenAI `input_file` PDF passthrough on `gpt-5.6-terra`**, not a
   page-rasterization pipeline this n8n build has no node for (§4). Flagged as needing live
   verification, with `plan.md`'s own cut order (vision is the **first** thing to cut) as the
   sanctioned fallback if it doesn't pan out.
3. **Idempotency cache scope** — only `_f08_deck_meta` (4 fields) is cached; everything else in a
   retry's response is reconstructed live from current DB state (§2.1). The plan review confirmed
   the *behavior* (retry returns existing result, checked before rate limiting) is required; this
   specific mechanism is this spec's own design.
4. **Two-phase `founders.full_name` resolution** (placeholder at creation, `UPDATE` after
   extraction, only for newly-created founders) — resolves an ordering conflict between §3.1's
   "deck-extracted name" default and the GDPR-driven "entities before any raw write" ordering,
   neither of which `design.md` reconciles explicitly. Consistent with `defaultsForNewFounder`'s
   own signature, which already anticipates being called with or without a `deck_extracted_name`.
5. **Case-insensitive GitHub identity lookup** (`ilike`, no wildcard) in the `lookupIdentity`
   callback — not stated anywhere, but required for the cross-feature "ayuhito" narrative to
   actually work given 02 stores the login's natural casing and `founder_identities.value` has no
   `citext`/case-folding.
6. **No company-level dedup** — every intake submission creates a new `companies` row, matching
   02's own accepted "duplicate `applications` row, not a correctness defect" precedent rather
   than inventing a name-matching heuristic `design.md` never asked for.
7. **Resolved, no longer open:** an earlier pass of this spec proposed a bespoke
   `evidence.content_hash` recipe for a `missing` marker, reasoning the column is `NOT NULL` even
   though `claims.content_hash` is nullable for the same row. Confirmed against the real
   `hashing.js` (§4.1): its own `contentHash.evidence({application_id, claim_id, relation,
   raw_signal_id})` recipe already covers this case generically — a missing-marker's
   `raw_signal_id` still points at the step-11 `raw_signals` row, so `relation:'context'` alone
   discriminates it from a `relation:'supports'` row on the same claim. No bespoke recipe needed;
   §4.1 uses the real function directly.
8. **`base_confidence = 0.30`** for interview-sourced claims — "low base confidence" is stated,
   no number is; borrowed from an existing anchor already live in the same config for internal
   consistency, not derived from any interview-specific source.
9. **`text` sent to `f07-thesis-gate`** is decoupled from 08's own `text_layer`/`vision`/`none`
   branching — send whatever `Extract From File` produced whenever it's non-empty, even below
   08's own vision-fallback threshold, since 07's extraction is independently tolerant of sparse
   input and gets no benefit from 08 being stricter on its behalf. `design.md` §3.3 only spells
   out the fully-empty case.
10. **Parallelizing `deck-claims-extractor` and `f07-thesis-gate`** behind a `Merge` node is
    recommended but explicitly optional — a latency choice, not a correctness requirement.
11. **Rate limiting is in-memory (`$getWorkflowStaticData`)**, resets on container restart — same
    limitation class as 02's Tavily budget, acceptable for a hackathon demo, not a production
    design. The producer is real (§0/§1), closing the plan review's "either specify a producer or
    disclose it's unreachable" instruction in favor of the former.
12. **`Buffer` is assumed to be an available Code-node-sandbox global** for the Storage upload
    (§0.2) — the one runtime-availability question in this spec still genuinely open, now that
    both `crypto` (`require('crypto').createHash`) and URL parsing (`identity.js`'s regex parser)
    turned out to need no polyfill at all (§0.1). Flagged for live verification; if wrong,
    `'buffer'` needs adding to `NODE_FUNCTION_ALLOW_BUILTIN`.
13. **`respondToWebhook` typeVersion `1.1`, `convertToFile`/`extractFromFile` typeVersion `1`** —
    proposed defaults; no prior workflow in this repo uses any of the three, so these need
    confirming against the live node picker before the generator script hardcodes them.
14. **`$env.FOUNDER_APP_BASE_URL` is a new env var this spec introduces** (§10.3, §12) — nothing
    upstream names it; needed only to build a human-clickable `share_url`, defaulted to the
    confirmed-working Vite origin so a missing env var degrades to something correct locally rather
    than an empty/broken link.
15. **`f08-followup-create`'s `note` is never sent to `gap-question-phraser`** — the agent's own
    input spec has no field for it, and D-7 ("same agent serves both call sites") is read here as
    being about the *output shape*, not about folding a manager's free text into the model's input.
    `note` is stored and displayed, not used for phrasing, in this MVP tier.
16. **`f08-followup-create` re-runs `gaps.js` against current claims** rather than replaying
    whatever was selected at intake time — since real time has passed and a prior
    `f08-gap-answers` call may have already closed a criterion, re-selecting is more correct than
    reusing a stale list, though `design.md`/`plan.md` don't specify this explicitly either way.
17. **Extending the T20 rescore trigger to `f08-intake-submit` itself** (§2, node 25; §9.2's final
    paragraph) is this spec's own recommendation, not something the plan review's T20 finding
    asked for by name — it only named `f08-gap-answers`. Cuttable independently of everything else
    in this document if it turns out to be unnecessary build effort.
