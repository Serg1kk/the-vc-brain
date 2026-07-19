#!/usr/bin/env python3
"""
Build the feature-09 (`f09-suggest-followup`, investor dashboard) n8n workflow from source.

Why a generator rather than hand-maintained JSON: same reason as `n8n/build-f05-workflow.py`
and `n8n/build-f10-workflow.py` -- the agent's system prompt and JSON schema live as reviewed
artifacts under `docs/backlog/09-investor-dashboard/agents/suggest-followup-questions/*` and
must never be retyped by hand into the Code node, which is exactly the class of drift those
generators exist to prevent. This feature has no `lib/f09/*.js` (single-endpoint workflow, no
tested shared module yet), so the deterministic gap-selection logic is written directly as
Python string constants below rather than inlined from a separate source file -- still
generated, not hand-edited in the JSON, for the same reason: the workflow JSON is 1000+ lines
and a single stray brace in a hand edit is invisible until n8n rejects the import.

Run after any change to the agent artifacts or to this file's own JS bodies:

    python3 n8n/build-f09-workflow.py           # regenerate n8n/workflows/f09-suggest-followup.json
    python3 n8n/build-f09-workflow.py --check   # syntax-check every Code node, no write

Then PUT/POST the JSON to n8n (see n8n/workflows/README-f09.md).

Schema deviation, same root cause f10's build script already documented and verified live
2026-07-19: OpenAI's Structured Outputs API rejects `minLength`/`maxLength`/`pattern`/
`uniqueItems`/`maxItems`/`$schema`/`title` in a strict-mode schema. The wire schema sent to the
API strips exactly those keywords from the canonical
`suggest-followup-questions-agent-json-schema.json` and nothing else -- `minItems`, `examples`,
`description`, `enum` and `additionalProperties` all passed live in feature 08's own identical
call, so they are kept here too rather than pre-emptively stripped.
"""
import json
import os
import subprocess
import sys
import tempfile
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_DIR = os.path.join(ROOT, 'docs', 'backlog', '09-investor-dashboard', 'agents',
                          'suggest-followup-questions')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

MODEL = 'gpt-5.6-terra'


def agent_system_prompt():
    t = open(os.path.join(AGENT_DIR, 'suggest-followup-questions-agent-prompts.txt'),
              encoding='utf-8').read()
    return t[t.find('SYSTEM MESSAGE'):].split('=' * 80, 1)[1].strip()


def agent_schema():
    return json.load(open(os.path.join(AGENT_DIR, 'suggest-followup-questions-agent-json-schema.json'),
                           encoding='utf-8'))


# OpenAI strict-mode keyword denylist -- see module docstring. Same list
# n8n/build-f10-workflow.py's own _strip_kw uses.
_STRIP_KEYWORDS = ('minLength', 'maxLength', 'pattern', 'uniqueItems', 'maxItems', '$schema', 'title')


def _strip_kw(node):
    if isinstance(node, dict):
        return {k: _strip_kw(v) for k, v in node.items() if k not in _STRIP_KEYWORDS}
    if isinstance(node, list):
        return [_strip_kw(v) for v in node]
    return node


def build_wire_schema():
    schema = agent_schema()
    return _strip_kw(schema)


SYSTEM_PROMPT = agent_system_prompt()
WIRE_SCHEMA = build_wire_schema()


# ============================================================================
# n8n node/connection helpers (same shape as n8n/build-f10-workflow.py)
# ============================================================================

def nid():
    return str(uuid.uuid4())


def code_node(name, js, x, y, notes=None, on_error=None):
    node = {
        "parameters": {"mode": "runOnceForAllItems", "jsCode": js},
        "id": nid(), "name": name, "type": "n8n-nodes-base.code",
        "typeVersion": 2, "position": [x, y],
    }
    if notes:
        node["notes"] = notes
    if on_error:
        node["onError"] = on_error
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


def respond_node(name, x, y, code):
    return {
        "parameters": {"respondWith": "firstIncomingItem", "options": {"responseCode": code}},
        "id": nid(), "name": name, "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.1, "position": [x, y],
    }


