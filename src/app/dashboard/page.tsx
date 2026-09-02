import { db } from "@/db";
import { agents, branches, printers, printJobs } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "@/lib/manager-auth";
import DashboardClient from "./dashboard-client";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // This console renders live print topology + job data straight from PG, so
  // it must enforce the SAME manager-session check as the management API
  // routes — a server component with no guard would anonymously expose it.
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");

  // Explicit column lists: agents.secret (credential hash) must never be
  // serialized into the client bundle. Full printer/job rows are fine here —
  // this view is manager-only.
  let allAgents: Array<{
    id: string;
    branchId: string;
    name: string;
    pairingCode: string | null;
    status: string;
    metadata: unknown;
    lastSeenAt: Date | null;
    createdAt: Date;
  }> = [];
  // Printer rows carry a DERIVED branchId (from the owning agent), never a
  // stored one — printers have no branch column.
  let allPrinters: Array<(typeof printers.$inferSelect) & { branchId: string | null }> = [];
  let allBranches: Array<{ id: string; name: string; enabled: boolean }> = [];
  let allJobs: Array<(typeof printJobs.$inferSelect)> = [];
  let dbUnavailable = false;
  try {
    allAgents = await db
      .select({
        id: agents.id,
        branchId: agents.branchId,
        name: agents.name,
        pairingCode: agents.pairingCode,
        status: agents.status,
        metadata: agents.metadata,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .orderBy(desc(agents.createdAt));
    // branch → agent → printer: the join IS the branch derivation.
    allPrinters = (await db
      .select({ printer: printers, branchId: agents.branchId })
      .from(printers)
      .innerJoin(agents, eq(printers.agentId, agents.id))
      .orderBy(desc(printers.createdAt))).map((r) => ({ ...r.printer, branchId: r.branchId }));
    allBranches = await db.select({ id: branches.id, name: branches.name, enabled: branches.enabled }).from(branches).orderBy(desc(branches.createdAt));
    allJobs = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(50);
  } catch (error) {
    // The database is unreachable. Rendering the normal console with empty
    // arrays and a green "Live" badge would actively mislead the operator into
    // believing there are no agents, printers or jobs — which looks identical
    // to a healthy but empty deployment. Fail visibly instead.
    //
    // The real error goes to the server log (structured, for diagnosis); the
    // page shows no driver text, host, credentials or SQL to the browser.
    logError("dashboard.db_unavailable", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    dbUnavailable = true;
  }

  if (dbUnavailable) {
    return (
      <div className="container mx-auto py-8 px-4">
        <header className="mb-6 border-b border-edge pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-[-0.015em] text-ink">Management console</h1>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-bad-edge bg-bad-bg px-2.5 py-0.5 text-[11px] font-semibold text-bad"
              role="status"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-bad" aria-hidden />
              Database unavailable
            </span>
          </div>
        </header>
        <div role="alert" className="rounded-lg border border-bad-edge bg-bad-bg px-5 py-4">
          <h2 className="text-sm font-semibold text-bad">Cannot reach the database</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-2">
            The console could not read the print topology from PostgreSQL, so it is not showing
            any agents, printers or jobs. <strong>This is not an empty deployment</strong> — the
            current state is simply unknown.
          </p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-2">
            Queued jobs are unaffected and are not lost. Check the gateway&apos;s database
            connectivity; the underlying error has been written to the server log.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <header className="mb-6 border-b border-edge pb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-[-0.015em] text-ink">Management console</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-edge-accent bg-brand-subtle px-2.5 py-0.5 text-[11px] font-semibold text-brand-subtle-text">
            <span className="h-1.5 w-1.5 rounded-full bg-ok-solid" aria-hidden />
            Live
          </span>
        </div>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-ink-2">
          Agents, printers and the job queue, straight from PostgreSQL. A manager session (8h httpOnly, revocable) is required for this page and its actions.
        </p>
      </header>
      <DashboardClient initialAgents={allAgents} initialPrinters={allPrinters} initialJobs={allJobs} initialBranches={allBranches} />
    </div>
  );
}
