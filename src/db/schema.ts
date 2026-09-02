import { pgTable, text, timestamp, jsonb, integer, index, uniqueIndex, boolean, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const branches = pgTable("branches", {
  id: text("id").primaryKey(),
  companyId: text("company_id"),
  name: text("name").notNull(),
  description: text("description"),
  location: text("location"),
  timezone: text("timezone"),
  enabled: boolean("enabled").notNull().default(true),
  gatewayUrl: text("gateway_url"),
  metadata: jsonb("metadata").$type<{
    phone?: string;
    address?: string;
    manager_email?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  nameIdx: index("branches_name_idx").on(table.name),
  enabledIdx: index("branches_enabled_idx").on(table.enabled),
}));

export const destinations = pgTable("destinations", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").references(() => branches.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description"),
  zone: text("zone"),
  enabled: boolean("enabled").notNull().default(true),
  metadata: jsonb("metadata").$type<{
    odoo_location_id?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("destinations_branch_id_idx").on(table.branchId),
  typeIdx: index("destinations_type_idx").on(table.type),
  enabledIdx: index("destinations_enabled_idx").on(table.enabled),
}));

export const documentTypes = pgTable("document_types", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").references(() => branches.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  payloadHint: text("payload_hint"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("document_types_branch_id_idx").on(table.branchId),
  nameIdx: index("document_types_name_idx").on(table.name),
  payloadHintCheck: check("document_types_payload_hint_check", sql`${table.payloadHint} IS NULL OR ${table.payloadHint} IN ('raw','escpos','pdf')`),
}));

export const localNetworks = pgTable("local_networks", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").references(() => branches.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  metadata: jsonb("metadata").$type<{
    network_cidr?: string;
    primary_gateway?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("local_networks_branch_id_idx").on(table.branchId),
}));

export const agents = pgTable("agents", {
  id: text("id").primaryKey(), // agt_...
  branchId: text("branch_id").references(() => branches.id).notNull(),
  localNetworkId: text("local_network_id").references(() => localNetworks.id),
  name: text("name").notNull(),
  pairingCode: text("pairing_code"),
  pairingCodeExpiresAt: timestamp("pairing_code_expires_at"),
  secret: text("secret"),
  status: text("status").notNull().default("offline"),
  lifecycle: text("lifecycle").notNull().default("active"),
  metadata: jsonb("metadata").$type<{
    hostname?: string;
    os?: string;
    osVersion?: string;
    version?: string;
  }>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("agents_branch_id_idx").on(table.branchId),
  localNetworkIdIdx: index("agents_local_network_id_idx").on(table.localNetworkId),
  lastSeenIdx: index("agents_last_seen_idx").on(table.lastSeenAt),
  lifecycleCheck: check("agents_lifecycle_check", sql`${table.lifecycle} in ('active','disabled','retired')`),
}));

export const printers = pgTable("printers", {
  id: text("id").primaryKey(), // printer_...
  agentId: text("agent_id").references(() => agents.id).notNull(),
  name: text("name").notNull(),
  printerType: text("printer_type").notNull().default("physical"),
  deviceClass: text("device_class").notNull().default("unknown"),
  connectionType: text("connection_type").notNull().default("network"),
  protocol: text("protocol").notNull().default("raw"),
  status: text("status").notNull().default("unknown"),
  lifecycle: text("lifecycle").notNull().default("active"),
  config: jsonb("config").$type<{
    ip?: string;
    port?: number;
    vid?: number;
    pid?: number;
    serial?: string;
    address?: string;
    spooler_name?: string;
    paper_widths?: number[];
    color_capable?: boolean;
    duplex_capable?: boolean;
  }>(),
  capabilities: jsonb("capabilities").$type<{
    max_paper_width?: number;
    supports_color?: boolean;
    supports_duplex?: boolean;
    supported_protocols?: string[];
  }>(),
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
  protocolCheck: check("printers_protocol_check", sql`${table.protocol} in ('raw','escpos','ipp','ipps','spooler')`),
}));

