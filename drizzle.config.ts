import { defineConfig } from "drizzle-kit";

// Production deployments must set DATABASE_URL in the environment; the
// fallback is the local development database only.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
});
