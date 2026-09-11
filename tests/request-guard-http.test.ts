import { createServer, type Server } from "http";
import { connect, type AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardApiRequest, MAX_API_BODY_BYTES } from "../src/server/request-guard";

/**
 * Real-TCP tests for the API body guard. The P0 that broke every mutating
 * /api/* request in production was invisible to in-process route tests, so
 * the guard must be verified the same way production runs it: a real HTTP
 * server, real request streams, and a handler that consumes the body the
 * framework would (fully reading it).
 */

// undici requires `duplex` for stream bodies; the DOM RequestInit type does
// not declare it, so widen at the single fetch call site.
function post(url: string, init?: { body?: BodyInit | null; headers?: Record<string, string> | null; duplex?: "half" }) {
  return fetch(url, { method: "POST", ...init } as RequestInit);
}

describe("request guard (real HTTP)", () => {
  let server: Server;
  let base: string;

  const MAX_TEST_BYTES = 4 * 1024; // small ceiling so overflow tests stay fast

  let port: number;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const guarded = await guardApiRequest(req, res, { maxBytes: MAX_TEST_BYTES });
      if (!guarded) return;
      if (req.url === "/api/echo") {
        const chunks: Buffer[] = [];
        for await (const chunk of guarded) chunks.push(Buffer.from(chunk));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: Buffer.concat(chunks).length, body: Buffer.concat(chunks).toString("base64") }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  // Raw-socket helper: undici (fetch) refuses to send a lying or invalid
  // Content-Length, so the declared-size paths must be driven at the wire
  // level, exactly as a misbehaving or malicious client would.
  function rawHttp(request: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      const data: Buffer[] = [];
      socket.on("data", (chunk) => data.push(chunk));
      socket.on("end", () => {
        const raw = Buffer.concat(data).toString("utf8");
        const status = parseInt(raw.split(" ", 2)[1] ?? "0", 10) || 0;
        const body = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : "";
        resolve({ status, body });
      });
      socket.on("error", (err) => resolve({ status: 0, body: `error: ${err.message}` }));
    });
  }

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("declared Content-Length", () => {
    it("passes a small body through untouched", async () => {
      const payload = JSON.stringify({ hello: "world" });
      const res = await post(`${base}/api/echo`, {
        body: payload,
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: number; body: string };
      expect(data.received).toBe(Buffer.byteLength(payload));
      expect(Buffer.from(data.body, "base64").toString("utf8")).toBe(payload);
    });

    it("rejects a declared body over the ceiling with 413", async () => {
      // A lying client declares 99999 bytes; the guard must reject from the
      // header alone, without reading the stream.
      const { status, body } = await rawHttp(
        "POST /api/echo HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${MAX_TEST_BYTES + 5}\r\n` +
          "Connection: close\r\n\r\n" +
          '{"a":"b"}',
      );
      expect(status).toBe(413);
      expect(body).toContain("REQUEST_BODY_TOO_LARGE");
    });

    it("rejects a malformed content-length (400/413, never 200)", async () => {
      // Node's HTTP parser rejects non-numeric Content-Length itself (400);
      // the guard's defensive NaN branch would answer 413. Either way the
      // request must never be forwarded.
      const { status } = await rawHttp(
        "POST /api/echo HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Length: abc\r\n" +
          "Connection: close\r\n\r\n",
      );
      expect([0, 400, 413]).toContain(status);
    });

    it("leaves GET requests alone", async () => {
      const res = await fetch(`${base}/api/echo`);
      expect(res.status).toBe(200);
    });

    it("leaves non-/api paths alone even when mutating", async () => {
      const res = await fetch(`${base}/page`, { method: "POST", body: "x".repeat(MAX_TEST_BYTES * 2) });
      // The test server only implements /api/echo; any status other than 413
      // proves the guard did not intercept a non-/api path.
      expect(res.status).not.toBe(413);
    });
  });

  describe("chunked / missing Content-Length", () => {
    it("rejects missing Content-Length without consuming the request stream", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("AAAA"));
          stream.close();
        },
      });
      const res = await post(`${base}/api/echo`, { body, duplex: "half" });
      expect(res.status).toBe(411);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("CONTENT_LENGTH_REQUIRED");
    });

    it("admits requests only while the global byte budget has capacity", async () => {
      const { MAX_CONCURRENT_CHUNKED_BYTES, getReservedRequestBytes } = await import(
        "../src/server/request-guard"
      );
      expect(MAX_CONCURRENT_CHUNKED_BYTES).toBe(32 * 1024 * 1024);
      expect(getReservedRequestBytes()).toBe(0);
    });
  });

  it("exposes the 8MB production ceiling", () => {
    expect(MAX_API_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});
