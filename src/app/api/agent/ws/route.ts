import { NextResponse } from "next/server";

// Next.js route handlers cannot hold WebSocket upgrades.
// The real Agent ↔ Gateway WS is handled in server.ts via attachAgentWSS().
// This stub exists so a direct HTTP GET doesn't look like a missing route.
export async function GET() {
  return NextResponse.json(
    { error: "WebSocket endpoint — connect via WSS upgrade at /api/agent/ws with Authorization: Bearer <agentId>:<secret>" },
    { status: 426, headers: { Upgrade: "websocket" } }
  );
}
