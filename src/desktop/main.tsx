/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Printer,
  ClipboardList,
  Settings,
  Menu,
  X,
  RefreshCw,
  Search,
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
  Info,
  Plus,
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
  registerPrinter,
  getAutostart,
  setAutostart,
  type PrinterInfo,
} from "./lib/ipc";
import "../app/globals.css";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function friendlyPrinterError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("connection refused") || lower.includes("dial tcp")) return "Could not connect to the printer.";
  if (lower.includes("timeout") || lower.includes("deadline")) return "Printer did not respond in time.";
  if (lower.includes("offline")) return "Printer is offline.";
  if (lower.includes("not found") || lower.includes("no such")) return "Printer not found.";
  if (lower.includes("access denied") || lower.includes("permission")) return "Access denied. Check Windows printer permissions.";
  return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
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
  }, []);
  const navigate = useCallback((p: Page) => {
    window.location.hash = p;
    setPage(p);
  }, []);
  return [page, navigate];
}

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: "default" | "success" | "warning" | "danger" | "info" | "neutral" }) {
  const map: Record<string, string> = {
    default: "bg-zinc-100 text-zinc-700 border-zinc-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    danger: "bg-red-50 text-red-700 border-red-200",
    info: "bg-indigo-50 text-indigo-700 border-indigo-200",
    neutral: "bg-zinc-50 text-zinc-500 border-zinc-200",
  };
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${map[variant]}`}>{children}</span>;
}
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white border border-zinc-200/70 rounded-2xl shadow-sm ${className}`}>{children}</div>;
}
function StatCard({ title, value, subtitle, icon, color }: { title: string; value: string; subtitle?: string; icon: React.ReactNode; color: string }) {
  return (
    <Card className="p-5 relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-1 ${color}`} />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold tracking-widest uppercase text-zinc-500">{title}</p>
          <p className="text-2xl font-black mt-1 text-zinc-900">{value}</p>
          {subtitle && <p className="text-xs text-zinc-500 mt-1">{subtitle}</p>}
        </div>
        <div className="w-10 h-10 rounded-xl bg-zinc-50 border border-zinc-200/50 flex items-center justify-center text-zinc-700">{icon}</div>
      </div>
    </Card>
  );
}
function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="py-16 flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-2xl bg-zinc-100 flex items-center justify-center text-zinc-400 mb-4">{icon}</div>
      <h3 className="font-bold text-sm text-zinc-900">{title}</h3>
      <p className="text-sm text-zinc-500 max-w-sm mt-1">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-zinc-100 rounded w-1/3" />
      <div className="h-24 bg-zinc-100 rounded-xl" />
      <div className="h-24 bg-zinc-100 rounded-xl" />
    </div>
  );
}
function DetailsDrawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-zinc-200 flex flex-col">
        <div className="p-5 border-b border-zinc-200 flex items-center justify-between">
          <h3 className="font-bold text-sm">{title}</h3>
          <button onClick={onClose} className="p-2 hover:bg-zinc-100 rounded-xl"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4 text-sm">{children}</div>
      </div>
    </div>
  );
}
function humanType(p: PrinterInfo): string {
  const isVirtual = (p as any).isVirtual || (p as any).is_virtual || p.printer_type === "virtual" || (p.capabilities as any)?.virtual === true;
  if (isVirtual) return "Virtual";
  const t = (p.printer_type || "").toLowerCase();
  if (t === "thermal" || t === "label") return "Physical";
  if (t === "laser" || t === "inkjet") return "Physical";
  if ((p.connection_type || "").toLowerCase() === "network") return "Network";
  if ((p.connection_type || "").toLowerCase() === "usb") return "Physical";
  if (t === "virtual") return "Virtual";
  if (t && t !== "unknown") return t.charAt(0).toUpperCase() + t.slice(1);
  return "Physical";
}
function humanConnection(p: PrinterInfo): string {
  const c = (p.connection_type || p.printer_type || "").toLowerCase();
  const proto = (p.protocol || "").toLowerCase();
  if (c === "spooler" || proto === "spooler") return "Spooler";
  if (c === "usb") return "USB";
  if (c === "ipp" || c === "ipps" || proto === "ipp" || proto === "ipps") return "IPP";
  if (c === "network" || c === "tcp") return "TCP/IP";
  if (c === "virtual") return "Spooler";
  return c ? c.toUpperCase() : "Spooler";
}
function AddPrinterDialog({ open, onClose, onSuccess, spoolerPrinters, usbPrinters }: { open: boolean; onClose: () => void; onSuccess: () => void; spoolerPrinters: PrinterInfo[]; usbPrinters: PrinterInfo[] }) {
  const [name, setName] = useState("");
  const [conn, setConn] = useState<"spooler" | "network" | "usb" | "ipp">("spooler");
  const [spoolerName, setSpoolerName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [protocol, setProtocol] = useState("raw");
  const [ippUrl, setIppUrl] = useState("");
  const [usbSel, setUsbSel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const physicalSpoolers = useMemo(() => spoolerPrinters.filter(p => !(p as any).isVirtual && p.spooler_name), [spoolerPrinters]);
  const filteredUsb = useMemo(() => usbPrinters, [usbPrinters]);
  useEffect(() => { if (open) { setError(null); } }, [open]);
  const validate = (): string | null => {
    if (!name.trim()) return "Printer name is required.";
    if (conn === "spooler" && !spoolerName.trim()) return "Select a spooler printer.";
    if (conn === "network") {
      if (!host.trim()) return "Host is required.";
      if (host.includes(" ")) return "Invalid host.";
      const p = parseInt(port, 10);
      if (isNaN(p) || p < 1 || p > 65535) return "Port must be 1–65535.";
    }
    if (conn === "ipp" && !ippUrl.trim()) return "IPP endpoint is required.";
    if (conn === "ipp" && ippUrl.trim() && !/^https?:\/\//i.test(ippUrl) && !/^ipp:\/\//i.test(ippUrl)) return "IPP URL must start with http://, https:// or ipp://";
    if (conn === "usb" && !usbSel) return "Select a USB printer.";
    return null;
  };
  const handleSubmit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setBusy(true);
    setError(null);
    try {
      let req: any = { name: name.trim(), connectionType: conn };
      if (conn === "spooler") { req.spoolerName = spoolerName.trim(); req.endpoint = spoolerName.trim(); req.protocol = "spooler"; }
      if (conn === "network") { req.endpoint = `${host.trim()}:${port.trim()}`; req.protocol = protocol; }
      if (conn === "ipp") { req.endpoint = ippUrl.trim(); req.protocol = "ipp"; }
      if (conn === "usb") {
        const sel = filteredUsb.find(p => p.id === usbSel);
        if (sel) { req.usbVid = sel.usbVid; req.usbPid = sel.usbPid; req.usbSerial = sel.usbSerial; req.spoolerName = (sel as any).spooler_name || sel.name; if (req.spoolerName) req.endpoint = req.spoolerName; }
      }
      await registerPrinter(req);
      onSuccess();
      onClose();
      setName(""); setHost(""); setPort("9100"); setSpoolerName(""); setIppUrl(""); setUsbSel("");
    } catch (e) { setError(friendlyPrinterError(errMsg(e))); } finally { setBusy(false); }
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-zinc-200">
          <h2 className="font-bold text-base">Add Printer</h2>
          <p className="text-xs text-zinc-500 mt-1">Register a printer for this agent. Discovery is preferred, but manual works for legacy devices.</p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-xs font-semibold text-zinc-700">Printer name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="HP LaserJet" className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#714B67]/20 focus:border-[#714B67]" />
          </div>
          <div>
            <label className="text-xs font-semibold text-zinc-700">Connection type</label>
            <select value={conn} onChange={e => setConn(e.target.value as any)} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm">
              <option value="spooler">Spooler (Windows)</option>
              <option value="network">Network / TCP</option>
              <option value="usb">USB</option>
              <option value="ipp">IPP</option>
            </select>
          </div>
          {conn === "spooler" && (
            <div>
              <label className="text-xs font-semibold text-zinc-700">Spooler printer</label>
              <select value={spoolerName} onChange={e => setSpoolerName(e.target.value)} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm">
                <option value="">Select…</option>
                {physicalSpoolers.map(p => <option key={p.id} value={p.spooler_name || p.name}>{p.name}</option>)}
                {physicalSpoolers.length === 0 && <option disabled>No physical spooler printers found — try Discover or enter name manually</option>}
              </select>
              {physicalSpoolers.length === 0 && <input value={spoolerName} onChange={e => setSpoolerName(e.target.value)} placeholder="Or type spooler name" className="mt-2 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm" />}
            </div>
          )}
          {conn === "network" && (
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              <div>
                <label className="text-xs font-semibold text-zinc-700">Host</label>
                <input value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.50" className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm" />
              </div>
              <div>
                <label className="text-xs font-semibold text-zinc-700">Port</label>
                <input value={port} onChange={e => setPort(e.target.value)} placeholder="9100" className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm" />
              </div>
              <div className="col-span-2">
                <label className="text-xs font-semibold text-zinc-700">Protocol</label>
                <select value={protocol} onChange={e => setProtocol(e.target.value)} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm">
                  <option value="raw">RAW</option>
                  <option value="escpos">ESC/POS</option>
                </select>
              </div>
            </div>
          )}
          {conn === "usb" && (
            <div>
              <label className="text-xs font-semibold text-zinc-700">USB printer</label>
              <select value={usbSel} onChange={e => setUsbSel(e.target.value)} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm">
                <option value="">Select…</option>
                {filteredUsb.map(p => <option key={p.id} value={p.id}>{p.name} {p.usbVid ? `(${p.usbVid}:${p.usbPid})` : ""}</option>)}
                {filteredUsb.length === 0 && <option disabled>No USB printers discovered</option>}
              </select>
              <p className="text-xs text-zinc-500 mt-1">Only valid USB printers are listed. Generic USB devices are hidden.</p>
            </div>
          )}
          {conn === "ipp" && (
            <div>
              <label className="text-xs font-semibold text-zinc-700">IPP endpoint</label>
              <input value={ippUrl} onChange={e => setIppUrl(e.target.value)} placeholder="ipp://192.168.1.60/ipp/print or http://host:631/ipp/print" className="mt-1 w-full px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm" />
            </div>
          )}
          {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex gap-2"><XCircle className="w-4 h-4 flex-shrink-0" /> {error}</div>}
        </div>
        <div className="p-6 border-t border-zinc-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-zinc-200 text-sm font-semibold hover:bg-zinc-50">Cancel</button>
          <button onClick={handleSubmit} disabled={busy} className="px-5 py-2.5 bg-[#714B67] hover:bg-[#5a3c52] text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center gap-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add Printer</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
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
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersFilter, setPrintersFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "virtual">("all");
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobTab, setJobTab] = useState<JobTab>("all");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterInfo | null>(null);
  const [selectedJob, setSelectedJob] = useState<Record<string, unknown> | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [gatewaySaving, setGatewaySaving] = useState(false);

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
      setPrintersError(friendlyPrinterError(errMsg(e)));
    } finally { setPrintersLoading(false); }
  }, []);
  const refreshJobs = useCallback(async () => {
    if (!gatewayUrl) return;
    setJobsLoading(true);
    try {
      const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/api/jobs?limit=50`, { credentials: "include" });
      if (!res.ok) throw new Error(`Gateway ${res.status}`);
      const data = await res.json();
      setJobs(Array.isArray(data) ? data : []);
    } catch {
      setJobs([]);
    } finally { setJobsLoading(false); }
  }, [gatewayUrl]);
  const checkHealth = useCallback(async () => {
    if (!gatewayUrl) { setHealthError("Gateway URL not configured"); return; }
    setHealthError(null);
    try {
      const h = await fetchGatewayHealth(gatewayUrl);
      setHealth(h as any);
      if ((h as any)?.error) setHealthError(String((h as any).error));
    } catch (e) { setHealthError(friendlyPrinterError(errMsg(e))); }
  }, [gatewayUrl]);
  const handleDiscover = useCallback(async () => {
    if (!isTauri) return;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const res = await discoverPrinters();
      setPrinters(res.printers);
      setMsg({ text: `Discovery found ${res.printers.length} printers`, type: "success" });
      if (res.errors.length) setPrintersError(res.errors.join("; ").slice(0, 300));
    } catch (e) { setPrintersError(friendlyPrinterError(errMsg(e))); } finally { setPrintersLoading(false); }
  }, []);
  const handleTest = useCallback(async (id: string) => {
    try {
      setBusyBoth(true);
      const res = await testPrinter(id);
      setMsg({ text: "Test print sent", type: "success" });
    } catch (e) { setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" }); } finally { setBusyBoth(false); }
  }, [setBusyBoth]);
  const saveGateway = useCallback(async () => {
    try { const n = normalizeGatewayUrl(gatewayUrl); setGatewaySaving(true); await setGatewayUrl(n); setGw(n); setMsg({ text: "Gateway saved", type: "success" }); checkHealth(); } catch (e) { setMsg({ text: errMsg(e), type: "error" }); } finally { setGatewaySaving(false); }
  }, [gatewayUrl, checkHealth]);
  const startAgent = useCallback(async () => { try { setBusyBoth(true); const m = await ipcStartAgent(); setMsg({ text: m, type: "success" }); refreshStatus(); } catch (e) { setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" }); } finally { setBusyBoth(false); } }, [refreshStatus, setBusyBoth]);
  const stopAgent = useCallback(async () => { try { setBusyBoth(true); const m = await ipcStopAgent(); setMsg({ text: m, type: "success" }); refreshStatus(); } catch (e) { setMsg({ text: errMsg(e), type: "error" }); } finally { setBusyBoth(false); } }, [refreshStatus, setBusyBoth]);
  const restartAgent = useCallback(async () => { try { setBusyBoth(true); const m = await ipcRestartAgent(); setMsg({ text: m, type: "success" }); refreshStatus(); } catch (e) { setMsg({ text: errMsg(e), type: "error" }); } finally { setBusyBoth(false); } }, [refreshStatus, setBusyBoth]);
  const pair = useCallback(async () => {
    if (!pairCode.trim()) { setMsg({ text: "Enter pairing code", type: "error" }); return; }
    if (!gatewayUrl) { setMsg({ text: "Set gateway URL first", type: "error" }); return; }
    try { setBusyBoth(true); const r = await pairAgent(pairCode.trim(), gatewayUrl); setMsg({ text: r || "Agent paired", type: "success" }); setPairCode(""); refreshStatus(); } catch (e) { setMsg({ text: errMsg(e), type: "error" }); } finally { setBusyBoth(false); }
  }, [pairCode, gatewayUrl, refreshStatus, setBusyBoth]);

  useEffect(() => {
    if (!isTauri) return;
    getAppVersion().then(setVersion).catch(() => {});
    getGatewayUrl().then(v => { setGw(v); if (v) fetchGatewayHealth(v).then(h => setHealth(h as any)).catch(e => setHealthError(errMsg(e))); }).catch(() => {});
    getRuntimePaths().then(setRuntimePaths).catch(() => {});
    getAutostart().then(s => setAutostartState(s.enabled)).catch(() => {});
    refreshStatus(); refreshPrinters();
    const id = setInterval(refreshStatus, 30000);
    return () => clearInterval(id);
  }, [refreshStatus, refreshPrinters]);
  useEffect(() => { if (gatewayUrl) refreshJobs(); }, [gatewayUrl, refreshJobs]);
  useEffect(() => {
    if (!isTauri) return;
    onTrayNavigate((anchor) => { const p = anchor.replace("#", "") as Page; if (["dashboard","printers","jobs","settings"].includes(p)) navigate(p); });
    onTrayRestartAgent(() => restartAgent());
  }, [navigate, restartAgent]);

  const isOnline = !!agentStatus && !(agentStatus as any).error && (agentStatus as any).running !== false;
  const totalPrinters = printers.length;
  const onlinePrinters = printers.filter(p => p.status === "online").length;
  const pendingJobs = jobs.filter((j: any) => ["queued","claimed"].includes(String(j.status))).length;
  const failedJobs = jobs.filter((j: any) => ["failed","expired"].includes(String(j.status))).length;

  const filteredPrinters = useMemo(() => {
    let list = printers;
    if (printersFilter) {
      const q = printersFilter.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || (p.connection_type||"").toLowerCase().includes(q) || (p.printer_type||"").toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      if (statusFilter === "virtual") list = list.filter(p => (p as any).isVirtual || p.printer_type === "virtual");
      else list = list.filter(p => p.status === statusFilter && !((p as any).isVirtual));
    }
    return list.sort((a,b) => {
      const aVirt = (a as any).isVirtual ? 1 : 0;
      const bVirt = (b as any).isVirtual ? 1 : 0;
      if (aVirt !== bVirt) return aVirt - bVirt;
      return a.name.localeCompare(b.name);
    });
  }, [printers, printersFilter, statusFilter]);

  const jobsFiltered = useMemo(() => {
    if (jobTab === "all") return jobs;
    return jobs.filter((j: any) => {
      const s = String(j.status).toLowerCase();
      if (jobTab === "pending") return ["queued","claimed"].includes(s);
      if (jobTab === "printing") return s === "printing";
      if (jobTab === "completed") return ["success","completed"].includes(s);
      if (jobTab === "failed") return ["failed","expired"].includes(s);
      return true;
    });
  }, [jobs, jobTab]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 flex">
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 bg-white border-r border-zinc-200 flex flex-col ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"} transition-transform`}>
        <div className="h-16 px-5 flex items-center gap-3 border-b border-zinc-200">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#714B67] to-[#8a6a7e] flex items-center justify-center text-white font-black text-sm">O</div>
          <div>
            <div className="font-black text-sm leading-none">Odoo Print</div>
            <div className="text-xs text-zinc-500">Manager • v{version || "1.0.0"}</div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {[
            { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, desc: "Overview" },
            { id: "printers", label: "Printers", icon: Printer, desc: `${totalPrinters} printers` },
            { id: "jobs", label: "Print Jobs", icon: ClipboardList, desc: `${jobs.length} jobs` },
            { id: "settings", label: "Settings", icon: Settings, desc: "Gateway & agent" },
          ].map(item => (
            <button key={item.id} onClick={() => { navigate(item.id as Page); setSidebarOpen(false); }} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${page === item.id ? "bg-zinc-900 text-white shadow" : "hover:bg-zinc-100 text-zinc-700"}`}>
              <item.icon className="w-4 h-4" />
              <span className="flex-1 text-left">{item.label}</span>
              <span className={`text-xs ${page===item.id?"text-white/60":"text-zinc-500"}`}>{item.desc}</span>
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-zinc-200">
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${isOnline?"bg-emerald-500":"bg-red-500"}`} />
            <span className="font-semibold">{isOnline?"Agent Online":"Agent Offline"}</span>
            <span className="ml-auto text-zinc-500">{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}</span>
          </div>
        </div>
      </aside>
      {sidebarOpen && <div className="fixed inset-0 bg-black/20 z-20 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      <div className="flex-1 lg:ml-64 flex flex-col min-h-screen min-w-0">
        <header className="sticky top-0 z-20 backdrop-blur-xl bg-white/80 border-b border-zinc-200 px-4 lg:px-6 py-3 flex items-center gap-3">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 rounded-lg hover:bg-zinc-100"><Menu className="w-5 h-5" /></button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-sm capitalize">{page === "jobs" ? "Print Jobs" : page}</h1>
            <p className="text-xs text-zinc-500 hidden sm:block">
              {page === "dashboard" && "Agent, gateway and printer overview"}
              {page === "printers" && "Manage printers, discover and test"}
              {page === "jobs" && "Track print jobs and retries"}
              {page === "settings" && "Gateway, branch and agent configuration"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${isOnline ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
              <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
              {isOnline ? "Online" : "Offline"}
            </span>
            <span className="hidden sm:inline-flex text-xs font-mono px-2 py-1 bg-zinc-900 text-white rounded-lg">v{version || "…"}</span>
          </div>
        </header>

        {(msg || healthError) && (
          <div className="mx-4 lg:mx-6 mt-4 space-y-2">
            {msg && (
              <div className={`flex items-start gap-3 p-3 rounded-xl border text-sm ${msg.type === "success" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : msg.type === "error" ? "bg-red-50 border-red-200 text-red-800" : "bg-indigo-50 border-indigo-200 text-indigo-800"}`}>
                {msg.type === "success" ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : msg.type === "error" ? <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />}
                <span className="flex-1">{msg.text}</span>
                <button onClick={() => setMsg(null)} className="p-1 hover:bg-black/5 rounded"><X className="w-3 h-3" /></button>
              </div>
            )}
            {healthError && !msg && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                <AlertTriangle className="w-4 h-4" /> {healthError}
              </div>
            )}
          </div>
        )}

        <main className="flex-1 p-4 lg:p-6 max-w-7xl w-full mx-auto">
          {page === "dashboard" && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Agent" value={isOnline ? "Online" : "Offline"} subtitle={(agentStatus as any)?.note || (isTauri ? "Windows Service" : "Browser mode")} icon={isOnline ? <Activity className="w-5 h-5 text-emerald-600" /> : <WifiOff className="w-5 h-5 text-red-600" />} color={isOnline ? "bg-gradient-to-r from-emerald-500 to-teal-500" : "bg-gradient-to-r from-red-500 to-orange-500"} />
                <StatCard title="Gateway" value={health && (health as any).ok !== false ? "Connected" : healthError ? "Unreachable" : "Unknown"} subtitle={gatewayUrl || "Not configured"} icon={<Server className="w-5 h-5 text-indigo-600" />} color="bg-gradient-to-r from-violet-600 to-indigo-600" />
                <StatCard title="Printers" value={`${onlinePrinters}/${totalPrinters}`} subtitle={`${totalPrinters} total`} icon={<Printer className="w-5 h-5 text-indigo-600" />} color="bg-gradient-to-r from-indigo-500 to-violet-500" />
                <StatCard title="Print Jobs" value={`${pendingJobs} pending`} subtitle={`${failedJobs} failed • ${jobs.length} total`} icon={<ClipboardList className="w-5 h-5 text-amber-600" />} color="bg-gradient-to-r from-amber-500 to-orange-500" />
              </div>
              {!isOnline && (
                <Card className="p-4 border-amber-200 bg-amber-50">
                  <div className="flex items-center justify-between">
                    <div className="flex gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-600" />
                      <div>
                        <div className="font-semibold text-sm">Agent is offline</div>
                        <p className="text-xs text-zinc-600 mt-1">Start the agent to receive print jobs. The agent runs as a Windows service in the background.</p>
                      </div>
                    </div>
                    <button onClick={startAgent} disabled={busy} className="px-4 py-2 bg-[#714B67] text-white rounded-xl text-sm font-semibold flex items-center gap-2"><Play className="w-4 h-4" /> Start Agent</button>
                  </div>
                </Card>
              )}
              <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-bold text-sm flex items-center gap-2"><Printer className="w-4 h-4 text-indigo-600" /> Printers</h2>
                    <button onClick={refreshPrinters} className="text-xs px-3 py-1.5 rounded-xl border border-zinc-200 hover:bg-zinc-50 flex items-center gap-1.5"><RefreshCw className="w-3 h-3" /> Refresh</button>
                  </div>
                  {printersLoading ? <LoadingSkeleton /> : printers.length === 0 ? (
                    <EmptyState icon={<Inbox className="w-8 h-8" />} title="No printers found" description="No physical or configured printers are currently available." action={<div className="flex gap-2"><button onClick={handleDiscover} className="px-4 py-2 bg-[#714B67] text-white rounded-xl text-sm font-semibold">Discover Printers</button><button onClick={() => setShowAdd(true)} className="px-4 py-2 border border-zinc-200 rounded-xl text-sm font-semibold">Add Printer</button></div>} />
                  ) : (
                    <div className="space-y-3">
                      {printers.slice(0, 4).map((p) => (
                        <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl border border-zinc-200 hover:bg-zinc-50/50">
                          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-zinc-900 to-zinc-700 flex items-center justify-center text-white text-xs font-bold">{p.name.slice(0, 2).toUpperCase()}</div>
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm truncate flex items-center gap-2">{p.name} {(p as any).isVirtual && <span className="text-xs px-1.5 py-0.5 rounded border bg-zinc-100 text-zinc-500">Virtual</span>}</div>
                            <div className="text-xs text-zinc-500 truncate">{humanType(p)} • {humanConnection(p)} • {p.network_address ? `${p.network_address}:${p.port}` : p.spooler_name || "—"}</div>
                          </div>
                          <Badge variant={p.status === "online" ? "success" : p.status === "offline" ? "danger" : p.status === "busy" ? "warning" : "neutral"}>{p.status === "online" ? "Online" : p.status.charAt(0).toUpperCase()+p.status.slice(1)}</Badge>
                        </div>
                      ))}
                      <button onClick={() => navigate("printers")} className="w-full text-xs py-2 rounded-xl hover:bg-zinc-50 flex items-center justify-center gap-1.5 text-zinc-600">View all printers <ChevronRight className="w-3 h-3" /></button>
                    </div>
                  )}
                </Card>
                <Card className="p-5">
                  <h2 className="font-bold text-sm mb-4 flex items-center gap-2"><Clock className="w-4 h-4 text-zinc-500" /> Activity</h2>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-zinc-500">Last heartbeat</span><span className="font-mono text-xs">{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}</span></div>
                    <div className="flex justify-between"><span className="text-zinc-500">Gateway</span><span className="text-xs truncate max-w-[150px]">{gatewayUrl || "—"}</span></div>
                    <div className="pt-3 border-t border-zinc-100">
                      <div className="text-xs font-semibold mb-2">Quick actions</div>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={refreshStatus} className="px-3 py-2 rounded-xl bg-zinc-900 text-white text-xs font-semibold">Refresh</button>
                        <button onClick={checkHealth} className="px-3 py-2 rounded-xl border border-zinc-200 text-xs font-semibold hover:bg-zinc-50">Check gateway</button>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-bold text-sm flex items-center gap-2"><ClipboardList className="w-4 h-4 text-amber-600" /> Recent Jobs</h2>
                  <button onClick={() => navigate("jobs")} className="text-xs px-3 py-1.5 rounded-xl border border-zinc-200 hover:bg-zinc-50 flex items-center gap-1">View all <ChevronRight className="w-3 h-3" /></button>
                </div>
                {jobsLoading ? <LoadingSkeleton /> : jobs.length === 0 ? (
                  <EmptyState icon={<FileText className="w-8 h-8" />} title="No jobs yet" description="Print jobs will appear here when printing starts." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-zinc-500">
                        <tr><th className="text-left font-semibold py-2">Document</th><th className="text-left font-semibold">Printer</th><th className="text-left font-semibold">Status</th><th className="text-left font-semibold">Time</th></tr>
                      </thead>
                      <tbody>
                        {jobs.slice(0, 5).map((j: any) => (
                          <tr key={String(j.id || j.jobId)} className="border-t border-zinc-100">
                            <td className="py-2.5 text-xs truncate max-w-[160px]">{String(j.documentType || j.document_type || "Document")}</td>
                            <td className="py-2.5 text-xs truncate max-w-[140px]">{String(printers.find(p => p.id === j.printerId)?.name || j.printerId || "—")}</td>
                            <td className="py-2.5"><Badge variant={String(j.status) === "success" || String(j.status) === "completed" ? "success" : String(j.status) === "failed" || String(j.status) === "expired" ? "danger" : String(j.status) === "printing" ? "warning" : "neutral"}>{String(j.status) === "success" ? "Completed" : String(j.status).charAt(0).toUpperCase()+String(j.status).slice(1)}</Badge></td>
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

          {page === "printers" && (
            <div className="space-y-4">
              <Card className="p-4 flex flex-col sm:flex-row gap-3">
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input value={printersFilter} onChange={(e) => setPrintersFilter(e.target.value)} placeholder="Search printers..." className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-zinc-200 bg-zinc-50/50 text-sm focus:outline-none focus:ring-2 focus:ring-[#714B67]/20" />
                </div>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm">
                  <option value="all">All</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                  <option value="virtual">Virtual</option>
                </select>
                <button onClick={() => setShowAdd(true)} className="px-4 py-2.5 bg-[#714B67] hover:bg-[#5a3c52] text-white rounded-xl text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" /> Add Printer</button>
                <button onClick={handleDiscover} disabled={printersLoading} className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${printersLoading ? "animate-spin" : ""}`} /> Discover</button>
                <button onClick={refreshPrinters} className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold hover:bg-zinc-50">Refresh</button>
              </Card>
              <Card className="overflow-hidden">
                {printersLoading ? (
                  <div className="p-6"><LoadingSkeleton /></div>
                ) : printersError ? (
                  <div className="p-6 flex items-center gap-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl m-4"><XCircle className="w-5 h-5" /> {printersError}</div>
                ) : filteredPrinters.length === 0 ? (
                  <EmptyState icon={<Printer className="w-8 h-8" />} title={printers.length === 0 ? "No printers found" : "No matches"} description={printers.length === 0 ? "Connect a printer or add one manually." : "Try a different search or filter."} action={printers.length === 0 ? <div className="flex gap-2"><button onClick={handleDiscover} className="px-4 py-2 bg-[#714B67] text-white rounded-xl text-sm font-semibold">Discover Printers</button><button onClick={() => setShowAdd(true)} className="px-4 py-2 border border-zinc-200 rounded-xl text-sm font-semibold">Add Printer</button></div> : undefined} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50/50 text-xs text-zinc-500">
                        <tr>
                          <th className="text-left font-semibold px-4 py-3">Name</th>
                          <th className="text-left font-semibold px-4 py-3">Type</th>
                          <th className="text-left font-semibold px-4 py-3">Connection</th>
                          <th className="text-left font-semibold px-4 py-3">Status</th>
                          <th className="text-right font-semibold px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPrinters.map((p) => (
                          <tr key={p.id} className="border-t border-zinc-100 hover:bg-zinc-50/50">
                            <td className="px-4 py-3">
                              <div className="font-semibold text-sm flex items-center gap-2">{p.name} {(p as any).isVirtual && <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 border text-zinc-500">Virtual</span>}</div>
                              <div className="text-xs text-zinc-500 truncate max-w-[220px]">{p.spooler_name || p.network_address || ""}</div>
                            </td>
                            <td className="px-4 py-3"><Badge variant={(p as any).isVirtual ? "neutral" : "default"}>{humanType(p)}</Badge></td>
                            <td className="px-4 py-3 text-xs">{humanConnection(p)}</td>
                            <td className="px-4 py-3"><Badge variant={p.status === "online" ? "success" : p.status === "offline" ? "danger" : p.status === "busy" ? "warning" : "neutral"}>{p.status === "online" ? "Online" : p.status.charAt(0).toUpperCase()+p.status.slice(1)}</Badge></td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => handleTest(p.id)} className="p-2 rounded-xl hover:bg-zinc-100 border border-zinc-200/50" title="Test"><Zap className="w-4 h-4" /></button>
                                <button onClick={() => setSelectedPrinter(p)} className="p-2 rounded-xl hover:bg-zinc-100" title="Details"><Eye className="w-4 h-4" /></button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}

          {page === "jobs" && (
            <div className="space-y-4">
              <Card className="p-2 flex gap-1 overflow-x-auto">
                {(["all", "pending", "printing", "completed", "failed"] as JobTab[]).map((tab) => (
                  <button key={tab} onClick={() => setJobTab(tab)} className={`px-4 py-2 rounded-xl text-sm font-semibold capitalize whitespace-nowrap ${jobTab === tab ? "bg-zinc-900 text-white shadow" : "hover:bg-zinc-100 text-zinc-600"}`}>
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
                  <button onClick={refreshJobs} className="p-2 rounded-xl hover:bg-zinc-100 border border-zinc-200/50" title="Refresh"><RefreshCw className={`w-4 h-4 ${jobsLoading ? "animate-spin" : ""}`} /></button>
                </div>
              </Card>
              <Card className="overflow-hidden">
                {jobsLoading ? <div className="p-6"><LoadingSkeleton /></div> : jobsFiltered.length === 0 ? (
                  <EmptyState icon={jobTab === "failed" ? <XCircle className="w-8 h-8 text-red-400" /> : jobTab === "completed" ? <CheckCircle2 className="w-8 h-8 text-emerald-500" /> : <Inbox className="w-8 h-8" />} title={jobTab === "all" ? "No print jobs yet" : `No ${jobTab} jobs`} description={jobTab === "failed" ? "Failed jobs will appear here with error details." : jobTab === "pending" ? "Queued jobs waiting for agent." : "Print jobs will appear here when printing starts."} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50/50 text-xs text-zinc-500">
                        <tr>
                          <th className="text-left font-semibold px-4 py-3">Document</th>
                          <th className="text-left font-semibold px-4 py-3">Printer</th>
                          <th className="text-left font-semibold px-4 py-3">Status</th>
                          <th className="text-left font-semibold px-4 py-3">Time</th>
                          <th className="text-right font-semibold px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobsFiltered.map((j: any) => {
                          const status = String(j.status);
                          const isFailed = status === "failed" || status === "expired";
                          const isSuccess = status === "success" || status === "completed";
                          return (
                            <tr key={String(j.id || j.jobId)} className="border-t border-zinc-100 hover:bg-zinc-50/50">
                              <td className="px-4 py-3 text-xs">{String(j.documentType || j.document_type || "Document")}</td>
                              <td className="px-4 py-3 text-xs truncate max-w-[160px]">{String(printers.find(p => p.id === j.printerId)?.name || j.printerId || "—")}</td>
                              <td className="px-4 py-3"><Badge variant={isSuccess ? "success" : isFailed ? "danger" : status === "printing" ? "warning" : "neutral"}>{isSuccess ? "Completed" : status.charAt(0).toUpperCase()+status.slice(1)}</Badge></td>
                              <td className="px-4 py-3 text-xs text-zinc-500">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-1">
                                  <button onClick={() => setSelectedJob(j)} className="p-2 rounded-xl hover:bg-zinc-100" title="Details"><Eye className="w-4 h-4" /></button>
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
            </div>
          )}

          {page === "settings" && (
            <div className="space-y-6 max-w-4xl">
              <Card className="p-5">
                <h2 className="font-bold flex items-center gap-2"><Link2 className="w-4 h-4 text-indigo-600" /> Connection</h2>
                <p className="text-xs text-zinc-500 mt-1">Gateway connection status and URL.</p>
                <div className="mt-4 p-3 rounded-xl border flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${health && (health as any).ok !== false ? "bg-emerald-500" : "bg-red-500"}`} />
                  <span className="text-sm font-semibold">{health && (health as any).ok !== false ? "Connected" : healthError ? "Not connected" : "Unknown"}</span>
                  <span className="text-xs text-zinc-500 ml-auto truncate max-w-[200px]">{gatewayUrl || "Not configured"}</span>
                </div>
                <div className="mt-4 flex gap-2">
                  <input value={gatewayUrl} onChange={(e) => setGw(e.target.value)} placeholder="https://gateway.example.com" className="flex-1 px-3.5 py-2.5 rounded-xl border border-zinc-200 bg-zinc-50/50 text-sm focus:outline-none focus:ring-2 focus:ring-[#714B67]/20" />
                  <button onClick={saveGateway} disabled={gatewaySaving} className="px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-semibold disabled:opacity-50">{gatewaySaving ? "Saving…" : "Save"}</button>
                  <button onClick={checkHealth} disabled={busy} className="px-4 py-2.5 border border-zinc-200 rounded-xl text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50 flex items-center gap-2"><Activity className="w-4 h-4" /> Check</button>
                </div>
                {healthError && <div className="mt-3 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs">{friendlyPrinterError(healthError)}</div>}
                {health && !(health as any).error && <div className="mt-3 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex gap-2"><CheckCircle2 className="w-4 h-4" /> Gateway reachable</div>}
              </Card>

              <Card className="p-5">
                <h2 className="font-bold flex items-center gap-2"><Server className="w-4 h-4 text-violet-600" /> Agent</h2>
                <div className="mt-3 p-4 rounded-xl border bg-zinc-50/50 flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-emerald-500" : "bg-red-500"}`} />
                  <div>
                    <div className="font-semibold text-sm">{isOnline ? "Online" : "Offline"}</div>
                    <div className="text-xs text-zinc-500">{(agentStatus as any)?.hostname || "—"}</div>
                  </div>
                  <div className="ml-auto flex gap-2">
                    <button onClick={startAgent} disabled={busy} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5"><Play className="w-3 h-3" /> Start</button>
                    <button onClick={stopAgent} disabled={busy} className="px-3 py-2 bg-zinc-900 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5"><Square className="w-3 h-3" /> Stop</button>
                    <button onClick={restartAgent} disabled={busy} className="px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5"><RotateCcw className="w-3 h-3" /> Restart</button>
                  </div>
                </div>
                <div className="mt-4">
                  <div className="text-xs font-semibold text-zinc-700">Agent name</div>
                  <div className="text-sm mt-1">{(agentStatus as any)?.hostname || "—"}</div>
                </div>
              </Card>

              <Card className="p-5">
                <h2 className="font-bold">Pairing</h2>
                <p className="text-xs text-zinc-500 mt-1">Connect this Manager to your Odoo Print Agent.</p>
                <div className="flex gap-2 mt-3">
                  <input value={pairCode} onChange={(e) => setPairCode(e.target.value.toUpperCase())} placeholder="AB12CD" maxLength={6} className="flex-1 px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm font-mono tracking-widest uppercase text-center" />
                  <button onClick={pair} disabled={busy || !pairCode} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold disabled:opacity-50">Pair Agent</button>
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <ShieldCheck className="w-4 h-4" /> Connection secured — credentials are stored securely and not shown here.
                </div>
              </Card>

              <Card className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm flex items-center gap-2"><Power className="w-4 h-4 text-zinc-500" /> Start with Windows</div>
                    <div className="text-xs text-zinc-500">Automatically start when you sign in.</div>
                  </div>
                  <button onClick={async () => { if (autostart===null) return; const res = await setAutostart(!autostart); setMsg({ text: res, type: "success" }); const s = await getAutostart(); setAutostartState(s.enabled); }} className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${autostart ? "bg-[#714B67]" : "bg-zinc-300"}`}>
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${autostart ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
              </Card>

              <Card className="p-5">
                <button onClick={() => setAdvancedOpen(!advancedOpen)} className="w-full flex items-center justify-between">
                  <span className="font-bold text-sm">Advanced</span>
                  <ChevronRight className={`w-4 h-4 transition ${advancedOpen ? "rotate-90" : ""}`} />
                </button>
                {advancedOpen && (
                  <div className="mt-4 space-y-4 text-xs">
                    <div>
                      <div className="font-semibold">Security information</div>
                      <p className="text-zinc-500 mt-1">Connection uses secure authentication. Credentials are stored with OS-level protection and never displayed.</p>
                    </div>
                    {runtimePaths && (
                      <div>
                        <div className="font-semibold">Data locations</div>
                        <div className="mt-2 space-y-2">
                          {[
                            ["Manager data", runtimePaths.manager_data],
                            ["Settings", runtimePaths.settings],
                            ["Agent config", runtimePaths.agent_config],
                            ["Manager log", runtimePaths.manager_log],
                            ["Agent data", runtimePaths.agent_data],
                          ].map(([label, path]) => (
                            <div key={label} className="flex items-center gap-2 p-2 rounded-xl border bg-zinc-50">
                              <span className="font-semibold min-w-[110px]">{label}</span>
                              <span className="flex-1 truncate font-mono text-zinc-600">{String(path)}</span>
                              <button onClick={async () => { await navigator.clipboard.writeText(String(path)); setMsg({ text: "Copied", type: "success" }); }} className="px-2 py-1 rounded border bg-white text-xs">Copy</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="font-semibold">About</div>
                      <p className="text-zinc-500 mt-1">Odoo Print Manager • Version {version || "1.0.0"} • © 2026 Odoo Print</p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-zinc-700">Technical information</summary>
                        <p className="text-zinc-500 mt-2">Lightweight desktop manager for the Odoo Print Agent.</p>
                      </details>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          )}
        </main>
      </div>

      <AddPrinterDialog open={showAdd} onClose={() => setShowAdd(false)} onSuccess={() => { refreshPrinters(); setMsg({ text: "Printer added", type: "success" }); }} spoolerPrinters={printers.filter(p => p.spooler_name)} usbPrinters={printers.filter(p => (p.connection_type||"").toLowerCase()==="usb" && !(p as any).isVirtual)} />

      <DetailsDrawer open={!!selectedPrinter} onClose={() => setSelectedPrinter(null)} title={selectedPrinter?.name || "Printer details"}>
        {selectedPrinter && (
          <div className="space-y-4">
            <div><div className="text-xs font-semibold text-zinc-500">Status</div><div className="mt-1"><Badge variant={selectedPrinter.status==="online"?"success":selectedPrinter.status==="offline"?"danger":"neutral"}>{selectedPrinter.status}</Badge></div></div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><div className="text-zinc-500">Type</div><div className="font-semibold">{humanType(selectedPrinter)}</div></div>
              <div><div className="text-zinc-500">Connection</div><div className="font-semibold">{humanConnection(selectedPrinter)}</div></div>
              <div><div className="text-zinc-500">Protocol</div><div className="font-semibold">{selectedPrinter.protocol || "—"}</div></div>
              <div><div className="text-zinc-500">Endpoint</div><div className="font-mono truncate">{selectedPrinter.endpoint || selectedPrinter.spooler_name || "—"}</div></div>
            </div>
            <details className="rounded-xl border p-3 bg-zinc-50">
              <summary className="font-semibold text-xs cursor-pointer">Advanced</summary>
              <div className="mt-3 space-y-2 text-xs font-mono">
                <div>Stable ID: {selectedPrinter.id}</div>
                {selectedPrinter.spooler_name && <div>Spooler: {selectedPrinter.spooler_name}</div>}
                {selectedPrinter.network_address && <div>Network: {selectedPrinter.network_address}:{selectedPrinter.port}</div>}
                {selectedPrinter.usbVid && <div>USB: {selectedPrinter.usbVid}:{selectedPrinter.usbPid} {selectedPrinter.usbSerial}</div>}
                <div>Status: {selectedPrinter.status}</div>
              </div>
            </details>
            <button onClick={() => handleTest(selectedPrinter.id)} className="w-full py-2.5 bg-[#714B67] text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2"><Zap className="w-4 h-4" /> Test Print</button>
          </div>
        )}
      </DetailsDrawer>

      <DetailsDrawer open={!!selectedJob} onClose={() => setSelectedJob(null)} title="Job details">
        {selectedJob && (
          <div className="space-y-3 text-xs">
            <div><span className="text-zinc-500">Job ID:</span> <span className="font-mono">{String((selectedJob as any).id || (selectedJob as any).jobId)}</span></div>
            <div><span className="text-zinc-500">Status:</span> <Badge variant={String((selectedJob as any).status)==="success"?"success":String((selectedJob as any).status)==="failed"?"danger":"neutral"}>{String((selectedJob as any).status)}</Badge></div>
            <div><span className="text-zinc-500">Printer:</span> {String((selectedJob as any).printerId || "—")}</div>
            <div><span className="text-zinc-500">Retries:</span> {String((selectedJob as any).retries ?? 0)}</div>
            <div><span className="text-zinc-500">Updated:</span> { (selectedJob as any).updatedAt ? new Date(String((selectedJob as any).updatedAt)).toLocaleString() : "—"}</div>
            {(selectedJob as any).error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700"><div className="font-semibold">Error</div><div className="mt-1">{friendlyPrinterError(String((selectedJob as any).error))}</div><details className="mt-2"><summary className="cursor-pointer">Technical details</summary><div className="font-mono mt-1 break-all">{String((selectedJob as any).error)}</div></details></div>}
          </div>
        )}
      </DetailsDrawer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
