"use server";

import { db } from "@/db";
import { agents, branches, localNetworks, printers, printJobs } from "@/db/schema";
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
/**
 * Create an agent.
 *
 * `branchId` is REQUIRED and never inferred. The agent is the single owner of
 * branch context for every printer it reports, so guessing the branch (the
 * "default", or the only branch that happens to exist today) would silently
 * decide printer ownership on the operator's behalf — and would quietly start
 * being wrong the moment a second branch is created.
 *
 * `localNetworkId` is optional, but if given it must belong to the SAME branch:
 * otherwise the agent would sit in one branch while being discovered on another
 * branch's network, re-introducing a cross-branch ownership inconsistency.
 */
export async function createAgent(name: string, branchId: string, localNetworkId?: string) {
  await requireManager();
  if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
    throw new Error("invalid agent name");
  }
  if (typeof branchId !== "string" || !branchId.trim()) {
    throw new Error("branchId is required: an agent must be created in an explicit branch");
  }
  const pairingCode = generatePairingCode();
  const id = `agt_${nanoid(8)}`;

  const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId.trim()) });
  if (!branch) throw new Error(`branch ${branchId} not found`);
  if (branch.enabled === false) throw new Error(`branch ${branchId} is disabled`);
  const resolvedBranchId = branch.id;

  let resolvedLocalNetworkId: string | null = null;
  if (typeof localNetworkId === "string" && localNetworkId.trim()) {
    const net = await db.query.localNetworks.findFirst({ where: eq(localNetworks.id, localNetworkId.trim()) });
    if (!net) throw new Error(`local network ${localNetworkId} not found`);
    if (net.branchId !== resolvedBranchId) {
      throw new Error(
        `local network ${net.id} belongs to branch ${net.branchId}, not to branch ${resolvedBranchId}: an agent and its local network must be in the same branch`
      );
    }
    resolvedLocalNetworkId = net.id;
  }

  await db.insert(agents).values({
    id,
    branchId: resolvedBranchId,
    localNetworkId: resolvedLocalNetworkId,
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

/* ---------------------------------------------------------------------------
 * Lifecycle
 *
 * Agents and printers are RUNTIME entities that historical print jobs point at
 * (print_jobs.agent_id / printer_id are NOT NULL foreign keys). Hard-deleting
 * them either fails outright or would require destroying audit history, so the
 * supported operations are lifecycle transitions, not deletion:
 *
 *   active   — normal operation
 *   disabled — temporarily out of service; credentials still valid, but no new
 *              work is routed to it. REVERSIBLE.
 *   retired  — permanently decommissioned; runtime credentials destroyed.
 *              TERMINAL — there is no way back.
 *
 * Both states preserve every job, binding and relationship needed to inspect
 * history. Retiring an agent cascades to its printers, because a printer that
 * cannot be reached through its agent cannot print.
 *
 * WHY `retired` IS TERMINAL
 * -------------------------
 * Retirement destroys the agent's credential (`secret` is set to NULL, not
 * archived). Nothing can restore it, so "un-retiring" could only ever produce
 * an agent that no device can authenticate as — an entity that looks live in
 * the console but is permanently unreachable. That is strictly worse than
 * having no record at all, because it invites an operator to route work to it.
 *
 * Retirement is also the state operators use to assert "this hardware is gone".
 * Allowing it to be reversed would let a decommissioned machine's identity be
 * silently resurrected and pointed at a different physical device, while its
 * historical jobs still claim to have been printed by "that" agent.
 *
 * The correct way to bring a machine back is to create a NEW agent in the
 * intended branch and pair it. It gets a fresh id, a fresh credential and a
 * clean audit trail, and the retired record stays an honest historical fact.
 *
 * Use `disabled` for anything temporary.
 * ------------------------------------------------------------------------ */

export type AgentLifecycleState = "active" | "disabled" | "retired";
export type PrinterLifecycleState = "active" | "disabled" | "retired";

/**
 * Move an agent through its lifecycle. Retiring revokes the agent's runtime
 * credentials (so heartbeat/poll/WS auth stops working) and cascades to its
 * printers in the SAME transaction — leaving printers active under a retired
 * agent would advertise routes that can never be delivered.
 */
export async function setAgentLifecycle(id: string, state: AgentLifecycleState) {
  await requireManager();
  if (state !== "active" && state !== "disabled" && state !== "retired") {
    throw new Error(`invalid agent lifecycle state: ${state}`);
  }
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) throw new Error("Agent not found");

  // `retired` is TERMINAL. Refuse every transition out of it, including
  // retired -> retired, so the intent of the refusal is unambiguous.
  if (agent.status === "retired") {
    throw new Error(
      `agent ${id} is retired: retirement is permanent and cannot be undone. ` +
      `Its credential was destroyed, so no device could authenticate as it again. ` +
      `Create a new agent in the target branch and pair it instead.`
    );
  }

  await db.transaction(async (tx) => {
    if (state === "retired") {
      await tx.update(agents).set({
        status: "retired",
        // Revoke runtime credentials: the stored value is a hash, and no hash
        // input produces NULL, so every future authenticated call fails.
        secret: null,
        pairingCode: null,
        pairingCodeExpiresAt: null,
        updatedAt: new Date(),
      }).where(eq(agents.id, id));
      // A retired agent's printers are unreachable by definition.
      await tx.update(printers).set({ enabled: false, status: "retired", updatedAt: new Date() })
        .where(eq(printers.agentId, id));
    } else if (state === "disabled") {
      await tx.update(agents).set({ status: "disabled", updatedAt: new Date() }).where(eq(agents.id, id));
      await tx.update(printers).set({ enabled: false, updatedAt: new Date() }).where(eq(printers.agentId, id));
    } else {
      // Reactivation from `disabled` only (retired was rejected above).
      // Printers are re-enabled deliberately, one at a time: a printer disabled
      // for its own reason (paper jam, decommissioned hardware) must not
      // silently come back.
      await tx.update(agents).set({ status: "offline", updatedAt: new Date() }).where(eq(agents.id, id));
    }
  });

  revalidatePath("/dashboard");
}

/**
 * Move a printer through its lifecycle. A disabled or retired printer is never
 * selected for new jobs (routing checks `enabled`), but its historical jobs and
 * bindings remain intact and queryable.
 *
 * As with agents, `retired` is TERMINAL: it records that the physical device is
 * gone. Reversing it would let a decommissioned printer's identity — and its
 * job history — be silently transferred to different hardware. Register the
 * replacement as a new printer instead; the agent's next heartbeat does this
 * automatically.
 */
export async function setPrinterLifecycle(id: string, state: PrinterLifecycleState) {
  await requireManager();
  if (state !== "active" && state !== "disabled" && state !== "retired") {
    throw new Error(`invalid printer lifecycle state: ${state}`);
  }
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) throw new Error("Printer not found");

  // Terminal: no transition out of `retired`, in either direction.
  if (printer.status === "retired") {
    throw new Error(
      `printer ${id} is retired: retirement is permanent and cannot be undone. ` +
      `Register the replacement device as a new printer (the owning agent's next ` +
      `heartbeat will do this automatically) so its job history stays distinct.`
    );
  }

  if (state === "retired") {
    await db.update(printers).set({ enabled: false, status: "retired", updatedAt: new Date() }).where(eq(printers.id, id));
  } else if (state === "disabled") {
    await db.update(printers).set({ enabled: false, updatedAt: new Date() }).where(eq(printers.id, id));
  } else {
    // Re-enable from `disabled`. The next heartbeat establishes the real status.
    await db.update(printers).set({ enabled: true, updatedAt: new Date() }).where(eq(printers.id, id));
  }
  revalidatePath("/dashboard");
}

/**
 * Hard delete, restricted to genuinely unused agents.
 *
 * This is NOT the normal decommissioning path — use `setAgentLifecycle(id,
 * "retired")`. Deletion is only permitted when nothing references the agent,
 * so it can never destroy print history. Each dependency is reported
 * explicitly rather than surfacing an opaque foreign-key error.
 */
export async function deleteAgent(id: string) {
  await requireManager();
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) throw new Error("Agent not found");

  const jobs = await db.select({ id: printJobs.id }).from(printJobs).where(eq(printJobs.agentId, id)).limit(1);
  if (jobs.length > 0) {
    throw new Error(
      `agent ${id} has print history and cannot be deleted — retire it instead (its jobs, printers and audit trail are preserved)`
    );
  }
  const ownedPrinters = await db.select({ id: printers.id }).from(printers).where(eq(printers.agentId, id));
  if (ownedPrinters.length > 0) {
    throw new Error(
      `agent ${id} still owns ${ownedPrinters.length} printer(s) (${ownedPrinters.map((p) => p.id).join(", ")}) — a printer cannot exist without an agent, so remove or reassign them first, or retire the agent instead`
    );
  }

  await db.delete(agents).where(eq(agents.id, id));
  revalidatePath("/dashboard");
}
