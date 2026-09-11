import { pgTable, text, timestamp, jsonb, integer, bigint, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  pairingCodeHash: text("pairing_code_hash"),
  pairingCodeExpiresAt: timestamp("pairing_code_expires_at"),
  secret: text("secret"),
  status: text("status").notNull().default("offline"),
  lifecycle: text("lifecycle").notNull().default("active"),
  metadata: jsonb("metadata").$type<{ hostname?: string; os?: string; osVersion?: string; version?: string; }>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  lastSeenIdx: index("agents_last_seen_idx").on(table.lastSeenAt),
  lifecycleCheck: check("agents_lifecycle_check", sql`${table.lifecycle} in ('active','disabled','retired')`),
  statusCheck: check("agents_status_check", sql`${table.status} in ('online','offline')`),
}));

export const printers = pgTable("printers", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  name: text("name").notNull(),
  printerType: text("printer_type").notNull().default("physical"),
  deviceClass: text("device_class").notNull().default("unknown"),
  connectionType: text("connection_type").notNull().default("network"),
  protocol: text("protocol").notNull().default("unknown"),
  status: text("status").notNull().default("unknown"),
  lifecycle: text("lifecycle").notNull().default("active"),
  config: jsonb("config").$type<{ ip?: string; port?: number; vid?: number; pid?: number; serial?: string; address?: string; spooler_name?: string; paper_widths?: number[]; color_capable?: boolean; duplex_capable?: boolean; }>(),
  capabilities: jsonb("capabilities").$type<{ max_paper_width?: number; supports_color?: boolean; supports_duplex?: boolean; supported_protocols?: string[]; }>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentIdx: index("printers_agent_id_idx").on(table.agentId),
  printerTypeIdx: index("printers_printer_type_idx").on(table.printerType),
  statusIdx: index("printers_status_idx").on(table.status),
  lifecycleCheck: check("printers_lifecycle_check", sql`${table.lifecycle} in ('active','disabled','retired')`),
  printerTypeCheck: check("printers_type_check", sql`${table.printerType} in ('physical','virtual','redirected')`),
  deviceClassCheck: check("printers_device_class_check", sql`${table.deviceClass} in ('thermal','laser','inkjet','label','other','unknown')`),
  connectionTypeCheck: check("printers_connection_type_check", sql`${table.connectionType} in ('network','usb','spooler','ipp','ipps')`),
  protocolCheck: check("printers_protocol_check", sql`${table.protocol} in ('raw','escpos','zpl','tspl','ipp','ipps','spooler','windows_spooler','unknown')`),
  statusCheck: check("printers_status_check", sql`${table.status} in ('online','offline','busy','error','unknown')`),
}));

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull().default("standard"),
  name: text("name").notNull(),
  description: text("description"),
  hashedKey: text("hashed_key").notNull().unique(),
  allowedDocumentTypes: jsonb("allowed_document_types").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
});

export const managerSessions = pgTable("manager_sessions", {
  jti: text("jti").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({ expiresIdx: index("manager_sessions_expires_idx").on(table.expiresAt) }));

export const authRateLimits = pgTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
  lockedUntil: timestamp("locked_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  lockedUntilIdx: index("auth_rate_limits_locked_until_idx").on(table.lockedUntil),
  updatedAtIdx: index("auth_rate_limits_updated_at_idx").on(table.updatedAt),
}));

export const discoverySessions = pgTable("discovery_sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  status: text("status").notNull().default("running"),
  config: jsonb("config").$type<{ cidr?: string; protocols?: string[]; timeoutMs?: number; concurrency?: number; }>().default({}).notNull(),
  stats: jsonb("stats").$type<{ candidates?: number; verified?: number; errors?: number; durationMs?: number; }>().default({}).notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentIdIdx: index("discovery_sessions_agent_id_idx").on(table.agentId),
  statusIdx: index("discovery_sessions_status_idx").on(table.status),
}));

