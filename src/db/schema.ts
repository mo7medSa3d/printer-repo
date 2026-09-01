import { pgTable, text, timestamp, jsonb, integer, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
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
}));

export const printers = pgTable("printers", {
  id: text("id").primaryKey(), // printer_...
  branchId: text("branch_id").references(() => branches.id).notNull(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("network"), // legacy compatibility; prefer printerType/connectionType/protocol
  printerType: text("printer_type").notNull().default("thermal"),
  connectionType: text("connection_type").notNull().default("tcp"),
  protocol: text("protocol").notNull().default("escpos"),
  status: text("status").notNull().default("unknown"),
  config: jsonb("config").$type<{
    ip?: string;
    port?: number;
    protocol?: string;
    vid?: number;
    pid?: number;
    serial?: string;
    address?: string;
    spooler_name?: string;
    paper_widths?: number[];
    color_capable?: boolean;
    duplex_capable?: boolean;
  }>(),
  enabled: boolean("enabled").notNull().default(true),
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
  branchIdIdx: index("printers_branch_id_idx").on(table.branchId),
  agentIdx: index("printers_agent_id_idx").on(table.agentId),
  printerTypeIdx: index("printers_printer_type_idx").on(table.printerType),
  statusIdx: index("printers_status_idx").on(table.status),
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
