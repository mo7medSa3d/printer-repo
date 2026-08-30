import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const VALID_PRINTER_STATUSES = new Set(["online", "offline", "busy", "error", "unknown"]);
const VALID_PRINTER_TYPES = new Set(["network", "usb"]);
// The agent currently only reports "online"; clamp anything else so a
// compromised/buggy agent cannot write arbitrary strings into agents.status.
const VALID_AGENT_STATUSES = new Set(["online", "offline"]);

type ReportedPrinter = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  status?: unknown;
  config?: unknown;
};

function sanitizePrinter(p: ReportedPrinter): { id: string; name: string; type: string; status: string; config: Record<string, unknown> } | null {
  if (typeof p.id !== "string" || !p.id) return null;
  if (typeof p.name !== "string" || !p.name) return null;
  if (typeof p.type !== "string" || !VALID_PRINTER_TYPES.has(p.type)) return null;
  const status = typeof p.status === "string" && VALID_PRINTER_STATUSES.has(p.status) ? p.status : "unknown";
  const config = (p.config && typeof p.config === "object") ? (p.config as Record<string, unknown>) : {};
  return { id: p.id, name: p.name, type: p.type, status, config };
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
        // CRITICAL: an agent may only update a printer it already owns.
        // Without this check, Agent A could overwrite Agent B's printer
        // by reporting the same printer id.
        if (existing.agentId !== agent.id) {
          skipped.push(p.id);
          continue;
        }
        await db.update(printers)
          .set({
            name: p.name,
            status: p.status,
            config: p.config,
            lastSeenAt: new Date(),
          })
          .where(eq(printers.id, p.id));
      } else {
        await db.insert(printers).values({
          id: p.id,
          agentId: agent.id,
          name: p.name,
          type: p.type,
          status: p.status,
          config: p.config,
          lastSeenAt: new Date(),
        });
      }
    }

    return NextResponse.json({ success: true, skippedPrinters: skipped });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
