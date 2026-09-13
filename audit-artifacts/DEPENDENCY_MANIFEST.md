# DEPENDENCY_MANIFEST (Phase 0, 2026-09-13)

Node lock digest: da90a3eda06e8e1f | lockfileVersion 3
engines: {"node": ">=24.15.0"} | overrides: {"esbuild": "0.28.2"} | engine-strict in .npmrc: True

| package | spec | resolved(lock) |
|---|---|---|
| @tauri-apps/api | ^2.11.1 | 2.11.1 |
| clsx | ^2.1.1 | 2.1.1 |
| date-fns | ^4.4.0 | 4.4.0 |
| drizzle-orm | 0.45.2 | 0.45.2 |
| lucide-react | ^1.41.0 | 1.41.0 |
| nanoid | ^6.0.1 | 6.0.1 |
| next | 16.3.4 | 16.3.4 |
| pg | 8.23.0 | 8.23.0 |
| react | 19.3.0 | 19.3.0 |
| react-dom | 19.3.0 | 19.3.0 |
| tailwind-merge | ^3.6.0 | 3.6.0 |
| ws | 8.21.3 | 8.21.3 |
| zod | ^4.6.1 | 4.6.2 |
| tsx | ^4.23.13 | 4.23.13 |
| drizzle-kit | 0.31.10 | 0.31.10 |
| @tailwindcss/postcss | 4.3.3 | 4.3.3 |
| @types/node | 22.19.15 | 22.19.15 |
| @types/pg | 8.18.0 | 8.18.0 |
| @types/react | 19.2.18 | 19.2.18 |
| @types/react-dom | 19.2.3 | 19.2.3 |
| @types/ws | ^8.18.1 | 8.18.1 |
| @vitejs/plugin-react | ^6.1.1 | 6.1.1 |
| eslint | ^9.39.5 | 9.39.5 |
| eslint-config-next | 16.3.4 | 16.3.4 |
| jsdom | ^30.0.1 | 30.0.1 |
| postcss | ^8.5.28 | 8.5.28 |
| tailwindcss | 4.3.3 | 4.3.3 |
| vitest | ^4.1.11 | 4.1.11 |
| typescript | ^5.7.2 | 5.9.3 |
| vite | ^8.2.2 | 8.2.2 |

## Go module (agent/go.mod)
```
module github.com/odoo-print-agent/agent

go 1.26

require (
	github.com/gorilla/websocket v1.5.3
	github.com/gosnmp/gosnmp v1.44.0
	github.com/grandcat/zeroconf v1.0.0
	github.com/kardianos/service v1.3.0
	github.com/klippa-app/go-pdfium v1.19.8
	github.com/mattn/go-sqlite3 v1.14.50
	github.com/tetratelabs/wazero v1.12.0
	golang.org/x/sys v0.47.0
	gopkg.in/natefinch/lumberjack.v2 v2.2.1
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/cenkalti/backoff v2.2.1+incompatible // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jolestar/go-commons-pool/v2 v2.1.2 // indirect
	github.com/miekg/dns v1.1.27 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/text v0.40.0 // indirect
)
```
go.sum digest: 8ff5229512e327ea

## Rust (src-tauri/Cargo.toml dependency lines)
```
name = "odoo-print-manager"
version = "1.0.0"
description = "Odoo Print Manager — lightweight management for Odoo Local Print Agent (Tauri 2.x, no Python)"
authors = ["Odoo Print Agent"]
license = "MIT"
repository = "https://github.com/mo7medSa3d/printer-repo"
edition = "2021"
rust-version = "1.90"
tauri-build = { version = "=2.6.3", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "=2.11.5", features = ["tray-icon"] }
tauri-plugin-autostart = "2"
url = "2.5.7"
reqwest = { version = "0.13.4", default-features = false, features = ["json", "rustls"] }
default = [ "custom-protocol" ]
custom-protocol = [ "tauri/custom-protocol" ]
lto = true
codegen-units = 1
strip = true
opt-level = 3
debug = false
```
Cargo.lock: a300ca6e5a3eeb1d

## Python/Odoo
addon external_dependencies: requests (Odoo runtime). No requirements.txt.

## Migration state
journal entries: 32 (0..31), last: 0031_enforce_tenant_cross_table_foreign_keys
SQL files: 32
meta snapshots: 0000_snapshot.json, 0028_snapshot.json, _journal.json
NOTE: 0029 modified in working tree vs HEAD (in-place edit of committed migration — finding P1-01). 0030/0031 untracked.
