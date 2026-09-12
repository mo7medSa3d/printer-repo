"use server";

import { db } from "../db";
import { agents, printers, printJobs, discoverySessions, discoveredDevices } from "../db/schema";
import { eq, count, or, inArray, sql, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { generatePairingCode, hashPairingCode } from "../lib/agent-auth";
import { buildTestPrintPayloadForPrinter } from "../lib/payload";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "../lib/manager-auth";
import { createPrintJobForPrinter } from "../lib/print-job-service";
import { isTerminal, type JobStatus } from "../lib/job-status";
import { canTransitionLifecycle } from "../lib/lifecycle";
import { transitionAgentLifecycle, LifecycleConflict } from "../lib/agent-lifecycle";
import { hasOpenAgentSocket, closeAgentSockets, publishAgentSessionClose } from "../server/ws";
import { ActionError } from "../lib/action-error";

async function requireManager() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) throw new ActionError("Your manager session has expired. Sign in again.", 401);
  return claims;
}

export async function createAgent(name: string) {
  await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) throw new ActionError("Agent name must be 1-200 characters.", 400);
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
  if (typeof id !== "string" || !id.trim()) throw new ActionError("agent id is required", 400);
  const agentId = id.trim();

  // In-memory WebSocket guard: if the agent is actively connected, refuse deletion
  if (hasOpenAgentSocket(agentId)) {
    throw new ActionError("This agent is still connected. Stop the agent service first, then delete it.", 409);
  }

  await db.transaction(async (tx) => {
    // Acquire row-level lock to prevent concurrent state transitions or reconnect races
    const locked = await tx.execute(sql`
      SELECT id, status, lifecycle
      FROM agents
      WHERE id = ${agentId}
      FOR UPDATE
    `);
    const agent = (locked as unknown as { rows?: { id: string; status: string; lifecycle: string }[] }).rows?.[0];
    if (!agent) throw new ActionError("Agent not found", 404);
    if (agent.status === "online") {
      throw new Error("This agent is still connected. Stop the agent service first, then delete it.");
    }
    if (agent.lifecycle === "retired") {
      throw new ActionError("Retired agents are kept for audit history and cannot be deleted.", 409);
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
      throw new ActionError("This agent has print history and cannot be deleted. Choose Retire instead to preserve the audit history.", 409);
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
  void publishAgentSessionClose(agentId).catch(() => { /* best-effort revocation */ });

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
  if (!printer) throw new ActionError("Printer not found", 404);
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!agent) throw new ActionError("The agent that owns this printer is missing.", 500);
  const payload = buildTestPrintPayloadForPrinter(printer.name, agent.name ?? printer.agentId, {
    protocol: printer.protocol,
    connectionType: printer.connectionType,
    capabilities: printer.capabilities,
  });
  const result = await createPrintJobForPrinter(printerId, payload, {
    requestedBy: "manager-test",
    documentType: "test_page",
  });
  revalidatePath("/dashboard");
  return { id: result.id };
}

/**
 * Deliberate operator reprint of an ORIGINAL document after a terminal,
 * possibly-printed outcome. This re-queues the job's stored payload — it is
 * NOT a test page — under a deterministic derived idempotency key
 * ("gw-reprint:{jobId}:{n}") so a double-click cannot create two reprints:
 * concurrent attempts compute the same key and PostgreSQL's idempotency
 * unique index collapses them. Like Odoo's action_force_reprint, physical
 * reprints of unknown outcomes are always an explicit operator action.
 */
export async function reprintJob(jobId: string) {
  await requireManager();
  if (typeof jobId !== "string" || !jobId.trim()) throw new ActionError("job id is required", 400);
  const job = await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId.trim()) });
  if (!job) throw new ActionError("Job not found", 404);
  if (!isTerminal(job.status as JobStatus)) {
    throw new ActionError("Only finished, failed, or expired jobs can be reprinted. The current job is still in progress.", 409);
  }
  const [attempts] = await db
    .select({ c: count() })
    .from(printJobs)
    .where(sql`idempotency_key LIKE ${`gw-reprint:${job.id}:%`}`);
  const derivedKey = `gw-reprint:${job.id}:${Number(attempts?.c ?? 0) + 1}`;
  const result = await createPrintJobForPrinter(job.printerId, job.payload, {
    requestedBy: "manager-reprint",
    idempotencyKey: derivedKey,
    destination: job.destination,
    documentType: job.documentType ?? undefined,
  });
  revalidatePath("/dashboard");
  return { id: result.id, reused: result.isReused === true };
}

export async function setPrinterLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  await requireManager();
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) throw new ActionError("Printer not found", 404);
  if (printer.lifecycle === lifecycle) {
    revalidatePath("/dashboard");
    return;
  }
  if (!canTransitionLifecycle(printer.lifecycle, lifecycle)) throw new ActionError(`This printer cannot go from ${printer.lifecycle} to ${lifecycle}.`, 409);
  if (lifecycle === "active") {
    const owner = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
    if (!owner) throw new ActionError("The agent that owns this printer no longer exists.", 404);
    if (owner.lifecycle !== "active") throw new ActionError(`The agent owning this printer is ${owner.lifecycle}; reactivate the agent first.`, 409);
  }
  await db.update(printers).set({ lifecycle, updatedAt: new Date() }).where(eq(printers.id, id));
  revalidatePath("/dashboard");
}

export async function setAgentLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  await requireManager();
  try {
    const result = await transitionAgentLifecycle(id, lifecycle);
    if (!result) throw new ActionError("Agent not found", 404);
    revalidatePath("/dashboard");
    return { lifecycle: result.lifecycle, pairingCode: result.pairingCode };
  } catch (error) {
    if (error instanceof LifecycleConflict) throw new ActionError(error.message, 409);
    throw error;
  }
}

export async function getDashboardState() {
  await requireManager();
  const allAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      pairingCode: sql<string | null>`NULL`,
      pairingCodeExpiresAt: agents.pairingCodeExpiresAt,
      status: agents.status,
      lifecycle: agents.lifecycle,
      metadata: agents.metadata,
      lastSeenAt: agents.lastSeenAt,
      createdAt: agents.createdAt,
      printerCount: count(printers.id),
    })
    .from(agents)
    .leftJoin(printers, eq(printers.agentId, agents.id))
    .groupBy(agents.id)
    .orderBy(desc(agents.createdAt));

  const allPrinters = await db.select().from(printers).orderBy(desc(printers.createdAt));
  const allJobs = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(50);

  return { agents: allAgents, printers: allPrinters, jobs: allJobs };
}

