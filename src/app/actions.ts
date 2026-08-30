"use server";

import { db } from "@/db";
import { agents, printers, printJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { generatePairingCode } from "@/lib/agent-auth";
import { validatePrintJobPayload, buildTestPrintPayload } from "@/lib/payload";

export async function createAgent(name: string) {
  const pairingCode = generatePairingCode();
  const id = `agt_${nanoid(8)}`;

  await db.insert(agents).values({
    id,
    name,
    pairingCode,
    pairingCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 30), // 30 mins
    status: "offline",
  });

  revalidatePath("/dashboard");
  return { id, pairingCode };
}

export async function createPrintJob(printerId: string, payload: unknown) {
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
    agentId: printer.agentId,
    printerId: printer.id,
    status: "queued" as const,
    payload: validatedPayload,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
  };
  await db.insert(printJobs).values(row);

  // Best-effort WS push (polling fallback covers offline agent)
  try {
    const { tryPushJob } = await import("@/server/ws");
    tryPushJob({ id, agentId: printer.agentId, printerId: printer.id, payload: validatedPayload, expiresAt: row.expiresAt });
  } catch {}

  revalidatePath("/dashboard");
  return { id };
}

/**
 * A real test print, not just a connectivity check: sends an actual
 * ESC/POS test payload through the same job pipeline every other job
 * uses (queued -> claimed -> printing -> success/failed).
 */
export async function createTestPrintJob(printerId: string) {
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
  await db.delete(agents).where(eq(agents.id, id));
  revalidatePath("/dashboard");
}
