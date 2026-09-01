"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, Mono } from "@/components/ui";

/**
 * Branded error boundary for the web console. Presentation only — it renders
 * whatever Next.js already decided was an error and calls the reset() handler
 * Next provides. No error handling semantics are changed here.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="canvas-wash min-h-[calc(100vh-4rem)]">
      <div className="container mx-auto flex max-w-xl flex-col px-4 py-20 sm:py-28">
        <div className="card w-full p-8" role="alert">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-bad-edge bg-bad-bg text-bad">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </div>
          <p className="label-caps mt-5">Unexpected error</p>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.015em] text-ink">
            The console couldn’t finish loading this view
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Agents, printers and queued jobs are unaffected — this is a display failure in the
            management console only. Retry the view, or check the gateway health endpoint if it
            keeps happening.
          </p>
          {error?.digest && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-edge bg-surface-2 px-3 py-2">
              <span className="label-caps">Digest</span>
              <Mono>{error.digest}</Mono>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => reset()} icon={<RefreshCw className="h-4 w-4" />}>
              Try again
            </Button>
            <Link
              href="/dashboard"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-edge bg-surface px-3.5 text-sm font-semibold text-ink shadow-xs transition-colors duration-150 hover:border-edge-strong hover:bg-surface-2 focusable"
            >
              Back to console
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
