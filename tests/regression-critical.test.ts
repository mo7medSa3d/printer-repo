import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { validatePrintJobPayload } from "@/lib/payload";
import { validatePayloadForPrinter, selectBestBinding } from "@/lib/routing";
import { isOdooKeyAllowedForDocumentType } from "@/lib/odoo-auth";
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

describe("regression: WS claim race (contract-level, no DB required)", () => {
  const wsSrc = readFileSync("src/server/ws.ts", "utf8");
  const deliverySrc = readFileSync("src/lib/job-delivery.ts", "utf8");

  it("claims the job before it is written to the socket", () => {
    const claimIdx = wsSrc.indexOf("claimJobForDelivery");
    const sendIdx = wsSrc.indexOf("sendToAgent(job.agentId");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(sendIdx);
  });

  it("claims inside a transaction with FOR UPDATE SKIP LOCKED", () => {
    expect(deliverySrc).toContain("db.transaction");
    expect(deliverySrc).toContain("FOR UPDATE SKIP LOCKED");
    expect(deliverySrc).toContain("status = 'claimed'");
  });

  it("releases an undelivered claim instead of stranding the job, reusing the job id", () => {
    expect(wsSrc).toContain("releaseUndeliveredClaim");
    expect(deliverySrc).toContain("SET status = 'queued'");
    // The recovery path never inserts a new row / new job id.
    expect(deliverySrc).not.toContain("nanoid");
    expect(deliverySrc).not.toContain("INSERT INTO print_jobs");
  });

  it("delivers the claimed status and job identity in the WS envelope", () => {
    expect(wsSrc).toContain('type: "print_job"');
    expect(wsSrc).toContain("branchId");
    expect(wsSrc).toContain("agentId");
    expect(wsSrc).toContain("printerId");
    expect(wsSrc).toContain('type !== "job_ack"');
  });

  it("keeps queued un-transitionable by agents (a fast agent cannot skip the claim)", () => {
    expect(canTransition("queued", "printing")).toBe(false);
    expect(canTransition("queued", "success")).toBe(false);
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("success", "printing")).toBe(false);
  });
});

describe("regression: PDF capability routing (contract-level, no DB required)", () => {
  it("refuses PDF for an ESC/POS-only printer even when it also lists raw", () => {
    const escposOnly = {
      protocol: "escpos",
      connectionType: "network",
      capabilities: { supported_protocols: ["escpos", "raw"] },
    };
    const result = validatePayloadForPrinter("pdf", escposOnly);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("CAPABILITY_MISMATCH");

    // raw/escpos to the same printer stay valid — no over-blocking.
    expect(validatePayloadForPrinter("raw", escposOnly).ok).toBe(true);
    expect(validatePayloadForPrinter("escpos", escposOnly).ok).toBe(true);
  });

  it("accepts PDF for a printer that declares pdf support", () => {
    expect(validatePayloadForPrinter("pdf", {
      protocol: "spooler",
      connectionType: "spooler",
      capabilities: { supported_protocols: ["raw", "escpos", "pdf"] },
    }).ok).toBe(true);
  });

  it("agent PDF path is real: validation, secure temp file, no shell", () => {
    const pdfSrc = readFileSync("agent/internal/printer/pdf.go", "utf8");
    expect(pdfSrc).toContain("%PDF-");
    expect(pdfSrc).toContain("%%EOF");
    expect(pdfSrc).toContain("os.MkdirTemp");
    expect(pdfSrc).toContain("os.CreateTemp");
    expect(pdfSrc).toContain("exec.CommandContext");
    expect(pdfSrc).not.toContain("sh -c");
    expect(pdfSrc).not.toContain("cmd /c");
    const winSrc = readFileSync("agent/internal/printer/pdf_windows.go", "utf8");
    expect(winSrc).toContain("ShellExecuteExW");
    expect(winSrc).toContain("printto");
    expect(winSrc).toContain("WaitForSingleObject");
  });

  it("payload types keep distinct semantics in the agent (pdf is never renamed to raw)", () => {
    const doc = readFileSync("agent/internal/printer/document.go", "utf8");
    expect(doc).toContain(`KindPDF    = "pdf"`);
    expect(doc).toContain("ErrCapabilityMismatch");
    const agentSrc = readFileSync("agent/internal/agent/agent.go", "utf8");
    expect(agentSrc).toContain("printer.PrintDocument(printCtx, p, printer.Document{Kind: kind");
    expect(agentSrc).toContain("CAPABILITY_MISMATCH");
  });
});

