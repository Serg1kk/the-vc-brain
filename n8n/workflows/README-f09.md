# Feature 09 workflow — `f09-suggest-followup`

**Do not hand-edit the JSON.** It is generated:

```bash
python3 n8n/build-f09-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f09-workflow.py --check   # check only, no write
```

The agent's system prompt and JSON schema live as reviewed artifacts under
`docs/backlog/09-investor-dashboard/agents/suggest-followup-questions/` and are pulled in
verbatim by the generator — never retyped by hand into the workflow JSON. Editing the JSON
directly makes the reviewed prompt and the running workflow drift apart, the same class of
defect `n8n/README-f05.md` and `n8n/README-f10.md` already document for their own workflows.

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f09-suggest-followup` | `t4OfTrYXVtHfohAY` | 22 total | Given `{ application_id }`: reads three gap sources for the application, ranks/caps each deterministically, phrases two of them into spoken investor questions via one LLM call, and returns a composed follow-up set plus a stubbed email preview. |

Entry point: `POST /webhook/f09-suggest-followup` with `{ "application_id": "<uuid>" }`.

---

## What it does

Feature 09's card (`lovable-brief.md` §9.4) has a `Suggest follow-up questions` action. Manager
notes were cut from the product (operator decision, Jul 19 — no notes table exists), so **the
card's gaps alone drive this**, per the brief: *"That is where the value is anyway."*

Three gap sources are read for the application, each capped, each ranked deterministically —
**selection is always code, never the model**:

1. **Contradictions** (`events` where `event_type='claim_contradicted'`, both the
   `entity_type='application'` and `entity_type='founder'` shapes, per `data-contracts.md` §8's
   "query both shapes" rule). These **never reach the LLM** — feature 05's own pipeline already
   wrote a fully-formed, neutrally-framed `payload.question` string at verification time, reused
   verbatim. The `why` is built in code from `payload.founder_claim` / `payload.found_reality` /
   `payload.checked_at`, following the house framing rule (`lovable-brief.md` §9.3): *"worth
   asking about," never an accusation.* Deduped to one (the most recent) event per `claim_id`,
   capped at 3.
2. **Founder-score gaps** (`api_founders.founder_score_gaps[]`, `{criterion_id,
   what_would_close_it}` — already investor-language prose per `lovable-brief.md` §4.4). Ranked by
   the live `score_formulas` criteria weight (axis `founder_score`), capped at 2. These **do** go
   to the LLM to be turned into a spoken question.
3. **Missing (not-disclosed) claims** (`claim_trust.derived_status='missing'`, scoped to the
   application via `api_claims`). Deduped against any topic already reachable through a selected
   founder-score criterion (the same `criterion_id → topic` map `lib/f08/gaps.js` uses), ordered by
   topic for run-to-run stability, capped at 2. These also go to the LLM.

The two model-bound sources are sent to the `suggest-followup-questions` agent (built via the
`ai-agent-builder` skill — artifacts at
`docs/backlog/09-investor-dashboard/agents/suggest-followup-questions/`), which converts each into
one natural spoken question a non-technical investor can ask out loud on a live call, plus a
one-line `why`. **Model:** `gpt-5.6-terra`, `reasoning.effort: "low"`, strict `json_schema`
response format, `temperature` omitted (cross-feature rule 7 — `luna` rejects `temperature: 0`
with HTTP 400; every OpenAI-calling node in this repo omits the parameter identically so it is
never copy-pasted into a `luna` node with a poisoned value).

**Never fabricates.** If all three sources come back empty, the workflow returns an empty
`questions[]` with an honest `empty_reason` string — no generic VC questions are invented to fill
the modal. Verified live (see below).

**Deliberately excluded** (documented, not silently dropped —
`suggest-followup-questions-agent-tbd-items.md` TBD-3): the short internal codes in
`score_market`/`score_idea_vs_market`'s `missing[]` arrays (`gap_growth`, `gap_size_bottom_up`, …)
and `thesis_missing_fields`. No investor-language description of these codes exists anywhere in
this codebase (checked: no lookup table in `lib/` or any design doc), and guessing their meaning
would risk exactly the fabrication this feature's hard constraint forbids.

---

## Frozen contract

### Request

```
POST /webhook/f09-suggest-followup
Content-Type: application/json

