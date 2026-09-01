# Architecture — Production (Current)

## Components

- **Gateway** `server.ts` + `src/server/ws.ts` + `src/db/schema.ts` (10 tables: `branches, destinations, document_types, local_networks, agents, printers, printer_bindings, api_keys, manager_sessions, print_jobs`). Next.js 16 + PG/Drizzle + custom WS `attachAgentWSS` on same HTTP port 3000. Serves Next + `WSS /api/agent/ws`.
- **Agent** `agent/cmd/agent/main.go` Windows Service `kardianos/service` `Arguments: -config C:\ProgramData\OdooPrintAgent\config.yaml`. `agent/internal/agent/agent.go` outbound `WSS` + poll fallback `GET /api/agent/jobs` (only when `wsConn==nil`), heartbeat `POST /api/agent/heartbeat` 30s `printerStatusPayload` with `id, printerType, connectionType, protocol, usbVid/pid/serial, NetworkAddress/Port, capabilities`, `DiscoverQuick` sync then async full discovery (network 9100 + USB `SetupDi` + IPP 631 + mDNS stub) 2s delay.
- **Desktop** `src-tauri/src/main.rs` `tauri_plugin_autostart` + `tray::setup_tray` hide-on-close, `src-tauri/src/commands.rs` 14 `run_blocking` commands (`get_agent_status, start/stop/restart, pair_agent, get_printers/discover/test, get_autostart`), `src/desktop/main.tsx` 891 lines 4 pages (Dashboard, Printers, Jobs, Settings) with `getPrinters/discoverPrinters/testPrinter`, theme `localStorage`, hash routing, `src/desktop/lib/ipc.ts` typed `normalizeGatewayUrl`, `fetchGatewayHealth` 8s abort, `src-tauri/Cargo.toml` `tauri 2 + tauri-plugin-autostart`.
- **Odoo Addon** `odoo_addons/print_gateway` `v1.0.0` `depends base,sale,account,stock,purchase,point_of_sale` + 14 data (11 views, `security`, `data/cron`, `data/report_mappings.xml` 8 defaults). Models: `branch` (gateway_url/api_key, `create_print_job` 8-args), `destination` (pos/kitchen/warehouse), `document_type` (receipt/invoice/order...), `printer` (thermal/laser/inkjet, tcp/usb/spooler/ipp/ipps, `printer_type/connection_type/protocol`), `agent`, `printer_binding` (branch/destination/document_type→printer priority fallback), `print_job` (gateway_job_id + `odoo_model/record_id/report_xml_id/name/report_id`), `report_mapping` (report_id/xml_id/model/report_name → document_type, branch/destination, gateway_enabled, payload_type, priority, fallback), `ir.actions.report` inherit (`print_gateway_enabled, document_type_id, branch_id, destination_id`, `report_action` override). **Legacy `sale_order.py` and `sale_order_views.xml` removed** — fully replaced by generic `report_mapping` + `ir.actions.report` override.

## Two Queue Layers

- **Gateway PG** `print_jobs` `src/db/schema.ts:179` `queued → claimed → printing → success/failed/expired` — atomic `FOR UPDATE SKIP LOCKED` `src/app/api/agent/jobs/route.ts:49` (TTL sweep `expires_at`, stale `90s` `retries<5` reclaim `retries++`, `MAX_CLAIM 20`, `STALE 90s`, `MAX_RETRIES 5`).
- **Agent WAL** `agent/internal/queue/queue.go:14` `queued → printing → success/failed` (`id == gateway job_id`, `INSERT OR IGNORE`, `PRAGMA WAL`, `busy_timeout=5000`, `MaxOpenConns 1`). `IsProcessed` guards duplicate after `success`.

## Job Flow (Generic Report)

