"use client";

import React, { useState, useMemo, useEffect } from "react";
import {
  createAgent,
  createTestPrintJob,
  deleteAgent,
  getDashboardJobs,
  getDashboardState,
  reprintJob,
  setAgentLifecycle,
  setPrinterLifecycle,
} from "../actions";
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  PauseCircle,
  PlayCircle,
  Printer as PrinterIcon,
  Plus,
  RefreshCw,
  Server,
  Search,
  LayoutGrid,
  List,
  Wifi,
  Usb,
  Layers,
  Clock,
  AlertTriangle,
  Key,
  RotateCcw,
  Eye,
  Trash2,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  StatCard,
  Input,
  Select,
  StatusBadge,
  Mono,
  Drawer,
  Modal,
  CopyButton,
  agentTone,
} from "../../components/ui";
import {
  agentLiveView,
  deriveOutcome,
  jobGuidance,
  jobLabel,
  jobTone as sharedJobTone,
  printerLabel,
  printerTone as sharedPrinterTone,
  effectivePrinterStatus,
} from "../../shared/job-vocabulary";
import { copyTextToClipboard } from "../../lib/clipboard";

export type Agent = {
  id: string;
  name: string;
  pairingCode: string | null;
  pairingCodeExpiresAt?: Date | null;
  status: string;
  lifecycle: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  printerCount: number;
  metadata?: unknown;
};

export type Printer = {
  id: string;
  agentId: string;
  name: string;
  printerType: string;
  deviceClass?: string | null;
  connectionType: string;
  protocol?: string | null;
  lifecycle: string;
  status: string;
  config?: unknown;
  capabilities?: unknown;
  lastSeenAt?: Date | null;
};

export type Job = {
  id: string;
  agentId: string;
  printerId: string;
  status: string;
  destination?: string | null;
  documentType?: string | null;
  error?: string | null;
  payload?: unknown;
  retries?: number;
  deliveryAttempts?: number;
  claimedAt?: Date | null;
  deliveredAt?: Date | null;
  ackedAt?: Date | null;
  createdAt: Date;
  updatedAt?: Date | null;
};

function formatRelativeTime(dateInput: Date | string | null | undefined): string {
  if (!dateInput) return "Never";
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return "Unknown";
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 10) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatCountdown(expiresAt: Date | string | null | undefined): { text: string; expired: boolean } {
  if (!expiresAt) return { text: "10:00", expired: false };
  const exp = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const now = new Date();
  const diffMs = exp.getTime() - now.getTime();
  if (diffMs <= 0) return { text: "Expired", expired: true };
  const min = Math.floor(diffMs / 60000);
  const sec = Math.floor((diffMs % 60000) / 1000);
  return {
    text: `${min}:${sec.toString().padStart(2, "0")}`,
    expired: false,
  };
}

