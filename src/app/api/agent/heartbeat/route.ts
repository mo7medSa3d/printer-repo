import { db } from "../../../../db";
import { agents, printJobs, printers } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { DEVICE_CLASSES, PRINTER_TYPES } from "../../../../lib/printer-model";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

const MAX_HEARTBEAT_BODY_BYTES = 512 * 1024;
const MAX_KEEP_ALIVE_JOB_IDS = 64;
const VALID_PRINTER_STATUSES = new Set(["online", "offline", "busy", "error", "unknown"]);
const VALID_CONNECTION_TYPES = new Set(["network", "usb", "spooler", "ipp", "ipps"]);
const VALID_PROTOCOLS = new Set(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler"]);
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
  if (!(PRINTER_TYPES as readonly string[]).includes(printerType) && (DEVICE_CLASSES as readonly string[]).includes(printerType)) {
    deviceClass = printerType;
    printerType = "physical";
  }
  if (!(PRINTER_TYPES as readonly string[]).includes(printerType) || !(DEVICE_CLASSES as readonly string[]).includes(deviceClass)) return null;
  const protocol = normalizeProtocol(p.protocol ?? (p.config as Record<string, unknown>)?.protocol);
  if (!protocol) return null;
  const config = p.config && typeof p.config === "object" ? { ...(p.config as Record<string, unknown>) } : {};
  delete config.protocol;
  const capabilities = p.capabilities && typeof p.capabilities === "object" ? (p.capabilities as Record<string, unknown>) : null;
  const status = typeof p.status === "string" && VALID_PRINTER_STATUSES.has(p.status.trim().toLowerCase())
    ? p.status.trim().toLowerCase()
    : "unknown";
  return { id: p.id.trim(), name: p.name.trim(), printerType, deviceClass, connectionType, protocol, status, config, capabilities };
}

export async function POST(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  if (hasBodyOverLimit(req, MAX_HEARTBEAT_BODY_BYTES)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  try {
    const body = await req.json();
    const rawStatus = typeof body?.status === "string" ? body.status.trim().toLowerCase() : "online";
    if (!VALID_AGENT_STATUSES.has(rawStatus)) {
      return NextResponse.json({ error: "status must be online or offline" }, { status: 400 });
    }
    const status = rawStatus;
    const reportedPrinters = Array.isArray(body?.printers) ? body.printers : [];
    if (reportedPrinters.length > 500) return NextResponse.json({ error: "too many printers in heartbeat" }, { status: 400 });
    if (JSON.stringify(reportedPrinters).length > 256_000) return NextResponse.json({ error: "heartbeat printer metadata exceeds 256KB" }, { status: 400 });

    await db.update(agents).set({ status, lastSeenAt: new Date() }).where(eq(agents.id, agent.id));

    // Print-lease keep-alive: the agent reports the job ids it has taken
    // (gateway status claimed/printing). While the agent is alive and
    // working those jobs, their `updated_at` stays fresh, so the
    // stale-printing sweep (10 min) cannot fail a legitimately long print.
    // A dead agent stops heartbeating, so its jobs still time out as
    // before. Scoped to this agent's own non-terminal delivery states.
    const rawKeepAlive: unknown[] = Array.isArray(body?.keepAliveJobIds) ? (body.keepAliveJobIds as unknown[]) : [];
    const keepAliveJobIds = rawKeepAlive
      .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 120)
      .slice(0, MAX_KEEP_ALIVE_JOB_IDS);
    if (keepAliveJobIds.length > 0) {
      await db.update(printJobs)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(printJobs.agentId, agent.id),
            inArray(printJobs.status, ["claimed", "printing"]),
            inArray(printJobs.id, keepAliveJobIds),
          ),
        );
    }

    const skipped: string[] = [];
    for (const raw of reportedPrinters) {
      const p = sanitizePrinter(raw);
      if (!p) {
        skipped.push(typeof raw?.id === "string" ? raw.id : "(unknown)");
        continue;
      }

      const existing = await db.query.printers.findFirst({ where: eq(printers.id, p.id) });
      if (existing) {
        if (existing.agentId !== agent.id) {
          skipped.push(p.id);
          continue;
        }
        await db.update(printers).set({
          name: p.name,
          printerType: p.printerType as typeof printers.$inferInsert.printerType,
          deviceClass: p.deviceClass as typeof printers.$inferInsert.deviceClass,
          connectionType: p.connectionType as typeof printers.$inferInsert.connectionType,
          protocol: p.protocol as typeof printers.$inferInsert.protocol,
          status: p.status,
          config: p.config as typeof printers.$inferInsert.config,
          capabilities: p.capabilities as typeof printers.$inferInsert.capabilities,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(printers.id, p.id));
      } else {
        await db.insert(printers).values({
          id: p.id,
          agentId: agent.id,
          name: p.name,
          printerType: p.printerType as typeof printers.$inferInsert.printerType,
          deviceClass: p.deviceClass as typeof printers.$inferInsert.deviceClass,
          connectionType: p.connectionType as typeof printers.$inferInsert.connectionType,
          protocol: p.protocol as typeof printers.$inferInsert.protocol,
          status: p.status,
          lifecycle: "active",
          config: p.config as typeof printers.$inferInsert.config,
          capabilities: p.capabilities as typeof printers.$inferInsert.capabilities,
          lastSeenAt: new Date(),
        });
      }
    }

    return NextResponse.json({ success: true, skippedPrinters: skipped });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
