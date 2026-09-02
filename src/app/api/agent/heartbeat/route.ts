import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const VALID_PRINTER_STATUSES = new Set(["online", "offline", "busy", "error", "unknown"]);
const VALID_PRINTER_TYPES = new Set(["network", "usb", "spooler", "tcp", "ipp", "ipps"]);
const VALID_CONNECTION_TYPES = new Set(["tcp", "network", "usb", "spooler", "ipp", "ipps"]);
const VALID_PROTOCOLS = new Set(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler", ""]);
const VALID_AGENT_STATUSES = new Set(["online", "offline"]);

type ReportedPrinter = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  printerType?: unknown;
  connectionType?: unknown;
  protocol?: unknown;
  status?: unknown;
  enabled?: unknown;
  config?: unknown;
  capabilities?: unknown;
};

function normalizeConnectionType(raw?: unknown, fallback?: string): string {
  let t = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (!t && typeof fallback === "string") t = fallback.toLowerCase().trim();
  if (t === "tcp") t = "network";
  if (t === "windows_spooler") t = "spooler";
  if (!VALID_CONNECTION_TYPES.has(t)) {
    if (VALID_PRINTER_TYPES.has(t)) return t === "tcp" ? "network" : t;
    return "network";
  }
  return t;
}

function normalizeProtocol(raw?: unknown): string {
  let p = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (p === "windows_spooler") p = "spooler";
  if (!VALID_PROTOCOLS.has(p)) return "raw";
  if (p === "") return "raw";
  return p;
}

function sanitizePrinter(p: ReportedPrinter): {
  id: string;
  name: string;
  type: string;
  printerType: string;
  connectionType: string;
  protocol: string;
  status: string;
  enabled: boolean;
  config: Record<string, unknown>;
  capabilities: Record<string, unknown> | null;
} | null {
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.name !== "string" || !p.name) return null;
  // type is legacy; prefer connectionType if present
  const connType = normalizeConnectionType(p.connectionType, typeof p.type === "string" ? p.type : undefined);
  if (!VALID_CONNECTION_TYPES.has(connType) && !VALID_PRINTER_TYPES.has(connType)) return null;
  const printerType = typeof p.printerType === "string" && p.printerType.trim() ? p.printerType.trim().toLowerCase() : "unknown";
  const protocol = normalizeProtocol(p.protocol ?? (p.config as any)?.protocol);
  const status = typeof p.status === "string" && VALID_PRINTER_STATUSES.has(p.status) ? p.status : "unknown";
  const enabled = typeof p.enabled === "boolean" ? p.enabled : true;
  const config = p.config && typeof p.config === "object" ? (p.config as Record<string, unknown>) : {};
  // sanitize config protocol consistency
  if (typeof config.protocol === "string") {
    config.protocol = normalizeProtocol(config.protocol);
  } else if (!config.protocol) {
    config.protocol = protocol;
  }
  const capabilities = p.capabilities && typeof p.capabilities === "object" ? (p.capabilities as Record<string, unknown>) : null;
  // Map legacy type to still store for backward compat
  const legacyType = connType === "network" ? "network" : connType === "spooler" ? "spooler" : connType;
  return { id: p.id, name: p.name, type: legacyType, printerType, connectionType: connType, protocol, status, enabled, config, capabilities };
}

export async function POST(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const status = typeof body?.status === "string" && VALID_AGENT_STATUSES.has(body.status) ? body.status : "online";
    const reportedPrinters = Array.isArray(body?.printers) ? body.printers : [];

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
            type: p.type as any,
            printerType: p.printerType as any,
            connectionType: p.connectionType as any,
            protocol: p.protocol as any,
            status: p.status,
            config: p.config as any,
            capabilities: p.capabilities as any,
            // `enabled` is operator-controlled on the gateway. A heartbeat
            // must never resurrect a printer the operator disabled.
            lastSeenAt: new Date(),
            branchId: agent.branchId ?? (existing as any).branchId,
            updatedAt: new Date(),
          })
          .where(eq(printers.id, p.id));
      } else {
        await db.insert(printers).values({
          id: p.id,
          agentId: agent.id,
          branchId: agent.branchId as any,
          name: p.name,
          type: p.type as any,
          printerType: p.printerType as any,
          connectionType: p.connectionType as any,
          protocol: p.protocol as any,
          status: p.status,
          config: p.config as any,
          capabilities: p.capabilities as any,
          enabled: p.enabled,
          lastSeenAt: new Date(),
        } as any);
      }
    }

    return NextResponse.json({ success: true, skippedPrinters: skipped });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
