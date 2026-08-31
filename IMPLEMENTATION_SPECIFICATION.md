# IMPLEMENTATION SPECIFICATION: Multi-Branch Odoo Print Gateway

**Date**: 2026-08-31  
**Status**: DESIGN ONLY — No implementation, no code changes  
**Scope**: Detailed specification for multi-branch architecture transformation

---

## PART 1: CURRENT VS TARGET ARCHITECTURE

### 1.1 Current Data Flow

```
Odoo ERP
    │
    ├─ Hardcoded logic: "which printer for this POS?"
    │
    ├─ POST /api/print/jobs
    │   {"printerId": "printer_receipt", "payload": {...}}
    │
    └─> Gateway (Next.js + PostgreSQL)
        │
        ├─ Lookup: printers.id = "printer_receipt"
        │ ├─ Find printers.agentId
        │ └─ Check printers.enabled
        │
        ├─ Insert: printJobs (agentId, printerId, status="queued", payload)
        │
        ├─ Push: WS to agent OR queue for poll
        │
        └─> Agent (Go service)
            │
            ├─ Claim: GET /api/agent/jobs (FOR UPDATE SKIP LOCKED)
            │
            ├─ Local lookup: config.yaml → printer {id, endpoint, type}
            │
            ├─ Per-printer lock (sync.Mutex)
            │
            ├─ Execute: NetworkPrinter.Print(TCP 9100)
            │
            └─> Physical Printer
```

**Problems with current flow**:
- ❌ Odoo hardcodes printer IDs (no UI mapping)
- ❌ No branch context (multi-location mixing risk)
- ❌ No destination concept (business context lost)
- ❌ Printer config split between YAML + PG
- ❌ No per-branch authorization

### 1.2 Target Data Flow

```
Odoo ERP (Source of Truth for Configuration)
    │
    ├─ Models:
    │   ├─ print_gateway.branch (Cairo, Giza, Alexandria)
    │   ├─ print_gateway.destination (POS 1, POS 2, Kitchen 1, Warehouse)
    │   ├─ print_gateway.document_type (receipt, invoice, label, order)
    │   ├─ print_gateway.printer (Physical: TCP IP, USB, Spooler)
    │   └─ print_gateway.printer_binding (dest + doctype → printer)
    │
    ├─ POST /api/print/jobs
    │   {
    │     "branchId": "branch_cairo",
    │     "destinationId": "pos_1",
    │     "documentType": "receipt",
    │     "payload": {...},
    │     "idempotencyKey": "order-123"
    │   }
    │
    └─> Gateway (Orchestration Layer)
        │
        ├─ Validate branchId + destinationId exist
        │
        ├─ Routing lookup:
        │   printer_binding: (branchId, destinationId, documentType)
        │       → printerId (physical printer)
        │
        ├─ Enrich job:
        │   printJobs {
        │     branchId,
        │     destinationId,
        │     documentType,
        │     printerId,
        │     agentId,
        │     status = "queued",
        │     payload
        │   }
        │
        ├─ Push: WS or queue
        │
        └─> Agent (Local Executor)
            │
            ├─ Claim job
            │
            ├─ Local lookup: printer by ID (no config needed; gateway told it what to print)
            │
            ├─ Execute
            │
            └─> Physical Printer
```

**Benefits of target**:
- ✅ Odoo is configuration source of truth
- ✅ Gateway is orchestrator (routing, queue, state)
- ✅ Agent is executor (local printing, no decisions)
- ✅ Full business context preserved in jobs
- ✅ Per-branch isolation and authorization
- ✅ Printer config in Gateway DB (not YAML)

---

## PART 2: GAP ANALYSIS

### 2.1 Missing Entities

| Entity | Current | Required | Gap |
|--------|---------|----------|-----|
| **Company** | ❌ None | Optional parent of branch | Optional for Phase 1 |
| **Branch** | ❌ None (implicit) | ✅ Explicit branch entity | CRITICAL |
| **Local Network** | ❌ None | ✅ Agent organization layer | MEDIUM |
| **Destination** | ❌ None | ✅ POS/Kitchen/Warehouse abstraction | CRITICAL |
| **Document Type** | ❌ None | ✅ Receipt/Invoice/Label/Order abstraction | MEDIUM |
| **Printer Binding** | ❌ None | ✅ Destination+DocType → Printer mapping | CRITICAL |
| **Printer Type** | ⚠️ Partial (only "network" | "usb") | ✅ thermal, laser, inkjet, etc. | MEDIUM |
| **Agent** | ✅ Exists | ✅ Enhance: add branchId + localNetworkId | MEDIUM |
| **Printer** | ✅ Exists | ✅ Enhance: add type, connection, protocol, branch | MEDIUM |
| **Print Job** | ✅ Exists | ✅ Enhance: add branchId, destinationId, documentType | MEDIUM |
| **API Key** | ✅ Exists | ✅ Enhance: add branchId scope | MEDIUM |

### 2.2 Missing Concepts

| Concept | Current | Target | Impact |
|---------|---------|--------|--------|
| **Routing Logic** | Hardcoded in Odoo | Gateway-driven lookup | CRITICAL: Gateway must resolve destination→printer |
| **Printer Config Location** | Agent YAML | Gateway DB | MEDIUM: Printer config moves from YAML to DB |
| **Business Context** | None | Full (branch, destination, doctype) | CRITICAL: Preserved in every job |
| **Authorization Scope** | Global (no boundaries) | Per-branch | CRITICAL: API keys scoped to branch |
| **Agent Registration** | Simple (pairing code) | Scoped (branchId) | MEDIUM: Agent knows which branch it serves |
| **Printer Bindings** | Implicit/hardcoded | Explicit table | CRITICAL: Configurable from Odoo |
| **Fallback Chain** | None | Priority-based | LOW: Multiple printers per destination |

---

## PART 3: ENTITY RELATIONSHIP MODEL

### 3.1 ER Diagram (Text)

```
┌─────────────────────────────────────────────────────────────────┐
│                         ODOO SIDE                               │
│                    (Configuration Owner)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐                                              │
│  │ res.company  │  (Odoo core: legal entity)                   │
│  │ (id, name)   │                                              │
│  └──────┬───────┘                                              │
│         │ 1                                                    │
│         │ many                                                 │
│  ┌──────▼────────────────────────────────────┐                │
│  │   print_gateway.branch                     │                │
│  │   (branch-specific printing setup)         │                │
│  │                                             │                │
│  │  id                      PK                 │                │
│  │  company_id              FK → res.company  │                │
│  │  name                    "Cairo Branch"     │                │
│  │  gateway_url             URL for printing   │                │
│  │  gateway_api_key         Scoped Odoo key   │                │
│  │  enabled                 T/F                │                │
│  └──────┬──────────────┬─────────────────────┘                │
│         │ 1            │ 1                                     │
│         │ many         │ many                                  │
│  ┌──────▼──────────────┐  ┌──────▼──────────────────┐         │
│  │ print_gateway.      │  │ print_gateway.          │         │
│  │ destination         │  │ document_type           │         │
│  │                     │  │                         │         │
│  │ id             PK   │  │ id              PK       │         │
│  │ branch_id      FK   │  │ branch_id       FK       │         │
│  │ name                │  │ name            "receipt"         │
│  │ type (POS,Kitchen)  │  │ description             │         │
│  │ enabled             │  │ enabled                 │         │
│  └──────┬──────────────┘  └─────────────────────────┘         │
│         │                                                      │
│         │ Destination                                         │
│         │ (POS, Kitchen, Warehouse)                           │
│         │                                                      │
└─────────┼──────────────────────────────────────────────────────┘
          │
          │  many-to-many through printer_binding
          │
┌─────────┼──────────────────────────────────────────────────────┐
│         │                   GATEWAY SIDE                        │
│         │             (Runtime Orchestrator)                   │
│         │                                                      │
│  ┌──────▼────────────────────────────────────┐                │
│  │ print_gateway.printer_binding              │                │
│  │ (Route: destination + doctype → printer)  │                │
│  │                                             │                │
│  │  id                      PK                 │                │
│  │  branch_id               FK                 │                │
│  │  destination_id          FK                 │                │
│  │  document_type_id        FK                 │                │
│  │  printer_id              FK (Gateway DB)   │                │
│  │  priority                1 (fallback chain) │                │
│  │  enabled_at              timestamp          │                │
│  │  disabled_at             timestamp (soft)   │                │
│  └────────────────────┬────────────────────────┘                │
│                       │                                        │
│                       │ FK → gateway printers table             │
│                       │                                        │
│  ┌────────────────────▼────────────────────────┐               │
│  │ printers (Gateway DB)                        │               │
│  │ (Physical printer device)                    │               │
│  │                                               │               │
│  │  id                      PK                   │               │
│  │  branch_id               FK                   │               │
│  │  agent_id                FK → agents          │               │
│  │  name                    "POS 1 Receipt"      │               │
│  │  printer_type            "thermal"            │               │
│  │  connection_type         "tcp"                │               │
│  │  protocol                "escpos"             │               │
│  │  config                  JSON {ip, port, ...} │               │
│  │  status                  "online"             │               │
│  │  capabilities            JSON {paper_widths}  │               │
│  │  enabled                 T/F                  │               │
│  │  last_seen_at            timestamp            │               │
│  └────────────────┬─────────────────────────────┘               │
│                   │                                            │
│                   │ FK → agents                                │
│                   │                                            │
│  ┌────────────────▼─────────────────────────────┐              │
│  │ agents (Gateway DB)                           │              │
│  │ (Agent service running on local network)      │              │
│  │                                                │              │
│  │  id                      PK "agt_..."         │              │
│  │  branch_id               FK (NEW)             │              │
│  │  local_network_id        FK (NEW, optional)   │              │
│  │  name                    "Cairo Agent 1"      │              │
│  │  status                  "online"             │              │
│  │  secret                  hashed               │              │
│  │  metadata                JSON                 │              │
│  │  last_seen_at            timestamp            │              │
│  └────────────────────────────────────────────────┘              │
│                                                      │           │
│  ┌────────────────────────────────────────────────┐ │           │
│  │ local_networks (Gateway DB) — NEW              │ │           │
│  │ (Optional: organize multiple agents per branch)│ │           │
│  │                                                │ │           │
│  │  id                      PK                    │ │           │
│  │  branch_id               FK                    │ │           │
│  │  name                    "WiFi" or "Wired"     │ │           │
│  │  description                                  │ │           │
│  │  enabled                 T/F                  │ │           │
│  └────────────────────────────────────────────────┘ │           │
│                                                      │           │
│  ┌────────────────────────────────────────────────┐ │           │
│  │ print_jobs (Gateway DB) — ENHANCED             │ │           │
│  │                                                 │ │           │
│  │  id                      PK                     │ │           │
│  │  branch_id               FK (NEW)               │ │           │
│  │  destination_id          FK (NEW)               │ │           │
│  │  document_type           string (NEW)           │ │           │
│  │  agent_id                FK                     │ │           │
│  │  printer_id              FK                     │ │           │
│  │  status                  enum (queued, ...)     │ │           │
│  │  payload                 JSON                   │ │           │
│  │  error                   text                   │ │           │
│  │  requested_by            string (NEW, audit)    │ │           │
│  │  retries                 int                    │ │           │
│  │  expires_at              timestamp              │ │           │
│  │  created_at, updated_at  timestamps             │ │           │
│  └────────────────────────────────────────────────┘ │           │
│                                                      │           │
│  ┌────────────────────────────────────────────────┐ │           │
│  │ api_keys (Gateway DB) — ENHANCED               │ │           │
│  │                                                 │ │           │
│  │  id                      PK                     │ │           │
│  │  branch_id               FK (NEW, nullable)     │ │           │
│  │  name                    "Odoo Cairo"           │ │           │
│  │  hashed_key              SHA256                 │ │           │
│  │  scope                   enum (NEW)             │ │           │
│  │  allowed_doc_types       JSON (NEW, optional)   │ │           │
│  │  last_used_at            timestamp              │ │           │
│  │  revoked_at              timestamp              │ │           │
│  │  created_at              timestamp              │ │           │
│  └────────────────────────────────────────────────┘ │           │
│                                                      │           │
│  ┌────────────────────────────────────────────────┐ │           │
│  │ manager_sessions (Gateway DB)                  │ │           │
│  │ (unchanged, but add branch scope in future)    │ │           │
│  └────────────────────────────────────────────────┘ │           │
│                                                      │           │
└──────────────────────────────────────────────────────┴───────────┘
```

