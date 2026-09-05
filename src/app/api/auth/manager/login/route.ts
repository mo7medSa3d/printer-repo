import { NextResponse } from "next/server";
import { createManagerSession, managerCookieHeader, verifyManagerPassword, getManagerUsername } from "@/lib/manager-auth";
import {
  clientIpFrom,
  inspectAuthRateLimit,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/auth-rate-limit";
import { hasBodyOverLimit } from "@/lib/request-limits";
import { logWarn, logInfo, requestIdFrom } from "@/lib/log";

const INVALID = "Invalid credentials";

function tooMany(retryAfterSec: number) {
  const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  res.headers.set("Retry-After", String(retryAfterSec));
  return res;
}

export async function POST(req: Request) {
  const requestId = requestIdFrom(req);
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.slice(0, 128) : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password || password.length > 4096) {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }

  const expectedUser = getManagerUsername();
  if (!expectedUser) {
    return NextResponse.json({ error: "Manager auth not configured (set MANAGER_USERNAME / MANAGER_PASSWORD or MANAGER_PASSWORD_HASH)" }, { status: 500 });
  }

  const ip = clientIpFrom(req);

  try {
    const pre = await inspectAuthRateLimit(ip, username);
    if (!pre.allowed) {
      logWarn("auth.login.rate_limited", { requestId, ip, retryAfterSec: pre.retryAfterSec });
      return tooMany(pre.retryAfterSec);
    }
  } catch (e) {
    logWarn("auth.login.rate_limit_unavailable", { requestId, error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 });
  }

  if (!verifyManagerPassword(username, password)) {
    let locked: { allowed: false; retryAfterSec: number } | null = null;
    try {
      const after = await recordAuthFailure(ip, username);
      if (!after.allowed) locked = after;
    } catch (e) {
      logWarn("auth.login.rate_limit_record_failed", { requestId, error: e instanceof Error ? e.message : "unknown" });
    }
    logWarn("auth.login.failed", { requestId, ip });
    if (locked) return tooMany(locked.retryAfterSec);
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

  try {
    await recordAuthSuccess(username);
  } catch (e) {
    logWarn("auth.login.rate_limit_clear_failed", { requestId, error: e instanceof Error ? e.message : "unknown" });
  }

  let sess;
  try {
    sess = await createManagerSession();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "session error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  logInfo("auth.login.success", { requestId, ip });
  const res = NextResponse.json({ ok: true, expiresAt: sess.exp.toISOString() });
  res.headers.set("Set-Cookie", managerCookieHeader(sess.token, sess.exp));
  res.headers.set("X-Request-Id", requestId);
  return res;
}
