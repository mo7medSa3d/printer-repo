import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";

// Thin Tauri wrapper — reuses shared components where possible.
// Never opens printer TCP directly; all printer ops go via Gateway.

function App() {
  const [gatewayUrl, setGatewayUrl] = useState("https://your-gateway.example.com");
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [agentStatus, setAgentStatus] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState("");

  const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

  async function fetchHealth() {
    try {
      const r = await fetch(`${gatewayUrl}/api/health`);
      const j = await r.json();
      setHealth(j);
    } catch (e) {
      setHealth({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Manager auth verification harness (for docs/VERIFICATION.md W5)
  // Tests login → Set-Cookie → GET /api/agents with cookie on this WebView.
  // If WebView fetch drops httpOnly cookie, fallback to tauri-plugin-http Bearer is required.
  async function testManagerAuth(username: string, password: string) {
    const base = gatewayUrl.replace(/\/$/, "");
    try {
      const login = await fetch(`${base}/api/auth/manager/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`);
      // Direct verification: cookie should now be sent automatically
      const agents = await fetch(`${base}/api/agents`, { credentials: "include" });
      const body = await agents.text();
      if (!agents.ok) throw new Error(`GET /api/agents ${agents.status}: ${body}`);
      // Also verify via query: GET /api/jobs should succeed with same cookie
      const jobs = await fetch(`${base}/api/jobs`, { credentials: "include" });
      if (!jobs.ok) throw new Error(`GET /api/jobs ${jobs.status}: ${await jobs.text()}`);
      setMsg(`Manager auth VERIFIED via WebView fetch (cookie persisted): agents ${agents.status}, jobs ${jobs.status}. If this fails on Windows, implement tauri-plugin-http Bearer fallback (see docs/AUTH.md).`);
    } catch (e) {
      setMsg(`Manager auth FAILED via WebView fetch: ${e instanceof Error ? e.message : String(e)} — fallback required: use tauri-plugin-http with Authorization: Bearer <jwt> (store jwt via plugin-store, never renderer localStorage for secret — see docs/AUTH.md fallback).`);
    }
  }

  async function invokeAgentStatus() {
    if (!isTauri) return;
    try {
      // @ts-ignore Tauri API available only in Tauri webview
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke("get_agent_status");
      setAgentStatus(s as Record<string, unknown>);
    } catch (e) {
      setAgentStatus({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function onPair() {
    if (!isTauri) { setMsg("Pairing requires Tauri (Windows) — uses bundled odoo-agent-cli.exe"); return; }
    try {
      // @ts-ignore
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke("pair_agent", { args: { code: pairCode, gateway_url: gatewayUrl } });
      setMsg(String(res));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    // Tauri poll is external sync — allowed to setState in effect via microtask
    queueMicrotask(() => {
      void fetchHealth();
      void invokeAgentStatus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayUrl]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <header className="border-b bg-white dark:bg-zinc-900 p-4 flex items-center justify-between">
        <h1 className="font-bold">Odoo Print Manager — Tauri (lightweight)</h1>
        <span className="text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded">v1.0.0 — No Python — Agent is separate service</span>
      </header>
      <main className="container mx-auto p-6 grid gap-6 md:grid-cols-2">
        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900">
          <h2 className="font-semibold mb-2">Gateway</h2>
          <input className="w-full px-3 py-2 border rounded text-sm" value={gatewayUrl} onChange={e => setGatewayUrl(e.target.value)} placeholder="https://gateway" />
          <button onClick={fetchHealth} className="mt-2 px-3 py-1.5 bg-blue-600 text-white rounded text-sm">Check Health</button>
          <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">{JSON.stringify(health, null, 2) ?? "—"}</pre>
          <p className="text-xs text-zinc-500 mt-2">Desktop polls <code>GET /api/health</code> + <code>GET /api/agents|printers|jobs</code> with manager session (httpOnly 8h, jti). No Desktop WebSocket — only Agent ↔ Gateway is persistent.</p>
        </section>
        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900">
          <h2 className="font-semibold mb-2">Local Agent</h2>
          <button onClick={invokeAgentStatus} className="px-3 py-1.5 bg-zinc-900 text-white rounded text-sm">Get Agent Status (Tauri thin invoke)</button>
          <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">{JSON.stringify(agentStatus, null, 2) ?? "—"}</pre>
          <p className="text-xs text-zinc-500 mt-2">Tauri never opens printer TCP. Tests: Tauri → Gateway → Agent → Printer. Pairing: CLI owns secret at <code>C:\ProgramData\OdooPrintAgent\config.yaml</code>.</p>
        </section>
        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900 md:col-span-2">
          <h2 className="font-semibold mb-2">Pair Agent (Tauri collects code + URL, CLI persists secret)</h2>
          <div className="flex gap-2">
            <input className="flex-1 px-3 py-2 border rounded text-sm" placeholder="6-char code (e.g. AB12CD)" value={pairCode} onChange={e => setPairCode(e.target.value.toUpperCase())} />
            <button onClick={onPair} className="px-4 py-2 bg-green-600 text-white rounded text-sm">Pair via CLI</button>
          </div>
          <p className="text-xs text-zinc-500 mt-2">React never receives agent.secret. CLI: <code>odoo-agent-cli.exe -pair CODE -server URL -config C:\ProgramData\OdooPrintAgent\config.yaml</code> (allowlisted shell args only).</p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => testManagerAuth("admin","changeme")} className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm">Verify Manager Auth Cookie (login→/api/agents→/api/jobs)</button>
            <span className="text-xs text-zinc-500 self-center">For docs/VERIFICATION.md W5 — record VERIFIED/FAILED on Windows.</span>
          </div>
          {msg && <pre className="mt-3 text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto">{msg}</pre>}
        </section>
        <section className="p-4 border rounded-xl bg-white dark:bg-zinc-900 md:col-span-2">
          <h3 className="font-semibold">Installer & Permissions (least-privilege)</h3>
          <ul className="text-xs text-zinc-600 list-disc pl-4 mt-2 space-y-1">
            <li><code>C:\ProgramData\OdooPrintManager\</code> — installer creates with SYSTEM:F, Administrators:F; Manager writes <code>settings.json</code> via store plugin (verify <code>icacls</code> on clean VM).</li>
            <li><code>C:\ProgramData\OdooPrintAgent\</code> — SYSTEM:F, Administrators:F, Service SID F; Manager never writes there except via elevated CLI.</li>
            <li>WebView2 Evergreen Runtime: Tauri bootstrapper <code>downloadBootstrapper</code> — tested on clean Win10 1809+/Win11 VM.</li>
            <li>Agent service <code>OdooPrintAgent</code> runs independently; closing Desktop does not stop printing.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
