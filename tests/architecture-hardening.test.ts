import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canTransitionLifecycle, lifecycleAllowsNewJobs } from "../src/lib/lifecycle";
import { printerInputSchema } from "../src/lib/printer-model";
import { validatePrintJobPayload } from "../src/lib/payload";

const b64 = (value: string) => Buffer.from(value, "binary").toString("base64");

describe("architecture hardening", () => {
  it("keeps agent management runtime-only and rejects branch ownership fields", async () => {
    const source = await import("node:fs/promises");
    const body = await source.readFile(new URL("../src/app/api/agents/route.ts", import.meta.url), "utf8");
    expect(body).not.toContain("branchId");
    expect(body).not.toContain("Default Branch");
    expect(body).toContain("createAgentSchema");
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

  it("rejects legacy branch-owned printer input instead of normalizing it", () => {
    expect(printerInputSchema.safeParse({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "thermal", connectionType: "network", protocol: "raw",
      config: { ip: "127.0.0.1", port: 9100 }, branchId: "evil",
    }).success).toBe(false);
  });

  it("validates supported payload representations", () => {
    expect(validatePrintJobPayload({ type: "pdf", encoding: "base64", data: b64("%PDF-1.7\n") }).type).toBe("pdf");
    expect(validatePrintJobPayload({ type: "image", encoding: "base64", data: "/9j/4AAQSkZJRg==" }).type).toBe("image");
  });

  it("keeps the runtime printer schema canonical", () => {
    const result = printerInputSchema.safeParse({
      agentId: "agt_1", name: "P", printerType: "physical", deviceClass: "laser", connectionType: "spooler", protocol: "spooler",
      config: { spooler_name: "P" }, type: "spooler",
    });
    expect(result.success).toBe(false);
  });

  it("uses pairing code as the registration credential without Odoo business ownership", () => {
    const src = readFileSync("src/app/api/agent/register/route.ts", "utf8");
    expect(src).toContain("pairingCode");
    expect(src).toContain("agentId: z.string().trim().min(1).max(120).optional()");
    expect(src).not.toContain("branchId");
    expect(src).toContain("eq(agents.pairingCode, normalizedCode)");
    expect(src).toContain("inspectPairingRateLimit");
    expect(src).toContain("return NextResponse.json({ agentId: agent.id, secret }, { status: 200 });");
  });

  it("installs security headers without forcing HSTS on development HTTP", () => {
    const src = readFileSync("next.config.ts", "utf8");
    expect(src).toContain("X-Content-Type-Options");
    expect(src).toContain("strict-origin-when-cross-origin");
    expect(src).toContain("X-Frame-Options");
    expect(src).toContain("Permissions-Policy");
    expect(src).toContain("NODE_ENV === \"production\"");
    expect(src).toContain("Strict-Transport-Security");
  });

  it("keeps agent lifecycle changes transactional", () => {
    const src = readFileSync("src/app/actions.ts", "utf8");
    const start = src.indexOf("export async function setAgentLifecycle");
    const end = src.indexOf('revalidatePath("/dashboard")', start);
    const block = src.slice(start, end);
    expect(block).toContain("db.transaction");
    expect(block).toContain("tx.update(agents)");
    expect(block).toContain("tx.update(printers)");
  });
});
