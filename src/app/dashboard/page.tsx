import { db } from "@/db";
import { agents, printers, printJobs } from "@/db/schema";
import { desc } from "drizzle-orm";
import DashboardClient from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let allAgents: Array<(typeof agents.$inferSelect)> = [];
  let allPrinters: Array<(typeof printers.$inferSelect)> = [];
  let allJobs: Array<(typeof printJobs.$inferSelect)> = [];
  try {
    allAgents = await db.select().from(agents).orderBy(desc(agents.createdAt));
    allPrinters = await db.select().from(printers).orderBy(desc(printers.createdAt));
    allJobs = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(50);
  } catch {
    // build without DB — render empty shell; runtime will populate
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-2">Print Hub Management Console</h1>
      <p className="text-zinc-500 mb-2 italic">Cloud Gateway — Gateway: queued→claimed→printing→success/failed/expired · Agent: queued→printing→success/failed</p>
      <p className="text-xs text-zinc-400 mb-8">Manager session (8h httpOnly, jti revocation) required for /api/agents/printers/jobs. Agent auth (Bearer agt:secret) separate. Odoo key separate. WebSocket: Agent ↔ Gateway only. Desktop polls HTTPS.</p>
      <DashboardClient initialAgents={allAgents} initialPrinters={allPrinters} initialJobs={allJobs} />
    </div>
  );
}
