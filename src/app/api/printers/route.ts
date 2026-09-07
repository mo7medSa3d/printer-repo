import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents, printers } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { parsePrinterInput } from "../../../lib/printer-model";

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

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select().from(printers).orderBy(desc(printers.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    const data = parsePrinterInput(body);
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, data.agentId) });
    if (!agent) return NextResponse.json({ error: "agentId not found" }, { status: 404 });
    if (agent.lifecycle !== "active") return NextResponse.json({ error: `agent is ${agent.lifecycle}` }, { status: 409 });
    const error = validateConnectionConfig(data.connectionType, data.config);
    if (error) return NextResponse.json({ error }, { status: 400 });
    const id = data.id ?? `printer_${nanoid(8)}`;
    const [row] = await db.insert(printers).values({
      id,
      agentId: data.agentId,
      name: data.name,
      printerType: data.printerType,
      deviceClass: data.deviceClass,
      connectionType: data.connectionType,
      protocol: data.protocol,
      status: "unknown",
      lifecycle: "active",
      config: data.config,
      capabilities: data.capabilities ?? null,
    }).returning();
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid printer payload" }, { status: 400 });
  }
}
