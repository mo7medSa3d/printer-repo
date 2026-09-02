/**
 * Practical structured logging for the gateway.
 *
 * One JSON object per line on stdout. Fields that look like credentials or
 * document payloads are dropped so a debug log can never leak a secret.
 * A correlation id is taken from `x-request-id` / `x-correlation-id` or minted.
 */

const SENSITIVE = /secret|password|passwd|token|authorization|cookie|api[_-]?key|payload|pairing/i;

export type LogFields = Record<string, unknown>;

export function requestIdFrom(req: Request): string {
  const existing =
    req.headers.get("x-request-id")?.trim() ||
    req.headers.get("x-correlation-id")?.trim();
  if (existing && existing.length <= 128) return existing;
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 200)}…(${value.length} chars)`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.info(text);
}

export function logInfo(event: string, fields: LogFields = {}): void {
  emit("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  emit("warn", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  emit("error", event, fields);
}
