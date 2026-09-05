import { db } from "../db";
import { agents, branches, printers, printJobs } from "../db/schema";
import { isVirtualPrinterRecord } from "./printer-virtual";
import { validatePayloadForPrinter } from "./routing";
import { validatePrintJobPayload } from "./payload";
import { claimAndPushJobToAgent } from "../server/ws";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export const MAX_AGENT_IN_FLIGHT_JOBS = 500;
export const MAX_AGENT_QUEUED_JOBS = 1000;
export const MAX_BRANCH_QUEUED_JOBS = 10000;
export const PRINT_JOB_RATE_LIMIT_PER_MINUTE = 60;
export const PRINT_JOB_RATE_LIMIT_PER_HOUR = 1000;

export class AgentQueueFullError extends Error {
  readonly code = "AGENT_QUEUE_FULL" as const;
  constructor(public readonly agentId: string, public readonly inFlight: number) {
    super(`Agent ${agentId} has reached the maximum of ${MAX_AGENT_IN_FLIGHT_JOBS} in-flight jobs`);
  }
}

export class AgentQueuedJobsFullError extends Error {
  readonly code = "AGENT_QUEUED_QUEUE_FULL" as const;
  constructor(public readonly agentId: string, public readonly queued: number) {
    super(`Agent ${agentId} has reached the maximum of ${MAX_AGENT_QUEUED_JOBS} queued jobs`);
  }
}

export class BranchQueuedJobsFullError extends Error {
  readonly code = "BRANCH_QUEUED_QUEUE_FULL" as const;
  constructor(public readonly branchId: string, public readonly queued: number) {
    super(`Branch ${branchId} has reached the maximum of ${MAX_BRANCH_QUEUED_JOBS} queued jobs`);
  }
}

export class PrintJobRateLimitError extends Error {
  readonly code = "PRINT_JOB_RATE_LIMITED" as const;
  constructor(public readonly retryAfterSeconds: number) {
    super(`Print job rate limit exceeded; retry after ${retryAfterSeconds} seconds`);
  }
}

export type CreatePrintJobOptions = {
  requestedBy: string;
  idempotencyKey?: string | null;
  destinationId?: string | null;
  documentType?: string | null;
  expiresAt?: Date;
  /** Stable API-key identity used for distributed throttling. */
  rateLimitKeyId?: string | null;
};

export type CreatePrintJobResult = {
  id: string;
  printerId: string;
  agentId: string;
  branchId: string;
  status: "queued";
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
  rateLimitKeyId,
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
  rateLimitKeyId?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock in deterministic branch -> agent -> key order so concurrent
    // submissions stay race-free without cross-agent/global serialization.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:branch:${branchId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);
    if (rateLimitKeyId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:key:${rateLimitKeyId}`}))`);
    }

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

    const counts = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE agent_id = ${agentId}
            AND status = 'queued'
            AND expires_at > now()
        )::int AS agent_queued,
        COUNT(*) FILTER (
          WHERE agent_id = ${agentId}
            AND status IN ('claimed', 'printing')
            AND expires_at > now()
        )::int AS agent_in_flight,
        COUNT(*) FILTER (
          WHERE branch_id = ${branchId}
            AND status = 'queued'
            AND expires_at > now()
        )::int AS branch_queued
      FROM print_jobs
      WHERE (agent_id = ${agentId} OR branch_id = ${branchId})
    `);
    const row = counts.rows[0] as { agent_queued?: number | string; agent_in_flight?: number | string; branch_queued?: number | string } | undefined;
    const agentQueued = Number(row?.agent_queued ?? 0);
    const inFlight = Number(row?.agent_in_flight ?? 0);
    const branchQueued = Number(row?.branch_queued ?? 0);

    if (agentQueued >= MAX_AGENT_QUEUED_JOBS) throw new AgentQueuedJobsFullError(agentId, agentQueued);
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) throw new AgentQueueFullError(agentId, inFlight);
    if (branchQueued >= MAX_BRANCH_QUEUED_JOBS) throw new BranchQueuedJobsFullError(branchId, branchQueued);

    if (rateLimitKeyId) {
      const now = new Date();
      const limit = await tx.execute(sql`
        SELECT minute_window_started_at, minute_count, hour_window_started_at, hour_count
        FROM print_job_rate_limits
        WHERE api_key_id = ${rateLimitKeyId}
        FOR UPDATE
      `);
      const existing = limit.rows[0] as {
        minute_window_started_at?: string | Date;
        minute_count?: number | string;
        hour_window_started_at?: string | Date;
        hour_count?: number | string;
      } | undefined;

      if (!existing) {
        await tx.execute(sql`
          INSERT INTO print_job_rate_limits
            (api_key_id, minute_window_started_at, minute_count, hour_window_started_at, hour_count, updated_at)
          VALUES (${rateLimitKeyId}, ${now}, 1, ${now}, 1, ${now})
        `);
      } else {
        const minuteStarted = new Date(existing.minute_window_started_at ?? now);
        const hourStarted = new Date(existing.hour_window_started_at ?? now);
        const minuteCount = Number(existing.minute_count ?? 0);
        const hourCount = Number(existing.hour_count ?? 0);
        const minuteElapsed = Math.max(0, now.getTime() - minuteStarted.getTime());
        const hourElapsed = Math.max(0, now.getTime() - hourStarted.getTime());
        const nextMinuteCount = minuteElapsed >= 60_000 ? 1 : minuteCount + 1;
        const nextHourCount = hourElapsed >= 3_600_000 ? 1 : hourCount + 1;

        if (nextMinuteCount > PRINT_JOB_RATE_LIMIT_PER_MINUTE || nextHourCount > PRINT_JOB_RATE_LIMIT_PER_HOUR) {
          const minuteRetry = minuteElapsed >= 60_000 ? 0 : Math.ceil((60_000 - minuteElapsed) / 1000);
          const hourRetry = hourElapsed >= 3_600_000 ? 0 : Math.ceil((3_600_000 - hourElapsed) / 1000);
          throw new PrintJobRateLimitError(Math.max(1, Math.max(minuteRetry, hourRetry)));
        }

        await tx.execute(sql`
          UPDATE print_job_rate_limits
          SET minute_window_started_at = ${minuteElapsed >= 60_000 ? now : minuteStarted},
              minute_count = ${nextMinuteCount},
              hour_window_started_at = ${hourElapsed >= 3_600_000 ? now : hourStarted},
              hour_count = ${nextHourCount},
              updated_at = ${now}
          WHERE api_key_id = ${rateLimitKeyId}
        `);
      }
    }

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
  if (ownerAgent.lifecycle !== "active") throw new Error(`Agent is ${ownerAgent.lifecycle}`);
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
    rateLimitKeyId: options.rateLimitKeyId ?? null,
  });

  try {
    await claimAndPushJobToAgent({ id, agentId: ownerAgent.id });
  } catch (error) {
    console.warn(`[print-job-service] WS push failed for job ${id}:`, error);
  }

  return { id, printerId: printer.id, agentId: ownerAgent.id, branchId: ownerBranch.id, status: "queued" };
}
