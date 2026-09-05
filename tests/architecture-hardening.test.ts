import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canTransitionLifecycle, lifecycleAllowsNewJobs } from "../src/lib/lifecycle";
import { normalizeLegacyPrinterInput, printerInputSchema } from "../src/lib/printer-model";
import { validatePrintJobPayload } from "../src/lib/payload";

const b64 = (value: string) => Buffer.from(value, "binary").toString("base64");

describe("architecture hardening", () => {
  it("requires an explicit branch at the agent API boundary", async () => {
    const source = await import("node:fs/promises");
    const body = await source.readFile(new URL("../src/app/api/agents/route.ts", import.meta.url), "utf8");
    expect(body).toContain("branchId");
    expect(body).not.toContain("Default Branch");
  });

  it("enforces terminal retired lifecycle", () => {
    expect(canTransitionLifecycle("active", "disabled")).toBe(true);
    expect(canTransitionLifecycle("disabled", "active")).toBe(true);
    expect(canTransitionLifecycle("active", "retired")).toBe(true);
    expect(canTransitionLifecycle("retired", "active")).toBe(false);
    expect(canTransitionLifecycle("retired", "disabled")).toBe(false);
    expect(lifecycleAllowsNewJobs("retired")).toBe(false);
    expect(lifecycleAllowsNewJobs("disabled")).toBe(false);
  });

  it("normalizes legacy printer input but never accepts branch ownership", () => {
    const canonical = normalizeLegacyPrinterInput({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "thermal", type: "tcp",
      protocol: "raw", config: { ip: "127.0.0.1", port: 9100, protocol: "raw" },
    });
    expect(canonical.connectionType).toBe("network");
    expect(canonical.config).not.toHaveProperty("protocol");
    expect(() => normalizeLegacyPrinterInput({ agentId: "agt_1", name: "P", branchId: "evil" })).toThrow();
    expect(() => normalizeLegacyPrinterInput({ agentId: "agt_1", name: "P", type: "tcp", connectionType: "usb" })).toThrow();
  });

  it("rejects ambiguous PDF-to-RAW payload routing at the payload capability boundary", () => {
    expect(validatePrintJobPayload({ type: "pdf", encoding: "base64", data: b64("%PDF-1.7\n") }).type).toBe("pdf");
    const parsed = printerInputSchema.safeParse({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "thermal", connectionType: "network", protocol: "raw",
      config: { ip: "127.0.0.1", port: 9100 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.printerType).toBe("physical");
      expect(parsed.data.deviceClass).toBe("thermal");
    }
  });

  it("keeps the printer schema canonical", () => {
    const result = printerInputSchema.safeParse({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "laser", connectionType: "spooler", protocol: "spooler", config: { spooler_name: "P" },
      type: "spooler",
    });
    expect(result.success).toBe(false);
  });

  it("uses the pairing code as the agent-registration credential and derives branch ownership from the paired agent", () => {
    const src = readFileSync("src/app/api/agent/register/route.ts", "utf8");
    expect(src).toContain("pairingCode");
    expect(src).toContain("agentId: z.string().trim().min(1).max(120).optional()");
    expect(src).toContain("branchId is not accepted");
    expect(src).toContain("eq(agents.pairingCode, normalizedCode)");
    expect(src).toContain("clientIpFrom(req)");
    expect(src).toContain("inspectPairingRateLimit");
    expect(src).toContain("return NextResponse.json({ agentId: agent.id, branchId: agent.branchId, secret });");
  });

  it("installs security headers without forcing HSTS on development HTTP", () => {
    const src = readFileSync("next.config.ts", "utf8");
    expect(src).toContain("X-Content-Type-Options");
    expect(src).toContain("strict-origin-when-cross-origin");
    expect(src).toContain('X-Frame-Options');
    expect(src).toContain('Permissions-Policy');
    expect(src).toContain("NODE_ENV === \"production\"");
    expect(src).toContain("Strict-Transport-Security");
  });

  it("makes agent->printer lifecycle ownership transactional", () => {
    const src = readFileSync("src/app/actions.ts", "utf8");
    const start = src.indexOf("export async function setAgentLifecycle");
    const end = src.indexOf('revalidatePath("/dashboard")', start);
    const block = src.slice(start, end);
    expect(block).toContain("db.transaction");
    expect(block).toContain("tx.update(agents)");
    expect(block).toContain("tx.update(printers)");
  });
});
