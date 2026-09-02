import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, discoveredDevices, printers } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

// POST provision discovered device -> Printer (Branch via Agent)
export async function POST(req: Request, { params }: { params: Promise<{ id: string; deviceId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: agentId, deviceId } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  const device = await db.query.discoveredDevices.findFirst({ where: and(eq(discoveredDevices.id, deviceId), eq(discoveredDevices.agentId, agentId)) });
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  if (device.candidateStatus === "provisioned" && device.provisionedPrinterId) {
    return NextResponse.json({ printerId: device.provisionedPrinterId, already: true });
  }
  // Deduplicate: if printer with same IP:port already exists for this agent, return it
  if (device.ipAddress && device.port) {
    const existing = await db.query.printers.findFirst({ where: eq(printers.agentId, agentId) });
    // naive check: find by endpoint containing IP
    // For correctness, check all printers of agent
    const all = await db.query.printers.findMany({ where: eq(printers.agentId, agentId) });
    for (const p of all) {
      const cfg = p.config as any;
      const ip = cfg?.ip ?? cfg?.address;
      const port = cfg?.port;
      if (ip === device.ipAddress && port === device.port) {
        await db.update(discoveredDevices).set({ candidateStatus: "provisioned", provisionedPrinterId: p.id, updatedAt: new Date() }).where(eq(discoveredDevices.id, deviceId));
        return NextResponse.json({ printerId: p.id, already: true });
      }
    }
  }
  const printerId = `printer_${nanoid(10)}`;
  // Map discovery protocol to canonical printer protocol
  const protocolMap: Record<string, string> = { ipp: "ipp", ipps: "ipps", raw: "raw", lpr: "raw", wsd: "raw", mdns: "ipp", snmp: "raw", usb: "raw", spooler: "spooler", windows_spooler: "spooler", escpos: "escpos" };
  const protocol = protocolMap[device.protocol ?? "unknown"] ?? "raw";
  const connectionTypeMap: Record<string, string> = { usb: "usb", spooler: "spooler", windows_spooler: "spooler", ipp: "ipp", ipps: "ipps" };
  const connectionType = connectionTypeMap[device.protocol ?? ""] ?? (device.protocol === "lpr" ? "network" : "network");
  // Transactional insert + update device
  await db.transaction(async (tx) => {
    await tx.insert(printers).values({
      id: printerId,
      agentId,
      name: device.deviceName ?? device.model ?? `Printer ${device.ipAddress ?? deviceId}`,
      printerType: "physical",
      deviceClass: (device.deviceClass as any) ?? "unknown",
      connectionType: connectionType as any,
      protocol: protocol as any,
      status: "unknown",
      lifecycle: "active",
      config: { ip: device.ipAddress ?? undefined, port: device.port ?? undefined, address: device.uri ?? undefined } as any,
      capabilities: { discovered_via: device.source, confidence: device.confidence, verification: device.verification } as any,
    });
    await tx.update(discoveredDevices).set({ candidateStatus: "provisioned", provisionedPrinterId: printerId, updatedAt: new Date() }).where(eq(discoveredDevices.id, deviceId));
  });
  return NextResponse.json({ printerId, already: false }, { status: 201 });
}
