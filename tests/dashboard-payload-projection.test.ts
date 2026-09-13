import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  seedFixture,
  insertQueuedJob,
} from "./helpers/pg";
import { createManagerSession } from "../src/lib/manager-auth";
import type { Fixture } from "./helpers/pg";

let currentManagerToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (currentManagerToken ? { value: currentManagerToken } : undefined),
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Import actions after mocks (same ordering as agent-deletion.test.ts)
import { getDashboardState, getDashboardJobs } from "../src/app/actions";

const suite = describe.skipIf(!hasTestDatabase);

// Audit P1-02 regression: the dashboard 50-row list (page.tsx initial props
// AND the getDashboardState poll payload) must be metadata-only. Full
// payloads (base64 documents, multi-MB per job) are fetched per-job through
// GET /api/jobs/[id] by the inspector.
suite("dashboard list queries never carry full job payloads", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
    process.env.MANAGER_USERNAME = "manager";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    fixture = await seedFixture();
    const session = await createManagerSession(fixture.tenantId);
    currentManagerToken = session.token;
  });

  it("getDashboardState returns jobs without the payload column", async () => {
    await insertQueuedJob(fixture, "job_payload_probe_1");
    const state = await getDashboardState();
    expect(state.jobs.length).toBeGreaterThan(0);
    for (const job of state.jobs) {
      expect(job).not.toHaveProperty("payload");
      expect(job.id).toBe("job_payload_probe_1");
    }
  });

  it("getDashboardJobs returns jobs without the payload column", async () => {
    await insertQueuedJob(fixture, "job_payload_probe_2");
    const rows = await getDashboardJobs({ limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("payload");
    }
  });
});
