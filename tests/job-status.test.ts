import { describe, it, expect } from "vitest";
import {
  canTransition,
  isTerminal,
  isJobStatus,
  isLateSuccessAllowed,
  LATE_SUCCESS_MAX_AGE_MS,
  type JobStatus,
} from "../src/lib/job-status";

describe("job-status", () => {
  it("terminal states block further transitions", () => {
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(canTransition("success", "printing")).toBe(false);
    expect(canTransition("success", "failed")).toBe(false);
    expect(canTransition("expired", "success")).toBe(false);
    // failed is terminal EXCEPT the documented late-physical-outcome
    // override failed -> success, which is only honoured by the API when
    // isLateSuccessAllowed() also passes (error marker + 24h recency).
    expect(canTransition("failed", "printing")).toBe(false);
    expect(canTransition("failed", "failed")).toBe(false);
    expect(canTransition("failed", "success")).toBe(true);
  });
  it("allowed: claimed->printing and printing->terminal", () => {
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
  });
  it("agent rejection path: claimed->queued", () => {
    // The route gates this on reason "pending_full" (see PATCH /api/agent/jobs).
    expect(canTransition("claimed", "queued")).toBe(true);
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

  describe("isLateSuccessAllowed", () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const at = (iso: string) => new Date(iso);
    const job = (overrides: { status: JobStatus; error: string | null; updatedAt: Date }) => ({
      ...overrides,
    });

    it("allows a sweep failure marked AGENT_EXECUTION_TIMEOUT while recent", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "AGENT_EXECUTION_TIMEOUT (retried 2/3)",
            updatedAt: at("2026-09-06T11:00:00.000Z"),
          }),
          now,
        ),
      ).toBe(true);
    });

    it("allows a sweep failure marked AGENT_RESTART_DURING_PRINT", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "AGENT_RESTART_DURING_PRINT",
            updatedAt: at("2026-09-06T11:00:00.000Z"),
          }),
          now,
        ),
      ).toBe(true);
    });

    it("rejects a real print failure (no sweep marker)", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "connection refused: printer offline",
            updatedAt: at("2026-09-06T11:00:00.000Z"),
          }),
          now,
        ),
      ).toBe(false);
    });

    it("rejects a failure older than the 24h window", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "AGENT_EXECUTION_TIMEOUT",
            updatedAt: new Date(now - LATE_SUCCESS_MAX_AGE_MS - 1),
          }),
          now,
        ),
      ).toBe(false);
    });

    it("rejects when the job is not in failed state", () => {
      expect(
        isLateSuccessAllowed(
          job({ status: "success", error: "AGENT_EXECUTION_TIMEOUT", updatedAt: at("2026-09-06T11:00:00.000Z") }),
          now,
        ),
      ).toBe(false);
    });

    it("rejects null error", () => {
      expect(
        isLateSuccessAllowed(job({ status: "failed", error: null, updatedAt: at("2026-09-06T11:00:00.000Z") }), now),
      ).toBe(false);
    });
  });
});
