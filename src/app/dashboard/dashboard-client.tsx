"use client";

import { useMemo, useState } from "react";

// ... existing imports and component code remain unchanged above ...

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
      setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, candidateStatus: "verified", verification: "verified", confidence: "high" } : d));
      setMsg(`Candidate ${deviceId.slice(0, 16)}… approved. It can now be provisioned.`);
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
