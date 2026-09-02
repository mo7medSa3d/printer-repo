"use client";

import { useState } from "react";
import { createAgent, createTestPrintJob, setAgentLifecycle, setPrinterLifecycle } from "@/app/actions";
import { cn } from "@/lib/utils";
import {
  Plus,
  Printer,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HardDrive,
  Network,
  KeyRound,
  Server,
} from "lucide-react";
import { format } from "date-fns";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  StatusBadge,
  StatusDot,
  Modal,
  Mono,
  MetaRow,
  CopyButton,
  inputClass,
  type Tone,
} from "@/components/ui";

type Branch = { id: string; name: string; enabled: boolean };
type Agent = { id: string; branchId: string; name: string; pairingCode: string | null; status: string; lifecycle: string; lastSeenAt: Date | null; createdAt: Date; printerCount: number; metadata?: unknown };

type Printer = { id: string; agentId: string; name: string; printerType: string; deviceClass: string; connectionType: string; lifecycle: string; status: string; config: any };

type Job = {
  id: string;
  agentId: string;
  printerId: string;
  status: string;
  createdAt: Date;
};

function agentTone(status: string): Tone {
  return status === "online" ? "ok" : status === "offline" ? "bad" : "neutral";
}
function printerTone(status: string): Tone {
  return status === "online" ? "ok" : status === "busy" ? "warn" : status === "error" ? "bad" : status === "offline" ? "bad" : "neutral";
}
function jobTone(status: string): Tone {
  if (status === "success") return "ok";
  if (status === "failed" || status === "expired") return "bad";
  if (status === "printing") return "warn";
  if (status === "claimed") return "info";
  return "neutral";
}

