import { pgTable, text, timestamp, jsonb, integer, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

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
  // Nullable BY DESIGN: retiring an agent revokes its credential by setting
  // this to NULL. No hash input produces NULL, so every authenticated call
  // from a retired agent fails closed.
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
  statusIdx: index("agents_status_idx").on(table.status),
  lastSeenIdx: index("agents_last_seen_idx").on(table.lastSeenAt),
}));

/**
 * Printers are owned by exactly one Agent, and an Agent belongs to exactly one
 * Branch:
 *
 *     Branch → Agent → Printer
 *
 * There is deliberately NO `branch_id` column here. A printer's branch is
 * ALWAYS derived through its agent (`printer.agent_id → agents.branch_id`).
 * Re-introducing a branch column (under any name) would recreate the two
 * conflicting sources of truth this schema was migrated away from
 * (drizzle/0006_printer_branch_via_agent.sql).
 */
export const printers = pgTable("printers", {
  id: text("id").primaryKey(), // printer_...
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
  // Matches compareBindings(): priority ASC then id ASC, so PostgreSQL can
  // return routing candidates already in the deterministic order.
  routingDeterministicIdx: index("printer_bindings_routing_deterministic_idx").on(table.branchId, table.destinationId, table.documentType, table.priority, table.id),
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
  // Retention sweep selects on (locked_until, updated_at).
  updatedAtIdx: index("auth_rate_limits_updated_at_idx").on(table.updatedAt),
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

/* ---------------------------------------------------------------------------
 * Relations
 *
 * Canonical ownership chain:
 *
 *     branches ──< agents ──< printers
 *
 * `printers` has no branch column: use `printer.agent.branchId`. The relation
 * below is what makes `db.query.printers.findFirst({ with: { agent: true } })`
 * (and therefore every branch derivation in the gateway) possible.
 * ------------------------------------------------------------------------ */

export const branchesRelations = relations(branches, ({ many }) => ({
  agents: many(agents),
  destinations: many(destinations),
  documentTypes: many(documentTypes),
  localNetworks: many(localNetworks),
  printerBindings: many(printerBindings),
  printJobs: many(printJobs),
  apiKeys: many(apiKeys),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  branch: one(branches, { fields: [agents.branchId], references: [branches.id] }),
  localNetwork: one(localNetworks, { fields: [agents.localNetworkId], references: [localNetworks.id] }),
  printers: many(printers),
  printJobs: many(printJobs),
}));

export const printersRelations = relations(printers, ({ one, many }) => ({
  /** The ONLY path from a printer to its branch: printer → agent → branch. */
  agent: one(agents, { fields: [printers.agentId], references: [agents.id] }),
  bindings: many(printerBindings),
  printJobs: many(printJobs),
}));

export const destinationsRelations = relations(destinations, ({ one, many }) => ({
  branch: one(branches, { fields: [destinations.branchId], references: [branches.id] }),
  bindings: many(printerBindings),
}));

export const documentTypesRelations = relations(documentTypes, ({ one }) => ({
  branch: one(branches, { fields: [documentTypes.branchId], references: [branches.id] }),
}));

export const localNetworksRelations = relations(localNetworks, ({ one, many }) => ({
  branch: one(branches, { fields: [localNetworks.branchId], references: [branches.id] }),
  agents: many(agents),
}));

export const printerBindingsRelations = relations(printerBindings, ({ one }) => ({
  branch: one(branches, { fields: [printerBindings.branchId], references: [branches.id] }),
  destination: one(destinations, { fields: [printerBindings.destinationId], references: [destinations.id] }),
  printer: one(printers, { fields: [printerBindings.printerId], references: [printers.id] }),
}));

export const printJobsRelations = relations(printJobs, ({ one }) => ({
  branch: one(branches, { fields: [printJobs.branchId], references: [branches.id] }),
  destination: one(destinations, { fields: [printJobs.destinationId], references: [destinations.id] }),
  agent: one(agents, { fields: [printJobs.agentId], references: [agents.id] }),
  printer: one(printers, { fields: [printJobs.printerId], references: [printers.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  branch: one(branches, { fields: [apiKeys.branchId], references: [branches.id] }),
}));
