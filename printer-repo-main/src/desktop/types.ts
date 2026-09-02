import type { AgentStatus, PrinterInfo, RuntimePaths } from "./lib/ipc";

export type Page = "dashboard" | "printers" | "jobs" | "agents" | "settings";
export type JobTab = "all" | "pending" | "printing" | "completed" | "failed";
export type PrinterStatusFilter = "all" | "online" | "offline";

export type AgentStatusView = Partial<AgentStatus> & { error?: string };
export type ToastMessage = { text: string; type: "success" | "error" | "info" } | null;
export type JobRecord = Record<string, unknown>;

/**
 * Everything the desktop pages need. The App shell owns the state and the
 * IPC effects; pages are pure presentation over this bag, which keeps the
 * five screens consistent and makes each one readable on its own.
 */
export interface DesktopState {
  /* navigation */
  page: Page;
  navigate: (p: Page) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;

  /* local agent */
  version: string;
  agentStatus: AgentStatusView | null;
  isOnline: boolean;
  lastHeartbeat: string | null;
  autostart: boolean | null;
  setAutostartState: (v: boolean) => void;
  refreshStatus: () => void;
  startAgent: () => void;
  requestStopAgent: () => void;
  restartAgent: () => void;

  /* gateway */
  gatewayUrl: string;
  setGw: (v: string) => void;
  health: Record<string, unknown> | null;
  healthError: string | null;
  gatewayConnected: boolean;
  gatewaySaving: boolean;
  checkHealth: () => void;
  saveGateway: () => void;
  pairCode: string;
  setPairCode: (v: string) => void;
  pair: () => void;

  /* printers */
  printers: PrinterInfo[];
  printersLoading: boolean;
  printersError: string | null;
  printersFilter: string;
  setPrintersFilter: (v: string) => void;
  statusFilter: PrinterStatusFilter;
  setStatusFilter: (v: PrinterStatusFilter) => void;
  filteredPrinters: PrinterInfo[];
  totalPrinters: number;
  onlinePrinters: number;
  offlinePrinters: number;
  refreshPrinters: () => void;
  handleDiscover: () => void;
  handleTest: (id: string) => void;
  showAdd: boolean;
  setShowAdd: (v: boolean) => void;
  selectedPrinter: PrinterInfo | null;
  setSelectedPrinter: (p: PrinterInfo | null) => void;

  /* jobs */
  jobs: JobRecord[];
  jobsLoading: boolean;
  jobsError: string | null;
  jobTab: JobTab;
  setJobTab: (t: JobTab) => void;
  jobSearch: string;
  setJobSearch: (v: string) => void;
  jobsFiltered: JobRecord[];
  jobCounts: Record<JobTab | "all", number>;
  pendingJobs: number;
  failedJobs: number;
  refreshJobs: () => void;
  jobPrinterFilter: string | null;
  setJobPrinterFilter: (v: string | null) => void;
  printerFilterName: string;
  selectedJob: JobRecord | null;
  setSelectedJob: (j: JobRecord | null) => void;

  /* misc */
  runtimePaths: RuntimePaths | null;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
  busy: boolean;
  msg: ToastMessage;
  setMsg: (m: ToastMessage) => void;
  fleetTotal: number;
  fleetOnline: number;
}