def sticky(name, content, x, y, w, h):
    return {
        "parameters": {"content": content, "height": h, "width": w},
        "id": nid(), "name": name, "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1, "position": [x, y],
    }


def openai_node(name, x, y):
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
            "options": {"timeout": 30000},
        },
        "id": nid(), "name": name, "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.1, "position": [x, y],
        "retryOnFail": True, "maxTries": 2, "waitBetweenTries": 3000,
        "onError": "continueErrorOutput",
        "notes": "jsonBody stays a SHORT expression referencing a Code-node-built object -- "
                 "n8n's {{ }} parser truncates on the first '}}' it finds, and this schema's "
                 "nested objects contain several (same defect f07's/f10's build scripts found "
                 "live). temperature omitted -- cross-feature rule 7 (03/done.md).",
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
        os.unlink(path)
        if not ok:
            bad += 1
            print("SYNTAX ERROR in %r:\n%s" % (n['name'], r.stderr))
    return bad


# ============================================================================
# Node bodies
# ============================================================================

PG_HELPERS_JS = r"""
const SB = String($env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const KEY = $env.SUPABASE_SERVICE_ROLE_KEY;
async function pg(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  return await this.helpers.httpRequest({ method, url: SB + '/rest/v1/' + path, headers, body, json: true });
}
async function pgGet(path) { return await pg.call(this, 'GET', path); }
"""

VALIDATE_INPUT_JS = r"""
const item = $input.first().json;
const body = item.body || {};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const applicationId = String(body.application_id || '').trim();
if (!applicationId || !UUID_RE.test(applicationId)) {
  return [{ json: { __valid: false, error: { code: 'invalid_input', message: 'application_id must be a uuid.' } } }];
}
return [{ json: { __valid: true, application_id: applicationId } }];
"""

CLIENT_ERROR_RESPONSE_JS = "return [{ json: { error: $json.error } }];"

LOAD_APPLICATION_JS = PG_HELPERS_JS + r"""
// Existence check + company identity -- same two-step (applications -> companies) f08's
// own "Fetch card + criteria + claims" node uses, kept as its own node here since 09 needs
// no card/claims context, only company identity for the phrasing agent's company_context.
const inp = $json;
const appRows = await pgGet.call(this, 'applications?id=eq.' + inp.application_id + '&select=id,company_id,status');
if (!appRows || !appRows.length) {
  return [{ json: { ...inp, __found: false } }];
}
const companyId = appRows[0].company_id;
const companyRows = await pgGet.call(this,
  'companies?id=eq.' + companyId + '&select=name,one_liner,category,is_synthetic');
const company = (companyRows && companyRows[0]) || {};
return [{ json: { ...inp, __found: true, company_id: companyId,
  company_name: company.name || null, one_liner: company.one_liner || null,
  sector: company.category || null, is_synthetic: !!company.is_synthetic } }];
"""

NOT_FOUND_RESPONSE_JS = "return [{ json: { error: { code: 'not_found', message: 'Application not found.' } } }];"

