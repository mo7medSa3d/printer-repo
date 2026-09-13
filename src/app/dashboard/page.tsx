import { db } from "../../db";
import { agents, printers, printJobs } from "../../db/schema";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "../../lib/manager-auth";
import DashboardClient from "./dashboard-client";
import { JobCleanupButton } from "../../components/JobCleanupButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");

  let allAgents: Array<{
    id: string;
    name: string;
    pairingCode: string | null;
    pairingCodeExpiresAt?: Date | null;
    status: string;
    lifecycle: string;
    metadata: unknown;
    lastSeenAt: Date | null;
    createdAt: Date;
    printerCount: number;
  }> = [];
  let allPrinters: Array<typeof printers.$inferSelect> = [];
  type JobMeta = Omit<typeof printJobs.$inferSelect, "payload">;
  let allJobs: JobMeta[] = [];
  let databaseError: string | null = null;

  try {
    allAgents = await db
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
      .where(eq(agents.tenantId, claims.tenantId))
      .leftJoin(printers, and(eq(printers.agentId, agents.id), eq(printers.tenantId, claims.tenantId)))
      .groupBy(agents.id)
      .orderBy(desc(agents.createdAt));
    allPrinters = await db.select().from(printers).where(eq(printers.tenantId, claims.tenantId)).orderBy(desc(printers.createdAt));
    // Metadata-only projection: `payload` (base64 document bytes, up to ~5 MB
    // per job) must never ride along in the 50-row list. Full payloads are
    // fetched per-job on demand by the inspector via GET /api/jobs/[id].
    const jobColumns = {
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
    } as const;
    allJobs = await db
      .select(jobColumns)
      .from(printJobs)
      .where(eq(printJobs.tenantId, claims.tenantId))
      .orderBy(desc(printJobs.createdAt))
      .limit(50);
  } catch (error: unknown) {
    console.error("[dashboard] database load failed", error);
    databaseError = "PostgreSQL unavailable";
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-6 lg:py-8">
      <header className="mb-7 flex flex-col gap-4 border-b border-edge pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-ink">Management console</h1>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${databaseError ? "border-bad-edge bg-bad-bg text-bad" : "border-edge-accent bg-brand-subtle text-brand-subtle-text"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${databaseError ? "bg-bad-solid" : "bg-ok-solid"}`} aria-hidden />
              {databaseError ? "Database unavailable" : "Live console"}
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink-3">
            Runtime agents, printers, and queue state. Business branches, destinations, and document ownership remain in Odoo.
          </p>
        </div>
        {!databaseError ? <JobCleanupButton /> : null}
      </header>

      {databaseError ? (
        <div role="alert" className="rounded-xl border border-bad-edge bg-bad-bg px-5 py-6 text-sm text-bad shadow-xs">
          <h2 className="font-semibold">Database unavailable</h2>
          <p className="mt-1 text-ink-2">PostgreSQL could not be reached. The console is not displaying an empty healthy state.</p>
        </div>
      ) : (
        <DashboardClient initialAgents={allAgents} initialPrinters={allPrinters} initialJobs={allJobs} databaseError={null} />
      )}
    </div>
  );
}
