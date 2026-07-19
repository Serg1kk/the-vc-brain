#!/usr/bin/env python3
"""
Build the feature-10 (NL-search) n8n workflow from source.

Why a generator rather than hand-maintained JSON: `lib/f10/{constants,plan,score}.js` is the
tested logic (82 tests, `node --test lib/f10/*.test.js`), and n8n's Code-node sandbox cannot
`require()` a repo file (no bind-mount, no NODE_FUNCTION_ALLOW_EXTERNAL -- see
infra/n8n/docker-compose.yml). That source has to be *inlined* into the Code nodes verbatim.
Doing that by hand is exactly the class of drift 04/03/07's own generators exist to prevent
(n8n/build-workflows.py, n8n/build-f03-workflow.py, n8n/build-f07-workflow.py) -- same fix,
same reason, fourth time. The resolver's system prompt and JSON schema are likewise pulled
straight out of docs/backlog/10-api-cli-skill/agents/nl-search-resolver/*, never retyped by
hand.

Run after any change to lib/f10/*.js or to the nl-search-resolver agent artifacts:

    python3 n8n/build-f10-workflow.py           # regenerate n8n/workflows/f10-nl-search.json
    python3 n8n/build-f10-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f10.md).

One deliberate schema deviation from the agent artifact, recorded here because it is not
visible from the JSON diff alone: OpenAI's Structured Outputs API requires the ROOT schema to
be `type: "object"` -- it rejects a root-level `oneOf`/`anyOf` union outright (verified live,
2026-07-19: "schema must be a JSON Schema of 'type: object', got 'type: None'"). The canonical
`nl-search-resolver-agent-json-schema.json` has such a root union (plan | error), because the
resolver's OWN documented contract allows it to self-report `empty_query`/`no_catalogue`. This
workflow's own upstream nodes make both of those conditions unreachable before the LLM is ever
called (empty query is rejected in "Normalize input"; the catalogue is always built fresh in
"Build catalogue"), so the schema sent to the API for THIS call is the plan-only root schema
--the union's dead branch is dropped from the wire schema, not from the documented contract.
`lib/f10/plan.js`'s `validatePlan()` still handles `rawPlan.error_code !== undefined`
defensively and unmodified, in case a future caller of the same prompt/schema pair (outside
this n8n workflow) ever needs it.

A second, smaller deviation in the same direction: OpenAI strict mode also rejects `allOf`
(the attribute's negative-requires-not_exists / op-requires-value conditionals) and requires
EVERY property to be listed in `required` (no true-optional keys) -- both verified live. The
wire schema therefore drops `allOf` and widens `value`/`broadening`/`resolved_as` to
`[...,"null"]` + required, exactly the "if/then/allOf unsupported in strict mode, enforced by
a downstream Code node instead" pattern feature 07's own agent-model-recommendations.md
already documents for the identical class of constraint. Because the model must now emit
those three keys as literal JSON `null` (never absent) when they do not apply, "Parse resolver
response" strips them back to *absent* before `validatePlan()` runs -- `lib/f10/plan.js`'s
`validateAttributeShape()` was written expecting "not applicable" to mean the key is missing,
not `null`, and it is pasted here unmodified (task instruction: do not change the logic while
pasting). This normalisation is workflow-layer plumbing around the untrusted LLM output, not a
change to the tested module.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f10')
AGENT_DIR = os.path.join(ROOT, 'docs', 'backlog', '10-api-cli-skill', 'agents', 'nl-search-resolver')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

MODEL = 'gpt-5.6-luna'


def _read(name):
    return open(os.path.join(LIBDIR, name), encoding='utf-8').read()


def _strip_exports(src):
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed: " + src[-200:]
    return stripped.rstrip() + "\n"


def _strip_requires(src):
    # plan.js: `const { WEIGHTS } = require('./constants');`
    # score.js: a multi-line destructure of the same form.
    stripped = re.sub(r"const\s*\{[^}]*\}\s*=\s*require\('\./constants'\);\n?", "", src)
    # Check for an actual unstripped `= require(` statement, not the word "require()"
    # appearing in prose inside a comment (both files' own header comments discuss the
    # n8n Code-node require() constraint in English).
    assert "= require(" not in stripped, "require() strip failed: " + stripped[:2000]
    return stripped


CONSTANTS_SRC = _strip_exports(_read('constants.js'))
PLAN_SRC = _strip_exports(_strip_requires(_read('plan.js')))
SCORE_SRC = _strip_exports(_strip_requires(_read('score.js')))


def bundle(*parts):
    return "\n".join(parts)


VALIDATE_PLAN_BUNDLE = bundle(
    "// ===== SOURCE OF TRUTH: lib/f10/constants.js (verbatim, module.exports stripped -- "
    "generated by n8n/build-f10-workflow.py, edit the source, not this) =====",
    CONSTANTS_SRC,
    "// ===== SOURCE OF TRUTH: lib/f10/plan.js (verbatim, require()/module.exports stripped) =====",
    PLAN_SRC,
)

SCORE_BUNDLE = bundle(
    "// ===== SOURCE OF TRUTH: lib/f10/constants.js (verbatim, module.exports stripped -- "
    "generated by n8n/build-f10-workflow.py, edit the source, not this) =====",
    CONSTANTS_SRC,
    "// ===== SOURCE OF TRUTH: lib/f10/score.js (verbatim, require()/module.exports stripped) =====",
    SCORE_SRC,
)


# ============================================================================
# Resolver agent artifacts -- prompt + schema, pulled verbatim, never retyped.
# ============================================================================

def agent_system_prompt():
    t = open(os.path.join(AGENT_DIR, 'nl-search-resolver-agent-prompts.txt'), encoding='utf-8').read()
    return t[t.find('SYSTEM MESSAGE'):].split('=' * 80, 1)[1].strip()


def agent_schema():
    return json.load(open(os.path.join(AGENT_DIR, 'nl-search-resolver-agent-json-schema.json'), encoding='utf-8'))


# OpenAI strict-mode keyword denylist -- same list f07's build script found live
# (docs/backlog/07-thesis-engine's model-recommendations.md "strict-mode schema caveat"),
# plus $schema/title which are pure decoration the API does not need.
_STRIP_KEYWORDS = ('minLength', 'maxLength', 'pattern', 'uniqueItems', 'maxItems', '$schema', 'title')


def _strip_kw(node):
    if isinstance(node, dict):
        return {k: _strip_kw(v) for k, v in node.items() if k not in _STRIP_KEYWORDS}
    if isinstance(node, list):
        return [_strip_kw(v) for v in node]
    return node


def build_wire_schema():
    """The plan-only, strict-mode-compatible schema actually sent to the API.

    See the module docstring for the full rationale (root oneOf -> unions not
    supported at the API root; allOf not supported; every property must be
    required, with optional fields modelled as nullable). Verified live,
    2026-07-19, against both Q1 and Q2 -- see README-f10.md.
    """
    schema = agent_schema()
    defs = _strip_kw(schema['definitions'])

    attr = defs['attribute']
    attr.pop('allOf', None)
    attr['required'] = ['id', 'label', 'kind', 'polarity', 'target', 'op', 'value', 'broadening', 'resolved_as']
    attr['properties']['value']['type'] = ['string', 'number', 'null']
    attr['properties']['broadening']['type'] = ['string', 'null']
    if 'enum' in attr['properties']['broadening'] and None not in attr['properties']['broadening']['enum']:
        attr['properties']['broadening']['enum'].append(None)
    attr['properties']['resolved_as']['type'] = ['string', 'null']

    plan_def = defs['plan']
    # Inline the attribute/unresolvableItem $refs directly rather than shipping a sibling
    # `definitions` block -- two references, not worth the $ref-support uncertainty.
    plan_def['properties']['attributes']['items'] = attr
    plan_def['properties']['unresolvable']['items'] = defs['unresolvableItem']
    return plan_def


SYSTEM_PROMPT = agent_system_prompt()
WIRE_SCHEMA = build_wire_schema()

# catalogue.vocabularies -- static, per the task brief ("plus the static vocabularies from
# lib/f07/vocabulary.js"). Pasted as literal arrays (not re-derived at runtime -- these are
# fixed taxonomy, not corpus measurements) straight from lib/f07/vocabulary.js's own
# SECTOR_VALUES / GEOGRAPHY_REGION_VALUES / STAGE_VALUES / STAGE_EVIDENCE_VALUES /
# BUSINESS_MODEL_VALUES.
VOCABULARIES_JS = """{
  sector: ["b2b-software","ai-infra","devtools","fintech","healthtech","consumer","marketplace","gambling","adtech","other"],
  geography_region: ["EU","US","UK","APAC","LATAM","MEA","other"],
  stage: ["pre_seed","seed"],
  stage_evidence: ["idea","prototype","early_revenue","scaling"],
  business_model: ["b2b","b2c","b2b2c","marketplace","open_source","unknown"],
}"""

# catalogue.metric_kinds -- static, per nl-search-resolver-agent-input-spec.md's own example
# (legal targets for the CUT `velocity` kind; kept in the catalogue for schema completeness /
# forward compatibility per the input-spec's field-rules table marking it required).
METRIC_KINDS_JS = (
    '["gh_stars","gh_commit_weeks","gh_merged_prs","hn_points","site_updated",'
    '"gh_followers","gh_notable_followers","gh_forks","gh_dependents",'
    '"hn_karma","hn_comments","hn_author_replies"]'
)


# ============================================================================
# n8n node/connection helpers (same shape as n8n/build-f07-workflow.py)
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
        print("  %-42s %s (%d bytes)" % (n['name'], 'OK' if ok else 'SYNTAX ERROR', len(js)))
        if not ok:
            bad += 1
            print(r.stderr[:1200])
        os.unlink(path)
    return bad


def openai_resolver_node(name, x, y):
    return {
        "parameters": {
            "method": "POST", "url": "https://api.openai.com/v1/responses",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $env.OPENAI_API_KEY }}"},
                {"name": "Content-Type", "value": "application/json"},
            ]},
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.__resolver_request_body) }}",
            "options": {"timeout": 60000},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.1, "position": [x, y],
        "retryOnFail": True, "maxTries": 2, "waitBetweenTries": 3000,
        "notes": "gpt-5.6-luna rejects an explicit temperature parameter (HTTP 400) -- omitted "
                 "entirely, per model-recommendations.md. jsonBody stays a SHORT expression "
                 "referencing a Code-node-built object (n8n's {{ }} parser truncates on the "
                 "first '}}' it finds, and this schema's nested objects contain several -- "
                 "same defect f07's build script found live).",
    }


# ============================================================================
# Node bodies
# ============================================================================

NORMALIZE_INPUT_JS = r"""
// design.md SS5: POST body { query, limit }. Webhook wraps the body under .body -- same
// convention as f03/f04/f07's normalize-input nodes. `error` is threaded through every
// downstream node as a single field; "Build response" is the one place that inspects it.
const item = $input.first().json;
const body = item.body || item || {};
const rawQuery = body.query;
const query = (typeof rawQuery === 'string' ? rawQuery : '').trim();

