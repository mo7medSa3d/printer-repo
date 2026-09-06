import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("production fixes contracts (2026-09)", () => {
  it("odoo sync wipe guard: an empty list cannot silently disable every row", () => {
    const sync = read("src/app/api/odoo/sync/route.ts");
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
    expect(sync.split("!wipeRequested").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("odoo sync GET is metadata-only and caps jobIds at 50", () => {
    const sync = read("src/app/api/odoo/sync/route.ts");
    expect(sync).toContain("const MAX_SYNC_JOB_IDS = 50;");
    expect(sync).toContain("if (ids.length > MAX_SYNC_JOB_IDS) return null;");
    expect(sync).toContain("jobIds accepts at most ${MAX_SYNC_JOB_IDS} ids");
    const colsStart = sync.indexOf("const SYNC_JOB_COLUMNS = {");
    const colsEnd = sync.indexOf("} as const;", colsStart);
    expect(colsStart).toBeGreaterThan(-1);
    const cols = sync.slice(colsStart, colsEnd);
    expect(cols).toContain("status: printJobs.status");
    expect(cols).toContain("error: printJobs.error");
    expect(cols).not.toContain("payload");
    expect(sync).toContain('return NextResponse.json({ branchId: branchFilter, agents: [], printers: [], jobs: jobRows, syncStatus: "success" });');
  });

  it("heartbeat print-lease keep-alive: bounded job id list only, scoped to claimed/printing", () => {
    const hb = read("src/app/api/agent/heartbeat/route.ts");
    const normalized = hb.replace(/\s+/g, " ");
    expect(normalized).toContain("const MAX_KEEP_ALIVE_JOB_IDS = 64;");
    expect(normalized).toContain(".slice(0, MAX_KEEP_ALIVE_JOB_IDS)");
    expect(normalized).toContain("eq(printJobs.agentId, agent.id)");
    expect(normalized).toContain('inArray(printJobs.status, ["claimed", "printing"])');
    expect(normalized).toContain("db.update(printJobs) .set({ updatedAt: new Date() })");
    expect(normalized).not.toContain("db.update(printJobs) .set({ status");
  });

  it("agent rejection gate: claimed->queued only with reason 'pending_full' (no retry burn)", () => {
    const jobs = read("src/app/api/agent/jobs/route.ts");
    expect(jobs).toContain('reason !== "pending_full"');
    expect(jobs).toContain("claimed -> queued requires reason 'pending_full'");
  });

  it("Go agent: size-aware print timeout and per-write stall deadline", () => {
    const agent = read("agent/internal/agent/agent.go");
    expect(agent).toContain("printCtx, cancel := context.WithTimeout(ctx, printDocumentTimeout(len(pl.Data)))");
    expect(agent).toContain("func printDocumentTimeout(payloadBytes int) time.Duration {");
    expect(agent).toContain("a.rejectJob(jobID)");
    expect(agent).toContain('"reason": "pending_full"');
    expect(agent).toContain("discoverySem: make(chan struct{}, 1)");
    const net = read("agent/internal/printer/network.go");
    expect(net).toContain("dialTimeout = 10 * time.Second");
    expect(net).toContain("writeStallTimeout = 60 * time.Second");
    expect(net).toContain("_ = conn.SetWriteDeadline(time.Now().Add(writeStallTimeout))");
    expect(net).not.toContain("conn.SetDeadline(");
  });

  it("Go agent: interrupted jobs are reprinted, not skipped as processed", () => {
    const agent = read("agent/internal/agent/agent.go");
    expect(agent).toContain("recoverInterruptedJobs");
    expect(agent).toContain("WasInterrupted");
  });

  it("job-maintenance: stale PRINTING jobs are requeued until retry budget is exhausted", () => {
    const jm = read("src/lib/job-maintenance.ts");
    expect(jm).toContain("AGENT_EXECUTION_TIMEOUT");
    expect(jm).toContain("requeuedPrinting");
    expect(jm).toContain("MAX_RETRIES");
  });

  it("Odoo cron reconciliation is bounded and batched", () => {
    const jobs = read("odoo_addons/print_gateway/models/print_job.py");
    expect(jobs).toContain("max_jobs = 100");
    expect(jobs).toContain("max_branches = 20");
    expect(jobs).toContain("max_runtime_seconds = 30");
    expect(jobs).toContain("request_timeout_seconds = 5");
    expect(jobs).toContain("batch_size = 50");
    expect(jobs).toContain("/api/odoo/sync");
    expect(jobs).toContain("jobIds");
    expect(jobs).not.toContain("pending.action_sync_status()");
  });

  it("production startup refuses plaintext manager passwords", () => {
    const server = read("server.ts");
    expect(server).toContain("process.env.NODE_ENV === \"production\" && process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD === \"1\"");
    expect(server).toContain("Refusing production startup with ALLOW_PLAINTEXT_MANAGER_PASSWORD=1");
    expect(server).not.toContain("ALLOW_PLAINTEXT_MANAGER_PASSWORD=1 in production: the manager password is held in the environment");
  });

  it("Tauri background stop never uses global taskkill by image name", () => {
    const agent = read("src-tauri/src/agent.rs");
    expect(agent).toContain("const BACKGROUND_PID_FILE: &str = \"agent.pid\";");
    expect(agent).toContain("taskkill_pid(pid, false)");
    expect(agent).toContain("taskkill_pid(pid, true)");
    expect(agent).not.toContain('.args(["/IM", "OdooPrintAgent.exe"])');
    expect(agent).not.toContain('.args(["/F", "/IM", "OdooPrintAgent.exe"])');
  });
});
