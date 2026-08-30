import { pgTable, text, timestamp, jsonb, integer, index, boolean } from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // agt_...
  name: text("name").notNull(),
  pairingCode: text("pairing_code"),
  pairingCodeExpiresAt: timestamp("pairing_code_expires_at"),
  secret: text("secret"), // SHA-256 hash of the credential handed to the agent - never the plaintext secret
  status: text("status").notNull().default("offline"), // online, offline, inactive
  metadata: jsonb("metadata").$type<{
    hostname?: string;
    os?: string;
    osVersion?: string;
    version?: string;
  }>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  lastSeenIdx: index("agents_last_seen_idx").on(table.lastSeenAt),
}));

export const printers = pgTable("printers", {
  id: text("id").primaryKey(), // printer_...
  agentId: text("agent_id").references(() => agents.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // usb, network
  status: text("status").notNull().default("unknown"), // online, offline, busy, error, unknown
  config: jsonb("config").$type<{
    ip?: string;
    port?: number;
    protocol?: string;
    vid?: number;
    pid?: number;
    serial?: string;
    address?: string; // USB path
  }>(),
  enabled: boolean("enabled").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentIdx: index("printers_agent_id_idx").on(table.agentId),
}));

// Odoo API keys — separate from agent secrets. See src/lib/odoo-auth.ts.
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(), // key_...
  name: text("name").notNull(),
  hashedKey: text("hashed_key").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
});

// Manager sessions — httpOnly JWT with server-side revocation via jti.
// See src/lib/manager-auth.ts and docs/AUTH.md.
export const managerSessions = pgTable("manager_sessions", {
  jti: text("jti").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  expiresIdx: index("manager_sessions_expires_idx").on(table.expiresAt),
}));

export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(), // job_...
  agentId: text("agent_id").references(() => agents.id).notNull(),
  printerId: text("printer_id").references(() => printers.id).notNull(),
  // queued -> claimed -> printing -> success | failed ; any -> expired (see src/lib/job-status.ts)
  status: text("status").notNull().default("queued"),
  payload: jsonb("payload").notNull(), // strict {type, encoding, data} contract - see API.md
  error: text("error"),
  retries: integer("retries").notNull().default(0),
  claimedAt: timestamp("claimed_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentStatusIdx: index("print_jobs_agent_status_idx").on(table.agentId, table.status),
  printerStatusIdx: index("print_jobs_printer_status_idx").on(table.printerId, table.status),
  statusExpiresIdx: index("print_jobs_status_expires_idx").on(table.status, table.expiresAt),
}));
