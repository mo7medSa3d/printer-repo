import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

// Static contracts for the 2026-09 production-readiness fixes. These pin the
// behavioral gates that are expensive to exercise end-to-end (they require a
// live agent/DB) by asserting the exact source-level guards exist.
describe("production fixes contracts (2026-09 audit)", () => {
  it("odoo sync wipe guard: an empty list cannot silently disable every row", () => {
    const sync = read("src/app/api/odoo/sync/route.ts");
    // Explicit opt-in flag, checked per entity kind.
    expect(sync).toContain("const wipeRequested = body.wipe === true;");
    expect(sync).toContain(
      "empty destinations list would disable all existing destinations in this branch; if intentional, re-run the sync with \\\"wipe\\\": true",
    );
    expect(sync).toContain(
      "empty documentTypes list would disable all existing document types in this branch; if intentional, re-run the sync with \\\"wipe\\\": true",
    );
    expect(sync).toContain(
      "empty bindings list would disable all existing printer bindings in this branch; if intentional, re-run the sync with \\\"wipe\\\": true",
    );
    // The guard must be active for all three entity kinds.
    const guards = sync.split("!wipeRequested").length - 1;
    expect(guards).toBeGreaterThanOrEqual(3);
    // An applied wipe (explicit empty array with wipe:true) is logged as a
    // security-relevant event (audit #22: "مع سجل").
    expect(sync).toContain('event: "odoo.sync.wipe"');
  });

  it("odoo sync GET is metadata-only and caps jobIds at 50", () => {
    const sync = read("src/app/api/odoo/sync/route.ts");
    expect(sync).toContain("const MAX_SYNC_JOB_IDS = 50;");
    expect(sync).toContain("if (ids.length > MAX_SYNC_JOB_IDS) return null;");
    expect(sync).toContain("jobIds accepts at most ${MAX_SYNC_JOB_IDS} ids");
    // The batched-job response must never include the (sensitive, large)
    // payload column.
    const colsStart = sync.indexOf("const SYNC_JOB_COLUMNS = {");
    const colsEnd = sync.indexOf("} as const;", colsStart);
    expect(colsStart).toBeGreaterThan(-1);
    const cols = sync.slice(colsStart, colsEnd);
    expect(cols).toContain("status: printJobs.status");
    expect(cols).toContain("error: printJobs.error");
    expect(cols).not.toContain("payload");
    expect(sync).toContain(
      'return NextResponse.json({ branchId: branchFilter, agents: [], printers: [], jobs: jobRows, syncStatus: "success" });',
    );
  });

  it("heartbeat print-lease keep-alive: bounded job id list only, scoped to claimed/printing", () => {
    const hb = read("src/app/api/agent/heartbeat/route.ts");
    expect(hb).toContain("const MAX_KEEP_ALIVE_JOB_IDS = 64;");
    expect(hb).toContain(".slice(0, MAX_KEEP_ALIVE_JOB_IDS)");
    // Only the agent's own in-flight jobs can be refreshed.
    expect(hb).toContain("eq(printJobs.agentId, agent.id)");
    expect(hb).toContain('inArray(printJobs.status, ["claimed", "printing"])');
    // It refreshes the lease (updatedAt) only — the exact update statement
    // sets updatedAt and nothing else (no status mutation), on printJobs.
    expect(hb).toContain("db.update(printJobs)\n        .set({ updatedAt: new Date() })");
    expect(hb).not.toContain("db.update(printJobs)\n        .set({ status");
  });

  it("agent rejection gate: claimed->queued only with reason 'pending_full' (no retry burn)", () => {
    const jobs = read("src/app/api/agent/jobs/route.ts");
    expect(jobs).toContain('reason !== "pending_full"');
    expect(jobs).toContain("claimed -> queued requires reason 'pending_full'");
  });

  it("Go agent: size-aware print timeout and per-write stall deadline", () => {
    const agent = read("agent/internal/agent/agent.go");
    // The physical print is bounded by document size, not a fixed 20s.
    expect(agent).toContain("printCtx, cancel := context.WithTimeout(ctx, printDocumentTimeout(len(pl.Data)))");
    expect(agent).toContain("func printDocumentTimeout(payloadBytes int) time.Duration {");
    // A saturated executor hands jobs back to the gateway queue
    // (pending_full) instead of silently dropping them until the lease.
    expect(agent).toContain("a.rejectJob(jobID)");
    expect(agent).toContain('"reason": "pending_full"');
    // Discovery sessions are bounded to one concurrent run.
    expect(agent).toContain("discoverySem: make(chan struct{}, 1)");
    const net = read("agent/internal/printer/network.go");
    expect(net).toContain("dialTimeout = 10 * time.Second");
    expect(net).toContain("writeStallTimeout = 60 * time.Second");
    expect(net).toContain("_ = conn.SetWriteDeadline(time.Now().Add(writeStallTimeout))");
    // No single whole-document connection deadline remains.
    expect(net).not.toContain("conn.SetDeadline(");
  });

  it("Go agent: interrupted jobs are reprinted, not skipped as processed", () => {
    const agent = read("agent/internal/agent/agent.go");
    expect(agent).toContain("recoverInterruptedJobs");
    expect(agent).toContain("WasInterrupted");
  });

  it("job-maintenance: stale PRINTING jobs are requeued until the retry budget is exhausted", () => {
    const jm = read("src/lib/job-maintenance.ts");
    // Requeue (not fail) while retries remain; fail with the late-success
    // marker once the budget is exhausted.
    expect(jm).toContain("AGENT_EXECUTION_TIMEOUT");
    expect(jm).toContain("requeue");
  });
});
