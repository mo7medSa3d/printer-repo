import { defineConfig } from "drizzle-kit";

// Production deployments must set DATABASE_URL in the environment; the
// fallback is the local development database only.
const getDatabaseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL environment variable is required. " +
      "Run 'cp .env.example .env' and configure your database connection."
    );
  }
  return url;
};

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: getDatabaseUrl(),
  },
});
