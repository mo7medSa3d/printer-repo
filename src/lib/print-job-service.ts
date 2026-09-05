import { db } from "@/db";
import { agents, branches, printers, printJobs } from "@/db/schema";
import { getAgentAvailability } from "@/lib/agent-availability";
import { isVirtualPrinterRecord } from "@/lib/printer-virtual";
import { validatePayloadForPrinter } from "@/lib/routing";
import { validatePrintJobPayload } from "@/lib/payload";
import { claimAndPushJobToAgent } from "@/server/ws";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export const MAX_AGENT_IN_FLIGHT_JOBS = 500;

export class AgentQueueFullError extends Error {
  readonly code = "AGENT_QUEUE_FULL" as const;
  constructor(public readonly agentId: string, public readonly inFlight: number) {
    super(`Agent ${agentId} has reached the maximum of ${MAX_AGENT_IN_FLIGHT_JOBS} in-flight jobs`);
  }
}

export type CreatePrintJobOptions = {
  requestedBy: string;
  idempotencyKey?: string | null;
  destinationId?: string | null;
  documentType?: string | null;
  expiresAt?: Date;
};

export type CreatePrintJobResult = {
  id: string;
  printerId: string;
  agentId: string;
  branchId: string;
  status: "queued" | "claimed";
};

function normalizeRequestedBy(value: string): string {
  const v = value.trim();
  if (!v || v.length > 100) throw new Error("requestedBy is invalid");
  return v;
}

async function insertQueuedJobAtomically({
  jobId,
  printerId,
  agentId,
  branchId,
  validatedPayload,
  expiresAt,
  requestedBy,
  idempotencyKey,
  destinationId,
  documentType,
}: {
  jobId: string;
  printerId: string;
  agentId: string;
  branchId: string;
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt: Date;
  requestedBy: string;
  idempotencyKey?: string | null;
  destinationId?: string | null;
  documentType?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);

    if (idempotencyKey) {
      const existing = await tx.execute(sql`
        SELECT id FROM print_jobs
        WHERE branch_id = ${branchId} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `);
      if (existing.rows.length > 0) {
        const err = new Error("DUPLICATE_JOB");
        Object.assign(err, { code: "DUPLICATE_JOB" });
        throw err;
      }
    }

    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE agent_id = ${agentId}
        AND status IN ('claimed', 'printing')
        AND expires_at > now()
    `);
    const inFlight = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) throw new AgentQueueFullError(agentId, inFlight);

    await tx.insert(printJobs).values({
      id: jobId,
      branchId,
      destinationId: destinationId ?? null,
      documentType: documentType ?? null,
      agentId,
      printerId,
      status: "queued",
      payload: validatedPayload,
      requestedBy,
      idempotencyKey: idempotencyKey ?? null,
      expiresAt,
    });
  });
}

export async function createPrintJobForPrinter(
  printerId: string,
  payload: unknown,
  options: CreatePrintJobOptions,
): Promise<CreatePrintJobResult> {
  if (typeof printerId !== "string" || !printerId.trim()) throw new Error("printer id is required");
  const requestedBy = normalizeRequestedBy(options.requestedBy);

  const printer = await db.query.printers.findFirst({ where: eq(printers.id, printerId.trim()) });
  if (!printer) throw new Error("Printer not found");
  if (printer.lifecycle !== "active") throw new Error(`Printer is ${printer.lifecycle}`);
  if (isVirtualPrinterRecord(printer)) throw new Error("Printer is virtual or redirected");
  if (printer.status !== "online") throw new Error(`Printer is not online (status=${printer.status})`);

  const validatedPayload = validatePrintJobPayload(payload);
  const capability = validatePayloadForPrinter(validatedPayload.type, {
    protocol: printer.protocol,
    connectionType: printer.connectionType,
    capabilities: printer.capabilities,
  });
  if (!capability.ok) throw new Error(capability.reason);

  const ownerAgent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!ownerAgent) throw new Error("Printer owner agent not found");
  const availability = getAgentAvailability(ownerAgent);
  if (!availability.available) {
    throw new Error(`Agent is not available for jobs (reason=${availability.reason})`);
  }
  if (!ownerAgent.branchId) throw new Error("Printer owner agent has no branch");

  const ownerBranch = await db.query.branches.findFirst({ where: eq(branches.id, ownerAgent.branchId) });
  if (!ownerBranch) throw new Error("Printer owner branch not found");
  if (!ownerBranch.enabled) throw new Error("Printer owner branch is disabled");

  const id = `job_${nanoid(12)}`;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("expiresAt must be in the future");
  }

  await insertQueuedJobAtomically({
    jobId: id,
    printerId: printer.id,
    agentId: ownerAgent.id,
    branchId: ownerBranch.id,
    validatedPayload,
    expiresAt,
    requestedBy,
    idempotencyKey: options.idempotencyKey ?? null,
    destinationId: options.destinationId ?? null,
    documentType: options.documentType ?? null,
  });

  let status: "queued" | "claimed" = "queued";
  try {
    const outcome = await claimAndPushJobToAgent({ id, agentId: ownerAgent.id });
    if (outcome === "delivered") status = "claimed";
    if (outcome === "failed") {
      console.warn(`[print-job-service] job ${id} exhausted its delivery budget after a failed WS push`);
    }
  } catch (error) {
    // The durable row is already queued. Delivery is best-effort and polling
    // remains the recovery path; never roll back a successfully persisted job
    // merely because the optional WebSocket fast path failed.
    console.warn(`[print-job-service] WS push failed for job ${id}:`, error);
  }

  return { id, printerId: printer.id, agentId: ownerAgent.id, branchId: ownerBranch.id, status };
}
