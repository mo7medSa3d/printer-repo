import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents, printers } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeLegacyPrinterInput } from "../../../lib/printer-model";

export const dynamic = "force-dynamic";

function validateConnectionConfig(connectionType: string, cfg: Record<string, unknown>): string | null {
  if (connectionType === "network") {
    if (!cfg.ip || typeof cfg.ip !== "string") return "network printer requires config.ip";
    if (!cfg.port || typeof cfg.port !== "number") return "network printer requires config.port";
    if (cfg.ip.includes(" ")) return "invalid network address";
  }
  if (connectionType === "spooler" && !(typeof cfg.spooler_name === "string" && cfg.spooler_name.trim()) && !(typeof cfg.address === "string" && cfg.address.trim())) {
    return "spooler printer requires config.spooler_name or config.address";
  }
  return null;
}

async function serializePrinters(rows: Array<typeof printers.$inferSelect>) {
  const agentIds = [...new Set(rows.map(r => r.agentId))];
  const ownerRows = agentIds.length ? await db.select({ id: agents.id, branchId: agents.branchId }).from(agents) : [];
  const byId = new Map(ownerRows.map(a => [a.id, a.branchId]));
  return rows.map(({ lifecycle, ...r }) => ({ ...r, lifecycle, branchId: byId.get(r.agentId) ?? null }));
}

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select().from(printers).orderBy(desc(printers.createdAt));
  return NextResponse.json(await serializePrinters(rows));
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    if (body && typeof body === "object" && ("branchId" in body || "enabled" in body)) {
      return NextResponse.json({ error: "branchId/enabled are not writable printer fields; branch derives from agent and lifecycle is authoritative" }, { status: 400 });
    }
    const data = normalizeLegacyPrinterInput(body);
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, data.agentId) });
    if (!agent) return NextResponse.json({ error: "agentId not found" }, { status: 404 });
    if (agent.lifecycle !== "active") return NextResponse.json({ error: `agent is ${agent.lifecycle}` }, { status: 409 });
    const err = validateConnectionConfig(data.connectionType, data.config);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    const id = data.id ?? `printer_${nanoid(8)}`;
    const [row] = await db.insert(printers).values({
      id, agentId: data.agentId, name: data.name, printerType: data.printerType, deviceClass: data.deviceClass,
      connectionType: data.connectionType, protocol: data.protocol, status: "unknown", lifecycle: "active",
      config: data.config, capabilities: data.capabilities ?? null,
    }).returning();
    return NextResponse.json({ ...row, branchId: agent.branchId }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && /already exists|duplicate/i.test(e.message)) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid printer payload" }, { status: 400 });
  }
}
