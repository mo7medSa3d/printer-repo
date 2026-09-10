import { agents, printJobs, printers } from "../db/schema";
import { db } from "../db";
import { isVirtualPrinterRecord } from "./printer-virtual";
import { validatePayloadForPrinter } from "./routing";
import { validatePrintJobPayload } from "./payload";
import { claimAndPushJobToAgent } from "../server/ws";
import { logWarn } from "./log";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { canonicalize } from "./canonicalize";
import { MAX_AGENT_IN_FLIGHT_JOBS } from "./job-delivery";

export const MAX_AGENT_QUEUED_JOBS = 1000;
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
export class PrintJobRateLimitError extends Error {
  readonly code = "PRINT_JOB_RATE_LIMITED" as const;
  constructor(public readonly retryAfterSeconds: number) {
    super(`Print job rate limit exceeded; retry after ${retryAfterSeconds} seconds`);
  }
}
export class PrintJobCapabilityError extends Error {
  readonly code = "CAPABILITY_MISMATCH" as const;
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * Expected, operator-safe input/state failures. Routes map these to explicit
 * HTTP statuses; anything NOT of this family is an internal error and must be
 * logged, never echoed to clients.
 */
export class PrintJobInputError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function idempotencyFingerprint(input: {
  printerId: string;
  documentType?: string | null;
  destination?: string | null;
  payload: unknown;
}) {
  return JSON.stringify({
    printerId: input.printerId,
    documentType: input.documentType?.trim().toLowerCase() || null,
    destination: input.destination?.trim() || null,
    payload: canonicalize(input.payload),
  });
}

export type CreatePrintJobOptions = {
  requestedBy: string;
  idempotencyKey?: string | null;
  destination?: string | null;
  documentType?: string | null;
  expiresAt?: Date;
  rateLimitKeyId?: string | null;
};

export type CreatePrintJobResult = {
  id: string;
  printerId: string;
  agentId: string;
  status: string;
  isReused?: boolean;
};

function normalizeRequestedBy(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new PrintJobInputError("requestedBy is invalid", "INVALID_REQUEST", 400);
  return normalized;
}

async function insertQueuedJobAtomically({
  jobId, printerId, agentId, validatedPayload, expiresAt, requestedBy,
  idempotencyKey, destination, documentType, rateLimitKeyId,
}: {
  jobId: string;
  printerId: string;
  agentId: string;
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt: Date;
  requestedBy: string;
  idempotencyKey?: string | null;
  destination?: string | null;
  documentType?: string | null;
  rateLimitKeyId?: string | null;
}): Promise<{ jobId: string; status: string; agentId: string; printerId: string; isReused: boolean }> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);
    if (rateLimitKeyId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:key:${rateLimitKeyId}`}))`);
    }
    if (idempotencyKey) {
      const lockKey = rateLimitKeyId ? `print_jobs:idempotency:${rateLimitKeyId}:${idempotencyKey}` : `print_jobs:idempotency:internal:${idempotencyKey}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    }

    if (idempotencyKey) {
      const existing = rateLimitKeyId
        ? await tx.execute(sql`SELECT id, printer_id, destination, document_type, payload, agent_id, status FROM print_jobs WHERE api_key_id = ${rateLimitKeyId} AND idempotency_key = ${idempotencyKey} LIMIT 1 FOR UPDATE`)
        : await tx.execute(sql`SELECT id, printer_id, destination, document_type, payload, agent_id, status FROM print_jobs WHERE api_key_id IS NULL AND idempotency_key = ${idempotencyKey} LIMIT 1 FOR UPDATE`);
      if (existing.rows.length > 0) {
        const row = existing.rows[0] as {
          id: string;
          printer_id: string;
          destination?: string | null;
          document_type?: string | null;
          payload: unknown;
          agent_id: string;
          status: string;
        };
        const storedFingerprint = idempotencyFingerprint({
          printerId: row.printer_id,
          documentType: row.document_type,
          destination: row.destination,
          payload: row.payload,
        });
        const requestFingerprint = idempotencyFingerprint({
          printerId,
          documentType,
          destination,
          payload: validatedPayload,
        });

        if (storedFingerprint === requestFingerprint) {
          return {
            jobId: row.id,
            status: row.status,
            agentId: row.agent_id,
            printerId: row.printer_id,
            isReused: true,
          };
        }
        const conflictErr = new Error("IDEMPOTENCY_CONFLICT");
        Object.assign(conflictErr, { code: "IDEMPOTENCY_CONFLICT" });
        throw conflictErr;
      }
    }

    const counts = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE agent_id = ${agentId} AND status = 'queued' AND expires_at > now())::int AS agent_queued,
        COUNT(*) FILTER (WHERE agent_id = ${agentId} AND status IN ('claimed', 'printing') AND expires_at > now())::int AS agent_in_flight
      FROM print_jobs WHERE agent_id = ${agentId}
    `);
    const row = counts.rows[0] as { agent_queued?: number | string; agent_in_flight?: number | string } | undefined;
    const agentQueued = Number(row?.agent_queued ?? 0);
    const inFlight = Number(row?.agent_in_flight ?? 0);
    if (agentQueued >= MAX_AGENT_QUEUED_JOBS) throw new AgentQueuedJobsFullError(agentId, agentQueued);
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) throw new AgentQueueFullError(agentId, inFlight);

    if (rateLimitKeyId) {
      const now = new Date();
      const limit = await tx.execute(sql`SELECT minute_window_started_at, minute_count, hour_window_started_at, hour_count
        FROM print_job_rate_limits WHERE api_key_id = ${rateLimitKeyId} FOR UPDATE`);
      const existingLimit = limit.rows[0] as {
        minute_window_started_at?: string | Date; minute_count?: number | string;
        hour_window_started_at?: string | Date; hour_count?: number | string;
      } | undefined;
      if (!existingLimit) {
        await tx.execute(sql`INSERT INTO print_job_rate_limits
          (api_key_id, minute_window_started_at, minute_count, hour_window_started_at, hour_count, updated_at)
          VALUES (${rateLimitKeyId}, ${now}, 1, ${now}, 1, ${now})`);
      } else {
        const minuteStarted = new Date(existingLimit.minute_window_started_at ?? now);
        const hourStarted = new Date(existingLimit.hour_window_started_at ?? now);
        const minuteElapsed = Math.max(0, now.getTime() - minuteStarted.getTime());
        const hourElapsed = Math.max(0, now.getTime() - hourStarted.getTime());
        const nextMinuteCount = minuteElapsed >= 60_000 ? 1 : Number(existingLimit.minute_count ?? 0) + 1;
        const nextHourCount = hourElapsed >= 3_600_000 ? 1 : Number(existingLimit.hour_count ?? 0) + 1;
        if (nextMinuteCount > PRINT_JOB_RATE_LIMIT_PER_MINUTE || nextHourCount > PRINT_JOB_RATE_LIMIT_PER_HOUR) {
          const minuteRetry = minuteElapsed >= 60_000 ? 0 : Math.ceil((60_000 - minuteElapsed) / 1000);
          const hourRetry = hourElapsed >= 3_600_000 ? 0 : Math.ceil((3_600_000 - hourElapsed) / 1000);
          throw new PrintJobRateLimitError(Math.max(1, minuteRetry, hourRetry));
        }
        await tx.execute(sql`UPDATE print_job_rate_limits SET
          minute_window_started_at = ${minuteElapsed >= 60_000 ? now : minuteStarted},
          minute_count = ${nextMinuteCount},
          hour_window_started_at = ${hourElapsed >= 3_600_000 ? now : hourStarted},
          hour_count = ${nextHourCount}, updated_at = ${now}
          WHERE api_key_id = ${rateLimitKeyId}`);
      }
    }

    await tx.insert(printJobs).values({
      id: jobId,
      apiKeyId: rateLimitKeyId ?? null,
      destination: destination ?? null,
      documentType: documentType ?? null,
      agentId,
      printerId,
      status: "queued",
      payload: validatedPayload,
      requestedBy,
      idempotencyKey: idempotencyKey ?? null,
      expiresAt,
    });

    return {
      jobId,
      status: "queued",
      agentId,
      printerId,
      isReused: false,
    };
  });
}

