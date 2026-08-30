# Architecture — Production

## Components

- **Gateway:** Next.js 16 + PG/Drizzle + custom WS server (`server.ts` + `src/server/ws.ts`). Serves Next + handles `WSS /api/agent/ws` upgrade via `attachAgentWSS`. Desktop polls HTTPS only.
- **Agent:** Go 1.21 Windows Service (`kardianos/service`) `agent/cmd/agent/main.go` `Arguments: -config C:\ProgramData\OdooPrintAgent\config.yaml`, `Dependencies: Tcpip`. `agent/internal/agent/agent.go` outbound WS + poll fallback (WS connected → poll skipped), heartbeat 30s, per-printer `sync.Mutex`, `net` dial 5s + deadline.
- **Desktop:** Tauri 2.x + React `src/desktop/main.tsx` (+ typed IPC layer `src/desktop/lib/ipc.ts`) + Rust `src-tauri/src/{main,commands,agent,paths,logging,tray}.rs`. Async Rust commands only (no shell plugin); tray hide-not-exit; settings at `C:\ProgramData\OdooPrintManager\settings.json`, written exclusively by Rust commands (single source of truth).

## Two Queue Layers

- Gateway PG `print_jobs` `src/db/schema.ts:43` `queued → claimed → printing → success/failed/expired` — atomic lease `FOR UPDATE SKIP LOCKED` `src/app/api/agent/jobs/route.ts:49` (TTL sweep, stale 90s, MAX_RETRIES 5 → failed, MAX_CLAIM 20).
- Agent SQLite WAL `agent/internal/queue/queue.go:14` `queued → printing → success/failed` (`id == gateway job_id`, `INSERT OR IGNORE`, `PRAGMA WAL`, `busy_timeout=5000`). Survives crash/reboot. `IsProcessed` guards duplicate print after success; `UpdateStatusWithError`.

## Job Flow

```
Odoo --Bearer odoo_xxx--> POST /api/print/jobs {printerId,payload,expiresAt,idempotencyKey}
  → PG queued (validatePrintJobPayload 5MiB)
  → tryPushJob WS to agent (or next poll claims)
  → agent processJob: check expiresAt UTC → IsProcessed → printer lookup → payload.Parse → lock → Push local → UpdateStatus printing → PATCH printing → p.Print(ctx, PL.Data) → UpdateStatus success/failed → PATCH success/failed
```

Success = socket write loop OK (`network.go:13`), not paper-out.

## Printer Identity

Stable `printer.id` PK, not IP. Heartbeat upserts scoped `existing.agentId !== agent.id → skip` `heartbeat/route.ts:60`. USB `Identify()` SN → LOC → VIDPID `usb_windows.go:30`.

## Security

- Agent: `hashSecret` SHA256 timing-safe `src/lib/agent-auth.ts:15`, `Authorization: Bearer agt:secret` scoped to `agent.id`.
- Manager: `GATEWAY_JWT_SECRET` HS256 8h `jti` + `manager_sessions` row, httpOnly `mgr_session` cookie, revoke on logout `src/lib/manager-auth.ts`, `docs/AUTH.md`.
- Odoo: `odoo_` SHA256 `api_keys` `src/lib/odoo-auth.ts`.
- Scope: manager cannot read `agents.secret`, agent cannot read other agent's jobs/printers (404 identical).

## WS vs Poll

Agent WS dial `wss://host/api/agent/ws` with `Authorization` header, backoff 5s→60s, `handleWSMessages` per-job goroutine. Poll `GET /api/agent/jobs` only when `wsConn==nil` (fallback). Desktop never holds WS.

## Deployment

- Gateway `Docker` or `node server.js` (single port handles Next + WS). `DATABASE_URL` required at runtime; `next build` tolerates missing DB (empty dashboard shell).
- Agent `OdooPrintAgent.exe -service install/start` → `C:\ProgramData\OdooPrintAgent\config.yaml|agent.db|logs` (SYSTEM:F Administrators:F ServiceSID:F).
- Desktop `cargo tauri build` → `OdooPrintManager_*_x64-setup.exe` `downloadBootstrapper` for WebView2; Manager dir `C:\ProgramData\OdooPrintManager\` (least-privilege, verify icacls).

