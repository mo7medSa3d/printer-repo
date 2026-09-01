/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import appIconRaw from "../../src-tauri/icons/icon.png";
const appIcon = appIconRaw as unknown as string;
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
  Network,
  Cpu,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import {
  Button,
  IconButton,
  Drawer,
  Modal,
  Field,
  Input,
  Select,
  StatusBadge,
  StatusDot,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  Tabs,
  Toast,
  CopyButton,
  MetaRow,
  Mono,
  type Tone,
} from "@/components/ui";
import {
  fetchGatewayHealth,
  fetchGatewayJobs,
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
  return raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
}

type AgentStatusView = Partial<AgentStatus> & { error?: string };
type Page = "dashboard" | "printers" | "jobs" | "agents" | "settings";
type JobTab = "all" | "pending" | "printing" | "completed" | "failed";

function useHashPage(defaultPage: Page): [Page, (p: Page) => void] {
  const getHash = (): Page => {
    const h = window.location.hash.replace("#", "") as Page;
    if (["dashboard", "printers", "jobs", "agents", "settings"].includes(h)) return h;
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

/* ---------- Status vocabulary (single source, icon + color + label) ---------- */

function printerTone(status: string): Tone {
  switch (status) {
    case "online": return "ok";
    case "busy": return "warn";
    case "error":
    case "offline": return "bad";
    default: return "neutral";
  }
}
function jobTone(status: string): Tone {
  switch (status) {
    case "success":
    case "completed": return "ok";
    case "failed":
    case "expired": return "bad";
    case "printing": return "warn";
    case "claimed": return "info";
    case "queued": return "neutral";
    default: return "neutral";
  }
}
function labelPrinter(status: string): string {
  return status === "unknown" ? "Unknown" : status.charAt(0).toUpperCase() + status.slice(1);
}
function labelJob(status: string): string {
  if (status === "success" || status === "completed") return "Completed";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function JobTimeline({ status }: { status: string }) {
  const s = String(status).toLowerCase();
  const flow = ["queued", "claimed", "printing"] as const;
  const done = s === "success" || s === "completed";
  const failed = s === "failed" || s === "expired";
  const idx = flow.indexOf(s as any);
  const terminalLabel = done ? "Completed" : failed ? "Failed" : "Outcome";
  const steps = flow.map((step, i) => {
    const current = idx === i;
    const isReached = done || failed || idx > i;
    return { label: step, state: current && !done && !failed ? "current" : isReached ? "done" : "todo" } as { label: string; state: string };
  });
  return (
    <div className="rounded-xl border border-edge bg-surface-2/50 px-4 py-3.5" role="img" aria-label={`Job pipeline: ${labelJob(status)}`}>
      <ol className="flex items-start">
        {steps.map((step, i) => (
          <li key={step.label} className={`flex items-start flex-1 ${i === 0 ? "" : ""}`}>
            {i > 0 && (
              <span aria-hidden className={`mt-2 h-px flex-1 ${idx >= i || done || failed ? "bg-ok/50" : "bg-edge-strong"}`} />
            )}
            <span className="flex flex-col items-center gap-1.5 px-0.5" aria-hidden>
              <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[8px] font-bold transition-colors ${
                step.state === "current" ? "border-brand-500 bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-200 ring-2 ring-brand-500/25"
                : step.state === "done" ? "border-ok-edge bg-ok text-surface"
                : "border-edge-strong bg-surface text-ink-3"
              }`}>
                {step.state === "done" ? "✓" : step.state === "current" ? "●" : ""}
              </span>
              <span className={`w-full min-w-max text-center text-[10px] font-semibold capitalize ${step.state === "current" ? "text-ink" : step.state === "done" ? "text-ok" : "text-ink-3"}`}>
                {step.label}
              </span>
            </span>
          </li>
        ))}
        <li className="flex items-start flex-1">
          <span aria-hidden className={`mt-2 h-px flex-1 ${done || failed ? "bg-ok/50" : "bg-edge-strong"}`} />
          <span className="flex flex-col items-center gap-1.5 px-0.5" aria-hidden>
            <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[8px] font-bold transition-colors ${
              done ? "border-ok-edge bg-ok text-surface" : failed ? "border-bad-edge bg-bad text-surface" : "border-edge-strong bg-surface text-ink-3"
            }`}>
              {done ? "✓" : failed ? "✕" : ""}
            </span>
            <span className={`w-full min-w-max text-center text-[10px] font-semibold ${done ? "text-ok" : failed ? "text-bad" : "text-ink-3"}`}>
              {terminalLabel}
            </span>
          </span>
        </li>
      </ol>
    </div>
  );
}

function humanType(p: PrinterInfo): string {
  const isVirtual = (p as any).isVirtual || (p as any).is_virtual || p.printer_type === "virtual" || (p.capabilities as any)?.virtual === true;
  if (isVirtual) return "Virtual";
  const t = (p.printer_type || "").toLowerCase();
  if (t === "thermal" || t === "label") return "Thermal";
  if (t === "laser") return "Laser";
  if (t === "inkjet") return "Inkjet";
  if ((p.connection_type || "").toLowerCase() === "usb") return "USB device";
  if (t && t !== "unknown") return t.charAt(0).toUpperCase() + t.slice(1);
  return "Printer";
}
function humanConnection(p: PrinterInfo): string {
  const c = (p.connection_type || p.printer_type || "").toLowerCase();
  const proto = (p.protocol || "").toLowerCase();
  if (c === "spooler" || proto === "spooler") return "Windows spooler";
  if (c === "usb") return "USB";
  if (c === "ipp" || c === "ipps" || proto === "ipp" || proto === "ipps") return "IPP";
  if (c === "network" || c === "tcp") return "Network (TCP)";
  if (c === "virtual") return "Virtual spooler";
  return "Printer";
}
function printerEndpoint(p: PrinterInfo): string {
  if (p.network_address) return `${p.network_address}${p.port ? `:${p.port}` : ""}`;
  if (p.endpoint) return p.endpoint;
  return p.spooler_name || "—";
}

/* ---------- Add Printer ---------- */

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
    if (conn === "spooler" && !spoolerName.trim()) return "Select or type a spooler printer name.";
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
      const req: any = { name: name.trim(), connectionType: conn };
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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add printer"
      description="Register a printer for this agent. Discovery is preferred, but manual registration works for legacy devices."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy} icon={<Plus className="h-4 w-4" />}>
            Add printer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Printer name" htmlFor="pp-name">
          <Input id="pp-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Kitchen receipt" autoFocus />
        </Field>
        <Field label="Connection type" htmlFor="pp-conn">
          <Select id="pp-conn" value={conn} onChange={e => setConn(e.target.value as any)}>
            <option value="spooler">Windows spooler</option>
            <option value="network">Network (TCP)</option>
            <option value="usb">USB</option>
            <option value="ipp">IPP</option>
          </Select>
        </Field>
        {conn === "spooler" && (
          <Field label="Spooler printer" htmlFor="pp-spooler" hint={physicalSpoolers.length === 0 ? "No physical spooler printers were discovered — run Discovery first, or type the exact Windows printer name." : undefined}>
            <Select id="pp-spooler" value={spoolerName} onChange={e => setSpoolerName(e.target.value)}>
              <option value="">Select…</option>
              {physicalSpoolers.map(p => <option key={p.id} value={p.spooler_name || p.name}>{p.name}</option>)}
              {physicalSpoolers.length === 0 && <option disabled>None discovered</option>}
            </Select>
            {physicalSpoolers.length === 0 && (
              <Input className="mt-2" value={spoolerName} onChange={e => setSpoolerName(e.target.value)} placeholder="Type Windows printer name" />
            )}
          </Field>
        )}
        {conn === "network" && (
          <div className="grid grid-cols-[1.6fr_1fr] gap-3">
            <Field label="Host" htmlFor="pp-host">
              <Input id="pp-host" value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.50" />
            </Field>
            <Field label="Port" htmlFor="pp-port">
              <Input id="pp-port" value={port} onChange={e => setPort(e.target.value)} placeholder="9100" inputMode="numeric" />
            </Field>
            <Field label="Protocol" htmlFor="pp-proto" className="col-span-2" hint="RAW sends bytes as-is; ESC/POS is the usual thermal receipt language.">
              <Select id="pp-proto" value={protocol} onChange={e => setProtocol(e.target.value)}>
                <option value="raw">RAW</option>
                <option value="escpos">ESC/POS</option>
              </Select>
            </Field>
          </div>
        )}
        {conn === "usb" && (
          <Field label="USB printer" htmlFor="pp-usb" hint="Only valid USB printers are listed — generic USB devices are hidden.">
            <Select id="pp-usb" value={usbSel} onChange={e => setUsbSel(e.target.value)}>
              <option value="">Select…</option>
              {filteredUsb.map(p => <option key={p.id} value={p.id}>{p.name} {p.usbVid ? `(${p.usbVid}:${p.usbPid})` : ""}</option>)}
              {filteredUsb.length === 0 && <option disabled>No USB printers discovered</option>}
            </Select>
          </Field>
        )}
        {conn === "ipp" && (
          <Field label="IPP endpoint" htmlFor="pp-ipp" hint="Examples: ipp://192.168.1.60/ipp/print or http://host:631/ipp/print">
            <Input id="pp-ipp" value={ippUrl} onChange={e => setIppUrl(e.target.value)} placeholder="ipp://192.168.1.60/ipp/print" />
          </Field>
        )}
        {error && <ErrorState title="Cannot add printer" message={error} />}
      </div>
    </Modal>
  );
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
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((v: boolean) => { busyRef.current = v; setBusy(v); }, []);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersFilter, setPrintersFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "virtual">("all");
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobTab, setJobTab] = useState<JobTab>("all");
  const [jobSearch, setJobSearch] = useState("");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterInfo | null>(null);
  const [selectedJob, setSelectedJob] = useState<Record<string, unknown> | null>(null);
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
      const data = await fetchGatewayJobs(gatewayUrl);
      setJobs(Array.isArray(data) ? data : []);
      setJobsError(null);
    } catch (e: any) {
      setJobs([]);
      const status = Number(e?.status ?? 0);
      setJobsError(
        status === 401 || status === 403
          ? "Gateway requires a manager session — sign in at the gateway dashboard to view jobs."
          : `Could not load jobs: ${errMsg(e)}`
      );
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
      await testPrinter(id);
      setMsg({ text: "Test print sent", type: "success" });
    } catch (e) { setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" }); } finally { setBusyBoth(false); }
  }, [setBusyBoth]);
  const saveGateway = useCallback(async () => {
    try { const n = normalizeGatewayUrl(gatewayUrl); setGatewaySaving(true); await setGatewayUrl(n); setGw(n); setMsg({ text: "Gateway saved", type: "success" }); checkHealth(); } catch (e) { setMsg({ text: errMsg(e), type: "error" }); } finally { setGatewaySaving(false); }
  }, [gatewayUrl, checkHealth]);
  const startAgent = useCallback(async () => { try { setBusyBoth(true); const m = await ipcStartAgent(); setMsg({ text: m, type: "success" }); refreshStatus(); } catch (e) { setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" }); } finally { setBusyBoth(false); } }, [refreshStatus, setBusyBoth]);
  const stopAgent = useCallback(async () => { setConfirmStop(false); try { setBusyBoth(true); const m = await ipcStopAgent(); setMsg({ text: m, type: "success" }); refreshStatus(); } catch (e) { setMsg({ text: errMsg(e), type: "error" }); } finally { setBusyBoth(false); } }, [refreshStatus, setBusyBoth]);
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
    onTrayNavigate((anchor) => { const p = anchor.replace("#", "") as Page; if (["dashboard","printers","jobs","agents","settings"].includes(p)) navigate(p); });
    onTrayRestartAgent(() => restartAgent());
  }, [navigate, restartAgent]);

  const isOnline = !!agentStatus && !(agentStatus as any).error && (agentStatus as any).running !== false;
  const gatewayConnected = !!health && (health as any).ok !== false && !healthError;
  const totalPrinters = printers.length;
  const onlinePrinters = printers.filter(p => p.status === "online").length;
  const offlinePrinters = printers.filter(p => p.status === "offline" || p.status === "error").length;
  const pendingJobs = jobs.filter((j: any) => ["queued","claimed"].includes(String(j.status))).length;
  const failedJobs = jobs.filter((j: any) => ["failed","expired"].includes(String(j.status))).length;
  const fleetAgents = (health as any)?.agents as { total?: number; online?: number } | undefined;
  const fleetTotal = Number(fleetAgents?.total ?? 0);
  const fleetOnline = Number(fleetAgents?.online ?? 0);
  const printerFilterName = printers.find(pp => pp.id === jobPrinterFilter)?.name ?? jobPrinterFilter ?? "";

  const filteredPrinters = useMemo(() => {
    let list = printers;
    if (printersFilter) {
      const q = printersFilter.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || (p.connection_type||"").toLowerCase().includes(q) || (p.printer_type||"").toLowerCase().includes(q) || printerEndpoint(p).toLowerCase().includes(q));
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
    let list = jobs;
    if (jobPrinterFilter) {
      const t = printers.find(pp => pp.id === jobPrinterFilter);
      const target = (t?.name || "").toLowerCase();
      list = list.filter((j: any) => {
        const pid = String(j.printerId ?? "");
        return pid === jobPrinterFilter || (target && (pid.toLowerCase() === target || String(j.printerName ?? "").toLowerCase() === target));
      });
    }
    if (jobTab !== "all") {
      list = list.filter((j: any) => {
        const s = String(j.status).toLowerCase();
        if (jobTab === "pending") return ["queued","claimed"].includes(s);
        if (jobTab === "printing") return s === "printing";
        if (jobTab === "completed") return ["success","completed"].includes(s);
        if (jobTab === "failed") return ["failed","expired"].includes(s);
        return true;
      });
    }
    if (jobSearch) {
      const q = jobSearch.toLowerCase();
      list = list.filter((j: any) =>
        String(j.id || j.jobId || "").toLowerCase().includes(q) ||
        String(j.documentType || j.document_type || "").toLowerCase().includes(q) ||
        String(j.printerId || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [jobs, jobTab, jobSearch, jobPrinterFilter, printers]);

  const jobCounts = useMemo(() => ({
    all: jobs.length,
    pending: pendingJobs,
    printing: jobs.filter((j: any) => String(j.status) === "printing").length,
    completed: jobs.filter((j: any) => ["success","completed"].includes(String(j.status))).length,
    failed: failedJobs,
  }), [jobs, pendingJobs, failedJobs]);

  const attentionItems: string[] = [];
  if (!isOnline) attentionItems.push("Local agent is offline");
  if (!gatewayUrl) attentionItems.push("Gateway is not configured");
  else if (!gatewayConnected) attentionItems.push("Gateway is unreachable");
  if (offlinePrinters > 0) attentionItems.push(`${offlinePrinters} printer${offlinePrinters > 1 ? "s" : ""} need${offlinePrinters === 1 ? "s" : ""} attention`);
  if (failedJobs > 0) attentionItems.push(`${failedJobs} job${failedJobs > 1 ? "s" : ""} failed`);
  const allGood = attentionItems.length === 0 && isTauri;

  const nav = [
    { id: "dashboard" as Page, label: "Overview", icon: LayoutDashboard, desc: isOnline ? "Operational" : "Check status" },
    { id: "printers" as Page, label: "Printers", icon: Printer, desc: `${totalPrinters} total` },
    { id: "jobs" as Page, label: "Print Jobs", icon: ClipboardList, desc: `${pendingJobs} pending` },
    { id: "agents" as Page, label: "Agents", icon: Cpu, desc: isOnline ? "Local online" : "Local stopped" },
    { id: "settings" as Page, label: "Settings", icon: Settings, desc: "Gateway & agent" },
  ];

  const pageMeta: Record<Page, { title: string; subtitle: string }> = {
    dashboard: { title: "Overview", subtitle: "Agent, gateway and print infrastructure at a glance" },
    printers: { title: "Printers", subtitle: "Discover, register and test the printers this agent can reach" },
    jobs: { title: "Print Jobs", subtitle: "Operational queue — queued, printing, completed and failed" },
    agents: { title: "Agents", subtitle: "This PC's print agent and the gateway fleet" },
    settings: { title: "Settings", subtitle: "Gateway connection, local agent and pairing" },
  };

  return (
    <div className="min-h-screen bg-app text-ink">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 ${collapsed ? "lg:w-16" : "lg:w-60"} bg-surface border-r border-edge flex flex-col transition-all duration-200 ease-out ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className={`h-16 flex items-center gap-2.5 border-b border-edge ${collapsed ? "lg:justify-center px-0" : "px-4"}`}>
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-edge bg-surface-2 overflow-hidden">
            {/* Tauri desktop app: next/image is not available; asset is bundled locally */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={appIcon} alt="" className="h-7 w-7 object-contain" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-sm font-bold leading-tight text-ink">Print Gateway</div>
              <div className="text-[11px] text-ink-3 leading-tight">Odoo Print Manager</div>
            </div>
          )}
          <button onClick={() => { setCollapsed(false); setSidebarOpen(false); }} className="lg:hidden ml-auto p-1.5 rounded-lg text-ink-3 hover:bg-surface-2" aria-label="Close navigation">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-0.5" aria-label="Primary">
          {nav.map(item => {
            const active = page === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { navigate(item.id); setSidebarOpen(false); }}
                aria-current={active ? "page" : undefined}
                aria-label={collapsed ? item.label : undefined}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors ${collapsed ? "lg:justify-center px-2 py-2" : "px-2.5 py-2"} ${
                  active ? "bg-brand-50 text-brand-800 dark:bg-brand-900/60 dark:text-brand-200" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                <item.icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
                {!collapsed && <span className={`text-[11px] tabular-nums ${active ? "text-brand-700/70 dark:text-brand-300/80" : "text-ink-3"}`}>{item.desc}</span>}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-edge px-2.5 py-2 space-y-2">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="hidden lg:inline-flex w-full items-center justify-center rounded-lg px-2 py-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
          <div className={`${collapsed ? "flex flex-col items-center gap-2.5" : "space-y-2.5"} px-1.5 pb-1`}>
            <div className="flex items-center gap-2 text-xs" title={collapsed ? (gatewayConnected ? "Gateway connected" : "Gateway offline") : undefined}>
              <StatusDot tone={gatewayConnected ? "ok" : "bad"} pulse={gatewayConnected} />
              {!collapsed && (
                <div className="min-w-0">
                  <div className="font-semibold text-ink-2">{gatewayConnected ? "Gateway connected" : gatewayUrl ? "Gateway offline" : "Gateway not set"}</div>
                  <div className="truncate text-[11px] text-ink-3">{gatewayUrl || "Set in Settings"}</div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs" title={collapsed ? (isOnline ? `Agent running v${version || "1.0.0"}` : "Agent stopped") : undefined}>
              <StatusDot tone={isOnline ? "ok" : "bad"} pulse={isOnline} />
              {!collapsed && (
                <div className="min-w-0">
                  <div className="font-semibold text-ink-2">{isOnline ? "Agent running" : "Agent stopped"}</div>
                  <div className="text-[11px] text-ink-3">v{version || "1.0.0"}</div>
                </div>
              )}
              {!collapsed && <span className="ml-auto text-[11px] text-ink-3" title="Last status check">{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}</span>}
            </div>
          </div>
        </div>
      </aside>
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/35 lg:hidden" style={{ backgroundColor: "var(--overlay)" }} onClick={() => setSidebarOpen(false)} aria-hidden />}

      {/* Main */}
      <div className={`flex min-h-screen min-w-0 flex-col ${collapsed ? "lg:pl-16" : "lg:pl-60"}`}>
        <header className="sticky top-0 z-20 border-b border-edge bg-surface/90 backdrop-blur px-4 lg:px-8 py-3 flex items-center gap-3">
          <button onClick={() => { setCollapsed(false); setSidebarOpen(true); }} className="lg:hidden p-2 rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-ink leading-tight">{pageMeta[page].title}</h1>
            <p className="hidden sm:block text-xs text-ink-3 truncate">{pageMeta[page].subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge tone={isOnline ? "ok" : "bad"} label={isOnline ? "Agent online" : "Agent offline"} />
            <button
              onClick={() => { refreshStatus(); refreshPrinters(); if (gatewayUrl) refreshJobs(); }}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 h-8 text-xs font-medium text-ink-2 hover:bg-surface-2 transition-colors"
              aria-label="Refresh all"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </button>
          </div>
        </header>

        <main className="flex-1 w-full mx-auto max-w-7xl px-4 lg:px-8 py-6 space-y-6">
          {page === "dashboard" && (
            <>
              {allGood ? (
                <div className="flex items-start gap-3 rounded-xl border border-ok-edge bg-ok-bg px-4 py-3.5">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-ok" aria-hidden />
                  <div>
                    <div className="text-sm font-semibold text-ok">Everything is running normally</div>
                    <p className="mt-0.5 text-xs text-ink-2">
                      {isTauri ? "The local agent is online, the gateway is reachable and no printers or jobs need attention." : "Open the desktop manager for full agent status."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-xl border border-warn-edge bg-warn-bg px-4 py-3.5">
                  <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warn" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-warn">Needs attention</div>
                    <p className="mt-0.5 text-xs text-ink-2">{attentionItems.join(" · ") || "No issues detected yet — agent/gateway data is still loading."}</p>
                  </div>
                  {!isOnline && (
                    <Button size="sm" variant="primary" onClick={startAgent} icon={<Play className="h-3.5 w-3.5" />} className="shrink-0">
                      Start agent
                    </Button>
                  )}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: "Agent", value: isOnline ? "Online" : "Offline", sub: (agentStatus as any)?.note || "Windows service", tone: (isOnline ? "ok" : "bad") as Tone, icon: <Activity className="h-4 w-4" /> },
                  { label: "Gateway", value: gatewayUrl ? (gatewayConnected ? "Connected" : "Unreachable") : "Not configured", sub: gatewayUrl ? "Reachable" : "Set URL in Settings", tone: (gatewayConnected ? "ok" : gatewayUrl ? "bad" : "neutral") as Tone, icon: <Server className="h-4 w-4" /> },
                  { label: "Printers", value: `${onlinePrinters}/${totalPrinters}`, sub: `${totalPrinters} total · ${offlinePrinters} attention`, tone: (onlinePrinters === totalPrinters && totalPrinters > 0 ? "ok" : totalPrinters === 0 ? "neutral" : "warn") as Tone, icon: <Printer className="h-4 w-4" /> },
                  { label: "Print jobs", value: `${pendingJobs} pending`, sub: `${failedJobs} failed · ${jobs.length} total`, tone: (failedJobs > 0 ? "bad" : pendingJobs > 0 ? "info" : "neutral") as Tone, icon: <ClipboardList className="h-4 w-4" /> },
                ].map(s => (
                  <Card key={s.label} className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{s.label}</span>
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-ink-2">{s.icon}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <StatusDot tone={s.tone} pulse={s.tone === "ok" && s.label !== "Print jobs"} />
                      <span className="text-xl font-bold tabular-nums text-ink">{s.value}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-ink-3">{s.sub}</p>
                  </Card>
                ))}
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2 overflow-hidden">
                  <CardHeader
                    title="Printers"
                    subtitle={`${onlinePrinters} of ${totalPrinters} online`}
                    icon={<Printer className="h-4 w-4 text-brand-600" aria-hidden />}
                    actions={<Button size="sm" variant="ghost" onClick={refreshPrinters} icon={<RefreshCw className="h-3.5 w-3.5" />}>Refresh</Button>}
                  />
                  <div className="px-5 pb-5">
                    {printersLoading ? <LoadingState rows={3} /> : printers.length === 0 ? (
                      <EmptyState
                        icon={<Printer className="h-7 w-7" />}
                        title="No printers yet"
                        description="Discover printers connected to this PC, or register one manually."
                        action={<>
                          <Button variant="primary" size="sm" onClick={handleDiscover} icon={<RefreshCw className="h-3.5 w-3.5" />}>Discover</Button>
                          <Button variant="secondary" size="sm" onClick={() => setShowAdd(true)} icon={<Plus className="h-3.5 w-3.5" />}>Add printer</Button>
                        </>}
                      />
                    ) : (
                      <div className="space-y-2">
                        {printers.slice(0, 4).map(p => (
                          <button key={p.id} onClick={() => setSelectedPrinter(p)} className="w-full flex items-center gap-3 rounded-xl border border-edge bg-surface px-3 py-2.5 text-left transition-colors hover:border-edge-strong hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
                            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-3 text-xs font-bold text-ink-2">
                              {p.name.slice(0, 2).toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-ink">{p.name} {(p as any).isVirtual && <span className="ml-1 text-[10px] font-semibold uppercase text-ink-3">Virtual</span>}</span>
                              <span className="block truncate text-xs text-ink-3">{humanType(p)} · {humanConnection(p)} · {printerEndpoint(p)}</span>
                            </span>
                            <StatusBadge tone={printerTone(p.status)} label={labelPrinter(p.status)} />
                          </button>
                        ))}
                        <button onClick={() => navigate("printers")} className="w-full py-2 text-xs font-medium text-ink-3 hover:text-ink transition-colors inline-flex items-center justify-center gap-1">
                          View all printers <ChevronRight className="h-3 w-3" aria-hidden />
                        </button>
                      </div>
                    )}
                  </div>
                </Card>

                <Card className="p-5">
                  <CardHeader title="Activity" subtitle="Local agent & gateway health" icon={<Clock className="h-4 w-4 text-ink-3" aria-hidden />} />
                  <div className="divide-y divide-edge px-5 pb-5 text-sm">
                    <MetaRow label="Last status check"><Mono>{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}</Mono></MetaRow>
                    <MetaRow label="Gateway"><span className="truncate">{gatewayUrl || "—"}</span></MetaRow>
                    <MetaRow label="Agent"><span>{isOnline ? "Running" : "Stopped"}</span></MetaRow>
                    <div className="pt-4">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Quick actions</div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button variant="primary" size="sm" onClick={refreshStatus} icon={<RefreshCw className="h-3.5 w-3.5" />}>Refresh</Button>
                        <Button variant="secondary" size="sm" onClick={checkHealth} icon={<Activity className="h-3.5 w-3.5" />}>Check gateway</Button>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

              <Card className="overflow-hidden">
                <CardHeader
                  title="Recent jobs"
                  subtitle={`${pendingJobs} pending · ${failedJobs} failed`}
                  icon={<ClipboardList className="h-4 w-4 text-brand-600" aria-hidden />}
                  actions={<Button size="sm" variant="ghost" onClick={() => navigate("jobs")}>View all <ChevronRight className="h-3.5 w-3.5" aria-hidden /></Button>}
                />
                {jobsLoading ? (
                  <div className="px-5 pb-5"><LoadingState rows={3} /></div>
                ) : jobsError ? (
                  <div className="px-5 pb-5"><ErrorState title="Jobs unavailable" message={jobsError} retry={refreshJobs} /></div>
                ) : jobs.length === 0 ? (
                  <EmptyState icon={<FileText className="h-7 w-7" />} title="No print jobs yet" description="Print jobs will appear here as soon as the agent starts printing." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-y border-edge bg-surface-2/60 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                          <th className="px-5 py-2.5">Document</th>
                          <th className="px-3 py-2.5">Printer</th>
                          <th className="px-3 py-2.5">Status</th>
                          <th className="px-5 py-2.5 text-right">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.slice(0, 5).map((j: any) => (
                          <tr key={String(j.id || j.jobId)} className="border-b border-edge last:border-0 hover:bg-surface-2/40">
                            <td className="px-5 py-2.5 text-xs font-medium text-ink">{String(j.documentType || j.document_type || "Document")}</td>
                            <td className="px-3 py-2.5 text-xs text-ink-2">{String(printers.find(p => p.id === j.printerId)?.name || j.printerId || "—")}</td>
                            <td className="px-3 py-2.5"><StatusBadge tone={jobTone(String(j.status))} label={labelJob(String(j.status))} /></td>
                            <td className="px-5 py-2.5 text-right text-xs text-ink-3">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

          {page === "printers" && (
            <div className="space-y-4">
              <Card className="p-4">
                <div className="flex flex-col sm:flex-row gap-3 items-stretch">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                    <Input value={printersFilter} onChange={e => setPrintersFilter(e.target.value)} placeholder="Search by name, type or address…" className="pl-9" aria-label="Search printers" />
                  </div>
                  <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} className="sm:w-40" aria-label="Filter by status">
                    <option value="all">All statuses</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                    <option value="virtual">Virtual</option>
                  </Select>
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => setShowAdd(true)} icon={<Plus className="h-4 w-4" />}>Add printer</Button>
                    <Button variant="secondary" onClick={handleDiscover} loading={printersLoading} icon={<RefreshCw className="h-4 w-4" />}>Discover</Button>
                    <Button variant="ghost" onClick={refreshPrinters} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>
                  </div>
                </div>
                {printersError && !printersLoading && (
                  <div className="mt-3"><ErrorState title="Could not load printers" message={printersError} retry={refreshPrinters} /></div>
                )}
              </Card>
              <Card className="overflow-hidden">
                {printersLoading ? (
                  <div className="p-6"><LoadingState rows={5} /></div>
                ) : filteredPrinters.length === 0 ? (
                  <EmptyState
                    icon={<Printer className="h-7 w-7" />}
                    title={printers.length === 0 ? "No printers connected" : "No matches"}
                    description={printers.length === 0 ? "Connect a printer to this PC, then run Discovery or add it manually." : "Try a different search term or status filter."}
                    action={printers.length === 0 ? <>
                      <Button variant="primary" size="sm" onClick={handleDiscover} icon={<RefreshCw className="h-3.5 w-3.5" />}>Discover printers</Button>
                      <Button variant="secondary" size="sm" onClick={() => setShowAdd(true)} icon={<Plus className="h-3.5 w-3.5" />}>Add printer</Button>
                    </> : undefined}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-edge bg-surface-2/60 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                          <th className="px-5 py-3">Printer</th>
                          <th className="px-3 py-3">Type</th>
                          <th className="px-3 py-3">Connection</th>
                          <th className="px-3 py-3">Status</th>
                          <th className="px-5 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPrinters.map(p => (
                          <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-surface-2/40">
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-2.5">
                                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3 text-[10px] font-bold text-ink-2">{p.name.slice(0, 2).toUpperCase()}</span>
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-ink">{p.name} {(p as any).isVirtual && <span className="ml-1 text-[10px] font-semibold uppercase text-ink-3">Virtual</span>}</div>
                                  <div className="truncate text-xs text-ink-3 font-mono">{printerEndpoint(p)}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-xs text-ink-2 whitespace-nowrap">{humanType(p)}</td>
                            <td className="px-3 py-3 text-xs text-ink-2 whitespace-nowrap">{humanConnection(p)}</td>
                            <td className="px-3 py-3"><StatusBadge tone={printerTone(p.status)} label={labelPrinter(p.status)} /></td>
                            <td className="px-5 py-3">
                              <div className="flex items-center justify-end gap-1">
                                <Button size="sm" variant="ghost" onClick={() => handleTest(p.id)} icon={<Zap className="h-3.5 w-3.5" />}>Test</Button>
                                <Button size="sm" variant="ghost" onClick={() => setSelectedPrinter(p)} icon={<Eye className="h-3.5 w-3.5" />}>Details</Button>
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
              <Card className="px-2 pt-1">
                <Tabs
                  tabs={["all", "pending", "printing", "completed", "failed"] as const}
                  active={jobTab}
                  onChange={setJobTab}
                  counts={jobCounts}
                />
                <div className="flex items-center gap-2 p-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                    <Input value={jobSearch} onChange={e => setJobSearch(e.target.value)} placeholder="Search job, document or printer…" className="pl-9" aria-label="Search jobs" />
                  </div>
                  <Button variant="ghost" onClick={refreshJobs} loading={jobsLoading} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>
                </div>
                {jobPrinterFilter && (
                  <div className="flex items-center gap-2 px-3 pb-3">
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-[11px] font-medium text-brand-800 dark:border-brand-800 dark:bg-brand-900/50 dark:text-brand-200">
                      <Printer className="h-3 w-3" aria-hidden />
                      Filtered to <Mono className="text-inherit">{printerFilterName}</Mono>
                      <button onClick={() => setJobPrinterFilter(null)} aria-label={`Clear printer filter ${printerFilterName}`} className="ml-0.5 rounded p-0.5 hover:bg-surface-2">
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  </div>
                )}
              </Card>
              <Card className="overflow-hidden">
                {jobsLoading ? (
                  <div className="p-6"><LoadingState rows={5} /></div>
                ) : jobsError ? (
                  <div className="p-6"><ErrorState title="Jobs unavailable" message={jobsError} retry={refreshJobs} /></div>
                ) : jobsFiltered.length === 0 ? (
                  <EmptyState
                    icon={jobTab === "failed" ? <XCircle className="h-7 w-7 text-bad" /> : jobTab === "completed" ? <CheckCircle2 className="h-7 w-7 text-ok" /> : <Inbox className="h-7 w-7" />}
                    title={jobPrinterFilter ? `No jobs for ${printerFilterName}` : jobTab === "all" ? "No print jobs yet" : `No ${jobTab} jobs`}
                    description={jobPrinterFilter ? "This printer has no jobs in the current view — clear the filter to see the full queue." : jobTab === "failed" ? "Failed jobs will appear here with the reason and printer." : jobTab === "pending" ? "Queued jobs waiting for the agent to claim them." : "Print jobs will appear here when printing starts."}
                    action={jobPrinterFilter ? <Button size="sm" variant="secondary" onClick={() => setJobPrinterFilter(null)} icon={<X className="h-3.5 w-3.5" />}>Clear filter</Button> : undefined}
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-edge bg-surface-2/60 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                          <th className="px-5 py-3">Document</th>
                          <th className="px-3 py-3">Printer</th>
                          <th className="px-3 py-3">Status</th>
                          <th className="px-3 py-3">Updated</th>
                          <th className="px-5 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobsFiltered.map((j: any) => (
                          <tr key={String(j.id || j.jobId)} className="border-b border-edge last:border-0 hover:bg-surface-2/40">
                            <td className="px-5 py-3">
                              <div className="font-medium text-xs text-ink">{String(j.documentType || j.document_type || "Document")}</div>
                              <div className="font-mono text-[10px] text-ink-3">{String(j.id || j.jobId)}</div>
                            </td>
                            <td className="px-3 py-3 text-xs text-ink-2 whitespace-nowrap">{String(printers.find(p => p.id === j.printerId)?.name || j.printerId || "—")}</td>
                            <td className="px-3 py-3"><StatusBadge tone={jobTone(String(j.status))} label={labelJob(String(j.status))} /></td>
                            <td className="px-3 py-3 text-xs text-ink-3 whitespace-nowrap">{j.updatedAt ? new Date(String(j.updatedAt)).toLocaleString() : "—"}</td>
                            <td className="px-5 py-3 text-right">
                              <Button size="sm" variant="ghost" onClick={() => setSelectedJob(j)} icon={<Eye className="h-3.5 w-3.5" />}>Details</Button>
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

          {page === "agents" && (
            <div className="grid gap-6 xl:grid-cols-2 max-w-5xl">
              <Card className="overflow-hidden">
                <CardHeader
                  title="This PC agent"
                  subtitle="The agent this desktop app supervises"
                  icon={<Cpu className="h-4 w-4 text-brand-600" aria-hidden />}
                  actions={<Button size="sm" variant="ghost" onClick={refreshStatus} icon={<RefreshCw className="h-3.5 w-3.5" />}>Refresh</Button>}
                />
                <div className="px-5 pb-5 space-y-4">
                  <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-2/60 px-3.5 py-3">
                    <StatusDot tone={isOnline ? "ok" : "bad"} pulse={isOnline} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ink">{isOnline ? "Agent running" : "Agent stopped"}</div>
                      <div className="truncate text-xs text-ink-3">{(agentStatus as any)?.hostname || "This PC"}</div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="primary" onClick={startAgent} icon={<Play className="h-3.5 w-3.5" />}>Start</Button>
                      <Button size="sm" variant="secondary" onClick={() => setConfirmStop(true)} icon={<Square className="h-3.5 w-3.5" />}>Stop</Button>
                      <Button size="sm" variant="ghost" onClick={restartAgent} icon={<RotateCcw className="h-3.5 w-3.5" />}>Restart</Button>
                    </div>
                  </div>
                  <div className="divide-y divide-edge text-sm">
                    <MetaRow label="Status check"><Mono>{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}</Mono></MetaRow>
                    <MetaRow label="Service"><span className="truncate">{String((agentStatus as any)?.service || "Windows service")}</span></MetaRow>
                    <MetaRow label="Version"><Mono>{String((agentStatus as any)?.version || version || "1.0.0")}</Mono></MetaRow>
                    <MetaRow label="Hostname"><Mono>{String((agentStatus as any)?.hostname || "—")}</Mono></MetaRow>
                    <MetaRow label="Printers on this PC"><span className="tabular-nums">{onlinePrinters}/{totalPrinters} online · {offlinePrinters} attention</span></MetaRow>
                  </div>
                  {(agentStatus as any)?.note && (
                    <p className="rounded-lg border border-edge bg-surface-2/60 px-3 py-2 text-xs leading-relaxed text-ink-2">{String((agentStatus as any).note)}</p>
                  )}
                  {(agentStatus as any)?.error && (
                    <ErrorState title="Agent status unavailable" message={String((agentStatus as any).error)} retry={refreshStatus} />
                  )}
                </div>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader
                  title="Gateway fleet"
                  subtitle={`Agents registered with ${gatewayUrl ? "the gateway" : "no gateway configured"}`}
                  icon={<Server className="h-4 w-4 text-brand-600" aria-hidden />}
                  actions={gatewayUrl ? <Button size="sm" variant="ghost" onClick={checkHealth} icon={<Activity className="h-3.5 w-3.5" />}>Check</Button> : undefined}
                />
                <div className="px-5 pb-5 space-y-4">
                  {!gatewayUrl ? (
                    <EmptyState
                      icon={<Server className="h-7 w-7" />}
                      title="Gateway not configured"
                      description="Set the gateway URL in Settings so this agent can register and the fleet can be reported."
                      action={<Button size="sm" variant="primary" onClick={() => navigate("settings")} icon={<Settings className="h-3.5 w-3.5" />}>Open settings</Button>}
                    />
                  ) : healthError ? (
                    <ErrorState title="Gateway check failed" message={friendlyPrinterError(healthError)} retry={checkHealth} />
                  ) : fleetTotal > 0 ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-edge bg-surface px-3.5 py-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Total agents</div>
                          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{fleetTotal}</div>
                        </div>
                        <div className="rounded-xl border border-edge bg-surface px-3.5 py-3">
                          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Online <StatusDot tone={fleetOnline > 0 ? "ok" : "bad"} /></div>
                          <div className="mt-1 flex items-baseline gap-1.5">
                            <span className="text-2xl font-bold tabular-nums text-ink">{fleetOnline}</span>
                            <span className="text-xs text-ink-3">of {fleetTotal}</span>
                          </div>
                        </div>
                      </div>
                      <p className="text-xs leading-relaxed text-ink-3">
                        Fleet counts come from the gateway health endpoint. Full per-agent management — pairing codes,
                        per-agent printers and status history — is available in the gateway dashboard with a manager session.
                      </p>
                      <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-2/60 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">{gatewayUrl}</span>
                        <CopyButton value={gatewayUrl} label="Copy" onCopied={() => setMsg({ text: "Gateway URL copied", type: "success" })} />
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      icon={<Server className="h-7 w-7" />}
                      title="Fleet report unavailable"
                      description="The gateway is reachable but did not report any agents. Sign in at the gateway dashboard to manage the fleet."
                      action={<Button size="sm" variant="secondary" onClick={checkHealth} icon={<RefreshCw className="h-3.5 w-3.5" />}>Check again</Button>}
                    />
                  )}
                </div>
              </Card>

              <Card className="xl:col-span-2 overflow-hidden">
                <CardHeader title="How agents work" subtitle="One agent per machine, many printers per agent" icon={<ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden />} />
                <div className="px-5 pb-5 grid gap-4 md:grid-cols-3 text-xs leading-relaxed text-ink-2">
                  <div className="rounded-xl border border-edge p-3.5">
                    <div className="mb-1.5 font-semibold text-ink">Pair once</div>
                    A one-time pairing code from the gateway dashboard registers this PC. The agent keeps its credentials in a protected local config.
                  </div>
                  <div className="rounded-xl border border-edge p-3.5">
                    <div className="mb-1.5 font-semibold text-ink">Print locally</div>
                    The agent claims queued jobs and sends bytes directly to the printer — RAW, ESC/POS, IPP/IPPS, USB or the Windows spooler.
                  </div>
                  <div className="rounded-xl border border-edge p-3.5">
                    <div className="mb-1.5 font-semibold text-ink">Report honestly</div>
                    Heartbeats and job status flow back to the gateway. If the gateway is unreachable the agent keeps its local queue and drains it on reconnect.
                  </div>
                </div>
              </Card>
            </div>
          )}

          {page === "settings" && (
            <div className="grid gap-6 xl:grid-cols-2 max-w-5xl">
              <Card className="overflow-hidden">
                <CardHeader title="Gateway connection" subtitle="Where the agent reports and receives jobs" icon={<Link2 className="h-4 w-4 text-brand-600" aria-hidden />} />
                <div className="px-5 pb-5 space-y-4">
                  <div className="flex items-center gap-2.5 rounded-xl border border-edge bg-surface-2/60 px-3.5 py-3">
                    <StatusDot tone={gatewayConnected ? "ok" : gatewayUrl ? "bad" : "neutral"} pulse={gatewayConnected} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ink">{gatewayConnected ? "Connected" : gatewayUrl ? "Not reachable" : "Not configured"}</div>
                      <div className="truncate text-xs text-ink-3">{gatewayUrl || "Enter the gateway URL below"}</div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={checkHealth} icon={<Activity className="h-3.5 w-3.5" />}>Check</Button>
                  </div>
                  <Field label="Gateway URL" htmlFor="gw-url" hint="Base URL of the Odoo Print Gateway, e.g. https://print.example.com">
                    <Input id="gw-url" value={gatewayUrl} onChange={e => setGw(e.target.value)} placeholder="https://gateway.example.com" />
                  </Field>
                  <div className="flex justify-end">
                    <Button variant="primary" onClick={saveGateway} loading={gatewaySaving} icon={<Link2 className="h-4 w-4" />}>Save connection</Button>
                  </div>
                  {healthError && <ErrorState title="Gateway check failed" message={friendlyPrinterError(healthError)} retry={checkHealth} />}
                </div>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader title="Local agent" subtitle="The Windows service that talks to printers on this PC" icon={<Server className="h-4 w-4 text-brand-600" aria-hidden />} />
                <div className="px-5 pb-5 space-y-4">
                  <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-2/60 px-3.5 py-3">
                    <StatusDot tone={isOnline ? "ok" : "bad"} pulse={isOnline} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ink">{isOnline ? "Agent online" : "Agent stopped"}</div>
                      <div className="truncate text-xs text-ink-3">{(agentStatus as any)?.hostname || "This PC"}</div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="primary" onClick={startAgent} icon={<Play className="h-3.5 w-3.5" />}>Start</Button>
                      <Button size="sm" variant="secondary" onClick={() => setConfirmStop(true)} icon={<Square className="h-3.5 w-3.5" />}>Stop</Button>
                      <Button size="sm" variant="ghost" onClick={restartAgent} icon={<RotateCcw className="h-3.5 w-3.5" />}>Restart</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-edge px-3.5 py-3">
                    <div className="flex items-center gap-2.5">
                      <Power className="h-4 w-4 text-ink-3" aria-hidden />
                      <div>
                        <div className="text-sm font-medium text-ink">Start with Windows</div>
                        <div className="text-xs text-ink-3">Launch the agent automatically when you sign in.</div>
                      </div>
                    </div>
                    <button
                      role="switch"
                      aria-checked={!!autostart}
                      aria-label="Start agent with Windows"
                      onClick={async () => { if (autostart === null) return; const res = await setAutostart(!autostart); setMsg({ text: res, type: "success" }); const s = await getAutostart(); setAutostartState(s.enabled); }}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${autostart ? "bg-brand-700" : "bg-surface-3"}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-surface transition-transform ${autostart ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                  </div>
                </div>
              </Card>

              <Card className="xl:col-span-2 overflow-hidden">
                <CardHeader title="Pair agent" subtitle="Connect this PC to the gateway as a print agent" icon={<KeyRound className="h-4 w-4 text-brand-600" aria-hidden />} />
                <div className="px-5 pb-5 grid gap-4 lg:grid-cols-[1fr_auto] items-end">
                  <div className="space-y-2 text-xs text-ink-2">
                    <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-800 dark:bg-brand-900 dark:text-brand-200">1</span> Save the gateway URL above.</div>
                    <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-800 dark:bg-brand-900 dark:text-brand-200">2</span> Generate a pairing code on the gateway dashboard.</div>
                    <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-800 dark:bg-brand-900 dark:text-brand-200">3</span> Enter it here — the agent registers and stays paired.</div>
                  </div>
                  <div className="flex w-full max-w-sm items-end gap-2">
                    <Field label="Pairing code" htmlFor="pair-code" className="flex-1">
                      <Input id="pair-code" value={pairCode} onChange={e => setPairCode(e.target.value.toUpperCase())} placeholder="AB12CD" maxLength={6} className="font-mono tracking-[0.3em] uppercase text-center" autoComplete="off" />
                    </Field>
                    <Button variant="primary" onClick={pair} loading={busy} icon={<ShieldCheck className="h-4 w-4" />}>Pair agent</Button>
                  </div>
                </div>
              </Card>

              <Card className="xl:col-span-2 overflow-hidden">
                <button onClick={() => setAdvancedOpen(!advancedOpen)} className="w-full flex items-center justify-between px-5 py-4 text-left" aria-expanded={advancedOpen}>
                  <span className="text-sm font-semibold text-ink">Advanced</span>
                  <ChevronRight className={`h-4 w-4 text-ink-3 transition-transform ${advancedOpen ? "rotate-90" : ""}`} aria-hidden />
                </button>
                {advancedOpen && (
                  <div className="border-t border-edge px-5 py-5 grid gap-6 lg:grid-cols-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Security</div>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">Pairing uses a one-time code; credentials are stored in the agent config with OS-level protection and never displayed here.</p>
                      <div className="mt-3 flex items-center gap-2 text-xs text-ok"><ShieldCheck className="h-4 w-4" aria-hidden /> Credentials stay on this PC</div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Data locations</div>
                      {runtimePaths ? (
                        <div className="mt-2 space-y-1.5">
                          {[
                            ["Manager data", runtimePaths.manager_data],
                            ["Settings", runtimePaths.settings],
                            ["Agent config", runtimePaths.agent_config],
                            ["Manager log", runtimePaths.manager_log],
                            ["Agent data", runtimePaths.agent_data],
                          ].map(([label, path]) => (
                            <div key={label} className="flex items-center gap-2 rounded-lg border border-edge bg-surface-2/60 px-2.5 py-1.5">
                              <span className="w-28 flex-shrink-0 text-xs font-medium text-ink-2">{label}</span>
                              <span className="flex-1 truncate font-mono text-[11px] text-ink-3">{String(path)}</span>
                              <CopyButton value={String(path)} label="Copy" onCopied={() => setMsg({ text: "Copied to clipboard", type: "success" })} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-ink-3">Loading paths…</p>
                      )}
                      <p className="mt-4 text-xs text-ink-3">Odoo Print Manager · v{version || "1.0.0"} · © 2026 Odoo Print</p>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          )}
        </main>
      </div>

      <AddPrinterDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSuccess={() => { refreshPrinters(); setMsg({ text: "Printer added", type: "success" }); }}
        spoolerPrinters={printers.filter(p => p.spooler_name)}
        usbPrinters={printers.filter(p => (p.connection_type || "").toLowerCase() === "usb" && !(p as any).isVirtual)}
      />

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop the local agent?"
        description="The agent will stop accepting print jobs until it is started again."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmStop(false)}>Cancel</Button>
            <Button variant="danger" onClick={stopAgent} icon={<Square className="h-4 w-4" />}>Stop agent</Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">In-flight jobs are drained first; the gateway keeps them queued and they can be resumed when the agent is back online.</p>
      </Modal>

      <Drawer open={!!selectedPrinter} onClose={() => setSelectedPrinter(null)} title="Printer details" description={selectedPrinter?.name}>
        {selectedPrinter && (
          <div className="space-y-5">
            <div className="flex items-center gap-2.5 rounded-xl border border-edge bg-surface-2/60 px-3.5 py-3">
              <StatusDot tone={printerTone(selectedPrinter.status)} />
              <span className="text-sm font-semibold text-ink">{labelPrinter(selectedPrinter.status)}</span>
              <span className="ml-auto text-xs text-ink-3">{humanType(selectedPrinter)}</span>
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label="Connection">{humanConnection(selectedPrinter)}</MetaRow>
              <MetaRow label="Protocol">{selectedPrinter.protocol || "—"}</MetaRow>
              <MetaRow label="Address"><Mono>{printerEndpoint(selectedPrinter)}</Mono></MetaRow>
              <MetaRow label="Stable ID"><Mono>{selectedPrinter.id}</Mono></MetaRow>
              {selectedPrinter.usbVid && <MetaRow label="USB"><Mono>{selectedPrinter.usbVid}:{selectedPrinter.usbPid} {selectedPrinter.usbSerial || ""}</Mono></MetaRow>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="primary" onClick={() => handleTest(selectedPrinter.id)} icon={<Zap className="h-4 w-4" />}>
                Test print
              </Button>
              <Button variant="secondary" onClick={() => { setJobPrinterFilter(selectedPrinter.id); setSelectedPrinter(null); navigate("jobs"); }} icon={<ClipboardList className="h-4 w-4" />}>
                View jobs
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-ink-3">A test print goes through the same job pipeline as real prints — queued, claimed by the agent, then to the printer.</p>
          </div>
        )}
      </Drawer>

      <Drawer open={!!selectedJob} onClose={() => setSelectedJob(null)} title="Job details" description={selectedJob ? String((selectedJob as any).documentType || (selectedJob as any).document_type || "Print job") : undefined}>
        {selectedJob && (
          <div className="space-y-4">
            <div className="space-y-3">
              <StatusBadge tone={jobTone(String((selectedJob as any).status))} label={labelJob(String((selectedJob as any).status))} />
              <JobTimeline status={String((selectedJob as any).status)} />
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label="Job ID"><Mono>{String((selectedJob as any).id || (selectedJob as any).jobId)}</Mono></MetaRow>
              <MetaRow label="Printer"><span className="truncate">{String(printers.find(p => p.id === (selectedJob as any).printerId)?.name || (selectedJob as any).printerId || "—")}</span></MetaRow>
              <MetaRow label="Branch"><span className="truncate">{String((selectedJob as any).branchId || "—")}</span></MetaRow>
              <MetaRow label="Retries">{String((selectedJob as any).retries ?? 0)}</MetaRow>
              <MetaRow label="Created">{ (selectedJob as any).createdAt ? new Date(String((selectedJob as any).createdAt)).toLocaleString() : "—"}</MetaRow>
              <MetaRow label="Updated">{ (selectedJob as any).updatedAt ? new Date(String((selectedJob as any).updatedAt)).toLocaleString() : "—"}</MetaRow>
            </div>
            {(selectedJob as any).error ? (
              <div className="rounded-xl border border-bad-edge bg-bad-bg p-3.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-bad"><AlertTriangle className="h-4 w-4" aria-hidden /> Print failed</div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{friendlyPrinterError(String((selectedJob as any).error))}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-ink-3">Technical details</summary>
                  <p className="mt-1.5 break-all font-mono text-[11px] text-ink-2">{String((selectedJob as any).error)}</p>
                </details>
                <p className="mt-2 text-xs text-ink-3">Retries: {String((selectedJob as any).retries ?? 0)} of 5 — the gateway re-delivers the job to the agent while retries remain.</p>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-info-edge bg-info-bg px-3.5 py-3 text-xs text-info">
                <Info className="h-4 w-4 flex-shrink-0" aria-hidden /> No error recorded for this job.
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Toast toast={msg} onDismiss={() => setMsg(null)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
