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
 *
 * `dbClockOffsetMs` (epoch milliseconds, DB minus app) exposes clock skew
 * between the PostgreSQL host and the gateway process. The job lease and
 * TTL logic compare SQL `now()` with app-written timestamps (see the
 * timezone requirement in docs/DEPLOYMENT.md), so sustained drift of more
 * than a few seconds should be investigated even while `ok` is true.
 */
export async function GET() {
  try {
    const res = (await db.execute(sql`select now() as db_now`)) as unknown as { rows: Array<{ db_now: Date }> };
    const dbNow = res.rows[0]?.db_now;
    const dbClockOffsetMs = dbNow instanceof Date && !Number.isNaN(dbNow.getTime()) ? dbNow.getTime() - Date.now() : null;
    return Response.json({ ok: true, dbClockOffsetMs });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
