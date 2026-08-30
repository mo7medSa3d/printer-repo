import { db } from "@/db";
import { agents, printers, printJobs } from "@/db/schema";
import { sql, eq, count } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    // Lightweight counts for Tauri health polling (no auth required)
    let agentCounts: { total: number; online: number } = { total: 0, online: 0 };
    let printerCounts: { total: number; online: number } = { total: 0, online: 0 };
    let jobCounts: { queued: number; failed: number } = { queued: 0, failed: 0 };
    try {
      const [aTotal] = await db.select({ c: count() }).from(agents);
      const [aOnline] = await db.select({ c: count() }).from(agents).where(eq(agents.status, "online"));
      const [pTotal] = await db.select({ c: count() }).from(printers);
      const [pOnline] = await db.select({ c: count() }).from(printers).where(eq(printers.status, "online"));
      const [jQueued] = await db.select({ c: count() }).from(printJobs).where(eq(printJobs.status, "queued"));
      const [jFailed] = await db.select({ c: count() }).from(printJobs).where(eq(printJobs.status, "failed"));
      agentCounts = { total: aTotal?.c ?? 0, online: aOnline?.c ?? 0 };
      printerCounts = { total: pTotal?.c ?? 0, online: pOnline?.c ?? 0 };
      jobCounts = { queued: jQueued?.c ?? 0, failed: jFailed?.c ?? 0 };
    } catch {
      // counts are best-effort; health is still ok if db is reachable
    }
    return Response.json({ ok: true, agents: agentCounts, printers: printerCounts, jobs: jobCounts });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