### 3.2 Relationships Summary

**One-to-Many**:
- Company → Branches (1:N)
- Branch → Destinations (1:N)
- Branch → Local Networks (1:N)
- Branch → Printers (1:N)
- Local Network → Agents (1:N)
- Agent → Printers (1:N)
- Printer → Jobs (1:N)

**Many-to-Many**:
- Destination + Document Type + Branch → Printer (via printer_binding)

**Foreign Keys**:
- `printers.branch_id` → `branches.id`
- `printers.agent_id` → `agents.id`
- `agents.branch_id` → `branches.id`
- `agents.local_network_id` → `local_networks.id` (optional)
- `local_networks.branch_id` → `branches.id`
- `print_jobs.branch_id` → `branches.id`
- `print_jobs.destination_id` → `destinations.id` (optional)
- `print_jobs.agent_id` → `agents.id`
- `print_jobs.printer_id` → `printers.id`
- `printer_binding.branch_id` → `branches.id`
- `printer_binding.destination_id` → `destinations.id`
- `printer_binding.printer_id` → `printers.id`
- `api_keys.branch_id` → `branches.id` (nullable, NULL = unrestricted)

---

## PART 4: DATABASE SCHEMA PROPOSAL

### 4.1 New Tables

#### 4.1.1 `branches`

**Purpose**: Logical grouping of printing infrastructure per location/business unit.

```typescript
// Drizzle ORM definition
export const branches = pgTable("branches", {
  id: text("id").primaryKey(), // "branch_cairo", "branch_giza"
  companyId: text("company_id"), // Future: link to res.company via Odoo integration
  name: text("name").notNull(), // "Cairo Branch", "Giza Warehouse"
  description: text("description"),
  location: text("location"), // Optional geography
  timezone: text("timezone"), // "Africa/Cairo" — for timestamp context
  enabled: boolean("enabled").notNull().default(true),
  
  // Gateway connection (for future Odoo integration)
  gatewayUrl: text("gateway_url"), // URL where this branch's API calls go
  
  // Metadata
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
```

**Why it exists**: Provides explicit business unit organization; enables per-branch configuration, authorization, and audit trails.

**Uniqueness**: `id` is primary key; `(name, company_id)` should be unique (if company_id populated).

**Ownership**: Odoo is source of truth; Gateway stores for runtime reference and job enrichment.

---

#### 4.1.2 `destinations`

**Purpose**: Abstract logical printing endpoints (POS, kitchen, warehouse, office).

```typescript
export const destinations = pgTable("destinations", {
  id: text("id").primaryKey(), // "dest_pos_1", "dest_kitchen_1"
  branchId: text("branch_id").references(() => branches.id).notNull(),
  
  name: text("name").notNull(), // "POS 1", "Kitchen 1", "Warehouse Main"
  type: text("type").notNull(), // enum: "pos", "kitchen", "warehouse", "office", "other"
  description: text("description"),
  
  // Optional: physical location within branch
  zone: text("zone"), // "Dining Area", "Prep Line", "Loading Dock"
  
  enabled: boolean("enabled").notNull().default(true),
  
  metadata: jsonb("metadata").$type<{
    odoo_location_id?: string; // Reference to Odoo location, if any
  }>(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("destinations_branch_id_idx").on(table.branchId),
  typeIdx: index("destinations_type_idx").on(table.type),
  enabledIdx: index("destinations_enabled_idx").on(table.enabled),
}));
```

**Why it exists**: Business abstraction layer. Enables routing rules without hardcoding printer IDs. Supports audit ("which destination requested this print?").

**Uniqueness**: `id` is PK; `(branchId, name)` should be unique (logical constraint).

**Ownership**: Odoo-managed; Gateway uses for routing.

---

#### 4.1.3 `document_types`

**Purpose**: Classify print requests by document purpose.

```typescript
export const documentTypes = pgTable("document_types", {
  id: text("id").primaryKey(), // "doc_receipt", "doc_invoice", "doc_label"
  branchId: text("branch_id").references(() => branches.id).notNull(),
  
  name: text("name").notNull(), // "Receipt", "Invoice", "Kitchen Order", "Shipping Label"
  description: text("description"),
  
  // Optional: expected payload structure hints
  payloadHint: text("payload_hint"), // "escpos", "raw", "ipp", "pdf"
  
  enabled: boolean("enabled").notNull().default(true),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("document_types_branch_id_idx").on(table.branchId),
}));
```

**Why it exists**: Enables fine-grained routing. Different document types may use different printers even from the same destination (e.g., POS prints receipts on thermal, invoices on laser).

**Uniqueness**: `id` is PK; `(branchId, name)` should be unique.

**Ownership**: Odoo-managed; Gateway uses for routing.

---

#### 4.1.4 `printer_bindings`

**Purpose**: Define routing rules: (destination, document_type, branch) → printer(s).

```typescript
export const printerBindings = pgTable("printer_bindings", {
  id: text("id").primaryKey(), // "binding_pos1_receipt_1"
  branchId: text("branch_id").references(() => branches.id).notNull(),
  destinationId: text("destination_id").references(() => destinations.id).notNull(),
  documentTypeId: text("document_type_id").references(() => documentTypes.id).notNull(),
  printerId: text("printer_id").references(() => printers.id).notNull(),
  
  // Priority for fallback chain: lower priority = try first
  // If printer offline, gateway tries next priority
  priority: integer("priority").notNull().default(1),
  
  // Configuration
  enabled: boolean("enabled").notNull().default(true),
  enabledAt: timestamp("enabled_at").defaultNow().notNull(),
  disabledAt: timestamp("disabled_at"), // Soft-delete
  
  // Optional: binding-specific config overrides
  // e.g., "always use color mode" or "duplex disabled"
  configOverride: jsonb("config_override"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  routingIdx: index("printer_bindings_routing_idx").on(
    table.branchId,
    table.destinationId,
    table.documentTypeId,
    table.priority
  ),
  printerIdIdx: index("printer_bindings_printer_id_idx").on(table.printerId),
  enabledIdx: index("printer_bindings_enabled_idx").on(table.enabled),
}));
```

**Why it exists**: Explicit routing configuration. Customer-managed from Odoo. Replaces hardcoded printerId logic in Odoo.

**Uniqueness**: No natural PK; `id` is surrogate. `(branchId, destinationId, documentTypeId, priority)` should be unique.

**Ownership**: Odoo-managed; Gateway uses for routing during job creation.

---

#### 4.1.5 `local_networks`

**Purpose**: Organize agents by network within a branch (optional, for large deployments).

```typescript
export const localNetworks = pgTable("local_networks", {
  id: text("id").primaryKey(), // "net_cairo_wifi", "net_cairo_wired"
  branchId: text("branch_id").references(() => branches.id).notNull(),
  
  name: text("name").notNull(), // "WiFi", "Wired LAN A", "Wired LAN B"
  description: text("description"), // "Main office WiFi", "Kitchen isolated network"
  
  enabled: boolean("enabled").notNull().default(true),
  
  metadata: jsonb("metadata").$type<{
    network_cidr?: string; // Optional: 192.168.1.0/24
    primary_gateway?: string;
  }>(),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("local_networks_branch_id_idx").on(table.branchId),
}));
```

**Why it exists**: Some branches have isolated networks (air-gapped kitchen, separate warehouse LAN). Allows deploying multiple agents per branch.

**Uniqueness**: `id` is PK; `(branchId, name)` should be unique.

**Ownership**: Gateway-managed; conceptual layer for agent organization.

---

### 4.2 Modified Tables

#### 4.2.1 `agents` (Enhanced)

