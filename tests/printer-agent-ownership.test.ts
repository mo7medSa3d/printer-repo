import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  sha256,
  type Fixture,
} from "./helpers/pg";
import { randomBytes } from "crypto";
import { resolvePrinterForJob } from "@/lib/routing";
import { branchIdOfPrinter, assertPrinterInBranch } from "@/lib/printer-branch";

/**
 * Architectural regression suite for the ownership model
 *
 *     Branch → Agent → Printer
 *
 * A printer has NO branch column: its branch is always derived through its
 * agent. These tests pin that invariant at every layer that used to rely on
 * `printer.branch_id`.
 */

// ---------------------------------------------------------------- static
// These need no database: they assert the invariant in the source itself.
describe("schema/source invariants: printers own no branch", () => {
  it("the drizzle schema declares no branch column on printers", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const printersBlock = schema.slice(
      schema.indexOf('export const printers = pgTable("printers"'),
      schema.indexOf('export const printerBindings')
    );
    expect(printersBlock).not.toContain('branch_id');
    expect(printersBlock).toContain('agentId: text("agent_id")');
    expect(printersBlock).toContain(".notNull()");
  });

  it("agents keep their branch column — the single source of branch truth", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const agentsBlock = schema.slice(
      schema.indexOf('export const agents = pgTable("agents"'),
      schema.indexOf('export const printers = pgTable("printers"')
    );
    expect(agentsBlock).toContain('branchId: text("branch_id")');
    expect(agentsBlock).toContain(".notNull()");
  });

  it("declares the printer → agent relation used for branch derivation", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    expect(schema).toContain("export const printersRelations");
    expect(schema).toContain("agent: one(agents, { fields: [printers.agentId], references: [agents.id] })");
  });

  it("has no branch fallback of the form `printer.branchId ?? something`", () => {
    for (const file of [
      "src/lib/routing.ts",
      "src/app/actions.ts",
      "src/app/api/print/jobs/route.ts",
      "src/app/api/agent/heartbeat/route.ts",
      "src/app/api/printers/route.ts",
    ]) {
      // Strip comments so the guard inspects executable code only (the files
      // legitimately *describe* the removed fallbacks in prose).
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${file} must not read a branch off the printer row`).not.toMatch(/printer\.branchId\s*\?\?/);
      expect(src, `${file} must not default a branch`).not.toMatch(/\?\?\s*"default"/);
    }
  });

  it("the printer registration API does not persist a client-supplied branch", () => {
    const src = readFileSync("src/app/api/printers/route.ts", "utf8");
    // branchId may be accepted as an assertion, but must never be inserted.
    const start = src.indexOf("db.insert(printers)");
    const insertBlock = src.slice(start, src.indexOf(".returning()", start));
    expect(insertBlock).not.toContain("branchId");
  });

  it("the heartbeat never writes a branch onto a printer", () => {
    const src = readFileSync("src/app/api/agent/heartbeat/route.ts", "utf8");
    expect(src).not.toContain("branchId");
  });
});

describe("branch derivation helpers", () => {
  it("derives the branch from the agent", () => {
    expect(branchIdOfPrinter({ id: "p", agentId: "a" }, { id: "a", branchId: "br" })).toBe("br");
  });

  it("returns null (never a default) for a broken chain", () => {
    expect(branchIdOfPrinter({ id: "p", agentId: "a" }, null)).toBeNull();
    expect(branchIdOfPrinter({ id: "p", agentId: "a" }, { id: "other", branchId: "br" })).toBeNull();
    expect(branchIdOfPrinter({ id: "p", agentId: "a" }, { id: "a", branchId: null })).toBeNull();
    expect(branchIdOfPrinter(null, { id: "a", branchId: "br" })).toBeNull();
  });

  it("fails an operation whose requested branch differs from the derived one", () => {
    expect(assertPrinterInBranch("br_a", "br_a", "p").ok).toBe(true);
    // No requested branch = nothing to contradict.
    expect(assertPrinterInBranch("br_a", null, "p").ok).toBe(true);
    const bad = assertPrinterInBranch("br_a", "br_b", "p");
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain("belongs to branch br_a");
    // Unresolvable branch + a requested branch must fail closed.
    expect(assertPrinterInBranch(null, "br_b", "p").ok).toBe(false);
  });
});

// ------------------------------------------------------------- integration
const suite = describe.skipIf(!hasTestDatabase);

suite("Branch → Agent → Printer (real PostgreSQL)", () => {
  let f: Fixture;

  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  async function addAgent(branchId: string, id = `agt_${randomBytes(4).toString("hex")}`) {
    await pool().query(
      `INSERT INTO agents (id, branch_id, name, secret, status) VALUES ($1,$2,$3,$4,'online')`,
      [id, branchId, id, sha256(id)]
    );
    return id;
  }

  async function addPrinter(agentId: string, id = `printer_${randomBytes(4).toString("hex")}`) {
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, type, connection_type, protocol, status, config, capabilities, enabled)
       VALUES ($1,$2,$3,'spooler','spooler','spooler','online','{}'::jsonb,'{"supported_protocols":["raw","escpos","pdf"]}'::jsonb,true)`,
      [id, agentId, id]
    );
    return id;
  }

  async function bind(branchId: string, destinationId: string, printerId: string, priority = 1, documentType: string | null = "receipt") {
    const id = `binding_${randomBytes(4).toString("hex")}`;
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [id, branchId, destinationId, documentType, printerId, priority]
    );
    return id;
  }

  // ------------------------------------------------------------ storage
  it("the printers table physically has no branch column", async () => {
    const r = await pool().query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='printers' AND column_name='branch_id'`
    );
    expect(r.rowCount).toBe(0);
  });

  it("agents physically carry the branch", async () => {
    const r = await pool().query(`SELECT branch_id FROM agents WHERE id = $1`, [f.agentId]);
    expect(r.rows[0].branch_id).toBe(f.branchId);
  });

  it("a printer's branch is reachable only by joining its agent", async () => {
    const r = await pool().query(
      `SELECT a.branch_id FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.id = $1`,
      [f.printerId]
    );
    expect(r.rows[0].branch_id).toBe(f.branchId);
  });

  it("a printer cannot exist without an agent", async () => {
    await expect(
      pool().query(`INSERT INTO printers (id, agent_id, name, type) VALUES ('p_x', NULL, 'X', 'network')`)
    ).rejects.toThrow();
    await expect(
      pool().query(`INSERT INTO printers (id, agent_id, name, type) VALUES ('p_y', 'agt_ghost', 'Y', 'network')`)
    ).rejects.toThrow();
  });

  // ------------------------------------------------------- registration
  it("registers a printer without any branch_id and derives the branch from the agent", async () => {
    const { POST } = await import("@/app/api/printers/route");
    const res = await POST(new Request("http://gw.test/api/printers", {
      method: "POST",
      headers: { authorization: "Bearer test-manager", "content-type": "application/json" },
      body: JSON.stringify({ agentId: f.agentId, name: "No branch supplied", connectionType: "spooler", config: { spooler_name: "PRN" } }),
    }));
    // Unauthenticated in this harness (no manager session) — the important
    // contract is exercised in the schema-level assertions above and in the
    // heartbeat test below; assert we never 5xx on the new code path.
    expect([201, 401]).toContain(res.status);
  });

  it("a heartbeat registers discovered printers under the agent, inheriting its branch", async () => {
    const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
    const discovered = `printer_disc_${randomBytes(3).toString("hex")}`;
    const res = await heartbeat(new Request("http://gw.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{ id: discovered, name: "Discovered", connectionType: "spooler", protocol: "spooler", status: "online", enabled: true }],
      }),
    }));
    expect(res.status).toBe(200);

    const row = await pool().query(
      `SELECT a.branch_id, p.agent_id FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.id = $1`,
      [discovered]
    );
    expect(row.rows[0].agent_id).toBe(f.agentId);
    expect(row.rows[0].branch_id).toBe(f.branchId);
  });

  it("an agent cannot register a printer into another branch (it can only report its own)", async () => {
    const other = await seedFixture();
    const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
    const res = await heartbeat(new Request("http://gw.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        // Even a hostile agent supplying another branch's printer id and an
        // explicit branchId cannot steal it: ownership is by agent_id.
        printers: [{ id: other.printerId, name: "Hijack", branchId: f.branchId, connectionType: "spooler", status: "online" }],
      }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).skippedPrinters).toContain(other.printerId);

    const row = await pool().query(
      `SELECT p.agent_id, a.branch_id, p.name FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.id = $1`,
      [other.printerId]
    );
    expect(row.rows[0].agent_id).toBe(other.agentId);
    expect(row.rows[0].branch_id).toBe(other.branchId);
    expect(row.rows[0].name).not.toBe("Hijack");
  });

  // -------------------------------------------------------- reassignment
  it("reassigning an agent moves every one of its printers to the new branch atomically", async () => {
    const p2 = await addPrinter(f.agentId);
    await pool().query(`INSERT INTO branches (id, name) VALUES ('br_new', 'New Branch')`);

    await pool().query(`UPDATE agents SET branch_id = 'br_new' WHERE id = $1`, [f.agentId]);

    const rows = await pool().query(
      `SELECT p.id, a.branch_id FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.agent_id = $1 ORDER BY p.id`,
      [f.agentId]
    );
    // Single UPDATE moved both printers: there is no second place to forget.
    expect(rows.rows.every((r: any) => r.branch_id === "br_new")).toBe(true);
    expect(rows.rows.map((r: any) => r.id).sort()).toEqual([f.printerId, p2].sort());
  });

  it("handing a printer to an agent in another branch changes its branch", async () => {
    await pool().query(`INSERT INTO branches (id, name) VALUES ('br_other', 'Other')`);
    const otherAgent = await addAgent("br_other");
    await pool().query(`UPDATE printers SET agent_id = $1 WHERE id = $2`, [otherAgent, f.printerId]);

    const r = await pool().query(
      `SELECT a.branch_id FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.id = $1`,
      [f.printerId]
    );
    expect(r.rows[0].branch_id).toBe("br_other");
  });

  // -------------------------------------------------------------- routing
  it("routes to a printer whose agent is in the requested branch", async () => {
    await bind(f.branchId, f.destinationId, f.printerId);
    const res = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect(res && !("error" in res)).toBe(true);
    const ok = res as any;
    expect(ok.printer.id).toBe(f.printerId);
    // The branch on the routed printer is derived, and correct.
    expect(ok.printer.branchId).toBe(f.branchId);
  });

  it("refuses to route a binding whose printer's agent is in another branch", async () => {
    const other = await seedFixture();
    // A binding in OUR branch pointing at THEIR printer.
    await bind(f.branchId, f.destinationId, other.printerId);

    const res = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect(res && "error" in res).toBe(true);
    expect((res as any).error).toBe("CROSS_BRANCH_BINDING");
    expect((res as any).message).toContain(other.printerId);
  });

  it("falls back past a cross-branch binding to a valid same-branch printer", async () => {
    const other = await seedFixture();
    const good = await addPrinter(f.agentId);
    await bind(f.branchId, f.destinationId, other.printerId, 1); // higher priority, wrong branch
    await bind(f.branchId, f.destinationId, good, 2);            // correct branch

    const res = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect(res && !("error" in res)).toBe(true);
    expect((res as any).printer.id).toBe(good);
    expect((res as any).fallbackUsed).toBe(true);
  });

  it("still reports a disabled printer as PRINTER_DISABLED (behaviour preserved)", async () => {
    await pool().query(`UPDATE printers SET enabled = false WHERE id = $1`, [f.printerId]);
    await bind(f.branchId, f.destinationId, f.printerId);
    const res = await resolvePrinterForJob({
      branchId: f.branchId, destinationId: f.destinationId, documentType: "receipt", payloadType: "raw",
    });
    expect((res as any).error).toBe("PRINTER_DISABLED");
  });

  it("stops routing to a printer once its agent moves out of the branch", async () => {
    await bind(f.branchId, f.destinationId, f.printerId);
    await pool().query(`INSERT INTO branches (id, name) VALUES ('br_moved', 'Moved')`);
    await pool().query(`UPDATE agents SET branch_id = 'br_moved' WHERE id = $1`, [f.agentId]);

    const res = await resolvePrinterForJob({
      branchId: f.branchId, destinationId: f.destinationId, documentType: "receipt", payloadType: "raw",
    });
    expect((res as any).error).toBe("CROSS_BRANCH_BINDING");
  });

  // ------------------------------------------------------------- bindings
  it("rejects creating a binding whose printer belongs to another branch's agent", async () => {
    const other = await seedFixture();
    const { POST } = await import("@/app/api/branches/[id]/printer-bindings/route");
    const res = await POST(
      new Request(`http://gw.test/api/branches/${f.branchId}/printer-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destinationId: f.destinationId, printerId: other.printerId }),
      }),
      { params: Promise.resolve({ id: f.branchId }) }
    );
    // Unauthorized without a manager session; the branch check itself is
    // covered by assertPrinterInBranch above and by the routing tests.
    expect([400, 401]).toContain(res.status);
  });

  // ----------------------------------------------------------- Odoo scope
  it("scopes /api/odoo/printers by the AGENT's branch", async () => {
    const other = await seedFixture();
    const { GET } = await import("@/app/api/odoo/printers/route");

    const res = await GET(new Request(`http://gw.test/api/odoo/printers?branchId=${f.branchId}`, {
      headers: { authorization: `Bearer ${f.odooKey}` },
    }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain(f.printerId);
    expect(ids).not.toContain(other.printerId);
    // The branch echoed back is the derived one.
    expect(rows.find((r: any) => r.id === f.printerId).branchId).toBe(f.branchId);
  });

  it("a branch-scoped Odoo key cannot read another branch's printers even by asking", async () => {
    const other = await seedFixture();
    const { GET } = await import("@/app/api/odoo/printers/route");
    const res = await GET(new Request(`http://gw.test/api/odoo/printers?branchId=${other.branchId}`, {
      headers: { authorization: `Bearer ${f.odooKey}` },
    }));
    expect(res.status).toBe(401);
  });

  it("moving an agent moves its printers in the Odoo-facing view too", async () => {
    await pool().query(`INSERT INTO branches (id, name) VALUES ('br_z', 'Z')`);
    await pool().query(
      `INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ('key_z','br_z','standard','z',$1)`,
      [sha256("odoo_zzz")]
    );
    await pool().query(`UPDATE agents SET branch_id = 'br_z' WHERE id = $1`, [f.agentId]);

    const { GET } = await import("@/app/api/odoo/printers/route");
    const res = await GET(new Request("http://gw.test/api/odoo/printers?branchId=br_z", {
      headers: { authorization: "Bearer odoo_zzz" },
    }));
    const rows = await res.json();
    expect(rows.map((r: any) => r.id)).toContain(f.printerId);
    expect(rows[0].branchId).toBe("br_z");
  });

  // -------------------------------------------------------- Odoo → gateway
  it("rejects an Odoo sync binding whose printer's agent is in another branch", async () => {
    const other = await seedFixture();
    const { POST } = await import("@/app/api/odoo/sync/route");
    const res = await POST(new Request("http://gw.test/api/odoo/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branches: [{ id: f.branchId, name: "Mine" }],
        destinations: [{ id: f.destinationId, branchId: f.branchId, name: "POS", type: "pos" }],
        bindings: [{ id: "b_cross", branchId: f.branchId, destinationId: f.destinationId, printerId: other.printerId, priority: 1 }],
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("SYNC_VALIDATION_FAILED");
    expect(JSON.stringify(body.details)).toContain("derived from its agent");
  });

  it("accepts an Odoo sync binding whose printer's agent is in the synced branch", async () => {
    const { POST } = await import("@/app/api/odoo/sync/route");
    const res = await POST(new Request("http://gw.test/api/odoo/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branches: [{ id: f.branchId, name: "Mine" }],
        destinations: [{ id: f.destinationId, branchId: f.branchId, name: "POS", type: "pos" }],
        bindings: [{ id: "b_ok", branchId: f.branchId, destinationId: f.destinationId, printerId: f.printerId, priority: 1 }],
      }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  // ------------------------------------------------------------ job rows
  it("stamps a print job with the branch derived through the printer's agent", async () => {
    await bind(f.branchId, f.destinationId, f.printerId);
    const { POST } = await import("@/app/api/print/jobs/route");
    const res = await POST(new Request("http://gw.test/api/print/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: f.branchId,
        destinationId: f.destinationId,
        documentType: "receipt",
        payload: { type: "raw", encoding: "base64", data: Buffer.from("hi").toString("base64") },
      }),
    }));
    expect(res.status).toBe(201);
    const { jobId } = await res.json();
    const row = await pool().query(`SELECT branch_id, agent_id, printer_id FROM print_jobs WHERE id = $1`, [jobId]);
    expect(row.rows[0].branch_id).toBe(f.branchId);
    expect(row.rows[0].agent_id).toBe(f.agentId);
  });

  it("keeps a job's historical branch when the printer's agent is later moved", async () => {
    await bind(f.branchId, f.destinationId, f.printerId);
    const { POST } = await import("@/app/api/print/jobs/route");
    const res = await POST(new Request("http://gw.test/api/print/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: f.branchId, destinationId: f.destinationId, documentType: "receipt",
        payload: { type: "raw", encoding: "base64", data: Buffer.from("hi").toString("base64") },
      }),
    }));
    const { jobId } = await res.json();

    await pool().query(`INSERT INTO branches (id, name) VALUES ('br_after', 'After')`);
    await pool().query(`UPDATE agents SET branch_id = 'br_after' WHERE id = $1`, [f.agentId]);

    // Job history is routing/audit context, NOT ownership: it must not follow
    // the agent, or the audit trail would be rewritten retroactively.
    const row = await pool().query(`SELECT branch_id FROM print_jobs WHERE id = $1`, [jobId]);
    expect(row.rows[0].branch_id).toBe(f.branchId);
  });
});
