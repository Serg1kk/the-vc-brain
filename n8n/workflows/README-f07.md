# Feature 07 workflows — Thesis Engine

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f07-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f07-workflow.py --check   # check only, no write
```

The deterministic evaluator lives in `lib/f07/{vocabulary,rules,hashes}.js`, unit-tested (87
tests) outside n8n. n8n Code nodes cannot `require` local files, so that source is **inlined**
verbatim into the "Evaluate thesis" nodes by the generator. The extractor's system prompt and
JSON schema are likewise pulled straight out of `lib/f07/extractor/*` (not
`docs/backlog/07-thesis-engine/agents/thesis-attribute-extractor/`, which is gitignored from the
public repo — `lib/f07/extractor/` is the runtime copy `lib/f07/run.js` also reads, verified
byte-identical to the docs/ original), never retyped by hand. Editing the JSON directly makes the
tested modules / reviewed prompt and the running workflow drift apart — the exact class of silent
divergence this generator exists to prevent (same reasoning as `n8n/build-f03-workflow.py` /
`n8n/build-workflows.py`).

**This generator was cross-checked against `lib/f07/run.js`** (the team lead's headless
reference implementation, 133/133 tests, independently verified live) after the fact, per the
team lead's instruction, and corrected in three places where run.js's actual behavior disagreed
with this file's earlier reading of the design prose — see the topology notes below.

## Registered workflows

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f07-db-write` | `7pEtpy8sS3VLgVt2` | 6 | design.md §5.4 write path only: `ai_runs → cards → raw_signals → claims → evidence`. Sub-workflow, called via Execute Workflow from `f07-thesis-gate`'s full-mode branch. |
| `f07-thesis-gate` | `EQxi1lFF2bDjDByd` | 34 | Both modes (`full`/`keyword`), the extraction validator, the persistence procedure (design.md §2/§5/§6). |
| `f07-thesis-reevaluate` | `2dqjJ7HRCudSqnWT` | 26 | Does **not** re-extract; reads current claims (contradicted → unknown); writes new rows only. |

Entry points: `POST /webhook/<name>` with the design.md §6.1 body shape, or as an Execute-Workflow
sub-workflow call from another workflow (02/08 will call `f07-thesis-gate` this way once they
exist) with the same fields flat (no `.body` wrapper). All three are currently **active**.

## Why `f07-db-write` is not a call to `f04-db-write`

Checked, per the plan's own instruction, before building a second copy. The card-preflight
resolution genuinely is identical and is reused verbatim below. But `f04-db-write`'s
`raw_signals`/`claims`/`evidence` hash recipes are hard-coded inside **its own** Code nodes and
are f04's, not 07's: `04-db-write` anchors `claims.content_hash` on `ai_run_id` **deliberately**
(to force new rows per re-run, since `scores.trend` needs history), while 07's design.md §5.4
requires the opposite — anchoring on `raw_signal_id` for retry-safety. Calling `f04-db-write` as a
sub-workflow would silently reintroduce the exact rev.2 duplicate-claims defect design.md's "hash
correction that matters" section documents. `f07-db-write` therefore mirrors `f04-db-write`'s
*topology* (preflight → ai_run → raw_signal → claims → evidence) but uses its own, independently
correct hash recipes from `lib/f07/hashes.js`, pasted verbatim.

## E1b QA gate findings, fixed 2026-07-19

- **D4 (Major) — `_text` was folding `what_is_built` in, violating §1.1.** Both
  `f07-thesis-gate`'s "Build attributes for evaluation" and `f07-thesis-reevaluate`'s "Build
  attributes from current claims" synthesized `_text` as `[gate_text, what_is_built].join(' ')`
  — the equivalent of calling `vocabulary.synthesize_text(gateText, whatIsBuilt)`. That is a
  real call shape the function accepts, but no correct caller passes the second argument
  (`lib/f07/run.js`'s `buildAttributesFromExtraction()` calls it with only `gateText`). `_text`
  is the gate's RAW input specifically so keyword rules catch phrasing the extractor might
  normalize away; folding an LLM paraphrase back in means a negative keyword can be introduced
  or erased by the extractor's own wording, reacting to text the founder never wrote. Fixed in
  both nodes: `_text` is now `gate_text.trim()` (or the raw_signals-resolved text for D2),
  nothing else. Verified live: re-ran the item-11 orphan test below through keyword mode and
  confirmed `fired_rules[].observed` shows the raw marker text with no paraphrase appended.
- **Item 11 (gate-blocker) — `Write scores` was the one write in the pipeline that was not
  select-first.** `scores` has no unique constraint (design.md), so the upstream "Check existing
  evaluation" (keyed on `thesis_evaluations`) cannot catch a crash that happens AFTER `Write
  scores` succeeds but BEFORE `Write thesis_evaluations` runs — on retry, `thesis_evaluations`
  still does not exist, so the same branch is taken again and mints a second, permanently
  orphaned `scores(thesis_fit)` row nothing will ever reference. Fixed by embedding the
  fingerprint inside `scores.missing_flags` (the only place this value can live without a
  schema change) and making `Write scores` select-first on
  `(application_id, thesis_id, axis, missing_flags._f07_input_fingerprint)` before inserting —
  the same "never blind-insert" principle already applied to every other write. Shared between
  both workflows (`D1_WRITE_SCORES_JS` is the one constant both `f07-thesis-gate` and
  `f07-thesis-reevaluate` use).

  **Key is `_f07_input_fingerprint`, not a bare `input_fingerprint`** (team-lead ruling,
  2026-07-19, made after the first pass shipped the bare name): `missing_flags` has a
  documented cross-feature meaning owned by feature 01 — "what was absent when this was
  computed" (REQ-003) — and 05/06/09 read it to render what the system did NOT know. A bare
  `input_fingerprint` key would eventually be rendered to an investor as a missing data point,
  or counted in a gap tally: a cross-feature hazard planted in a field this workflow does not
  own. **Convention for every consumer**: any key prefixed `_` in `missing_flags` is
  writer-internal plumbing and must never be rendered as a missing-data signal. The team lead
  is carrying this into the 05/06/09 handoff.

  **Verified by direct simulation**, twice (once for each key name), since orchestrating an
  actual mid-workflow kill via the n8n API wasn't practical in the time available: computed the
  exact keyword-mode fingerprint a specific `(gate_text, structured_hints)` pair would produce
  (replicated `lib/f07/hashes.js`'s formula in a one-off `node -e` script against the live
  default thesis config), pre-inserted a `scores` row carrying that fingerprint under the
  correct key (simulating the orphan a crash would leave), then called the real gate with the
  matching input and confirmed in the DB that the new `thesis_evaluations` row's `score_id`
  pointed at the pre-inserted (reused) row and the `scores` count for that application/thesis/
  axis did not increase.

  ⚠️ **This left three synthetic `scores` rows and their corresponding `thesis_evaluations`/
  `ai_runs` rows under Nordkit's application** (`07f00002-...-000001`) — `scores` and
  `thesis_evaluations` are both append-only (no DELETE), so this residue cannot be cleaned up.
  All three are identifiable by the literal marker text `ITEM11-ORPHAN-TEST` /
  `ITEM11-NAMESPACE-TEST` in their `fired_rules`/payload and by round test values
  (`value: 42.00` / `7.00` / `13.00`, `confidence: NULL`) — flagging plainly rather than
  leaving undisclosed contamination in shared fixture data. Recorded in the tracker so nobody
  mistakes them for live data.

## Corrections applied after cross-checking `lib/f07/run.js`

- **`_text` resolves from the MOST RECENT `raw_signals` row that carries a `text` key**,
  never just "the stored payload" (team-lead correction, 2026-07-19, found live by querying
  `raw_signals` across all four fixtures after the gap-topic fix landed): every application
  now has several `raw_signals` rows — the fixture's own (`{note, text}`), pre-fix-era rows
  written by `lib/f07/run.js` (`{mode}`, no `text` — `run.js` never persists it, since it
  never re-evaluates), and current gate calls (`{mode, text}`). §1.1's original "resolves from
  the stored payload" sentence assumed exactly one row. Rows without a `text` key are
  **skipped**, never treated as empty text: an empty `_text` makes every keyword rule
  evaluate `no_match` — a conclusion drawn from text this re-evaluation never actually saw.
  Fixed in `f07-thesis-reevaluate`'s claims fetch (added `raw_signals.created_at` to the
  embedded select) and its attributes builder (collects every distinct raw_signal referenced
  by the card's claims' evidence, filters to `payload ? 'text'`, sorts by `created_at desc`,
  takes the first; `_text` stays absent if none qualify). Re-verified live against Fogline and
  GameLoop — both named by the team lead as the cases with a text-less row sitting more
  recently than their fixture row — and both still resolve `_text` to the fixture's own text
  (`M_negkw` correctly still triggers on GameLoop's "casino"/"betting", correctly stays
  `satisfied` on Fogline).
- **`ai_runs` IS select-by-input_hash-first**, insert only if absent — this generator's first
  pass read design.md's "hash correction" section as implying `ai_runs` gets an unconditional
  fresh row every attempt (mirroring f04-db-write's own `ai_runs` write). `run.js`'s
  `writeAiRun()` does the opposite. Matched to `run.js`.
- **Gap-claim topic is the BASE `company.<field>`, never a `.gap` suffix** (team-lead
  correction, 2026-07-19 — design.md §5.4.1's "`*.gap` convention" sentence was stale;
  `db/fixtures/07-thesis-engine.sql`'s own Fogline fixture never used the suffix). Since a
  present claim and a gap claim can now share the identical topic across different runs (a
  field extracted once, missing on a later re-extraction, or vice versa — **observed live**,
  see the Fogline re-run below), gap dedup and gap-vs-present detection are keyed on
  `source_kind='derived'` / `verification_status`, never on the topic string. Fixed in
  `f07-db-write`'s claims writer, `f07-thesis-gate`'s contradicted-claims resolver (dead
  `.gap`-suffix strip removed), and `f07-thesis-reevaluate`'s current-claims reader (topic
  regex replaced with a `source_kind`/`verification_status` check).
- **`base_confidence: 0.4`** for real claims (not `0.3`) — orchestrator ruling recorded in
  `run.js`'s `DEFAULT_BASE_CONFIDENCE` comment, not specified in design.md itself. Matched.
- **`evidence.strength: 0.9`** for `tier='documented'` — was omitted (left `NULL`) in the first
  pass; schema.sql's own comment warns this degrades feature 05's rollup silently. Matched to
  `run.js`'s `EVIDENCE_STRENGTH_DOCUMENTED`.
- **`ai_runs.output_json`** now records `{input: {gate_text, structured_hints}, extraction}`
  (was just `extraction`) — matches `run.js`'s shape and makes the anti-sycophancy guarantee
  (SS8.3 test 13: no thesis field in the prompt payload) directly auditable off the row.
- **Kept deliberately different from `run.js`**: `raw_signals.payload` carries `{mode, text}`,
  not `run.js`'s `{mode}` alone. `run.js` never re-reads this row (it is full-mode, one-shot, no
  re-evaluation), but `f07-thesis-reevaluate` (D2) — which `run.js` does not implement — must
  resolve `_text` from exactly this stored payload later (design.md SS1.1). Dropping `text` here
  would silently break D2's re-evaluation path.

## Topology notes / live-discovered gotchas

- **PostgREST access is Code-node-wrapped (`this.helpers.httpRequest`), not the standalone
  `n8n-nodes-base.httpRequest` node**, for every Supabase read/write. Discovered mid-build:
  `f04-market-intel.json`'s own "Extract application" / "Resolve card" nodes (edited by a
  concurrent terminal while this was being built) carry a comment that the standalone
  httpRequest node's automatic JSON-array-to-items conversion is "inconsistent for
  empty-array responses — sometimes 0 items, sometimes 1 item with json={}". Calling
  `this.helpers.httpRequest({..., json:true})` from a Code node returns an already-parsed
  value directly with no such ambiguity. Real httpRequest nodes are kept only for the OpenAI
  extractor call (a single JSON object, unaffected) and `n8n-nodes-base.if` /
  `n8n-nodes-base.executeWorkflow` for the genuinely useful visual decision points (mode
  branch, retry branch, verdict branches, the sub-workflow call) — CLAUDE.md's "визуальными
  workflow ... не кодом" directive, balanced against not re-deriving 100+ hand-built nodes
  under a hackathon clock.
- **The extractor's OpenAI request body is built in a Code node, never inline in the
  httpRequest node's own `jsonBody` expression.** Live-verified 2026-07-19: n8n's `{{ ... }}`
  expression parser locates the closing `}}` with what behaves like a naive first-match scan,
  not a brace-depth-aware one. The extractor's JSON schema is deeply nested and contains
  literal `"}}"` sequences (adjacent closing braces) well before the expression's intended
  end; embedding the schema directly inside `{{ }}` truncated the expression there and n8n
  reported `"invalid syntax"` with the whole expression echoed back as context. Fix: a
  preceding Code node builds the full request object into `$json.__extractor_request_body`,
  and the httpRequest node's `jsonBody` is the short
  `={{ JSON.stringify($json.__extractor_request_body) }}` — the schema text is now data
  inside `$json`, never literal characters inside the expression source itself.
- **The extractor's JSON schema is sanitized before being sent** (`sanitize_schema_for_strict_mode`
  in the build script): OpenAI's structured-output validator rejected `uniqueItems` on
  `missing_fields` (`400 Invalid schema ... 'uniqueItems' is not permitted`), live-verified —
  exactly the risk model-recommendations.md's "Strict-mode schema caveat" section flagged in
  advance. `minLength`/`maxLength`/`pattern`/`maxItems` are stripped too, proactively, for the
  same documented reason. The deterministic validator Code node re-implements every one of
  these checks in JS, so nothing is lost.
- **`temperature` is omitted, not sent as `0`.** Design §4 wants `temperature=0` for
  reproducibility (input_fingerprint's retry-stability argument depends on it). `gpt-5.6-luna`
  rejects an explicit `temperature` parameter outright (400 `Unsupported parameter`) — the same
  constraint f03's and f04's own build scripts discovered live for this model family, now
  confirmed a third time over `/v1/responses`. **Honest limitation, not fixed here**: without
  `temperature=0`, extraction is not fully deterministic, and `lib/f07/hashes.js`'s
  `contentHash.claim()` does not include the extracted value in its hash (by design, anchored
  only on `card_id`/`topic`/`raw_signal_id`/`item_key` — see hashes.js's own comment on why).
  A second **genuine** re-extraction of the same input (not a workflow-level retry of the same
  attempt, but a later independent gate call) that samples a different classification will
  find the existing claim row by hash and silently keep the earlier value rather than
  updating it. This is a real tension between design.md §4's stated assumption and the model's
  actual behavior, surfaced by live testing — flagged in the handoff, not silently absorbed.

## Live-verified results (2026-07-19, against `db/fixtures/07-thesis-engine.sql`)

Run via `curl -X POST http://localhost:5678/webhook/f07-thesis-gate -d '{...}'`. Exact payloads
used: each fixture application's own `raw_signals.payload.text` (see
`db/fixtures/07-thesis-engine.sql`) as `"text"`, plus `"application_id"` and `"mode"`.

| Application | Mode | Verdict | Notes |
|---|---|---|---|
| Nordkit (`…0001`) | full | `passed` (fit 100, coverage 1.0) | all rules satisfied |
| StakeCircle (`…0003`) | full | `failed` | R1 (hard gambling rule) triggered, as designed |
| Fogline (`…0002`), 1st run | full | `insufficient_evidence` (coverage 0.38) | `thesis_gate` written as **NULL** (verified in DB, not left unset); one `thesis_gate_insufficient_evidence` events row; zero `scores` rows |
| Fogline (`…0002`), re-run after the gap-topic fix | full | `borderline` (coverage 0.62) | extractor sampled `business_model: "b2b"` this time (non-deterministic — see the temperature note below); **verified in DB**: the new real claim and the earlier gap claim now coexist under the identical base topic `company.business_model`, distinguished only by `source_kind` (`self_reported` vs `derived`) — exactly the scenario the gap-topic correction exists to handle, observed live rather than only reasoned about |
| GameLoop (`…0004`) | full | `failed` (not the fixture's intended `borderline`) | **LLM extraction defect, not a workflow-logic defect** — see below |
| GameLoop (`…0004`) | keyword, with `structured_hints.sector="consumer"` + gate text | `borderline`, coverage **NULL** | isolates and confirms §2 step 2b: a triggered *soft* deal-breaker alone, with the hard rule not firing, down-ranks rather than blocks |
| Nordkit, re-evaluated (D2) | — | `passed`, new row after a claim was test-contradicted | coverage dropped 1.00→0.76, `business_model` correctly went `unknown` (not `missed`), **new** `input_fingerprint` (no UNIQUE violation) — QA item 12's exact scenario |
| Fogline, re-evaluated (D2) after the gap-topic fix | — | `borderline`, same `evaluation_id` as the full-mode run | confirms D2 correctly resolves the CURRENT (most recent by `created_at`) claim per field when a gap and a present row share one topic — picked the real `business_model: "b2b"` claim, not the older gap |

**GameLoop's full-mode discrepancy, reported plainly rather than absorbed:** the extractor
classified `sector: "gambling"` (grounded in a real, verbatim quote — "GameLoop lets mobile game
publishers add real-money betting mini-games that their casino partners can white-label inside
existing apps" — so the deterministic validator correctly let it through), overriding the
company's own explicit self-description ("a consumer mobile gaming platform, not a gambling
operator") per Instruction 5's self-label-override rule. This is a defensible-but-wrong
application of that rule to a case the prompt's negative criteria don't sharply cover: GameLoop
*enables* gambling features for its B2B customers rather than operating gambling itself, a
distinction the prompt's worked examples don't isolate the way they isolate "self-label vs.
described product." Given `sector: "gambling"`, the evaluator is **correct** to return `failed`
(R1 fires) — the deterministic logic did exactly what design.md specifies given its input. The
keyword-mode test above (bypassing the LLM, supplying the fixture's *intended* classification via
`structured_hints`) independently confirms the evaluator's step-2b path produces `borderline` as
designed once the sector classification is correct. Whether to sharpen the prompt's negative
criteria for this "enables X vs. is X" case is a decision for whoever owns the extraction agent
next, not one made here.

**Idempotency, observed rather than merely tested:** an independent tool (`lib/f07/run.js
--recorded`, run earlier by another terminal against the same fixture) had already written a
`thesis_evaluations` row for Nordkit. This workflow's own fresh extraction converged on the exact
same `input_fingerprint` and reused that row rather than duplicating it — the two systems
computing identical hashes from `lib/f07/hashes.js` independently is stronger evidence of
correctness than either one alone.

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals in the JSON — safe
to commit to a public repo. Values live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`. Every PostgREST-calling Code node normalizes
`$env.SUPABASE_URL` defensively (strips a trailing `/rest/v1` if present, always appends it back)
— the same drift f03's build script found live applies here too.

## Re-deploying after a change

```bash
F07_DB_WRITE_ID=7pEtpy8sS3VLgVt2 python3 n8n/build-f07-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "
import json
for name, wid in [('f07-db-write','7pEtpy8sS3VLgVt2'), ('f07-thesis-gate','EQxi1lFF2bDjDByd'),
                   ('f07-thesis-reevaluate','2dqjJ7HRCudSqnWT')]:
    d = json.load(open(f'n8n/workflows/{name}.json'))
    for k in ('active','pinData','meta','id','versionId','tags'): d.pop(k, None)
    json.dump(d, open(f'/tmp/{name}_put.json','w'))
"
for pair in "f07-db-write:7pEtpy8sS3VLgVt2" "f07-thesis-gate:EQxi1lFF2bDjDByd" "f07-thesis-reevaluate:2dqjJ7HRCudSqnWT"; do
  name="${pair%%:*}"; id="${pair##*:}"
  curl -X PUT "$N8N_URL/api/v1/workflows/$id" -H "X-N8N-API-KEY: $N8N_API_KEY" \
       -H "Content-Type: application/json" -d @"/tmp/${name}_put.json"
done
```

(The n8n public API rejects `active`/`pinData`/`meta`/`id`/`versionId`/`tags` as read-only on
create/update, even though the exported file includes them for correct standalone import —
hence the strip-before-PUT step, same as f03's README documents.)
