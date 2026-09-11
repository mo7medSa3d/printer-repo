import { defineConfig } from "drizzle-kit";

// No credential fallback: a missing DATABASE_URL fails fast with a clear
// message instead of silently targeting a hardcoded local database that
// could leak default credentials into logs or error messages.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Set it to the PostgreSQL connection string for this environment (e.g. DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB).",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
