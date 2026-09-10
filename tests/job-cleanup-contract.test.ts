import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("print-job cleanup contract", () => {
  it("protects active Gateway jobs and requires manager authentication", () => {
    const src = read("src/app/api/jobs/route.ts");
    expect(src).toContain("export async function DELETE(req: Request)");
    expect(src).toContain("const claims = await validateManager(req)");
    expect(src).toContain('["success", "failed", "expired"]');
    expect(src).toContain("inArray(printJobs.status");
    expect(src).not.toContain(".delete(printJobs)\n    .where(inArray(printJobs.status");
    expect(src).toContain("confirm=1");
    expect(src).toContain("MAX_CLEANUP_ROWS = 5000");
    expect(src).toContain("before=<ISO-8601 timestamp>");
  });

  it("surfaces a confirmed bounded retention action in the Gateway dashboard", () => {
    const page = read("src/app/dashboard/page.tsx");
    const button = read("src/components/JobCleanupButton.tsx");
    expect(page).toContain("<JobCleanupButton />");
    expect(button).toContain("Clean jobs");
    expect(button).toContain('method: "DELETE"');
    expect(button).toContain("RETENTION_DAYS = 30");
    expect(button).toContain("limit=5000&confirm=1");
  });

  it("exposes local cleanup through the typed Desktop IPC boundary", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    const rust = read("src-tauri/src/main.rs");
    const command = read("src-tauri/src/cleanup.rs");
    expect(ipc).toContain('invoke<number>("cleanup_local_jobs")');
    expect(rust).toContain("cleanup::cleanup_local_jobs");
    expect(command).toContain('arg("jobs")');
    expect(command).toContain('arg("cleanup")');
  });

  it("only deletes PROVABLY terminal records from the Agent local queue", () => {
    const queue = read("agent/internal/queue/cleanup.go");
    // Unknown-outcome evidence survives cleanup: deleting a row whose last
    // error carries ANY unknown-outcome marker would erase the local
    // duplicate-print protection and the operator's reconciliation record.
    // The SQL is derived from the CANONICAL marker list (queue.UnknownOutcomeMarkers)
    // so cleanup can never drift behind the marker vocabulary again — the
    // old implementation preserved only 2 of the 5 markers.
    expect(queue).toContain("status = 'success'");
    expect(queue).toContain("unknownMarkerSQL(\"last_error\")");
    expect(queue).toContain("UnknownOutcomeMarkers");
    // The canonical marker vocabulary is declared once (queue.go) and is
    // separately locked by queue_test.go / outcome_test.go.
    const markers = read("agent/internal/queue/queue.go");
    for (const marker of [
      "AGENT_EXECUTION_TIMEOUT",
      "AGENT_RESTART_DURING_PRINT",
      "JOB_EXPIRED_DURING_PRINT",
      "UNKNOWN_PARTIAL_DELIVERY",
      "UNKNOWN_SUBMISSION_OUTCOME",
    ]) {
      expect(markers).toContain(marker);
    }
    const purge = read("agent/cmd/cli/cleanup.go");
    // purging unknown-outcome evidence is a separate deliberate operation.
    expect(purge).toContain("--include-unknown");
  });
});
