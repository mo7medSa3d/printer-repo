import { db } from "../db";
import { sql } from "drizzle-orm";

const WINDOW_MS = 60_000;
const MAX_FAILURES = 20;
const LOCK_MS = 60_000;

const localLockedUntil = new Map<string, number>();

export function isWsUpgradeLocallyLocked(key: string, now = Date.now()): boolean {
  const until = localLockedUntil.get(key) ?? 0;
  if (until <= now) {
    localLockedUntil.delete(key);
    return false;
  }
  return true;
}

export async function inspectWsUpgradeRateLimit(key: string): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const now = Date.now();
  if (isWsUpgradeLocallyLocked(key, now)) {
    const until = localLockedUntil.get(key) ?? now + LOCK_MS;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) };
  }

  const result = await db.execute(sql`
    SELECT failures, window_started_at, locked_until
    FROM auth_rate_limits
    WHERE key = ${`ws-upgrade:${key}`}
  `);
  const row = result.rows[0] as { failures?: number | string; window_started_at?: Date | string; locked_until?: Date | string | null } | undefined;
  if (!row) return { allowed: true };

  const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
  if (lockedUntil > now) {
    localLockedUntil.set(key, lockedUntil);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) };
  }

  const windowStart = new Date(row.window_started_at ?? now).getTime();
  if (windowStart <= now - WINDOW_MS) return { allowed: true };
  if (Number(row.failures ?? 0) >= MAX_FAILURES) {
    const until = now + LOCK_MS;
    localLockedUntil.set(key, until);
    return { allowed: false, retryAfterSec: 60 };
  }
  return { allowed: true };
}

export async function recordWsUpgradeFailure(key: string): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const until = new Date(now.getTime() + LOCK_MS);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
      VALUES (${`ws-upgrade:${key}`}, 1, ${now}, NULL, ${now})
      ON CONFLICT (key) DO UPDATE
      SET failures = CASE
          WHEN auth_rate_limits.window_started_at < ${cutoff} THEN 1
          ELSE auth_rate_limits.failures + 1
        END,
        window_started_at = CASE
          WHEN auth_rate_limits.window_started_at < ${cutoff} THEN ${now}
          ELSE auth_rate_limits.window_started_at
        END,
        locked_until = CASE
          WHEN auth_rate_limits.window_started_at < ${cutoff} THEN NULL
          WHEN auth_rate_limits.failures + 1 >= ${MAX_FAILURES} THEN ${until}
          ELSE NULL
        END,
        updated_at = ${now}
    `);
  });

  const check = await db.execute(sql`
    SELECT locked_until FROM auth_rate_limits WHERE key = ${`ws-upgrade:${key}`}
  `);
  const lockedUntil = check.rows[0]?.locked_until ? new Date(check.rows[0].locked_until as string | Date).getTime() : 0;
  if (lockedUntil > Date.now()) localLockedUntil.set(key, lockedUntil);
}
