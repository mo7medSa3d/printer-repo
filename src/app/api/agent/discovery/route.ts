import { NextResponse } from "next/server";
import { db } from "@/db";
import { discoverySessions, discoveredDevices } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

// Agent polls for pending running sessions (branch isolation via agent identity)
export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  const rows = await db.query.discoverySessions.findMany({ where: and(eq(discoverySessions.agentId, agent.id), eq(discoverySessions.status, "running")), orderBy: [desc(discoverySessions.createdAt)], limit: 5 });
  return NextResponse.json(rows);
}

const deviceSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  source: z.array(z.string()).optional(),
  protocol: z.string().min(1).max(32).optional(),
  ipAddress: z.string().max(45).optional(),
  hostname: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  deviceName: z.string().max(255).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(120).optional(),
  confidence: z.enum(["low","medium","high"]).optional(),
  verification: z.enum(["candidate","verified"]).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  rawMetadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// POST /api/agent/discovery — agent reports results for a session
export async function POST(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const discoveryId = typeof body?.discoveryId === "string" ? body.discoveryId : null;
  const status = typeof body?.status === "string" ? body.status : null;
  const devices: unknown[] = Array.isArray(body?.devices) ? body.devices : [];
  if (!discoveryId) return NextResponse.json({ error: "discoveryId required" }, { status: 400 });
  const session = await db.query.discoverySessions.findFirst({ where: eq(discoverySessions.id, discoveryId) });
  if (!session) return NextResponse.json({ error: "Discovery not found" }, { status: 404 });
  if (session.agentId !== agent.id) return NextResponse.json({ error: "Forbidden: discovery belongs to another agent" }, { status: 403 });
  if (session.status !== "running") return NextResponse.json({ error: `Discovery already ${session.status}` }, { status: 409 });
  // Validate no private CIDR abuse: devices must have private IPs only
  for (const raw of devices) {
    const parsed = deviceSchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: `Invalid device: ${parsed.error.issues[0]?.message}` }, { status: 400 });
    const ip = parsed.data.ipAddress;
    if (ip && !isPrivateIP(ip)) return NextResponse.json({ error: `Device IP must be private, got ${ip}` }, { status: 400 });
  }
  // Insert devices
  for (const raw of devices) {
    const d = deviceSchema.parse(raw);
    const id = typeof (raw as any)?.id === "string" && (raw as any).id ? (raw as any).id : `dev_${nanoid(10)}`;
    await db.insert(discoveredDevices).values({
      id,
      discoveryId,
      agentId: agent.id,
      branchId: agent.branchId,
      source: (d.source as any) ?? [],
      protocol: d.protocol ?? "unknown",
      ipAddress: d.ipAddress ?? null,
      hostname: d.hostname ?? null,
      port: d.port ?? null,
      deviceName: d.deviceName ?? null,
      manufacturer: d.manufacturer ?? null,
      model: d.model ?? null,
      serialNumber: d.serialNumber ?? null,
      confidence: d.confidence ?? "low",
      verification: d.verification ?? "candidate",
      capabilities: d.capabilities as any,
      rawMetadata: d.rawMetadata as any,
    }).onConflictDoNothing();
  }
  if (status && ["completed","partial","failed","cancelled"].includes(status)) {
    await db.update(discoverySessions).set({ status, completedAt: new Date(), updatedAt: new Date(), stats: { candidates: devices.length } as any }).where(eq(discoverySessions.id, discoveryId));
  }
  return NextResponse.json({ ok: true, inserted: devices.length });
}

function isPrivateIP(ip: string): boolean {
  // allow hostname null, but if IP present must be private or link-local not public
  if (!ip || ip.includes(":")) return true; // IPv6 allowed via isPrivate check in Go; here be permissive for IPv6 localhost
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return false; // loopback forbidden
  return false;
}
