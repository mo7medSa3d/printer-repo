export const AGENT_LIFECYCLES = ["active", "disabled", "retired"] as const;
export const PRINTER_LIFECYCLES = ["active", "disabled", "retired"] as const;

export type Lifecycle = (typeof AGENT_LIFECYCLES)[number];

export function isLifecycle(value: unknown): value is Lifecycle {
  return typeof value === "string" && (AGENT_LIFECYCLES as readonly string[]).includes(value);
}

export function canTransitionLifecycle(current: string, next: string): boolean {
  if (current === next) return true;
  if (current === "retired") return false;
  if (next === "retired") return current === "active" || current === "disabled";
  if (next === "active" || next === "disabled") return current === "active" || current === "disabled";
  return false;
}

export function assertLifecycleTransition(current: string, next: string): void {
  if (!isLifecycle(next)) throw new Error(`invalid lifecycle: ${next}`);
  if (!canTransitionLifecycle(current, next)) {
    throw new Error(`invalid lifecycle transition: ${current} -> ${next}`);
  }
}

export function lifecycleAllowsNewJobs(lifecycle: string): boolean {
  return lifecycle === "active";
}
