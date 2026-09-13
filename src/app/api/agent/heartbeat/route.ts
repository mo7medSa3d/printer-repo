import { db } from "../../../../db";
import { agents, printJobs, printers } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { DEVICE_CLASSES, PRINTER_TYPES, PRINTER_CONFIG_MAX_BYTES, PRINTER_CAPABILITIES_MAX_BYTES, validateConnectionConfig } from "../../../../lib/printer-model";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

const MAX_HEARTBEAT_BODY_BYTES = 512 * 1024;
const MAX_KEEP_ALIVE_JOB_IDS = 64;
const VALID_PRINTER_STATUSES = new Set(["online", "offline", "busy", "error", "unknown"]);
// Union of every capability token either compatibility table can match
// (agent/internal/printer/capability.go + src/lib/routing.ts). Anything
// outside this vocabulary can never route; it is dropped at the trust
// boundary instead of stored.
const KNOWN_CAPABILITY_TOKENS = new Set([
  "raw",
  "escpos",
  "zpl",
  "tspl",
  "pdf",
  "image",
  "jpeg",
  "spooler",
  "ipp",
  "ipps",
]);
const VALID_CONNECTION_TYPES = new Set(["network", "usb", "spooler", "ipp", "ipps"]);
// "unknown" is the HONEST value for a device whose byte-language protocol
// has not been declared. Per the authoritative rule (src/lib/routing.ts):
// unknown+network/usb is inventoried but never routable; unknown+spooler/
// ipp behaves as that document transport because the connection itself is
// the explicit transport declaration. Nothing here ever invents raw/escpos.
const VALID_PROTOCOLS = new Set(["raw", "escpos", "zpl", "tspl", "ipp", "ipps", "spooler", "windows_spooler", "unknown"]);
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
  ok: true;
  printer: {
    id: string;
    name: string;
    printerType: string;
    deviceClass: string;
    connectionType: string;
    protocol: string;
    status: string;
    config: Record<string, unknown>;
    capabilities: Record<string, unknown> | null;
  };
} | { ok: false; reason: string } {
  if (typeof p.id !== "string" || !p.id.trim() || p.id.length > 120) {
    return { ok: false, reason: "invalid_id" };
  }
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100) {
    return { ok: false, reason: "invalid_name" };
  }
  const connectionType = normalizeConnectionType(p.connectionType, p.type);
  if (!connectionType) {
    return { ok: false, reason: "invalid_or_unsupported_connection_type" };
  }
  let printerType = typeof p.printerType === "string" ? p.printerType.trim().toLowerCase() : "";
  let deviceClass = typeof p.deviceClass === "string" ? p.deviceClass.trim().toLowerCase() : "unknown";
  if (!(PRINTER_TYPES as readonly string[]).includes(printerType) && (DEVICE_CLASSES as readonly string[]).includes(printerType)) {
    deviceClass = printerType;
    printerType = "physical";
  }
  if (!printerType) {
    printerType = "physical";
  }
  if (!(PRINTER_TYPES as readonly string[]).includes(printerType) || !(DEVICE_CLASSES as readonly string[]).includes(deviceClass)) {
    return { ok: false, reason: "invalid_device_class_or_printer_type" };
  }
  const protocol = normalizeProtocol(p.protocol ?? (p.config as Record<string, unknown>)?.protocol);
  if (!protocol) {
    return { ok: false, reason: "invalid_or_unsupported_protocol" };
  }
  const config = p.config && typeof p.config === "object" ? { ...(p.config as Record<string, unknown>) } : {};
  delete config.protocol;
  let capabilities = p.capabilities && typeof p.capabilities === "object" ? { ...(p.capabilities as Record<string, unknown>) } : null;
  if (capabilities && "supported_protocols" in capabilities) {
    if (Array.isArray(capabilities.supported_protocols)) {
      const known = (capabilities.supported_protocols as unknown[])
        .map((value) => String(value).toLowerCase().trim())
        .filter((token) => KNOWN_CAPABILITY_TOKENS.has(token));
      if (known.length > 0) capabilities.supported_protocols = known;
      else delete capabilities.supported_protocols;
    } else {
      delete capabilities.supported_protocols;
    }
  }
  const status = typeof p.status === "string" && VALID_PRINTER_STATUSES.has(p.status.trim().toLowerCase())
    ? p.status.trim().toLowerCase()
    : "unknown";
  if (JSON.stringify(config).length > PRINTER_CONFIG_MAX_BYTES) {
    return { ok: false, reason: "config_payload_too_large" };
  }
  if (capabilities && JSON.stringify(capabilities).length > PRINTER_CAPABILITIES_MAX_BYTES) {
    return { ok: false, reason: "capabilities_payload_too_large" };
  }
  const configErr = validateConnectionConfig(connectionType, config);
  if (configErr) {
    return { ok: false, reason: `invalid_connection_config: ${configErr}` };
  }
  return {
    ok: true,
    printer: {
      id: p.id.trim(),
      name: p.name.trim(),
      printerType,
      deviceClass,
      connectionType,
      protocol,
      status,
      config,
      capabilities,
    },
  };
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

    await db.update(agents).set({ status, lastSeenAt: new Date() }).where(and(eq(agents.id, agent.id), eq(agents.tenantId, agent.tenantId)));

    const rawKeepAlive: unknown[] = Array.isArray(body?.keepAliveJobIds) ? (body.keepAliveJobIds as unknown[]) : [];
    const pairs: Array<{ jobId: string; claimToken: string | null }> = [];
    for (const entry of rawKeepAlive) {
      if (typeof entry === "string") {
        if (entry.length > 0 && entry.length <= 120) pairs.push({ jobId: entry, claimToken: null });
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const jobId = typeof rec.jobId === "string" ? rec.jobId : typeof rec.id === "string" ? rec.id : "";
        const claimToken = typeof rec.claimToken === "string" && rec.claimToken.length > 0 && rec.claimToken.length <= 120
          ? rec.claimToken
          : null;
        if (jobId.length > 0 && jobId.length <= 120) pairs.push({ jobId, claimToken });
      }
      if (pairs.length >= MAX_KEEP_ALIVE_JOB_IDS) break;
    }
    const tokened = pairs.filter((p): p is { jobId: string; claimToken: string } => p.claimToken !== null);
    const tokenless = pairs.filter((p) => p.claimToken === null);
    if (tokened.length > 0) {
      const tuples = tokened.map((p) => sql`(${p.jobId}, ${p.claimToken})`);
      const list = tuples.length === 1 ? tuples[0]! : sql.join(tuples, sql`, `);
      await db.execute(sql`
        UPDATE print_jobs SET updated_at = now()
        WHERE agent_id = ${agent.id}
          AND status IN ('claimed', 'printing')
          AND (id, claim_token) IN (${list})
      `);
    }
    if (tokenless.length > 0) {
      await db.update(printJobs)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(printJobs.tenantId, agent.tenantId),
            eq(printJobs.agentId, agent.id),
            inArray(printJobs.status, ["claimed", "printing"]),
            inArray(printJobs.id, tokenless.map((p) => p.jobId)),
            isNull(printJobs.claimToken),
          ),
        );
    }

    const skipped: Array<{ id: string; reason: string }> = [];
    for (const raw of reportedPrinters) {
      const rawId = typeof raw?.id === "string" ? raw.id : "(unknown)";
      const res = sanitizePrinter(raw);
      if (!res.ok) {
        skipped.push({ id: rawId, reason: res.reason });
        continue;
      }

      const p = res.printer;
      const printerUpdateSet = {
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
      };

      const existing = await db.query.printers.findFirst({ where: and(eq(printers.id, p.id), eq(printers.tenantId, agent.tenantId)) });
      if (existing) {
        if (existing.agentId !== agent.id) {
          skipped.push({ id: p.id, reason: `owned_by_another_agent (${existing.agentId})` });
          continue;
        }
        await db.update(printers).set(printerUpdateSet).where(and(eq(printers.id, p.id), eq(printers.tenantId, agent.tenantId)));
      } else {
        const inserted = await db.insert(printers).values({
          id: p.id,
          tenantId: agent.tenantId,
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
        }).onConflictDoNothing({ target: printers.id }).returning({ id: printers.id });
        if (inserted.length === 0) {
          const raced = await db.query.printers.findFirst({ where: and(eq(printers.id, p.id), eq(printers.tenantId, agent.tenantId)) });
          if (raced && raced.agentId === agent.id) {
            await db.update(printers).set(printerUpdateSet).where(and(eq(printers.id, p.id), eq(printers.tenantId, agent.tenantId)));
          } else {
            skipped.push({ id: p.id, reason: "insert_conflict_owned_by_another_agent" });
          }
        }
      }
    }

    return NextResponse.json({ success: true, skippedPrinters: skipped });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
