import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");
const caddy = readFileSync("Caddyfile", "utf8");
const windowsWorkflow = readFileSync(".github/workflows/build-windows.yml", "utf8");
const runtimeSecret = readFileSync("src/lib/runtime-secret.ts", "utf8");
const server = readFileSync("server.ts", "utf8");

function workflowPermissionsBlock(): string {
  const marker = "permissions:\n";
  const start = windowsWorkflow.indexOf(marker);
  if (start < 0) return "";
  return windowsWorkflow.slice(start, windowsWorkflow.indexOf("    steps:", start));
}

describe("deployment security contracts", () => {
  it("mounts production secrets as Compose secrets instead of service environment values", () => {
    expect(compose).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password");
    expect(compose).toContain("GATEWAY_JWT_SECRET_FILE: /run/secrets/gateway_jwt_secret");
    expect(compose).toContain("MANAGER_PASSWORD_HASH_FILE: /run/secrets/manager_password_hash");
    expect(compose).toContain("TRUST_PROXY_SECRET_FILE: /run/secrets/trust_proxy_secret");
    expect(compose).toContain("secrets:\n  postgres_password:");
    expect(compose).not.toContain("PGPASSWORD: ${POSTGRES_PASSWORD");
    expect(compose).not.toContain("GATEWAY_JWT_SECRET: ${GATEWAY_JWT_SECRET");
    expect(compose).not.toContain("MANAGER_PASSWORD_HASH: ${MANAGER_PASSWORD_HASH");
  });

  it("supports file-backed secrets with explicit environment fallback for development", () => {
    expect(runtimeSecret).toContain("${name}_FILE");
    expect(runtimeSecret).toContain("readFileSync(file, \"utf8\")");
  });

  it("requires an authenticated proxy token whenever TRUST_PROXY is enabled", () => {
    expect(server).toContain("isTrustedProxyRequest");
    expect(server).toContain("TRUSTED_PROXY_REQUIRED");
    expect(server).toContain("TRUST_PROXY_SECRET");
    expect(caddy).toContain("header_up X-Gateway-Proxy-Token {$TRUST_PROXY_SECRET}");
    expect(caddy).toContain("header_up X-Forwarded-For {http.request.remote.host}");
    expect(caddy).toContain("header_up -X-Real-Ip");
  });

  it("keeps the Windows workflow read-only and immutable", () => {
    const permissions = workflowPermissionsBlock();
    expect(permissions).toContain("contents: read");
    expect(permissions).not.toContain("contents: write");
    expect(windowsWorkflow).not.toContain("git push");
    expect(windowsWorkflow).not.toContain("git commit");
    expect(windowsWorkflow).toContain("cargo metadata --locked --no-deps");
  });
});
