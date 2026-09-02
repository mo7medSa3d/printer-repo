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
import { loadPrinterWithBranch } from "@/lib/printer-branch";

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

/**
 * Create (and pair) an agent.
 *
 * The agent IS the branch anchor: every printer it later discovers belongs to
 * this branch, derived through the agent. The branch is therefore an explicit,
 * validated input at creation time rather than something guessed afterwards.
 * A single configured branch is used implicitly (unambiguous); with several
 * branches the caller must choose, because picking one arbitrarily would place
 * real hardware in the wrong location.
 */
export async function createAgent(name: string, branchId?: string) {
  await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
    throw new Error("invalid agent name");
  }
  const pairingCode = generatePairingCode();
  const id = `agt_${nanoid(8)}`;

  let resolvedBranchId: string;
  if (typeof branchId === "string" && branchId.trim()) {
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId.trim()) });
    if (!branch) throw new Error(`branch ${branchId} not found`);
    if (branch.enabled === false) throw new Error(`branch ${branchId} is disabled`);
    resolvedBranchId = branch.id;
  } else {
    const all = await db.select({ id: branches.id, enabled: branches.enabled }).from(branches);
    const enabled = all.filter((b) => b.enabled !== false);
    if (enabled.length === 0) throw new Error("no branch configured — create a branch before registering an agent");
    if (enabled.length > 1) {
      throw new Error("branchId is required: an agent owns its printers' branch, so it must be assigned explicitly when several branches exist");
    }
    resolvedBranchId = enabled[0].id;
  }

  await db.insert(agents).values({
    id,
    branchId: resolvedBranchId,
    name: name.trim(),
    pairingCode,
    pairingCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30), // 30 mins
    status: "offline",
  });

  revalidatePath("/dashboard");
  return { id, pairingCode, branchId: resolvedBranchId };
}

export async function createPrintJob(printerId: string, payload: unknown) {
  await requireManager();
  // The job's branch is the printer's branch, DERIVED through its agent
  // (printer → agent → branch). There is no printer.branchId and no
  // "default branch" fallback: an unresolvable chain is a hard error, because
  // silently stamping a job with the wrong branch would break both routing
  // audit trails and branch-scoped authorization.
  const loaded = await loadPrinterWithBranch(printerId);
  if (!loaded.ok) {
    if (loaded.error === "PRINTER_NOT_FOUND") throw new Error("Printer not found");
    throw new Error(loaded.message);
  }
  const printer = loaded.printer;
  if (printer.enabled === false) throw new Error("Printer is disabled");

  // Reject malformed/unsupported payloads here too (defense in depth) -
  // the agent enforces the same contract independently.
  const validatedPayload = validatePrintJobPayload(payload);

  const id = `job_${nanoid(10)}`;
  const row = {
    id,
    // Historical/routing context on the job row: the branch this job was
    // actually routed through. Recorded at creation time for auditability and
    // for branch-scoped authorization of later reads — it is NOT printer
    // ownership (that lives on the agent).
    branchId: printer.branchId,
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
  const loaded = await loadPrinterWithBranch(printerId);
  if (!loaded.ok) {
    if (loaded.error === "PRINTER_NOT_FOUND") throw new Error("Printer not found");
    throw new Error(loaded.message);
  }
  const printer = loaded.printer;
  const payload = buildTestPrintPayload(printer.name, printer.agent?.name ?? printer.agentId);
  return createPrintJob(printerId, payload);
}

export async function deleteAgent(id: string) {
  await requireManager();
  await db.delete(agents).where(eq(agents.id, id));
  revalidatePath("/dashboard");
}
