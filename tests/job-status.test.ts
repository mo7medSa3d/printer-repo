import { describe, it, expect } from "vitest";
import { canTransition, isTerminal, isJobStatus } from "../src/lib/job-status";

describe("job-status", () => {
  it("terminal blocks all", () => {
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(canTransition("success", "printing")).toBe(false);
    expect(canTransition("failed", "success")).toBe(false);
  });
  it("allowed: claimed->printing and printing->terminal", () => {
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
  });
  it("expired jobs may be finalized by an agent after local TTL observation", () => {
    expect(canTransition("claimed", "expired")).toBe(true);
    expect(canTransition("printing", "expired")).toBe(true);
  });
  it("disallowed: queued is agent never sets", () => {
    expect(canTransition("queued", "printing")).toBe(false);
  });
  it("isJobStatus", () => {
    expect(isJobStatus("queued")).toBe(true);
    expect(isJobStatus("bogus")).toBe(false);
  });
});
