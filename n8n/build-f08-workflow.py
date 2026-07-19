#!/usr/bin/env python3
"""
Build the feature-08 (Founder Intake) n8n workflows from source.

Generator, not hand-edited JSON -- same reason as 02/03/04/07 (n8n/build-workflows.py,
n8n/build-f03-workflow.py, n8n/build-f07-workflow.py): lib/f08/{validate,identity,hashing,
gaps,completeness}.js are self-contained, zero-import, unit-tested CommonJS modules
(docs/backlog/TRACKER.md hard convention -- n8n's Code-node sandbox cannot require() a repo
file, no bind-mount). This script pastes them verbatim into Code nodes, so editing the tested
source and re-running this script is the only path from a fix to a running workflow.

Normative spec: docs/backlog/08-founder-intake-interview/n8n-spec.md (node-by-node, read
alongside this file -- every section reference in the comments below points there).
Frozen API contracts: docs/backlog/08-founder-intake-interview/lovable-brief.md SS4.

Five endpoints, priority order per the team lead's brief (build and verify in this order --
the clock may not allow all five):
  1. f08-intake-submit       -- the critical path. Nothing else matters if this fails.
  2. f08-gap-answers         -- the feature's headline claim (coverage rises after answers).
  3. f08-application-status  -- small; its absence makes the UI status screen lie.
  4. f08-followup + f08-followup-answers + f08-followup-create -- lowest priority, cut first.

Deviation from 02/03/04/07's own convention, and why (n8n-spec.md SS0.3): every webhook here
uses responseMode:"responseNode" with explicit n8n-nodes-base.respondToWebhook nodes, never
"lastNode". web/src/lib/api.ts's request() throws on `!res.ok`, reading error.code/message only
on a non-2xx status -- "lastNode" can only ever emit HTTP 200, which would make every frozen
error code (400/413/429/500) unreachable by the frontend.

Run after any change to lib/f08/*.js or docs/backlog/08-founder-intake-interview/agents/*:

    python3 n8n/build-f08-workflow.py           # regenerate n8n/workflows/f08-*.json
    python3 n8n/build-f08-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/README-f08.md).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f08')
AGENTS_ROOT = os.path.join(ROOT, 'docs', 'backlog', '08-founder-intake-interview', 'agents')
DECK_EXTRACTOR_DIR = os.path.join(AGENTS_ROOT, 'deck-claims-extractor')
GAP_PHRASER_DIR = os.path.join(AGENTS_ROOT, 'gap-question-phraser')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

MODEL_LUNA = 'gpt-5.6-luna'    # extraction/classification workhorse (CLAUDE.md) -- text_layer branch
MODEL_TERRA = 'gpt-5.6-terra'  # general-purpose multimodal -- vision branch + gap-question-phraser

# Registered sub-workflow ids -- confirmed live against the running n8n instance
# (GET /api/v1/workflows), overridable for a fresh-instance re-import.
F07_THESIS_GATE_ID = os.environ.get('F07_THESIS_GATE_ID', 'EQxi1lFF2bDjDByd')
F03_SCORE_FOUNDER_ID = os.environ.get('F03_SCORE_FOUNDER_ID', 'AlkzJ70zET7SiHkn')

# Constants n8n-spec.md SS12 introduces -- no source names them, tune empirically.
DECK_TEXT_THRESHOLD_CHARS = 200
RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW_SEC = 60
BASE_CONFIDENCE_INTERVIEW = 0.30
VERDICT_ETA_HOURS = 24
ESTIMATED_MINUTES = 2

INTERNAL_ERROR_MESSAGE = (
    "Something went wrong on our side. Your answers are still here — try again."
)

# The five founder.* topics 08 owns (design.md SS4.0) -- absence markers for whichever of
# these the deck-claims-extractor did NOT return a claim for (SS4.1).
ABSENCE_TOPICS = [
    {"topic": "founder.expertise.vertical_tenure", "label": "Vertical tenure"},
    {"topic": "founder.expertise.insight_specificity", "label": "Industry insight"},
    {"topic": "founder.expertise.competitor_granularity", "label": "Competitor detail"},
    {"topic": "founder.leadership.first_customers", "label": "First customers"},
    {"topic": "founder.leadership.icp_specificity", "label": "ICP specificity"},
]

# Static per-criterion fallback questions -- gap-question-phraser-agent-tbd-items.md D-4,
# used verbatim when the model's output fails the code-side validation gate (n8n-spec.md SS7).
GAP_FALLBACK_QUESTIONS = {
    "L2": {
        "question": "Who is using it today, and how did the first one find you?",
        "why": "Nothing we found publicly shows who is using it yet.",
        "placeholder": "A name, a date, and how the conversation started is enough.",
    },
    "L3": {
        "question": "Who was the last person who really wanted this, and what were they using before?",
        "why": "We couldn't tell from public sources who actually signs.",
        "placeholder": "Their job title, their company size, and what they did instead is plenty.",
    },
    "X5": {
        "question": "When someone chose a different tool over yours, what did they pick and what did it do better?",
        "why": "We can find who your competitors are; we can't find where you actually lose.",
        "placeholder": "One specific instance is more useful than a full comparison.",
    },
}


# ============================================================================
# Source extraction -- lib/f08/*.js pasted verbatim (module.exports stripped; each file's
# own "// SOURCE OF TRUTH: lib/f08/<file>.js" header comment is already IN the file, so it
# travels with the paste automatically -- no need to re-add it here).
# ============================================================================

def _read(name):
    return open(os.path.join(LIBDIR, name), encoding='utf-8').read()


def _strip_exports(src):
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed: " + src[:80]
    return stripped.rstrip() + "\n"


def _strip_use_strict(src):
    """Verified live, 2026-07-19: n8n's Code-node ('runOnceForAllItems') sandbox binds
    `this` (used everywhere by PG_HELPER_JS's `pg.call(this, ...)`) the sloppy-mode way --
    top-level `this` resolves to the execution context object carrying `.helpers`. Every
    lib/f08/*.js file opens with its own `'use strict';` directive (correct for the file in
    isolation); once pasted, if that line lands as the CONCATENATED SCRIPT's leading
    statement (i.e. this file is bundled FIRST), it silently strict-modes the entire Code
    node -- top-level `this` becomes `undefined`, and `this.helpers.httpRequest(...)` inside
    `pg()` throws "Cannot read properties of undefined (reading 'helpers')" purely because of
    concatenation order. Stripped unconditionally on every bundled file rather than relying on
    "always put PG_HELPER_JS first" as the only safeguard -- that convention is easy to break
    on a future edit and the failure mode is silent until a real request exercises the node."""
    return re.sub(r"^\s*['\"]use strict['\"];\s*$", "", src, flags=re.M)


def lib_bundle(*names):
    """Concatenate one or more lib/f08/*.js files (exports stripped, 'use strict' stripped)
    into one Code-node scope. Safe to combine files with no symbol collisions (checked by
    hand below) -- e.g. the Storage-upload node needs BOTH hashing.js's sha256Hex AND
    validate.js's sanitizeFilename, and the two files share no top-level names."""
    parts = []
    for name in names:
        parts.append(_strip_use_strict(_strip_exports(_read(name))))
    return "\n".join(parts)


HASHING_JS = lib_bundle('hashing.js')
VALIDATE_JS = lib_bundle('validate.js')
IDENTITY_JS = lib_bundle('identity.js')
GAPS_JS = lib_bundle('gaps.js')
COMPLETENESS_JS = lib_bundle('completeness.js')


def completeness_unique_js():
    """completeness.js with its CRITERION_TOPIC / GAP_REACHABLE_SOURCES /
    normalizeCriteriaList / isGapReachable / isCriterionCovered block removed -- those five
    are byte-identical duplicates of gaps.js's own copies (each file's header explains why:
    every lib/f08/*.js is meant to be pasted into its OWN separate Code node, so the two
    files duplicate rather than require() each other). Colliding "Identifier ... already
    declared" only shows up when a SINGLE node genuinely needs both selectGapCriteria() and
    cardCompleteness() together -- use GAPS_JS + completeness_unique_js() there, never
    GAPS_JS + COMPLETENESS_JS."""
    marker = "// ---- rounding: matches cards.completeness numeric(3,2) (db/schema.sql). ----"
    idx = COMPLETENESS_JS.find(marker)
    assert idx != -1, "completeness.js marker not found -- source may have changed, update this split point"
    return COMPLETENESS_JS[idx:]


# ============================================================================
# Agent prompt/schema loaders -- pulled straight out of docs/backlog/08-founder-intake-
# interview/agents/*, never retyped by hand (same discipline as f03/f07's generators).
# ============================================================================

def agent_system_prompt(agent_dir, filename):
    t = open(os.path.join(agent_dir, filename), encoding='utf-8').read()
    return t[t.find('SYSTEM MESSAGE'):].split('=' * 80, 1)[1].strip()


def agent_schema(agent_dir, filename):
    return json.load(open(os.path.join(agent_dir, filename), encoding='utf-8'))


# OpenAI's structured-output strict mode rejects several JSON-Schema keywords the source
# docs were written with no knowledge of that constraint (same caveat f07's build script
# already documents and works around) -- stripped here rather than discovered per failed
# call. `allOf` (the deck-extractor schema's criterion_id<->topic cross-check) is stripped
# too: strict mode's conditional-schema support is unreliable, and the check is not load-
# bearing -- the backend's own absence-derivation keys on `topic` alone, `criterion_id` is
# bookkeeping metadata only.
_STRIP_KEYWORDS = ('minLength', 'maxLength', 'pattern', 'uniqueItems', 'maxItems', 'allOf')


def sanitize_schema_for_strict_mode(node):
    if isinstance(node, dict):
        out = {k: sanitize_schema_for_strict_mode(v) for k, v in node.items() if k not in _STRIP_KEYWORDS}
        # Verified live, 2026-07-19: OpenAI's structured-output strict mode rejects `oneOf`
        # outright ("'oneOf' is not allowed"; only `anyOf` is supported). The deck-claims-
        # extractor schema's founder_identity field is exactly `oneOf: [null, object]` --
        # renamed to `anyOf`, which validates identically here since the two branches
        # (type:null vs type:object) are already mutually exclusive by construction.
        if 'oneOf' in out:
            out['anyOf'] = out.pop('oneOf')
        # OpenAI strict mode requires every key in "properties" to also appear in
        # "required" (nullability is expressed via a type union / oneOf-with-null instead
        # of by omitting the key from required) -- fix up defensively rather than hand-edit
        # every schema file to satisfy an API constraint the docs were written without.
        if 'properties' in out and isinstance(out['properties'], dict):
            out['required'] = list(out['properties'].keys())
        return out
    if isinstance(node, list):
        return [sanitize_schema_for_strict_mode(v) for v in node]
    return node


DECK_EXTRACTOR_SYS = agent_system_prompt(DECK_EXTRACTOR_DIR, 'deck-claims-extractor-agent-prompts.txt')
DECK_EXTRACTOR_SCHEMA = sanitize_schema_for_strict_mode(
    agent_schema(DECK_EXTRACTOR_DIR, 'deck-claims-extractor-agent-json-schema.json'))
GAP_PHRASER_SYS = agent_system_prompt(GAP_PHRASER_DIR, 'gap-question-phraser-agent-prompts.txt')
GAP_PHRASER_SCHEMA_ARRAY = sanitize_schema_for_strict_mode(
    agent_schema(GAP_PHRASER_DIR, 'gap-question-phraser-agent-json-schema.json'))
# n8n-spec.md SS7 asserted the request body's schema must be the array schema "verbatim, not
# wrapped" -- verified live 2026-07-19 that this is WRONG: OpenAI's /v1/responses rejects a
# top-level `type:"array"` response_format schema outright ("schema must be a JSON Schema of
# 'type: object', got 'type: array'"). Wrapped in a single-key object instead; the parse node
# below reads `parsed.questions` rather than `parsed` directly. The agent's own prompt still
# describes a bare array as the OUTPUT FORMAT, which is harmless -- strict structured-output
# enforcement dictates the actual wire shape regardless of what the prompt text says.
GAP_PHRASER_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"questions": GAP_PHRASER_SCHEMA_ARRAY}, "required": ["questions"],
}


# ============================================================================
# n8n node/connection helpers -- same shapes as build-f03/f07-workflow.py.
# ============================================================================

def nid():
    return str(uuid.uuid4())


def code_node(name, js, x, y, notes=None, on_error=False):
    node = {
        "parameters": {"mode": "runOnceForAllItems", "jsCode": js},
        "id": nid(), "name": name, "type": "n8n-nodes-base.code",
        "typeVersion": 2, "position": [x, y],
    }
    if notes:
        node["notes"] = notes
    if on_error:
        # n8n-spec.md SS0.3.1: every Code node that calls Storage/PostgREST/OpenAI wires
        # its error output (index 1) to the shared "Handle unexpected error" node, instead
        # of the default stopWorkflow (which would surface n8n's own error page / stack
        # trace to the founder -- lovable-brief.md SS4.5 forbids that explicitly).
        node["onError"] = "continueErrorOutput"
    return node


def if_node(name, left_expr, right, op_type, operation, x, y):
    return {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [{
                    "id": nid(), "leftValue": left_expr, "rightValue": right,
                    "operator": {"type": op_type, "operation": operation},
                }],
                "combinator": "and",
            },
            "options": {},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.if",
        "typeVersion": 2, "position": [x, y],
    }


def webhook_node(name, path, method, x, y):
    return {
        "parameters": {
            "httpMethod": method, "path": path,
            "responseMode": "responseNode",  # SS0.3 -- the load-bearing deviation from 02/03/04/07
            "options": {},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [x, y], "webhookId": nid(),
    }


def respond_node(name, status_code, x, y):
    """respondToWebhook, typeVersion 1.1 -- new to this repo (n8n-spec.md SS0.1b). Every
    call site upstream builds the EXACT response object as its own item.json (no wrapper
    keys), so "firstIncomingItem" sends it verbatim -- avoids any dynamic-expression risk
    in the response body (the {{ }} brace-truncation bug 07's README documents was hit
    building a JSON *body* expression; sidestepped entirely here by never building one)."""
    return {
        "parameters": {
            "respondWith": "firstIncomingItem",
            "options": {"responseCode": status_code},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.1, "position": [x, y],
    }


def convert_to_file_node(name, source_property, filename_expr, mime, x, y, on_error=True):
    node = {
        "parameters": {
            "operation": "toBinary",
            "sourceProperty": source_property,
            "binaryPropertyName": "data",
            "options": {"fileName": filename_expr, "mimeType": mime},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.convertToFile",
        "typeVersion": 1.1, "position": [x, y],
    }
    if on_error:
        node["onError"] = "continueErrorOutput"
    return node


def extract_from_file_pdf_node(name, x, y, on_error=True):
    node = {
        "parameters": {
            "operation": "pdf", "binaryPropertyName": "data",
            "options": {"joinPages": True},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.extractFromFile",
        "typeVersion": 1.1, "position": [x, y],
    }
    if on_error:
        node["onError"] = "continueErrorOutput"
    return node


def execute_workflow_node(name, workflow_id, x, y, notes=None):
    node = {
        "parameters": {"source": "database", "workflowId": {"__rl": True, "value": workflow_id, "mode": "id"}, "options": {}},
        "id": nid(), "name": name, "type": "n8n-nodes-base.executeWorkflow",
        "typeVersion": 1.2, "position": [x, y],
    }
    if notes:
        node["notes"] = notes
    return node


def openai_node(name, x, y, timeout=90000):
    """Generic /v1/responses call -- reused for both deck-claims-extractor branches and
    gap-question-phraser. The request body is built in the PRECEDING Code node and stashed
    on $json.__openai_request_body; jsonBody stays a SHORT expression referencing it (07's
    own documented workaround for the {{ }} brace-truncation bug on deeply nested schemas)."""
    return {
        "parameters": {
            "method": "POST", "url": "https://api.openai.com/v1/responses",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $env.OPENAI_API_KEY }}"},
                {"name": "Content-Type", "value": "application/json"},
            ]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.__openai_request_body) }}",
            "options": {"timeout": timeout},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.1, "position": [x, y],
        "retryOnFail": True, "maxTries": 2, "waitBetweenTries": 3000,
        "onError": "continueErrorOutput",
    }


def sticky(content, x, y, w, h):
    return {
        "parameters": {"content": content, "height": h, "width": w},
        "id": nid(), "name": "Note", "type": "n8n-nodes-base.stickyNote",
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


def error_out(src, target):
    """Wire a node's error output (index 1, only present when onError:'continueErrorOutput'
    is set) to `target`. Multiple risky nodes' error outputs may all point at the SAME
    target -- only one can ever fire per execution (a single run follows one path), the
    same "exclusive branches may share a plain fan-in" allowance n8n-spec.md SS0 grants
    IF/Switch reconvergence."""
    return {src: {"main": [[], [{"node": target, "type": "main", "index": 0}]]}}


def check_nodes(nodes):
    bad = 0
    for n in nodes:
        js = n.get('parameters', {}).get('jsCode')
        if not js:
            continue
        wrapped = (
            "const $env = {}; const $execution = { id: 1 };\n"
            "const $input = { first: () => ({ json: {} }), all: () => [] };\n"
            "const $ = () => ({ first: () => ({ json: {} }) });\n"
            "const self = { helpers: { httpRequest: async () => ({}), assertBinaryData: () => ({}) } };\n"
            "(async function(){\n" + js + "\n}).call(self);\n"
        )
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write(wrapped)
            path = f.name
        r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
        ok = r.returncode == 0
        print("  %-52s %s (%d bytes)" % (n['name'], 'OK' if ok else 'SYNTAX ERROR', len(js)))
        if not ok:
            bad += 1
            print(r.stderr[:800])
        os.unlink(path)
    return bad


# ============================================================================
# Shared JS fragments
# ============================================================================

PG_HELPER_JS = r"""
const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;
async function pg(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  return await this.helpers.httpRequest({ method, url: SB + '/rest/v1/' + path, headers, body, json: true });
}
async function pgGet(path) { return await pg.call(this, 'GET', path); }
"""

# n8n-spec.md SS0.2 -- the `decks` bucket, provisioned by devops (T1, tracker.md: done).
# `Buffer` confirmed live as an available Code-node-sandbox global (team lead, 2026-07-19) --
# no polyfill needed. Uses this.helpers.httpRequest exactly like pg() -- throws on non-2xx
# by default, which is what lets the calling node's onError:'continueErrorOutput' catch a
# failed upload without this helper needing its own status check.
STORAGE_HELPER_JS = r"""
async function storageUpload(objectPath, mime, base64) {
  const buf = Buffer.from(base64, 'base64');
  return await this.helpers.httpRequest({
    method: 'POST', url: SB + '/storage/v1/object/decks/' + objectPath,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': mime || 'application/octet-stream' },
    body: buf,
  });
}
"""

HANDLE_UNEXPECTED_ERROR_JS = (
    "// n8n-spec.md SS0.3.1 -- the single shared internal-error responder every risky\n"
    "// Code/httpRequest node's error output feeds. Fixed copy regardless of the upstream\n"
    "// failure's shape -- lovable-brief.md SS9.5's exact string, so Postgres/Storage/OpenAI\n"
    "// failures all read identically to the founder.\n"
    "return [{ json: { error: { code: 'internal', message: " + json.dumps(INTERNAL_ERROR_MESSAGE) + " } } }];\n"
)


def build_openai_request_body_js(sys_prompt, schema, schema_name, model, user_expr_js, extra_content_js=None,
                                  reasoning_effort='low', verbosity='low', max_output_tokens=1500, strict=True):
    """Builds a Code node body that stashes an OpenAI /v1/responses request on
    $json.__openai_request_body. `user_expr_js` is a JS expression string yielding either a
    plain string (text-only) or an array of content parts (vision -- text + input_file).
    `extra_content_js`, if given, is JS building an array to concat onto the user content
    (used by the vision branch to attach the PDF as an input_file part).

    `strict=False` -- verified live 2026-07-19: deck-claims-extractor-agent-json-schema.json's
    `claims[].value` is deliberately untyped (`{"type": ["object","null"]}`, no `properties`) --
    "a small structured echo of arbitrary shape" per the agent's own input spec, varying per
    topic. OpenAI's strict structured-output mode rejects that outright ("'additionalProperties'
    is required to be supplied and to be false"), which cannot be satisfied without abandoning
    the field's actual purpose (a fixed schema can't describe every topic's shape in advance).
    Non-strict json_schema mode keeps the field genuinely free-form; this node's own downstream
    parsing already treats the model's output defensively (span-verifies every quote, drops
    anything that fails), so losing the strict guarantee costs nothing this code doesn't already
    check for itself."""
    sys_js = json.dumps(sys_prompt)
    schema_js = json.dumps(schema)
    return (
        "const SYS = " + sys_js + ";\n"
        "const SCHEMA = " + schema_js + ";\n"
        "let userContent = " + user_expr_js + ";\n"
        + (extra_content_js or "") +
        "const body = {\n"
        "  model: " + json.dumps(model) + ",\n"
        "  input: [ { role: 'system', content: SYS }, { role: 'user', content: userContent } ],\n"
        "  reasoning: { effort: " + json.dumps(reasoning_effort) + " },\n"
        "  text: { verbosity: " + json.dumps(verbosity) + ", format: { type: 'json_schema',\n"
        "    name: " + json.dumps(schema_name) + ", strict: " + json.dumps(bool(strict)) + ", schema: SCHEMA } },\n"
        "  max_output_tokens: " + str(max_output_tokens) + ",\n"
        "};\n"
        "return [{ json: { ...$json, __openai_request_body: body } }];\n"
    )


def parse_openai_response_js():
    """Shared prelude for parsing a /v1/responses payload -- same shape f07's own extractor
    validator uses (find the 'message' output item, read its first content part's text,
    JSON.parse it). Returns the parsed value in `parsed` (null on any failure) and the raw
    text in `rawText`."""
    return r"""
const resp = $input.first().json;
let parsed = null, rawText = '';
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  rawText = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  parsed = JSON.parse(rawText);
} catch (e) { parsed = null; }
"""


# ============================================================================
# f08-intake-submit -- the critical path (n8n-spec.md SS2). Sequential, not the optional
# parallel Merge of deck-claims-extractor + f07-thesis-gate (SS5's own "equally correct
# against every acceptance criterion... a latency optimization, not a correctness
# requirement") -- chosen to keep the build's risk surface small under the clock.
# ============================================================================

def build_intake_submit():
    nodes = []
    X0 = -1600

    webhook = webhook_node("Webhook: f08-intake-submit", "f08-intake-submit", "POST", X0, 0)
    validate = code_node(
        "Validate input",
        VALIDATE_JS + r"""
const item = $input.first().json;
const body = item.body || {};
const result = validateIntakePayload(body);
if (!result.ok) {
  return [{ json: { __valid: false, error: result.error } }];
}
return [{ json: { __valid: true, ...result.value } }];
""", X0 + 240, 0)
    if_valid = if_node("IF: valid?", "={{ $json.__valid }}", True, "boolean", "equals", X0 + 480, 0)
    nodes += [webhook, validate, if_valid]

    # ---- validation-error branch (SS0.4 -- exact codes validate.js actually produces) ----
    build_val_err = code_node(
        "Build validation error response",
        r"""
const err = $json.error || { code: 'invalid_input', message: 'Invalid input.' };
return [{ json: { error: { code: err.code, message: err.message } } }];
""", X0 + 720, -300)
    if_deck_too_large = if_node("IF: deck_too_large?", "={{ $json.error.code }}", "deck_too_large",
                                 "string", "equals", X0 + 960, -300)
    respond_413 = respond_node("Respond: deck too large (413)", 413, X0 + 1200, -420)
    respond_400 = respond_node("Respond: bad request (400)", 400, X0 + 1200, -180)
    nodes += [build_val_err, if_deck_too_large, respond_413, respond_400]

    # ---- idempotency check (SS2.1a -- BEFORE rate limiting, deliberately) ----
    idem_check = code_node(
        "Idempotency check",
        PG_HELPER_JS + r"""
const inp = $json;
const apps = await pgGet.call(this,
  `applications?id=eq.${inp.intake_submission_id}&select=id,company_id,status,created_at,artifact_links&order=created_at.asc&limit=1`);
let cardRow = null, interviewRow = null;
if (apps.length) {
  const cards = await pgGet.call(this,
    `cards?application_id=eq.${inp.intake_submission_id}&card_type=eq.founder&select=id,founder_id,completeness&order=created_at.asc&limit=1`);
  cardRow = cards.length ? cards[0] : null;
  const interviews = await pgGet.call(this,
    `interviews?application_id=eq.${inp.intake_submission_id}&kind=eq.first&select=transcript&order=created_at.asc&limit=1`);
  interviewRow = interviews.length ? interviews[0] : null;
}
return [{ json: { ...inp, __existing_application: apps.length ? apps[0] : null,
  __existing_card: cardRow, __existing_interview: interviewRow } }];
""", X0 + 720, 0, on_error=True)
    if_exists = if_node("IF: application exists?", "={{ !!$json.__existing_application }}", True,
                         "boolean", "equals", X0 + 960, 0)
    nodes += [idem_check, if_exists]

    # ---- replay branch (SS2.1 -- only _f08_deck_meta is cached; everything else re-read live) ----
    replay = code_node(
        "Build replay response",
        PG_HELPER_JS + COMPLETENESS_JS + r"""
const inp = $json;
const app = inp.__existing_application;
const card = inp.__existing_card;
const links = app.artifact_links || {};
const meta = links._f08_deck_meta || { extraction_mode: 'none', pages: 0, chars_extracted: 0, warning: null };
let completeness = card ? card.completeness : 0;
if (card) {
  const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
  const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
  const claims = await pgGet.call(this, `claims?card_id=eq.${card.id}&select=id,topic,verification_status`);
  completeness = cardCompleteness({ criteria, claims });
}
const pendingQuestions = ((inp.__existing_interview && inp.__existing_interview.transcript &&
  inp.__existing_interview.transcript.questions) || [])
  .map(q => ({ criterion_id: q.criterion_id, question: q.question, why: q.why, placeholder: q.placeholder }));
return [{ json: {
  application_id: app.id, company_id: app.company_id, founder_id: card ? card.founder_id : null,
  status: app.status,
  deck: { extraction_mode: meta.extraction_mode, pages: meta.pages || 0,
          chars_extracted: meta.chars_extracted || 0, warning: meta.warning || null },
  extra_files_stored: (links.extra_file_paths || []).length,
  gap_questions: pendingQuestions,
  estimated_minutes: %(EST)s, verdict_eta_hours: %(ETA)s,
} }];
""" % {"EST": ESTIMATED_MINUTES, "ETA": VERDICT_ETA_HOURS}, X0 + 1200, 180, on_error=True)
    respond_replay = respond_node("Respond: success (replay)", 200, X0 + 1440, 180)
    nodes += [replay, respond_replay]

    # ---- rate limiting (SS12: 5 req / 60s per email, in-memory static data) ----
    rate_check = code_node(
        "Rate limit check",
        r"""
const inp = $json;
const store = $getWorkflowStaticData('global');
if (!store.emailCounts) store.emailCounts = {};
const now = Date.now();
const windowMs = %(WINDOW)s * 1000;
const key = inp.contact_email;
const arr = (store.emailCounts[key] || []).filter(ts => now - ts < windowMs);
const limited = arr.length >= %(MAXN)s;
if (!limited) arr.push(now);
store.emailCounts[key] = arr;
return [{ json: { ...inp, __rate_limited: limited } }];
""" % {"WINDOW": RATE_LIMIT_WINDOW_SEC, "MAXN": RATE_LIMIT_MAX}, X0 + 1200, 0)
    if_rate_limited = if_node("IF: rate limited?", "={{ $json.__rate_limited }}", True, "boolean",
                               "equals", X0 + 1440, 0)
    build_rate_err = code_node(
        "Set rate_limited error",
        r"""return [{ json: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } } }];""",
        X0 + 1680, -60)
    respond_429 = respond_node("Respond: rate limited (429)", 429, X0 + 1920, -60)
    nodes += [rate_check, if_rate_limited, build_rate_err, respond_429]

    # ---- shared internal-error responder (SS0.3.1) ----
    handle_unexpected_error = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, X0 + 2400, 600)
    respond_500 = respond_node("Respond: internal error (500)", 500, X0 + 2640, 600)
    nodes += [handle_unexpected_error, respond_500]

    # ---- Storage upload (SS0.2 -- deck first, then extra files; base64 dropped after) ----
    upload = code_node(
        "Upload deck + extra files to Storage",
        PG_HELPER_JS + STORAGE_HELPER_JS + HASHING_JS + r"""
const inp = $json;
const applicationId = inp.intake_submission_id;
const deckHash = sha256Hex(inp.deck.base64).slice(0, 16);
const deckObjectPath = `${applicationId}/${deckHash}-${inp.deck.filename}`;
await storageUpload.call(this, deckObjectPath, inp.deck.mime, inp.deck.base64);

const extraFilePaths = [];
for (const f of (inp.extra_files || [])) {
  const hp = sha256Hex(f.base64).slice(0, 16);
  const objPath = `${applicationId}/${hp}-${f.filename}`;
  await storageUpload.call(this, objPath, f.mime, f.base64);
  extraFilePaths.push(objPath);
}
const out = { ...inp, deck_storage_path: deckObjectPath, extra_file_paths: extraFilePaths };
delete out.extra_files; // R-10: drop extra-file base64 immediately after upload
return [{ json: out }];
""", X0 + 1920, 0, on_error=True)
    nodes.append(upload)

    # ---- entity resolution (identity.js, design.md SS3.1) ----
    resolve_entities = code_node(
        "Resolve or create entities",
        PG_HELPER_JS + IDENTITY_JS + r"""
const inp = $json;
async function lookupIdentity(kind, value) {
  const filter = kind === 'github'
    ? `founder_identities?kind=eq.github&value=ilike.${encodeURIComponent(value)}&select=founder_id&order=created_at.asc&limit=1`
    : `founder_identities?kind=eq.${kind}&value=eq.${encodeURIComponent(value)}&select=founder_id&order=created_at.asc&limit=1`;
  const rows = await pgGet.call(this, filter);
  return rows.length ? rows[0].founder_id : null;
}
const resolution = await resolveFounderIdentity(
  { contact_email: inp.contact_email, artifact_links: inp.artifact_links },
  lookupIdentity.bind(this)
);
let founderId = resolution.founder_id;
if (resolution.action === 'create') {
  const made = await pg.call(this, 'POST', 'founders', { full_name: resolution.defaults.full_name }, 'return=representation');
  founderId = made[0].id;
}
for (const idn of resolution.identities_to_write) {
  const existing = await pgGet.call(this, `founder_identities?kind=eq.${idn.kind}&value=eq.${encodeURIComponent(idn.value)}&select=id&limit=1`);
  if (!existing.length) {
    await pg.call(this, 'POST', 'founder_identities', { founder_id: founderId, kind: idn.kind, value: idn.value }, 'return=minimal');
  }
}
// design.md SS3.1 -- no company-level dedup for 08; every intake submission creates a fresh row.
const company = await pg.call(this, 'POST', 'companies', {
  name: inp.company_name,
  stage: (resolution.defaults && resolution.defaults.companies_stage) || 'pre_seed',
  domain: null,
}, 'return=representation');
const companyId = company[0].id;
const fc = await pgGet.call(this, `founder_company?founder_id=eq.${founderId}&company_id=eq.${companyId}&select=id&limit=1`);
if (!fc.length) {
  await pg.call(this, 'POST', 'founder_company', {
    founder_id: founderId, company_id: companyId,
    role: (resolution.defaults && resolution.defaults.founder_company_role) || 'founder',
    is_current: true, source: 'intake_form',
  }, 'return=minimal');
}
return [{ json: { ...inp, founder_id: founderId, company_id: companyId, __is_new_founder: resolution.action === 'create' } }];
""", X0 + 2160, 0, on_error=True)
    nodes.append(resolve_entities)

    # ---- applications + cards (design.md SS2.0 -- kind='inbound', card_type='founder') ----
    insert_app = code_node(
        "Insert applications + cards",
        PG_HELPER_JS + r"""
const inp = $json;
const artifactLinks = {
  source: 'intake_form',
  intake_submission_id: inp.intake_submission_id,
  founder_links: inp.artifact_links || [],
  deck_filename: inp.deck.filename,
  extra_file_paths: inp.extra_file_paths || [],
};
const appRow = await pg.call(this, 'POST', 'applications', {
  id: inp.intake_submission_id, company_id: inp.company_id, kind: 'inbound',
  deck_storage_path: inp.deck_storage_path, artifact_links: artifactLinks,
  submitted_by: inp.contact_email,
}, 'return=representation');
const applicationId = appRow[0].id;
const cardRow = await pg.call(this, 'POST', 'cards', {
  card_type: 'founder', founder_id: inp.founder_id, company_id: inp.company_id,
  application_id: applicationId, status: 'prefilled',
}, 'return=representation');
return [{ json: { ...inp, application_id: applicationId, card_id: cardRow[0].id, __artifact_links: artifactLinks } }];
""", X0 + 2400, 0, on_error=True)
    nodes.append(insert_app)

    # ---- raw_signals(deck_parse) (design.md SS3, step 5 -- both FKs set at insert) ----
    write_raw_signal = code_node(
        "Write raw_signals (deck_parse)",
        PG_HELPER_JS + HASHING_JS + r"""
const inp = $json;
const hash = contentHash.rawSignal({ application_id: inp.application_id, source: 'deck_parse', content_key: inp.deck.base64 });
const found = await pgGet.call(this, `raw_signals?content_hash=eq.${encodeURIComponent(hash)}&select=id`);
let rawSignalId;
if (found.length) {
  rawSignalId = found[0].id;
} else {
  const made = await pg.call(this, 'POST', 'raw_signals', {
    source: 'deck_parse', source_url: null,
    payload: { deck_storage_path: inp.deck_storage_path, filename: inp.deck.filename, mime: inp.deck.mime },
    content_hash: hash, founder_id: inp.founder_id, company_id: inp.company_id,
    observed_at: new Date().toISOString(),
  }, 'return=representation');
  rawSignalId = made[0].id;
}
return [{ json: { ...inp, raw_signal_id: rawSignalId } }];
""", X0 + 2640, 0, on_error=True)
    nodes.append(write_raw_signal)

    # ---- deck cascade (design.md SS5): text layer -> vision fallback -> honest 'none' ----
    convert_to_file = convert_to_file_node("Convert to File", "deck.base64", "={{ $json.deck.filename }}",
                                            "application/pdf", X0 + 2880, 0, on_error=True)
    extract_pdf = extract_from_file_pdf_node("Extract From File", X0 + 3120, 0, on_error=True)
    compute_chars = code_node(
        "Compute chars_extracted",
        r"""
// Verified live 2026-07-19: n8n-nodes-base.convertToFile's 'toBinary' operation returns an
// EMPTY json object (only the binary property is set) -- it does not spread the incoming
// item's json the way ExtractFromFile's own keepSource:'json' default does. Every field set
// before "Convert to File" (application_id, founder_id, card_id, deck, company_name, ...) is
// therefore gone from $json by this point; recovered here via a named-node lookup to the
// last node that still had it, same pattern used everywhere else in this workflow whenever
// a node's output replaces rather than merges the upstream item.
const ctx = $('Write raw_signals (deck_parse)').first().json;
const inp = $input.first().json;
const text = typeof inp.text === 'string' ? inp.text : '';
const pages = typeof inp.numpages === 'number' ? inp.numpages : 0;
return [{ json: { ...ctx, chars_extracted: text.length, pages, __deck_text: text } }];
""", X0 + 3360, 0)
    if_text_sufficient = if_node("IF: text layer sufficient?", "={{ $json.chars_extracted }}",
                                  DECK_TEXT_THRESHOLD_CHARS, "number", "gte", X0 + 3600, 0)
    nodes += [convert_to_file, extract_pdf, compute_chars, if_text_sufficient]

    # "Handle deck read failure" -- Convert to File / Extract From File threw (genuinely
    # corrupt binary), NOT the internal-error path: design.md SS5 treats an unreadable file
    # as an honest, scoreable outcome, not an infra failure.
    deck_read_failure = code_node(
        "Handle deck read failure",
        r"""
const ctx = $('Write raw_signals (deck_parse)').first().json;
return [{ json: { ...ctx, extraction_mode: 'none', deck_warning: 'extraction_failed',
  chars_extracted: 0, pages: 0, __deck_text: '', __extractor_claims: [], __founder_identity: null } }];
""", X0 + 3360, 420)
    nodes.append(deck_read_failure)

    text_req_js = build_openai_request_body_js(
        sys_prompt=DECK_EXTRACTOR_SYS, schema=DECK_EXTRACTOR_SCHEMA,
        schema_name='deck_claims_extractor_output', model=MODEL_LUNA,
        user_expr_js=(
            "'<extraction_mode>text_layer</extraction_mode>\\n' +\n"
            "  '<company_name>' + String($json.company_name || '') + '</company_name>\\n' +\n"
            "  '<page_count>' + String($json.pages || 0) + '</page_count>\\n' +\n"
            "  '<deck_text>\\n' + String($json.__deck_text || '') + '\\n</deck_text>'"
        ),
        strict=False,  # claims[].value is deliberately free-form -- see build_openai_request_body_js docstring
    )
    build_text_req = code_node("Build extractor request (text_layer)", text_req_js, X0 + 3840, -180)
    openai_text = openai_node("OpenAI: deck-claims-extractor (luna, text_layer)", X0 + 4080, -180)

    vision_req_js = build_openai_request_body_js(
        sys_prompt=DECK_EXTRACTOR_SYS, schema=DECK_EXTRACTOR_SCHEMA,
        schema_name='deck_claims_extractor_output', model=MODEL_TERRA,
        user_expr_js=(
            "[ { type: 'input_text', text:\n"
            "  '<extraction_mode>vision</extraction_mode>\\n' +\n"
            "  '<company_name>' + String($json.company_name || '') + '</company_name>\\n' +\n"
            "  '<page_count>' + String($json.pages || 0) + '</page_count>\\n' +\n"
            "  '<deck_text>\\n\\n</deck_text>' } ]"
        ),
        extra_content_js=(
            "// design.md SS5 -- no PDF-rasterization node in this n8n build; the original PDF is\n"
            "// sent as an input_file part and OpenAI's Responses API renders pages internally.\n"
            "// Flagged for live verification (n8n-spec.md SS4) -- verified live in this build.\n"
            "userContent.push({ type: 'input_file', filename: $json.deck.filename || 'deck.pdf',\n"
            "  file_data: 'data:application/pdf;base64,' + $json.deck.base64 });\n"
        ),
        strict=False,  # claims[].value is deliberately free-form -- see build_openai_request_body_js docstring
    )
    build_vision_req = code_node("Build extractor request (vision)", vision_req_js, X0 + 3840, 180)
    openai_vision = openai_node("OpenAI: deck-claims-extractor (terra, vision)", X0 + 4080, 180, timeout=120000)
    nodes += [build_text_req, openai_text, build_vision_req, openai_vision]

    def _extractor_parse_js(ctx_node_name, success_extraction_mode):
        return (
            "const ctx = $('%s').first().json;\n" % ctx_node_name
            + r"""
const resp = $input.first().json;
let parsed = null, rawText = '';
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  rawText = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  parsed = JSON.parse(rawText);
} catch (e) { parsed = null; }

let extractionMode, deckWarning, claims, founderIdentity;
if (parsed && resp.status === 'completed' && Array.isArray(parsed.claims)) {
  const failureReason = parsed.failure_reason;
  if (failureReason === 'no_text_extracted') { extractionMode = 'none'; deckWarning = 'image_only_deck'; }
  else if (failureReason === 'unreadable_input') { extractionMode = 'none'; deckWarning = 'extraction_failed'; }
  else { extractionMode = '""" + success_extraction_mode + r"""'; deckWarning = null; }
  claims = parsed.claims;
  founderIdentity = parsed.founder_identity || null;
} else {
  // Transport succeeded but the model's output was unparseable/invalid -- an honest
  // extraction failure (the deck WAS sent), never an infra 500.
  extractionMode = 'none'; deckWarning = 'extraction_failed'; claims = []; founderIdentity = null;
}
return [{ json: { ...ctx, extraction_mode: extractionMode, deck_warning: deckWarning,
  __extractor_claims: claims, __founder_identity: founderIdentity } }];
"""
        )

    parse_text = code_node("Parse extractor response (text_layer)",
                            _extractor_parse_js("Build extractor request (text_layer)", "text_layer"),
                            X0 + 4320, -180)
    parse_vision = code_node("Parse extractor response (vision)",
                              _extractor_parse_js("Build extractor request (vision)", "vision"),
                              X0 + 4320, 180)
    nodes += [parse_text, parse_vision]

    # Shared: either OpenAI call itself failed (network/API error) -- an honest degraded
    # outcome per plan.md's own cut order ("if gpt-5.6-terra rejects input_file... go
    # straight to extraction_mode='none'"), extended here to the text_layer branch too for
    # the identical reason -- the deck was legitimately sent, only the call failed.
    handle_extractor_failure = code_node(
        "Handle extractor call failure",
        r"""
let ctx = null;
try { ctx = $('Build extractor request (text_layer)').first().json; } catch (e) { ctx = null; }
if (!ctx) { try { ctx = $('Build extractor request (vision)').first().json; } catch (e) { ctx = null; } }
ctx = ctx || $json;
return [{ json: { ...ctx, extraction_mode: 'none', deck_warning: 'extraction_failed',
  __extractor_claims: [], __founder_identity: null } }];
""", X0 + 4320, 420)
    nodes.append(handle_extractor_failure)

    # ---- claims + evidence + ai_runs + full_name update (design.md SS4/SS4.1, SS3.1 step 15) ----
    # Four exclusive branches (parse_text / parse_vision / handle_extractor_failure /
    # deck_read_failure) all produce the SAME shape and reconverge here with a plain
    # multi-wire fan-in -- allowed for exclusive branches (n8n-spec.md SS0).
    write_claims = code_node(
        "Write founder claims + evidence",
        PG_HELPER_JS + HASHING_JS + r"""
const inp = $json;
const claimsOut = Array.isArray(inp.__extractor_claims) ? inp.__extractor_claims : [];
const modeCap = inp.extraction_mode === 'text_layer' ? 0.80 : inp.extraction_mode === 'vision' ? 0.64 : 0.0;
const tier = inp.extraction_mode === 'text_layer' ? 'documented' : inp.extraction_mode === 'vision' ? 'inferred' : 'missing';

// ai_runs -- only when a model call actually happened (design.md SS5: extraction_mode='none'
// -- honest-empty-deck or crash alike -- skips the model call entirely).
let aiRunId = null;
if (inp.extraction_mode !== 'none') {
  const model = inp.extraction_mode === 'text_layer' ? %(LUNA)s : %(TERRA)s;
  const inputHash = sha256Hex('f08:ai_run:extraction:' + inp.application_id + ':' + inp.raw_signal_id + ':' + inp.extraction_mode);
  const found = await pgGet.call(this, `ai_runs?input_hash=eq.${encodeURIComponent(inputHash)}&select=id`);
  if (found.length) {
    aiRunId = found[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'ai_runs', {
      task_type: 'extraction', founder_id: inp.founder_id, company_id: inp.company_id, application_id: inp.application_id,
      model, input_hash: inputHash,
      output_json: { claims: claimsOut, founder_identity: inp.__founder_identity || null },
    }, 'return=representation');
    aiRunId = made[0].id;
  }
}

function normWs(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }
function spanFactor(quote, source) {
  if (!quote) return 0;
  const q = normWs(quote);
  if (!q) return 0;
  const src = normWs(source);
  if (src.includes(q)) return 1.0;
  if (src.toLowerCase().includes(q.toLowerCase())) return 0.9;
  return 0;
}

const presentTopics = new Set();
const hallucinationFlags = [];
for (const c of claimsOut) {
  const factor = spanFactor(c.quote_verbatim, inp.__deck_text || '');
  if (factor <= 0) {
    hallucinationFlags.push({ topic: c.topic, quote_verbatim: c.quote_verbatim });
    continue; // dropped -- not written, per the extractor's own confidence contract
  }
  presentTopics.add(c.topic);
  const baseConfidence = Math.round(factor * modeCap * 100) / 100;
  const claimHash = contentHash.claim({ application_id: inp.application_id, card_id: inp.card_id, topic: c.topic, item_key: '_' });
  const existingClaim = await pgGet.call(this, `claims?content_hash=eq.${encodeURIComponent(claimHash)}&select=id`);
  let claimId;
  if (existingClaim.length) {
    claimId = existingClaim[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'claims', {
      card_id: inp.card_id, topic: c.topic, text_verbatim: c.text_verbatim, value: c.value || null,
      axis: null, source_kind: 'self_reported', base_confidence: baseConfidence,
      verification_status: 'unverified', content_hash: claimHash,
    }, 'return=representation');
    claimId = made[0].id;
  }
  const evHash = contentHash.evidence({ application_id: inp.application_id, claim_id: claimId, relation: 'supports', raw_signal_id: inp.raw_signal_id });
  const existingEv = await pgGet.call(this, `evidence?content_hash=eq.${encodeURIComponent(evHash)}&select=id`);
  if (!existingEv.length) {
    await pg.call(this, 'POST', 'evidence', {
      claim_id: claimId, relation: 'supports', tier, strength: null,
      quote_verbatim: c.quote_verbatim, source_url: null, raw_signal_id: inp.raw_signal_id, content_hash: evHash,
    }, 'return=minimal');
  }
}

// Absence markers -- the founder.* topics NOT present in claimsOut (design.md SS4.1, R-6).
const ABSENCE_TOPICS = %(ABSENCE_TOPICS)s;
for (const abs of ABSENCE_TOPICS) {
  if (presentTopics.has(abs.topic)) continue;
  const existingGap = await pgGet.call(this,
    `claims?card_id=eq.${inp.card_id}&topic=eq.${encodeURIComponent(abs.topic)}&source_kind=eq.derived&select=id&order=created_at.desc&limit=1`);
  let gapId;
  if (existingGap.length) {
    gapId = existingGap[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'claims', {
      card_id: inp.card_id, topic: abs.topic, text_verbatim: abs.label + ': not stated in the deck.',
      value: null, axis: null, source_kind: 'derived', verification_status: 'missing', content_hash: null,
    }, 'return=representation');
    gapId = made[0].id;
  }
  const gapEvHash = sha256Hex('f08:evidence:missing:' + inp.application_id + ':' + abs.topic);
  const existingGapEv = await pgGet.call(this, `evidence?content_hash=eq.${encodeURIComponent(gapEvHash)}&select=id`);
  if (!existingGapEv.length) {
    await pg.call(this, 'POST', 'evidence', {
      claim_id: gapId, relation: 'context', tier: 'missing', strength: null,
      quote_verbatim: null, source_url: null, raw_signal_id: inp.raw_signal_id, content_hash: gapEvHash,
    }, 'return=minimal');
  }
}

// design.md SS3.1 step 15 -- two-phase full_name resolution: only for a NEWLY created
// founder, and only when the extractor actually found a name.
if (inp.__is_new_founder && inp.__founder_identity && inp.__founder_identity.full_name) {
  await pg.call(this, 'PATCH', `founders?id=eq.${inp.founder_id}`, { full_name: inp.__founder_identity.full_name }, 'return=minimal');
}

// QA finding (2026-07-19): `extraction_mode` answers "what path did we take", `deck.warning`
// answers "should we tell the founder we came up empty" -- the two questions are different,
// and the vision branch can honestly answer "vision" to the first while still deserving
// 'image_only_deck' on the second. This happens whenever every vision-extracted claim fails
// span verification against `__deck_text` (empty on a genuinely image-only PDF, so no vision
// quote can ever be confirmed) -- REQ-004's honesty is already in the database (every founder.*
// topic lands as a `missing` claim, exactly as it should), but before this fix the response
// contract still said `warning: null`, so the founder's screen never rendered the honest
// notice lovable-brief.md SS9.3 requires. Scoped to the vision branch only: a text_layer deck
// that genuinely says nothing about the five founder topics is a different, correct outcome
// ("we read it fine, it just doesn't mention this") and must not trip this warning.
let finalWarning = inp.deck_warning;
if (inp.extraction_mode === 'vision' && presentTopics.size === 0 && finalWarning === null) {
  finalWarning = 'image_only_deck';
}

return [{ json: { ...inp, deck_warning: finalWarning, ai_run_id: aiRunId, hallucination_flags: hallucinationFlags } }];
""" % {"LUNA": json.dumps(MODEL_LUNA), "TERRA": json.dumps(MODEL_TERRA), "ABSENCE_TOPICS": json.dumps(ABSENCE_TOPICS)},
        X0 + 4560, 0, on_error=True)
    nodes.append(write_claims)

    # ---- f07-thesis-gate (design.md SS3.3 / SS7 -- 08 never reads the response) ----
    prep_gate = code_node(
        "Prepare thesis gate call",
        r"""return [{ json: { ...$json, mode: 'full', text: $json.__deck_text || '' } }];""",
        X0 + 4800, 0)
    call_gate = execute_workflow_node("Call f07-thesis-gate", F07_THESIS_GATE_ID, X0 + 5040, 0,
                                       notes="08 does not read or act on the response -- it only needs the call to have "
                                             "happened so 07's own company.* claims land before the gap-question-phraser "
                                             "card_context fetch below (n8n-spec.md SS5).")
    call_gate["onError"] = "continueErrorOutput"
    reshape_after_gate = code_node(
        "Reshape after thesis gate",
        r"""const ctx = $('Prepare thesis gate call').first().json; return [{ json: { ...ctx } }];""",
        X0 + 5280, 0)
    nodes += [prep_gate, call_gate, reshape_after_gate]

    # ---- gap selection + card_completeness (design.md SS6/SS6.1, gaps.js + completeness.js) ----
    fetch_criteria = code_node(
        "Fetch score_formulas + current claims",
        PG_HELPER_JS + r"""
const inp = $json;
const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
const claims = await pgGet.call(this, `claims?card_id=eq.${inp.card_id}&select=id,topic,verification_status,text_verbatim`);
return [{ json: { ...inp, __criteria: criteria, __current_claims: claims } }];
""", X0 + 5520, 0, on_error=True)
    select_gaps = code_node(
        "Select gap criteria + write completeness",
        GAPS_JS + completeness_unique_js() + PG_HELPER_JS + r"""
const inp = $json;
const selected = selectGapCriteria({ criteria: inp.__criteria, claims: inp.__current_claims, cap: 3 });
const completeness = cardCompleteness({ criteria: inp.__criteria, claims: inp.__current_claims });
await pg.call(this, 'PATCH', `cards?id=eq.${inp.card_id}`, { completeness }, 'return=minimal');
return [{ json: { ...inp, __selected_criteria: selected, card_completeness: completeness } }];
""", X0 + 5760, 0, on_error=True)
    nodes += [fetch_criteria, select_gaps]

    if_any_gaps = if_node("IF: any gap criteria?", "={{ $json.__selected_criteria.length }}", 0,
                          "number", "gt", X0 + 6000, 0)
    nodes.append(if_any_gaps)

    no_gaps = code_node("No gap criteria", r"""return [{ json: { ...$json, __gap_questions: [] } }];""",
                        X0 + 6240, 300)
    nodes.append(no_gaps)

    # ---- gap-question-phraser (design.md SS6/SS7, agents/gap-question-phraser) ----
    build_card_context = code_node(
        "Build card_context",
        PG_HELPER_JS + r"""
const inp = $json;
const companyCards = await pgGet.call(this,
  `cards?application_id=eq.${inp.application_id}&card_type=eq.company&select=id&order=created_at.asc&limit=1`);
let whatIsBuilt = null, sector = null, geographyCountry = null;
if (companyCards.length) {
  const rows = await pgGet.call(this,
    `claims?card_id=eq.${companyCards[0].id}&topic=in.(company.what_is_built,company.sector,company.geography_country)&select=topic,value&order=created_at.desc`);
  for (const r of rows) {
    if (r.topic === 'company.what_is_built' && whatIsBuilt === null) whatIsBuilt = r.value;
    if (r.topic === 'company.sector' && sector === null) sector = r.value;
    if (r.topic === 'company.geography_country' && geographyCountry === null) geographyCountry = r.value;
  }
}
const knownClaims = (inp.__current_claims || [])
  .filter(c => c.verification_status !== 'missing')
  .slice(0, 8)
  .map(c => ({ topic: c.topic, text_verbatim: c.text_verbatim || null }));
const cardContext = {
  company_name: inp.company_name,
  what_is_built: whatIsBuilt, sector, geography_country: geographyCountry,
  deck_readable: inp.extraction_mode !== 'none',
  public_footprint: (inp.artifact_links || []).map(a => ({ kind: a.kind, url: a.url })),
  known_claims: knownClaims,
};
const selectedCriteriaInput = inp.__selected_criteria.map(c => ({ criterion_id: c.id, anchor: c.anchor, weight: c.weight }));
return [{ json: { ...inp, __card_context: cardContext, __selected_criteria_input: selectedCriteriaInput } }];
""", X0 + 6240, -180, on_error=True)
    nodes.append(build_card_context)

    phraser_req_js = build_openai_request_body_js(
        sys_prompt=GAP_PHRASER_SYS, schema=GAP_PHRASER_SCHEMA, schema_name='gap_question_phraser_output',
        model=MODEL_TERRA,
        user_expr_js=(
            "'<card_context>\\n' + JSON.stringify($json.__card_context) + '\\n</card_context>\\n\\n' +\n"
            "  '<selected_criteria>\\n' + JSON.stringify($json.__selected_criteria_input) + '\\n</selected_criteria>'"
        ),
    )
    build_phraser_req = code_node("Build gap-question-phraser request", phraser_req_js, X0 + 6480, -180)
    openai_phraser = openai_node("OpenAI: gap-question-phraser (terra)", X0 + 6720, -180, timeout=30000)
    nodes += [build_phraser_req, openai_phraser]

    fallback_json = json.dumps(GAP_FALLBACK_QUESTIONS)
    parse_phraser = code_node(
        "Parse + validate gap-question-phraser response",
        PG_HELPER_JS + HASHING_JS + r"""
const ctx = $('Build gap-question-phraser request').first().json;
const resp = $input.first().json;
let parsed = null, rawText = '';
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  rawText = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  parsed = JSON.parse(rawText);
} catch (e) { parsed = null; }

const FORBIDDEN_STEMS = ['interview', 'assess', 'evaluat', 'screening', 'screen', ' test', 'vetting',
  'candidate', 'applicant', 'your score', 'ranking'];
const FALLBACK = %(FALLBACK)s;
const selected = ctx.__selected_criteria_input || [];

function violates(q) {
  if (!q || typeof q.question !== 'string' || typeof q.why !== 'string' || typeof q.placeholder !== 'string') return true;
  const all = (q.question + ' ' + q.why + ' ' + q.placeholder).toLowerCase();
  if (FORBIDDEN_STEMS.some(stem => all.includes(stem))) return true;
  if (q.question.length > 140 || q.why.length > 120 || q.placeholder.length > 120) return true;
  const qMarks = (q.question.match(/\?/g) || []).length;
  if (qMarks !== 1) return true;
  return false;
}

// GAP_PHRASER_SCHEMA wraps the array under a "questions" key (schema-object-root
// requirement -- see the GAP_PHRASER_SCHEMA assignment for why this differs from the
// agent's own OUTPUT FORMAT prose, which describes a bare array).
const items = (parsed && Array.isArray(parsed.questions)) ? parsed.questions : [];
const byId = new Map();
for (const it of items) { if (it && it.criterion_id) byId.set(it.criterion_id, it); }

const gapQuestions = selected.map(sc => {
  const candidate = byId.get(sc.criterion_id);
  if (candidate && !violates(candidate)) {
    return { criterion_id: sc.criterion_id, question: candidate.question, why: candidate.why, placeholder: candidate.placeholder };
  }
  const fb = FALLBACK[sc.criterion_id] || {
    question: 'Tell us more about this.', why: 'We could not find this publicly.', placeholder: 'A few sentences is enough.',
  };
  return { criterion_id: sc.criterion_id, question: fb.question, why: fb.why, placeholder: fb.placeholder };
});

const inputHash = sha256Hex('f08:ai_run:question_generation:' + ctx.application_id + ':' + selected.map(s => s.criterion_id).join(','));
const found = await pgGet.call(this, `ai_runs?input_hash=eq.${encodeURIComponent(inputHash)}&select=id`);
if (!found.length) {
  await pg.call(this, 'POST', 'ai_runs', {
    task_type: 'question_generation', founder_id: ctx.founder_id, company_id: ctx.company_id, application_id: ctx.application_id,
    model: %(TERRA)s, input_hash: inputHash, output_json: { selected_criteria: selected, questions: gapQuestions },
  }, 'return=minimal');
}
return [{ json: { ...ctx, __gap_questions: gapQuestions } }];
""" % {"FALLBACK": fallback_json, "TERRA": json.dumps(MODEL_TERRA)},
        X0 + 6960, -180, on_error=False)
    nodes.append(parse_phraser)

    handle_phraser_failure = code_node(
        "Handle gap-phraser failure",
        r"""
const ctx = $('Build gap-question-phraser request').first().json;
const selected = ctx.__selected_criteria_input || [];
const FALLBACK = %(FALLBACK)s;
const gapQuestions = selected.map(sc => {
  const fb = FALLBACK[sc.criterion_id] || {
    question: 'Tell us more about this.', why: 'We could not find this publicly.', placeholder: 'A few sentences is enough.',
  };
  return { criterion_id: sc.criterion_id, question: fb.question, why: fb.why, placeholder: fb.placeholder };
});
return [{ json: { ...ctx, __gap_questions: gapQuestions } }];
""" % {"FALLBACK": fallback_json}, X0 + 6960, 60)
    nodes.append(handle_phraser_failure)
    # wire the openai node's own error output here instead of the generic 500 handler --
    # gap-question-phraser-agent-input-spec.md's own D-4: a dropped question forfeits real
    # score weight, so a static fallback beats surfacing an infra error to the founder.
    openai_phraser["onError"] = "continueErrorOutput"

    # ---- interviews + status + events + deck-meta cache (design.md SS8, SS2 step 8) ----
    write_interviews = code_node(
        "Write interviews (kind='first')",
        PG_HELPER_JS + r"""
const inp = $json;
const questions = (inp.__gap_questions || []).map(q => ({
  criterion_id: q.criterion_id, question: q.question, why: q.why, placeholder: q.placeholder,
  status: 'pending', answer_text: null,
}));
await pg.call(this, 'POST', 'interviews', {
  application_id: inp.application_id, card_id: inp.card_id, kind: 'first', status: 'pending',
  transcript: { questions }, disclosed_at: new Date().toISOString(),
}, 'return=minimal');
return [{ json: inp }];
""", X0 + 7200, 0, on_error=True)
    finalize_application = code_node(
        "Update status, events, deck-meta cache",
        PG_HELPER_JS + r"""
const inp = $json;
const mergedArtifactLinks = { ...(inp.__artifact_links || {}), _f08_deck_meta: {
  extraction_mode: inp.extraction_mode, pages: inp.pages || 0, chars_extracted: inp.chars_extracted || 0,
  warning: inp.deck_warning || null,
} };
await pg.call(this, 'PATCH', `applications?id=eq.${inp.application_id}`, {
  status: 'screening', artifact_links: mergedArtifactLinks,
}, 'return=minimal');
await pg.call(this, 'POST', 'events', {
  event_type: 'application_submitted', entity_type: 'founder', entity_id: inp.founder_id,
  payload: { application_id: inp.application_id }, actor: 'f08-intake-submit',
}, 'return=minimal');
return [{ json: inp }];
""", X0 + 7440, 0, on_error=True)
    nodes += [write_interviews, finalize_application]

    build_response = code_node(
        "Build IntakeResponse",
        r"""
const inp = $json;
return [{ json: {
  application_id: inp.application_id, company_id: inp.company_id, founder_id: inp.founder_id,
  status: 'screening',
  deck: { extraction_mode: inp.extraction_mode, pages: inp.pages || 0, chars_extracted: inp.chars_extracted || 0,
          warning: inp.deck_warning || null },
  extra_files_stored: (inp.extra_file_paths || []).length,
  gap_questions: inp.__gap_questions || [],
  estimated_minutes: %(EST)s, verdict_eta_hours: %(ETA)s,
} }];
""" % {"EST": ESTIMATED_MINUTES, "ETA": VERDICT_ETA_HOURS}, X0 + 7680, 0)
    respond_success = respond_node("Respond: success", 200, X0 + 7920, 0)
    nodes += [build_response, respond_success]

    # ---- fire-and-forget rescore (design.md SS9.2 T20 -- wired AFTER the respond node) ----
    build_rescore_input = code_node(
        "Build rescore input", r"""return [{ json: { founder_id: $json.founder_id } }];""", X0 + 8160, 0)
    trigger_rescore = execute_workflow_node("Trigger f03-score-founder rescore", F03_SCORE_FOUNDER_ID, X0 + 8400, 0)
    write_rescore_event = code_node(
        "Write events (rescore_triggered)",
        PG_HELPER_JS + r"""
const inp = $('Build rescore input').first().json;
await pg.call(this, 'POST', 'events', {
  event_type: 'rescore_triggered', entity_type: 'founder', entity_id: inp.founder_id, payload: {}, actor: 'f08-intake-submit',
}, 'return=minimal');
return [{ json: {} }];
""", X0 + 8640, 0)
    nodes += [build_rescore_input, trigger_rescore, write_rescore_event]

    conns = merge_connections(
        connect(
            ("Webhook: f08-intake-submit", 0, "Validate input", 0),
            ("Validate input", 0, "IF: valid?", 0),
        ),
        {"IF: valid?": {"main": [
            [{"node": "Idempotency check", "type": "main", "index": 0}],
            [{"node": "Build validation error response", "type": "main", "index": 0}],
        ]}},
        connect(("Build validation error response", 0, "IF: deck_too_large?", 0)),
        {"IF: deck_too_large?": {"main": [
            [{"node": "Respond: deck too large (413)", "type": "main", "index": 0}],
            [{"node": "Respond: bad request (400)", "type": "main", "index": 0}],
        ]}},
        {"IF: application exists?": {"main": [
            [{"node": "Build replay response", "type": "main", "index": 0}],
            [{"node": "Rate limit check", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Idempotency check", 0, "IF: application exists?", 0),
            ("Build replay response", 0, "Respond: success (replay)", 0),
            ("Rate limit check", 0, "IF: rate limited?", 0),
        ),
        {"IF: rate limited?": {"main": [
            [{"node": "Set rate_limited error", "type": "main", "index": 0}],
            [{"node": "Upload deck + extra files to Storage", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Set rate_limited error", 0, "Respond: rate limited (429)", 0),
            ("Handle unexpected error", 0, "Respond: internal error (500)", 0),
            ("Upload deck + extra files to Storage", 0, "Resolve or create entities", 0),
            ("Resolve or create entities", 0, "Insert applications + cards", 0),
            ("Insert applications + cards", 0, "Write raw_signals (deck_parse)", 0),
            ("Write raw_signals (deck_parse)", 0, "Convert to File", 0),
            ("Convert to File", 0, "Extract From File", 0),
            ("Extract From File", 0, "Compute chars_extracted", 0),
            ("Compute chars_extracted", 0, "IF: text layer sufficient?", 0),
        ),
        {"IF: text layer sufficient?": {"main": [
            [{"node": "Build extractor request (text_layer)", "type": "main", "index": 0}],
            [{"node": "Build extractor request (vision)", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build extractor request (text_layer)", 0, "OpenAI: deck-claims-extractor (luna, text_layer)", 0),
            ("OpenAI: deck-claims-extractor (luna, text_layer)", 0, "Parse extractor response (text_layer)", 0),
            ("Build extractor request (vision)", 0, "OpenAI: deck-claims-extractor (terra, vision)", 0),
            ("OpenAI: deck-claims-extractor (terra, vision)", 0, "Parse extractor response (vision)", 0),
        ),
        # exclusive-branch fan-in into the single claims writer -- no Merge node needed
        # (n8n-spec.md SS0: only genuine PARALLEL fan-out needs one).
        connect(
            ("Parse extractor response (text_layer)", 0, "Write founder claims + evidence", 0),
            ("Parse extractor response (vision)", 0, "Write founder claims + evidence", 0),
            ("Handle extractor call failure", 0, "Write founder claims + evidence", 0),
            ("Handle deck read failure", 0, "Write founder claims + evidence", 0),
            ("Write founder claims + evidence", 0, "Prepare thesis gate call", 0),
            ("Prepare thesis gate call", 0, "Call f07-thesis-gate", 0),
            ("Call f07-thesis-gate", 0, "Reshape after thesis gate", 0),
            ("Reshape after thesis gate", 0, "Fetch score_formulas + current claims", 0),
            ("Fetch score_formulas + current claims", 0, "Select gap criteria + write completeness", 0),
            ("Select gap criteria + write completeness", 0, "IF: any gap criteria?", 0),
        ),
        {"IF: any gap criteria?": {"main": [
            [{"node": "Build card_context", "type": "main", "index": 0}],
            [{"node": "No gap criteria", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build card_context", 0, "Build gap-question-phraser request", 0),
            ("Build gap-question-phraser request", 0, "OpenAI: gap-question-phraser (terra)", 0),
            ("OpenAI: gap-question-phraser (terra)", 0, "Parse + validate gap-question-phraser response", 0),
        ),
        connect(
            ("No gap criteria", 0, "Write interviews (kind='first')", 0),
            ("Parse + validate gap-question-phraser response", 0, "Write interviews (kind='first')", 0),
            ("Handle gap-phraser failure", 0, "Write interviews (kind='first')", 0),
            ("Write interviews (kind='first')", 0, "Update status, events, deck-meta cache", 0),
            ("Update status, events, deck-meta cache", 0, "Build IntakeResponse", 0),
            ("Build IntakeResponse", 0, "Respond: success", 0),
            ("Respond: success", 0, "Build rescore input", 0),
            ("Build rescore input", 0, "Trigger f03-score-founder rescore", 0),
            ("Trigger f03-score-founder rescore", 0, "Write events (rescore_triggered)", 0),
        ),
        # error-output fan-in (SS0.3.1) -- every risky node's index-1 output -> shared handler.
        error_out("Idempotency check", "Handle unexpected error"),
        error_out("Build replay response", "Handle unexpected error"),
        error_out("Upload deck + extra files to Storage", "Handle unexpected error"),
        error_out("Resolve or create entities", "Handle unexpected error"),
        error_out("Insert applications + cards", "Handle unexpected error"),
        error_out("Write raw_signals (deck_parse)", "Handle unexpected error"),
        error_out("Write founder claims + evidence", "Handle unexpected error"),
        error_out("Call f07-thesis-gate", "Handle unexpected error"),
        error_out("Fetch score_formulas + current claims", "Handle unexpected error"),
        error_out("Select gap criteria + write completeness", "Handle unexpected error"),
        error_out("Build card_context", "Handle unexpected error"),
        error_out("Write interviews (kind='first')", "Handle unexpected error"),
        error_out("Update status, events, deck-meta cache", "Handle unexpected error"),
        error_out("Convert to File", "Handle deck read failure"),
        error_out("Extract From File", "Handle deck read failure"),
        error_out("OpenAI: deck-claims-extractor (luna, text_layer)", "Handle extractor call failure"),
        error_out("OpenAI: deck-claims-extractor (terra, vision)", "Handle extractor call failure"),
        error_out("OpenAI: gap-question-phraser (terra)", "Handle gap-phraser failure"),
    )

    return {
        "name": "f08-intake-submit", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# f08-gap-answers (n8n-spec.md SS9) -- the feature's headline claim: answering the gap
# questions writes founder.* claims that close L2/L3/X5 and triggers a founder-score rescore.
# ============================================================================

def build_gap_answers():
    nodes = []
    X0 = -1600

    webhook = webhook_node("Webhook: f08-gap-answers", "f08-gap-answers", "POST", X0, 0)
    validate = code_node(
        "Validate input",
        r"""
const item = $input.first().json;
const body = item.body || {};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const applicationId = String(body.application_id || '').trim();
if (!applicationId || !UUID_RE.test(applicationId)) {
  return [{ json: { __valid: false, error: { code: 'invalid_input', message: 'application_id must be a uuid.' } } }];
}
const answersIn = Array.isArray(body.answers) ? body.answers : [];
const answers = [];
for (const a of answersIn) {
  if (!a || typeof a !== 'object') continue;
  const criterionId = String(a.criterion_id || '').trim();
  const answerText = typeof a.answer_text === 'string' ? a.answer_text : '';
  if (!criterionId || !answerText.trim()) continue; // blank/malformed -- treated as not-answered, never an error
  answers.push({ criterion_id: criterionId, question: String(a.question || ''), answer_text: answerText });
}
const skippedIn = Array.isArray(body.skipped_criterion_ids) ? body.skipped_criterion_ids : [];
const skipped = skippedIn.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
return [{ json: { __valid: true, application_id: applicationId, answers, skipped_criterion_ids: skipped } }];
""", X0 + 240, 0)
    if_valid = if_node("IF: valid?", "={{ $json.__valid }}", True, "boolean", "equals", X0 + 480, 0)
    build_client_err = code_node("Build client error response",
                                  r"""return [{ json: { error: $json.error } }];""", X0 + 720, 300)
    respond_400 = respond_node("Respond: bad request (400)", 400, X0 + 960, 300)
    nodes += [webhook, validate, if_valid, build_client_err, respond_400]

    fetch_app = code_node(
        "Fetch application + first interview",
        PG_HELPER_JS + r"""
const inp = $json;
const apps = await pgGet.call(this, `applications?id=eq.${inp.application_id}&select=id,status&order=created_at.asc&limit=1`);
if (!apps.length) return [{ json: { ...inp, __found: false } }];
const cards = await pgGet.call(this,
  `cards?application_id=eq.${inp.application_id}&card_type=eq.founder&select=id,founder_id,company_id&order=created_at.asc&limit=1`);
const card = cards.length ? cards[0] : null;
const interviews = await pgGet.call(this,
  `interviews?application_id=eq.${inp.application_id}&kind=eq.first&select=id,status,transcript&order=created_at.asc&limit=1`);
const interview = interviews.length ? interviews[0] : null;
return [{ json: { ...inp, __found: true, status: apps[0].status,
  card_id: card ? card.id : null, founder_id: card ? card.founder_id : null, company_id: card ? card.company_id : null,
  __interview: interview, __interview_completed: !!(interview && interview.status === 'completed') } }];
""", X0 + 720, 0, on_error=True)
    if_found = if_node("IF: application found?", "={{ $json.__found }}", True, "boolean", "equals", X0 + 960, 0)
    build_not_found = code_node(
        "Build not-found response",
        r"""return [{ json: { error: { code: 'not_found', message: 'Application not found.' } } }];""",
        X0 + 1200, 480)
    respond_404 = respond_node("Respond: not found (404)", 404, X0 + 1440, 480)
    nodes += [fetch_app, if_found, build_not_found, respond_404]

    if_completed = if_node("IF: interview already completed?", "={{ $json.__interview_completed }}", True,
                            "boolean", "equals", X0 + 1200, 0)
    replay = code_node(
        "Build replay response",
        COMPLETENESS_JS + PG_HELPER_JS + r"""
const inp = $json;
const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
const claims = await pgGet.call(this, `claims?card_id=eq.${inp.card_id}&select=id,topic,verification_status`);
const completeness = cardCompleteness({ criteria, claims });
const questions = (inp.__interview.transcript && inp.__interview.transcript.questions) || [];
const accepted = questions.filter(q => q.status === 'answered').length;
const skippedCount = questions.filter(q => q.status === 'skipped').length;
return [{ json: { accepted, skipped: skippedCount, card_completeness: completeness, status: inp.status,
  verdict_eta_hours: %(ETA)s } }];
""" % {"ETA": VERDICT_ETA_HOURS}, X0 + 1440, -240, on_error=True)
    respond_replay = respond_node("Respond: success (replay)", 200, X0 + 1680, -240)
    nodes += [if_completed, replay, respond_replay]

    write_answers = code_node(
        "Write answer claims + evidence + raw_signals",
        PG_HELPER_JS + HASHING_JS + GAPS_JS + r"""
const inp = $json;
for (const a of inp.answers) {
  const topic = CRITERION_TOPIC[a.criterion_id];
  if (!topic) continue; // unknown criterion id -- defensively skip rather than throw
  const rsHash = contentHash.rawSignal({ application_id: inp.application_id, source: 'interview_answer',
    content_key: a.criterion_id + ':answer' });
  const existingRs = await pgGet.call(this, `raw_signals?content_hash=eq.${encodeURIComponent(rsHash)}&select=id`);
  let rawSignalId;
  if (existingRs.length) {
    rawSignalId = existingRs[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'raw_signals', {
      source: 'interview_answer', source_url: null,
      payload: { criterion_id: a.criterion_id, question: a.question, answer_text: a.answer_text },
      content_hash: rsHash, founder_id: inp.founder_id, company_id: inp.company_id, observed_at: new Date().toISOString(),
    }, 'return=representation');
    rawSignalId = made[0].id;
  }
  const claimHash = contentHash.claim({ application_id: inp.application_id, card_id: inp.card_id, topic, item_key: 'interview' });
  const existingClaim = await pgGet.call(this, `claims?content_hash=eq.${encodeURIComponent(claimHash)}&select=id`);
  let claimId;
  if (existingClaim.length) {
    claimId = existingClaim[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'claims', {
      card_id: inp.card_id, topic, text_verbatim: a.answer_text, value: null, axis: null,
      source_kind: 'interview', base_confidence: %(BCI)s, verification_status: 'unverified', content_hash: claimHash,
    }, 'return=representation');
    claimId = made[0].id;
  }
  const evHash = contentHash.evidence({ application_id: inp.application_id, claim_id: claimId, relation: 'supports', raw_signal_id: rawSignalId });
  const existingEv = await pgGet.call(this, `evidence?content_hash=eq.${encodeURIComponent(evHash)}&select=id`);
  if (!existingEv.length) {
    await pg.call(this, 'POST', 'evidence', {
      claim_id: claimId, relation: 'supports', tier: 'discovered', strength: null,
      quote_verbatim: a.answer_text, source_url: null, raw_signal_id: rawSignalId, content_hash: evHash,
    }, 'return=minimal');
  }
}
return [{ json: inp }];
""" % {"BCI": BASE_CONFIDENCE_INTERVIEW}, X0 + 1440, 120, on_error=True)
    mark_completed = code_node(
        "Mark interview completed",
        PG_HELPER_JS + r"""
const inp = $json;
const answeredIds = new Set(inp.answers.map(a => a.criterion_id));
const skippedIds = new Set(inp.skipped_criterion_ids);
const transcript = inp.__interview.transcript || { questions: [] };
const questions = (transcript.questions || []).map(q => {
  if (answeredIds.has(q.criterion_id)) {
    const a = inp.answers.find(x => x.criterion_id === q.criterion_id);
    return { ...q, status: 'answered', answer_text: a.answer_text };
  }
  if (skippedIds.has(q.criterion_id)) return { ...q, status: 'skipped' };
  return q; // neither answered nor explicitly skipped -- left pending
});
await pg.call(this, 'PATCH', `interviews?id=eq.${inp.__interview.id}`, {
  status: 'completed', transcript: { questions }, completed_at: new Date().toISOString(),
}, 'return=minimal');
return [{ json: inp }];
""", X0 + 1680, 120, on_error=True)
    finalize = code_node(
        "Recompute completeness + write events",
        COMPLETENESS_JS + PG_HELPER_JS + r"""
const inp = $json;
const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
const claims = await pgGet.call(this, `claims?card_id=eq.${inp.card_id}&select=id,topic,verification_status`);
const completeness = cardCompleteness({ criteria, claims });
await pg.call(this, 'PATCH', `cards?id=eq.${inp.card_id}`, { completeness }, 'return=minimal');
await pg.call(this, 'POST', 'events', {
  event_type: 'gap_answers_submitted', entity_type: 'founder', entity_id: inp.founder_id,
  payload: { application_id: inp.application_id, accepted: inp.answers.length, skipped: inp.skipped_criterion_ids.length },
  actor: 'f08-gap-answers',
}, 'return=minimal');
return [{ json: { founder_id: inp.founder_id, accepted: inp.answers.length, skipped: inp.skipped_criterion_ids.length,
  card_completeness: completeness, status: inp.status, verdict_eta_hours: %(ETA)s } }];
""" % {"ETA": VERDICT_ETA_HOURS}, X0 + 1920, 120, on_error=True)
    nodes += [write_answers, mark_completed, finalize]

    build_response = code_node(
        "Build GapAnswersResponse",
        r"""
const inp = $json;
return [{ json: { accepted: inp.accepted, skipped: inp.skipped, card_completeness: inp.card_completeness,
  status: inp.status, verdict_eta_hours: inp.verdict_eta_hours } }];
""", X0 + 2160, 120)
    respond_success = respond_node("Respond: success", 200, X0 + 2400, 120)
    nodes += [build_response, respond_success]

    handle_unexpected_error = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, X0 + 1440, 600)
    respond_500 = respond_node("Respond: internal error (500)", 500, X0 + 1680, 600)
    nodes += [handle_unexpected_error, respond_500]

    # ---- fire-and-forget rescore (n8n-spec.md SS9.2 T20) -- wired AFTER Respond: success ----
    build_rescore_input = code_node(
        "Build rescore input",
        r"""const ctx = $('Recompute completeness + write events').first().json; return [{ json: { founder_id: ctx.founder_id } }];""",
        X0 + 2640, 120)
    trigger_rescore = execute_workflow_node("Trigger f03-score-founder rescore", F03_SCORE_FOUNDER_ID, X0 + 2880, 120)
    write_rescore_event = code_node(
        "Write events (rescore_triggered)",
        PG_HELPER_JS + r"""
const inp = $('Build rescore input').first().json;
await pg.call(this, 'POST', 'events', {
  event_type: 'rescore_triggered', entity_type: 'founder', entity_id: inp.founder_id, payload: {}, actor: 'f08-gap-answers',
}, 'return=minimal');
return [{ json: {} }];
""", X0 + 3120, 120)
    nodes += [build_rescore_input, trigger_rescore, write_rescore_event]

    conns = merge_connections(
        connect(
            ("Webhook: f08-gap-answers", 0, "Validate input", 0),
            ("Validate input", 0, "IF: valid?", 0),
        ),
        {"IF: valid?": {"main": [
            [{"node": "Fetch application + first interview", "type": "main", "index": 0}],
            [{"node": "Build client error response", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build client error response", 0, "Respond: bad request (400)", 0),
            ("Fetch application + first interview", 0, "IF: application found?", 0),
        ),
        {"IF: application found?": {"main": [
            [{"node": "IF: interview already completed?", "type": "main", "index": 0}],
            [{"node": "Build not-found response", "type": "main", "index": 0}],
        ]}},
        connect(("Build not-found response", 0, "Respond: not found (404)", 0)),
        {"IF: interview already completed?": {"main": [
            [{"node": "Build replay response", "type": "main", "index": 0}],
            [{"node": "Write answer claims + evidence + raw_signals", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build replay response", 0, "Respond: success (replay)", 0),
            ("Write answer claims + evidence + raw_signals", 0, "Mark interview completed", 0),
            ("Mark interview completed", 0, "Recompute completeness + write events", 0),
            ("Recompute completeness + write events", 0, "Build GapAnswersResponse", 0),
            ("Build GapAnswersResponse", 0, "Respond: success", 0),
            ("Respond: success", 0, "Build rescore input", 0),
            ("Build rescore input", 0, "Trigger f03-score-founder rescore", 0),
            ("Trigger f03-score-founder rescore", 0, "Write events (rescore_triggered)", 0),
            ("Handle unexpected error", 0, "Respond: internal error (500)", 0),
        ),
        error_out("Fetch application + first interview", "Handle unexpected error"),
        error_out("Build replay response", "Handle unexpected error"),
        error_out("Write answer claims + evidence + raw_signals", "Handle unexpected error"),
        error_out("Mark interview completed", "Handle unexpected error"),
        error_out("Recompute completeness + write events", "Handle unexpected error"),
    )

    return {
        "name": "f08-gap-answers", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# f08-application-status (GET) -- n8n-spec.md SS11. Renders /apply/status after a page
# refresh; its own card_completeness is recomputed fresh, never trusted stale, per the same
# discipline as every other completeness read in this feature.
# ============================================================================

def build_application_status():
    nodes = []
    X0 = -1200

    webhook = webhook_node("Webhook: f08-application-status", "f08-application-status", "GET", X0, 0)
    validate = code_node(
        "Validate query",
        r"""
const item = $input.first().json;
const query = item.query || {};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const applicationId = String(query.application_id || '').trim();
if (!applicationId || !UUID_RE.test(applicationId)) {
  return [{ json: { __valid: false, error: { code: 'invalid_input', message: 'application_id must be a uuid.' } } }];
}
return [{ json: { __valid: true, application_id: applicationId } }];
""", X0 + 240, 0)
    if_valid = if_node("IF: valid?", "={{ $json.__valid }}", True, "boolean", "equals", X0 + 480, 0)
    build_client_err = code_node("Build client error response",
                                  r"""return [{ json: { error: $json.error } }];""", X0 + 720, 300)
    respond_400 = respond_node("Respond: bad request (400)", 400, X0 + 960, 300)
    nodes += [webhook, validate, if_valid, build_client_err, respond_400]

    fetch = code_node(
        "Fetch application + company + card + interview",
        PG_HELPER_JS + r"""
const inp = $json;
const apps = await pgGet.call(this,
  `applications?id=eq.${inp.application_id}&select=id,status,created_at,company_id&order=created_at.asc&limit=1`);
if (!apps.length) return [{ json: { ...inp, __found: false } }];
const app = apps[0];
const companies = await pgGet.call(this, `companies?id=eq.${app.company_id}&select=name&limit=1`);
const cards = await pgGet.call(this,
  `cards?application_id=eq.${inp.application_id}&card_type=eq.founder&select=id,completeness&order=created_at.asc&limit=1`);
const card = cards.length ? cards[0] : null;
const interviews = await pgGet.call(this,
  `interviews?application_id=eq.${inp.application_id}&kind=eq.first&select=status,transcript&order=created_at.asc&limit=1`);
const interview = interviews.length ? interviews[0] : null;
return [{ json: { ...inp, __found: true, status: app.status, submitted_at: app.created_at,
  company_name: companies.length ? companies[0].name : null, card_id: card ? card.id : null, __interview: interview } }];
""", X0 + 720, 0, on_error=True)
    if_found = if_node("IF: found?", "={{ $json.__found }}", True, "boolean", "equals", X0 + 960, 0)
    build_not_found = code_node(
        "Build not-found response",
        r"""return [{ json: { error: { code: 'not_found', message: 'Application not found.' } } }];""",
        X0 + 1200, 300)
    respond_404 = respond_node("Respond: not found (404)", 404, X0 + 1440, 300)
    nodes += [fetch, if_found, build_not_found, respond_404]

    build_status = code_node(
        "Compute open_questions + fresh completeness",
        COMPLETENESS_JS + PG_HELPER_JS + r"""
const inp = $json;
let openQuestions = 0;
if (inp.__interview && inp.__interview.status !== 'completed') {
  const qs = (inp.__interview.transcript && inp.__interview.transcript.questions) || [];
  openQuestions = qs.filter(q => q.status === 'pending').length;
}
let completeness = 0;
if (inp.card_id) {
  const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
  const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
  const claims = await pgGet.call(this, `claims?card_id=eq.${inp.card_id}&select=id,topic,verification_status`);
  completeness = cardCompleteness({ criteria, claims });
}
return [{ json: {
  application_id: inp.application_id, company_name: inp.company_name, status: inp.status,
  submitted_at: inp.submitted_at, verdict_eta_hours: %(ETA)s, card_completeness: completeness, open_questions: openQuestions,
} }];
""" % {"ETA": VERDICT_ETA_HOURS}, X0 + 1200, 0, on_error=True)
    respond_success = respond_node("Respond: success", 200, X0 + 1440, 0)
    nodes += [build_status, respond_success]

    handle_unexpected_error = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, X0 + 1200, 600)
    respond_500 = respond_node("Respond: internal error (500)", 500, X0 + 1440, 600)
    nodes += [handle_unexpected_error, respond_500]

    conns = merge_connections(
        connect(
            ("Webhook: f08-application-status", 0, "Validate query", 0),
            ("Validate query", 0, "IF: valid?", 0),
        ),
        {"IF: valid?": {"main": [
            [{"node": "Fetch application + company + card + interview", "type": "main", "index": 0}],
            [{"node": "Build client error response", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build client error response", 0, "Respond: bad request (400)", 0),
            ("Fetch application + company + card + interview", 0, "IF: found?", 0),
        ),
        {"IF: found?": {"main": [
            [{"node": "Compute open_questions + fresh completeness", "type": "main", "index": 0}],
            [{"node": "Build not-found response", "type": "main", "index": 0}],
        ]}},
        connect(("Build not-found response", 0, "Respond: not found (404)", 0)),
        connect(
            ("Compute open_questions + fresh completeness", 0, "Respond: success", 0),
            ("Handle unexpected error", 0, "Respond: internal error (500)", 0),
        ),
        error_out("Fetch application + company + card + interview", "Handle unexpected error"),
        error_out("Compute open_questions + fresh completeness", "Handle unexpected error"),
    )

    return {
        "name": "f08-application-status", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# f08-followup-create (n8n-spec.md SS10.3, plan.md T19) -- lowest priority of the five, and
# the one the team lead's brief sanctions cutting first. Not a frozen lovable-brief.md
# contract (that document only specifies the founder-facing GET/POST pair below) -- this is
# the minimal manager-side token producer feature 09's real dashboard will eventually call;
# built here only so f08-followup / f08-followup-answers have a real row to exercise against
# rather than a hand-inserted fixture. Input/response shapes are this workflow's own
# reasonable design, not transcribed from any frozen document.
# ============================================================================

def build_followup_create():
    nodes = []
    X0 = -1400

    webhook = webhook_node("Webhook: f08-followup-create", "f08-followup-create", "POST", X0, 0)
    validate = code_node(
        "Validate input",
        r"""
const item = $input.first().json;
const body = item.body || {};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const applicationId = String(body.application_id || '').trim();
if (!applicationId || !UUID_RE.test(applicationId)) {
  return [{ json: { __valid: false, error: { code: 'invalid_input', message: 'application_id must be a uuid.' } } }];
}
const askedBy = typeof body.asked_by === 'string' && body.asked_by.trim()
  ? body.asked_by.trim() : 'The investor reviewing your application';
const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
return [{ json: { __valid: true, application_id: applicationId, asked_by: askedBy, note } }];
""", X0 + 240, 0)
    if_valid = if_node("IF: valid?", "={{ $json.__valid }}", True, "boolean", "equals", X0 + 480, 0)
    build_client_err = code_node("Build client error response",
                                  r"""return [{ json: { error: $json.error } }];""", X0 + 720, 300)
    respond_400 = respond_node("Respond: bad request (400)", 400, X0 + 960, 300)
    nodes += [webhook, validate, if_valid, build_client_err, respond_400]

    fetch = code_node(
        "Fetch card + criteria + claims",
        PG_HELPER_JS + r"""
const inp = $json;
const cards = await pgGet.call(this,
  `cards?application_id=eq.${inp.application_id}&card_type=eq.founder&select=id,founder_id,company_id&order=created_at.asc&limit=1`);
if (!cards.length) return [{ json: { ...inp, __found: false } }];
const card = cards[0];
const companies = await pgGet.call(this, `applications?id=eq.${inp.application_id}&select=company_id,artifact_links&limit=1`);
const companyRow = companies.length ? companies[0] : null;
const companyName = companyRow ? (await pgGet.call(this, `companies?id=eq.${companyRow.company_id}&select=name&limit=1`))[0]?.name : null;
const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
const claims = await pgGet.call(this, `claims?card_id=eq.${card.id}&select=id,topic,verification_status,text_verbatim`);
return [{ json: { ...inp, __found: true, card_id: card.id, founder_id: card.founder_id, company_id: card.company_id,
  company_name: companyName, __criteria: criteria, __current_claims: claims,
  __artifact_links: (companyRow && companyRow.artifact_links) || {} } }];
""", X0 + 720, 0, on_error=True)
    if_found = if_node("IF: found?", "={{ $json.__found }}", True, "boolean", "equals", X0 + 960, 0)
    build_not_found = code_node("Build not-found response",
                                 r"""return [{ json: { error: { code: 'not_found', message: 'Application not found.' } } }];""",
                                 X0 + 1200, 300)
    respond_404 = respond_node("Respond: not found (404)", 404, X0 + 1440, 300)
    nodes += [fetch, if_found, build_not_found, respond_404]

    select_gaps = code_node(
        "Select gap criteria",
        GAPS_JS + r"""
const inp = $json;
const selected = selectGapCriteria({ criteria: inp.__criteria, claims: inp.__current_claims, cap: 3 });
return [{ json: { ...inp, __selected_criteria: selected } }];
""", X0 + 1200, 0)
    if_any_gaps = if_node("IF: any gap criteria?", "={{ $json.__selected_criteria.length }}", 0,
                          "number", "gt", X0 + 1440, 0)
    no_gaps = code_node("No gap criteria", r"""return [{ json: { ...$json, __gap_questions: [] } }];""",
                        X0 + 1680, 300)
    nodes += [select_gaps, if_any_gaps, no_gaps]

    build_card_context = code_node(
        "Build card_context",
        r"""
const inp = $json;
const links = inp.__artifact_links || {};
const knownClaims = (inp.__current_claims || [])
  .filter(c => c.verification_status !== 'missing')
  .slice(0, 8)
  .map(c => ({ topic: c.topic, text_verbatim: c.text_verbatim || null }));
const cardContext = {
  company_name: inp.company_name, what_is_built: null, sector: null, geography_country: null,
  deck_readable: true, public_footprint: links.founder_links || [], known_claims: knownClaims,
};
const selectedCriteriaInput = inp.__selected_criteria.map(c => ({ criterion_id: c.id, anchor: c.anchor, weight: c.weight }));
return [{ json: { ...inp, __card_context: cardContext, __selected_criteria_input: selectedCriteriaInput } }];
""", X0 + 1680, -180)
    phraser_req_js = build_openai_request_body_js(
        sys_prompt=GAP_PHRASER_SYS, schema=GAP_PHRASER_SCHEMA, schema_name='gap_question_phraser_output',
        model=MODEL_TERRA,
        user_expr_js=(
            "'<card_context>\\n' + JSON.stringify($json.__card_context) + '\\n</card_context>\\n\\n' +\n"
            "  '<selected_criteria>\\n' + JSON.stringify($json.__selected_criteria_input) + '\\n</selected_criteria>'"
        ),
    )
    build_phraser_req = code_node("Build gap-question-phraser request", phraser_req_js, X0 + 1920, -180)
    openai_phraser = openai_node("OpenAI: gap-question-phraser (terra)", X0 + 2160, -180, timeout=30000)
    nodes += [build_card_context, build_phraser_req, openai_phraser]

    fallback_json = json.dumps(GAP_FALLBACK_QUESTIONS)
    parse_phraser = code_node(
        "Parse + validate gap-question-phraser response",
        PG_HELPER_JS + HASHING_JS + r"""
const ctx = $('Build gap-question-phraser request').first().json;
const resp = $input.first().json;
let parsed = null, rawText = '';
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  rawText = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  parsed = JSON.parse(rawText);
} catch (e) { parsed = null; }

const FORBIDDEN_STEMS = ['interview', 'assess', 'evaluat', 'screening', 'screen', ' test', 'vetting',
  'candidate', 'applicant', 'your score', 'ranking'];
const FALLBACK = %(FALLBACK)s;
const selected = ctx.__selected_criteria_input || [];
function violates(q) {
  if (!q || typeof q.question !== 'string' || typeof q.why !== 'string' || typeof q.placeholder !== 'string') return true;
  const all = (q.question + ' ' + q.why + ' ' + q.placeholder).toLowerCase();
  if (FORBIDDEN_STEMS.some(stem => all.includes(stem))) return true;
  if (q.question.length > 140 || q.why.length > 120 || q.placeholder.length > 120) return true;
  const qMarks = (q.question.match(/\?/g) || []).length;
  if (qMarks !== 1) return true;
  return false;
}
const items = (parsed && Array.isArray(parsed.questions)) ? parsed.questions : [];
const byId = new Map();
for (const it of items) { if (it && it.criterion_id) byId.set(it.criterion_id, it); }
const gapQuestions = selected.map(sc => {
  const candidate = byId.get(sc.criterion_id);
  if (candidate && !violates(candidate)) {
    return { criterion_id: sc.criterion_id, question: candidate.question, why: candidate.why, placeholder: candidate.placeholder };
  }
  const fb = FALLBACK[sc.criterion_id] || {
    question: 'Tell us more about this.', why: 'We could not find this publicly.', placeholder: 'A few sentences is enough.',
  };
  return { criterion_id: sc.criterion_id, question: fb.question, why: fb.why, placeholder: fb.placeholder };
});
const inputHash = sha256Hex('f08:ai_run:question_generation:followup:' + ctx.application_id + ':' + selected.map(s => s.criterion_id).join(','));
const found = await pgGet.call(this, `ai_runs?input_hash=eq.${encodeURIComponent(inputHash)}&select=id`);
if (!found.length) {
  await pg.call(this, 'POST', 'ai_runs', {
    task_type: 'question_generation', founder_id: ctx.founder_id, company_id: ctx.company_id, application_id: ctx.application_id,
    model: %(TERRA)s, input_hash: inputHash, output_json: { selected_criteria: selected, questions: gapQuestions },
  }, 'return=minimal');
}
return [{ json: { ...ctx, __gap_questions: gapQuestions } }];
""" % {"FALLBACK": fallback_json, "TERRA": json.dumps(MODEL_TERRA)},
        X0 + 2400, -180, on_error=False)
    handle_phraser_failure = code_node(
        "Handle gap-phraser failure",
        r"""
const ctx = $('Build gap-question-phraser request').first().json;
const selected = ctx.__selected_criteria_input || [];
const FALLBACK = %(FALLBACK)s;
const gapQuestions = selected.map(sc => {
  const fb = FALLBACK[sc.criterion_id] || {
    question: 'Tell us more about this.', why: 'We could not find this publicly.', placeholder: 'A few sentences is enough.',
  };
  return { criterion_id: sc.criterion_id, question: fb.question, why: fb.why, placeholder: fb.placeholder };
});
return [{ json: { ...ctx, __gap_questions: gapQuestions } }];
""" % {"FALLBACK": fallback_json}, X0 + 2400, 60)
    openai_phraser["onError"] = "continueErrorOutput"
    nodes += [parse_phraser, handle_phraser_failure]

    write_interview = code_node(
        "Generate token + write interviews (kind='follow_up')",
        PG_HELPER_JS + HASHING_JS + r"""
const inp = $json;
const rawToken = crypto.randomBytes(32).toString('hex');
const tokenHash = sha256Hex(rawToken);
const questions = (inp.__gap_questions || []).map(q => ({
  criterion_id: q.criterion_id, question: q.question, why: q.why, placeholder: q.placeholder,
  status: 'pending', answer_text: null,
}));
await pg.call(this, 'POST', 'interviews', {
  application_id: inp.application_id, card_id: inp.card_id, kind: 'follow_up', status: 'pending',
  share_token: tokenHash, disclosed_at: new Date().toISOString(),
  transcript: { questions, meta: { asked_by: inp.asked_by, note: inp.note } },
}, 'return=minimal');
return [{ json: { token: rawToken, questions } }];
""", X0 + 2640, 0, on_error=True)
    build_response = code_node(
        "Build FollowUpCreateResponse",
        r"""
const inp = $json;
return [{ json: { token: inp.token, questions: inp.questions, estimated_minutes: %(EST)s } }];
""" % {"EST": ESTIMATED_MINUTES}, X0 + 2880, 0)
    respond_success = respond_node("Respond: success", 200, X0 + 3120, 0)
    nodes += [write_interview, build_response, respond_success]

    handle_unexpected_error = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, X0 + 2160, 600)
    respond_500 = respond_node("Respond: internal error (500)", 500, X0 + 2400, 600)
    nodes += [handle_unexpected_error, respond_500]

    conns = merge_connections(
        connect(
            ("Webhook: f08-followup-create", 0, "Validate input", 0),
            ("Validate input", 0, "IF: valid?", 0),
        ),
        {"IF: valid?": {"main": [
            [{"node": "Fetch card + criteria + claims", "type": "main", "index": 0}],
            [{"node": "Build client error response", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build client error response", 0, "Respond: bad request (400)", 0),
            ("Fetch card + criteria + claims", 0, "IF: found?", 0),
        ),
        {"IF: found?": {"main": [
            [{"node": "Select gap criteria", "type": "main", "index": 0}],
            [{"node": "Build not-found response", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build not-found response", 0, "Respond: not found (404)", 0),
            ("Select gap criteria", 0, "IF: any gap criteria?", 0),
        ),
        {"IF: any gap criteria?": {"main": [
            [{"node": "Build card_context", "type": "main", "index": 0}],
            [{"node": "No gap criteria", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build card_context", 0, "Build gap-question-phraser request", 0),
            ("Build gap-question-phraser request", 0, "OpenAI: gap-question-phraser (terra)", 0),
            ("OpenAI: gap-question-phraser (terra)", 0, "Parse + validate gap-question-phraser response", 0),
        ),
        connect(
            ("No gap criteria", 0, "Generate token + write interviews (kind='follow_up')", 0),
            ("Parse + validate gap-question-phraser response", 0, "Generate token + write interviews (kind='follow_up')", 0),
            ("Handle gap-phraser failure", 0, "Generate token + write interviews (kind='follow_up')", 0),
            ("Generate token + write interviews (kind='follow_up')", 0, "Build FollowUpCreateResponse", 0),
            ("Build FollowUpCreateResponse", 0, "Respond: success", 0),
            ("Handle unexpected error", 0, "Respond: internal error (500)", 0),
        ),
        error_out("Fetch card + criteria + claims", "Handle unexpected error"),
        error_out("Generate token + write interviews (kind='follow_up')", "Handle unexpected error"),
        error_out("OpenAI: gap-question-phraser (terra)", "Handle gap-phraser failure"),
    )

    return {
        "name": "f08-followup-create", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# f08-followup (GET, never consumes the token) -- n8n-spec.md SS10.1.
# ============================================================================

def build_followup():
    nodes = []
    X0 = -1000

    webhook = webhook_node("Webhook: f08-followup", "f08-followup", "GET", X0, 0)
    if_token = if_node("IF: token param present?", "={{ !!$json.query.token }}", True, "boolean", "equals",
                        X0 + 240, 0)
    build_missing_token_err = code_node(
        "Build missing-token error", r"""return [{ json: { error: { code: 'invalid_input', message: 'token is required.' } } }];""",
        X0 + 480, 300)
    respond_400 = respond_node("Respond: bad request (400)", 400, X0 + 720, 300)
    nodes += [webhook, if_token, build_missing_token_err, respond_400]

    lookup = code_node(
        "Hash token, look up interview",
        PG_HELPER_JS + HASHING_JS + r"""
const item = $input.first().json;
const token = String((item.query && item.query.token) || '');
const tokenHash = sha256Hex(token);
const rows = await pgGet.call(this,
  `interviews?kind=eq.follow_up&share_token=eq.${encodeURIComponent(tokenHash)}` +
  `&select=id,application_id,status,transcript,created_at&order=created_at.asc&limit=1`);
return [{ json: { __interview: rows.length ? rows[0] : null } }];
""", X0 + 480, 0, on_error=True)
    if_found = if_node("IF: found?", "={{ !!$json.__interview }}", True, "boolean", "equals", X0 + 720, 0)
    build_unknown = code_node(
        "Build valid:false (unknown)",
        r"""return [{ json: { valid: false, reason: 'unknown' } }];""", X0 + 960, 300)
    respond_unknown = respond_node("Respond: valid false (200)", 200, X0 + 1200, 300)
    nodes += [lookup, if_found, build_unknown, respond_unknown]

    if_expired = if_node(
        "IF: expired (>24h)?",
        "={{ (Date.now() - new Date($json.__interview.created_at).getTime()) > 24*60*60*1000 }}",
        True, "boolean", "equals", X0 + 960, -60)
    build_expired = code_node(
        "Build valid:false (expired)",
        r"""return [{ json: { valid: false, reason: 'expired' } }];""", X0 + 1200, -240)
    respond_expired = respond_node("Respond: valid false expired (200)", 200, X0 + 1440, -240)
    nodes += [if_expired, build_expired, respond_expired]

    build_response = code_node(
        "Build FollowUpGetResponse",
        PG_HELPER_JS + r"""
const inp = $json;
const iv = inp.__interview;
const apps = await pgGet.call(this, `applications?id=eq.${iv.application_id}&select=company_id&limit=1`);
const companyId = apps.length ? apps[0].company_id : null;
const companies = companyId ? await pgGet.call(this, `companies?id=eq.${companyId}&select=name&limit=1`) : [];
const meta = (iv.transcript && iv.transcript.meta) || {};
const questions = ((iv.transcript && iv.transcript.questions) || [])
  .map(q => ({ criterion_id: q.criterion_id, question: q.question, why: q.why, placeholder: q.placeholder }));
return [{ json: {
  valid: true,
  company_name: companies.length ? companies[0].name : null,
  asked_by: meta.asked_by || 'The investor reviewing your application',
  note: meta.note || null,
  questions,
  estimated_minutes: %(EST)s,
  already_answered: iv.status === 'completed',
} }];
""" % {"EST": ESTIMATED_MINUTES}, X0 + 1200, 120, on_error=True)
    respond_success = respond_node("Respond: success", 200, X0 + 1440, 120)
    nodes += [build_response, respond_success]

    handle_unexpected_error = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, X0 + 960, 600)
    respond_500 = respond_node("Respond: internal error (500)", 500, X0 + 1200, 600)
    nodes += [handle_unexpected_error, respond_500]

    conns = merge_connections(
        {"IF: token param present?": {"main": [
            [{"node": "Hash token, look up interview", "type": "main", "index": 0}],
            [{"node": "Build missing-token error", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Webhook: f08-followup", 0, "IF: token param present?", 0),
            ("Build missing-token error", 0, "Respond: bad request (400)", 0),
            ("Hash token, look up interview", 0, "IF: found?", 0),
        ),
        {"IF: found?": {"main": [
            [{"node": "IF: expired (>24h)?", "type": "main", "index": 0}],
            [{"node": "Build valid:false (unknown)", "type": "main", "index": 0}],
        ]}},
        connect(("Build valid:false (unknown)", 0, "Respond: valid false (200)", 0)),
        {"IF: expired (>24h)?": {"main": [
            [{"node": "Build valid:false (expired)", "type": "main", "index": 0}],
            [{"node": "Build FollowUpGetResponse", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build valid:false (expired)", 0, "Respond: valid false expired (200)", 0),
            ("Build FollowUpGetResponse", 0, "Respond: success", 0),
            ("Handle unexpected error", 0, "Respond: internal error (500)", 0),
        ),
        error_out("Hash token, look up interview", "Handle unexpected error"),
        error_out("Build FollowUpGetResponse", "Handle unexpected error"),
    )

    return {
        "name": "f08-followup", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# f08-followup-answers (POST, consumes the token) -- n8n-spec.md SS10.2. Same write shape
# as f08-gap-answers SS9.1, keyed by share_token hash instead of application_id.
# ============================================================================

def build_followup_answers():
    nodes = []
    X0 = -1400

    webhook = webhook_node("Webhook: f08-followup-answers", "f08-followup-answers", "POST", X0, 0)
    validate = code_node(
        "Validate input",
        r"""
const item = $input.first().json;
const body = item.body || {};
const token = String(body.token || '').trim();
if (!token) {
  return [{ json: { __valid: false, error: { code: 'invalid_input', message: 'token is required.' } } }];
}
const answersIn = Array.isArray(body.answers) ? body.answers : [];
const answers = [];
for (const a of answersIn) {
  if (!a || typeof a !== 'object') continue;
  const criterionId = String(a.criterion_id || '').trim();
  const answerText = typeof a.answer_text === 'string' ? a.answer_text : '';
  if (!criterionId || !answerText.trim()) continue;
  answers.push({ criterion_id: criterionId, question: String(a.question || ''), answer_text: answerText });
}
const skippedIn = Array.isArray(body.skipped_criterion_ids) ? body.skipped_criterion_ids : [];
const skipped = skippedIn.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
return [{ json: { __valid: true, token, answers, skipped_criterion_ids: skipped } }];
""", X0 + 240, 0)
    if_valid = if_node("IF: valid?", "={{ $json.__valid }}", True, "boolean", "equals", X0 + 480, 0)
    build_client_err = code_node("Build client error response",
                                  r"""return [{ json: { error: $json.error } }];""", X0 + 720, 300)
    respond_400 = respond_node("Respond: bad request (400)", 400, X0 + 960, 300)
    nodes += [webhook, validate, if_valid, build_client_err, respond_400]

    fetch = code_node(
        "Hash token, fetch interview + application",
        PG_HELPER_JS + HASHING_JS + r"""
const inp = $json;
const tokenHash = sha256Hex(inp.token);
const interviews = await pgGet.call(this,
  `interviews?kind=eq.follow_up&share_token=eq.${encodeURIComponent(tokenHash)}` +
  `&select=id,application_id,status,transcript,created_at&order=created_at.asc&limit=1`);
if (!interviews.length) return [{ json: { ...inp, __valid_token: false } }];
const iv = interviews[0];
const expired = (Date.now() - new Date(iv.created_at).getTime()) > 24 * 60 * 60 * 1000;
if (expired) return [{ json: { ...inp, __valid_token: false } }];
const cards = await pgGet.call(this,
  `cards?application_id=eq.${iv.application_id}&card_type=eq.founder&select=id,founder_id,company_id&order=created_at.asc&limit=1`);
const card = cards.length ? cards[0] : null;
const apps = await pgGet.call(this, `applications?id=eq.${iv.application_id}&select=status&limit=1`);
return [{ json: { ...inp, __valid_token: true, __interview: iv, application_id: iv.application_id,
  card_id: card ? card.id : null, founder_id: card ? card.founder_id : null, company_id: card ? card.company_id : null,
  status: apps.length ? apps[0].status : null,
  __interview_completed: iv.status === 'completed' } }];
""", X0 + 720, 0, on_error=True)
    if_valid_token = if_node("IF: token valid?", "={{ $json.__valid_token }}", True, "boolean", "equals",
                              X0 + 960, 0)
    build_invalid_token_err = code_node(
        "Build invalid-token error",
        r"""return [{ json: { error: { code: 'internal', message: 'This link is no longer valid.' } } }];""",
        X0 + 1200, 300)
    respond_404 = respond_node("Respond: invalid token (404)", 404, X0 + 1440, 300)
    nodes += [fetch, if_valid_token, build_invalid_token_err, respond_404]

    if_completed = if_node("IF: already completed?", "={{ $json.__interview_completed }}", True,
                            "boolean", "equals", X0 + 1200, 0)
    replay = code_node(
        "Build replay response",
        COMPLETENESS_JS + PG_HELPER_JS + r"""
const inp = $json;
const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
const claims = inp.card_id ? await pgGet.call(this, `claims?card_id=eq.${inp.card_id}&select=id,topic,verification_status`) : [];
const completeness = cardCompleteness({ criteria, claims });
const questions = (inp.__interview.transcript && inp.__interview.transcript.questions) || [];
const accepted = questions.filter(q => q.status === 'answered').length;
const skippedCount = questions.filter(q => q.status === 'skipped').length;
return [{ json: { accepted, skipped: skippedCount, card_completeness: completeness, status: inp.status,
  verdict_eta_hours: %(ETA)s } }];
""" % {"ETA": VERDICT_ETA_HOURS}, X0 + 1440, -240, on_error=True)
    respond_replay = respond_node("Respond: success (replay)", 200, X0 + 1680, -240)
    nodes += [if_completed, replay, respond_replay]

    write_answers = code_node(
        "Write answer claims + evidence + raw_signals",
        PG_HELPER_JS + HASHING_JS + GAPS_JS + r"""
const inp = $json;
for (const a of inp.answers) {
  const topic = CRITERION_TOPIC[a.criterion_id];
  if (!topic) continue;
  const rsHash = contentHash.rawSignal({ application_id: inp.application_id, source: 'interview_answer',
    content_key: a.criterion_id + ':answer:followup' });
  const existingRs = await pgGet.call(this, `raw_signals?content_hash=eq.${encodeURIComponent(rsHash)}&select=id`);
  let rawSignalId;
  if (existingRs.length) {
    rawSignalId = existingRs[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'raw_signals', {
      source: 'interview_answer', source_url: null,
      payload: { criterion_id: a.criterion_id, question: a.question, answer_text: a.answer_text },
      content_hash: rsHash, founder_id: inp.founder_id, company_id: inp.company_id, observed_at: new Date().toISOString(),
    }, 'return=representation');
    rawSignalId = made[0].id;
  }
  const claimHash = contentHash.claim({ application_id: inp.application_id, card_id: inp.card_id, topic, item_key: 'followup' });
  const existingClaim = await pgGet.call(this, `claims?content_hash=eq.${encodeURIComponent(claimHash)}&select=id`);
  let claimId;
  if (existingClaim.length) {
    claimId = existingClaim[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'claims', {
      card_id: inp.card_id, topic, text_verbatim: a.answer_text, value: null, axis: null,
      source_kind: 'interview', base_confidence: %(BCI)s, verification_status: 'unverified', content_hash: claimHash,
    }, 'return=representation');
    claimId = made[0].id;
  }
  const evHash = contentHash.evidence({ application_id: inp.application_id, claim_id: claimId, relation: 'supports', raw_signal_id: rawSignalId });
  const existingEv = await pgGet.call(this, `evidence?content_hash=eq.${encodeURIComponent(evHash)}&select=id`);
  if (!existingEv.length) {
    await pg.call(this, 'POST', 'evidence', {
      claim_id: claimId, relation: 'supports', tier: 'discovered', strength: null,
      quote_verbatim: a.answer_text, source_url: null, raw_signal_id: rawSignalId, content_hash: evHash,
    }, 'return=minimal');
  }
}
return [{ json: inp }];
""" % {"BCI": BASE_CONFIDENCE_INTERVIEW}, X0 + 1440, 120, on_error=True)
    mark_completed = code_node(
        "Mark interview completed",
        PG_HELPER_JS + r"""
const inp = $json;
const answeredIds = new Set(inp.answers.map(a => a.criterion_id));
const skippedIds = new Set(inp.skipped_criterion_ids);
const transcript = inp.__interview.transcript || { questions: [] };
const questions = (transcript.questions || []).map(q => {
  if (answeredIds.has(q.criterion_id)) {
    const a = inp.answers.find(x => x.criterion_id === q.criterion_id);
    return { ...q, status: 'answered', answer_text: a.answer_text };
  }
  if (skippedIds.has(q.criterion_id)) return { ...q, status: 'skipped' };
  return q;
});
await pg.call(this, 'PATCH', `interviews?id=eq.${inp.__interview.id}`, {
  status: 'completed', transcript: { ...transcript, questions }, completed_at: new Date().toISOString(),
}, 'return=minimal');
return [{ json: inp }];
""", X0 + 1680, 120, on_error=True)
    finalize = code_node(
        "Recompute completeness + write events",
        COMPLETENESS_JS + PG_HELPER_JS + r"""
const inp = $json;
const formulaRows = await pgGet.call(this, `score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1`);
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];
const claims = await pgGet.call(this, `claims?card_id=eq.${inp.card_id}&select=id,topic,verification_status`);
const completeness = cardCompleteness({ criteria, claims });
await pg.call(this, 'PATCH', `cards?id=eq.${inp.card_id}`, { completeness }, 'return=minimal');
await pg.call(this, 'POST', 'events', {
  event_type: 'gap_answers_submitted', entity_type: 'founder', entity_id: inp.founder_id,
  payload: { application_id: inp.application_id, accepted: inp.answers.length, skipped: inp.skipped_criterion_ids.length,
             via: 'followup' },
  actor: 'f08-followup-answers',
}, 'return=minimal');
return [{ json: { founder_id: inp.founder_id, accepted: inp.answers.length, skipped: inp.skipped_criterion_ids.length,
  card_completeness: completeness, status: inp.status, verdict_eta_hours: %(ETA)s } }];
""" % {"ETA": VERDICT_ETA_HOURS}, X0 + 1920, 120, on_error=True)
    nodes += [write_answers, mark_completed, finalize]

    build_response = code_node(
        "Build GapAnswersResponse",
        r"""
const inp = $json;
return [{ json: { accepted: inp.accepted, skipped: inp.skipped, card_completeness: inp.card_completeness,
  status: inp.status, verdict_eta_hours: inp.verdict_eta_hours } }];
""", X0 + 2160, 120)
    respond_success = respond_node("Respond: success", 200, X0 + 2400, 120)
    nodes += [build_response, respond_success]

    handle_unexpected_error = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, X0 + 1440, 600)
    respond_500 = respond_node("Respond: internal error (500)", 500, X0 + 1680, 600)
    nodes += [handle_unexpected_error, respond_500]

    build_rescore_input = code_node(
        "Build rescore input",
        r"""const ctx = $('Recompute completeness + write events').first().json; return [{ json: { founder_id: ctx.founder_id } }];""",
        X0 + 2640, 120)
    trigger_rescore = execute_workflow_node("Trigger f03-score-founder rescore", F03_SCORE_FOUNDER_ID, X0 + 2880, 120)
    write_rescore_event = code_node(
        "Write events (rescore_triggered)",
        PG_HELPER_JS + r"""
const inp = $('Build rescore input').first().json;
await pg.call(this, 'POST', 'events', {
  event_type: 'rescore_triggered', entity_type: 'founder', entity_id: inp.founder_id, payload: {}, actor: 'f08-followup-answers',
}, 'return=minimal');
return [{ json: {} }];
""", X0 + 3120, 120)
    nodes += [build_rescore_input, trigger_rescore, write_rescore_event]

    conns = merge_connections(
        connect(
            ("Webhook: f08-followup-answers", 0, "Validate input", 0),
            ("Validate input", 0, "IF: valid?", 0),
        ),
        {"IF: valid?": {"main": [
            [{"node": "Hash token, fetch interview + application", "type": "main", "index": 0}],
            [{"node": "Build client error response", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build client error response", 0, "Respond: bad request (400)", 0),
            ("Hash token, fetch interview + application", 0, "IF: token valid?", 0),
        ),
        {"IF: token valid?": {"main": [
            [{"node": "IF: already completed?", "type": "main", "index": 0}],
            [{"node": "Build invalid-token error", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build invalid-token error", 0, "Respond: invalid token (404)", 0),
        ),
        {"IF: already completed?": {"main": [
            [{"node": "Build replay response", "type": "main", "index": 0}],
            [{"node": "Write answer claims + evidence + raw_signals", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build replay response", 0, "Respond: success (replay)", 0),
            ("Write answer claims + evidence + raw_signals", 0, "Mark interview completed", 0),
            ("Mark interview completed", 0, "Recompute completeness + write events", 0),
            ("Recompute completeness + write events", 0, "Build GapAnswersResponse", 0),
            ("Build GapAnswersResponse", 0, "Respond: success", 0),
            ("Respond: success", 0, "Build rescore input", 0),
            ("Build rescore input", 0, "Trigger f03-score-founder rescore", 0),
            ("Trigger f03-score-founder rescore", 0, "Write events (rescore_triggered)", 0),
            ("Handle unexpected error", 0, "Respond: internal error (500)", 0),
        ),
        error_out("Hash token, fetch interview + application", "Handle unexpected error"),
        error_out("Build replay response", "Handle unexpected error"),
        error_out("Write answer claims + evidence + raw_signals", "Handle unexpected error"),
        error_out("Mark interview completed", "Handle unexpected error"),
        error_out("Recompute completeness + write events", "Handle unexpected error"),
    )

    return {
        "name": "f08-followup-answers", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# main
# ============================================================================

def main():
    check_only = '--check' in sys.argv
    builders = [build_intake_submit, build_gap_answers, build_application_status,
                build_followup_create, build_followup, build_followup_answers]
    workflows = [b() for b in builders]
    failures = 0
    for wf in workflows:
        print("\n%s (%d nodes)" % (wf['name'], len(wf['nodes'])))
        failures += check_nodes(wf['nodes'])
        if not check_only:
            path = os.path.join(OUT, wf['name'] + '.json')
            json.dump(wf, open(path, 'w', encoding='utf-8'), indent=1)
            print("  -> %s" % os.path.relpath(path, ROOT))
    print("\nCode nodes failing syntax check: %d" % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
