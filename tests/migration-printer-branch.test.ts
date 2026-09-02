import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "fs";
import { Client } from "pg";
import { hasTestDatabase, TEST_DATABASE_URL } from "./helpers/pg";

/**
 * Migration behaviour: drizzle/0006_printer_branch_via_agent.sql
 *
 * The migration removes `printers.branch_id` so a printer's branch is derived
 * exclusively through its agent. Because that column may hold real, conflicting
 * production data, the migration must:
 *
 *   - apply cleanly when legacy data is already consistent;
 *   - FAIL LOUDLY (and change nothing) on inconsistent legacy data, naming the
 *     printer, its branch, its agent and the agent's branch;
 *   - never delete printers and never silently reassign them across branches;
 *   - be idempotent once applied.
 *
 * These run against a REAL PostgreSQL (DDL + DO-block exceptions cannot be
 * faked) on a throwaway database, so they never touch the shared test schema.
 */

const suite = describe.skipIf(!hasTestDatabase);

const PRE_MIGRATIONS = [
  "0000_simple_tigra",
  "0001_phase1_branch_foundation",
  "0002_add_document_types",
  "0003_add_idempotency_key",
  "0004_add_job_delivery_tracking",
  "0005_auth_rate_limits",
].map((f) => readFileSync(`drizzle/${f}.sql`, "utf8"));

const MIGRATION_0006 = readFileSync("drizzle/0006_printer_branch_via_agent.sql", "utf8");

let dbCounter = 0;
const createdDatabases: string[] = [];

function adminUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = "/postgres";
  return u.toString();
}

function dbUrl(name: string): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Spin up a throwaway database with the pre-0006 schema and the given seed. */
async function withLegacyDatabase(
  seed: (c: Client) => Promise<void>,
  run: (c: Client) => Promise<void>
): Promise<void> {
  const name = `pg_mig_test_${process.pid}_${dbCounter++}`;
  const admin = new Client(adminUrl());
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  createdDatabases.push(name);

  const c = new Client(dbUrl(name));
  await c.connect();
  try {
    for (const sql of PRE_MIGRATIONS) await c.query(sql);
    await seed(c);
    await run(c);
  } finally {
    await c.end();
    const cleanup = new Client(adminUrl());
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
    await cleanup.end();
  }
}

async function seedBranchesAndAgents(c: Client) {
  await c.query(`INSERT INTO branches (id, name) VALUES ('br_a','Branch A'), ('br_b','Branch B')`);
  await c.query(
    `INSERT INTO agents (id, branch_id, name) VALUES ('agt_a','br_a','Agent A'), ('agt_b','br_b','Agent B')`
  );
}

