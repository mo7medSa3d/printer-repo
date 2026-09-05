import { db } from "../db";
import { sql } from "drizzle-orm";
import { isIP } from "node:net";

/**
 * Database-backed authentication rate limiter.
 *
 * Designed for the supported multi-instance deployment: every gateway process
 * shares PostgreSQL, so an in-memory limiter would be bypassed by spraying
 * attempts across instances. State lives in `auth_rate_limits`.
 *
 * Keys:
 *   ip:<client-ip>        — per source address when a trusted proxy is configured
 *   acct:<username>       — per login identifier (lowercased, trimmed)
 *   pairing-ip:<client-ip> — dedicated pairing endpoint budget, independent of code value
 *
 * When TRUST_PROXY is not explicitly enabled, the framework Request does not
 * expose a trustworthy TCP peer address. We therefore use account-scoped
 * limiting for manager login; pairing falls back to one shared bucket until a
 * trusted proxy is configured, preventing code rotation from bypassing limits.
 */

export const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
export const PAIRING_RATE_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_RATE_RETENTION_MS = 24 * 60 * 60 * 1000;

let warnedUntrustedProxy = false;

function trustProxyEnabled(): boolean {
  return process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
}

function warnUntrustedProxyOnce(): void {
  if (warnedUntrustedProxy || process.env.NODE_ENV !== "production") return;
  warnedUntrustedProxy = true;
  console.warn(
    "[auth-rate-limit] TRUST_PROXY is not enabled in production; IP-scoped auth rate limiting is disabled. " +
    "Set TRUST_PROXY only when the deployment is behind a trusted proxy that sanitizes forwarding headers."
  );
}

export function lockDurationMs(failures: number): number {
  if (failures < 5) return 0;
  if (failures < 10) return 30_000;
  if (failures < 15) return 5 * 60_000;
  if (failures < 20) return 15 * 60_000;
  return 60 * 60_000;
}

export function pairingLockDurationMs(failures: number): number {
  // Pairing keeps the requested six-digit UX. The progressively stronger
  // lockout prevents rotating through different six-digit values from
  // becoming an online brute-force oracle.
  if (failures < 5) return 0;
  if (failures < 10) return 30_000;
  if (failures < 15) return 5 * 60_000;
  if (failures < 20) return 15 * 60_000;
  return 60 * 60_000;
}

export function clientIpFrom(req: Request): string {
  if (!trustProxyEnabled()) {
    warnUntrustedProxyOnce();
    return "unknown";
  }

  const candidates = [
    ...(req.headers.get("x-forwarded-for")?.split(",") ?? []),
    req.headers.get("x-real-ip") ?? "",
  ];
  for (const candidate of candidates) {
    const ip = candidate.trim();
    if (ip && isIP(ip) !== 0) return ip.slice(0, 128);
  }
  return "unknown";
}

export function accountKey(username: string): string {
  return `acct:${username.trim().toLowerCase().slice(0, 128)}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip.slice(0, 128)}`;
}

function pairingIpKey(ip: string): string {
  return `pairing-ip:${ip.slice(0, 128)}`;
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

export async function inspectAuthRateLimit(ip: string, username: string): Promise<RateLimitDecision> {
  const now = Date.now();
  const account = readBucket(accountKey(username));
  if (!trustProxyEnabled() || ip === "unknown") {
    warnUntrustedProxyOnce();
    const acctRow = await account;
    const remaining = lockedFor(acctRow, now);
    return remaining > 0
      ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) }
      : { allowed: true };
  }

  const [ipRow, acctRow] = await Promise.all([readBucket(ipKey(ip)), account]);
  const remaining = Math.max(lockedFor(ipRow, now), lockedFor(acctRow, now));
  if (remaining > 0) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
  }
  return { allowed: true };
}

export async function inspectPairingRateLimit(ip: string): Promise<RateLimitDecision> {
  const now = Date.now();
  const row = await readBucket(pairingIpKey(ip));
  const remaining = lockedFor(row, now);
  return remaining > 0
    ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) }
    : { allowed: true };
}

