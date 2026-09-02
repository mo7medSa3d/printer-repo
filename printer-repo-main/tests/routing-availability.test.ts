import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { resolvePrinterForJob, selectBestBinding } from "@/lib/routing";
import { getAgentAvailability } from "@/lib/agent-availability";
import { POST as printJobsPOST } from "@/app/api/print/jobs/route";

/**
 * Routing availability and authorization regressions (real PostgreSQL).
 *
 *  - a disabled printer must be reported as PRINTER_DISABLED (409), not as
 *    PRINTER_OFFLINE (503): one is a configuration change, the other is
 *    "retry later";
 *  - Odoo API-key document-type allow-lists must match the routing layer's
 *    case-insensitive comparison.
 */

const suite = describe.skipIf(!hasTestDatabase);

async function bind(f: Fixture, bindingId: string, printerId: string, priority: number, documentType: string | null = "receipt") {
  await pool().query(
    `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [bindingId, f.branchId, f.destinationId, documentType, printerId, priority]
  );
}

async function addPrinter(f: Fixture, id: string, opts: { lifecycle?: string; status?: string } = {}) {
  await pool().query(
    `INSERT INTO printers (id, agent_id, name, printer_type, connection_type, protocol, status, lifecycle, config, capabilities)
     VALUES ($1, $2, $3, 'other', 'spooler', 'spooler', $4, $5, '{}'::jsonb, '{"supported_protocols":["raw","escpos","pdf"]}'::jsonb)`,
    [id, f.agentId, id, opts.status ?? "online", opts.lifecycle ?? "active"]
  );
}

suite("routing availability + document-type authorization", () => {
  let f: Fixture;

  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  it("reports a disabled printer as PRINTER_DISABLED, not PRINTER_OFFLINE", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
    await bind(f, "binding_disabled", f.printerId, 1);

    const resolved = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect(resolved).toBeTruthy();
    expect("error" in resolved!).toBe(true);
    expect((resolved as any).error).toBe("PRINTER_DISABLED");
    expect((resolved as any).message).toContain(f.printerId);
  });

  it("returns HTTP 409 PRINTER_DISABLED from POST /api/print/jobs and creates no job", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
    await bind(f, "binding_disabled", f.printerId, 1);

    const res = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: f.branchId,
        destinationId: f.destinationId,
        documentType: "receipt",
        payload: { type: "raw", encoding: "base64", data: Buffer.from("hi").toString("base64") },
      }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PRINTER_DISABLED");

    const jobs = await pool().query(`SELECT count(*)::int AS n FROM print_jobs`);
    expect(jobs.rows[0].n).toBe(0);
  });

  it("still reports PRINTER_OFFLINE (503) for an enabled but offline printer", async () => {
    await pool().query(`UPDATE printers SET status = 'offline' WHERE id = $1`, [f.printerId]);
    await bind(f, "binding_offline", f.printerId, 1);

    const resolved = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect((resolved as any).error).toBe("PRINTER_OFFLINE");
  });

  it("prefers the transient PRINTER_OFFLINE when both a disabled and an offline candidate exist", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
    await addPrinter(f, "printer_offline_2", { status: "offline" });
    await bind(f, "binding_disabled", f.printerId, 1);
    await bind(f, "binding_offline", "printer_offline_2", 2);

    const resolved = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect((resolved as any).error).toBe("PRINTER_OFFLINE");
  });

  it("falls back to the next healthy printer when the first one is disabled", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
    await addPrinter(f, "printer_healthy", {});
    await bind(f, "binding_disabled", f.printerId, 1);
    await bind(f, "binding_healthy", "printer_healthy", 2);

    const resolved = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "raw",
    });
    expect("error" in (resolved as any)).toBe(false);
    expect((resolved as any).printer.id).toBe("printer_healthy");
    expect((resolved as any).fallbackUsed).toBe(true);
    expect((resolved as any).fallbackChain).toEqual([f.printerId, "printer_healthy"]);
  });

  it("accepts a document type whose case differs from the API key allow-list", async () => {
    await pool().query(
      `UPDATE api_keys SET allowed_document_types = '["invoice"]'::jsonb WHERE hashed_key = $1`,
      [sha256(f.odooKey)]
    );
    await bind(f, "binding_invoice", f.printerId, 1, "invoice");

    const res = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: f.branchId,
        destinationId: f.destinationId,
        documentType: "Invoice", // Odoo sends the user-visible name
        payload: { type: "raw", encoding: "base64", data: Buffer.from("hi").toString("base64") },
      }),
    }));
    expect(res.status).toBe(201);

    // A document type that is genuinely not allowed is still refused.
    const denied = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: f.branchId,
        destinationId: f.destinationId,
        documentType: "delivery",
        payload: { type: "raw", encoding: "base64", data: Buffer.from("hi").toString("base64") },
      }),
    }));
    expect(denied.status).toBe(403);
  });

  it("prefers exact document binding before generic binding regardless of priority", () => {
    const rows = [
      { id: "generic-low", branchId: f.branchId, destinationId: f.destinationId, documentType: null, printerId: "p-generic", priority: 1, enabled: true },
      { id: "exact-high", branchId: f.branchId, destinationId: f.destinationId, documentType: "receipt", printerId: "p-exact", priority: 10, enabled: true },
    ];
    expect(selectBestBinding(rows, "receipt")?.id).toBe("exact-high");
  });

  it("marks an active offline agent unavailable", () => {
    expect(getAgentAvailability({ lifecycle: "active", status: "offline", lastSeenAt: new Date() }).available).toBe(false);
  });

  it("marks an active stale agent unavailable", () => {
    expect(getAgentAvailability({ lifecycle: "active", status: "online", lastSeenAt: new Date(Date.now() - 120_000) }).available).toBe(false);
  });

});
