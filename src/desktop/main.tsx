import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Printer,
  ClipboardList,
  Settings,
  Sun,
  Moon,
  Menu,
  X,
  RefreshCw,
  Search,
  Wifi,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Activity,
  Server,
  HardDrive,
  FileText,
  Power,
  PowerOff,
  RotateCcw,
  Play,
  Square,
  Link2,
  ShieldCheck,
  Zap,
  ChevronRight,
  Inbox,
  Loader2,
  Eye,
  Trash2,
  Download,
  Info,
  ExternalLink,
} from "lucide-react";
import {
  fetchGatewayHealth,
  getAgentStatus,
  getAppVersion,
  getGatewayUrl,
  getRuntimePaths,
  isTauri,
  normalizeGatewayUrl,
  onTrayNavigate,
  onTrayRestartAgent,
  pairAgent,
  restartAgent as ipcRestartAgent,
  setGatewayUrl,
  startAgent as ipcStartAgent,
  stopAgent as ipcStopAgent,
  type AgentStatus,
  type RuntimePaths,
  getPrinters,
  discoverPrinters,
  testPrinter,
  getAutostart,
  setAutostart,
  type PrinterInfo,
} from "./lib/ipc";
import "../app/globals.css";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type AgentStatusView = Partial<AgentStatus> & { error?: string };
type Page = "dashboard" | "printers" | "jobs" | "settings";
type JobTab = "all" | "pending" | "printing" | "completed" | "failed";

function useHashPage(defaultPage: Page): [Page, (p: Page) => void] {
  const getHash = (): Page => {
    const h = window.location.hash.replace("#", "") as Page;
    if (["dashboard", "printers", "jobs", "settings"].includes(h)) return h;
    return defaultPage;
  };
  const [page, setPage] = useState<Page>(() => getHash());
  useEffect(() => {
    const onHash = () => setPage(getHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const navigate = useCallback((p: Page) => {
    window.location.hash = p;
    setPage(p);
  }, []);
  return [page, navigate];
}

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "success" | "warning" | "danger" | "info" | "neutral" }) {
  const map: Record<string, string> = {
    default: "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700",
    success: "bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
    warning: "bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800",
    danger: "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800",
    info: "bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800",
    neutral: "bg-zinc-50 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700",
  };
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${map[variant]}`}>{children}</span>;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-800 rounded-2xl shadow-sm ${className}`}>{children}</div>;
}

function StatCard({ title, value, subtitle, icon, color }: { title: string; value: string; subtitle?: string; icon: React.ReactNode; color: string }) {
  return (
    <Card className="p-5 relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-1 ${color}`} />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold tracking-widest uppercase text-zinc-500 dark:text-zinc-400">{title}</p>
          <p className="text-2xl font-black mt-1">{value}</p>
          {subtitle && <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{subtitle}</p>}
        </div>
        <div className="w-10 h-10 rounded-xl bg-zinc-50 dark:bg-zinc-800 border border-zinc-200/50 dark:border-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-300">{icon}</div>
      </div>
    </Card>
  );
}