async function bumpWith(
  key: string,
  windowMs: number,
  lockFn: (failures: number) => number,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowMs);
  return await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
      VALUES (${key}, 0, ${now}, NULL, ${now})
      ON CONFLICT (key) DO UPDATE SET updated_at = ${now}
    `);
    await tx.execute(sql`SELECT * FROM auth_rate_limits WHERE key = ${key} FOR UPDATE`);

    const cur = await tx.execute(sql`SELECT failures, window_started_at FROM auth_rate_limits WHERE key = ${key}`);
    const row = (cur.rows[0] as { failures?: number | string; window_started_at?: Date | string } | undefined)
      ?? { failures: 0, window_started_at: now };
    const windowExpired = new Date(row.window_started_at ?? now).getTime() < windowStartCutoff.getTime();
    const newFailures = windowExpired ? 1 : Number(row.failures ?? 0) + 1;
    const newWindowStart = windowExpired ? now : new Date(row.window_started_at ?? now);
    const lockMs = lockFn(newFailures);
    const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs) : null;

    const updated = await tx.execute(sql`
      UPDATE auth_rate_limits
      SET failures = ${newFailures},
          window_started_at = ${newWindowStart},
          locked_until = ${lockedUntil},
          updated_at = ${now}
      WHERE key = ${key}
      RETURNING failures, locked_until
    `);
    const ret = (updated.rows[0] as { failures?: number | string; locked_until?: Date | string | null } | undefined)
      ?? { failures: newFailures, locked_until: lockedUntil };
    return { failures: Number(ret.failures ?? newFailures), lockedUntil: ret.locked_until ? new Date(ret.locked_until) : null };
  });
}

async function bump(key: string): Promise<{ failures: number; lockedUntil: Date | null }> {
  return bumpWith(key, AUTH_RATE_WINDOW_MS, lockDurationMs);
}

export async function recordPairingFailure(ip: string): Promise<RateLimitDecision> {
  const keyIp = pairingIpKey(ip);
  const result = await bumpWith(keyIp, PAIRING_RATE_WINDOW_MS, pairingLockDurationMs);
  if (!result.lockedUntil) return { allowed: true };
  const remaining = result.lockedUntil.getTime() - Date.now();
  return remaining > 0
    ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) }
    : { allowed: true };
}

export async function cleanupAuthRateLimits(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTH_RATE_RETENTION_MS);
  const result = await db.execute(sql`
    DELETE FROM auth_rate_limits
    WHERE updated_at < ${cutoff}
    RETURNING key
  `);
  return result.rows.length;
}

export async function recordAuthFailure(ip: string, username: string): Promise<RateLimitDecision> {
  const accountBump = bump(accountKey(username));

  if (!trustProxyEnabled() || ip === "unknown") {
    warnUntrustedProxyOnce();
    const result = await accountBump;
    if (!result.lockedUntil) return { allowed: true };
    const remaining = result.lockedUntil.getTime() - Date.now();
    return remaining > 0
      ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) }
      : { allowed: true };
  }

  const [ipBump, acctBump] = await Promise.all([bump(ipKey(ip)), accountBump]);
  const until = [ipBump.lockedUntil, acctBump.lockedUntil]
    .filter((d): d is Date => !!d)
    .map((d) => d.getTime());
  if (until.length === 0) return { allowed: true };
  const remaining = Math.max(...until) - Date.now();
  if (remaining <= 0) return { allowed: true };
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
}

export async function recordAuthSuccess(username: string): Promise<void> {
  await db.execute(sql`DELETE FROM auth_rate_limits WHERE key = ${accountKey(username)}`);
}

export async function recordPairingSuccess(ip: string): Promise<void> {
  await db.execute(sql`DELETE FROM auth_rate_limits WHERE key = ${pairingIpKey(ip)}`);
}