// design.md SS5.4 rule 5: limit defaults to 10, hard-capped by PGRST_DB_MAX_ROWS (env, "
// 1000 if unset per the tooling changelog).
const CAP = Number($env.PGRST_DB_MAX_ROWS) > 0 ? Number($env.PGRST_DB_MAX_ROWS) : 1000;

let limit = 10;
let error = null;

if (!query) {
  // design.md SS5.7
  error = { kind: 'empty_query', message: 'query was empty or whitespace only', hint: null, retryable: false };
} else if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
  const n = Number(body.limit);
  if (!Number.isFinite(n) || n <= 0) {
    limit = 10; // defensive default, not a documented error kind
  } else if (n > CAP) {
    error = { kind: 'limit_exceeded', message: `limit ${n} exceeds the maximum of ${CAP}`, hint: `use limit <= ${CAP}`, retryable: false };
  } else {
    limit = Math.floor(n);
  }
}

return [{ json: { query, limit, error } }];
"""

BUILD_CATALOGUE_JS = r"""
// design.md SS5.3 / nl-search-resolver-agent-input-spec.md: "the live corpus catalogue,
// assembled fresh on every call". Every PostgREST read is Code-node-wrapped
// (this.helpers.httpRequest), matching f03/f04/f07's house convention -- see those
// workflows' READMEs for why the standalone httpRequest node is not used for Supabase reads.
const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;
async function pg(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  return await this.helpers.httpRequest({ method, url: SB + '/rest/v1/' + path, headers, body, json: true });
}
async function pgGet(path) { return await pg.call(this, 'GET', path); }
async function pgCount(path) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'count=exact' };
  const res = await this.helpers.httpRequest({ method: 'GET', url: SB + '/rest/v1/' + path, headers, json: true, returnFullResponse: true });
  const cr = (res.headers && (res.headers['content-range'] || res.headers['Content-Range'])) || '';
  const m = /\/(\d+)$/.exec(String(cr));
  if (m) return Number(m[1]);
  return Array.isArray(res.body) ? res.body.length : 0;
}

