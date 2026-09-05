import { db } from "../../db";
import { agents, branches, printers, printJobs } from "../../db/schema";
import { count, desc, eq } from "drizzle-orm";
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
    status: string;
    lifecycle: string;
    branchId: string;
    metadata: unknown;
    lastSeenAt: Date | null;
    createdAt: Date;
    printerCount: number;
  }> = [];
  let allBranches: Array<{ id: string; name: string; enabled: boolean }> = [];
  let allPrinters: Array<typeof printers.$inferSelect> = [];
  let allJobs: Array<typeof printJobs.$inferSelect> = [];
  let databaseError: string | null = null;

  try {
    allAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        pairingCode: agents.pairingCode,
        status: agents.status,
        lifecycle: agents.lifecycle,
        branchId: agents.branchId,
        metadata: agents.metadata,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
        printerCount: count(printers.id),
      })
      .from(agents)
      .leftJoin(printers, eq(printers.agentId, agents.id))
      .groupBy(agents.id)
      .orderBy(desc(agents.createdAt));
    allBranches = await db
      .select({ id: branches.id, name: branches.name, enabled: branches.enabled })
      .from(branches)
      .orderBy(desc(branches.createdAt));
    allPrinters = await db.select().from(printers).orderBy(desc(printers.createdAt));
    allJobs = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(50);
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
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                databaseError
                  ? "border-bad-edge bg-bad-bg text-bad"
                  : "border-edge-accent bg-brand-subtle text-brand-subtle-text"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${databaseError ? "bg-bad-solid" : "bg-ok-solid"}`} aria-hidden />
              {databaseError ? "Database unavailable" : "Live"}
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink-3">
            Agents, printers and the job queue, straight from PostgreSQL. Secure manager access
            protects the console and all management actions.
          </p>
        </div>
        {!databaseError ? <JobCleanupButton /> : null}
      </header>

      {databaseError ? (
        <div role="alert" className="rounded-xl border border-bad-edge bg-bad-bg px-5 py-6 text-sm text-bad shadow-xs">
          <h2 className="font-semibold">Database unavailable</h2>
          <p className="mt-1 text-ink-2">
            PostgreSQL could not be reached. The console is not displaying an empty healthy state.
            Check gateway logs and database connectivity, then reload the page.
          </p>
        </div>
      ) : (
        <DashboardClient
          initialBranches={allBranches}
          initialAgents={allAgents}
          initialPrinters={allPrinters}
          initialJobs={allJobs}
          databaseError={null}
        />
      )}
    </div>
  );
}
