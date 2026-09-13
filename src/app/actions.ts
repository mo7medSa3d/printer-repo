"use server";

import { db } from "../db";
import { agents, printers, printJobs, discoverySessions, discoveredDevices } from "../db/schema";
import { eq, count, or, and, inArray, sql, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { generatePairingCode, hashPairingCode } from "../lib/agent-auth";
import { buildTestPrintPayloadForPrinter } from "../lib/payload";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "../lib/manager-auth";
import { createPrintJobForPrinter } from "../lib/print-job-service";
import {
  isTerminal,
  isJobFilterStatus,
  derivePhysicalOutcome,
  PHYSICAL_OUTCOME_UNKNOWN_MARKERS,
  type JobStatus,
} from "../lib/job-status";
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
  const manager = await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) throw new ActionError("Agent name must be 1-200 characters.", 400);
  // 0032 guarantees that no two rows share a pending pairing-code hash
  // (the register route looks codes up without a tenant boundary), so
  // regenerate on the astronomically rare collision instead of letting
  // the INSERT violate the constraint and mint an ambiguous code.
  let pairingCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generatePairingCode();
    const clash = await db.query.agents.findFirst({
      where: eq(agents.pairingCodeHash, hashPairingCode(candidate)),
      columns: { id: true },
    });
    if (!clash) {
      pairingCode = candidate;
      break;
    }
  }
  if (!pairingCode) throw new ActionError("Could not mint a unique pairing code. Try again.", 500);
  const id = `agt_${nanoid(8)}`;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 10);
  await db.insert(agents).values({
    id, tenantId: manager.tenantId, name: name.trim(),
    pairingCodeHash: hashPairingCode(pairingCode),
    pairingCodeExpiresAt: expiresAt,
    status: "offline", lifecycle: "active",
  });
  revalidatePath("/dashboard");
  return { id, pairingCode, expiresAt, expires_at: expiresAt.toISOString() };
}

