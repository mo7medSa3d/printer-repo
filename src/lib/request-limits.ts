/**
 * Checks the declared HTTP Content-Length before a JSON body is parsed.
 * The custom HTTP server also enforces a global ceiling for chunked requests;
 * a reverse proxy should enforce an equivalent limit when it terminates or
 * forwards traffic before the application server.
 */
export function hasBodyOverLimit(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get("content-length");
  if (!raw) return false;
  const length = Number(raw);
  return !Number.isFinite(length) || length < 0 || length > maxBytes;
}
