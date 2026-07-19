#!/usr/bin/env python3
"""
Build the feature-05 n8n workflow JSON (f05-trust-rollup) from source.

Why a generator rather than hand-maintained JSON: the deterministic rollup math lives in
lib/f05/trust.js (computeTrustRollup), unit-tested outside n8n. n8n's Code-node sandbox cannot
`require()` from this repo (see infra/n8n/docker-compose.yml -- no bind-mount,
NODE_FUNCTION_ALLOW_EXTERNAL unset), so that source has to be *inlined* into the ROLLUP node
verbatim. Doing that inlining by hand risks the tested module and the running workflow silently
drifting apart -- the exact class of defect this generator exists to prevent, same approach
n8n/build-f03-workflow.py takes for lib/f03/{gate,scoring}.js (kept independent here, no shared
import, per that generator's own precedent).

This is the ONLY workflow feature 06 is blocked on (plan.md task C1a). Zero LLM: given
{ application_id }, it reads score_formulas + claim_trust (the view feature 05's `A1` terminal
built), computes the Trust axis rollup, and writes exactly one `scores(axis='trust')` row -- or,
below min_coverage, writes NO row and emits a `trust_rollup_insufficient_evidence` event instead
(design.md SS8.2/SS8.3, SS14: "an absent scores row means not assessed... must never render as
zero"). The claim-routing / evidence-writing checks (gh_provenance, quote_guard) are a SEPARATE
workflow (f05-verify-claims, task C1b) -- this one only rolls up whatever claim_trust already
shows at read time.

Run after any change to lib/f05/trust.js:

    python3 n8n/build-f05-workflow.py           # regenerate n8n/workflows/f05-trust-rollup.json
    python3 n8n/build-f05-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f05.md).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f05')
AGENTS_DIR = os.path.join(ROOT, 'docs', 'backlog', '05-truth-gap-trust', 'agents')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

# gpt-5.6-luna, temperature omitted (rejects 0 -- verified live building 03/04, restated in both
# agents/*.md here) -- task C1b's own two LLM call sites (contradiction-detector K=2,
# entity-matcher step 3 of the gate). f05-trust-rollup (C1a, above) has none of its own since it
# is zero-LLM by design -- these constants are new to this generator.
MODEL = 'gpt-5.6-luna'
PROMPT_VERSION = 'p1-2026.07'


# ----------------------------------------------------------------------------
# Source extraction -- lib/f05/trust.js pasted verbatim (module.exports stripped, it is
# CommonJS glue, not logic), identical technique to n8n/build-f03-workflow.py's inline_module.
# ----------------------------------------------------------------------------

def inline_module(filename):
    """Read lib/f05/<filename>.js verbatim, stripping only the CommonJS
    `module.exports = {...};` tail -- n8n's Code-node sandbox does not define `module`, so that
    line would throw ReferenceError, but the functions it exports are already in scope once the
    rest of the file is pasted in."""
    src = open(os.path.join(LIBDIR, filename), encoding='utf-8').read()
    stripped = re.sub(r"module\.exports\s*=\s*\{.*?\};\s*\Z", "", src, flags=re.S)
    assert 'module.exports' not in stripped, "module.exports strip failed for " + filename
    assert 'require(' not in re.sub(r"//[^\n]*", "", stripped), \
        filename + " must stay zero-import (plan.md's C1a note: only run.js, B3, may require())"
    return stripped.rstrip() + "\n"


TRUST_JS = inline_module('trust.js')

# task C1b (this file's own addition): router.js/verifiers.js/quote_guard.js/entity_gate.js --
# the four modules the team lead's brief names explicitly ("Reuse via inlining"). trust.js above
# is ALSO reused here (its scopeClaimsToApplication()) even though the brief's list did not name
# it -- design SS8.1's company_id restriction on route 3 is load-bearing (a founder's OTHER
# company's claims must not leak into THIS application's checks), C1a already proved the
# inline-verbatim pattern works for it, and lib/f05/run.js (the reference this task wraps, not
# reimplements) applies the identical restriction at the identical point in its own pipeline.
ROUTER_JS = inline_module('router.js')
VERIFIERS_JS = inline_module('verifiers.js')
QUOTE_GUARD_JS = inline_module('quote_guard.js')
ENTITY_GATE_JS = inline_module('entity_gate.js')


def agent_system_prompt(name):
    """Pull the '## System prompt' XML block out of docs/backlog/05-truth-gap-trust/agents/
    <name>.md verbatim -- same extraction technique n8n/build-f03-workflow.py uses for its own
    agents, independently pointed at THIS feature's agents/ dir (no shared import between
    generators, same precedent both files already state for their own JS inlining), widened here
    because contradiction-detector.md/entity-matcher.md (unlike f03's agent files) each carry an
    explanatory paragraph BETWEEN the '## System prompt' heading and the ```xml fence itself --
    f03's stricter \\s*\\n``` (fence immediately after the heading) does not match here, so this
    finds the heading first, then the first ```xml fence AFTER it, wherever it falls."""
    text = open(os.path.join(AGENTS_DIR, name + '.md'), encoding='utf-8').read()
    h = re.search(r"## System prompt\s*\n", text)
    if not h:
        raise SystemExit("could not find '## System prompt' heading in %s.md" % name)
    m = re.search(r"```xml\n(.*?)\n```", text[h.end():], re.S)
    if not m:
        raise SystemExit("could not find a ```xml fence after '## System prompt' in %s.md" % name)
    return m.group(1)


def agent_schema(name):
    text = open(os.path.join(AGENTS_DIR, name + '.md'), encoding='utf-8').read()
    m = re.search(r"## Output JSON Schema\s*\n```json\n(.*?)\n```", text, re.S)
    if not m:
        raise SystemExit("could not find '## Output JSON Schema' block in %s.md" % name)
    return json.loads(m.group(1))


CONTRADICTION_DETECTOR_PROMPT = agent_system_prompt('contradiction-detector')
CONTRADICTION_DETECTOR_SCHEMA = agent_schema('contradiction-detector')
ENTITY_MATCHER_PROMPT = agent_system_prompt('entity-matcher')
ENTITY_MATCHER_SCHEMA = agent_schema('entity-matcher')


# ----------------------------------------------------------------------------
# n8n node/connection helpers (mirrors n8n/build-f03-workflow.py's conventions verbatim --
# same generator shape, independently maintained per that file's own precedent).
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
    Multiple pairs sharing the same (source_name, output_index) fan out to several targets;
    multiple pairs sharing the same target across different sources fan in (n8n concatenates the
    incoming items)."""
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
    and references to $json/$input/$env/$execution/this parse and resolve without actually
    running network calls."""
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
# and "http://host.docker.internal:8000/rest/v1" (feature 03's own tracker changelog entry) --
# stripping a trailing /rest/v1 here and always appending it back is correct regardless of which
# convention $env.SUPABASE_URL currently holds. Identical to build-f03-workflow.py's SB_NORMALIZE
# (kept as an independent copy per that generator's own no-shared-import precedent).
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

    # ---- Entry points ------------------------------------------------------
    webhook = {
        "parameters": {
            "httpMethod": "POST", "path": "f05-trust-rollup",
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
        "// Webhook body carries { application_id }. design.md SS8: 05's rollup scores the\n"
        "// APPLICATION, not the founder -- 03 already owns founder_id-keyed scores.\n"
        "const item = $input.first().json;\n"
        "const body = item.body || {};\n"
        "const application_id = body.application_id || item.application_id;\n"
        "if (!application_id) throw new Error('f05-trust-rollup: application_id is required');\n"
        "return [{ json: { application_id } }];\n",
        -180, -140,
    )
    norm_sub = code_node(
        "Normalize Sub-workflow Input",
        "// Called by 06/09/10 as a sub-workflow with { application_id }.\n"
        "const item = $input.first().json || {};\n"
        "const application_id = item.application_id;\n"
        "if (!application_id) throw new Error('f05-trust-rollup: application_id is required');\n"
        "return [{ json: { application_id } }];\n",
        -180, 140,
    )
    nodes += [norm_webhook, norm_sub]

    gen_run_id = code_node(
        "Generate run_id",
        "// One UUID per rollup run -- echoed into the trust_rollup_insufficient_evidence\n"
        "// event's payload when the coverage gate fails (lib/f05/trust.js's ctx.runId,\n"
        "// design.md SS8.2). globalThis.crypto is undefined inside this n8n build's actual\n"
        "// Code-node VM sandbox (verified live 2026-07-19 -- a plain `docker exec node -e`\n"
        "// process exposes it, the task-runner's sandbox does not), so require('crypto') is\n"
        "// used instead -- allow-listed in infra/n8n/docker-compose.yml\n"
        "// (NODE_FUNCTION_ALLOW_BUILTIN=crypto,url), same proven pattern as f03's own\n"
        "// gen_run_id node.\n"
        "const { randomUUID } = require('crypto');\n"
        "const inp = $input.first().json;\n"
        "return [{ json: { application_id: inp.application_id, run_id: randomUUID() } }];\n",
        60, 0,
    )
    nodes.append(gen_run_id)

    # ---- Read side: ctx resolution + active formula -------------------------
    load_application = code_node(
        "Load application + company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'applications?id=eq.' + inp.application_id + '&select=id,company_id');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error('f05-trust-rollup: no application found for id ' + inp.application_id);\n"
        "}\n"
        "return [{ json: { ...inp, company_id: rows[0].company_id } }];\n",
        340, 0,
    )

    load_founder_ids = code_node(
        "Load founder_ids for company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.1 route 3's founderIds -- \"resolved by the caller with a\n"
        "// single-table lookup, not re-derived\" inside trust.js (lib/f05/trust.js's own file\n"
        "// header contract).\n"
        "const rows = await pgGet.call(this,\n"
        "  'founder_company?company_id=eq.' + inp.company_id + '&select=founder_id');\n"
        "const founder_ids = (rows || []).map(function (r) { return r.founder_id; }).filter(Boolean);\n"
        "return [{ json: { ...inp, founder_ids } }];\n",
        620, 0,
    )

    load_formula = code_node(
        "Load active trust_v1 formula",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'score_formulas?axis=eq.trust&active=eq.true&select=version,config&limit=1');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error(\"f05-trust-rollup: no active score_formulas row for axis='trust'\");\n"
        "}\n"
        "// lib/f05/trust.js's own config shape -- { version, min_coverage } (SS7.5/SS8.2's\n"
        "// LEFT JOIN + literal-fallback discipline: read the live row here rather than a\n"
        "// second hardcoded copy; computeTrustRollup applies its OWN literal fallback if\n"
        "// config.rollup is entirely absent, e.g. a fresh clone before seed.sql has run).\n"
        "const rollup_cfg = rows[0].config && rows[0].config.rollup;\n"
        "const rollup_config = { version: rows[0].version, min_coverage: rollup_cfg && rollup_cfg.min_coverage };\n"
        "return [{ json: { ...inp, rollup_config } }];\n",
        900, 0,
    )
    nodes += [load_application, load_founder_ids, load_formula]

    # ---- Scope resolution: cards (OR filter) -> claim_trust (card_id IN) ----
    load_scope_cards = code_node(
        "Load scope card ids",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.1 -- the same three OR'd routes lib/f05/trust.js's own\n"
        "// isClaimInScope() applies in JS, expressed here as a PostgREST 'or' filter over\n"
        "// `cards`. claim_trust is a VIEW with no FK metadata PostgREST can embed through, so\n"
        "// the join happens as two round trips -- cards first (this node), then claim_trust\n"
        "// filtered by card_id (next node), merged back together there. This query is the\n"
        "// UNRESTRICTED superset (route 3 with no company_id restriction) -- lib/f05/trust.js's\n"
        "// own scopeClaimsToApplication() applies that restriction inside the ROLLUP node\n"
        "// below, exactly as its file header documents (\"a caller may pass a superset and\n"
        "// rely on this module for the restriction\").\n"
        "const orParts = [\n"
        "  'application_id.eq.' + inp.application_id,\n"
        "  'company_id.eq.' + inp.company_id,\n"
        "];\n"
        "if (inp.founder_ids && inp.founder_ids.length) {\n"
        "  orParts.push('founder_id.in.(' + inp.founder_ids.join(',') + ')');\n"
        "}\n"
        "const cards = await pgGet.call(this,\n"
        "  'cards?select=id,application_id,company_id,founder_id&or=(' + orParts.join(',') + ')');\n"
        "return [{ json: { ...inp, scope_cards: cards || [] } }];\n",
        1180, 0,
    )

    load_claim_trust = code_node(
        "Load claim_trust rows (scoped)",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const cardIds = (inp.scope_cards || []).map(function (c) { return c.id; });\n"
        "let claimRows = [];\n"
        "if (cardIds.length) {\n"
        "  claimRows = await pgGet.call(this,\n"
        "    'claim_trust?select=claim_id,card_id,topic,router_class,derived_status,trust,' +\n"
        "    'independence_factor,n_supports,n_contradicts&card_id=in.(' + cardIds.join(',') + ')');\n"
        "}\n"
        "\n"
        "// Column-contract reconciliation (lib/f05/run.js's own term for this same step):\n"
        "// claim_trust exposes only card_id, not the three card FKs lib/f05/trust.js's row\n"
        "// shape needs (card_application_id/card_company_id/card_founder_id) -- merged in here\n"
        "// from the cards rows fetched by the previous node, keyed by card_id.\n"
        "const cardsById = new Map((inp.scope_cards || []).map(function (c) { return [c.id, c]; }));\n"
        "const rows = (claimRows || []).map(function (r) {\n"
        "  const card = cardsById.get(r.card_id) || {};\n"
        "  return {\n"
        "    claim_id: r.claim_id,\n"
        "    topic: r.topic,\n"
        "    class: r.router_class,\n"
        "    derived_status: r.derived_status,\n"
        "    trust: r.trust,\n"
        "    independence_factor: r.independence_factor,\n"
        "    n_supports: r.n_supports,\n"
        "    n_contradicts: r.n_contradicts,\n"
        "    card_application_id: card.application_id || null,\n"
        "    card_company_id: card.company_id || null,\n"
        "    card_founder_id: card.founder_id || null,\n"
        "  };\n"
        "});\n"
        "return [{ json: { ...inp, rows } }];\n",
        1460, 0,
    )
    nodes += [load_scope_cards, load_claim_trust]

    # ---- Deterministic core -- no LLM anywhere in this workflow -------------
    rollup_node = code_node(
        "ROLLUP - trust.js (computeTrustRollup)",
        "// SOURCE OF TRUTH: lib/f05/trust.js -- do not edit here, edit there and re-run\n"
        "// n8n/build-f05-workflow.py. Body below is pasted VERBATIM (only the trailing\n"
        "// `module.exports` block is stripped -- n8n's sandbox does not define `module`).\n"
        "// Zero LLM: pure arithmetic over score_formulas.config -- design.md SS8.2's whole\n"
        "// point is that the rollup is a SELECT, never a model call (SS6.0b: \"confidence in\n"
        "// this feature is computed from evidence structure, never reported by a model\").\n"
        "\n" + TRUST_JS + "\n"
        "// ---- invocation ----\n"
        "const inp = $input.first().json;\n"
        "const ctx = {\n"
        "  applicationId: inp.application_id,\n"
        "  companyId: inp.company_id,\n"
        "  founderIds: inp.founder_ids || [],\n"
        "  runId: inp.run_id,\n"
        "};\n"
        "const rollup = computeTrustRollup(inp.rows || [], inp.rollup_config || {}, ctx);\n"
        "return [{ json: { ...inp, rollup } }];\n",
        1740, 0,
        notes="SOURCE OF TRUTH: lib/f05/trust.js -- do not edit here, edit there and re-paste "
              "(via n8n/build-f05-workflow.py). No LLM call anywhere in this node.",
    )
    nodes.append(rollup_node)

    if_node = {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                "conditions": [{
                    "id": nid(),
                    "leftValue": "={{ $json.rollup.status }}",
                    "rightValue": "insufficient_evidence",
                    "operator": {"type": "string", "operation": "equals"},
                }],
                "combinator": "and",
            },
            "options": {},
        },
        "id": nid(), "name": "IF: insufficient_evidence?", "type": "n8n-nodes-base.if",
        "typeVersion": 2, "position": [2020, 0],
    }
    nodes.append(if_node)

    write_event = code_node(
        "Write event (insufficient_evidence)",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.2/SS8.3 -- coverage below min_coverage writes NO scores row (there is\n"
        "// no honest number to persist into a NOT NULL numeric(5,2) column without\n"
        "// fabricating); one events row is the queryable, timestamped marker so 'not assessed'\n"
        "// is never confused with a silent zero (SS14: \"an absent scores(axis='trust') row\n"
        "// means not assessed... it must never render as zero\"). rollup.event is already the\n"
        "// full { event_type, entity_type, entity_id, payload } shape lib/f05/trust.js builds --\n"
        "// written here verbatim, no reshaping.\n"
        "await pg.call(this, 'POST', 'events', {\n"
        "  event_type: inp.rollup.event.event_type,\n"
        "  entity_type: inp.rollup.event.entity_type,\n"
        "  entity_id: inp.rollup.event.entity_id,\n"
        "  payload: inp.rollup.event.payload,\n"
        "  actor: 'f05-trust-rollup',\n"
        "}, 'return=minimal');\n"
        "return [{ json: { ...inp, score_id: null } }];\n",
        2300, -150,
    )
    write_scores = code_node(
        "Write scores row (trust)",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.2/SS8.3 -- no idempotency guard by design (\"accept duplicates under\n"
        "// append-only semantics... resolve current by max(computed_at)\"), matching scores'\n"
        "// own project-wide write convention (e.g. lib/f03/run.js's writeScored).\n"
        "const sr = inp.rollup.scoresRow;\n"
        "const rows = await pg.call(this, 'POST', 'scores', {\n"
        "  application_id: sr.application_id,\n"
        "  founder_id: null,\n"
        "  axis: 'trust',\n"
        "  value: sr.value,\n"
        "  confidence: sr.confidence,\n"
        "  missing_flags: sr.missing_flags,\n"
        "  input_claim_ids: sr.input_claim_ids,\n"
        "  formula_version: sr.formula_version,\n"
        "  model: null,\n"
        "}, 'return=representation');\n"
        "return [{ json: { ...inp, score_id: rows[0].id } }];\n",
        2300, 150,
    )
    nodes += [write_event, write_scores]

    build_contract = code_node(
        "Build output contract",
        "// design.md SS8.2's summary contract -- terminal node: its return value is both the\n"
        "// webhook HTTP response (responseMode: lastNode) and the value returned to a caller\n"
        "// invoking this as a sub-workflow (06/09/10).\n"
        "const inp = $input.first().json;\n"
        "const rollup = inp.rollup;\n"
        "return [{ json: {\n"
        "  application_id: inp.application_id, run_id: inp.run_id,\n"
        "  status: rollup.status, score_id: inp.score_id || null, axis: 'trust',\n"
        "  coverage: rollup.coverage, verdict_eligible_count: rollup.verdictEligibleCount,\n"
        "  assessed_count: rollup.assessedCount, missing_flags: rollup.missingFlags,\n"
        "  scores_row: rollup.scoresRow, formula_version: inp.rollup_config.version,\n"
        "} }];\n",
        2580, 0,
    )
    nodes.append(build_contract)

    # ---- Sticky notes --------------------------------------------------------
    nodes.append(sticky(
        "Note: scope resolution",
        "### SCOPE = SS8.1's THREE OR'D ROUTES\n"
        "`cards` matching application_id, OR company_id, OR a\n"
        "founder on this company (unrestricted superset) -- then\n"
        "`claim_trust` by card_id. lib/f05/trust.js's own\n"
        "scopeClaimsToApplication() applies route 3's company_id\n"
        "restriction inside ROLLUP, not here.",
        1160, -420, 460, 240,
    ))
    nodes.append(sticky(
        "Note: deterministic core, no LLM",
        "### ZERO LLM -- THE ROLLUP IS A SELECT (design.md SS6.0b)\n"
        "ROLLUP (`lib/f05/trust.js`, pasted verbatim) is pure\n"
        "arithmetic over `score_formulas.config` -- coverage,\n"
        "value and confidence, all derived from claim_trust's\n"
        "already-computed per-claim numbers. Below `min_coverage`:\n"
        "NO scores row, one `trust_rollup_insufficient_evidence`\n"
        "event instead -- absence is not zero (design.md SS14).",
        1720, -420, 1080, 260,
    ))

    # ---- Connections -----------------------------------------------------------
    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Execute Workflow Trigger", 0, "Normalize Sub-workflow Input", 0),
            ("Normalize Webhook Input", 0, "Generate run_id", 0),
            ("Normalize Sub-workflow Input", 0, "Generate run_id", 0),
            ("Generate run_id", 0, "Load application + company", 0),
            ("Load application + company", 0, "Load founder_ids for company", 0),
            ("Load founder_ids for company", 0, "Load active trust_v1 formula", 0),
            ("Load active trust_v1 formula", 0, "Load scope card ids", 0),
            ("Load scope card ids", 0, "Load claim_trust rows (scoped)", 0),
            ("Load claim_trust rows (scoped)", 0, "ROLLUP - trust.js (computeTrustRollup)", 0),
            ("ROLLUP - trust.js (computeTrustRollup)", 0, "IF: insufficient_evidence?", 0),
        ),
        # IF v2: output 0 = true, output 1 = false
        connect(
            ("IF: insufficient_evidence?", 0, "Write event (insufficient_evidence)", 0),
        ),
        {"IF: insufficient_evidence?": {"main": [[], [
            {"node": "Write scores row (trust)", "type": "main", "index": 0}
        ]]}},
        connect(
            ("Write event (insufficient_evidence)", 0, "Build output contract", 0),
            ("Write scores row (trust)", 0, "Build output contract", 0),
        ),
    )

    workflow = {
        "name": "f05-trust-rollup",
        "nodes": nodes,
        "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": True},
    }
    return workflow


