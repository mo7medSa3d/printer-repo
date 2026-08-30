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
      <h1 className="text-3xl font-bold mb-2">Print Hub Management Console</h1>
      <p className="text-zinc-500 mb-2 italic">Cloud Gateway — Gateway: queued→claimed→printing→success/failed/expired · Agent: queued→printing→success/failed</p>
      <p className="text-xs text-zinc-400 mb-8">Manager session (8h httpOnly, jti revocation) required for this page, its actions, and /api/agents/printers/jobs. Agent auth (Bearer agt:secret) separate. Odoo key separate. WebSocket: Agent ↔ Gateway only. Desktop polls HTTPS.</p>
      <DashboardClient initialAgents={allAgents} initialPrinters={allPrinters} initialJobs={allJobs} />
    </div>
  );
}