**Current**:
```typescript
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  pairingCode: text("pairing_code"),
  pairingCodeExpiresAt: timestamp("pairing_code_expires_at"),
  secret: text("secret"),
  status: text("status").notNull().default("offline"),
  metadata: jsonb("metadata"),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Target**:
```typescript
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  
  // NEW: Branch association (REQUIRED)
  branchId: text("branch_id").references(() => branches.id).notNull(),
  
  // NEW: Optional local network association
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
  updatedAt: timestamp("updated_at").defaultNow().notNull(), // NEW
}, (table) => ({
  branchIdIdx: index("agents_branch_id_idx").on(table.branchId),
  localNetworkIdIdx: index("agents_local_network_id_idx").on(table.localNetworkId),
  lastSeenIdx: index("agents_last_seen_idx").on(table.lastSeenAt),
}));
```

**Changes**:
- ➕ `branchId` (FK): Every agent belongs to exactly one branch.
- ➕ `localNetworkId` (FK, optional): Agent may serve a specific network within branch.
- ➕ `updatedAt` (timestamp): Track when agent last changed state.

**Why**: Agent must know its branch context for authorization, audit, and multi-branch isolation.

**Backward compatibility**: Make `branchId` nullable temporarily during migration; require non-null in Phase 2.

---

#### 4.2.2 `printers` (Enhanced)

**Current**:
```typescript
export const printers = pgTable("printers", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "usb" | "network"
  status: text("status").notNull().default("unknown"),
  config: jsonb("config"),
  enabled: boolean("enabled").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

**Target**:
```typescript
export const printers = pgTable("printers", {
  id: text("id").primaryKey(), // "printer_xxx"
  
  // NEW: Branch association (for query filtering, audit)
  branchId: text("branch_id").references(() => branches.id).notNull(),
  
  agentId: text("agent_id").references(() => agents.id).notNull(),
  name: text("name").notNull(), // "POS 1 Receipt", "Kitchen Order"
  
  // ENHANCED: More detailed printer classification
  // OLD: type "usb" | "network" → SPLIT into two:
  printerType: text("printer_type").notNull(), // "thermal" | "laser" | "inkjet" | "other"
  connectionType: text("connection_type").notNull(), // "tcp" | "usb" | "spooler" | "ipp"
  protocol: text("protocol").notNull(), // "raw" | "escpos" | "pcl" | "ipp" | "windows_spooler"
  
  status: text("status").notNull().default("unknown"), // "online" | "offline" | "busy" | "error"
  
  // Enhanced config to support all connection types
  config: jsonb("config").$type<{
    // TCP/IP config
    ip?: string;
    port?: number;
    
    // USB config
    vid?: number; // Vendor ID
    pid?: number; // Product ID
    serial?: string;
    address?: string; // USB path
    
    // Windows spooler config
    spooler_name?: string;
    
    // Capability hints
    paper_widths?: number[]; // [58, 80] for thermal
    color_capable?: boolean;
    duplex_capable?: boolean;
  }>(),
  
  enabled: boolean("enabled").notNull().default(true),
  
  // NEW: Capabilities for validation
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
  agentIdIdx: index("printers_agent_id_idx").on(table.agentId),
  typeIdx: index("printers_printer_type_idx").on(table.printerType),
  statusIdx: index("printers_status_idx").on(table.status),
}));
```

**Changes**:
- ➕ `branchId`: Denormalized for query performance and branch isolation.
- ➕ `printerType`: Categorize by device type (thermal, laser, etc.).
- ➕ `connectionType`: How printer connects (TCP, USB, spooler, IPP).
- ➕ `protocol`: Communication protocol (raw, ESC/POS, PCL, IPP, etc.).
- ➕ `capabilities`: Metadata about printer capabilities for validation.
- ➖ Old `type` field replaced by three new fields.

**Why**: Support for diverse printer types and connection methods; enables validation (e.g., "don't send PCL to thermal printer").

**Backward compatibility**: During migration, infer `printerType`, `connectionType`, `protocol` from old `type` field; map "network" → ("thermal", "tcp", "escpos"), "usb" → ("unknown", "usb", "raw").

---

#### 4.2.3 `print_jobs` (Enhanced)

**Current**:
```typescript
export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id).notNull(),
  printerId: text("printer_id").references(() => printers.id).notNull(),
  status: text("status").notNull().default("queued"),
  payload: jsonb("payload").notNull(),
  error: text("error"),
  retries: integer("retries").notNull().default(0),
  claimedAt: timestamp("claimed_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

**Target**:
```typescript
export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(),
  
  // NEW: Business context (for routing, audit, filtering)
  branchId: text("branch_id").references(() => branches.id).notNull(),
  destinationId: text("destination_id").references(() => destinations.id), // Optional: may be unknown
  documentType: text("document_type"), // "receipt", "invoice", "label", "order" (optional)
  
  // Execution context
  agentId: text("agent_id").references(() => agents.id).notNull(),
  printerId: text("printer_id").references(() => printers.id).notNull(),
  
  // Status machine
  status: text("status").notNull().default("queued"), // "queued" | "claimed" | "printing" | "success" | "failed" | "expired"
  
  // Payload data
  payload: jsonb("payload").notNull(),
  
  // Audit trail
  error: text("error"),
  requestedBy: text("requested_by"), // "odoo", "manager", "system" + identifier
  
  // Retry and expiry
  retries: integer("retries").notNull().default(0),
  claimedAt: timestamp("claimed_at"),
  expiresAt: timestamp("expires_at").notNull(),
  
  // Timing
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  branchIdIdx: index("print_jobs_branch_id_idx").on(table.branchId),
  agentStatusIdx: index("print_jobs_agent_status_idx").on(table.agentId, table.status),
  printerStatusIdx: index("print_jobs_printer_status_idx").on(table.printerId, table.status),
  statusExpiresIdx: index("print_jobs_status_expires_idx").on(table.status, table.expiresAt),
  destinationIdIdx: index("print_jobs_destination_id_idx").on(table.destinationId),
}));
```

**Changes**:
- ➕ `branchId`: Denormalized; enables branch-scoped queries and authorization.
- ➕ `destinationId`: Tracks which logical destination requested the print.
- ➕ `documentType`: Classification of print purpose.
- ➕ `requestedBy`: Audit trail (who triggered the print?).

**Why**: Business context preservation; audit trail for compliance; enables branch-scoped queries.

**Backward compatibility**: Make new fields nullable during migration; populate from routing table if available.

---

#### 4.2.4 `api_keys` (Enhanced)

**Current**:
```typescript
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hashedKey: text("hashed_key").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
});
```

**Target**:
```typescript
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  
  // NEW: Scope limitation
  branchId: text("branch_id").references(() => branches.id), // NULL = unrestricted, non-NULL = scoped to branch
  scope: text("scope").notNull().default("standard"), // "standard" | "read_only" | "admin"
  
  name: text("name").notNull(),
  description: text("description"), // "Odoo Cairo", "External integration"
  
  hashedKey: text("hashed_key").notNull().unique(),
  
  // NEW: Fine-grained permissions
  allowedDocumentTypes: jsonb("allowed_document_types").$type<string[]>(), // NULL = all, ["receipt", "invoice"] = scoped
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  branchIdIdx: index("api_keys_branch_id_idx").on(table.branchId),
}));
```

**Changes**:
- ➕ `branchId` (nullable FK): NULL = global access (admin), non-NULL = scoped to one branch.
- ➕ `scope`: Permission level (standard, read_only, admin).
- ➕ `description`: Human-readable purpose.
- ➕ `allowedDocumentTypes`: Optional per-key document type restrictions.

**Why**: Authorization isolation; prevent Odoo Branch A key from printing jobs in Branch B.

**Backward compatibility**: Existing keys get `branchId = NULL` (unrestricted); new keys must specify `branchId`.

---

#### 4.2.5 `manager_sessions` (Unchanged for Phase 1)

```typescript
export const managerSessions = pgTable("manager_sessions", {
  jti: text("jti").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  expiresIdx: index("manager_sessions_expires_idx").on(table.expiresAt),
}));
```

**Note**: In Phase 2, add `branchId` to scope manager access per-branch.

---

### 4.3 Schema Summary Table

| Table | Purpose | Owner | Read | Write | Change Type |
|-------|---------|-------|------|-------|-------------|
| `branches` | Business unit organization | Odoo | Gateway | Odoo → Gateway sync | **NEW** |
| `destinations` | POS/Kitchen/Warehouse abstraction | Odoo | Gateway | Odoo → Gateway sync | **NEW** |
| `document_types` | Print classification (receipt/invoice/label) | Odoo | Gateway | Odoo → Gateway sync | **NEW** |
| `local_networks` | Agent network organization | Gateway | Gateway | Gateway API | **NEW** |
| `printer_bindings` | Routing rules (dest+doctype → printer) | Odoo | Gateway | Odoo → Gateway sync | **NEW** |
| `agents` | Print agents (enhanced) | Gateway | Gateway | Agent registration + heartbeat | **ENHANCED** |
| `printers` | Physical printers (enhanced) | Gateway | Gateway | Heartbeat + manual | **ENHANCED** |
| `print_jobs` | Job queue (enhanced) | Gateway | Gateway | API + agent status updates | **ENHANCED** |
| `api_keys` | Odoo access tokens (enhanced) | Gateway | Gateway | Manager API | **ENHANCED** |
| `manager_sessions` | Manager sessions | Gateway | Gateway | Auth API | unchanged |

---

## PART 5: ODOO MODULE PROPOSAL

### 5.1 Module Structure

**Module name**: `print_gateway` (or `odoo_print_management`)

**Location**: Custom Odoo module, parallel to standard modules.

**Dependencies**: `base`, `sale` (for sale.order integration), optionally `purchase`, `stock`.

### 5.2 Odoo Models

#### 5.2.1 `print_gateway.branch`

```python
class PrintGatewayBranch(models.Model):
    _name = 'print_gateway.branch'
    _description = 'Printing Branch Configuration'
    
    # Identity
    name = fields.Char(
        string='Branch Name',
        required=True,
        help='E.g., "Cairo Branch", "Giza Warehouse"'
    )
    
    # Link to company (optional, for multi-company support)
    company_id = fields.Many2one(
        'res.company',
        string='Company',
        ondelete='cascade',
        help='Parent company (optional)'
    )
    
    # Gateway connection
    gateway_url = fields.Char(
        string='Gateway URL',
        required=True,
        help='Base URL of the print gateway (e.g., https://print.example.com)'
    )
    
    gateway_api_key = fields.Char(
        string='Gateway API Key',
        help='Odoo API key scoped to this branch (created in Gateway dashboard)'
    )
    
    # Status
    enabled = fields.Boolean(default=True)
    
    # Configuration
    description = fields.Text()
    location = fields.Char(help='Physical location / address')
    timezone = fields.Selection(selection=_tz_get, string='Timezone')
    
    # Relations
    destinations = fields.One2many('print_gateway.destination', 'branch_id')
    printers = fields.One2many('print_gateway.printer', 'branch_id')
    document_types = fields.One2many('print_gateway.document_type', 'branch_id')
    printer_bindings = fields.One2many('print_gateway.printer_binding', 'branch_id')
    agents = fields.One2many('print_gateway.agent', 'branch_id')
    
    # Status from gateway
    agent_count = fields.Integer(compute='_compute_agent_count', string='Agents Online')
    printer_count = fields.Integer(compute='_compute_printer_count', string='Printers Total')
    
    def _compute_agent_count(self):
        for rec in self:
            rec.agent_count = len(rec.agents.filtered(lambda a: a.status == 'online'))
    
    def _compute_printer_count(self):
        for rec in self:
            rec.printer_count = len(rec.printers)
    
    def sync_from_gateway(self):
        """Sync agents and printers from gateway"""
        # Call gateway API GET /api/branches/{id}/agents
        # Call gateway API GET /api/branches/{id}/printers
        pass
    
    def test_connection(self):
        """Test connectivity to gateway"""
        # Call gateway API GET /api/health
        pass
    
    _sql_constraints = [
        ('name_company_unique', 'unique(name, company_id)', 'Branch name must be unique per company'),
    ]
```

**Why this model**:
- Represents a physical or logical branch (Cairo, Giza, Alexandria).
- Stores gateway connection details.
- Parent of destinations, printers, bindings.
- Provides sync methods to pull agent/printer status.

---

#### 5.2.2 `print_gateway.destination`

```python
class PrintGatewayDestination(models.Model):
    _name = 'print_gateway.destination'
    _description = 'Printing Destination (POS, Kitchen, Warehouse)'
    
    # Identity
    name = fields.Char(required=True, help='E.g., "POS 1", "Kitchen 1", "Warehouse"')
    
    # Classification
    destination_type = fields.Selection(
        selection=[
            ('pos', 'POS Terminal'),
            ('kitchen', 'Kitchen'),
            ('warehouse', 'Warehouse'),
            ('office', 'Office'),
            ('other', 'Other'),
        ],
        required=True,
        help='Type of destination'
    )
    
    # Hierarchy
    branch_id = fields.Many2one(
        'print_gateway.branch',
        required=True,
        ondelete='cascade'
    )
    
    # Details
    description = fields.Text()
    zone = fields.Char(help='Physical zone / area within branch (optional)')
    
    # Status
    enabled = fields.Boolean(default=True)
    
    # Relations
    printer_bindings = fields.One2many('print_gateway.printer_binding', 'destination_id')
    
    # Computed
    receipt_printer = fields.Many2one(
        'print_gateway.printer',
        compute='_compute_printers_by_doctype',
        help='Printer assigned for receipt documents'
    )
    invoice_printer = fields.Many2one(
        'print_gateway.printer',
        compute='_compute_printers_by_doctype',
        help='Printer assigned for invoice documents'
    )
    label_printer = fields.Many2one(
        'print_gateway.printer',
        compute='_compute_printers_by_doctype',
        help='Printer assigned for label documents'
    )
    
    def _compute_printers_by_doctype(self):
        for rec in self:
            # Find bindings for common doctypes
            rec.receipt_printer = rec.printer_bindings.filtered(
                lambda b: b.document_type_id.name == 'Receipt'
            ).sorted('priority').printer_id[:1] or False
            # ... similar for invoice, label
    
    def get_printer_for_doctype(self, document_type_name):
        """
        Returns the printer_id to use for a given document type.
        Resolves from printer_bindings with fallback chain.
        """
        bindings = self.printer_bindings.filtered(
            lambda b: b.document_type_id.name == document_type_name
        ).sorted('priority')
        
        if bindings:
            return bindings[0].printer_id
        
        # Fallback: any printer
        return self.printer_bindings.sorted('priority').printer_id[:1] or None
    
    _sql_constraints = [
        ('name_branch_unique', 'unique(name, branch_id)', 'Destination name must be unique per branch'),
    ]
