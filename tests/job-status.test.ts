import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  canTransition,
  isTerminal,
  isJobStatus,
  isLateSuccessAllowed,
  LATE_SUCCESS_MAX_AGE_MS,
  PHYSICAL_OUTCOME_UNKNOWN_MARKERS,
  derivePhysicalOutcome,
  type JobStatus,
} from "../src/lib/job-status";

describe("job-status", () => {
  it("unknown-outcome markers stay in lockstep across all layers", () => {
    // The marker TEXT is the wire protocol between the Go agent, this
    // gateway, Odoo, and the desktop UX: a marker renamed in one layer
    // silently converts unknown outcomes into auto-retryable failures in
    // another (physical double prints). This is the one place a literal
    // comparison is the correct test: it locks the three independent lists
    // to identical values. (Odoo's _GATEWAY_UNKNOWN_MARKERS is locked by
    // test_marker_parity in the addon suite.)
    const go = readFileSync("agent/internal/printer/outcome.go", "utf8");
    for (const marker of PHYSICAL_OUTCOME_UNKNOWN_MARKERS) {
      expect(go).toContain(`"${marker}"`);
    }
    expect(PHYSICAL_OUTCOME_UNKNOWN_MARKERS).toHaveLength(5);
    expect(derivePhysicalOutcome("failed", "UNKNOWN_SUBMISSION_OUTCOME: x")).toBe("unknown");
    expect(derivePhysicalOutcome("failed", "CONNECTION_ERROR: x")).toBe("not_printed");
  });
  it("terminal states block further transitions", () => {
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(canTransition("success", "printing")).toBe(false);
    expect(canTransition("success", "failed")).toBe(false);
    expect(canTransition("expired", "success")).toBe(false);
    // failed is terminal. The ONLY exception is the explicitly authorized
    // late-physical-outcome override (failed -> success), which the API
    // grants solely when isLateSuccessAllowed() also passes (error marker +
    // 24h recency). The general table must say NO without that opt-in, so a
    // second consumer of canTransition cannot silently rewrite failures.
    expect(canTransition("failed", "printing")).toBe(false);
    expect(canTransition("failed", "failed")).toBe(false);
    expect(canTransition("failed", "success")).toBe(false);
    expect(canTransition("failed", "success", { allowLateSuccess: true })).toBe(true);
    expect(canTransition("failed", "printing", { allowLateSuccess: true })).toBe(false);
    expect(canTransition("success", "success", { allowLateSuccess: true })).toBe(false);
  });
  it("allowed: claimed->printing and printing->terminal", () => {
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
  });
  it("agent rejection path: claimed->queued", () => {
    // The route gates this on an explicit fenced reason (AGENT_REQUEUE_REASONS).
    expect(canTransition("claimed", "queued")).toBe(true);
  });
  it("expired jobs may be finalized by an agent after local TTL observation", () => {
    // Expiration is isolated to the dedicated atomic route branch
    // (expires_at <= NOW() + fencedJobWrite). It is intentionally absent
    // from the generic transition table so a live job can never be
    // terminalized early via canTransition.
    expect(canTransition("claimed", "expired")).toBe(false);
    expect(canTransition("printing", "expired")).toBe(false);
    expect(canTransition("queued", "expired")).toBe(false);
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
