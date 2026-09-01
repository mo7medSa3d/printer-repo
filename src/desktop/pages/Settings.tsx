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
} from "lucide-react";
import {
  Button,
  Card,
  CopyButton,
  ErrorState,
  Field,
  Input,
  Mono,
  StatusBadge,
  StatusDot,
} from "@/components/ui";
import { SettingsSection } from "../ui";
import type { DesktopState } from "../types";
import { friendlyPrinterError } from "../lib/printers";

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
        {/* ---------- Gateway ---------- */}
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

        {/* ---------- Local agent ---------- */}
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
                  <div className="text-[14px] font-semibold text-ink">
                    Start with Windows
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
                    Launch the agent automatically when you sign in.
                  </p>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={!!s.autostart}
                aria-label="Start agent with Windows"
                onClick={async () => {
                  if (s.autostart === null) return;
                  const { setAutostart, getAutostart } = await import("../lib/ipc");
                  const res = await setAutostart(!s.autostart);
                  s.setMsg({ text: res, type: "success" });
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

      {/* ---------- Pairing ---------- */}
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3.5 border-b border-edge bg-surface px-6 py-5">
          <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
            <KeyRound className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              Pair agent
            </h2>
            <p className="mt-1 text-[13px] text-ink-3">
              Connect this PC to the gateway as a print agent
            </p>
          </div>
        </div>
        <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <ol className="space-y-3 text-[14px] text-ink-2">
            {[
              "Save the gateway URL above.",
              "Generate a pairing code on the gateway dashboard.",
              "Enter it here — the agent registers and stays paired.",
            ].map((step, i) => (
              <li key={step} className="flex items-center gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-brand-contrast">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <div className="flex w-full max-w-sm items-end gap-3">
            <Field label="Pairing code" htmlFor="pair-code" className="flex-1">
              <Input
                id="pair-code"
                value={s.pairCode}
                onChange={(e) => s.setPairCode(e.target.value.toUpperCase())}
                placeholder="AB12CD"
                maxLength={6}
                className="text-center font-mono text-[15px] uppercase tracking-[0.3em]"
                autoComplete="off"
              />
            </Field>
            <Button
              variant="primary"
              onClick={s.pair}
              loading={s.busy}
              icon={<ShieldCheck className="h-[18px] w-[18px]" />}
            >
              Pair agent
            </Button>
          </div>
        </div>
      </Card>

      {/* ---------- Advanced ---------- */}
      <Card className="overflow-hidden">
        <button
          onClick={() => s.setAdvancedOpen(!s.advancedOpen)}
          className="flex w-full items-center justify-between px-6 py-5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)]"
          aria-expanded={s.advancedOpen}
        >
          <span className="text-[17px] font-semibold text-ink">Advanced</span>
          <ChevronRight
            className={`h-5 w-5 text-ink-3 transition-transform ${
              s.advancedOpen ? "rotate-90" : ""
            }`}
            aria-hidden
          />
        </button>
        {s.advancedOpen && (
          <div className="grid gap-7 border-t border-edge px-6 py-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Security
              </div>
              <p className="text-[13px] leading-relaxed text-ink-2">
                Pairing uses a one-time code; credentials are stored in the agent config with
                OS-level protection and never displayed here.
              </p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-ok-edge bg-ok-bg px-3.5 py-2.5 text-[13px] font-medium text-ok">
                <ShieldCheck className="h-[18px] w-[18px]" aria-hidden />
                Credentials stay on this PC
              </div>
            </div>
            <div>
              <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Data locations
              </div>
              {paths.length > 0 ? (
                <div className="space-y-2">
                  {paths.map(([label, path]) => (
                    <div
                      key={label}
                      className="flex items-center gap-2 rounded-lg border border-edge bg-surface-2 px-3.5 py-2.5"
                    >
                      <span className="w-28 flex-shrink-0 text-[13px] font-semibold text-ink-2">
                        {label}
                      </span>
                      <span className="flex-1 truncate font-mono text-[12px] text-ink-3">
                        {path}
                      </span>
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
              <p className="mt-5 text-[13px] text-ink-3">
                Odoo Print Manager · v{s.version || "1.0.0"} · © 2026 Odoo Print
              </p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