const inp = $json;

// claim_topics: exact-topic row counts, aggregated client-side over the raw `claims` table
// (734 rows live, 2026-07-19 -- well under any PGRST_DB_MAX_ROWS default; a single fetch,
// no pagination needed). plan.js's own familyRowCount()/topicRecognised() sum matching
// prefixes at validation time, so the catalogue only needs EXACT topics, never
// pre-aggregated families.
const claimRows = await pgGet.call(this, 'claims?select=topic&limit=5000');
const topicCounts = new Map();
for (const r of claimRows) {
  if (!r || typeof r.topic !== 'string') continue;
  topicCounts.set(r.topic, (topicCounts.get(r.topic) || 0) + 1);
}

// FILTER to the documented taxonomy ONLY (lib/f10/plan.js's PROVENANCE_TOPIC_PREFIXES /
// STRUCTURAL_TOPICS -- mirrored here verbatim, not imported, since this node has no
// visibility into the compiled plan yet). Live-discovered bug, fixed 2026-07-19: the
// raw `claims` table also carries topics NO target in this build resolves against
// (company.business_model, company.stage_evidence, market.*, competition.*, round.*,
// traction.*, and every `.gap`-suffixed topic) -- 9-13 rows apiece, real and non-empty.
// Feeding those to the resolver invites it to map a fragment onto a topic that EXISTS in
// the corpus but that plan.js's validateTarget() will reject as `invalid_target` -- and
// invalid_target is a WHOLE-PLAN rejection (plan.js's own doc comment), so one
// out-of-taxonomy guess turns Q2's honest degradation into a hard error with zero items,
// exactly the "Q2 returning no rows is a bug" case design.md SS5.8 forbids. Filtering the
// catalogue to what is actually executable forces those fragments into `unresolvable`
// (no_data_source / not_testable) instead, which is the correct, honest outcome.
const PROVENANCE_PREFIXES = ['founder.expertise.', 'founder.execution.', 'founder.leadership.'];
const STRUCTURAL_TOPICS = ['company.sector', 'company.geography_country'];
const claim_topics = [...topicCounts.entries()]
  .filter(([topic]) => PROVENANCE_PREFIXES.some(p => topic.startsWith(p)) || STRUCTURAL_TOPICS.includes(topic))
  .map(([topic, rows]) => ({ topic, rows }))
  .sort((a, b) => b.rows - a.rows);

