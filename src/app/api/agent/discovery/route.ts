import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { discoverySessions, discoveredDevices } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { isPrivateNetworkAddress } from "../../../../lib/network-address";

export const dynamic = "force-dynamic";
const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;

export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  const rows = await db.query.discoverySessions.findMany({ where: and(eq(discoverySessions.agentId, agent.id), eq(discoverySessions.status, "running")), orderBy: [desc(discoverySessions.createdAt)], limit: 5 });
  return NextResponse.json(rows);
}

const deviceSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  source: z.array(z.string().max(64)).max(32).optional(),
  protocol: z.string().min(1).max(32).optional(),
  ipAddress: z.string().max(45).optional(),
  hostname: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  deviceName: z.string().max(255).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(120).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  verification: z.enum(["candidate", "verified"]).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  rawMetadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export async function POST(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  if (hasBodyOverLimit(req, MAX_DISCOVERY_BODY_BYTES)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const discoveryId = typeof body?.discoveryId === "string" ? body.discoveryId : null;
  const status = typeof body?.status === "string" ? body.status : null;
  const devices: unknown[] = Array.isArray(body?.devices) ? body.devices : [];
  if (!discoveryId) return NextResponse.json({ error: "discoveryId required" }, { status: 400 });
  if (devices.length > 5000) return NextResponse.json({ error: "Too many devices in one discovery report" }, { status: 413 });

  const session = await db.query.discoverySessions.findFirst({ where: eq(discoverySessions.id, discoveryId) });
  if (!session) return NextResponse.json({ error: "Discovery not found" }, { status: 404 });
  if (session.agentId !== agent.id) return NextResponse.json({ error: "Forbidden: discovery belongs to another agent" }, { status: 403 });
  if (session.status !== "running") return NextResponse.json({ error: `Discovery already ${session.status}` }, { status: 409 });

  const parsedDevices = [] as Array<ReturnType<typeof deviceSchema.parse>>;
  for (const raw of devices) {
    const parsed = deviceSchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: `Invalid device: ${parsed.error.issues[0]?.message}` }, { status: 400 });
    const ip = parsed.data.ipAddress;
    if (ip && !isPrivateNetworkAddress(ip)) return NextResponse.json({ error: `Device IP must be private or link-local, got ${ip}` }, { status: 400 });
    parsedDevices.push(parsed.data);
  }

  // Discovery is observation, not authorization. The gateway never accepts an
  // agent-supplied "verified" value as proof of a production-ready printer.
  for (const d of parsedDevices) {
    const id = typeof d.id === "string" && d.id ? d.id : `dev_${nanoid(10)}`;
    await db.insert(discoveredDevices).values({
      id,
      discoveryId,
      agentId: agent.id,
      branchId: agent.branchId,
      source: d.source ?? [],
      protocol: d.protocol ?? "unknown",
      ipAddress: d.ipAddress ?? null,
      hostname: d.hostname ?? null,
      port: d.port ?? null,
      deviceName: d.deviceName ?? null,
      manufacturer: d.manufacturer ?? null,
      model: d.model ?? null,
      serialNumber: d.serialNumber ?? null,
      confidence: "low",
      verification: "candidate",
      capabilities: d.capabilities as any,
      rawMetadata: d.rawMetadata as any,
    }).onConflictDoNothing();
  }

  if (status && ["completed", "partial", "failed", "cancelled"].includes(status)) {
    await db.update(discoverySessions)
      .set({ status, completedAt: new Date(), updatedAt: new Date(), stats: { candidates: parsedDevices.length } as any })
      .where(eq(discoverySessions.id, discoveryId));
  }
  return NextResponse.json({ ok: true, inserted: parsedDevices.length, verification: "candidate-only" });
}
