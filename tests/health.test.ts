import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { hasTestDatabase, applyMigrations, closePool } from "./helpers/pg";
import { GET as healthGET } from "../src/app/api/health/route";

describe("health endpoint contract", () => {
  it("does not expose inventory or job counts", () => {
    const src = readFileSync("src/app/api/health/route.ts", "utf8");
    expect(src).not.toContain("agentCounts");
    expect(src).not.toContain("printerCounts");
    expect(src).not.toContain("jobCounts");
    expect(src).not.toContain("from(agents)");
    expect(src).not.toContain("from(printers)");
    expect(src).not.toContain("from(printJobs)");
    expect(src).toContain("ok: true");
    expect(src).toContain("ok: false");
  });
});

const suite = describe.skipIf(!hasTestDatabase);

suite("health endpoint (live)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  afterAll(async () => {
    await closePool();
  });

  it("returns { ok: true } and nothing else material", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(body.agents).toBeUndefined();
    expect(body.printers).toBeUndefined();
    expect(body.jobs).toBeUndefined();
  });
});
