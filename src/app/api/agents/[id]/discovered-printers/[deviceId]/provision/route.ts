import { NextResponse } from "next/server";
import { db } from "../../../../../../../db";
import { agents, discoveredDevices, printers } from "../../../../../../../db/schema";
import { validateManager } from "../../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../../lib/authorization";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; deviceId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId, deviceId } = await params;

  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });

  const result = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, candidate_status, verification, provisioned_printer_id
      FROM discovered_devices
      WHERE id = ${deviceId} AND agent_id = ${agentId} AND tenant_id = ${claims.tenantId}
      FOR UPDATE
    `);
    const rows = locked.rows as Array<{ id: string; candidate_status: string; verification: string; provisioned_printer_id: string | null }>;
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    if (row.candidate_status === "provisioned" && row.provisioned_printer_id) {
      return { kind: "already" as const, printerId: row.provisioned_printer_id };
    }
    if (row.verification !== "verified" || row.candidate_status !== "verified") {
      return { kind: "not_approved" as const };
    }

    const device = await tx.query.discoveredDevices.findFirst({
      where: and(eq(discoveredDevices.id, deviceId), eq(discoveredDevices.agentId, agentId), eq(discoveredDevices.tenantId, claims.tenantId)),
    });
    if (!device) return { kind: "not_found" as const };

    const protocolMap: Record<string, { protocol: string; connectionType: string }> = {
      ipp: { protocol: "ipp", connectionType: "ipp" },
      ipps: { protocol: "ipps", connectionType: "ipps" },
      raw: { protocol: "raw", connectionType: "network" },
      escpos: { protocol: "escpos", connectionType: "network" },
      spooler: { protocol: "spooler", connectionType: "spooler" },
      windows_spooler: { protocol: "spooler", connectionType: "spooler" },
      // "lpr" is deliberately NOT mapped. An LPR discovery probe only proves
      // TCP 515 accepts connections; the LPD daemon there does NOT consume a
      // raw byte stream, so provisioning lpr -> raw would write raw job bytes
      // to port 515 - the exact heuristic protocol inference the agent's own
      // NormalizedProtocol refuses. LPR-only devices must be registered
      // explicitly by an operator (Add Printer dialog) with a proven
      // transport, never silently re-labelled.
    };
    const rawProtocol = (device.protocol ?? "").toLowerCase();
    const transport = protocolMap[rawProtocol];
    if (!transport) return { kind: "unsupported_transport" as const, protocol: device.protocol ?? "unknown" };
    if (["ipp", "ipps", "raw"].includes(transport.protocol) && (!device.ipAddress || !device.port)) {
      return { kind: "missing_endpoint" as const };
    }

    if (device.ipAddress && device.port) {
      const all = await tx.query.printers.findMany({ where: and(eq(printers.agentId, agentId), eq(printers.tenantId, claims.tenantId)) });
      for (const p of all) {
        const cfg = p.config as { ip?: string; address?: string; port?: number } | null;
        const ip = cfg?.ip ?? cfg?.address;
        if (ip === device.ipAddress && cfg?.port === device.port) {
          await tx.update(discoveredDevices)
            .set({ candidateStatus: "provisioned", provisionedPrinterId: p.id, updatedAt: new Date() })
            .where(and(eq(discoveredDevices.id, deviceId), eq(discoveredDevices.tenantId, claims.tenantId), eq(discoveredDevices.candidateStatus, "verified")));
          return { kind: "already" as const, printerId: p.id };
        }
      }
    }

    const printerId = `printer_${nanoid(10)}`;
    await tx.insert(printers).values({
      id: printerId,
      tenantId: claims.tenantId,
      agentId,
      name: device.deviceName ?? device.model ?? `Printer ${device.ipAddress ?? deviceId}`,
      printerType: "physical",
      deviceClass: device.deviceClass ?? "unknown",
      connectionType: transport.connectionType,
      protocol: transport.protocol,
      status: "unknown",
      lifecycle: "active",
      config: { ip: device.ipAddress ?? undefined, port: device.port ?? undefined, address: device.uri ?? undefined },
      capabilities: {
        ...(device.capabilities as Record<string, unknown> | null ?? {}),
        discovered_via: device.source,
        confidence: device.confidence,
        verification: device.verification,
      },
    });
    await tx.update(discoveredDevices)
      .set({ candidateStatus: "provisioned", provisionedPrinterId: printerId, updatedAt: new Date() })
      .where(and(eq(discoveredDevices.id, deviceId), eq(discoveredDevices.tenantId, claims.tenantId), eq(discoveredDevices.candidateStatus, "verified")));

    return { kind: "created" as const, printerId };
  });

  if (result.kind === "not_found") return NextResponse.json({ error: "Device not found" }, { status: 404 });
  if (result.kind === "not_approved") {
    return NextResponse.json({ error: "DEVICE_NOT_APPROVED: a discovery candidate must be explicitly approved before provisioning", code: "DEVICE_NOT_APPROVED" }, { status: 409 });
  }
  if (result.kind === "unsupported_transport") {
    return NextResponse.json({ error: `UNSUPPORTED_DISCOVERY_TRANSPORT: ${result.protocol}. The candidate must report an explicit executable print transport before provisioning.`, code: "UNSUPPORTED_DISCOVERY_TRANSPORT" }, { status: 422 });
  }
  if (result.kind === "missing_endpoint") {
    return NextResponse.json({ error: "MISSING_PRINTER_ENDPOINT: network printer requires ipAddress and port", code: "MISSING_PRINTER_ENDPOINT" }, { status: 422 });
  }
  if (result.kind === "already") return NextResponse.json({ printerId: result.printerId, already: true });
  return NextResponse.json({ printerId: result.printerId, already: false }, { status: 201 });
}