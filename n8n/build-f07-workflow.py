#!/usr/bin/env python3
"""
Build the feature-07 (Thesis Engine) n8n workflows from source.

Why a generator rather than hand-maintained JSON: the deterministic evaluator lives in
lib/f07/{vocabulary,rules,hashes}.js, unit-tested outside n8n (87 tests: 62 rules.js + 25
hashes.js). n8n's Code-node sandbox cannot `require()` a repo file (no bind-mount, see
infra/n8n/docker-compose.yml), so that source has to be *inlined* into the nodes verbatim.
Doing that by hand is exactly the class of drift feature 04 hit first (n8n/build-workflows.py)
and feature 03 hit second (n8n/build-f03-workflow.py) -- same fix, same reason, third time.

Three workflows, per docs/backlog/07-thesis-engine/plan.md Stage D:

  f07-db-write         (D0) -- the design.md SS5.4 write path only: ai_runs -> cards ->
                         raw_signals -> claims -> evidence. Code-node sub-workflow, mirrors
                         n8n/workflows/f04-db-write.json's shape (its card-preflight step is
                         reused verbatim). NOT the same hash recipes as f04-db-write -- see
                         "why D0 is not a call to f04-db-write" below.
  f07-thesis-gate      (D1) -- both modes (full / keyword), the extraction validator node,
                         calls f07-db-write, evaluates, persists per design.md SS2's table.
  f07-thesis-reevaluate (D2) -- does not re-extract; reads current claims; contradicted ->
                         unknown; writes new rows only.

Run after any change to lib/f07/*.js or to docs/backlog/07-thesis-engine/agents/*:

    python3 n8n/build-f07-workflow.py           # regenerate n8n/workflows/f07-*.json
    python3 n8n/build-f07-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f07.md).

Why D0 is not a call to f04-db-write, though the team lead asked to check first: the
card-preflight resolution IS identical and is reused verbatim below. But f04-db-write's
raw_signals/claims/evidence hash recipes are f04's OWN, hard-coded inside ITS Code nodes
(sha(source,source_url,query,observed_at) / sha(card_id,topic,ai_run_id,item_key) /
sha(claimId,relation,source_url,quote,query)) -- and design.md SS5.4 is explicit and
repeated that 07 must NOT use the ai_run_id-anchored claims hash ("Do NOT 'harmonise' this
back"), because f04 embeds ai_run_id ON PURPOSE (to force new rows per re-run for
scores.trend) while 07 needs the opposite: retry-safety anchored on raw_signal_id. Calling
f04-db-write as a sub-workflow would silently reintroduce the exact rev.2 duplicate-claims
bug design.md's SS5.4 "hash correction that matters" section exists to document. So D0 is
its own sub-workflow, same topology as f04-db-write, independent (correct) hash recipes from
lib/f07/hashes.js.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f07')
# lib/f07/extractor/ (NOT docs/backlog/07-thesis-engine/agents/thesis-attribute-extractor/,
# which is gitignored from the public the-vc-brain repo per CLAUDE.md's publication gate).
# Team-lead ruling, 2026-07-19: lib/f07/run.js reads from the same lib/f07/extractor/ copy
# so the public tree is self-contained; docs/ remains the C1 deliverable's source of record
# during development, but is a duplicate now, not the canonical read path. Verified
# byte-identical to the docs/ copy at the time this generator was pointed here.
AGENT_DIR = os.path.join(ROOT, 'lib', 'f07', 'extractor')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

MODEL = 'gpt-5.6-luna'
PROMPT_VERSION = 'f07-extract-v1'
FORMULA_VERSION = 'f07-rules-v1'

# f07-db-write, registered 2026-07-19 (mirrors n8n/build-workflows.py's DB_WRITE_ID
# constant, same reason: f07-thesis-gate's Execute Workflow node needs the sub-workflow's
# id). Override via F07_DB_WRITE_ID for a re-import on a fresh n8n instance.
D0_WORKFLOW_ID = os.environ.get('F07_DB_WRITE_ID', '7pEtpy8sS3VLgVt2')

FIELDS5 = ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built']
GATEABLE4 = ['sector', 'business_model', 'geography_country', 'stage_evidence']  # what_is_built: not gateable (SS1.1)

GAP_LABELS_JS = (
    "{\n"
    "  sector: 'Sector: not disclosed.',\n"
    "  business_model: 'Business model: not disclosed.',\n"
    "  geography_country: 'Headquarters location: not disclosed.',\n"
    "  stage_evidence: 'Product stage: not disclosed.',\n"
    "  what_is_built: 'Product description: not disclosed.',\n"
    "}"
)


# ============================================================================
# Source extraction -- lib/f07/*.js pasted verbatim (module.exports / require
# seams stripped -- n8n's Code-node sandbox does not define `module`, and
# cannot require() a sibling file).
# ============================================================================

def _read(name):
    return open(os.path.join(LIBDIR, name), encoding='utf-8').read()


def _strip_exports(src):
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed"
    return stripped.rstrip() + "\n"


def _export_names(src):
    m = re.search(r"module\.exports\s*=\s*\{(.*?)\};", src, re.S)
    if not m:
        raise SystemExit("could not find module.exports block")
    return [x.strip() for x in m.group(1).split(',') if x.strip()]


def build_hashes_bundle():
    """hashes.js alone -- all D0 needs (write-path content hashes)."""
    src = _read('hashes.js')
    src = re.sub(r"const crypto = require\('node:crypto'\);", "const crypto = require('crypto');", src)
    body = _strip_exports(src)
    return (
        "// ===== inlined lib/f07/hashes.js verbatim "
        "(generated by n8n/build-f07-workflow.py -- edit the source, not this) =====\n"
        + body
    )


def build_evaluator_bundle():
    """vocabulary.js + rules.js + hashes.js, concatenated into one Code-node scope.

    rules.js does `const vocabulary = require('./vocabulary');` and calls
    `vocabulary.region_of(...)` / `.stage_of(...)` / `.isSentinel(...)` -- dot access on a
    namespace, not destructured bare names (unlike f04's config.js pattern, where stripping
    the require line is enough because the SAME bare consts are already in scope). So the
    require line is stripped and a `const vocabulary = { ... }` object literal is
    reconstructed here from vocabulary.js's own export list, before rules.js's body is
    pasted in -- keeps `vocabulary.<fn>` call sites in rules.js untouched (edit there, not
    here, on any future change).
    """
    vocab_src = _read('vocabulary.js')
    vocab_exports = _export_names(vocab_src)
    vocab_body = _strip_exports(vocab_src)
    vocab_ns = "const vocabulary = { %s };\n" % ", ".join(vocab_exports)

    rules_src = _read('rules.js')
    rules_src = re.sub(r"const vocabulary = require\('\./vocabulary'\);\n?", "", rules_src)
    rules_body = _strip_exports(rules_src)

    hashes_bundle = build_hashes_bundle()

    return (
        "// ===== inlined lib/f07/{vocabulary,rules}.js verbatim "
        "(generated by n8n/build-f07-workflow.py -- edit the source, not this) =====\n"
        + vocab_body + "\n" + vocab_ns + "\n" + rules_body + "\n" + hashes_bundle
    )


def agent_system_prompt():
    t = open(os.path.join(AGENT_DIR, 'thesis-attribute-extractor-agent-prompts.txt'), encoding='utf-8').read()
    return t[t.find('SYSTEM MESSAGE'):].split('=' * 80, 1)[1].strip()


def agent_schema():
    return json.load(open(os.path.join(AGENT_DIR, 'thesis-attribute-extractor-agent-json-schema.json'), encoding='utf-8'))


# model-recommendations.md's own "Strict-mode schema caveat" section, cashed out: verified
# live 2026-07-19 that OpenAI's structured-output validator rejects `uniqueItems` on
# missing_fields ("'uniqueItems' is not permitted"). Stripping the documented risk list
# up front rather than discovering each one via a separate failed call -- the deterministic
# validator Code node (PARSE_AND_VALIDATE_JS) already re-implements every one of these
# checks in JS (legal-keys-only + dedup on missing_fields, the geography_country pattern,
# the length caps), so removing them from the SCHEMA sent to the API loses no guarantee.
_STRIP_KEYWORDS = ('minLength', 'maxLength', 'pattern', 'uniqueItems', 'maxItems')


def sanitize_schema_for_strict_mode(node):
    if isinstance(node, dict):
        return {k: sanitize_schema_for_strict_mode(v) for k, v in node.items() if k not in _STRIP_KEYWORDS}
    if isinstance(node, list):
        return [sanitize_schema_for_strict_mode(v) for v in node]
    return node


EVALUATOR_BUNDLE = build_evaluator_bundle()
HASHES_BUNDLE = build_hashes_bundle()
SYSTEM_PROMPT = agent_system_prompt()
SCHEMA = sanitize_schema_for_strict_mode(agent_schema())


# ============================================================================
# n8n node/connection helpers
# ============================================================================

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


# PostgREST access: Code-node-wrapped `this.helpers.httpRequest` throughout (pg()/pgGet()
# below), matching D0's shape (and f03's, and f04-db-write's) -- NOT the standalone
# n8n-nodes-base.httpRequest node for Supabase calls. This was a live pivot while writing
# this generator: n8n/workflows/f04-market-intel.json's OWN "Extract application" /
# "Resolve card" Code nodes carry a comment discovered mid-build (2026-07-19, concurrent
# terminal) -- "postgrestNode() returns raw text ... never relying on n8n's own
# array-unwrapping (verified live: it is inconsistent for empty-array responses --
# sometimes 0 items, sometimes 1 item with json={})". That inconsistency is specific to
# the STANDALONE httpRequest node's automatic JSON-array-to-items conversion; calling
# `this.helpers.httpRequest({..., json: true})` from inside a Code node returns an
# already-parsed JS value directly, with no such ambiguity. Real httpRequest nodes are
# kept ONLY for the OpenAI extractor call (a single JSON object response, not an array --
# unaffected -- and proven working against this exact model in f04-market-intel) and for
# n8n-nodes-base.if / n8n-nodes-base.executeWorkflow, which are the genuinely useful
# "visual" decision points a reviewer would want on the canvas (CLAUDE.md's "визуальными
# workflow ... не кодом" directive). Every PostgREST read/write stays in Code nodes.

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


def sticky(name, content, x, y, w, h):
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
    bad = 0
    for n in nodes:
        js = n.get('parameters', {}).get('jsCode')
        if not js:
            continue
        wrapped = (
            "const $env = {}; const $execution = { id: 1 };\n"
            "const $input = { first: () => ({ json: {} }), all: () => [] };\n"
            "const $ = () => ({ first: () => ({ json: {} }) });\n"
            "const self = { helpers: { httpRequest: async () => ({}) } };\n"
            "(async function(){\n" + js + "\n}).call(self);\n"
        )
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write(wrapped)
            path = f.name
        r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
        ok = r.returncode == 0
        print("  %-48s %s (%d bytes)" % (n['name'], 'OK' if ok else 'SYNTAX ERROR', len(js)))
        if not ok:
            bad += 1
            print(r.stderr[:800])
        os.unlink(path)
    return bad


# ============================================================================
# Extractor OpenAI request body (design.md SS4; model-recommendations.md's runtime
# params). /v1/responses, not /v1/chat/completions: the reasoning/text/format shape below
# mirrors n8n/workflows/f04-market-intel.json's categorizer node. temperature is OMITTED,
# not sent as 1 -- f03's build script discovered live that gpt-5.6-luna REJECTS an explicit
# temperature parameter (400 "Unsupported parameter") over chat/completions; the same
# rejection is recorded for /v1/responses against this model family. Design SS4 wants
# temperature=0 for reproducibility; omitting it (not forcing 1) is the same judgment call
# f03/f04 already made for the identical constraint.
#
# The request body is built in a Code node (D1_BUILD_EXTRACTOR_REQUEST_JS /
# retry variant below), NOT inline in the httpRequest node's own jsonBody expression --
# discovered live while testing this exact node (2026-07-19): n8n's `{{ ... }}` expression
# parser locates the closing `}}` with what appears to be a naive first-match scan, not a
# brace-depth-aware one. The extractor's JSON schema is deeply nested and contains
# literal "}}" sequences (adjacent closing braces from nested objects) well before the
# expression's own intended end -- embedding the schema directly inside `{{ }}` truncates
# the expression there and n8n reports "invalid syntax" with the whole expression echoed
# back as context. Building the body object in a Code node and referencing it via a SHORT
# `{{ JSON.stringify($json.__extractor_request_body) }}` sidesteps the parser entirely: the
# schema text is now DATA inside $json, never literal characters inside the expression
# source itself.
# ============================================================================

def build_extractor_request_js(retry=False):
    sys_js = json.dumps(SYSTEM_PROMPT)
    schema_js = json.dumps(SCHEMA)
    retry_note = (
        "\n\nYour previous response was not valid JSON matching the required schema, "
        "or a quote could not be grounded. Return ONLY the JSON object, with every field "
        "exactly matching the schema, every quote a literal verbatim substring of the input."
        if retry else ""
    )
    return (
        "const SYS = " + sys_js + ";\n"
        "const SCHEMA = " + schema_js + ";\n"
        "const inp = $json;\n"
        "const user = \"<company_text>\\n\" + String(inp.gate_text || '') + \"\\n</company_text>\\n\\n\"\n"
        "  + \"<structured_hints>\\n\" + JSON.stringify(inp.structured_hints || {}) + \"\\n</structured_hints>\"\n"
        "  + " + json.dumps(retry_note) + ";\n"
        "const body = {\n"
        "  model: " + json.dumps(MODEL) + ",\n"
        "  input: [ { role: 'system', content: SYS }, { role: 'user', content: user } ],\n"
        "  reasoning: { effort: 'low' },\n"
        "  text: { verbosity: 'low', format: { type: 'json_schema',\n"
        "    name: 'thesis_attribute_extractor_output', strict: true, schema: SCHEMA } },\n"
        "  max_output_tokens: 1500,\n"
        "};\n"
        "return [{ json: { ...inp, __extractor_request_body: body } }];\n"
    )


def openai_extractor_node(name, x, y):
    return {
        "parameters": {
            "method": "POST", "url": "https://api.openai.com/v1/responses",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $env.OPENAI_API_KEY }}"},
                {"name": "Content-Type", "value": "application/json"},
            ]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.__extractor_request_body) }}",
            "options": {"timeout": 120000},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.1, "position": [x, y],
        "retryOnFail": True, "maxTries": 2, "waitBetweenTries": 3000,
        "notes": "model-recommendations.md's temperature:0 is dropped -- gpt-5.6-luna "
                 "rejects an explicit temperature parameter (verified live for this model "
                 "family by f03/f04's own build scripts, 2026-07-19). jsonBody stays a "
                 "SHORT expression referencing a Code-node-built object -- see the module "
                 "comment above on why the body is not built inline.",
    }


# The 4-check deterministic validator (input-spec.md "The deterministic validator" section)
# + response parsing, shared by both the first-try and retry parse nodes. The preceding
# httpRequest node's output REPLACES $json with the raw API response (n8n does not merge
# it with the upstream item) -- so context (application_id, gate_text, structured_hints,
# mode, observed_at) is recovered via a NAMED upstream-node lookup, exactly the pattern
# f04-market-intel's own "Parse categorizer response" node uses (`$('Build preflight
# context').first().json`) for the identical reason.
PARSE_AND_VALIDATE_JS = r"""
// design.md SS4 / thesis-attribute-extractor-agent-*: parse the /v1/responses payload,
// then run the FOUR checks the input spec requires (strict structured output cannot
// express "quotes.X non-null iff X non-null iff X in missing_fields" -- no if/then/allOf
// in strict mode -- so this Code node is the enforcement, not the schema).
const ctx = $('Init run context').first().json;
const resp = $input.first().json;
let parsed = null, rawText = '';
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  rawText = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  parsed = JSON.parse(rawText);
} catch (e) { parsed = null; }

