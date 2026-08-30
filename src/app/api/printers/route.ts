import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers, agents } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

const createPrinterSchema = z.object({
  id: z.string().regex(/^[a-z0-9_][a-z0-9_-]*$/).optional(),
  agentId: z.string().min(1),
  name: z.string().min(1).max(100),
  type: z.enum(["network", "usb"]),
  enabled: z.boolean().optional(),
  config: z.object({
    ip: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["raw", "escpos", "ipp"]).optional(),
    address: z.string().optional(),
    vid: z.number().optional(),
    pid: z.number().optional(),
  }).passthrough().optional(),
});

function validateNetworkConfig(cfg: Record<string, unknown>, type: string) {
  if (type === "network") {
    const ip = cfg.ip as string | undefined;
    const port = cfg.port as number | undefined;
    if (!ip || typeof ip !== "string") return "network printer requires config.ip";
    if (!port || typeof port !== "number") return "network printer requires config.port";
    // basic ip check
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4.test(ip)) return `invalid ip ${ip}`;
    const parts = ip.split(".").map(Number);
    if (parts.some(n => n < 0 || n > 255)) return `invalid ip ${ip}`;
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

  const parsed = createPrinterSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });

  const data = parsed.data;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, data.agentId) });
  if (!agent) return NextResponse.json({ error: "agentId not found" }, { status: 404 });

  const cfg = (data.config ?? {}) as Record<string, unknown>;
  const err = validateNetworkConfig(cfg, data.type);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const id = data.id ?? `printer_${nanoid(8)}`;
  const existing = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (existing) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });

  const [row] = await db.insert(printers).values({
    id,
    agentId: data.agentId,
    name: data.name,
    type: data.type,
    status: "unknown",
    config: cfg,
    enabled: data.enabled ?? true,
  }).returning();

  return NextResponse.json(row, { status: 201 });
}