async function hasLegacyColumn(c: Client): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='printers' AND column_name='branch_id'`
  );
  return (r.rowCount ?? 0) > 0;
}

async function printerCount(c: Client): Promise<number> {
  const r = await c.query(`SELECT count(*)::int AS n FROM printers`);
  return r.rows[0].n;
}

async function applyAndCaptureError(c: Client): Promise<string | null> {
  try {
    await c.query(MIGRATION_0006);
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

suite("migration 0006 — printer branch derived through agent", () => {
  afterAll(async () => {
    // Belt and braces: drop anything a failed run left behind.
    const admin = new Client(adminUrl());
    await admin.connect();
    for (const name of createdDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    }
    await admin.end();
  });

  it("applies cleanly when legacy printer branches already match their agent", async () => {
    await withLegacyDatabase(
      async (c) => {
        await seedBranchesAndAgents(c);
        await c.query(
          `INSERT INTO printers (id, agent_id, branch_id, name, type)
           VALUES ('p1','agt_a','br_a','P1','network'), ('p2','agt_b','br_b','P2','network')`
        );
      },
      async (c) => {
        const err = await applyAndCaptureError(c);
        expect(err).toBeNull();
        // Redundant column gone …
        expect(await hasLegacyColumn(c)).toBe(false);
        // … and every printer preserved.
        expect(await printerCount(c)).toBe(2);
        // The branch is now reachable ONLY through the agent.
        const r = await c.query(
          `SELECT p.id, a.branch_id FROM printers p JOIN agents a ON a.id = p.agent_id ORDER BY p.id`
        );
        expect(r.rows).toEqual([
          { id: "p1", branch_id: "br_a" },
          { id: "p2", branch_id: "br_b" },
        ]);
      }
    );
  });

  it("fails loudly and changes nothing when a printer disagrees with its agent's branch", async () => {
    await withLegacyDatabase(
      async (c) => {
        await seedBranchesAndAgents(c);
        await c.query(
          `INSERT INTO printers (id, agent_id, branch_id, name, type)
           VALUES ('p_ok','agt_a','br_a','OK','network'),
                  ('p_bad','agt_a','br_b','Conflicted','network')`
        );
      },
      async (c) => {
        const err = await applyAndCaptureError(c);
        expect(err).toContain("MIGRATION 0006 ABORTED");
        expect(err).toContain("disagree with their agent");
        // The error must identify printer, its branch, the agent and the agent's branch.
        expect(err).toContain("printer=p_bad");
        expect(err).toContain("printer.branch_id=br_b");
        expect(err).toContain("agent=agt_a");
        expect(err).toContain("agent.branch_id=br_a");
        // Nothing was destroyed or reassigned: the upgrade is fully recoverable.
        expect(await hasLegacyColumn(c)).toBe(true);
        expect(await printerCount(c)).toBe(2);
        const still = await c.query(`SELECT branch_id FROM printers WHERE id='p_bad'`);
        expect(still.rows[0].branch_id).toBe("br_b");
      }
    );
  });

  it("fails loudly when a printer has no valid agent (branch would be underivable)", async () => {
    await withLegacyDatabase(
      async (c) => {
        await seedBranchesAndAgents(c);
        await c.query(`ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_agent_id_agents_id_fk`);
        await c.query(
          `INSERT INTO printers (id, agent_id, branch_id, name, type)
           VALUES ('p_orphan','agt_ghost','br_a','Orphan','network')`
        );
      },
      async (c) => {
        const err = await applyAndCaptureError(c);
        expect(err).toContain("MIGRATION 0006 ABORTED");
        expect(err).toContain("no valid agent");
        expect(err).toContain("printer=p_orphan");
        expect(err).toContain("agent_id=agt_ghost");
        expect(await hasLegacyColumn(c)).toBe(true);
        expect(await printerCount(c)).toBe(1);
      }
    );
  });

  it("fails loudly when an agent has no branch (agent is the sole branch owner)", async () => {
    await withLegacyDatabase(
      async (c) => {
        await seedBranchesAndAgents(c);
        await c.query(`ALTER TABLE agents ALTER COLUMN branch_id DROP NOT NULL`);
        await c.query(`ALTER TABLE printers ALTER COLUMN branch_id DROP NOT NULL`);
        await c.query(`INSERT INTO agents (id, branch_id, name) VALUES ('agt_nb', NULL, 'No branch')`);
        await c.query(
          `INSERT INTO printers (id, agent_id, branch_id, name, type)
           VALUES ('p3','agt_nb',NULL,'P3','network')`
        );
      },
      async (c) => {
        const err = await applyAndCaptureError(c);
        expect(err).toContain("MIGRATION 0006 ABORTED");
        expect(err).toContain("have no valid branch");
        expect(err).toContain("agent=agt_nb");
        expect(await hasLegacyColumn(c)).toBe(true);
      }
    );
  });

  it("is idempotent: re-running after a successful apply is a no-op", async () => {
    await withLegacyDatabase(
      async (c) => {
        await seedBranchesAndAgents(c);
        await c.query(
          `INSERT INTO printers (id, agent_id, branch_id, name, type) VALUES ('p1','agt_a','br_a','P1','network')`
        );
      },
      async (c) => {
        expect(await applyAndCaptureError(c)).toBeNull();
        expect(await applyAndCaptureError(c)).toBeNull();
        expect(await hasLegacyColumn(c)).toBe(false);
        expect(await printerCount(c)).toBe(1);
      }
    );
  });

  it("keeps agent_id NOT NULL and foreign-keyed after the migration", async () => {
    await withLegacyDatabase(
      async (c) => {
        await seedBranchesAndAgents(c);
        await c.query(
          `INSERT INTO printers (id, agent_id, branch_id, name, type) VALUES ('p1','agt_a','br_a','P1','network')`
        );
      },
      async (c) => {
        expect(await applyAndCaptureError(c)).toBeNull();

        const nn = await c.query(
          `SELECT is_nullable FROM information_schema.columns WHERE table_name='printers' AND column_name='agent_id'`
        );
        expect(nn.rows[0].is_nullable).toBe("NO");

        // A printer can never point at a non-existent agent, because that would
        // leave it without a derivable branch.
        await expect(
          c.query(`INSERT INTO printers (id, agent_id, name, type) VALUES ('p_x','agt_ghost','X','network')`)
        ).rejects.toThrow();

        // And it can never be created branch-less-by-omission: there is simply
        // no branch column to omit.
        await expect(
          c.query(`INSERT INTO printers (id, agent_id, branch_id, name, type) VALUES ('p_y','agt_a','br_a','Y','network')`)
        ).rejects.toThrow(/branch_id/);
      }
    );
  });
});
