#!/usr/bin/env python3
"""
Build the feature-02 n8n workflow JSON (f02-radar-scan) from source.

Why a generator rather than hand-maintained JSON: the deterministic core lives in
lib/f02/{normalize,identity,claims,obscurity,pipeline}.js and lib/f02/write.js, unit-tested
(212 tests) outside n8n. n8n's Code-node sandbox cannot `require()` from this repo (see
infra/n8n/docker-compose.yml -- no bind-mount, NODE_FUNCTION_ALLOW_EXTERNAL unset), so that
source has to be *inlined* into Code nodes verbatim. Doing that inlining by hand risks the
tested module and the running workflow silently drifting apart -- the exact class of defect
features 03/04/07 already hit and documented in docs/backlog/TRACKER.md. Same approach as
n8n/build-f03-workflow.py and n8n/build-f07-workflow.py -- kept independent (no shared
import) since a generator this size is itself something worth reading start to finish.

lib/f02/*.js is edited concurrently by another terminal at the time this generator was
written -- every inline_module()/extract_function() call below reads from disk at BUILD
TIME (i.e. every time this script is invoked), never copies source into this file.

Run after any change to lib/f02/*.js:

    python3 n8n/build-f02-workflow.py           # regenerate n8n/workflows/f02-radar-scan.json
    python3 n8n/build-f02-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f02.md).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f02')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

# f07-thesis-gate's live workflow id (docs/backlog/02-sourcing-radar/design.md §5.5,
# confirmed against the deployed workflow, id EQxi1lFF2bDjDByd, active, 34 nodes).
GATE_WORKFLOW_ID = os.environ.get('F07_THESIS_GATE_ID', 'EQxi1lFF2bDjDByd')

# design.md §2: gate_budget, config, default 120. Overridable at BUILD time only for a quick
# local smoke run (e.g. F02_TEST_GATE_BUDGET=3) -- never changes the deployed default unless
# the env var is set when this generator runs; a plain `python3 n8n/build-f02-workflow.py`
# always produces the design-mandated 120.
GATE_BUDGET_DEFAULT = int(os.environ.get('F02_TEST_GATE_BUDGET', '120'))
TAVILY_CREDIT_BUDGET_DEFAULT = 150  # design.md §7.2: tavily_credit_budget, default 150
WINDOW_DAYS = 14                    # design.md §10 decision 2 / §6.3


# ----------------------------------------------------------------------------
# Source extraction -- lib/f02/*.js pasted verbatim (module.exports stripped, it is
# CommonJS glue, not logic) so nothing here is retyped by hand.
# ----------------------------------------------------------------------------

def inline_module(filename):
    """Read lib/f02/<filename>.js verbatim, stripping only the trailing CommonJS
    `module.exports = {...};` -- n8n's Code-node sandbox does not define `module`, so that
    line would throw ReferenceError, but the functions/consts it exports are already in
    scope once the rest of the file is pasted in. Asserts the file stays zero-import
    (TRACKER.md's hard convention for anything pasted into a Code node)."""
    src = open(os.path.join(LIBDIR, filename), encoding='utf-8').read()
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed for " + filename
    assert 'require(' not in re.sub(r"//[^\n]*", "", stripped), \
        filename + " must stay zero-import (TRACKER.md hard convention)"
    return stripped.rstrip() + "\n"


def extract_function(source, start_marker, label):
    """Slice ONE top-level function definition out of `source` verbatim, by brace-matching
    from the first '{' after `start_marker` to its balanced close. Used for lib/f02/write.js,
    which is a Node-CLI file (freely uses require('node:fs'), process.env -- neither exists
    in an n8n Code node sandbox) -- inline_module()'s whole-file paste is wrong for it, but
    the one function this workflow actually needs (applyWriteSet) has no require()/process
    reference anywhere in its OWN body (only in write.js's makeClient()/getSupabaseUrl(),
    which this generator deliberately does not paste -- see N8N_CLIENT_JS below), so slicing
    just that span verbatim is both correct and load-bearing for staying in sync with the
    tested file. `start_marker` must appear exactly once in `source`."""
    assert source.count(start_marker) == 1, \
        "extract_function: %r must appear exactly once for %s" % (start_marker, label)
    idx = source.index(start_marker)

    # Find the function BODY's opening brace -- NOT the first '{' after start_marker,
    # which may belong to a default-parameter object literal (e.g. `opts = {}` in
    # `applyWriteSet(writeSet, opts = {})`) and would truncate the extraction after just
    # that empty literal. Skip past the balanced parameter-list parens first.
    paren_start = source.index('(', idx)
    pdepth = 0
    j = paren_start
    while j < len(source):
        if source[j] == '(':
            pdepth += 1
        elif source[j] == ')':
            pdepth -= 1
            if pdepth == 0:
                break
        j += 1
    else:
        raise SystemExit("extract_function: unbalanced parens extracting %s" % label)
    brace_start = source.index('{', j)

    depth = 0
    i = brace_start
    while i < len(source):
        c = source[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                span = source[idx:i + 1]
                assert 'require(' not in span, \
                    label + ": extracted span must not reference require() (n8n Code-node sandbox has none)"
                return span.rstrip() + "\n"
        i += 1
    raise SystemExit("extract_function: unbalanced braces extracting %s (%r)" % (label, start_marker))


def strip_identity_duplicates(identity_js):
    """identity.js's own file header says each lib/f02/*.js file is pasted into its OWN
    separate Code node ("so no file here may depend on another at runtime") -- under that
    assumption it carries its OWN small copies of 3 helpers (TWO_LABEL_SUFFIX_SECOND_LEVEL,
    hostIsGenericOrSubdomainOfGeneric, reduceToRootDomain) that normalize.js ALSO defines,
    "kept in lockstep... by hand" and cross-checked equal by identity.test.js. But
    pipeline.js's OWN header describes the OTHER deployment shape this generator actually
    uses: all five lib/f02 files concatenated into ONE Code node (buildWriteSet's `deps`
    argument needs every one of them in scope together) -- the two files' headers
    contradict each other, and concatenating both verbatim collides on 3 duplicate
    `const`/`function` declarations (SyntaxError, confirmed live via --check). Since the
    two copies are tested-equivalent, strip identity.js's here -- ONLY for the combined-
    bundle build, never touching lib/f02/identity.js on disk -- so
    canonicalDomainForBlogMatch/resolveIdentity resolve to normalize.js's own (already in
    scope earlier in the same bundle, identical behaviour)."""
    out = identity_js
    out, n1 = re.subn(
        r"const TWO_LABEL_SUFFIX_SECOND_LEVEL = new Set\(\[[^\]]*\]\);\n",
        "// TWO_LABEL_SUFFIX_SECOND_LEVEL: reusing normalize.js's own copy in this combined bundle.\n",
        out, count=1,
    )
    out, n2 = re.subn(
        r"function hostIsGenericOrSubdomainOfGeneric\(host\) \{.*?\n\}\n",
        "// hostIsGenericOrSubdomainOfGeneric: reusing normalize.js's own copy in this combined bundle.\n",
        out, count=1, flags=re.S,
    )
    out, n3 = re.subn(
        r"function reduceToRootDomain\(host\) \{.*?\n\}\n",
        "// reduceToRootDomain: reusing normalize.js's own copy in this combined bundle.\n",
        out, count=1, flags=re.S,
    )
    assert (n1, n2, n3) == (1, 1, 1), \
        "strip_identity_duplicates: expected exactly 1 match each, got %r -- identity.js source drifted, re-check the regexes" % ((n1, n2, n3),)
    return out


NORMALIZE_JS = inline_module('normalize.js')
IDENTITY_JS = inline_module('identity.js')
IDENTITY_JS_FOR_BUNDLE = strip_identity_duplicates(IDENTITY_JS)
CLAIMS_JS = inline_module('claims.js')
OBSCURITY_JS = inline_module('obscurity.js')
PIPELINE_JS = inline_module('pipeline.js')
# lib/f02/ethics.js -- appeared mid-build (another terminal, concurrently) implementing
# design.md §7 items 1-2 (robots.txt gate, opt-out gate). write.js's applyWriteSet now
# imports isOptedOut from it; this generator's Tavily node also calls checkRobots directly
# (design §7 item 1: "robots.txt is checked before any crawl, in a dedicated node").
ETHICS_JS = inline_module('ethics.js')

_WRITE_SRC = open(os.path.join(LIBDIR, 'write.js'), encoding='utf-8').read()
APPLY_WRITE_SET_JS = extract_function(_WRITE_SRC, 'async function applyWriteSet', 'lib/f02/write.js applyWriteSet')

_PIPELINE_SRC = open(os.path.join(LIBDIR, 'pipeline.js'), encoding='utf-8').read()
DERIVE_SITE_CRAWL_SEED_JS = extract_function(
    _PIPELINE_SRC, 'function deriveSiteCrawlSeed', 'lib/f02/pipeline.js deriveSiteCrawlSeed'
)

# n8n-sandbox adapter for lib/f02/write.js's applyWriteSet(). write.js's OWN makeClient()
# reads process.env and calls the Node-global fetch() -- neither exists in an n8n Code node
# sandbox (TRACKER.md's Tooling changelog + every other Code node in this repo: f03/f04/f07's
# shared SB_NORMALIZE/PG_HELPER idiom use $env + this.helpers.httpRequest exclusively, never
# process.env or raw fetch). This function reproduces write.js's makeClient() four-method
# surface (restRequest/selectOne/insertAlways/insertIdempotent) with ONLY the transport
# swapped -- applyWriteSet's own FK ordering and its idempotent two-step
# INSERT...ON CONFLICT DO NOTHING + select-back pattern (design.md §5.0 rule 3) are pasted
# verbatim above, untouched.
N8N_CLIENT_JS = r"""
function makeN8nSupabaseClient(self) {
  const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
  const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;

  async function restRequest(method, pathAndQuery, opts) {
    opts = opts || {};
    const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    if (opts.prefer) headers.Prefer = opts.prefer;
    return await self.helpers.httpRequest({
      method, url: SB + '/rest/v1/' + pathAndQuery, headers,
      body: opts.body, json: true,
    });
  }

  async function selectOne(table, filters, select) {
    const params = new URLSearchParams();
    for (const k of Object.keys(filters || {})) params.append(k, filters[k]);
    if (select) params.set('select', select);
    params.set('limit', '1');
    const rows = await restRequest('GET', table + '?' + params.toString());
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  async function insertAlways(table, row, opts) {
    opts = opts || {};
    const select = opts.select || 'id';
    const params = new URLSearchParams();
    if (select) params.set('select', select);
    const rows = await restRequest('POST', table + '?' + params.toString(), { body: row, prefer: 'return=representation' });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('makeN8nSupabaseClient: insertAlways(' + table + ') returned no row');
    }
    return rows[0];
  }

  async function insertIdempotent(table, row, opts) {
    opts = opts || {};
    const select = opts.select || 'id';
    const params = new URLSearchParams();
    params.set('on_conflict', opts.conflictColumns);
    if (select) params.set('select', select);
    const rows = await restRequest('POST', table + '?' + params.toString(), {
      body: row,
      prefer: 'resolution=ignore-duplicates,return=representation',
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { row: rows[0], created: true };
    }
    const found = await selectOne(table, opts.matchFilters, select);
    if (!found) {
      throw new Error('makeN8nSupabaseClient: insertIdempotent(' + table + ') returned zero rows and the select-back also found nothing');
    }
    return { row: found, created: false };
  }

  return { restRequest, selectOne, insertAlways, insertIdempotent };
}
"""

# Three runtime gaps discovered live, 2026-07-19, deploying THIS workflow: this n8n build's
# JS Task Runner sandbox (confirmed by reading js-task-runner.js's own getNativeVariables() /
# buildContext() inside the running container -- it exposes ONLY Buffer, timers, btoa/atob,
# TextEncoder/TextDecoder(+Stream), FormData) does NOT expose `globalThis.crypto`, `URL`, or
# `URLSearchParams` -- contradicting normalize.js's own header comment (written against a
# different n8n execution mode) and, for `URL`, initially MISDIAGNOSED as working: `new
# URL(...)` throws ReferenceError when URL is undefined, and normalize.js's
# parseArtifactUrl()/canonicalDomain() each wrap it in their OWN try/catch (for genuinely
# unparseable strings) -- the catch block does not distinguish "bad URL" from "URL is not a
# function", so a missing global was being SILENTLY swallowed and every artifact resolved to
# emptyArtifact()/null instead of throwing. Caught by cross-checking a live execution's
# artifact_kind (always 'none', even for a plain https://github.com/owner/repo URL) against
# the SAME code run in a real Node vm with URL actually present, which produced the correct
# 'github_repo' -- see n8n/workflows/README-f02.md.
#
# lib/f02/normalize.js itself is NOT edited (concurrent-terminal file; its own SHA-256/URL
# code below is pasted verbatim, still calling globalThis.crypto.subtle.digest(...) / `new
# URL(...)` exactly as written) -- this is a polyfill for the three missing GLOBALS only,
# sourced from Node's OWN implementations (require('crypto').webcrypto is the SAME
# subtle.digest surface; require('url').URL/.URLSearchParams are the SAME classes, not
# different ones) via the SAME require('crypto') allowlist f03's "Generate run_id" node
# already relies on live (NODE_FUNCTION_ALLOW_BUILTIN=crypto,url,
# infra/n8n/docker-compose.yml already lists 'url' too, added for f04's own identical need).
# `require('node:crypto')` / `require('node:url')` (the node:-prefixed form) are REJECTED
# live -- "Module 'node:crypto' is disallowed" -- the task runner's require-resolver.js does
# an EXACT string match against NODE_FUNCTION_ALLOW_BUILTIN, which lists the bare forms only.
# A no-op wherever a global already exists (e.g. a future n8n version, or a different
# execution mode) -- every check is a typeof guard, never an unconditional overwrite.
RUNTIME_POLYFILL_JS = (
    "if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {\n"
    "  globalThis.crypto = require('crypto').webcrypto;\n"
    "}\n"
    "if (typeof URL === 'undefined') {\n"
    "  globalThis.URL = require('url').URL;\n"
    "}\n"
    "if (typeof URLSearchParams === 'undefined') {\n"
    "  globalThis.URLSearchParams = require('url').URLSearchParams;\n"
    "}\n"
)

# The full bundle used by BOTH write passes (Tier 1 pre-gate entity creation, Tier 2 final
# persist) -- order matters only in that later files' top-level code may reference earlier
# ones (pipeline.js's buildWriteSet takes every dependency injected via its `deps` argument
# rather than by direct reference, but keeping normalize->identity->claims->obscurity->
# pipeline->write mirrors lib/f02's own dependency order, documented in pipeline.js's header).
F02_LIB_BUNDLE = (
    "// SOURCE OF TRUTH: lib/f02/{normalize,identity,claims,obscurity,pipeline,ethics}.js +\n"
    "// lib/f02/write.js's applyWriteSet -- pasted verbatim below (module.exports stripped;\n"
    "// applyWriteSet extracted by brace-matching). Do not edit here -- edit the lib/f02\n"
    "// source and re-run n8n/build-f02-workflow.py.\n\n"
    + RUNTIME_POLYFILL_JS + "\n"
    + NORMALIZE_JS + "\n"
    + IDENTITY_JS_FOR_BUNDLE + "\n"
    + CLAIMS_JS + "\n"
    + OBSCURITY_JS + "\n"
    + PIPELINE_JS + "\n"
    + ETHICS_JS + "\n"
    + N8N_CLIENT_JS + "\n"
    + APPLY_WRITE_SET_JS + "\n"
)


# ----------------------------------------------------------------------------
# n8n node/connection helpers (mirrors n8n/build-f03-workflow.py's conventions verbatim)
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


def http_node(name, method, url_expr, x, y, query_params=None, notes=None):
    params = {"method": method, "url": url_expr, "options": {}}
    if query_params:
        params["sendQuery"] = True
        params["queryParameters"] = {"parameters": query_params}
    node = {
        "parameters": params,
        "id": nid(), "name": name, "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.1, "position": [x, y],
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
    """pairs: (source_name, output_index, target_name, target_index) tuples. Multiple pairs
    sharing the same (source_name, output_index) fan out to several targets; multiple pairs
    sharing the same target across different sources fan in (n8n concatenates the incoming
    items -- fine for an exclusive IF/Switch reconverge, NOT fine for genuinely parallel
    branches, which need a real Merge node -- see TRACKER.md ~05:05)."""
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
    """node --check every Code node body, wrapped with dummy n8n globals so a top-level
    `await` and references to $json/$input/$env/$execution/this parse and resolve without
    actually running network calls. node --check only PARSES (never executes), so
    $('NodeName') / $getWorkflowStaticData(...) references need no stub here -- they would
    only matter at runtime, which this check does not perform. (Runtime-confirmed live
    against the actual JS Task Runner sandbox, 2026-07-19: $getWorkflowStaticData is a
    GLOBAL, not `this.getWorkflowStaticData` -- see n8n/workflows/README-f02.md.)"""
    bad = 0
    for n in nodes:
        js = n.get('parameters', {}).get('jsCode')
        if not js:
            continue
        wrapped = (
            "const $env = {}; const $execution = { id: 1 };\n"
            "const $input = { first: () => ({ json: {} }), all: () => [] };\n"
            "function $(name) { return { first: () => ({ json: {} }), all: () => [] }; }\n"
            "function $getWorkflowStaticData(type) { return {}; }\n"
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
# build()
# ----------------------------------------------------------------------------

def build():
    nodes = []

    # ---- Entry points -------------------------------------------------------
    manual_trigger = {
        "parameters": {}, "id": nid(), "name": "Manual Trigger",
        "type": "n8n-nodes-base.manualTrigger", "typeVersion": 1, "position": [-980, -180],
    }
    schedule_trigger = {
        "parameters": {"rule": {"interval": [{"field": "cronExpression", "expression": "0 */6 * * *"}]}},
        "id": nid(), "name": "Schedule Trigger",
        "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2, "position": [-980, 20],
    }
    nodes += [manual_trigger, schedule_trigger]

    # ---- TIER 0: HN Algolia funnel head + deterministic filter --------------
    http_algolia = http_node(
        "HTTP: HN Algolia search", "GET", "https://hn.algolia.com/api/v1/search_by_date",
        -660, -80,
        query_params=[
            {"name": "tags", "value": "show_hn"},
            # design.md §2: "created_at_i>{now-14d},points>=2". The epoch bound is computed
            # here, not baked into the URL, so a redeploy always uses a fresh 14-day window.
            {"name": "numericFilters",
             "value": "={{ 'created_at_i>' + Math.floor((Date.now() - %d*24*3600*1000)/1000) + ',points>=2' }}" % WINDOW_DAYS},
            {"name": "hitsPerPage", "value": "1000"},
        ],
        notes="design.md §2.1 live measurement: nbHits=1380 over a 14-day window, "
              "hitsPerPage=1000 is Algolia's own page ceiling (deeper needs time-slicing, "
              "not built here). Keyless.",
    )
    nodes.append(http_algolia)

    tier0_js = (
        "// design.md §2 / §2.1: \"the cap is by RECENCY, never by points\" -- a points cap\n"
        "// would reinstate the already-visible bias the operator explicitly removed (design\n"
        "// §10 decision 2). This node has no lib/f02/*.js counterpart to inline (the\n"
        "// filter/sort/cap rule lives only in design.md, not in a tested module) -- it is\n"
        "// hand-written orchestration, the same status as f03/f07's own \"Init run context\" /\n"
        "// \"Fetch founder + company\" glue nodes.\n"
        "const resp = $json || {};\n"
        "const hits = Array.isArray(resp.hits) ? resp.hits : [];\n"
        "\n"
        "const withUrl = hits.filter(function (h) { return h && h.url; });\n"
        "const droppedNoUrl = hits.length - withUrl.length;\n"
        "\n"
        "const sorted = withUrl.slice().sort(function (a, b) {\n"
        "  return (b.created_at_i || 0) - (a.created_at_i || 0);\n"
        "});\n"
        "\n"
        "const gateBudget = Number($env.GATE_BUDGET) || %d;\n"
        "const survivors = sorted.slice(0, gateBudget);\n"
        "const droppedByCap = sorted.length - survivors.length;\n"
        "\n"
        "// design.md §7.2: reset the per-run Tavily credit ledger here, once, before the loop\n"
        "// starts. $getWorkflowStaticData is a GLOBAL function in this n8n build's JS Task\n"
        "// Runner sandbox, NOT `this.getWorkflowStaticData` (confirmed live, 2026-07-19: the\n"
        "// latter throws \"this.getWorkflowStaticData is not a function\" -- see\n"
        "// n8n/workflows/README-f02.md). It persists across EXECUTIONS (not only across loop\n"
        "// iterations within one), so it must be zeroed at the top of every run, not only\n"
        "// initialised once ever.\n"
        "const staticData = $getWorkflowStaticData('global');\n"
        "staticData.tavilyCreditsUsed = 0;\n"
        "\n"
        "const nowIso = new Date().toISOString();\n"
        "const windowStart = new Date(Date.now() - %d * 24 * 3600 * 1000).toISOString();\n"
        "\n"
        "const counters0 = {\n"
        "  signals: hits.length,\n"
        "  candidates: survivors.length,\n"
        "  dropped_by_cap: droppedByCap,\n"
        "  dropped_no_url: droppedNoUrl,\n"
        "  window_start: windowStart,\n"
        "  window_end: nowIso,\n"
        "};\n"
        "\n"
        "// splitInBatches already no-ops on empty input (its own builderHint says so) -- an\n"
        "// empty array here is the correct, silent-safe way to signal \"no candidates this run\"\n"
        "// rather than feeding it a placeholder item with no hnStory to dereference downstream.\n"
        "if (survivors.length === 0) {\n"
        "  return [];\n"
        "}\n"
        "\n"
        "return survivors.map(function (hit) {\n"
        "  return { json: { hnStory: hit, counters0: counters0, now: nowIso } };\n"
        "});\n"
    ) % (GATE_BUDGET_DEFAULT, WINDOW_DAYS)
    tier0_node = code_node("Tier 0 - deterministic filter", tier0_js, -360, -80)
    nodes.append(tier0_node)

    # ---- Loop over survivors --------------------------------------------------
    loop_node = {
        "parameters": {"batchSize": 1, "options": {}},
        "id": nid(), "name": "Loop candidates (Split in Batches)",
        "type": "n8n-nodes-base.splitInBatches", "typeVersion": 3, "position": [-60, -80],
        "notes": "outputs: [done, loop] (n8n-nodes-base SplitInBatchesV3 source, confirmed "
                 "live in the running container). 'done' (index 0) fires once, carrying the "
                 "concatenation of every loop-body iteration's output -- fed straight into "
                 "'Run counters -> events' below. 'loop' (index 1) is the per-candidate body.",
    }
    nodes.append(loop_node)

    # ---- TIER 1: comment tree + user karma + entity pre-creation -------------
    http_item = http_node(
        "HTTP: HN item tree", "GET",
        "=https://hn.algolia.com/api/v1/items/{{ $json.hnStory.objectID }}",
        240, 220,
        notes="design.md §2.1: median num_comments is 0 -- an absent thread is a `missing` "
              "claim, not a failure; it is the common case.",
    )
    http_user = http_node(
        "HTTP: HN user karma", "GET",
        "=https://hn.algolia.com/api/v1/users/{{ $json.author }}",
        500, 220,
        notes="$json here is the PREVIOUS node's (HTTP: HN item tree) raw response -- HN's "
              "/items/{id} shape carries `author` at the top level, same person as hnStory.author.",
    )
    nodes += [http_item, http_user]

    tier1_js = (
        F02_LIB_BUNDLE
        + "\n"
        "// design.md §5.5(a): \"companies + applications must exist before the gate runs\".\n"
        "// This is the FIRST of two calls to buildWriteSet+applyWriteSet in this workflow\n"
        "// (see \"Tier 2 - Build write set + persist\" for the second, full-capability call).\n"
        "// capabilities.github/tavily are both false here because enrichment has not run yet,\n"
        "// so buildWriteSet naturally degrades to exactly design §5.5(a)'s field defaults\n"
        "// (title-derived company name, no org-aware naming, no cross-platform identity link)\n"
        "// with no special-casing in this node.\n"
        "const loopItem = $('Loop candidates (Split in Batches)').first().json;\n"
        "const hnStory = loopItem.hnStory;\n"
        "const now = loopItem.now;\n"
        "const hnThread = $('HTTP: HN item tree').first().json;\n"
        "const hnUser = $json;\n"
        "\n"
        "const deps = {\n"
        "  resolveIdentity, parseArtifactUrl, canonicalDomain, normalizeName, contentHash,\n"
        "  PRODUCERS, TOPIC, tierForSource, obscurity,\n"
        "};\n"
        "\n"
        "const writeSetTier1 = await buildWriteSet(\n"
        "  { hnStory, hnThread, hnUser, capabilities: { github: false, tavily: false }, now },\n"
        "  deps\n"
        ");\n"
        "\n"
        "const client = makeN8nSupabaseClient(this);\n"
        "const result = await applyWriteSet(writeSetTier1, { client });\n"
        "\n"
        "// design.md §7 item 2: opt-out is enforced AT INGEST -- write.js's applyWriteSet now\n"
        "// returns { blocked: true, reason: 'opt_out', ... } BEFORE writing anything (not even\n"
        "// the raw signal) when a matching founder_identities row's founder has\n"
        "// founders.opt_out_at set. result.ids is {} in that case -- \"IF: opted out?\" below\n"
        "// routes this candidate straight to the loop-back, never to the gate (there is no\n"
        "// application_id to gate against).\n"
        "if (result.blocked) {\n"
        "  return [{ json: {\n"
        "    tier1Blocked: true, hnStory, now,\n"
        "    optOutReason: result.reason, optOutMatchedIdentity: result.matchedIdentity,\n"
        "  } }];\n"
        "}\n"
        "\n"
        "const title = hnStory.title || '';\n"
        "const storyText = hnStory.story_text || '';\n"
        "\n"
        "return [{ json: {\n"
        "  tier1Blocked: false,\n"
        "  hnStory, hnThread, hnUser, now,\n"
        "  artifactLinks: writeSetTier1.application.artifact_links,\n"
        "  tavilySeed: writeSetTier1.decisions.siteCrawlSeed,\n"
        "  decisions: writeSetTier1.decisions,\n"
        "  tier1: result.ids,\n"
        "  tier1Created: result.created,\n"
        "  tier1Warnings: result.warnings,\n"
        "  tier1WriteSetCounts: {\n"
        "    rawSignals: writeSetTier1.rawSignals.length,\n"
        "    claims: writeSetTier1.claims.length,\n"
        "    metrics: writeSetTier1.metrics.length,\n"
        "  },\n"
        "  // design.md §5.5(c) exact call shape -- flat item, no .body wrapper. f07's own\n"
        "  // sub-workflow normaliser reads ONLY these four fields and ignores everything else\n"
        "  // on this item, so it is safe to also carry the context above forward on the SAME\n"
        "  // item straight into \"Gate: f07-thesis-gate\" -- no separate 'build gate request'\n"
        "  // node needed. geography_country stays null: GitHub `location` (design §3's\n"
        "  // normalisation target) is not known until Tier 2, which runs AFTER the gate by\n"
        "  // construction -- an honest, documented gap, not a silent one.\n"
        "  application_id: result.ids.application,\n"
        "  text: (title + '\\n\\n' + storyText).trim(),\n"
        "  mode: 'keyword',\n"
        "  structured_hints: { geography_country: null },\n"
        "} }];\n"
    )
    tier1_node = code_node(
        "Tier 1 - create entities + raw signals", tier1_js, 780, 220,
        notes="SOURCE OF TRUTH: lib/f02/{normalize,identity,claims,obscurity,pipeline,write}.js "
              "-- do not edit here, edit there and re-run n8n/build-f02-workflow.py.",
    )
    nodes.append(tier1_node)

    # ---- OPT-OUT GATE (design.md §7 item 2) -------------------------------------
    if_opted_out = if_node(
        "IF: opted out?", "={{ $json.tier1Blocked }}", True, "boolean", "equals", 1000, 460,
    )
    if_opted_out["notes"] = (
        "design.md §7 item 2: opt-out is enforced AT INGEST by write.js's applyWriteSet "
        "(lib/f02/ethics.js's isOptedOut), before Tier 1 writes anything. A blocked candidate "
        "has no application_id -- routes straight to the loop-back, never to the gate."
    )
    nodes.append(if_opted_out)

    opted_out_js = (
        "// design.md §7 item 2: nothing was written for this candidate (not even the raw\n"
        "// signal) -- fold it into the run counters as gated_out so it is visible, not silent.\n"
        "const inp = $json;\n"
        "return [{ json: {\n"
        "  hn_author: (inp.hnStory && inp.hnStory.author) || null,\n"
        "  gated: true, verdict: 'opt_out',\n"
        "  resolved: false, duplicates: 0, tavily_credits: 0,\n"
        "} }];\n"
    )
    opted_out_node = code_node("Opted out - skip", opted_out_js, 1000, 700)
    nodes.append(opted_out_node)

    # ---- GATE ------------------------------------------------------------------
    gate_node = {
        "parameters": {"source": "database", "workflowId": {"__rl": True, "value": GATE_WORKFLOW_ID, "mode": "id"}, "options": {}},
        "id": nid(), "name": "Gate: f07-thesis-gate", "type": "n8n-nodes-base.executeWorkflow",
        "typeVersion": 1.2, "position": [1260, 220],
        "notes": "mode:'keyword' -- no LLM, no GitHub token. Flat payload, no .body wrapper "
                 "(design.md §5.5(c)). Sub-workflow output REPLACES $json with the gate's "
                 "return contract: {application_id, thesis_id, evaluation_id, mode, verdict, "
                 "fit, coverage, fired_rules, missing_fields}.",
    }
    nodes.append(gate_node)

    if_verdict = if_node(
        "IF: verdict != failed", "={{ $json.verdict }}", "failed", "string", "notEquals", 1360, 220,
    )
    if_verdict["notes"] = (
        "design.md §5.5(c): FOUR-way outcome (passed | borderline | insufficient_evidence "
        "(response) == NULL (column) | failed) collapses to a two-way branch here -- only "
        "'failed' stops. keyword mode never returns 'passed' by design, so advancing only on "
        "'passed' would advance nobody."
    )
    nodes.append(if_verdict)

    # ---- TIER 2: GitHub + Tavily (parallel) -----------------------------------
    github_js = (
        "// design.md §5.4: GitHub REST unauthenticated is fine (60 req/h, no GITHUB_TOKEN\n"
        "// configured -- design §11); if a token is later added to infra/n8n/.env this node\n"
        "// picks it up automatically via $env.GITHUB_TOKEN, no code change needed.\n"
        "// Best-effort, never fatal (design §2 rationale 3, vantage's own error posture): any\n"
        "// single GitHub call failing degrades that candidate's E1/E3/E5/E7/X6 claims to \"no\n"
        "// attempt\", never aborts the run.\n"
        "\n"
        + RUNTIME_POLYFILL_JS + "\n"
        + NORMALIZE_JS + "\n"
        "const tier1ctx = $('Tier 1 - create entities + raw signals').first().json;\n"
        "const artifact = parseArtifactUrl(tier1ctx.hnStory.url);\n"
        "\n"
        "const headers = { 'User-Agent': 'the-vc-brain-f02-radar-scan', Accept: 'application/vnd.github+json' };\n"
        "if ($env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + $env.GITHUB_TOKEN;\n"
        "\n"
        "async function ghGet(self, url) {\n"
        "  try {\n"
        "    return await self.helpers.httpRequest({ method: 'GET', url, headers, json: true });\n"
        "  } catch (e) {\n"
        "    return null; // absent, not fatal -- design §2's \"best-effort, never fatal\"\n"
        "  }\n"
        "}\n"
        "\n"
        "let ghUser = null, ghRepo = null, ghRepos = null, ghContributors = null;\n"
        "let ghSearchPrs = null, ghEvents = null;\n"
        "\n"
        "if (artifact.kind === 'github_repo' || artifact.kind === 'github_user') {\n"
        "  ghUser = await ghGet(this, 'https://api.github.com/users/' + encodeURIComponent(artifact.owner));\n"
        "  ghRepos = await ghGet(this, 'https://api.github.com/users/' + encodeURIComponent(artifact.owner) + '/repos?per_page=100&sort=pushed');\n"
        "  // design.md §5.4, E1/E3 -- pipeline.js gates these on `personLinked` (a CONFIRMED\n"
        "  // person-level identity, never an Organization) internally, so it is safe to always\n"
        "  // fetch them here; the Search API's own tight unauthenticated budget (10 req/min)\n"
        "  // is why this is scoped to github-kind candidates only, not every candidate.\n"
        "  ghSearchPrs = await ghGet(this, 'https://api.github.com/search/issues?q=' + encodeURIComponent('author:' + artifact.owner + ' type:pr is:merged'));\n"
        "  ghEvents = await ghGet(this, 'https://api.github.com/users/' + encodeURIComponent(artifact.owner) + '/events');\n"
        "}\n"
        "if (artifact.kind === 'github_repo') {\n"
        "  ghRepo = await ghGet(this, 'https://api.github.com/repos/' + encodeURIComponent(artifact.owner) + '/' + encodeURIComponent(artifact.repo));\n"
        "  // design.md §4.1 tier 3: an Organization-owned artifact routes the company to the\n"
        "  // org itself; contributors are candidate people, each needs_review, no entity\n"
        "  // merge. lib/f02/pipeline.js persists this today only as a raw_signals row (no\n"
        "  // per-contributor founder split yet) -- fetched here so that row exists to persist.\n"
        "  if (ghUser && ghUser.type === 'Organization') {\n"
        "    ghContributors = await ghGet(this, 'https://api.github.com/repos/' + encodeURIComponent(artifact.owner) + '/' + encodeURIComponent(artifact.repo) + '/contributors');\n"
        "  }\n"
        "}\n"
        "\n"
        "return [{ json: { ghUser, ghRepo, ghRepos, ghContributors, ghSearchPrs, ghEvents } }];\n"
    )
    github_node = code_node("Tier 2 - GitHub enrichment", github_js, 1640, 60)
    nodes.append(github_node)

    tavily_js = (
        "// design.md §7.1: /map first; if it returns zero URLs (systematic on small static\n"
        "// personal sites -- verified live against two fixture sites), fall back to\n"
        "// extracting the ROOT page only rather than guessing conventional paths (guessing\n"
        "// /about, /blog etc. was tried live and both 404'd on the fixture site). §7.2: hard\n"
        "// per-run credit ceiling, enforced via workflow static data reset in\n"
        "// \"Tier 0 - deterministic filter\".\n"
        "\n"
        + RUNTIME_POLYFILL_JS + "\n"
        + NORMALIZE_JS + "\n"
        + DERIVE_SITE_CRAWL_SEED_JS + "\n"
        + ETHICS_JS + "\n"
        "const tier1ctx = $('Tier 1 - create entities + raw signals').first().json;\n"
        "const artifact = parseArtifactUrl(tier1ctx.hnStory.url);\n"
        "// parseArtifactUrl() itself returns {kind,owner,repo,host} -- NO `.url` field.\n"
        "// pipeline.js's buildWriteSet adds it itself (`artifact.url = artifactUrl`) because\n"
        "// deriveSiteCrawlSeed()/identity.js's tier-1-case-3 both key off artifact.url, not\n"
        "// just its host -- replicated here since this node calls parseArtifactUrl directly,\n"
        "// outside buildWriteSet. Its absence silently produced 'no_seed' for EVERY candidate\n"
        "// (deriveSiteCrawlSeed's own condition includes `artifact.url &&`) until caught live\n"
        "// against a real execution -- see n8n/workflows/README-f02.md.\n"
        "artifact.url = tier1ctx.hnStory.url;\n"
        "// ghUser is deliberately null here -- GitHub enrichment runs in a genuinely parallel\n"
        "// branch (design §7.2's Merge-node requirement), so the founder's GitHub `blog`\n"
        "// field (design §4.1's ~44%-of-the-time site-crawl seed) is not yet known when this\n"
        "// node runs. deriveSiteCrawlSeed() degrades correctly with ghUser=null: it falls\n"
        "// through to the artifact URL itself for a non-GitHub (product-path) candidate --\n"
        "// the majority case (design §4: ~73%) -- and yields no seed for a GitHub-hosted\n"
        "// artifact. Documented simplification, not a silent gap -- see README-f02.md.\n"
        "const seed = deriveSiteCrawlSeed(null, artifact, { canonicalDomain });\n"
        "\n"
        "const staticData = $getWorkflowStaticData('global');\n"
        "const budget = Number($env.TAVILY_CREDIT_BUDGET) || " + str(TAVILY_CREDIT_BUDGET_DEFAULT) + ";\n"
        "const alreadyUsed = Number(staticData.tavilyCreditsUsed) || 0;\n"
        "\n"
        "if (!seed || alreadyUsed >= budget) {\n"
        "  return [{ json: {\n"
        "    siteMap: null, siteExtract: null, tavilyCredits: 0,\n"
        "    tavilySkipped: !seed ? 'no_seed' : 'budget_exhausted',\n"
        "  } }];\n"
        "}\n"
        "\n"
        "// design.md §7 item 1: \"robots.txt is checked before any crawl, in a dedicated\n"
        "// node\" -- this IS that node (the only node in this workflow that crawls a\n"
        "// third-party site). lib/f02/ethics.js's checkRobots() takes an injected fetchFn;\n"
        "// this wraps this.helpers.httpRequest to match its {status, text()} contract.\n"
        "// Fetch failures/non-200 both resolve to 'allowed' inside checkRobots itself (a\n"
        "// site with no robots.txt has expressed no objection; an unreachable robots.txt\n"
        "// must not be indistinguishable from a disallow) -- this wrapper never throws.\n"
        "async function robotsFetchFn(self, url) {\n"
        "  try {\n"
        "    const body = await self.helpers.httpRequest({ method: 'GET', url, json: false });\n"
        "    return { status: 200, text: async () => String(body) };\n"
        "  } catch (e) {\n"
        "    const status = (e && e.statusCode) || (e && e.response && e.response.statusCode) ||\n"
        "      (e && e.cause && e.cause.response && e.cause.response.status) || null;\n"
        "    return { status };\n"
        "  }\n"
        "}\n"
        "\n"
        "const self = this;\n"
        "const robotsVerdict = await checkRobots(seed, function (url) { return robotsFetchFn(self, url); }, 'the-vc-brain-f02-radar-scan');\n"
        "if (!robotsVerdict.allowed) {\n"
        "  // design §7 item 1: \"the skip is recorded as an events row ... so it is visible\n"
        "  // rather than silent\" -- persisted here directly (this node is the one place\n"
        "  // that knows the verdict), not deferred to the run-counters node.\n"
        "  const SB = String($env.SUPABASE_URL || '').replace(/\\/rest\\/v1\\/?$/, '');\n"
        "  const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;\n"
        "  try {\n"
        "    await this.helpers.httpRequest({\n"
        "      method: 'POST', url: SB + '/rest/v1/events',\n"
        "      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },\n"
        "      body: crawlSkippedEvent(seed, robotsVerdict),\n"
        "      json: true,\n"
        "    });\n"
        "  } catch (e) { /* best-effort -- a failed audit write must not abort the run */ }\n"
        "  return [{ json: { siteMap: null, siteExtract: null, tavilyCredits: 0, tavilySkipped: 'robots_disallowed' } }];\n"
        "}\n"
        "\n"
        "const headers = { Authorization: 'Bearer ' + $env.TAVILY_API_KEY, 'Content-Type': 'application/json' };\n"
        "let siteMap = { results: [] };\n"
        "let creditsUsed = 0;\n"
        "\n"
        "try {\n"
        "  siteMap = await this.helpers.httpRequest({\n"
        "    method: 'POST', url: 'https://api.tavily.com/map',\n"
        "    headers, json: true,\n"
        "    body: { url: seed, allow_external: false, include_usage: true },\n"
        "  });\n"
        "  creditsUsed += (siteMap.usage && siteMap.usage.credits) || 0;\n"
        "} catch (e) {\n"
        "  siteMap = { results: [], error: (e && e.message) || String(e) };\n"
        "}\n"
        "\n"
        "// design.md §3: prioritise /about, /now, /blog, /changelog, /pricing; cap 20 (one\n"
        "// batched /extract -- 5 URLs = 1 credit per internal/research/tavily/02-*.md).\n"
        "const PRIORITY_PATHS = ['/about', '/now', '/blog', '/changelog', '/pricing'];\n"
        "let urls = Array.isArray(siteMap.results) ? siteMap.results.slice() : [];\n"
        "if (urls.length > 0) {\n"
        "  urls.sort(function (a, b) {\n"
        "    const aScore = PRIORITY_PATHS.some(function (p) { return a.indexOf(p) !== -1; }) ? 0 : 1;\n"
        "    const bScore = PRIORITY_PATHS.some(function (p) { return b.indexOf(p) !== -1; }) ? 0 : 1;\n"
        "    return aScore - bScore;\n"
        "  });\n"
        "  urls = urls.slice(0, 20);\n"
        "} else {\n"
        "  // §7.1 finding 2 -- /map returned zero URLs on both live fixture sites even though\n"
        "  // the sites themselves answer HTTP 200; root-page-only fallback.\n"
        "  urls = [seed];\n"
        "}\n"
        "\n"
        "let siteExtract = { results: [], failed_results: [] };\n"
        "try {\n"
        "  siteExtract = await this.helpers.httpRequest({\n"
        "    method: 'POST', url: 'https://api.tavily.com/extract',\n"
        "    headers, json: true,\n"
        "    body: { urls: urls, extract_depth: 'basic', format: 'text', include_usage: true },\n"
        "  });\n"
        "  creditsUsed += (siteExtract.usage && siteExtract.usage.credits) || 0;\n"
        "} catch (e) {\n"
        "  // §7.1 -- a failed extract is \"could not verify\", never \"project is dead\".\n"
        "  siteExtract = {\n"
        "    results: [],\n"
        "    failed_results: urls.map(function (u) { return { url: u, error: (e && e.message) || String(e) }; }),\n"
        "  };\n"
        "}\n"
        "\n"
        "staticData.tavilyCreditsUsed = alreadyUsed + creditsUsed;\n"
        "\n"
        "return [{ json: { siteMap, siteExtract, tavilyCredits: creditsUsed } }];\n"
    )
    tavily_node = code_node("Tier 2 - Tavily enrichment", tavily_js, 1640, 380)
    nodes.append(tavily_node)

    rejected_js = (
        "// design.md §2 rationale 3 / §5.5: rejects are persisted too -- the gate's own\n"
        "// f07-db-write / Write thesis_evaluations already wrote the rejection row against\n"
        "// Tier 1's application_id. This node's only job is to fold the candidate into the\n"
        "// run counters as gated_out; it writes nothing itself.\n"
        "const tier1ctx = $('Tier 1 - create entities + raw signals').first().json;\n"
        "const gate = $json;\n"
        "\n"
        "const dup =\n"
        "  (tier1ctx.tier1WriteSetCounts.rawSignals - tier1ctx.tier1Created.rawSignals) +\n"
        "  (tier1ctx.tier1WriteSetCounts.claims - tier1ctx.tier1Created.claims) +\n"
        "  (tier1ctx.tier1WriteSetCounts.metrics - tier1ctx.tier1Created.metrics);\n"
        "\n"
        "return [{ json: {\n"
        "  hn_author: tier1ctx.hnStory.author,\n"
        "  gated: true,\n"
        "  verdict: gate.verdict,\n"
        "  resolved: !!(tier1ctx.decisions && tier1ctx.decisions.crossPlatformLinked),\n"
        "  duplicates: dup,\n"
        "  tavily_credits: 0,\n"
        "} }];\n"
    )
    rejected_node = code_node("Rejected - skip Tier 2", rejected_js, 1640, 640)
    nodes.append(rejected_node)

    # Fan-in: two genuinely parallel branches (GitHub, Tavily) reconverging -- MUST use a
    # real Merge node (TRACKER.md ~05:05: a plain node with several wires into its single
    # input does NOT reliably wait for all of them in this n8n build; confirmed live for
    # f03's 4-way LLM fan-in, same n8n version here).
    merge_node = {
        "parameters": {"mode": "append", "numberInputs": 2},
        "id": nid(), "name": "Merge Tier 2 branches", "type": "n8n-nodes-base.merge",
        "typeVersion": 3.2, "position": [1920, 220],
        "notes": "mode:'append', numberInputs:2 -- GitHub branch -> input 0, Tavily branch -> "
                 "input 1. The downstream node ignores this node's own output payload (it "
                 "pulls GitHub/Tavily data via named-node lookups instead); this Merge exists "
                 "purely as the synchronization gate that guarantees BOTH branches completed "
                 "before Tier 2's write runs -- see TRACKER.md ~05:05.",
    }
    nodes.append(merge_node)

    tier2_js = (
        F02_LIB_BUNDLE
        + "\n"
        "// This is the SECOND call to buildWriteSet+applyWriteSet for this candidate (Tier 1\n"
        "// already ran the first, HN-only, pre-gate pass). founders/founder_identities\n"
        "// resolve idempotently (Tier 1's HN identity is found and reused); cards resolve\n"
        "// idempotently ((founder_id, card_type) natural key, write.js step 4);\n"
        "// raw_signals/claims/evidence/metrics resolve idempotently (content_hash / natural-\n"
        "// key, write.js steps 5-7) -- every claim/raw signal Tier 1 already wrote (e.g. L5,\n"
        "// hn_karma) recomputes to the IDENTICAL hash here and is a no-op, not a duplicate.\n"
        "// The one honest exception is `applications`: write.js's own insertAlways() has no\n"
        "// natural key for that table by design (matches 01/design.md's \"re-application = new\n"
        "// row\" stance), so this second call creates a SECOND applications row for this\n"
        "// candidate. That second row is inert -- never referenced by thesis_evaluations (the\n"
        "// gate already ran against Tier 1's row), never read by 03's founder_id-scoped\n"
        "// queries, and does not violate any product invariant (REQ-002/003, the GDPR FK\n"
        "// rule). Documented in n8n/workflows/README-f02.md rather than hidden -- the\n"
        "// alternative (hand-rolling a THIRD implementation of write.js's steps 5-7 starting\n"
        "// from pre-known ids) would itself be exactly the kind of duplicate, untested logic\n"
        "// path this project's build convention exists to avoid.\n"
        "const tier1ctx = $('Tier 1 - create entities + raw signals').first().json;\n"
        "const gate = $('Gate: f07-thesis-gate').first().json;\n"
        "const gh = $('Tier 2 - GitHub enrichment').first().json;\n"
        "const tavily = $('Tier 2 - Tavily enrichment').first().json;\n"
        "\n"
        "const deps = {\n"
        "  resolveIdentity, parseArtifactUrl, canonicalDomain, normalizeName, contentHash,\n"
        "  PRODUCERS, TOPIC, tierForSource, obscurity,\n"
        "};\n"
        "\n"
        "const writeSetFull = await buildWriteSet({\n"
        "  hnStory: tier1ctx.hnStory, hnThread: tier1ctx.hnThread, hnUser: tier1ctx.hnUser,\n"
        "  ghUser: gh.ghUser, ghRepo: gh.ghRepo, ghRepos: gh.ghRepos, ghContributors: gh.ghContributors,\n"
        "  ghSearchPrs: gh.ghSearchPrs, ghEvents: gh.ghEvents,\n"
        "  siteMap: tavily.siteMap, siteExtract: tavily.siteExtract,\n"
        "  capabilities: { github: true, tavily: true },\n"
        "  now: tier1ctx.now,\n"
        "}, deps);\n"
        "\n"
        "const client = makeN8nSupabaseClient(this);\n"
        "const result = await applyWriteSet(writeSetFull, { client });\n"
        "\n"
        "// design.md §7 item 2, defensive: an opt-out set BETWEEN Tier 1 and Tier 2 (a real\n"
        "// but narrow race, since Tier 1 already passed this same check for this founder) --\n"
        "// nothing further is written; fold into the run counters as gated_out rather than\n"
        "// throwing, since the gate already ran and Tier 1's rows already exist.\n"
        "if (result.blocked) {\n"
        "  return [{ json: {\n"
        "    hn_author: tier1ctx.hnStory.author,\n"
        "    gated: true, verdict: 'opt_out_race',\n"
        "    resolved: !!(tier1ctx.decisions && tier1ctx.decisions.crossPlatformLinked),\n"
        "    duplicates: 0, tavily_credits: Number(tavily.tavilyCredits) || 0,\n"
        "  } }];\n"
        "}\n"
        "\n"
        "const dupTier1 =\n"
        "  (tier1ctx.tier1WriteSetCounts.rawSignals - tier1ctx.tier1Created.rawSignals) +\n"
        "  (tier1ctx.tier1WriteSetCounts.claims - tier1ctx.tier1Created.claims) +\n"
        "  (tier1ctx.tier1WriteSetCounts.metrics - tier1ctx.tier1Created.metrics);\n"
        "const dupTier2 =\n"
        "  (writeSetFull.rawSignals.length - result.created.rawSignals) +\n"
        "  (writeSetFull.claims.length - result.created.claims) +\n"
        "  (writeSetFull.metrics.length - result.created.metrics);\n"
        "\n"
        "return [{ json: {\n"
        "  hn_author: tier1ctx.hnStory.author,\n"
        "  gated: false,\n"
        "  verdict: gate.verdict,\n"
        "  resolved: !!(writeSetFull.decisions && writeSetFull.decisions.crossPlatformLinked),\n"
        "  duplicates: dupTier1 + dupTier2,\n"
        "  tavily_credits: Number(tavily.tavilyCredits) || 0,\n"
        "} }];\n"
    )
    tier2_node = code_node(
        "Tier 2 - Build write set + persist", tier2_js, 2200, 220,
        notes="SOURCE OF TRUTH: lib/f02/{normalize,identity,claims,obscurity,pipeline,write}.js "
              "-- do not edit here, edit there and re-run n8n/build-f02-workflow.py. Second "
              "write pass, full capabilities -- see the in-node comment on the documented "
              "duplicate-applications-row limitation.",
    )
    nodes.append(tier2_node)

    # ---- Final aggregation ------------------------------------------------------
    counters_js = (
        "// design.md §6.2 (radar_scan_completed event) + this feature's own extension\n"
        "// (dropped_by_cap, tavily_credits). Fed by the splitInBatches \"done\" output (index\n"
        "// 0), which n8n's own SplitInBatchesV3 source concatenates from every loop-body\n"
        "// iteration's output (nodeContext.processedItems) -- one summary item per candidate,\n"
        "// whether it reached Tier 2 or was rejected at the gate.\n"
        "const items = $input.all();\n"
        "\n"
        "let resolved = 0, unresolved = 0, gated_out = 0, enriched = 0, duplicates = 0, tavily_credits = 0;\n"
        "for (const it of items) {\n"
        "  const j = it.json || {};\n"
        "  if (j.gated) gated_out += 1; else enriched += 1;\n"
        "  if (j.resolved) resolved += 1; else unresolved += 1;\n"
        "  duplicates += Number(j.duplicates) || 0;\n"
        "  tavily_credits += Number(j.tavily_credits) || 0;\n"
        "}\n"
        "\n"
        "// .all() (never .first()) on the Tier 0 lookup -- Tier 0 legitimately returns ZERO\n"
        "// items on a window with no candidates (see its own comment), and .first() throws on\n"
        "// empty where .all()[0] degrades to undefined.\n"
        "const t0items = $('Tier 0 - deterministic filter').all();\n"
        "const c0 = (t0items[0] && t0items[0].json && t0items[0].json.counters0) || null;\n"
        "const nowIso = new Date().toISOString();\n"
        "\n"
        "const payload = {\n"
        "  window_start: c0 ? c0.window_start : new Date(Date.now() - %d * 24 * 3600 * 1000).toISOString(),\n"
        "  window_end: c0 ? c0.window_end : nowIso,\n"
        "  counters: {\n"
        "    signals: c0 ? c0.signals : 0,\n"
        "    candidates: c0 ? c0.candidates : items.length,\n"
        "    resolved, unresolved, duplicates, gated_out, enriched,\n"
        "    dropped_by_cap: c0 ? c0.dropped_by_cap : 0,\n"
        "    tavily_credits,\n"
        "  },\n"
        "};\n"
        "\n"
        + "const SB = " + 'String($env.SUPABASE_URL || \'\').replace(/\\/rest\\/v1\\/?$/, \'\');' + "\n"
        "const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;\n"
        "const rows = await this.helpers.httpRequest({\n"
        "  method: 'POST', url: SB + '/rest/v1/events',\n"
        "  headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },\n"
        "  body: {\n"
        "    event_type: 'radar_scan_completed',\n"
        "    entity_type: null, entity_id: null,\n"
        "    payload,\n"
        "    actor: 'n8n:f02-radar-scan:' + String($execution.id),\n"
        "  },\n"
        "  json: true,\n"
        "});\n"
        "\n"
        "return [{ json: { event: (rows && rows[0]) || null, payload } }];\n"
    ) % WINDOW_DAYS
    counters_node = code_node("Run counters -> events", counters_js, 240, -420)
    nodes.append(counters_node)

    # ---- Sticky notes ------------------------------------------------------------
    nodes.append(sticky(
        "Note: TIER 0",
        "### TIER 0 -- free, deterministic, no LLM, no key\n"
        "HN Algolia search_by_date, 14-day window, points>=2. Drop hits with no\n"
        "url; sort by created_at_i DESC; take gate_budget (default 120).\n"
        "The cap is by RECENCY, never by points (design.md §2/§10 decision 2).\n"
        "Dropped counts are always logged into counters0, never silent.",
        -980, -400, 620, 260,
    ))
    nodes.append(sticky(
        "Note: TIER 1 + GATE",
        "### TIER 1 -- one extra call per survivor, then GATE\n"
        "HN comment tree + user karma. Then founders + companies +\n"
        "applications are created BEFORE any raw_signals row is written\n"
        "(design.md §5.0 rule 0) -- a raw_signals row with both FKs NULL can\n"
        "never be reached by purge_founder() and the table is append-only.\n\n"
        "GATE calls f07-thesis-gate in mode:'keyword' (no LLM, no GitHub\n"
        "token). FOUR-way outcome collapses to a two-way branch: only\n"
        "'failed' stops (design.md §5.5(c)) -- keyword mode never returns\n"
        "'passed' by design, so gating on 'passed' would advance nobody.",
        180, 460, 1360, 300,
    ))
    nodes.append(sticky(
        "Note: TIER 2",
        "### TIER 2 -- expensive, only past the gate\n"
        "GitHub REST (unauthenticated, 60 req/h -- no GITHUB_TOKEN configured,\n"
        "design.md §11) and Tavily /map -> one batched /extract run as\n"
        "genuinely PARALLEL branches and reconverge through a real Merge node\n"
        "(mode:'append', numberInputs:2) -- TRACKER.md ~05:05: several wires\n"
        "into one plain node's input does NOT reliably wait for both branches\n"
        "in this n8n build. Tavily enforces a hard per-run credit ceiling via\n"
        "workflow static data (design.md §7.2, default 150).\n\n"
        "\"Tier 2 - Build write set + persist\" calls buildWriteSet then the\n"
        "writer a SECOND time (full capabilities) -- see its own in-node\n"
        "comment for the documented duplicate-applications-row limitation.",
        1560, -60, 900, 800,
    ))
    nodes.append(sticky(
        "Note: loop pattern",
        "### LOOP: Split in Batches\n"
        "batchSize:1. 'loop' output (index 1) feeds the per-candidate chain;\n"
        "BOTH exit paths (\"Tier 2 - Build write set + persist\" success and\n"
        "\"Rejected - skip Tier 2\") wire back into this node's single input --\n"
        "an exclusive IF/Switch reconverge is fine with multiple wires (only\n"
        "one branch is ever live per candidate); ONLY the genuinely parallel\n"
        "GitHub/Tavily fan-in above needs the real Merge node.\n\n"
        "'done' output (index 0) fires once, carrying every candidate's\n"
        "summary item concatenated -> \"Run counters -> events\".",
        -60, 900, 620, 300,
    ))

    # ---- Connections ---------------------------------------------------------------
    conns = merge_connections(
        connect(
            ("Manual Trigger", 0, "HTTP: HN Algolia search", 0),
            ("Schedule Trigger", 0, "HTTP: HN Algolia search", 0),
            ("HTTP: HN Algolia search", 0, "Tier 0 - deterministic filter", 0),
            ("Tier 0 - deterministic filter", 0, "Loop candidates (Split in Batches)", 0),
        ),
        # splitInBatches outputs: [done, loop]
        {"Loop candidates (Split in Batches)": {"main": [
            [{"node": "Run counters -> events", "type": "main", "index": 0}],
            [{"node": "HTTP: HN item tree", "type": "main", "index": 0}],
        ]}},
        connect(
            ("HTTP: HN item tree", 0, "HTTP: HN user karma", 0),
            ("HTTP: HN user karma", 0, "Tier 1 - create entities + raw signals", 0),
            ("Tier 1 - create entities + raw signals", 0, "IF: opted out?", 0),
        ),
        # IF v2: output 0 = true (blocked, design §7 item 2), output 1 = false (proceed to gate)
        {"IF: opted out?": {"main": [
            [{"node": "Opted out - skip", "type": "main", "index": 0}],
            [{"node": "Gate: f07-thesis-gate", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Gate: f07-thesis-gate", 0, "IF: verdict != failed", 0),
        ),
        # IF v2: output 0 = true (advance), output 1 = false (stop)
        {"IF: verdict != failed": {"main": [
            [
                {"node": "Tier 2 - GitHub enrichment", "type": "main", "index": 0},
                {"node": "Tier 2 - Tavily enrichment", "type": "main", "index": 0},
            ],
            [{"node": "Rejected - skip Tier 2", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Tier 2 - GitHub enrichment", 0, "Merge Tier 2 branches", 0),
            ("Tier 2 - Tavily enrichment", 0, "Merge Tier 2 branches", 1),
            ("Merge Tier 2 branches", 0, "Tier 2 - Build write set + persist", 0),
        ),
        # Loop back -- exclusive exit paths, multiple wires into one input is fine here
        # (TRACKER.md: "An IF/Switch reconverge, where only one branch is ever live, is fine
        # as-is" -- unlike the genuinely parallel GitHub/Tavily fan-in above).
        connect(
            ("Tier 2 - Build write set + persist", 0, "Loop candidates (Split in Batches)", 0),
            ("Rejected - skip Tier 2", 0, "Loop candidates (Split in Batches)", 0),
            ("Opted out - skip", 0, "Loop candidates (Split in Batches)", 0),
        ),
    )

    workflow = {
        "name": "f02-radar-scan",
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
