#!/usr/bin/env python3
"""
Build feature-04 n8n workflow JSON from source.

Why a generator rather than hand-maintained JSON: the deterministic scoring core lives in
lib/f04/*.js where it is unit-tested (141 tests). n8n Code nodes cannot `require` local
files, so that source has to be inlined into the nodes. Doing that by hand means the tested
module and the running workflow drift apart the first time either changes — which is exactly
the class of silent divergence this feature exists to prevent.

Run after any change to lib/f04/ or to the agent prompt/schema artifacts:

    python3 n8n/build-workflows.py           # regenerate JSON
    python3 n8n/build-workflows.py --check   # syntax-check every Code node, no write

Then POST the JSON to n8n (see n8n/workflows/README-f04.md).
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBDIR = os.path.join(ROOT, 'lib', 'f04')
AGENTS = os.path.join(ROOT, 'docs', 'backlog', '04-market-trend-competition', 'agents')
OUT = os.path.join(ROOT, 'n8n', 'workflows')

DB_WRITE_ID = '3tKU8GFFkmSOiJBG'  # f04-db-write, registered 2026-07-19


def inline_lib(*names):
    """Concatenate lib modules into one scope.

    Strips the CommonJS seams: `require('./config')`, the `const {...} = config`
    destructuring (config's own top-level consts are already in scope once inlined, so
    re-declaring them is a SyntaxError), and `module.exports`.
    """
    out = []
    for n in names:
        src = open(os.path.join(LIBDIR, n + '.js'), encoding='utf-8').read()
        src = re.sub(r"const config = require\('\./config'\);", "", src)
        src = re.sub(r"const \w+ = require\('node:crypto'\);", "const crypto = require('crypto');", src)
        src = re.sub(r"const \{[^}]*?\}\s*=\s*config;", "", src, flags=re.S)
        src = re.sub(r"const \{[^}]*?\}\s*=\s*require\('\./[a-z]+'\);", "", src, flags=re.S)
        src = re.sub(r"module\.exports\s*=\s*\{.*?\};", "", src, flags=re.S)
        out.append("// ===== inlined lib/f04/%s.js (generated — edit the source, not this) =====\n%s" % (n, src))
    return "\n".join(out)


def agent_system_prompt(name):
    t = open(os.path.join(AGENTS, name, name + '-agent-prompts.txt'), encoding='utf-8').read()
    return t[t.find('SYSTEM MESSAGE'):].split('=' * 80, 1)[1].strip()


def agent_schema(name):
    return json.load(open(os.path.join(AGENTS, name, name + '-agent-json-schema.json'), encoding='utf-8'))


def blocklist():
    cfg = open(os.path.join(LIBDIR, 'config.js'), encoding='utf-8').read()
    m = re.search(r"REPORT_MILL_BLOCKLIST\s*=\s*Object\.freeze\(\[(.*?)\]\)", cfg, re.S)
    return re.findall(r"'([^']+)'", m.group(1)) if m else []


def code_node(name, js, x, y):
    return {"parameters": {"mode": "runOnceForAllItems", "jsCode": js},
            "id": re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-'),
            "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [x, y]}


def chain(nodes):
    order = [n["name"] for n in nodes]
    return {order[i]: {"main": [[{"node": order[i + 1], "type": "main", "index": 0}]]}
            for i in range(len(order) - 1)}


def check_nodes(wf):
    """node --check every Code node. Catches inlining collisions before they reach n8n."""
    bad = 0
    for n in wf['nodes']:
        js = n.get('parameters', {}).get('jsCode')
        if not js:
            continue
        wrapped = ("(async function(){ const $env={},$input={first:()=>({json:{}})},"
                   "$execution={id:1};\n" + js + "\n})")
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write(wrapped)
            p = f.name
        r = subprocess.run(['node', '--check', p], capture_output=True, text=True)
        ok = r.returncode == 0
        print("  %-32s %s (%d bytes)" % (n['name'], 'OK' if ok else 'SYNTAX ERROR', len(js)))
        if not ok:
            bad += 1
            print(r.stderr[:400])
        os.unlink(p)
    return bad


def main():
    check_only = '--check' in sys.argv
    from workflow_defs import build_all  # noqa: E402  (kept separate for readability)
    workflows = build_all(inline_lib, agent_system_prompt, agent_schema, blocklist,
                          code_node, chain, DB_WRITE_ID)
    failures = 0
    for wf in workflows:
        print("\n%s (%d nodes)" % (wf['name'], len(wf['nodes'])))
        failures += check_nodes(wf)
        if not check_only:
            path = os.path.join(OUT, wf['name'] + '.json')
            json.dump(wf, open(path, 'w', encoding='utf-8'), indent=1)
            print("  -> %s" % os.path.relpath(path, ROOT))
    print("\nCode nodes failing syntax check: %d" % failures)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
