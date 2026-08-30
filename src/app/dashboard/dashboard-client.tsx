"use client";

import { useState } from "react";
import { createAgent, createTestPrintJob, deleteAgent } from "@/app/actions";
import { cn } from "@/lib/utils";
import { 
  Plus, 
  Trash2, 
  Printer, 
  Settings, 
  Activity, 
  CheckCircle, 
  AlertCircle, 
  Clock,
  HardDrive,
  Network
} from "lucide-react";
import { format } from "date-fns";

type Agent = {
  id: string;
  name: string;
  pairingCode: string | null;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  metadata?: { hostname?: string; os?: string; version?: string } | null;
};

type Printer = {
  id: string;
  agentId: string;
  name: string;
  type: string;
  status: string;
  config: any;
};

type Job = {
  id: string;
  agentId: string;
  printerId: string;
  status: string;
  createdAt: Date;
};

export default function DashboardClient({
  initialAgents,
  initialPrinters,
  initialJobs,
}: {
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
}) {
  const [agents, setAgents] = useState(initialAgents);
  const [newAgentName, setNewAgentName] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName) return;
    setIsLoading(true);
    try {
      await createAgent(newAgentName);
      setNewAgentName("");
      window.location.reload(); // Simple way to refresh for now
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestPrint = async (printerId: string) => {
    setIsLoading(true);
    try {
      await createTestPrintJob(printerId);
      alert("Test print job queued! Gateway → Agent → Printer. Check Recent Jobs for queued → claimed → printing → success/failed. Success = socket write OK (see PRINTERS.md), not paper-out.");
    } catch (err) {
      alert(`Failed to queue test print: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestConnection = async (printerId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/printers/${printerId}/test-connection`, { method: "POST" });
      const data: { reachable: boolean; latencyMs: number | null; agentOnline: boolean; error: string | null } = await res.json();
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "probe failed");
      // Contract: {reachable, latencyMs, agentOnline, error} — no probeId, no printJobs row (see route.ts:10)
      if (data.error) {
        alert(`reachable=${data.reachable} agentOnline=${data.agentOnline} latencyMs=${data.latencyMs ?? "n/a"}\n${data.error}`);
      } else {
        alert(`reachable=${data.reachable} agentOnline=${data.agentOnline} latencyMs=${data.latencyMs ?? "null (Gateway cannot dial LAN; Agent dials on heartbeat)"}`);
      }
    } catch (err) {
      alert(`Probe failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
      {/* Agents Column */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-500" />
            Agents
          </h2>
        </div>

        <form onSubmit={handleCreateAgent} className="flex gap-2">
          <input
            type="text"
            placeholder="Agent Name (e.g. Cairo Branch)"
            className="flex-1 px-3 py-2 border rounded-md text-sm bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800"
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !newAgentName}
            className="p-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus className="w-5 h-5" />
          </button>
        </form>

        <div className="space-y-4">
          {initialAgents.map((agent) => (
            <div
              key={agent.id}
              className="p-4 border rounded-lg bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 relative group"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium">{agent.name}</h3>
                <span
                  className={cn(
                    "text-xs px-2 py-0.5 rounded-full uppercase font-bold",
                    agent.status === "online"
                      ? "bg-green-100 text-green-700"
                      : "bg-zinc-100 text-zinc-600"
                  )}
                >
                  {agent.status}
                </span>
              </div>
              <div className="text-xs text-zinc-500 space-y-1">
                <p>ID: {agent.id}</p>
                {agent.pairingCode && (
                  <p className="text-orange-600 font-mono font-bold">
                    Pairing Code: {agent.pairingCode}
                  </p>
                )}
                <p>Host: {(agent.metadata as unknown as { hostname?: string })?.hostname ?? "—"} · {(agent.metadata as unknown as { os?: string })?.os ?? ""} {(agent.metadata as unknown as { version?: string })?.version ?? ""}</p>
                <p>
                  Last seen:{" "}
                  {agent.lastSeenAt
                    ? format(new Date(agent.lastSeenAt), "MMM d, HH:mm:ss")
                    : "Never"}
                </p>
                <p className="text-[10px] opacity-60">Gateway: queued→claimed→printing→success/failed/expired · Agent: queued→printing→success/failed</p>
              </div>
              <button
                onClick={() => deleteAgent(agent.id)}
                className="absolute top-2 right-2 p-1 text-zinc-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {initialAgents.length === 0 && (
            <p className="text-center text-zinc-500 py-8 italic">No agents registered</p>
          )}
        </div>
      </div>

      {/* Printers Column */}
      <div className="space-y-6">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Printer className="w-5 h-5 text-purple-500" />
          Printers
        </h2>

        <div className="space-y-4">
          {initialPrinters.map((printer) => (
            <div
              key={printer.id}
              className="p-4 border rounded-lg bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium">{printer.name}</h3>
                <span
                  className={cn(
                    "text-xs px-2 py-0.5 rounded-full",
                    printer.status === "online"
                      ? "bg-green-100 text-green-700"
                      : "bg-red-100 text-red-700"
                  )}
                >
                  {printer.status}
                </span>
              </div>
              <div className="text-xs text-zinc-500 space-y-1 mb-4">
                <div className="flex items-center gap-1">
                  {printer.type === "usb" ? (
                    <HardDrive className="w-3 h-3" />
                  ) : (
                    <Network className="w-3 h-3" />
                  )}
                  <span>{printer.type.toUpperCase()}</span>
                </div>
                <p>Agent: {initialAgents.find(a => a.id === printer.agentId)?.name || printer.agentId}</p>
                {printer.config?.ip && <p>IP: {printer.config.ip}</p>}
                {printer.config?.address && <p>Path: {printer.config.address}</p>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleTestConnection(printer.id)}
                  disabled={isLoading}
                  className="py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 text-sm font-medium rounded-md transition-colors"
                >
                  Test Connection
                </button>
                <button
                  onClick={() => handleTestPrint(printer.id)}
                  disabled={isLoading}
                  className="py-2 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 text-sm font-medium rounded-md transition-colors"
                >
                  Test Print
                </button>
              </div>
              <p className="text-[10px] text-zinc-400 mt-2 leading-tight">Connection = TCP dial only (no job). Print = real queued→claimed→printing→success/failed via Agent → LAN.</p>
            </div>
          ))}
          {initialPrinters.length === 0 && (
            <p className="text-center text-zinc-500 py-8 italic">No printers discovered</p>
          )}
        </div>
      </div>

      {/* Jobs Column */}
      <div className="space-y-6">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Clock className="w-5 h-5 text-orange-500" />
          Recent Jobs
        </h2>

        <div className="space-y-3">
          {initialJobs.map((job) => (
            <div
              key={job.id}
              className="p-3 border rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 text-xs"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-zinc-400">{job.id}</span>
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded flex items-center gap-1",
                    job.status === "success" && "text-green-600 bg-green-50",
                    job.status === "failed" && "text-red-600 bg-red-50",
                    job.status === "queued" && "text-blue-600 bg-blue-50",
                    job.status === "printing" && "text-orange-600 bg-orange-50"
                  )}
                >
                  {job.status === "success" && <CheckCircle className="w-3 h-3" />}
                  {job.status === "failed" && <AlertCircle className="w-3 h-3" />}
                  {job.status}
                </span>
              </div>
              <div className="flex justify-between items-end">
                <div className="text-zinc-500">
                  <p>Printer: {initialPrinters.find(p => p.id === job.printerId)?.name || job.printerId}</p>
                  <p>{format(new Date(job.createdAt), "HH:mm:ss")}</p>
                </div>
              </div>
            </div>
          ))}
          {initialJobs.length === 0 && (
            <p className="text-center text-zinc-500 py-8 italic">No jobs in queue</p>
          )}
        </div>
      </div>
    </div>
  );
}
