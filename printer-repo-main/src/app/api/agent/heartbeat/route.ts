import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { DEVICE_CLASSES, PRINTER_TYPES } from "@/lib/printer-model";

const VALID_PRINTER_STATUSES = new Set(["online", "offline", "busy", "error", "unknown"]);
const VALID_PRINTER_TYPES = new Set(PRINTER_TYPES);
const VALID_CONNECTION_TYPES = new Set(["network", "usb", "spooler", "ipp", "ipps"]);
const VALID_PROTOCOLS = new Set(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler", ""]);
const VALID_AGENT_STATUSES = new Set(["online", "offline"]);

type ReportedPrinter = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  printerType?: unknown;
  deviceClass?: unknown;
  connectionType?: unknown;
  protocol?: unknown;
  status?: unknown;
  enabled?: unknown;
  config?: unknown;
  capabilities?: unknown;
};

function normalizeConnectionType(raw?: unknown, legacy?: unknown): string | null {
  const canonical = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  const old = typeof legacy === "string" ? legacy.toLowerCase().trim() : "";
  const normalizedOld = old === "tcp" ? "network" : old === "windows_spooler" ? "spooler" : old;
  if (canonical && normalizedOld && canonical !== normalizedOld) return null;
  const value = canonical || normalizedOld;
  return VALID_CONNECTION_TYPES.has(value) ? value : null;
}

function normalizeProtocol(raw?: unknown): string | null {
  const p = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  const normalized = p === "windows_spooler" ? "spooler" : p;
  return VALID_PROTOCOLS.has(normalized) && normalized ? normalized : null;
}

function sanitizePrinter(p: ReportedPrinter): {
  id: string; name: string; printerType: string; deviceClass: string; connectionType: string; protocol: string; status: string; config: Record<string, unknown>; capabilities: Record<string, unknown> | null;
} | null {
  if (typeof p.id !== "string" || !p.id.trim() || p.id.length > 120) return null;
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100) return null;
  const connectionType = normalizeConnectionType(p.connectionType, p.type);
  if (!connectionType) return null;
  let printerType = typeof p.printerType === "string" ? p.printerType.trim().toLowerCase() : "";
  let deviceClass = typeof p.deviceClass === "string" ? p.deviceClass.trim().toLowerCase() : "unknown";
  if (!PRINTER_TYPES.includes(printerType as any) && DEVICE_CLASSES.includes(printerType as any)) {
    deviceClass = printerType;
    printerType = "physical";
  }
  if (!PRINTER_TYPES.includes(printerType as any) || !DEVICE_CLASSES.includes(deviceClass as any)) return null;
  const protocol = normalizeProtocol(p.protocol ?? (p.config as any)?.protocol);
  if (!protocol) return null;
  const config = p.config && typeof p.config === "object" ? { ...(p.config as Record<string, unknown>) } : {};
  delete config.protocol;
  const capabilities = p.capabilities && typeof p.capabilities === "object" ? (p.capabilities as Record<string, unknown>) : null;
  const status = typeof p.status === "string" && VALID_PRINTER_STATUSES.has(p.status) ? p.status : "unknown";
  return { id: p.id.trim(), name: p.name.trim(), printerType, deviceClass, connectionType, protocol, status, config, capabilities };
}

export async function POST(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });

  try {
    const body = await req.json();
    const status = typeof body?.status === "string" && VALID_AGENT_STATUSES.has(body.status) ? body.status : "online";
    const reportedPrinters = Array.isArray(body?.printers) ? body.printers : [];
    if (reportedPrinters.length > 500) return NextResponse.json({ error: "too many printers in heartbeat" }, { status: 400 });
    if (JSON.stringify(reportedPrinters).length > 256_000) return NextResponse.json({ error: "heartbeat printer metadata exceeds 256KB" }, { status: 400 });

    await db.update(agents)
      .set({
        status,
        lastSeenAt: new Date(),
      })
      .where(eq(agents.id, agent.id));

    const skipped: string[] = [];

    for (const raw of reportedPrinters) {
      const p = sanitizePrinter(raw);
      if (!p) {
        skipped.push(typeof raw?.id === "string" ? raw.id : "(unknown)");
        continue;
      }

      const existing = await db.query.printers.findFirst({
        where: eq(printers.id, p.id),
      });

      if (existing) {
        if (existing.agentId !== agent.id) {
          skipped.push(p.id);
          continue;
        }
        await db.update(printers)
          .set({
            name: p.name,
            printerType: p.printerType as any,
            deviceClass: p.deviceClass as any,
            connectionType: p.connectionType as any,
            protocol: p.protocol as any,
            status: p.status,
            config: p.config as any,
            capabilities: p.capabilities as any,
            // Heartbeat updates telemetry only; lifecycle remains operator-owned.
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(printers.id, p.id));
      } else {
        await db.insert(printers).values({
          id: p.id,
          agentId: agent.id,
          name: p.name,
          printerType: p.printerType as any,
          connectionType: p.connectionType as any,
          protocol: p.protocol as any,
          status: p.status,
          lifecycle: "active",
          config: p.config as any,
          capabilities: p.capabilities as any,
          lastSeenAt: new Date(),
        });
      }
    }

    return NextResponse.json({ success: true, skippedPrinters: skipped });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
