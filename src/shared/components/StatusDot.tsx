"use client";
import { cn } from "@/lib/utils";

export function StatusDot({ status, label }: { status: string; label?: string }) {
  const color =
    status === "online" || status === "success" ? "bg-green-500" :
    status === "offline" || status === "failed" || status === "error" ? "bg-red-500" :
    status === "printing" || status === "claimed" ? "bg-orange-500" :
    status === "queued" ? "bg-blue-500" :
    "bg-zinc-400";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={cn("w-2 h-2 rounded-full", color)} />
      {label ?? status}
    </span>
  );
}
