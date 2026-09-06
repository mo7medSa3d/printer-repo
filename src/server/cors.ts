import type { ServerResponse } from "http";

const DEFAULT_DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];
const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type,Authorization,X-Odoo-Print-Desktop";

function configuredOrigins(): Set<string> {
  const raw = process.env.DESKTOP_CORS_ORIGINS;
  const values = raw
    ? raw.split(",").map((v) => v.trim()).filter(Boolean)
    : DEFAULT_DESKTOP_ORIGINS;
  return new Set(values);
}

export function applyApiCors(req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: ServerResponse): boolean {
  if (!req.url?.startsWith("/api/")) return false;

  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!origin) return false;

  if (!configuredOrigins().has(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  return true;
}

export function handleApiCorsPreflight(req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS" || !req.url?.startsWith("/api/")) return false;
  const allowed = applyApiCors(req, res);
  if (!allowed) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "CORS_ORIGIN_FORBIDDEN" }));
    return true;
  }
  res.statusCode = 204;
  res.end();
  return true;
}