// structural_fields: filled/total per column, via PostgREST's Prefer:count=exact +
// Content-Range (server-side count, no row download). design.md SS4.0's own measured set,
// re-measured live on every call rather than hard-coded -- the resolver's prompt (rule 5)
// only proposes a `column` target when `filled > 0`, so listing the empty ones (hq_country,
// location_*) is what lets it correctly steer AWAY from them.
const companiesTotal = await pgCount.call(this, 'companies?select=id');
const foundersTotal = await pgCount.call(this, 'founders?select=id');
const FIELD_SPECS = [
  ['companies', 'hq_country', companiesTotal],
  ['companies', 'category', companiesTotal],
  ['companies', 'domain', companiesTotal],
  ['companies', 'stage', companiesTotal],
  ['founders', 'location_city', foundersTotal],
  ['founders', 'location_country', foundersTotal],
  ['founders', 'headline', foundersTotal],
];
const structural_fields = [];
for (const [table, column, total] of FIELD_SPECS) {
  const filled = await pgCount.call(this, `${table}?select=id&${column}=not.is.null`);
  structural_fields.push({ field: `${table}.${column}`, filled, total });
}

// vocabularies / metric_kinds: static, from lib/f07/vocabulary.js (sector/geography_region/
// stage/stage_evidence/business_model) and the input-spec's own metric_kinds example --
// fixed taxonomy, not a corpus measurement, so not re-derived at runtime.
const vocabularies = %(VOCAB)s;
const metric_kinds = %(METRICS)s;

