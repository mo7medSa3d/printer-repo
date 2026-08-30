// Real PG concurrency verification harness — requires DATABASE_URL and seeded jobs.
// Run: DATABASE_URL=... node tests/pg-concurrent-claim.mjs
// Proves each job is claimed by at most one concurrent Agent request (FOR UPDATE SKIP LOCKED).
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
const pool = new Pool({ connectionString: url });
const AGENT_ID = process.env.AGENT_ID ?? "agt_concurrent_test";
const PRINTER_ID = process.env.PRINTER_ID ?? "printer_concurrent";

async function ensureFixture() {
  // ensure agent and printer exist for FK
  await pool.query(`INSERT INTO agents (id, name, status) VALUES ($1, 'concurrent-test', 'online') ON CONFLICT (id) DO NOTHING`, [AGENT_ID]);
  await pool.query(`INSERT INTO printers (id, agent_id, name, type, status, config) VALUES ($1, $2, 'concurrent', 'network', 'online', '{"ip":"127.0.0.1","port":9100,"protocol":"raw"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [PRINTER_ID, AGENT_ID]);
  await pool.query(`DELETE FROM print_jobs WHERE agent_id=$1 AND id LIKE 'job_cc_%'`, [AGENT_ID]);
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO print_jobs (id, agent_id, printer_id, status, payload, expires_at) VALUES ($1,$2,$3,'queued','{"type":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now()+interval '1 hour')`,
      [`job_cc_${String(i).padStart(2,"0")}`, AGENT_ID, PRINTER_ID]
    );
  }
  console.log("Seeded 20 queued jobs");
}

async function claim() {
  // This is the exact Gateway claim transaction from src/app/api/agent/jobs/route.ts:49
  const res = await pool.query(`
    WITH claimable AS (
      SELECT id FROM print_jobs
      WHERE agent_id = $1
        AND expires_at > now()
        AND (status = 'queued' OR (status IN ('claimed','printing') AND updated_at < now() - interval '90 seconds' AND retries < 5))
      ORDER BY created_at ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='claimed', claimed_at=now(), updated_at=now(),
      retries = CASE WHEN print_jobs.status IN ('claimed','printing') THEN retries+1 ELSE retries END
    FROM claimable WHERE print_jobs.id=claimable.id
    RETURNING print_jobs.id
  `, [AGENT_ID]);
  return res.rows.map(r => r.id);
}

async function main() {
  await ensureFixture();
  // fire 3 concurrent claims
  const [a,b,c] = await Promise.all([claim(), claim(), claim()]);
  const all = [...a, ...b, ...c];
  const uniq = new Set(all);
  console.log(`Claim results: A=${a.length} B=${b.length} C=${c.length} total=${all.length} uniq=${uniq.size}`);
  if (all.length !== uniq.size) {
    const dups = all.filter((x,i) => all.indexOf(x) !== i);
    console.error("FAILED: duplicate ids across concurrent claims:", dups);
    process.exit(1);
  }
  if (uniq.size !== 20) {
    console.error(`FAILED: expected 20 uniq claimed, got ${uniq.size}. All:`, all);
    process.exit(1);
  }
  // second round should claim 0
  const second = await claim();
  if (second.length !== 0) {
    console.error("FAILED: second round should claim 0, got", second);
    process.exit(1);
  }
  console.log("VERIFIED: each job claimed by at most one concurrent requester (FOR UPDATE SKIP LOCKED works).");
  await pool.query(`DELETE FROM print_jobs WHERE agent_id=$1 AND id LIKE 'job_cc_%'`, [AGENT_ID]);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