```

**Why this model**:
- Represents a logical printing destination (POS 1, Kitchen 1, etc.).
- Not a physical printer; can map to different printers.
- Enables routing configuration in Odoo UI.

---

#### 5.2.3 `print_gateway.document_type`

```python
class PrintGatewayDocumentType(models.Model):
    _name = 'print_gateway.document_type'
    _description = 'Document Type / Printing Purpose'
    
    # Identity
    name = fields.Char(required=True, help='E.g., "Receipt", "Invoice", "Label"')
    
    # Hierarchy
    branch_id = fields.Many2one(
        'print_gateway.branch',
        required=True,
        ondelete='cascade'
    )
    
    # Details
    description = fields.Text()
    
    # Payload hints (for validation/routing)
    payload_hint = fields.Selection(
        selection=[
            ('raw', 'Raw Binary'),
            ('escpos', 'ESC/POS'),
            ('pcl', 'PCL'),
            ('ipp', 'IPP'),
            ('pdf', 'PDF'),
        ],
        help='Expected payload format for this document type'
    )
    
    # Status
    enabled = fields.Boolean(default=True)
    
    # Relations
    printer_bindings = fields.One2many('print_gateway.printer_binding', 'document_type_id')
    
    _sql_constraints = [
        ('name_branch_unique', 'unique(name, branch_id)', 'Document type must be unique per branch'),
    ]
```

**Why this model**:
- Classifies print requests by purpose (receipt, invoice, label, etc.).
- Enables differentiated routing from the same destination.

---

#### 5.2.4 `print_gateway.printer`

```python
class PrintGatewayPrinter(models.Model):
    _name = 'print_gateway.printer'
    _description = 'Physical Printer in Branch'
    
    # Identity (from gateway)
    gateway_printer_id = fields.Char(
        required=True,
        help='Printer ID from gateway (e.g., "printer_xxx")'
    )
    
    name = fields.Char(required=True, help='Human-readable name')
    
    # Hierarchy
    branch_id = fields.Many2one(
        'print_gateway.branch',
        required=True,
        ondelete='cascade'
    )
    
    # Classification
    printer_type = fields.Selection(
        selection=[
            ('thermal', 'Thermal Receipt'),
            ('laser', 'Laser'),
            ('inkjet', 'Inkjet'),
            ('spooler', 'Windows Spooler / Network'),
            ('other', 'Other'),
        ],
        help='Type of printer device'
    )
    
    connection_type = fields.Selection(
        selection=[
            ('tcp', 'Network (TCP)'),
            ('usb', 'USB'),
            ('spooler', 'Windows Spooler'),
            ('ipp', 'IPP'),
        ],
        help='How the printer is connected'
    )
    
    protocol = fields.Selection(
        selection=[
            ('raw', 'Raw Binary'),
            ('escpos', 'ESC/POS'),
            ('pcl', 'PCL'),
            ('ipp', 'IPP Protocol'),
            ('windows_spooler', 'Windows Spooler'),
        ],
        help='Communication protocol'
    )
    
    # Status from gateway (synced)
    status = fields.Selection(
        selection=[
            ('online', 'Online'),
            ('offline', 'Offline'),
            ('busy', 'Busy'),
            ('unknown', 'Unknown'),
        ],
        default='unknown',
        help='Last known status from gateway'
    )
    
    # Configuration
    ip_address = fields.Char(help='Network IP (if TCP)')
    port = fields.Integer(help='Network port (if TCP)')
    usb_serial = fields.Char(help='USB serial number (if USB)')
    spooler_name = fields.Char(help='Windows spooler printer name')
    
    enabled = fields.Boolean(default=True)
    
    # Relations
    bindings = fields.One2many('print_gateway.printer_binding', 'printer_id')
    
    # Computed
    binding_count = fields.Integer(compute='_compute_binding_count')
    destinations = fields.Many2many(
        'print_gateway.destination',
        compute='_compute_destinations',
        string='Assigned to Destinations'
    )
    
    def _compute_binding_count(self):
        for rec in self:
            rec.binding_count = len(rec.bindings)
    
    def _compute_destinations(self):
        for rec in self:
            rec.destinations = rec.bindings.mapped('destination_id')
    
    def sync_from_gateway(self):
        """Pull printer status from gateway"""
        # Call gateway API GET /api/printers/{id}
        # Update self.status, last_seen_at
        pass
    
    def test_print(self):
        """Send test print job to this printer"""
        # Call gateway API POST /api/printers/{id}/test-print
        # Create a print_job record for tracking
        pass
    
    _sql_constraints = [
        ('gateway_printer_id_unique', 'unique(gateway_printer_id, branch_id)', 'Printer ID must be unique per branch'),
    ]
```

**Why this model**:
- Represents a physical printer in the branch.
- Stores connection details (IP, USB serial, spooler name).
- Synced from gateway for real-time status.

---

#### 5.2.5 `print_gateway.printer_binding`

```python
class PrintGatewayPrinterBinding(models.Model):
    _name = 'print_gateway.printer_binding'
    _description = 'Printer Routing Rule (Destination + DocType → Printer)'
    
    # The routing rule: (destination, document_type) → printer
    branch_id = fields.Many2one(
        'print_gateway.branch',
        required=True,
        ondelete='cascade',
        help='Branch this binding belongs to'
    )
    
    destination_id = fields.Many2one(
        'print_gateway.destination',
        required=True,
        ondelete='cascade',
        help='Which destination (POS, kitchen, etc.)'
    )
    
    document_type_id = fields.Many2one(
        'print_gateway.document_type',
        required=True,
        ondelete='cascade',
        help='Which document type (receipt, invoice, label, etc.)'
    )
    
    printer_id = fields.Many2one(
        'print_gateway.printer',
        required=True,
        ondelete='restrict',
        help='Which printer to use'
    )
    
    # Priority (for fallback chain)
    priority = fields.Integer(
        default=1,
        help='Priority for fallback chain (1=highest, lower number = try first)'
    )
    
    # Status
    enabled = fields.Boolean(default=True)
    
    # Metadata
    config_override = fields.Jsonb(
        help='Optional printer config overrides for this binding (e.g., {"color": true})'
    )
    
    notes = fields.Text(help='Internal notes about this binding')
    
    def name_get(self):
        result = []
        for rec in self:
            name = f'{rec.destination_id.name} + {rec.document_type_id.name} → {rec.printer_id.name}'
            result.append((rec.id, name))
        return result
    
    _sql_constraints = [
        ('routing_unique', 'unique(branch_id, destination_id, document_type_id, priority)',
         'Only one binding per destination+doctype+priority'),
    ]
    
    _order = 'branch_id, destination_id, document_type_id, priority'
```

**Why this model**:
- Encodes the routing rules: "when printing from POS 1 a receipt, use Printer A".
- Configurable from Odoo UI.
- Enables fallback chain (priority).

---

#### 5.2.6 `print_gateway.agent` (Optional, Read-only)

```python
class PrintGatewayAgent(models.Model):
    _name = 'print_gateway.agent'
    _description = 'Print Agent (Read-only from Gateway)'
    
    # Synced from gateway
    gateway_agent_id = fields.Char(required=True, unique=True)
    
    name = fields.Char()
    
    branch_id = fields.Many2one(
        'print_gateway.branch',
        ondelete='cascade'
    )
    
    status = fields.Selection(
        selection=[('online', 'Online'), ('offline', 'Offline'), ('unknown', 'Unknown')],
        default='unknown'
    )
    
    last_seen_at = fields.Datetime()
    
    # Metadata from agent
    hostname = fields.Char()
    os = fields.Char()
    version = fields.Char()
    
    # Relations
    printers = fields.One2many('print_gateway.printer', 'agent_id')
    
    _order = 'branch_id, name'
    
    def sync_from_gateway(self):
        """Pull agent status from gateway"""
        # Call gateway API GET /api/agents/{id}
        pass
```

**Why this model**:
- Read-only view of agents from gateway.
- Provides visibility into agent fleet health.
- Not a data entry point; purely for monitoring.

---

#### 5.2.7 `print_gateway.print_job` (Optional, Audit Trail)

```python
class PrintGatewayPrintJob(models.Model):
    _name = 'print_gateway.print_job'
    _description = 'Print Job History / Audit Trail'
    
    # Synced from gateway
    gateway_job_id = fields.Char(required=True, unique=True)
    
    branch_id = fields.Many2one('print_gateway.branch', ondelete='set null')
    destination_id = fields.Many2one('print_gateway.destination', ondelete='set null')
    printer_id = fields.Many2one('print_gateway.printer', ondelete='set null')
    document_type = fields.Char()
    
    status = fields.Selection(
        selection=[
            ('queued', 'Queued'),
            ('claimed', 'Claimed'),
            ('printing', 'Printing'),
            ('success', 'Success'),
            ('failed', 'Failed'),
            ('expired', 'Expired'),
        ]
    )
    
    error = fields.Text()
    requested_by = fields.Char()
    
    created_at = fields.Datetime()
    updated_at = fields.Datetime()
    
    # Link to sale order (optional)
    sale_order_id = fields.Many2one('sale.order', ondelete='set null')
    
    _order = 'created_at desc'
    
    def sync_from_gateway(self):
        """Pull job status from gateway"""
        # Call gateway API GET /api/print-jobs/{id}
        pass
```

**Why this model**:
- Audit trail for compliance and troubleshooting.
- Read-only view of gateway jobs.
- Optional; not required for Phase 1.

---

### 5.3 Odoo Module Integration Points

#### 5.3.1 Sale Order Integration (Print on Invoice)

```python
# In sale.order model or via action button

