import { NextResponse } from "next/server";
import { validateManager, revokeManagerSession, clearManagerCookieHeader } from "../../../../../lib/manager-auth";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (claims) {
    await revokeManagerSession(claims.jti).catch(() => {});
  }
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearManagerCookieHeader());
  return res;
}
