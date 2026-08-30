import { NextResponse } from "next/server";
import { createManagerSession, managerCookieHeader, verifyManagerPassword, getManagerUsername } from "@/lib/manager-auth";

export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }

  const expectedUser = getManagerUsername();
  if (!expectedUser) {
    // Not configured — in dev allow any? No, fail closed.
    return NextResponse.json({ error: "Manager auth not configured (set MANAGER_USERNAME / MANAGER_PASSWORD or MANAGER_PASSWORD_HASH)" }, { status: 500 });
  }

  if (!verifyManagerPassword(username, password)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  let sess;
  try {
    sess = await createManagerSession();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "session error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, expiresAt: sess.exp.toISOString() });
  res.headers.set("Set-Cookie", managerCookieHeader(sess.token, sess.exp));
  return res;
}
