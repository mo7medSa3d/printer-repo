import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import "../app/globals.css";

const DEFAULT_GATEWAY_URL = "https://your-gateway.example.com";

// Tauri v2 exposes its internals as __TAURI_INTERNALS__. In a plain browser
// dev session this is absent and the desktop-only controls are disabled.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function readPersistedGatewayUrl(): Promise<string> {
  try {
    const cfg = await invoke<{ url: string }>("get_gateway_config");
    if (cfg?.url) return cfg.url;
  } catch (e) {
    console.warn("get_gateway_config failed", e);
  }
  try {
    const store = await load("settings.json", { autoSave: true });
    const url = await store.get<string>("gateway_url");
    if (url) return url;
  } catch (e) {
    console.warn("settings store unavailable or corrupted", e);
  }
  return "";
}

async function persistGatewayUrl(url: string): Promise<void> {
  await invoke("set_gateway_config", { url });
  try {
    const store = await load("settings.json", { autoSave: true });
    await store.set("gateway_url", url);
    await store.save();
  } catch (e) {
    console.warn("could not write store fallback", e);
  }
}

function App() {
  const [gatewayUrl, setGatewayUrl] = useState(DEFAULT_GATEWAY_URL);
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [agentStatus, setAgentStatus] = useState<Record<string, unknown> | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function fetchHealth() {
    if (!gatewayUrl.trim()) {
      setHealth({ error: "Gateway URL is empty" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${gatewayUrl.replace(/\/$/, "")}/api/health`);
      setHealth(await r.json());
    } catch (e) {
      setHealth({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function invokeAgentStatus() {
    if (!isTauri) return;
    try {
      const s = await invoke("get_agent_status");
      setAgentStatus(s as Record<string, unknown>);
    } catch (e) {
      setAgentStatus({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function onPair() {
    if (!isTauri) {
      setMsg("Pairing requires the Windows desktop app (uses bundled odoo-agent-cli.exe).");
      return;
    }
    setBusy(true);
    try {
      const res = await invoke("pair_agent", {
        args: { code: pairCode, gateway_url: gatewayUrl },
      });
      setMsg(String(res));
      await startAgent();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startAgent() {
    if (!isTauri) return;
    setBusy(true);
    try {
      const res = await invoke("start_agent");
      setMsg(String(res));
      await invokeAgentStatus();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopAgent() {
    if (!isTauri) return;
    setBusy(true);
    try {
      const res = await invoke("stop_agent");
      setMsg(String(res));
      await invokeAgentStatus();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restartAgent() {
    if (!isTauri) return;
    setBusy(true);
    try {
      const res = await invoke("restart_agent");
      setMsg(String(res));
      await invokeAgentStatus();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGateway() {
    if (isTauri) {
      try {
        await persistGatewayUrl(gatewayUrl.trim().replace(/\/$/, ""));
        setMsg("Gateway URL saved on this desktop.");
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    await fetchHealth();
  }

  useEffect(() => {
    queueMicrotask(async () => {
      if (!isTauri) {
        setMsg("Running in browser mode. Desktop controls require the installed Windows app.");
        return;
      }
      const saved = await readPersistedGatewayUrl();
      if (saved) setGatewayUrl(saved);
      await invokeAgentStatus();
      try {
        const p = await invoke<[string, string, string, string]>("get_runtime_paths");
        setRuntimePaths({ managerData: p[0], settings: p[1], agentConfig: p[2], log: p[3] });
      } catch (e) {
        console.warn("runtime paths unavailable", e);
      }
    });
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <header className="border-b bg-white dark:bg-zinc-900 p-4 flex items-center justify-between">
        <h1 className="font-bold">Odoo Print Manager — Tauri (lightweight)</h1>
        <span className="text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded">v1.0.0 — Windows</span>
      </header>
      <main className="container mx-auto p-6 grid gap-6 md:grid-cols-2">
        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900">
          <h2 className="font-semibold mb-2">Gateway</h2>
          <div className="flex gap-2">
            <input
              className="w-full px-3 py-2 border rounded text-sm"
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="https://gateway.example.com"
            />
            <button onClick={saveGateway} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm whitespace-nowrap">
              Save
            </button>
          </div>
          <button onClick={fetchHealth} className="mt-2 px-3 py-1.5 bg-zinc-900 text-white rounded text-sm">
            Check Health
          </button>
          <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">
            {JSON.stringify(health, null, 2) ?? "—"}
          </pre>
          <p className="text-xs text-zinc-500 mt-2">
            The desktop polls <code>GET /api/health</code>. Agent ↔ Gateway uses HTTPS/WSS.
          </p>
        </section>

        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900">
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
            <button onClick={invokeAgentStatus} className="px-3 py-1.5 bg-zinc-900 text-white rounded text-sm">
              Refresh Status
            </button>
          </div>
          <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">
            {JSON.stringify(agentStatus, null, 2) ?? "—"}
          </pre>
          <p className="text-xs text-zinc-500 mt-2">
            Tauri never opens printer TCP directly. Printing is handled by the local Go agent.
          </p>
        </section>

        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900 md:col-span-2">
          <h2 className="font-semibold mb-2">Pair Agent</h2>
          <div className="flex flex-wrap gap-2">
            <input
              className="flex-1 px-3 py-2 border rounded text-sm"
              placeholder="6-char code (e.g. AB12CD)"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value.toUpperCase())}
            />
            <button onClick={onPair} disabled={busy || !pairCode} className="px-4 py-2 bg-green-600 text-white rounded text-sm disabled:opacity-50">
              Pair via bundled CLI
            </button>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            The agent secret is written by the CLI to <code>C:\ProgramData\OdooPrintAgent\config.yaml</code> and is never returned to the UI.
          </p>
          {msg && <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">{msg}</pre>}
        </section>

        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900 md:col-span-2">
          <h2 className="font-semibold mb-2">Runtime Paths</h2>
          <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">
            {JSON.stringify(runtimePaths, null, 2) ?? "Available in the installed desktop app"}
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
