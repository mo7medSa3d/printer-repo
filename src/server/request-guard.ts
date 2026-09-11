import { IncomingMessage, type ServerResponse } from "http";

/**
 * API body limit. The custom Next server must never consume the IncomingMessage
 * stream before Next has converted it to a Web Request. In production Caddy
 * also enforces this same 8 MiB ceiling at the edge.
 */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_CONCURRENT_CHUNKED_BYTES = 32 * 1024 * 1024;

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
let reservedRequestBytes = 0;

export interface ApiBodyGuardOptions {
  maxBytes?: number;
}

function rejectRequest(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");
  res.end(JSON.stringify({ success: false, error: code }));
}

function reserve(bytes: number): boolean {
  if (bytes < 0 || !Number.isSafeInteger(bytes)) return false;
  if (reservedRequestBytes + bytes > MAX_CONCURRENT_CHUNKED_BYTES) return false;
  reservedRequestBytes += bytes;
  return true;
}

function release(bytes: number): void {
  reservedRequestBytes = Math.max(0, reservedRequestBytes - bytes);
}

/**
 * Release a previous reservation against the concurrent chunked budget.
 * Idempotency is enforced by the caller via `releaseOnce`; this export
 * exists so the reservation lifecycle is explicit and greppable, and so
 * tests/edge proxies can reconcile the budget.
 */
export function releaseChunkedBody(bytes: number): void {
  release(bytes);
}

export function getReservedRequestBytes(): number {
  return reservedRequestBytes;
}

/** Payload-bearing endpoints whose bodies reserve the concurrency budget. */
function isPayloadBearingEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("/api/agent/") || url.startsWith("/api/print/");
}

/**
 * Pre-auth check: runs BEFORE any byte is reserved against
 * MAX_CONCURRENT_CHUNKED_BYTES so unauthenticated Slowloris/chunked
 * streams cannot exhaust the 32 MiB budget and 503 legitimate traffic.
 */
function hasAuthHeaders(req: IncomingMessage): boolean {
  const headers = req.headers;
  const authorization = headers["authorization"];
  if (typeof authorization === "string" && authorization.trim() !== "") return true;
  if (Array.isArray(authorization) && authorization.some((v) => v.trim() !== "")) return true;
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim() !== "") return true;
  if (Array.isArray(apiKey) && apiKey.some((v) => v.trim() !== "")) return true;
  const cookie = headers["cookie"];
  if (typeof cookie === "string" && cookie.trim() !== "") return true;
  if (Array.isArray(cookie) && cookie.some((v) => v.trim() !== "")) return true;
  return false;
}

/**
 * Admission-only request guard. It validates Content-Length and reserves the
 * maximum admitted bytes without touching the request stream. Chunked requests
 * are rejected with 411 because enforcing a hard byte ceiling without consuming
 * or replacing the stream would require the exact clone/lock workaround that
 * previously broke Next.js 16. Edge proxies should enforce Content-Length/body
 * limits before forwarding.
 *
 * Pre-auth DoS hardening:
 * - Authentication headers (`Authorization`, `X-API-Key`, cookies) are
 *   inspected BEFORE any byte is reserved against
 *   MAX_CONCURRENT_CHUNKED_BYTES.
 * - Unauthenticated chunked requests to payload-bearing endpoints
 *   (`/api/agent/`, `/api/print/`) are rejected with 401 UNAUTHORIZED
 *   without reserving budget.
 * - Reservation applies ONLY to payload-bearing endpoints; other /api/*
 *   routes are size-checked but never charge the concurrency budget.
 * - Every reservation is released via releaseChunkedBody() on response
 *   `finish`/`close` and request `close`/`error`.
 */
export async function guardApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiBodyGuardOptions = {},
): Promise<IncomingMessage | null> {
  const maxBytes = options.maxBytes ?? MAX_API_BODY_BYTES;
  if (!req.url?.startsWith("/api/")) return req;
  if (!MUTATING_METHODS.includes(req.method ?? "")) return req;

  const payloadBearing = isPayloadBearingEndpoint(req.url);

  const rawLength = req.headers["content-length"];
  if (rawLength === undefined) {
    // Chunked / missing length: auth first, never allocate for anonymous
    // Slowloris streams on payload-bearing endpoints.
    if (payloadBearing && !hasAuthHeaders(req)) {
      rejectRequest(res, 401, "UNAUTHORIZED");
      req.destroy();
      return null;
    }
    rejectRequest(res, 411, "CONTENT_LENGTH_REQUIRED");
    req.destroy();
    return null;
  }

  const length = Number(rawLength);
  if (!Number.isInteger(length) || length < 0 || length > maxBytes) {
    rejectRequest(res, 413, "REQUEST_BODY_TOO_LARGE");
    req.destroy();
    return null;
  }

  // Non-payload endpoints are size-checked only; they never reserve the
  // shared 32 MiB concurrency budget.
  if (!payloadBearing) return req;

  // Auth is inspected before allocating any bytes against
  // MAX_CONCURRENT_CHUNKED_BYTES. Unauthenticated declared-length requests
  // forward WITHOUT reserving budget so the route handler still owns the
  // 401/400 contract, while anonymous streams can never exhaust the 32 MiB
  // concurrency budget and 503 legitimate traffic.
  if (!hasAuthHeaders(req)) {
    return req;
  }

  if (!reserve(length)) {
    rejectRequest(res, 503, "REQUEST_BODY_CAPACITY_EXCEEDED");
    req.destroy();
    return null;
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseChunkedBody(length);
  };
  res.once("finish", releaseOnce);
  res.once("close", releaseOnce);
  req.once("close", releaseOnce);
  req.once("error", releaseOnce);
  return req;
}
