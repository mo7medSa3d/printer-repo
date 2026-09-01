"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  Play,
  Square,
  Terminal,
  RefreshCcw,
  Wifi,
  WifiOff,
  Database,
  Printer as PrinterIcon
} from "lucide-react";

type LogEntry = {
  time: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
};

export default function AgentSimulator() {
  const [pairingCode, setPairingCode] = useState("");
  const [agentAuth, setAgentAuth] = useState<{ id: string; secret: string } | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState("idle");
  const [printers, setPrinters] = useState([
    { id: "sim_p1", name: "Simulated Kitchen Printer", type: "network", status: "online", config: { ip: "192.168.1.100", port: 9100, protocol: "raw" } },
    { id: "sim_p2", name: "Simulated USB Receipt Printer", type: "usb", status: "online", config: { vid: 0x04b8, pid: 0x0202, address: "USB001" } },
  ]);

  const addLog = useCallback((message: string, level: LogEntry["level"] = "info") => {
    setLogs(prev => [{
      time: new Date().toLocaleTimeString(),
      level,
      message
    }, ...prev.slice(0, 99)]);
  }, []);

  const handleRegister = async () => {
    if (!pairingCode) return;
    addLog(`Attempting to pair with code: ${pairingCode}...`);
    try {
      const res = await fetch("/api/agent/register", {
        method: "POST",
        body: JSON.stringify({
          pairingCode,
          metadata: {
            hostname: "simulated-agent-host",
            os: "Browser",
            version: "1.0.0-sim"
          }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setAgentAuth(data);
      localStorage.setItem("sim_agent_auth", JSON.stringify(data));
      addLog(`Pairing successful! Agent ID: ${data.agentId}`, "success");
      setPairingCode("");
    } catch (err: any) {
      addLog(`Pairing failed: ${err.message}`, "error");
    }
  };

  const heartbeat = useCallback(async () => {
    if (!agentAuth) return;
    try {
      const res = await fetch("/api/agent/heartbeat", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${agentAuth.id}:${agentAuth.secret}`
        },
        body: JSON.stringify({
          status: "online",
          printers: printers
        })
      });
      if (res.status === 401) {
        addLog("Authentication failed. Revoking session.", "error");
        setAgentAuth(null);
        setIsRunning(false);
        return;
      }
      addLog("Heartbeat sent successfully.");
    } catch (err) {
      addLog("Heartbeat failed. Retrying...", "warn");
    }
  }, [agentAuth, printers, addLog]);

  const pollJobs = useCallback(async () => {
    if (!agentAuth) return;
    try {
      const res = await fetch("/api/agent/jobs", {
        headers: {
          "Authorization": `Bearer ${agentAuth.id}:${agentAuth.secret}`
        }
      });
      const jobs = await res.json();
      if (jobs.length > 0) {
        addLog(`Received ${jobs.length} job(s). Processing...`, "info");
        for (const job of jobs) {
          addLog(`Job ${job.id}: Processing for printer ${job.printerId}...`);

          // Update status to printing
          await fetch("/api/agent/jobs", {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${agentAuth.id}:${agentAuth.secret}`
            },
            body: JSON.stringify({ jobId: job.id, status: "printing" })
          });

          // Simulate actual printing
          await new Promise(r => setTimeout(r, 2000));

          // Update status to success
          await fetch("/api/agent/jobs", {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${agentAuth.id}:${agentAuth.secret}`
            },
            body: JSON.stringify({ jobId: job.id, status: "success" })
          });
          addLog(`Job ${job.id}: Printed successfully!`, "success");
        }
      }
    } catch (err) {
      addLog("Failed to poll jobs.", "error");
    }
  }, [agentAuth, addLog]);

  useEffect(() => {
    const saved = localStorage.getItem("sim_agent_auth");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // schedule state update after mount to avoid cascading render lint
        queueMicrotask(() => setAgentAuth(parsed));
      } catch {}
    }
  }, []);

  useEffect(() => {
    if (!isRunning || !agentAuth) return;

    const heartbeatInterval = setInterval(heartbeat, 10000);
    const pollInterval = setInterval(pollJobs, 5000);

    return () => {
      clearInterval(heartbeatInterval);
      clearInterval(pollInterval);
    };
  }, [isRunning, agentAuth, heartbeat, pollJobs]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-1 space-y-6">
        <div className="p-6 border-edge rounded-xl bg-surface shadow-sm border-edge">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Database className="w-5 h-5 text-info" />
            Configuration
          </h2>

          {!agentAuth ? (
            <div className="space-y-4">
              <p className="text-sm text-ink-3">Pair this simulator with the dashboard to start.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Pairing Code"
                  className="flex-1 px-3 py-2 border-edge rounded-md text-sm bg-surface-2"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
                />
                <button
                  onClick={handleRegister}
                  className="bg-brand-700 text-white px-4 py-2 h-9 rounded-lg text-sm font-semibold hover:bg-brand-800 transition-colors disabled:opacity-50"
                >
                  Pair
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 bg-ok-bg border-ok-edge text-ok rounded-lg text-sm font-mono border">
                Paired: {agentAuth.id}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setIsRunning(!isRunning)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-bold transition-colors",
                    isRunning
                      ? "bg-bad-bg text-bad hover:bg-bad-bg/70"
                      : "bg-ok text-white hover:bg-ok/90"
                  )}
                >
                  {isRunning ? (
                    <><Square className="w-4 h-4 fill-current" /> Stop Agent</>
                  ) : (
                    <><Play className="w-4 h-4 fill-current" /> Start Agent</>
                  )}
                </button>
                <button
                  onClick={() => {
                    localStorage.removeItem("sim_agent_auth");
                    setAgentAuth(null);
                    setIsRunning(false);
                    addLog("Agent session cleared.", "warn");
                  }}
                  className="p-2 text-ink-3 hover:text-bad transition-colors"
                  title="Unpair Agent"
                >
                  <RefreshCcw className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-edge rounded-xl bg-surface shadow-sm border-edge">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <PrinterIcon className="w-5 h-5 text-brand-600" />
            Local Printers
          </h2>
          <div className="space-y-3">
            {printers.map(p => (
              <div key={p.id} className="text-xs p-3 border-edge rounded-lg bg-surface-2">
                <div className="flex justify-between font-bold mb-1">
                  <span>{p.name}</span>
                  <span className="text-ok uppercase text-[10px]">{p.status}</span>
                </div>
                <div className="text-ink-3">
                  {p.type === 'network' ? `IP: ${p.config.ip}:${p.config.port}` : `USB Path: ${p.config.address}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="lg:col-span-2 flex flex-col h-[600px] border-edge rounded-xl bg-surface-2 shadow-inner overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-surface-2 border-b border-edge">
          <div className="flex items-center gap-2 text-ink-3 text-sm font-mono">
            <Terminal className="w-4 h-4" />
            Agent Logs
          </div>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <span className="flex items-center gap-1.5 text-ok text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
                Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-ink-2 text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-ink-3" />
                Offline
              </span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-sm">
          {logs.map((log, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-ink-2 shrink-0">[{log.time}]</span>
              <span className={cn(
                "font-bold uppercase shrink-0 w-12",
                log.level === "info" && "text-info",
                log.level === "success" && "text-ok",
                log.level === "warn" && "text-warn",
                log.level === "error" && "text-bad",
              )}>
                {log.level}
              </span>
              <span className="text-ink-2 break-all">{log.message}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="text-ink-2 italic">No logs yet...</div>
          )}
        </div>
      </div>
    </div>
  );
}