{ "application_id": "11f00002-0000-0000-0000-000000000001" }
```

`application_id` — required, must be a UUID (string match, not a DB existence check at this
stage — that follows next).

### Response — 200, questions found

```json
{
  "application_id": "11f00002-0000-0000-0000-000000000001",
  "company_name": "Voltaic Labs",
  "generated_at": "2026-07-19T09:49:03.572Z",
  "questions": [
    {
      "question": "Which of the three pilots are paying today, and can we speak to one of them?",
      "why": "The deck says \"We are live with three paying pilot customers in banking and health...\" (checked 2026-07-16); a public source says: \"Company homepage invites visitors to join the waitlist and describe...\". Worth asking about.",
      "source": "contradiction"
    },
    {
      "question": "Who owns the company today, and what percentage does each founder hold?",
      "why": "We haven't seen the current ownership split.",
      "source": "missing_claim"
    },
    {
      "question": "How much outside capital has the company raised so far?",
      "why": "We don't have the amount of prior outside funding.",
      "source": "missing_claim"
    }
  ],
  "email_preview": {
    "subject": "A few things before our call — Voltaic Labs",
    "body": "Hi Jonas,\n\nLooking forward to our call. A few things I would like to cover:\n\n- Which of the three pilots are paying today, and can we speak to one of them?\n- Who owns the company today, and what percentage does each founder hold?\n- How much outside capital has the company raised so far?\n\nSee you soon."
  },
  "empty_reason": null
}
```

This is a **real, unedited response** from the live workflow against the demo database
(`11f00002-0000-0000-0000-000000000001`, Voltaic Labs, from the feature-11 demo fixture).

Field notes:

- `questions[]` — 0 to 7 items (contradictions ≤3 + founder-score gaps ≤2 + missing claims ≤2),
  in the order: contradictions first, then founder-score gaps, then missing claims. Each item:
  - `question` — one spoken question, ≤160 characters, exactly one `?`.
  - `why` — one line stating what this question closes. For `source: "contradiction"` this can run
    longer than the LLM-phrased sources (it quotes two short excerpts) but is capped in practice by
    truncating each quoted excerpt to 70 characters.
  - `source` — `"contradiction"` | `"founder_score_gap"` | `"missing_claim"`. Exposed for UI
    transparency (this product's chip system, `lovable-brief.md` §4.1) — `contradiction` items are
    fully deterministic reuse of stored text (`▦`-equivalent), the other two are model-phrased from
    a deterministically-selected input (`▦◇`-equivalent). **Do not render this as a trust/quality
    signal** — it is provenance of the *phrasing*, not of the underlying evidence.
- `email_preview` — `{ subject, body }`, a **draft only**. There is no founder email address
  anywhere in this schema (`db/schema.sql`'s own comment: "email delivery mocked in MVP"), so there
  is no `to` field — the frontend renders this as a preview with the send button labelled `Not
  sent — email delivery is not enabled in this build.` per `lovable-brief.md` §9.4. Present only
  when `questions.length > 0`; `null` when the set is empty.
- `empty_reason` — `null` when `questions[]` is non-empty; otherwise a plain-English sentence
  naming which of the three sources came back empty and why (see the empty-response example below).
  Never a generic "no data" string — always names the actual sources checked.

### Response — 200, no gaps found (honest, not an error)

Real response, verified live against a clean application with no scored founder, no
contradictions and no not-disclosed claims:

```json
{
  "application_id": "2ae681e5-cdc9-4461-bcf7-998f2ecd836d",
  "company_name": "how we review 400k lines of go code nobody has seen",
  "generated_at": "2026-07-19T09:49:21.740Z",
  "questions": [],
  "email_preview": null,
  "empty_reason": "No follow-up questions to suggest yet: no recorded contradictions, no founder is scored on this application yet, no undisclosed topics found in the evidence base."
}
```

### Errors — feature 08's §4.5 shape, exactly

```json
{ "error": { "code": "...", "message": "Human-readable, safe to display." } }
```

| HTTP | `code` | When | Verified live |
|---|---|---|---|
| 400 | `invalid_input` | `application_id` missing or not a UUID string | `{"error":{"code":"invalid_input","message":"application_id must be a uuid."}}` |
| 404 | `not_found` | `application_id` is a well-formed UUID with no matching row in `applications` | `{"error":{"code":"not_found","message":"Application not found."}}` |
| 500 | `internal` | Any unexpected failure in the Supabase reads (e.g. Postgres unreachable) | Fixed copy: `"Something went wrong on our side. Try again."` — matches `lovable-brief.md` §12.3's fallback message exactly. Not forced live (would require breaking the DB connection mid-demo); the node wiring (`onError: continueErrorOutput` on every PostgREST-calling Code node → shared `Handle unexpected error` → `Respond: internal error (500)`) is identical to the already-verified pattern in `f08-followup-create` and `f05-verify-claims`. |

**The OpenAI call itself never surfaces as a 500.** If the model call fails or its output fails
validation, the workflow substitutes a static per-item fallback question (see below) and still
returns 200 with a full `questions[]` — the UI never sees a failed "Suggest follow-up questions"
click for that reason. (An LLM outage is a degraded question, not a broken feature.)

---

## Validation gate on the LLM output

Same "model proposes, backend decides" two-layer enforcement as feature 08's
`gap-question-phraser` (`n8n/workflows/f08-followup-create.json`'s own `Parse + validate ...`
node): every phrased item is re-checked in code before it reaches the response —

1. `ref_id` must be one of the ids actually sent, one output item per input item, same order.
2. Length caps: `question` ≤ 160 chars, `why` ≤ 140 chars.
3. Exactly one `?` in `question`.
4. Forbidden-vocabulary stem scan (case-insensitive) over both fields: `criterion`, `founder
   score`, `score`, `gap`, `axis`, `verif`, `claim`, `topic`, `evidence base`, `coverage`,
   `confidence`, `lied`, `misrepresent`, `fabricat`, `inconsistent`, `dishonest`, "you didn't tell
   us", "you failed to".

Any item that fails is **substituted with a static fallback**, never dropped — a missing question
would silently shrink the "where to dig" set the whole feature exists to produce. Fallback text is
keyed by the item's own `kind`: `founder_score_gap` → *"Can you walk me through {criterion_label},
in your own words?"*; `missing_claim` → a small topic playbook (business model, stage evidence,
what's built, geography, first customers) with a generic humanized-slug fallback for any topic not
in the playbook. Full text: `n8n/build-f09-workflow.py`'s `FALLBACK_JS` constant, mirrored from
`suggest-followup-questions-agent-tbd-items.md` D-4.

If the OpenAI HTTP call itself fails (timeout, 5xx, malformed JSON), **every** gap item for that
call gets the static fallback (`Handle LLM failure` node) rather than a partial or empty set.

---

## Running it

```bash
curl -X POST http://localhost:5678/webhook/f09-suggest-followup \
  -H "Content-Type: application/json" \
  -d '{"application_id":"11f00002-0000-0000-0000-000000000001"}'
