import { db } from "../../../db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness/readiness probe for load balancers and the
 * desktop manager. Intentionally contains no inventory, job, or agent
 * counts — those are internal and belong behind manager authentication.
 *
 * Shape is stable: `{ ok: true }` on success, `{ ok: false }` with HTTP 500
 * when the database is unreachable.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
