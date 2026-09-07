"use client";

import { useState } from "react";
import { createAgent, createTestPrintJob, setAgentLifecycle, setPrinterLifecycle } from "../actions";
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  PauseCircle,
  PlayCircle,
  Printer as PrinterIcon,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import { Button, Card, CardHeader, Field, Input, StatusBadge, agentTone, jobTone, printerTone } from "../../components/ui";

type Agent = {
  id: string;
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
  connectionType: string;
  lifecycle: string;
  status: string;
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
  databaseError,
}: {
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
  databaseError: string | null;
}) {
  const [agentName, setAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage(success);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAgent = async (name: string) => {
    setBusy(true);
    setMessage(null);
    setPairingCode(null);
    setCopied(false);
    try {
      const result = await createAgent(name);
      setPairingCode(result.pairingCode);
      setAgentName("");
      setMessage("Agent created. Enter this code in the Windows Agent application within 30 minutes.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent creation failed");
    } finally {
      setBusy(false);
    }
  };

  const copyPairingCode = async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("Pairing code is ready; copy it manually.");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <Card>
        <CardHeader
          title="Agents"
          subtitle="Runtime machines connected to this Gateway"
          icon={<Activity className="h-5 w-5 text-brand" aria-hidden />}
        />
        <div className="space-y-4 px-6 pb-6">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!agentName.trim()) return;
              void handleCreateAgent(agentName.trim());
            }}
          >
            <Field label="Add runtime agent">
              <div className="flex gap-2">
                <Input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Agent name" disabled={busy || databaseError !== null} />
                <Button type="submit" variant="primary" disabled={busy || !agentName.trim() || databaseError !== null} icon={<Plus className="h-4 w-4" />}>
                  Add
                </Button>
              </div>
            </Field>
          </form>

          {pairingCode ? (
            <div className="rounded-xl border border-brand/30 bg-brand-subtle p-4" role="status" aria-live="polite">
              <div className="text-xs font-semibold uppercase tracking-[0.08em] text-brand">Pairing code</div>
              <div className="mt-2 flex items-center gap-2">
                <code className="rounded-lg bg-white px-3 py-2 text-2xl font-bold tracking-[0.3em] text-ink shadow-xs">{pairingCode}</code>
                <Button type="button" size="sm" variant="secondary" onClick={() => void copyPairingCode()} icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-3">Use this one-time code in the Windows Agent. It expires after 30 minutes.</p>
            </div>
          ) : null}

          <div className="space-y-2">
            {initialAgents.length === 0 ? (
              <p className="text-sm text-ink-3">No runtime agents are registered.</p>
            ) : initialAgents.map((agent) => (
              <div key={agent.id} className="rounded-xl border border-edge p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink">{agent.name}</div>
                    <div className="mt-1 text-xs text-ink-3">{agent.printerCount} runtime printer{agent.printerCount === 1 ? "" : "s"}</div>
                  </div>
                  <StatusBadge label={agent.status} tone={agentTone(agent.status)} />
                </div>
                <div className="mt-3 flex gap-2">
                  {agent.lifecycle === "active" ? (
                    <Button size="sm" variant="secondary" onClick={() => void run(() => setAgentLifecycle(agent.id, "disabled"), "Agent disabled.")} disabled={busy} icon={<PauseCircle className="h-4 w-4" />}>
                      Disable
                    </Button>
                  ) : agent.lifecycle === "disabled" ? (
                    <Button size="sm" variant="secondary" onClick={() => void run(() => setAgentLifecycle(agent.id, "active"), "Agent re-enabled.")} disabled={busy} icon={<PlayCircle className="h-4 w-4" />}>
                      Re-enable
                    </Button>
                  ) : null}
                  {agent.pairingCode ? <span className="rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2">Pairing available</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Runtime Printers"
          subtitle="Printers reported by Agents"
          icon={<PrinterIcon className="h-5 w-5 text-brand" aria-hidden />}
        />
        <div className="space-y-2 px-6 pb-6">
          {initialPrinters.length === 0 ? (
            <p className="text-sm text-ink-3">No runtime printers are available yet.</p>
          ) : initialPrinters.map((printer) => (
            <div key={printer.id} className="rounded-xl border border-edge p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-ink">{printer.name}</div>
                  <div className="mt-1 text-xs text-ink-3">{printer.printerType} · {printer.connectionType}</div>
                </div>
                <StatusBadge label={printer.status} tone={printerTone(printer.status)} />
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void run(() => createTestPrintJob(printer.id), "Test print queued.")} disabled={busy || printer.lifecycle !== "active"} icon={<CheckCircle2 className="h-4 w-4" />}>
                  Test Print
                </Button>
                {printer.lifecycle === "active" ? (
                  <Button size="sm" variant="secondary" onClick={() => void run(() => setPrinterLifecycle(printer.id, "disabled"), "Printer disabled.")} disabled={busy}>Disable</Button>
                ) : printer.lifecycle === "disabled" ? (
                  <Button size="sm" variant="secondary" onClick={() => void run(() => setPrinterLifecycle(printer.id, "active"), "Printer re-enabled.")} disabled={busy}>Re-enable</Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recent Print Jobs"
          subtitle="Runtime execution state"
          icon={<Server className="h-5 w-5 text-brand" aria-hidden />}
        />
        <div className="px-6 pb-6">
          {initialJobs.length === 0 ? (
            <p className="text-sm text-ink-3">No print jobs yet.</p>
          ) : (
            <div className="space-y-2">
              {initialJobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{job.status}</div>
                    <div className="truncate text-xs text-ink-3">Printer runtime: {job.printerId}</div>
                  </div>
                  <StatusBadge label={job.status} tone={jobTone(job.status)} />
                </div>
              ))}
            </div>
          )}
          <Button className="mt-4" variant="secondary" onClick={() => window.location.reload()} icon={<RefreshCw className="h-4 w-4" />}>
            Refresh
          </Button>
        </div>
      </Card>

      {message ? <div role="status" className="xl:col-span-3 rounded-xl border border-edge bg-surface-2 px-4 py-3 text-sm text-ink-2">{message}</div> : null}
    </div>
  );
}
