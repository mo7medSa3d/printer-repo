"use server";

import { db } from "@/db";
import { agents, branches, printers, printJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { generatePairingCode } from "@/lib/agent-auth";
import { validatePrintJobPayload, buildTestPrintPayload } from "@/lib/payload";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "@/lib/manager-auth";
import { claimAndPushJobToAgent } from "@/server/ws";
import { canTransitionLifecycle } from "@/lib/lifecycle";

/**
 * Server actions are public HTTP endpoints (POST) like any route handler —
 * "use server" does NOT authenticate them. Every action here mutates printer
 * state, so require a valid manager session (cookie round-trip, same policy
 * as the management API routes) before touching the DB.
 */
async function requireManager() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) throw new Error("Unauthorized");
  return claims;
}

export async function createAgent(name: string, branchId: string) {
  await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
    throw new Error("invalid agent name");
  }
  if (typeof branchId !== "string" || !branchId.trim()) {
    throw new Error("branchId is required");
  }
  const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId.trim()) });
  if (!branch) throw new Error("branch not found");
  if (!branch.enabled) throw new Error("branch is disabled");
  const pairingCode = generatePairingCode();
  const id = `agt_${nanoid(8)}`;
  await db.insert(agents).values({
    id,
    branchId: branch.id,
    name: name.trim(),
    pairingCode,
    pairingCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30), // 30 mins
    status: "offline",
    lifecycle: "active",
  });

  revalidatePath("/dashboard");
  return { id, pairingCode };
}

export async function createPrintJob(printerId: string, payload: unknown) {
  await requireManager();
  const printer = await db.query.printers.findFirst({
    where: eq(printers.id, printerId),
  });

  if (!printer) throw new Error("Printer not found");
  if (printer.lifecycle !== "active") throw new Error(`Printer is ${printer.lifecycle}`);

  // Reject malformed/unsupported payloads here too (defense in depth) -
  // the agent enforces the same contract independently.
  const validatedPayload = validatePrintJobPayload(payload);

  const id = `job_${nanoid(10)}`;
  const ownerAgent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!ownerAgent) throw new Error("Printer owner agent not found");
  if (ownerAgent.lifecycle !== "active") throw new Error(`Agent is ${ownerAgent.lifecycle}`);
  const row = {
    id,
    branchId: ownerAgent.branchId,
    agentId: ownerAgent.id,
    printerId: printer.id,
    status: "queued" as const,
    payload: validatedPayload,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
  };
  await db.insert(printJobs).values(row);

  // Claim-before-delivery push (polling fallback covers an offline agent).
  // The row is moved queued→claimed inside a transaction *before* the socket
  // write, so the agent never executes a job the gateway still calls queued.
  try {
    await claimAndPushJobToAgent({ id, agentId: printer.agentId });
  } catch (e) {
    // Best-effort push; the durable row + agent polling is the fallback.
    // Log instead of swallowing so persistent push failures are visible.
    console.warn(`[actions] WS push failed for job ${id}:`, e);
  }

  revalidatePath("/dashboard");
  return { id };
}

/**
 * A real test print, not just a connectivity check: sends an actual
 * ESC/POS test payload through the same job pipeline every other job
 * uses (queued -> claimed -> printing -> success/failed).
 */
export async function createTestPrintJob(printerId: string) {
  await requireManager();
  const printer = await db.query.printers.findFirst({
    where: eq(printers.id, printerId),
  });
  if (!printer) throw new Error("Printer not found");

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, printer.agentId),
  });

  const payload = buildTestPrintPayload(printer.name, agent?.name ?? printer.agentId);
  return createPrintJob(printerId, payload);
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
  if (!canTransitionLifecycle(agent.lifecycle, lifecycle)) {
    throw new Error(`invalid lifecycle transition: ${agent.lifecycle} -> ${lifecycle}`);
  }
  const reenable = agent.lifecycle === "disabled" && lifecycle === "active";
  const pairingCode = reenable ? generatePairingCode() : null;
  await db.transaction(async (tx) => {
    await tx.update(agents).set({
      lifecycle,
      // Disabling always revokes credentials. Re-enabling requires fresh pairing.
      secret: null,
      pairingCode,
      pairingCodeExpiresAt: pairingCode ? new Date(Date.now() + 1000 * 60 * 30) : null,
      status: "offline",
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
    if (lifecycle !== "active") {
      await tx.update(printers).set({ lifecycle: "disabled", updatedAt: new Date() }).where(eq(printers.agentId, id));
    }
  });
  revalidatePath("/dashboard");
  return reenable ? { pairingCode } : undefined;
}
