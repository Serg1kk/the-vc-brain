#!/usr/bin/env python3
"""
Build the feature-06 n8n workflow JSON (f06-generate-memo) from source.

Why a generator rather than hand-maintained JSON: the deterministic context-pack assembly
(lib/f06/context.js), decision cascade (lib/f06/decision.js) and memo-assemble/validate logic
(lib/f06/assemble.js) all live in unit-tested (`node --test`), zero-import CommonJS modules. n8n's
Code-node sandbox cannot `require()` a repo file (infra/n8n/docker-compose.yml has no bind-mount of
this repo, NODE_FUNCTION_ALLOW_EXTERNAL unset -- same constraint every prior n8n/build-f0*-workflow.py
documents), so each module's body has to be pasted VERBATIM into the Code node that needs it. Doing
that by hand risks the tested module and the running workflow silently drifting apart -- exactly the
defect class this generator (same pattern as build-f03/f05/f07/f08-workflow.py, independently
maintained per this repo's own no-shared-import-between-generators convention) exists to prevent.

Builds ONE workflow, `f06-generate-memo`, design.md SS5's node graph:

    Webhook POST /webhook/f06-generate-memo { application_id, thesis_id? }
      -> [A] Context pack        (Code, deterministic -- lib/f06/context.js, SS3)
      -> IF: pack error? --true--> Respond: pack error (404)
                         --false-> fan out to the four LLM section-writer nodes (SS6/SS7):
                                     [B1] memo-descriptive  (SS6, agents/memo-descriptive)
                                     [B2] memo-analytical   (SS6, agents/memo-analytical)
                                     [B3] memo-optional     (SS6, agents/memo-optional)
                                     [B4] deep-dive-questions (SS7, agents/deep-dive-questions)
                                   -> [M] Merge (real n8n-nodes-base.merge, numberInputs:4, mode:append)
                                   -> [C] Decision   (Code, deterministic -- lib/f06/decision.js, SS8)
                                   -> [D] Assemble + validate + version + write (Code -- lib/f06/
                                      assemble.js, SS9)
                                   -> IF: assemble error? --true--> Respond: assemble error (422)
                                                          --false-> Respond: success (200)

Run after any change to lib/f06/{context,decision,assemble}.js or to the docs/backlog/
06-memo-decision/agents/* prompt/schema files:

    python3 n8n/build-f06-workflow.py           # regenerate n8n/workflows/f06-generate-memo.json
    python3 n8n/build-f06-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f06.md). This script does not deploy or run
git -- that is @devops's job (plan.md task T6), not this generator's.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f06')
AGENTS_DIR = os.path.join(ROOT, 'docs', 'backlog', '06-memo-decision', 'agents')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

# gpt-5.6-luna, temperature OMITTED (rejects 0 -- verified live building 03/04/05/08, restated in
# this feature's own agents/README.md "Model recommendation": "luna returns HTTP 400 on
# temperature:0 and we do not want the variance of 1"). Same model 03/04/05 use for their own
# structured-extraction LLM nodes -- project stack rule (CLAUDE.md) for scoring/extraction/batch.
MODEL = 'gpt-5.6-luna'


# ----------------------------------------------------------------------------
# Source extraction -- lib/f06/*.js pasted verbatim (module.exports stripped; 'use strict'
# stripped -- see _strip_use_strict below for why). Identical technique to every prior
# n8n/build-f0*-workflow.py's own inline_module()/lib_bundle(), independently re-implemented
# here per this repo's no-shared-import-between-generators convention (see e.g.
# build-f05-workflow.py's own header note restating the same rule for its own copy).
# ----------------------------------------------------------------------------

def _read(name):
    return open(os.path.join(LIBDIR, name), encoding='utf-8').read()


def _strip_exports(src):
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed: " + src[:80]
    return stripped.rstrip() + "\n"


def _strip_use_strict(src):
    """build-f08-workflow.py found this live (README-f08.md 'One n8n sandbox bug found live'):
    a leading `'use strict';` directive, if it lands as the concatenated Code node's OWN first
    statement, silently strict-modes the whole node -- top-level `this` (which every pg() helper
    in this file's Code nodes depends on for `this.helpers.httpRequest`) becomes `undefined`
    instead of sloppy-mode-binding to the execution context, throwing "Cannot read properties of
    undefined (reading 'helpers')" purely from paste order. Every lib/f06/*.js file opens with its
    own `'use strict';` (correct for the file in isolation) -- stripped here unconditionally
    rather than relying on "always put the pg()-helper snippet first," the exact convention that
    broke silently for f08 the first time an edit reordered it. Belt-and-suspenders: this
    generator ALSO always places its own PG_HELPER_JS (which captures `self = this` at the Code
    node's genuine top level) before any pasted module body, so even an unstripped 'use strict'
    landing mid-script would be inert (a directive prologue only applies among a script's leading
    statements; once real statements precede it, it is just a no-op string-literal expression)."""
    return re.sub(r"^\s*['\"]use strict['\"];\s*$", "", src, flags=re.M)


def inline_module(filename):
    return _strip_use_strict(_strip_exports(_read(filename))).rstrip() + "\n"


CONTEXT_JS = inline_module('context.js')
DECISION_JS = inline_module('decision.js')
ASSEMBLE_JS = inline_module('assemble.js')

for _name, _src in (('context.js', CONTEXT_JS), ('decision.js', DECISION_JS), ('assemble.js', ASSEMBLE_JS)):
    assert 'require(' not in re.sub(r"//[^\n]*", "", _src), \
        _name + " must stay zero-import (design.md SS5: pasted verbatim into a Code node)"


# ----------------------------------------------------------------------------
# Agent prompt/schema loaders -- pulled straight out of docs/backlog/06-memo-decision/agents/*,
# never retyped by hand (same discipline as every prior generator's own agent_system_prompt()/
# agent_schema()). This feature's agent artifacts are a DIFFERENT file format from 03/05's
# ##-heading .md files or 08's XML-fenced .md files: a single `*-prompts.txt` per agent with a
# fixed `'='*80`-delimited USER MESSAGE / SYSTEM MESSAGE layout (agents/README.md's own
# "consolidated 5-artifact-per-agent set" note) plus a sibling `*-json-schema.json`.
# ----------------------------------------------------------------------------

def agent_system_prompt(agent_dir, filename):
    """Everything after the 'SYSTEM MESSAGE' heading's own '='*80 divider line, to EOF --
    verified against all four *-prompts.txt files (each divider is exactly 80 '=' characters)
    before relying on this split. Same technique build-f08-workflow.py's own agent_system_prompt()
    uses for its differently-shaped .txt files, independently re-pointed at this feature's own
    agents/ dir."""
    text = open(os.path.join(agent_dir, filename), encoding='utf-8').read()
    idx = text.find('SYSTEM MESSAGE')
    if idx == -1:
        raise SystemExit("could not find a 'SYSTEM MESSAGE' marker in " + filename)
    parts = text[idx:].split('=' * 80, 1)
    if len(parts) < 2:
        raise SystemExit("could not find the '='*80 divider after SYSTEM MESSAGE in " + filename)
    return parts[1].strip()


def agent_schema_file(agent_dir, filename):
    """Loads a *-json-schema.json file WHOLE -- {name, strict, schema}, already the exact shape
    an OpenAI json_schema response_format wants (see build_json_schema below)."""
    return json.load(open(os.path.join(agent_dir, filename), encoding='utf-8'))


# OpenAI's structured-output strict mode rejects several JSON-Schema keywords the source docs
# were written without knowledge of (docs/backlog/TRACKER.md 2026-07-19 ~11:20, discovered
# building feature 08; agents/README.md's own "Model recommendation" section restates the same
# rule for THIS feature: "Every schema in this folder MUST pass through the recursive strictify()
# ... at embed time"). Independent copy of build-f08-workflow.py's own
# sanitize_schema_for_strict_mode(), widened to the TRACKER entry's full four-violation list
# (minItems/minimum/maximum/format/default/examples -- f08's own copy only needed the subset ITS
# schemas actually used) since agents/README.md explicitly calls out "min/max/pattern/format" as a
# class, not just the two f08 happened to hit.
_STRIP_KEYWORDS = (
    'minLength', 'maxLength', 'pattern', 'format',
    'minItems', 'maxItems', 'minimum', 'maximum', 'uniqueItems',
    'default', 'examples',
)


def strictify(node):
    if isinstance(node, dict):
        out = {k: strictify(v) for k, v in node.items() if k not in _STRIP_KEYWORDS}
        # Strict mode allows only `anyOf`, never `oneOf`/`allOf` (TRACKER: "'oneOf' is not
        # permitted"; conditional-schema (`allOf`) support is "unreliable" per the same entry).
        # None of this feature's four schemas use either (verified below, at embed time) -- both
        # branches are defensive-only, matching f08's own "verified live... renamed" precedent
        # rather than a guess.
        if 'oneOf' in out:
            out['anyOf'] = out.pop('oneOf')
        if 'allOf' in out:
            del out['allOf']
        # Strict mode requires every key in "properties" to also appear in "required"
        # (nullability is expressed via a `type` union, e.g. memo-optional's
        # `"type": ["object", "null"]`, never by omitting the key from required) -- fixed up
        # defensively here rather than trusting every schema file to already satisfy an API
        # constraint its own author had no live feedback loop against.
        if 'properties' in out and isinstance(out['properties'], dict):
            out['required'] = list(out['properties'].keys())
        return out
    if isinstance(node, list):
        return [strictify(v) for v in node]
    return node


def build_json_schema(raw):
    """raw is a whole *-json-schema.json file ({name, strict, schema}) -- returns the exact
    object an OpenAI `response_format.json_schema` field wants. `strict` is forced `true`
    regardless of what the file says (agents/README.md's own explicit requirement; all four files
    already say `true` themselves, so this is a belt-and-suspenders assertion, not an override)."""
    assert raw.get('strict') is True, "agent schema file did not declare strict:true: " + raw.get('name', '?')
    return {'name': raw['name'], 'strict': True, 'schema': strictify(raw['schema'])}


DESCRIPTIVE_DIR = os.path.join(AGENTS_DIR, 'memo-descriptive')
ANALYTICAL_DIR = os.path.join(AGENTS_DIR, 'memo-analytical')
OPTIONAL_DIR = os.path.join(AGENTS_DIR, 'memo-optional')
QUESTIONS_DIR = os.path.join(AGENTS_DIR, 'deep-dive-questions')

DESCRIPTIVE_SYS = agent_system_prompt(DESCRIPTIVE_DIR, 'memo-descriptive-prompts.txt')
DESCRIPTIVE_SCHEMA = build_json_schema(agent_schema_file(DESCRIPTIVE_DIR, 'memo-descriptive-json-schema.json'))

ANALYTICAL_SYS = agent_system_prompt(ANALYTICAL_DIR, 'memo-analytical-prompts.txt')
ANALYTICAL_SCHEMA = build_json_schema(agent_schema_file(ANALYTICAL_DIR, 'memo-analytical-json-schema.json'))

OPTIONAL_SYS = agent_system_prompt(OPTIONAL_DIR, 'memo-optional-prompts.txt')
OPTIONAL_SCHEMA = build_json_schema(agent_schema_file(OPTIONAL_DIR, 'memo-optional-json-schema.json'))

QUESTIONS_SYS = agent_system_prompt(QUESTIONS_DIR, 'deep-dive-questions-prompts.txt')

# DESIGN AMBIGUITY, resolved here (flagged in this task's own report, not silently assumed):
# docs/backlog/06-memo-decision/agents/deep-dive-questions/ ships ONLY a *-prompts.txt -- unlike
# the other three agents, no sibling *-json-schema.json file exists in this repo (confirmed by
# directory listing before writing this). Reconstructed from two sources that agree byte-for-byte
# on the shape: (a) the prompt's own "## OUTPUT FORMAT" block (deep-dive-questions-prompts.txt --
# `{ "deep_dive_questions": [ {question, closes_gap, gap_kind, claim_ids} ] }`) and (b) design.md
# SS4.3's frozen `deep_dive_questions` column shape. `gap_kind`'s enum is the prompt's own
# instruction #3 ("gap_kind ∈ contradiction|missing|ambiguous"). Deliberately NO minItems/maxItems
# (SS4.3 says "5-7 items", but strict mode rejects array-length keywords -- TRACKER 11:20; the
# prompt's own instruction #2/#5 ("PRODUCE 5 TO 7 QUESTIONS... Cap at 7") is the sole enforcement,
# matching every other agent here: none of the four schemas encode a length constraint in-schema,
# all rely on the prompt). Wrapped in a top-level object (not a bare array) for the same reason
# build-f08-workflow.py's GAP_PHRASER_SCHEMA is wrapped: a bare `type:"array"` response_format
# schema is rejected outright by OpenAI structured output regardless of endpoint.
QUESTIONS_SCHEMA_RAW = {
    'name': 'deep_dive_questions',
    'strict': True,
    'schema': {
        'type': 'object',
        'additionalProperties': False,
        'required': ['deep_dive_questions'],
        'properties': {
            'deep_dive_questions': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'additionalProperties': False,
                    'required': ['question', 'closes_gap', 'gap_kind', 'claim_ids'],
                    'properties': {
                        'question': {'type': 'string'},
                        'closes_gap': {'type': 'string'},
                        'gap_kind': {'type': 'string', 'enum': ['contradiction', 'missing', 'ambiguous']},
                        'claim_ids': {'type': 'array', 'items': {'type': 'string'}},
                    },
                },
            },
        },
    },
}
QUESTIONS_SCHEMA = build_json_schema(QUESTIONS_SCHEMA_RAW)


# ----------------------------------------------------------------------------
# n8n node/connection helpers -- same shapes as every prior n8n/build-f0*-workflow.py
# (independent copies, no shared import between generators, this repo's own stated convention).
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


def if_node(name, left_expr, right, x, y):
    """String-equals IF (typeVersion 2) -- same convention build-f05-workflow.py's own
    `IF: insufficient_evidence?` node uses (leftValue an expression, rightValue a literal string,
    operator string/equals) in preference to a boolean-typed condition, sidestepping any
    boolean-coercion ambiguity. Output 0 = condition true, output 1 = false (n8n IF v2)."""
    return {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [{
                    "id": nid(), "leftValue": left_expr, "rightValue": right,
                    "operator": {"type": "string", "operation": "equals"},
                }],
                "combinator": "and",
            },
            "options": {},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.if",
        "typeVersion": 2, "position": [x, y],
    }


def webhook_node(name, path, x, y):
    """responseMode:'responseNode', NOT 'lastNode' -- deliberate deviation from build-f02/03/04/05-
    workflow.py's own convention, matching build-f08-workflow.py's (README-f08.md "Deviation from
    02/03/04/07's own convention"): `web/src/lib/api.ts`'s `request()` throws on `!res.ok`, reading
    `error.code`/`error.message` only off a non-2xx status -- `lastNode` mode can only ever emit
    HTTP 200, which would make this workflow's own 404/422 error paths unreachable by any future
    frontend caller. f06 has two genuinely different terminal branches (pack-not-found vs.
    assemble-gate-rejected vs. success), so explicit `respondToWebhook` nodes are used at every
    terminal rather than relying on n8n's own last-executed-node inference across a branch."""
    return {
        "parameters": {"httpMethod": "POST", "path": path, "responseMode": "responseNode", "options": {}},
        "id": nid(), "name": name, "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [x, y], "webhookId": nid(),
    }


def respond_node(name, status_code, x, y):
    return {
        "parameters": {"respondWith": "firstIncomingItem", "options": {"responseCode": status_code}},
        "id": nid(), "name": name, "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.1, "position": [x, y],
    }


def merge_node_def(name, number_inputs, x, y):
    """Real n8n-nodes-base.merge, typeVersion 3.2, mode:'append' -- NOT a plain multi-wire fan-in.
    A plain node with N wires into its single input does not reliably wait for all N upstream
    branches in this n8n build (docs/backlog/TRACKER.md -- the f03 bug: a downstream node fired
    after only 1-2 of 4 parallel branches had completed). Merge's numbered inputs ARE waited on;
    branch i must be wired to input i (design.md SS5.2)."""
    return {
        "parameters": {"mode": "append", "numberInputs": number_inputs},
        "id": nid(), "name": name, "type": "n8n-nodes-base.merge",
        "typeVersion": 3.2, "position": [x, y],
    }


def sticky(name, content, x, y, w, h):
    # n8n's public API rejects a create/update whose `nodes[]` contains two entries with the
    # same `name` (`duplicate_node_name`) -- verified live 2026-07-19 deploying THIS workflow,
    # where every sticky note previously shared the literal name "Note". Every call site below
    # now passes its own distinct, descriptive name.
    return {
        "parameters": {"content": content, "height": h, "width": w},
        "id": nid(), "name": name, "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1, "position": [x, y],
    }


def connect(*pairs):
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
    """node --check every Code node body, wrapped with dummy n8n globals so a top-level `await`
    and references to $json/$input/$env/$execution/$()/this parse without actually running network
    calls. Note: `node --check` is a SYNTAX check only -- it does not execute the wrapped IIFE, so
    these mock globals exist for readability/documentation of this file's own runtime assumptions,
    not because an undefined identifier would fail the check (same caveat applies to every prior
    generator's identical check_nodes())."""
    bad = 0
    for n in nodes:
        js = n.get('parameters', {}).get('jsCode')
        if not js:
            continue
        wrapped = (
            "const $env = {}; const $execution = { id: 1 };\n"
            "const $input = { first: () => ({ json: {} }), all: () => [] };\n"
            "const $ = (name) => ({ first: () => ({ json: {} }), all: () => [] });\n"
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
            print(r.stderr[:800])
        os.unlink(path)
    return bad


# ----------------------------------------------------------------------------
# Shared JS snippets
# ----------------------------------------------------------------------------

# $env.SUPABASE_URL has been observed live to drift between "http://host.docker.internal:8000" and
# ".../rest/v1" (build-f03-workflow.py's own SB_NORMALIZE finding, restated by every generator
# since) -- stripping a trailing /rest/v1 and always re-appending it is correct regardless of
# which convention is currently set. `self = this` is captured BEFORE any pasted lib/f06/*.js body
# so pg()'s `this.helpers.httpRequest` never depends on sloppy-mode `this`-binding surviving
# whatever gets pasted after it (see _strip_use_strict's docstring above).
PG_HELPER_JS = (
    "const SB = String($env.SUPABASE_URL || '').replace(/\\/rest\\/v1\\/?$/, '');\n"
    "const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;\n"
    "const self = this;\n"
    "async function pg(method, path, body, prefer) {\n"
    "  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };\n"
    "  if (prefer) headers.Prefer = prefer;\n"
    "  return await self.helpers.httpRequest({ method, url: SB + '/rest/v1/' + path, headers, body, json: true });\n"
    "}\n"
)


def llm_agent_js(sys_prompt, schema_obj, slice_key, fallback_js):
    """Body for one [B] section-writer Code node: build the chat/completions request, call it,
    parse `choices[0].message.content` -- ONE Code node does build+call+parse together (team-lead
    brief's own instruction, matching build-f03/f05-workflow.py's LLM Code-node shape; NOT
    build-f08-workflow.py's separate build/httpRequest/parse three-node split, which that feature
    needed only for its own binary/vision branching). `strict:true` (agents/README.md's own
    "Model recommendation" -- a deliberate deviation from 03/05's `strict:false`, made safe here by
    strictify() at embed time, per that same section)."""
    return (
        "const SYS = " + json.dumps(sys_prompt) + ";\n"
        "const SCHEMA_NAME = " + json.dumps(schema_obj['name']) + ";\n"
        "const SCHEMA = " + json.dumps(schema_obj['schema']) + ";\n"
        "const MODEL_NAME = " + json.dumps(MODEL) + ";\n"
        "\n"
        "const inp = $input.first().json;\n"
        "const userPayload = inp." + slice_key + ";\n"
        "\n"
        "let parsed;\n"
        "try {\n"
        "  const r = await this.helpers.httpRequest({\n"
        "    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',\n"
        "    headers: { Authorization: 'Bearer ' + $env.OPENAI_API_KEY, 'Content-Type': 'application/json' },\n"
        "    body: {\n"
        "      // gpt-5.6-luna rejects an explicit temperature (HTTP 400, verified live building\n"
        "      // 03/04/05/08) -- omitted entirely, same convention every f0*-workflow LLM node in\n"
        "      // this repo already follows.\n"
        "      model: MODEL_NAME,\n"
        "      messages: [ { role: 'system', content: SYS }, { role: 'user', content: JSON.stringify(userPayload) } ],\n"
        "      response_format: { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema: SCHEMA } },\n"
        "    },\n"
        "    json: true,\n"
        "  });\n"
        "  parsed = JSON.parse(r.choices[0].message.content);\n"
        "} catch (e) {\n"
        "  // Graceful degradation -- an LLM-node failure (network/schema/parse) must never\n"
        "  // hard-fail the whole memo. This mirrors exactly the posture spec-review should-fix #1\n"
        "  // put into lib/f06/assemble.js: this agent's keys are simply ABSENT from this item, and\n"
        "  // [D]'s mergeSectionsParts()/backfillRequiredSections() supply the honest structural\n"
        "  // fallback for any required section this agent would have written.\n"
        "  parsed = " + fallback_js + ";\n"
        "}\n"
        "return [{ json: parsed }];\n"
    )


# ----------------------------------------------------------------------------
# [A] Context pack -- design.md SS3. Reads via lib/f06/context.js's buildPack(pg, application_id);
# ALSO builds the four per-agent pack_slice payloads here (agents/README.md's "Shared input
# contract" -- so each [B] node just reads its own slice, never re-derives it).
# ----------------------------------------------------------------------------

CONTEXT_PACK_JS = (
    PG_HELPER_JS +
    "\n"
    "// SOURCE OF TRUTH: lib/f06/context.js -- pasted verbatim below (module.exports stripped).\n"
    "// Edit there and re-run n8n/build-f06-workflow.py, not here.\n"
    "\n" + CONTEXT_JS + "\n"
    "// ---- invocation ----\n"
    "const inp = $input.first().json;\n"
    "const application_id = inp.application_id;\n"
    "if (!application_id) {\n"
    "  return [{ json: { error: { code: 'bad_request', message: 'f06-generate-memo: application_id is required' } } }];\n"
    "}\n"
    "\n"
    "let pack;\n"
    "try {\n"
    "  // buildPack() already computes and attaches pack.gaps internally (context.js's own final\n"
    "  // step, \"gaps is a pure function of the pack -- computed last, attached here\") -- no\n"
    "  // separate buildGaps() call needed on top of it.\n"
    "  pack = await buildPack(pg, application_id);\n"
    "} catch (e) {\n"
    "  // design.md SS10 -- \"Application not found | Error envelope {error:{code,message}},\n"
    "  // 404-shaped. No row.\" buildPack()'s only own thrown error is the not-found case\n"
    "  // (context.js: \"the ONLY hard error in this file\"); anything else surfacing here would be\n"
    "  // an unexpected upstream failure, still reported honestly via the same envelope rather than\n"
    "  // crashing the whole n8n execution with no HTTP response at all.\n"
    "  const message = String((e && e.message) || e);\n"
    "  const notFound = message.indexOf('application not found') !== -1;\n"
    "  return [{ json: { error: { code: notFound ? 'not_found' : 'internal', message } } }];\n"
    "}\n"
    "\n"
    "// agents/README.md \"Shared input contract\" -- the common envelope every [B1]/[B2]/[B3] agent\n"
    "// gets. `claims` is pack.claims_for_writers -- context.js already trims it to exactly the\n"
    "// seven fields design SS6/agents/README.md's own envelope lists (claim_id, topic,\n"
    "// text_verbatim, value, source_kind, derived_status, router_class), never founder_id/\n"
    "// company_id/evidence.\n"
    "const baseSlice = {\n"
    "  application_id: pack.application_id,\n"
    "  company: { name: pack.company_name, stage: pack.stage, category: pack.category, kind: pack.kind },\n"
    "  allowed_claim_ids: pack.allowed_claim_ids,\n"
    "  claims: pack.claims_for_writers,\n"
    "  gaps: pack.gaps,\n"
    "  axes: {\n"
    "    founder: { value: pack.axes.founder.value, assessed: pack.axes.founder.assessed },\n"
    "    market: { value: pack.axes.market.value, assessed: pack.axes.market.assessed },\n"
    "    idea_vs_market: { value: pack.axes.idea_vs_market.value, assessed: pack.axes.idea_vs_market.assessed },\n"
    "  },\n"
    "  founder_score: pack.decision_inputs.founder_score,\n"
    "  trust: { value: pack.trust.value, assessed: pack.trust.assessed, coverage: pack.trust.coverage },\n"
    "};\n"
    "\n"
    "// agents/README.md: \"B3 additionally gets competitors[] (topic competition.* claims) and the\n"
    "// contradiction list.\" competitors[] is context.js's own already-structured\n"
    "// {name, named_by_founder, claim_ids} rows (design SS3.10) -- handed over pre-built rather\n"
    "// than making the model re-derive `value.company_mentioned` itself. \"the contradiction\n"
    "// list\" is gaps.contradictions, already inside baseSlice.gaps -- not duplicated as a second\n"
    "// top-level key (the memo-optional prompt itself reads risk_matrix eligibility off\n"
    "// gaps.contradictions, never off a separate field).\n"
    "const pack_slice_descriptive = baseSlice;\n"
    "const pack_slice_analytical = baseSlice;\n"
    "const pack_slice_optional = Object.assign({}, baseSlice, { competitors: pack.competitors });\n"
    "\n"
    "// agents/README.md: \"B4 gets gaps + contradictions + the ambiguous-claim subset + the\n"
    "// weakest assessed axis label.\" Same trimmed claim shape as claims_for_writers -- never\n"
    "// leaks founder_id/company_id/evidence to the model.\n"
    "const pack_slice_questions = {\n"
    "  application_id: pack.application_id,\n"
    "  allowed_claim_ids: pack.allowed_claim_ids,\n"
    "  gaps: pack.gaps,\n"
    "  ambiguous_claims: pack.ambiguous_claims.map(function (c) {\n"
    "    return {\n"
    "      claim_id: c.claim_id, topic: c.topic, text_verbatim: c.text_verbatim,\n"
    "      value: c.value, source_kind: c.source_kind, derived_status: c.derived_status, router_class: c.router_class,\n"
    "    };\n"
    "  }),\n"
    "  weakest_axis: pack.weakest_assessed_axis,\n"
    "};\n"
    "\n"
    "// The full pack (application_id/allowed_claim_ids/gaps/decision_inputs/... -- design SS5.1)\n"
    "// PLUS the four pack_slice_* payloads, flattened onto ONE item: [C]/[D] read this node back\n"
    "// via $('Context pack').first().json for the pack fields; each [B] node's main input IS this\n"
    "// item directly (design SS5: \"each Bi main-input = [A]'s pack\"), so it reads\n"
    "// $input.first().json.pack_slice_<name> for its own slice.\n"
    "return [{ json: Object.assign({}, pack, {\n"
    "  run_id: inp.run_id, thesis_id: inp.thesis_id,\n"
    "  pack_slice_descriptive, pack_slice_analytical, pack_slice_optional, pack_slice_questions,\n"
    "} ) }];\n"
)


def build():
    nodes = []

    webhook = webhook_node("Webhook Trigger", "f06-generate-memo", -700, 0)
    nodes.append(webhook)

    normalize = code_node(
        "Normalize Webhook Input",
        "// Webhook body carries { application_id, thesis_id? } (design.md SS5's own trigger\n"
        "// shape). thesis_id is accepted but NOT currently consumed anywhere downstream --\n"
        "// design SS3.5: api_applications already resolves the live thesis evaluation (the\n"
        "// stale-thesis trap), \"use it -- do not re-derive from scores\"; no override mechanism\n"
        "// is specified anywhere in SS3-SS9. Accepted here only so a future caller-supplied\n"
        "// override has somewhere to land without a webhook-contract change.\n"
        "const { randomUUID } = require('crypto');\n"
        "const item = $input.first().json;\n"
        "const body = item.body || {};\n"
        "const application_id = body.application_id || item.application_id || null;\n"
        "const thesis_id = body.thesis_id || item.thesis_id || null;\n"
        "return [{ json: { application_id, thesis_id, run_id: randomUUID() } }];\n",
        -420, 0,
    )
    nodes.append(normalize)

    context_pack = code_node("Context pack", CONTEXT_PACK_JS, -140, 0,
                              notes="SOURCE OF TRUTH: lib/f06/context.js -- do not edit here, edit there and re-paste "
                                    "(via n8n/build-f06-workflow.py).")
    nodes.append(context_pack)

    if_pack_error = if_node("IF: pack error?", "={{ $json.error ? 'error' : 'ok' }}", 'error', 180, 0)
    nodes.append(if_pack_error)

    respond_pack_error = respond_node("Respond: pack error", 404, 460, -260)
    nodes.append(respond_pack_error)

    # ---- [B1]-[B4] -- four LLM section-writer nodes, all four ALWAYS execute (design SS5.3). ----
    b1 = code_node(
        "LLM: memo-descriptive (B1)",
        llm_agent_js(DESCRIPTIVE_SYS, DESCRIPTIVE_SCHEMA, 'pack_slice_descriptive', '{}'),
        460, -520,
    )
    b2 = code_node(
        "LLM: memo-analytical (B2)",
        llm_agent_js(ANALYTICAL_SYS, ANALYTICAL_SCHEMA, 'pack_slice_analytical', '{}'),
        460, -140,
    )
    b3 = code_node(
        "LLM: memo-optional (B3)",
        llm_agent_js(
            OPTIONAL_SYS, OPTIONAL_SCHEMA, 'pack_slice_optional',
            "{ _sentinel: true, risk_matrix: null, competition: null, financials_lite: null }",
        ),
        460, 220,
    )
    b4 = code_node(
        "LLM: deep-dive-questions (B4)",
        llm_agent_js(QUESTIONS_SYS, QUESTIONS_SCHEMA, 'pack_slice_questions', "{ deep_dive_questions: [] }"),
        460, 580,
    )
    nodes += [b1, b2, b3, b4]

    merge = merge_node_def("Merge", 4, 780, 0)
    nodes.append(merge)

    decision_js = (
        "// SOURCE OF TRUTH: lib/f06/decision.js -- pasted verbatim below (module.exports\n"
        "// stripped). Edit there and re-run n8n/build-f06-workflow.py, not here. Pure function,\n"
        "// zero I/O -- design.md SS8: \"No LLM. Pure total function of the pack's numbers.\"\n"
        "\n" + DECISION_JS + "\n"
        "// ---- invocation ----\n"
        "// design.md SS5.1's own pack-propagation rule: [C]'s main input is the Merge node\n"
        "// (prose only), so the NUMBERS come back via the $('Context pack') node reference\n"
        "// instead (valid -- [A] is an ancestor of [C] via [A]->...->Merge->[C]).\n"
        "const pack = $('Context pack').first().json;\n"
        "const decisionResult = decide(pack.decision_inputs);\n"
        "return [{ json: { decision: decisionResult } }];\n"
    )
    decision = code_node("Decision", decision_js, 1060, 0,
                          notes="SOURCE OF TRUTH: lib/f06/decision.js -- do not edit here, edit there and re-paste "
                                "(via n8n/build-f06-workflow.py). No LLM call in this node.")
    nodes.append(decision)

    assemble_js = (
        PG_HELPER_JS +
        "\n"
        "// SOURCE OF TRUTH: lib/f06/assemble.js -- pasted verbatim below (module.exports\n"
        "// stripped). Edit there and re-run n8n/build-f06-workflow.py, not here.\n"
        "\n" + ASSEMBLE_JS + "\n"
        "// ---- invocation ----\n"
        "// design.md SS5.1 -- pack via $('Context pack') node reference; sections via\n"
        "// $('Merge').all() (Merge carries only prose, MERGED BY KEY/CONTENT inside\n"
        "// mergeSectionsParts(), never by input index -- the [B3] sentinel contributes no keys\n"
        "// regardless of which Merge slot it landed in).\n"
        "const pack = $('Context pack').first().json;\n"
        "const decisionOut = $input.first().json.decision;\n"
        "const sections_parts = $('Merge').all().map(function (item) { return item.json; });\n"
        "\n"
        "const assembled = assembleMemo({ pack, sections_parts, decision: decisionOut });\n"
        "if (assembled.error) {\n"
        "  return [{ json: { error: assembled.error } }];\n"
        "}\n"
        "const row = assembled.row;\n"
        "// task T6b (design SS9's DROP + LOG revision) -- a content slip (bad citation /\n"
        "// numeric-in-typed-exception) no longer reaches `assembled.error` at all; it is\n"
        "// dropped from `row` above and logged here instead, via the memo_generated event\n"
        "// payload below (never silent -- design SS9.1's own \"the drop is logged, not silent\").\n"
        "const dropped_statements = assembled.dropped_statements || [];\n"
        "\n"
        "// design.md SS9.4 -- next = COALESCE(MAX(version),0)+1. This read happens inside a Code\n"
        "// node (this.helpers.httpRequest via pg()), never a dedicated PostgREST-typed n8n node,\n"
        "// so there is no separate alwaysOutputData toggle to set -- an empty `[]` result (v1, the\n"
        "// normal case) is just an empty JS array here, handled by computeVersion() below exactly\n"
        "// like every other empty-select branch in this workflow's own [A] node.\n"
        "async function readNextVersion() {\n"
        "  const existing = await pg('GET', 'memos?application_id=eq.' + row.application_id + '&select=version&order=version.desc&limit=1');\n"
        "  return computeVersion((existing || []).map(function (r) { return r.version; }));\n"
        "}\n"
        "\n"
        "async function insertMemo() {\n"
        "  return await pg('POST', 'memos', {\n"
        "    application_id: row.application_id, version: row.version, sections: row.sections,\n"
        "    gaps: row.gaps, cited_claim_ids: row.cited_claim_ids, recommendation: row.recommendation,\n"
        "    conditions: row.conditions, deep_dive_questions: row.deep_dive_questions,\n"
        "  }, 'return=representation');\n"
        "}\n"
        "\n"
        "// UNVERIFIED LIVE (flagged to @devops/@qa-engineer -- no deployed instance to trigger a\n"
        "// real (application_id, version) race against for this task): n8n's\n"
        "// this.helpers.httpRequest throws on PostgREST's non-2xx response; the exact shape of\n"
        "// the thrown error for a 23505 unique-violation (409) was not confirmed live. Best-effort\n"
        "// match against every shape PostgREST's own {code:'23505', ...} body has been seen to\n"
        "// surface as, plus a message-substring fallback -- confirm against a real concurrent\n"
        "// f06-generate-memo submit for the same application_id before relying on this in the demo.\n"
        "function isUniqueViolation(e) {\n"
        "  const body = (e && e.response && (e.response.data || e.response.body))\n"
        "    || (e && e.cause && e.cause.response && (e.cause.response.data || e.cause.response.body))\n"
        "    || null;\n"
        "  if (body && typeof body === 'object' && body.code === '23505') return true;\n"
        "  const text = (body && typeof body === 'string') ? body : String((e && e.message) || e);\n"
        "  return text.indexOf('23505') !== -1 || text.toLowerCase().indexOf('duplicate key') !== -1;\n"
        "}\n"
        "\n"
        "row.version = await readNextVersion();\n"
        "let insertedRows;\n"
        "try {\n"
        "  insertedRows = await insertMemo();\n"
        "} catch (e) {\n"
        "  if (!isUniqueViolation(e)) throw e;\n"
        "  // design.md SS9.6 -- on the (application_id, version) unique race, retry ONCE with next+1.\n"
        "  row.version = await readNextVersion();\n"
        "  insertedRows = await insertMemo();\n"
        "}\n"
        "const memo_id = insertedRows && insertedRows[0] && insertedRows[0].id;\n"
        "\n"
        "// design.md SS9.7 -- lights up api_applications.memo_available/memo_version.\n"
        "const event = buildMemoGeneratedEvent({\n"
        "  memo_id: memo_id, application_id: row.application_id, version: row.version,\n"
        "  recommendation: row.recommendation,\n"
        "  rule_fired: (row.conditions && row.conditions.decision_inputs) ? row.conditions.decision_inputs.rule_fired : null,\n"
        "  run_id: pack.run_id || null, n8n_execution_id: $execution.id,\n"
        "  dropped_statements: dropped_statements,\n"
        "});\n"
        "await pg('POST', 'events', {\n"
        "  event_type: event.event_type, entity_type: event.entity_type, entity_id: event.entity_id,\n"
        "  payload: event.payload, actor: 'f06-generate-memo',\n"
        "}, 'return=minimal');\n"
        "\n"
        "return [{ json: { memo_id: memo_id, application_id: row.application_id, version: row.version, recommendation: row.recommendation } }];\n"
    )
    assemble = code_node("Assemble + write", assemble_js, 1340, 0,
                          notes="SOURCE OF TRUTH: lib/f06/assemble.js -- do not edit here, edit there and re-paste "
                                "(via n8n/build-f06-workflow.py).")
    nodes.append(assemble)

    if_assemble_error = if_node("IF: assemble error?", "={{ $json.error ? 'error' : 'ok' }}", 'error', 1620, 0)
    nodes.append(if_assemble_error)

    respond_assemble_error = respond_node("Respond: assemble error", 422, 1900, -140)
    respond_success = respond_node("Respond: success", 200, 1900, 140)
    nodes += [respond_assemble_error, respond_success]

    # ---- Sticky notes -----------------------------------------------------------
    nodes.append(sticky(
        "Note: pack propagation",
        "### PACK PROPAGATION (design.md SS5.1)\n"
        "An n8n node emits what it RETURNS, not its input. [C]/[D] need\n"
        "[A]'s pack numbers/ids -- reached via the $('Context pack') node\n"
        "reference (valid: [A] is an ancestor of both via\n"
        "[A]->...->Merge->[C]->[D]). [D] likewise reads the four section\n"
        "groups with $('Merge').all(), merged by KEY/CONTENT inside\n"
        "mergeSectionsParts(), never by input index.",
        -160, -820, 620, 240,
    ))
    nodes.append(sticky(
        "Note: all four B nodes always execute",
        "### ALL FOUR [B] NODES ALWAYS EXECUTE (design.md SS5.3)\n"
        "[B3] (memo-optional) is conditional in CONTENT, not in\n"
        "EXECUTION -- with no qualifying input it emits the sentinel\n"
        "{_sentinel:true, risk_matrix:null, competition:null,\n"
        "financials_lite:null}, so the numberInputs:4 append-Merge\n"
        "always sees all four inputs and never stalls (real\n"
        "n8n-nodes-base.merge, branch i -> input i -- a plain multi-wire\n"
        "fan-in silently runs only 1-2 branches in this n8n build,\n"
        "TRACKER's own f03 finding).",
        440, -820, 700, 240,
    ))
    nodes.append(sticky(
        "Note: required-section back-fill",
        "### REQUIRED-SECTION BACK-FILL, NEVER REJECT (spec-review\n"
        "should-fix #1, design.md SS9.3)\n"
        "lib/f06/assemble.js's checkRequiredSections() was replaced with\n"
        "backfillRequiredSections(): a missing/empty required section (or\n"
        "SWOT array) gets ONE deterministic structural line instead of\n"
        "rejecting the memo. As of task T6b, the citation gate and the\n"
        "typed-exception guard ALSO no longer return {error} -- they\n"
        "DROP + LOG the offending statement/item instead (dropped_count/\n"
        "dropped_statements ride the memo_generated event payload), and\n"
        "back-fill (this step) runs AFTER both drops so an emptied\n"
        "required section still ships one line. assembleMemo()'s only\n"
        "remaining {error} path is malformed input (pack/decision missing\n"
        "entirely) -- an LLM omission or citation slip can never hard-fail\n"
        "the whole memo any more.",
        1160, -820, 780, 260,
    ))
    nodes.append(sticky(
        "Note: strict-mode schemas",
        "### STRICT-MODE SCHEMAS (agents/README.md)\n"
        "response_format uses strict:true for every [B] node -- every\n"
        "agent JSON schema is run through this generator's own\n"
        "strictify() at embed time (strips oneOf/allOf/min*/max*/\n"
        "pattern/format, forces every property into `required`).\n"
        "deep-dive-questions has NO *-json-schema.json file in this repo\n"
        "-- its schema is reconstructed here from the prompt's own\n"
        "OUTPUT FORMAT block + design.md SS4.3 (see QUESTIONS_SCHEMA_RAW\n"
        "above), flagged as a design-ambiguity resolution.",
        1160, 460, 780, 260,
    ))

    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Normalize Webhook Input", 0, "Context pack", 0),
            ("Context pack", 0, "IF: pack error?", 0),
        ),
        # IF v2: output 0 = true (error present) -> respond immediately, no downstream.
        {"IF: pack error?": {"main": [
            [{"node": "Respond: pack error", "type": "main", "index": 0}],
            [
                {"node": "LLM: memo-descriptive (B1)", "type": "main", "index": 0},
                {"node": "LLM: memo-analytical (B2)", "type": "main", "index": 0},
                {"node": "LLM: memo-optional (B3)", "type": "main", "index": 0},
                {"node": "LLM: deep-dive-questions (B4)", "type": "main", "index": 0},
            ],
        ]}},
        connect(
            ("LLM: memo-descriptive (B1)", 0, "Merge", 0),
            ("LLM: memo-analytical (B2)", 0, "Merge", 1),
            ("LLM: memo-optional (B3)", 0, "Merge", 2),
            ("LLM: deep-dive-questions (B4)", 0, "Merge", 3),
            ("Merge", 0, "Decision", 0),
            ("Decision", 0, "Assemble + write", 0),
            ("Assemble + write", 0, "IF: assemble error?", 0),
        ),
        {"IF: assemble error?": {"main": [
            [{"node": "Respond: assemble error", "type": "main", "index": 0}],
            [{"node": "Respond: success", "type": "main", "index": 0}],
        ]}},
    )

    workflow = {
        "name": "f06-generate-memo",
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
    print("Code nodes failing syntax check: %d" % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
