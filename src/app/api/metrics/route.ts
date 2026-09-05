import { NextResponse } from "next/server";
import { validateManager } from "../../../lib/manager-auth";
import { renderPrometheusMetrics } from "../../../lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return new Response(await renderPrometheusMetrics(), {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
  });
}