const FIELDS = ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'];
const LEGAL_MISSING = new Set(FIELDS);

function normWs(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }

function groundedIn(quote, gateText, hints) {
  if (quote == null) return true; // null quote is only valid alongside a null value -- checked separately
  const q = normWs(quote);
  if (!q) return false;
  if (normWs(gateText).includes(q)) return true;
  const hintVals = Object.values(hints || {}).filter(v => typeof v === 'string');
  return hintVals.some(v => normWs(v).includes(q));
}

let valid = false;
let extraction = null;

if (parsed && resp.status === 'completed' &&
    parsed.quotes && typeof parsed.quotes === 'object' &&
    Array.isArray(parsed.missing_fields)) {
  const gateText = ctx.gate_text || '';
  const hints = ctx.structured_hints || {};

  // Check 3: missing_fields contains only the 5 legal keys, no duplicates.
  let missing = Array.from(new Set(parsed.missing_fields.filter(f => LEGAL_MISSING.has(f))));

  // Check 4: strip any key outside the schema (defensive -- strict mode + additionalProperties:
  // false at the API level already forbids this, but a validator that trusts the API blindly is
  // no validator).
  const clean = { reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' };
  const quotesClean = {};

  for (const f of FIELDS) {
    let value = Object.prototype.hasOwnProperty.call(parsed, f) ? parsed[f] : null;
    let quote = Object.prototype.hasOwnProperty.call(parsed.quotes, f) ? parsed.quotes[f] : null;

    // Check 1: value===null <=> quotes[f]===null <=> f in missing_fields. Any mismatch
    // demotes to null+missing (never repairs upward -- never synthesizes a value or quote).
    const inMissing = missing.includes(f);
    const stateOk = (value === null) === (quote === null) && (value === null) === inMissing;

    // Check 2: every non-null quote is a contiguous substring of gate_text OR of some
    // structured_hints value (whitespace-normalized).
    const grounded = value === null || groundedIn(quote, gateText, hints);

    if (!stateOk || !grounded) {
      value = null; quote = null;
      if (!missing.includes(f)) missing.push(f);
    }
    clean[f] = value;
    quotesClean[f] = quote;
  }

  clean.quotes = quotesClean;
  clean.missing_fields = missing;
  extraction = clean;
  valid = true;
}

return [{ json: { ...ctx, __extractor_valid: valid, extracted: extraction, __extractor_raw_text: rawText } }];
"""

ALL_NULL_RECORD_JS = r"""
// Retry policy (input-spec.md "Retry policy"): non-conforming JSON -> one re-ask with the
// schema restated -> then treat the run as an all-null record. An all-null record is a
// LEGAL outcome (coverage -> 0 -> insufficient_evidence, D-07), never an error status.
const inp = $json;
if (inp.__extractor_valid) { return [{ json: inp }]; }
const FIELDS = ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'];
const allNull = { reasoning: 'No extractable content: response was not valid after retry.',
  quotes: {}, missing_fields: FIELDS.slice() };
for (const f of FIELDS) { allNull[f] = null; allNull.quotes[f] = null; }
return [{ json: { ...inp, __extractor_valid: true, extracted: allNull } }];
"""

# ============================================================================
# Build the three workflows
# ============================================================================

D0_PREFLIGHT_JS = PG_HELPER_JS + r"""
// design.md SS5.4 "Card preflight, reusing 04's resolution verbatim" -- the ORDER BY is
// load-bearing (a founder card can carry the same application_id too).
const inp = $input.first().json;
const appId = inp.application_id;
if (!appId) throw new Error('f07-db-write: application_id is required');
const app = await pg.call(this, 'GET', `applications?id=eq.${appId}&select=id,company_id`);
if (!app.length) throw new Error('f07-db-write: application not found: ' + appId);
const companyId = app[0].company_id;
let cards = await pg.call(this, 'GET',
  `cards?application_id=eq.${appId}&card_type=eq.company&select=id&order=created_at.asc&limit=1`);
let cardId = cards.length ? cards[0].id : null;
if (!cardId) {
  const made = await pg.call(this, 'POST', 'cards',
    { card_type: 'company', company_id: companyId, application_id: appId, status: 'draft' },
    'return=representation');
  cardId = made[0].id;
}
return [{ json: { ...inp, application_id: appId, company_id: companyId, card_id: cardId } }];
"""

D0_AI_RUN_JS = PG_HELPER_JS + HASHES_BUNDLE + r"""
// design.md SS5.4 row 1: ai_runs IS select-by-input_hash-first, insert only if absent --
// matching lib/f07/run.js's writeAiRun() exactly (the verified reference implementation;
// this generator's earlier "fresh row every attempt" reading of the design's prose was
// wrong and has been corrected against run.js, 2026-07-19).
const inp = $input.first().json;
const gateText = inp.gate_text || '';
const structuredHints = inp.structured_hints || {};
const inputTextHashVal = inputTextHash(gateText);
const inputHashVal = contentHash.aiRun({
  application_id: inp.application_id, input_text_hash: inputTextHashVal,
  prompt_version: inp.prompt_version, model: inp.model,
});
const found = await pg.call(this, 'GET', `ai_runs?input_hash=eq.${inputHashVal}&select=id`);
let aiRunId;
if (found.length) {
  aiRunId = found[0].id;
} else {
  // Corollary (input-spec.md / SS8.3 test 13): the payload written here must contain no
  // thesis field -- D0 never receives one, so this is structurally guaranteed. Recording
  // {input, extraction} (not just extraction) makes that guarantee auditable directly off
  // this row, matching run.js's writeAiRun() shape.
  const rows = await pg.call(this, 'POST', 'ai_runs', {
    task_type: 'thesis_extraction', company_id: inp.company_id, application_id: inp.application_id,
    model: inp.model, prompt_version: inp.prompt_version, input_hash: inputHashVal,
    output_json: { input: { gate_text: gateText || null, structured_hints: structuredHints },
                   extraction: inp.extraction || {} },
    n8n_execution_id: String($execution.id),
  }, 'return=representation');
  aiRunId = rows[0].id;
}
return [{ json: { ...inp, ai_run_id: aiRunId, input_text_hash: inputTextHashVal } }];
"""

D0_RAW_SIGNAL_JS = PG_HELPER_JS + HASHES_BUNDLE + r"""
// design.md SS5.4 row 3: select-by-content_hash first, insert only if absent -- NOT
// ON CONFLICT DO NOTHING, which returns zero rows over PostgREST and would null
// evidence.raw_signal_id (04/design.md :240, the precedent this note is borrowed from).
// Anchored on (application_id, input_text_hash, prompt_version) -- retry-stable
// independent of ai_run_id, per the hash-correction note above.
//
// payload carries BOTH `mode` (matching run.js's writeRawSignal() shape) AND `text`
// (a deliberate divergence from run.js, which never re-reads this row -- run.js is
// full-mode, one-shot, no re-evaluation). f07-thesis-reevaluate (D2) MUST resolve `_text`
// from exactly this stored payload (design.md SS1.1: "the original input is preserved
// there by SS5.4 step 3"), so `text` stays here even though run.js's own narrower scope
// does not need it.
const inp = $input.first().json;
const hash = contentHash.rawSignal({
  application_id: inp.application_id, input_text_hash: inp.input_text_hash,
  prompt_version: inp.prompt_version,
});
let found = await pg.call(this, 'GET', `raw_signals?content_hash=eq.${encodeURIComponent(hash)}&select=id`);
let rawSignalId;
if (found.length) {
  rawSignalId = found[0].id;
} else {
  const made = await pg.call(this, 'POST', 'raw_signals', {
    source: 'deck_parse', source_url: null, payload: { mode: 'full', text: inp.gate_text || '' },
    content_hash: hash, company_id: inp.company_id, founder_id: null,
    observed_at: inp.observed_at, // the gate invocation timestamp, never now() (SS5.4)
  }, 'return=representation');
  rawSignalId = made[0].id;
}
return [{ json: { ...inp, raw_signal_id: rawSignalId } }];
"""

D0_CLAIMS_JS = PG_HELPER_JS + HASHES_BUNDLE + r"""
// design.md SS5.4 row 4 + SS5.4.1 (the company.* prefix 07 owns). Real (non-null)
// attributes: select-by-content_hash first (anchored on raw_signal_id, NOT ai_run_id --
// the hash-correction note). Gaps: BASE topic `company.<field>` (NOT `.gap` suffix --
// team-lead correction, 2026-07-19: design.md SS5.4.1's "*.gap convention" sentence is
// stale; db/fixtures/07-thesis-engine.sql's actual Fogline fixture never used that suffix,
// and lib/f07/run.js's buildClaimPlan()/writeClaimsAndEvidence() follow the fixture's
// convention, which the orchestrator ruled authoritative). Since a gap and a present claim
// can now share the identical topic string across different runs (a field extracted once,
// missing on a later re-extraction, or vice versa), gap dedup is keyed on
// (card_id, topic, source_kind='derived') -- matching run.js exactly -- not on
// content_hash, which stays NULL for a gap ("no underlying raw content to hash",
// schema.sql comment).
const GAP_LABELS = %(GAP_LABELS)s;
const inp = $input.first().json;
const ext = inp.extraction || {};
const quotes = ext.quotes || {};
const missing = new Set(ext.missing_fields || []);
const FIELDS = %(FIELDS5)s;
const claims = {};
for (const f of FIELDS) {
  const topic = 'company.' + f;
  const isMissing = missing.has(f) || ext[f] === null || ext[f] === undefined;
  if (isMissing) {
    const existing = await pg.call(this, 'GET',
      `claims?card_id=eq.${inp.card_id}&topic=eq.${encodeURIComponent(topic)}&source_kind=eq.derived` +
      `&select=id&order=created_at.desc&limit=1`);
    let gapId;
    if (existing.length) {
      gapId = existing[0].id;
    } else {
      const made = await pg.call(this, 'POST', 'claims', {
        card_id: inp.card_id, topic, text_verbatim: GAP_LABELS[f],
        value: null, axis: null, source_kind: 'derived', verification_status: 'missing',
        content_hash: null,
      }, 'return=representation');
      gapId = made[0].id;
    }
    claims[f] = { id: gapId, content_hash: null, is_gap: true };
    continue;
  }
  // design.md SS4 output schema table: text_verbatim = quotes.<f> (the verbatim span --
  // claims.text_verbatim is NOT NULL and a normalized label is not a verbatim span);
  // value = the normalized label, EXCEPT what_is_built, where value = the written summary
  // itself (the one row where the two differ -- the summary is not "word-for-word source
  // text" so it cannot be text_verbatim, but it is exactly what feature 06's memo needs).
  const hash = contentHash.claim({ card_id: inp.card_id, topic, raw_signal_id: inp.raw_signal_id, item_key: '_' });
  const found = await pg.call(this, 'GET', `claims?content_hash=eq.${encodeURIComponent(hash)}&select=id`);
  let claimId;
  if (found.length) {
    claimId = found[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'claims', {
      // base_confidence 0.4: orchestrator ruling (tracker.md task B4) -- not specified in
      // design.md itself, matches lib/f07/run.js's DEFAULT_BASE_CONFIDENCE exactly.
      card_id: inp.card_id, topic, text_verbatim: quotes[f],
      value: ext[f], axis: null, source_kind: 'self_reported', base_confidence: 0.4,
      verification_status: 'unverified', content_hash: hash,
    }, 'return=representation');
    claimId = made[0].id;
  }
  claims[f] = { id: claimId, content_hash: hash, is_gap: false };
}
return [{ json: { ...inp, claims } }];
""" % {"GAP_LABELS": GAP_LABELS_JS, "FIELDS5": json.dumps(FIELDS5)}

D0_EVIDENCE_JS = PG_HELPER_JS + HASHES_BUNDLE + r"""
// design.md SS5.4 row 5: one supporting evidence row per REAL (non-gap) claim --
// (claim_id, relation) is already unique here (07 always writes relation='supports',
// tier='documented', exactly one row per claim), unlike 04's evidence which also
// discriminates on source_url/quote/query to keep multiple tier='missing' rows apart.
// strength 0.9 for tier='documented' (f04's STRENGTH table convention, matched by
// lib/f07/run.js's EVIDENCE_STRENGTH_DOCUMENTED) -- schema.sql's own comment: "Feature 05's
// rollup is f(tier, relation, strength); writing nulls here would degrade it silently
// rather than loudly."
const inp = $input.first().json;
const quotes = (inp.extraction && inp.extraction.quotes) || {};
const FIELDS = %(FIELDS5)s;
let n = 0;
const evidenceIds = {};
for (const f of FIELDS) {
  const c = inp.claims[f];
  if (!c || c.is_gap) continue;
  const hash = contentHash.evidence({ claim_id: c.id, relation: 'supports' });
  const existing = await pg.call(this, 'GET', `evidence?content_hash=eq.${encodeURIComponent(hash)}&select=id`);
  let evId;
  if (existing.length) {
    evId = existing[0].id;
  } else {
    const made = await pg.call(this, 'POST', 'evidence', {
      claim_id: c.id, relation: 'supports', tier: 'documented', strength: 0.9,
      quote_verbatim: quotes[f] || null, source_url: null,
      raw_signal_id: inp.raw_signal_id, content_hash: hash,
    }, 'return=representation');
    evId = made[0].id; n++;
  }
  evidenceIds[f] = evId;
}
return [{ json: { application_id: inp.application_id, company_id: inp.company_id, card_id: inp.card_id,
  ai_run_id: inp.ai_run_id, raw_signal_id: inp.raw_signal_id, claims: inp.claims,
  evidence_ids: evidenceIds, evidence_written: n, extraction: inp.extraction } }];
""" % {"FIELDS5": json.dumps(FIELDS5)}


# ============================================================================
# f07-thesis-gate (D1) -- both modes, the extraction validator, the persistence
# procedure from design.md SS2/SS5/SS6.
# ============================================================================

D1_NORMALIZE_WEBHOOK_JS = r"""
// design.md SS6.1: {application_id, text, mode, structured_hints?}. Webhook wraps the
// body under .body -- same convention as f03-score-founder / f04-market-intel.
const item = $input.first().json;
const body = item.body || {};
const application_id = body.application_id;
if (!application_id) throw new Error('f07-thesis-gate: application_id is required');
return [{ json: {
  application_id,
  mode: body.mode === 'keyword' ? 'keyword' : 'full',
  gate_text: body.text || '',
  structured_hints: (body.structured_hints && typeof body.structured_hints === 'object') ? body.structured_hints : {},
} }];
"""

D1_NORMALIZE_SUBWORKFLOW_JS = r"""
// Called by 08 (intake, mode='full') / 02 (radar Tier 1, mode='keyword') as a sub-workflow
// -- flat item, no .body wrapper.
const item = $input.first().json || {};
const application_id = item.application_id;
if (!application_id) throw new Error('f07-thesis-gate: application_id is required');
return [{ json: {
  application_id,
  mode: item.mode === 'keyword' ? 'keyword' : 'full',
  gate_text: item.text || '',
  structured_hints: (item.structured_hints && typeof item.structured_hints === 'object') ? item.structured_hints : {},
} }];
"""

D1_INIT_CONTEXT_JS = r"""
// design.md SS5.4 / SS6.2: observed_at is captured ONCE here -- "the gate invocation
// timestamp, never now()" -- and threaded through every downstream write so a retry of
// this same run reuses the same value instead of drifting per attempt.
const inp = $input.first().json;
return [{ json: { ...inp, observed_at: new Date().toISOString() } }];
"""

D1_KEYWORD_STUB_JS = r"""
// design.md SS6.1: mode='keyword' makes NO LLM call and touches no card/claims/evidence
// at all -- structured_hints is the ONLY attribute source. Shapes the item so the shared
// trunk below (also fed by the full-mode branch, after f07-db-write) sees the same shape.
const inp = $json;
return [{ json: { ...inp, extracted: null, card_id: null, ai_run_id: null,
  claims: null, evidence_written: 0 } }];
"""

D1_BUILD_DBWRITE_INPUT_JS = (
    "const inp = $json;\n"
    "return [{ json: {\n"
    "  application_id: inp.application_id, gate_text: inp.gate_text, observed_at: inp.observed_at,\n"
    "  extraction: inp.extracted, model: " + json.dumps(MODEL) + ", prompt_version: " + json.dumps(PROMPT_VERSION) + ",\n"
    "} }];\n"
)

D1_RESHAPE_AFTER_DBWRITE_JS = r"""
// n8n-nodes-base.executeWorkflow's output REPLACES $json with the sub-workflow's return
// value -- merge back the pre-extraction context (mode, structured_hints, gate_text,
// observed_at) via a named-node lookup, same pattern as the extractor's response-parsing
// nodes above (and f04-market-intel's "Reshape for sub-call" node).
const ctx = $('Init run context').first().json;
const out = $input.first().json;
return [{ json: { ...ctx, application_id: out.application_id, company_id: out.company_id,
  card_id: out.card_id, ai_run_id: out.ai_run_id, raw_signal_id: out.raw_signal_id,
  claims: out.claims, evidence_written: out.evidence_written, extracted: out.extraction } }];
"""

D1_BUILD_ATTRIBUTES_JS = r"""
// design.md SS6.1: "Hints are merged UNDER extraction output in full mode (a grounded
// extraction wins over a caller's guess) and are the ONLY attribute source in keyword
// mode." geography_region/stage are DERIVED (SS1.1) -- resolveField() in the evaluator
// derives them from geography_country/stage_evidence itself, so only the base fields are
// set here.
const inp = $json;
const GATEABLE = ['sector', 'business_model', 'geography_country', 'stage_evidence'];
const hints = inp.structured_hints || {};
const attributes = {};
const missingFields = [];

if (inp.mode === 'keyword') {
  for (const f of GATEABLE) {
    const v = hints[f];
    if (v !== undefined && v !== null && v !== '') attributes[f] = v;
    else missingFields.push(f);
  }
  attributes.what_is_built = null;
  missingFields.push('what_is_built');
} else {
  const ext = inp.extracted || {};
  for (const f of GATEABLE) {
    if (ext[f] !== null && ext[f] !== undefined) attributes[f] = ext[f];
    else if (hints[f] !== undefined && hints[f] !== null && hints[f] !== '') attributes[f] = hints[f];
    else missingFields.push(f);
  }
  attributes.what_is_built = (ext.what_is_built !== undefined && ext.what_is_built !== null) ? ext.what_is_built : null;
  if (attributes.what_is_built === null) missingFields.push('what_is_built');
}

// _text (SS1.1, QA D4 fix 2026-07-19): `gate_text` VERBATIM, nothing else -- NEVER
// what_is_built or any other derived/paraphrased field folded in. `_text` is the gate's raw
// input specifically so keyword rules catch phrasing the extractor might normalize away;
// folding an LLM paraphrase back in would let a negative keyword be introduced or erased by
// the extractor's own wording, so the gate would react to text the founder never wrote.
// Matches lib/f07/vocabulary.js's synthesize_text(gateText) called with ONLY gate_text (as
// lib/f07/run.js actually calls it) -- the earlier version here (and in
// f07-thesis-reevaluate) called the equivalent of synthesize_text(gateText, whatIsBuilt),
// which is a real second argument that function accepts but that no correct caller passes.
attributes._text = (typeof inp.gate_text === 'string' && inp.gate_text.trim().length > 0)
  ? inp.gate_text.trim() : null;
if (attributes._text === null) missingFields.push('_text');

return [{ json: { ...inp, attributes, missing_fields: missingFields } }];
"""

D1_RESOLVE_CONTRADICTED_JS = PG_HELPER_JS + r"""
// design.md D-03 / SS6.1's caller obligation ("missing_fields is the caller's
// responsibility, not the evaluator's... Stage D owns this"): folds any company.* claim
// already flipped to verification_status='contradicted' into missing_fields BEFORE
// evaluation, for BOTH modes -- an application gated once (full mode) can have a claim
// contradicted by feature 05 before a LATER keyword-mode or full-mode re-gate; skipping
// this would let a disproven attribute still fire a hard rule.
const inp = $json;
let cardId = inp.card_id || null;
if (!cardId) {
  const cards = await pgGet.call(this,
    `cards?application_id=eq.${inp.application_id}&card_type=eq.company&select=id&order=created_at.asc&limit=1`);
  cardId = cards.length ? cards[0].id : null;
}
let contradictedFields = [];
if (cardId) {
  const rows = await pgGet.call(this,
    `claims?card_id=eq.${cardId}&topic=like.company.*&verification_status=eq.contradicted&select=topic`);
  // Gap claims are never verification_status='contradicted' (only 'missing'), so this
  // query only ever matches base-topic REAL claims -- no `.gap`-suffix stripping needed
  // (topic naming corrected 2026-07-19: gaps use the base `company.<field>` topic).
  contradictedFields = rows.map(r => (r.topic || '').replace(/^company\./, '')).filter(Boolean);
}
const missingFields = Array.from(new Set([...(inp.missing_fields || []), ...contradictedFields]));
return [{ json: { ...inp, missing_fields: missingFields } }];
"""

D1_LOAD_DEFAULT_THESIS_JS = PG_HELPER_JS + r"""
// design.md SS7: the gate loads the (is_default AND active) thesis. The gate cannot run
// without one -- the seed + uq_theses_single_default guarantee exactly one such row.
const rows = await pgGet.call(this, 'theses?is_default=eq.true&active=eq.true&select=id,name,config,version&limit=1');
if (!rows.length) throw new Error('f07-thesis-gate: no default active thesis found (is_default AND active)');
const inp = $json;
return [{ json: { ...inp, thesis_id: rows[0].id, thesis_version: rows[0].version, thesis_config: rows[0].config } }];
"""

D1_EVALUATE_JS = EVALUATOR_BUNDLE + r"""
const inp = $json;
const FIELDS5 = %(FIELDS5)s;
const config = inp.thesis_config || {};
const result = evaluateThesis({ config, attributes: inp.attributes, missingFields: inp.missing_fields, mode: inp.mode });

// input_fingerprint (SS5.1) = sha256(sorted CONTRIBUTING claim content_hashes ‖
// thesis_config_snapshot hash). "Contributing" = a field NOT in missing_fields (a real,
// trusted observation feeding `attributes`) -- a claim that flipped to contradicted drops
// out of this set, which is what gives a re-evaluation a naturally new fingerprint without
// a version bump (SS8.3 item 12). Keyword mode never writes claims at all (SS6.1), so
// design.md leaves this mode's fingerprint ingredient unspecified: this file's choice is to
// hash the (gate_text, structured_hints) pair as the stand-in "contributing evidence",
// giving the identical retry-stability property (same hints+text -> same fingerprint ->
// dedup) without inventing claim rows that were never written.
let contributingHashes = [];
if (inp.mode === 'keyword') {
  contributingHashes = [ sha256Hex(stableStringify({
    gate_text: normalizeText(inp.gate_text || ''), structured_hints: inp.structured_hints || {} })) ];
} else {
  contributingHashes = FIELDS5
    .filter(f => !(inp.missing_fields || []).includes(f))
    .map(f => (inp.claims && inp.claims[f] && inp.claims[f].content_hash) || null)
    .filter(Boolean);
}
const fingerprint = inputFingerprint({ claimContentHashes: contributingHashes, thesisConfigSnapshot: config });

return [{ json: { ...inp,
  fired_rules: result.fired_rules, total: result.total, earned: result.earned,
  penalty: result.penalty, fit: result.fit, coverage: result.coverage, verdict: result.verdict,
  input_fingerprint: fingerprint, thesis_config_snapshot: config,
} }];
""" % {"FIELDS5": json.dumps(FIELDS5)}

D1_CHECK_EXISTING_EVAL_JS = PG_HELPER_JS + r"""
// design.md SS5.1: UNIQUE (application_id, thesis_id, input_fingerprint) -- select first,
// insert only if absent (SS6.2's unconditional-retry rule: a retry must converge, not
// duplicate or 23505).
const inp = $json;
const rows = await pgGet.call(this,
  `thesis_evaluations?application_id=eq.${inp.application_id}&thesis_id=eq.${inp.thesis_id}` +
  `&input_fingerprint=eq.${encodeURIComponent(inp.input_fingerprint)}&select=id,score_id,verdict&limit=1`);
return [{ json: { ...inp, existing_evaluation: rows.length ? rows[0] : null } }];
"""

D1_USE_EXISTING_EVAL_JS = r"""
// design.md SS6.2: "found existing never means nothing left to do" -- reuse the prior
// evaluation's id/score_id/verdict, but STILL fall through (below) to the
// applications-cache write, which is exactly the resume scenario the design calls out: a
// run that died after writing thesis_evaluations but before the cache write must not leave
// the application permanently invisible in every feed lane.
const inp = $json;
const ex = inp.existing_evaluation;
return [{ json: { ...inp, evaluation_id: ex.id, score_id: ex.score_id || null, verdict: ex.verdict } }];
"""

D1_DECIDE_SCORES_JS = r"""
// design.md SS2's persistence table: scores(thesis_fit) is written for every verdict
// EXCEPT insufficient_evidence, and except a keyword-mode borderline (SS6.1: "keyword-mode
// rows persist exactly like insufficient_evidence... failed is the one verdict that still
// persists normally"). Keyword mode can only ever resolve to 'failed' or 'borderline'
// (computeVerdict() never returns passed/insufficient_evidence there), so this is exactly:
// write unless insufficient_evidence, or (keyword AND borderline).
const inp = $json;
const writeScores = inp.verdict !== 'insufficient_evidence' &&
  !(inp.mode === 'keyword' && inp.verdict === 'borderline');
return [{ json: { ...inp, write_scores: writeScores } }];
"""

D1_WRITE_SCORES_JS = (
    PG_HELPER_JS +
    "// design.md SS5.3: 07 is the sole writer of axis='thesis_fit'; is_screening_axis=false\n"
    "// (invariant #1: never blended with the three screening axes).\n"
    "//\n"
    "// QA E1b item 11 fix (2026-07-19, gate-blocker): scores has no unique constraint\n"
    "// (design.md), so 'Check existing evaluation' upstream (keyed on thesis_evaluations)\n"
    "// cannot catch a crash that happens AFTER this node succeeds but BEFORE 'Write\n"
    "// thesis_evaluations' runs -- on retry, thesis_evaluations still does not exist, so the\n"
    "// same branch is taken again and an ORPHANED second scores row was minted that no\n"
    "// evaluation would ever reference. This node is now select-first like every other write\n"
    "// in the pipeline: the fingerprint is embedded in missing_flags (the only place this\n"
    "// value can live without a schema change) and checked BEFORE inserting.\n"
    "//\n"
    "// KEY NAMED `_f07_input_fingerprint`, not `input_fingerprint` (team-lead ruling,\n"
    "// 2026-07-19): missing_flags has a documented cross-feature meaning -- feature 01 defines\n"
    "// it as \"what was absent when this was computed\" (REQ-003), and 05/06/09 read it to\n"
    "// render what the system did NOT know. A bare `input_fingerprint` key would eventually be\n"
    "// rendered to an investor as a missing data point, or counted in a gap tally -- a\n"
    "// cross-feature hazard planted in a field this workflow does not own. The leading `_` is\n"
    "// the mechanical rule: ANY key prefixed `_` in missing_flags is writer-internal plumbing\n"
    "// and MUST NOT be rendered as a missing-data signal by any consumer.\n"
    "const inp = $json;\n"
    "const FIELDS5 = " + json.dumps(FIELDS5) + ";\n"
    "const claimIds = FIELDS5.map(f => (inp.claims && inp.claims[f] && !inp.claims[f].is_gap) ? inp.claims[f].id : null).filter(Boolean);\n"
    "const existing = await pg.call(this, 'GET',\n"
    "  `scores?application_id=eq.${inp.application_id}&thesis_id=eq.${inp.thesis_id}&axis=eq.thesis_fit` +\n"
    "  `&select=id,missing_flags&order=computed_at.desc`);\n"
    "const match = existing.find(r => r.missing_flags && r.missing_flags._f07_input_fingerprint === inp.input_fingerprint);\n"
    "let scoreId;\n"
    "if (match) {\n"
    "  scoreId = match.id;\n"
    "} else {\n"
    "  const row = await pg.call(this, 'POST', 'scores', {\n"
    "    application_id: inp.application_id, founder_id: null, axis: 'thesis_fit',\n"
    "    value: inp.fit, trend: null, confidence: inp.coverage,\n"
    "    missing_flags: { missing_fields: inp.missing_fields || [], _f07_input_fingerprint: inp.input_fingerprint },\n"
    "    input_claim_ids: claimIds,\n"
    "    formula_version: " + json.dumps(FORMULA_VERSION) + ",\n"
    "    prompt_version: inp.mode === 'full' ? " + json.dumps(PROMPT_VERSION) + " : null,\n"
    "    model: inp.mode === 'full' ? " + json.dumps(MODEL) + " : null,\n"
    "    thesis_id: inp.thesis_id,\n"
    "  }, 'return=representation');\n"
    "  scoreId = row[0].id;\n"
    "}\n"
    "return [{ json: { ...inp, score_id: scoreId } }];\n"
)

D1_NO_SCORES_JS = r"""
const inp = $json;
return [{ json: { ...inp, score_id: null } }];
"""

D1_WRITE_THESIS_EVAL_JS = (
    PG_HELPER_JS +
    "// design.md SS5.1 -- append-only decision receipt; score_id set only when a scores\n"
    "// row was actually written above.\n"
    "const inp = $json;\n"
    "const row = await pg.call(this, 'POST', 'thesis_evaluations', {\n"
    "  application_id: inp.application_id, thesis_id: inp.thesis_id, thesis_version: inp.thesis_version,\n"
    "  input_fingerprint: inp.input_fingerprint, evaluation_mode: inp.mode, verdict: inp.verdict,\n"
    "  score_id: inp.score_id, fired_rules: inp.fired_rules,\n"
    "  extracted_snapshot: { mode: inp.mode, attributes: inp.attributes, missing_fields: inp.missing_fields,\n"
    "    structured_hints: inp.structured_hints, extraction: inp.extracted || null },\n"
    "  thesis_config_snapshot: inp.thesis_config_snapshot, missing_fields: inp.missing_fields,\n"
    "  coverage: inp.coverage, extraction_ai_run_id: inp.ai_run_id || null,\n"
    "  formula_version: " + json.dumps(FORMULA_VERSION) + ",\n"
    "}, 'return=representation');\n"
    "return [{ json: { ...inp, evaluation_id: row[0].id } }];\n"
)

D1_WRITE_APPLICATIONS_CACHE_JS = PG_HELPER_JS + r"""
// design.md SS6.3: applications.thesis_gate/thesis_id are a CACHE of the current verdict,
// re-written on every evaluation (never "never UPDATEs" -- that claim, in rev.1, could not
// coexist with "pointer to current state"). D-05: NULL is an actual WRITE on
// insufficient_evidence, not a skip.
const inp = $json;
await pg.call(this, 'PATCH', `applications?id=eq.${inp.application_id}`, {
  thesis_id: inp.thesis_id,
  thesis_gate: inp.verdict === 'insufficient_evidence' ? null : inp.verdict,
}, 'return=minimal');
return [{ json: inp }];
"""

D1_WRITE_EVENTS_JS = PG_HELPER_JS + r"""
// design.md SS2 persistence table: insufficient_evidence is the ONLY verdict that gets an
// events row (SS8.5 TRACKER note: 02 needs this, plus the thesis_gate=NULL notice).
const inp = $json;
await pg.call(this, 'POST', 'events', {
  event_type: 'thesis_gate_insufficient_evidence', entity_type: 'application', entity_id: inp.application_id,
  payload: { thesis_id: inp.thesis_id, coverage: inp.coverage, missing_fields: inp.missing_fields || [] },
  actor: 'f07-thesis-gate',
}, 'return=minimal');
return [{ json: inp }];
"""

D1_BUILD_OUTPUT_JS = r"""
// design.md SS6.1's return contract: {verdict, fit, coverage, fired_rules, missing_fields}
// -- plus enough identifiers (application_id, thesis_id, evaluation_id) for the caller to
// cross-reference without a second read.
const inp = $json;
return [{ json: {
  application_id: inp.application_id, thesis_id: inp.thesis_id, evaluation_id: inp.evaluation_id || null,
  mode: inp.mode, verdict: inp.verdict, fit: inp.fit, coverage: inp.coverage,
  fired_rules: inp.fired_rules, missing_fields: inp.missing_fields || [],
} }];
"""


def build_d1():
    nodes = []

    webhook = {
        "parameters": {"httpMethod": "POST", "path": "f07-thesis-gate", "responseMode": "lastNode", "options": {}},
        "id": nid(), "name": "Webhook Trigger", "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [-1120, -160], "webhookId": nid(),
    }
    exec_trigger = {
        "parameters": {}, "id": nid(), "name": "Execute Workflow Trigger",
        "type": "n8n-nodes-base.executeWorkflowTrigger", "typeVersion": 1, "position": [-1120, 160],
    }
    norm_webhook = code_node("Normalize Webhook Input", D1_NORMALIZE_WEBHOOK_JS, -880, -160)
    norm_sub = code_node("Normalize Sub-workflow Input", D1_NORMALIZE_SUBWORKFLOW_JS, -880, 160)
    init_ctx = code_node("Init run context", D1_INIT_CONTEXT_JS, -640, 0)
    nodes += [webhook, exec_trigger, norm_webhook, norm_sub, init_ctx]

    if_keyword = if_node("IF: mode = keyword", "={{ $json.mode }}", "keyword", "string", "equals", -400, 0)
    nodes.append(if_keyword)

    # ---- keyword branch (TRUE) --------------------------------------------
    keyword_stub = code_node("Keyword: build extraction stub", D1_KEYWORD_STUB_JS, -160, -300)
    nodes.append(keyword_stub)

    # ---- full branch (FALSE): LLM extractor + validator + retry + f07-db-write --------
    build_request1 = code_node("Build extractor request", build_extractor_request_js(retry=False), -160, 60)
    llm_call = openai_extractor_node("OpenAI: thesis-attribute-extractor (luna)", 80, 60)
    parse1 = code_node("Parse extractor response", PARSE_AND_VALIDATE_JS, 320, 60)
    if_valid = if_node("IF: extractor response valid?", "={{ $json.__extractor_valid }}", True, "boolean", "equals", 560, 60)
    build_request2 = code_node("Build extractor retry request", build_extractor_request_js(retry=True), 800, 220)
    llm_retry = openai_extractor_node("OpenAI retry: thesis-attribute-extractor (luna)", 1040, 220)
    parse2 = code_node("Parse retry response", PARSE_AND_VALIDATE_JS, 1280, 220)
    finalize = code_node("Finalize extraction (all-null fallback)", ALL_NULL_RECORD_JS, 1520, 60)
    build_dbwrite_input = code_node("Build f07-db-write input", D1_BUILD_DBWRITE_INPUT_JS, 1760, 60)
    call_dbwrite = {
        "parameters": {"source": "database", "workflowId": {"__rl": True, "value": D0_WORKFLOW_ID, "mode": "id"}, "options": {}},
        "id": nid(), "name": "Call f07-db-write", "type": "n8n-nodes-base.executeWorkflow",
        "typeVersion": 1.2, "position": [2000, 60],
        "notes": "Calls f07-db-write (D0) -- its own hash recipes, NOT f04-db-write's; "
                 "see this build script's module docstring for why.",
    }
    reshape_after_dbwrite = code_node("Reshape after f07-db-write", D1_RESHAPE_AFTER_DBWRITE_JS, 2240, 60)
    nodes += [build_request1, llm_call, parse1, if_valid, build_request2, llm_retry, parse2, finalize,
              build_dbwrite_input, call_dbwrite, reshape_after_dbwrite]

    # ---- shared trunk (fan-in: keyword_stub + reshape_after_dbwrite) ------------------
    build_attrs = code_node("Build attributes for evaluation", D1_BUILD_ATTRIBUTES_JS, 2180, 0)
    resolve_contra = code_node("Resolve contradicted claims", D1_RESOLVE_CONTRADICTED_JS, 2420, 0)
    load_thesis = code_node("Load default thesis", D1_LOAD_DEFAULT_THESIS_JS, 2660, 0)
    evaluate = code_node("Evaluate thesis", D1_EVALUATE_JS, 2900, 0,
                          notes="SOURCE OF TRUTH: lib/f07/{vocabulary,rules,hashes}.js -- do not edit here, "
                                "edit there and re-run n8n/build-f07-workflow.py.")
    check_existing = code_node("Check existing evaluation", D1_CHECK_EXISTING_EVAL_JS, 3140, 0)
    if_exists = if_node("IF: evaluation already exists?", "={{ !!$json.existing_evaluation }}", True, "boolean", "equals", 3380, 0)
    nodes += [build_attrs, resolve_contra, load_thesis, evaluate, check_existing, if_exists]

    use_existing = code_node("Use existing evaluation", D1_USE_EXISTING_EVAL_JS, 3620, -220)
    decide_scores = code_node("Decide scores write", D1_DECIDE_SCORES_JS, 3620, 140)
    if_write_scores = if_node("IF: write scores?", "={{ $json.write_scores }}", True, "boolean", "equals", 3860, 140)
    write_scores = code_node("Write scores (thesis_fit)", D1_WRITE_SCORES_JS, 4100, 20)
    no_scores = code_node("No scores row", D1_NO_SCORES_JS, 4100, 260)
    write_eval = code_node("Write thesis_evaluations", D1_WRITE_THESIS_EVAL_JS, 4340, 140)
    write_cache = code_node("Write applications cache", D1_WRITE_APPLICATIONS_CACHE_JS, 4580, -40)
    nodes += [use_existing, decide_scores, if_write_scores, write_scores, no_scores, write_eval, write_cache]

    if_insufficient = if_node("IF: verdict = insufficient_evidence?", "={{ $json.verdict }}", "insufficient_evidence",
                               "string", "equals", 4820, -40)
    write_events = code_node("Write events (insufficient_evidence)", D1_WRITE_EVENTS_JS, 5060, -180)
    build_output = code_node("Build output contract", D1_BUILD_OUTPUT_JS, 5300, -40)
    nodes += [if_insufficient, write_events, build_output]

    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Execute Workflow Trigger", 0, "Normalize Sub-workflow Input", 0),
            ("Normalize Webhook Input", 0, "Init run context", 0),
            ("Normalize Sub-workflow Input", 0, "Init run context", 0),
            ("Init run context", 0, "IF: mode = keyword", 0),
        ),
        # IF v2: output 0 = true, output 1 = false
        {"IF: mode = keyword": {"main": [
            [{"node": "Keyword: build extraction stub", "type": "main", "index": 0}],
            [{"node": "Build extractor request", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build extractor request", 0, "OpenAI: thesis-attribute-extractor (luna)", 0),
            ("OpenAI: thesis-attribute-extractor (luna)", 0, "Parse extractor response", 0),
            ("Parse extractor response", 0, "IF: extractor response valid?", 0),
        ),
        {"IF: extractor response valid?": {"main": [
            [{"node": "Finalize extraction (all-null fallback)", "type": "main", "index": 0}],
            [{"node": "Build extractor retry request", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build extractor retry request", 0, "OpenAI retry: thesis-attribute-extractor (luna)", 0),
        ),
        connect(
            ("OpenAI retry: thesis-attribute-extractor (luna)", 0, "Parse retry response", 0),
            ("Parse retry response", 0, "Finalize extraction (all-null fallback)", 0),
            ("Finalize extraction (all-null fallback)", 0, "Build f07-db-write input", 0),
            ("Build f07-db-write input", 0, "Call f07-db-write", 0),
            ("Call f07-db-write", 0, "Reshape after f07-db-write", 0),
            ("Keyword: build extraction stub", 0, "Build attributes for evaluation", 0),
            ("Reshape after f07-db-write", 0, "Build attributes for evaluation", 0),
            ("Build attributes for evaluation", 0, "Resolve contradicted claims", 0),
            ("Resolve contradicted claims", 0, "Load default thesis", 0),
            ("Load default thesis", 0, "Evaluate thesis", 0),
            ("Evaluate thesis", 0, "Check existing evaluation", 0),
            ("Check existing evaluation", 0, "IF: evaluation already exists?", 0),
        ),
        {"IF: evaluation already exists?": {"main": [
            [{"node": "Use existing evaluation", "type": "main", "index": 0}],
            [{"node": "Decide scores write", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Decide scores write", 0, "IF: write scores?", 0),
        ),
        {"IF: write scores?": {"main": [
            [{"node": "Write scores (thesis_fit)", "type": "main", "index": 0}],
            [{"node": "No scores row", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Write scores (thesis_fit)", 0, "Write thesis_evaluations", 0),
            ("No scores row", 0, "Write thesis_evaluations", 0),
            ("Write thesis_evaluations", 0, "Write applications cache", 0),
            ("Use existing evaluation", 0, "Write applications cache", 0),
            ("Write applications cache", 0, "IF: verdict = insufficient_evidence?", 0),
        ),
        {"IF: verdict = insufficient_evidence?": {"main": [
            [{"node": "Write events (insufficient_evidence)", "type": "main", "index": 0}],
            [{"node": "Build output contract", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Write events (insufficient_evidence)", 0, "Build output contract", 0),
        ),
    )

    return {
        "name": "f07-thesis-gate", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# f07-thesis-reevaluate (D2) -- does NOT re-extract; reads current claims; contradicted ->
# unknown; writes new rows only. Reuses D1's evaluate/persist segment verbatim (same
# generically-named $json fields), since design.md SS2's persistence procedure is identical
# once `attributes` / `missing_fields` / `thesis_config` are in hand -- only how they get
# there differs (current claims vs a fresh extraction).
# ============================================================================

D2_NORMALIZE_WEBHOOK_JS = r"""
// design.md SS6.1: f07-thesis-reevaluate does NOT re-extract; reads current claims,
// evaluates against a GIVEN thesis version. thesis_id is optional -- absent means "the
// current default thesis" (NotebookLM's named workflow: "resurface deals we qualified out
// in the past" most naturally re-runs against the fund's current mandate).
const item = $input.first().json;
const body = item.body || {};
const application_id = body.application_id;
if (!application_id) throw new Error('f07-thesis-reevaluate: application_id is required');
return [{ json: { application_id, thesis_id: body.thesis_id || null } }];
"""

D2_NORMALIZE_SUBWORKFLOW_JS = r"""
const item = $input.first().json || {};
const application_id = item.application_id;
if (!application_id) throw new Error('f07-thesis-reevaluate: application_id is required');
return [{ json: { application_id, thesis_id: item.thesis_id || null } }];
"""

D2_LOAD_SPECIFIED_THESIS_JS = PG_HELPER_JS + r"""
const inp = $json;
const rows = await pgGet.call(this, `theses?id=eq.${inp.thesis_id}&select=id,name,config,version,active`);
return [{ json: { ...inp, __thesis_rows: rows } }];
"""

D2_LOAD_DEFAULT_THESIS_JS = PG_HELPER_JS + r"""
// design.md SS7: falls back to the (is_default AND active) thesis when the caller supplied
// none.
const inp = $json;
const rows = await pgGet.call(this, 'theses?is_default=eq.true&active=eq.true&select=id,name,config,version&limit=1');
return [{ json: { ...inp, __thesis_rows: rows } }];
"""

D2_REQUIRE_THESIS_JS = r"""
const inp = $json;
const rows = inp.__thesis_rows || [];
if (!rows.length) {
  throw new Error('f07-thesis-reevaluate: thesis not found' +
    (inp.thesis_id ? ` (id=${inp.thesis_id})` : ' (no default active thesis)'));
}
return [{ json: { application_id: inp.application_id, thesis_id: rows[0].id,
  thesis_version: rows[0].version, thesis_config: rows[0].config } }];
"""

D2_RESOLVE_CARD_JS = PG_HELPER_JS + r"""
const inp = $json;
const cards = await pgGet.call(this,
  `cards?application_id=eq.${inp.application_id}&card_type=eq.company&select=id&order=created_at.asc&limit=1`);
return [{ json: { ...inp, card_id: cards.length ? cards[0].id : null } }];
"""

D2_FETCH_CLAIMS_JS = PG_HELPER_JS + r"""
// design.md SS6.1: reads CURRENT claims (embedding evidence -> raw_signals so `_text` can
// resolve from the ORIGINAL gate input, per SS1.1 -- never a concatenation of claims).
const inp = $json;
const rows = await pgGet.call(this,
  `claims?card_id=eq.${inp.card_id}&topic=like.company.*` +
  `&select=id,topic,value,verification_status,source_kind,content_hash,created_at,` +
  `evidence(raw_signal_id,raw_signals(payload,created_at))`);
return [{ json: { ...inp, current_claims: rows } }];
"""

D2_NO_CLAIMS_JS = r"""
// This application was never gated (no card exists) -- a legitimate degenerate case, not
// an error: every attribute is unknown, coverage -> 0 -> insufficient_evidence (D-07).
const inp = $json;
return [{ json: { ...inp, current_claims: [] } }];
"""

D2_BUILD_ATTRIBUTES_JS = r"""
// design.md SS6.1: re-evaluation reads CURRENT claims, never a frozen snapshot --
// corrections arrive via feature 05's contradicts/supersedes mechanism, and reflecting
// what we now know is the point. A `contradicted` claim is treated as `unknown` (D-03),
// identically to a `missing` gap claim -- "a contradicted attribute is precisely 'we do
// not reliably know this'".
const inp = $json;
const FIELDS = ['sector', 'business_model', 'geography_country', 'stage_evidence', 'what_is_built'];
const GATEABLE = ['sector', 'business_model', 'geography_country', 'stage_evidence'];
// Topic is the BASE `company.<field>` for BOTH a present claim and a gap claim (topic
// naming corrected 2026-07-19 -- no `.gap` suffix ever existed to key off). A present row
// and a gap row can therefore share the identical topic string across different runs (a
// field extracted once, missing on a later re-extraction, or vice versa) -- gap-ness is
// read from `verification_status`/`source_kind`, never from the topic string, matching
// lib/f07/run.js's writeClaimsAndEvidence() convention.
const byField = {};
for (const c of (inp.current_claims || [])) {
  const field = (c.topic || '').startsWith('company.') ? (c.topic || '').slice('company.'.length) : null;
  if (!field || !FIELDS.includes(field)) continue;
  const existing = byField[field];
  if (!existing || new Date(c.created_at) > new Date(existing.created_at)) {
    byField[field] = c;
  }
}

const attributes = {};
const missingFields = [];
const claims = {};
function isUsable(c) {
  return c && c.verification_status !== 'missing' && c.verification_status !== 'contradicted' && c.source_kind !== 'derived';
}
for (const f of GATEABLE) {
  const c = byField[f];
  if (isUsable(c)) attributes[f] = c.value; else missingFields.push(f);
  claims[f] = c ? { content_hash: c.content_hash || null } : null;
}
const wib = byField.what_is_built;
attributes.what_is_built = isUsable(wib) ? wib.value : null;
if (attributes.what_is_built === null) missingFields.push('what_is_built');
claims.what_is_built = wib ? { content_hash: wib.content_hash || null } : null;

// _text (SS1.1, corrected 2026-07-19): resolves from the MOST RECENT raw_signals row for
// this application that actually CARRIES a `text` key in its payload -- not just "the
// stored payload", which assumed a single row. Multiple raw_signals rows legitimately
// accumulate per application (one per gate call with different input text), including
// legacy rows from before this fix that carry only {mode}, no text at all. A row without
// a `text` key is SKIPPED, never treated as empty text: an empty _text would make every
// keyword rule evaluate `no_match` -- "no negative keyword found" -- which is a conclusion
// drawn from text this re-evaluation never actually saw. If no row anywhere carries text,
// _text stays absent -> every _text rule evaluates `unknown` (D-03), never a miss.
const rawSignalsById = new Map();
for (const c of (inp.current_claims || [])) {
  for (const ev of (c.evidence || [])) {
    const rs = ev.raw_signals;
    if (rs && ev.raw_signal_id && !rawSignalsById.has(ev.raw_signal_id)) {
      rawSignalsById.set(ev.raw_signal_id, rs);
    }
  }
}
const rawSignalsWithText = Array.from(rawSignalsById.values())
  .filter(rs => rs.payload && Object.prototype.hasOwnProperty.call(rs.payload, 'text'))
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
const gateText = rawSignalsWithText.length ? rawSignalsWithText[0].payload.text : null;
// QA D4 fix, 2026-07-19: _text is gate_text VERBATIM, never what_is_built folded in (see
// f07-thesis-gate's identical fix for the full rationale -- the same defect existed here).
attributes._text = (typeof gateText === 'string' && gateText.trim().length > 0) ? gateText.trim() : null;
if (attributes._text === null) missingFields.push('_text');

return [{ json: { application_id: inp.application_id, thesis_id: inp.thesis_id,
  thesis_version: inp.thesis_version, thesis_config: inp.thesis_config, mode: 'full',
  attributes, missing_fields: missingFields, claims, ai_run_id: null, extracted: null,
  structured_hints: {}, gate_text: gateText } }];
"""


def build_d2():
    nodes = []

    webhook = {
        "parameters": {"httpMethod": "POST", "path": "f07-thesis-reevaluate", "responseMode": "lastNode", "options": {}},
        "id": nid(), "name": "Webhook Trigger", "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [-1120, -140], "webhookId": nid(),
    }
    exec_trigger = {
        "parameters": {}, "id": nid(), "name": "Execute Workflow Trigger",
        "type": "n8n-nodes-base.executeWorkflowTrigger", "typeVersion": 1, "position": [-1120, 140],
    }
    norm_webhook = code_node("Normalize Webhook Input", D2_NORMALIZE_WEBHOOK_JS, -880, -140)
    norm_sub = code_node("Normalize Sub-workflow Input", D2_NORMALIZE_SUBWORKFLOW_JS, -880, 140)
    nodes += [webhook, exec_trigger, norm_webhook, norm_sub]

    if_thesis = if_node("IF: thesis_id provided?", "={{ !!$json.thesis_id }}", True, "boolean", "equals", -640, 0)
    load_specified = code_node("Load specified thesis", D2_LOAD_SPECIFIED_THESIS_JS, -400, -160)
    load_default = code_node("Load default thesis", D2_LOAD_DEFAULT_THESIS_JS, -400, 160)
    require_thesis = code_node("Require thesis found", D2_REQUIRE_THESIS_JS, -160, 0)
    nodes += [if_thesis, load_specified, load_default, require_thesis]

    resolve_card = code_node("Resolve card", D2_RESOLVE_CARD_JS, 80, 0)
    if_card = if_node("IF: card exists?", "={{ !!$json.card_id }}", True, "boolean", "equals", 320, 0)
    fetch_claims = code_node("Fetch current claims", D2_FETCH_CLAIMS_JS, 560, -160)
    no_claims = code_node("No claims (never gated)", D2_NO_CLAIMS_JS, 560, 160)
    nodes += [resolve_card, if_card, fetch_claims, no_claims]

    build_attrs = code_node("Build attributes from current claims", D2_BUILD_ATTRIBUTES_JS, 800, 0)
    evaluate = code_node("Evaluate thesis", D1_EVALUATE_JS, 1040, 0,
                          notes="SOURCE OF TRUTH: lib/f07/{vocabulary,rules,hashes}.js -- do not edit here, "
                                "edit there and re-run n8n/build-f07-workflow.py.")
    check_existing = code_node("Check existing evaluation", D1_CHECK_EXISTING_EVAL_JS, 1280, 0)
    if_exists = if_node("IF: evaluation already exists?", "={{ !!$json.existing_evaluation }}", True, "boolean", "equals", 1520, 0)
    nodes += [build_attrs, evaluate, check_existing, if_exists]

    use_existing = code_node("Use existing evaluation", D1_USE_EXISTING_EVAL_JS, 1760, -220)
    decide_scores = code_node("Decide scores write", D1_DECIDE_SCORES_JS, 1760, 140)
    if_write_scores = if_node("IF: write scores?", "={{ $json.write_scores }}", True, "boolean", "equals", 2000, 140)
    write_scores = code_node("Write scores (thesis_fit)", D1_WRITE_SCORES_JS, 2240, 20)
    no_scores = code_node("No scores row", D1_NO_SCORES_JS, 2240, 260)
    write_eval = code_node("Write thesis_evaluations", D1_WRITE_THESIS_EVAL_JS, 2480, 140)
    write_cache = code_node("Write applications cache", D1_WRITE_APPLICATIONS_CACHE_JS, 2720, -40)
    nodes += [use_existing, decide_scores, if_write_scores, write_scores, no_scores, write_eval, write_cache]

    if_insufficient = if_node("IF: verdict = insufficient_evidence?", "={{ $json.verdict }}", "insufficient_evidence",
                               "string", "equals", 2960, -40)
    write_events = code_node("Write events (insufficient_evidence)", D1_WRITE_EVENTS_JS, 3200, -180)
    build_output = code_node("Build output contract", D1_BUILD_OUTPUT_JS, 3440, -40)
    nodes += [if_insufficient, write_events, build_output]

    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Execute Workflow Trigger", 0, "Normalize Sub-workflow Input", 0),
            ("Normalize Webhook Input", 0, "IF: thesis_id provided?", 0),
            ("Normalize Sub-workflow Input", 0, "IF: thesis_id provided?", 0),
        ),
        {"IF: thesis_id provided?": {"main": [
            [{"node": "Load specified thesis", "type": "main", "index": 0}],
            [{"node": "Load default thesis", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Load specified thesis", 0, "Require thesis found", 0),
            ("Load default thesis", 0, "Require thesis found", 0),
            ("Require thesis found", 0, "Resolve card", 0),
            ("Resolve card", 0, "IF: card exists?", 0),
        ),
        {"IF: card exists?": {"main": [
            [{"node": "Fetch current claims", "type": "main", "index": 0}],
            [{"node": "No claims (never gated)", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Fetch current claims", 0, "Build attributes from current claims", 0),
            ("No claims (never gated)", 0, "Build attributes from current claims", 0),
            ("Build attributes from current claims", 0, "Evaluate thesis", 0),
            ("Evaluate thesis", 0, "Check existing evaluation", 0),
            ("Check existing evaluation", 0, "IF: evaluation already exists?", 0),
        ),
        {"IF: evaluation already exists?": {"main": [
            [{"node": "Use existing evaluation", "type": "main", "index": 0}],
            [{"node": "Decide scores write", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Decide scores write", 0, "IF: write scores?", 0),
        ),
        {"IF: write scores?": {"main": [
            [{"node": "Write scores (thesis_fit)", "type": "main", "index": 0}],
            [{"node": "No scores row", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Write scores (thesis_fit)", 0, "Write thesis_evaluations", 0),
            ("No scores row", 0, "Write thesis_evaluations", 0),
            ("Write thesis_evaluations", 0, "Write applications cache", 0),
            ("Use existing evaluation", 0, "Write applications cache", 0),
            ("Write applications cache", 0, "IF: verdict = insufficient_evidence?", 0),
        ),
        {"IF: verdict = insufficient_evidence?": {"main": [
            [{"node": "Write events (insufficient_evidence)", "type": "main", "index": 0}],
            [{"node": "Build output contract", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Write events (insufficient_evidence)", 0, "Build output contract", 0),
        ),
    )

    return {
        "name": "f07-thesis-reevaluate", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


def build_d0():
    nodes = [
        {"parameters": {}, "id": "trigger", "name": "When Executed by Another Workflow",
         "type": "n8n-nodes-base.executeWorkflowTrigger", "typeVersion": 1, "position": [0, 0]},
        code_node("Preflight: resolve card", D0_PREFLIGHT_JS, 220, 0),
        code_node("Write ai_run", D0_AI_RUN_JS, 440, 0),
        code_node("Write raw_signal", D0_RAW_SIGNAL_JS, 660, 0),
        code_node("Write claims + gaps", D0_CLAIMS_JS, 880, 0),
        code_node("Write evidence", D0_EVIDENCE_JS, 1100, 0),
    ]
    order = [n["name"] for n in nodes]
    conns = {order[i]: {"main": [[{"node": order[i + 1], "type": "main", "index": 0}]]}
             for i in range(len(order) - 1)}
    return {
        "name": "f07-db-write", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


# ============================================================================
# main
# ============================================================================

def main():
    check_only = '--check' in sys.argv
    if D0_WORKFLOW_ID == 'REPLACE_WITH_F07_DB_WRITE_ID':
        print("WARNING: F07_DB_WRITE_ID not set -- f07-thesis-gate's Execute Workflow node "
              "will reference a placeholder id. Create f07-db-write first, then re-run with "
              "F07_DB_WRITE_ID=<id> in the environment.", file=sys.stderr)

    workflows = [build_d0(), build_d1(), build_d2()]
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