export const discoveredDevices = pgTable("discovered_devices", {
  id: text("id").primaryKey(),
  discoveryId: text("discovery_id").references(() => discoverySessions.id).notNull(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  source: text("source").array().notNull().default(sql`ARRAY[]::text[]`),
  protocol: text("protocol").notNull().default("unknown"),
  ipAddress: text("ip_address"),
  hostname: text("hostname"),
  port: integer("port"),
  macAddress: text("mac_address"),
  deviceName: text("device_name"),
  manufacturer: text("manufacturer"),
  model: text("model"),
  serialNumber: text("serial_number"),
  firmwareVersion: text("firmware_version"),
  printerState: text("printer_state"),
  uri: text("uri"),
  transport: text("transport"),
  confidence: text("confidence").notNull().default("low"),
  verification: text("verification").notNull().default("candidate"),
  deviceClass: text("device_class").notNull().default("unknown"),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>(),
  rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>(),
  provisionedPrinterId: text("provisioned_printer_id").references(() => printers.id),
  candidateStatus: text("candidate_status").notNull().default("discovered"),
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  discoveryIdIdx: index("discovered_devices_discovery_id_idx").on(table.discoveryId),
  agentIdIdx: index("discovered_devices_agent_id_idx").on(table.agentId),
  candidateStatusIdx: index("discovered_devices_candidate_status_idx").on(table.candidateStatus),
  confidenceIdx: index("discovered_devices_confidence_idx").on(table.confidence),
}));

export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(),
  apiKeyId: text("api_key_id").references(() => apiKeys.id),
  destination: text("destination"),
  documentType: text("document_type"),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  printerId: text("printer_id").references(() => printers.id).notNull(),
  status: text("status").notNull().default("queued"),
  payload: jsonb("payload").notNull(),
  error: text("error"),
  requestedBy: text("requested_by"),
  idempotencyKey: text("idempotency_key"),
  retries: integer("retries").notNull().default(0),
  claimedAt: timestamp("claimed_at"),
  claimToken: text("claim_token"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveredAt: timestamp("delivered_at"),
  ackedAt: timestamp("acked_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentStatusIdx: index("print_jobs_agent_status_idx").on(table.agentId, table.status),
  printerStatusIdx: index("print_jobs_printer_status_idx").on(table.printerId, table.status),
  statusExpiresIdx: index("print_jobs_status_expires_idx").on(table.status, table.expiresAt),
  claimedAtIdx: index("print_jobs_claimed_at_idx").on(table.status, table.claimedAt),
  apiKeyIdIdx: index("print_jobs_api_key_id_idx").on(table.apiKeyId),
  idempotencyUnique: uniqueIndex("print_jobs_idempotency_unique").on(table.apiKeyId, table.idempotencyKey).where(sql`idempotency_key IS NOT NULL AND api_key_id IS NOT NULL`),
  internalIdempotencyUnique: uniqueIndex("print_jobs_internal_idempotency_unique").on(table.idempotencyKey).where(sql`idempotency_key IS NOT NULL AND api_key_id IS NULL`),
  statusCheck: check("print_jobs_status_check", sql`${table.status} in ('queued','claimed','printing','success','failed','expired')`),
  retriesCheck: check("print_jobs_retries_check", sql`${table.retries} >= 0`),
  deliveryAttemptsCheck: check("print_jobs_delivery_attempts_check", sql`${table.deliveryAttempts} >= 0`),
  // Mirrors validatePrintJobPayload: the type/protocol contract is enforced at
  // the database boundary too (0024, NOT VALID so pre-existing rows are kept).
  // COALESCE keeps this predicate two-valued: an absent/NULL protocol must
  // FAIL raw/escpos rows, never evaluate to UNKNOWN (CHECKs accept UNKNOWN).
  payloadContractCheck: check("print_jobs_payload_contract_check", sql`jsonb_typeof(${table.payload}) = 'object' AND (
    (${table.payload}->>'type' = 'raw' AND COALESCE(${table.payload}->>'protocol', '') in ('raw','escpos','zpl','tspl'))
    OR (${table.payload}->>'type' = 'escpos' AND COALESCE(${table.payload}->>'protocol', '') = 'escpos')
    OR (${table.payload}->>'type' = 'pdf' AND COALESCE(${table.payload}->>'protocol', '') = '')
    OR (${table.payload}->>'type' = 'image' AND COALESCE(${table.payload}->>'protocol', '') = '')
  )`),
}));

// Operational Prometheus counter store. Created by migration 0015 and written
// exclusively via raw SQL in `src/lib/metrics.ts` (metrics must never break a
// print/auth request, so the write path intentionally bypasses the ORM). It is
// declared here so the Drizzle schema is the complete source of truth for every
// table that exists in the database.
export const gatewayMetrics = pgTable("gateway_metrics", {
  name: text("name").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  valueCheck: check("gateway_metrics_value_check", sql`${table.value} >= 0`),
}));

export const printJobRateLimits = pgTable("print_job_rate_limits", {
  apiKeyId: text("api_key_id").references(() => apiKeys.id).primaryKey(),
  minuteWindowStartedAt: timestamp("minute_window_started_at").notNull(),
  minuteCount: integer("minute_count").notNull().default(0),
  hourWindowStartedAt: timestamp("hour_window_started_at").notNull(),
  hourCount: integer("hour_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});