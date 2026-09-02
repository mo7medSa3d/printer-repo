import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "../src/db";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("PostgreSQL migrations applied successfully");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
