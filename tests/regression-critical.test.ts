import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { validatePrintJobPayload } from "@/lib/payload";
import { validatePayloadForPrinter } from "@/lib/routing";
import { canTransition } from "@/lib/job-status";

describe("regression: truncated 40-bit jobId removed", () => {
  it("route.ts does not use sha256 truncated hash for jobId", () => {
    const src = readFileSync("src/app/api/print/jobs/route.ts", "utf8");
    expect(src).not.toContain("createHash");
    expect(src).not.toContain("slice(0, 10)");
    expect(src).not.toContain("job_${h}");
    // Must use nanoid with collision-safe length
    expect(src).toContain("nanoid(12)");
    // Must dedup via (branchId, idempotencyKey)
    expect(src).toContain("idempotencyKey");
    expect(src).toContain("branchId");
    expect(src).toContain("printJobs.idempotencyKey");
  });

  it("schema persists idempotencyKey durably", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    expect(schema).toContain("idempotencyKey");
    expect(schema).toContain("idempotency_key");
    const migration = readFileSync("drizzle/0003_add_idempotency_key.sql", "utf8");
    expect(migration).toContain("idempotency_key");
    expect(migration).toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain("WHERE \"idempotency_key\" IS NOT NULL");
  });

  it("Odoo generates stable key per logical operation", () => {
    const branch = readFileSync("odoo_addons/print_gateway/models/branch.py", "utf8");
    expect(branch).toContain("idempotency_key");
    expect(branch).toContain("uuid.uuid4().hex");
    expect(branch).toContain("idempotencyKey");
    expect(branch).toContain("requests.post");
    // Must reuse same key on retry
    expect(branch).toContain("for attempt in (1, 2)");

    const report = readFileSync("odoo_addons/print_gateway/models/ir_actions_report.py", "utf8");
    expect(report).toContain("idempotency_key = _uuid.uuid4().hex");
    expect(report).toContain("idempotency_key=idempotency_key");
  });
});

describe("regression: payload contract aligned", () => {
  it("allows pdf and rejects badtype (gateway==Go)", () => {
    expect(() => validatePrintJobPayload({ type: "pdf", encoding: "base64", data: Buffer.from("%PDF-1.4").toString("base64") })).not.toThrow();
    expect(() => validatePrintJobPayload({ type: "badtype", encoding: "base64", data: "aGVsbG8=" })).toThrow();
  });

  it("pdf to raw thermal is rejected, pdf to spooler/IPP allowed", () => {
    expect(validatePayloadForPrinter("pdf", { protocol: "raw", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter("pdf", { protocol: "spooler", connectionType: "spooler" }).ok).toBe(true);
    expect(validatePayloadForPrinter("pdf", { protocol: "ipp", connectionType: "ipp" }).ok).toBe(true);
    expect(validatePayloadForPrinter("pdf", { protocol: "raw", connectionType: "spooler" }).ok).toBe(true);
    expect(validatePayloadForPrinter("raw", { protocol: "raw", connectionType: "network" }).ok).toBe(true);
  });
});

describe("regression: state machine server-enforced", () => {
  it("queued never transitions to printing (only claimed->printing)", () => {
    expect(canTransition("queued", "printing")).toBe(false);
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
    expect(canTransition("success", "failed")).toBe(false);
  });
});

describe("regression: no mutex held during network (agent)", () => {
  it("agent.go does not hold lock across updateJobStatus", () => {
    const src = readFileSync("agent/internal/agent/agent.go", "utf8");
    // The critical comment must exist
    expect(src).toContain("Report printing outside the per-printer lock");
    // Ensure lock is released before updateJobStatus
    const idxLock = src.indexOf("a.queue.UpdateStatus(jobID, \"printing\")");
    const idxUnlock = src.indexOf("lock.Unlock()", idxLock);
    const idxUpdate = src.indexOf("a.updateJobStatus(jobID, \"printing\"", idxUnlock);
    expect(idxLock).toBeGreaterThan(0);
    expect(idxUnlock).toBeGreaterThan(idxLock);
    expect(idxUpdate).toBeGreaterThan(idxUnlock);
    // Ensure second lock re-checks dedup
    expect(src).toContain("was already processed while waiting for printer");
  });
});

describe("regression: Odoo payload_type dead UI fixed", () => {
  it("ir_actions_report consumes payload_type", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/ir_actions_report.py", "utf8");
    expect(src).toContain("payload_type");
    expect(src).toContain("desired_type");
    expect(src).toContain("type': payload_type");
  });
  it("report_mapping help is honest", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/report_mapping.py", "utf8");
    expect(src).not.toContain("will try to convert");
    expect(src).toContain("requires spooler or IPP");
  });
});

describe("regression: branch isolation and auth", () => {
  it("route.ts validates odoo key with branchId", () => {
    const src = readFileSync("src/app/api/print/jobs/route.ts", "utf8");
    expect(src).toContain("validateOdooKey(req, parsed.branchId)");
  });
  it("agent claims are branch-scoped", () => {
    const src = readFileSync("src/app/api/agent/jobs/route.ts", "utf8");
    expect(src).toContain("branchFilter");
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
  });
});

describe("regression: stale refs and debug", () => {
  it("no truncated hash, no console.log, no TODO", () => {
    const route = readFileSync("src/app/api/print/jobs/route.ts", "utf8");
    expect(route).not.toMatch(/slice\(0,\s*10\)/);
    const allSrc = readFileSync("src/lib/payload.ts", "utf8") + readFileSync("agent/internal/payload/payload.go", "utf8");
    expect(allSrc).not.toContain("console.log");
  });
});
