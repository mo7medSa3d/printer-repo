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

export async function createAgent(name: string) {
  await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
    throw new Error("invalid agent name");
  }
  const pairingCode = generatePairingCode();
  const id = `agt_${nanoid(8)}`;

  // Default to 'default' branch for dashboard-created agents; manager can reassign later
  const defaultBranch = await db.query.branches.findFirst({ where: eq(branches.id, "default") });
  const branchId = defaultBranch?.id ?? (await db.query.branches.findFirst({}))?.id ?? "default";
  await db.insert(agents).values({
    id,
    branchId,
    name: name.trim(),
    pairingCode,
    pairingCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30), // 30 mins
    status: "offline",
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
  if (printer.enabled === false) throw new Error("Printer is disabled");

  // Reject malformed/unsupported payloads here too (defense in depth) -
  // the agent enforces the same contract independently.
  const validatedPayload = validatePrintJobPayload(payload);

  const id = `job_${nanoid(10)}`;
  const row = {
    id,
    branchId: (printer as any).branchId ?? "default",
    agentId: printer.agentId,
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

export async function deleteAgent(id: string) {
  await requireManager();
  await db.delete(agents).where(eq(agents.id, id));
  revalidatePath("/dashboard");
}