LOAD_GAP_SOURCES_JS = PG_HELPERS_JS + r"""
const inp = $json;

// founder_ids on this application's company -- same lookup f05's own SS8.1 route 3 uses,
// reused here for the identical reason: contradiction events and founder_score_gaps are
// both founder-scoped, not application-scoped.
const founderRows = await pgGet.call(this, 'founder_company?company_id=eq.' + inp.company_id + '&select=founder_id');
const founder_ids = (founderRows || []).map(r => r.founder_id).filter(Boolean);

// Contradictions -- data-contracts.md SS8: "query both shapes" (application-fallback for
// company-only cards, founder-scoped otherwise).
const contradictionsApp = await pgGet.call(this,
  'events?event_type=eq.claim_contradicted&entity_type=eq.application&entity_id=eq.' + inp.application_id + '&order=created_at.desc');
let contradictionsFounder = [];
if (founder_ids.length) {
  contradictionsFounder = await pgGet.call(this,
    'events?event_type=eq.claim_contradicted&entity_type=eq.founder&entity_id=in.(' + founder_ids.join(',') + ')&order=created_at.desc');
}

// Founder-score gaps -- api_founders.founder_score_gaps[], already investor-language
// (lovable-brief.md SS4.4: "render as-is, do not rewrite").
let founderRowsScored = [];
if (founder_ids.length) {
  founderRowsScored = await pgGet.call(this,
    'api_founders?founder_id=in.(' + founder_ids.join(',') + ')&select=founder_id,full_name,founder_score,founder_score_gaps');
}

// score_formulas active founder_score config -- criteria[].anchor/weight, same source
// f08's own "Fetch card + criteria + claims" node reads (independent copy, no shared
// import between generators, house convention).
const formulaRows = await pgGet.call(this,
  'score_formulas?axis=eq.founder_score&active=eq.true&select=config&order=created_at.asc&limit=1');
const criteria = (formulaRows.length && formulaRows[0].config && formulaRows[0].config.criteria) || [];

// Missing (not-disclosed) claims -- api_claims carries application_id + topic; claim_trust
// carries the authoritative derived_status (data-contracts.md SS4: "read derived_status,
// not verification_status"). Two reads, same reason claim_trust has no application_id.
const claimRows = await pgGet.call(this,
  'api_claims?application_id=eq.' + inp.application_id + '&select=claim_id,topic,text_verbatim');
let missingClaimIds = [];
if (claimRows.length) {
  const claimIds = claimRows.map(c => c.claim_id);
  const trustRows = await pgGet.call(this,
    'claim_trust?claim_id=in.(' + claimIds.join(',') + ')&derived_status=eq.missing&select=claim_id');
  missingClaimIds = (trustRows || []).map(r => r.claim_id);
}

return [{ json: { ...inp, founder_ids, contradiction_events: [...contradictionsApp, ...contradictionsFounder],
  founder_rows: founderRowsScored, criteria_config: criteria, claim_rows: claimRows,
  missing_claim_ids: missingClaimIds } }];
"""

