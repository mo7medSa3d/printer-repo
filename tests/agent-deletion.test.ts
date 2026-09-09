import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  pool,
  sha256,
} from "./helpers/pg";
import { createManagerSession } from "../src/lib/manager-auth";
import { validateAgent, hashPairingCode } from "../src/lib/agent-auth";
import { POST as registerPOST } from "../src/app/api/agent/register/route";

let currentManagerToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (currentManagerToken ? { value: currentManagerToken } : undefined),
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Import actions after mocks
import { deleteAgent, createAgent } from "../src/app/actions";

const suite = describe.skipIf(!hasTestDatabase);

suite("permanent agent deletion lifecycle & invariants", () => {
  const prevTrustProxy = process.env.TRUST_PROXY;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
    process.env.MANAGER_USERNAME = "manager";
    process.env.TRUST_PROXY = "1";
    await applyMigrations();
  });

  afterAll(async () => {
    if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTrustProxy;
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    const session = await createManagerSession();
    currentManagerToken = session.token;
  });

  it("rejects deletion when unauthenticated or called with invalid manager token", async () => {
    currentManagerToken = null;
    await expect(deleteAgent("agt_offline_1")).rejects.toThrow("manager session has expired");

    currentManagerToken = "tampered.jwt.token";
    await expect(deleteAgent("agt_offline_1")).rejects.toThrow("manager session has expired");
  });

  it("rejects empty or whitespace agent ID", async () => {
    await expect(deleteAgent("")).rejects.toThrow("agent id is required");
    await expect(deleteAgent("   ")).rejects.toThrow("agent id is required");
    // @ts-expect-error test non-string input
    await expect(deleteAgent(null)).rejects.toThrow("agent id is required");
  });

  it("rejects deletion of a non-existent agent", async () => {
    await expect(deleteAgent("agt_non_existent")).rejects.toThrow("Agent not found");
  });

  it("rejects deletion of an online agent", async () => {
    const agentId = "agt_online_test";
    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, 'Online Agent', $2, 'online', 'active', now())`,
      [agentId, sha256("secret123")],
    );

    await expect(deleteAgent(agentId)).rejects.toThrow(
      "This agent is still connected. Stop the agent service first, then delete it.",
    );

    // Verify agent was NOT deleted
    const row = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    expect(row).toBeTruthy();
  });

  it("rejects deletion of a retired agent to preserve audit history", async () => {
    const agentId = "agt_retired_test";
    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, 'Retired Agent', $2, 'offline', 'retired', now())`,
      [agentId, sha256("secret123")],
    );

    await expect(deleteAgent(agentId)).rejects.toThrow(
      "Retired agents are kept for audit history and cannot be deleted.",
    );

    // Verify agent was NOT deleted
    const row = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    expect(row).toBeTruthy();
  });

  it("rejects deletion of an agent that has historical print jobs (audit retention)", async () => {
    const agentId = "agt_with_jobs";
    const printerId = "prn_with_jobs";
    const jobId = "job_audit_fixture";
    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, 'Job Agent', $2, 'offline', 'active', now())`,
      [agentId, sha256("secret123")],
    );
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, printer_type, connection_type, protocol, status, lifecycle)
       VALUES ($1, $2, 'Test Printer', 'physical', 'network', 'raw', 'offline', 'active')`,
      [printerId, agentId],
    );
    await pool().query(
      `INSERT INTO print_jobs (id, agent_id, printer_id, destination, status, payload, expires_at)
       VALUES ($1, $2, $3, 'POS-1', 'success', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`,
      [jobId, agentId, printerId],
    );

    await expect(deleteAgent(agentId)).rejects.toThrow(
      "This agent has print history and cannot be deleted. Choose Retire instead to preserve the audit history.",
    );

    // Verify neither agent, printer, nor print job was deleted
    const a = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows[0];
    const p = (await pool().query(`SELECT id FROM printers WHERE id = $1`, [printerId])).rows[0];
    const j = (await pool().query(`SELECT id FROM print_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(a).toBeTruthy();
    expect(p).toBeTruthy();
    expect(j).toBeTruthy();
  });

  it("deletes an eligible offline agent with no print jobs and cleans up removable runtime records", async () => {
    const agentId = "agt_clean_eligible";
    const printerId1 = "prn_clean_1";
    const printerId2 = "prn_clean_2";
    const discoveryId = "disc_session_1";
    const deviceId = "dev_candidate_1";

    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, 'Eligible Agent', $2, 'offline', 'active', now())`,
      [agentId, sha256("secret123")],
    );
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, printer_type, connection_type, protocol, status, lifecycle)
       VALUES ($1, $2, 'Printer 1', 'physical', 'network', 'raw', 'offline', 'active'),
              ($3, $2, 'Printer 2', 'physical', 'network', 'raw', 'offline', 'active')`,
      [printerId1, agentId, printerId2],
    );
    await pool().query(
      `INSERT INTO discovery_sessions (id, agent_id, status, config, stats)
       VALUES ($1, $2, 'completed', '{}'::jsonb, '{}'::jsonb)`,
      [discoveryId, agentId],
    );
    await pool().query(
      `INSERT INTO discovered_devices (id, discovery_id, agent_id, protocol, provisioned_printer_id)
       VALUES ($1, $2, $3, 'raw', $4)`,
      [deviceId, discoveryId, agentId, printerId1],
    );

    const result = await deleteAgent(agentId);
    expect(result).toEqual({ ok: true });

    // Verify agent and all associated runtime records are gone
    const agentRows = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId])).rows;
    expect(agentRows).toHaveLength(0);

    const printerRows = (await pool().query(`SELECT id FROM printers WHERE agent_id = $1`, [agentId])).rows;
    expect(printerRows).toHaveLength(0);

    const discRows = (await pool().query(`SELECT id FROM discovery_sessions WHERE agent_id = $1`, [agentId])).rows;
    expect(discRows).toHaveLength(0);

    const devRows = (await pool().query(`SELECT id FROM discovered_devices WHERE agent_id = $1`, [agentId])).rows;
    expect(devRows).toHaveLength(0);
  });

  it("invalidates credentials: deleted agent cannot authenticate or access endpoints", async () => {
    const agentId = "agt_auth_invalidation";
    const rawSecret = "my-super-secret-password-123";
    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle, last_seen_at)
       VALUES ($1, 'Auth Agent', $2, 'offline', 'active', now())`,
      [agentId, sha256(rawSecret)],
    );

    const authHeader = `Bearer ${agentId}:${rawSecret}`;

    // Agent authenticates successfully prior to deletion
    const validatedBefore = await validateAgent(authHeader);
    expect(validatedBefore).not.toBeNull();
    expect(validatedBefore?.id).toBe(agentId);

    // Delete agent
    await deleteAgent(agentId);

    // Agent authentication returns null (401 Unauthorized) after deletion
    const validatedAfter = await validateAgent(authHeader);
    expect(validatedAfter).toBeNull();
  });

  it("ensures old pairing code cannot be used to pair after agent deletion", async () => {
    const agentId = "agt_pairing_cleanup";
    const pairingCode = "KL77MN";
    await pool().query(
      `INSERT INTO agents (id, name, pairing_code_hash, pairing_code_expires_at, status, lifecycle)
       VALUES ($1, 'Pairing Agent', $2, now() + interval '30 minutes', 'offline', 'active')`,
      [agentId, hashPairingCode(pairingCode)],
    );

    // Delete agent before pairing code is consumed
    await deleteAgent(agentId);

    // Old pairing attempt fails
    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.88" },
      body: JSON.stringify({ pairingCode }),
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unknown, disabled, retired, or expired agent registration");
  });

  it("handles complete uninstall -> delete -> reinstall -> re-pair end-to-end flow", async () => {
    // 1. Initial Agent on Customer Windows PC
    const agentId1 = "agt_initial_pc";
    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle)
       VALUES ($1, 'Reception PC', $2, 'offline', 'active')`,
      [agentId1, sha256("old-secret")],
    );

    // 2. Windows Agent was uninstalled from PC; Agent remains offline in Gateway
    // 3. Administrator permanently deletes the Agent from Gateway
    await deleteAgent(agentId1);

    const check1 = (await pool().query(`SELECT id FROM agents WHERE id = $1`, [agentId1])).rows;
    expect(check1).toHaveLength(0);

    // 4. Customer installs fresh Windows Agent app; Administrator creates new Agent
    const freshAgent = await createAgent("Reception PC Reinstalled");
    expect(freshAgent.id).toBeTruthy();
    expect(freshAgent.id).not.toBe(agentId1);
    expect(freshAgent.pairingCode).toHaveLength(6);

    // 5. Windows Agent pairs with the new pairing code
    const registerRes = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.99" },
      body: JSON.stringify({
        pairingCode: freshAgent.pairingCode,
        metadata: { hostname: "reception-pc", os: "windows" },
      }),
    }));

    expect(registerRes.status).toBe(200);
    const registerBody = await registerRes.json();
    expect(registerBody.agentId).toBe(freshAgent.id);
    expect(registerBody.secret).toBeTruthy();

    // 6. Verify fresh agent is active, online, with new secret, decoupled from old agent
    const check2 = (await pool().query(`SELECT status, lifecycle, secret FROM agents WHERE id = $1`, [freshAgent.id])).rows[0];
    expect(check2.status).toBe("online");
    expect(check2.lifecycle).toBe("active");
    expect(check2.secret).toBe(sha256(registerBody.secret));
  });

  it("handles double-delete deterministically", async () => {
    const agentId = "agt_double_delete";
    await pool().query(
      `INSERT INTO agents (id, name, secret, status, lifecycle)
       VALUES ($1, 'Double Agent', $2, 'offline', 'active')`,
      [agentId, sha256("sec")],
    );

    // First delete succeeds
    await deleteAgent(agentId);

    // Second delete immediately throws "Agent not found"
    await expect(deleteAgent(agentId)).rejects.toThrow("Agent not found");
  });
});
