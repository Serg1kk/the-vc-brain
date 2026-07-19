# Feature 04 workflows — market, trend & competition intel

**Do not hand-edit the JSON in this directory.** It is generated:

```bash
python3 n8n/build-workflows.py           # regenerate + syntax-check every Code node
python3 n8n/build-workflows.py --check   # check only, no write
```

The deterministic scoring core lives in `lib/f04/*.js`, where it is unit-tested (141 tests).
n8n Code nodes cannot `require` local files, so that source is **inlined** into the nodes by the
generator. Editing the JSON directly makes the tested module and the running workflow drift
apart — the exact class of silent divergence this feature exists to prevent.

## Registered workflows

| Workflow | id | Nodes | Role |
|---|---|---|---|
| `f04-db-write` | `3tKU8GFFkmSOiJBG` | 7 | Every Supabase write (design §3.5/§3.6). Called via Execute Workflow. |
| `f04-market-intel` | `XVGJRXDHT8HMvxbv` | 8 | The market axis pipeline (design §4). |
| `f04-competition-intel` | *(pending)* | — | Competitor discovery + mismatch (design §8). |

## Running one application end to end

```bash
set -a; source infra/n8n/.env; set +a
curl -H "X-N8N-API-KEY: $N8N_API_KEY" http://localhost:5678/api/v1/workflows
```

`f04-market-intel` takes `{ application_id, end_date? }`. **`end_date` is pinned**: without it
the same scoring run returns different evidence tomorrow, so a demo recording and the repo
would disagree. It defaults to today only for convenience — pin it explicitly for anything
reproducible.

## Credentials

Secrets are container env vars referenced as `$env.*` in nodes, never literals in the JSON —
so these files are safe to commit to a public repo. Values live in `infra/n8n/.env`
(gitignored): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TAVILY_API_KEY`, `OPENAI_API_KEY`.

## Re-deploying after a change

```bash
python3 n8n/build-workflows.py
curl -X PUT  "http://localhost:5678/api/v1/workflows/3tKU8GFFkmSOiJBG" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @n8n/workflows/f04-db-write.json
curl -X PUT  "http://localhost:5678/api/v1/workflows/XVGJRXDHT8HMvxbv" \
     -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
     -d @n8n/workflows/f04-market-intel.json
```