SELECT_RANK_GAPS_JS = r"""
// Deterministic gap selection for feature 09's "Suggest follow-up questions" card action
// (lovable-brief.md SS9.4). Three gap sources, each capped, each independently
// deterministic -- NO LLM involved in WHICH gaps get asked about, only in HOW the two
// evidence-description sources get turned into spoken questions (this node -> Build
// request -> OpenAI: suggest-followup-questions).
//
// Source A: contradictions (events.claim_contradicted). Fully deterministic -- the stored
// payload.question was already written by feature 05's own pipeline at verification time.
// This bucket needs zero model calls. Capped at 3, most-recent-per-claim wins.
//
// Source B: founder_score_gaps[] (api_founders). what_would_close_it is already
// investor-language prose describing MISSING EVIDENCE, not a question -- ranked by the
// live score_formulas criteria weight, capped at 2.
//
// Source C: missing (not-disclosed) claims (claim_trust.derived_status='missing'), scoped
// to this application via api_claims. Deduped against any topic already reachable through
// a Source-B criterion (CRITERION_TOPIC below), so the same underlying fact is never asked
// about twice through two different phrasings. Capped at 2, ordered by topic for
// run-to-run stability (claim_trust rows carry no timestamp to order by instead).
//
// Deliberately EXCLUDED (suggest-followup-questions-agent-tbd-items.md TBD-3):
// score_market/idea_vs_market missing[] short codes (gap_growth, gap_size_bottom_up, ...)
// and thesis_missing_fields -- terse internal flags with no investor-language description
// anywhere in this codebase; turning them into a spoken question would require guessing
// their meaning, which this feature's own "never fabricate" rule forbids.

// CRITERION_TOPIC -- SOURCE OF TRUTH: lib/f08/gaps.js. Duplicated here (not required --
// this sandbox cannot require() a repo file, same "zero imports" convention every lib/*.js
// file in this repo states) purely to dedupe Source C against Source B's own criteria.
const CRITERION_TOPIC = {
  E1: 'founder.execution.merged_pr_foreign', E3: 'founder.execution.commit_consistency',
  E4: 'founder.execution.live_product', E5: 'founder.execution.external_usage',
  E7: 'founder.execution.provenance', X1: 'founder.expertise.vertical_tenure',
  X2: 'founder.expertise.insight_specificity', X5: 'founder.expertise.competitor_granularity',
  X6: 'founder.expertise.unasked_work', L2: 'founder.leadership.first_customers',
  L3: 'founder.leadership.icp_specificity', L5: 'founder.leadership.written_communication',
};

function normalizeCriteriaList(criteria) {
  if (!criteria) return [];
  if (Array.isArray(criteria)) return criteria.filter(Boolean);
  return Object.keys(criteria).map((id) => ({ id, ...criteria[id] }));
}

function fmtDate(iso) {
  if (!iso) return null;
  try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return null; }
}

function clip(text, max) {
  if (!text) return text;
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

const inp = $json;

// ---- Source A: contradictions ----------------------------------------

const byClaim = new Map();
for (const ev of (inp.contradiction_events || [])) {
  const p = ev.payload || {};
  const claimId = p.claim_id || ev.id;
  const existing = byClaim.get(claimId);
  if (!existing || new Date(ev.created_at) > new Date(existing.created_at)) byClaim.set(claimId, ev);
}
const contradictionEvents = Array.from(byClaim.values())
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  .slice(0, 3);

const contradiction_questions = contradictionEvents.map((ev) => {
  const p = ev.payload || {};
  const question = p.question || 'Can you walk me through this in more detail?';
  const date = fmtDate(p.checked_at);
  const founderClaim = clip(p.founder_claim, 70);
  const foundReality = clip(p.found_reality, 70);
  let why;
  if (founderClaim && foundReality) {
    why = 'The deck says "' + founderClaim + '"' + (date ? ' (checked ' + date + ')' : '') +
      '; a public source says: "' + foundReality + '". Worth asking about.';
  } else if (foundReality) {
    why = 'A public check' + (date ? ' on ' + date : '') + ' found: "' + foundReality + '". Worth asking about.';
  } else {
    why = 'A public check' + (date ? ' on ' + date : '') + ' raised a question here. Worth asking about.';
  }
  return { ref_id: 'contradiction:' + (p.claim_id || ev.id), question, why, source: 'contradiction' };
});

// ---- Source B: founder_score_gaps -------------------------------------

const criteriaById = new Map(normalizeCriteriaList(inp.criteria_config).map(c => [c.id, c]));
const fsgCandidates = [];
const seenCriteria = new Set();
for (const fr of (inp.founder_rows || [])) {
  const gaps = Array.isArray(fr.founder_score_gaps) ? fr.founder_score_gaps : [];
  for (const g of gaps) {
    if (!g || !g.criterion_id || seenCriteria.has(g.criterion_id)) continue;
    seenCriteria.add(g.criterion_id);
    const cfg = criteriaById.get(g.criterion_id) || {};
    fsgCandidates.push({
      founder_id: fr.founder_id, criterion_id: g.criterion_id,
      weight: typeof cfg.weight === 'number' ? cfg.weight : 0,
      anchor: cfg.anchor || g.criterion_id,
      what_would_close_it: g.what_would_close_it || null,
    });
  }
}
fsgCandidates.sort((a, b) => b.weight - a.weight);
const fsgSelected = fsgCandidates.filter(c => c.what_would_close_it).slice(0, 2);

// ---- Source C: missing (not-disclosed) claims --------------------------

const missingIds = new Set(inp.missing_claim_ids || []);
const excludedTopics = new Set(fsgCandidates.map(c => CRITERION_TOPIC[c.criterion_id]).filter(Boolean));
const seenTopics = new Set();
const mcCandidates = (inp.claim_rows || [])
  .filter(c => missingIds.has(c.claim_id) && c.topic && !excludedTopics.has(c.topic))
  .sort((a, b) => String(a.topic).localeCompare(String(b.topic)))
  .filter(c => { if (seenTopics.has(c.topic)) return false; seenTopics.add(c.topic); return true; })
  .slice(0, 2);

// ---- gap_items for the phrasing agent -----------------------------------

const gap_items = [
  ...fsgSelected.map(c => ({
    ref_id: 'fsg:' + c.founder_id + ':' + c.criterion_id, kind: 'founder_score_gap',
    criterion_label: c.anchor, what_would_close_it: c.what_would_close_it,
  })),
  ...mcCandidates.map(c => ({ ref_id: 'mc:' + c.claim_id, kind: 'missing_claim', topic: c.topic })),
];

const company_context = {
  company_name: inp.company_name || 'this company',
  one_liner: inp.one_liner || null,
  sector: inp.sector || null,
};

const reasons = [];
if (!contradiction_questions.length) reasons.push('no recorded contradictions');
if (!fsgSelected.length) reasons.push((inp.founder_rows && inp.founder_rows.length)
  ? 'no founder-score gaps on file' : 'no founder is scored on this application yet');
if (!mcCandidates.length) reasons.push('no undisclosed topics found in the evidence base');
const empty = !contradiction_questions.length && !gap_items.length;
const empty_reason = empty
  ? 'No follow-up questions to suggest yet: ' + reasons.join(', ') + '.'
  : null;

return [{ json: { ...inp, __contradiction_questions: contradiction_questions,
  __gap_items: gap_items, __company_context: company_context,
  __empty: empty, __empty_reason: empty_reason } }];
"""