export async function deleteAgent(id: string) {
  const manager = await requireManager();
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
      WHERE id = ${agentId} AND tenant_id = ${manager.tenantId}
      FOR UPDATE
    `);
    const agent = (locked as unknown as { rows?: { id: string; status: string; lifecycle: string }[] }).rows?.[0];
    if (!agent) throw new ActionError("Agent not found", 404);
    if (agent.status === "online") {
      throw new ActionError("This agent is still connected. Stop the agent service first, then delete it.", 409);
    }
    if (agent.lifecycle === "retired") {
      throw new ActionError("Retired agents are kept for audit history and cannot be deleted.", 409);
    }

    // Referential integrity: check if this agent or any of its printers have historical print jobs
    const agentPrinters = await tx.select({ id: printers.id }).from(printers).where(and(eq(printers.agentId, agent.id), eq(printers.tenantId, manager.tenantId)));
    const printerIds = agentPrinters.map((p) => p.id);
    const jobConditions = [and(eq(printJobs.agentId, agent.id), eq(printJobs.tenantId, manager.tenantId))];
    if (printerIds.length > 0) {
      jobConditions.push(and(inArray(printJobs.printerId, printerIds), eq(printJobs.tenantId, manager.tenantId)));
    }
    const [{ c: jobCount }] = await tx
      .select({ c: count() })
      .from(printJobs)
      .where(or(...jobConditions));

    if (Number(jobCount ?? 0) > 0) {
      throw new ActionError("This agent has print history and cannot be deleted. Choose Retire instead to preserve the audit history.", 409);
    }

    // Clean removable transient discovery runtime records
    await tx.delete(discoveredDevices).where(and(eq(discoveredDevices.agentId, agent.id), eq(discoveredDevices.tenantId, manager.tenantId)));
    await tx.delete(discoverySessions).where(and(eq(discoverySessions.agentId, agent.id), eq(discoverySessions.tenantId, manager.tenantId)));

    // Clean removable runtime printers registered by this agent
    await tx.delete(printers).where(and(eq(printers.agentId, agent.id), eq(printers.tenantId, manager.tenantId)));

    // Permanently delete the agent
    await tx.delete(agents).where(and(eq(agents.id, agent.id), eq(agents.tenantId, manager.tenantId)));
  });

  // Terminate any remaining socket connections and publish revocation across cluster
  try { closeAgentSockets(agentId); } catch {}
  void publishAgentSessionClose(agentId).catch(() => { /* best-effort revocation */ });

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function createPrintJob(printerId: string, payload: unknown) {
  const manager = await requireManager();
  const result = await createPrintJobForPrinter(printerId, payload, { requestedBy: "manager", tenantId: manager.tenantId });
  revalidatePath("/dashboard");
  return { id: result.id };
}

export async function createTestPrintJob(printerId: string) {
  const manager = await requireManager();
  const printer = await db.query.printers.findFirst({ where: and(eq(printers.id, printerId), eq(printers.tenantId, manager.tenantId)) });
  if (!printer) throw new ActionError("Printer not found", 404);
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, manager.tenantId)) });
  if (!agent) throw new ActionError("The agent that owns this printer is missing.", 500);
  try {
    const payload = buildTestPrintPayloadForPrinter(printer.name, agent.name ?? printer.agentId, {
      protocol: printer.protocol,
      connectionType: printer.connectionType,
      capabilities: printer.capabilities,
    });
    const result = await createPrintJobForPrinter(printerId, payload, {
      requestedBy: "manager-test",
      documentType: "test_page",
      tenantId: manager.tenantId,
    });
    revalidatePath("/dashboard");
    return { id: result.id };
  } catch (error) {
    if (error instanceof ActionError) throw error;
    const msg = error instanceof Error ? error.message : "Failed to generate or queue test page";
    throw new ActionError(msg, 400);
  }
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
  const manager = await requireManager();
  if (typeof jobId !== "string" || !jobId.trim()) throw new ActionError("job id is required", 400);
  const job = await db.query.printJobs.findFirst({ where: and(eq(printJobs.id, jobId.trim()), eq(printJobs.tenantId, manager.tenantId)) });
  if (!job) throw new ActionError("Job not found", 404);
  if (!isTerminal(job.status as JobStatus)) {
    throw new ActionError("Only finished, failed, or expired jobs can be reprinted. The current job is still in progress.", 409);
  }
  const [attempts] = await db
    .select({ c: count() })
    .from(printJobs)
    .where(and(eq(printJobs.tenantId, manager.tenantId), sql`idempotency_key LIKE ${`gw-reprint:${job.id}:%`}`));
  const derivedKey = `gw-reprint:${job.id}:${Number(attempts?.c ?? 0) + 1}`;
  const result = await createPrintJobForPrinter(job.printerId, job.payload, {
    requestedBy: "manager-reprint",
    idempotencyKey: derivedKey,
    destination: job.destination,
    documentType: job.documentType ?? undefined,
    tenantId: manager.tenantId,
  });
  revalidatePath("/dashboard");
  return { id: result.id, reused: result.isReused === true };
}

export async function setPrinterLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  const manager = await requireManager();
  const printer = await db.query.printers.findFirst({ where: and(eq(printers.id, id), eq(printers.tenantId, manager.tenantId)) });
  if (!printer) throw new ActionError("Printer not found", 404);
  if (printer.lifecycle === lifecycle) {
    revalidatePath("/dashboard");
    return;
  }
  if (!canTransitionLifecycle(printer.lifecycle, lifecycle)) throw new ActionError(`This printer cannot go from ${printer.lifecycle} to ${lifecycle}.`, 409);
  if (lifecycle === "active") {
    const owner = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, manager.tenantId)) });
    if (!owner) throw new ActionError("The agent that owns this printer no longer exists.", 404);
    if (owner.lifecycle !== "active") throw new ActionError(`The agent owning this printer is ${owner.lifecycle}; reactivate the agent first.`, 409);
  }
  await db.update(printers).set({ lifecycle, updatedAt: new Date() }).where(and(eq(printers.id, id), eq(printers.tenantId, manager.tenantId)));
  revalidatePath("/dashboard");
}

export async function setAgentLifecycle(id: string, lifecycle: "active" | "disabled" | "retired") {
  const manager = await requireManager();
  try {
    const result = await transitionAgentLifecycle(id, lifecycle, manager.tenantId);
    if (!result) throw new ActionError("Agent not found", 404);
    revalidatePath("/dashboard");
    return { lifecycle: result.lifecycle, pairingCode: result.pairingCode };
  } catch (error) {
    if (error instanceof LifecycleConflict) throw new ActionError(error.message, 409);
    throw error;
  }
}

export async function getDashboardState() {
  const manager = await requireManager();
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
    .leftJoin(printers, and(eq(printers.agentId, agents.id), eq(printers.tenantId, manager.tenantId)))
    .where(eq(agents.tenantId, manager.tenantId))
    .groupBy(agents.id)
    .orderBy(desc(agents.createdAt));

  const allPrinters = await db.select().from(printers).where(eq(printers.tenantId, manager.tenantId)).orderBy(desc(printers.createdAt));
  // Metadata-only projection (same contract as the dashboard page): the
  // 50-row list must not carry multi-MB base64 payload blobs into the
  // browser on every poll; the inspector fetches payloads per job.
  const allJobs = await db
    .select({
      id: printJobs.id,
      tenantId: printJobs.tenantId,
      apiKeyId: printJobs.apiKeyId,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      idempotencyKey: printJobs.idempotencyKey,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      claimToken: printJobs.claimToken,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    })
    .from(printJobs)
    .where(eq(printJobs.tenantId, manager.tenantId))
    .orderBy(desc(printJobs.createdAt))
    .limit(50);

  return { agents: allAgents, printers: allPrinters, jobs: allJobs };
}

export async function getDashboardJobs(options?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const manager = await requireManager();
  const statusParam = options?.status?.trim().toLowerCase();
  const searchParam = options?.search?.trim();
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const offset = Math.max(options?.offset ?? 0, 0);

  if (statusParam && !isJobFilterStatus(statusParam)) {
    throw new ActionError("Invalid status filter", 400);
  }

  const conditions = [eq(printJobs.tenantId, manager.tenantId)];

  if (statusParam && statusParam !== "all") {
    if (statusParam === "active" || statusParam === "in_flight") {
      conditions.push(inArray(printJobs.status, ["queued", "claimed", "printing"]));
    } else if (statusParam === "queued" || statusParam === "claimed" || statusParam === "printing" || statusParam === "expired") {
      conditions.push(eq(printJobs.status, statusParam));
    } else if (statusParam === "success" || statusParam === "printed") {
      conditions.push(eq(printJobs.status, "success"));
    } else if (statusParam === "unknown" || statusParam === "attention") {
      conditions.push(
        or(...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`${printJobs.error} LIKE ${m + "%"}`))
      );
    } else if (statusParam === "failed") {
      conditions.push(
        and(
          eq(printJobs.status, "failed"),
          ...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`COALESCE(${printJobs.error}, '') NOT LIKE ${m + "%"}`)
        )
      );
    } else if (statusParam === "unassigned") {
      conditions.push(
        or(
          eq(printJobs.destination, "unassigned"),
          eq(printJobs.printerId, "unassigned"),
          sql`${printJobs.printerId} NOT IN (SELECT id FROM printers WHERE lifecycle = 'active')`,
          sql`${printJobs.agentId} NOT IN (SELECT id FROM agents WHERE lifecycle = 'active')`
        )
      );
    }
  }

  if (searchParam) {
    const term = `%${searchParam.toLowerCase()}%`;
    conditions.push(
      or(
        sql`LOWER(${printJobs.id}) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.destination}, '')) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.documentType}, '')) LIKE ${term}`,
        sql`LOWER(${printJobs.printerId}) LIKE ${term}`,
        sql`LOWER(${printJobs.agentId}) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.error}, '')) LIKE ${term}`
      )
    );
  }

  const rows = await db
    .select({
      id: printJobs.id,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      idempotencyKey: printJobs.idempotencyKey,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    })
    .from(printJobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(printJobs.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    ...row,
    physicalOutcome: derivePhysicalOutcome(row.status, row.error),
  }));
}


