# Feature 03 workflow — Founder Score

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-f03-workflow.py           # regenerate + syntax-check every Code node
python3 n8n/build-f03-workflow.py --check   # check only, no write
```

The deterministic core lives in `lib/f03/gate.js` and `lib/f03/scoring.js`, unit-tested (67
tests) outside n8n. n8n Code nodes cannot `require` local files, so that source is **inlined**
into the `GATE` and `AGGREGATE` nodes by the generator (only the trailing CommonJS
`module.exports` line is stripped — the sandbox has no `module` global). The 4 sub-scorer
agents' system prompts and JSON schemas are likewise pulled straight out of
`docs/backlog/03-founder-score/agents/*.md`, never retyped by hand. Editing the JSON directly
makes the tested modules / reviewed prompts and the running workflow drift apart — the exact
class of silent divergence this generator exists to prevent.

## Registered workflow

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f03-score-founder` | `AlkzJ70zET7SiHkn` | 26 | The whole pipeline (design §5, merged per plan.md into one workflow): context build → 4 parallel LLM sub-scorers → GATE → AGGREGATE → DB writes → §4.9 output contract. |

Entry points: `POST /webhook/f03-score-founder` with `{ "founder_id": "<uuid>" }`, or as an
Execute-Workflow sub-workflow call from another workflow with the same input shape (02/08 will
call it this way once they exist). `application_id` is deliberately **not** an input — 03
scores the person, not an application.

## Topology notes

- The 4 sub-scorer LLM nodes are genuinely separate n8n nodes (not one Code node looping 4
  times) so the "4 parallel agents" architecture is visible on the canvas to a judge.
- They fan back into **an actual `Merge` node** (`mode: append, numberInputs: 4`), not multiple
  wires into one Code node's input — see the tooling changelog entry in
  `docs/backlog/TRACKER.md` (~05:05) for why: a plain node with several incoming wires does
  **not** reliably wait for all of them in this n8n build, and fired after only 1-2 of the 4
  branches had completed when tested without the Merge node.
- GATE (`lib/f03/gate.js`) and AGGREGATE (`lib/f03/scoring.js`) are both zero-LLM, pure
  arithmetic/validation nodes; a sticky note on the canvas labels AGGREGATE onward as the
  deterministic core per plan.md task C1's topology (`GATE → [deterministic block] → AGGREGATE
  → writes → contract`).

## Running one founder end to end

```bash
curl -X POST http://localhost:5678/webhook/f03-score-founder \
  -H "Content-Type: application/json" \
  -d '{"founder_id":"03f00001-0000-0000-0000-000000000001"}'
```

Fixture founders (`db/fixtures/03-founder-score.sql`):

| founder_id | Name | Expected |
|---|---|---|
| `…0001` | Devon Ashworth (synthetic) | `scored`, all 3 red flags fire (R1/R2/R4), value ≈ 29 |
| `…0002` | Kwame Asante (sparse) | borderline — landed `scored` at coverage ≈ 0.251 (just above `min_coverage` 0.25) in the one live run tested; the 3-claim fixture was designed to exercise `insufficient_evidence` but the actual outcome depends on live LLM judgment calls at the margin, not a fixed threshold |
| `…0003` | Pieter Levels (real) | expected `scored`, well-evidenced — not yet exercised live by this task (budget) |

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals in the JSON — so
these files are safe to commit to a public repo. Values live in `infra/n8n/.env` (gitignored):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`.

⚠️ `$env.SUPABASE_URL` has been observed to drift between `http://host.docker.internal:8000`
and `http://host.docker.internal:8000/rest/v1` (container-baked value vs. the `.env` file on
disk falling out of sync across parallel terminals — see `docs/backlog/TRACKER.md` infra
changelog, ~05:00). Every Postgres-calling Code node in this workflow normalizes it defensively
(`SB_NORMALIZE` in `n8n/build-f03-workflow.py`), so this workflow is correct regardless of which
form the env var currently holds.

⚠️ `gpt-5.6-luna` rejects `temperature: 0` (HTTP 400, live-verified 2026-07-19) — the parameter
is omitted from every sub-scorer's request body. See `docs/backlog/TRACKER.md` tooling
changelog (~05:10).

## Re-deploying after a change

```bash
python3 n8n/build-f03-workflow.py
set -a; source infra/n8n/.env; set +a
python3 -c "import json; wf=json.load(open('n8n/workflows/f03-score-founder.json')); wf.pop('active',None); wf.pop('meta',None); json.dump(wf, open('/tmp/f03_put_body.json','w'))"
curl -X PUT "http://localhost:5678/api/v1/workflows/AlkzJ70zET7SiHkn" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @/tmp/f03_put_body.json
```

(The n8n public API rejects `active` and `meta` as read-only on create/update, even though the
exported file includes them for correct standalone import — hence the strip-before-PUT step.)
