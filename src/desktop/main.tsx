/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ClipboardList,
  Cpu,
  Info,
  LayoutDashboard,
  Menu,
  Printer as PrinterIcon,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  X,
  Zap,
} from "lucide-react";
import {
  Button,
  Drawer,
  MetaRow,
  Modal,
  Mono,
  StatusBadge,
  StatusDot,
  Toast as ToastView,
} from "../components/ui";
import { PageHeader } from "./ui";
import { JobTimeline } from "./components/JobTimeline";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { AddPrinterDialog } from "./components/AddPrinterDialog";
import { OverviewPage } from "./pages/Overview";
import { PrintersPage } from "./pages/Printers";
import { JobsPage } from "./pages/Jobs";
import { AgentsPage } from "./pages/Agents";
import { SettingsPage } from "./pages/Settings";
import {
  fetchGatewayHealth,
  fetchGatewayJobs,
  getAgentStatus,
  getAppVersion,
  getAutostart,
  getGatewayUrl,
  getPrinters,
  getRuntimePaths,
  isTauri,
  onTrayNavigate,
  onTrayRestartAgent,
  pairAgent,
  restartAgent as ipcRestartAgent,
  setGatewayUrl,
  startAgent as ipcStartAgent,
  stopAgent as ipcStopAgent,
  normalizeGatewayUrl,
  discoverPrinters,
  testPrinter,
  setAutostart,
  type PrinterInfo,
} from "./lib/ipc";
import {
  errMsg,
  friendlyPrinterError,
  humanConnection,
  humanType,
  isProductionPrinter,
  jobDocType,
  jobId,
  jobPrinterId,
  jobStatus,
  jobTone,
  labelJob,
  labelPrinter,
  printerEndpoint,
  printerTone,
} from "./lib/printers";
import type {
  AgentStatusView,
  DesktopState,
  JobRecord,
  JobTab,
  Page,
  PrinterStatusFilter,
  ToastMessage,
} from "./types";
import "../app/globals.css";
/* The Desktop Manager is always light — see the file for why. */
import "./theme-light.css";

const PAGES: Page[] = ["dashboard", "printers", "jobs", "agents", "settings"];

