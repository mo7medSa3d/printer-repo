import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { canonicalTypeFor } from "@/lib/printer-transport";

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
  // LEGACY COMPATIBILITY BOUNDARY.
  //
  // This is the one and only place the deprecated `type` value is produced.
  // It is DERIVED from the canonical connectionType — never read back, never
  // used for a decision — so the legacy column can never disagree with the
  // canonical fields. See src/lib/printer-transport.ts.
  const legacyType = canonicalTypeFor(connType);
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
        // `retired` is a TERMINAL, operator-asserted state meaning the physical
        // device is gone for good. A heartbeat must never overwrite it: if the
        // agent still enumerates a stale queue (a Windows spooler entry that
        // was never removed, say), reporting it as `online` would silently
        // resurrect a decommissioned printer and make it look routable again.
        if (existing.status === "retired") {
          skipped.push(p.id);
          continue;
        }
        await db.update(printers)
          .set({
            name: p.name,
            // Legacy compatibility column, derived (see normalizePrinter).
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
            // No branch is written here: the printer's branch IS the agent's
            // branch (printer → agent → branch). Reassigning the agent to
            // another branch moves its printers with it, atomically, because
            // there is nothing else to update.
            updatedAt: new Date(),
          })
          .where(eq(printers.id, p.id));
      } else {
        // A printer discovered by this agent (spooler, USB, RAW TCP, IPP,
        // mDNS, SNMP, WSD, …) is registered UNDER THE AGENT and therefore
        // inherits the agent's branch implicitly. No branch is supplied or
        // stored, so the agent can never place a printer in another branch.
        await db.insert(printers).values({
          id: p.id,
          agentId: agent.id,
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
