import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers, agents } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { isVirtualPrinterRecord } from "@/lib/printer-virtual";

export const dynamic = "force-dynamic";

/**
 * Printer registration contract.
 *
 * `agentId` is the ONLY ownership input: the printer's branch is derived as
 * `agent.branchId`. `branchId` is accepted purely as an OPTIONAL assertion
 * (older clients still send it) and is validated against the agent's branch —
 * a mismatch is a 400. It is never stored, and never used to place the printer
 * anywhere. Clients therefore cannot create a cross-branch printer.
 */
const createPrinterSchema = z.object({
  id: z.string().regex(/^[a-z0-9_][a-z0-9_-]*$/).optional(),
  agentId: z.string().min(1),
  /** Optional cross-check only — see above. Never persisted. */
  branchId: z.string().optional(),
  name: z.string().min(1).max(100),
  type: z.enum(["network", "usb", "spooler", "tcp", "ipp", "ipps"]).optional(),
  connectionType: z.enum(["tcp", "usb", "spooler", "ipp", "ipps", "network"]).optional(),
  printerType: z.enum(["thermal", "laser", "inkjet", "spooler", "other", "unknown"]).optional(),
  protocol: z.enum(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler"]).optional(),
  enabled: z.boolean().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  config: z.object({
    ip: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler"]).optional(),
    address: z.string().optional(),
    vid: z.number().optional(),
    pid: z.number().optional(),
    spooler_name: z.string().optional(),
  }).passthrough().optional(),
});

function normalizeType(t?: string): string {
  if (!t) return "network";
  const s = t.toLowerCase();
  if (s === "tcp") return "network";
  return s;
}
function validateNetworkConfig(cfg: Record<string, unknown>, type: string) {
  const nt = normalizeType(type);
  if (nt === "network") {
    const ip = cfg.ip as string | undefined;
    const port = cfg.port as number | undefined;
    // For spooler/usb/ipp via config, ip/port not required if spooler_name/address present
    if (cfg.spooler_name || cfg.address) return null;
    if (!ip || typeof ip !== "string") return "network printer requires config.ip";
    if (!port || typeof port !== "number") return "network printer requires config.port";
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4.test(ip)) {
      // allow hostnames for non-strict
      if (ip.includes(" ")) return `invalid ip ${ip}`;
      return null;
    }
    const parts = ip.split(".").map(Number);
    if (parts.some(n => n < 0 || n > 255)) return `invalid ip ${ip}`;
  }
  if (nt === "spooler") {
    const spooler = (cfg.spooler_name as string) ?? (cfg.address as string);
    if (!spooler || typeof spooler !== "string" || !spooler.trim()) return "spooler printer requires config.spooler_name or address";
  }
  return null;
}

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Branch is DERIVED through the owning agent (printer → agent → branch) and
  // returned read-only so the dashboard can display it without implying the
  // printer owns it.
  const rows = await db
    .select({ printer: printers, agentBranchId: agents.branchId, agentName: agents.name })
    .from(printers)
    .innerJoin(agents, eq(printers.agentId, agents.id))
    .orderBy(desc(printers.createdAt));
  // Virtual / redirected queues are preserved in the database but are never
  // presented as selectable production printers.
  return NextResponse.json(
    rows
      .filter((r) => !isVirtualPrinterRecord(r.printer))
      .map((r) => ({ ...r.printer, branchId: r.agentBranchId, agentName: r.agentName }))
  );
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = createPrinterSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });

  const data = parsed.data;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, data.agentId) });
  if (!agent) return NextResponse.json({ error: "agentId not found" }, { status: 404 });

  // Branch is derived from the agent; a supplied branchId may only CONFIRM it.
  const agentBranchId = (agent as any).branchId as string | null;
  if (!agentBranchId) {
    return NextResponse.json(
      { error: "agent has no branch; assign the agent to a branch before registering printers" },
      { status: 409 }
    );
  }
  if (data.branchId !== undefined && String(data.branchId) !== String(agentBranchId)) {
    return NextResponse.json(
      {
        error: `Printer branch is derived from its agent: agent ${agent.id} is in branch ${agentBranchId}, but branchId ${data.branchId} was supplied`,
      },
      { status: 400 }
    );
  }

  const cfg = (data.config ?? {}) as Record<string, unknown>;
  // Fill spooler_name into config if provided top-level
  if ((data as any).connectionType === "spooler" || (data as any).type === "spooler") {
    if (!cfg.spooler_name && typeof (data as any).spooler_name === "string") cfg.spooler_name = (data as any).spooler_name;
  }
  const effectiveType = (data.connectionType as string) ?? (data.type as string) ?? "network";
  const err = validateNetworkConfig(cfg, effectiveType);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const id = data.id ?? `printer_${nanoid(8)}`;
  const existing = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (existing) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });

  const connectionType = normalizeType((data.connectionType as string) ?? (data.type as string) ?? "network");
  const protocolRaw = (data.protocol as string) ?? (cfg.protocol as string) ?? "raw";
  const protocol = protocolRaw.toString().toLowerCase() === "windows_spooler" ? "spooler" : protocolRaw.toString().toLowerCase();
  const printerType = (data.printerType as string) ?? "unknown";

  const [row] = await db.insert(printers).values({
    id,
    // Ownership: agent only. The branch follows from agents.branch_id.
    agentId: data.agentId,
    name: data.name,
    type: connectionType as any,
    printerType: printerType as any,
    connectionType: connectionType as any,
    protocol: protocol as any,
    status: "unknown",
    config: cfg as any,
    capabilities: (data.capabilities as any) ?? null,
    enabled: data.enabled ?? true,
  } as any).returning();

  // Echo the derived branch so callers still see the printer's branch, clearly
  // sourced from the agent rather than from the printer row.
  return NextResponse.json({ ...row, branchId: agentBranchId }, { status: 201 });
}
