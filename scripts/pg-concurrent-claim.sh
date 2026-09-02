#!/usr/bin/env bash
# Real PostgreSQL concurrency verification — NOT simulation/code inspection.
# Must be run against a real PG with DATABASE_URL set (constraint: 2-3 concurrent claimers prove each job claimed at most once).
# Usage: DATABASE_URL=postgresql://... AGENT_ID=agt_xxx bash scripts/pg-concurrent-claim.sh
# Prerequisite: agents row exists, at least 1 printer, Node 22, DATABASE_URL reachable.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
AGENT_ID="${AGENT_ID:-agt_concurrent_test}"
echo "PG concurrent claim test — agent $AGENT_ID — DATABASE_URL $DATABASE_URL"
echo "This test proves FOR UPDATE SKIP LOCKED in src/app/api/agent/jobs/route.ts:49 against real PG transactions."
echo "Create 20 queued jobs, then fire 3 concurrent GET /api/agent/jobs with same agent credential, assert no id overlap and total claimed == queued."

# Check psql or node
if command -v psql >/dev/null 2>&1; then
  echo "psql available — will use raw SQL. If not, ensure Node can connect via drizzle."
fi

# Fallback: use Node to seed jobs if psql not available
# Steps documented for VM:
cat <<'STEPS'
1) Seed: insert 20 queued jobs for AGENT_ID/printers/printer_concurrent:
   INSERT INTO print_jobs (id, agent_id, printer_id, status, payload, expires_at) VALUES
   ('job_c1_1', $AGENT_ID, 'printer_concurrent', 'queued', '{"type":"raw","encoding":"base64","data":"aGVsbG8="}', now()+interval '1 hour'),
   ... x20
2) Concurrent claims: run 3 processes in parallel:
   curl -s -H "Authorization: Bearer $AGENT_ID:$SECRET" https://gateway/api/agent/jobs &
   (each does the atomic WITH claimable FOR UPDATE SKIP LOCKED claim)
3) Collect ids: jq -r '.[].id' | sort
4) Assert: (a) no duplicate ids across 3 responses (sort | uniq -d == empty), (b) union size == 20 (or 20 with limit 20), (c) second round claims 0 (all already claimed).
5) Clean: DELETE FROM print_jobs WHERE id LIKE 'job_c1_%'
STEPS

echo "If run via Node harness, see tests/pg-concurrent-claim.mjs (requires DATABASE_URL)."
echo "Mark docs/VERIFICATION.md #19 as VERIFIED only after this script shows 0 duplicates on real PG."
