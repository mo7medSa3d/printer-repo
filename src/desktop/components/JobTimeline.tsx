import React from "react";
import { labelJob } from "../lib/printers";

/**
 * Queued → Claimed → Printing → Outcome pipeline for a print job.
 * Larger than the previous version: the labels are legible at a glance and
 * the step numbers stay readable at small widths.
 */
export function JobTimeline({ status }: { status: string }) {
  const s = String(status).toLowerCase();
  const flow = ["queued", "claimed", "printing"] as const;
  const done = s === "success" || s === "completed";
  const failed = s === "failed" || s === "expired";
  const idx = flow.indexOf(s as (typeof flow)[number]);
  const terminalLabel = done ? "Completed" : failed ? "Failed" : "Outcome";

  const steps = flow.map((step, i) => {
    const current = idx === i;
    const reached = done || failed || idx > i;
    return {
      label: step,
      state: current && !done && !failed ? "current" : reached ? "done" : "todo",
      n: i + 1,
    } as const;
  });

  return (
    <div
      className="rounded-xl border border-edge-accent bg-surface-accent px-5 py-4"
      role="img"
      aria-label={`Job pipeline: ${labelJob(status)}`}
    >
      <ol className="flex items-start">
        {steps.map((step, i) => (
          <li key={step.label} className="flex flex-1 items-start">
            {i > 0 && (
              <span
                aria-hidden
                className={`mt-[13px] h-0.5 flex-1 ${
                  idx >= i || done || failed ? "bg-ok-solid/50" : "bg-edge-strong"
                }`}
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
                className={`min-w-max text-center text-[12px] font-semibold capitalize ${
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
            className={`mt-[13px] h-0.5 flex-1 ${
              done || failed ? "bg-ok-solid/50" : "bg-edge-strong"
            }`}
          />
          <span className="flex flex-col items-center gap-2 px-1" aria-hidden>
            <span
              className={`flex h-[26px] w-[26px] items-center justify-center rounded-full border text-[12px] font-bold transition-colors ${
                done
                  ? "border-ok-edge bg-ok-solid text-on-solid"
                  : failed
                  ? "border-bad-edge bg-bad-solid text-on-solid"
                  : "border-edge-strong bg-surface text-ink-4"
              }`}
            >
              {done ? "✓" : failed ? "✕" : ""}
            </span>
            <span
              className={`min-w-max text-center text-[12px] font-semibold ${
                done ? "text-ok" : failed ? "text-bad" : "text-ink-3"
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
