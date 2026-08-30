# Architecture & Design Verification

## Project State: DESIGN COMPLETED & PROTOTYPE READY
The current implementation consists of the full architectural design, the Go source code for the agent, and a TypeScript simulation harness.

### 1. The Local Print Agent (Go)
**Directory**: `/agent`
**Core Logic**: Implemented but **NOT VERIFIED** in this environment due to missing Go toolchain.
- **cmd/agent**: Implements a native Windows service.
- **internal/agent**: Handles WebSocket communication, job polling, and the print job state machine.
- **internal/queue**: SQLite-backed durable queue.
- **internal/printer**: Backends for RAW TCP and USB (Layered ID).

### 2. The Protocol Simulator (TypeScript)
**Directory**: `src/app/simulator`
**Role**: **VERIFIED**.
This component successfully demonstrates the communication protocol between the Agent and the Management Console. It verifies:
- Pairing code generation and validation.
- Heartbeat reporting.
- Job polling and status updates.
- TTL and Idempotency logic at the API level.

### 3. The Management Console (Next.js)
**Role**: **VERIFIED**.
Simulates the Odoo ERP environment for agent management.

---

## Verification Requirements (Manual)

Because the current sandbox environment lacks the Go toolchain and a Windows kernel, the following verification steps must be performed on a local development machine:

### A. Compile the Agent
```bash
cd agent
go mod tidy
go build -o OdooPrintAgent.exe ./cmd/agent
```

### B. Service Verification
```cmd
OdooPrintAgent.exe install
OdooPrintAgent.exe start
sc query OdooPrintAgent
```

### C. Hardware Test
1. Connect an Epson or Xprinter via USB.
2. In the Management Console, trigger a Test Print.
3. Verify the agent process detects the printer and produces physical output.

### D. Network Test
1. Connect a printer to the LAN.
2. Assign it to the agent via IP:Port.
3. Power cycle the printer to change its IP (if not reserved).
4. Update the config and verify the internal Printer ID remains consistent.
