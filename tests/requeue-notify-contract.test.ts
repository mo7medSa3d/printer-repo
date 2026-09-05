import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("drizzle/0017_notify_requeued_jobs.sql", "utf8");

describe("PostgreSQL requeue notification contract", () => {
  it("notifies on INSERT and queued transitions from UPDATE", () => {
    expect(migration).toContain("AFTER INSERT OR UPDATE OF status ON print_jobs");
    expect(migration).toContain("TG_OP = 'INSERT'");
    expect(migration).toContain("TG_OP = 'UPDATE'");
    expect(migration).toContain("NEW.status = 'queued'");
    expect(migration).toContain("OLD.status IS DISTINCT FROM NEW.status");
  });
});
