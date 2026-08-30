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
        <div className="p-6 border rounded-xl bg-white dark:bg-zinc-900 shadow-sm border-zinc-200 dark:border-zinc-800">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Database className="w-5 h-5 text-blue-500" />
            Configuration
          </h2>
          
          {!agentAuth ? (
            <div className="space-y-4">
              <p className="text-sm text-zinc-500">Pair this simulator with the dashboard to start.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Pairing Code"
                  className="flex-1 px-3 py-2 border rounded-md text-sm bg-zinc-50 dark:bg-zinc-800"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
                />
                <button
                  onClick={handleRegister}
                  className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
                >
                  Pair
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg text-sm font-mono border border-green-100 dark:border-green-900/30">
                Paired: {agentAuth.id}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setIsRunning(!isRunning)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-bold transition-colors",
                    isRunning 
                      ? "bg-red-50 text-red-600 hover:bg-red-100" 
                      : "bg-green-600 text-white hover:bg-green-700"
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
                  className="p-2 text-zinc-400 hover:text-red-600"
                  title="Unpair Agent"
                >
                  <RefreshCcw className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border rounded-xl bg-white dark:bg-zinc-900 shadow-sm border-zinc-200 dark:border-zinc-800">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <PrinterIcon className="w-5 h-5 text-purple-500" />
            Local Printers
          </h2>
          <div className="space-y-3">
            {printers.map(p => (
              <div key={p.id} className="text-xs p-3 border rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                <div className="flex justify-between font-bold mb-1">
                  <span>{p.name}</span>
                  <span className="text-green-600 uppercase text-[10px]">{p.status}</span>
                </div>
                <div className="text-zinc-400">
                  {p.type === 'network' ? `IP: ${p.config.ip}:${p.config.port}` : `USB Path: ${p.config.address}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="lg:col-span-2 flex flex-col h-[600px] border rounded-xl bg-zinc-950 shadow-inner overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-400 text-sm font-mono">
            <Terminal className="w-4 h-4" />
            Agent Logs
          </div>
          <div className="flex items-center gap-2">
            {isRunning ? (
              <span className="flex items-center gap-1.5 text-green-500 text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-zinc-600 text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-zinc-600" />
                Offline
              </span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-sm">
          {logs.map((log, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-zinc-600 shrink-0">[{log.time}]</span>
              <span className={cn(
                "font-bold uppercase shrink-0 w-12",
                log.level === "info" && "text-blue-400",
                log.level === "success" && "text-green-400",
                log.level === "warn" && "text-orange-400",
                log.level === "error" && "text-red-400",
              )}>
                {log.level}
              </span>
              <span className="text-zinc-300 break-all">{log.message}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="text-zinc-700 italic">No logs yet...</div>
          )}
        </div>
      </div>
    </div>
  );
}
