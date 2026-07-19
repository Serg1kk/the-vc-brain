#!/usr/bin/env bash
# Feature 08 end-to-end smoke test.
#
# Checks the things a green HTTP 200 does NOT prove:
#   - which nodes actually executed (this n8n build has silently skipped
#     branches while still returning 200)
#   - that every claim carries evidence with raw_signal_id (an evidence-less
#     claim inverts REQ-003 across every scoring criterion)
#   - that nothing was written that GDPR erasure cannot reach
#   - that gap-question SUPPRESSION works, not just generation
#
# Usage:  ./lib/f08/smoke-e2e.sh
# Requires: infra/supabase/.env, infra/n8n/.env, the stack running.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

set -a; . infra/supabase/.env 2>/dev/null; . infra/n8n/.env 2>/dev/null; set +a
PSQL="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@localhost:54322/postgres"
N8N="http://localhost:5678"
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

submit() { # $1 = pdf path, $2 = company name, $3 = submission uuid
  local b64; b64=$(base64 < "$1" | tr -d '\n')
  curl -s -m 120 -X POST "$N8N/webhook/f08-intake-submit" \
    -H 'Content-Type: application/json' \
    -d "{\"intake_submission_id\":\"$3\",\"company_name\":\"$2\",
         \"contact_email\":\"founder+$3@example.test\",
         \"deck\":{\"filename\":\"deck.pdf\",\"mime\":\"application/pdf\",\"base64\":\"$b64\"},
         \"artifact_links\":[{\"url\":\"https://github.com/northwind/grasp\",\"kind\":\"github_repo\"}]}"
}

jqf() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

echo "=== 1. RICH DECK — states L2, L3 and X5 explicitly ==="
ID1=$(uuidgen | tr 'A-Z' 'a-z')
R1=$(submit db/fixtures/f08/northwind-deck.pdf "Northwind Robotics" "$ID1")
echo "$R1" | head -c 400; echo
APP1=$(echo "$R1" | jqf "['application_id']")
GQ1=$(echo "$R1" | jqf "['gap_questions'].__len__()")
[ -n "$APP1" ] && ok "application created ($APP1)" || bad "no application_id in response"
[ "$GQ1" = "0" ] && ok "0 gap questions — suppression works on a deck that answers all three" \
                 || bad "expected 0 gap questions, got '$GQ1' (suppression is the harder half)"

echo "=== 2. SPARSE DECK — answers none of the three ==="
ID2=$(uuidgen | tr 'A-Z' 'a-z')
R2=$(submit db/fixtures/f08/sparse-deck.pdf "Loomweave" "$ID2")
GQ2=$(echo "$R2" | jqf "['gap_questions'].__len__()")
[ "$GQ2" = "3" ] && ok "3 gap questions generated" || bad "expected 3 gap questions, got '$GQ2'"
echo "$R2" | python3 -c "
import sys,json
try:
    for q in json.load(sys.stdin).get('gap_questions',[]):
        print('   ',q.get('criterion_id'),'|',q.get('question'))
except Exception: pass"
echo "$R2" | grep -qiE '\b(interview|assessment|evaluation|screening)\b' \
  && bad "FORBIDDEN WORD in founder-facing question text" \
  || ok "no interview/assessment framing in the questions"

echo "=== 3. IMAGE-ONLY DECK — honest declaration, not a silent empty ==="
ID3=$(uuidgen | tr 'A-Z' 'a-z')
R3=$(submit db/fixtures/f08/image-only-deck.pdf "Blindspot Labs" "$ID3")
echo "$R3" | grep -q "image_only_deck" && ok "warning: image_only_deck" \
  || bad "no image_only_deck warning — this is the 30%-Data-criterion behaviour"

echo "=== 4. IDEMPOTENCY — the same submission id must not create a second row ==="
R1B=$(submit db/fixtures/f08/northwind-deck.pdf "Northwind Robotics" "$ID1")
APP1B=$(echo "$R1B" | jqf "['application_id']")
[ "$APP1" = "$APP1B" ] && ok "retry replayed the same application" \
  || bad "retry returned '$APP1B' instead of '$APP1' — a timed-out founder would be stranded"

echo "=== 5. DATABASE INVARIANTS ==="
q() { psql "$PSQL" -tAc "$1" 2>/dev/null; }
N=$(q "select count(*) from claims c left join evidence e on e.claim_id=c.id
       join cards cd on cd.id=c.card_id
       where cd.application_id in ('$APP1','$APP1B') and (e.id is null or e.raw_signal_id is null)")
[ "${N:-x}" = "0" ] && ok "every claim has evidence with raw_signal_id" \
  || bad "$N claims lack evidence/raw_signal_id — inverts REQ-003 across all criteria"

N=$(q "select count(*) from claims c join cards cd on cd.id=c.card_id
       where cd.application_id='$APP1' and c.source_kind='public'")
[ "${N:-x}" = "0" ] && ok "no source_kind='public' claims (wildcard trap avoided)" \
  || bad "$N public claims — one licenses not_met on every criterion"

N=$(q "select count(*) from raw_signals where founder_id is null and company_id is null")
[ "${N:-x}" = "0" ] && ok "no raw_signals unreachable by erasure" \
  || bad "$N raw_signals with both FKs NULL — survive a deletion request permanently"

N=$(q "select count(*) from events where entity_type <> 'founder' and created_at > now() - interval '10 minutes'")
[ "${N:-x}" = "0" ] && ok "events use entity_type='founder'" \
  || bad "$N recent events with another entity_type — unreachable by purge_founder()"

echo "=== 6. WHAT ACTUALLY EXECUTED (a 200 is not proof) ==="
EX=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N/api/v1/executions?limit=1&includeData=true")
echo "$EX" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)['data'][0]
    nodes=list((d.get('data',{}).get('resultData',{}).get('runData',{}) or {}).keys())
    print('   status:',d.get('status'),'| nodes executed:',len(nodes))
    for n in nodes: print('     -',n)
except Exception as e: print('   could not read execution data:',e)"

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
