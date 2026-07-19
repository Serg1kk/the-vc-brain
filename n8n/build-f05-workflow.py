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
OUT = os.path.join(ROOT, 'n8n', 'workflows')


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
