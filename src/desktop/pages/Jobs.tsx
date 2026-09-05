import React, { useState } from "react";
import {
  CheckCircle2,
  Eye,
  Inbox,
  Printer as PrinterIcon,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Modal,
  Mono,
  StatusBadge,
  Tabs,
} from "@/components/ui";
import type { DesktopState } from "../types";
import {
  cleanupLocalJobs,
} from "../lib/ipc";
import {
  jobDocType,
  jobId,
  jobPrinterId,
  jobStatus,
  jobTone,
  labelJob,
} from "../lib/printers";

const TABS = ["all", "pending", "printing", "completed", "failed"] as const;

export function JobsPage({ s }: { s: DesktopState }) {
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const tabCounts = {
    all: s.jobCounts.all,
    pending: s.jobCounts.pending,
    printing: s.jobCounts.printing,
    completed: s.jobCounts.completed,
    failed: s.jobCounts.failed,
  };

  const handleCleanup = async () => {
    setCleanupBusy(true);
    try {
      const deleted = await cleanupLocalJobs();
      setCleanupOpen(false);
      s.setMsg({
        text:
          deleted === 0
            ? "No completed or failed local print jobs to remove."
            : `Removed ${deleted} terminal local print job${deleted === 1 ? "" : "s"}.`,
        type: "success",
      });
      // The table is sourced from the Gateway. Local cleanup intentionally
      // does not rewrite Gateway history, so no remote refresh is triggered.
    } catch (error) {
      s.setMsg({
        text: error instanceof Error ? error.message : "Failed to clean local print jobs",
        type: "error",
      });
    } finally {
      setCleanupBusy(false);
    }
  };

  return (
    <div className="space-y-7">
      <Card className="overflow-hidden">
        <div className="px-2">
          <Tabs tabs={TABS} active={s.jobTab} onChange={s.setJobTab} counts={tabCounts} />
        </div>
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-3"
              aria-hidden
            />
            <Input
              value={s.jobSearch}
              onChange={(e) => s.setJobSearch(e.target.value)}
              placeholder="Search job, document or printer…"
              className="pl-11"
              aria-label="Search jobs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={s.refreshJobs}
              loading={s.jobsLoading}
              icon={<RefreshCw className="h-[18px] w-[18px]" />}
            >
              Refresh
            </Button>
            <Button
              variant="ghost"
              onClick={() => setCleanupOpen(true)}
              disabled={cleanupBusy}
              icon={<Trash2 className="h-[18px] w-[18px]" />}
            >
              Clean local jobs
            </Button>
          </div>
        </div>
        {s.jobPrinterFilter && (
          <div className="flex items-center gap-3 border-t border-edge bg-surface-2/60 px-6 py-4">
            <span className="inline-flex items-center gap-2 rounded-lg border border-edge-accent bg-brand-subtle px-3 py-2 text-[13px] font-medium text-brand-subtle-text">
              <PrinterIcon className="h-4 w-4" aria-hidden />
              Filtered to <Mono className="text-inherit">{s.printerFilterName}</Mono>
              <button
                onClick={() => s.setJobPrinterFilter(null)}
                aria-label={`Clear printer filter ${s.printerFilterName}`}
                className="ml-0.5 rounded p-0.5 hover:bg-surface-2"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </span>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        {s.jobsLoading ? (
          <div className="p-6">
            <LoadingState rows={5} />
          </div>
        ) : s.jobsError ? (
          <div className="p-6">
            <ErrorState title="Jobs unavailable" message={s.jobsError} retry={s.refreshJobs} />
          </div>
        ) : s.jobsFiltered.length === 0 ? (
          <EmptyState
            icon={
              s.jobTab === "failed" ? (
                <XCircle className="h-10 w-10 text-bad" />
              ) : s.jobTab === "completed" ? (
                <CheckCircle2 className="h-10 w-10 text-ok" />
              ) : (
                <Inbox className="h-10 w-10" />
              )
            }
            title={
              s.jobPrinterFilter
                ? `No jobs for ${s.printerFilterName}`
                : s.jobTab === "all"
                ? "No print jobs yet"
                : `No ${s.jobTab} jobs`
            }
            description={
              s.jobPrinterFilter
                ? "This printer has no jobs in the current view — clear the filter to see the full queue."
                : s.jobTab === "failed"
                ? "Failed jobs will appear here with the reason and printer."
                : s.jobTab === "pending"
                ? "Queued jobs waiting for the agent to claim them."
                : "Print jobs will appear here as soon as the agent starts printing."
            }
            action={
              s.jobPrinterFilter ? (
                <Button
                  variant="secondary"
                  onClick={() => s.setJobPrinterFilter(null)}
                  icon={<X className="h-4 w-4" />}
                >
                  Clear filter
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge table-head text-left">
                  <th className="px-6 py-3">Document</th>
                  <th className="px-4 py-3">Job ID</th>
                  <th className="px-4 py-3">Printer</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {s.jobsFiltered.map((j) => (
                  <tr key={jobId(j)} className="border-b border-edge last:border-0 row-hover">
                    <td className="px-6 py-4">
                      <div className="text-[14px] font-semibold text-ink">{jobDocType(j)}</div>
                      {j.branchId ? (
                        <div className="text-[12px] text-ink-3">Branch {String(j.branchId)}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-4"><Mono>{jobId(j)}</Mono></td>
                    <td className="whitespace-nowrap px-4 py-4 text-[14px] text-ink-2">
                      {String(s.printers.find((p) => p.id === jobPrinterId(j))?.name || jobPrinterId(j) || "—")}
                    </td>
                    <td className="px-4 py-4"><StatusBadge tone={jobTone(jobStatus(j))} label={labelJob(jobStatus(j))} /></td>
                    <td className="whitespace-nowrap px-4 py-4 text-[13px] text-ink-3">
                      {j.createdAt ? new Date(String(j.createdAt)).toLocaleString() : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-[13px] text-ink-3">
                      {j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button size="sm" variant="secondary" onClick={() => s.setSelectedJob(j)} icon={<Eye className="h-4 w-4" />}>
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={cleanupOpen}
        onClose={() => {
          if (!cleanupBusy) setCleanupOpen(false);
        }}
        title="Clean local print jobs?"
        description="This clears terminal records from this PC's local Agent queue."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCleanupOpen(false)} disabled={cleanupBusy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleCleanup} loading={cleanupBusy} icon={<Trash2 className="h-4 w-4" />}>
              Clean local jobs
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p>Only completed and failed local records are removed.</p>
          <p>Queued and printing jobs are never touched.</p>
          <p>Gateway PostgreSQL history is not changed by this action.</p>
        </div>
      </Modal>
    </div>
  );
}
