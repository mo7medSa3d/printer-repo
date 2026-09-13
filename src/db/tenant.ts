import { db } from "./index";
import { sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTenant<T>(
  tenantId: string,
  cb: (tx: Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    // 3rd arg = true means is_local, so it only persists for this transaction
    await tx.execute(sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`);
    return cb(tx);
  });
}