```

Other verified live runs during this build:

- `67169f25-b2a1-4e64-821d-a4bce3e3b340` (Northwind Robotics) — founder-score-gap-only case, no
  contradictions, no missing claims: 2 questions, both `source: "founder_score_gap"`, phrased from
  criteria `E1` ("merged PR into an external repo") and `E4` ("live product URL").
- `00000000-0000-0000-0000-000000000000` — well-formed UUID, no such row → 404 `not_found`.
- `not-a-uuid` / missing `application_id` → 400 `invalid_input`.

`ai_runs` audit row confirmed written (only when the model is actually called — the empty-gaps and
no-gap-items-for-LLM paths write nothing, matching feature 08's identical convention):

```sql
select task_type, application_id, model, created_at from ai_runs
where application_id = '11f00002-0000-0000-0000-000000000001' and task_type = 'question_generation'
order by created_at desc limit 1;
-- question_generation | 11f00002-... | gpt-5.6-terra | 2026-07-19 09:49:03...
```

Idempotency: the `ai_runs` write is deduped by a content hash of
`application_id + selected ref_ids` (same `input_hash` pattern as feature 08's own write), so a
re-run against the identical gap selection does not insert a second audit row — but note the
**response itself is not cached or idempotent**: `temperature` is omitted, so the exact question
wording can vary run to run on identical input (acceptable — this is call-prep copy, not a score,
and nothing downstream keys on the exact string, same determinism note as
`suggest-followup-questions-agent-model-recommendations.md`).

---

## Relationship to feature 06's `deep-dive-questions`

Feature 06 (memo, not yet built) owns a separate `deep-dive-questions` agent for the **memo's**
"Where to dig" block, drawing from gaps + contradictions + ambiguous claims to produce 5-7
questions with a WHY (`docs/backlog/06-memo-decision/README.md` §3). This workflow owns the
**card's** interactive suggestion only — same spirit (gap → question → WHY), same rough count (this
workflow's cap is 3+2+2 = 7, matching 06's stated 5-7 target), but a different workflow, a different
agent, and a different LLM call. **Do not merge these** — the card's version is call-prep (spoken,
live, no review step), the memo's version is a written document section. If 06 is built later and
wants to reuse a gap source's selection logic (e.g. the same `CRITERION_TOPIC` map), copy it the
same way this workflow copied it from `lib/f08/gaps.js` — an independent, documented duplicate, not
a shared import (no Code node in this repo can `require()` another repo file).

---

## Credentials

Secrets are container env vars referenced as `$env.*`, never literals — safe to commit. Values
live in `infra/n8n/.env` (gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`OPENAI_API_KEY`.

`$env.SUPABASE_URL` is normalized defensively in every PostgREST-calling Code node
(`.replace(/\/rest\/v1\/?$/, '')`), same as every other workflow in this repo — it has been
observed to drift between the bare host and the `/rest/v1`-suffixed form across parallel terminals
(feature 03's own tracker changelog).

---

## Re-deploying after a change

```bash
python3 n8n/build-f09-workflow.py   # regenerates n8n/workflows/f09-suggest-followup.json
set -a; source infra/n8n/.env; set +a
python3 -c "import json; wf=json.load(open('n8n/workflows/f09-suggest-followup.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f09_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/t4OfTrYXVtHfohAY" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f09_put_body.json
```

(The n8n public API rejects `active` and `meta` as read-only on update, even though the exported
file includes them for correct standalone import — same strip-before-PUT step every other feature's
README documents.) The workflow was activated once via `POST /api/v1/workflows/{id}/activate`
after creation; a PUT update does not deactivate it.
