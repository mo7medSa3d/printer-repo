import { NextResponse } from "next/server";
import { validateManager } from "../../../../../lib/manager-auth";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, jti: claims.jti, exp: claims.exp });
}