export const printerBindings = pgTable("printer_bindings", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").references(() => branches.id).notNull(),
  destinationId: text("destination_id").references(() => destinations.id).notNull(),
  documentType: text("document_type"),
  printerId: text("printer_id").references(() => printers.id).notNull(),
  priority: integer("priority").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  enabledAt: timestamp("enabled_at").defaultNow().notNull(),
  disabledAt: timestamp("disabled_at"),
  configOverride: jsonb("config_override"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  routingIdx: index("printer_bindings_routing_idx").on(table.branchId, table.destinationId, table.documentType, table.priority),
  printerIdIdx: index("printer_bindings_printer_id_idx").on(table.printerId),
  enabledIdx: index("printer_bindings_enabled_idx").on(table.enabled),
}));

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").references(() => branches.id),
  scope: text("scope").notNull().default("standard"),
  name: text("name").notNull(),
  description: text("description"),
  hashedKey: text("hashed_key").notNull().unique(),
  allowedDocumentTypes: jsonb("allowed_document_types").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  branchIdIdx: index("api_keys_branch_id_idx").on(table.branchId),
}));

export const managerSessions = pgTable("manager_sessions", {
  jti: text("jti").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  expiresIdx: index("manager_sessions_expires_idx").on(table.expiresAt),
}));

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
  branchId: text("branch_id").references(() => branches.id).notNull(),
  status: text("status").notNull().default("running"),
  config: jsonb("config").$type<{
    cidr?: string;
    protocols?: string[];
    timeoutMs?: number;
    concurrency?: number;
  }>().default({}).notNull(),
  stats: jsonb("stats").$type<{
    candidates?: number;
    verified?: number;
    errors?: number;
    durationMs?: number;
  }>().default({}).notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentIdIdx: index("discovery_sessions_agent_id_idx").on(table.agentId),
  branchIdIdx: index("discovery_sessions_branch_id_idx").on(table.branchId),
  statusIdx: index("discovery_sessions_status_idx").on(table.status),
}));

export const discoveredDevices = pgTable("discovered_devices", {
  id: text("id").primaryKey(),
  discoveryId: text("discovery_id").references(() => discoverySessions.id).notNull(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  branchId: text("branch_id").references(() => branches.id).notNull(),
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
  branchIdIdx: index("discovered_devices_branch_id_idx").on(table.branchId),
  candidateStatusIdx: index("discovered_devices_candidate_status_idx").on(table.candidateStatus),
  confidenceIdx: index("discovered_devices_confidence_idx").on(table.confidence),
}));

export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(),
  branchId: text("branch_id").references(() => branches.id).notNull(),
  destinationId: text("destination_id").references(() => destinations.id),
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
  // Delivery bookkeeping for the claim-before-delivery WS protocol:
  //   deliveryAttempts — how many times the gateway tried to hand the job to
  //                      an agent (WS send or poll response)
  //   deliveredAt      — the moment the job actually left the gateway
  //   ackedAt          — the moment the agent confirmed receipt (WS job_ack)
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveredAt: timestamp("delivered_at"),
  ackedAt: timestamp("acked_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("print_jobs_branch_id_idx").on(table.branchId),
  agentStatusIdx: index("print_jobs_agent_status_idx").on(table.agentId, table.status),
  printerStatusIdx: index("print_jobs_printer_status_idx").on(table.printerId, table.status),
  statusExpiresIdx: index("print_jobs_status_expires_idx").on(table.status, table.expiresAt),
  claimedAtIdx: index("print_jobs_claimed_at_idx").on(table.status, table.claimedAt),
  destinationIdIdx: index("print_jobs_destination_id_idx").on(table.destinationId),
  branchIdempotencyIdx: index("print_jobs_branch_idempotency_idx").on(table.branchId, table.idempotencyKey),
  branchIdempotencyUnique: uniqueIndex("print_jobs_branch_idempotency_unique").on(table.branchId, table.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
}));
