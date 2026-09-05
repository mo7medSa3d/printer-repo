"use client";

import { useState, useMemo } from "react";
import { createAgent, createTestPrintJob, deleteAgent, setAgentLifecycle, setPrinterLifecycle } from "@/app/actions";
import {
  Plus,
  Printer as PrinterIcon,
  Activity,
  HardDrive,
  Network,
  KeyRound,
  Server,
  Clock,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  StatusBadge,
  Modal,
  Mono,
  CopyButton,
  Input,
  Select,
  Field,
  Toast,
  agentTone,
  printerTone,
  jobTone,
} from "@/components/ui";

type Branch = { id: string; name: string; enabled: boolean };
type Agent = {
  id: string;
  branchId: string;
  name: string;
  pairingCode: string | null;
  status: string;
  lifecycle: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  printerCount: number;
  metadata?: unknown;
};

type Printer = {
  id: string;
  agentId: string;
  name: string;
  printerType: string;
  deviceClass: string;
  connectionType: string;
  lifecycle: string;
  status: string;
  config: any;
};

type Job = { id: string; agentId: string; printerId: string; status: string; createdAt: Date };

function DiscoveryPanel({ agents, branchesById }: { agents: Agent[]; branchesById: Map<string, Branch> }) {
  const activeAgents = useMemo(() => agents.filter((a) => a.lifecycle === "active"), [agents]);
  const [agentId, setAgentId] = useState(activeAgents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [devices, setDevices] = useState<any[]>([]);
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);

  const start = async () => {
    if (!agentId) { setMsg("Select an agent"); return; }
    setBusy(true); setMsg(null); setDevices([]);
    try {
      const res = await fetch(`/api/agents/${agentId}/discovery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "start failed");
      setDiscoveryId(data.discoveryId);
      const agentName = agents.find(a => a.id === agentId)?.name ?? agentId;
      setMsg(`Scanning ${agentName} — Discovery ID: ${data.discoveryId}`);

      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const r2 = await fetch(`/api/agents/${agentId}/discovery/${data.discoveryId}`);
        if (!r2.ok) continue;
        const j = await r2.json();
        if (j.devices) setDevices(j.devices);
        if (j.session?.status && j.session.status !== "running") {
          setMsg(`Scan finished (${j.session.status}) — ${j.devices?.length ?? 0} devices found`);
          break;
        }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const approve = async (deviceId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/discovered-printers/${deviceId}/verify`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "approval failed");
      setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, candidateStatus: "verified", verification: "verified" } : d));
      setMsg(`Candidate ${deviceId.slice(0, 16)}… approved. Technical confidence remains unchanged; approval only authorizes provisioning.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const provision = async (deviceId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/discovered-printers/${deviceId}/provision`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "provision failed");
      setMsg(data.already ? `Already configured as ${data.printerId}` : `Provisioned printer ${data.printerId}`);
      setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, candidateStatus: "provisioned" } : d));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const refresh = async () => {
    if (!discoveryId || !agentId) return;
    const r = await fetch(`/api/agents/${agentId}/discovery/${discoveryId}`);
    if (r.ok) { const j = await r.json(); if (j.devices) setDevices(j.devices); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="flex-1" aria-label="Discovery agent">
          {activeAgents.length === 0 ? (
            <option value="">No active agents</option>
          ) : (
            activeAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} — {branchesById.get(a.branchId)?.name ?? a.branchId}</option>
            ))
          )}
        </Select>
        <div className="flex gap-2">
          <Button variant="primary" onClick={start} loading={busy} disabled={busy || !agentId} icon={<Network className="h-4 w-4" />}>
            Scan Network
          </Button>
          {discoveryId && (
            <Button variant="secondary" onClick={refresh} disabled={busy} icon={<RefreshCw className="h-4 w-4" />}>
              Refresh
            </Button>
          )}
        </div>
      </div>

      {msg && <div className="rounded-lg border border-edge bg-surface-2 px-3.5 py-2 text-xs font-medium text-ink-2">{msg}</div>}

      {devices.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-3">No candidates yet — select an active agent and start a scan. Scans private /24 subnets only and do not impact active printing.</p>
      ) : (
        <div className="max-h-[28rem] space-y-2.5 overflow-auto pr-1">
          {devices.map((d: any) => (
            <div key={d.id} className="space-y-1.5 rounded-xl border border-edge bg-surface p-3.5 text-xs shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-ink">{d.deviceName ?? d.model ?? d.ipAddress ?? d.id}</span>
                <StatusBadge tone={d.confidence === "high" ? "ok" : d.confidence === "medium" ? "warn" : "neutral"} label={d.confidence ?? "low confidence"} />
              </div>
              <div className="text-ink-3">Protocol: <span className="font-mono text-ink-2">{d.protocol}</span> · {d.ipAddress ? `${d.ipAddress}:${d.port ?? ""}` : d.uri ?? ""}</div>
              <div className="text-ink-3">Verification: {d.verification === "verified" ? "Verified" : "Candidate"} · Status: {d.candidateStatus ?? "discovered"}</div>
              {d.manufacturer || d.model ? <div className="font-medium text-ink-2">{d.manufacturer ?? ""} {d.model ?? ""}</div> : null}
              <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-edge pt-2.5">
                <Mono>{d.id.slice(0, 16)}…</Mono>
                {d.candidateStatus === "provisioned" ? (
                  <Button size="sm" variant="secondary" disabled>Configured</Button>
                ) : d.candidateStatus === "verified" && d.verification === "verified" ? (
                  <Button size="sm" variant="primary" onClick={() => provision(d.id)} disabled={busy}>
                    Provision Printer
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => approve(d.id)} disabled={busy}>
                    Approve Candidate
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardClient({ initialBranches, initialAgents, initialPrinters, initialJobs, databaseError }: {
  initialBranches: Branch[];
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
  databaseError: string | null;
}) {
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentBranchId, setNewAgentBranchId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);
  const [pendingLifecycle, setPendingLifecycle] = useState<{ agent?: Agent; printer?: Printer; lifecycle: "disabled" | "retired" } | null>(null);
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [printerSearch, setPrinterSearch] = useState("");
  const [printerStatusFilter, setPrinterStatusFilter] = useState("all");
  const [jobSearch, setJobSearch] = useState("");

  const branchesById = useMemo(() => new Map(initialBranches.map((branch) => [branch.id, branch])), [initialBranches]);
  const agentsById = useMemo(() => new Map(initialAgents.map((agent) => [agent.id, agent])), [initialAgents]);

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
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "Failed to create agent", type: "error" });
    } finally { setIsLoading(false); }
  };

  const handleDeleteAgent = async () => {
    if (!pendingDeleteAgent) return;
    setDeleteBusy(true);
    setNotice(null);
    try {
      await deleteAgent(pendingDeleteAgent.id);
      setPendingDeleteAgent(null);
      setNotice({ text: `Agent “${pendingDeleteAgent.name}” deleted successfully.`, type: "success" });
      window.location.reload();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "Failed to delete agent", type: "error" });
      setPendingDeleteAgent(null);
    } finally { setDeleteBusy(false); }
  };

  const handleTestPrint = async (printerId: string) => {
    setIsLoading(true); setNotice(null);
    try {
      await createTestPrintJob(printerId);
      setNotice({ text: "Test print queued successfully — check job queue below.", type: "success" });
    } catch (err) {
      setNotice({ text: `Failed to queue test print: ${err instanceof Error ? err.message : "unknown error"}`, type: "error" });
    } finally { setIsLoading(false); }
  };

  const handleTestConnection = async (printerId: string) => {
    setIsLoading(true); setNotice(null);
    try {
      const res = await fetch(`/api/printers/${printerId}/test-connection`, { method: "POST" });
      const data: { reachable: boolean; latencyMs: number | null; agentOnline: boolean; error: string | null } = await res.json();
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? "probe failed");
      if (data.error) setNotice({ text: `Reachable: ${data.reachable} · Agent Online: ${data.agentOnline} · ${data.error}`, type: "error" });
      else setNotice({ text: `Printer reachable! Agent online · Round-trip latency: ${data.latencyMs ?? "active"}ms`, type: "success" });
    } catch (err) {
      setNotice({ text: `Probe failed: ${err instanceof Error ? err.message : "unknown"}`, type: "error" });
    } finally { setIsLoading(false); }
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
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "Lifecycle update failed", type: "error" });
    } finally { setIsLoading(false); }
  };

  const filteredPrinters = useMemo(() => {
    let list = initialPrinters;
    if (printerSearch) {
      const q = printerSearch.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || p.printerType.toLowerCase().includes(q) || p.connectionType.toLowerCase().includes(q));
    }
    if (printerStatusFilter !== "all") list = list.filter((p) => p.status === printerStatusFilter);
    return list;
  }, [initialPrinters, printerSearch, printerStatusFilter]);

  const filteredJobs = useMemo(() => {
    let list = initialJobs;
    if (jobSearch) {
      const q = jobSearch.toLowerCase();
      list = list.filter((j) => j.id.toLowerCase().includes(q) || j.status.toLowerCase().includes(q) || j.printerId.toLowerCase().includes(q));
    }
    return list;
  }, [initialJobs, jobSearch]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <Card className="overflow-hidden lg:col-span-1">
        <CardHeader title="Agents" subtitle="Machines paired to this gateway" icon={<Activity className="h-5 w-5 text-brand" aria-hidden />} />
        <div className="space-y-4 px-6 pb-6">
          <form onSubmit={handleCreateAgent} className="space-y-3" aria-label="Register a new agent">
            <Field label="Register agent">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input type="text" placeholder="Agent name (e.g. Cairo Branch)" value={newAgentName} onChange={(e) => setNewAgentName(e.target.value)} disabled={isLoading} className="flex-1" />
                <Select value={newAgentBranchId} onChange={(e) => setNewAgentBranchId(e.target.value)} disabled={isLoading || databaseError !== null} className="sm:w-40">
                  <option value="">Branch…</option>
                  {initialBranches.filter(b => b.enabled).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
                <Button variant="primary" type="submit" disabled={isLoading || !newAgentName || !newAgentBranchId || databaseError !== null} icon={<Plus className="h-4 w-4" />}>Add</Button>
              </div>
            </Field>
          </form>

          {initialAgents.length === 0 ? (
            <EmptyState icon={<Server className="h-8 w-8" />} title="No agents registered" description="Create an agent to generate a pairing code, then pair your desktop manager or Windows agent." />
          ) : (
            <div className="max-h-[36rem] space-y-3 overflow-auto pr-1">
              {initialAgents.map((agent) => {
                const canDelete = agent.lifecycle !== "retired" && agent.printerCount === 0 && agent.status !== "online";
                return (
                  <div key={agent.id} className="card card-interactive p-4 shadow-none">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="truncate pt-0.5 text-sm font-semibold text-ink">{agent.name}</h3>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <StatusBadge tone={agentTone(agent.status)} label={agent.status === "online" ? "Online" : "Offline"} />
                        <StatusBadge tone={agent.lifecycle === "retired" ? "bad" : agent.lifecycle === "disabled" ? "warn" : "ok"} label={agent.lifecycle} />
                      </div>
                    </div>
                    <div className="mt-2.5 space-y-1.5 text-xs text-ink-2">
                      <div className="flex items-center gap-1.5"><span className="text-ink-3">ID</span><Mono>{agent.id}</Mono><CopyButton value={agent.id} label="Copy" className="ml-auto" /></div>
                      {agent.pairingCode ? (
                        <div className="flex items-center gap-1.5 rounded-lg border border-warn-edge bg-warn-bg px-3 py-1.5">
                          <KeyRound className="h-3.5 w-3.5 text-warn" aria-hidden />
                          <span className="font-medium text-ink-2">Pairing code</span>
                          <span className="font-mono font-bold tracking-widest text-ink">{agent.pairingCode}</span>
                          <CopyButton value={agent.pairingCode} label="Copy" className="ml-auto" />
                        </div>
                      ) : <p className="text-ink-3">Paired — active session established</p>}
                      <p className="text-ink-3">Branch: {branchesById.get(agent.branchId)?.name ?? agent.branchId} · Printers: {agent.printerCount}</p>
                      <p className="text-ink-3">Last seen: {agent.lastSeenAt ? format(new Date(agent.lastSeenAt), "MMM d, HH:mm:ss") : "never"}</p>
                    </div>
                    {agent.lifecycle !== "retired" && (
                      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-edge pt-2.5">
                        {agent.lifecycle === "active" && <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ agent, lifecycle: "disabled" })}>Disable</Button>}
                        {agent.lifecycle === "disabled" && <Button variant="ghost" size="sm" onClick={async () => { setIsLoading(true); try { await setAgentLifecycle(agent.id, "active"); window.location.reload(); } catch (err) { setNotice({ text: err instanceof Error ? err.message : "Failed to enable agent", type: "error" }); } finally { setIsLoading(false); } }}>Enable</Button>}
                        <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ agent, lifecycle: "retired" })}>Retire</Button>
                        {canDelete && (
                          <Button variant="ghost" size="sm" onClick={() => setPendingDeleteAgent(agent)} disabled={isLoading || deleteBusy} icon={<Trash2 className="h-4 w-4" />} className="text-bad hover:bg-bad-bg hover:text-bad">Delete</Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden lg:col-span-1">
        <CardHeader title="Printers" subtitle="Reported by agents via heartbeat" icon={<PrinterIcon className="h-5 w-5 text-brand" aria-hidden />} />
        <div className="space-y-3 px-6 pb-6">
          {initialPrinters.length > 0 && (
            <div className="flex gap-2">
              <Input placeholder="Search printers..." value={printerSearch} onChange={(e) => setPrinterSearch(e.target.value)} className="h-9 text-xs" />
              <Select value={printerStatusFilter} onChange={(e) => setPrinterStatusFilter(e.target.value)} className="h-9 w-28 text-xs">
                <option value="all">All</option><option value="online">Online</option><option value="offline">Offline</option>
              </Select>
            </div>
          )}
          {filteredPrinters.length === 0 ? (
            <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title={initialPrinters.length === 0 ? "No printers yet" : "No matching printers"} description={initialPrinters.length === 0 ? "Printers appear here as soon as an online agent reports them." : "Try adjusting your search criteria."} />
          ) : (
            <div className="max-h-[36rem] space-y-3 overflow-auto pr-1">
              {filteredPrinters.map((printer) => (
                <div key={printer.id} className="card card-interactive p-4 shadow-none">
                  <div className="flex items-center justify-between gap-2"><h3 className="truncate text-sm font-semibold text-ink">{printer.name}</h3><StatusBadge tone={printerTone(printer.status)} label={printer.status.charAt(0).toUpperCase() + printer.status.slice(1)} /></div>
                  <div className="mt-2 space-y-1.5 text-xs text-ink-2">
                    <div className="flex items-center gap-1.5">{printer.connectionType === "usb" ? <HardDrive className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <Network className="h-3.5 w-3.5 text-ink-3" aria-hidden />}<span className="font-mono text-[11px] uppercase">{printer.connectionType} · {printer.printerType}</span></div>
                    <p className="text-ink-3">Agent: {agentsById.get(printer.agentId)?.name || printer.agentId}</p>
                    <p className="text-ink-3">Lifecycle: {printer.lifecycle}</p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button variant="secondary" size="sm" onClick={() => handleTestConnection(printer.id)} disabled={isLoading || printer.lifecycle !== "active"}>Test Probe</Button>
                    <Button variant="primary" size="sm" onClick={() => handleTestPrint(printer.id)} disabled={isLoading || printer.lifecycle !== "active"}>Test Print</Button>
                  </div>
                  {printer.lifecycle !== "retired" && <div className="mt-2.5 flex justify-end gap-2 border-t border-edge pt-2">{printer.lifecycle === "active" && <Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ printer, lifecycle: "disabled" })}>Disable</Button>}{printer.lifecycle === "disabled" && <Button variant="ghost" size="sm" onClick={async () => { setIsLoading(true); try { await setPrinterLifecycle(printer.id, "active"); window.location.reload(); } catch (err) { setNotice({ text: err instanceof Error ? err.message : "Failed to enable printer", type: "error" }); } finally { setIsLoading(false); } }}>Enable</Button>}<Button variant="ghost" size="sm" onClick={() => setPendingLifecycle({ printer, lifecycle: "retired" })}>Retire</Button></div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden lg:col-span-1">
        <CardHeader title="Network Discovery" subtitle="Scan local network for physical printers" icon={<Network className="h-5 w-5 text-brand" aria-hidden />} />
        <div className="px-6 pb-6"><DiscoveryPanel agents={initialAgents} branchesById={branchesById} /></div>
      </Card>

      <Card className="overflow-hidden lg:col-span-3">
        <CardHeader title="Recent Print Queue" subtitle="Latest jobs routed through the cloud gateway" icon={<Clock className="h-5 w-5 text-brand" aria-hidden />} actions={<div className="w-48 sm:w-64"><Input placeholder="Search queue by job ID..." value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} className="h-9 text-xs" /></div>} />
        <div className="space-y-2 px-6 pb-6">
          {filteredJobs.length === 0 ? <EmptyState icon={<Clock className="h-8 w-8" />} title="No jobs in queue" description="Jobs submitted via API or Odoo will appear here." /> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="table-head border-y border-edge text-left"><th className="px-4 py-3">Job ID</th><th className="px-4 py-3">Printer</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Created</th></tr></thead><tbody>{filteredJobs.map((job) => <tr key={job.id} className="row-hover border-b border-edge last:border-0"><td className="px-4 py-3.5 font-mono text-xs"><Mono>{job.id}</Mono></td><td className="px-4 py-3.5 text-xs font-medium text-ink-2">{initialPrinters.find((p) => p.id === job.printerId)?.name || job.printerId}</td><td className="px-4 py-3.5"><StatusBadge tone={jobTone(job.status)} label={job.status === "success" ? "Completed" : job.status.charAt(0).toUpperCase() + job.status.slice(1)} /></td><td className="px-4 py-3.5 text-right text-xs text-ink-3">{format(new Date(job.createdAt), "HH:mm:ss")}</td></tr>)}</tbody></table></div>
          )}
        </div>
      </Card>

      <Modal
        open={!!pendingLifecycle}
        onClose={() => setPendingLifecycle(null)}
        title={`${pendingLifecycle?.lifecycle === "retired" ? "Retire" : "Disable"} ${pendingLifecycle?.agent ? "agent" : "printer"} “${pendingLifecycle?.agent?.name ?? pendingLifecycle?.printer?.name ?? ""}”?`}
        description="This preserves the resource and its audit log. New printing is blocked while disabled or retired."
        footer={<><Button variant="secondary" onClick={() => setPendingLifecycle(null)}>Cancel</Button><Button variant="danger" onClick={handleLifecycle}>{pendingLifecycle?.lifecycle === "retired" ? "Retire" : "Disable"}</Button></>}
      >
        <p className="text-sm text-ink-2">Note: Retirement is permanent and cannot be reversed.</p>
      </Modal>

      <Modal
        open={!!pendingDeleteAgent}
        onClose={() => { if (!deleteBusy) setPendingDeleteAgent(null); }}
        title={`Delete agent “${pendingDeleteAgent?.name ?? ""}”?`}
        description="This is a permanent removal for an unused agent."
        footer={<><Button variant="secondary" onClick={() => setPendingDeleteAgent(null)} disabled={deleteBusy}>Cancel</Button><Button variant="danger" onClick={handleDeleteAgent} loading={deleteBusy} icon={<Trash2 className="h-4 w-4" />}>Delete agent</Button></>}
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p>This action is available only when the agent is offline and has no printers or print history.</p>
          <p>Agents with operational history must be retired instead so audit and print records remain intact.</p>
        </div>
      </Modal>

      <Toast toast={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