# Shared fallback logic -- duplicated verbatim into both "Parse + validate" (per-item
# violation) and "Handle LLM failure" (whole-call failure) nodes, since Code nodes cannot
# share scope. Kept identical to suggest-followup-questions-agent-tbd-items.md D-4.
FALLBACK_JS = r"""
const TOPIC_FALLBACK = {
  'company.business_model': { question: 'In plain terms, how does the company make money today?', why: "We don't have anything describing how the business actually monetizes." },
  'company.stage_evidence': { question: "What's actually live and usable today, and does anyone outside the team use it?", why: "We don't have confirmation of what stage the product is actually at." },
  'company.what_is_built': { question: 'In plain terms, what has the team actually built and shipped so far?', why: "Nothing in the evidence we have describes what the product does today." },
  'company.geography_country': { question: "Where's the company actually based, and is that also where your customers are?", why: "We don't have the company's location on file." },
  'founder.leadership.first_customers': { question: 'Who was your first customer or pilot, and how did that relationship start?', why: "We haven't found any record of a customer or pilot commitment yet." },
};
function missingClaimFallback(topic) {
  const known = TOPIC_FALLBACK[topic];
  if (known) return known;
  const words = String(topic || '').split('.').pop().replace(/_/g, ' ') || 'this';
  return { question: 'Can you tell me more about ' + words + '?', why: "We don't have this on file yet." };
}
function founderScoreGapFallback(criterionLabel) {
  const label = criterionLabel || 'this';
  return { question: 'Can you walk me through ' + label + ', in your own words?', why: "We don't yet have direct evidence for this." };
}
function fallbackFor(item) {
  return item.kind === 'missing_claim' ? missingClaimFallback(item.topic) : founderScoreGapFallback(item.criterion_label);
}
function sourceFor(item) {
  return item.kind === 'missing_claim' ? 'missing_claim' : 'founder_score_gap';
}
"""

