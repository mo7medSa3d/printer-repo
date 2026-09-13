import { db } from "../src/db";
import { tenants, agents, printers, printJobs, apiKeys, users, tenantUsers, applications, discoverySessions, discoveredDevices } from "../src/db/schema";
import { sql } from "drizzle-orm";

async function run() {
  console.log("Starting backfill...");
  
  // 1. Create a Default Tenant
  const defaultTenantId = "00000000-0000-4000-a000-000000000000";
  await db.insert(tenants).values({
    id: defaultTenantId,
    name: "Default Legacy Tenant",
  }).onConflictDoNothing();
  console.log("Default tenant created/verified.");

  // 2. Backfill runtime entities
  const tables = [agents, printers, apiKeys, discoverySessions, discoveredDevices, printJobs, applications];
  for (const t of tables) {
    await db.update(t).set({ tenantId: defaultTenantId }).where(sql`${t.tenantId} IS NULL`);
    console.log(`Backfilled table`);
  }

  // 3. Create a Default Admin User (if manager credentials exist in .env, we can map them, but for now just create a stub user)
  const defaultUserId = "00000000-0000-4000-a000-111111111111";
  await db.insert(users).values({
    id: defaultUserId,
    email: "admin@local",
    passwordHash: "unmigrated-legacy-password", // In a real system we'd parse .env
  }).onConflictDoNothing();

  await db.insert(tenantUsers).values({
    userId: defaultUserId,
    tenantId: defaultTenantId,
    role: "admin",
  }).onConflictDoNothing();

  console.log("Legacy Admin User mapped to Default Tenant.");
  console.log("Backfill complete.");
  process.exit(0);
}

run().catch(console.error);