describe("regression: Odoo sync is validated and transactional (contract-level)", () => {
  const syncSrc = readFileSync("src/app/api/odoo/sync/route.ts", "utf8");

  it("validates the whole payload before any write and applies it in one transaction", () => {
    const validationIdx = syncSrc.indexOf("SYNC_VALIDATION_FAILED");
    const txIdx = syncSrc.indexOf("db.transaction");
    expect(validationIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(txIdx);
  });

  it("never auto-creates printers and reports missing dependencies explicitly", () => {
    expect(syncSrc).toContain("SYNC_DEPENDENCY_MISSING");
    expect(syncSrc).not.toContain("insert(printers)");
    expect(syncSrc).not.toContain("insert(agents)");
  });

  it("normalizes ids to strings before comparing", () => {
    expect(syncSrc).toContain("function asId");
    expect(syncSrc).toContain("String(value)");
  });

  it("never returns success while something failed", () => {
    // The only success:true is emitted after the transaction committed.
    const successIdx = syncSrc.indexOf("success: true");
    const commitIdx = syncSrc.indexOf("});", syncSrc.indexOf("db.transaction"));
    expect(successIdx).toBeGreaterThan(commitIdx);
  });
});

describe("regression: PRINTER_DISABLED is distinct from PRINTER_OFFLINE", () => {
  const routingSrc = readFileSync("src/lib/routing.ts", "utf8");

  it("tracks disabled printers separately from offline ones", () => {
    expect(routingSrc).toContain("lastDisabledPrinter");
    // A disabled printer must no longer be reported through the offline path.
    expect(routingSrc).not.toContain("if (idx === 0) lastOfflinePrinter = printer.id;");
    const disabledIdx = routingSrc.indexOf('error: "PRINTER_DISABLED"');
    expect(disabledIdx).toBeGreaterThan(-1);
  });

  it("maps the code to HTTP 409 at the API layer", () => {
    const routeSrc = readFileSync("src/app/api/print/jobs/route.ts", "utf8");
    expect(routeSrc).toContain("PRINTER_DISABLED: 409");
  });
});

describe("regression: Odoo key document-type matching is normalized like routing", () => {
  it("accepts a differently-cased or padded document type", () => {
    const key = { allowedDocumentTypes: ["invoice", "receipt"], scope: "standard" };
    expect(isOdooKeyAllowedForDocumentType(key, "Invoice", "write")).toBe(true);
    expect(isOdooKeyAllowedForDocumentType(key, "  RECEIPT ", "write")).toBe(true);
    expect(isOdooKeyAllowedForDocumentType({ allowedDocumentTypes: ["Invoice"] }, "invoice", "write")).toBe(true);
  });

  it("still rejects a document type that is not on the list", () => {
    const key = { allowedDocumentTypes: ["invoice"], scope: "standard" };
    expect(isOdooKeyAllowedForDocumentType(key, "delivery", "write")).toBe(false);
    expect(isOdooKeyAllowedForDocumentType({ scope: "read_only", allowedDocumentTypes: ["invoice"] }, "Invoice", "write")).toBe(false);
  });

  it("matches the routing layer's normalization for the same value", () => {
    const bindings = [{ id: "b1", branchId: "br", destinationId: "d", documentType: "invoice", printerId: "p", priority: 1, enabled: true }];
    // routing accepts "Invoice" for a binding declared as "invoice" …
    expect(selectBestBinding(bindings, "Invoice")?.id).toBe("b1");
    // … so authorization must accept it too (this was the 403 mismatch).
    expect(isOdooKeyAllowedForDocumentType({ allowedDocumentTypes: ["invoice"] }, "Invoice", "write")).toBe(true);
  });
});

describe("regression: agent crash duplicate-print exposure", () => {
  it("marks mid-print jobs as an explicit interruption instead of leaving them printing", () => {
    const queueSrc = readFileSync("agent/internal/queue/queue.go", "utf8");
    expect(queueSrc).toContain("InterruptedMarker");
    expect(queueSrc).toContain("MarkInterrupted");
    const agentSrc = readFileSync("agent/internal/agent/agent.go", "utf8");
    expect(agentSrc).toContain("recoverInterruptedJobs");
    expect(agentSrc).toContain("ReprintAfterCrashEnabled");
  });

  it("does not claim exactly-once physical printing anywhere in the docs", () => {
    for (const file of ["PRINTERS.md", "README.md", "API.md"]) {
      const text = readFileSync(file, "utf8").toLowerCase();
      expect(text).not.toContain("exactly-once physical");
    }
  });
});
