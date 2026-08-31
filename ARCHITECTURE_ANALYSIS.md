# ARCHITECTURAL ANALYSIS: Current Implementation vs. Client Requirements

**Date**: 2026-08-31  
**Scope**: Complete audit of code against multi-branch, multi-printer, Odoo-controlled routing requirements  
**Analysis Level**: Evidence-based, code-referenced, no assumptions

---

## EXECUTIVE SUMMARY

The current project implements a **single-gateway, multi-agent, basic print-job dispatcher** suitable for **single-location, single-network deployments** or **multiple isolated locations each managing their own agents independently**. 

It does **NOT** support:
- **Multi-branch Odoo instances** (no company/branch entity)
- **Logical printer routing** from Odoo (hardcoded printer IDs only)
- **Centralized printer assignment management** (printer config lives in agent YAML)
- **Multi-network agents** within a single branch (no network/local-network concept)
- **Odoo-driven routing rules** (Odoo just sends raw printerId)

---

## SECTION 1: CURRENT ARCHITECTURE

### 1.1 Flow: Odoo → Gateway → Agent → Printer

**Evidence**: [API.md](API.md#L55-L62), [ARCHITECTURE.md](ARCHITECTURE.md#L17-L25), [src/app/api/print/jobs/route.ts](src/app/api/print/jobs/route.ts#L21-L91)

```
Odoo 
  │
  ├─ (1) POST /api/print/jobs
  │   Authorization: Bearer odoo_xxx
  │   {"printerId":"printer_receipt", "payload":{...}, "idempotencyKey":"order-123"}
  │
  └─> Gateway (Next.js + PostgreSQL)
        │
        ├─ (2) Validate printerId exists → [printers] table
        │       [Evidence: src/app/api/print/jobs/route.ts:34]
        │
        ├─ (3) Look up printer.agentId  
        │       [Evidence: printers.agentId foreign key → agents.id]
        │
        ├─ (4) Insert [printJobs] row with agentId + printerId
        │       status = "queued"
        │       [Evidence: src/app/api/print/jobs/route.ts:77]
        │
        ├─ (5a) Push job via WebSocket to agent (best-effort)
        │        [Evidence: src/server/ws.ts → pushJobToAgentWithClaim]
        │        If WS connected, atomic claim: queued → claimed
        │
        ├─ (5b) Or: Agent polls GET /api/agent/jobs (fallback)
        │        Claims up to 20 queued jobs with FOR UPDATE SKIP LOCKED
        │        [Evidence: src/app/api/agent/jobs/route.ts:49-71]
        │
        └─> Agent (Go Windows Service)
              │
              ├─ (6) Receive job {id, printerId, payload, expiresAt}
              │       [Evidence: agent/internal/agent/agent.go:515]
              │
              ├─ (7) Look up printer by printerId in local config
              │       [Evidence: agent/internal/agent/agent.go:546-551]
              │       If not found → PATCH /api/agent/jobs with status:"failed"
              │
              ├─ (8) Parse payload (strict base64 → {type,encoding,data})
              │       [Evidence: agent/internal/payload/payload.go]
              │
              ├─ (9) Per-printer lock (serialize same printer)
              │       [Evidence: agent/internal/agent/agent.go:555-558]
              │
              ├─ (10) Insert local SQLite queue (durable, crash-safe)
              │        [Evidence: agent/internal/queue/queue.go:14]
              │
              ├─ (11) PATCH /api/agent/jobs status:printing
              │        [Evidence: agent/internal/agent/agent.go:565]
              │
              ├─ (12) NetworkPrinter.Print(data)
              │        TCP dial ip:port, timeout 5s, send all bytes
              │        [Evidence: agent/internal/printer/network.go:13-50]
              │
              ├─ (13) Success = socket write complete (NOT paper physically out)
              │        [Evidence: PRINTERS.md, agent/internal/printer/network.go:50]
              │
              ├─ (14) PATCH /api/agent/jobs status:success or failed
              │        [Evidence: agent/internal/agent/agent.go:584-589]
              │
              └─> Printer
                    TCP receive on port 9100 (raw or ESC/POS)
```

**Key Characteristics**:
- **Printer identification**: Raw ID string (e.g. `printer_receipt`)
- **No business context**: Odoo sends only printerId, no branch/POS/warehouse info
- **Gateway-centric**: Gateway owns job lifecycle (PG `printJobs` table)
- **Agent-centric printer config**: Printers defined in `config.yaml`, heartbeat syncs to PG
- **Stateless per-agent**: One agent never knows about other agents' printers

---

## SECTION 2: CURRENT DATA MODEL

### 2.1 Database Schema

**File**: [src/db/schema.ts](src/db/schema.ts)

#### Table: `agents`
```typescript
{
  id: text (primary key)         // "agt_xxxxx"
  name: text                      // e.g. "Office Agent"
  pairingCode: text              // 6-char, 30m expiry, single-use
  pairingCodeExpiresAt: timestamp
  secret: text                    // SHA256 hash (never plaintext)
  status: text (default "offline") // "online" | "offline" | "inactive"
  metadata: jsonb                 // {hostname, os, osVersion, version}
  lastSeenAt: timestamp
  createdAt: timestamp
}
// Indexes: agents_last_seen_idx
```
**What's MISSING**:
- ❌ No `companyId` or `branchId` (no multi-branch support)
- ❌ No `localNetworkId` (no network segmentation within a branch)
- ❌ No location/geography
- ❌ No agent-to-network relationship

#### Table: `printers`
```typescript
{
  id: text (primary key)          // "printer_xxxxx"
  agentId: text (foreign key)     // Links to agents.id
  name: text                       // e.g. "Kitchen Receipt"
  type: text                       // "network" | "usb" ONLY
  status: text (default "unknown") // "online" | "offline" | "busy" | "error"
  config: jsonb                   // {ip?, port?, protocol?, vid?, pid?, serial?, address?}
  enabled: boolean (default true)
  lastSeenAt: timestamp
  createdAt: timestamp
  updatedAt: timestamp
}
// Indexes: printers_agent_id_idx
```
**What's MISSING**:
- ❌ No printer type differentiation (thermal, laser, inkjet, etc.)
- ❌ No distinction: physical printer vs logical destination
- ❌ No connection type (USB vs TCP vs Windows spooler vs IPP)
- ❌ No printing protocol/driver capability
- ❌ No `branchId` or location
- ❌ No printer-to-destination mapping (no "POS 1 uses this printer")
- ❌ No printer group/category

#### Table: `printJobs`
```typescript
{
  id: text (primary key)          // "job_xxxxx"
  agentId: text (foreign key)     // Links to agents.id
  printerId: text (foreign key)   // Links to printers.id
  status: text (default "queued") // "queued" | "claimed" | "printing" | "success" | "failed" | "expired"
  payload: jsonb                  // {type, encoding, data} only
  error: text                      // Error message if failed
  retries: integer (default 0)
  claimedAt: timestamp
  expiresAt: timestamp
  createdAt: timestamp
  updatedAt: timestamp
}
// Indexes: 
//   print_jobs_agent_status_idx (agentId, status)
//   print_jobs_printer_status_idx (printerId, status)
//   print_jobs_status_expires_idx (status, expiresAt)
```
**What's MISSING**:
- ❌ No `branchId` (no branch context)
- ❌ No `destinationId` (POS/kitchen/warehouse/office identifier)
- ❌ No `destinationType` enum
- ❌ No `requesterId` (who requested the print? OdooUserId? POSId?)
- ❌ No business context whatsoever

#### Table: `apiKeys` (Odoo)
```typescript
{
  id: text (primary key)
  name: text                      // e.g. "Odoo prod"
  hashedKey: text                 // SHA256
  createdAt: timestamp
  lastUsedAt: timestamp
  revokedAt: timestamp
}
```
**What's MISSING**:
- ❌ No `branchId` (cannot scope an Odoo key to a single branch)
- ❌ No per-branch Odoo keys

#### Table: `managerSessions`
```typescript
{
  jti: text (primary key)  // JWT token ID for revocation
  createdAt: timestamp
  expiresAt: timestamp
  revokedAt: timestamp
}
```
**What's MISSING**:
- ❌ No manager identity (anonymous, global access)

### 2.2 Missing Entities (Required for Requirements)

| Concept | Status | Required? | Impact |
|---------|--------|-----------|--------|
| **Company** | ❌ Missing | HIGH | Multi-tenant isolation |
| **Branch** | ❌ Missing | HIGH | Multi-location same Odoo instance |
| **Local Network** | ❌ Missing | HIGH | Multiple agents per branch |
| **Destination** (POS/Kitchen/Warehouse/Office) | ❌ Missing | HIGH | Business routing context |
| **Printer (Logical)** | ❌ Missing | HIGH | Abstract printer destination in Odoo |
| **Printer (Physical)** | ✅ Exists as `printers` | — | But no type distinction |
| **Routing Rule** | ❌ Missing | HIGH | Who prints where |
| **Printer Binding** | ❌ Missing | HIGH | Destination → Physical Printer |
| **Agent** | ✅ Exists | — | But no branch/network FK |
| **Print Job** | ✅ Exists | — | But no business context |

---

## SECTION 3: CURRENT AGENT MODEL

### 3.1 Agent ↔ Printer Association

**File**: [agent/internal/agent/agent.go](agent/internal/agent/agent.go#L37-L45), [src/app/api/agent/heartbeat/route.ts](src/app/api/agent/heartbeat/route.ts)

**Current Model**:
```
Agent (1:N) Printer
  - One agent can manage many printers
  - One printer belongs to exactly one agent (agentId foreign key)
  - Heartbeat from agent upserts printers scoped to that agent
  - Agent cannot overwrite another agent's printer
    [Evidence: src/app/api/agent/heartbeat/route.ts:52-56]
```

### 3.2 Questions & Answers

| Question | Answer | Evidence |
|----------|--------|----------|
| **Can one Agent manage many printers?** | ✅ YES | `agents:printers = 1:N` [src/db/schema.ts] |
| **Can one Branch have many Agents?** | ❌ NO entity exists | No `branchId` in schema |
| **Is there currently a Branch entity?** | ❌ NO | Grep confirms no branch table [grep_search result] |
| **Can multiple Agents belong to the same Branch?** | ❌ Cannot answer; no branch entity | Would require `agents.branchId` FK |
| **Can system represent multiple isolated local networks in one branch?** | ❌ NO | No network/location concept in schema |
| **Current Agent model is...** | Agent-per-printer pool (unbounded) | Agent agnostic to network topology |

### 3.3 What This Means

The current system is:
- **Agent-per-location** (one agent = one physical location OR one network segment)
- **Not branch-aware** (agent has no concept of which branch it serves)
- **Not network-aware** (no ability to split one branch into multiple networks)
- **Printer pool model** (agent reports all printers it can reach; gateway routes jobs)

**Problem**: If a single branch has two isolated networks (e.g. office on WiFi, kitchen on separate LAN), they **cannot share a single agent** today. Would need two agents + manual configuration to distinguish which printers belong to which network.

---

## SECTION 4: CURRENT PRINTER MODEL

### 4.1 Supported Printer Types

**File**: [agent/internal/printer/factory.go](agent/internal/printer/factory.go), [PRINTERS.md](PRINTERS.md#L1-L16)

| Type | Protocol | Status | Transport | Code Path | Notes |
|------|----------|--------|-----------|-----------|-------|
| Network RAW | `raw` | ✅ **IMPLEMENTED** | RAW TCP (port 9100) | `NetworkPrinter{Address}` [network.go:13] | Full working |
| Network ESC/POS | `escpos` | ✅ **IMPLEMENTED** | Same RAW TCP | `NetworkPrinter{Address}` (protocol is payload semantic only) | Full working |
| Network IPP | `ipp` | ❌ NOT IMPLEMENTED | IPP protocol | [factory.go:32] returns error `"IPP not implemented"` | Rejected at init time |
| USB | — | ❌ STUB | — | [factory.go:36] returns error `"USB not yet implemented"` | Cannot print USB printers today |
| Windows Spooler | — | ❌ PLANNED | `winspool.drv` API | Not wired; future phase | Requires Windows API integration |

### 4.2 What's NOT Supported

**Printer Type Distinctions** (all collapsed into `type:network`):
- ❌ Thermal vs Laser vs Inkjet
- ❌ POS printer vs Office printer
- ❌ ESC/POS vs raw text vs PCL
- ❌ Connection protocol: USB vs TCP vs IPP vs Spooler

**Printer Capabilities**:
- ❌ Paper width (80mm vs 58mm receipt)
- ❌ Print speed
- ❌ Duplex support
- ❌ Color support
- ❌ Network protocol negotiation

**Physical vs Logical**:
- ❌ No abstraction: printer IS the physical device
- ❌ No "print to Logical Printer X" → resolve to 3 physical printers
- ❌ Cannot alias or reuse

### 4.3 Code Evidence

**Factory function** [agent/internal/printer/factory.go:7-33]:
```go
// New builds the concrete Printer backend for a configured printer.
// Supported today:
//   - type "network" with protocol "raw" or "escpos"
//
// Explicitly NOT supported yet (returns an error, never a fake success):
//   - type "usb": the current backend does not perform real Windows
//     spooler calls yet.
//   - type "ipp": no IPP client exists in this project.
```

**Printer interface** [agent/internal/printer/printer.go:7-15]:
```go
type Printer interface {
  Print(ctx context.Context, data []byte) error
  Test(ctx context.Context) error
  Status() string
}
```
No metadata about printer type, capabilities, or business role.

---

## SECTION 5: CURRENT ODOO INTEGRATION

### 5.1 How Odoo Currently Uses the System

**File**: [src/app/api/print/jobs/route.ts](src/app/api/print/jobs/route.ts), [API.md](API.md#L55-L61)

**Current Odoo → Gateway API**:
```
POST /api/print/jobs
Authorization: Bearer odoo_xxx
{
  "printerId": "printer_receipt",      // Required: exact printer ID
  "payload": {                         // Required: raw bytes
    "type": "raw|escpos",
    "encoding": "base64",
    "data": "..."
  },
  "expiresAt": "2026-09-01T12:00:00Z", // Optional: default 1h
  "idempotencyKey": "order-123"        // Optional: idempotency
}
```

**What Odoo must do today**:
1. Know the exact `printerId` for each printer
2. Know which printer to use for each POS/kitchen/destination
3. Encode print data (ESC/POS or raw text) to base64
4. Handle idempotency manually

### 5.2 What Odoo Does NOT Send

| Concept | Sent? | Impact |
|---------|-------|--------|
| Branch ID | ❌ NO | No branch isolation or multi-location routing |
| Company ID | ❌ NO | No multi-tenant support |
| POS ID | ❌ NO | No business context about *where* to print |
| Destination type (POS/Kitchen/Warehouse) | ❌ NO | No logical routing |
| Printer assignment config | ❌ NO | Hardcoded in Odoo code or external system |
| Authorization/scope | ❌ NO | All Odoo API keys are unrestricted |
| Printer capabilities needed | ❌ NO | No verification printer can handle payload |

### 5.3 Odoo Module Status

**File Search Result**: No Odoo module found in codebase

- ❌ No custom Odoo module (`sale_print_agent`, `print_gateway`, etc.)
- ❌ No Odoo Python code
- ❌ No Odoo views or models
- ❌ No Odoo configuration UI

**Implication**: Odoo integration is **API-only**. Customer must:
- Manually hardcode printer IDs in Odoo code or config
- Use a workaround (middleware, custom module) to map POS → printer ID
- Manage printer bindings outside the system

### 5.4 Routing Configuration

**Current Location**: **Split and manual**
- Agent: Local YAML config [agent/configs/config.yaml.example]
- Gateway: Dashboard can create printers (but doesn't own config)
- Odoo: Must know printer IDs (hardcoded or lookup from somewhere)

**Evidence**:
- Agent config [agent/configs/config.yaml.example:11-21]: Printers defined here
- Gateway dashboard [src/app/api/printers/route.ts]: Can POST new printer but doesn't sync back to agent YAML
- Odoo integration: No routing table, no config UI in Odoo

---

## SECTION 6: CURRENT ROUTING LOGIC

### 6.1 Trace: Real Print Job from Odoo to Printer

**Scenario**: Odoo POS Cairo wants to print receipt on Printer A

**Step-by-step**:

| Step | Component | Code | Details |
|------|-----------|------|---------|
| 1 | Odoo Python | Custom code | Knows printerId = `"printer_receipt_cairo"` (hardcoded or from config) |
| 2 | Odoo | Custom code | Encodes receipt lines to ESC/POS + base64 |
| 3 | HTTP Client | Custom code | `POST https://gateway/api/print/jobs` with Bearer token |
| 4 | Gateway (validation) | [src/app/api/print/jobs/route.ts:22] | `validateOdooKey(req)` → checks header auth |
| 5 | Gateway (parse) | [src/app/api/print/jobs/route.ts:29-31] | Parse JSON body, extract printerId + payload |
| 6 | Gateway (check printer exists) | [src/app/api/print/jobs/route.ts:34-36] | `db.query.printers.findFirst({id: printerId})` |
| 7 | Gateway (check enabled) | [src/app/api/print/jobs/route.ts:36-37] | If `enabled=false` → 409 error |
| 8 | Gateway (validate payload) | [src/app/api/print/jobs/route.ts:41-46] | `validatePrintJobPayload` → strict base64, max 5MiB |
| 9 | Gateway (set expiry) | [src/app/api/print/jobs/route.ts:49-58] | Parse expiresAt or default 1h from now |
| 10 | Gateway (idempotency) | [src/app/api/print/jobs/route.ts:60-68] | If `idempotencyKey` provided, generate stable jobId, check if already exists |
| 11 | Gateway (insert job) | [src/app/api/print/jobs/route.ts:73-80] | `INSERT INTO print_jobs VALUES (jobId, agentId=printer.agentId, printerId, status="queued", payload, expiresAt)` |
| 12 | Gateway (WS push) | [src/app/api/print/jobs/route.ts:84-88] | Try `pushJobToAgentWithClaim` via WebSocket (best-effort) |
| 13 | Gateway (response) | [src/app/api/print/jobs/route.ts:91] | Return `{jobId, status:"queued", printerId, agentId}` to Odoo |
| 14 | Odoo | Custom code | Poll `GET /api/print/jobs?id=jobId` for status updates |
| 15 | Agent (claim) | [src/app/api/agent/jobs/route.ts:17-71] or WS push | If no WS, poll `GET /api/agent/jobs` → claims job `queued→claimed` |
| 16 | Agent (dispatch) | [agent/internal/agent/agent.go:289-345] | `dispatchJob` → check shutdown gate, dedupe, bounded queue |
| 17 | Agent (execute) | [agent/internal/agent/agent.go:515-589] | `processJob` → parse payload, look up printer by printerId |
| 18 | Agent (lookup printer) | [agent/internal/agent/agent.go:546-551] | `a.printers[printerID]` from config — if not found, fail |
| 19 | Agent (lock printer) | [agent/internal/agent/agent.go:555-558] | Per-printer `sync.Mutex` for serialization |
| 20 | Agent (queue locally) | [agent/internal/agent/agent.go:566-567] | `a.queue.Push(jobID, printerID, pl.Data)` → SQLite |
| 21 | Agent (update status) | [agent/internal/agent/agent.go:568] | `a.queue.UpdateStatus(jobID, "printing")` |
| 22 | Agent (report to Gateway) | [agent/internal/agent/agent.go:569] | `a.updateJobStatus(jobID, "printing", "")` → PATCH /api/agent/jobs |
| 23 | Agent (print) | [agent/internal/agent/agent.go:573-577] | `p.Print(ctx, pl.Data)` → NetworkPrinter |
| 24 | Printer (network) | [agent/internal/printer/network.go:13-50] | TCP dial `ip:port` with 5s timeout, send all bytes |
| 25 | Physical Printer | Hardware | Receives bytes on TCP 9100, interprets ESC/POS, prints receipt |
| 26 | Agent (success) | [agent/internal/agent/agent.go:580-582] | `a.queue.UpdateStatus(jobID, "success")` |
| 27 | Agent (report to Gateway) | [agent/internal/agent/agent.go:582] | `a.updateJobStatus(jobID, "success", "")` → PATCH /api/agent/jobs |
| 28 | Gateway (update) | [src/app/api/agent/jobs/route.ts:88-145] | `UPDATE print_jobs SET status="success" WHERE id=jobID` |
| 29 | Odoo (poll) | Custom code | `GET /api/print/jobs?id=jobId` returns `status:"success"` → receipt printed ✅ |

### 6.2 Files Involved in Every Step

```
Validation Layer:
  ✓ src/lib/odoo-auth.ts (step 4)
  ✓ src/lib/payload.ts (step 8)

Gateway API:
  ✓ src/app/api/print/jobs/route.ts (steps 4-13, 28)
  ✓ src/app/api/agent/jobs/route.ts (step 15, 28)
  ✓ src/server/ws.ts (step 12)
  ✓ src/db/schema.ts (database schema for jobs, printers, agents)

Agent:
  ✓ agent/internal/agent/agent.go (steps 15-27)
  ✓ agent/internal/agent/dispatch_test.go (coverage)
  ✓ agent/internal/payload/payload.go (step 17)
  ✓ agent/internal/printer/printer.go (step 17)
  ✓ agent/internal/printer/factory.go (step 17, initialization)
  ✓ agent/internal/printer/network.go (step 24)
  ✓ agent/internal/queue/queue.go (steps 20-21)
  ✓ agent/internal/config/config.go (agent startup, printer config loading)

No business context injected anywhere; routing is purely by printer ID.
```

---

## SECTION 7: MULTI-BRANCH SUPPORT ANALYSIS

### 7.1 Can Current System Support Multiple Branches?

**Answer**: ❌ NO. Not by design, and not safely.

**Evidence**:

1. **No branch entity in database** [src/db/schema.ts]
   ```typescript
   // No agents.branchId
   // No agents.companyId
   // No printers.branchId
   // No printJobs.branchId
   ```

2. **No authorization boundary** [src/app/api/agents/route.ts:10-13]
   ```typescript
   export async function GET(req: Request) {
     const claims = await validateManager(req);
     if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
     const rows = await db.select().from(printers).orderBy(...);
     // Returns ALL printers from ALL agents — no filtering
   ```

3. **No tenant isolation in Odoo keys** [src/app/api/odoo/keys/route.ts:18-26]
   ```typescript
   // Manager creates Odoo key
   // No way to restrict key to single branch
   // No way to enforce: "this key can only print on Cairo printers"
   ```

4. **No multi-tenant queries anywhere**
   ```
   Every SELECT/UPDATE operates on ALL rows of that entity.
   If Branch A and Branch B both use the same Gateway,
   they are completely intermingled in the database.
   ```

5. **Agent heartbeat upserts all printers globally** [src/app/api/agent/heartbeat/route.ts:30-80]
   ```typescript
   // Agent reports printers, Gateway upserts them
   // Scoped only by agent.id, not by branch
   // No check: "is this agent allowed in this branch?"
   ```

### 7.2 Hypothetical Multi-Branch Scenario

**Scenario**: Single Odoo instance, two branches (Cairo and Giza).

```
Odoo Cloud
├── Branch: Cairo
│   ├── POS 1
│   ├── POS 2
│   └── Kitchen 1
│
└── Branch: Giza
    ├── POS 1
    ├── POS 2
    └── Kitchen 1
```

**If they tried to use current system**:

1. Deploy Gateway in cloud
2. Deploy Agent A in Cairo LAN
3. Deploy Agent B in Giza LAN
4. Create one Odoo API key `odoo_prod` (unrestricted)
5. Odoo Cairo queries: "print receipt on printer_receipt_cairo"
6. Odoo Giza queries: "print receipt on printer_receipt_giza"
7. **PROBLEM**: If Odoo accidentally sends Cairo POS job to Giza printer:
   - Gateway has no concept of branch-membership
   - Gateway will route it if printer exists
   - No cross-branch safety checks

**Missing controls**:
- No way to say "API key X can only see Branch Cairo"
- No way to say "Agent A only serves Cairo"
- No way to say "Printer X is in Cairo, cannot be used by Giza"
- If network misconfiguration occurs, jobs route silently to wrong location

---

## SECTION 8: CONFIGURATION OWNERSHIP

### 8.1 Where Is Configuration Today?

| Configuration Type | Owner | File/Table | Editable? |
|-------------------|-------|-----------|-----------|
| Agent registration | Odoo system | Agent CLI pairing | No |
| Agent credentials | Agent machine | `C:\ProgramData\OdooPrintAgent\config.yaml` | Agent CLI only |
| Printer list | Agent + Gateway | `config.yaml` + `printers` table | Both (heartbeat sync) |
| Printer IP/port | Agent | `config.yaml` | Manual YAML edit |
| Printer type | Agent | `config.yaml` | Manual YAML edit |
| Printer enabled/disabled | Gateway Dashboard | `printers.enabled` | Dashboard UI |
| Printer name | Both | `config.yaml` + `printers.name` | Both |
| Printer status | Gateway DB | `printers.status` | Auto-heartbeat |
| Odoo routing (which printer for which POS) | **Odoo itself** | Hardcoded or custom module | Hardcoded or custom code |
| Job queue/retries/TTL | Gateway | PG `printJobs` | Auto |

### 8.2 Client Requirement vs Reality

**Client wants**:
> The customer should be able to manage printer assignments from Odoo without needing to manually configure routing inside the Gateway for every printing rule.

**Current reality**:
- ❌ Printer assignments (which POS uses which printer) managed in **Odoo code or external config**, NOT in Odoo UI
- ❌ Printer physical config (IP, port, type) managed in **Agent YAML**, requires manual file edit
- ❌ Gateway Dashboard can view printers but **cannot change** business routing rules
- ❌ No Odoo module UI exists to configure "POS 1 → Printer A, Kitchen 1 → Printer B"

**Configuration flow today**:
1. System admin edits Agent YAML: add `printer_receipt` with `ip: 192.168.1.50`
2. Agent starts, reports printers via heartbeat
3. Gateway Dashboard shows the printer
4. Odoo code hardcodes: `printerId = "printer_receipt"` for POS 1
5. If printer IP changes: admin edits YAML again, restarts agent

**This violates the requirement** that customer manages routing FROM Odoo.

---

## SECTION 9: GAP ANALYSIS

### 9.1 What's Supported Correctly

**A. Supported Correctly** ✅

| Feature | Details | Evidence |
|---------|---------|----------|
| **Single-agent printer pool** | One agent can manage many printers | agents:printers = 1:N, heartbeat sync works |
| **Printer life cycle** | Online/offline status tracking | heartbeat updates `printers.status`, dashboard shows |
| **Job queue & retries** | Durable PG queue + local SQLite queue | `printJobs` table, agent queue.go, retry logic |
| **Idempotency** | Duplicate jobs deduplicated by idempotencyKey | `POST /api/print/jobs` → stable jobId hash |
| **Payload validation** | Strict base64, max 5MiB | `validatePrintJobPayload`, gateway + agent match |
| **Network RAW/ESC/POS** | TCP 9100 printing works | NetworkPrinter fully implemented, tested |
| **Per-printer serialization** | No concurrent prints on same printer | Agent per-printer mutex, tested in agent_test.go |
| **Crash safety** | SQLite WAL survives reboot | queue.go PRAGMA WAL, NORMAL sync |
| **WS + poll fallback** | Agent uses WS if available, polls if not | agent.go connectWebSocket + pollJobsGuarded |
| **Manager authentication** | JWT cookies, server-side session revocation | manager-auth.ts + managerSessions table |
| **Odoo API key auth** | Bearer token, SHA256 hash | odoo-auth.ts, validateOdooKey |
| **Test print** | Manager can test printer via real job | test-print/route.ts creates queued job |

### 9.2 What's Partially Supported

**B. Partially Supported** ⚠️

| Feature | What Works | What's Missing | Gap Severity |
|---------|-----------|-----------------|---------------|
| **Printer types** | Network RAW, network ESC/POS | USB (stub), Windows spooler (planned), IPP (error), thermal vs laser distinction | MEDIUM |
| **Printer config UI** | Dashboard can create/edit printers | Cannot sync back to agent YAML; agent config is ground truth | MEDIUM |
| **Odoo integration** | Basic POST/GET API works | No business context (branch, POS, destination); no Odoo module UI | MEDIUM |
| **Multi-location** | Multiple agents can exist | No branch/company entity to organize them; no cross-agent coordination | HIGH |
| **Printer discovery** | Agent reports printers via heartbeat | No auto-discovery; must configure YAML manually | LOW |
| **Job tracking** | Full job lifecycle in PG | No business context (which POS, which branch) | MEDIUM |

### 9.3 What's Missing (Required for Client Requirements)

**C. Missing & Must Be Redesigned** ❌

| Feature | What Client Wants | What System Has | Required Change | Complexity |
|---------|-------------------|-----------------|-----------------|-------------|
| **Companies** | Multiple Odoo instances or multi-tenant | Single global gateway | Add `company_id` to agents/printers/jobs; isolate per company | HIGH |
| **Branches** | Multiple locations per company | Only implicit (one agent per location) | Add `branch` entity; FK from agents, printers, jobs; auth boundaries | HIGH |
| **Local Networks** | Multiple agents per branch (isolated networks) | Cannot represent | Add `local_network` entity; agent→network FK | MEDIUM |
| **Logical Destinations** | Abstract POS/Kitchen/Warehouse identifiers | Only physical printers | Add `destination` entity; map to printers (N:1 or N:M) | MEDIUM |
| **Printer Types** | Thermal, laser, inkjet, USB, spooler, IPP | Only "network" and USB stub | Extend printer.type enum; implement USB + spooler + IPP backends | HIGH |
| **Printer Bindings** | Destination X uses Printer Y | Hardcoded in Odoo code | Add `printer_binding` junction table; Odoo UI to configure | MEDIUM |
| **Routing Rules** | POS 1 prints receipts on Printer A, invoices on Printer B | Single printerId per call | Add routing engine in gateway; match (destination, doctype) → printer_id | HIGH |
| **Odoo Module** | Odoo UI to configure printers & bindings | None; Odoo integration is API-only | Implement Odoo custom module (res.branch, print.destination, print.binding) | HIGH |
| **Authorization** | Odoo key scoped to branch | All keys global | Add `branch_id` FK to apiKeys; enforce in every endpoint | MEDIUM |
| **Business Context** | Every job knows its branch, destination, business purpose | Jobs only have agentId + printerId | Add branchId, destinationId, destinationType to printJobs | MEDIUM |

---

## SECTION 10: RECOMMENDED TARGET ARCHITECTURE

Based on the existing codebase and client requirements, the target should be:

```
┌─────────────────────────────────────────────────────────────────┐
│                   Odoo Cloud (Single Instance)                   │
│  • res.company (Cairo HQ, Giza Branch, Alex Branch)             │
│  • sale.order (where print requests originate)                   │
│  • custom_print_gateway.printer (Odoo-managed printer config)     │
│  • custom_print_gateway.printer_binding (POS → Physical Printer) │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTPS (Bearer odoo_token)
                     │ POST /api/print/jobs {branchId, destinationId, doctype, payload}
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Print Gateway (Centralized Orchestrator)            │
│  • PostgreSQL (multi-tenant aware)                               │
│  • WebSocket server for Agent coordination                       │
│  • Routing engine: (branch, destination, doctype) → printer_id   │
│  • Per-branch Odoo API key validation                            │
└────────────────────┬────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
   Branch: Cairo   Branch: Giza   Branch: Alex
        │            │            │
        │            │            │
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │  LAN A  │  │  LAN A  │  │  LAN A  │
   │(WiFi)  │  │(WiFi)  │  │(WiFi)  │
   │        │  │        │  │        │
   │Agent 1 │  │Agent 1 │  │Agent 1 │
   └────────┘  └────────┘  └────────┘
        │            │            │
    ┌───┴──┐     ┌───┴──┐     ┌───┴──┐
    │  │   │     │  │   │     │  │   │
    P1 P2 P3    P1 P2 P3    P1 P2 P3
   (3 printers per branch)
   
   Plus if LAN B exists in Cairo:
   ┌─────────┐
   │  LAN B  │
   │(Wired)  │
   │        │
   │Agent 2 │
   └────────┘
        │
    ┌───┴──┐
    │  │   │
    P4 P5 P6

Legend:
  • Agent = Print Agent (Go service) per local network
  • P1,P2,P3 = Physical printers on that network
  • Logical destinations (POS 1, Kitchen 1, Warehouse) → P1, P2, P3 mappings configured in Odoo
```

### 10.1 Key Architectural Principles

1. **Data ownership**:
   - **Odoo owns**: Business routing (which destination prints where)
   - **Gateway owns**: Job queue, job lifecycle, printer registry
   - **Agent owns**: Local printer probing, actual printing

2. **Authorization**:
   - Odoo keys scoped to branch
   - Manager can view/edit only assigned branch
   - Jobs carry branchId + destinationId for audit trail

3. **Routing decision**:
   - Odoo sends: `{branchId, destinationId, doctype, payload}`
   - Gateway looks up: `printer_binding` table → printer_id
   - Gateway enqueues: job with (branchId, destinationId, printerId, agentId)

4. **Agent model**:
   - Agent registers with branchId + localNetworkId
   - Agent heartbeats: "I manage printers X, Y, Z in Cairo/LAN-A"
   - Multiple agents per branch allowed (different networks)

5. **Printer model**:
   - Physical printer: IP:port, type (thermal/laser), protocol
   - Logical printer: abstract destination name (e.g., "Cairo POS 1 Receipt")
   - Binding: logical → physical (N:1, with fallback chain)

---

## SECTION 11: DATABASE CHANGES REQUIRED

### 11.1 Minimum Schema Changes

**New Tables**:

1. **`companies`** (if multi-tenant per gateway):
   ```typescript
   {
     id: text PK
     name: text
     enabled: boolean
     metadata: jsonb
     createdAt: timestamp
   }
   ```

2. **`branches`** (per company):
   ```typescript
   {
     id: text PK
     companyId: text FK → companies.id
     name: text
     location: text (optional)
     enabled: boolean
     createdAt: timestamp
   }
   ```

3. **`local_networks`** (per branch, if multiple networks):
   ```typescript
   {
     id: text PK
     branchId: text FK → branches.id
     name: text (e.g., "WiFi", "Wired")
     description: text
     createdAt: timestamp
   }
   ```

4. **`destinations`** (POS, kitchen, warehouse, office):
   ```typescript
   {
     id: text PK
     branchId: text FK → branches.id
     name: text (e.g., "POS 1", "Kitchen 1", "Warehouse")
     type: enum ("pos", "kitchen", "warehouse", "office", "other")
     enabled: boolean
     createdAt: timestamp
   }
   ```

5. **`printer_bindings`** (Logical destination → Physical printers):
   ```typescript
   {
     id: text PK
     destinationId: text FK → destinations.id
     printerId: text FK → printers.id
     priority: int (if multiple fallbacks)
     enabledAt: timestamp
     disabledAt: timestamp (soft-delete)
   }
   ```

6. **`printer_types`** (Enum table for extensibility):
   ```typescript
   {
     id: text PK ("thermal", "laser", "inkjet", "spooler", "ipp", ...)
     description: text
   }
   ```

**Schema Changes to Existing Tables**:

1. **`agents`**:
   ```typescript
   + branchId: text FK → branches.id
   + localNetworkId: text FK → local_networks.id (optional)
   ```

2. **`printers`**:
   ```typescript
   + branchId: text FK → branches.id (denormalized for query perf)
   + printerType: text FK → printer_types.id (not just "network" | "usb")
   + connectionType: enum ("usb", "tcp", "spooler", "ipp")
   + protocol: text (more specific: "raw", "escpos", "pcl", "ipp", "windows_spooler")
   + capabilities: jsonb {thermally, duplexing, color, paperWidths: [...]}
   ```

3. **`printJobs`**:
   ```typescript
   + branchId: text FK → branches.id
   + destinationId: text FK → destinations.id (optional)
   + destinationType: enum ("pos", "kitchen", ...)
   + requesterId: text (who made the request, for audit)
   + documentType: text (optional, "receipt" | "invoice" | ...)
   ```

4. **`apiKeys`**:
   ```typescript
   + branchId: text FK → branches.id (NULL = all branches, if admin wants)
   + companyId: text FK → companies.id (NULL = all companies)
   + allowedDestinationTypes: jsonb (scope: which destination types can use this key)
   ```

5. **`agents`** (if per-branch manager exists):
   ```typescript
   + branchId: text FK → branches.id
   ```

---

## SECTION 12: ODOO MODULE REQUIREMENTS

### 12.1 What the Odoo Module Must Do

**Module name**: `odoo_print_gateway` (or `print_management`)

**Models to Add**:

1. **`print_gateway.branch`** (extends or complements res.company):
   ```python
   class PrintGatewayBranch(models.Model):
       _name = 'print_gateway.branch'
       
       name = fields.Char()
       company_id = fields.Many2one('res.company')
       location = fields.Char()
       
       # Connection to gateway
       gateway_url = fields.Char()
       gateway_api_key = fields.Char()  # Odoo key specific to this branch
       
       # Agent registration
       agents = fields.One2many('print_gateway.agent', 'branch_id')
       printers = fields.One2many('print_gateway.printer', 'branch_id')
       destinations = fields.One2many('print_gateway.destination', 'branch_id')
   ```

2. **`print_gateway.agent`** (optional, for visibility):
   ```python
   class PrintGatewayAgent(models.Model):
       _name = 'print_gateway.agent'
       
       agent_id = fields.Char()  # From gateway
       name = fields.Char()
       branch_id = fields.Many2one('print_gateway.branch')
       status = fields.Selection([('online', 'Online'), ('offline', 'Offline')])
       last_seen = fields.Datetime()
       
       def sync_from_gateway(self):
           """Fetch agent status from gateway"""
   ```

3. **`print_gateway.destination`** (POS, kitchen, warehouse):
   ```python
   class PrintGatewayDestination(models.Model):
       _name = 'print_gateway.destination'
       
       name = fields.Char()  # "POS 1", "Kitchen 1", "Warehouse"
       destination_type = fields.Selection([
           ('pos', 'POS Terminal'),
           ('kitchen', 'Kitchen'),
           ('warehouse', 'Warehouse'),
           ('office', 'Office'),
           ('other', 'Other'),
       ])
       branch_id = fields.Many2one('print_gateway.branch')
       enabled = fields.Boolean(default=True)
       
       # Current printer assignments
       receipt_printer = fields.Many2one('print_gateway.printer')
       invoice_printer = fields.Many2one('print_gateway.printer')
       label_printer = fields.Many2one('print_gateway.printer')
       
       def get_printer_for_doctype(self, doctype):
           """Returns printer_id to use for given document type"""
   ```

4. **`print_gateway.printer`** (Physical printers in branch):
   ```python
   class PrintGatewayPrinter(models.Model):
       _name = 'print_gateway.printer'
       
       printer_id = fields.Char()  # From gateway
       name = fields.Char()
       branch_id = fields.Many2one('print_gateway.branch')
       gateway_printer_id = fields.Char()  # "printer_xxx" from gateway
       
       # Type info
       printer_type = fields.Selection([
           ('thermal', 'Thermal'),
           ('laser', 'Laser'),
           ('inkjet', 'Inkjet'),
           ('spooler', 'Windows Spooler'),
       ])
       connection_type = fields.Selection([
           ('network', 'Network TCP'),
           ('usb', 'USB'),
           ('spooler', 'Windows Spooler'),
           ('ipp', 'IPP'),
       ])
       protocol = fields.Selection([
           ('raw', 'RAW'),
           ('escpos', 'ESC/POS'),
           ('pcl', 'PCL'),
           ('ipp', 'IPP'),
       ])
       
       # Status
       status = fields.Selection([
           ('online', 'Online'),
           ('offline', 'Offline'),
           ('busy', 'Busy'),
       ])
       
       def sync_from_gateway(self):
           """Fetch printer list & status from gateway"""
   ```

5. **`print_gateway.print_job`** (Optional, for audit trail):
   ```python
   class PrintGatewayPrintJob(models.Model):
       _name = 'print_gateway.print_job'
       
       job_id = fields.Char()  # From gateway
       gateway_job_id = fields.Char()  # "job_xxx"
       branch_id = fields.Many2one('print_gateway.branch')
       destination_id = fields.Many2one('print_gateway.destination')
       printer_id = fields.Many2one('print_gateway.printer')
       status = fields.Char()  # queued, claimed, printing, success, failed, expired
       document_type = fields.Char()  # receipt, invoice, label
       created_at = fields.Datetime()
       updated_at = fields.Datetime()
       error = fields.Text()
       
       def sync_from_gateway(self):
           """Poll job status from gateway"""
   ```

### 12.2 Views/Menus to Add

1. **Branch Configuration**:
   - List of branches
   - Branch details: gateway URL, API key
   - Agent status dashboard
   - Printer inventory (synced from gateway)

2. **Destination Management**:
   - List destinations per branch
   - Assign printers to destinations (receipt/invoice/label)
   - Test print button

3. **Print Job History**:
   - Log of recent jobs
   - Status, errors, timing

4. **Dashboard**:
   - Printer status per branch
   - Online/offline agent count
   - Recent print jobs

### 12.3 API Integration Points

**Module must call**:
1. `GET /api/branches` (or via sync cron)
2. `GET /api/printers` per branch
3. `GET /api/agents` per branch
4. `POST /api/print/jobs` (already done, but enhanced with branchId)
5. `GET /api/print/jobs/{id}` (status polling)

**Module must expose** (if gateway needs to call Odoo):
- None required in Phase 1; all integration is Odoo → Gateway

---

## SECTION 13: BACKWARD COMPATIBILITY

### 13.1 What Can Remain Unchanged

**✅ Can Stay As-Is**:

1. **Agent code** (agent/internal/*):
   - Core agent loop, WS connection, job processing
   - SQLite queue implementation
   - Per-printer serialization
   - TCP/ESC-POS printing logic
   - No branchId awareness needed at agent level; agent doesn't route

2. **Agent API endpoints** (agent auth, heartbeat, jobs):
   - `POST /api/agent/register`
   - `POST /api/agent/heartbeat`
   - `GET/PATCH /api/agent/jobs`
   - `WS /api/agent/ws`
   - These remain the same; agent doesn't know about branches

3. **Printer backend** (network.go):
   - TCP printing unchanged
   - StatusProbe unchanged

4. **Manager authentication** (manager-auth.ts):
   - JWT + session row approach remains
   - Just add per-branch scope to manager role (future)

5. **Desktop Manager** (src-tauri/):
   - No changes needed for Phase 1
   - Shows branches/agents/printers same as today

6. **Payload validation** (payload.ts):
   - Strict base64 validation unchanged
   - Max 5MiB unchanged

### 13.2 What Must Change

**❌ Requires Redesign**:

1. **Odoo API endpoint** (`POST /api/print/jobs`):
   - Add required `branchId` and `destinationId` to request body
   - Change routing: lookup destination → printer_binding → printer_id
   - Add branch scope validation to Odoo key

2. **Job creation paths**:
   - `src/app/api/print/jobs/route.ts`: Add branchId + destinationId handling
   - `src/app/api/printers/[id]/test-print/route.ts`: Add branchId context
   - Manager actions: require branch context

3. **Agent registration**:
   - Agent must register with `branchId` + `localNetworkId`
   - Modify `POST /api/agent/register` to accept these

4. **Database queries**:
   - Every SELECT/UPDATE must filter by branchId (if branch-scoped auth)
   - Indexes on branchId for performance

5. **Printer management**:
   - `printers` table gains `branchId`
   - Heartbeat must scope to branch
   - Dashboard must filter by branch

6. **API key validation**:
   - `validateOdooKey` must enforce `branchId` scope
   - API key creation must accept optional `branchId`

---

## SECTION 14: RISKS

### 14.1 Architectural Risks

| Risk | Current Exposure | Consequence | Mitigation |
|------|------------------|-------------|-----------|
| **Data leakage between branches** | HIGH | If API key unscoped, Odoo Branch A can print jobs in Branch B | Enforce `branchId` on every route immediately |
| **Printer misconfiguration silent failure** | MEDIUM | Agent refers to nonexistent printer locally → job fails with opaque error | Add printer existence pre-check at gateway before queueing |
| **No audit trail of who printed what** | MEDIUM | Compliance/billing issues; cannot trace job to business context | Add destinationId + requesterId to printJobs |
| **Agent-printer mapping unstable** | MEDIUM | Agent crashes, printers go offline temporarily; jobs might route to stale printer cache | Add heartbeat-before-claim validation |
| **Routing logic split between Odoo and Gateway** | HIGH | Business rules in Odoo, printer bindings in Gateway; hard to maintain | Centralize routing engine in gateway; Odoo reads it |
| **Printer type detection incomplete** | MEDIUM | Sending ESC/POS to raw laser printer fails silently | Add printer.capabilities check before accepting job |
| **No multi-agent coordination** | LOW (for Phase 1) | If two agents in same branch have same printer_id config, jobs might go to wrong agent | Enforce unique printer_id across branch (currently scoped by agent only) |
| **Manager can delete printer while job printing** | MEDIUM | Race condition between printer.enabled check and actual print | Add job-time printer existence + enabled check |

### 14.2 Implementation Risks

| Risk | Likelihood | Effort | Mitigation |
|------|------------|--------|-----------|
| **Odoo module doesn't exist yet** | CERTAIN | HIGH (custom module dev) | Start Odoo module in parallel; provide reference implementation |
| **Agent needs re-registration for branchId** | HIGH | MEDIUM | Make branchId optional in registration for backward compat |
| **Database migration downtime** | MEDIUM | MEDIUM | Use Drizzle migrations; test on staging first |
| **Gateway restart during migration** | MEDIUM | LOW | Put gateway in read-only mode during schema change |
| **Existing deployments break** | HIGH | MEDIUM | Provide migration guide; keep single-branch mode as default |
| **Testing multi-branch scenarios in CI** | MEDIUM | HIGH | Need multi-tenant test fixtures; add to vitest suite |

---

## SECTION 15: FINAL VERDICT

### 15.1 CURRENT ARCHITECTURE SUMMARY

```
┌──────────────────────────────────────────────────────────────┐
│                     CURRENT STATE                             │
├──────────────────────────────────────────────────────────────┤
│ Gateway:  Next.js + PostgreSQL + WebSocket                    │
│ Agents:   Go Windows Services (one or more, global)           │
│ Database: agents, printers, printJobs, apiKeys, managerSessions│
│ Routing:  Odoo sends printerId → gateway maps to printer →    │
│           gateway looks up agentId → agent executes           │
│ Auth:     Manager (JWT), Agent (Bearer), Odoo (Bearer)        │
│ Scope:    Single location OR multiple isolated locations      │
│ Multi-tenant: NO                                               │
│ Business context: NONE (just printerId)                       │
└──────────────────────────────────────────────────────────────┘
```

**Strengths**:
- ✅ Robust job queue (PG + SQLite)
- ✅ Crash-safe (WAL, idempotency guards)
- ✅ Network printing works (RAW TCP, ESC/POS)
- ✅ Per-printer serialization prevents conflicts
- ✅ WS + poll fallback covers connectivity gaps
- ✅ Clean separation: Agent, Gateway, Manager

**Weaknesses**:
- ❌ No branch entity or multi-location organization
- ❌ No business routing (POS → printer mapping)
- ❌ No Odoo module (integration is API-only, Odoo doesn't configure routing)
- ❌ Limited printer types (network only)
- ❌ No authorization boundaries between locations
- ❌ Printer config split between YAML + Gateway DB

---

### 15.2 CLIENT REQUIREMENTS SUMMARY

```
┌──────────────────────────────────────────────────────────────┐
│                    CLIENT WANTS                               │
├──────────────────────────────────────────────────────────────┤
│ 1. Multi-branch Odoo instance                                 │
│ 2. Each branch: POS, kitchens, warehouses, offices            │
│ 3. Each location: multiple printers (thermal, laser, inkjet)  │
│ 4. Routing managed IN ODOO (not hardcoded)                   │
│ 5. One agent per local network (not per printer/POS)          │
│ 6. Multiple agents per branch (if isolated networks)          │
│ 7. Centralized gateway orchestrating all                      │
│ 8. Printer assignments configurable from ODOO UI             │
└──────────────────────────────────────────────────────────────┘
```

---

### 15.3 GAP ANALYSIS SUMMARY

| Layer | Gap | Severity | Effort |
|-------|-----|----------|--------|
| **Database** | No company/branch/destination/binding entities | CRITICAL | 2 weeks |
| **Gateway API** | No branchId/destinationId in routing | CRITICAL | 1 week |
| **Odoo Module** | Does not exist | CRITICAL | 3 weeks |
| **Agent** | Must register with branchId (optional in Phase 1) | MEDIUM | 3 days |
| **Printer types** | Only network; USB/spooler/IPP stubs | MEDIUM | 2 weeks |
| **Authorization** | No branch scope on API keys | MEDIUM | 1 week |
| **Manager UI** | No branch filtering (shows all) | LOW | 1 week |

---

### 15.4 REQUIRED DATABASE CHANGES

**New tables**: `companies`, `branches`, `local_networks`, `destinations`, `printer_bindings`, `printer_types`

**Modified tables**: 
- `agents`: +branchId, +localNetworkId
- `printers`: +branchId, +printerType, +connectionType, +protocol, +capabilities
- `printJobs`: +branchId, +destinationId, +destinationType, +requesterId, +documentType
- `apiKeys`: +branchId, +companyId, +allowedDestinationTypes

**Indexes to add**: All new FKs need indexes; consider `(branchId, status)` on printJobs

**Migration strategy**: Blue-green deployment with backfill script (safe on customer PG)

---

### 15.5 REQUIRED ODOO MODULE CHANGES

**Create**: `odoo_print_gateway` module with:
- `print_gateway.branch` (connection config)
- `print_gateway.destination` (POS/kitchen/warehouse)
- `print_gateway.printer` (physical printers from gateway)
- `print_gateway.print_job` (audit trail)
- Views for printer assignment (destination → printer mapping)
- Cron job to sync printer status from gateway
- Integration with sale.order to auto-print receipts

**Modify**: `POST /api/print/jobs` to accept branchId + destinationId

**Effort**: 3-4 weeks for Odoo Python/JS/XML

---

### 15.6 REQUIRED GATEWAY CHANGES

1. **Schema**: Add 6 new tables, modify 4 existing (~2 weeks with testing)
2. **Routing engine**: Implement (branch, destination, doctype) → printer_id lookup (~1 week)
3. **Odoo API**: Validate branchId on every route (~3 days)
4. **Agent registration**: Accept branchId + localNetworkId (~3 days)
5. **Manager UI**: Add branch filtering (~1 week)
6. **Authorization**: Enforce branch scope on API keys (~1 week)
7. **Tests**: Extend vitest suite for multi-branch scenarios (~1 week)

**Total Gateway effort**: ~4-5 weeks

---

### 15.7 REQUIRED AGENT CHANGES

**Minimal**:
- Accept optional `branchId` + `localNetworkId` in registration payload (backward compatible)
- No logic change needed (agent doesn't route; gateway does)

**Effort**: 2-3 days

---

### 15.8 REQUIRED PRINTER ABSTRACTION CHANGES

**Phase 2 (if client wants USB + spooler)**:
- Implement Windows spooler backend: `OpenPrinterW`, `WritePrinter` via cgo
- Implement USB backend: Windows HID or WinUSB API
- Implement IPP client (third-party library or custom)
- Add printer capability negotiation (paper sizes, colors, etc.)
- Update printer.type enum in schema
- Update tests with real hardware (integration tests)

**Effort**: 2-3 weeks (Phase 2 effort, not blocking Phase 1)

---

### 15.9 WHAT CAN STAY AS-IS

✅ **No Changes Required**:
- Agent core loop (agent.go)
- Job queue implementation (queue.go)
- Network printer backend (network.go) — *used as-is*
- Payload validation (payload.ts)
- Crash safety (WAL, idempotency)
- WS + poll fallback mechanism
- Manager JWT auth (just add branch scope later)
- Desktop Manager (Tauri) — *can show branches in Phase 2*

---

### 15.10 RECOMMENDED IMPLEMENTATION ORDER

**Phase 1 (4-5 weeks)**: Multi-branch + routing foundation
1. Add database schema (branches, destinations, bindings, etc.)
2. Implement branch validation in all Odoo API routes
3. Build routing engine (destination → printer lookup)
4. Implement Odoo module with basic printer assignment UI
5. Update agent registration to accept branchId (optional)
6. Test multi-branch scenarios end-to-end

**Phase 2 (2-3 weeks)**: Extended printer types
7. Implement USB Windows backend
8. Implement Windows spooler backend
9. Implement IPP client
10. Add printer capability detection

**Phase 3 (1-2 weeks)**: Polish & hardening
11. Manager UI branch filtering
12. Advanced routing rules (per doctype)
13. Audit trail improvements
14. Performance tuning (indexes, query optimization)

---

## APPENDIX: CODE REFERENCE

### Key Files by Category

**Database Schema**:
- [src/db/schema.ts](src/db/schema.ts) — Current tables (agents, printers, printJobs, apiKeys, managerSessions)

**Gateway API**:
- [src/app/api/print/jobs/route.ts](src/app/api/print/jobs/route.ts) — Odoo job creation
- [src/app/api/agent/jobs/route.ts](src/app/api/agent/jobs/route.ts) — Agent job claiming
- [src/app/api/printers/route.ts](src/app/api/printers/route.ts) — Printer management
- [src/app/api/agent/heartbeat/route.ts](src/app/api/agent/heartbeat/route.ts) — Agent heartbeat
- [src/server/ws.ts](src/server/ws.ts) — WebSocket job push

**Authentication**:
- [src/lib/odoo-auth.ts](src/lib/odoo-auth.ts) — Odoo API key validation
- [src/lib/agent-auth.ts](src/lib/agent-auth.ts) — Agent credential validation
- [src/lib/manager-auth.ts](src/lib/manager-auth.ts) — Manager JWT validation

**Agent**:
- [agent/internal/agent/agent.go](agent/internal/agent/agent.go) — Main agent loop
- [agent/internal/agent/dispatch_test.go](agent/internal/agent/dispatch_test.go) — Job dispatch tests
- [agent/internal/printer/factory.go](agent/internal/printer/factory.go) — Printer initialization
- [agent/internal/printer/network.go](agent/internal/printer/network.go) — TCP printing
- [agent/internal/queue/queue.go](agent/internal/queue/queue.go) — SQLite queue

**Configuration**:
- [agent/configs/config.yaml.example](agent/configs/config.yaml.example) — Agent config template
- [agent/internal/config/config.go](agent/internal/config/config.go) — Config parsing

**Documentation**:
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design overview
- [API.md](API.md) — API contracts
- [PRINTERS.md](PRINTERS.md) — Printer capabilities & semantics
- [docs/AUTH.md](docs/AUTH.md) — Authentication spec

---

## END OF ANALYSIS

**Analysis completed**: 2026-08-31  
**Scope**: Code-based audit, no implementation  
**Recommendation**: Proceed to Phase 1 design with schema + Odoo module specifications