const catalogue = { claim_topics, structural_fields, vocabularies, metric_kinds };
return [{ json: { ...inp, catalogue, resolverInput: { query: inp.query, catalogue } } }];
""" % {"VOCAB": VOCABULARIES_JS, "METRICS": METRIC_KINDS_JS}


def build_resolver_request_js():
    sys_js = json.dumps(SYSTEM_PROMPT)
    schema_js = json.dumps(WIRE_SCHEMA)
    return (
        "// nl-search-resolver-agent-prompts.txt SYSTEM MESSAGE, pasted verbatim by "
        "n8n/build-f10-workflow.py -- edit the source, not this.\n"
        "const SYS = " + sys_js + ";\n\n"
        "// Wire schema -- the plan-only, strict-mode-compatible transform of "
        "nl-search-resolver-agent-json-schema.json. See this file's module docstring "
        "(n8n/build-f10-workflow.py) for the full rationale.\n"
        "const SCHEMA = " + schema_js + ";\n\n"
        "const inp = $json;\n"
        "const user = JSON.stringify(inp.resolverInput);\n"
        "const body = {\n"
        "  model: " + json.dumps(MODEL) + ",\n"
        "  input: [ { role: 'system', content: SYS }, { role: 'user', content: user } ],\n"
        "  reasoning: { effort: 'low' },\n"
        "  text: { verbosity: 'low', format: { type: 'json_schema',\n"
        "    name: 'nl_search_resolver_output', strict: true, schema: SCHEMA } },\n"
        "  max_output_tokens: 1200,\n"
        "};\n"
        "return [{ json: { ...inp, __resolver_request_body: body } }];\n"
    )


PARSE_RESOLVER_RESPONSE_JS = r"""
// design.md SS5.3/SS5.7: parse the /v1/responses payload. `ctx` is the state from BEFORE the
// HTTP call (query/limit/catalogue/resolverInput) -- $json at this point is the httpRequest
// node's own output, so cross-node reference is required (same technique f07's "Parse
// extractor response" uses via $('Init run context')).
const ctx = $('Build resolver request').first().json;
const resp = $input.first().json;

let rawPlan = null;
let parseOk = false;
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  const text = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  rawPlan = JSON.parse(text);
  parseOk = resp.status === 'completed' && rawPlan !== null && typeof rawPlan === 'object';
} catch (e) {
  parseOk = false;
}

if (!parseOk) {
  return [{ json: { ...ctx, rawPlan: null,
    error: { kind: 'resolver_failed', message: 'resolver returned malformed or incomplete output', hint: null, retryable: true } } }];
}

// Strict-mode forces value/broadening/resolved_as to be emitted as literal null when not
// applicable (every property must be `required` under OpenAI's strict schema rules -- see
// n8n/build-f10-workflow.py's module docstring). lib/f10/plan.js's validateAttributeShape()
// was written expecting those keys to be ABSENT, not null, when not applicable -- normalise
// back to "key absent" here, in this workflow-layer adapter, so the pasted-verbatim module
// below sees exactly the shape it was designed against.
if (Array.isArray(rawPlan.attributes)) {
  for (const a of rawPlan.attributes) {
    if (a && typeof a === 'object') {
      if (a.value === null) delete a.value;
      if (a.broadening === null) delete a.broadening;
      if (a.resolved_as === null) delete a.resolved_as;
    }
  }
}

