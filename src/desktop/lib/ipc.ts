/**
 * Typed IPC boundary between the desktop WebView and the Rust backend.
 *
 * All Tauri-specific knowledge lives in this module; the React view only calls
 * these domain-level functions and never touches `invoke`/`listen` directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tauri v2 injects __TAURI_INTERNALS__ only inside the real desktop shell. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MANAGER_TOKEN_KEY = "odoo-print-manager-session";
const MANAGER_AUTH_EVENT = "odoo-print-manager-auth-changed";
const REQUEST_TIMEOUT_MS = 10_000;

export interface AgentStatus {
  running: boolean;
  service: string;
  version: string;
  hostname: string;
  note: string;
}

export interface RuntimePaths {
  manager_data: string;
  settings: string;
  agent_config: string;
  manager_log: string;
  agent_data: string;
}

export function normalizeGatewayUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/\s/.test(value)) throw new Error("Gateway URL cannot contain whitespace");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Gateway URL is invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Gateway URL cannot include credentials, query strings, or fragments");
  }
  const scheme = parsed.protocol.toLowerCase();
  // Zero-configuration: both http and https are accepted for any valid
  // hostname or IP (LAN, public, loopback) with no environment opt-in.
  if (scheme !== "https:" && scheme !== "http:") throw new Error("Gateway URL must use http:// or https://");
  return parsed.toString().replace(/\/+$/, "");
}

function getManagerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.sessionStorage.getItem(MANAGER_TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function setManagerToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(MANAGER_TOKEN_KEY, token);
    window.dispatchEvent(new Event(MANAGER_AUTH_EVENT));
  } catch {
    throw new Error("Unable to store the manager session in this application session");
  }
}

export function clearManagerToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(MANAGER_TOKEN_KEY);
    window.dispatchEvent(new Event(MANAGER_AUTH_EVENT));
  } catch {
    // Best effort during logout / expiry recovery.
  }
}

export interface ManagerSessionStatus {
  authenticated: boolean;
  expiresAt?: string;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // Browser fetch is intentionally retained only for the Vite preview harness.
  // The packaged Tauri app uses the Rust gateway_request command so CSP can
  // remain narrow and the WebView cannot call arbitrary remote origins.
  if (isTauri) {
    throw new Error("Tauri gateway requests must use gatewayRequest");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface GatewayResponse {
  status: number;
  body: string;
}

async function gatewayRequest(
  gatewayUrl: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<GatewayResponse> {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!isTauri) {
    const response = await fetchWithTimeout(`${base}${path}`, {
      method,
      headers,
      body,
    });
    return { status: response.status, body: await response.text() };
  }
  return invoke<GatewayResponse>("gateway_request", {
    args: { path, method, headers, body: body ?? null },
  });
}

export async function loginManager(
  gatewayUrl: string,
  username: string,
  password: string,
): Promise<ManagerSessionStatus> {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!username.trim() || !password) throw new Error("Username and password are required");

  const { status, body } = await gatewayRequest(
    base,
    "/api/auth/manager/login",
    "POST",
    { "Content-Type": "application/json", "X-Odoo-Print-Desktop": "1" },
    JSON.stringify({ username: username.trim(), password }),
  );
  const data = (JSON.parse(body || "{}")) as {
    ok?: boolean;
    expiresAt?: string;
    accessToken?: string;
    error?: string;
  };
  if (status < 200 || status >= 300 || !data.ok || !data.accessToken) {
    const err: Error & { status?: number } = new Error(data.error || `Manager login failed (${status})`);
    err.status = status;
    throw err;
  }
  setManagerToken(data.accessToken);
  return { authenticated: true, expiresAt: data.expiresAt };
}

export async function getManagerSession(gatewayUrl: string): Promise<ManagerSessionStatus> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const token = getManagerToken();
  if (!token) return { authenticated: false };

  const { status, body } = await gatewayRequest(base, "/api/auth/manager/me", "GET", { Authorization: `Bearer ${token}` });
  if (status === 401 || status === 403) {
    clearManagerToken();
    return { authenticated: false };
  }
  if (status < 200 || status >= 300) throw new Error(`Manager session check failed (${status})`);
  const data = JSON.parse(body) as { authenticated?: boolean; exp?: number };
  if (!data.authenticated || typeof data.exp !== "number") {
    clearManagerToken();
    return { authenticated: false };
  }
  return { authenticated: true, expiresAt: new Date(data.exp * 1000).toISOString() };
}

export async function logoutManager(gatewayUrl: string): Promise<void> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const token = getManagerToken();
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    await gatewayRequest(base, "/api/auth/manager/logout", "POST", headers);
  } finally {
    clearManagerToken();
  }
}

export function isManagerAuthenticated(): boolean {
  return !!getManagerToken();
}

export function onManagerAuthChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MANAGER_AUTH_EVENT, handler);
  return () => window.removeEventListener(MANAGER_AUTH_EVENT, handler);
}

export function getAgentStatus(): Promise<AgentStatus> {
  return invoke<AgentStatus>("get_agent_status");
}

export function startAgent(): Promise<string> {
  return invoke<string>("start_agent");
}

export function stopAgent(): Promise<string> {
  return invoke<string>("stop_agent");
}

export function restartAgent(): Promise<string> {
  return invoke<string>("restart_agent");
}

export function pairAgent(code: string, gatewayUrl: string): Promise<string> {
  return invoke<string>("pair_agent", {
    args: { code, gateway_url: gatewayUrl },
  });
}

export async function getGatewayUrl(): Promise<string> {
  const cfg = await invoke<{ url: string }>("get_gateway_config");
  return cfg?.url ?? "";
}

export function setGatewayUrl(url: string): Promise<string> {
  return invoke<string>("set_gateway_config", { url });
}

export function getRuntimePaths(): Promise<RuntimePaths> {
  return invoke<RuntimePaths>("get_runtime_paths");
}

export function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

export async function isRunningAsAdmin(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_running_as_admin");
  } catch {
    return false;
  }
}

export interface PrinterInfo {
  id: string;
  name: string;
  display_name?: string;
  displayName?: string;
  printer_type?: string;
  printerType?: string;
  device_class?: string;
  deviceClass?: string;
  connection_type?: string;
  connectionType?: string;
  protocol?: string;
  endpoint?: string;
  spooler_name?: string;
  spoolerName?: string;
  network_address?: string;
  networkAddress?: string;
  port?: number | null;
  status: string;
  enabled: boolean;
  isVirtual?: boolean;
  is_virtual?: boolean;
  usbVid?: string;
  usbPid?: string;
  usbSerial?: string;
  capabilities?: Record<string, unknown> | null;
}

export interface DiscoverResult {
  printers: PrinterInfo[];
  errors: string[];
}

export function getPrinters(): Promise<PrinterInfo[]> {
  return invoke<PrinterInfo[]>("get_printers");
}

export function discoverPrinters(): Promise<DiscoverResult> {
  return invoke<DiscoverResult>("discover_printers");
}

export function testPrinter(printerId: string): Promise<string> {
  return invoke<string>("test_printer", { printerId });
}

export function cleanupLocalJobs(): Promise<number> {
  return invoke<number>("cleanup_local_jobs");
}

export interface RegisterPrinterRequest {
  name: string;
  connectionType: string;
  endpoint?: string;
  spoolerName?: string;
  protocol?: string;
  printerType?: string;
  usbVid?: string;
  usbPid?: string;
  usbSerial?: string;
}

export function registerPrinter(req: RegisterPrinterRequest): Promise<string> {
  return invoke<string>("register_printer", { request: req });
}

export interface AutostartStatus {
  enabled: boolean;
}

export function getAutostart(): Promise<AutostartStatus> {
  return invoke<AutostartStatus>("get_autostart");
}

export function setAutostart(enabled: boolean): Promise<string> {
  return invoke<string>("set_autostart", { enabled });
}

export async function fetchGatewayJobs(
  gatewayUrl: string
): Promise<Record<string, unknown>[]> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const token = getManagerToken();
  if (!token) {
    const err: Error & { status?: number } = new Error("Manager authentication required");
    err.status = 401;
    throw err;
  }
  const { status, body } = await gatewayRequest(base, "/api/jobs?limit=50", "GET", { Authorization: `Bearer ${token}` });
  if (status === 401 || status === 403) {
    clearManagerToken();
  }
  if (status < 200 || status >= 300) {
    const err: Error & { status?: number } = new Error(
      body || `jobs fetch failed ${status}`
    );
    err.status = status;
    throw err;
  }
  return JSON.parse(body) as Record<string, unknown>[];
}

/** Tray menu "Restart Agent" event. Returns the unlisten function. */
export function onTrayRestartAgent(handler: () => void): Promise<UnlistenFn> {
  return listen("tray:restart_agent", handler);
}

/** Tray menu navigation event ("#gateway" | "#agent" | "#pair" | "#settings"). */
export function onTrayNavigate(
  handler: (anchor: string) => void
): Promise<UnlistenFn> {
  return listen<string>("tray:navigate", (event) => handler(String(event.payload)));
}

const HEALTH_TIMEOUT_MS = 8000;

/**
 * Bounded gateway health probe. Without an explicit timeout a hung TLS
 * handshake would leave the UI "busy" forever (the browser default has no
 * upper bound for fetch).
 */
export async function fetchGatewayHealth(
  gatewayUrl: string
): Promise<Record<string, unknown>> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const { status, body } = await gatewayRequest(base, "/api/health", "GET");
  if (status < 200 || status >= 300) throw new Error(`Gateway health failed (${status})`);
  return JSON.parse(body) as Record<string, unknown>;
}
