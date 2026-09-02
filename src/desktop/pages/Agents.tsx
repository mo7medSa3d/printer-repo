import React from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Square,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  CopyButton,
  EmptyState,
  ErrorState,
  Mono,
  StatusBadge,
  StatusDot,
} from "@/components/ui";
import { DetailList, StatCard } from "../ui";
import type { DesktopState } from "../types";
import { friendlyPrinterError, isProductionPrinter } from "../lib/printers";

export function AgentsPage({ s }: { s: DesktopState }) {
  const anyStatus = s.agentStatus as Record<string, unknown> | null;
  const physical = s.printers.filter(isProductionPrinter);
  const online = physical.filter((p) => p.status === "online").length;
  const attention = physical.filter(
    (p) => p.status === "offline" || p.status === "error"
  ).length;

  return (
    <div className="space-y-7">
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Local agent"
          value={s.isOnline ? "Online" : "Offline"}
          sub={String(anyStatus?.hostname || "This PC")}
          tone={s.isOnline ? "ok" : "bad"}
          icon={<Cpu className="h-[22px] w-[22px]" aria-hidden />}
        />
        <StatCard
          label="Printers on this PC"
          value={`${online} / ${physical.length}`}
          sub={attention > 0 ? `${attention} need attention` : "Online"}
          tone={physical.length > 0 && attention === 0 ? "ok" : physical.length === 0 ? "neutral" : "warn"}
          icon={<HardDrive className="h-[22px] w-[22px]" aria-hidden />}
        />
        <StatCard
          label="Gateway fleet"
          value={s.gatewayUrl ? `${s.fleetOnline} / ${s.fleetTotal}` : "—"}
          sub={s.gatewayUrl ? "Agents online" : "Gateway not configured"}
          tone={s.gatewayUrl && s.fleetOnline > 0 ? "ok" : "neutral"}
          icon={<Server className="h-[22px] w-[22px]" aria-hidden />}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* ---------- This PC ---------- */}
        <Card className="overflow-hidden">
          <CardHeader
            title="This PC agent"
            subtitle="The agent this desktop app supervises"
            icon={<Cpu className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={s.refreshStatus}
                icon={<RefreshCw className="h-4 w-4" />}
              >
                Refresh
              </Button>
            }
          />
          <div className="space-y-5 px-6 pb-6">
            <div className="flex flex-col gap-4 rounded-xl border border-edge-accent bg-surface-accent p-5 sm:flex-row sm:items-center">
              <StatusDot tone={s.isOnline ? "ok" : "bad"} pulse={s.isOnline} />
              <div className="min-w-0 flex-1">
                <div className="text-[17px] font-semibold leading-tight text-ink">
                  {s.isOnline ? "Agent running" : "Agent stopped"}
                </div>
                <div className="truncate text-[13px] text-ink-3">
                  {String(anyStatus?.hostname || "This PC")}
                </div>
              </div>
              <StatusBadge
                tone={s.isOnline ? "ok" : "bad"}
                label={s.isOnline ? "Online" : "Offline"}
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="primary"
                onClick={s.startAgent}
                icon={<Play className="h-4 w-4" />}
              >
                Start
              </Button>
              <Button
                variant="secondary"
                onClick={s.requestStopAgent}
                icon={<Square className="h-4 w-4" />}
              >
                Stop
              </Button>
              <Button
                variant="ghost"
                onClick={s.restartAgent}
                icon={<RotateCcw className="h-4 w-4" />}
              >
                Restart
              </Button>
            </div>

            <DetailList
              rows={[
                {
                  label: "Last heartbeat",
                  value: (
                    <Mono>
                      {s.lastHeartbeat
                        ? new Date(s.lastHeartbeat).toLocaleString()
                        : "—"}
                    </Mono>
                  ),
                },
                {
                  label: "Service",
                  value: String(anyStatus?.service || "Windows service"),
                },
                {
                  label: "Version",
                  value: <Mono>{String(anyStatus?.version || s.version || "1.0.0")}</Mono>,
                },
                {
                  label: "Hostname",
                  value: <Mono>{String(anyStatus?.hostname || "—")}</Mono>,
                },
                {
                  label: "Printers",
                  value: `${online}/${physical.length} online · ${attention} attention`,
                },
              ]}
            />

            {anyStatus?.note ? (
              <p className="inset-panel px-4 py-3 text-[13px] leading-relaxed text-ink-2">
                {String(anyStatus.note)}
              </p>
            ) : null}
            {anyStatus?.error ? (
              <ErrorState
                title="Agent status unavailable"
                message={String(anyStatus.error)}
                retry={s.refreshStatus}
              />
            ) : null}
          </div>
        </Card>

        {/* ---------- Gateway fleet ---------- */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Gateway fleet"
            subtitle={`Agents registered with ${s.gatewayUrl ? "the gateway" : "no gateway configured"}`}
            icon={<Server className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
            actions={
              s.gatewayUrl ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={s.checkHealth}
                  icon={<Activity className="h-4 w-4" />}
                >
                  Check
                </Button>
              ) : undefined
            }
          />
          <div className="px-6 pb-6">
            {!s.gatewayUrl ? (
              <EmptyState
                icon={<Server className="h-10 w-10" />}
                title="Gateway not configured"
                description="Set the gateway URL in Settings so this agent can register and the fleet can be reported."
                action={
                  <Button
                    variant="primary"
                    onClick={() => s.navigate("settings")}
                    icon={<Settings className="h-4 w-4" />}
                  >
                    Open settings
                  </Button>
                }
              />
            ) : s.healthError ? (
              <ErrorState
                title="Gateway check failed"
                message={friendlyPrinterError(s.healthError)}
                retry={s.checkHealth}
              />
            ) : s.fleetTotal > 0 ? (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="card p-5">
                    <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                      Total agents
                    </div>
                    <div className="mt-2 text-[28px] font-bold leading-none tabular-nums text-ink">
                      {s.fleetTotal}
                    </div>
                  </div>
                  <div className="card p-5">
                    <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                      Online
                      <StatusDot tone={s.fleetOnline > 0 ? "ok" : "bad"} />
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-[28px] font-bold leading-none tabular-nums text-ink">
                        {s.fleetOnline}
                      </span>
                      <span className="text-[13px] text-ink-3">of {s.fleetTotal}</span>
                    </div>
                  </div>
                </div>
                <p className="text-[13px] leading-relaxed text-ink-3">
                  The unauthenticated health probe only reports liveness. Full per-agent
                  management — pairing codes, per-agent printers and status history — is
                  available in the gateway dashboard with a manager session.
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-2 px-4 py-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-3">
                    {s.gatewayUrl}
                  </span>
                  <CopyButton
                    value={s.gatewayUrl}
                    label="Copy"
                    onCopied={() => s.setMsg({ text: "Gateway URL copied", type: "success" })}
                  />
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<Server className="h-10 w-10" />}
                title="Fleet report unavailable"
                description="The gateway is reachable but did not report any agents. Sign in at the gateway dashboard to manage the fleet."
                action={
                  <Button
                    variant="secondary"
                    onClick={s.checkHealth}
                    icon={<RefreshCw className="h-4 w-4" />}
                  >
                    Check again
                  </Button>
                }
              />
            )}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="How agents work"
          subtitle="One agent per machine, many printers per agent"
          icon={<ShieldCheck className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
        />
        <div className="grid gap-5 px-6 pb-6 md:grid-cols-3">
          {[
            {
              title: "Pair once",
              body: "A one-time pairing code from the gateway dashboard registers this PC. The agent keeps its credentials in a protected local config.",
            },
            {
              title: "Print locally",
              body: "The agent claims queued jobs and sends bytes directly to the printer — RAW, ESC/POS, IPP/IPPS, USB or the Windows spooler.",
            },
            {
              title: "Report honestly",
              body: "Heartbeats and job status flow back to the gateway. If the gateway is unreachable the agent keeps its local queue and drains it on reconnect.",
            },
          ].map((c) => (
            <div key={c.title} className="rounded-xl border border-edge p-5">
              <div className="text-[15px] font-semibold text-ink">{c.title}</div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{c.body}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
