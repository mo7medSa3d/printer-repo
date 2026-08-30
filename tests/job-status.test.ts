import { describe, it, expect } from "vitest";
import { canTransition, isTerminal, isJobStatus } from "@/lib/job-status";

describe("job-status", () => {
  it("terminal blocks all", () => {
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(canTransition("success", "printing")).toBe(false);
    expect(canTransition("failed", "success")).toBe(false);
  });
  it("allowed: claimed->printing", () => {
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
  });
  it("disallowed: queued is agent never sets", () => {
    expect(canTransition("queued", "printing")).toBe(false);
  });
  it("isJobStatus", () => {
    expect(isJobStatus("queued")).toBe(true);
    expect(isJobStatus("bogus")).toBe(false);
  });
});
