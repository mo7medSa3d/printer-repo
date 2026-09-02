import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Database-backed authentication rate limiter.
 *
 * Designed for the supported multi-instance deployment: every gateway process
 * shares PostgreSQL, so an in-memory limiter would be bypassed by spraying
 * attempts across instances. State lives in `auth_rate_limits`.
 *
 * Keys:
 *   ip:<client-ip>        — per source address
 *   acct:<username>       — per login identifier (lowercased, trimmed)
 *
 * Progressive backoff (failures inside a 15-minute window):
 *    1–4  no lock
 *    5–9  30 s
 *   10–14 5 min
 *   15–19 15 min
 *     20+ 60 min
 *
 * A successful login clears the account bucket so a legitimate user recovers
 * immediately. The IP bucket is left alone (it may be covering other accounts).
 *
 * Responses never distinguish "unknown user" from "known user" — both increment
 * the same shape of counters and both see either 401 or 429.
 */

export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;

export function lockDurationMs(failures: number): number {
  if (failures < 5) return 0;
  if (failures < 10) return 30_000;
  if (failures < 15) return 5 * 60_000;
  if (failures < 20) return 15 * 60_000;
  return 60 * 60_000;
}

export function clientIpFrom(req: Request): string {
  const trust = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
  if (trust) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first.slice(0, 128);
    }
    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real.slice(0, 128);
  }
  const fallback = req.headers.get("x-real-ip")?.trim();
  return (fallback || "unknown").slice(0, 128);
}

export function accountKey(username: string): string {
  return `acct:${username.trim().toLowerCase().slice(0, 128)}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip.slice(0, 128)}`;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

type BucketRow = {
  key: string;
  failures: number;
  window_started_at: Date;
  locked_until: Date | null;
};

async function readBucket(key: string): Promise<BucketRow | null> {
  const res = await db.execute(sql`
    SELECT key, failures, window_started_at, locked_until
    FROM auth_rate_limits
    WHERE key = ${key}
  `);
  const row = res.rows[0] as
    | { key: string; failures: number | string; window_started_at: Date | string; locked_until: Date | string | null }
    | undefined;
  if (!row) return null;
  return {
    key: row.key,
    failures: Number(row.failures) || 0,
    window_started_at: new Date(row.window_started_at),
    locked_until: row.locked_until ? new Date(row.locked_until) : null,
  };
}

function lockedFor(row: BucketRow | null, now: number): number {
  if (!row?.locked_until) return 0;
  const until = row.locked_until.getTime();
  if (until <= now) return 0;
  return until - now;
}

/**
 * Reject the attempt if either the IP or the account is currently locked.
 * Does not consume a failure — callers record failures only after a real
 * authentication miss so a 429 itself cannot amplify the lock.
 */
export async function inspectAuthRateLimit(ip: string, username: string): Promise<RateLimitDecision> {
  const now = Date.now();
  const [ipRow, acctRow] = await Promise.all([
    readBucket(ipKey(ip)),
    readBucket(accountKey(username)),
  ]);
  const remaining = Math.max(lockedFor(ipRow, now), lockedFor(acctRow, now));
  if (remaining > 0) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
  }
  return { allowed: true };
}

async function bump(key: string): Promise<{ failures: number; lockedUntil: Date | null }> {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - AUTH_RATE_WINDOW_MS);

  // Insert or reset-if-window-expired, then increment. Two statements in one
  // round-trip keep concurrent attempts serialised on the row.
  await db.execute(sql`
    INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
    VALUES (${key}, 0, ${now}, NULL, ${now})
    ON CONFLICT (key) DO UPDATE
      SET failures = CASE
            WHEN auth_rate_limits.window_started_at < ${windowStartCutoff} THEN 0
            ELSE auth_rate_limits.failures
          END,
          window_started_at = CASE
            WHEN auth_rate_limits.window_started_at < ${windowStartCutoff} THEN ${now}
            ELSE auth_rate_limits.window_started_at
          END,
          locked_until = CASE
            WHEN auth_rate_limits.window_started_at < ${windowStartCutoff} THEN NULL
            ELSE auth_rate_limits.locked_until
          END,
          updated_at = ${now}
  `);

  const updated = await db.execute(sql`
    UPDATE auth_rate_limits
    SET failures = failures + 1,
        updated_at = ${now}
    WHERE key = ${key}
    RETURNING failures
  `);
  const failures = Number((updated.rows[0] as { failures?: number } | undefined)?.failures ?? 1);
  const lockMs = lockDurationMs(failures);
  let lockedUntil: Date | null = null;
  if (lockMs > 0) {
    lockedUntil = new Date(now.getTime() + lockMs);
    await db.execute(sql`
      UPDATE auth_rate_limits
      SET locked_until = ${lockedUntil}, updated_at = ${now}
      WHERE key = ${key}
    `);
  }
  return { failures, lockedUntil };
}

export async function recordAuthFailure(ip: string, username: string): Promise<RateLimitDecision> {
  const [ipBump, acctBump] = await Promise.all([
    bump(ipKey(ip)),
    bump(accountKey(username)),
  ]);
  const until = [ipBump.lockedUntil, acctBump.lockedUntil]
    .filter((d): d is Date => !!d)
    .map((d) => d.getTime());
  if (until.length === 0) return { allowed: true };
  const remaining = Math.max(...until) - Date.now();
  if (remaining <= 0) return { allowed: true };
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
}

export async function recordAuthSuccess(username: string): Promise<void> {
  // A successful login recovers the account identifier. The IP bucket is not
  // cleared: a shared NAT should not unlock an attacker targeting another
  // account from the same address.
  await db.execute(sql`
    DELETE FROM auth_rate_limits WHERE key = ${accountKey(username)}
  `);
}
