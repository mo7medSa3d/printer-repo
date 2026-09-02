"use client";

import { useState } from "react";
import { createAgent, createTestPrintJob, deleteAgent } from "@/app/actions";
import { cn } from "@/lib/utils";
import {
  Plus,
  Trash2,
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

type Branch = {
  id: string;
  name: string;
  enabled: boolean;
};

type Agent = {
  id: string;
  /**
   * The agent's branch. This is the SINGLE source of branch truth for the
   * agent and for every printer it owns (Branch → Agent → Printer).
   */
  branchId: string;
  name: string;
  pairingCode: string | null;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  metadata?: unknown;
};

type Printer = {
  id: string;
  agentId: string;
  name: string;
  type: string;
  status: string;
  config: any;
  /**
   * DERIVED from the owning agent (printer → agent → branch) by the server.
   * Display only — a printer has no branch of its own and the UI intentionally
   * offers no way to edit it.
   */
  branchId: string | null;
};

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
  initialAgents,
  initialPrinters,
  initialJobs,
  initialBranches,
}: {
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
  initialBranches: Branch[];
}) {
  const enabledBranches = initialBranches.filter((b) => b.enabled !== false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentBranchId, setNewAgentBranchId] = useState<string>(enabledBranches[0]?.id ?? "");
  const branchName = (id: string | null | undefined) =>
    (id ? initialBranches.find((b) => b.id === id)?.name ?? id : null);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName) return;
    setIsLoading(true);
    try {
      await createAgent(newAgentName, newAgentBranchId || undefined);
      setNewAgentName("");
      window.location.reload();
    } catch (err) {
      setNotice({ text: `Failed to create agent: ${err instanceof Error ? err.message : "unknown error"}`, tone: "bad" });
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

  const handleDeleteConfirmed = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    setIsLoading(true);
    try {
      await deleteAgent(id);
      window.location.reload();
    } finally {
      setIsLoading(false);
    }
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
          {/* Pairing establishes Agent → Branch. Every printer this agent
              discovers inherits this branch, so it is chosen here, once. */}
          <form onSubmit={handleCreateAgent} className="space-y-2" aria-label="Register a new agent">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Agent name, e.g. Cairo Front Desk"
                className={`flex-1 ${inputClass}`}
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                disabled={isLoading}
                aria-label="Agent name"
              />
              <Button variant="primary" type="submit" disabled={isLoading || !newAgentName || !newAgentBranchId} icon={<Plus className="h-4 w-4" />} aria-label="Create agent">
                Add
              </Button>
            </div>
            <select
              className={`w-full ${inputClass}`}
              value={newAgentBranchId}
              onChange={(e) => setNewAgentBranchId(e.target.value)}
              disabled={isLoading || enabledBranches.length === 0}
              aria-label="Agent branch"
            >
              {enabledBranches.length === 0 && <option value="">No branch configured — create a branch first</option>}
              {enabledBranches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-ink-3">
              The agent owns the branch for all printers it reports: Branch → Agent → Printer.
            </p>
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
                    <StatusBadge tone={agentTone(agent.status)} label={agent.status === "online" ? "Online" : "Offline"} />
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
                    <p className="text-ink-3">Branch: {branchName(agent.branchId) ?? "unassigned"}</p>
                    <p className="text-ink-3">
                      {(agent.metadata as unknown as { hostname?: string })?.hostname ?? "Host unknown"} · {(agent.metadata as unknown as { os?: string })?.os ?? ""} {(agent.metadata as unknown as { version?: string })?.version ?? ""}
                    </p>
                    <p className="text-ink-3">
                      Last seen {agent.lastSeenAt ? format(new Date(agent.lastSeenAt), "MMM d, HH:mm:ss") : "never"}
                    </p>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setPendingDelete(agent)} icon={<Trash2 className="h-3.5 w-3.5" />} className="text-ink-3 hover:text-bad">
                      Remove
                    </Button>
                  </div>
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
                    {printer.type === "usb" ? <HardDrive className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <Network className="h-3.5 w-3.5 text-ink-3" aria-hidden />}
                    <span className="uppercase">{printer.type}</span>
                  </div>
                  <p className="text-ink-3">Agent: {initialAgents.find(a => a.id === printer.agentId)?.name || printer.agentId}</p>
                  {/* Read-only: derived through the agent, never editable here. */}
                  <p className="text-ink-3" title="Derived from the owning agent — a printer has no branch of its own">
                    Branch: {branchName(printer.branchId) ?? "—"} <span className="text-ink-3">(via agent)</span>
                  </p>
                  {printer.config?.ip && <p className="font-mono text-ink-2">{printer.config.ip}</p>}
                  {printer.config?.address && <p className="font-mono text-ink-2">{printer.config.address}</p>}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleTestConnection(printer.id)} disabled={isLoading}>Test connection</Button>
                  <Button variant="primary" size="sm" onClick={() => handleTestPrint(printer.id)} disabled={isLoading}>Test print</Button>
                </div>
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
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={`Remove agent “${pendingDelete?.name ?? ""}”?`}
        description="The agent can no longer poll for jobs or report heartbeats. Its printers remain in the database."
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={handleDeleteConfirmed} icon={<Trash2 className="h-4 w-4" />}>Remove agent</Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">This action cannot be undone from the console. Pair the agent again later with a new code.</p>
      </Modal>
    </div>
  );
}
