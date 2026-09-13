import { sql, type SQL } from "drizzle-orm";

export class TenantEntitlementError extends Error {
  readonly code = "TENANT_ENTITLEMENT_EXCEEDED" as const;
  constructor(public readonly entitlement: string, public readonly limit: number) {
    super(`Tenant entitlement ${entitlement} exceeded (limit ${limit})`);
  }
}

/**
 * Enforces only configured subscription limits. Tenants without a subscription
 * record are deliberately not subject to invented plan limits; billing setup
 * remains an explicit control-plane operation.
 */
export type EntitlementTx = { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> };

export async function getTenantEntitlementLimit(tx: EntitlementTx, tenantId: string, key: string): Promise<number | null> {
  const result = await tx.execute(sql`
    SELECT p.entitlements
    FROM tenant_subscriptions ts
    JOIN plans p ON p.id = ts.plan_id
    WHERE ts.tenant_id = ${tenantId}
      AND ts.status IN ('trialing','active','past_due')
    LIMIT 1
  `);
  const entitlements = (result.rows[0]?.entitlements ?? {}) as Record<string, unknown>;
  const value = entitlements[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function enforceTenantResourceEntitlement(tx: EntitlementTx, tenantId: string, key: string, currentCountSql: SQL): Promise<void> {
  const limit = await getTenantEntitlementLimit(tx, tenantId, key);
  if (limit === null) return;
  const result = await tx.execute(currentCountSql);
  const count = Number(result.rows[0]?.count ?? 0);
  if (count >= limit) throw new TenantEntitlementError(key, limit);
}

export async function enforceTenantJobEntitlements(tx: { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> }, tenantId: string): Promise<void> {
  const minuteLimit = await getTenantEntitlementLimit(tx, tenantId, "max_jobs_per_minute");
  if (minuteLimit !== null) {
    const recent = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE tenant_id = ${tenantId}
        AND created_at >= now() - interval '1 minute'
    `);
    const count = Number(recent.rows[0]?.count ?? 0);
    if (count >= minuteLimit) throw new TenantEntitlementError("max_jobs_per_minute", minuteLimit);
  }

  const concurrentLimit = await getTenantEntitlementLimit(tx, tenantId, "max_concurrent_jobs");
  if (concurrentLimit !== null) {
    const current = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE tenant_id = ${tenantId}
        AND status IN ('queued','claimed','printing')
        AND expires_at > now()
    `);
    const count = Number(current.rows[0]?.count ?? 0);
    if (count >= concurrentLimit) throw new TenantEntitlementError("max_concurrent_jobs", concurrentLimit);
  }
}
