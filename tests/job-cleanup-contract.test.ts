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
    expect(src).toContain("queued/claimed/printing");
  });

  it("surfaces a confirmed cleanup action in the Gateway dashboard", () => {
    const page = read("src/app/dashboard/page.tsx");
    const button = read("src/components/JobCleanupButton.tsx");
    expect(page).toContain("<JobCleanupButton />");
    expect(button).toContain("Clean jobs");
    expect(button).toContain('method: "DELETE"');
    expect(button).toContain("completed, failed and expired jobs");
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

  it("only deletes terminal records from the Agent local queue", () => {
    const queue = read("agent/internal/queue/cleanup.go");
    expect(queue).toContain("status IN ('success', 'failed')");
    expect(queue).toContain("Queued and");
    expect(queue).toContain("printing jobs are deliberately preserved");
  });
});
