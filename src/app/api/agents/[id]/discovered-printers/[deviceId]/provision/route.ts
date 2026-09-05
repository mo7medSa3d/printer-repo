import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, discoveredDevices, printers } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; deviceId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: agentId, deviceId } = await params;

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });

  const device = await db.query.discoveredDevices.findFirst({
    where: and(
      eq(discoveredDevices.id, deviceId),
      eq(discoveredDevices.agentId, agentId),
      eq(discoveredDevices.branchId, agent.branchId),
    ),
  });
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  if (device.candidateStatus === "provisioned" && device.provisionedPrinterId) {
    return NextResponse.json({ printerId: device.provisionedPrinterId, already: true });
  }
  if (device.verification !== "verified" || device.candidateStatus !== "verified") {
    return NextResponse.json({
      error: "DEVICE_NOT_APPROVED: a discovery candidate must be explicitly approved before provisioning",
      code: "DEVICE_NOT_APPROVED",
    }, { status: 409 });
  }

  if (device.ipAddress && device.port) {
    const all = await db.query.printers.findMany({ where: eq(printers.agentId, agentId) });
    for (const p of all) {
      const cfg = p.config as { ip?: string; address?: string; port?: number } | null;
      const ip = cfg?.ip ?? cfg?.address;
      if (ip === device.ipAddress && cfg?.port === device.port) {
        await db.update(discoveredDevices)
          .set({ candidateStatus: "provisioned", provisionedPrinterId: p.id, updatedAt: new Date() })
          .where(eq(discoveredDevices.id, deviceId));
        return NextResponse.json({ printerId: p.id, already: true });
      }
    }
  }

  const printerId = `printer_${nanoid(10)}`;
  const protocolMap: Record<string, string> = {
    ipp: "ipp", ipps: "ipps", raw: "raw", lpr: "raw", wsd: "raw", mdns: "ipp", snmp: "raw",
    usb: "raw", spooler: "spooler", windows_spooler: "spooler", escpos: "escpos",
  };
  const protocol = protocolMap[device.protocol ?? "unknown"];
  if (!protocol) {
    return NextResponse.json({ error: `UNSUPPORTED_DISCOVERY_PROTOCOL: ${device.protocol ?? "unknown"}`, code: "UNSUPPORTED_DISCOVERY_PROTOCOL" }, { status: 422 });
  }

  const connectionType = device.protocol === "usb"
    ? "usb"
    : device.protocol === "spooler" || device.protocol === "windows_spooler"
      ? "spooler"
      : device.protocol === "ipp"
        ? "ipp"
        : device.protocol === "ipps"
          ? "ipps"
          : "network";

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
      capabilities: {
        ...(device.capabilities as Record<string, unknown> | null ?? {}),
        discovered_via: device.source,
        confidence: device.confidence,
        verification: device.verification,
      } as any,
    });
    await tx.update(discoveredDevices)
      .set({ candidateStatus: "provisioned", provisionedPrinterId: printerId, updatedAt: new Date() })
      .where(eq(discoveredDevices.id, deviceId));
  });

  return NextResponse.json({ printerId, already: false }, { status: 201 });
}
