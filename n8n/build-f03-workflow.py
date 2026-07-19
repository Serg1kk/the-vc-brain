#!/usr/bin/env python3
"""
Build the feature-03 n8n workflow JSON (f03-score-founder) from source.

Why a generator rather than hand-maintained JSON: the deterministic core lives in
lib/f03/gate.js and lib/f03/scoring.js, unit-tested (67 tests) outside n8n. n8n's Code-node
sandbox cannot `require()` from this repo (see infra/n8n/docker-compose.yml -- no bind-mount,
NODE_FUNCTION_ALLOW_EXTERNAL unset), so that source has to be *inlined* into the two Code
nodes verbatim. Doing that inlining by hand risks the tested module and the running workflow
silently drifting apart -- the exact class of defect plan.md's guiding decision 3 exists to
prevent. Same approach feature 04 took (n8n/build-workflows.py) -- kept independent here (no
shared import) since a generator this size is itself something worth reading start to finish.

Run after any change to lib/f03/{gate,scoring}.js or to docs/backlog/03-founder-score/agents/*.md:

    python3 n8n/build-f03-workflow.py           # regenerate n8n/workflows/f03-score-founder.json
    python3 n8n/build-f03-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f03.md).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f03')
AGENTS_DIR = os.path.join(ROOT, 'docs', 'backlog', '03-founder-score', 'agents')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

AGENT_NAMES = ['execution-signals', 'expertise-signals', 'leadership-sales-proxies', 'red-flags']
PROMPT_VERSION = 'p1-2026.07'
MODEL = 'gpt-5.6-luna'


# ----------------------------------------------------------------------------
# Source extraction -- lib/f03/*.js pasted verbatim (module.exports stripped,
# it is CommonJS glue, not logic) and the 4 agent specs' system prompt / JSON
# schema pulled straight out of docs/backlog/03-founder-score/agents/*.md so
# nothing here is retyped by hand.
# ----------------------------------------------------------------------------

def inline_module(filename):
    """Read lib/f03/<filename>.js verbatim, stripping only the CommonJS
    `module.exports = {...};` tail -- n8n's Code-node sandbox does not define
    `module`, so that line would throw ReferenceError, but the functions it
    exports are already in scope once the rest of the file is pasted in."""
    src = open(os.path.join(LIBDIR, filename), encoding='utf-8').read()
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed for " + filename
    assert 'require(' not in re.sub(r"//[^\n]*", "", stripped), \
        filename + " must stay zero-import (plan.md guiding decision 3)"
    return stripped.rstrip() + "\n"


def agent_system_prompt(name):
    text = open(os.path.join(AGENTS_DIR, name + '.md'), encoding='utf-8').read()
    m = re.search(r"## System prompt\s*\n```xml\n(.*?)\n```", text, re.S)
    if not m:
        raise SystemExit("could not find '## System prompt' xml block in %s.md" % name)
    return m.group(1)


def agent_schema(name):
    text = open(os.path.join(AGENTS_DIR, name + '.md'), encoding='utf-8').read()
    m = re.search(r"## Output JSON Schema\s*\n```json\n(.*?)\n```", text, re.S)
    if not m:
        raise SystemExit("could not find '## Output JSON Schema' block in %s.md" % name)
    return json.loads(m.group(1))


GATE_JS = inline_module('gate.js')
SCORING_JS = inline_module('scoring.js')


# ----------------------------------------------------------------------------
# n8n node/connection helpers (mirrors n8n/build-workflows.py's conventions)
# ----------------------------------------------------------------------------

def nid():
    return str(uuid.uuid4())


def code_node(name, js, x, y, notes=None):
    node = {
        "parameters": {"mode": "runOnceForAllItems", "jsCode": js},
        "id": nid(), "name": name, "type": "n8n-nodes-base.code",
        "typeVersion": 2, "position": [x, y],
    }
    if notes:
        node["notes"] = notes
    return node


def sticky(name, content, x, y, w, h, color=None):
    node = {
        "parameters": {"content": content, "height": h, "width": w},
        "id": nid(), "name": name, "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1, "position": [x, y],
    }
    if color is not None:
        node["parameters"]["color"] = color
    return node


def connect(*pairs):
    """pairs: (source_name, output_index, target_name, target_index) tuples.
    Multiple pairs sharing the same (source_name, output_index) fan out to
    several targets; multiple pairs sharing the same target across different
    sources fan in (n8n concatenates the incoming items)."""
    conns = {}
    for src, out_idx, dst, dst_idx in pairs:
        entry = conns.setdefault(src, {"main": []})
        while len(entry["main"]) <= out_idx:
            entry["main"].append([])
        entry["main"][out_idx].append({"node": dst, "type": "main", "index": dst_idx})
    return conns


def merge_connections(*dicts):
    out = {}
    for d in dicts:
        for src, spec in d.items():
            if src not in out:
                out[src] = {"main": []}
            for i, targets in enumerate(spec["main"]):
                while len(out[src]["main"]) <= i:
                    out[src]["main"].append([])
                out[src]["main"][i].extend(targets)
    return out


def check_nodes(nodes):
    """node --check every Code node body, wrapped with dummy n8n globals so a
    top-level `await` and references to $json/$input/$env/$execution/this
    parse and resolve without actually running network calls."""
    bad = 0
    for n in nodes:
        js = n.get('parameters', {}).get('jsCode')
        if not js:
            continue
        wrapped = (
            "const $env = {}; const $execution = { id: 1 };\n"
            "const $input = { first: () => ({ json: {} }), all: () => [] };\n"
            "const self = { helpers: { httpRequest: async () => ({}) } };\n"
            "(async function(){\n" + js + "\n}).call(self);\n"
        )
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write(wrapped)
            path = f.name
        r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
        ok = r.returncode == 0
        print("  %-45s %s (%d bytes)" % (n['name'], 'OK' if ok else 'SYNTAX ERROR', len(js)))
        if not ok:
            bad += 1
            print(r.stderr[:600])
        os.unlink(path)
    return bad


# ----------------------------------------------------------------------------
# Shared JS snippets
# ----------------------------------------------------------------------------

# $env.SUPABASE_URL has been observed live to drift between "http://host.docker.internal:8000"
# and "http://host.docker.internal:8000/rest/v1" -- the container-baked value and the
# infra/n8n/.env file on disk fell out of sync mid-build (another terminal's edits raced this
# one on the same shared file; see docs/backlog/TRACKER.md's infra changelog). Rather than
# depend on winning that race, strip a trailing /rest/v1 here and always append it back --
# correct regardless of which convention $env.SUPABASE_URL currently holds.
SB_NORMALIZE = "String($env.SUPABASE_URL || '').replace(/\\/rest\\/v1\\/?$/, '')"

PG_HELPER = (
    "const SB = " + SB_NORMALIZE + ", KEY = $env.SUPABASE_SERVICE_ROLE_KEY;\n"
    "async function pg(method, path, body, prefer) {\n"
    "  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };\n"
    "  if (prefer) headers.Prefer = prefer;\n"
    "  return await this.helpers.httpRequest({ method, url: SB + '/rest/v1/' + path, headers, body, json: true });\n"
    "}\n"
)

PG_GET_HELPER = (
    "const SB = " + SB_NORMALIZE + ", KEY = $env.SUPABASE_SERVICE_ROLE_KEY;\n"
    "async function pgGet(path) {\n"
    "  return await this.helpers.httpRequest({\n"
    "    method: 'GET', url: SB + '/rest/v1/' + path,\n"
    "    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, json: true,\n"
    "  });\n"
    "}\n"
)


def build():
    nodes = []
    conns = {}

    # ---- Entry points ----------------------------------------------------
    webhook = {
        "parameters": {
            "httpMethod": "POST", "path": "f03-score-founder",
            "responseMode": "lastNode",
            "options": {},
        },
        "id": nid(), "name": "Webhook Trigger", "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [-460, -140],
        "webhookId": nid(),
    }
    exec_trigger = {
        "parameters": {},
        "id": nid(), "name": "Execute Workflow Trigger",
        "type": "n8n-nodes-base.executeWorkflowTrigger",
        "typeVersion": 1, "position": [-460, 140],
    }
    nodes += [webhook, exec_trigger]

    norm_webhook = code_node(
        "Normalize Webhook Input",
        "// Webhook body carries { founder_id }. application_id is deliberately NOT an input --\n"
        "// design.md SS4/SS9: 03 scores the PERSON, not an application.\n"
        "const item = $input.first().json;\n"
        "const body = item.body || {};\n"
        "const founder_id = body.founder_id || item.founder_id;\n"
        "if (!founder_id) throw new Error('f03-score-founder: founder_id is required');\n"
        "return [{ json: { founder_id } }];\n",
        -180, -140,
    )
    norm_sub = code_node(
        "Normalize Sub-workflow Input",
        "// Called by 02 (radar) / 08 (intake) as a sub-workflow with { founder_id }.\n"
        "const item = $input.first().json || {};\n"
        "const founder_id = item.founder_id;\n"
        "if (!founder_id) throw new Error('f03-score-founder: founder_id is required');\n"
        "return [{ json: { founder_id } }];\n",
        -180, 140,
    )
    nodes += [norm_webhook, norm_sub]

    gen_run_id = code_node(
        "Generate run_id",
        "// One UUID per run of f03-score-founder (design.md SS4.9) -- echoed into every\n"
        "// ai_runs.output_json below so the four ledger rows join to the components.\n"
        "// require('crypto') is allow-listed in infra/n8n/docker-compose.yml\n"
        "// (NODE_FUNCTION_ALLOW_BUILTIN=crypto,url), shared with feature 04.\n"
        "const { randomUUID } = require('crypto');\n"
        "const inp = $input.first().json;\n"
        "return [{ json: { founder_id: inp.founder_id, run_id: randomUUID() } }];\n",
        60, 0,
    )
    nodes.append(gen_run_id)

    # ---- Read side: founder+company, claims join, active formula ---------
    fetch_founder = code_node(
        "Fetch founder + company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const founders = await pgGet.call(this,\n"
        "  'founders?id=eq.' + inp.founder_id + '&select=id,full_name,headline,location_country');\n"
        "const founder = founders[0] || { id: inp.founder_id, full_name: null, headline: null, location_country: null };\n"
        "\n"
        "// founder_company.is_current is the mechanism (design.md 01 SS5.3) by which the score\n"
        "// follows a person across companies -- 'current company' means is_current=true.\n"
        "const fc = await pgGet.call(this,\n"
        "  'founder_company?founder_id=eq.' + inp.founder_id +\n"
        "  '&is_current=eq.true&select=companies(name,one_liner,category,stage)&limit=1');\n"
        "const company = (fc[0] && fc[0].companies) ||\n"
        "  { name: null, one_liner: null, category: null, stage: null };\n"
        "\n"
        "return [{ json: { ...inp, founder, company } }];\n",
        340, 0,
    )

    fetch_claims = code_node(
        "Fetch claims + cards + evidence + raw_signals",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS4.1: claims JOIN cards (WHERE cards.founder_id = $1) LEFT JOIN evidence\n"
        "// LEFT JOIN raw_signals. PostgREST resource embedding does this in one request:\n"
        "//  - cards!inner(founder_id) + cards.founder_id=eq.<id> filters through the join\n"
        "//    (the '!inner' hint is required for PostgREST to let a top-level filter reference\n"
        "//    an embedded resource).\n"
        "//  - evidence(...) embeds the one-to-many child rows as an array per claim -- \"a claim\n"
        "//    may have MULTIPLE evidence rows\" (task brief) falls out of this for free.\n"
        "//  - raw_signals(source) is nested INSIDE each evidence row via evidence.raw_signal_id;\n"
        "//    PostgREST returns `raw_signals: null` when that FK is null (verified live against\n"
        "//    the fixture DB before wiring this in), giving the required\n"
        "//    \"evidence.source must be the JOINED raw_signals.source, null when raw_signal_id is\n"
        "//    null\" without a second round trip.\n"
        "const select = 'id,topic,text_verbatim,source_kind,created_at,cards!inner(founder_id),' +\n"
        "  'evidence(id,tier,quote_verbatim,source_url,raw_signal_id,raw_signals(source))';\n"
        "const claims = await pgGet.call(this,\n"
        "  'claims?select=' + select + '&cards.founder_id=eq.' + inp.founder_id);\n"
        "return [{ json: { ...inp, claims } }];\n",
        620, 0,
    )

    load_formula = code_node(
        "Load active score_formulas",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'score_formulas?axis=eq.founder_score&active=eq.true&select=version,config&limit=1');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error('f03-score-founder: no active score_formulas row for axis=founder_score');\n"
        "}\n"
        "// scoring.js's trend guard (SS4.5) compares config.version against the previous scores\n"
        "// row's formula_version -- but `version` lives OUTSIDE `config` in score_formulas\n"
        "// (schema.sql). Fold it into the config object here, once, for every downstream reader\n"
        "// (GATE, AGGREGATE, the scores-row write, the output contract) to share.\n"
        "const formula_config = { ...rows[0].config, version: rows[0].version };\n"
        "return [{ json: { ...inp, formula_config } }];\n",
        900, 0,
    )
    nodes += [fetch_founder, fetch_claims, load_formula]

    # ---- Context packs -----------------------------------------------------
    build_packs = code_node(
        "Build 4 routed context packs",
        "// design.md SS4.7: route each claim by claims.topic PREFIX into its sub-scorer's pack;\n"
        "// red-flags always gets the union of every claim (cross-cutting visibility to spot\n"
        "// contradictions). A claim matching no prefix is never dropped -- plan.md task C1:\n"
        "// \"unmatched topic -> union pack (never dropped)\" -- broadcast into EVERY positive\n"
        "// sub-scorer's pack (not just red-flags), because a claim silently invisible to every\n"
        "// scored criterion is exactly the starvation SS4.7 warns against; red-flags already sees\n"
        "// it unconditionally either way.\n"
        "const TIER_RANK = { documented: 3, discovered: 2, inferred: 1, missing: 0 };\n"
        "function bestTierRank(claim) {\n"
        "  var best = -1;\n"
        "  (claim.evidence || []).forEach(function (e) {\n"
        "    var r = TIER_RANK.hasOwnProperty(e.tier) ? TIER_RANK[e.tier] : -1;\n"
        "    if (r > best) best = r;\n"
        "  });\n"
        "  return best;\n"
        "}\n"
        "\n"
        "const inp = $input.first().json;\n"
        "const cfg = inp.formula_config || {};\n"
        "const routing = cfg.topic_routing || {};\n"
        "const prefixMap = routing.prefix_map || {};\n"
        "const cap = cfg.max_claims_per_agent || 40;\n"
        "\n"
        "// Normalize into gate.js's contextPacks claim shape, pre-joining raw_signals.source onto\n"
        "// each evidence entry (design SS4.1 -- \"PRE-JOINED by the caller -- gate.js does no DB\n"
        "// access\", per lib/f03/gate.js's own header contract).\n"
        "const normClaims = (inp.claims || []).map(function (c) {\n"
        "  return {\n"
        "    claim_id: c.id,\n"
        "    text_verbatim: c.text_verbatim,\n"
        "    topic: c.topic,\n"
        "    source_kind: c.source_kind,\n"
        "    created_at: c.created_at,\n"
        "    evidence: (c.evidence || []).map(function (e) {\n"
        "      return {\n"
        "        tier: e.tier,\n"
        "        quote_verbatim: e.quote_verbatim,\n"
        "        source_url: e.source_url,\n"
        "        raw_signal_id: e.raw_signal_id || null,\n"
        "        source: (e.raw_signals && e.raw_signals.source) || null,\n"
        "      };\n"
        "    }),\n"
        "  };\n"
        "});\n"
        "\n"
        "const positiveNames = ['execution-signals', 'expertise-signals', 'leadership-sales-proxies'];\n"
        "const buckets = { 'execution-signals': [], 'expertise-signals': [], 'leadership-sales-proxies': [] };\n"
        "const unmatched = [];\n"
        "normClaims.forEach(function (c) {\n"
        "  var routed = null;\n"
        "  Object.keys(prefixMap).some(function (prefix) {\n"
        "    if (c.topic && c.topic.indexOf(prefix) === 0) { routed = prefixMap[prefix]; return true; }\n"
        "    return false;\n"
        "  });\n"
        "  if (routed && buckets[routed]) buckets[routed].push(c);\n"
        "  else unmatched.push(c);\n"
        "});\n"
        "\n"
        "// Cap: max_claims_per_agent, ordered by evidence.tier (documented -> discovered ->\n"
        "// inferred) then claims.created_at desc (design SS4.7).\n"
        "function sortAndCap(list) {\n"
        "  var sorted = list.slice().sort(function (a, b) {\n"
        "    var rb = bestTierRank(b) - bestTierRank(a);\n"
        "    if (rb !== 0) return rb;\n"
        "    return new Date(b.created_at) - new Date(a.created_at);\n"
        "  });\n"
        "  return sorted.slice(0, cap);\n"
        "}\n"
        "\n"
        "const packs = {};\n"
        "positiveNames.forEach(function (name) {\n"
        "  var combined = sortAndCap(buckets[name].concat(unmatched));\n"
        "  packs[name] = { claim_ids: combined.map(function (c) { return c.claim_id; }), claims: combined };\n"
        "});\n"
        "var redFlagCombined = sortAndCap(normClaims); // union of ALL claims, uncapped concern removed by cap\n"
        "packs['red-flags'] = {\n"
        "  claim_ids: redFlagCombined.map(function (c) { return c.claim_id; }),\n"
        "  claims: redFlagCombined,\n"
        "};\n"
        "\n"
        "return [{ json: { ...inp, packs } }];\n",
        1180, 0,
    )
    nodes.append(build_packs)

    # ---- 4 parallel LLM sub-scorer nodes -----------------------------------
    llm_y = {'execution-signals': -480, 'expertise-signals': -160,
             'leadership-sales-proxies': 160, 'red-flags': 480}
    llm_nodes = {}
    for agent in AGENT_NAMES:
        sys_prompt = agent_system_prompt(agent)
        schema = agent_schema(agent)
        schema_name = agent.replace('-', '_')
        js = (
            "// SOURCE OF TRUTH: docs/backlog/03-founder-score/agents/%s.md -- system prompt and\n"
            "// JSON schema pasted verbatim. Edit there and re-run n8n/build-f03-workflow.py, not here.\n"
            "const SYS = %s;\n"
            "const SCHEMA = %s;\n"
            "\n"
            "const inp = $input.first().json;\n"
            "const pack = (inp.packs && inp.packs[%s]) || { claim_ids: [], claims: [] };\n"
            "\n"
            "// Shared input contract (agents/README.md): the LEAN view the model sees -- topic,\n"
            "// text_verbatim, source_kind, raw_signal_source, evidence w/o raw_signal_id (that\n"
            "// field is backend-only, for gate.js's neg_src check, never shown to the model).\n"
            "const claimsView = pack.claims.map(function (c) {\n"
            "  var firstSourced = (c.evidence || []).find(function (e) { return e.source; });\n"
            "  return {\n"
            "    claim_id: c.claim_id,\n"
            "    topic: c.topic,\n"
            "    text_verbatim: c.text_verbatim,\n"
            "    source_kind: c.source_kind,\n"
            "    raw_signal_source: firstSourced ? firstSourced.source : null,\n"
            "    evidence: (c.evidence || []).map(function (e) {\n"
            "      return { tier: e.tier, quote_verbatim: e.quote_verbatim, source_url: e.source_url };\n"
            "    }),\n"
            "  };\n"
            "});\n"
            "\n"
            "const userPayload = { founder: inp.founder || {}, company: inp.company || {}, claims: claimsView };\n"
            "\n"
            "let raw;\n"
            "try {\n"
            "  const r = await this.helpers.httpRequest({\n"
            "    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',\n"
            "    headers: { Authorization: 'Bearer ' + $env.OPENAI_API_KEY, 'Content-Type': 'application/json' },\n"
            "    body: {\n"
            "      // NOTE: design.md SS4.8 specifies temperature 0, but gpt-5.6-luna rejects it live --\n"
            "      // \"Unsupported value: 'temperature' does not support 0 with this model. Only the\n"
            "      // default (1) value is supported\" (verified 2026-07-19 against the real API). Omitted\n"
            "      // rather than sent as 1, since the design's intent (deterministic, low-variance\n"
            "      // output) is better served by NOT overriding a value the model does not accept than by\n"
            "      // silently sending a different number than what was specified.\n"
            "      model: %s,\n"
            "      messages: [ { role: 'system', content: SYS }, { role: 'user', content: JSON.stringify(userPayload) } ],\n"
            "      response_format: { type: 'json_schema', json_schema: { name: %s, strict: false, schema: SCHEMA } },\n"
            "    },\n"
            "    json: true,\n"
            "  });\n"
            "  raw = JSON.parse(r.choices[0].message.content);\n"
            "} catch (e) {\n"
            "  // design.md SS4.4 step 8: a sub-scorer that errors/times out -> GATE records every\n"
            "  // one of its criteria as cannot_assess; the other three still aggregate normally.\n"
            "  raw = { error: (e && e.message) ? e.message : String(e) };\n"
            "}\n"
            "\n"
            "const agent_output = {};\n"
            "agent_output[%s] = raw;\n"
            "return [{ json: { ...inp, agent_output } }];\n"
        ) % (
            agent, json.dumps(sys_prompt), json.dumps(schema), json.dumps(agent),
            json.dumps(MODEL), json.dumps(schema_name), json.dumps(agent),
        )
        node = code_node("LLM: " + agent, js, 1520, llm_y[agent])
        nodes.append(node)
        llm_nodes[agent] = node["name"]

    # A plain Code/regular node with 4 wires into its single input does NOT reliably wait for
    # all 4 upstream branches in this n8n version (2.30.7) -- verified live: the downstream
    # node fired after only 1-2 of the 4 parallel LLM branches had completed, so 2 of the 4
    # sub-scorer calls never ran at all. n8n's Merge node is the one node type with genuinely
    # separate, numbered inputs that the scheduler waits on before executing -- confirmed by
    # reading n8n-nodes-base's own Merge/v3/actions/mode/append.js source inside the running
    # container: `for (let i = 0; i < inputsData.length; i++) returnData.push(...inputsData[i])`
    # only runs once data for every configured input index has arrived.
    merge_node = {
        "parameters": {"mode": "append", "numberInputs": len(AGENT_NAMES)},
        "id": nid(), "name": "Merge sub-scorer outputs", "type": "n8n-nodes-base.merge",
        "typeVersion": 3.2, "position": [1820, 0],
    }
    nodes.append(merge_node)

    combine = code_node(
        "Combine agent outputs",
        "// Fed by the Merge node above (mode: append, numberInputs: 4), which concatenates the\n"
        "// 4 sub-scorer items into one list ONLY once all 4 parallel LLM branches have completed\n"
        "// -- $input.all() here returns exactly 4 items, one per sub-scorer, all sharing the same\n"
        "// upstream context (packs, founder_id, run_id, formula_config, ...) since they all\n"
        "// descend from \"Build 4 routed context packs\". Merge each item's one-key agent_output\n"
        "// into one map.\n"
        "const items = $input.all();\n"
        "const base = { ...items[0].json };\n"
        "delete base.agent_output;\n"
        "const rawAgentOutputs = {};\n"
        "items.forEach(function (it) { Object.assign(rawAgentOutputs, it.json.agent_output || {}); });\n"
        "return [{ json: { ...base, rawAgentOutputs } }];\n",
        2100, 0,
    )
    nodes.append(combine)

    write_ai_runs = code_node(
        "Write ai_runs x4",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md I8 / SS4.3: every AI call is ledgered ALWAYS, BEFORE validation -- write all\n"
        "// 4 rows unconditionally, whatever GATE later does with the content. run_id is echoed\n"
        "// into each output_json so the 4 ledger rows join to the score_components they produced\n"
        "// (design SS4.9: deliberately not ai_runs.n8n_execution_id, which is text and scoped to\n"
        "// a single node).\n"
        "const subscorers = ['execution-signals', 'expertise-signals', 'leadership-sales-proxies', 'red-flags'];\n"
        "const ai_run_ids = {};\n"
        "for (const name of subscorers) {\n"
        "  const out = (inp.rawAgentOutputs && inp.rawAgentOutputs[name]) || { error: 'no output received' };\n"
        "  const output_json = { ...out, run_id: inp.run_id };\n"
        "  const rows = await pg.call(this, 'POST', 'ai_runs', {\n"
        "    task_type: 'scoring',\n"
        "    founder_id: inp.founder_id,\n"
        "    model: %s,\n"
        "    prompt_version: %s,\n"
        "    output_json,\n"
        "    n8n_execution_id: String($execution.id),\n"
        "  }, 'return=representation');\n"
        "  ai_run_ids[name] = rows[0].id;\n"
        "}\n"
        "return [{ json: { ...inp, ai_run_ids } }];\n" % (json.dumps(MODEL), json.dumps(PROMPT_VERSION)),
        2380, 0,
    )
    nodes.append(write_ai_runs)

    # ---- GATE (validation -- model proposes, backend decides) -------------
    gate_node = code_node(
        "GATE - validation (gate.js)",
        "// SOURCE OF TRUTH: lib/f03/gate.js -- do not edit here, edit there and re-run\n"
        "// n8n/build-f03-workflow.py. Body below is pasted VERBATIM (only the trailing\n"
        "// `module.exports` line is stripped -- n8n's sandbox does not define `module`).\n"
        "\n" + GATE_JS + "\n"
        "// ---- invocation ----\n"
        "const inp = $input.first().json;\n"
        "const components = applyGate(inp.rawAgentOutputs, inp.packs, inp.formula_config);\n"
        "return [{ json: { ...inp, components } }];\n",
        2660, 0,
        notes="SOURCE OF TRUTH: lib/f03/gate.js -- do not edit here, edit there and re-paste "
              "(via n8n/build-f03-workflow.py).",
    )
    nodes.append(gate_node)

    # ---- Deterministic block (no LLM below this line) ---------------------
    load_prev = code_node(
        "Load previous founder_score",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS4.5 trend guard needs the prior founder_score row for THIS founder (or\n"
        "// null if none exists yet -- a first score's trend is NULL, not 'stable').\n"
        "const rows = await pgGet.call(this,\n"
        "  'scores?founder_id=eq.' + inp.founder_id +\n"
        "  '&axis=eq.founder_score&order=computed_at.desc&limit=1' +\n"
        "  '&select=id,value,formula_version,input_claim_ids,confidence');\n"
        "const previous_score = (rows && rows.length) ? {\n"
        "  value: Number(rows[0].value),\n"
        "  formula_version: rows[0].formula_version,\n"
        "  input_claim_ids: rows[0].input_claim_ids || [],\n"
        "} : null;\n"
        "return [{ json: { ...inp, previous_score } }];\n",
        2940, 0,
    )
    nodes.append(load_prev)

    aggregate_node = code_node(
        "AGGREGATE - formula (scoring.js)",
        "// SOURCE OF TRUTH: lib/f03/scoring.js -- do not edit here, edit there and re-run\n"
        "// n8n/build-f03-workflow.py. Body below is pasted VERBATIM (only the trailing\n"
        "// `module.exports` block is stripped -- n8n's sandbox does not define `module`).\n"
        "// THIS IS THE PLACE WITH NO LLM IN IT (design.md SS0 / SS5): \"the model proposes\n"
        "// booleans, the backend decides the number.\" Every constant (weights, credits, tier\n"
        "// factors, min_coverage, trend_epsilon) comes from formula_config -- score_formulas --\n"
        "// nothing is hardcoded here.\n"
        "\n" + SCORING_JS + "\n"
        "// ---- invocation ----\n"
        "const inp = $input.first().json;\n"
        "const result = aggregate(inp.components, inp.formula_config, inp.previous_score || null);\n"
        "return [{ json: { ...inp, ...result } }];\n",
        3220, 0,
        notes="SOURCE OF TRUTH: lib/f03/scoring.js -- do not edit here, edit there and re-paste "
              "(via n8n/build-f03-workflow.py). This is the deterministic core -- no LLM call "
              "anywhere in this node.",
    )
    nodes.append(aggregate_node)

    if_node = {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [{
                    "id": nid(),
                    "leftValue": "={{ $json.status }}",
                    "rightValue": "insufficient_evidence",
                    "operator": {"type": "string", "operation": "equals"},
                }],
                "combinator": "and",
            },
            "options": {},
        },
        "id": nid(), "name": "IF: insufficient_evidence?", "type": "n8n-nodes-base.if",
        "typeVersion": 2, "position": [3500, 0],
    }
    nodes.append(if_node)

    write_events = code_node(
        "Write events (insufficient_evidence)",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS2.4: the insufficient_evidence branch writes NO scores row (there is no\n"
        "// way to write \"unknown\" into a NOT NULL numeric(5,2) column without fabricating), but\n"
        "// it must not be indistinguishable from \"never scored\" -- one events row is the\n"
        "// timestamped, queryable marker for 06/09/10.\n"
        "await pg.call(this, 'POST', 'events', {\n"
        "  event_type: 'founder_score_insufficient_evidence',\n"
        "  entity_type: 'founder',\n"
        "  entity_id: inp.founder_id,\n"
        "  payload: { run_id: inp.run_id, coverage: inp.coverage, missing: inp.missing || [] },\n"
        "  actor: 'f03-score-founder',\n"
        "}, 'return=minimal');\n"
        "return [{ json: { ...inp, score_id: null } }];\n",
        3780, -150,
    )
    write_scores = code_node(
        "Write scores row",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// scores.input_claim_ids = union of every component's claim_ids -- same union scoring.js\n"
        "// computes internally for the trend comparison (unionClaimIds), recomputed here because\n"
        "// aggregate() does not return it on its result object.\n"
        "const input_claim_ids = Array.from(new Set(\n"
        "  (inp.components || []).flatMap(function (c) { return c.claim_ids || []; })\n"
        "));\n"
        "const rows = await pg.call(this, 'POST', 'scores', {\n"
        "  founder_id: inp.founder_id,\n"
        "  application_id: null,\n"
        "  axis: 'founder_score',\n"
        "  value: inp.value,\n"
        "  trend: inp.trend,\n"
        "  confidence: inp.confidence,\n"
        "  missing_flags: inp.missing || [],\n"
        "  input_claim_ids,\n"
        "  formula_version: inp.formula_config.version,\n"
        "  prompt_version: %s,\n"
        "  model: %s,\n"
        "}, 'return=representation');\n"
        "return [{ json: { ...inp, score_id: rows[0].id } }];\n" % (json.dumps(PROMPT_VERSION), json.dumps(MODEL)),
        3780, 150,
    )
    nodes += [write_events, write_scores]

    write_components = code_node(
        "Write score_components x12",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// Written either way (design SS4.3): score_id is NULL on the insufficient_evidence\n"
        "// branch (schema.sql: score_components.score_id is nullable for exactly that case),\n"
        "// founder_id + run_id carry the identity instead.\n"
        "const rows = (inp.components || []).map(function (c) {\n"
        "  return {\n"
        "    score_id: inp.score_id, founder_id: inp.founder_id, run_id: inp.run_id,\n"
        "    subscorer: c.subscorer, criterion_id: c.criterion_id, verdict: c.verdict,\n"
        "    weight: c.weight, credit: c.credit, contribution: c.contribution,\n"
        "    evidence_tier: c.evidence_tier, claim_ids: c.claim_ids || [],\n"
        "    quote_verbatim: c.quote_verbatim, rationale: c.rationale,\n"
        "    what_would_close_it: c.what_would_close_it, demoted_by: c.demoted_by,\n"
        "  };\n"
        "});\n"
        "await pg.call(this, 'POST', 'score_components', rows, 'return=minimal');\n"
        "return [{ json: inp }];\n",
        4060, 0,
    )
    nodes.append(write_components)

    build_contract = code_node(
        "Build output contract",
        "// design.md SS4.9 -- the normative shape consumed by 05, 06, 09, 10. Terminal node:\n"
        "// its return value is both the webhook HTTP response (responseMode: lastNode) and the\n"
        "// value returned to a caller that invoked this as a sub-workflow.\n"
        "const inp = $input.first().json;\n"
        "\n"
        "const bySubscorer = {};\n"
        "(inp.components || []).forEach(function (c) {\n"
        "  if (!bySubscorer[c.subscorer]) bySubscorer[c.subscorer] = [];\n"
        "  bySubscorer[c.subscorer].push({\n"
        "    id: c.criterion_id, verdict: c.verdict, credit: c.credit, weight: c.weight,\n"
        "    contribution: c.contribution, evidence_tier: c.evidence_tier,\n"
        "    claim_ids: c.claim_ids || [], quote_verbatim: c.quote_verbatim,\n"
        "    rationale: c.rationale, demoted_by: c.demoted_by,\n"
        "  });\n"
        "});\n"
        "const subscorerWeights = (inp.formula_config && inp.formula_config.subscorer_weights) || {};\n"
        "const subscorers = Object.keys(bySubscorer).map(function (name) {\n"
        "  return { name, weight: subscorerWeights[name] != null ? subscorerWeights[name] : null,\n"
        "           criteria: bySubscorer[name] };\n"
        "});\n"
        "\n"
        "const redFlagsOut = (inp.rawAgentOutputs && inp.rawAgentOutputs['red-flags']) || {};\n"
        "const redFlagRules = (inp.formula_config && inp.formula_config.red_flags) || [];\n"
        "const red_flags = (redFlagsOut.flags || []).map(function (f) {\n"
        "  var fid = f.flag_id || f.id;\n"
        "  var rule = redFlagRules.find(function (r) { return r.id === fid; });\n"
        "  return { id: fid, severity: f.severity, contradicts: (rule && rule.contradicts) || [],\n"
        "           evidence: f.claim_ids || [] };\n"
        "});\n"
        "\n"
        "const expertiseOut = (inp.rawAgentOutputs && inp.rawAgentOutputs['expertise-signals']) || {};\n"
        "const pedigreeSrc = expertiseOut.pedigree || {};\n"
        "const pedigree = {\n"
        "  prior_companies: pedigreeSrc.prior_companies || [],\n"
        "  notable_employers: pedigreeSrc.notable_employers || [],\n"
        "  scored: false,\n"
        "  note: 'Displayed for context. Not scored -- see design SS3.2.',\n"
        "};\n"
        "\n"
        "return [{ json: {\n"
        "  status: inp.status, founder_id: inp.founder_id, run_id: inp.run_id,\n"
        "  score_id: inp.score_id || null, axis: 'founder_score',\n"
        "  value: inp.value, confidence: inp.confidence, coverage: inp.coverage, trend: inp.trend,\n"
        "  formula_version: inp.formula_config.version, prompt_version: %s, model: %s,\n"
        "  subscorers, missing: inp.missing || [], red_flags, pedigree,\n"
        "} }];\n" % (json.dumps(PROMPT_VERSION), json.dumps(MODEL)),
        4340, 0,
    )
    nodes.append(build_contract)

    # ---- Sticky notes -------------------------------------------------------
    nodes.append(sticky(
        "Note: parallel sub-scorers",
        "### 4 PARALLEL LLM SUB-SCORER AGENTS\n"
        "`gpt-5.6-luna`, temperature 0, JSON schema output.\n"
        "System prompts + schemas pasted verbatim from\n"
        "`docs/backlog/03-founder-score/agents/*.md`.\n\n"
        "Each agent proposes verdicts only (`met` / `self_asserted` /\n"
        "`not_met` / `cannot_assess`) -- it never emits evidence_tier,\n"
        "credit, weight or a number. The backend (GATE + AGGREGATE,\n"
        "right of here) decides all of that.",
        1440, -760, 460, 260,
    ))
    nodes.append(sticky(
        "Note: deterministic core",
        "### DETERMINISTIC CORE -- NO LLM CALL BEYOND THIS POINT\n"
        "\"The model proposes booleans, the backend decides the number.\"\n"
        "(design.md SS0)\n\n"
        "GATE (`lib/f03/gate.js`, pasted verbatim) enforces the negative-\n"
        "capability check, red-flag demotion, evidence-tier assignment\n"
        "and verbatim-quote verification -- REQ-003 / I2 / I6 are code\n"
        "here, not prompt instructions.\n\n"
        "AGGREGATE (`lib/f03/scoring.js`, pasted verbatim) is pure\n"
        "arithmetic over `score_formulas.config` -- every weight, credit\n"
        "and tier factor is data, nothing is hardcoded. This is literally\n"
        "the part a judge can be shown with zero LLM involvement.",
        2640, -760, 1900, 320,
    ))

    # ---- Connections ---------------------------------------------------------
    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Execute Workflow Trigger", 0, "Normalize Sub-workflow Input", 0),
            ("Normalize Webhook Input", 0, "Generate run_id", 0),
            ("Normalize Sub-workflow Input", 0, "Generate run_id", 0),
            ("Generate run_id", 0, "Fetch founder + company", 0),
            ("Fetch founder + company", 0, "Fetch claims + cards + evidence + raw_signals", 0),
            ("Fetch claims + cards + evidence + raw_signals", 0, "Load active score_formulas", 0),
            ("Load active score_formulas", 0, "Build 4 routed context packs", 0),
            ("Build 4 routed context packs", 0, llm_nodes['execution-signals'], 0),
            ("Build 4 routed context packs", 0, llm_nodes['expertise-signals'], 0),
            ("Build 4 routed context packs", 0, llm_nodes['leadership-sales-proxies'], 0),
            ("Build 4 routed context packs", 0, llm_nodes['red-flags'], 0),
            # Merge node inputs are genuinely separate, numbered slots (unlike 4 wires into a
            # plain node's single input) -- n8n waits for data on all 4 before executing it.
            (llm_nodes['execution-signals'], 0, "Merge sub-scorer outputs", 0),
            (llm_nodes['expertise-signals'], 0, "Merge sub-scorer outputs", 1),
            (llm_nodes['leadership-sales-proxies'], 0, "Merge sub-scorer outputs", 2),
            (llm_nodes['red-flags'], 0, "Merge sub-scorer outputs", 3),
            ("Merge sub-scorer outputs", 0, "Combine agent outputs", 0),
            ("Combine agent outputs", 0, "Write ai_runs x4", 0),
            ("Write ai_runs x4", 0, "GATE - validation (gate.js)", 0),
            ("GATE - validation (gate.js)", 0, "Load previous founder_score", 0),
            ("Load previous founder_score", 0, "AGGREGATE - formula (scoring.js)", 0),
            ("AGGREGATE - formula (scoring.js)", 0, "IF: insufficient_evidence?", 0),
        ),
        # IF v2: output 0 = true, output 1 = false
        connect(
            ("IF: insufficient_evidence?", 0, "Write events (insufficient_evidence)", 0),
        ),
        {"IF: insufficient_evidence?": {"main": [[], [
            {"node": "Write scores row", "type": "main", "index": 0}
        ]]}},
        connect(
            ("Write events (insufficient_evidence)", 0, "Write score_components x12", 0),
            ("Write scores row", 0, "Write score_components x12", 0),
            ("Write score_components x12", 0, "Build output contract", 0),
        ),
    )

    workflow = {
        "name": "f03-score-founder",
        "nodes": nodes,
        "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": True},
    }
    return workflow


def main():
    check_only = '--check' in sys.argv
    wf = build()
    print("%s (%d nodes)" % (wf['name'], len(wf['nodes'])))
    failures = check_nodes(wf['nodes'])
    if not check_only:
        path = os.path.join(OUT, wf['name'] + '.json')
        json.dump(wf, open(path, 'w', encoding='utf-8'), indent=1)
        print("  -> %s" % os.path.relpath(path, ROOT))
    print("\nCode nodes failing syntax check: %d" % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