return [{ json: { ...ctx, rawPlan, error: null } }];
"""

VALIDATE_PLAN_INVOKE_JS = r"""
// validatePlan() is lib/f10/plan.js's one entry point -- pasted verbatim above.
const inp = $json;
const result = validatePlan(inp.rawPlan, inp.catalogue);
if (!result.ok) {
  return [{ json: { ...inp, plan: null, error: result.error } }];
}
return [{ json: { ...inp, plan: result.plan, error: null } }];
"""

FETCH_CANDIDATES_JS = r"""
// design.md SS5.1/SS5.4: the n8n workflow issues the PostgREST reads a compiled plan's
// descriptors describe (lib/f10/plan.js builds the descriptor DATA; this node is the
// "responsible for... the founder_company join" workflow half plan.js's own comment names).
const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;
async function pg(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  return await this.helpers.httpRequest({ method, url: SB + '/rest/v1/' + path, headers, body, json: true });
}
async function pgGet(path) { return await pg.call(this, 'GET', path); }

// House style (matches f03/f04/f07's own pg() call sites): raw string interpolation, no
// encodeURIComponent -- every value here is a UUID, an ISO-3166 code, a closed-vocabulary
// slug or a claim-topic string, none of which carry characters PostgREST's querystring
// parser would choke on.
function filterQs(filters) {
  return (filters || []).map(f => `${f.column}=${f.op}.${f.value}`).join('&');
}
function orderQs(order) {
  return (order || []).map(o => `${o.column}.${o.dir}`).join(',');
}

const inp = $json;
const attributes = (inp.plan && Array.isArray(inp.plan.attributes)) ? inp.plan.attributes : [];
const fetchedRows = {};
let error = null;

try {
  // score.js's own comment: "founders is the one reserved key beyond the per-attribute
  // ones -- api_founders rows used both for display enrichment of scored candidates and as
  // the universe for the zero-positive fallback." Fetched unconditionally, even when
  // `attributes` is empty.
  fetchedRows.founders = await pgGet.call(this,
    'api_founders?select=founder_id,full_name,is_synthetic,founder_score,score_assessed,company_id,company_name,application_id&order=founder_id.asc&limit=2000');

  for (const attr of attributes) {
    const d = attr.descriptor;
    if (!d) { fetchedRows[attr.id] = []; continue; }

    if (d.resource === 'api_claims') {
      const path = `api_claims?select=${d.select}&${filterQs(d.filters)}&order=${orderQs(d.order)}&limit=2000`;
      fetchedRows[attr.id] = await pgGet.call(this, path);
      continue;
    }

    // target.type === 'column' (companies.stage today) -- lib/f10/plan.js's own comment
    // flags this path as "not fully specified... no worked example ever uses
    // target.type:'column', Q1/Q2 do not exercise it" (design.md B1 report). Neither
    // required acceptance query reaches this branch. Best-effort n8n-side adaptation, NOT
    // covered by lib/f10's 82 tests: the descriptor's own filter already applies the `eq`
    // server-side (every row returned already satisfies the attribute), so this fetches the
    // matching companies, joins to their CURRENT founder via founder_company, and reshapes
    // each row into the claims-row shape score.js's classifyRow()/evalOpMatch() expect --
    // a synthetic `supports`/`documented` evidence entry (no real claim_id, no real
    // quote/source_url, since this is a structural-column fact, not a claims-ledger entry).
    const companies = await pgGet.call(this, `${d.resource}?select=${d.select}&${filterQs(d.filters)}&limit=2000`);
    const companyIds = companies.map(c => c.id).filter(Boolean);
    let rows = [];
    if (companyIds.length) {
      const links = await pgGet.call(this,
        `founder_company?company_id=in.(${companyIds.join(',')})&is_current=eq.true&select=founder_id,company_id`);
      const byCompany = new Map(companies.map(c => [c.id, c]));
      rows = links.map(l => {
        const c = byCompany.get(l.company_id) || {};
        const colKey = Object.keys(c).find(k => k !== 'id');
        return {
          claim_id: null, founder_id: l.founder_id, topic: null, value: colKey ? c[colKey] : null,
          verification_status: null, created_at: null,
          evidence: [{ tier: 'documented', relation: 'supports', strength: null,
                       quote_verbatim: null, source_url: null, raw_signal_id: null, captured_at: null }],
        };
      });
    }
    fetchedRows[attr.id] = rows;
  }
} catch (e) {
  error = { kind: 'upstream_timeout', message: 'PostgREST fetch failed: ' + (e && e.message ? e.message : String(e)), hint: null, retryable: true };
}