BUILD_LLM_REQUEST_JS = r"""
const SYS = __SYS_JSON__;
const SCHEMA = __SCHEMA_JSON__;
const inp = $json;
const userContent = '<company_context>\n' + JSON.stringify(inp.__company_context) +
  '\n</company_context>\n\n<gap_items>\n' + JSON.stringify(inp.__gap_items) + '\n</gap_items>';
const body = {
  model: __MODEL_JSON__,
  input: [ { role: 'system', content: SYS }, { role: 'user', content: userContent } ],
  reasoning: { effort: "low" },
  text: { verbosity: "low", format: { type: 'json_schema',
    name: "suggest_followup_questions_output", strict: true, schema: SCHEMA } },
  max_output_tokens: 1800,
};
return [{ json: { ...inp, __openai_request_body: body } }];
"""

PARSE_VALIDATE_JS = PG_HELPERS_JS + FALLBACK_JS + r"""
const FORBIDDEN_STEMS = ['criterion', 'founder score', 'score', 'gap', 'axis', 'verif', 'claim',
  'topic', 'evidence base', 'coverage', 'confidence', 'lied', 'misrepresent', 'fabricat',
  'inconsistent', 'dishonest', "you didn't tell us", "you failed to"];
function violates(q) {
  if (!q || typeof q.question !== 'string' || typeof q.why !== 'string') return true;
  const all = (q.question + ' ' + q.why).toLowerCase();
  if (FORBIDDEN_STEMS.some(stem => all.includes(stem))) return true;
  if (q.question.length > 160 || q.why.length > 140) return true;
  const qMarks = (q.question.match(/\?/g) || []).length;
  if (qMarks !== 1) return true;
  return false;
}

const crypto = require('crypto');
function sha256Hex(text) { return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex'); }

const ctx = $('Build suggest-followup-questions request').first().json;
const resp = $input.first().json;
let parsed = null;
try {
  const msg = (resp.output || []).find(o => o.type === 'message');
  const rawText = (msg && msg.content && msg.content[0]) ? msg.content[0].text : '';
  parsed = JSON.parse(rawText);
} catch (e) { parsed = null; }

const items = (parsed && Array.isArray(parsed.questions)) ? parsed.questions : [];
const byRef = new Map();
for (const it of items) { if (it && it.ref_id) byRef.set(it.ref_id, it); }

const gapItems = ctx.__gap_items || [];
const phrased = gapItems.map(item => {
  const candidate = byRef.get(item.ref_id);
  if (candidate && !violates(candidate)) {
    return { ref_id: item.ref_id, question: candidate.question, why: candidate.why, source: sourceFor(item) };
  }
  const fb = fallbackFor(item);
  return { ref_id: item.ref_id, question: fb.question, why: fb.why, source: sourceFor(item) };
});

const inputHash = sha256Hex('f09:ai_run:question_generation:' + ctx.application_id + ':' + gapItems.map(i => i.ref_id).join(','));
const found = await pgGet.call(this, 'ai_runs?input_hash=eq.' + encodeURIComponent(inputHash) + '&select=id');
if (!found.length) {
  await pg.call(this, 'POST', 'ai_runs', {
    task_type: 'question_generation', application_id: ctx.application_id,
    model: __MODEL_JSON__, input_hash: inputHash, output_json: { gap_items: gapItems, questions: phrased },
  }, 'return=minimal');
}
return [{ json: { ...ctx, __phrased_questions: phrased } }];
"""

HANDLE_LLM_FAILURE_JS = FALLBACK_JS + r"""
const ctx = $('Build suggest-followup-questions request').first().json;
const phrased = (ctx.__gap_items || []).map(item => {
  const fb = fallbackFor(item);
  return { ref_id: item.ref_id, question: fb.question, why: fb.why, source: sourceFor(item) };
});
return [{ json: { ...ctx, __phrased_questions: phrased } }];
"""

SKIP_PHRASING_JS = "return [{ json: { ...$json, __phrased_questions: [] } }];"

