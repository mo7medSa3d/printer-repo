import { timingSafeEqual } from "node:crypto";

function configuredProxySecret(): string | null {
  const value = process.env.TRUST_PROXY_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function trustProxyEnabled(): boolean {
  return process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
}

export function isTrustedProxyRequest(req: Request): boolean {
  if (!trustProxyEnabled()) return true;
  const secret = configuredProxySecret();
  if (!secret) return false;
  const supplied = req.headers.get("x-gateway-proxy-token")?.trim() ?? "";
  return supplied.length > 0 && safeEqual(supplied, secret);
}

export function isTrustedProxyUpgrade(headers: Record<string, string | string[] | undefined>): boolean {
  if (!trustProxyEnabled()) return true;
  const secret = configuredProxySecret();
  if (!secret) return false;
  const raw = headers["x-gateway-proxy-token"];
  const supplied = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return supplied.trim().length > 0 && safeEqual(supplied.trim(), secret);
}
