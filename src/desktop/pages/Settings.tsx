import React from "react";
import {
  Activity,
  ChevronRight,
  KeyRound,
  Link2,
  Play,
  Power,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  Copy,
} from "lucide-react";
import {
  Button,
  Card,
  CopyButton,
  ErrorState,
  Field,
  Input,
  StatusBadge,
  StatusDot,
} from "../../components/ui";
import { SettingsSection } from "../ui";
import type { DesktopState } from "../types";
import { friendlyPrinterError, labelPrinter } from "../lib/printers";
import { getAutostart, setAutostart } from "../lib/ipc";

export function SettingsPage({ s }: { s: DesktopState }) {
  const anyStatus = s.agentStatus as Record<string, unknown> | null;

  const paths: [string, string][] = s.runtimePaths
    ? [
        ["Manager data", s.runtimePaths.manager_data],
        ["Settings", s.runtimePaths.settings],
        ["Agent config", s.runtimePaths.agent_config],
        ["Manager log", s.runtimePaths.manager_log],
        ["Agent data", s.runtimePaths.agent_data],
      ]
    : [];

  return (
    <div className="space-y-7">
      <div className="grid gap-7 xl:grid-cols-2">
        <SettingsSection
          title="Gateway connection"
          description="Where the agent reports and receives jobs"
          icon={<Link2 className="h-5 w-5" aria-hidden />}
        >
          <div className="flex flex-col gap-4 rounded-xl border border-edge-accent bg-surface-accent p-5 sm:flex-row sm:items-center">
            <StatusDot
              tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"}
              pulse={s.gatewayConnected}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold leading-tight text-ink">
                {s.gatewayConnected ? "Connected" : s.gatewayUrl ? "Not reachable" : "Not configured"}
              </div>
              <div className="truncate text-[13px] text-ink-3">
                {s.gatewayUrl || "Enter the gateway URL below"}
              </div>
            </div>
            <StatusBadge
              tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"}
              label={s.gatewayConnected ? "Online" : s.gatewayUrl ? "Offline" : "Not set"}
            />
          </div>

          <Field
            label="Gateway URL"
            htmlFor="gw-url"
            hint="Base URL of the Odoo Print Gateway, e.g. https://print.example.com"
          >
            <Input
              id="gw-url"
              value={s.gatewayUrl}
              onChange={(e) => s.setGw(e.target.value)}
              placeholder="https://gateway.example.com"
            />
          </Field>

          <div className="flex flex-wrap justify-end gap-3">
            <Button
              variant="secondary"
              onClick={s.checkHealth}
              icon={<Activity className="h-[18px] w-[18px]" />}
            >
              Check connection
            </Button>
            <Button
              variant="primary"
              onClick={s.saveGateway}
              loading={s.gatewaySaving}
              icon={<Link2 className="h-[18px] w-[18px]" />}
            >
              Save connection
            </Button>
          </div>

          {s.healthError && (
            <ErrorState
              title="Gateway check failed"
              message={friendlyPrinterError(s.healthError)}
              retry={s.checkHealth}
            />
          )}
        </SettingsSection>

        <SettingsSection
          title="Local agent"
          description="The Windows service that talks to printers on this PC"
          icon={<Server className="h-5 w-5" aria-hidden />}
        >
          <div className="flex flex-col gap-4 rounded-xl border border-edge-accent bg-surface-accent p-5 sm:flex-row sm:items-center">
            <StatusDot tone={s.isOnline ? "ok" : "bad"} pulse={s.isOnline} />
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold leading-tight text-ink">
                {s.isOnline ? "Agent online" : "Agent stopped"}
              </div>
              <div className="truncate text-[13px] text-ink-3">
                {String(anyStatus?.hostname || "This PC")}
              </div>
            </div>
            <StatusBadge
              tone={s.isOnline ? "ok" : "bad"}
              label={s.isOnline ? "Running" : "Stopped"}
            />
          </div>

          <div>
            <div className="mb-3 text-[13px] font-semibold text-ink">Service control</div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="primary"
                onClick={s.startAgent}
                icon={<Play className="h-[18px] w-[18px]" />}
              >
                Start
              </Button>
              <Button
                variant="secondary"
                onClick={s.requestStopAgent}
                icon={<Square className="h-[18px] w-[18px]" />}
              >
                Stop
              </Button>
              <Button
                variant="ghost"
                onClick={s.restartAgent}
                icon={<RotateCcw className="h-[18px] w-[18px]" />}
              >
                Restart
              </Button>
            </div>
          </div>

          <div className="section-rule pt-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <Power className="mt-0.5 h-5 w-5 flex-shrink-0 text-ink-3" aria-hidden />
                <div>
                  <div className="text-[14px] font-semibold text-ink">Start with Windows</div>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
                    Launch the agent automatically when you sign in.
                  </p>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={!!s.autostart}
                aria-busy={s.autostart === null}
                disabled={s.autostart === null}
                aria-label="Start agent with Windows"
                title={s.autostart === null ? "Checking current setting..." : undefined}
                onClick={async () => {
                  if (s.autostart === null) return;
                  const next = !s.autostart;
                  const res = await setAutostart(next);
                  s.setMsg({ text: next ? "Launch at sign-in turned on." : "Launch at sign-in turned off.", type: "success" });
                  const st = await getAutostart();
                  s.setAutostartState(st.enabled);
                }}
                className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] ${
                  s.autostart ? "bg-brand" : "bg-surface-3"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow-xs transition-transform ${
                    s.autostart ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </SettingsSection>
      </div>

      {/* Pair Agent Hero Card */}
      <Card className="overflow-hidden border-2 border-brand/20">
        <div className="flex items-start justify-between gap-4 border-b border-edge bg-surface px-6 py-5">
          <div className="flex items-start gap-3.5">
            <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">Pair agent</h2>
              <p className="mt-1 text-[13px] text-ink-3">Connect this PC to the gateway as a managed edge print agent</p>
            </div>
          </div>
          <StatusBadge
            label={s.isOnline ? (s.gatewayConnected ? "Agent Running" : "Agent Running - Gateway Unreachable") : "Agent Stopped"}
            tone={s.isOnline ? (s.gatewayConnected ? "ok" : "warn") : "neutral"}
          />
        </div>
        <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <ol className="space-y-3 text-[14px] text-ink-2">
            {[
              "Configure and save the Gateway URL above.",
              "Generate a 6-character pairing code from the Central Gateway dashboard or Odoo 19 wizard.",
              "Enter the code below — credentials are securely persisted to Windows DPAPI / agent config.",
            ].map((step, i) => (
              <li key={step} className="flex items-center gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-brand-contrast">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Field label="6-Digit Pairing Code" htmlFor="pair-code" className="flex-1">
              <div className="flex items-center gap-2">
                <Input
                  id="pair-code"
                  value={s.pairCode}
                  onChange={(e) => s.setPairCode(e.target.value.toUpperCase())}
                  placeholder="AB12CD"
                  maxLength={6}
                  className="text-center font-mono text-[18px] font-bold uppercase tracking-[0.4em]"
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  onClick={s.pair}
                  loading={s.busy}
                  disabled={!s.pairCode.trim() || s.pairCode.trim().length !== 6}
                  icon={<ShieldCheck className="h-[18px] w-[18px]" />}
                >
                  Pair
                </Button>
              </div>
            </Field>
          </div>
        </div>
      </Card>

      {/* Current Status Snapshot */}
      <Card className="overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-edge bg-surface px-6 py-5">
          <div>
            <h2 className="text-[17px] font-semibold leading-tight text-ink">Current Status</h2>
            <p className="mt-1 text-[13px] text-ink-3">
              A live snapshot of this PC&apos;s agent and devices - not a log stream. The full agent log lives at the path below.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const report = [
                  `=== Odoo Print Agent Diagnostic Export ===`,
                  `Generated At: ${new Date().toISOString()}`,
                  `App Version: ${s.version || "1.0.0"}`,
                  `Agent Running: ${s.isOnline}`,
                  `Gateway URL: ${s.gatewayUrl || "Not configured"}`,
                  `Gateway Reachable: ${s.gatewayConnected}`,
                  `Last Heartbeat: ${s.lastHeartbeat || "None"}`,
                  `Printers Count: ${s.printers.length}`,
                  `Pending Jobs: ${s.pendingJobs}, Failed Jobs: ${s.failedJobs}`,
                  ``,
                  `=== Discovered Printers ===`,
                  ...s.printers.map((p) => ` - ${p.name} [${p.status}] (${p.printer_type || p.device_class || "unknown"}, ${p.connection_type})`),
                  ``,
                  `=== Runtime Paths ===`,
                  ...paths.map(([k, v]) => ` - ${k}: ${v}`),
                ].join("\n");

                navigator.clipboard.writeText(report).then(() => {
                  s.setMsg({ text: "Status summary copied to clipboard", type: "success" });
                }).catch(() => {
                  s.setMsg({ text: "Unable to copy the status summary", type: "error" });
                });
              }}
              icon={<Copy className="h-3.5 w-3.5" />}
            >
              Copy Status Summary
            </Button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="max-h-64 overflow-y-auto rounded-xl border border-edge bg-surface-2 p-4 text-[13px] shadow-inner space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink-2">Agent service</span>
              <span className={s.isOnline ? "font-semibold text-ok" : "font-semibold text-bad"}>
                {s.isOnline ? "Running" : "Stopped"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink-2">Gateway</span>
              <span className={s.gatewayConnected ? "font-semibold text-ok" : "font-semibold text-warn"}>
                {s.gatewayConnected ? "Reachable" : s.gatewayUrl ? "Failed last check" : "Not configured"}
              </span>
            </div>
            {s.healthError && (
              <div className="rounded-lg border border-bad-edge bg-bad-bg px-3 py-2 text-[12px] text-bad">
                Gateway health check failed: {friendlyPrinterError(s.healthError)}
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink-2">Devices reported</span>
              <span className="font-semibold text-ink">{s.printers.length}</span>
            </div>
            {s.printers.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-surface px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-ink-2">{p.name}</span>
                <span className={`flex-shrink-0 font-semibold ${p.status === "online" ? "text-ok" : p.status === "offline" || p.status === "error" ? "text-bad" : "text-warn"}`}>
                  {labelPrinter(p.status)}
                </span>
              </div>
            ))}
            {s.printers.length === 0 && (
              <p className="text-[12px] text-ink-3">
                No devices reported yet. Run discovery on the Printers page.
              </p>
            )}
            {paths.length > 0 && (
              <div className="pt-1 text-[12px] text-ink-3">
                Agent log: <span className="font-mono break-all">{paths.find(([k]) => k.toLowerCase().includes("log"))?.[1] ?? "see Data locations below"}</span>
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <button
          onClick={() => s.setAdvancedOpen(!s.advancedOpen)}
          className="flex w-full items-center justify-between px-6 py-5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)]"
          aria-expanded={s.advancedOpen}
        >
          <span className="text-[17px] font-semibold text-ink">Advanced</span>
          <ChevronRight className={`h-5 w-5 text-ink-3 transition-transform ${s.advancedOpen ? "rotate-90" : ""}`} aria-hidden />
        </button>
        {s.advancedOpen && (
          <div className="grid gap-7 border-t border-edge px-6 py-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Security</div>
              <p className="text-[13px] leading-relaxed text-ink-2">
                Pairing uses a one-time code; credentials are stored in the agent config with OS-level protection and never displayed here.
              </p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-ok-edge bg-ok-bg px-3.5 py-2.5 text-[13px] font-medium text-ok">
                <ShieldCheck className="h-[18px] w-[18px]" aria-hidden />
                Credentials stay on this PC
              </div>
            </div>
            <div>
              <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Data locations</div>
              {paths.length > 0 ? (
                <div className="space-y-2">
                  {paths.map(([label, path]) => (
                    <div key={label} className="flex items-center gap-2 rounded-lg border border-edge bg-surface-2 px-3.5 py-2.5">
                      <span className="w-28 flex-shrink-0 text-[13px] font-semibold text-ink-2">{label}</span>
                      <span className="flex-1 truncate font-mono text-[12px] text-ink-3">{path}</span>
                      <CopyButton
                        value={path}
                        label="Copy"
                        onCopied={() => s.setMsg({ text: "Copied to clipboard", type: "success" })}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-ink-3">Loading paths…</p>
              )}
              <p className="mt-5 text-[13px] text-ink-3">Odoo Print Manager · v{s.version || "1.0.0"} · © 2026 Odoo Print</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
