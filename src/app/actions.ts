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
    pairingCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30),
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

  const validatedPayload = validatePrintJobPayload(payload);

  const ownerAgent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!ownerAgent) throw new Error("Printer owner agent not found");
  if (ownerAgent.lifecycle !== "active") throw new Error(`Agent is ${ownerAgent.lifecycle}`);
  if (!ownerAgent.branchId) throw new Error("Printer owner agent has no branch");

  const ownerBranch = await db.query.branches.findFirst({ where: eq(branches.id, ownerAgent.branchId) });
  if (!ownerBranch) throw new Error("Printer owner branch not found");
  if (!ownerBranch.enabled) throw new Error("Printer owner branch is disabled");

  const id = `job_${nanoid(10)}`;
  const row = {
    id,
    branchId: ownerBranch.id,
    agentId: ownerAgent.id,
    printerId: printer.id,
    status: "queued" as const,
    payload: validatedPayload,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  };
  await db.insert(printJobs).values(row);

  try {
    await claimAndPushJobToAgent({ id, agentId: printer.agentId });
  } catch (e) {
    console.warn(`[actions] WS push failed for job ${id}:`, e);
  }

  revalidatePath("/dashboard");
  return { id };
}

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
    if (!owner.branchId) throw new Error("cannot activate printer without owner branch");
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, owner.branchId) });
    if (!branch?.enabled) throw new Error("cannot activate printer while branch is disabled");
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
  if (lifecycle === "active" && agent.branchId) {
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, agent.branchId) });
    if (!branch?.enabled) throw new Error("cannot activate agent while branch is disabled");
  }
  const reenable = agent.lifecycle === "disabled" && lifecycle === "active";
  const pairingCode = reenable ? generatePairingCode() : null;
  await db.transaction(async (tx) => {
    await tx.update(agents).set({
      lifecycle,
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