function useHashPage(defaultPage: Page): [Page, (p: Page) => void] {
  const getHash = (): Page => {
    const h = window.location.hash.replace("#", "") as Page;
    return PAGES.includes(h) ? h : defaultPage;
  };
  const [page, setPage] = useState<Page>(() => getHash());
  useEffect(() => {
    const onHash = () => setPage(getHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((p: Page) => {
    window.location.hash = p;
    setPage(p);
  }, []);
  return [page, navigate];
}

/* ---------- App ---------- */

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [page, navigate] = useHashPage("dashboard");
  const [version, setVersion] = useState("");
  const [gatewayUrl, setGw] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatusView | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<DesktopState["runtimePaths"]>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMessage>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersFilter, setPrintersFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<PrinterStatusFilter>("all");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobTab, setJobTab] = useState<JobTab>("all");
  const [jobSearch, setJobSearch] = useState("");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterInfo | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [jobPrinterFilter, setJobPrinterFilter] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!isTauri) return;
    try {
      const s = await getAgentStatus();
      setAgentStatus(s);
      setLastHeartbeat(new Date().toISOString());
    } catch (e) {
      setAgentStatus({ error: errMsg(e) });
    }
  }, []);

  const refreshPrinters = useCallback(async () => {
    if (!isTauri) return;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      // UI safety net: the agent already filters virtual/redirected queues at
      // discovery time; anything that still reports as virtual is dropped here.
      const list = await getPrinters();
      setPrinters(list.filter(isProductionPrinter));
    } catch (e) {
      setPrintersError(friendlyPrinterError(errMsg(e)));
    } finally {
      setPrintersLoading(false);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!gatewayUrl) return;
    setJobsLoading(true);
    try {
      const data = await fetchGatewayJobs(gatewayUrl);
      setJobs(Array.isArray(data) ? data : []);
      setJobsError(null);
    } catch (e: unknown) {
      setJobs([]);
      const status = Number((e as { status?: number })?.status ?? 0);
      setJobsError(
        status === 401 || status === 403
          ? "Gateway requires a manager session — sign in at the gateway dashboard to view jobs."
          : `Could not load jobs: ${errMsg(e)}`
      );
    } finally {
      setJobsLoading(false);
    }
  }, [gatewayUrl]);

  const checkHealth = useCallback(async () => {
    if (!gatewayUrl) {
      setHealthError("Gateway URL not configured");
      return;
    }
    setHealthError(null);
    try {
      const h = await fetchGatewayHealth(gatewayUrl);
      setHealth(h);
      if ((h as { error?: string })?.error) setHealthError(String((h as { error?: string }).error));
    } catch (e) {
      setHealthError(friendlyPrinterError(errMsg(e)));
    }
  }, [gatewayUrl]);

  const handleDiscover = useCallback(async () => {
    if (!isTauri) return;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const res = await discoverPrinters();
      const list = res.printers.filter(isProductionPrinter);
      setPrinters(list);
      setMsg({ text: `Discovery found ${list.length} printers`, type: "success" });
      if (res.errors.length) setPrintersError(res.errors.join("; ").slice(0, 300));
    } catch (e) {
      setPrintersError(friendlyPrinterError(errMsg(e)));
    } finally {
      setPrintersLoading(false);
    }
  }, []);

  const handleTest = useCallback(
    async (id: string) => {
      try {
        setBusyBoth(true);
        await testPrinter(id);
        setMsg({ text: "Test print sent", type: "success" });
      } catch (e) {
        setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" });
      } finally {
        setBusyBoth(false);
      }
    },
    [setBusyBoth]
  );

  const saveGateway = useCallback(async () => {
    try {
      const n = normalizeGatewayUrl(gatewayUrl);
      setGatewaySaving(true);
      await setGatewayUrl(n);
      setGw(n);
      setMsg({ text: "Gateway saved", type: "success" });
      checkHealth();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setGatewaySaving(false);
    }
  }, [gatewayUrl, checkHealth]);

  const startAgent = useCallback(async () => {
    try {
      setBusyBoth(true);
      const m = await ipcStartAgent();
      setMsg({ text: m, type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const stopAgent = useCallback(async () => {
    setConfirmStop(false);
    try {
      setBusyBoth(true);
      const m = await ipcStopAgent();
      setMsg({ text: m, type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const restartAgent = useCallback(async () => {
    try {
      setBusyBoth(true);
      const m = await ipcRestartAgent();
      setMsg({ text: m, type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const pair = useCallback(async () => {
    if (!pairCode.trim()) {
      setMsg({ text: "Enter pairing code", type: "error" });
      return;
    }
    if (!gatewayUrl) {
      setMsg({ text: "Set gateway URL first", type: "error" });
      return;
    }
    try {
      setBusyBoth(true);
      const r = await pairAgent(pairCode.trim(), gatewayUrl);
      setMsg({ text: r || "Agent paired", type: "success" });
      setPairCode("");
      refreshStatus();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [pairCode, gatewayUrl, refreshStatus, setBusyBoth]);

  useEffect(() => {
    if (!isTauri) return;
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
    getGatewayUrl()
      .then((v) => {
        setGw(v);
        if (v)
          fetchGatewayHealth(v)
            .then((h) => setHealth(h))
            .catch((e) => setHealthError(errMsg(e)));
      })
      .catch(() => {});
    getRuntimePaths()
      .then(setRuntimePaths)
      .catch(() => {});
    getAutostart()
      .then((st) => setAutostartState(st.enabled))
      .catch(() => {});
    refreshStatus();
    refreshPrinters();
    const id = setInterval(refreshStatus, 30000);
    return () => clearInterval(id);
  }, [refreshStatus, refreshPrinters]);

  useEffect(() => {
    if (gatewayUrl) refreshJobs();
  }, [gatewayUrl, refreshJobs]);

  useEffect(() => {
    if (!isTauri) return;
    onTrayNavigate((anchor) => {
      const p = anchor.replace("#", "") as Page;
      if (PAGES.includes(p)) navigate(p);
    });
    onTrayRestartAgent(() => restartAgent());
  }, [navigate, restartAgent]);

  const isOnline =
    !!agentStatus && !(agentStatus as Record<string, unknown>).error && (agentStatus as { running?: boolean }).running !== false;
  const gatewayConnected = !!health && (health as { ok?: boolean }).ok !== false && !healthError;
  const physicalPrinters = useMemo(() => printers.filter(isProductionPrinter), [printers]);
  const totalPrinters = physicalPrinters.length;
  const onlinePrinters = physicalPrinters.filter((p) => p.status === "online").length;
  const offlinePrinters = physicalPrinters.filter(
    (p) => p.status === "offline" || p.status === "error"
  ).length;
  const pendingJobs = jobs.filter((j) => ["queued", "claimed"].includes(jobStatus(j))).length;
  const failedJobs = jobs.filter((j) => ["failed", "expired"].includes(jobStatus(j))).length;
  const fleetAgents = (health as { agents?: { total?: number; online?: number } } | null)?.agents;
  const fleetTotal = Number(fleetAgents?.total ?? 0);
  const fleetOnline = Number(fleetAgents?.online ?? 0);
  const printerFilterName =
    printers.find((pp) => pp.id === jobPrinterFilter)?.name ?? jobPrinterFilter ?? "";

  const filteredPrinters = useMemo(() => {
    let list = physicalPrinters;
    if (printersFilter) {
      const q = printersFilter.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.connection_type || "").toLowerCase().includes(q) ||
          (p.printer_type || "").toLowerCase().includes(q) ||
          printerEndpoint(p).toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") {
      list = list.filter((p) => p.status === statusFilter);
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [physicalPrinters, printersFilter, statusFilter]);

  const jobsFiltered = useMemo(() => {
    let list = jobs;
    if (jobPrinterFilter) {
      const target = (printers.find((pp) => pp.id === jobPrinterFilter)?.name || "").toLowerCase();
      list = list.filter((j) => {
        const pid = jobPrinterId(j);
        return (
          pid === jobPrinterFilter ||
          (!!target && String(j.printerName ?? "").toLowerCase() === target)
        );
      });
    }
    if (jobTab !== "all") {
      list = list.filter((j) => {
        const st = jobStatus(j).toLowerCase();
        if (jobTab === "pending") return ["queued", "claimed"].includes(st);
        if (jobTab === "printing") return st === "printing";
        if (jobTab === "completed") return ["success", "completed"].includes(st);
        if (jobTab === "failed") return ["failed", "expired"].includes(st);
        return true;
      });
    }
    if (jobSearch) {
      const q = jobSearch.toLowerCase();
      list = list.filter(
        (j) =>
          jobId(j).toLowerCase().includes(q) ||
          jobDocType(j).toLowerCase().includes(q) ||
          jobPrinterId(j).toLowerCase().includes(q)
      );
    }
    return list;
  }, [jobs, jobTab, jobSearch, jobPrinterFilter, printers]);

  const jobCounts = useMemo(
    () => ({
      all: jobs.length,
      pending: pendingJobs,
      printing: jobs.filter((j) => jobStatus(j) === "printing").length,
      completed: jobs.filter((j) => ["success", "completed"].includes(jobStatus(j))).length,
      failed: failedJobs,
    }),
    [jobs, pendingJobs, failedJobs]
  );

  const nav: NavItem[] = [
    {
      id: "dashboard",
      label: "Overview",
      icon: LayoutDashboard,
      desc: isOnline ? "Operational" : "Check status",
    },
    { id: "printers", label: "Printers", icon: PrinterIcon, desc: `${totalPrinters} total` },
    { id: "jobs", label: "Print Jobs", icon: ClipboardList, desc: `${pendingJobs} pending` },
    {
      id: "agents",
      label: "Agents",
      icon: Cpu,
      desc: isOnline ? "Local online" : "Local stopped",
    },
    { id: "settings", label: "Settings", icon: SettingsIcon, desc: "Gateway & agent" },
  ];

  const pageMeta: Record<Page, { title: string; subtitle: string }> = {
    dashboard: {
      title: "Overview",
      subtitle: "Monitor your print infrastructure, agents, printers and jobs.",
    },
    printers: {
      title: "Printers",
      subtitle: "Discover, register and test the physical printers this agent can reach.",
    },
    jobs: {
      title: "Print Jobs",
      subtitle: "Operational queue — queued, printing, completed and failed.",
    },
    agents: { title: "Agents", subtitle: "This PC's print agent and the gateway fleet." },
    settings: {
      title: "Settings",
      subtitle: "Gateway connection, local agent and pairing.",
    },
  };

  const state: DesktopState = {
    page,
    navigate,
    collapsed,
    setCollapsed,
    sidebarOpen,
    setSidebarOpen,
    version,
    agentStatus,
    isOnline,
    lastHeartbeat,
    autostart,
    setAutostartState,
    refreshStatus,
    startAgent,
    requestStopAgent: () => setConfirmStop(true),
    restartAgent,
    gatewayUrl,
    setGw,
    health,
    healthError,
    gatewayConnected,
    gatewaySaving,
    checkHealth,
    saveGateway,
    pairCode,
    setPairCode,
    pair,
    printers: physicalPrinters,
    printersLoading,
    printersError,
    printersFilter,
    setPrintersFilter,
    statusFilter,
    setStatusFilter,
    filteredPrinters,
    totalPrinters,
    onlinePrinters,
    offlinePrinters,
    refreshPrinters,
    handleDiscover,
    handleTest,
    showAdd,
    setShowAdd,
    selectedPrinter,
    setSelectedPrinter,
    jobs,
    jobsLoading,
    jobsError,
    jobTab,
    setJobTab,
    jobSearch,
    setJobSearch,
    jobsFiltered,
    jobCounts,
    pendingJobs,
    failedJobs,
    refreshJobs,
    jobPrinterFilter,
    setJobPrinterFilter,
    printerFilterName,
    selectedJob,
    setSelectedJob,
    runtimePaths,
    advancedOpen,
    setAdvancedOpen,
    busy,
    msg,
    setMsg,
    fleetTotal,
    fleetOnline,
  };

  return (
    <div className="min-h-screen bg-app text-ink">
      <Sidebar
        page={page}
        navigate={navigate}
        items={nav}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        gatewayConnected={gatewayConnected}
        gatewayUrl={gatewayUrl}
        isOnline={isOnline}
        version={version}
        lastHeartbeat={lastHeartbeat}
      />
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ backgroundColor: "var(--overlay)" }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <div
        className={`flex min-h-screen min-w-0 flex-col transition-[padding] duration-200 ${
          collapsed ? "lg:pl-[72px]" : "lg:pl-[248px]"
        }`}
      >
        <header className="sticky top-0 z-20 border-b border-edge bg-surface/90 px-5 py-5 backdrop-blur-md lg:px-8">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setCollapsed(false);
                setSidebarOpen(true);
              }}
              className="rounded-lg p-2.5 text-ink-2 transition-colors hover:bg-surface-2 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <PageHeader
                title={pageMeta[page].title}
                subtitle={pageMeta[page].subtitle}
                actions={
                  <>
                    <StatusBadge
                      tone={isOnline ? "ok" : "bad"}
                      label={isOnline ? "Agent online" : "Agent offline"}
                    />
                    <Button
                      variant="secondary"
                      onClick={() => {
                        refreshStatus();
                        refreshPrinters();
                        if (gatewayUrl) refreshJobs();
                      }}
                      icon={<RefreshCw className="h-[18px] w-[18px]" />}
                      aria-label="Refresh all"
                    >
                      <span className="hidden sm:inline">Refresh</span>
                    </Button>
                  </>
                }
              />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-7 lg:px-8 lg:py-8">
          {page === "dashboard" && <OverviewPage s={state} />}
          {page === "printers" && <PrintersPage s={state} />}
          {page === "jobs" && <JobsPage s={state} />}
          {page === "agents" && <AgentsPage s={state} />}
          {page === "settings" && <SettingsPage s={state} />}
        </main>
      </div>

      <AddPrinterDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSuccess={() => {
          refreshPrinters();
          setMsg({ text: "Printer added", type: "success" });
        }}
        printers={printers}
      />

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop the local agent?"
        description="The agent will stop accepting print jobs until it is started again."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={stopAgent}
              icon={<Square className="h-4 w-4" />}
            >
              Stop agent
            </Button>
          </>
        }
      >
        <p className="text-[14px] leading-relaxed text-ink-2">
          In-flight jobs are drained first; the gateway keeps them queued and they can be
          resumed when the agent is back online.
        </p>
      </Modal>

      <Drawer
        open={!!selectedPrinter}
        onClose={() => setSelectedPrinter(null)}
        title="Printer details"
        description={selectedPrinter?.name}
      >
        {selectedPrinter && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 rounded-xl border border-edge-accent bg-surface-accent px-5 py-4">
              <StatusDot tone={printerTone(selectedPrinter.status)} />
              <span className="text-[16px] font-semibold text-ink">
                {labelPrinter(selectedPrinter.status)}
              </span>
              <span className="ml-auto text-[13px] text-ink-3">
                {humanType(selectedPrinter)}
              </span>
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label="Name">
                <span className="block truncate">{selectedPrinter.name}</span>
              </MetaRow>
              <MetaRow label="Connection">{humanConnection(selectedPrinter)}</MetaRow>
              <MetaRow label="Protocol">{selectedPrinter.protocol || "—"}</MetaRow>
              <MetaRow label="Address">
                <Mono>{printerEndpoint(selectedPrinter)}</Mono>
              </MetaRow>
              <MetaRow label="Stable ID">
                <Mono>{selectedPrinter.id}</Mono>
              </MetaRow>
              {selectedPrinter.usbVid && (
                <MetaRow label="USB">
                  <Mono>
                    {selectedPrinter.usbVid}:{selectedPrinter.usbPid}{" "}
                    {selectedPrinter.usbSerial || ""}
                  </Mono>
                </MetaRow>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="primary"
                onClick={() => handleTest(selectedPrinter.id)}
                icon={<Zap className="h-4 w-4" />}
              >
                Test print
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setJobPrinterFilter(selectedPrinter.id);
                  setSelectedPrinter(null);
                  navigate("jobs");
                }}
                icon={<ClipboardList className="h-4 w-4" />}
              >
                View jobs
              </Button>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-3">
              A test print goes through the same job pipeline as real prints — queued, claimed
              by the agent, then to the printer.
            </p>
          </div>
        )}
      </Drawer>

      <Drawer
        open={!!selectedJob}
        onClose={() => setSelectedJob(null)}
        title="Job details"
        description={selectedJob ? jobDocType(selectedJob) : undefined}
      >
        {selectedJob && (
          <div className="space-y-6">
            <div className="space-y-4">
              <StatusBadge
                tone={jobTone(jobStatus(selectedJob))}
                label={labelJob(jobStatus(selectedJob))}
              />
              <JobTimeline status={jobStatus(selectedJob)} />
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label="Job ID">
                <Mono>{jobId(selectedJob)}</Mono>
              </MetaRow>
              <MetaRow label="Printer">
                <span className="block truncate">
                  {String(
                    printers.find((p) => p.id === jobPrinterId(selectedJob))?.name ||
                      jobPrinterId(selectedJob) ||
                      "—"
                  )}
                </span>
              </MetaRow>
              <MetaRow label="Branch">
                <span className="block truncate">{String(selectedJob.branchId || "—")}</span>
              </MetaRow>
              <MetaRow label="Retries">{String(selectedJob.retries ?? 0)}</MetaRow>
              <MetaRow label="Created">
                {selectedJob.createdAt
                  ? new Date(String(selectedJob.createdAt)).toLocaleString()
                  : "—"}
              </MetaRow>
              <MetaRow label="Updated">
                {selectedJob.updatedAt
                  ? new Date(String(selectedJob.updatedAt)).toLocaleString()
                  : "—"}
              </MetaRow>
            </div>
            {selectedJob.error ? (
              <div className="rounded-xl border border-bad-edge bg-bad-bg p-5">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-bad">
                  <AlertTriangle className="h-5 w-5" aria-hidden /> Print failed
                </div>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
                  {friendlyPrinterError(String(selectedJob.error))}
                </p>
                <details className="mt-3">
                  <summary className="cursor-pointer text-[13px] font-medium text-ink-3">
                    Technical details
                  </summary>
                  <p className="mt-2 break-all font-mono text-[12px] text-ink-2">
                    {String(selectedJob.error)}
                  </p>
                </details>
                <p className="mt-3 text-[13px] text-ink-3">
                  Retries: {String(selectedJob.retries ?? 0)} of 5 — the gateway re-delivers the
                  job to the agent while retries remain.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-info-edge bg-info-bg px-5 py-4 text-[14px] text-info">
                <Info className="h-5 w-5 flex-shrink-0" aria-hidden /> No error recorded for
                this job.
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ToastView toast={msg} onDismiss={() => setMsg(null)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