def action_print_invoice(self):
    """
    Print invoice for this sales order.
    Routing: find destination (POS 1) + doctype (Invoice) → printer
    """
    # Step 1: Determine which destination/branch this sale is from
    branch = self._determine_branch()  # e.g., from location, warehouse, POS terminal
    if not branch:
        raise UserError("Cannot determine branch for this sale order")
    
    # Step 2: Determine document type
    document_type = self.env['print_gateway.document_type'].search([
        ('branch_id', '=', branch.id),
        ('name', '=', 'Invoice'),
    ], limit=1)
    if not document_type:
        raise UserError("Document type 'Invoice' not configured for branch")
    
    # Step 3: Determine destination (POS terminal)
    destination = self._determine_destination(branch)  # e.g., from sale.order.pos_id
    if not destination:
        raise UserError("Cannot determine destination for this sale order")
    
    # Step 4: Resolve printer via binding
    binding = self.env['print_gateway.printer_binding'].search([
        ('branch_id', '=', branch.id),
        ('destination_id', '=', destination.id),
        ('document_type_id', '=', document_type.id),
        ('enabled', '=', True),
    ], order='priority', limit=1)
    if not binding:
        raise UserError(f"No printer binding for {destination.name} + {document_type.name}")
    
    printer = binding.printer_id
    
    # Step 5: Generate payload (PDF or ESC/POS)
    payload_base64 = self._generate_invoice_payload(printer.protocol)
    
    # Step 6: Call gateway API to create print job
    gateway_response = branch._call_gateway_api(
        'POST', '/api/print/jobs',
        {
            'branchId': branch.id,
            'destinationId': destination.id,
            'documentType': 'invoice',
            'payload': {
                'type': 'raw' if printer.protocol == 'raw' else 'escpos',
                'encoding': 'base64',
                'data': payload_base64,
            },
            'idempotencyKey': f'sale_{self.id}_invoice_{self.name}',
        }
    )
    
    # Step 7: Create print_job record for audit
    print_job = self.env['print_gateway.print_job'].create({
        'gateway_job_id': gateway_response['jobId'],
        'branch_id': branch.id,
        'destination_id': destination.id,
        'printer_id': printer.id,
        'document_type': 'invoice',
        'status': gateway_response['status'],
        'sale_order_id': self.id,
    })
    
    return {
        'type': 'ir.actions.client',
        'tag': 'display_notification',
        'params': {
            'title': 'Print Job Queued',
            'message': f'Invoice printing on {printer.name}',
            'type': 'success',
        }
    }
```

**Why this integration**:
- Enables end-to-end printing from Odoo.
- Automatically routes based on branch + destination + doctype.
- No hardcoded printer IDs in sale.order code.

---

### 5.4 Odoo UI Screens (Mockup)

#### 5.4.1 Branch List & Edit

```
┌─────────────────────────────────────────────────────────────┐
│ Print Gateway → Branches                                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Create] [Refresh Status]                                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Name          │ Gateway URL      │ Agents │ Status   │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ Cairo Branch  │ https://gw.../   │   3   │ ✅      │   │
│  │ Giza Branch   │ https://gw.../   │   2   │ ✅      │   │
│  │ Alex Branch   │ https://gw.../   │   1   │ ⚠️       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘

[Click to view/edit branch details]