```
Odoo standard Print (sale.order → sale.report_saleorder_document)
  → ir.actions.report.report_action(docids)  odoo_addons/print_gateway/models/ir_actions_report.py:311
    → _should_route_via_gateway() → report_mapping priority (report_id > xml_id > report_name > model) or direct print_gateway_enabled
    → _determine_branch/destination/document_type (mapping direct → record.company → first enabled)
    → _generate_payload_for_report → _render_qweb_pdf → base64 {'type':'raw','encoding':'base64','data':b64}
    → branch.create_print_job(destination.gateway_destination_id, document_type, payload, odoo_model, odoo_record_id, report_xml_id, report_name)
      → POST /api/print/jobs {branchId, destinationId, documentType, payload} src/app/api/print/jobs/route.ts:75 (validateOdooKey branch-scoped, validatePrintJobPayload 5MiB canonical, resolvePrinterForJob)
        → createQueuedJob INSERT queued + pushJobToAgentWithClaim (WS broadcast + UPDATE queued→claimed if open socket)
        → Agent handleWSMessages or GET /api/agent/jobs FOR UPDATE SKIP LOCKED → dispatchJob (inFlight dedup, pendingSlots 64, execSem 8) → processJob (expiresAt, IsProcessed, printer lookup, payload.Parse strict base64, getPrinterLock, queue.Push, PATCH printing, p.Print 20s, queue success/failed, PATCH success/failed)
          → Printer: NetworkPrinter TCP 9100 (network.go:19), SpoolerPrinter winspool.drv (spooler_windows.go:47), USBPrinter CreateFile \\?\usb# (usb_windows.go:34), IPPPrinter HTTP POST application/ipp (ipp.go:34)
          → PATCH /api/agent/jobs  src/app/api/agent/jobs/route.ts:95 canTransition, TTL win
        → print_jobs status → print_gateway.print_job GET /api/print/jobs?id=  print_job.py:41 cron 2m
```

Success = socket/WritePrinter/IPP `0x0000` OK, not paper-out. Crash window duplicate documented as at-least-once.

## Printer Identity

Stable `printer.id` PK, not IP. `printer/stable_id.go:55` `spooler:<norm> → printer_spooler_%x`, `usb-sn/loc/vidpid → printer_usb_%x`, `net:ip:port → printer_net_%x` (handles `ipp://` URL host:port via `url.Parse`), `endpoint:<str> → printer_ep_%x`. Heartbeat upserts scoped `existing.agentId !== agent.id → skip` `heartbeat/route.ts:110` + branchId `agent.branchId`. USB `Identify()` SN→LOC→VIDPID `usb_windows.go:30`.

## Discovery (Additive, Isolated)

- `discoverFromConfig` YAML legacy
- `discoverSpoolerPrinters` `EnumPrintersW` level 2 `PRINTER_INFO_2W` `unsafe.Sizeof` `spooler_windows.go:143` → `pPrinterName/pPortName/pDriverName` → `classify.go:3` + `mapWindowsStatus`
- `loadRegistryPrinters` `printers.json` atomic `registry.go:31`
- `discoverNetworkPrinters` `network_discovery.go:9` private IPv4 `net.Interfaces` clamp `/16→/24`, 32 workers, 500ms/host, 8s global
- `discoverUSBPrinters` `usb_windows.go:83` `SetupDiGetClassDevsW` `GUID 28d78fad/USBDEVICE A5DCBF10`, `buildUSBDevicePathMap` via `SetupDiGetDeviceInterfaceDetailW`, `parseVIDPIDSerial`
- `discoverIPPPrinters` `ipp_discovery.go:15` TCP 631 scan + `discoverMDNSPrinters` stub
- Dedup by stable ID + `NetworkAddress:Port` + `USB VID:PID:serial` `discovery.go:129`, `mergeDeviceInfo`, `DiscoverQuick` sync + async full 2s `agent.go:129`.

## Security

- Agent `hashSecret` SHA256 timing-safe `src/lib/agent-auth.ts:15`, `Bearer agt:secret` scoped `agent.id`.
- Manager `GATEWAY_JWT_SECRET` HS256 8h `jti` + `manager_sessions` `src/lib/manager-auth.ts`, httpOnly `mgr_session`.
- Odoo `odoo_` SHA256 `api_keys` `src/lib/odoo-auth.ts`, branch-scoped `isBranchScoped`, `allowedDocumentTypes`.
- Scope: manager global (not per-branch), agent cannot read other agent jobs (404 identical). **Fixed**: `security/ir.model.access.csv` now restricts `branch` write/create/unlink to `base.group_system`; `group_user` has read-only → `gateway_api_key` (password field) no longer writable by normal users.

## WS vs Poll

Agent WS `wss://host/api/agent/ws` `Authorization` header, backoff 5s→60s jitter, `handleWSMessages` per-job goroutine. Poll `GET /api/agent/jobs` only when `wsConn==nil`. Desktop never holds WS, polls `fetchGatewayHealth` 8s abort + `GET /api/jobs?limit=50` with `credentials:include` (requires manager JWT).

## Deployment

- Gateway `Docker` or `node server.js` single port, `DATABASE_URL`, `next build` tolerates missing DB.
- Agent `OdooPrintAgent.exe -service install/start` → `C:\ProgramData\OdooPrintAgent\config.yaml|agent.db|logs` `SYSTEM:F Administrators:F`.
- Desktop `cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi` `downloadBootstrapper` WebView2, `C:\ProgramData\OdooPrintManager\settings.json`.
