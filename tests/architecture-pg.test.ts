import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, pool, closePool } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("real PostgreSQL runtime architecture gate", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closePool(); });

  it("removes duplicated Gateway business entities", async () => {
    const result = await pool().query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('branches','destinations','document_types','local_networks','printer_bindings')
    `);
    expect(result.rows).toEqual([]);
  });

  it("removes Gateway branch ownership columns", async () => {
    const result = await pool().query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name IN ('branch_id','local_network_id','destination_id')
        AND table_name IN ('agents','printers','print_jobs','api_keys','discovery_sessions','discovered_devices')
    `);
    expect(result.rows).toEqual([]);
  });

  it("keeps printers owned only by runtime agents", async () => {
    const cols = await pool().query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='printers'
    `);
    const names = new Set(cols.rows.map((r) => r.column_name));
    expect(names).toEqual(expect.objectContaining({}));
    expect(names.has("agent_id")).toBe(true);
    expect(names.has("branch_id")).toBe(false);
    expect(names.has("enabled")).toBe(false);
  });

  it("preserves runtime jobs when agent/printer lifecycle changes", async () => {
    await pool().query(`INSERT INTO agents (id,name,lifecycle,status) VALUES ('agt_pg','Agent','active','online')`);
    await pool().query(`INSERT INTO printers (id,agent_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle,config,capabilities)
      VALUES ('prn_pg','agt_pg','Printer','physical','laser','spooler','spooler','online','active','{}'::jsonb,'{}'::jsonb)`);
    await pool().query(`INSERT INTO print_jobs (id,destination,document_type,agent_id,printer_id,status,payload,expires_at)
      VALUES ('job_pg','POS','receipt','agt_pg','prn_pg','queued','{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb,now()+interval '1 hour')`);
    await pool().query(`UPDATE agents SET lifecycle='retired' WHERE id='agt_pg'`);
    await pool().query(`UPDATE printers SET lifecycle='disabled' WHERE id='prn_pg'`);
    const job = await pool().query(`SELECT id,agent_id,printer_id,destination FROM print_jobs WHERE id='job_pg'`);
    expect(job.rows[0]).toMatchObject({ id:'job_pg', agent_id:'agt_pg', printer_id:'prn_pg', destination:'POS' });
  });

  it("enforces globally unique idempotency keys", async () => {
    await pool().query(`INSERT INTO agents (id,name,lifecycle,status) VALUES ('agt_unique','Agent','active','online')`);
    await pool().query(`INSERT INTO printers (id,agent_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle,config,capabilities)
      VALUES ('prn_unique','agt_unique','Printer','physical','other','spooler','spooler','online','active','{}'::jsonb,'{}'::jsonb)`);
    const payload = '{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb;
    await pool().query(`INSERT INTO print_jobs (id,destination,document_type,agent_id,printer_id,status,payload,expires_at,idempotency_key)
      VALUES ('job_unique_1','POS','receipt','agt_unique','prn_unique','queued',$1,now()+interval '1 hour','same-key')`, [payload]);
    await expect(pool().query(`INSERT INTO print_jobs (id,destination,document_type,agent_id,printer_id,status,payload,expires_at,idempotency_key)
      VALUES ('job_unique_2','POS','receipt','agt_unique','prn_unique','queued',$1,now()+interval '1 hour','same-key')`, [payload])).rejects.toThrow();
  });
});
