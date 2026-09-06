import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { POST as syncPOST } from "../src/app/api/odoo/sync/route";

/**
 * PART 3 regression suite — dependency-safe, transactional Odoo → Gateway sync.
 * Runs against a real PostgreSQL: partial application and rollback cannot be
 * observed without one.
 */

const suite = describe.skipIf(!hasTestDatabase);

function syncRequest(key: string, body: unknown) {
  return new Request("http://gateway.test/api/odoo/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function count(table: string, where = "TRUE", params: any[] = []): Promise<number> {
  const res = await pool().query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return res.rows[0].n;
}

suite("Odoo → Gateway sync (dependency-safe, transactional)", () => {
  let f: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  function validPayload(overrides: Record<string, any> = {}) {
    return {
      branches: [{ id: f.branchId, name: "Cairo Branch", location: "Cairo", enabled: true }],
      destinations: [{ id: "dest_kitchen", branchId: f.branchId, name: "Kitchen", type: "kitchen", enabled: true }],
      documentTypes: [{ id: "doctype_receipt", branchId: f.branchId, name: "receipt", enabled: true }],
      bindings: [
        {
          id: "binding_1",
          branchId: f.branchId,
          destinationId: "dest_kitchen",
          documentType: "receipt",
          printerId: f.printerId,
          priority: 1,
          enabled: true,
        },
      ],
      ...overrides,
    };
  }

  // --------------------------------------------------------------- Test 16
  it("Test 16: a complete valid sync commits every entity", async () => {
    const res = await syncPOST(syncRequest(f.odooKey, validPayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.synced).toEqual({ branches: 1, destinations: 1, documentTypes: 1, bindings: 1 });

    expect(await count("branches", "id = $1", [f.branchId])).toBe(1);
    expect(await count("destinations", "id = 'dest_kitchen' AND branch_id = $1", [f.branchId])).toBe(1);
    expect(await count("document_types", "id = 'doctype_receipt'")).toBe(1);
    expect(await count("printer_bindings", "id = 'binding_1' AND printer_id = $1", [f.printerId])).toBe(1);

    const branch = await pool().query(`SELECT name, location FROM branches WHERE id = $1`, [f.branchId]);
    expect(branch.rows[0].name).toBe("Cairo Branch");
  });

  // --------------------------------------------------------------- Test 17
  it("Test 17: an invalid binding aborts the whole sync — nothing is written", async () => {
    const payload = validPayload({
      bindings: [
        { id: "binding_1", branchId: f.branchId, destinationId: "dest_kitchen", printerId: f.printerId, priority: 1 },
        { id: "binding_bad", branchId: f.branchId, destinationId: "dest_kitchen", printerId: "printer_does_not_exist", priority: 2 },
      ],
    });
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("SYNC_DEPENDENCY_MISSING");

    // Not one row of the payload may have been applied.
    expect(await count("destinations", "id = 'dest_kitchen'")).toBe(0);
    expect(await count("document_types", "id = 'doctype_receipt'")).toBe(0);
    expect(await count("printer_bindings", "TRUE")).toBe(0);
    const branch = await pool().query(`SELECT name FROM branches WHERE id = $1`, [f.branchId]);
    expect(branch.rows[0].name).not.toBe("Cairo Branch"); // untouched seed name
  });

  it("Test 17b: a database failure inside the transaction rolls the entire sync back", async () => {
    // A constraint that the application layer cannot know about forces the
    // failure to happen *inside* the transaction, after earlier upserts.
    await pool().query(`ALTER TABLE printer_bindings ADD CONSTRAINT test_reject_priority_99 CHECK (priority <> 99)`);
    try {
      const payload = validPayload({
        bindings: [
          { id: "binding_1", branchId: f.branchId, destinationId: "dest_kitchen", printerId: f.printerId, priority: 99 },
        ],
      });
      const res = await syncPOST(syncRequest(f.odooKey, payload));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("SYNC_INTERNAL_ERROR");

      // Branch/destination/document-type upserts from the same transaction
      // must have been rolled back with it.
      expect(await count("destinations", "id = 'dest_kitchen'")).toBe(0);
      expect(await count("document_types", "id = 'doctype_receipt'")).toBe(0);
      expect(await count("printer_bindings", "TRUE")).toBe(0);
      const branch = await pool().query(`SELECT name FROM branches WHERE id = $1`, [f.branchId]);
      expect(branch.rows[0].name).not.toBe("Cairo Branch");
    } finally {
      await pool().query(`ALTER TABLE printer_bindings DROP CONSTRAINT test_reject_priority_99`);
    }
  });

  // --------------------------------------------------------------- Test 18
  it("Test 18: a binding for an unregistered printer reports SYNC_DEPENDENCY_MISSING and names it", async () => {
    const payload = validPayload({
      bindings: [
        { id: "binding_1", branchId: f.branchId, destinationId: "dest_kitchen", printerId: "printer_not_yet_registered", priority: 1 },
      ],
    });
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("SYNC_DEPENDENCY_MISSING");
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatchObject({ bindingId: "binding_1", printerId: "printer_not_yet_registered" });
    expect(body.details[0].reason).toContain("printer does not exist");

    // The gateway must NOT invent a printer row from Odoo data.
    expect(await count("printers", "id = 'printer_not_yet_registered'")).toBe(0);
  });

  // --------------------------------------------------------------- Test 19
  it("Test 19: a binding referencing a printer from another branch is rejected", async () => {
    const other = await seedFixture();
    const payload = validPayload({
      bindings: [
        { id: "binding_x", branchId: f.branchId, destinationId: "dest_kitchen", printerId: other.printerId, priority: 1 },
      ],
    });
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("SYNC_VALIDATION_FAILED");
    expect(body.details[0].printerId).toBe(other.printerId);
    expect(body.details[0].reason).toContain("printer belongs to branch");
    expect(await count("printer_bindings", "TRUE")).toBe(0);
  });

  // --------------------------------------------------------------- Test 20
  it("Test 20: a binding referencing a destination from another branch is rejected", async () => {
    const other = await seedFixture();
    const payload = validPayload({
      destinations: [],
      bindings: [
        { id: "binding_y", branchId: f.branchId, destinationId: other.destinationId, printerId: f.printerId, priority: 1 },
      ],
    });
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("SYNC_VALIDATION_FAILED");
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "binding",
          bindingId: "binding_y",
          destinationId: other.destinationId,
          reason: expect.stringContaining("destination belongs to branch"),
        }),
      ]),
    );
    expect(await count("printer_bindings", "TRUE")).toBe(0);
  });

  it("Test 20b: a payload mixing two branches is rejected as a whole", async () => {
    const other = await seedFixture();
    const payload = validPayload({
      destinations: [
        { id: "dest_kitchen", branchId: f.branchId, name: "Kitchen", type: "kitchen" },
        { id: "dest_other", branchId: other.branchId, name: "Other", type: "pos" },
      ],
    });
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("SYNC_VALIDATION_FAILED");
    expect(await count("destinations", "id = 'dest_kitchen'")).toBe(0);
    expect(await count("destinations", "id = 'dest_other'")).toBe(0);
  });

  it("rejects a branch-scoped key used for a different branch", async () => {
    const other = await seedFixture();
    const payload = {
      branches: [{ id: other.branchId, name: "Someone else" }],
      destinations: [],
      bindings: [],
    };
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect([401, 403]).toContain(res.status);
    expect((await res.json()).success).toBe(false);
  });

  // --------------------------------------------------------------- Test 21
  it("Test 21: repeating the identical sync is idempotent", async () => {
    const first = await syncPOST(syncRequest(f.odooKey, validPayload()));
    expect(first.status).toBe(200);
    const second = await syncPOST(syncRequest(f.odooKey, validPayload()));
    expect(second.status).toBe(200);
    const third = await syncPOST(syncRequest(f.odooKey, validPayload()));
    expect(third.status).toBe(200);

    expect(await count("branches", "id = $1", [f.branchId])).toBe(1);
    expect(await count("destinations", "id = 'dest_kitchen'")).toBe(1);
    expect(await count("document_types", "id = 'doctype_receipt'")).toBe(1);
    expect(await count("printer_bindings", "id = 'binding_1'")).toBe(1);
  });

  // --------------------------------------------------------------- Test 22
  it("Test 22: concurrent identical syncs do not create duplicates", async () => {
    const [a, b, c] = await Promise.all([
      syncPOST(syncRequest(f.odooKey, validPayload())),
      syncPOST(syncRequest(f.odooKey, validPayload())),
      syncPOST(syncRequest(f.odooKey, validPayload())),
    ]);
    for (const res of [a, b, c]) {
      // Every concurrent caller either commits the same state or fails
      // explicitly — never a silent partial success.
      const body = await res.clone().json();
      if (res.status !== 200) {
        expect(body.success).toBe(false);
        expect(body.error).toBe("SYNC_INTERNAL_ERROR");
      } else {
        expect(body.success).toBe(true);
      }
    }
    expect(await count("branches", "id = $1", [f.branchId])).toBe(1);
    expect(await count("destinations", "id = 'dest_kitchen'")).toBe(1);
    expect(await count("document_types", "id = 'doctype_receipt'")).toBe(1);
    expect(await count("printer_bindings", "id = 'binding_1'")).toBe(1);
  });

  it("disables destinations omitted from a later full-snapshot sync (deleted printer-side resource)", async () => {
    const first = await syncPOST(syncRequest(f.odooKey, validPayload()));
    expect(first.status).toBe(200);
    const dropped = validPayload({
      destinations: [{ id: "dest_pos", branchId: f.branchId, name: "POS", type: "pos", enabled: true }],
      bindings: [
        { id: "binding_1", branchId: f.branchId, destinationId: "dest_pos", documentType: "receipt", printerId: f.printerId, priority: 1, enabled: true },
      ],
    });
    const res = await syncPOST(syncRequest(f.odooKey, dropped));
    expect(res.status).toBe(200);
    const kitchen = await pool().query(`SELECT enabled FROM destinations WHERE id = 'dest_kitchen'`);
    expect(kitchen.rows[0].enabled).toBe(false);
    const pos = await pool().query(`SELECT enabled FROM destinations WHERE id = 'dest_pos'`);
    expect(pos.rows[0].enabled).toBe(true);
  });

  it("applies a changed destination without creating a duplicate", async () => {
    expect((await syncPOST(syncRequest(f.odooKey, validPayload()))).status).toBe(200);
    const changed = validPayload({
      destinations: [{ id: "dest_kitchen", branchId: f.branchId, name: "Hot Line", type: "kitchen", enabled: true }],
    });
    expect((await syncPOST(syncRequest(f.odooKey, changed))).status).toBe(200);
    expect(await count("destinations", "id = 'dest_kitchen'")).toBe(1);
    const row = await pool().query(`SELECT name FROM destinations WHERE id = 'dest_kitchen'`);
    expect(row.rows[0].name).toBe("Hot Line");
  });

  it("keeps a disabled destination disabled on repeat sync", async () => {
    const payload = validPayload({
      destinations: [{ id: "dest_kitchen", branchId: f.branchId, name: "Kitchen", type: "kitchen", enabled: false }],
    });
    expect((await syncPOST(syncRequest(f.odooKey, payload))).status).toBe(200);
    expect((await syncPOST(syncRequest(f.odooKey, payload))).status).toBe(200);
    const row = await pool().query(`SELECT enabled FROM destinations WHERE id = 'dest_kitchen'`);
    expect(row.rows[0].enabled).toBe(false);
  });

  it("rejects a destination id that already belongs to another branch", async () => {
    const other = await seedFixture();
    await pool().query(
      `INSERT INTO destinations (id, branch_id, name, type) VALUES ('shared_dest', $1, 'Other POS', 'pos')`,
      [other.branchId]
    );
    const payload = validPayload({
      destinations: [{ id: "shared_dest", branchId: f.branchId, name: "Stolen", type: "pos", enabled: true }],
    });
    const res = await syncPOST(syncRequest(f.odooKey, payload));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("SYNC_VALIDATION_FAILED");
    const owner = await pool().query(`SELECT branch_id FROM destinations WHERE id = 'shared_dest'`);
    expect(owner.rows[0].branch_id).toBe(other.branchId);
  });

  it("does not leak or mutate the other branch during a successful sync", async () => {
    const other = await seedFixture();
    await pool().query(
      `INSERT INTO destinations (id, branch_id, name, type, enabled) VALUES ('other_dest', $1, 'Stay', 'pos', true)`,
      [other.branchId]
    );
    expect((await syncPOST(syncRequest(f.odooKey, validPayload()))).status).toBe(200);
    const row = await pool().query(`SELECT branch_id, enabled, name FROM destinations WHERE id = 'other_dest'`);
    expect(row.rows[0].branch_id).toBe(other.branchId);
    expect(row.rows[0].enabled).toBe(true);
    expect(row.rows[0].name).toBe("Stay");
  });

  it("rejects bare numeric Odoo company ids under the canonical branch-id contract", async () => {
    const numericBranch = await seedFixture({ branchId: "odoo_company_4242" });
    const payload = {
      branches: [{ id: 4242, name: "Numeric Branch" }],
      destinations: [{ id: 77, branchId: 4242, name: "POS", type: "pos" }],
      bindings: [{ id: 9, branchId: 4242, destinationId: 77, printerId: numericBranch.printerId, priority: 1 }],
    };
    const res = await syncPOST(syncRequest(numericBranch.odooKey, payload));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("UNAUTHORIZED");
    expect(await count("destinations", "id = '77' AND branch_id = 'odoo_company_4242'")).toBe(0);
    expect(await count("printer_bindings", "id = '9' AND destination_id = '77'")).toBe(0);
  });

  it("accepts the canonical Odoo company branch id and normalizes child integer ids", async () => {
    const canonicalBranch = await seedFixture({ branchId: "odoo_company_4242" });
    const payload = {
      branches: [{ id: "odoo_company_4242", name: "Canonical Branch" }],
      destinations: [{ id: 77, branchId: "odoo_company_4242", name: "POS", type: "pos" }],
      bindings: [{ id: 9, branchId: "odoo_company_4242", destinationId: 77, printerId: canonicalBranch.printerId, priority: 1 }],
    };
    const res = await syncPOST(syncRequest(canonicalBranch.odooKey, payload));
    expect(res.status).toBe(200);
    expect(await count("destinations", "id = '77' AND branch_id = 'odoo_company_4242'")).toBe(1);
    expect(await count("printer_bindings", "id = '9' AND destination_id = '77'")).toBe(1);
  });
});
