import { createServer, type Server } from "http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Acceptance test for the REAL production request path: Next.js production
 * handler + the custom-server body guard, exactly as server.ts wires them.
 *
 * This is the layer the P0 regression lived in — in-process route tests
 * bypass server.ts entirely. The suite skips when no production build
 * exists (run `npm run build` first; CI builds before running tests).
 */
const hasProductionBuild = existsSync(join(process.cwd(), ".next", "BUILD_ID"));
const suite = describe.skipIf(!hasProductionBuild);

const PORT = 3987;

function isNextInternalErrorPage(res: Response): boolean {
  const type = res.headers.get("content-type") ?? "";
  return res.status === 500 && type.includes("text/html");
}

suite("production server HTTP acceptance (real Next.js + guard)", () => {
  let server: Server | null = null;

  // Hooks live INSIDE the skipped suite so a missing production build
  // (describe.skipIf) does not attempt to prepare the Next app.
  beforeAll(async () => {
    // Dynamically import so the suite can skip without paying the cost of
    // preparing the Next app.
    const { default: next } = await import("next");
    const { guardApiRequest } = await import("../src/server/request-guard");
    const app = next({ dev: false, hostname: "0.0.0.0", port: PORT });
    const handle = app.getRequestHandler();
    await app.prepare();

    server = createServer((req, res) => {
      guardApiRequest(req, res)
        .then((guarded) => {
          if (!guarded) return;
          handle(guarded, res);
        })
        .catch((error) => {
          console.error("[acceptance] guard failure", error);
          if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
          }
          req.destroy();
        });
    });
    await new Promise<void>((resolve) => server!.listen(PORT, "127.0.0.1", resolve));
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  describe("mutating API requests reach the route handlers", () => {
    it("POST /api/print/jobs with an invalid body returns the handler's 400 JSON (not a 500 ISE page)", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/print/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branchId: "x" }),
      });
      expect(isNextInternalErrorPage(res)).toBe(false);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBeTruthy();
    });

    it("POST /api/auth/manager/login returns the handler's JSON response (not a 500 ISE page)", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/manager/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "probe", password: "probe" }),
      });
      expect(isNextInternalErrorPage(res)).toBe(false);
      expect([401, 423, 429, 500, 503]).toContain(res.status);
      const type = res.headers.get("content-type") ?? "";
      expect(type).toContain("application/json");
    });

    it("POST /api/agent/register returns the handler's 400 JSON for a malformed pairing code", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/agent/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingCode: "1" }),
      });
      expect(isNextInternalErrorPage(res)).toBe(false);
      expect(res.status).toBe(400);
    });

    it("PATCH /api/agent/jobs (chunked, no content-length) is answered by the handler, not the framework", async () => {
      // A PATCH with a stream body exercises the chunked buffering path
      // end-to-end through Next.js. undici requires `duplex` for stream
      // bodies; the DOM RequestInit type does not declare it, hence the cast.
      const res = await fetch(
        `http://127.0.0.1:${PORT}/api/agent/jobs`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(JSON.stringify({ jobId: "nope", status: "success" })));
              stream.close();
            },
          }),
          duplex: "half",
        } as RequestInit,
      );
      expect(isNextInternalErrorPage(res)).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("body ceiling", () => {
    it("rejects a declared 8MB+ body with 413 before the handler", async () => {
      // Wire-level: a client that declares an oversized Content-Length.
      // (undici refuses to send a lying content-length, so a raw socket is
      // the only faithful way to test the guard's declared-size path.)
      const { connect } = await import("net");
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve) => {
        const socket = connect(PORT, "127.0.0.1", () => {
          socket.write(
            "POST /api/print/jobs HTTP/1.1\r\n" +
              `Host: 127.0.0.1:${PORT}\r\n` +
              "Content-Type: application/json\r\n" +
              `Content-Length: ${8 * 1024 * 1024 + 1}\r\n` +
              "Connection: close\r\n\r\n{}",
          );
        });
        const data: Buffer[] = [];
        socket.on("data", (chunk) => data.push(chunk));
        socket.on("end", () => {
          const raw = Buffer.concat(data).toString("utf8");
          const st = parseInt(raw.split(" ", 2)[1] ?? "0", 10) || 0;
          resolve({ status: st, body: raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : "" });
        });
        socket.on("error", () => resolve({ status: 0, body: "error" }));
      });
      expect(status).toBe(413);
      expect(body).toContain("REQUEST_BODY_TOO_LARGE");
    });
  });
});
