"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  Play,
  Square,
  Terminal,
  Trash2,
  Database,
  Printer as PrinterIcon,
  Wifi,
  KeyRound,
  CheckCircle2
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  StatusBadge,
  StatusDot,
  Mono,
  type Tone
} from "@/components/ui";

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
  const [printers] = useState([
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-6">
        <Card className="p-6">
          <h2 className="mb-4 flex items-center gap-2.5 text-base font-semibold text-ink">
            <Database className="w-5 h-5 text-brand" aria-hidden />
            Configuration
          </h2>

          {!agentAuth ? (
            <div className="space-y-4">
              <p className="text-sm text-ink-3">Pair this simulator with the dashboard to start sending heartbeats and claiming jobs.</p>
              <Field label="Pairing code" htmlFor="sim-pairing-code">
                <div className="flex gap-2.5">
                  <Input
                    id="sim-pairing-code"
                    placeholder="Enter pairing code"
                    value={pairingCode}
                    onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
                    className="font-mono uppercase tracking-wider"
                  />
                  <Button
                    variant="primary"
                    onClick={handleRegister}
                    disabled={!pairingCode}
                    icon={<KeyRound className="h-4 w-4" />}
                  >
                    Pair
                  </Button>
                </div>
              </Field>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-ok-edge bg-ok-bg p-4 flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-ok shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold uppercase tracking-wider text-ok">Paired Agent</div>
                  <Mono className="text-ink font-semibold truncate block mt-0.5">{agentAuth.id}</Mono>
                </div>
              </div>
              <div className="flex gap-2.5">
                <Button
                  variant={isRunning ? "danger" : "primary"}
                  onClick={() => setIsRunning(!isRunning)}
                  className="flex-1"
                  icon={isRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                >
                  {isRunning ? "Stop Agent" : "Start Agent"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    localStorage.removeItem("sim_agent_auth");
                    setAgentAuth(null);
                    setIsRunning(false);
                    addLog("Agent session cleared.", "warn");
                  }}
                  title="Unpair Agent"
                  aria-label="Unpair Agent"
                >
                  Unpair
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 flex items-center gap-2.5 text-base font-semibold text-ink">
            <PrinterIcon className="w-5 h-5 text-brand" aria-hidden />
            Simulated Local Printers
          </h2>
          <div className="space-y-3">
            {printers.map(p => (
              <div key={p.id} className="rounded-xl border border-edge bg-surface-2 p-3.5 text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-2 font-semibold text-ink">
                  <span className="truncate text-sm">{p.name}</span>
                  <StatusBadge tone="ok" label={p.status} />
                </div>
                <div className="text-ink-3 font-mono">
                  {p.type === 'network' ? `IP: ${p.config.ip}:${p.config.port}` : `USB Path: ${p.config.address}`}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="flex h-[600px] flex-col overflow-hidden lg:col-span-2">
        <div className="flex items-center justify-between border-b border-edge bg-surface-2 px-5 py-3">
          <div className="flex items-center gap-2.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-ink-3">
            <Terminal className="h-4 w-4 text-brand" aria-hidden />
            Agent Console Logs
          </div>
          <div className="flex items-center gap-4">
            <StatusBadge
              tone={isRunning ? "ok" : "neutral"}
              label={isRunning ? "Connected" : "Offline"}
            />
            {logs.length > 0 && (
              <button
                onClick={() => setLogs([])}
                className="text-ink-3 hover:text-bad p-1 rounded transition-colors"
                title="Clear logs"
                aria-label="Clear logs"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 space-y-1.5 overflow-y-auto bg-surface-2/60 p-4 font-mono text-xs leading-relaxed">
          {logs.map((log, i) => (
            <div key={i} className="flex gap-3 items-start py-0.5">
              <span className="shrink-0 text-ink-3 tabular-nums">[{log.time}]</span>
              <span className={cn(
                "w-14 shrink-0 font-semibold uppercase tracking-wide text-[11px]",
                log.level === "info" && "text-info",
                log.level === "success" && "text-ok",
                log.level === "warn" && "text-warn",
                log.level === "error" && "text-bad",
              )}>
                {log.level}
              </span>
              <span className="text-ink-2 break-all flex-1">{log.message}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="italic text-ink-3 p-4 text-center">No logs generated yet. Pair and start the agent simulator.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
