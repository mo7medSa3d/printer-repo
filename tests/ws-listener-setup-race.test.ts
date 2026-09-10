import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import type { PoolClient } from "pg";
import { hasTestDatabase, applyMigrations, closePool, pool } from "./helpers/pg";
import { pool as gatewayPool } from "../src/db";
import { attachAgentWSS } from "../src/server/ws";

// LISTEN-setup race: if the LISTEN statements themselves throw (DB restart
// landing between pool.connect() and LISTEN), the listener must keep
// retrying - never wedge itself into a permanently dead state. The old code
// assigned activeClient BEFORE the LISTEN calls, so the retry guard
// (`if (stopped || activeClient) return`) refused every later attempt while
// the half-initialized, handler-less client sat unreleased. Push delivery
// then silently died for the process lifetime (polling masked it).
const suite = describe.skipIf(!hasTestDatabase);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("PostgreSQL notification listener setup race", () => {
  let server: Server;

  beforeAll(async () => {
    await applyMigrations();
    server = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  it("retries LISTEN continuously when setup itself keeps failing, then recovers", async () => {
    let listenAttempts = 0;
    const released: unknown[][] = [];
    const fakeClient = {
      query: async (text: string) => {
        if (/LISTEN/i.test(text)) {
          listenAttempts += 1;
          throw new Error("terminating connection due to administrator command");
        }
        return { rows: [] };
      },
      release: (...args: unknown[]) => {
        released.push(args);
      },
      on: () => {},
    };
    // Spy the pool the gateway server actually uses (src/db), not the test
    // helper pool: ws.ts resolves pool.connect() against that object.
    const connectSpy = vi.spyOn(gatewayPool, "connect").mockImplementation(async () => fakeClient as unknown as PoolClient);

    attachAgentWSS(server, { enableJobNotifications: true });

    // Backoff is 1s, 2s, 4s...: three failed setup windows must each
    // re-attempt LISTEN. Against the old code the counter would freeze at 1
    // (the guard sees the stale activeClient) and push delivery would be
    // dead until process restart.
    const started = Date.now();
    while (listenAttempts < 3 && Date.now() - started < 15_000) {
      await sleep(100);
    }
    expect(listenAttempts).toBeGreaterThanOrEqual(3);
    // No half-initialized client may be retained: every failed setup must
    // release its client instead of parking it in activeClient.
    expect(released.length).toBeGreaterThanOrEqual(3);

    // Recovery: restore the real pool and prove a live LISTEN backend
    // appears (same observable the CI failure-injection script uses).
    connectSpy.mockRestore();
    const found = await (async () => {
      const begin = Date.now();
      while (Date.now() - begin < 40_000) {
        const result = await pool().query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE query ILIKE 'LISTEN print_gateway_agent%' AND pid <> pg_backend_pid()`,
        );
        if (result.rows.length > 0) return result.rows[0].pid;
        await sleep(250);
      }
      return null;
    })();
    expect(found).not.toBeNull();
  });
});
