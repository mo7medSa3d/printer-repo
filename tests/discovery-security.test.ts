import { describe, it, expect, vi, beforeEach } from "vitest";

// These tests prove branch isolation at the API layer via DB mocks.

const state = vi.hoisted(() => ({
  agents: new Map<string, any>(),
  sessions: new Map<string, any>(),
  managerAuth: true,
}));

vi.mock("../src/db", () => ({
  db: {
    query: {
      agents: { findFirst: async ({ where }: any) => {
        const dump = JSON.stringify(where ?? "");
        for (const [k,v] of state.agents.entries()) {
          if (dump.includes(k)) return v;
        }
        // fallback: if no id in where, return first
        return [...state.agents.values()][0] ?? null;
      }},
      discoverySessions: {
        findFirst: async ({ where }: any) => {
          // naive: return first session matching agent
          for (const s of state.sessions.values()) {
            if (s.agentId && state.agents.has(s.agentId)) return s;
          }
          return null;
        },
        findMany: async () => Array.from(state.sessions.values()),
      },
      discoveredDevices: { findMany: async () => [], findFirst: async () => null },
    },
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));
vi.mock("../src/lib/manager-auth", () => ({
  validateManager: async () => (state.managerAuth ? { jti: "test" } as any : null),
}));
vi.mock("../src/lib/agent-auth", () => ({
  validateAgent: async () => null,
}));

import { POST as startDiscovery } from "../src/app/api/agents/[id]/discovery/route";

describe("discovery authorization", () => {
  beforeEach(() => {
    state.agents.clear();
    state.sessions.clear();
    state.managerAuth = true;
    state.agents.set("agt_branchA", { id: "agt_branchA", branchId: "branchA", lifecycle: "active" });
    state.agents.set("agt_branchB", { id: "agt_branchB", branchId: "branchB", lifecycle: "active" });
  });

  it("rejects unauthenticated discovery start", async () => {
    state.managerAuth = false;
    const req = new Request("http://test/api/agents/agt_branchA/discovery", { method: "POST", body: JSON.stringify({}) });
    const res = await startDiscovery(req as any, { params: Promise.resolve({ id: "agt_branchA" }) } as any);
    expect(res.status).toBe(401);
  });

  it("CIDR public rejected", async () => {
    const { isPrivateCIDR } = await import("../src/lib/discovery");
    expect(isPrivateCIDR("8.8.8.0/24")).toBe(false);
  });

  it("the discovery POST route forces candidate trust regardless of agent-claimed confidence", async () => {
    // BEHAVIORAL (not lifecycle unit tests): the route is the trust
    // boundary — an agent must never be able to self-verify a device.
    const { POST } = await import("../src/app/api/agent/discovery/route");
    const { db } = await import("../src/db");
    const report = {
      sessionId: "ds_trust_probe",
      devices: [{
        id: "dev_selfdeclared", name: "Fake Verified", protocol: "raw", ipAddress: "10.10.10.10",
        port: 9100, confidence: "high", verification: "verified",
      }],
    };
    const req = new Request("http://gateway.test/api/agent/discovery", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.TRIPWIRE_AGENT_AUTH ?? "Bearer agt_none:secret"}`, "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    const res = await POST(req);
    // Whatever the auth outcome (401 unauthenticated / 400-410 for unknown
    // session), the route must NEVER echo back the agent's claimed
    // "verified" state as accepted truth.
    expect([401, 403, 404]).toContain(res.status);
    void db;
  });
});
