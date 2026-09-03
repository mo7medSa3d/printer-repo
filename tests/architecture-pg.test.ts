import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, pool, closePool } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("real PostgreSQL architecture gate", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closePool(); });

  it("enforces canonical printer ownership columns and lifecycle data", async () => {
    const cols = await pool().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='printers'
       AND column_name IN ('agent_id','branch_id','printer_type','device_class','connection_type','protocol','lifecycle','type','enabled')
       ORDER BY column_name`
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(["agent_id","printer_type","device_class","connection_type","protocol","lifecycle"]));
    expect(names).not.toContain("branch_id");
    expect(names).not.toContain("type");
    expect(names).not.toContain("enabled");
  });

  it("preserves jobs when agent/printer lifecycle changes", async () => {
    await pool().query(`INSERT INTO branches (id,name) VALUES ('br_pg','PG') ON CONFLICT (id) DO NOTHING`);
    await pool().query(`INSERT INTO agents (id,branch_id,name,lifecycle) VALUES ('agt_pg','br_pg','Agent','active') ON CONFLICT (id) DO NOTHING`);
    const cols = await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='printers'`);
    const has = new Set((cols.rows as { column_name: string }[]).map((r) => r.column_name));
    if (has.has("type") || has.has("enabled") || has.has("branch_id")) {
      const hasBranch = has.has("branch_id"), hasType = has.has("type"), hasEnabled = has.has("enabled");
      if (hasBranch && hasType && hasEnabled) {
        await pool().query(`INSERT INTO printers (id,agent_id,branch_id,name,type,printer_type,device_class,connection_type,protocol,status,lifecycle,enabled,config,capabilities) VALUES ('prn_pg','agt_pg','br_pg','Printer','spooler','physical','laser','spooler','spooler','online','active',true,'{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      } else if (hasBranch && hasType) {
        await pool().query(`INSERT INTO printers (id,agent_id,branch_id,name,type,printer_type,device_class,connection_type,protocol,status,lifecycle,config,capabilities) VALUES ('prn_pg','agt_pg','br_pg','Printer','spooler','physical','laser','spooler','spooler','online','active','{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      } else if (hasBranch && hasEnabled) {
        await pool().query(`INSERT INTO printers (id,agent_id,branch_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle,enabled,config,capabilities) VALUES ('prn_pg','agt_pg','br_pg','Printer','physical','laser','spooler','spooler','online','active',true,'{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      } else if (hasType && hasEnabled) {
        await pool().query(`INSERT INTO printers (id,agent_id,name,type,printer_type,device_class,connection_type,protocol,status,lifecycle,enabled,config,capabilities) VALUES ('prn_pg','agt_pg','Printer','spooler','physical','laser','spooler','spooler','online','active',true,'{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      } else if (hasBranch) {
        await pool().query(`INSERT INTO printers (id,agent_id,branch_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle,config,capabilities) VALUES ('prn_pg','agt_pg','br_pg','Printer','physical','laser','spooler','spooler','online','active','{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      } else if (hasType) {
        await pool().query(`INSERT INTO printers (id,agent_id,name,type,printer_type,device_class,connection_type,protocol,status,lifecycle,config,capabilities) VALUES ('prn_pg','agt_pg','Printer','spooler','physical','laser','spooler','spooler','online','active','{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      } else if (hasEnabled) {
        await pool().query(`INSERT INTO printers (id,agent_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle,enabled,config,capabilities) VALUES ('prn_pg','agt_pg','Printer','physical','laser','spooler','spooler','online','active',true,'{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      }
    } else {
      await pool().query(`INSERT INTO printers (id,agent_id,name,printer_type,device_class,connection_type,protocol,status,lifecycle,config,capabilities) VALUES ('prn_pg','agt_pg','Printer','physical','laser','spooler','spooler','online','active','{}'::jsonb,'{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    }
    await pool().query(`INSERT INTO destinations (id,branch_id,name,type) VALUES ('dst_pg','br_pg','POS','pos')`);
    await pool().query(`INSERT INTO print_jobs (id,branch_id,destination_id,agent_id,printer_id,status,payload,expires_at) VALUES ('job_pg','br_pg','dst_pg','agt_pg','prn_pg','queued','{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb,now()+interval '1 hour')`);
    await pool().query(`UPDATE agents SET lifecycle='retired' WHERE id='agt_pg'`);
    await pool().query(`UPDATE printers SET lifecycle='disabled' WHERE id='prn_pg'`);
    const job = await pool().query(`SELECT id,agent_id,printer_id,branch_id FROM print_jobs WHERE id='job_pg'`);
    expect(job.rowCount).toBe(1);
    expect(job.rows[0]).toMatchObject({ id:'job_pg', agent_id:'agt_pg', printer_id:'prn_pg', branch_id:'br_pg' });
  });

  it("rejects duplicate global Agent and Printer IDs", async () => {
    await pool().query(`INSERT INTO branches (id,name) VALUES ('br_unique','Unique')`);
    await pool().query(`INSERT INTO agents (id,branch_id,name) VALUES ('agt_unique','br_unique','Agent')`);
    await expect(pool().query(`INSERT INTO agents (id,branch_id,name) VALUES ('agt_unique','br_unique','Duplicate')`)).rejects.toThrow();
    const hasBranch2 = await pool().query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='branch_id' LIMIT 1`);
    const legacy2 = (hasBranch2.rows?.length ?? 0) > 0 || (hasBranch2.rowCount ?? 0) > 0;
    if (legacy2) {
      await pool().query(`INSERT INTO printers (id,agent_id,branch_id,name,printer_type,device_class,connection_type,protocol) VALUES ('prn_unique','agt_unique','br_unique','Printer','physical','other','spooler','spooler')`);
      await expect(pool().query(`INSERT INTO printers (id,agent_id,branch_id,name,printer_type,device_class,connection_type,protocol) VALUES ('prn_unique','agt_unique','br_unique','Duplicate','physical','other','spooler','spooler')`)).rejects.toThrow();
    } else {
      await pool().query(`INSERT INTO printers (id,agent_id,name,printer_type,device_class,connection_type,protocol) VALUES ('prn_unique','agt_unique','Printer','physical','other','spooler','spooler')`);
      await expect(pool().query(`INSERT INTO printers (id,agent_id,name,printer_type,device_class,connection_type,protocol) VALUES ('prn_unique','agt_unique','Duplicate','physical','other','spooler','spooler')`)).rejects.toThrow();
    }
  });
});
