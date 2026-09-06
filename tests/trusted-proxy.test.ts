import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTrustedProxyRequest, isTrustedProxyUpgrade, trustProxyEnabled } from "../src/server/trusted-proxy";

describe("trusted proxy boundary", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("TRUST_PROXY", "1");
    vi.stubEnv("TRUST_PROXY_SECRET", "proxy-secret-that-is-at-least-32-characters");
  });

  it("enables the boundary only when configured", () => {
    expect(trustProxyEnabled()).toBe(true);
    vi.stubEnv("TRUST_PROXY", "0");
    expect(trustProxyEnabled()).toBe(false);
  });

  it("rejects direct HTTP requests that do not carry the private proxy credential", () => {
    const req = new Request("http://gateway.test/api/print/jobs", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(isTrustedProxyRequest(req)).toBe(false);
  });

  it("accepts the authenticated reverse-proxy request", () => {
    const req = new Request("http://gateway.test/api/print/jobs", {
      headers: {
        "x-gateway-proxy-token": "proxy-secret-that-is-at-least-32-characters",
        "x-forwarded-for": "203.0.113.5",
      },
    });
    expect(isTrustedProxyRequest(req)).toBe(true);
  });

  it("fails closed when TRUST_PROXY is enabled without a strong secret", () => {
    vi.stubEnv("TRUST_PROXY_SECRET", "short");
    const req = new Request("http://gateway.test/api/print/jobs", {
      headers: { "x-gateway-proxy-token": "short" },
    });
    expect(isTrustedProxyRequest(req)).toBe(false);
  });

  it("applies the same boundary to WebSocket upgrades", () => {
    expect(isTrustedProxyUpgrade({
      "x-gateway-proxy-token": "proxy-secret-that-is-at-least-32-characters",
    })).toBe(true);
    expect(isTrustedProxyUpgrade({
      "x-gateway-proxy-token": "attacker-controlled-token",
    })).toBe(false);
    expect(isTrustedProxyUpgrade({})).toBe(false);
  });
});