export default function DashboardClient({
  initialBranches,
  initialAgents,
  initialPrinters,
  initialJobs,
  databaseError,
}: {
  initialBranches: Branch[]; initialAgents: Agent[]; initialPrinters: Printer[]; initialJobs: Job[]; databaseError: string | null;
}) {
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentBranchId, setNewAgentBranchId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [pendingLifecycle, setPendingLifecycle] = useState<{ agent?: Agent; printer?: Printer; lifecycle: "disabled" | "retired" } | null>(null);
  const branchesById = new Map(initialBranches.map((branch) => [branch.id, branch]));
  const agentsById = new Map(initialAgents.map((agent) => [agent.id, agent]));

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName) return;
    setIsLoading(true);
    try {
      if (!newAgentBranchId) throw new Error("Select a branch");
      await createAgent(newAgentName, newAgentBranchId);
      setNewAgentName("");
      setNewAgentBranchId("");
      window.location.reload();
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestPrint = async (printerId: string) => {
    setIsLoading(true);
    setNotice(null);
    try {
      await createTestPrintJob(printerId);
      setNotice({ text: "Test print queued — it runs through the normal job pipeline (queued → claimed → printing → success/failed).", tone: "ok" });
    } catch (err) {
      setNotice({ text: `Failed to queue test print: ${err instanceof Error ? err.message : "unknown error"}`, tone: "bad" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestConnection = async (printerId: string) => {
    setIsLoading(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/printers/${printerId}/test-connection`, { method: "POST" });
      const data: { reachable: boolean; latencyMs: number | null; agentOnline: boolean; error: string | null } = await res.json();
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "probe failed");
      if (data.error) {
        setNotice({ text: `reachable=${data.reachable} · agentOnline=${data.agentOnline} · ${data.error}`, tone: "bad" });
      } else {
        setNotice({ text: `Printer reachable · agent online · round-trip ${data.latencyMs ?? "not measured (live probe pending)"}`, tone: "ok" });
      }
    } catch (err) {
      setNotice({ text: `Probe failed: ${err instanceof Error ? err.message : "unknown"}`, tone: "bad" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLifecycle = async () => {
    if (!pendingLifecycle) return;
    const { agent, printer, lifecycle } = pendingLifecycle;
    setPendingLifecycle(null); setIsLoading(true);
    try {
      if (agent) await setAgentLifecycle(agent.id, lifecycle);
      else if (printer) await setPrinterLifecycle(printer.id, lifecycle);
      else throw new Error("lifecycle target missing");
      window.location.reload();
    }
    catch (err) { setNotice({ text: err instanceof Error ? err.message : "Lifecycle update failed", tone: "bad" }); }
    finally { setIsLoading(false); }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {notice && (
        <div
          role="status"
          className={cn(
            "lg:col-span-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
            notice.tone === "ok" ? "border-ok-edge bg-ok-bg text-ok" : "border-bad-edge bg-bad-bg text-bad"
          )}
        >
          {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />}
          <span className="text-ink-2">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="ml-auto text-ink-3 hover:text-ink" aria-label="Dismiss message">✕</button>
        </div>
      )}

      {/* Agents */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Agents"
          subtitle="Machines paired to this gateway"
          icon={<Activity className="h-4 w-4 text-brand" aria-hidden />}
        />
        <div className="px-5 pb-5 space-y-4">
          <form onSubmit={handleCreateAgent} className="flex gap-2" aria-label="Register a new agent">
            <input
              type="text"
              placeholder="Agent name, e.g. Cairo Branch"
              className={`flex-1 ${inputClass}`}
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              disabled={isLoading}
              aria-label="Agent name"
            />
            <select value={newAgentBranchId} onChange={(e) => setNewAgentBranchId(e.target.value)} disabled={isLoading || databaseError !== null} className={`w-48 ${inputClass}`} aria-label="Agent branch">
              <option value="">Select branch</option>
              {initialBranches.filter(b => b.enabled).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <Button variant="primary" type="submit" disabled={isLoading || !newAgentName || !newAgentBranchId || databaseError !== null} icon={<Plus className="h-4 w-4" />} aria-label="Create agent">
              Add
            </Button>
          </form>

          {initialAgents.length === 0 ? (
            <EmptyState
              icon={<Server className="h-7 w-7" />}
              title="No agents registered"
              description="Create an agent to get a one-time pairing code, then pair the desktop manager or the CLI with it."
            />
          ) : (
            <div className="space-y-3">
              {initialAgents.map((agent) => (
                <div key={agent.id} className="card card-interactive p-4 shadow-none">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="truncate font-medium text-ink">{agent.name}</h3>
                    <div className="flex items-center gap-2"><StatusBadge tone={agent.lifecycle === "active" ? agentTone(agent.status) : "warn"} label={agent.status === "online" ? "Online" : "Offline"} /><StatusBadge tone={agent.lifecycle === "retired" ? "bad" : agent.lifecycle === "disabled" ? "warn" : "ok"} label={agent.lifecycle} /></div>
                  </div>
                  <div className="mt-2 space-y-1.5 text-xs text-ink-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-ink-3">ID</span>
                      <Mono>{agent.id}</Mono>
                      <CopyButton value={agent.id} label="Copy" className="ml-auto" />
                    </div>
                    {agent.pairingCode ? (
                      <div className="flex items-center gap-1.5 rounded-md border border-warn-edge bg-warn-bg px-2.5 py-1.5">
                        <KeyRound className="h-3.5 w-3.5 text-warn" aria-hidden />
                        <span className="text-ink-2">Pairing code</span>
                        <span className="font-mono font-bold tracking-widest text-ink">{agent.pairingCode}</span>
                        <CopyButton value={agent.pairingCode} label="Copy" className="ml-auto" />
                      </div>
                    ) : (
                      <p className="text-ink-3">Paired — no active pairing code</p>
                    )}
                    <p className="text-ink-3">Branch: {branchesById.get(agent.branchId)?.name ?? agent.branchId} · Printers: {agent.printerCount}</p>
                    <p className="text-ink-3">
                      {(agent.metadata as unknown as { hostname?: string })?.hostname ?? "Host unknown"} · {(agent.metadata as unknown as { os?: string })?.os ?? ""} {(agent.metadata as unknown as { version?: string })?.version ?? ""}
                    </p>
                    <p className="text-ink-3">
                      Last seen {agent.lastSeenAt ? format(new Date(agent.lastSeenAt), "MMM d, HH:mm:ss") : "never"}
                    </p>
                  </div>
                  {agent.lifecycle !== "retired" && <div className="mt-3 flex justify-end gap-2">
                    {agent.lifecycle === "active" && <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ agent, lifecycle: "disabled" })}>Disable</Button>}
                    {agent.lifecycle === "disabled" && <Button variant="ghost" size="sm" onClick={async () => { await setAgentLifecycle(agent.id, "active"); window.location.reload(); }}>Enable</Button>}
                    <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ agent, lifecycle: "retired" })}>Retire</Button>
                  </div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Printers */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Printers"
          subtitle="Reported by agents via heartbeat"
          icon={<Printer className="h-4 w-4 text-brand" aria-hidden />}
        />
        <div className="px-5 pb-5 space-y-3">
          {initialPrinters.length === 0 ? (
            <EmptyState icon={<Printer className="h-7 w-7" />} title="No printers yet" description="Printers appear here as soon as an online agent reports them via heartbeat." />
          ) : (
            initialPrinters.map((printer) => (
              <div key={printer.id} className="card card-interactive p-4 shadow-none">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate font-medium text-ink">{printer.name}</h3>
                  <StatusBadge tone={printerTone(printer.status)} label={printer.status === "online" ? "Online" : printer.status.charAt(0).toUpperCase() + printer.status.slice(1)} />
                </div>
                <div className="mt-2 space-y-1.5 text-xs text-ink-2">
                  <div className="flex items-center gap-1.5">
                    {printer.connectionType === "usb" ? <HardDrive className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <Network className="h-3.5 w-3.5 text-ink-3" aria-hidden />}
                    <span className="uppercase">{printer.connectionType} · {printer.printerType}{printer.deviceClass !== "unknown" ? ` · ${printer.deviceClass}` : ""}</span>
                  </div>
                  <p className="text-ink-3">Agent: {agentsById.get(printer.agentId)?.name || printer.agentId}</p><p className="text-ink-3">Branch: {(() => { const owner = agentsById.get(printer.agentId); return owner ? (branchesById.get(owner.branchId)?.name ?? owner.branchId) : "unknown"; })()} · Lifecycle: {printer.lifecycle}</p>
                  {printer.config?.ip && <p className="font-mono text-ink-2">{printer.config.ip}</p>}
                  {printer.config?.address && <p className="font-mono text-ink-2">{printer.config.address}</p>}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleTestConnection(printer.id)} disabled={isLoading || printer.lifecycle !== "active"}>Test connection</Button>
                  <Button variant="primary" size="sm" onClick={() => handleTestPrint(printer.id)} disabled={isLoading || printer.lifecycle !== "active"}>Test print</Button>
                </div>
                {printer.lifecycle !== "retired" && <div className="mt-2 flex justify-end gap-2">
                  {printer.lifecycle === "active" && <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ printer, lifecycle: "disabled" })}>Disable</Button>}
                  {printer.lifecycle === "disabled" && <Button variant="ghost" size="sm" onClick={async () => { await setPrinterLifecycle(printer.id, "active"); window.location.reload(); }}>Enable</Button>}
                  <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ printer, lifecycle: "retired" })}>Retire</Button>
                </div>}
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Jobs */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Recent jobs"
          subtitle="Latest 50 in the gateway queue"
          icon={<Clock className="h-4 w-4 text-brand" aria-hidden />}
        />
        <div className="px-5 pb-5 space-y-2.5">
          {initialJobs.length === 0 ? (
            <EmptyState icon={<Clock className="h-7 w-7" />} title="No jobs in queue" description="Print jobs will appear here when an agent starts printing." />
          ) : (
            initialJobs.map((job) => (
              <div key={job.id} className="row-hover rounded-lg border border-edge bg-surface px-3.5 py-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <Mono className="truncate">{job.id}</Mono>
                  <StatusBadge tone={jobTone(job.status)} label={job.status === "success" ? "Completed" : job.status.charAt(0).toUpperCase() + job.status.slice(1)} />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-ink-3">
                  <span className="truncate">Printer: {initialPrinters.find(p => p.id === job.printerId)?.name || job.printerId}</span>
                  <span className="whitespace-nowrap">{format(new Date(job.createdAt), "HH:mm:ss")}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      <Modal
        open={!!pendingLifecycle}
        onClose={() => setPendingLifecycle(null)}
        title={`${pendingLifecycle?.lifecycle === "retired" ? "Retire" : "Disable"} ${pendingLifecycle?.agent ? "agent" : "printer"} “${pendingLifecycle?.agent?.name ?? pendingLifecycle?.printer?.name ?? ""}”?`}
        description="This preserves the resource, its historical jobs and audit history. New printing is blocked while disabled or retired."
        footer={<>
          <Button variant="secondary" onClick={() => setPendingLifecycle(null)}>Cancel</Button>
          <Button variant="danger" onClick={handleLifecycle}>{pendingLifecycle?.lifecycle === "retired" ? `Retire ${pendingLifecycle?.agent ? "agent" : "printer"}` : `Disable ${pendingLifecycle?.agent ? "agent" : "printer"}`}</Button>
        </>}
      >
        <p className="text-sm text-ink-2">Retired is terminal and cannot be reactivated.</p>
      </Modal>
    </div>
  );
}
