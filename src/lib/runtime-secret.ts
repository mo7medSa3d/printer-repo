import { readFileSync } from "node:fs";

/**
 * Resolve a runtime secret from an explicit *_FILE path first, then fall back
 * to the environment value for local development. Docker/Compose production
 * deployments should mount secrets as files under /run/secrets.
 */
export function runtimeSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    const value = readFileSync(file, "utf8").trim();
    return value || undefined;
  }
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requiredRuntimeSecret(name: string): string {
  const value = runtimeSecret(name);
  if (!value) throw new Error(`${name} must be provided via ${name}_FILE or ${name}`);
  return value;
}
