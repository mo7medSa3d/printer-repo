"use client";
import { cn } from "@/lib/utils";

/**
 * Legacy status pill kept for compatibility with server-rendered lists.
 * Colours come from the shared status tokens (see src/app/globals.css) —
 * never from raw palette utilities — so every surface reads the same.
 */
export function StatusDot({ status, label }: { status: string; label?: string }) {
  const color =
    status === "online" || status === "success" ? "bg-ok-solid" :
    status === "offline" || status === "failed" || status === "error" ? "bg-bad-solid" :
    status === "printing" || status === "claimed" ? "bg-warn-solid" :
    status === "queued" ? "bg-info-solid" :
    "bg-ink-4";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2">
      <span className={cn("w-2 h-2 rounded-full", color)} />
      {label ?? status}
    </span>
  );
}
