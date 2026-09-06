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
 * than a few seconds should be investigated even while `ok` is true. It is
 * `null` only if `now()` came back in an unparseable shape.
 */
export async function GET() {
  try {
    const res = (await db.execute(sql`select now() as db_now`)) as unknown as {
      rows: Array<{ db_now: Date | number | string | null }>;
    };
    const raw = res.rows[0]?.db_now;
    const dbEpoch =
      raw instanceof Date
        ? raw.getTime()
        : typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Date.parse(raw)
            : NaN;
    const dbClockOffsetMs = Number.isFinite(dbEpoch) ? dbEpoch - Date.now() : null;
    return Response.json({ ok: true, dbClockOffsetMs });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