def build_verify_claims():
    """f05-verify-claims (plan.md task C1b, design.md SS4/SS5/SS9/SS11): given { application_id },
    resolve scope exactly as f05-trust-rollup does, route every scoped claim (lib/f05/router.js),
    run the two deterministic SS5.1 checks (gh_provenance, quote_guard) plus denominator
    extraction (advisory), pass every confirmed contradiction CANDIDATE through the entity gate
    (lib/f05/entity_gate.js) using ONLY steps 1-2 -- the LLM hook (step 3) is never called here,
    matching lib/f05/run.js's own choice ("step 3 is omitted, owned by C1b") -- then write
    `evidence` + `events` (+ one `ai_runs` ledger row, confidence NULL). Zero LLM, zero external
    network call anywhere in this workflow: design SS5.1 calls factual_static's external cost
    "none", and this workflow is that promise kept.

    This is a hand-port of lib/f05/run.js's steps 1-9 (NOT step 10's rollup -- that stays
    f05-trust-rollup's own job -- and NOT step 11's write-back, which design SS8.4 binds to a
    SUCCESSFUL rollup, which this workflow never runs). run.js itself cannot be pasted verbatim:
    it is a Node CLI that requires node:fs/node:crypto/node:child_process and shells out to
    psql, not a zero-import Code-node module. What IS pasted verbatim, per the team lead's own
    brief, is router.js/verifiers.js/quote_guard.js/entity_gate.js -- the orchestration around
    them below is freshly written to reproduce run.js's logic faithfully over PostgREST instead
    of psql, cross-checked line by line against the live, QA'd reference implementation.
    """
    nodes = []

    webhook = {
        "parameters": {
            "httpMethod": "POST", "path": "f05-verify-claims",
            "responseMode": "lastNode", "options": {},
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
        "// Webhook body carries { application_id } -- same subject as f05-trust-rollup (design.md\n"
        "// SS8: 05 always operates at application scope, never bare card/claim scope, so the\n"
        "// SS8.1 scoping rule is applied identically by every f05 workflow).\n"
        "const item = $input.first().json;\n"
        "const body = item.body || {};\n"
        "const application_id = body.application_id || item.application_id;\n"
        "if (!application_id) throw new Error('f05-verify-claims: application_id is required');\n"
        "return [{ json: { application_id } }];\n",
        -180, -140,
    )
    norm_sub = code_node(
        "Normalize Sub-workflow Input",
        "// Called by 06/09/10 (or a manual test) as a sub-workflow with { application_id }.\n"
        "const item = $input.first().json || {};\n"
        "const application_id = item.application_id;\n"
        "if (!application_id) throw new Error('f05-verify-claims: application_id is required');\n"
        "return [{ json: { application_id } }];\n",
        -180, 140,
    )
    nodes += [norm_webhook, norm_sub]

    gen_run_id = code_node(
        "Generate run_id",
        "// One UUID per verification run -- echoed into every event payload below (design.md SS9's\n"
        "// audit trail). require('crypto') -- globalThis.crypto is undefined inside this n8n\n"
        "// build's actual Code-node VM sandbox (verified live 2026-07-19, restated in\n"
        "// n8n/workflows/README-f05.md), even though a bare `docker exec node -e` process on the\n"
        "// same container exposes it fine. Allow-listed via\n"
        "// infra/n8n/docker-compose.yml's NODE_FUNCTION_ALLOW_BUILTIN=crypto,url -- same proven\n"
        "// pattern as f03's and f05-trust-rollup's own Generate run_id nodes.\n"
        "const { randomUUID } = require('crypto');\n"
        "const inp = $input.first().json;\n"
        "return [{ json: { application_id: inp.application_id, run_id: randomUUID() } }];\n",
        60, 0,
    )
    nodes.append(gen_run_id)

    load_application = code_node(
        "Load application + company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'applications?id=eq.' + inp.application_id + '&select=id,company_id');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error('f05-verify-claims: no application found for id ' + inp.application_id);\n"
        "}\n"
        "return [{ json: { ...inp, company_id: rows[0].company_id } }];\n",
        340, 0,
    )
    load_founder_ids = code_node(
        "Load founder_ids for company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.1 route 3's founderIds -- resolved by the caller with a single-table\n"
        "// lookup, matching f05-trust-rollup's identical node exactly (no shared import between\n"
        "// generators; independent copy, same convention every f05 workflow follows).\n"
        "const rows = await pgGet.call(this,\n"
        "  'founder_company?company_id=eq.' + inp.company_id + '&select=founder_id');\n"
        "const founder_ids = (rows || []).map(function (r) { return r.founder_id; }).filter(Boolean);\n"
        "return [{ json: { ...inp, founder_ids } }];\n",
        620, 0,
    )
    load_formula = code_node(
        "Load active trust_v1 router config",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'score_formulas?axis=eq.trust&active=eq.true&select=version,config&limit=1');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error(\"f05-verify-claims: no active score_formulas row for axis='trust'\");\n"
        "}\n"
        "// design.md SS4.1 -- the router prefix_map + default_class live in config.router; read\n"
        "// the live row here rather than a second hardcoded copy (this workflow's own instance of\n"
        "// the LEFT-JOIN + literal-fallback discipline SS7.5 states for the view). lib/f05/router.js\n"
        "// itself carries NO built-in prefix map for exactly this reason.\n"
        "const router_config = (rows[0].config && rows[0].config.router) || { prefix_map: [], default_class: 'unverifiable' };\n"
        "return [{ json: { ...inp, router_config } }];\n",
        900, 0,
    )
    nodes += [load_application, load_founder_ids, load_formula]

    load_scope_cards = code_node(
        "Load scope card ids",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.1's three OR'd routes, IDENTICAL query to f05-trust-rollup's own node of\n"
        "// the same name (independent copy, no shared import between generators) -- the\n"
        "// UNRESTRICTED superset; the company_id restriction on route 3 is applied downstream by\n"
        "// trust.js's own scopeClaimsToApplication(), inlined into the ROUTE node below.\n"
        "const orParts = [\n"
        "  'application_id.eq.' + inp.application_id,\n"
        "  'company_id.eq.' + inp.company_id,\n"
        "];\n"
        "if (inp.founder_ids && inp.founder_ids.length) {\n"
        "  orParts.push('founder_id.in.(' + inp.founder_ids.join(',') + ')');\n"
        "}\n"
        "const cards = await pgGet.call(this,\n"
        "  'cards?select=id,application_id,company_id,founder_id&or=(' + orParts.join(',') + ')');\n"
        "return [{ json: { ...inp, scope_cards: cards || [] } }];\n",
        1180, 0,
    )
    load_claim_trust = code_node(
        "Load claim_trust rows (scoped)",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const cardIds = (inp.scope_cards || []).map(function (c) { return c.id; });\n"
        "let claimRows = [];\n"
        "if (cardIds.length) {\n"
        "  claimRows = await pgGet.call(this,\n"
        "    'claim_trust?select=claim_id,card_id,topic,text_verbatim,source_kind,verification_status,' +\n"
        "    'router_class,derived_status,n_supports,n_contradicts&card_id=in.(' + cardIds.join(',') + ')');\n"
        "}\n"
        "// Column-contract reconciliation (same term, same fix as B3's own tracker.md entry):\n"
        "// claim_trust exposes only card_id, not the three card FKs the SS8.1 scope predicate\n"
        "// needs -- merged in here from the cards rows the previous node already fetched. Also\n"
        "// carries text_verbatim/source_kind, which f05-trust-rollup's OWN version of this node\n"
        "// does not need (rollup math never reads a claim's text) but every SS5.1 check below does.\n"
        "const cardsById = new Map((inp.scope_cards || []).map(function (c) { return [c.id, c]; }));\n"
        "const rows = (claimRows || []).map(function (r) {\n"
        "  const card = cardsById.get(r.card_id) || {};\n"
        "  return {\n"
        "    claim_id: r.claim_id, card_id: r.card_id, topic: r.topic, text_verbatim: r.text_verbatim,\n"
        "    source_kind: r.source_kind, verification_status: r.verification_status,\n"
        "    class: r.router_class, derived_status: r.derived_status,\n"
        "    n_supports: r.n_supports, n_contradicts: r.n_contradicts,\n"
        "    card_application_id: card.application_id || null,\n"
        "    card_company_id: card.company_id || null,\n"
        "    card_founder_id: card.founder_id || null,\n"
        "  };\n"
        "});\n"
        "return [{ json: { ...inp, rows } }];\n",
        1460, 0,
    )
    nodes += [load_scope_cards, load_claim_trust]

    restrict_route = code_node(
        "RESTRICT + ROUTE (trust.js + router.js)",
        "// SOURCE OF TRUTH: lib/f05/trust.js + lib/f05/router.js -- pasted verbatim; edit there and\n"
        "// re-run n8n/build-f05-workflow.py.\n"
        "\n" + TRUST_JS + "\n"
        + ROUTER_JS + "\n"
        "// ---- invocation ----\n"
        "const inp = $input.first().json;\n"
        "const ctx = { applicationId: inp.application_id, companyId: inp.company_id, founderIds: inp.founder_ids || [] };\n"
        "// design.md SS8.1's company_id restriction on route 3 (trust.js's own\n"
        "// scopeClaimsToApplication()) -- the SAME restriction f05-trust-rollup applies before\n"
        "// rolling up, applied here BEFORE any check runs, so a founder's OTHER company's claims\n"
        "// are never checked or written to under THIS application's run (matching\n"
        "// lib/f05/run.js main() step 3's own ordering: \"restrict immediately... THIS restricted\n"
        "// set is 'claims in scope' for every count below\").\n"
        "const scoped = scopeClaimsToApplication(inp.rows || [], ctx);\n"
        "const scoped_rows = scoped.map(function (row) {\n"
        "  return Object.assign({}, row, { routing: routeClaimTopic(row.topic, inp.router_config) });\n"
        "});\n"
        "return [{ json: { ...inp, scoped_rows } }];\n",
        1740, 0,
        notes="SOURCE OF TRUTH: lib/f05/trust.js (scopeClaimsToApplication) + lib/f05/router.js "
              "(routeClaimTopic) -- do not edit here, edit there and re-paste.",
    )
    nodes.append(restrict_route)

    load_gh_signals = code_node(
        "Load raw_signals for gh_provenance",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS5.1(b) -- raw_signals ALREADY in the database, grouped downstream so a\n"
        "// per-claim lookup is a JS map read, not an N+1 query. Only github_api (earliest commit\n"
        "// author date) and hn_algolia (Show HN submission date, the anchor the founder does not\n"
        "// control) matter to this check.\n"
        "const companyIds = Array.from(new Set((inp.scoped_rows || []).map(function (r) { return r.card_company_id; }).filter(Boolean)));\n"
        "const founderFilter = (inp.founder_ids && inp.founder_ids.length) ? 'founder_id.in.(' + inp.founder_ids.join(',') + ')' : null;\n"
        "const effectiveCompanyIds = companyIds.length ? companyIds : [inp.company_id];\n"
        "const companyFilter = effectiveCompanyIds.length ? 'company_id.in.(' + effectiveCompanyIds.join(',') + ')' : null;\n"
        "const orParts = [founderFilter, companyFilter].filter(Boolean);\n"
        "let rows = [];\n"
        "if (orParts.length) {\n"
        "  rows = await pgGet.call(this,\n"
        "    'raw_signals?source=in.(github_api,hn_algolia)&select=id,founder_id,company_id,source,source_url,payload' +\n"
        "    '&or=(' + orParts.join(',') + ')');\n"
        "}\n"
        "return [{ json: { ...inp, gh_raw_signals: rows || [] } }];\n",
        2020, -220,
    )
    load_quote_candidates = code_node(
        "Load quote_guard candidates",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const claimIds = (inp.scoped_rows || []).map(function (r) { return r.claim_id; });\n"
        "let rows = [];\n"
        "if (claimIds.length) {\n"
        "  // design.md SS5.1(a) call-site measurement (A3): deck-sourced OR self-reported claims,\n"
        "  // carrying a quote. relation=eq.supports is load-bearing (lib/f05/run.js's own comment,\n"
        "  // preserved here verbatim): without it a claim whose only quote-bearing row is an\n"
        "  // UNRELATED contradicts row (planted by a different check) gets compared against that\n"
        "  // instead of its own cited support -- quote_guard's premise is \"does the claim overstate\n"
        "  // its OWN citation\", not a second pass over someone else's evidence.\n"
        "  rows = await pgGet.call(this,\n"
        "    'evidence?select=claim_id,quote_verbatim,source_url,raw_signal_id,created_at,' +\n"
        "    'raw_signals(source,payload,founder_id,company_id)' +\n"
        "    '&claim_id=in.(' + claimIds.join(',') + ')' +\n"
        "    '&relation=eq.supports&quote_verbatim=not.is.null' +\n"
        "    '&order=claim_id.asc,created_at.asc');\n"
        "}\n"
        "const sourceKindByClaim = new Map((inp.scoped_rows || []).map(function (r) { return [r.claim_id, r.source_kind]; }));\n"
        "const seen = new Set();\n"
        "const candidates = [];\n"
        "for (const row of (rows || [])) {\n"
        "  if (seen.has(row.claim_id)) continue; // ordered claim_id,created_at asc -> first row per claim wins (DISTINCT ON equivalent)\n"
        "  const rs = row.raw_signals || {};\n"
        "  const sourceKind = sourceKindByClaim.get(row.claim_id);\n"
        "  if (sourceKind !== 'self_reported' && rs.source !== 'deck_parse') continue;\n"
        "  seen.add(row.claim_id);\n"
        "  candidates.push(row);\n"
        "}\n"
        "return [{ json: { ...inp, quote_candidates: candidates } }];\n",
        2020, 0,
    )
    load_entity_context = code_node(
        "Load entity context (founders + companies)",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// Entity gate step 2 (registrable-domain match) + human-readable disambiguators for step 1\n"
        "// (design.md SS6) -- same lookup lib/f05/run.js's loadEntityContext performs.\n"
        "const companyIds = Array.from(new Set((inp.scoped_rows || []).map(function (r) { return r.card_company_id; }).filter(Boolean)\n"
        "  .concat(inp.company_id ? [inp.company_id] : [])));\n"
        "const founderIds = inp.founder_ids || [];\n"
        "const founders = founderIds.length\n"
        "  ? await pgGet.call(this, 'founders?id=in.(' + founderIds.join(',') + ')&select=id,full_name') : [];\n"
        "const companies = companyIds.length\n"
        "  ? await pgGet.call(this, 'companies?id=in.(' + companyIds.join(',') + ')&select=id,name,domain,aliases') : [];\n"
        "return [{ json: { ...inp, entity_founders: founders || [], entity_companies: companies || [] } }];\n",
        2020, 220,
    )
    nodes += [load_gh_signals, load_quote_candidates, load_entity_context]

    checks_js = (
        "// SOURCE OF TRUTH: lib/f05/verifiers.js + lib/f05/entity_gate.js + lib/f05/quote_guard.js --\n"
        "// pasted verbatim below; edit there and re-run n8n/build-f05-workflow.py. Orchestration\n"
        "// beneath the three pastes is a hand-port of lib/f05/run.js's runGithubProvenanceCheck /\n"
        "// runQuoteGuardCheck / buildEntityForRow / extractSourceText / main() steps 5-6 -- run.js\n"
        "// itself is a Node CLI (requires node:fs/node:crypto/node:child_process, shells out to\n"
        "// psql) and is not a zero-import Code-node module eligible for verbatim pasting, so this\n"
        "// reproduces its LOGIC faithfully rather than its literal source, cross-checked line by\n"
        "// line against the live, QA-verified reference implementation. design.md SS5.1: all four\n"
        "// checks here are zero-LLM, external cost NONE -- no network call below besides the\n"
        "// PostgREST reads already done upstream.\n"
        "\n"
        "// globalThis.crypto.subtle IS UNDEFINED inside this n8n build's actual Code-node VM\n"
        "// sandbox -- verified live 2026-07-19 while building THIS workflow (TypeError: Cannot\n"
        "// read properties of undefined (reading 'subtle'), thrown from lib/f05/verifiers.js's own\n"
        "// sha256Hex). This is the SAME class of gap as f05-trust-rollup's crypto.randomUUID\n"
        "// finding (README-f05.md), one level deeper: the sandbox exposes neither\n"
        "// globalThis.crypto NOR its .subtle property, even though design.md SS10.1 specifies\n"
        "// `globalThis.crypto.subtle.digest(...)` and verifiers.js is written exactly to that\n"
        "// spec. Rather than editing the frozen module (lib/f05/verifiers.js is out of scope for\n"
        "// this task), this line supplies Node's OWN WebCrypto implementation\n"
        "// (require('crypto').webcrypto) under the SAME globalThis.crypto name verifiers.js\n"
        "// already reads from -- confirmed live to expose an identical .subtle.digest() surface,\n"
        "// so evidenceContentHash()/sha256Hex() run completely unmodified. require('crypto') is\n"
        "// already allow-listed (infra/n8n/docker-compose.yml's\n"
        "// NODE_FUNCTION_ALLOW_BUILTIN=crypto,url).\n"
        "globalThis.crypto = require('crypto').webcrypto;\n"
        "\n" + VERIFIERS_JS + "\n"
        + ENTITY_GATE_JS + "\n"
        + QUOTE_GUARD_JS + "\n"
        "// ---- shared helpers (mirrors lib/f05/run.js's own, same names) ----\n"
        "function buildEntityForRow(row, founderById, companyById) {\n"
        "  const founder = row.card_founder_id ? founderById.get(row.card_founder_id) : null;\n"
        "  const company = row.card_company_id ? companyById.get(row.card_company_id) : null;\n"
        "  return {\n"
        "    founderId: row.card_founder_id || null, companyId: row.card_company_id || null,\n"
        "    founderName: founder ? founder.full_name : null, companyName: company ? company.name : null,\n"
        "    companyDomain: company ? company.domain : null, companyAliases: company ? company.aliases : [],\n"
        "  };\n"
        "}\n"
        "\n"
        "function extractSourceText(payload) {\n"
        "  if (!payload || typeof payload !== 'object') return '';\n"
        "  const keys = ['text', 'extracted_text', 'story_text', 'readme_excerpt', 'answer'];\n"
        "  for (const key of keys) {\n"
        "    if (typeof payload[key] === 'string' && payload[key]) return payload[key];\n"
        "  }\n"
        "  return '';\n"
        "}\n"
        "\n"
        "// design.md SS6: \"Only CONTRADICTION candidates ever reach [the entity] gate\" -- both\n"
        "// checks below call applyEntityGate() ONLY on their own 'flagged'/mismatch branch, with\n"
        "// NO matchWithLlm hook (step 3 is never invoked from this zero-LLM workflow -- owned by\n"
        "// f05-contradiction-scan, matching lib/f05/run.js's own explicit choice). A candidate that\n"
        "// fails steps 1-2 here is downgraded (step 4) and recorded as an auditable context row,\n"
        "// never silently dropped and never escalated to an LLM from this workflow.\n"
        "async function runGithubProvenanceCheck(row, bucket, founderById, companyById) {\n"
        "  const result = checkGithubProvenance({ commitPayloads: bucket.commitPayloads, hnPayloads: bucket.hnPayloads });\n"
        "\n"
        "  if (result.status === 'insufficient_data') {\n"
        "    if (!bucket.githubSignal) {\n"
        "      return { evidenceRow: null, contradiction: null, checkRan: bucket.commitPayloads.length > 0 || bucket.hnPayloads.length > 0 };\n"
        "    }\n"
        "    const evidenceRow = await buildEvidenceRow({\n"
        "      claimId: row.claim_id, relation: 'context', tier: 'missing', quoteVerbatim: null, sourceUrl: null,\n"
        "      rawSignalId: bucket.githubSignal, checkId: 'gh_provenance', candidateKey: 'insufficient_data',\n"
        "    });\n"
        "    return { evidenceRow, contradiction: null, checkRan: true };\n"
        "  }\n"
        "\n"
        "  if (result.status === 'clean') {\n"
        "    // design.md SS5.9 (found live 2026-07-19, Tavily branch): the entity gate now guards\n"
        "    // SUPPORTS candidates too, not only contradictions -- a same-named, unrelated company's\n"
        "    // page was once written as supporting evidence, flipping two claims to 'verified'. False\n"
        "    // corroboration is at least as dangerous as false contradiction (verified is the label an\n"
        "    // investor actually trusts). Steps 1-2 only (no LLM hook here, same as the contradiction\n"
        "    // path in this zero-LLM workflow); a gate failure writes 'context', never silently drops.\n"
        "    const entity = buildEntityForRow(row, founderById, companyById);\n"
        "    const gate = await applyEntityGate({\n"
        "      claimId: row.claim_id,\n"
        "      candidate: { sourceUrl: bucket.githubSourceUrl || null, quote: result.summary, tier: 'documented' },\n"
        "      rawSignal: { id: bucket.githubSignal, founderId: bucket.rsFounderId, companyId: bucket.rsCompanyId },\n"
        "      entity,\n"
        "    });\n"
        "    if (gate.resolved) {\n"
        "      const evidenceRow = await buildEvidenceRow({\n"
        "        claimId: row.claim_id, relation: 'supports', tier: 'documented', quoteVerbatim: result.summary,\n"
        "        sourceUrl: bucket.githubSourceUrl || null, rawSignalId: bucket.githubSignal,\n"
        "        checkId: 'gh_provenance', candidateKey: result.earliestCommitAuthorDate,\n"
        "      });\n"
        "      return { evidenceRow, contradiction: null, checkRan: true };\n"
        "    }\n"
        "    const contextRow = await buildEvidenceRow({\n"
        "      claimId: gate.contextRowFields.claimId, relation: gate.contextRowFields.relation, tier: gate.contextRowFields.tier,\n"
        "      quoteVerbatim: gate.contextRowFields.quoteVerbatim, sourceUrl: gate.contextRowFields.sourceUrl,\n"
        "      rawSignalId: gate.contextRowFields.rawSignalId, checkId: gate.contextRowFields.checkId,\n"
        "      candidateKey: gate.contextRowFields.candidateKey,\n"
        "    });\n"
        "    return { evidenceRow: contextRow, contradiction: null, checkRan: true };\n"
        "  }\n"
        "\n"
        "  // status === 'flagged' -- a CONTRADICTION CANDIDATE; must pass the entity gate.\n"
        "  const entity = buildEntityForRow(row, founderById, companyById);\n"
        "  const gate = await applyEntityGate({\n"
        "    claimId: row.claim_id,\n"
        "    candidate: { sourceUrl: bucket.githubSourceUrl || null, quote: result.summary, tier: 'documented' },\n"
        "    rawSignal: { id: bucket.githubSignal, founderId: bucket.rsFounderId, companyId: bucket.rsCompanyId },\n"
        "    entity,\n"
        "  });\n"
        "\n"
        "  if (gate.resolved) {\n"
        "    const evidenceRow = await buildEvidenceRow({\n"
        "      claimId: row.claim_id, relation: 'contradicts', tier: 'documented', quoteVerbatim: result.summary,\n"
        "      sourceUrl: bucket.githubSourceUrl || null, rawSignalId: bucket.githubSignal,\n"
        "      checkId: 'gh_provenance', candidateKey: result.earliestCommitAuthorDate,\n"
        "    });\n"
        "    return {\n"
        "      evidenceRow,\n"
        "      contradiction: {\n"
        "        sourceUrl: bucket.githubSourceUrl || null, nature: 'temporal', severity: 'material',\n"
        "        foundReality: result.summary,\n"
        "        question: 'Can you walk us through the development history of this repository -- specifically why the earliest ' +\n"
        "          'commit postdates your own earliest public trace by ' + result.gapDays + ' day(s)?',\n"
        "        entityMatch: gate.entityMatch,\n"
        "      },\n"
        "      checkRan: true,\n"
        "    };\n"
        "  }\n"
        "\n"
        "  const contextRow = await buildEvidenceRow({\n"
        "    claimId: gate.contextRowFields.claimId, relation: gate.contextRowFields.relation, tier: gate.contextRowFields.tier,\n"
        "    quoteVerbatim: gate.contextRowFields.quoteVerbatim, sourceUrl: gate.contextRowFields.sourceUrl,\n"
        "    rawSignalId: gate.contextRowFields.rawSignalId, checkId: gate.contextRowFields.checkId,\n"
        "    candidateKey: gate.contextRowFields.candidateKey,\n"
        "  });\n"
        "  return { evidenceRow: contextRow, contradiction: null, checkRan: true };\n"
        "}\n"
        "\n"
        "async function runQuoteGuardCheck(row, candidate, founderById, companyById) {\n"
        "  const sourceText = extractSourceText(candidate.raw_signals && candidate.raw_signals.payload);\n"
        "  const mismatches = quoteSalienceMismatches(row.text_verbatim, sourceText);\n"
        "  if (!mismatches.length) return { evidenceRow: null, contradiction: null };\n"
        "\n"
        "  const foundReality = mismatches.join('; ');\n"
        "  const entity = buildEntityForRow(row, founderById, companyById);\n"
        "  const rs = candidate.raw_signals || {};\n"
        "  const gate = await applyEntityGate({\n"
        "    claimId: row.claim_id,\n"
        "    candidate: { sourceUrl: candidate.source_url || null, quote: foundReality, tier: 'documented' },\n"
        "    rawSignal: { id: candidate.raw_signal_id, founderId: rs.founder_id, companyId: rs.company_id },\n"
        "    entity,\n"
        "  });\n"
        "\n"
        "  if (gate.resolved) {\n"
        "    const evidenceRow = await buildEvidenceRow({\n"
        "      claimId: row.claim_id, relation: 'contradicts', tier: 'documented', quoteVerbatim: foundReality,\n"
        "      sourceUrl: candidate.source_url || null, rawSignalId: candidate.raw_signal_id,\n"
        "      checkId: 'quote_guard', candidateKey: foundReality,\n"
        "    });\n"
        "    return {\n"
        "      evidenceRow,\n"
        "      contradiction: {\n"
        "        sourceUrl: candidate.source_url || null, nature: 'factual', severity: 'material', foundReality,\n"
        "        question: 'Can you walk us through the figure(s) behind this claim -- our review of the cited source found: ' + foundReality,\n"
        "        entityMatch: gate.entityMatch,\n"
        "      },\n"
        "    };\n"
        "  }\n"
        "\n"
        "  const contextRow = await buildEvidenceRow({\n"
        "    claimId: gate.contextRowFields.claimId, relation: gate.contextRowFields.relation, tier: gate.contextRowFields.tier,\n"
        "    quoteVerbatim: gate.contextRowFields.quoteVerbatim, sourceUrl: gate.contextRowFields.sourceUrl,\n"
        "    rawSignalId: gate.contextRowFields.rawSignalId, checkId: gate.contextRowFields.checkId,\n"
        "    candidateKey: gate.contextRowFields.candidateKey,\n"
        "  });\n"
        "  return { evidenceRow: contextRow, contradiction: null };\n"
        "}\n"
        "\n"
        "// ---- invocation: mirrors lib/f05/run.js main() steps 5-6 ----\n"
        "const inp = $input.first().json;\n"
        "const scopedRows = inp.scoped_rows || [];\n"
        "\n"
        "const rawSignalsByEntity = new Map();\n"
        "for (const rs of (inp.gh_raw_signals || [])) {\n"
        "  const key = rs.founder_id || rs.company_id;\n"
        "  if (!key) continue;\n"
        "  if (!rawSignalsByEntity.has(key)) {\n"
        "    rawSignalsByEntity.set(key, { commitPayloads: [], hnPayloads: [], githubSignal: null, githubSourceUrl: null, rsFounderId: null, rsCompanyId: null });\n"
        "  }\n"
        "  const bucket = rawSignalsByEntity.get(key);\n"
        "  if (rs.source === 'github_api') {\n"
        "    bucket.commitPayloads.push(rs.payload);\n"
        "    if (!bucket.githubSignal) {\n"
        "      bucket.githubSignal = rs.id; bucket.githubSourceUrl = rs.source_url;\n"
        "      bucket.rsFounderId = rs.founder_id; bucket.rsCompanyId = rs.company_id;\n"
        "    }\n"
        "  } else if (rs.source === 'hn_algolia') {\n"
        "    bucket.hnPayloads.push(rs.payload);\n"
        "  }\n"
        "}\n"
        "\n"
        "const quoteCandidateByClaim = new Map((inp.quote_candidates || []).map(function (c) { return [c.claim_id, c]; }));\n"
        "const founderById = new Map((inp.entity_founders || []).map(function (f) { return [f.id, f]; }));\n"
        "const companyById = new Map((inp.entity_companies || []).map(function (c) { return [c.id, c]; }));\n"
        "\n"
        "const evidenceRows = [];\n"
        "const contradictionByClaim = {};\n"
        "let ghProvenanceRan = 0, ghProvenanceInsufficientData = 0, quoteGuardRan = 0, quoteGuardMismatches = 0;\n"
        "const denominatorFindingsByClaim = {};\n"
        "\n"
        "for (const row of scopedRows) {\n"
        "  const routing = row.routing;\n"
        "\n"
        "  if (routing.check === 'gh_provenance') {\n"
        "    const key = row.card_founder_id || row.card_company_id;\n"
        "    const bucket = rawSignalsByEntity.get(key) || { commitPayloads: [], hnPayloads: [], githubSignal: null };\n"
        "    const outcome = await runGithubProvenanceCheck(row, bucket, founderById, companyById);\n"
        "    if (outcome.checkRan) {\n"
        "      ghProvenanceRan += 1;\n"
        "      if (outcome.evidenceRow && outcome.evidenceRow.tier === 'missing') ghProvenanceInsufficientData += 1;\n"
        "    }\n"
        "    if (outcome.evidenceRow) evidenceRows.push(outcome.evidenceRow);\n"
        "    if (outcome.contradiction) contradictionByClaim[row.claim_id] = outcome.contradiction;\n"
        "  }\n"
        "\n"
        "  const quoteCandidate = quoteCandidateByClaim.get(row.claim_id);\n"
        "  if (quoteCandidate) {\n"
        "    quoteGuardRan += 1;\n"
        "    const outcome = await runQuoteGuardCheck(row, quoteCandidate, founderById, companyById);\n"
        "    if (outcome.evidenceRow) { quoteGuardMismatches += 1; evidenceRows.push(outcome.evidenceRow); }\n"
        "    if (outcome.contradiction && !contradictionByClaim[row.claim_id]) contradictionByClaim[row.claim_id] = outcome.contradiction;\n"
        "  }\n"
        "\n"
        "  // design.md SS5.1(c) -- denominator extraction, advisory only (B2 ruling: no evidence\n"
        "  // row -- it analyses the claim's own text and has no raw_signal_id to attach); folded\n"
        "  // into this claim's attempted-event payload as deep_dive_questions below.\n"
        "  const denom = extractDenominator(row.text_verbatim);\n"
        "  if (denom.hasPercentageClaim && denom.cappedAtUnverified) {\n"
        "    denominatorFindingsByClaim[row.claim_id] = denom.deepDiveQuestions;\n"
        "  }\n"
        "}\n"
        "\n"
        "return [{ json: {\n"
        "  ...inp, evidence_rows: evidenceRows, contradiction_by_claim: contradictionByClaim,\n"
        "  denominator_findings_by_claim: denominatorFindingsByClaim,\n"
        "  check_summary: {\n"
        "    scoped_claims: scopedRows.length, gh_provenance_checks_run: ghProvenanceRan,\n"
        "    gh_provenance_insufficient_data: ghProvenanceInsufficientData,\n"
        "    quote_guard_checks_run: quoteGuardRan, quote_guard_mismatches: quoteGuardMismatches,\n"
        "  },\n"
        "} }];\n"
    )
    checks_node = code_node("CHECKS - dispatch (verifiers.js + entity_gate.js + quote_guard.js)", checks_js, 2300, 0,
                             notes="SOURCE OF TRUTH: lib/f05/verifiers.js + lib/f05/entity_gate.js + "
                                   "lib/f05/quote_guard.js -- do not edit here, edit there and re-paste. "
                                   "Zero LLM, zero network call beyond the DB reads already done upstream.")
    nodes.append(checks_node)

    write_evidence = code_node(
        "Write evidence rows",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = inp.evidence_rows || [];\n"
        "// design.md SS10.1 -- evidence.content_hash is NOT NULL UNIQUE; the PostgREST upsert\n"
        "// idiom (on_conflict= + Prefer: resolution=ignore-duplicates) is this workflow's\n"
        "// equivalent of lib/f05/run.js's own `INSERT ... ON CONFLICT (content_hash) DO NOTHING`\n"
        "// (run.js shells out to psql and can use raw SQL directly; this workflow only has\n"
        "// PostgREST, whose documented upsert mechanism is exactly this header+query-param pair) --\n"
        "// re-running this workflow against the same application inserts zero duplicate rows.\n"
        "if (rows.length) {\n"
        "  await pg.call(this, 'POST', 'evidence?on_conflict=content_hash', rows, 'resolution=ignore-duplicates,return=minimal');\n"
        "}\n"
        "return [{ json: { ...inp, evidence_written: rows.length } }];\n",
        2580, -140,
    )
    reload_claim_trust = code_node(
        "Reload claim_trust rows (post-write)",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS9's events need verdict_before/verdict_after -- 'after' can only be known\n"
        "// once the evidence just written has landed, so claim_trust (the live view) is re-read\n"
        "// here, matching lib/f05/run.js main() step 7's own re-read of the SAME rows post-write.\n"
        "const cardIds = (inp.scope_cards || []).map(function (c) { return c.id; });\n"
        "let rows = [];\n"
        "if (cardIds.length) {\n"
        "  rows = await pgGet.call(this, 'claim_trust?select=claim_id,derived_status&card_id=in.(' + cardIds.join(',') + ')');\n"
        "}\n"
        "const derived_status_after = {};\n"
        "(rows || []).forEach(function (r) { derived_status_after[r.claim_id] = r.derived_status; });\n"
        "return [{ json: { ...inp, derived_status_after } }];\n",
        2580, 140,
    )
    nodes += [write_evidence, reload_claim_trust]

    build_events = code_node(
        "BUILD EVENTS (claim_verification_attempted / verified / contradicted)",
        "// Hand-port of lib/f05/run.js's entityForClaim/buildAttemptedEventRow/\n"
        "// buildUnmatchedTopicEventRow/buildVerifiedEventRow/buildContradictedEventRow -- run.js\n"
        "// itself is a Node CLI, not a zero-import Code-node module, so this reproduces its LOGIC,\n"
        "// not its literal source. design.md SS9: claim_verification_attempted is MANDATORY, one\n"
        "// per scoped (routed) claim -- the ONLY trace distinguishing \"we looked and found\n"
        "// nothing\" from \"never routed\". SS14: a documented/discovered-tier contradiction on a\n"
        "// QUALITATIVE claim still gets its own claim_contradicted event even though the verdict\n"
        "// itself stays pinned to 'unverified' by the view's class gate (SS7.1/SS7.4 row 1) --\n"
        "// otherwise the finding reaches neither memo (06) nor dashboard (09).\n"
        "function entityForClaim(row, applicationId) {\n"
        "  if (row.card_founder_id) return { entityType: 'founder', entityId: row.card_founder_id };\n"
        "  return { entityType: 'application', entityId: applicationId };\n"
        "}\n"
        "\n"
        "const inp = $input.first().json;\n"
        "const scopedRows = inp.scoped_rows || [];\n"
        "const afterByClaim = inp.derived_status_after || {};\n"
        "const contradictionByClaim = inp.contradiction_by_claim || {};\n"
        "const denominatorFindingsByClaim = inp.denominator_findings_by_claim || {};\n"
        "const checkedAt = new Date().toISOString();\n"
        "const ACTOR = 'f05-verify-claims';\n"
        "\n"
        "const eventRows = [];\n"
        "for (const row of scopedRows) {\n"
        "  const routing = row.routing;\n"
        "  const verdictBefore = row.derived_status;\n"
        "  const verdictAfter = afterByClaim[row.claim_id] != null ? afterByClaim[row.claim_id] : verdictBefore;\n"
        "  const contradiction = contradictionByClaim[row.claim_id];\n"
        "  const ent = entityForClaim(row, inp.application_id);\n"
        "\n"
        "  const attemptedPayload = {\n"
        "    claim_id: row.claim_id, class: row.class, check: routing.check,\n"
        "    verdict_before: verdictBefore, verdict_after: verdictAfter, checked_at: checkedAt, run_id: inp.run_id,\n"
        "  };\n"
        "  if (denominatorFindingsByClaim[row.claim_id]) attemptedPayload.deep_dive_questions = denominatorFindingsByClaim[row.claim_id];\n"
        "  eventRows.push({ event_type: 'claim_verification_attempted', entity_type: ent.entityType, entity_id: ent.entityId, payload: attemptedPayload, actor: ACTOR });\n"
        "\n"
        "  if (routing.unmatched_topic) {\n"
        "    eventRows.push({\n"
        "      event_type: 'router_unmatched_topic', entity_type: ent.entityType, entity_id: ent.entityId,\n"
        "      payload: { claim_id: row.claim_id, topic: row.topic, run_id: inp.run_id, checked_at: checkedAt }, actor: ACTOR,\n"
        "    });\n"
        "  }\n"
        "\n"
        "  if (verdictBefore !== verdictAfter && verdictAfter === 'verified') {\n"
        "    eventRows.push({\n"
        "      event_type: 'claim_verified', entity_type: ent.entityType, entity_id: ent.entityId,\n"
        "      payload: {\n"
        "        claim_id: row.claim_id, class: row.class, check: routing.check,\n"
        "        verdict_before: verdictBefore, verdict_after: verdictAfter,\n"
        "        source_url: contradiction ? contradiction.sourceUrl : null, checked_at: checkedAt, run_id: inp.run_id,\n"
        "      }, actor: ACTOR,\n"
        "    });\n"
        "  }\n"
        "\n"
        "  if (contradiction) {\n"
        "    const base = {\n"
        "      claim_id: row.claim_id, class: row.class, check: routing.check,\n"
        "      verdict_before: verdictBefore, verdict_after: verdictAfter,\n"
        "      source_url: contradiction.sourceUrl || null, checked_at: checkedAt, run_id: inp.run_id,\n"
        "      nature: contradiction.nature, severity: contradiction.severity,\n"
        "      found_reality: contradiction.foundReality, question: contradiction.question,\n"
        "    };\n"
        "    // design.md SS9 -- on the entity_type='application' fallback (no resolvable founder on\n"
        "    // this claim's card), the payload OMITS founder_claim and entity_match.quote: the\n"
        "    // 'carries no personal data' argument that makes an unpurgeable event acceptable must\n"
        "    // be TRUE, not assumed. Built PER BRANCH, never inside the shared `base` object -- a\n"
        "    // real bug B3 caught and fixed in lib/f05/run.js's own build (tracker.md): sharing the\n"
        "    // object let the quote leak through the application-fallback path silently.\n"
        "    const payload = ent.entityType === 'application'\n"
        "      ? Object.assign({}, base, {\n"
        "          entity_match: contradiction.entityMatch\n"
        "            ? { resolved_by: contradiction.entityMatch.resolved_by, disambiguator: contradiction.entityMatch.disambiguator }\n"
        "            : null,\n"
        "        })\n"
        "      : Object.assign({ founder_claim: row.text_verbatim }, base, { entity_match: contradiction.entityMatch });\n"
        "    eventRows.push({ event_type: 'claim_contradicted', entity_type: ent.entityType, entity_id: ent.entityId, payload, actor: ACTOR });\n"
        "  }\n"
        "}\n"
        "\n"
        "return [{ json: { ...inp, event_rows: eventRows } }];\n",
        2860, 0,
    )
    nodes.append(build_events)

    write_events = code_node(
        "Write events",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// events is append-only (no uniqueness of its own, project-wide convention) -- no\n"
        "// on_conflict here, a re-run legitimately appends a fresh batch.\n"
        "const rows = inp.event_rows || [];\n"
        "if (rows.length) {\n"
        "  await pg.call(this, 'POST', 'events', rows, 'return=minimal');\n"
        "}\n"
        "return [{ json: { ...inp, events_written: rows.length } }];\n",
        3140, -140,
    )
    write_ai_runs = code_node(
        "Write ai_runs (ledger)",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS6.0b -- confidence is a literal SQL NULL, never read from output_json. This\n"
        "// workflow runs zero LLM calls (all SS5.1 checks are deterministic); this row is still the\n"
        "// ledger proving a verification run happened at all, same 'ai_runs even when zero-LLM'\n"
        "// pattern lib/f05/run.js's own step 10 uses (model: 'deterministic:f05_run' there).\n"
        "await pg.call(this, 'POST', 'ai_runs', {\n"
        "  task_type: 'verification', application_id: inp.application_id, founder_id: null, company_id: inp.company_id,\n"
        "  model: 'deterministic:f05_verify_claims',\n"
        "  output_json: Object.assign({ run_id: inp.run_id }, inp.check_summary || {}),\n"
        "}, 'return=minimal');\n"
        "return [{ json: inp }];\n",
        3140, 140,
    )
    nodes += [write_events, write_ai_runs]

    build_contract = code_node(
        "Build output contract",
        "// Terminal node: its return value is both the webhook HTTP response (responseMode:\n"
        "// lastNode) and the value returned to a caller invoking this as a sub-workflow (06/09/10).\n"
        "const inp = $input.first().json;\n"
        "return [{ json: {\n"
        "  application_id: inp.application_id, run_id: inp.run_id, status: 'checked',\n"
        "  scoped_claim_count: (inp.scoped_rows || []).length,\n"
        "  evidence_written: inp.evidence_written || 0, events_written: inp.events_written || 0,\n"
        "  check_summary: inp.check_summary,\n"
        "} }];\n",
        3420, 0,
    )
    nodes.append(build_contract)

    nodes.append(sticky(
        "Note: zero-LLM, wraps run.js",
        "### ZERO LLM, ZERO EXTERNAL NETWORK CALL (design.md SS5.1)\n"
        "gh_provenance + quote_guard + denominator extraction are all\n"
        "deterministic. Any contradiction CANDIDATE they find still\n"
        "passes the entity gate (steps 1-2 only, design SS6) before it\n"
        "may become a `contradicts` row -- but the LLM hook (step 3) is\n"
        "NEVER called from this workflow. That call lives only in\n"
        "f05-contradiction-scan, matching lib/f05/run.js's own explicit\n"
        "choice ('step 3 is omitted, owned by C1b').",
        1700, -520, 700, 260,
    ))
    nodes.append(sticky(
        "Note: narrow queue lives in contradiction-scan",
        "### THE LLM CONTRADICTION QUEUE IS NOT THREADED THROUGH HERE\n"
        "design.md SS11.1 describes 'the narrow queue f05-verify-claims\n"
        "routes to' f05-contradiction-scan. This generator keeps the two\n"
        "workflows independently callable/testable instead (matching\n"
        "f05-trust-rollup's own precedent of being a separate,\n"
        "independently-invoked sub-workflow rather than an automatic\n"
        "continuation) -- f05-contradiction-scan builds its OWN narrow\n"
        "queue from { application_id } by the identical eligibility rule\n"
        "(self_reported / deck-sourced claims). Open decision, documented\n"
        "rather than silently made -- see n8n/workflows/README-f05.md.",
        2400, -520, 900, 300,
    ))

    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Execute Workflow Trigger", 0, "Normalize Sub-workflow Input", 0),
            ("Normalize Webhook Input", 0, "Generate run_id", 0),
            ("Normalize Sub-workflow Input", 0, "Generate run_id", 0),
            ("Generate run_id", 0, "Load application + company", 0),
            ("Load application + company", 0, "Load founder_ids for company", 0),
            ("Load founder_ids for company", 0, "Load active trust_v1 router config", 0),
            ("Load active trust_v1 router config", 0, "Load scope card ids", 0),
            ("Load scope card ids", 0, "Load claim_trust rows (scoped)", 0),
            ("Load claim_trust rows (scoped)", 0, "RESTRICT + ROUTE (trust.js + router.js)", 0),
            ("RESTRICT + ROUTE (trust.js + router.js)", 0, "Load raw_signals for gh_provenance", 0),
            ("Load raw_signals for gh_provenance", 0, "Load quote_guard candidates", 0),
            ("Load quote_guard candidates", 0, "Load entity context (founders + companies)", 0),
            ("Load entity context (founders + companies)", 0, checks_node["name"], 0),
            (checks_node["name"], 0, "Write evidence rows", 0),
            ("Write evidence rows", 0, "Reload claim_trust rows (post-write)", 0),
            ("Reload claim_trust rows (post-write)", 0, "BUILD EVENTS (claim_verification_attempted / verified / contradicted)", 0),
            ("BUILD EVENTS (claim_verification_attempted / verified / contradicted)", 0, "Write events", 0),
            ("Write events", 0, "Write ai_runs (ledger)", 0),
            ("Write ai_runs (ledger)", 0, "Build output contract", 0),
        ),
    )

    workflow = {
        "name": "f05-verify-claims",
        "nodes": nodes,
        "connections": conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "UTC"},
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": True},
    }
    return workflow