return [{ json: { ...inp, fetchedRows, error } }];
"""

SCORE_INVOKE_JS = r"""
// score() is lib/f10/score.js's one entry point -- pasted verbatim above.
const inp = $json;
const result = score(inp.plan, inp.fetchedRows);
return [{ json: { ...inp, scoreResult: result, error: null } }];
"""

BUILD_RESPONSE_JS = r"""
// design.md SS5.6/SS5.7 -- the single terminal node every branch (error and success)
// converges on (IF/Switch reconverge without a Merge node is the sanctioned pattern in this
// repo's n8n build -- confirmed against f07-thesis-gate.json's own "Build attributes for
// evaluation" node, which receives two wires from mutually-exclusive IF branches the same
// way). responseMode:lastNode returns whatever this node outputs.
const inp = $json;

if (inp.error) {
  return [{ json: { error: inp.error } }];
}

const sr = inp.scoreResult || {};
const limit = Number(inp.limit) > 0 ? Math.floor(Number(inp.limit)) : 10;
// design.md SS5.4 rule 5: `limit` bounds items[] only -- `total` reports the full scored
// candidate count regardless, and `truncated` refers to the 200-candidate cap, never to
// `total > limit` (that comparison is normal and expected).
const items = Array.isArray(sr.items) ? sr.items.slice(0, limit) : [];

