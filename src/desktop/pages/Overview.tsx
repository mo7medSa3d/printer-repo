import React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  Play,
  Printer as PrinterIcon,
  RefreshCw,
  Server,
  Settings,
  Zap,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  Mono,
  StatusBadge,
} from "../../components/ui";
import {
  DetailList,
  StatCard,
  StatusNotice,
  ViewAllButton,
} from "../ui";
import { PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import {
  humanConnection,
  humanType,
  isProductionPrinter,
  jobDocType,
  jobId,
  jobPrinterId,
  jobStatus,
  labelJob,
  toneJob,
  labelPrinter,
  printerEndpoint,
  printerTone,
} from "../lib/printers";

export function OverviewPage({ s }: { s: DesktopState }) {
  // The normal printer list is physical-only; virtual/redirected queues are
  // filtered out in the agent and again here as a safety net.
  const shownPrinters = s.printers.filter(isProductionPrinter);
  const online = shownPrinters.filter((p) => p.status === "online").length;
  const offline = shownPrinters.filter(
    (p) => p.status === "offline" || p.status === "error"
  ).length;
  // Unreadable state is NOT healthy: it needs attention of its own kind.
  const unknownPrinters = shownPrinters.filter((p) => p.status === "unknown").length;

  const banner = (() => {
    if (!s.gatewayUrl) {
      return (
        <StatusNotice
          tone="warn"
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title="Gateway needs configuration"
          action={
            <Button
              variant="primary"
              onClick={() => s.navigate("settings")}
              icon={<Settings className="h-4 w-4" />}
            >
              Configure Gateway
            </Button>
          }
        >
          Gateway URL has not been configured yet.
        </StatusNotice>
      );
    }
    if (!s.gatewayConnected) {
      return (
        <StatusNotice
          tone="warn"
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title="Gateway is unreachable"
          action={
            <Button variant="primary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>
              Retry check
            </Button>
          }
        >
          {s.healthError
            ? `The gateway did not answer the last health check — ${s.healthError}`
            : "The gateway did not answer the last health check."}
        </StatusNotice>
      );
    }
    if (!s.isOnline) {
      return (
        <StatusNotice
          tone="warn"
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title="Local agent is offline"
          action={
            <Button variant="primary" onClick={s.startAgent} icon={<Play className="h-4 w-4" />}>
              Start agent
            </Button>
          }
        >
          OdooPrintAgent.exe is not running.
        </StatusNotice>
      );
    }
    if (offline > 0 || unknownPrinters > 0 || s.failedJobs > 0) {
      const parts: string[] = [];
      if (offline > 0) parts.push(`${offline} printer${offline > 1 ? "s" : ""} need attention`);
      if (unknownPrinters > 0) parts.push(`${unknownPrinters} printer${unknownPrinters > 1 ? "s" : ""} status unreadable`);
      if (s.failedJobs > 0) parts.push(`${s.failedJobs} job${s.failedJobs > 1 ? "s" : ""} failed`);
      return (
        <StatusNotice
          tone="warn"
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title="Needs attention"
          action={
            <Button
              variant="secondary"
              onClick={() => s.navigate(offline > 0 ? "printers" : "jobs")}
            >
              {offline > 0 ? "Review printers" : "Review jobs"}
            </Button>
          }
        >
          {parts.join(" · ")}
        </StatusNotice>
      );
    }
    if (unknownPrinters > 0) {
      return (
        <StatusNotice
          tone="warn"
          icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title={`${unknownPrinters} printer${unknownPrinters === 1 ? "" : "s"} could not be checked`}
          action={
            <Button variant="secondary" onClick={() => s.navigate("printers")}>
              Review printers
            </Button>
          }
        >
          The agent could not read their status. They are not treated as healthy until a probe
          succeeds. Open the Printers page for details.
        </StatusNotice>
      );
    }
    return (
      <StatusNotice
        tone="ok"
        icon={<CheckCircle2 className="h-6 w-6" aria-hidden />}
        title="Everything is running normally"
      >
        The local agent is online, the gateway is reachable and no printers or jobs need
        attention.
      </StatusNotice>
    );
  })();

  return (
    <div className="space-y-7">
      {banner}

      {/* ---------- Status grid ---------- */}
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Agent"
          value={s.isOnline ? "Online" : "Offline"}
          sub={(s.agentStatus as Record<string, unknown> | null)?.note
            ? String((s.agentStatus as Record<string, unknown>).note)
            : s.isOnline
            ? "OdooPrintAgent.exe is running"
            : "OdooPrintAgent.exe is not running"}
          tone={s.isOnline ? "ok" : "bad"}
          icon={<Activity className="h-[22px] w-[22px]" aria-hidden />}
        />
        <StatCard
          label="Gateway"
          value={
            s.gatewayUrl ? (s.gatewayConnected ? "Connected" : "Unreachable") : "Not configured"
          }
          sub={
            !s.gatewayUrl
              ? "Set Gateway URL in Settings"
              : s.gatewayConnected
                ? "Reachable"
                : "Failed last check — verify the URL and network"
          }
          tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"}
          icon={<Server className="h-[22px] w-[22px]" aria-hidden />}
        />
        <StatCard
          label="Printers"
          value={`${online} / ${shownPrinters.length}`}
          sub={offline > 0 ? `${offline} need attention` : "Online"}
          tone={
            shownPrinters.length > 0 && offline === 0
              ? "ok"
              : shownPrinters.length === 0
              ? "neutral"
              : "warn"
          }
          icon={<PrinterIcon className="h-[22px] w-[22px]" aria-hidden />}
        />
        <StatCard
          label="Print jobs"
          value={String(s.pendingJobs)}
          sub={s.failedJobs > 0 ? `${s.failedJobs} failed` : "Pending"}
          tone={
            s.failedJobs > 0 ? "bad" : s.pendingJobs > 0 ? "info" : "neutral"
          }
          icon={<ClipboardList className="h-[22px] w-[22px]" aria-hidden />}
        />
      </div>

      {/* ---------- Printers + Activity ---------- */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader
            title="Printers"
            subtitle={`${online} of ${shownPrinters.length} online`}
            icon={<PrinterIcon className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={s.refreshPrinters}
                icon={<RefreshCw className="h-4 w-4" />}
              >
                Refresh
              </Button>
            }
          />
          <div className="px-6 pb-6">
            {s.printersLoading ? (
              <LoadingState rows={3} />
            ) : s.printersError ? (
              <ErrorState
                title="Unable to load printers"
                message={s.printersError}
                retry={s.refreshPrinters}
              />
            ) : shownPrinters.length === 0 ? (
              <EmptyState
                icon={<PrinterIcon className="h-10 w-10" />}
                title="No physical printers found"
                description="Connect a printer to this PC, then run Discovery or add it manually. Virtual and redirected printers are not shown."
                action={
                  <>
                    <Button
                      variant="primary"
                      onClick={s.handleDiscover}
                      icon={<RefreshCw className="h-4 w-4" />}
                    >
                      Discover printers
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => s.setShowAdd(true)}
                      icon={<PrinterIcon className="h-4 w-4" />}
                    >
                      Add printer
                    </Button>
                  </>
                }
              />
            ) : (
              <div className="space-y-2.5">
                {shownPrinters.slice(0, 5).map((p) => {
                  const pType = (p.printer_type || "").toLowerCase();
                  const pClass = (p.device_class || "").toLowerCase();
                  const isThermal = pType === "thermal" || pClass === "thermal";
                  const isLabel = pType === "label" || pClass === "label";
                  const isSpooler = p.connection_type === "spooler" || pClass === "laser";
                  const badgeLabel = isLabel ? "ZPL / TSPL" : isThermal ? "ESC/POS" : isSpooler ? "Spooler" : "Raw";

                  return (
                    <div
                      key={p.id}
                      className="flex w-full items-center justify-between gap-4 rounded-xl border border-edge bg-surface px-4 py-3.5 transition-colors duration-150 hover:border-edge-accent focus-within:border-edge-accent"
                    >
                      <button
                        type="button"
                        onClick={() => s.setSelectedPrinter(p)}
                        className="flex min-w-0 flex-1 items-center gap-3.5 text-left focus:outline-none"
                      >
                        <PrinterAvatar
                          name={p.name}
                          size="lg"
                          tone={printerTone(p.status) === "neutral" ? "brand" : printerTone(p.status)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold text-ink">
                            {p.name}
                          </span>
                          <span className="block truncate text-[13px] text-ink-3">
                            {humanType(p)} · {humanConnection(p)} · {printerEndpoint(p)}
                          </span>
                        </span>
                      </button>

                      <div className="flex items-center gap-2.5 shrink-0">
                        <span className="hidden sm:inline-flex rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-2">
                          {badgeLabel}
                        </span>
                        <StatusBadge
                          tone={printerTone(p.status)}
                          label={labelPrinter(p.status)}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => s.handleTest(p.id)}
                          disabled={s.busy}
                          icon={<Zap className="h-3.5 w-3.5 text-brand" />}
                          title={`Send test print to ${p.name}`}
                        >
                          Test
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <ViewAllButton
                  label="View all printers"
                  onClick={() => s.navigate("printers")}
                />
              </div>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Activity"
            subtitle="Local agent & gateway health"
            icon={<Clock className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
          />
          <div className="px-6 pb-6">
            <DetailList
              rows={[
                {
                  label: "Last status check",
                  value: (
                    <Mono>
                      {s.lastHeartbeat
                        ? new Date(s.lastHeartbeat).toLocaleTimeString()
                        : "—"}
                    </Mono>
                  ),
                },
                {
                  label: "Gateway",
                  value: (
                    <span className="block truncate">{s.gatewayUrl || "—"}</span>
                  ),
                },
                {
                  label: "Agent",
                  value: s.isOnline ? "Running" : "Stopped",
                },
              ]}
            />
            {/* Gateway queue depth (from /api/jobs, most recent 50) */}
            <div className="section-rule mt-5 pt-5 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold uppercase tracking-wider text-ink-3">
                  Gateway Queue
                </span>
                <span className={`font-semibold ${s.jobsError || s.jobsLoading ? "text-ink-3" : s.pendingJobs > 20 ? "text-warn" : s.pendingJobs > 0 ? "text-brand" : "text-ok"}`}>
                  {s.jobsLoading ? "Checking…" : s.jobsError ? "Unavailable" : s.pendingJobs > 20 ? "Backlogged" : s.pendingJobs > 0 ? "In Flight" : "Clear"}
                </span>
              </div>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink font-bold text-sm">
                  {s.jobsLoading || s.jobsError ? "—" : s.pendingJobs}
                  <span className="text-ink-3 font-normal"> waiting at the Gateway</span>
                </span>
                <span className="text-ink-3">last 50 jobs shown</span>
              </div>
              <p className="text-[11px] text-ink-3">
                Counts jobs queued, claimed or printing at the Gateway. The agent accepts up to
                64 in-flight jobs per printer batch.
              </p>
            </div>
            <div className="section-rule mt-5 pt-5">
              <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Quick actions
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="primary"
                  onClick={s.refreshStatus}
                  icon={<RefreshCw className="h-4 w-4" />}
                >
                  Refresh
                </Button>
                <Button
                  variant="secondary"
                  onClick={s.checkHealth}
                  icon={<Activity className="h-4 w-4" />}
                >
                  Check gateway
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* ---------- Recent jobs ---------- */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Recent jobs"
          subtitle={`${s.pendingJobs} pending · ${s.failedJobs} failed`}
          icon={<ClipboardList className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
          actions={
            <Button size="sm" variant="ghost" onClick={() => s.navigate("jobs")}>
              View all
            </Button>
          }
        />
        {s.jobsLoading ? (
          <div className="px-6 pb-6">
            <LoadingState rows={3} />
          </div>
        ) : s.jobsError ? (
          <div className="px-6 pb-6">
            <ErrorState
              title="Jobs unavailable"
              message={s.jobsError}
              retry={() => { void s.refreshJobs(); }}
            />
          </div>
        ) : s.jobs.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-10 w-10" />}
            title="No print jobs yet"
            description="Print jobs will appear here as soon as the agent starts printing."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-edge table-head text-left">
                  <th className="px-6 py-3">Document</th>
                  <th className="px-4 py-3">Printer</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {s.jobs.slice(0, 5).map((j) => (
                  <tr
                    key={jobId(j)}
                    className="border-b border-edge last:border-0 row-hover"
                  >
                    <td className="px-6 py-4">
                      <div className="text-[14px] font-semibold text-ink">
                        {jobDocType(j)}
                      </div>
                      <div className="font-mono text-[12px] text-ink-3">{jobId(j)}</div>
                    </td>
                    <td className="px-4 py-4 text-[14px] text-ink-2">
                      {String(
                        s.printers.find((p) => p.id === jobPrinterId(j))?.name ||
                          jobPrinterId(j) ||
                          "—"
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge
                        tone={toneJob(jobStatus(j), j.error)}
                        label={labelJob(jobStatus(j), j.error)}
                      />
                    </td>
                    <td className="px-6 py-4 text-right text-[13px] text-ink-3">
                      {j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Hardware Profile Validation */}
      {shownPrinters.length > 0 && (() => {
        const thermal = shownPrinters.find((p) => {
          const t = (p.printer_type || "").toLowerCase();
          const d = (p.device_class || "").toLowerCase();
          return t === "thermal" || d === "thermal";
        });
        const label = shownPrinters.find((p) => {
          const t = (p.printer_type || "").toLowerCase();
          const d = (p.device_class || "").toLowerCase();
          return t === "label" || d === "label";
        });
        const spooler = shownPrinters.find(
          (p) => p.connection_type === "spooler" || (p.device_class || "").toLowerCase() === "laser"
        );

        return (
          <Card className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3.5">
                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
                  <Zap className="h-[22px] w-[22px]" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="text-[16px] font-semibold text-ink">
                    Hardware Profile Testing
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
                    Verify physical rendering across supported hardware profiles: ESC/POS (receipts),
                    ZPL/TSPL (labels), or Windows Spooler documents.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {thermal && (
                  <Button
                    variant="secondary"
                    onClick={() => s.handleTest(thermal.id)}
                    icon={<Zap className="h-4 w-4 text-brand" />}
                  >
                    Test ESC/POS
                  </Button>
                )}
                {label && (
                  <Button
                    variant="secondary"
                    onClick={() => s.handleTest(label.id)}
                    icon={<Zap className="h-4 w-4 text-brand" />}
                  >
                    Test ZPL Label
                  </Button>
                )}
                {spooler && (
                  <Button
                    variant="secondary"
                    onClick={() => s.handleTest(spooler.id)}
                    icon={<Zap className="h-4 w-4 text-brand" />}
                  >
                    Test Spooler
                  </Button>
                )}
                {!thermal && !label && !spooler && (
                  <Button
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => s.handleTest(shownPrinters[0].id)}
                    icon={<Zap className="h-4 w-4" />}
                  >
                    Test {shownPrinters[0].name.length > 18
                      ? `${shownPrinters[0].name.slice(0, 18)}…`
                      : shownPrinters[0].name}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        );
      })()}
    </div>
  );
}
