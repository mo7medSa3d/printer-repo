/**
 * Checks the declared HTTP Content-Length before a JSON body is parsed.
 * Chunked requests must still be bounded by the reverse proxy/web server.
 */
export function hasBodyOverLimit(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get("content-length");
  if (!raw) return false;
  const length = Number(raw);
  return !Number.isFinite(length) || length < 0 || length > maxBytes;
}
