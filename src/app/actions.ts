"use server";

import { db } from "../db";
import { agents, printers, printJobs, discoverySessions, discoveredDevices } from "../db/schema";
import { eq, count, or, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { generatePairingCode, hashPairingCode } from "../lib/agent-auth";
import { buildTestPrintPayload } from "../lib/payload";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "../lib/manager-auth";
import { createPrintJobForPrinter } from "../lib/print-job-service";
import { canTransitionLifecycle } from "../lib/lifecycle";
import { hasOpenAgentSocket, closeAgentSockets, publishAgentSessionClose } from "../server/ws";

async function requireManager() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) throw new Error("Unauthorized");
  return claims;
}

export async function createAgent(name: string) {
  await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) throw new Error("invalid agent name");
  const pairingCode = generatePairingCode();
  const id = `agt_${nanoid(8)}`;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 10);
  await db.insert(agents).values({
    id, name: name.trim(),
    pairingCodeHash: hashPairingCode(pairingCode),
    pairingCodeExpiresAt: expiresAt,
    status: "offline", lifecycle: "active",
  });
  revalidatePath("/dashboard");
  return { id, pairingCode, expiresAt, expires_at: expiresAt.toISOString() };
}

export async function deleteAgent(id: string) {
  await requireManager();
  if (typeof id !== "string" || !id.trim()) throw new Error("agent id is required");
  const agentId = id.trim();

  // In-memory WebSocket guard: if the agent is actively connected, refuse deletion
  if (hasOpenAgentSocket(agentId)) {
    throw new Error("Online agents cannot be deleted. The agent must be offline first.");
  }

  await db.transaction(async (tx) => {
    // Acquire row-level lock to prevent concurrent state transitions or reconnect races
    const locked = await tx.execute(sql`
      SELECT id, status, lifecycle
      FROM agents
      WHERE id = ${agentId}
      FOR UPDATE
    `);
    const agent = (locked as any).rows?.[0] as { id: string; status: string; lifecycle: string } | undefined;
    if (!agent) throw new Error("Agent not found");
    if (agent.status === "online") {
      throw new Error("Online agents cannot be deleted. The agent must be offline first.");
    }
    if (agent.lifecycle === "retired") {
      throw new Error("Retired agents are kept for audit history and cannot be deleted.");
    }

    // Referential integrity: check if this agent or any of its printers have historical print jobs
    const agentPrinters = await tx.select({ id: printers.id }).from(printers).where(eq(printers.agentId, agent.id));
    const printerIds = agentPrinters.map((p) => p.id);
    const jobConditions = [eq(printJobs.agentId, agent.id)];
    if (printerIds.length > 0) {
      jobConditions.push(inArray(printJobs.printerId, printerIds));
    }
    const [{ c: jobCount }] = await tx
      .select({ c: count() })
      .from(printJobs)
      .where(or(...jobConditions));

    if (Number(jobCount ?? 0) > 0) {
      throw new Error("This agent has print history and cannot be deleted. Retire the agent instead to preserve audit history.");
    }

    // Clean removable transient discovery runtime records
    await tx.delete(discoveredDevices).where(eq(discoveredDevices.agentId, agent.id));
    await tx.delete(discoverySessions).where(eq(discoverySessions.agentId, agent.id));

    // Clean removable runtime printers registered by this agent
    await tx.delete(printers).where(eq(printers.agentId, agent.id));

    // Permanently delete the agent
    await tx.delete(agents).where(eq(agents.id, agent.id));
  });

  // Terminate any remaining socket connections and publish revocation across cluster
  try { closeAgentSockets(agentId); } catch {}
  void publishAgentSessionClose(agentId).catch((error) => {
    console.warn(`[agents] failed to publish session close for ${agentId}:`, error);
  });

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function createPrintJob(printerId: string, payload: unknown) {
  await requireManager();
  const result = await createPrintJobForPrinter(printerId, payload, { requestedBy: "manager" });
  revalidatePath("/dashboard");
  return { id: result.id };
}

export async function createTestPrintJob(printerId: string) {
  await requireManager();
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, printerId) });
  if (!printer) throw new Error("Printer not found");
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!agent) throw new Error("Printer owner agent not found");
  const payload = buildTestPrintPayload(printer.name, agent.name ?? printer.agentId);
  const result = await createPrintJobForPrinter(printerId, payload, { requestedBy: "manager-test" });
  revalidatePath("/dashboard");
  return { id: result.id };
}

export async function setPrinterLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  await requireManager();
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) throw new Error("Printer not found");
  if (!canTransitionLifecycle(printer.lifecycle, lifecycle)) throw new Error(`invalid lifecycle transition: ${printer.lifecycle} -> ${lifecycle}`);
  if (lifecycle === "active") {
    const owner = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
    if (!owner) throw new Error("Printer owner agent not found");
    if (owner.lifecycle !== "active") throw new Error(`cannot activate printer while agent is ${owner.lifecycle}`);
  }
  await db.update(printers).set({ lifecycle, updatedAt: new Date() }).where(eq(printers.id, id));
  revalidatePath("/dashboard");
}

export async function setAgentLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  await requireManager();
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) throw new Error("Agent not found");
  if (agent.lifecycle === "retired" && lifecycle !== "retired") throw new Error("retired agent is terminal");
  if (!canTransitionLifecycle(agent.lifecycle, lifecycle)) throw new Error(`invalid lifecycle transition: ${agent.lifecycle} -> ${lifecycle}`);
  const reenable = agent.lifecycle === "disabled" && lifecycle === "active";
  const pairingCode = reenable ? generatePairingCode() : null;
  const pairingCodeHash = pairingCode ? hashPairingCode(pairingCode) : null;
  await db.transaction(async (tx) => {
    await tx.update(agents).set({
      lifecycle, secret: null,
      pairingCodeHash,
      pairingCodeExpiresAt: pairingCode ? new Date(Date.now() + 1000 * 60 * 10) : null,
      status: "offline", updatedAt: new Date(),
    }).where(eq(agents.id, id));
    if (lifecycle !== "active") {
      await tx.update(printers).set({ lifecycle: "disabled", updatedAt: new Date() }).where(eq(printers.agentId, id));
    }
  });
  if (lifecycle !== "active") {
    try { closeAgentSockets(id); } catch {}
    void publishAgentSessionClose(id).catch((error) => {
      console.warn(`[agents] failed to publish session close for ${id}:`, error);
    });
  }
  revalidatePath("/dashboard");
  return reenable ? { pairingCode } : undefined;
}