export default function DashboardClient({
  initialAgents,
  initialPrinters,
  initialJobs,
  databaseError,
}: {
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
  databaseError: string | null;
}) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents);
  const [printers, setPrinters] = useState<Printer[]>(initialPrinters);
  const [kpiJobs, setKpiJobs] = useState<Job[]>(initialJobs);
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [jobsLoading, setJobsLoading] = useState(false);

  const [prevAgents, setPrevAgents] = useState(initialAgents);
  if (prevAgents !== initialAgents) {
    setPrevAgents(initialAgents);
    setAgents(initialAgents);
  }

  const [prevPrinters, setPrevPrinters] = useState(initialPrinters);
  if (prevPrinters !== initialPrinters) {
    setPrevPrinters(initialPrinters);
    setPrinters(initialPrinters);
  }

  const [prevJobs, setPrevJobs] = useState(initialJobs);
  if (prevJobs !== initialJobs) {
    setPrevJobs(initialJobs);
    setKpiJobs(initialJobs);
    setJobs(initialJobs);
  }

  const [agentName, setAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [activePairing, setActivePairing] = useState<{ id?: string; code: string; expiresAt: Date } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [countdownText, setCountdownText] = useState("10:00");
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const [pendingAgentAction, setPendingAgentAction] = useState<{ agent: Agent; next: "disabled" | "retired" } | null>(null);
  const [reprintCandidate, setReprintCandidate] = useState<Job | null>(null);

  // Filter & view states
  const [printerViewMode, setPrinterViewMode] = useState<"grid" | "table">("grid");
  const [printerSearch, setPrinterSearch] = useState("");
  const [printerStatusFilter, setPrinterStatusFilter] = useState<string>("all");

  const [jobSearch, setJobSearch] = useState("");
  const [debouncedJobSearch, setDebouncedJobSearch] = useState("");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("all");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  // The job list is metadata-only (payload bytes can be multi-MB per job).
  // The inspector loads the full payload lazily, per selected job, and never
  // keeps it in the polling snapshots.
  const [selectedJobPayload, setSelectedJobPayload] = useState<unknown>(undefined);
  const [selectedJobPayloadLoading, setSelectedJobPayloadLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!selectedJob) {
      setSelectedJobPayload(undefined);
      return;
    }
    if (selectedJob.payload !== undefined) {
      setSelectedJobPayload(selectedJob.payload);
      return;
    }
    setSelectedJobPayload(undefined);
    setSelectedJobPayloadLoading(true);
    void fetch(`/api/jobs/${encodeURIComponent(selectedJob.id)}`, { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setSelectedJobPayload(null);
          return;
        }
        const row = (await res.json()) as { payload?: unknown };
        setSelectedJobPayload(row?.payload ?? null);
      })
      .catch(() => {
        if (!cancelled) setSelectedJobPayload(null);
      })
      .finally(() => {
        if (!cancelled) setSelectedJobPayloadLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob?.id]);

  const filterRef = React.useRef({ status: "all", search: "" });
  useEffect(() => {
    filterRef.current = { status: jobStatusFilter, search: debouncedJobSearch };
  }, [jobStatusFilter, debouncedJobSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedJobSearch(jobSearch), 250);
    return () => clearTimeout(timer);
  }, [jobSearch]);

  useEffect(() => {
    let cancelled = false;
    async function loadFilteredJobs() {
      setJobsLoading(true);
      try {
        const res = await getDashboardJobs({
          status: jobStatusFilter,
          search: debouncedJobSearch,
          limit: 100,
        });
        if (!cancelled) {
          setJobs(res as unknown as Job[]);
        }
      } catch (err) {
        console.error("Dashboard jobs query failed:", err);
      } finally {
        if (!cancelled) {
          setJobsLoading(false);
        }
      }
    }
    void loadFilteredJobs();
    return () => {
      cancelled = true;
    };
  }, [jobStatusFilter, debouncedJobSearch]);

  // Wall-clock used for heartbeat freshness (stale agents are not shown as online).
  // Ticked every 5s so heartbeat lapses (90s stale rule) update presence immediately without page reload.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const refreshData = React.useCallback(async () => {
    try {
      const data = await getDashboardState();
      if (data) {
        setAgents(data.agents as Agent[]);
        setPrinters(data.printers as Printer[]);
        setKpiJobs(data.jobs as Job[]);

        const current = filterRef.current;
        if (current.status === "all" && !current.search) {
          setJobs(data.jobs as Job[]);
        } else {
          void getDashboardJobs({
            status: current.status,
            search: current.search,
            limit: 100,
          }).then((res) => {
            setJobs(res as unknown as Job[]);
          });
        }

        setActivePairing((currentPairing) => {
          if (!currentPairing) return null;
          const target = data.agents.find(
            (a) =>
              (currentPairing.id && a.id === currentPairing.id) ||
              a.pairingCode === currentPairing.code
          );
          if (
            target &&
            (target.status === "online" ||
              target.lastSeenAt !== null ||
              target.pairingCodeExpiresAt === null)
          ) {
            setMessage({
              text: `Agent ${target.name} paired successfully and is now online.`,
              type: "ok",
            });
            return null;
          }
          return currentPairing;
        });
      }
    } catch {
      // background polling error ignored
    }
  }, []);

  // Periodic background state reconciliation: 3s during active pairing, 6s otherwise when tab is visible
  useEffect(() => {
    const intervalMs = activePairing ? 3000 : 6000;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refreshData();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [activePairing, refreshData]);

  // Active pairing countdown tick
  useEffect(() => {
    if (!activePairing) return;
    const interval = setInterval(() => {
      const { text, expired } = formatCountdown(activePairing.expiresAt);
      setCountdownText(text);
      if (expired) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activePairing]);

  // KPI calculations
  const kpis = useMemo(() => {
    const totalAgents = agents.length;
    // A stale heartbeat is NOT an online agent: availability follows the
    // same 90s rule the gateway itself enforces.
    const onlineAgents = agents.filter((a) => agentLiveView(a, nowMs).tone === "ok").length;

    const totalPrinters = printers.length;
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const onlinePrinters = printers.filter((p) => {
      const parentAgent = agentMap.get(p.agentId);
      return effectivePrinterStatus(p, parentAgent, nowMs) === "online";
    }).length;

    const inFlightJobs = kpiJobs.filter((j) => {
      const s = j.status.toLowerCase();
      return s === "queued" || s === "printing" || s === "claimed";
    }).length;

    const completedJobs = kpiJobs.filter((j) => j.status.toLowerCase() === "success").length;

    // "Needs attention" = the physical outcome is UNKNOWN (paper may exist),
    // regardless of whether the row says failed or expired.
    const attentionJobs = kpiJobs.filter(
      (j) => deriveOutcome(j.status, j.error) === "unknown"
    ).length;

    const failedJobs = kpiJobs.filter((j) => j.status.toLowerCase() === "failed" && deriveOutcome(j.status, j.error) === "not_printed").length;
    const expiredJobs = kpiJobs.filter((j) => j.status.toLowerCase() === "expired").length;

    const successRate =
      kpiJobs.length > 0 ? Math.round((completedJobs / kpiJobs.length) * 100) : null;

    return {
      totalAgents,
      onlineAgents,
      totalPrinters,
      onlinePrinters,
      inFlightJobs,
      completedJobs,
      attentionJobs,
      failedJobs,
      expiredJobs,
      successRate,
    };
  }, [agents, printers, kpiJobs, nowMs]);

  const runAction = async (operation: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await operation();
      if (successMsg) setMessage({ text: successMsg, type: "ok" });
      void refreshData();
      return result;
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Operation failed. Try again, and check the Gateway logs if it persists.",
        type: "err",
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const confirmAgentAction = async () => {
    if (!pendingAgentAction) return;
    const { agent, next } = pendingAgentAction;
    setPendingAgentAction(null);
    const result = await runAction(() => setAgentLifecycle(agent.id, next));
    if (result && next === "disabled") {
      setMessage({
        text: `Agent ${agent.name} disabled: its credentials were revoked and its ${agent.printerCount} printer(s) no longer receive jobs. Re-enabling requires pairing it again with a new code.`,
        type: "ok",
      });
    }
    if (result && next === "retired") {
      setMessage({ text: `Agent ${agent.name} retired. It is kept for audit history and cannot receive jobs.`, type: "ok" });
    }
  };

  const handleCreateAgent = async (name: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await createAgent(name);
      const expiresAt = result.expiresAt ? new Date(result.expiresAt) : (result.expires_at ? new Date(result.expires_at) : new Date(Date.now() + 1000 * 60 * 10));
      setActivePairing({ id: result.id, code: result.pairingCode, expiresAt });
      setAgentName("");
      setMessage({
        text: `Agent registered! Use pairing code ${result.pairingCode} before expiration.`,
        type: "ok",
      });
      void refreshData();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Agent registration failed",
        type: "err",
      });
    } finally {
      setBusy(false);
    }
  };

  const copyPairingCode = async (code: string) => {
    if (await copyTextToClipboard(code)) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } else {
      setMessage({ text: "Please copy the code manually.", type: "err" });
    }
  };

  // Filtered printers
  const filteredPrinters = useMemo(() => {
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    return printers.filter((p) => {
      const parentAgent = agentMap.get(p.agentId);
      const effStatus = effectivePrinterStatus(p, parentAgent, nowMs).toLowerCase();
      if (printerStatusFilter !== "all" && effStatus !== printerStatusFilter) {
        return false;
      }
      if (printerSearch.trim()) {
        const q = printerSearch.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.connectionType.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [printers, agents, nowMs, printerStatusFilter, printerSearch]);

  // Filtered jobs (database-queried via getDashboardJobs with immediate typing refinement)
  const filteredJobs = useMemo(() => {
    if (!jobSearch.trim()) return jobs;
    const q = jobSearch.toLowerCase();
    return jobs.filter((j) => {
      return (
        j.id.toLowerCase().includes(q) ||
        j.printerId.toLowerCase().includes(q) ||
        (j.destination && j.destination.toLowerCase().includes(q)) ||
        (j.documentType && j.documentType.toLowerCase().includes(q))
      );
    });
  }, [jobs, jobSearch]);

  // Helper for printer capability chips
  const getPrinterBadges = (printer: Printer) => {
    const badges: Array<{ label: string }> = [];
    const cls = (printer.deviceClass || "").toLowerCase();
    const conn = (printer.connectionType || "").toLowerCase();
    const proto = (printer.protocol || "").toLowerCase();

    if (cls === "thermal" || proto === "escpos") {
      badges.push({ label: "ESC/POS" });
    }
    if (cls === "label") {
      badges.push({ label: "ZPL / TSPL" });
    }
    if (conn === "spooler" || cls === "laser" || proto === "ipp") {
      badges.push({ label: "PDF / Spooler" });
    }
    return badges;
  };

  // Helper for printer connection icon
  const getConnectionIcon = (connectionType: string) => {
    const c = connectionType.toLowerCase();
    if (c === "usb") return <span role="img" aria-label="USB Connection"><Usb className="h-4 w-4 text-ink-3" aria-hidden="true" /></span>;
    if (c === "network" || c === "tcp")
      return <span role="img" aria-label="Network Connection"><Wifi className="h-4 w-4 text-ink-3" aria-hidden="true" /></span>;
    return <span role="img" aria-label="Spooler or system connection"><Layers className="h-4 w-4 text-ink-3" aria-hidden="true" /></span>;
  };

  return (
    <div className="space-y-8">
      {/* 1. KPI Summary Cards */}
      <section aria-label="Operational Metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Active Agents"
          value={`${kpis.onlineAgents} / ${kpis.totalAgents}`}
          subtitle={`${kpis.onlineAgents} edge agent${kpis.onlineAgents === 1 ? "" : "s"} online`}
          icon={<Activity className="h-5 w-5 text-brand" />}
          tone={kpis.onlineAgents > 0 ? "ok" : "warn"}
        />
        <StatCard
          title="Discovered Printers"
          value={kpis.totalPrinters}
          subtitle={`${kpis.onlinePrinters} ready for jobs`}
          icon={<PrinterIcon className="h-5 w-5 text-brand" />}
          tone={kpis.onlinePrinters > 0 ? "ok" : "neutral"}
        />
        <StatCard
          title="Active Jobs"
          value={kpis.inFlightJobs}
          subtitle={`${kpis.inFlightJobs} queued, claimed, or printing right now`}
          icon={<Server className="h-5 w-5 text-info" />}
          tone="info"
        />
        <StatCard
          title="Success Rate"
          value={kpis.successRate === null ? "—" : `${kpis.successRate}%`}
          subtitle={
            jobs.length === 0
              ? "No jobs in the recent list yet"
              : kpis.attentionJobs > 0
                ? `${kpis.attentionJobs} with unknown outcome - verify the printer`
                : kpis.failedJobs > 0
                  ? `${kpis.failedJobs} failed before printing`
                  : kpis.expiredJobs > 0
                    ? `${kpis.expiredJobs} expired unclaimed`
                    : "All recent jobs accounted for"
          }
          icon={<CheckCircle2 className="h-5 w-5 text-ok" />}
          tone={kpis.successRate === null || kpis.attentionJobs > 0 ? (kpis.successRate === null ? "neutral" : "warn") : kpis.successRate >= 90 ? "ok" : "warn"}
        />
      </section>

      {/* Global alert / message banner */}
      {message && (
        <div
          role={message.type === "ok" ? "status" : "alert"}
          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-xs ${
            message.type === "ok"
              ? "border-ok-edge bg-ok-bg text-ok"
              : "border-bad-edge bg-bad-bg text-bad"
          }`}
        >
          <div className="flex items-center gap-2">
            {message.type === "ok" ? (
              <Check className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
          <button
            onClick={() => setMessage(null)}
            className="text-xs font-semibold underline opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2. Pairing Hero Card (when active code present) */}
      {activePairing && (
        <div className="rounded-2xl border border-edge bg-surface p-6 shadow-xs">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-brand" aria-hidden="true" />
                <span className="text-xs font-bold uppercase tracking-wider text-brand">
                  Active Pairing Session
                </span>
              </div>
              <h3 className="text-lg font-bold text-ink">Ready to Pair Edge Agent</h3>
              <p className="text-sm text-ink-3 max-w-xl">
                Enter this 6-character code into the Windows Print Agent application or the Odoo
                Gateway Pairing Wizard to bind your local printer queue.
              </p>
            </div>

            <div className="flex flex-col sm:items-end gap-2">
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-edge-accent bg-surface px-5 py-3 shadow-inner">
                  <span className="font-mono text-3xl font-extrabold tracking-[0.35em] text-brand">
                    {activePairing.code}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => copyPairingCode(activePairing.code)}
                  icon={copiedCode ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                >
                  {copiedCode ? "Copied" : "Copy Code"}
                </Button>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-ink-3">
                <Clock className="h-3.5 w-3.5 text-warn" />
                <span>
                  Expires in <strong className="font-semibold text-ink">{countdownText}</strong>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. Main Dashboard Workspace (Agents & Printers) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column: Runtime Agents & Registration */}
        <Card className="lg:col-span-1 flex flex-col h-full">
          <CardHeader
            title="Runtime Agents"
            subtitle="Edge machines hosting local print drivers"
            icon={<Activity className="h-5 w-5 text-brand" />}
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refreshData()}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
              >
                Refresh
              </Button>
            }
          />
          <div className="flex-1 space-y-4 px-6 pb-6">
            {/* Registration Form */}
            <form
              className="rounded-xl border border-edge bg-surface-2/50 p-3.5 space-y-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!agentName.trim()) return;
                void handleCreateAgent(agentName.trim());
              }}
            >
              <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">
                Register New Agent
              </span>
              <div className="flex gap-2">
                <Input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="e.g. Warehouse-Windows-PC"
                  disabled={busy || databaseError !== null}
                />
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !agentName.trim() || databaseError !== null}
                  icon={<Plus className="h-4 w-4" />}
                >
                  Pair
                </Button>
              </div>
            </form>

            {/* Agent List */}
            <div className="space-y-3">
              {agents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-edge p-6 text-center text-sm text-ink-3">
                  No runtime agents registered yet.
                </div>
              ) : (
                agents.map((agent) => {
                  const meta = agent.metadata as { hostname?: string; os?: string } | undefined;
                  return (
                    <div
                      key={agent.id}
                      className="group relative rounded-xl border border-edge bg-surface p-4 transition-all hover:border-edge-strong hover:shadow-xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-ink">{agent.name}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
                            <Mono>{agent.id}</Mono>
                            {meta?.os && <span>· {meta.os}</span>}
                          </div>
                        </div>
                        {(() => {
                          const view = agentLiveView(agent);
                          return (
                            <StatusBadge
                              label={view.label}
                              tone={view.tone}
                              pulse={view.tone === "ok"}
                            />
                          );
                        })()}
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-edge/60 pt-3 text-xs text-ink-3">
                        <span>
                          {agent.printerCount} printer{agent.printerCount === 1 ? "" : "s"}
                        </span>
                        <span>Seen {formatRelativeTime(agent.lastSeenAt)}</span>
                      </div>

                      <div className="mt-3 flex items-center gap-2">
                        {agent.lifecycle === "active" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setPendingAgentAction({ agent, next: "disabled" })}
                            disabled={busy}
                            icon={<PauseCircle className="h-3.5 w-3.5" />}
                          >
                            Disable
                          </Button>
                        ) : agent.lifecycle === "disabled" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={async () => {
                              const result = (await runAction(() => setAgentLifecycle(agent.id, "active"))) as
                                | { pairingCode?: string | null }
                                | undefined;
                              if (result?.pairingCode) {
                                setActivePairing({ code: result.pairingCode, expiresAt: new Date(Date.now() + 1000 * 60 * 10) });
                                setMessage({
                                  text: `Agent ${agent.name} re-enabled. Pair it within 10 minutes using the code below - the old credentials no longer work.`,
                                  type: "ok",
                                });
                              }
                            }}
                            disabled={busy}
                            icon={<PlayCircle className="h-3.5 w-3.5" />}
                          >
                            Re-enable
                          </Button>
                        ) : null}

                        {agent.lifecycle !== "retired" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPendingAgentAction({ agent, next: "retired" })}
                            disabled={busy}
                            title="Retire keeps the agent and its print history for auditing; it can no longer receive jobs."
                          >
                            Retire
                          </Button>
                        )}

                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-bad hover:bg-bad-bg/60 hover:text-bad"
                          onClick={() => setAgentToDelete(agent)}
                          disabled={busy}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          title="Permanently delete agent"
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Card>

        {/* Right column: Discovered Runtime Printers with View Toggle */}
        <Card className="lg:col-span-2 flex flex-col h-full">
          <CardHeader
            title="Discovered Runtime Printers"
            subtitle="Hardware devices auto-detected and reported by agents"
            icon={<PrinterIcon className="h-5 w-5 text-brand" />}
            actions={
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-edge bg-surface-2 p-0.5" role="group" aria-label="Printer list layout">
                  <button
                    type="button"
                    title="Grid view"
                    aria-label="Grid view"
                    aria-pressed={printerViewMode === "grid"}
                    onClick={() => setPrinterViewMode("grid")}
                    className={`rounded-md p-1.5 transition-colors ${
                      printerViewMode === "grid"
                        ? "bg-surface text-brand shadow-xs"
                        : "text-ink-3 hover:text-ink"
                    }`}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Table view"
                    aria-label="Table view"
                    aria-pressed={printerViewMode === "table"}
                    onClick={() => setPrinterViewMode("table")}
                    className={`rounded-md p-1.5 transition-colors ${
                      printerViewMode === "table"
                        ? "bg-surface text-brand shadow-xs"
                        : "text-ink-3 hover:text-ink"
                    }`}
                  >
                    <List className="h-4 w-4" />
                  </button>
                </div>
              </div>
            }
          />

          <div className="flex-1 space-y-4 px-6 pb-6">
            {/* Filter & Search Bar */}
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <div className="relative w-full flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3" aria-hidden="true" />
                <Input
                  className="pl-9"
                  placeholder="Search printers by name, ID, or connection..."
                  aria-label="Search printers by name, ID, or connection"
                  value={printerSearch}
                  onChange={(e) => setPrinterSearch(e.target.value)}
                />
              </div>
              <div className="flex w-full sm:w-auto items-center gap-2">
                <Select
                  value={printerStatusFilter}
                  onChange={(e) => setPrinterStatusFilter(e.target.value)}
                  className="w-full sm:w-36"
                  aria-label="Filter printers by status"
                >
                  <option value="all">All Status</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                  <option value="busy">Busy</option>
                </Select>
              </div>
            </div>

            {/* Printers Content */}
            {filteredPrinters.length === 0 ? (
              <div className="rounded-xl border border-dashed border-edge p-12 text-center text-sm text-ink-3">
                No matching printers found. Ensure an Edge Agent is online and reporting hardware.
              </div>
            ) : printerViewMode === "grid" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {filteredPrinters.map((printer) => {
                  const caps = getPrinterBadges(printer);
                  const parentAgent = agents.find((a) => a.id === printer.agentId);
                  const effStatus = effectivePrinterStatus(printer, parentAgent, nowMs);
                  return (
                    <div
                      key={printer.id}
                      className="rounded-xl border border-edge bg-surface p-4 flex flex-col justify-between transition-all hover:border-edge-strong hover:shadow-xs"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-semibold text-ink text-[15px]">
                              {printer.name}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                              {getConnectionIcon(printer.connectionType)}
                              <span className="capitalize">{printer.connectionType}</span>
                              <span>·</span>
                              <Mono className="text-[11px]">{printer.id}</Mono>
                            </div>
                          </div>
                          <StatusBadge
                            label={printerLabel(effStatus)}
                            tone={sharedPrinterTone(effStatus)}
                          />
                        </div>

                        {/* Capabilities Chips */}
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {caps.map((c, i) => (
                            <span
                              key={i}
                              className="rounded-md border border-edge-accent bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-2"
                            >
                              {c.label}
                            </span>
                          ))}
                          {printer.deviceClass && (
                            <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3 capitalize">
                              {printer.deviceClass}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-edge flex items-center justify-between gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void runAction(
                              () => createTestPrintJob(printer.id),
                              `Test page queued for ${printer.name} - watch it in the job list.`
                            )
                          }
                          disabled={busy || printer.lifecycle !== "active"}
                          icon={<CheckCircle2 className="h-3.5 w-3.5 text-ok" />}
                        >
                          Send Test Page
                        </Button>
                        {printer.lifecycle === "active" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void runAction(
                                () => setPrinterLifecycle(printer.id, "disabled"),
                                "Printer disabled."
                              )
                            }
                            disabled={busy}
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void runAction(
                                () => setPrinterLifecycle(printer.id, "active"),
                                "Printer re-enabled."
                              )
                            }
                            disabled={busy}
                          >
                            Re-enable
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-edge bg-surface-2 text-xs font-semibold text-ink-3 uppercase">
                    <tr>
                      <th className="px-4 py-3">Printer Name / ID</th>
                      <th className="px-4 py-3">Connection</th>
                      <th className="px-4 py-3">Capabilities</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {filteredPrinters.map((printer) => {
                      const caps = getPrinterBadges(printer);
                      const parentAgent = agents.find((a) => a.id === printer.agentId);
                      const effStatus = effectivePrinterStatus(printer, parentAgent, nowMs);
                      return (
                        <tr key={printer.id} className="hover:bg-surface-2/40">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-ink">{printer.name}</div>
                            <Mono className="text-[11px] text-ink-3">{printer.id}</Mono>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5 text-ink-2 capitalize">
                              {getConnectionIcon(printer.connectionType)}
                              {printer.connectionType}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {caps.map((c, i) => (
                                <span
                                  key={i}
                                  className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-ink-2"
                                >
                                  {c.label}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge
                              label={printerLabel(effStatus)}
                              tone={sharedPrinterTone(effStatus)}
                            />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                void runAction(
                                  () => createTestPrintJob(printer.id),
                                  `Test page queued for ${printer.name} - watch it in the job list.`
                                )
                              }
                              disabled={busy || printer.lifecycle !== "active"}
                            >
                              Send Test Page
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 4. Job Queue Inspector */}
      <Card>
        <CardHeader
          title="Recent Print Jobs"
          subtitle="Latest queue snapshot, execution tracking, and diagnostic payload inspector"
          icon={<Server className="h-5 w-5 text-brand" />}
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refreshData()}
              icon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              Refresh Queue
            </Button>
          }
        />

        <div className="space-y-4 px-6 pb-6">
          {/* Search and Status Filters */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3" aria-hidden="true" />
              <Input
                className="pl-9"
                placeholder="Search by job ID, destination..."
                aria-label="Search jobs by ID or destination"
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto w-full sm:w-auto" role="group" aria-label="Filter jobs by status">
              {[
                { id: "all", label: "All Jobs" },
                { id: "active", label: "In Flight" },
                { id: "queued", label: "Queued" },
                { id: "claimed", label: "Claimed" },
                { id: "printing", label: "Printing" },
                { id: "unassigned", label: "Unassigned" },
                { id: "success", label: "Printed" },
                { id: "failed", label: "Failed" },
                { id: "unknown", label: "Unknown Outcome" },
                { id: "expired", label: "Expired" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setJobStatusFilter(tab.id)}
                  aria-pressed={jobStatusFilter === tab.id}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    jobStatusFilter === tab.id
                      ? "bg-brand text-brand-contrast shadow-xs"
                      : "bg-surface-2 text-ink-3 hover:text-ink"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Job Queue Table */}
          {jobsLoading && filteredJobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-edge p-12 text-center text-sm text-ink-3">
              Loading print jobs from database...
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-edge p-12 text-center text-sm text-ink-3">
              No print jobs match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-edge bg-surface-2 text-xs font-semibold text-ink-3 uppercase">
                  <tr>
                    <th className="px-4 py-3">Job ID</th>
                    <th className="px-4 py-3">Target Printer</th>
                    <th className="px-4 py-3">Context / Doc</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3 text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {filteredJobs.map((job) => {
                    const outcome = deriveOutcome(job.status, job.error);
                    return (
                      <tr
                        key={job.id}
                        onClick={() => setSelectedJob(job)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedJob(job);
                          }
                        }}
                        tabIndex={0}
                        aria-label={`Inspect job ${job.id}`}
                        className="cursor-pointer transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-brand"
                      >
                        <td className="px-4 py-3 font-mono font-medium text-ink">
                          <Mono>{job.id}</Mono>
                        </td>
                        <td className="px-4 py-3">
                          <Mono className="text-ink-2">{job.printerId}</Mono>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-ink font-medium">
                            {job.destination || "Direct Hardware"}
                          </div>
                          {job.documentType && (
                            <div className="text-xs text-ink-3">{job.documentType}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge
                            label={jobLabel(job.status, outcome)}
                            tone={sharedJobTone(job.status, outcome)}
                            pulse={
                              job.status.toLowerCase() === "printing" ||
                              job.status.toLowerCase() === "claimed"
                            }
                          />
                        </td>
                        <td className="px-4 py-3 text-xs text-ink-3">
                          {formatRelativeTime(job.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedJob(job);
                            }}
                            icon={<Eye className="h-3.5 w-3.5" />}
                          >
                            Inspect
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* 5. Slide-Over Drawer for Selected Job Payload & Diagnostics */}
      <Drawer
        open={selectedJob !== null}
        onClose={() => setSelectedJob(null)}
        title={selectedJob ? `Job ${selectedJob.id}` : "Job Details"}
        description="Full runtime execution parameters and payload inspection"
      >
        {selectedJob && (() => {
          const outcome = deriveOutcome(selectedJob.status, selectedJob.error);
          const isTerminal = ["success", "failed", "expired"].includes(selectedJob.status.toLowerCase());
          return (
          <div className="space-y-6">
            {/* Status Callout Banner */}
            <div className="flex items-center justify-between rounded-xl border border-edge bg-surface-2 p-4">
              <div className="space-y-1">
                <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                  Current State
                </span>
                <div className="text-lg font-bold text-ink">
                  {jobLabel(selectedJob.status, outcome)}
                </div>
                {jobGuidance(selectedJob.status, outcome) && (
                  <p className="text-xs text-ink-3 max-w-md">{jobGuidance(selectedJob.status, outcome)}</p>
                )}
              </div>
              <StatusBadge
                label={jobLabel(selectedJob.status, outcome)}
                tone={sharedJobTone(selectedJob.status, outcome)}
                pulse={
                  selectedJob.status.toLowerCase() === "printing" ||
                  selectedJob.status.toLowerCase() === "claimed"
                }
              />
            </div>

            {/* Unknown outcome: physical ambiguity is a DELIBERATE action */}
            {outcome === "unknown" && isTerminal && (
              <div className="rounded-xl border border-warn-edge bg-warn-bg p-4 space-y-3">
                <div className="flex items-start gap-2.5 text-warn">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-bold text-sm">Print status is unknown</h4>
                    <p className="text-xs leading-relaxed mt-1 text-ink-2">
                      The printer may have received part or all of the job. Automatic retry is paused
                      to prevent duplicate printing. Verify the printer (paper tray, last page) before
                      reprinting. Reprinting sends the ORIGINAL document again - you may get a second
                      copy.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setReprintCandidate(selectedJob)}
                    disabled={busy}
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                  >
                    Reprint original document...
                  </Button>
                </div>
              </div>
            )}

            {/* Provable pre-dispatch failure: retry is safe and honest */}
            {selectedJob.status.toLowerCase() === "failed" && outcome === "not_printed" && (
              <div className="rounded-xl border border-edge bg-surface-2 p-4 space-y-3">
                <p className="text-xs leading-relaxed text-ink-2">
                  This job failed before the printer started, so nothing was printed. Reprinting
                  queues the original document again under a new operation key.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setReprintCandidate(selectedJob)}
                  disabled={busy}
                  icon={<RotateCcw className="h-3.5 w-3.5" />}
                >
                  Retry print...
                </Button>
              </div>
            )}

            {/* Error Banner */}
            {selectedJob.error && (
              <div className="rounded-xl border border-bad-edge bg-bad-bg p-4 text-bad space-y-1">
                <div className="flex items-center gap-2 font-bold text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  <span>Execution Error</span>
                </div>
                <p className="text-xs leading-relaxed text-ink-2 font-mono break-all">
                  {selectedJob.error}
                </p>
              </div>
            )}

            {/* Core Metadata */}
            <div className="rounded-xl border border-edge bg-surface divide-y divide-edge text-xs">
              <div className="flex justify-between p-3">
                <span className="text-ink-3">Printer Runtime ID</span>
                <Mono>{selectedJob.printerId}</Mono>
              </div>
              <div className="flex justify-between p-3">
                <span className="text-ink-3">Hosting Agent ID</span>
                <Mono>{selectedJob.agentId}</Mono>
              </div>
              <div className="flex justify-between p-3">
                <span className="text-ink-3">Document Context</span>
                <span className="font-semibold text-ink">
                  {selectedJob.destination || "Direct"} · {selectedJob.documentType || "Standard"}
                </span>
              </div>
              <div className="flex justify-between p-3">
                <span className="text-ink-3">Delivery Retries</span>
                <span className="font-semibold text-ink">{selectedJob.retries ?? 0}</span>
              </div>
              <div className="flex justify-between p-3">
                <span className="text-ink-3">Created At</span>
                <span className="text-ink">
                  {new Date(selectedJob.createdAt).toLocaleString()}
                </span>
              </div>
              {selectedJob.deliveredAt && (
                <div className="flex justify-between p-3">
                  <span className="text-ink-3">Delivered At</span>
                  <span className="text-ink">
                    {new Date(selectedJob.deliveredAt).toLocaleString()}
                  </span>
                </div>
              )}
            </div>

            {/* Formatted Diagnostic Payload Inspector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                  Diagnostic Payload
                </span>
                <CopyButton
                  value={(() => {
                    const p = selectedJob.payload ?? selectedJobPayload;
                    return p === undefined ? "" : JSON.stringify(p, null, 2) || "";
                  })()}
                  label="Copy Payload"
                />
              </div>
              <div className="max-h-72 overflow-auto rounded-xl border border-edge bg-surface-2 p-3 font-mono text-[11px] text-ink-2 shadow-inner leading-relaxed" aria-live="polite">
                {selectedJobPayloadLoading ? (
                  <span role="status">Loading payload…</span>
                ) : (
                  <pre>{(() => {
                    const p = selectedJob.payload ?? selectedJobPayload;
                    return p === undefined ? "Loading payload…" : JSON.stringify(p, null, 2) || "No payload stored.";
                  })()}</pre>
                )}
              </div>
            </div>
          </div>
          );
        })()}
      </Drawer>

      {/* Reprint confirmation: a physical operation deserves a deliberate one */}
      <Modal
        open={Boolean(reprintCandidate)}
        onClose={() => { if (!busy) setReprintCandidate(null); }}
        title="Reprint this document?"
        description="This sends the ORIGINAL document to the printer again."
        footer={
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setReprintCandidate(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              loading={busy}
              onClick={async () => {
                const job = reprintCandidate;
                setReprintCandidate(null);
                if (!job) return;
                await runAction(
                  () => reprintJob(job.id),
                  `Reprint queued for ${job.printerId} - watch it in the job list.`
                );
              }}
              icon={<RotateCcw className="h-4 w-4" />}
            >
              Reprint original document
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p>
            Printer: <strong className="text-ink">{reprintCandidate?.printerId}</strong>
            {" "}· Document: {reprintCandidate?.documentType || "standard"}
          </p>
          {reprintCandidate && deriveOutcome(reprintCandidate.status, reprintCandidate.error) === "unknown" && (
            <div className="rounded-xl border border-warn-edge bg-warn-bg/60 p-3 text-xs text-ink-2">
              The previous attempt has an <strong>unknown outcome</strong>. If any pages already
              printed, this reprint produces a duplicate. Confirm only after checking the printer.
            </div>
          )}
        </div>
      </Modal>

      {/* Disable / Retire agent confirmation */}
      <Modal
        open={Boolean(pendingAgentAction)}
        onClose={() => { if (!busy) setPendingAgentAction(null); }}
        title={pendingAgentAction?.next === "retired" ? "Retire this agent?" : "Disable this agent?"}
        description={
          pendingAgentAction?.next === "retired"
            ? "Retirement is permanent and keeps the agent for audit history."
            : "Disabling revokes the agent's credentials immediately."
        }
        footer={
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setPendingAgentAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={pendingAgentAction?.next === "retired" ? "danger" : "primary"}
              disabled={busy}
              loading={busy}
              onClick={async () => { await confirmAgentAction(); }}
            >
              {pendingAgentAction?.next === "retired" ? "Retire agent" : "Disable agent"}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          {pendingAgentAction?.next === "disabled" ? (
            <>
              <p>
                Disabling <strong className="text-ink">{pendingAgentAction.agent.name}</strong>:
              </p>
              <ul className="list-disc pl-5 text-xs space-y-1">
                <li>Revokes the agent&apos;s secret - it cannot reconnect or receive jobs.</li>
                <li>Disables its {pendingAgentAction.agent.printerCount} printer(s).</li>
                <li>Re-enabling requires pairing again with a fresh single-use code.</li>
              </ul>
            </>
          ) : (
            <>
              <p>
                Retiring <strong className="text-ink">{pendingAgentAction?.agent.name}</strong> keeps
                the agent and its print history for auditing. A retired agent cannot be re-activated
                or deleted.
              </p>
              <p className="text-xs text-ink-3">If you only need to pause it temporarily, use Disable instead.</p>
            </>
          )}
        </div>
      </Modal>

      {/* Permanent Agent Deletion Confirmation Modal */}
      <Modal
        open={Boolean(agentToDelete)}
        onClose={() => {
          if (!busy) setAgentToDelete(null);
        }}
        title="Delete Agent"
        description="This permanently removes this runtime agent from the Gateway."
        footer={
          <div className="flex items-center justify-end gap-3">
            <Button
              variant="secondary"
              onClick={() => setAgentToDelete(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!agentToDelete) return;
                const id = agentToDelete.id;
                await runAction(() => deleteAgent(id), "Agent permanently deleted.");
                setAgentToDelete(null);
              }}
              disabled={busy}
              loading={busy}
              icon={<Trash2 className="h-4 w-4" />}
            >
              Delete Agent
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-sm text-ink-2">
          <div className="rounded-xl border border-bad-edge bg-bad-bg/50 p-4 text-xs leading-relaxed text-bad">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0 text-bad" />
              <span>This action cannot be undone.</span>
            </div>
            <p className="mt-2 text-ink-2">
              The agent must be offline before it can be deleted. Historical print/audit records may
              require the agent to be retired instead.
            </p>
          </div>

          <p>
            Are you sure you want to permanently delete agent{" "}
            <strong className="font-semibold text-ink">{agentToDelete?.name}</strong>{" "}
            (<Mono>{agentToDelete?.id}</Mono>)?
          </p>

          {agentToDelete?.status === "online" && (
            <p className="text-xs font-semibold text-warn">
              Note: This agent is currently marked as online. You must shut down or disconnect the
              agent before deleting it.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
