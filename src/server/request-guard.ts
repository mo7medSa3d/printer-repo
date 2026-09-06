import { IncomingMessage, type ServerResponse } from "http";

/**
 * Hard ceiling for API request bodies (print payloads are capped at 5MB).
 *
 * IMPORTANT: this guard must never *tap* the original request stream.
 * Next.js 16 builds its Web Request from the same IncomingMessage, and any
 * prior consumption of the stream ("data" listener, `read()`, ...) makes
 * undici reject the request with "Response body object should not be
 * disturbed or locked" — which silently 500'd every POST/PUT/PATCH/DELETE
 * /api/* request in production.
 *
 * Strategy:
 *   - Declared Content-Length: validated from the header only; the request
 *     stream is passed through completely untouched.
 *   - Chunked / missing Content-Length: the body is fully buffered (bounded
 *     by the ceiling) and handed to Next.js inside a NEW IncomingMessage,
 *     so the original stream is consumed by this guard and never re-read.
 */
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export interface ApiBodyGuardOptions {
  maxBytes?: number;
}

export class ApiBodyTooLargeError extends Error {
  constructor() {
    super("REQUEST_BODY_TOO_LARGE");
    this.name = "ApiBodyTooLargeError";
  }
}

export class ApiBodyAbortedError extends Error {
  constructor() {
    super("REQUEST_ABORTED");
    this.name = "ApiBodyAbortedError";
  }
}

function rejectOversizedRequest(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = 413;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");
  res.end(JSON.stringify({ success: false, error: "REQUEST_BODY_TOO_LARGE" }));
}

function rejectRequest(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");
  res.end(JSON.stringify({ success: false, error: code }));
}

/**
 * Reads the full request body into memory, rejecting once `maxBytes` is
 * exceeded. Resolves only for complete bodies.
 */
export function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted);
      req.removeListener("error", onError);
      if (error) reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        settle(new ApiBodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      if (settled) return;
      settle();
      resolve(Buffer.concat(chunks));
    };
    const onAborted = () => settle(new ApiBodyAbortedError());
    const onError = (err: Error) => settle(err);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
  });
}

/**
 * Builds a fresh IncomingMessage carrying the buffered body. The original
 * request's stream is never handed downstream; only its (immutable)
 * metadata and the new body stream are.
 */
export function cloneRequestWithBody(source: IncomingMessage, body: Buffer): IncomingMessage {
  const clone = new IncomingMessage(source.socket);
  clone.method = source.method;
  clone.url = source.url;
  clone.headers = source.headers;
  clone.httpVersion = source.httpVersion;
  clone.httpVersionMajor = source.httpVersionMajor;
  clone.httpVersionMinor = source.httpVersionMinor;
  clone.complete = true;
  clone.push(body);
  clone.push(null);
  return clone;
}

/**
 * Guards a mutating /api/* request.
 *
 * @returns the request to pass to the framework — either the ORIGINAL
 * request (declared size within limits: stream untouched) or a fresh
 * request wrapping the buffered chunked body. Returns `null` when the
 * response was already answered (413/499/400) and the connection must not
 * be forwarded.
 */
export async function guardApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiBodyGuardOptions = {},
): Promise<IncomingMessage | null> {
  const maxBytes = options.maxBytes ?? MAX_API_BODY_BYTES;

  if (!req.url?.startsWith("/api/")) return req;
  if (!MUTATING_METHODS.includes(req.method ?? "")) return req;

  const rawLength = req.headers["content-length"];
  if (rawLength !== undefined) {
    const length = Number(rawLength);
    if (!Number.isInteger(length) || length < 0 || length > maxBytes) {
      rejectOversizedRequest(res);
      // Stop consuming the declared oversized body once the 413 is flushed.
      res.once("finish", () => req.destroy());
      return null;
    }
    // Declared size is within the ceiling: pass the request through
    // WITHOUT attaching any stream listeners.
    return req;
  }

  // Chunked transfer (or missing Content-Length): buffer with a hard cap,
  // then hand a fresh request to the framework.
  try {
    const body = await readBoundedBody(req, maxBytes);
    return cloneRequestWithBody(req, body);
  } catch (error) {
    if (error instanceof ApiBodyTooLargeError) {
      rejectOversizedRequest(res);
    } else if (error instanceof ApiBodyAbortedError) {
      rejectRequest(res, 499, "REQUEST_ABORTED");
    } else {
      rejectRequest(res, 400, "REQUEST_BODY_INVALID");
    }
    req.destroy();
    return null;
  }
}