BUILD_FINAL_RESPONSE_JS = r"""
const inp = $json;
const questions = [...(inp.__contradiction_questions || []), ...(inp.__phrased_questions || [])];
const founderName = (inp.founder_rows && inp.founder_rows.length && inp.founder_rows[0].full_name) || null;
const greeting = founderName ? ('Hi ' + String(founderName).split(' ')[0] + ',') : 'Hi,';

let email_preview = null;
if (questions.length) {
  const bulletList = questions.map(q => '- ' + q.question).join('\n');
  email_preview = {
    subject: 'A few things before our call' + (inp.company_name ? ' — ' + inp.company_name : ''),
    body: greeting + '\n\nLooking forward to our call. A few things I would like to cover:\n\n' +
      bulletList + '\n\nSee you soon.',
  };
}

const response = {
  application_id: inp.application_id,
  company_name: inp.company_name || null,
  generated_at: new Date().toISOString(),
  questions: questions.map(q => ({ question: q.question, why: q.why, source: q.source })),
  email_preview,
  empty_reason: questions.length ? null : inp.__empty_reason,
};
return [{ json: response }];
"""

HANDLE_UNEXPECTED_ERROR_JS = (
    "return [{ json: { error: { code: 'internal', "
    "message: \"Something went wrong on our side. Try again.\" } } }];"
)


def build_llm_request_js():
    js = BUILD_LLM_REQUEST_JS
    js = js.replace('__SYS_JSON__', json.dumps(SYSTEM_PROMPT))
    js = js.replace('__SCHEMA_JSON__', json.dumps(WIRE_SCHEMA))
    js = js.replace('__MODEL_JSON__', json.dumps(MODEL))
    return js


def parse_validate_js():
    return PARSE_VALIDATE_JS.replace('__MODEL_JSON__', json.dumps(MODEL))


# ============================================================================
# Assembly
# ============================================================================

