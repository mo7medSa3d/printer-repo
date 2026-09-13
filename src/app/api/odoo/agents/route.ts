import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { isAgentAvailableForJob } from "../../../../lib/agent-availability";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req);
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      lifecycle: agents.lifecycle,
      lastSeenAt: agents.lastSeenAt,
    })
    .from(agents)
    .where(eq(agents.lifecycle, "active"))
    .orderBy(asc(agents.name));

  const now = new Date();
  const sanitized = rows.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: isAgentAvailableForJob(agent, now) ? "online" : "offline",
    lifecycle: agent.lifecycle,
    lastSeenAt: agent.lastSeenAt,
  }));

  return NextResponse.json({ agents: sanitized }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
