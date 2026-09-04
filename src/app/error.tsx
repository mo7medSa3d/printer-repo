"use client";

import { AlertTriangle, LayoutDashboard } from "lucide-react";
import { Button, Mono } from "@/components/ui";

/**
 * Branded error boundary for the web console.
 * Recovery is deliberately navigation-based so the production gateway
 * does not expose a misleading in-app retry control.
 */
export default function GlobalError({
  error,
  reset: _reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center bg-app py-12">
      <div className="mx-auto flex w-full max-w-xl flex-col px-4">
        <div className="card w-full p-8 shadow-md" role="alert">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-bad-edge bg-bad-bg text-bad">
            <AlertTriangle className="h-6 w-6" aria-hidden />
          </div>
          <p className="label-caps mt-5">Unexpected error</p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.015em] text-ink">
            The console couldn’t finish loading this view
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Agents, printers and queued jobs are unaffected. Return to the management console or
            check the gateway health endpoint if the problem persists.
          </p>
          {error?.digest && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-edge bg-surface-2 px-3 py-2">
              <span className="label-caps">Digest</span>
              <Mono>{error.digest}</Mono>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button variant="secondary" href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>
              Back to console
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
