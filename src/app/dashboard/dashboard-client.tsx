"use client";

import React, { useState, useMemo, useEffect } from "react";
import {
  createAgent,
  createTestPrintJob,
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
  CopyButton,
  agentTone,
  jobTone,
  printerTone,
} from "../../components/ui";

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
  const [agentName, setAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [activePairing, setActivePairing] = useState<{ code: string; expiresAt: Date } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [countdownText, setCountdownText] = useState("10:00");

  // Filter & view states
  const [printerViewMode, setPrinterViewMode] = useState<"grid" | "table">("grid");
  const [printerSearch, setPrinterSearch] = useState("");
  const [printerStatusFilter, setPrinterStatusFilter] = useState<string>("all");

  const [jobSearch, setJobSearch] = useState("");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("all");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

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
    const totalAgents = initialAgents.length;
    const onlineAgents = initialAgents.filter((a) => a.status.toLowerCase() === "online").length;

    const totalPrinters = initialPrinters.length;
    const onlinePrinters = initialPrinters.filter((p) => p.status.toLowerCase() === "online").length;

    const inFlightJobs = initialJobs.filter((j) => {
      const s = j.status.toLowerCase();
      return s === "queued" || s === "printing" || s === "claimed";
    }).length;

    const completedJobs = initialJobs.filter((j) => {
      const s = j.status.toLowerCase();
      return s === "success" || s === "completed";
    }).length;

    const attentionJobs = initialJobs.filter((j) => {
      const s = j.status.toLowerCase();
      return s === "unknown_partial_delivery" || s === "partial";
    }).length;

    const failedJobs = initialJobs.filter((j) => j.status.toLowerCase() === "failed").length;

    const successRate =
      initialJobs.length > 0 ? Math.round((completedJobs / initialJobs.length) * 100) : 100;

    return {
      totalAgents,
      onlineAgents,
      totalPrinters,
      onlinePrinters,
      inFlightJobs,
      completedJobs,
      attentionJobs,
      failedJobs,
      successRate,
    };
  }, [initialAgents, initialPrinters, initialJobs]);

  const runAction = async (operation: () => Promise<unknown>, successMsg: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage({ text: successMsg, type: "ok" });
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Operation failed",
        type: "err",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAgent = async (name: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await createAgent(name);
      const expiresAt = new Date(Date.now() + 1000 * 60 * 10);
      setActivePairing({ code: result.pairingCode, expiresAt });
      setAgentName("");
      setMessage({
        text: `Agent registered! Use pairing code ${result.pairingCode} within 10 minutes.`,
        type: "ok",
      });
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
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      setMessage({ text: "Please copy the code manually.", type: "err" });
    }
  };

  // Filtered printers
  const filteredPrinters = useMemo(() => {
    return initialPrinters.filter((p) => {
      if (printerStatusFilter !== "all" && p.status.toLowerCase() !== printerStatusFilter) {
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
  }, [initialPrinters, printerStatusFilter, printerSearch]);

  // Filtered jobs
  const filteredJobs = useMemo(() => {
    return initialJobs.filter((j) => {
      const s = j.status.toLowerCase();
      if (jobStatusFilter === "active" && !(s === "printing" || s === "claimed")) return false;
      if (jobStatusFilter === "queued" && s !== "queued") return false;
      if (jobStatusFilter === "attention" && !(s === "unknown_partial_delivery" || s === "partial"))
        return false;
      if (jobStatusFilter === "success" && !(s === "success" || s === "completed")) return false;
      if (jobStatusFilter === "failed" && s !== "failed") return false;

      if (jobSearch.trim()) {
        const q = jobSearch.toLowerCase();
        return (
          j.id.toLowerCase().includes(q) ||
          j.printerId.toLowerCase().includes(q) ||
          (j.destination && j.destination.toLowerCase().includes(q)) ||
          (j.documentType && j.documentType.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [initialJobs, jobStatusFilter, jobSearch]);

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
    if (c === "usb") return <span title="USB Connection"><Usb className="h-4 w-4 text-ink-3" /></span>;
    if (c === "network" || c === "tcp")
      return <span title="Network Connection"><Wifi className="h-4 w-4 text-ink-3" /></span>;
    return <span title="Spooler / System"><Layers className="h-4 w-4 text-ink-3" /></span>;
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
          title="Queue Throughput"
          value={kpis.inFlightJobs}
          subtitle={`${kpis.inFlightJobs} in-flight / processing`}
          icon={<Server className="h-5 w-5 text-info" />}
          tone="info"
        />
        <StatCard
          title="Success Rate"
          value={`${kpis.successRate}%`}
          subtitle={
            kpis.attentionJobs > 0
              ? `${kpis.attentionJobs} need attention`
              : `${kpis.failedJobs} failed jobs`
          }
          icon={<CheckCircle2 className="h-5 w-5 text-ok" />}
          tone={kpis.attentionJobs > 0 ? "warn" : kpis.successRate >= 90 ? "ok" : "warn"}
        />
      </section>

      {/* Global alert / message banner */}
      {message && (
        <div
          role="status"
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
        <div className="relative overflow-hidden rounded-2xl border-2 border-brand/40 bg-gradient-to-br from-brand-subtle via-surface to-surface-2 p-6 shadow-md">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-brand animate-ping" />
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
                onClick={() => window.location.reload()}
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
              {initialAgents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-edge p-6 text-center text-sm text-ink-3">
                  No runtime agents registered yet.
                </div>
              ) : (
                initialAgents.map((agent) => {
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
                        <StatusBadge
                          label={agent.status}
                          tone={agentTone(agent.status)}
                          pulse={agent.status.toLowerCase() === "online"}
                        />
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
                            onClick={() =>
                              void runAction(
                                () => setAgentLifecycle(agent.id, "disabled"),
                                "Agent disabled."
                              )
                            }
                            disabled={busy}
                            icon={<PauseCircle className="h-3.5 w-3.5" />}
                          >
                            Disable
                          </Button>
                        ) : agent.lifecycle === "disabled" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void runAction(
                                () => setAgentLifecycle(agent.id, "active"),
                                "Agent re-enabled."
                              )
                            }
                            disabled={busy}
                            icon={<PlayCircle className="h-3.5 w-3.5" />}
                          >
                            Re-enable
                          </Button>
                        ) : null}

                        {agent.pairingCode && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const expiresAt = agent.pairingCodeExpiresAt
                                ? new Date(agent.pairingCodeExpiresAt)
                                : new Date(Date.now() + 600000);
                              setActivePairing({ code: agent.pairingCode!, expiresAt });
                            }}
                            icon={<Key className="h-3.5 w-3.5 text-brand" />}
                          >
                            Pair Code
                          </Button>
                        )}
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
                <div className="flex rounded-lg border border-edge bg-surface-2 p-0.5">
                  <button
                    type="button"
                    title="Grid view"
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
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3" />
                <Input
                  className="pl-9"
                  placeholder="Search printers by name, ID, or connection..."
                  value={printerSearch}
                  onChange={(e) => setPrinterSearch(e.target.value)}
                />
              </div>
              <div className="flex w-full sm:w-auto items-center gap-2">
                <Select
                  value={printerStatusFilter}
                  onChange={(e) => setPrinterStatusFilter(e.target.value)}
                  className="w-full sm:w-36"
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
                            label={printer.status}
                            tone={printerTone(printer.status)}
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
                              `Test print job dispatched to ${printer.name}.`
                            )
                          }
                          disabled={busy || printer.lifecycle !== "active"}
                          icon={<CheckCircle2 className="h-3.5 w-3.5 text-ok" />}
                        >
                          Test Print
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
                              label={printer.status}
                              tone={printerTone(printer.status)}
                            />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                void runAction(
                                  () => createTestPrintJob(printer.id),
                                  `Test print sent to ${printer.name}.`
                                )
                              }
                              disabled={busy || printer.lifecycle !== "active"}
                            >
                              Test Print
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
          subtitle="Real-time telemetry, execution tracking, and diagnostic payload inspector"
          icon={<Server className="h-5 w-5 text-brand" />}
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.location.reload()}
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
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-3" />
              <Input
                className="pl-9"
                placeholder="Search by job ID, destination..."
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto w-full sm:w-auto">
              {[
                { id: "all", label: "All Jobs" },
                { id: "active", label: "In Flight" },
                { id: "attention", label: "Attention Needed" },
                { id: "queued", label: "Queued" },
                { id: "success", label: "Success" },
                { id: "failed", label: "Failed" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setJobStatusFilter(tab.id)}
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
          {filteredJobs.length === 0 ? (
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
                    const isPartial =
                      job.status.toLowerCase() === "unknown_partial_delivery" ||
                      job.status.toLowerCase() === "partial";
                    return (
                      <tr
                        key={job.id}
                        onClick={() => setSelectedJob(job)}
                        className="cursor-pointer transition-colors hover:bg-surface-2/50"
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
                            label={
                              isPartial
                                ? "Attention Needed"
                                : job.status.toUpperCase()
                            }
                            tone={jobTone(job.status)}
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
        {selectedJob && (
          <div className="space-y-6">
            {/* Status Callout Banner */}
            <div className="flex items-center justify-between rounded-xl border border-edge bg-surface-2 p-4">
              <div className="space-y-1">
                <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                  Current State
                </span>
                <div className="text-lg font-bold text-ink">
                  {selectedJob.status.replace(/_/g, " ").toUpperCase()}
                </div>
              </div>
              <StatusBadge
                label={selectedJob.status.toUpperCase()}
                tone={jobTone(selectedJob.status)}
                pulse={
                  selectedJob.status.toLowerCase() === "printing" ||
                  selectedJob.status.toLowerCase() === "claimed"
                }
              />
            </div>

            {/* Unknown Partial Delivery Warning Banner */}
            {(selectedJob.status.toLowerCase() === "unknown_partial_delivery" ||
              selectedJob.status.toLowerCase() === "partial") && (
              <div className="rounded-xl border border-warn-edge bg-warn-bg p-4 space-y-3">
                <div className="flex items-start gap-2.5 text-warn">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-bold text-sm">Attention Needed: Partial Delivery Detected</h4>
                    <p className="text-xs leading-relaxed mt-1 text-ink-2">
                      The printer agent reported a connection loss after partial data was written.
                      Physical paper may or may not have partially printed. Use Force Reprint only if
                      the physical document did not complete.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      void runAction(
                        () => createTestPrintJob(selectedJob.printerId),
                        `Force reprint dispatched to ${selectedJob.printerId}.`
                      )
                    }
                    disabled={busy}
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                  >
                    Force Reprint
                  </Button>
                </div>
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
                  value={JSON.stringify(selectedJob.payload, null, 2) || ""}
                  label="Copy Payload"
                />
              </div>
              <div className="max-h-72 overflow-auto rounded-xl border border-edge bg-surface-2 p-3 font-mono text-[11px] text-ink-2 shadow-inner leading-relaxed">
                <pre>{JSON.stringify(selectedJob.payload, null, 2) || "No payload stored."}</pre>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
