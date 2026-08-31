import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
} from "./lib/ipc";
import "../app/globals.css";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type AgentStatusView = Partial<AgentStatus> & { error?: string };

function App() {
  const [version, setVersion] = useState<string>("");
  const [gatewayUrl, setGw] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatusView | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<RuntimePaths | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // Serialize actions from tray events the same way as button clicks.
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!isTauri) return;
    try {
      setAgentStatus(await getAgentStatus());
    } catch (e) {
      setAgentStatus({ error: errMsg(e) });
    }
  }, []);

  const checkHealth = useCallback(async () => {
    if (!gatewayUrl.trim()) {
      setHealth({ error: "Gateway URL is empty" });
      return;
    }
    let url: string;
    try {
      url = normalizeGatewayUrl(gatewayUrl);
    } catch (e) {
      setHealth({ error: errMsg(e) });
      return;
    }
    setBusyBoth(true);
    try {
      setHealth(await fetchGatewayHealth(url));
    } catch (e) {
      const m = errMsg(e);
      setHealth({
        error:
          m.includes("abort") || m === "The operation was aborted."
            ? `gateway did not respond within 8s (${url})`
            : m,
      });
    } finally {
      setBusyBoth(false);
    }
  }, [gatewayUrl, setBusyBoth]);

  const startAgent = useCallback(async () => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      setMsg(String(await ipcStartAgent()));
      await refreshStatus();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const stopAgent = useCallback(async () => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      setMsg(String(await ipcStopAgent()));
      await refreshStatus();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const restartAgent = useCallback(async () => {
    if (!isTauri) return;
    setBusyBoth(true);
    try {
      setMsg(String(await ipcRestartAgent()));
      await refreshStatus();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth]);

  const saveGateway = useCallback(async () => {
    let url: string;
    try {
      url = normalizeGatewayUrl(gatewayUrl);
    } catch (e) {
      setMsg(errMsg(e));
      return;
    }
    if (!isTauri) {
      await checkHealth();
      return;
    }
    try {
      await setGatewayUrl(url);
      setGw(url);
      setMsg("Gateway URL saved on this desktop.");
    } catch (e) {
      setMsg(errMsg(e));
      return;
    }
    await checkHealth();
  }, [gatewayUrl, checkHealth]);

  const pair = useCallback(async () => {
    if (!isTauri) {
      setMsg("Pairing requires the Windows desktop app (uses bundled odoo-agent-cli.exe).");
      return;
    }
    let url: string;
    try {
      url = normalizeGatewayUrl(gatewayUrl);
    } catch (e) {
      setMsg(errMsg(e));
      return;
    }
    setBusyBoth(true);
    try {
      setMsg(String(await pairAgent(pairCode, url)));
      setPairCode("");
      await startAgent();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusyBoth(false);
    }
  }, [gatewayUrl, pairCode, startAgent, setBusyBoth]);

  // Startup: restore persisted settings, wire tray events (with cleanup).
  // State updates are deferred to a microtask so React never sees a
  // synchronous setState from inside the effect (react-hooks/set-state-in-effect).
  useEffect(() => {
    let disposed = false;
    queueMicrotask(async () => {
      if (!isTauri) {
        if (!disposed) {
          setMsg("Running in browser mode. Desktop controls require the installed Windows app.");
        }
        return;
      }
      try {
        const [url, v] = await Promise.all([getGatewayUrl(), getAppVersion()]);
        if (disposed) return;
        if (url) setGw(url);
        setVersion(v);
      } catch (e) {
        console.warn("initial desktop state load failed", e);
      }
      await refreshStatus();
      try {
        const p = await getRuntimePaths();
        if (!disposed) setRuntimePaths(p);
      } catch (e) {
        console.warn("runtime paths unavailable", e);
      }
    });

    if (!isTauri) {
      return () => {
        disposed = true;
      };
    }
    const unlisteners: Array<Promise<() => void>> = [
      onTrayRestartAgent(() => {
        if (!busyRef.current) void restartAgent();
      }),
      onTrayNavigate((anchor) => {
        if (typeof anchor === "string" && anchor.startsWith("#")) {
          window.location.hash = anchor;
        }
      }),
    ];
    return () => {
      disposed = true;
      for (const u of unlisteners) void u.then((fn) => fn()).catch(() => {});
    };
  }, [refreshStatus, restartAgent]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <header className="border-b bg-white dark:bg-zinc-900 p-4 flex items-center justify-between">
        <h1 className="font-bold">Odoo Print Manager — Tauri (lightweight)</h1>
        <span className="text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded">
          v{version || "…"} — Windows
        </span>
      </header>
      <main className="container mx-auto p-6 grid gap-6 md:grid-cols-2">
        <section id="gateway" className="p-4 border rounded-xl bg-white dark:bg-zinc-900">
          <h2 className="font-semibold mb-2">Gateway</h2>
          <div className="flex gap-2">
            <input
              className="w-full px-3 py-2 border rounded text-sm"
              value={gatewayUrl}
              onChange={(e) => setGw(e.target.value)}
              placeholder="https://gateway.example.com"
            />
            <button onClick={saveGateway} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm whitespace-nowrap">
              Save
            </button>
          </div>
          <button
            onClick={checkHealth}
            disabled={busy}
            className="mt-2 px-3 py-1.5 bg-zinc-900 text-white rounded text-sm disabled:opacity-50"
          >
            Check Health
          </button>
          <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">
            {health ? JSON.stringify(health, null, 2) : "—"}
          </pre>
          <p className="text-xs text-zinc-500 mt-2">
            The desktop polls <code>GET /api/health</code>. Agent ↔ Gateway uses HTTPS/WSS.
          </p>
        </section>

        <section id="agent" className="p-4 border rounded-xl bg-white dark:bg-zinc-900">
          <h2 className="font-semibold mb-2">Local Agent</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={startAgent} disabled={busy} className="px-3 py-1.5 bg-green-600 text-white rounded text-sm disabled:opacity-50">
              Start Agent
            </button>
            <button onClick={stopAgent} disabled={busy} className="px-3 py-1.5 bg-red-600 text-white rounded text-sm disabled:opacity-50">
              Stop Agent
            </button>
            <button onClick={restartAgent} disabled={busy} className="px-3 py-1.5 bg-amber-600 text-white rounded text-sm disabled:opacity-50">
              Restart Agent
            </button>
            <button onClick={refreshStatus} className="px-3 py-1.5 bg-zinc-900 text-white rounded text-sm">
              Refresh Status
            </button>
          </div>
          <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">
            {agentStatus ? JSON.stringify(agentStatus, null, 2) : "—"}
          </pre>
          <p className="text-xs text-zinc-500 mt-2">
            Tauri never opens printer TCP directly. Printing is handled by the local Go agent.
          </p>
        </section>

        <section id="pair" className="p-4 border rounded-xl bg-white dark:bg-zinc-900 md:col-span-2">
          <h2 className="font-semibold mb-2">Pair Agent</h2>
          <div className="flex flex-wrap gap-2">
            <input
              className="flex-1 px-3 py-2 border rounded text-sm"
              placeholder="6-char code (e.g. AB12CD)"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value.toUpperCase())}
            />
            <button onClick={pair} disabled={busy || !pairCode} className="px-4 py-2 bg-green-600 text-white rounded text-sm disabled:opacity-50">
              Pair via bundled CLI
            </button>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            The agent secret is written by the CLI to <code>C:\ProgramData\OdooPrintAgent\config.yaml</code> and is never returned to the UI.
          </p>
          {msg && <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">{msg}</pre>}
        </section>

        <section id="settings" className="p-4 border rounded-xl bg-white dark:bg-zinc-900 md:col-span-2">
          <h2 className="font-semibold mb-2">Runtime Paths</h2>
          <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">
            {runtimePaths ? JSON.stringify(runtimePaths, null, 2) : "Available in the installed desktop app"}
          </pre>
          <ul className="text-xs text-zinc-600 list-disc pl-4 mt-2 space-y-1">
            <li><code>C:\ProgramData\OdooPrintManager\</code> — writable manager settings and logs.</li>
            <li><code>C:\ProgramData\OdooPrintAgent\</code> — writable agent config, SQLite queue, and logs.</li>
            <li>WebView2 Evergreen Runtime: installer uses the Tauri downloadBootstrapper mode.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