def build_contradiction_scan():
    """f05-contradiction-scan (plan.md task C1b, design.md SS6/SS6.0-SS6.0b/SS11.1): the ONE
    place in feature 05 where an LLM can accuse a founder, so every guard is the point. Given
    { application_id } (or a caller-supplied { pairs: [...] }, design SS11.1's "the narrow queue
    f05-verify-claims routes to it"), builds a narrow queue of (claim, independent evidence)
    pairs -- deck-sourced/self-reported claims only -- runs `contradiction-detector` TWICE per
    pair (K=2, agreement-weighted per design SS6.0b), and passes any candidate through the SAME
    entity gate f05-verify-claims uses (lib/f05/entity_gate.js), except HERE step 3's LLM hook
    (`entity-matcher`) is actually wired in -- the one call site in this feature where it fires.

    Safety rules enforced here, each traceable to design.md:
      1. Entity gate before ANY `contradicted`-shaped write; on failure, downgrade + an auditable
         `context` row (SS6 step 4) -- never silently dropped.
      2. K=2: disagreement on `contradiction_found` downgrades the write to tier='discovered',
         which the ALREADY-BUILT claim_trust view (SS7.4) structurally caps at
         `partially_supported` -- no new view logic needed.
      3. Only the underlying evidence's own tier may reach 'documented' (and therefore
         `contradicted`); this workflow never assigns 'documented' itself, it only ever passes
         through what the cited evidence row already carries, or downgrades to 'discovered'.
      4. Narrow queue: source_kind='self_reported' OR raw_signals.source='deck_parse' claims,
         paired with INDEPENDENT (non-deck/non-interview) quoted evidence -- never the whole
         corpus.
      5. GDPR (design SS9): entity_type='founder' => entity_id is ALWAYS founders.id, never
         claim_id; the entity_type='application' fallback payload omits founder_claim and
         entity_match.quote.
      6. ai_runs.confidence stays NULL on every row (design SS6.0b) -- both K=2 calls AND the
         entity-matcher call are logged, never a confidence number.
    """
    nodes = []

    webhook = {
        "parameters": {
            "httpMethod": "POST", "path": "f05-contradiction-scan",
            "responseMode": "lastNode", "options": {},
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
        "// Webhook body carries { application_id } and OPTIONALLY { pairs: [...] } -- design.md\n"
        "// SS11.1's caller-supplied narrow queue. When `pairs` is omitted this workflow builds its\n"
        "// own (see 'Build narrow queue' below) -- both are supported so this workflow stays\n"
        "// independently callable/testable without requiring f05-verify-claims to run first.\n"
        "const item = $input.first().json;\n"
        "const body = item.body || {};\n"
        "const application_id = body.application_id || item.application_id;\n"
        "if (!application_id) throw new Error('f05-contradiction-scan: application_id is required');\n"
        "const pairs = Array.isArray(body.pairs) ? body.pairs : (Array.isArray(item.pairs) ? item.pairs : undefined);\n"
        "const out = { application_id };\n"
        "if (pairs) out.pairs = pairs;\n"
        "return [{ json: out }];\n",
        -180, -140,
    )
    norm_sub = code_node(
        "Normalize Sub-workflow Input",
        "// Called by 06/09/10, or by f05-verify-claims, as a sub-workflow with\n"
        "// { application_id } and optionally { pairs: [...] }.\n"
        "const item = $input.first().json || {};\n"
        "const application_id = item.application_id;\n"
        "if (!application_id) throw new Error('f05-contradiction-scan: application_id is required');\n"
        "const out = { application_id };\n"
        "if (Array.isArray(item.pairs)) out.pairs = item.pairs;\n"
        "return [{ json: out }];\n",
        -180, 140,
    )
    nodes += [norm_webhook, norm_sub]

    gen_run_id = code_node(
        "Generate run_id",
        "// require('crypto') -- globalThis.crypto is undefined inside this n8n build's actual\n"
        "// Code-node VM sandbox (verified live 2026-07-19, restated in README-f05.md); allow-listed\n"
        "// via infra/n8n/docker-compose.yml's NODE_FUNCTION_ALLOW_BUILTIN=crypto,url.\n"
        "const { randomUUID } = require('crypto');\n"
        "const inp = $input.first().json;\n"
        "return [{ json: { ...inp, run_id: randomUUID() } }];\n",
        60, 0,
    )
    nodes.append(gen_run_id)

    load_application = code_node(
        "Load application + company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'applications?id=eq.' + inp.application_id + '&select=id,company_id');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error('f05-contradiction-scan: no application found for id ' + inp.application_id);\n"
        "}\n"
        "return [{ json: { ...inp, company_id: rows[0].company_id } }];\n",
        340, 0,
    )
    load_founder_ids = code_node(
        "Load founder_ids for company",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'founder_company?company_id=eq.' + inp.company_id + '&select=founder_id');\n"
        "const founder_ids = (rows || []).map(function (r) { return r.founder_id; }).filter(Boolean);\n"
        "return [{ json: { ...inp, founder_ids } }];\n",
        620, 0,
    )
    load_budget = code_node(
        "Load active trust_v1 budget config",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = await pgGet.call(this,\n"
        "  'score_formulas?axis=eq.trust&active=eq.true&select=version,config&limit=1');\n"
        "if (!rows || !rows.length) {\n"
        "  throw new Error(\"f05-contradiction-scan: no active score_formulas row for axis='trust'\");\n"
        "}\n"
        "// design.md SS4.2/SS12 defines config.budget.max_paid_checks_per_card for the paid\n"
        "// factual_dynamic (Tavily) branch. Reused here -- a documented choice, not a silent\n"
        "// default -- as the SAME cap on this workflow's own paid (LLM) branch, rather than\n"
        "// inventing a second unrelated budget constant.\n"
        "const budget_config = (rows[0].config && rows[0].config.budget) || { max_paid_checks_per_card: 5 };\n"
        "return [{ json: { ...inp, budget_config } }];\n",
        900, 0,
    )
    nodes += [load_application, load_founder_ids, load_budget]

    load_scope_cards = code_node(
        "Load scope card ids",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS8.1's three OR'd routes -- identical query to f05-trust-rollup /\n"
        "// f05-verify-claims (independent copy, no shared import between generators).\n"
        "const orParts = [\n"
        "  'application_id.eq.' + inp.application_id,\n"
        "  'company_id.eq.' + inp.company_id,\n"
        "];\n"
        "if (inp.founder_ids && inp.founder_ids.length) {\n"
        "  orParts.push('founder_id.in.(' + inp.founder_ids.join(',') + ')');\n"
        "}\n"
        "const cards = await pgGet.call(this,\n"
        "  'cards?select=id,application_id,company_id,founder_id&or=(' + orParts.join(',') + ')');\n"
        "return [{ json: { ...inp, scope_cards: cards || [] } }];\n",
        1180, 0,
    )
    load_claim_trust = code_node(
        "Load claim_trust rows (scoped)",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "const cardIds = (inp.scope_cards || []).map(function (c) { return c.id; });\n"
        "let claimRows = [];\n"
        "if (cardIds.length) {\n"
        "  claimRows = await pgGet.call(this,\n"
        "    'claim_trust?select=claim_id,card_id,topic,text_verbatim,source_kind&card_id=in.(' + cardIds.join(',') + ')');\n"
        "}\n"
        "const cardsById = new Map((inp.scope_cards || []).map(function (c) { return [c.id, c]; }));\n"
        "const rows = (claimRows || []).map(function (r) {\n"
        "  const card = cardsById.get(r.card_id) || {};\n"
        "  return {\n"
        "    claim_id: r.claim_id, card_id: r.card_id, topic: r.topic, text_verbatim: r.text_verbatim,\n"
        "    source_kind: r.source_kind,\n"
        "    card_application_id: card.application_id || null, card_company_id: card.company_id || null,\n"
        "    card_founder_id: card.founder_id || null,\n"
        "  };\n"
        "});\n"
        "return [{ json: { ...inp, rows } }];\n",
        1460, 0,
    )
    nodes += [load_scope_cards, load_claim_trust]

    restrict_node = code_node(
        "RESTRICT (trust.js)",
        "// SOURCE OF TRUTH: lib/f05/trust.js -- pasted verbatim; edit there and re-run\n"
        "// n8n/build-f05-workflow.py.\n"
        "\n" + TRUST_JS + "\n"
        "const inp = $input.first().json;\n"
        "const ctx = { applicationId: inp.application_id, companyId: inp.company_id, founderIds: inp.founder_ids || [] };\n"
        "// design.md SS8.1's company_id restriction on route 3 -- same restriction\n"
        "// f05-trust-rollup/f05-verify-claims apply, so 'in scope for this application' means the\n"
        "// identical set of claims across all three workflows.\n"
        "const scoped_rows = scopeClaimsToApplication(inp.rows || [], ctx);\n"
        "return [{ json: { ...inp, scoped_rows } }];\n",
        1740, 0,
        notes="SOURCE OF TRUTH: lib/f05/trust.js (scopeClaimsToApplication) -- do not edit here, "
              "edit there and re-paste.",
    )
    nodes.append(restrict_node)

    build_queue = code_node(
        "Build narrow queue (deck-sourced / self-reported claims)",
        PG_GET_HELPER +
        "function questionForTopic(topic) {\n"
        "  // design.md SS6.0b: 'contradiction is only meaningful relative to a question' -- a\n"
        "  // small, explicitly heuristic topic -> question map, NOT exhaustive; the question\n"
        "  // travels with the pair through the whole pipeline and is stored on the record.\n"
        "  const t = typeof topic === 'string' ? topic : '';\n"
        "  if (t.indexOf('traction.customer_references') === 0) return 'Do they have verifiable customer references or pilot relationships?';\n"
        "  if (t.indexOf('traction.') === 0 || t === 'founder.execution.traction') return 'What traction (users, revenue, or usage) have they actually achieved?';\n"
        "  if (t.indexOf('market.growth') === 0) return \"What is this market's actual growth rate?\";\n"
        "  if (t.indexOf('company.what_is_built') === 0) return 'What has the team actually built and shipped?';\n"
        "  if (t.indexOf('company.stage_evidence') === 0) return 'What stage is the company actually at?';\n"
        "  return \"Does independently retrieved evidence support the founder's claim about '\" + t + \"'?\";\n"
        "}\n"
        "\n"
        "const inp = $input.first().json;\n"
        "if (Array.isArray(inp.pairs)) {\n"
        "  // design.md SS11.1: 'the narrow queue f05-verify-claims routes to' this workflow -- a\n"
        "  // caller-supplied queue is used AS-IS, no self-service construction (see\n"
        "  // n8n/workflows/README-f05.md for why the two workflows stay independently callable\n"
        "  // rather than one always chaining into the other).\n"
        "  return [{ json: { ...inp, candidate_pairs: inp.pairs } }];\n"
        "}\n"
        "\n"
        "const claimIds = (inp.scoped_rows || []).map(function (r) { return r.claim_id; });\n"
        "let rows = [];\n"
        "if (claimIds.length) {\n"
        "  // Narrow queue (design SS5.2/SS11.1): deck-sourced / self-reported claims, paired with\n"
        "  // evidence from an INDEPENDENT source (not the claim's own deck/interview channel)\n"
        "  // carrying a quote -- the semantic-comparison shape a Tavily-style result needs, distinct\n"
        "  // from quote_guard's SAME-citation salient-token check (design SS5.1a, f05-verify-claims).\n"
        "  rows = await pgGet.call(this,\n"
        "    'evidence?select=claim_id,quote_verbatim,source_url,raw_signal_id,tier,captured_at,' +\n"
        "    'raw_signals(source,founder_id,company_id)' +\n"
        "    '&claim_id=in.(' + claimIds.join(',') + ')' +\n"
        "    '&relation=in.(supports,context)&quote_verbatim=not.is.null' +\n"
        "    '&order=claim_id.asc,captured_at.asc');\n"
        "}\n"
        "\n"
        "const claimById = new Map((inp.scoped_rows || []).map(function (r) { return [r.claim_id, r]; }));\n"
        "const perClaimCount = new Map();\n"
        "const cap = (inp.budget_config && inp.budget_config.max_paid_checks_per_card) || 5;\n"
        "const built = [];\n"
        "for (const row of (rows || [])) {\n"
        "  const claim = claimById.get(row.claim_id);\n"
        "  if (!claim) continue;\n"
        "  const rs = row.raw_signals || {};\n"
        "  const claimEligible = claim.source_kind === 'self_reported' || rs.source === 'deck_parse';\n"
        "  const evidenceIndependent = Boolean(rs.source) && rs.source !== 'deck_parse' && rs.source !== 'interview_answer';\n"
        "  if (!claimEligible || !evidenceIndependent) continue;\n"
        "  const seenForClaim = perClaimCount.get(row.claim_id) || 0;\n"
        "  if (seenForClaim >= 2) continue; // at most 2 pairs per claim -- bounds cost per claim\n"
        "  perClaimCount.set(row.claim_id, seenForClaim + 1);\n"
        "  built.push({\n"
        "    claim_id: row.claim_id, question: questionForTopic(claim.topic),\n"
        "    founder_claim: { text_verbatim: claim.text_verbatim, source_kind: claim.source_kind },\n"
        "    evidence: {\n"
        "      quote_verbatim: row.quote_verbatim, tier: row.tier, source_url: row.source_url,\n"
        "      raw_signal_id: row.raw_signal_id, captured_at: row.captured_at,\n"
        "      raw_signal_founder_id: rs.founder_id || null, raw_signal_company_id: rs.company_id || null,\n"
        "    },\n"
        "    card_founder_id: claim.card_founder_id, card_company_id: claim.card_company_id,\n"
        "  });\n"
        "  if (built.length >= cap) break; // config.budget.max_paid_checks_per_card (see node comment above)\n"
        "}\n"
        "return [{ json: { ...inp, candidate_pairs: built } }];\n",
        2020, -160,
    )
    load_entity_context = code_node(
        "Load entity context (founders + companies)",
        PG_GET_HELPER +
        "const inp = $input.first().json;\n"
        "// Entity gate step 2 (registrable-domain match) + human-readable disambiguators / LLM\n"
        "// candidate_entity hints (design.md SS6, agents/entity-matcher.md's input contract).\n"
        "const companyIds = Array.from(new Set((inp.scoped_rows || []).map(function (r) { return r.card_company_id; }).filter(Boolean)\n"
        "  .concat(inp.company_id ? [inp.company_id] : [])));\n"
        "const founderIds = inp.founder_ids || [];\n"
        "const founders = founderIds.length\n"
        "  ? await pgGet.call(this, 'founders?id=in.(' + founderIds.join(',') + ')&select=id,full_name') : [];\n"
        "const companies = companyIds.length\n"
        "  ? await pgGet.call(this, 'companies?id=in.(' + companyIds.join(',') + ')&select=id,name,domain,aliases') : [];\n"
        "return [{ json: { ...inp, entity_founders: founders || [], entity_companies: companies || [] } }];\n",
        2020, 160,
    )
    nodes += [build_queue, load_entity_context]

    llm_js = (
        "// SOURCE OF TRUTH: docs/backlog/05-truth-gap-trust/agents/contradiction-detector.md +\n"
        "// entity-matcher.md -- system prompts and JSON schemas pasted verbatim below; edit there\n"
        "// and re-run n8n/build-f05-workflow.py, not here. Also pastes lib/f05/entity_gate.js +\n"
        "// lib/f05/verifiers.js (buildEvidenceRow/evidenceContentHash) verbatim -- same modules\n"
        "// f05-verify-claims inlines, independently, per this file's own no-shared-import\n"
        "// precedent between generated Code nodes.\n"
        "const CONTRA_SYS = " + json.dumps(CONTRADICTION_DETECTOR_PROMPT) + ";\n"
        "const CONTRA_SCHEMA = " + json.dumps(CONTRADICTION_DETECTOR_SCHEMA) + ";\n"
        "const MATCH_SYS = " + json.dumps(ENTITY_MATCHER_PROMPT) + ";\n"
        "const MATCH_SCHEMA = " + json.dumps(ENTITY_MATCHER_SCHEMA) + ";\n"
        "const MODEL_NAME = " + json.dumps(MODEL) + ";\n"
        "const PROMPT_VERSION_VAL = " + json.dumps(PROMPT_VERSION) + ";\n"
        "\n"
        "// globalThis.crypto.subtle IS UNDEFINED inside this n8n build's actual Code-node VM\n"
        "// sandbox (verified live 2026-07-19 building f05-verify-claims -- see that workflow's own\n"
        "// CHECKS node comment). Rather than editing the frozen lib/f05/verifiers.js (out of scope\n"
        "// for this task), this supplies Node's own WebCrypto implementation under the SAME\n"
        "// globalThis.crypto name verifiers.js already reads -- confirmed live to expose an\n"
        "// identical .subtle.digest() surface, so evidenceContentHash()/sha256Hex() run\n"
        "// completely unmodified. require('crypto') is already allow-listed\n"
        "// (infra/n8n/docker-compose.yml's NODE_FUNCTION_ALLOW_BUILTIN=crypto,url).\n"
        "globalThis.crypto = require('crypto').webcrypto;\n"
        "\n"
        + ENTITY_GATE_JS + "\n"
        + VERIFIERS_JS + "\n"
        "// ---- call + row-building helpers ----\n"
        "async function callLlm(self, sysPrompt, schemaName, schema, userPayload) {\n"
        "  const r = await self.helpers.httpRequest({\n"
        "    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',\n"
        "    headers: { Authorization: 'Bearer ' + $env.OPENAI_API_KEY, 'Content-Type': 'application/json' },\n"
        "    body: {\n"
        "      // gpt-5.6-luna rejects temperature: 0 (HTTP 400, verified live building 03/04/05) --\n"
        "      // omitted entirely rather than sent as 0 or 1 (both agents/*.md's own Model\n"
        "      // Parameters note, restated identically in each).\n"
        "      model: MODEL_NAME,\n"
        "      messages: [ { role: 'system', content: sysPrompt }, { role: 'user', content: JSON.stringify(userPayload) } ],\n"
        "      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: false, schema } },\n"
        "    },\n"
        "    json: true,\n"
        "  });\n"
        "  return JSON.parse(r.choices[0].message.content);\n"
        "}\n"
        "\n"
        "function buildCandidateEntity(pair, founderById, companyById) {\n"
        "  const founder = pair.card_founder_id ? founderById.get(pair.card_founder_id) : null;\n"
        "  const company = pair.card_company_id ? companyById.get(pair.card_company_id) : null;\n"
        "  return {\n"
        "    company_name: company ? company.name : null, company_domain: company ? company.domain : null,\n"
        "    company_aliases: company ? company.aliases : [], founder_name: founder ? founder.full_name : null,\n"
        "    product_name: null,\n"
        "  };\n"
        "}\n"
        "\n"
        "function buildAiRunRow(inp, pair, output, kIndex, agentName) {\n"
        "  return {\n"
        "    task_type: 'verification', founder_id: pair.card_founder_id || null,\n"
        "    company_id: pair.card_company_id || null, application_id: inp.application_id,\n"
        "    model: MODEL_NAME, prompt_version: PROMPT_VERSION_VAL,\n"
        "    output_json: Object.assign({ agent: agentName, k_index: kIndex, claim_id: pair.claim_id, question: pair.question }, output || {}),\n"
        "    confidence: null, // design.md SS6.0b -- no model in this feature ever emits a confidence number\n"
        "  };\n"
        "}\n"
        "\n"
        "// ---- invocation ----\n"
        "const self = this;\n"
        "const inp = $input.first().json;\n"
        "const candidatePairs = inp.candidate_pairs || [];\n"
        "const founderById = new Map((inp.entity_founders || []).map(function (f) { return [f.id, f]; }));\n"
        "const companyById = new Map((inp.entity_companies || []).map(function (c) { return [c.id, c]; }));\n"
        "\n"
        "const evidenceRows = [];\n"
        "const aiRunRows = [];\n"
        "const contradictionByClaim = {};\n"
        "const gateFailuresByClaim = {};\n"
        "let llmCallCount = 0;\n"
        "\n"
        "for (const pair of candidatePairs) {\n"
        "  const candidateEntity = buildCandidateEntity(pair, founderById, companyById);\n"
        "  const userPayload = {\n"
        "    question: pair.question, founder_claim: pair.founder_claim,\n"
        "    evidence: {\n"
        "      quote_verbatim: pair.evidence.quote_verbatim, tier: pair.evidence.tier,\n"
        "      source_url: pair.evidence.source_url, captured_at: pair.evidence.captured_at,\n"
        "    },\n"
        "    candidate_entity: candidateEntity,\n"
        "  };\n"
        "\n"
        "  let call1, call2;\n"
        "  try { call1 = await callLlm(self, CONTRA_SYS, 'contradiction_detector', CONTRA_SCHEMA, userPayload); llmCallCount += 1; }\n"
        "  catch (e) { call1 = { agent: 'contradiction-detector', contradiction_found: false, contradiction: null, error: String((e && e.message) || e) }; }\n"
        "  try { call2 = await callLlm(self, CONTRA_SYS, 'contradiction_detector', CONTRA_SCHEMA, userPayload); llmCallCount += 1; }\n"
        "  catch (e) { call2 = { agent: 'contradiction-detector', contradiction_found: false, contradiction: null, error: String((e && e.message) || e) }; }\n"
        "\n"
        "  aiRunRows.push(buildAiRunRow(inp, pair, call1, 0, 'contradiction-detector'));\n"
        "  aiRunRows.push(buildAiRunRow(inp, pair, call2, 1, 'contradiction-detector'));\n"
        "\n"
        "  const found1 = call1.contradiction_found === true;\n"
        "  const found2 = call2.contradiction_found === true;\n"
        "  const agree = found1 === found2;\n"
        "\n"
        "  if (!found1 && !found2) {\n"
        "    // design.md SS9 -- even 'checked, agreed there is nothing here' needs an auditable\n"
        "    // context row: the ONLY trace distinguishing 'we compared these two and they agreed'\n"
        "    // from 'never checked'.\n"
        "    const contextRow = await buildEvidenceRow({\n"
        "      claimId: pair.claim_id, relation: 'context', tier: pair.evidence.tier || 'inferred',\n"
        "      quoteVerbatim: pair.evidence.quote_verbatim, sourceUrl: pair.evidence.source_url,\n"
        "      rawSignalId: pair.evidence.raw_signal_id, checkId: 'contradiction_llm',\n"
        "      candidateKey: 'no_contradiction:' + (pair.evidence.quote_verbatim || pair.claim_id),\n"
        "    });\n"
        "    evidenceRows.push(contextRow);\n"
        "    continue;\n"
        "  }\n"
        "\n"
        "  // design.md SS6.0b -- K=2 agreement-weighting: use whichever run found the\n"
        "  // contradiction (if both, call1's) -- never averaged, never a tie-breaking third call.\n"
        "  const primary = found1 ? call1.contradiction : call2.contradiction;\n"
        "  if (!primary || typeof primary.found_reality !== 'string' ||\n"
        "      !String(pair.evidence.quote_verbatim || '').includes(primary.found_reality)) {\n"
        "    // agents/contradiction-detector.md's own write-time note: found_reality MUST be an\n"
        "    // exact substring of evidence.quote_verbatim before persisting -- a non-matching echo\n"
        "    // is a paraphrase violation, dropped and logged (via the ai_runs row already pushed\n"
        "    // above), never trusted -- same posture 03's gate takes on its own quote_verbatim\n"
        "    // fields.\n"
        "    continue;\n"
        "  }\n"
        "\n"
        "  // design.md SS6.0b: 'disagreement... downgrades it to partially_supported' --\n"
        "  // implemented as a TIER downgrade, never as new view logic: only documented-tier\n"
        "  // evidence can ever yield a flat 'contradicted' verdict (design SS6.0/SS7.4), so\n"
        "  // forcing 'discovered' on disagreement makes the ALREADY-BUILT claim_trust view\n"
        "  // produce exactly that outcome by itself.\n"
        "  const effectiveTier = agree ? (pair.evidence.tier === 'documented' ? 'documented' : 'discovered') : 'discovered';\n"
        "\n"
        "  const entity = {\n"
        "    founderId: pair.card_founder_id || null, companyId: pair.card_company_id || null,\n"
        "    founderName: candidateEntity.founder_name, companyName: candidateEntity.company_name,\n"
        "    companyDomain: candidateEntity.company_domain, companyAliases: candidateEntity.company_aliases,\n"
        "  };\n"
        "\n"
        "  // candidate.quote is the STABLE, DB-sourced pair.evidence.quote_verbatim -- NOT\n"
        "  // primary.found_reality. Found live (this workflow's own build, 2026-07-19): gpt-5.6-luna\n"
        "  // has no temperature:0 available (rejected, HTTP 400), so its exact extracted substring\n"
        "  // legitimately varies call to call even on identical input -- re-running THIS pair\n"
        "  // produced two different (both individually verbatim-valid) found_reality strings,\n"
        "  // 'a rolling 30-day total of 4,200 processed transactions' vs the same text plus\n"
        "  // 'across all connected accounts', which hashed to two different content_hash values and\n"
        "  // defeated the re-run-inserts-no-duplicates guarantee design.md SS10.1 requires.\n"
        "  // Anchoring the gate's candidate.quote (and, below, the written evidence row's own\n"
        "  // quoteVerbatim/candidateKey) to the ALREADY-STABLE evidence.quote_verbatim already in\n"
        "  // the database fixes idempotency AND was found to improve entity resolution: it also\n"
        "  // gives entity-matcher (step 3) the FULL cited text to search for a naming mention in,\n"
        "  // not just whatever narrower excerpt the contradiction call happened to quote -- in\n"
        "  // testing, a case where found_reality omitted 'Ledgerly'/the domain entirely (because the\n"
        "  // model's excerpt was narrower than the full citation) correctly failed to resolve for\n"
        "  // exactly that reason, which is a correct fail-closed outcome given what it was shown,\n"
        "  // but the FULL quote lets the model see naming context the narrow excerpt strips away.\n"
        "  // primary.found_reality itself is NOT lost -- it is stored verbatim in full on the\n"
        "  // claim_contradicted event's own found_reality field below, and in ai_runs' raw output.\n"
        "  const gate = await applyEntityGate({\n"
        "    claimId: pair.claim_id,\n"
        "    candidate: { sourceUrl: pair.evidence.source_url || null, quote: pair.evidence.quote_verbatim, tier: effectiveTier },\n"
        "    rawSignal: { id: pair.evidence.raw_signal_id, founderId: pair.evidence.raw_signal_founder_id, companyId: pair.evidence.raw_signal_company_id },\n"
        "    entity,\n"
        "    // design.md SS6 step 3 -- the ONE call site in this feature where the entity-matcher\n"
        "    // LLM actually fires, only after steps 1-2 (deterministic) have both already failed\n"
        "    // inside applyEntityGate.\n"
        "    matchWithLlm: async function (candidate, ent) {\n"
        "      let resp;\n"
        "      try {\n"
        "        resp = await callLlm(self, MATCH_SYS, 'entity_matcher', MATCH_SCHEMA, {\n"
        "          quote: candidate.quote, source_url: candidate.sourceUrl, candidate_entity: candidateEntity,\n"
        "        });\n"
        "        llmCallCount += 1;\n"
        "      } catch (e) {\n"
        "        aiRunRows.push(buildAiRunRow(inp, pair, { error: String((e && e.message) || e) }, null, 'entity-matcher'));\n"
        "        return null;\n"
        "      }\n"
        "      aiRunRows.push(buildAiRunRow(inp, pair, resp, null, 'entity-matcher'));\n"
        "      if (!resp || resp.resolved !== true || !resp.entity_match) return null;\n"
        "      // Runner-side citation check (agents/entity-matcher.md's own posture: 'the runner\n"
        "      // checks it, a malformed response is dropped and logged rather than silently\n"
        "      // trusted') -- both fields must be exact substrings of the SAME quote the model saw.\n"
        "      const q = String(candidate.quote || '');\n"
        "      if (!q.includes(resp.entity_match.quote) || !q.includes(resp.entity_match.disambiguator)) return null;\n"
        "      return { quote: resp.entity_match.quote, disambiguator: resp.entity_match.disambiguator };\n"
        "    },\n"
        "  });\n"
        "\n"
        "  if (gate.resolved) {\n"
        "    // quoteVerbatim/candidateKey use the SAME stable pair.evidence.quote_verbatim as the\n"
        "    // gate call above (see the comment there) -- content_hash idempotency, not design's\n"
        "    // literal SS6.2 wording ('found_reality also becomes evidence.quote_verbatim'), which\n"
        "    // assumed a deterministic finding (true for quote_guard/gh_provenance, not for an LLM\n"
        "    // extraction sampled without temperature:0). primary.found_reality is preserved in full\n"
        "    // on the claim_contradicted event below.\n"
        "    const evidenceRow = await buildEvidenceRow({\n"
        "      claimId: pair.claim_id, relation: 'contradicts', tier: effectiveTier, quoteVerbatim: pair.evidence.quote_verbatim,\n"
        "      sourceUrl: pair.evidence.source_url || null, rawSignalId: pair.evidence.raw_signal_id,\n"
        "      checkId: 'contradiction_llm', candidateKey: 'contradicted:' + (pair.evidence.raw_signal_id || pair.evidence.quote_verbatim),\n"
        "    });\n"
        "    evidenceRows.push(evidenceRow);\n"
        "    contradictionByClaim[pair.claim_id] = {\n"
        "      sourceUrl: pair.evidence.source_url || null, nature: primary.nature, severity: primary.severity,\n"
        "      foundReality: primary.found_reality, question: pair.question, entityMatch: gate.entityMatch,\n"
        "      agreed: agree, effectiveTier: effectiveTier,\n"
        "    };\n"
        "  } else {\n"
        "    // design.md SS6 step 4 -- never silently dropped: an auditable context row records\n"
        "    // the failed gate attempt. The acceptance gate (zero contradicted verdicts that\n"
        "    // failed the entity gate) is proved by SELECTing exactly these rows.\n"
        "    const contextRow = await buildEvidenceRow({\n"
        "      claimId: gate.contextRowFields.claimId, relation: gate.contextRowFields.relation, tier: gate.contextRowFields.tier,\n"
        "      quoteVerbatim: gate.contextRowFields.quoteVerbatim, sourceUrl: gate.contextRowFields.sourceUrl,\n"
        "      rawSignalId: gate.contextRowFields.rawSignalId, checkId: gate.contextRowFields.checkId,\n"
        "      candidateKey: gate.contextRowFields.candidateKey,\n"
        "    });\n"
        "    evidenceRows.push(contextRow);\n"
        "    gateFailuresByClaim[pair.claim_id] = true;\n"
        "  }\n"
        "}\n"
        "\n"
        "return [{ json: {\n"
        "  ...inp, evidence_rows: evidenceRows, ai_run_rows: aiRunRows,\n"
        "  contradiction_by_claim: contradictionByClaim, gate_failures_by_claim: gateFailuresByClaim,\n"
        "  llm_call_count: llmCallCount,\n"
        "} }];\n"
    )
    llm_node = code_node("LLM DISPATCH - contradiction-detector (K=2) + entity gate", llm_js, 2300, 0,
                          notes="SOURCE OF TRUTH: agents/contradiction-detector.md + agents/entity-matcher.md "
                                "(prompts+schemas) + lib/f05/entity_gate.js + lib/f05/verifiers.js -- do not "
                                "edit here, edit there and re-paste. The ONE workflow in feature 05 where an "
                                "LLM can accuse a founder.")
    nodes.append(llm_node)

    write_evidence = code_node(
        "Write evidence rows",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = inp.evidence_rows || [];\n"
        "// design.md SS10.1 -- content_hash NOT NULL UNIQUE; PostgREST's on_conflict= +\n"
        "// Prefer: resolution=ignore-duplicates is this workflow's equivalent of\n"
        "// `INSERT ... ON CONFLICT (content_hash) DO NOTHING` -- re-running against the same\n"
        "// application/pairs inserts zero duplicate rows.\n"
        "if (rows.length) {\n"
        "  await pg.call(this, 'POST', 'evidence?on_conflict=content_hash', rows, 'resolution=ignore-duplicates,return=minimal');\n"
        "}\n"
        "return [{ json: { ...inp, evidence_written: rows.length } }];\n",
        2580, -160,
    )
    write_ai_runs = code_node(
        "Write ai_runs (K=2 + entity-matcher ledger)",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "// design.md SS6.0b -- confidence is a literal SQL NULL on every row (never read from\n"
        "// output_json); both K=2 contradiction-detector calls AND every entity-matcher call are\n"
        "// ledgered here, so a K=2 disagreement is itself visible in the audit trail even though\n"
        "// neither call carries a confidence number.\n"
        "const rows = inp.ai_run_rows || [];\n"
        "if (rows.length) {\n"
        "  await pg.call(this, 'POST', 'ai_runs', rows, 'return=minimal');\n"
        "}\n"
        "return [{ json: { ...inp, ai_runs_written: rows.length } }];\n",
        2580, 160,
    )
    nodes += [write_evidence, write_ai_runs]

    build_events = code_node(
        "BUILD EVENTS (claim_verification_attempted / claim_contradicted)",
        "function entityForClaim(pair, applicationId) {\n"
        "  if (pair.card_founder_id) return { entityType: 'founder', entityId: pair.card_founder_id };\n"
        "  return { entityType: 'application', entityId: applicationId };\n"
        "}\n"
        "\n"
        "const inp = $input.first().json;\n"
        "const candidatePairs = inp.candidate_pairs || [];\n"
        "const contradictionByClaim = inp.contradiction_by_claim || {};\n"
        "const gateFailuresByClaim = inp.gate_failures_by_claim || {};\n"
        "const checkedAt = new Date().toISOString();\n"
        "const ACTOR = 'f05-contradiction-scan';\n"
        "const eventRows = [];\n"
        "const contradictedClaimIds = new Set();\n"
        "\n"
        "for (const pair of candidatePairs) {\n"
        "  const ent = entityForClaim(pair, inp.application_id);\n"
        "  eventRows.push({\n"
        "    event_type: 'claim_verification_attempted', entity_type: ent.entityType, entity_id: ent.entityId,\n"
        "    payload: {\n"
        "      claim_id: pair.claim_id, class: null, check: 'contradiction_llm', question: pair.question,\n"
        "      checked_at: checkedAt, run_id: inp.run_id, gate_failed: Boolean(gateFailuresByClaim[pair.claim_id]),\n"
        "    },\n"
        "    actor: ACTOR,\n"
        "  });\n"
        "\n"
        "  if (contradictionByClaim[pair.claim_id] && !contradictedClaimIds.has(pair.claim_id)) {\n"
        "    contradictedClaimIds.add(pair.claim_id);\n"
        "    const contradiction = contradictionByClaim[pair.claim_id];\n"
        "    const base = {\n"
        "      claim_id: pair.claim_id, class: null, check: 'contradiction_llm',\n"
        "      verdict_before: null, verdict_after: null,\n"
        "      source_url: contradiction.sourceUrl || null, checked_at: checkedAt, run_id: inp.run_id,\n"
        "      nature: contradiction.nature, severity: contradiction.severity,\n"
        "      found_reality: contradiction.foundReality, question: contradiction.question,\n"
        "      agreed: contradiction.agreed, effective_tier: contradiction.effectiveTier,\n"
        "    };\n"
        "    // design.md SS9 -- application-fallback payload OMITS founder_claim and\n"
        "    // entity_match.quote so an unpurgeable event never carries personal data.\n"
        "    const payload = ent.entityType === 'application'\n"
        "      ? Object.assign({}, base, {\n"
        "          entity_match: contradiction.entityMatch\n"
        "            ? { resolved_by: contradiction.entityMatch.resolved_by, disambiguator: contradiction.entityMatch.disambiguator }\n"
        "            : null,\n"
        "        })\n"
        "      : Object.assign({ founder_claim: pair.founder_claim.text_verbatim }, base, { entity_match: contradiction.entityMatch });\n"
        "    eventRows.push({ event_type: 'claim_contradicted', entity_type: ent.entityType, entity_id: ent.entityId, payload, actor: ACTOR });\n"
        "  }\n"
        "}\n"
        "\n"
        "return [{ json: { ...inp, event_rows: eventRows } }];\n",
        2860, 0,
    )
    nodes.append(build_events)

    write_events = code_node(
        "Write events",
        PG_HELPER +
        "const inp = $input.first().json;\n"
        "const rows = inp.event_rows || [];\n"
        "if (rows.length) {\n"
        "  await pg.call(this, 'POST', 'events', rows, 'return=minimal');\n"
        "}\n"
        "return [{ json: { ...inp, events_written: rows.length } }];\n",
        3140, 0,
    )
    nodes.append(write_events)

    build_contract = code_node(
        "Build output contract",
        "const inp = $input.first().json;\n"
        "return [{ json: {\n"
        "  application_id: inp.application_id, run_id: inp.run_id, status: 'scanned',\n"
        "  candidate_pairs_processed: (inp.candidate_pairs || []).length,\n"
        "  contradictions_confirmed: Object.keys(inp.contradiction_by_claim || {}).length,\n"
        "  gate_failures: Object.keys(inp.gate_failures_by_claim || {}).length,\n"
        "  evidence_written: inp.evidence_written || 0, ai_runs_written: inp.ai_runs_written || 0,\n"
        "  events_written: inp.events_written || 0, llm_call_count: inp.llm_call_count || 0,\n"
        "} }];\n",
        3420, 0,
    )
    nodes.append(build_contract)

    nodes.append(sticky(
        "Note: entity gate + K=2 tier downgrade",
        "### THE SAFETY STACK (design.md SS6/SS6.0b)\n"
        "K=2: two contradiction-detector calls per pair. Agreement on\n"
        "'found' -> proceed at the evidence's own tier. DISAGREEMENT\n"
        "forces tier='discovered' -- the already-built claim_trust view\n"
        "structurally caps that at partially_supported, no new view\n"
        "logic needed. Either way, the candidate then passes\n"
        "entity_gate.js steps 1-2 (code), and only THEN, if unresolved,\n"
        "entity-matcher (LLM, step 3) -- the ONE call site in this\n"
        "feature where that fires. A gate failure writes an auditable\n"
        "`context` row and STOPS -- never a `contradicts` row.",
        1700, -520, 760, 320,
    ))
    nodes.append(sticky(
        "Note: narrow queue, independently callable",
        "### SELF-SERVICE QUEUE, OR CALLER-SUPPLIED\n"
        "Given { application_id } alone, this workflow builds its OWN\n"
        "narrow queue (self_reported / deck-sourced claims + their\n"
        "independent, quoted evidence, capped by\n"
        "config.budget.max_paid_checks_per_card). Given { pairs: [...] }\n"
        "it uses that queue as-is -- e.g. from f05-verify-claims or a\n"
        "future Tavily (factual_dynamic) branch. Both workflows stay\n"
        "independently deployable/testable rather than one always\n"
        "chaining into the other -- see README-f05.md.",
        2480, -520, 760, 320,
    ))

    conns = merge_connections(
        connect(
            ("Webhook Trigger", 0, "Normalize Webhook Input", 0),
            ("Execute Workflow Trigger", 0, "Normalize Sub-workflow Input", 0),
            ("Normalize Webhook Input", 0, "Generate run_id", 0),
            ("Normalize Sub-workflow Input", 0, "Generate run_id", 0),
            ("Generate run_id", 0, "Load application + company", 0),
            ("Load application + company", 0, "Load founder_ids for company", 0),
            ("Load founder_ids for company", 0, "Load active trust_v1 budget config", 0),
            ("Load active trust_v1 budget config", 0, "Load scope card ids", 0),
            ("Load scope card ids", 0, "Load claim_trust rows (scoped)", 0),
            ("Load claim_trust rows (scoped)", 0, "RESTRICT (trust.js)", 0),
            ("RESTRICT (trust.js)", 0, "Build narrow queue (deck-sourced / self-reported claims)", 0),
            ("Build narrow queue (deck-sourced / self-reported claims)", 0, "Load entity context (founders + companies)", 0),
            ("Load entity context (founders + companies)", 0, llm_node["name"], 0),
            (llm_node["name"], 0, "Write evidence rows", 0),
            ("Write evidence rows", 0, "Write ai_runs (K=2 + entity-matcher ledger)", 0),
            ("Write ai_runs (K=2 + entity-matcher ledger)", 0, "BUILD EVENTS (claim_verification_attempted / claim_contradicted)", 0),
            ("BUILD EVENTS (claim_verification_attempted / claim_contradicted)", 0, "Write events", 0),
            ("Write events", 0, "Build output contract", 0),
        ),
    )

    workflow = {
        "name": "f05-contradiction-scan",
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
    # Three workflows, one generator (design.md SS11's topology table): f05-trust-rollup (C1a,
    # zero-LLM rollup) plus f05-verify-claims + f05-contradiction-scan (C1b, this file's own
    # addition) -- built/checked/written together so a change to any shared lib/f05/*.js module
    # regenerates all three consistently in one run.
    builders = [build, build_verify_claims, build_contradiction_scan]
    total_failures = 0
    for build_fn in builders:
        wf = build_fn()
        print("%s (%d nodes)" % (wf['name'], len(wf['nodes'])))
        failures = check_nodes(wf['nodes'])
        if not check_only:
            path = os.path.join(OUT, wf['name'] + '.json')
            json.dump(wf, open(path, 'w', encoding='utf-8'), indent=1)
            print("  -> %s" % os.path.relpath(path, ROOT))
        print("Code nodes failing syntax check: %d\n" % failures)
        total_failures += failures
    return 1 if total_failures else 0


if __name__ == '__main__':
    sys.exit(main())