function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="py-16 flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 mb-4">{icon}</div>
      <h3 className="font-bold text-sm">{title}</h3>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm mt-1">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-zinc-100 dark:bg-zinc-800 rounded w-1/3" />
      <div className="h-24 bg-zinc-100 dark:bg-zinc-800 rounded-xl" />
      <div className="h-24 bg-zinc-100 dark:bg-zinc-800 rounded-xl" />
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("theme") as any) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [page, navigate] = useHashPage("dashboard");
  const [version, setVersion] = useState("");
  const [gatewayUrl, setGw] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatusView | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((v: boolean) => { busyRef.current = v; setBusy(v); }, []);

  // Data for new pages
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersFilter, setPrintersFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline">("all");
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobTab, setJobTab] = useState<JobTab>("all");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

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
      const list = await getPrinters();
      setPrinters(list);
    } catch (e) {
      setPrintersError(errMsg(e));
    } finally {
      setPrintersLoading(false);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!gatewayUrl) return;
    setJobsLoading(true);
    try {
      const url = normalizeGatewayUrl(gatewayUrl);
      // Try gateway jobs API (may require manager auth, handle gracefully)
      const res = await fetch(`${url}/api/jobs?limit=50`, { credentials: "include" }).catch(() => null);
      if (res && res.ok) {
        const data = (await res.json()) as Record<string, unknown>[];
        setJobs(Array.isArray(data) ? data : []);
      } else {
        // Fallback: try health jobs count only
        setJobs([]);
      }
    } catch {
      setJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, [gatewayUrl]);

  const checkHealth = useCallback(async () => {
    if (!gatewayUrl.trim()) {
      setHealthError("Gateway URL is empty");
      setHealth(null);
      return;
    }
    let url: string;
    try {
      url = normalizeGatewayUrl(gatewayUrl);
    } catch (e) {
      setHealthError(errMsg(e));
      return;
    }
    setBusyBoth(true);
    try {
      const h = await fetchGatewayHealth(url);
      setHealth(h as Record<string, unknown>);
      setHealthError(null);
      setLastHeartbeat(new Date().toISOString());
      // After health, refresh jobs
      refreshJobs();
    } catch (e) {
      const m = errMsg(e);
      setHealth(null);
      setHealthError(m.includes("abort") || m === "The operation was aborted." ? `gateway did not respond within 8s (${url})` : m);
    } finally {
      setBusyBoth(false);
    }
  }, [gatewayUrl, setBusyBoth, refreshJobs]);

  const startAgent = useCallback(async () => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      setMsg({ text: String(await ipcStartAgent()), type: "success" });
      await refreshStatus();
      await refreshPrinters();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, refreshPrinters, setBusyBoth]);

  const stopAgent = useCallback(async () => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      setMsg({ text: String(await ipcStopAgent()), type: "success" });
      await refreshStatus();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const restartAgent = useCallback(async () => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      setMsg({ text: String(await ipcRestartAgent()), type: "success" });
      await refreshStatus();
      await refreshPrinters();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, refreshPrinters, setBusyBoth]);

  const saveGateway = useCallback(async () => {
    let url: string;
    try {
      url = normalizeGatewayUrl(gatewayUrl);
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
      return;
    }
    if (!isTauri) {
      await checkHealth();
      return;
    }
    try {
      await setGatewayUrl(url);
      setGw(url);
      setMsg({ text: "Gateway URL saved.", type: "success" });
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
      return;
    }
    await checkHealth();
  }, [gatewayUrl, checkHealth]);

  const pair = useCallback(async () => {
    if (!isTauri) {
      setMsg({ text: "Pairing requires the Windows desktop app.", type: "error" });
      return;
    }
    let url: string;
    try {
      url = normalizeGatewayUrl(gatewayUrl);
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
      return;
    }
    setBusyBoth(true);
    try {
      const res = String(await pairAgent(pairCode, url));
      setMsg({ text: res, type: "success" });
      setPairCode("");
      await startAgent();
      await refreshPrinters();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [gatewayUrl, pairCode, startAgent, refreshPrinters, setBusyBoth]);

  const handleDiscover = useCallback(async () => {
    if (!isTauri) return;
    setPrintersLoading(true);
    try {
      const res = await discoverPrinters();
      setMsg({ text: `Discovered ${res.printers.length} printer(s).`, type: "success" });
      await refreshPrinters();
    } catch (e) {
      setMsg({ text: errMsg(e), type: "error" });
    } finally {
      setPrintersLoading(false);
    }
  }, [refreshPrinters]);

  const handleTest = useCallback(async (id: string) => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      const res = await testPrinter(id);
      setMsg({ text: `Test print sent to ${id}: ${res}`, type: "success" });
    } catch (e) {
      setMsg({ text: `Test failed for ${id}: ${errMsg(e)}`, type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [setBusyBoth]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(async () => {
      if (!isTauri) {
        if (!disposed) setMsg({ text: "Running in browser mode. Desktop controls require the installed Windows app.", type: "info" });
        return;
      }
      try {
        const [url, v] = await Promise.all([getGatewayUrl(), getAppVersion()]);
        if (disposed) return;
        if (url) setGw(url);
        setVersion(v);
        try {
          const a = await getAutostart();
          if (!disposed) setAutostartState(a.enabled);
        } catch {}
      } catch (e) {
        console.warn("initial load failed", e);
      }
      await refreshStatus();
      await refreshPrinters();
      try {
        const p = await getRuntimePaths();
        if (!disposed) setRuntimePaths(p);
      } catch {}
      if (gatewayUrl) checkHealth();
    });
    if (!isTauri) return () => { disposed = true; };
    const unlisteners: Array<Promise<() => void>> = [
      onTrayRestartAgent(() => { if (!busyRef.current) void restartAgent(); }),
      onTrayNavigate((anchor) => {
        if (typeof anchor === "string" && anchor.startsWith("#")) {
          const page = anchor.replace("#", "") as Page;
          if (["dashboard", "printers", "jobs", "settings"].includes(page)) {
            window.location.hash = page;
          } else {
            window.location.hash = anchor;
          }
        }
      }),
    ];
    return () => {
      disposed = true;
      for (const u of unlisteners) void u.then((fn) => fn()).catch(() => {});
    };
  }, [refreshStatus, restartAgent, refreshPrinters, gatewayUrl, checkHealth]);

  // Auto-refresh printers/jobs when gatewayUrl changes (deferred to avoid cascading renders)
  useEffect(() => {
    if (gatewayUrl) {
      queueMicrotask(() => {
        void refreshPrinters();
        void refreshJobs();
      });
    }
  }, [gatewayUrl, refreshPrinters, refreshJobs]);

  const isOnline = agentStatus && !agentStatus.error && (agentStatus as any).running;
  const filteredPrinters = useMemo(() => {
    return printers.filter((p) => {
      const q = printersFilter.toLowerCase();
      const matchesSearch = !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.spooler_name || "").toLowerCase().includes(q) || (p.network_address || "").toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [printers, printersFilter, statusFilter]);

  const jobsFiltered = useMemo(() => {
    if (jobTab === "all") return jobs;
    return jobs.filter((j: any) => {
      const s = String(j.status || "").toLowerCase();
      if (jobTab === "pending") return ["queued", "claimed"].includes(s);
      if (jobTab === "printing") return s === "printing";
      if (jobTab === "completed") return ["success", "completed"].includes(s);
      if (jobTab === "failed") return ["failed", "expired"].includes(s);
      return true;
    });
  }, [jobs, jobTab]);

  const onlinePrinters = printers.filter((p) => p.status === "online").length;
  const totalPrinters = printers.length;
  const pendingJobs = jobs.filter((j: any) => ["queued", "claimed"].includes(String(j.status))).length;
  const failedJobs = jobs.filter((j: any) => String(j.status) === "failed").length;

  return (
    <div className={`min-h-screen flex bg-gradient-to-br from-slate-50 via-white to-indigo-50/20 dark:from-zinc-950 dark:via-zinc-900 dark:to-slate-900 text-zinc-900 dark:text-zinc-50 ${theme}`}>
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0 fixed inset-y-0 left-0 z-30 w-64 border-r border-zinc-200/70 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl flex flex-col transition-transform duration-200`}>
        <div className="h-16 px-5 flex items-center gap-3 border-b border-zinc-200/60 dark:border-zinc-800/80">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#0F172A] via-[#4338CA] to-[#06B6D4] flex items-center justify-center shadow">
            <Printer className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-black text-sm leading-none">Odoo Print</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">Manager • v{version || "…"}</div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="w-4 h-4" /></button>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {[
            { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, desc: "Overview & health" },
            { id: "printers", label: "Printers", icon: Printer, desc: `${totalPrinters} printers` },
            { id: "jobs", label: "Print Jobs", icon: ClipboardList, desc: `${jobs.length} jobs` },
            { id: "settings", label: "Settings", icon: Settings, desc: "Gateway & agent" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => {
                navigate(item.id as Page);
                setSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-left transition ${page === item.id ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow" : "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300"}`}
            >
              <item.icon className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              <ChevronRight className={`w-3 h-3 opacity-50 ${page === item.id ? "opacity-100" : ""}`} />
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-zinc-200/60 dark:border-zinc-800/80">
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
            {isOnline ? "Agent Online" : "Agent Offline"}
            <span className="ml-auto font-mono text-xs">{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 lg:ml-64 flex flex-col min-h-screen min-w-0">
        <header className="sticky top-0 z-20 backdrop-blur-xl bg-white/80 dark:bg-zinc-900/80 border-b border-zinc-200/60 dark:border-zinc-800/80 px-4 lg:px-6 py-3 flex items-center gap-3">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"><Menu className="w-5 h-5" /></button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-sm capitalize">{page}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 hidden sm:block">
              {page === "dashboard" && "Agent, gateway and printer overview"}
              {page === "printers" && "Manage printers, discover and test"}
              {page === "jobs" && "Track print jobs and retries"}
              {page === "settings" && "Gateway, branch and agent configuration"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200/50 dark:border-zinc-700/50" title="Toggle theme">
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-zinc-200 dark:border-zinc-700">
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${isOnline ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300" : "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300"}`}>
                <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
                {isOnline ? "Online" : "Offline"}
              </span>
              <span className="text-xs font-mono px-2 py-1 bg-zinc-900 dark:bg-zinc-800 text-white rounded-lg">v{version || "…"}</span>
            </div>
          </div>
        </header>

        {(msg || healthError) && (
          <div className="mx-4 lg:mx-6 mt-4">
            {msg && (
              <div className={`flex items-start gap-3 p-3 rounded-xl border text-sm ${msg.type === "success" ? "bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200" : msg.type === "error" ? "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200" : "bg-indigo-50 dark:bg-indigo-950 border-indigo-200 dark:border-indigo-800 text-indigo-800 dark:text-indigo-200"}`}>
                {msg.type === "success" ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : msg.type === "error" ? <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />}
                <span className="flex-1">{msg.text}</span>
                <button onClick={() => setMsg(null)} className="p-1 hover:bg-black/5 rounded"><X className="w-3 h-3" /></button>
              </div>
            )}
            {healthError && !msg && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
                <AlertTriangle className="w-4 h-4" /> {healthError}
              </div>
            )}
          </div>
        )}

        <main className="flex-1 p-4 lg:p-6 max-w-7xl w-full mx-auto">
          {/* Dashboard */}
          {page === "dashboard" && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Agent" value={isOnline ? "Online" : "Offline"} subtitle={(agentStatus as any)?.note || (isTauri ? "Windows Service" : "Browser mode")} icon={isOnline ? <Activity className="w-5 h-5 text-emerald-600" /> : <WifiOff className="w-5 h-5 text-red-600" />} color={isOnline ? "bg-gradient-to-r from-emerald-500 to-teal-500" : "bg-gradient-to-r from-red-500 to-orange-500"} />
                <StatCard title="Gateway" value={health && (health as any).ok !== false ? "Reachable" : healthError ? "Unreachable" : "Unknown"} subtitle={gatewayUrl || "Not configured"} icon={<Server className="w-5 h-5 text-indigo-600" />} color="bg-gradient-to-r from-violet-600 to-indigo-600" />
                <StatCard title="Printers" value={`${onlinePrinters}/${totalPrinters}`} subtitle={`${totalPrinters} total`} icon={<Printer className="w-5 h-5 text-indigo-600" />} color="bg-gradient-to-r from-indigo-500 to-violet-500" />
                <StatCard title="Jobs" value={`${pendingJobs} pending`} subtitle={`${failedJobs} failed • ${jobs.length} total`} icon={<ClipboardList className="w-5 h-5 text-amber-600" />} color="bg-gradient-to-r from-amber-500 to-orange-500" />
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-bold text-sm flex items-center gap-2"><Printer className="w-4 h-4 text-indigo-600" /> Printers</h2>
                    <button onClick={refreshPrinters} className="text-xs px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-1.5"><RefreshCw className="w-3 h-3" /> Refresh</button>
                  </div>
                  {printersLoading ? <LoadingSkeleton /> : printers.length === 0 ? (
                    <EmptyState icon={<Inbox className="w-8 h-8" />} title="No printers" description="No printers discovered yet. Run discovery or add manually." action={<button onClick={() => navigate("printers")} className="px-4 py-2 bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white rounded-xl text-sm font-semibold">Go to Printers</button>} />
                  ) : (
                    <div className="space-y-3">
                      {printers.slice(0, 4).map((p) => (
                        <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl border border-zinc-200/60 dark:border-zinc-800 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30">
                          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-zinc-900 to-zinc-700 dark:from-zinc-800 dark:to-zinc-900 flex items-center justify-center text-white text-xs font-bold">{p.name.slice(0, 2).toUpperCase()}</div>
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm truncate">{p.name}</div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{p.connection_type || p.printer_type} • {p.spooler_name || p.network_address || p.endpoint || "—"}</div>
                          </div>
                          <Badge variant={p.status === "online" ? "success" : p.status === "offline" ? "danger" : p.status === "busy" ? "warning" : "neutral"}>{p.status}</Badge>
                        </div>
                      ))}
                      <button onClick={() => navigate("printers")} className="w-full text-xs py-2 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-center gap-1.5 text-zinc-600 dark:text-zinc-400">View all printers <ChevronRight className="w-3 h-3" /></button>
                    </div>
                  )}
                </Card>
                <Card className="p-5">
                  <h2 className="font-bold text-sm mb-4 flex items-center gap-2"><Clock className="w-4 h-4 text-zinc-500" /> Heartbeat</h2>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-zinc-500">Last heartbeat</span><span className="font-mono text-xs">{lastHeartbeat ? new Date(lastHeartbeat).toLocaleString() : "—"}</span></div>
                    <div className="flex justify-between"><span className="text-zinc-500">WS connected</span><span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${isOnline ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500"}`}>{isOnline ? "Yes" : "No"}</span></div>
                    <div className="flex justify-between"><span className="text-zinc-500">Gateway</span><span className="text-xs truncate max-w-[150px]">{gatewayUrl || "—"}</span></div>
                    <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800">
                      <div className="text-xs font-semibold mb-2">Quick actions</div>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={refreshStatus} className="px-3 py-2 rounded-xl bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white text-xs font-semibold">Refresh status</button>
                        <button onClick={checkHealth} className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-800">Check gateway</button>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-bold text-sm flex items-center gap-2"><ClipboardList className="w-4 h-4 text-amber-600" /> Recent Jobs</h2>
                  <button onClick={() => navigate("jobs")} className="text-xs px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-1">View all <ChevronRight className="w-3 h-3" /></button>
                </div>
                {jobsLoading ? <LoadingSkeleton /> : jobs.length === 0 ? (
                  <EmptyState icon={<FileText className="w-8 h-8" />} title="No jobs yet" description="Print jobs will appear here when Odoo or test prints are queued." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-zinc-500 dark:text-zinc-400">
                        <tr><th className="text-left font-semibold py-2">Job</th><th className="text-left font-semibold">Printer</th><th className="text-left font-semibold">Status</th><th className="text-left font-semibold">Updated</th></tr>
                      </thead>
                      <tbody>
                        {jobs.slice(0, 5).map((j: any) => (
                          <tr key={String(j.id || j.jobId)} className="border-t border-zinc-100 dark:border-zinc-800">
                            <td className="py-2.5 font-mono text-xs truncate max-w-[120px]">{String(j.id || j.jobId).slice(0, 12)}</td>
                            <td className="py-2.5 text-xs truncate max-w-[140px]">{String(j.printerId || j.printer_id || "—")}</td>
                            <td className="py-2.5"><Badge variant={String(j.status) === "success" || String(j.status) === "completed" ? "success" : String(j.status) === "failed" || String(j.status) === "expired" ? "danger" : String(j.status) === "printing" ? "warning" : "neutral"}>{String(j.status)}</Badge></td>
                            <td className="py-2.5 text-xs text-zinc-500">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleTimeString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* Printers Page */}
          {page === "printers" && (
            <div className="space-y-4">
              <Card className="p-4 flex flex-col sm:flex-row gap-3">
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input value={printersFilter} onChange={(e) => setPrintersFilter(e.target.value)} placeholder="Search by name, ID, spooler, IP..." className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                </div>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
                  <option value="all">All status</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                </select>
                <button onClick={handleDiscover} disabled={printersLoading} className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${printersLoading ? "animate-spin" : ""}`} /> Discover</button>
                <button onClick={refreshPrinters} className="px-4 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-800">Refresh</button>
              </Card>

              <Card className="overflow-hidden">
                {printersLoading ? (
                  <div className="p-6"><LoadingSkeleton /></div>
                ) : printersError ? (
                  <div className="p-6 flex items-center gap-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl m-4"><XCircle className="w-5 h-5" /> {printersError}</div>
                ) : filteredPrinters.length === 0 ? (
                  <EmptyState icon={<Printer className="w-8 h-8" />} title={printers.length === 0 ? "No printers found" : "No matches"} description={printers.length === 0 ? "Run discovery to find Windows spooler, USB and network printers, or add manually." : "Try a different search or filter."} action={printers.length === 0 ? <button onClick={handleDiscover} className="px-4 py-2 bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white rounded-xl text-sm font-semibold">Discover printers</button> : undefined} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50/50 dark:bg-zinc-800/30 text-xs text-zinc-500 dark:text-zinc-400">
                        <tr>
                          <th className="text-left font-semibold px-4 py-3">Printer</th>
                          <th className="text-left font-semibold px-4 py-3">Type</th>
                          <th className="text-left font-semibold px-4 py-3">Connection</th>
                          <th className="text-left font-semibold px-4 py-3">IP / Port</th>
                          <th className="text-left font-semibold px-4 py-3">Status</th>
                          <th className="text-left font-semibold px-4 py-3">Capabilities</th>
                          <th className="text-right font-semibold px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPrinters.map((p) => (
                          <tr key={p.id} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20">
                            <td className="px-4 py-3">
                              <div className="font-semibold text-sm">{p.name}</div>
                              <div className="text-xs font-mono text-zinc-500 truncate max-w-[200px]">{p.id}</div>
                              {p.display_name && p.display_name !== p.name && <div className="text-xs text-zinc-500">{p.display_name}</div>}
                            </td>
                            <td className="px-4 py-3"><Badge variant="neutral">{p.printer_type || "unknown"}</Badge></td>
                            <td className="px-4 py-3 text-xs">{p.connection_type || "—"} <span className="text-zinc-500">/ {p.protocol || "—"}</span></td>
                            <td className="px-4 py-3 text-xs font-mono">
                              {p.network_address ? `${p.network_address}:${p.port || ""}` : p.spooler_name || p.endpoint || "—"}
                              {p.port ? <span className="text-zinc-500">:{p.port}</span> : null}
                            </td>
                            <td className="px-4 py-3"><Badge variant={p.status === "online" ? "success" : p.status === "offline" ? "danger" : p.status === "busy" ? "warning" : "neutral"}>{p.status}</Badge></td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1 max-w-[180px]">
                                {p.capabilities && typeof p.capabilities === "object" ? Object.entries(p.capabilities as Record<string, unknown>).slice(0, 3).map(([k, v]) => (
                                  <span key={k} className="text-xs px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 truncate max-w-[160px]">{k}: {String(v).slice(0, 20)}</span>
                                )) : <span className="text-xs text-zinc-400">—</span>}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => handleTest(p.id)} className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200/50 dark:border-zinc-700/50" title="Test Print"><Zap className="w-4 h-4" /></button>
                                <button onClick={() => setMsg({ text: `Printer ${p.name} (${p.id}) — ${JSON.stringify(p, null, 2).slice(0, 300)}...`, type: "info" })} className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800" title="View details"><Eye className="w-4 h-4" /></button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <Card className="p-4 bg-amber-50/50 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-900/30">
                <div className="flex gap-3 text-sm">
                  <Info className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <div>
                    <div className="font-semibold text-amber-900 dark:text-amber-100">Manual registration</div>
                    <p className="text-xs text-amber-800 dark:text-amber-200/80 mt-1">If discovery misses a legacy printer, add it manually via CLI: <code className="px-1 py-0.5 bg-white dark:bg-zinc-900 rounded border text-xs">printers add --name &quot;HP LaserJet&quot; --type spooler --spooler-name &quot;HP LaserJet&quot;</code> or <code className="px-1 py-0.5 bg-white dark:bg-zinc-900 rounded border text-xs">--type network --endpoint 192.168.1.50:9100</code></p>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* Jobs Page */}
          {page === "jobs" && (
            <div className="space-y-4">
              <Card className="p-2 flex gap-1 overflow-x-auto">
                {(["all", "pending", "printing", "completed", "failed"] as JobTab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setJobTab(tab)}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold capitalize whitespace-nowrap ${jobTab === tab ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow" : "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"}`}
                  >
                    {tab} {tab !== "all" && <span className="ml-1 opacity-60">({jobs.filter((j: any) => {
                      const s = String(j.status).toLowerCase();
                      if (tab === "pending") return ["queued", "claimed"].includes(s);
                      if (tab === "printing") return s === "printing";
                      if (tab === "completed") return ["success", "completed"].includes(s);
                      if (tab === "failed") return ["failed", "expired"].includes(s);
                      return false;
                    }).length})</span>}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-2 pl-2">
                  <button onClick={refreshJobs} className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200/50 dark:border-zinc-700/50" title="Refresh"><RefreshCw className={`w-4 h-4 ${jobsLoading ? "animate-spin" : ""}`} /></button>
                </div>
              </Card>

              <Card className="overflow-hidden">
                {jobsLoading ? <div className="p-6"><LoadingSkeleton /></div> : jobsFiltered.length === 0 ? (
                  <EmptyState
                    icon={jobTab === "failed" ? <XCircle className="w-8 h-8 text-red-400" /> : jobTab === "completed" ? <CheckCircle2 className="w-8 h-8 text-emerald-500" /> : <Inbox className="w-8 h-8" />}
                    title={jobTab === "all" ? "No jobs yet" : `No ${jobTab} jobs`}
                    description={jobTab === "failed" ? "Failed jobs will appear here with error details. Check printer status and retry." : jobTab === "pending" ? "Queued jobs waiting for Agent to claim. Ensure Agent is online." : "Jobs from Gateway and Agent will be listed here."}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50/50 dark:bg-zinc-800/30 text-xs text-zinc-500 dark:text-zinc-400">
                        <tr>
                          <th className="text-left font-semibold px-4 py-3">Job</th>
                          <th className="text-left font-semibold px-4 py-3">Printer</th>
                          <th className="text-left font-semibold px-4 py-3">Status</th>
                          <th className="text-left font-semibold px-4 py-3">Updated</th>
                          <th className="text-left font-semibold px-4 py-3">Error</th>
                          <th className="text-right font-semibold px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobsFiltered.map((j: any) => {
                          const status = String(j.status);
                          const isFailed = status === "failed" || status === "expired";
                          const isSuccess = status === "success" || status === "completed";
                          return (
                            <tr key={String(j.id || j.jobId)} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20">
                              <td className="px-4 py-3">
                                <div className="font-mono text-xs font-semibold">{String(j.id || j.jobId).slice(0, 14)}</div>
                                <div className="text-xs text-zinc-500">retries: {String(j.retries ?? 0)}</div>
                              </td>
                              <td className="px-4 py-3 text-xs truncate max-w-[160px]">{String(j.printerId || j.printer_id || "—")}</td>
                              <td className="px-4 py-3"><Badge variant={isSuccess ? "success" : isFailed ? "danger" : status === "printing" ? "warning" : status === "queued" || status === "claimed" ? "info" : "neutral"}>{status}</Badge></td>
                              <td className="px-4 py-3 text-xs text-zinc-500">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : j.createdAt ? new Date(String(j.createdAt)).toLocaleString() : "—"}</td>
                              <td className="px-4 py-3 text-xs max-w-[200px] truncate" title={String(j.error || "")}>{j.error ? String(j.error).slice(0, 60) : <span className="text-zinc-400">—</span>}</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-1">
                                  <button onClick={() => setMsg({ text: JSON.stringify(j, null, 2).slice(0, 800), type: "info" })} className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Details"><Eye className="w-4 h-4" /></button>
                                  {isFailed && <button onClick={() => setMsg({ text: `Retry not yet implemented for ${String(j.id || j.jobId)} — re-queue via Gateway POST /api/print/jobs with same idempotencyKey`, type: "info" })} className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Retry"><RotateCcw className="w-4 h-4" /></button>}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <Card className="p-4 bg-zinc-50/50 dark:bg-zinc-900/50 border-dashed">
                <div className="flex items-start gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  <Clock className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div>Gateway queue: <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded border">queued → claimed (90s lease, FOR UPDATE SKIP LOCKED) → printing → success/failed/expired</code> • Agent WAL <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded border">queued → printing → success/failed</code> (INSERT OR IGNORE). Retries ≤5, then failed. Crash window may duplicate (at-least-once).</div>
                </div>
              </Card>
            </div>
          )}

          {/* Settings Page */}
          {page === "settings" && (
            <div className="space-y-6 max-w-4xl">
              <Card className="p-5">
                <h2 className="font-bold flex items-center gap-2"><Link2 className="w-4 h-4 text-indigo-600" /> Gateway Connection</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">HTTPS/WSS to Cloud Print Gateway. No inbound ports required.</p>
                <div className="mt-4 flex gap-2">
                  <input value={gatewayUrl} onChange={(e) => setGw(e.target.value)} placeholder="https://gateway.example.com" className="flex-1 px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
                  <button onClick={saveGateway} className="px-4 py-2.5 bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white rounded-xl text-sm font-semibold">Save</button>
                  <button onClick={checkHealth} disabled={busy} className="px-4 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl text-sm font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"><Activity className="w-4 h-4" /> Check</button>
                </div>
                {health && <pre className="mt-3 text-xs bg-zinc-950 text-zinc-100 p-3 rounded-xl overflow-auto max-h-32">{JSON.stringify(health, null, 2)}</pre>}
                {healthError && <div className="mt-3 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-xs flex gap-2"><XCircle className="w-4 h-4 flex-shrink-0" /> {healthError}</div>}
                {health && !(health as any).error && <div className="mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 text-xs flex gap-2"><CheckCircle2 className="w-4 h-4" /> Gateway reachable • Agents: {(health as any).agents?.online ?? "?"}/{(health as any).agents?.total ?? "?"} • Printers: {(health as any).printers?.online ?? "?"}/{(health as any).printers?.total ?? "?"}</div>}
              </Card>

              <Card className="p-5">
                <h2 className="font-bold flex items-center gap-2"><Server className="w-4 h-4 text-violet-600" /> Branch & Agent</h2>
                <div className="grid sm:grid-cols-2 gap-4 mt-4">
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/20">
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">Agent</div>
                    <div className="font-semibold text-sm mt-1">{(agentStatus as any)?.hostname || "—"}</div>
                    <div className="text-xs text-zinc-500 mt-1">{(agentStatus as any)?.note || agentStatus?.error || "—"}</div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={startAgent} disabled={busy} className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"><Play className="w-3 h-3" /> Start</button>
                      <button onClick={stopAgent} disabled={busy} className="flex-1 px-3 py-2 bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"><Square className="w-3 h-3" /> Stop</button>
                      <button onClick={restartAgent} disabled={busy} className="flex-1 px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"><RotateCcw className="w-3 h-3" /> Restart</button>
                    </div>
                  </div>
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/20">
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">Pairing</div>
                    <div className="flex gap-2 mt-2">
                      <input value={pairCode} onChange={(e) => setPairCode(e.target.value.toUpperCase())} placeholder="AB12CD" maxLength={6} className="flex-1 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm font-mono tracking-widest uppercase text-center" />
                      <button onClick={pair} disabled={busy || !pairCode} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold disabled:opacity-50">Pair</button>
                    </div>
                    <p className="text-xs text-zinc-500 mt-2">Secret stored at <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded border text-xs">C:\ProgramData\OdooPrintAgent\config.yaml</code></p>
                  </div>
                </div>
                <div className="mt-4 p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm flex items-center gap-2"><Power className="w-4 h-4 text-zinc-500" /> Auto-start at Windows login</div>
                    <div className="text-xs text-zinc-500">Launch Manager on login via Tauri autostart. Agent runs as service/background process independently.</div>
                  </div>
                  <button
                    onClick={async () => {
                      if (autostart === null) return;
                      try {
                        const res = await setAutostart(!autostart);
                        setMsg({ text: res, type: "success" });
                        const s = await getAutostart();
                        setAutostartState(s.enabled);
                      } catch (e) {
                        setMsg({ text: errMsg(e), type: "error" });
                      }
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${autostart ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${autostart ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2 text-xs text-zinc-500">
                  <span>Status:</span> <span className={`px-2 py-1 rounded-full text-xs font-semibold ${autostart ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600"}`}>{autostart === null ? "—" : autostart ? "Enabled" : "Disabled"}</span>
                  <span className="ml-auto">Changing requires no restart</span>
                </div>
              </Card>

              <Card className="p-5">
                <h2 className="font-bold flex items-center gap-2"><HardDrive className="w-4 h-4 text-zinc-500" /> Runtime & Logging</h2>
                <pre className="mt-3 text-xs bg-zinc-950 text-zinc-100 p-3 rounded-xl overflow-auto border border-zinc-800">{runtimePaths ? JSON.stringify(runtimePaths, null, 2) : "Available in installed app"}</pre>
                <div className="grid sm:grid-cols-3 gap-2 mt-3 text-xs">
                  <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/50 dark:border-zinc-700/50"><div className="font-semibold">Manager log</div><div className="font-mono text-zinc-500">…\logs\odoo-print-manager.log</div><div className="text-zinc-500 mt-1">5 MiB rotation ×3, panic hook</div></div>
                  <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/50 dark:border-zinc-700/50"><div className="font-semibold">Agent log</div><div className="font-mono text-zinc-500">…\logs\agent.log</div><div className="text-zinc-500 mt-1">Outbound only, 20s print timeout</div></div>
                  <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/20 border border-indigo-200/50 dark:border-indigo-800/30"><div className="font-semibold text-indigo-700 dark:text-indigo-300">No inbound ports</div><div className="text-xs text-zinc-600 dark:text-zinc-400">Agent polls HTTPS/WSS outbound only</div></div>
                </div>
              </Card>

              <Card className="p-5 border-dashed bg-zinc-50/50 dark:bg-zinc-900/50">
                <h3 className="font-semibold text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-600" /> Security</h3>
                <ul className="mt-2 text-xs text-zinc-600 dark:text-zinc-400 list-disc pl-5 space-y-1">
                  <li>Agent: <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded border">Bearer agt:secret</code> SHA256, timing-safe, scoped to <code>agent.id</code></li>
                  <li>Manager: <code>mgr_session</code> JWT 8h httpOnly, <code>jti</code> row, revoke on logout</li>
                  <li>Odoo: <code>odoo_xxx</code> SHA256 <code>api_keys</code>, branch-scoped, <code>allowedDocumentTypes</code></li>
                  <li>Pairing secret never in renderer — CLI writes <code>config.yaml</code> 0600, logs only <code>agentId</code></li>
                </ul>
              </Card>
            </div>
          )}
        </main>

        <footer className="px-6 py-4 border-t border-zinc-200/50 dark:border-zinc-800/50 text-xs text-zinc-500 dark:text-zinc-400 flex items-center justify-between">
          <span>Odoo Print Manager • Lightweight • Tauri 2.x + Go 1.21</span>
          <a href="https://github.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-300">Docs <ExternalLink className="w-3 h-3" /></a>
        </footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