return [{ json: {
  query: inp.query,
  plan: sr.plan || null,
  items,
  low_confidence: Array.isArray(sr.low_confidence) ? sr.low_confidence : [],
  total: typeof sr.total === 'number' ? sr.total : 0,
  truncated: sr.truncated === true,
  low_confidence_only: sr.low_confidence_only === true,
  note: sr.note || null,
} }];
"""


# ============================================================================
# Assembly
# ============================================================================

def build_workflow():
    nodes = []

    webhook = {
        "parameters": {"httpMethod": "POST", "path": "f10-nl-search", "responseMode": "lastNode", "options": {}},
        "id": nid(), "name": "Webhook Trigger", "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [-1400, 0], "webhookId": nid(),
    }
    normalize = code_node("Normalize input", NORMALIZE_INPUT_JS, -1160, 0)
    if_early_error = if_node("IF: input error?", "={{ !!$json.error }}", True, "boolean", "equals", -920, 0)
    catalogue = code_node("Build catalogue", BUILD_CATALOGUE_JS, -680, -140,
                           notes="PostgREST reads (Code-node-wrapped this.helpers.httpRequest) + "
                                 "static vocabularies/metric_kinds. Assembled fresh on every call "
                                 "per nl-search-resolver-agent-input-spec.md.")
    resolver_req = code_node("Build resolver request", build_resolver_request_js(), -440, -140,
                              notes="SOURCE OF TRUTH: nl-search-resolver-agent-prompts.txt (SYSTEM "
                                    "MESSAGE) + nl-search-resolver-agent-json-schema.json (wire-schema "
                                    "transform -- see n8n/build-f10-workflow.py docstring).")
    resolver_call = openai_resolver_node("OpenAI: nl-search-resolver (luna)", -200, -140)
    parse_resolver = code_node("Parse resolver response", PARSE_RESOLVER_RESPONSE_JS, 40, -140)
    validate_plan = code_node("Validate plan", VALIDATE_PLAN_BUNDLE + "\n" + VALIDATE_PLAN_INVOKE_JS, 280, -140,
                               notes="SOURCE OF TRUTH: lib/f10/plan.js + lib/f10/constants.js -- do not "
                                     "edit here, edit there and re-run n8n/build-f10-workflow.py.")
    if_plan_error = if_node("IF: plan error?", "={{ !!$json.error }}", True, "boolean", "equals", 520, -140)
    fetch = code_node("Fetch candidates", FETCH_CANDIDATES_JS, 760, -260)
    if_fetch_error = if_node("IF: fetch error?", "={{ !!$json.error }}", True, "boolean", "equals", 1000, -260)
    score_node = code_node("Score", SCORE_BUNDLE + "\n" + SCORE_INVOKE_JS, 1240, -260,
                            notes="SOURCE OF TRUTH: lib/f10/score.js + lib/f10/constants.js -- do not "
                                  "edit here, edit there and re-run n8n/build-f10-workflow.py.")
    build_response = code_node("Build response", BUILD_RESPONSE_JS, 1480, 0)

    nodes += [webhook, normalize, if_early_error, catalogue, resolver_req, resolver_call,
              parse_resolver, validate_plan, if_plan_error, fetch, if_fetch_error, score_node,
              build_response]

    notes1 = sticky(
        "Overview",
        "# f10-nl-search\n\n"
        "POST /webhook/f10-nl-search  { \"query\": \"<nl>\", \"limit\": 10 }\n\n"
        "Resolver (LLM, gpt-5.6-luna) classifies the query into typed attributes against a live "
        "corpus catalogue -- it never sees the database, never ranks anyone. lib/f10/plan.js "
        "validates the plan and turns it into PostgREST descriptors; this workflow fetches them; "
        "lib/f10/score.js scores in memory. Design: docs/backlog/10-api-cli-skill/design.md §5.\n\n"
        "Three IF gates (input error / plan error / fetch error) all converge on \"Build response\" "
        "-- mutually exclusive branches, no Merge node needed (see f07-thesis-gate.json's own "
        "\"Build attributes for evaluation\" node for the same sanctioned pattern in this repo).",
        -1400, -420, 640, 260,
    )
    notes2 = sticky(
        "Schema deviation -- read before editing the resolver call",
        "OpenAI Structured Outputs rejects a root-level oneOf/anyOf and rejects allOf, and "
        "requires every property to be `required` (no true-optional keys). The wire schema "
        "(built in n8n/build-f10-workflow.py, embedded in \"Build resolver request\") is a "
        "plan-only, null-widened transform of nl-search-resolver-agent-json-schema.json -- NOT "
        "the file itself. \"Parse resolver response\" strips the resulting literal nulls "
        "(value/broadening/resolved_as) back to absent keys before lib/f10/plan.js sees them, "
        "because plan.js expects \"not applicable\" to mean absent, not null, and is pasted "
        "verbatim (unmodified). Verified live against both Q1 and Q2, 2026-07-19.",
        -440, -420, 720, 220,
    )
    nodes += [notes1, notes2]

    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize input", 0),
            ("Normalize input", 0, "IF: input error?", 0),
        ),
        {"IF: input error?": {"main": [
            [{"node": "Build response", "type": "main", "index": 0}],
            [{"node": "Build catalogue", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Build catalogue", 0, "Build resolver request", 0),
            ("Build resolver request", 0, "OpenAI: nl-search-resolver (luna)", 0),
            ("OpenAI: nl-search-resolver (luna)", 0, "Parse resolver response", 0),
            ("Parse resolver response", 0, "Validate plan", 0),
            ("Validate plan", 0, "IF: plan error?", 0),
        ),
        {"IF: plan error?": {"main": [
            [{"node": "Build response", "type": "main", "index": 0}],
            [{"node": "Fetch candidates", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Fetch candidates", 0, "IF: fetch error?", 0),
        ),
        {"IF: fetch error?": {"main": [
            [{"node": "Build response", "type": "main", "index": 0}],
            [{"node": "Score", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Score", 0, "Build response", 0),
        ),
    )

    return {
        "name": "f10-nl-search", "nodes": nodes, "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {}, "meta": {"templateCredsSetupCompleted": True},
    }


def main():
    check_only = '--check' in sys.argv
    wf = build_workflow()
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
