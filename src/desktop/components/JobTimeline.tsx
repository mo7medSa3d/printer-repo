import React from "react";
import { deriveOutcome, jobLabel } from "../lib/printers";

type TimelineProps = {
  status: string;
  error?: string | null;
  claimedAt?: string | null;
};

/**
 * Queued → Claimed → Printing → Outcome pipeline for a print job.
 *
 * Steps are marked reached from EVIDENCE (the claimedAt timestamp, the
 * status, and unknown-outcome markers), not from the terminal state alone:
 * a job that failed pre-dispatch never shows "Claimed ✓ Printing ✓" like a
 * job that really printed.
 */
export function JobTimeline({ status, error = null, claimedAt = null }: TimelineProps) {
  const s = String(status).toLowerCase();
  const outcome = deriveOutcome(s, error);
  const done = s === "success";
  const failed = s === "failed" || s === "expired";
  const unknown = outcome === "unknown";

  const reachedQueued = true;
  const reachedClaimed = Boolean(claimedAt) || ["claimed", "printing", "success"].includes(s) || (failed && unknown);
  const reachedPrinting = ["printing", "success"].includes(s) || (failed && unknown);

  const steps = [
    { label: "Queued", reached: reachedQueued },
    { label: "Claimed", reached: reachedClaimed },
    { label: "Printing", reached: reachedPrinting },
  ].map((step, i) => {
    const current =
      (step.label === "Claimed" && s === "claimed") ||
      (step.label === "Printing" && s === "printing");
    return {
      ...step,
      current,
      state: current && !done && !(failed || unknown) ? "current" : step.reached ? "done" : "todo",
      n: i + 1,
    } as const;
  });

  const terminalLabel = done || failed || unknown ? jobLabel(s, outcome) : "Outcome";
  const terminalTone = done ? "ok" : unknown ? "warn" : failed ? "bad" : "todo";

  return (
    <div
      className="rounded-xl border border-edge-accent bg-surface-accent px-5 py-4"
      role="img"
      aria-label={`Job pipeline: ${terminalLabel}`}
    >
      <ol className="flex items-start">
        {steps.map((step, i) => (
          <li key={step.label} className="flex flex-1 items-start">
            {i > 0 && (
              <span
                aria-hidden
                className={`mt-[13px] h-0.5 flex-1 ${steps[i - 1].reached && step.reached ? "bg-ok-solid/50" : "bg-edge-strong"}`}
              />
            )}
            <span className="flex flex-col items-center gap-2 px-1" aria-hidden>
              <span
                className={`flex h-[26px] w-[26px] items-center justify-center rounded-full border text-[12px] font-bold transition-colors ${
                  step.state === "current"
                    ? "border-brand bg-brand text-brand-contrast shadow-[var(--focus-ring-shadow)]"
                    : step.state === "done"
                    ? "border-ok-edge bg-ok-solid text-on-solid"
                    : "border-edge-strong bg-surface text-ink-4"
                }`}
              >
                {step.state === "done" ? "✓" : step.n}
              </span>
              <span
                className={`min-w-max text-center text-[12px] font-semibold ${
                  step.state === "current"
                    ? "text-ink"
                    : step.state === "done"
                    ? "text-ok"
                    : "text-ink-3"
                }`}
              >
                {step.label}
              </span>
            </span>
          </li>
        ))}
        <li className="flex flex-1 items-start">
          <span
            aria-hidden
            className={`mt-[13px] h-0.5 flex-1 ${done || failed || unknown ? "bg-ok-solid/50" : "bg-edge-strong"}`}
          />
          <span className="flex flex-col items-center gap-2 px-1" aria-hidden>
            <span
              className={`flex h-[26px] w-[26px] items-center justify-center rounded-full border text-[12px] font-bold transition-colors ${
                terminalTone === "ok"
                  ? "border-ok-edge bg-ok-solid text-on-solid"
                  : terminalTone === "warn"
                  ? "border-warn-edge bg-warn-solid text-on-solid"
                  : terminalTone === "bad"
                  ? "border-bad-edge bg-bad-solid text-on-solid"
                  : "border-edge-strong bg-surface text-ink-4"
              }`}
            >
              {done ? "✓" : failed || unknown ? (unknown ? "?" : "✕") : ""}
            </span>
            <span
              className={`min-w-max text-center text-[12px] font-semibold ${
                terminalTone === "ok" ? "text-ok" : terminalTone === "bad" ? "text-bad" : terminalTone === "warn" ? "text-warn" : "text-ink-3"
              }`}
            >
              {terminalLabel}
            </span>
          </span>
        </li>
      </ol>
    </div>
  );
}