export async function createPrintJobForPrinter(
  printerId: string,
  payload: unknown,
  options: CreatePrintJobOptions,
): Promise<CreatePrintJobResult> {
  const normalizedPrinterId = typeof printerId === "string" ? printerId.trim() : "";
  if (!normalizedPrinterId) throw new PrintJobInputError("printer id is required", "INVALID_REQUEST", 400);
  const requestedBy = normalizeRequestedBy(options.requestedBy);
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, normalizedPrinterId) });
  if (!printer) throw new PrintJobInputError("Printer not found", "PRINTER_NOT_FOUND", 404);
  if (printer.lifecycle !== "active") throw new PrintJobInputError(`Printer is ${printer.lifecycle}`, "PRINTER_UNAVAILABLE", 409);
  if (isVirtualPrinterRecord(printer)) throw new PrintJobInputError("Printer is virtual or redirected", "PRINTER_VIRTUAL", 409);
  if (printer.status !== "online") throw new PrintJobInputError("Printer is not online", "PRINTER_OFFLINE", 503);

  const validatedPayload = validatePrintJobPayload(payload);
  const capability = validatePayloadForPrinter(validatedPayload, {
    protocol: printer.protocol, connectionType: printer.connectionType, capabilities: printer.capabilities,
  });
  if (!capability.ok) throw new PrintJobCapabilityError(capability.reason);

  const ownerAgent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!ownerAgent) throw new PrintJobInputError("Printer owner agent not found", "AGENT_NOT_FOUND", 404);
  if (ownerAgent.lifecycle !== "active") throw new PrintJobInputError(`Agent is ${ownerAgent.lifecycle}`, "AGENT_UNAVAILABLE", 409);

  const id = `job_${nanoid(12)}`;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new PrintJobInputError("expiresAt must be in the future", "INVALID_REQUEST", 400);
  }

  const result = await insertQueuedJobAtomically({
    jobId: id,
    printerId: printer.id,
    agentId: ownerAgent.id,
    validatedPayload,
    expiresAt,
    requestedBy,
    idempotencyKey: options.idempotencyKey ?? null,
    destination: options.destination ?? null,
    documentType: options.documentType ?? null,
    rateLimitKeyId: options.rateLimitKeyId ?? null,
  });

  if (result.isReused) {
    return { id: result.jobId, printerId: result.printerId, agentId: result.agentId, status: result.status, isReused: true };
  }

  try {
    await claimAndPushJobToAgent({ id: result.jobId, agentId: ownerAgent.id });
  } catch (error) {
    logWarn("print.job.ws_push_deferred", { jobId: result.jobId, agentId: ownerAgent.id, error: error instanceof Error ? error.message : String(error) });
  }
  return { id: result.jobId, printerId: printer.id, agentId: ownerAgent.id, status: "queued", isReused: false };
}
