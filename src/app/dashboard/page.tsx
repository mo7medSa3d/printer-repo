import { db } from "@/db";
import { agents, printers, printJobs } from "@/db/schema";
import { desc } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getManagerCookieName, verifyManagerToken, validateManagerClaims } from "@/lib/manager-auth";
import DashboardClient from "./dashboard-client";

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
    name: string;
    pairingCode: string | null;
    status: string;
    metadata: unknown;
    lastSeenAt: Date | null;
    createdAt: Date;
  }> = [];
  let allPrinters: Array<(typeof printers.$inferSelect)> = [];
  let allJobs: Array<(typeof printJobs.$inferSelect)> = [];
  try {
    allAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        pairingCode: agents.pairingCode,
        status: agents.status,
        metadata: agents.metadata,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .orderBy(desc(agents.createdAt));
    allPrinters = await db.select().from(printers).orderBy(desc(printers.createdAt));
    allJobs = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(50);
  } catch {
    // DB momentarily unreachable — render empty shell; runtime will populate
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-ink">Management console</h1>
        <span className="rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-[11px] font-medium text-ink-3">live</span>
      </div>
      <p className="text-sm text-ink-2 mt-1">Agents, printers and the job queue, straight from PostgreSQL. A manager session (8h httpOnly, revocable) is required for this page and its actions.</p>
      <DashboardClient initialAgents={allAgents} initialPrinters={allPrinters} initialJobs={allJobs} />
    </div>
  );
}