┌─────────────────────────────────────────────────────────────┐
│ Print Gateway Branch Detail: Cairo                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Name:           [Cairo Branch]                             │
│  Company:        [Company A]                                │
│  Gateway URL:    [https://print.example.com]                │
│  Gateway API Key:[odoo_xxxx] (encrypted)                    │
│  Location:       [Cairo, Egypt]                             │
│  Timezone:       [Africa/Cairo]                             │
│  Enabled:        [✓] Yes                                    │
│                                                             │
│  ┌─ Destinations ─────────────────────────────────────┐    │
│  │ [Add Row]                                           │    │
│  │ Name         │ Type    │ Zone    │ Enabled          │    │
│  │ POS 1        │ POS     │ Dining  │ [✓]              │    │
│  │ POS 2        │ POS     │ Dining  │ [✓]              │    │
│  │ Kitchen 1    │ Kitchen │ Prep    │ [✓]              │    │
│  │ Warehouse    │ Warehouse│ Main   │ [✓]              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ Printers ─────────────────────────────────────────┐    │
│  │ Name           │ Type    │ Status   │ Agent         │    │
│  │ POS 1 Receipt  │ Thermal │ Online   │ Agent 1       │    │
│  │ Kitchen Order  │ Thermal │ Offline  │ Agent 1       │    │
│  │ Warehouse Label│ Laser   │ Online   │ Agent 2       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  [Save] [Sync from Gateway] [Test Connection]               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 5.4.2 Printer Bindings (Routing Rules)

```
┌─────────────────────────────────────────────────────────────┐
│ Print Gateway → Printer Bindings (Cairo Branch)             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Branch: [Cairo Branch] ▼                                   │
│  [Add Binding]                                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Destination  │ Document Type │ Printer      │ Pri    │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ POS 1        │ Receipt       │ POS 1 Receipt│ 1  ✓   │   │
│  │ POS 1        │ Invoice       │ Laser A      │ 1  ✓   │   │
│  │ POS 2        │ Receipt       │ POS 2 Receipt│ 1  ✓   │   │
│  │ Kitchen 1    │ Order         │ Kitchen Therm│ 1  ✓   │   │
│  │ Warehouse    │ Label         │ Warehouse Lab│ 1  ✓   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [Click to edit]                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘

[Edit Binding]

┌─────────────────────────────────────────────────────────────┐
│ Edit Binding: POS 1 + Receipt → POS 1 Receipt Printer      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Branch:         [Cairo Branch]                             │
│  Destination:    [POS 1] ▼                                  │
│  Document Type:  [Receipt] ▼                                │
│  Printer:        [POS 1 Receipt Printer] ▼                  │
│  Priority:       [1]                                        │
│  Enabled:        [✓] Yes                                    │
│  Config Override:[{...}]                                    │
│                                                             │
│  [Save]                                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 5.4.3 Printer Status Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ Print Gateway → Printer Status (Cairo Branch)               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Refresh Status] [Test All]                                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Printer         │ Type     │ Status   │ Agent   │ Act │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │ POS 1 Receipt   │ Thermal  │ ✅Online │ Agent 1 │ ...│  │
│  │ POS 2 Receipt   │ Thermal  │ ✅Online │ Agent 1 │ ...│  │
│  │ Kitchen Therm   │ Thermal  │ ❌Offline│ Agent 2 │ ...│  │
│  │ Warehouse Label │ Laser    │ ✅Online │ Agent 3 │ ...│  │
│  │ Invoice Printer │ Laser    │ ⚠️ Busy  │ Agent 1 │ ...│  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  [Click for details]                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘

[Printer Details]

┌─────────────────────────────────────────────────────────────┐
│ Printer: POS 1 Receipt (Thermal, TCP)                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  IP Address:    192.168.1.50                                │
│  Port:          9100                                        │
│  Protocol:      ESC/POS                                     │
│  Status:        Online                                      │
│  Last Seen:     2 min ago                                   │
│  Agent:         Agent 1 (Cairo WiFi)                        │
│                                                             │
│  Used by:       POS 1 Receipt, POS 2 Receipt               │
│                                                             │
│  [Test Print] [Edit] [Sync Status]                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## PART 6: GATEWAY API CHANGES

### 6.1 New Endpoint: Print Job with Business Context

**Current API**:
```
POST /api/print/jobs
Authorization: Bearer odoo_xxx
{
  "printerId": "printer_receipt",
  "payload": {...},
  "idempotencyKey": "order-123"
}
```

**Target API**:
```
POST /api/print/jobs
Authorization: Bearer odoo_xxx
{
  "branchId": "branch_cairo",
  "destinationId": "dest_pos_1",
  "documentType": "receipt",
  "payload": {
    "type": "raw|escpos",
    "encoding": "base64",
    "data": "..."
  },
  "expiresAt": "2026-09-01T12:00:00Z",
  "idempotencyKey": "order-123"
}
```

**Response**:
```json
{
  "jobId": "job_xxx",
  "status": "queued",
  "branchId": "branch_cairo",
  "destinationId": "dest_pos_1",
  "printerId": "printer_receipt",
  "agentId": "agt_xxx"
}
```

**Implementation in `src/app/api/print/jobs/route.ts`**:

```typescript
// Pseudo-code; not actual implementation

export async function POST(req: Request) {
  // 1. Validate Odoo API key + branch scope
  const odoo = await validateOdooKey(req);
  const branchId = parsedBody.branchId;
  
  // Enforce: API key must be scoped to this branch (or unrestricted)
  if (odoo.branchId && odoo.branchId !== branchId) {
    return 401 Unauthorized;
  }
  
  // 2. Validate inputs
  if (!branchId || !destinationId || !documentType) {
    return 400 Bad Request;
  }
  
  // 3. Resolve routing: (branch, destination, doctype) → printer
  const binding = db.query.printerBindings.findFirst({
    where: and(
      eq(printerBindings.branchId, branchId),
      eq(printerBindings.destinationId, destinationId),
      eq(printerBindings.documentType, documentType),
    ),
    orderBy: printerBindings.priority,
  });
  
  if (!binding) {
    return 404 No printer binding found;
  }
  
  const printer = await db.query.printers.findFirst({
    where: eq(printers.id, binding.printerId),
  });
  
  if (!printer) {
    return 404 Printer not found;
  }
  
  // 4. Create job with full context
  const jobId = `job_${nanoid(10)}`;
  await db.insert(printJobs).values({
    id: jobId,
    branchId: branchId,
    destinationId: destinationId,
    documentType: documentType,
    agentId: printer.agentId,
    printerId: printer.id,
    status: "queued",
    payload: validatedPayload,
    expiresAt: expiresAt,
    requestedBy: `odoo:${odoo.id}`,
  });
  
  // 5. Push to agent
  await pushJobToAgentWithClaim({...});
  
  // 6. Return response
  return {
    jobId,
    status: "queued",
    branchId,
    destinationId,
    printerId: printer.id,
    agentId: printer.agentId,
  };
}
```

**Files affected**:
- `src/app/api/print/jobs/route.ts` — Routing logic + validation
- `src/lib/odoo-auth.ts` — Add branch scope check to `validateOdooKey`
- `src/db/schema.ts` — Updated schema already exists from Part 4

---

### 6.2 New Endpoint: List Branches

**Endpoint**:
```
GET /api/branches
Authorization: Bearer manager_jwt | odoo_key
```

**Response**:
```json
[
  {
    "branchId": "branch_cairo",
    "name": "Cairo Branch",
    "agentCount": 3,
    "printerCount": 8
  },
  ...
]
```

**Authorization**:
- Manager: Can see all branches (or scoped ones in Phase 2)
- Odoo key: Can see only scoped branch (or all if unrestricted)

---

### 6.3 Enhanced Endpoint: Get Printer Bindings

**Endpoint**:
```
GET /api/branches/{branchId}/printer-bindings
Authorization: Bearer manager_jwt | odoo_key
```

**Response**:
```json
[
  {
    "bindingId": "binding_1",
    "destinationId": "dest_pos_1",
    "destinationName": "POS 1",
    "documentType": "receipt",
    "printerId": "printer_receipt_1",
    "printerName": "POS 1 Receipt",
    "priority": 1,
    "enabled": true
  },
  ...
]
```

**Why**: Odoo module needs to query available bindings for dynamic UI (dropdowns, validation).

---

### 6.4 Modified Endpoint: Agent Registration

**Current**:
```
POST /api/agent/register
{
  "pairingCode": "ABCDEF",
  "metadata": {...}
}
```

**Target**:
```
POST /api/agent/register
{
  "pairingCode": "ABCDEF",
  "branchId": "branch_cairo",  // NEW (optional in Phase 1)
  "localNetworkId": "net_cairo_wifi",  // NEW (optional)
  "metadata": {...}
}
```

**Response**:
```json
{
  "agentId": "agt_xxx",
  "secret": "...",
  "branchId": "branch_cairo"  // NEW
}
```

**Implementation**:
- Agent CLI must support `--branch-id` and `--network-id` flags
- Gateway saves these to agent record
- Enables per-branch agent organization

---

### 6.5 New Endpoint: Sync Printer Configuration to Agent

**Endpoint**:
```
GET /api/agents/{agentId}/printers
Authorization: Bearer agent_secret
```

**Response**:
```json
[
  {
    "id": "printer_receipt_1",
    "name": "POS 1 Receipt",
    "type": "thermal",
    "connectionType": "tcp",
    "protocol": "escpos",
    "config": {
      "ip": "192.168.1.50",
      "port": 9100
    }
  },
  ...
]
```

**Why**: Phase 1 plan: pull printer config from Gateway instead of YAML. Agent queries this endpoint on startup.

**Implementation**: New route in `src/app/api/agents/{id}/printers/route.ts`

---

## PART 7: ROUTING ENGINE DESIGN

### 7.1 Routing Flow

```
Input: (branchId, destinationId, documentType, payload)
         ↓
Step 1: Validate inputs exist in database
         ↓
Step 2: Query printer_bindings for (branchId, destinationId, documentType)
         ├─ Order by priority (ascending)
         ├─ Filter enabled = true
         └─ Return list of printer_id + priority
         ↓
Step 3: For each printer in priority order:
         ├─ Check printer.enabled = true
         ├─ Check printer.status != offline (optional, for fail-fast)
         └─ Select first available
         ↓
Step 4: Get agent_id from printer.agentId
         ↓
Step 5: Create job:
         {
           branchId,
           destinationId,
           documentType,
           printerId,
           agentId,
           status = "queued",
           payload,
           requestedBy
         }
         ↓
Output: jobId (ready to execute)
```

### 7.2 Routing Engine Code Structure

**File**: `src/lib/routing.ts` (NEW)

```typescript
export async function resolveJobRoute(input: {
  branchId: string;
  destinationId: string;
  documentType: string;
}): Promise<{
  printerId: string;
  agentId: string;
  bindingId: string;
}> {
  // Step 1: Validate branch, destination, doctype exist
  const branch = await db.query.branches.findFirst({
    where: eq(branches.id, input.branchId),
  });
  if (!branch) throw new Error('Branch not found');
  
  const destination = await db.query.destinations.findFirst({
    where: and(
      eq(destinations.id, input.destinationId),
      eq(destinations.branchId, input.branchId),
    ),
  });
  if (!destination) throw new Error('Destination not found');
  
  const docType = await db.query.documentTypes.findFirst({
    where: and(
      eq(documentTypes.name, input.documentType),
      eq(documentTypes.branchId, input.branchId),
    ),
  });
  if (!docType) throw new Error('Document type not found');
  
  // Step 2: Query bindings ordered by priority
  const bindings = await db.query.printerBindings.findMany({
    where: and(
      eq(printerBindings.branchId, input.branchId),
      eq(printerBindings.destinationId, input.destinationId),
      eq(printerBindings.documentTypeId, docType.id),
      eq(printerBindings.enabled, true),
    ),
    orderBy: printerBindings.priority,
  });
  
  if (bindings.length === 0) {
    throw new Error('No printer bindings found for this route');
  }
  
  // Step 3: Try each binding, select first enabled printer
  for (const binding of bindings) {
    const printer = await db.query.printers.findFirst({
      where: eq(printers.id, binding.printerId),
    });
    
    if (!printer) continue;
    if (!printer.enabled) continue;
    // Optional: if (printer.status === 'offline') continue;
    
    // Found a viable printer
    return {
      printerId: printer.id,
      agentId: printer.agentId,
      bindingId: binding.id,
    };
  }
  
  throw new Error('No available printers in fallback chain');
}
```

### 7.3 Fallback Chain Example

**Scenario**: POS 1 wants to print receipt, but preferred printer is offline.

**Bindings configured**:
```
1. POS 1 + Receipt → Printer A (priority 1, preferred)
2. POS 1 + Receipt → Printer B (priority 2, fallback)
3. POS 1 + Receipt → Printer C (priority 3, last resort)
```

**Runtime**: If Printer A offline, gateway tries Printer B. If B offline, tries C.

**Implementation**: The loop above handles this automatically.

---

## PART 8: AGENT REGISTRATION & CONFIGURATION

### 8.1 Current Agent Registration

**Files**:
- `src/app/api/agent/register/route.ts` — Gateway registration endpoint
- `agent/internal/agent/agent.go` — Agent main loop
- `agent/internal/config/config.go` — Config loading from YAML

**Current flow**:
1. Admin creates pairing code in Gateway dashboard
2. Agent CLI: `odoo-agent-cli.exe -pair ABCDEF -server https://gateway`
3. Agent retrieves `agentId` + `secret`, stores in `C:\ProgramData\OdooPrintAgent\config.yaml`
4. Agent loads printers from YAML, heartbeats to Gateway

---

### 8.2 Target Agent Registration

**Phase 1 (Backward compatible)**:
- Agent registration accepts optional `branchId` + `localNetworkId`
- If not provided, default to NULL (single-branch mode)
- Agent still loads printers from YAML (no change)

**Phase 2 (Printer config from Gateway)**:
- Agent registration requires `branchId` (break backward compat)
- Agent fetches printers from `GET /api/agents/{id}/printers` on startup
- No more YAML printer config needed

### 8.3 Agent CLI Changes

**Current**:
```powershell
.\odoo-agent-cli.exe -pair ABCDEF -server https://gateway
```

**Target (Phase 1)**:
```powershell
.\odoo-agent-cli.exe -pair ABCDEF -server https://gateway -branch branch_cairo -network net_cairo_wifi
```

**Implementation**:
- `agent/cmd/cli/main.go` — Add flags `--branch`, `--network`
- `src/app/api/agent/register/route.ts` — Accept optional fields, pass to agent record

### 8.4 Config.yaml Evolution

**Current** [agent/configs/config.yaml.example](agent/configs/config.yaml.example):
```yaml
server:
  url: "https://your-gateway.example.com"

agent:
  id: ""
  secret: ""
  name: "Main Office Agent"

printers:
  - id: "printer_kitchen"
    name: "Kitchen Printer"
    type: "network"
    endpoint: "192.168.1.50:9100"
    protocol: "escpos"
```

**Target (Phase 1, minimal changes)**:
```yaml
server:
  url: "https://your-gateway.example.com"

agent:
  id: ""
  secret: ""
  name: "Cairo Agent 1"
  branch_id: ""  # NEW (optional in Phase 1)
  local_network_id: ""  # NEW (optional)

printers:
  # Same as before; printers still loaded locally in Phase 1
  - id: "printer_kitchen"
    name: "Kitchen Printer"
    type: "network"
    endpoint: "192.168.1.50:9100"
    protocol: "escpos"
```

**Target (Phase 2, Gateway-sourced)**:
```yaml
server:
  url: "https://your-gateway.example.com"

agent:
  id: ""
  secret: ""
  name: "Cairo Agent 1"
  branch_id: "branch_cairo"  # REQUIRED
  local_network_id: "net_cairo_wifi"

# printers section removed; fetched from Gateway at startup
```

---

## PART 9: PRINTER ABSTRACTION CHANGES

### 9.1 Current Printer Support

**File**: `agent/internal/printer/factory.go`

| Type | Protocol | Status |
|------|----------|--------|
| network + raw | Raw TCP | ✅ Implemented |
| network + escpos | ESC/POS over TCP | ✅ Implemented |
| network + ipp | IPP | ❌ Not implemented |
| usb | — | ❌ Stub error |

### 9.2 Target Printer Support (Roadmap)

**Phase 1** (Current implementation, minimal changes):
- Network RAW TCP (✅ keep as-is)
- Network ESC/POS (✅ keep as-is)
- USB (❌ still not implemented)
- Windows Spooler (❌ still not implemented)
- IPP (❌ still not implemented)

**Phase 2** (Extended printer types):
- USB (implement `OpenPrinterW` / `GetPrinterPortName` on Windows)
- Windows Spooler (implement `WritePrinter` via cgo)
- IPP (third-party Go library or custom client)

**Phase 3** (Advanced):
- PDF printer driver
- Bluetooth printers
- Cloud printers (Google Cloud Print, etc.)

### 9.3 Printer Type Validation

**New concept**: Validate payload vs printer capabilities.

**Example rules**:
- ESC/POS payload → only send to thermal printers
- PCL payload → only send to laser/office printers
- PDF payload → only send to document printers

**Implementation**: Add validation in `src/app/api/print/jobs/route.ts`:

```typescript
function validatePayloadForPrinter(payload, printer) {
  const payloadProtocol = payload.type; // "raw", "escpos", "pcl"
  const printerProtocol = printer.protocol;
  
  if (payloadProtocol === "escpos" && printerProtocol !== "escpos") {
    throw new Error("ESC/POS payload requires ESC/POS printer");
  }
  
  if (payloadProtocol === "pcl" && !["pcl", "raw"].includes(printerProtocol)) {
    throw new Error("PCL payload requires PCL or raw printer");
  }
  
  // etc.
}
```

---

## PART 10: AUTHENTICATION & AUTHORIZATION MODEL

### 10.1 Three Auth Domains (Unchanged)

| Domain | Credential | Scope | Use Case |
|--------|-----------|-------|----------|
| **Odoo** | Bearer token `odoo_xxx` | Branch (optional) | Print job creation from Odoo |
| **Agent** | Bearer `agt_xxx:secret` | Single agent | Job polling, heartbeat |
| **Manager** | JWT httpOnly cookie | Global or per-branch (Phase 2) | Dashboard management |

### 10.2 Odoo API Key Scoping (NEW)

**Database**:
```typescript
apiKeys.branchId  // NULL = unrestricted, non-NULL = scoped
apiKeys.scope     // "standard" | "read_only" | "admin"
```

**Validation in `validateOdooKey`**:

```typescript
export async function validateOdooKey(req: Request) {
  const key = extractBearerToken(req);
  const hashed = hashKey(key);
  
  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.hashedKey, hashed),
  });
  
  if (!apiKey) throw new Error('Invalid API key');
  if (apiKey.revokedAt) throw new Error('API key revoked');
  
  // NEW: Return branch scope
  return {
    id: apiKey.id,
    branchId: apiKey.branchId,  // NULL if unrestricted
    scope: apiKey.scope,
  };
}
```

**Enforcement in `POST /api/print/jobs`**:

```typescript
const odoo = await validateOdooKey(req);
const requestedBranchId = parsedBody.branchId;

// If key is scoped and requested branch doesn't match, reject
if (odoo.branchId && odoo.branchId !== requestedBranchId) {
  return 401 Unauthorized;
}
```

### 10.3 Agent Authorization (Enhanced)

**Current**: Agent can read jobs scoped to its `agent_id`.

**Target (Phase 2)**: Agent can additionally verify jobs belong to its `branch_id` + `local_network_id`.

```typescript
// In GET /api/agent/jobs
const agent = await validateAgent(req);

// Query jobs for this agent AND this branch
const jobs = await db.query.printJobs.findMany({
  where: and(
    eq(printJobs.agentId, agent.id),
    eq(printJobs.branchId, agent.branchId),  // NEW verification
    // ... status filters
  ),
});
```

### 10.4 Manager Authorization (Phase 2)

**Current**: Manager can see all agents, printers, jobs.

**Target**: Manager scoped to one branch (via session or token).

```typescript
// In GET /api/agents
const manager = await validateManager(req);

const agents = await db.query.agents.findMany({
  where: manager.branchId ? eq(agents.branchId, manager.branchId) : undefined,
});
```

---

## PART 11: DATA SYNCHRONIZATION FLOW

### 11.1 Odoo → Gateway Sync

**Entities**: branches, destinations, document_types, printer_bindings, printers

**Mechanism**: Webhook or cron job in Odoo, calls Gateway API.

```
Odoo ERP
  ├─ Cron (every 5 min) or Webhook (on record change)
  │
  ├─ Call: POST /api/sync/branches
  │   Payload: [{branch_id, name, enabled, ...}, ...]
  │
  ├─ Call: POST /api/sync/destinations
  │   Payload: [{destination_id, branch_id, name, type, ...}, ...]
  │
  ├─ Call: POST /api/sync/document-types
  │   Payload: [{doc_type_id, branch_id, name, ...}, ...]
  │
  ├─ Call: POST /api/sync/printer-bindings
  │   Payload: [{binding_id, dest_id, doctype_id, printer_id, priority}, ...]
  │
  └─ Call: POST /api/sync/printers (optional)
      Payload: [{printer_id, name, type, connection, protocol}, ...]
```

**Implementation**:
- New endpoints in `src/app/api/sync/*.ts` (protected by admin key)
- Upsert logic: `INSERT ... ON CONFLICT ... DO UPDATE`
- Soft-delete support (disabled_at timestamp)

### 11.2 Gateway → Odoo Sync

**Entities**: agent status, printer status, print jobs (audit trail)

**Mechanism**: Optional; Odoo polls for status.

```
Odoo ERP (Cron, every 30 sec)
  │
  ├─ Call: GET /api/agents/{branch_id}
  │   Response: [{agent_id, name, status, last_seen}, ...]
  │   Odoo updates print_gateway.agent records
  │
  ├─ Call: GET /api/printers/{branch_id}
  │   Response: [{printer_id, name, status, last_seen}, ...]
  │   Odoo updates print_gateway.printer records
  │
  └─ Call: GET /api/print-jobs?branch_id=X&limit=100
      Response: [{job_id, status, error, created_at, ...}, ...]
      Odoo creates print_gateway.print_job audit records
```

### 11.3 Agent ↔ Gateway (Unchanged)

- Agent heartbeat: `POST /api/agent/heartbeat` (every 30s)
- Agent polling: `GET /api/agent/jobs` (every 10s if no WS)
- Agent status update: `PATCH /api/agent/jobs` (on job completion)

---

## PART 12: MIGRATION STRATEGY

### 12.1 Phase 0 → Phase 1 Migration (Current → Multi-branch foundation)

**Goals**:
- Add new tables (branches, destinations, document_types, local_networks, printer_bindings)
- Enhance existing tables (agents, printers, print_jobs, api_keys)
- Deploy new routing logic
- Maintain backward compatibility

**Steps**:

1. **Database Migration** (0-downtime using Drizzle):
   ```sql
   CREATE TABLE branches (...);
   CREATE TABLE destinations (...);
   CREATE TABLE document_types (...);
   CREATE TABLE local_networks (...);
   CREATE TABLE printer_bindings (...);
   
   ALTER TABLE agents ADD COLUMN branch_id (nullable);
   ALTER TABLE agents ADD COLUMN local_network_id (nullable);
   ALTER TABLE agents ADD COLUMN updated_at (timestamp);
   
   ALTER TABLE printers ADD COLUMN branch_id (nullable);
   ALTER TABLE printers ADD COLUMN printer_type (nullable);
   ALTER TABLE printers ADD COLUMN connection_type (nullable);
   ALTER TABLE printers ADD COLUMN protocol (nullable);
   ALTER TABLE printers ADD COLUMN capabilities (jsonb);
   
   ALTER TABLE print_jobs ADD COLUMN branch_id (nullable);
   ALTER TABLE print_jobs ADD COLUMN destination_id (nullable);
   ALTER TABLE print_jobs ADD COLUMN document_type (nullable);
   ALTER TABLE print_jobs ADD COLUMN requested_by (nullable);
   
   ALTER TABLE api_keys ADD COLUMN branch_id (nullable);
   ALTER TABLE api_keys ADD COLUMN scope (text default 'standard');
   ALTER TABLE api_keys ADD COLUMN allowed_document_types (jsonb);
   ```

2. **Backfill Old Data**:
   ```sql
   -- If no branches exist, create a default "Default Branch"
   INSERT INTO branches (id, name) VALUES ('default', 'Default Branch');
   
   -- Assign all existing agents to default branch
   UPDATE agents SET branch_id = 'default' WHERE branch_id IS NULL;
   
   -- Assign all existing printers to default branch
   UPDATE printers SET branch_id = 'default' WHERE branch_id IS NULL;
   
   -- Infer printer_type, connection_type, protocol from old 'type' field
   UPDATE printers SET
     printer_type = 'thermal',
     connection_type = CASE WHEN type = 'network' THEN 'tcp' ELSE 'usb' END,
     protocol = CASE WHEN type = 'network' THEN 'escpos' ELSE 'raw' END
   WHERE printer_type IS NULL;
   ```

3. **Deploy New API** (old endpoint still works):
   - New `POST /api/print/jobs` with branchId + destinationId support
   - Old `POST /api/print/jobs` with printerId still works (routes to "Default Branch")
   - Routing engine in place

4. **Odoo Module Installation** (optional for Phase 1):
   - Install `print_gateway` module
   - Configure at least one branch
   - Create destinations, bindings
   - Begin using new API from Odoo

5. **Verification**:
   - Old single-branch deployments still work
   - New multi-branch deployments can opt-in
   - All jobs tracked with branchId (even if "Default")

---

### 12.2 Phase 1 → Phase 2 Migration (Full multi-branch)

**Goals**:
- Require branchId on all agent registrations
- Move printer config from YAML to Gateway DB
- Enforce per-branch authorization

**Steps**:

1. **Make branchId mandatory**:
   ```typescript
   // In POST /api/agent/register
   if (!body.branchId) {
     return 400 Bad Request "branchId is required";
   }
   ```

2. **Agent fetches printers from Gateway**:
   - Agent startup: `GET /api/agents/{id}/printers`
   - Parse response, populate internal printer map
   - No more YAML printer config needed

3. **Enforce per-branch API keys**:
   - Dashboard requires specifying branchId when creating Odoo key
   - Keys without branchId are deprecated (marked for removal)

---

## PART 13: BACKWARD COMPATIBILITY STRATEGY

### 13.1 Deprecated Patterns (Phase 1, still works)

| Pattern | Current | Future | Migration |
|---------|---------|--------|-----------|
| **Single-branch deployment** | Works as-is | Auto-maps to "Default Branch" | No action needed |
| **Agent without branchId** | Allowed | Optional in Phase 1, required in Phase 2 | Recommended: update at next registration |
| **API key without branchId** | All keys unrestricted | Recommended: scope to branch | Optional in Phase 1 |
| **Printer config from YAML** | Primary method | Deprecated; move to Gateway DB in Phase 2 | Phase 1: no change; Phase 2: fetch from API |
| **Old print job API (printerId)** | Works | Deprecated; use new API (branchId+dest+doctype) | Keep old endpoint working via adapter |

### 13.2 Adapter for Old API

**Concept**: Keep `POST /api/print/jobs` accepting `printerId`, translate to new format internally.

```typescript
export async function POST_LEGACY(req: Request) {
  const odoo = await validateOdooKey(req);
  const { printerId, payload, ... } = parsedBody;
  
  // Find printer
  const printer = await db.query.printers.findFirst({
    where: eq(printers.id, printerId),
  });
  if (!printer) return 404;
  
  // Translate to new format
  return POST_NEW(req, {
    branchId: printer.branchId,
    destinationId: null,  // Unknown from old API
    documentType: null,   // Unknown from old API
    payload,
    ...
  });
}
```

### 13.3 What Cannot Change

❌ **Do NOT break these**:
- Agent heartbeat format (`POST /api/agent/heartbeat`)
- Agent job claiming (`GET /api/agent/jobs`)
- Agent status updates (`PATCH /api/agent/jobs`)
- Agent registration response (still returns `agentId` + `secret`)
- Payload format (`{type, encoding, data}`)
- Job status machine (`queued → claimed → printing → success/failed`)

✅ **Safe to enhance**:
- Add optional fields to requests (new fields)
- Add fields to responses (JSON is extensible)
- Add new endpoints (don't break old ones)

---

## PART 14: TESTING STRATEGY

### 14.1 Unit Tests

**New test files**:
- `tests/routing.test.ts` — Routing engine (resolveJobRoute)
- `tests/printer-validation.test.ts` — Printer type/capability validation
- `tests/odoo-api-scoping.test.ts` — API key branch scoping
- `agent/internal/agent/routing_test.go` — Agent-side routing validation

**Test cases**:
```typescript
describe('routing engine', () => {
  test('resolves route (destination + doctype → printer)', async () => {
    // Given: branch, destination, doctype, binding, printer
    // When: resolveJobRoute(branch, dest, doctype)
    // Then: returns correct printerId + agentId
  });
  
  test('fallback: uses secondary printer if primary offline', async () => {
    // Given: two bindings, priority 1 & 2
    // When: priority 1 printer disabled
    // Then: routes to priority 2 printer
  });
  
  test('rejects if no binding found', async () => {
    // Given: no printer_binding for (branch, dest, doctype)
    // When: resolveJobRoute(...)
    // Then: throws error
  });
});
```

### 14.2 Integration Tests

**Current test infrastructure**: `tests/odoo-simulation.test.ts` (already exists)

**New integration tests**:
- Multi-branch job creation (different Odoo keys, different branches)
- Printer binding resolution end-to-end
- Agent per-branch isolation (agent A cannot claim jobs for branch B)
- API key scoping enforcement

```typescript
describe('multi-branch integration', () => {
  test('branch A and B each get own printer bindings', async () => {
    // Given: two branches with different printers + bindings
    // When: POST /api/print/jobs for branch A
    // Then: routes to branch A's printer, not B's
  });
  
  test('Odoo key scoped to branch A cannot print in branch B', async () => {
    // Given: API key with branchId="A"
    // When: POST /api/print/jobs with branchId="B"
    // Then: 401 Unauthorized
  });
});
```

### 14.3 End-to-End Tests (Manual / CI)

**Scenario 1: Single-branch backward compatibility**
- No multi-branch setup
- Old API still works (printerId only)
- Jobs created successfully

**Scenario 2: Multi-branch deployment**
- Setup 2 branches, 2 destinations, 4 printers
- Create bindings (dest1+receipt→printer1, dest2+receipt→printer2, etc.)
- Send print jobs for each destination
- Verify correct printer receives each job

**Scenario 3: Fallback chain**
- Primary printer offline
- Secondary printer receives job

### 14.4 Agent Tests (Go)

**Current**: `agent/internal/agent/dispatch_test.go`, `agent/internal/agent/agent_test.go`

**Enhancements**:
- Verify agent respects branchId when claiming jobs
- Verify agent rejects jobs for wrong branch

```go
func TestAgentRespectsBranchId(t *testing.T) {
  // Given: agent registered to branch_cairo
  // When: job created for branch_giza
  // Then: agent does NOT claim it
}
```

---

## PART 15: RISKS & EDGE CASES

### 15.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Data leakage: Branch A prints in Branch B** | MEDIUM | CRITICAL | Enforce branchId on every auth boundary; test multi-branch scenarios |
| **Migration downtime** | LOW | HIGH | Use Drizzle 0-downtime migrations; test on staging |
| **Agent breaks without branchId** | MEDIUM | HIGH | Make branchId optional in Phase 1; warn in logs if NULL |
| **Printer config lost** | LOW | HIGH | Backfill printers to Gateway DB; agents fall back to YAML in Phase 1 |
| **Routing engine returns wrong printer** | MEDIUM | MEDIUM | Comprehensive unit tests; fallback to default printer if resolution fails |
| **Odoo module not installed** | MEDIUM | MEDIUM | System still works without module; old API works; new API returns errors if no bindings |
| **API key migration** | MEDIUM | LOW | Old keys still work (unrestricted); new keys encourage scoping |
| **Agent can't register without branchId (Phase 2)** | HIGH | HIGH | Provide migration guide; graceful error message in registration |

### 15.2 Edge Cases

| Edge Case | Current Behavior | Target Behavior |
|-----------|-----------------|-----------------|
| **No printer bindings exist for route** | — | 404 error "No printer binding found" |
| **All printers in fallback chain offline** | — | 409 error "No available printers"; job stays queued, agent re-tries on poll |
| **API key has no branchId (unrestricted)** | Only applies to Phase 0 | Can print to any branch (admin/super-user key) |
| **Agent has no branchId (Phase 1)** | Agent works (maps to NULL) | On Phase 2 upgrade, agent must re-register with branchId |
| **Destination in branch A, printer in branch B** | — | Constraint violation; database FK prevents this |
| **Print job created for non-existent destination** | — | 404 "Destination not found in branch" |
| **Odoo key scoped to branch A, prints to branch B** | — | 401 "API key scoped to branch A, not B" |
| **Agent claims job from wrong branch** | — | 404 "Job not found (scoped to agent's branch)" |

---

## PART 16: RECOMMENDED IMPLEMENTATION ORDER

### Phase 1: Multi-Branch Foundation (Weeks 1-4)

**Week 1: Database & Schema**
1. Design final schema (Part 4, completed above)
2. Drizzle migration: create new tables
3. Drizzle migration: enhance existing tables
4. Backfill data (default branch, printer type inference)
5. Verify schema with PG on staging

**Week 2: Routing Engine**
1. Implement `src/lib/routing.ts` resolveJobRoute()
2. Unit tests for routing logic
3. Implement printer binding CRUD API (manager dashboard)
4. Implement branch/destination/doctype CRUD API (manager dashboard)

**Week 3: API Enhancement**
1. Enhance `POST /api/print/jobs` to accept branchId + destinationId + documentType
2. Implement routing in print job creation
3. Add backward-compatibility adapter for old API (printerId)
4. Add branch scope validation to `validateOdooKey`
5. Enhance `GET /api/branches`, `GET /api/printer-bindings` endpoints

**Week 4: Agent & Testing**
1. Enhance agent registration to accept optional branchId + localNetworkId
2. Update agent CLI with `--branch-id`, `--network-id` flags
3. Integration tests for multi-branch scenarios
4. E2E manual testing (2-branch setup, verify routing)
5. Backward compatibility testing (single-branch mode still works)

**Deliverables**:
- ✅ Multi-branch database schema
- ✅ Routing engine (destination+doctype → printer)
- ✅ Enhanced print job API
- ✅ Backward-compatible old API
- ✅ Agent registration with optional branchId
- ✅ Full test coverage
- ✅ Deploy to staging

---

### Phase 2: Odoo Module & Config Sync (Weeks 5-7)

**Week 5: Odoo Module (Python)**
1. Create `print_gateway` module structure
2. Implement models: branch, destination, document_type, printer, agent, printer_binding
3. Implement sync API: `POST /api/sync/branches`, etc.
4. Implement Odoo UI views for each model
5. Test module installation on customer Odoo instance

**Week 6: Data Synchronization**
1. Implement Odoo cron job (sync to Gateway every 5 min)
2. Implement Odoo webhook (on record change, sync immediately)
3. Implement Gateway → Odoo polling (agent/printer status)
4. Test bidirectional sync scenarios
5. Handle conflicts and merge logic

**Week 7: Integration & Hardening**
1. Enhance sale.order with `action_print_invoice()` (uses new API)
2. Document Odoo module setup & configuration
3. Integration tests (Odoo → Gateway → Agent → Printer)
4. Make branchId mandatory in agent registration (Phase 2)
5. Deprecate old API (printerId only), schedule for removal

**Deliverables**:
- ✅ Odoo `print_gateway` module
- ✅ Sync API endpoints
- ✅ Bidirectional data sync
- ✅ Odoo UI for configuration
- ✅ Full integration tests
- ✅ Deploy to production

---

### Phase 3: Printer Type Expansion & Optimization (Weeks 8-10)

**Week 8: Extended Printer Types**
1. Implement USB Windows backend (OpenPrinterW, WritePrinter)
2. Implement Windows Spooler backend
3. Add IPP client (third-party library evaluation)
4. Update printer.type enum and validation
5. Add capability negotiation (paper sizes, colors, duplex)

**Week 9: Gateway → Agent Config Sync**
1. Implement `GET /api/agents/{id}/printers` endpoint
2. Update agent startup to fetch printers from Gateway
3. Remove YAML printer config requirement (Phase 2 change)
4. Make printer config Gateway-managed, not YAML-based
5. Test agent restart and config refresh

**Week 10: Performance & Hardening**
1. Performance tuning: indexes, query optimization
2. Add caching (printer bindings, agent status)
3. Implement metrics/telemetry (job throughput, printer uptime)
4. Comprehensive documentation
5. Customer UAT and feedback

**Deliverables**:
- ✅ USB, Spooler, IPP printer support
- ✅ Printer config from Gateway (not YAML)
- ✅ Agent fetches config at startup
- ✅ Performance optimizations
- ✅ Production hardening

---

## PART 17: FILES AFFECTED SUMMARY

### New Files to Create

| File | Purpose | Phase |
|------|---------|-------|
| `src/db/migrations/001_multi_branch_schema.sql` | Drizzle migration | 1 |
| `src/lib/routing.ts` | Routing engine | 1 |
| `src/app/api/branches/route.ts` | Branch management API | 1 |
| `src/app/api/branches/[id]/destinations/route.ts` | Destination API | 1 |
| `src/app/api/branches/[id]/printer-bindings/route.ts` | Binding API | 1 |
| `src/app/api/sync/branches/route.ts` | Sync from Odoo | 2 |
| `src/app/api/sync/destinations/route.ts` | Sync from Odoo | 2 |
| `src/app/api/sync/printer-bindings/route.ts` | Sync from Odoo | 2 |
| `src/app/api/agents/[id]/printers/route.ts` | Config sync to agent | 2 |
| `tests/routing.test.ts` | Routing tests | 1 |
| `tests/multi-branch.test.ts` | Multi-branch integration tests | 1 |
| `agent/internal/agent/routing_test.go` | Agent routing tests | 1 |

### Files to Modify

| File | Changes | Phase |
|------|---------|-------|
| `src/db/schema.ts` | Add new tables, enhance existing | 1 |
| `src/app/api/print/jobs/route.ts` | Add branchId+destinationId routing | 1 |
| `src/lib/odoo-auth.ts` | Add branch scope validation | 1 |
| `src/app/api/agent/register/route.ts` | Accept optional branchId | 1 |
| `src/app/api/agents/route.ts` | Add branch filtering | 2 |
| `src/app/api/printers/route.ts` | Add branch association | 1 |
| `agent/cmd/cli/main.go` | Add --branch-id, --network-id flags | 1 |
| `agent/internal/config/config.go` | Add branch_id, local_network_id fields | 1 |
| `agent/internal/agent/agent.go` | Verify jobs belong to agent's branch | 2 |

### Files That Can Stay Unchanged

| File | Reason |
|------|--------|
| `agent/internal/printer/network.go` | TCP printing logic doesn't change |
| `agent/internal/printer/factory.go` | Factory pattern still works (add new types in Phase 3) |
| `agent/internal/queue/queue.go` | SQLite queue implementation doesn't change |
| `src/lib/payload.ts` | Payload validation unchanged |
| `src/lib/job-status.ts` | Job status machine unchanged |

---

## PART 18: SUCCESS CRITERIA

### Phase 1 Success Criteria

- ✅ All new tables created and populated with default/backfilled data
- ✅ Routing engine resolves (destination+doctype → printer) correctly
- ✅ New API (`POST /api/print/jobs` with branchId+destinationId) works
- ✅ Old API (printerId) still works (backward compatible)
- ✅ Multi-branch test scenario: 2 branches, 4 destinations, 8 printers, correct routing
- ✅ Agent registration accepts optional branchId, stores correctly
- ✅ Jobs include branchId in database (even if "Default Branch")
- ✅ Single-branch deployments continue to work unchanged
- ✅ All existing tests pass
- ✅ New unit tests for routing (>90% coverage)
- ✅ Staging deployment stable for 1 week

### Phase 2 Success Criteria

- ✅ Odoo module installs and configures without errors
- ✅ Odoo → Gateway sync works (branches, destinations, bindings)
- ✅ Gateway → Odoo polling works (agent/printer status)
- ✅ Odoo UI displays branch status, printer status, job history
- ✅ Odoo sale.order can print invoices via new routing
- ✅ Multi-tenant isolation verified (Branch A key cannot print in Branch B)
- ✅ branchId now required for agent registration
- ✅ All integration tests pass
- ✅ Customer UAT on staging (if available)

### Phase 3 Success Criteria

- ✅ USB printers work (Windows backend implemented)
- ✅ Windows Spooler printers work
- ✅ IPP printers work (if included)
- ✅ Agent fetches printer config from Gateway (no YAML)
- ✅ Printer capability validation prevents misrouted jobs
- ✅ Performance benchmarks met (print job latency <2s)
- ✅ Full documentation complete
- ✅ Production deployment to customer environment

---

## END OF IMPLEMENTATION SPECIFICATION

**Document**: Complete target architecture specification  
**Phases**: 3 phases over 10 weeks  
**Status**: DESIGN ONLY — Ready for implementation phase  
**Next Step**: Begin Phase 1 Week 1 (Database & Schema)