def build_workflow():
    nodes = []

    webhook = {
        "parameters": {"httpMethod": "POST", "path": "f09-suggest-followup",
                        "responseMode": "responseNode", "options": {}},
        "id": nid(), "name": "Webhook: f09-suggest-followup", "type": "n8n-nodes-base.webhook",
        "typeVersion": 2.1, "position": [-1400, 0], "webhookId": nid(),
    }
    validate_input = code_node("Validate input", VALIDATE_INPUT_JS, -1160, 0)
    if_valid = if_node("IF: valid?", "={{ $json.__valid }}", True, "boolean", "equals", -920, 0)
    client_error = code_node("Build client error response", CLIENT_ERROR_RESPONSE_JS, -680, 300)
    respond_400 = respond_node("Respond: bad request (400)", -440, 300, 400)

    load_app = code_node("Load application + company", LOAD_APPLICATION_JS, -680, 0,
                          on_error="continueErrorOutput")
    if_found = if_node("IF: found?", "={{ $json.__found }}", True, "boolean", "equals", -440, 0)
    not_found = code_node("Build not-found response", NOT_FOUND_RESPONSE_JS, -200, 300)
    respond_404 = respond_node("Respond: not found (404)", 40, 300, 404)

    load_gaps = code_node("Load founder_ids + gap sources", LOAD_GAP_SOURCES_JS, -200, 0,
                           on_error="continueErrorOutput")
    select_rank = code_node("Select + rank gaps (deterministic)", SELECT_RANK_GAPS_JS, 40, 0)
    if_gap_items = if_node("IF: any gap_items?", "={{ $json.__gap_items.length }}", 0,
                            "number", "gt", 280, 0)

    build_llm_req = code_node("Build suggest-followup-questions request", build_llm_request_js(),
                               520, -180,
                               notes="SOURCE OF TRUTH: suggest-followup-questions-agent-prompts.txt "
                                     "(SYSTEM MESSAGE) + suggest-followup-questions-agent-json-schema.json "
                                     "(wire-schema strip -- see n8n/build-f09-workflow.py docstring).")
    openai_call = openai_node("OpenAI: suggest-followup-questions (terra)", 760, -180)
    parse_validate = code_node("Parse + validate suggest-followup-questions response",
                                parse_validate_js(), 1000, -180)
    handle_llm_failure = code_node("Handle LLM failure", HANDLE_LLM_FAILURE_JS, 1000, 60)
    skip_phrasing = code_node("Skip phrasing (no gap_items)", SKIP_PHRASING_JS, 520, 180)

    build_response = code_node("Build final response", BUILD_FINAL_RESPONSE_JS, 1240, 0)
    respond_200 = respond_node("Respond: success", 1480, 0, 200)

    handle_unexpected = code_node("Handle unexpected error", HANDLE_UNEXPECTED_ERROR_JS, 760, 600)
    respond_500 = respond_node("Respond: internal error (500)", 1000, 600, 500)

    nodes += [webhook, validate_input, if_valid, client_error, respond_400,
              load_app, if_found, not_found, respond_404,
              load_gaps, select_rank, if_gap_items,
              build_llm_req, openai_call, parse_validate, handle_llm_failure, skip_phrasing,
              build_response, respond_200, handle_unexpected, respond_500]

    overview = sticky(
        "Overview",
        "# f09-suggest-followup\n\n"
        "POST /webhook/f09-suggest-followup  { \"application_id\": \"<uuid>\" }\n\n"
        "Turns the card's gaps into a suggested set of investor-facing follow-up questions "
        "for a founder call. Three deterministic gap sources (contradictions, "
        "founder_score_gaps, not-disclosed claims) are read and ranked in code; only two of "
        "them (founder_score_gaps, missing claims) go through the "
        "suggest-followup-questions LLM agent to be phrased as spoken questions -- "
        "contradictions reuse feature 05's own stored question verbatim, zero model calls. "
        "Contract + example run: n8n/workflows/README-f09.md.",
        -1400, -420, 640, 260,
    )
    nodes.append(overview)

    conns = merge_connections(
        connect(("Webhook: f09-suggest-followup", 0, "Validate input", 0)),
        connect(("Validate input", 0, "IF: valid?", 0)),
        {"IF: valid?": {"main": [
            [{"node": "Load application + company", "type": "main", "index": 0}],
            [{"node": "Build client error response", "type": "main", "index": 0}],
        ]}},
        connect(("Build client error response", 0, "Respond: bad request (400)", 0)),
        {"Load application + company": {"main": [
            [{"node": "IF: found?", "type": "main", "index": 0}],
            [{"node": "Handle unexpected error", "type": "main", "index": 0}],
        ]}},
        {"IF: found?": {"main": [
            [{"node": "Load founder_ids + gap sources", "type": "main", "index": 0}],
            [{"node": "Build not-found response", "type": "main", "index": 0}],
        ]}},
        connect(("Build not-found response", 0, "Respond: not found (404)", 0)),
        {"Load founder_ids + gap sources": {"main": [
            [{"node": "Select + rank gaps (deterministic)", "type": "main", "index": 0}],
            [{"node": "Handle unexpected error", "type": "main", "index": 0}],
        ]}},
        connect(("Select + rank gaps (deterministic)", 0, "IF: any gap_items?", 0)),
        {"IF: any gap_items?": {"main": [
            [{"node": "Build suggest-followup-questions request", "type": "main", "index": 0}],
            [{"node": "Skip phrasing (no gap_items)", "type": "main", "index": 0}],
        ]}},
        connect(("Build suggest-followup-questions request", 0, "OpenAI: suggest-followup-questions (terra)", 0)),
        {"OpenAI: suggest-followup-questions (terra)": {"main": [
            [{"node": "Parse + validate suggest-followup-questions response", "type": "main", "index": 0}],
            [{"node": "Handle LLM failure", "type": "main", "index": 0}],
        ]}},
        connect(
            ("Parse + validate suggest-followup-questions response", 0, "Build final response", 0),
            ("Handle LLM failure", 0, "Build final response", 0),
            ("Skip phrasing (no gap_items)", 0, "Build final response", 0),
            ("Build final response", 0, "Respond: success", 0),
        ),
        connect(("Handle unexpected error", 0, "Respond: internal error (500)", 0)),
    )

    return {
        "name": "f09-suggest-followup", "nodes": nodes, "connections": conns,
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
