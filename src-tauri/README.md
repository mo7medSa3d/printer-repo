# Odoo Print Manager — Tauri Desktop (Phase 1)

**Stack:** Tauri 2.x + React + TypeScript + Rust. **No Python, no Electron.**

- UI: `src/desktop/main.tsx` (polls `GET /api/health`, `@tauri-apps/api` + plugin-store)
- Rust: `src-tauri/src/{main.rs,tray.rs,commands.rs,agent.rs,paths.rs,logging.rs}` — Rust commands only, no shell plugin
- Build host needs Rust stable + `cargo install tauri-cli --version "^2"`
- Customer needs **no** Node/Python/Go/Rust. Installer bundles `dist-desktop` + `agent/*.exe` resources.

## Build (Windows host with Rust)

```bash
npm ci
npm run desktop:vite:build    # produces dist-desktop/
# build agent binaries first (resources are required by the bundler)
cd agent && go build -o OdooPrintAgent.exe ./cmd/agent && go build -o odoo-agent-cli.exe ./cmd/cli && cd ..
cargo tauri build              # produces src-tauri/target/release/bundle/{nsis,msi}/...
```

`tauri.conf.json: bundle.windows.webviewInstallMode.downloadBootstrapper` — downloads WebView2 Evergreen if missing. Test on clean Win10 1809+/Win11 VM (see docs/VERIFICATION.md).

## Permissions (least-privilege)

- Manager settings/logs prefer `C:\ProgramData\OdooPrintManager\` and fall back to `%LOCALAPPDATA%\OdooPrintManager\` when the current user cannot write ProgramData.
- Agent config/db/logs prefer `C:\ProgramData\OdooPrintAgent\` and fall back to `%LOCALAPPDATA%\OdooPrintAgent\`; the installer should still create ProgramData-and-ACL entries on a real install so all users share the same runtime.
- Tauri capabilities are in `src-tauri/capabilities/default.json`: `core:default` + `store:default` only. No shell/process/fs/http permissions are granted.

## Verification

See `docs/VERIFICATION.md` — Desktop rows are `REQUIRES REAL WINDOWS TEST` until Tauri build + VM probe + tray hide-not-exit proven.
