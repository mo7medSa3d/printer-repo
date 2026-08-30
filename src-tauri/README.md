# Odoo Print Manager — Tauri Desktop (Phase 1)

**Stack:** Tauri 2.x + React + TypeScript + Rust. **No Python, no Electron.**

- UI: `src/desktop/main.tsx` (view) + `src/desktop/lib/ipc.ts` (typed IPC boundary; polls `GET /api/health`, tray events)
- Rust: `src-tauri/src/{main.rs,tray.rs,commands.rs,agent.rs,paths.rs,logging.rs}` — async Rust commands only, no shell plugin
- Build host needs Rust stable + `cargo install tauri-cli --version "^2"`
- Customer needs **no** Node/Python/Go/Rust. Installer bundles `dist-desktop` + `agent/*.exe` resources.

## Build (Windows host with Rust)

```powershell
# One-shot: prerequisites + typecheck/lint + frontend + Go agent (release) + Tauri bundle
pwsh -File scripts/build-windows-installer.ps1
# or step by step:
npm ci
npm run desktop:vite:build    # produces dist-desktop/
# build agent binaries first (resources are REQUIRED by the bundler)
cd agent && go build -trimpath -ldflags "-s -w" -o OdooPrintAgent.exe ./cmd/agent ^
        && go build -trimpath -ldflags "-s -w" -o odoo-agent-cli.exe ./cmd/cli && cd ..
cargo tauri build              # produces src-tauri/target/release/bundle/{nsis,msi}/...
```

`tauri.conf.json: bundle.windows.nsis` — per-machine install, Start Menu + desktop shortcuts, Add/Remove Programs uninstaller. `webviewInstallMode.downloadBootstrapper` — downloads WebView2 Evergreen if missing. Test on clean Win10 1809+/Win11 VM (see docs/VERIFICATION.md).

## Permissions (least-privilege)

- Manager settings/logs prefer `C:\ProgramData\OdooPrintManager\` and fall back to `%LOCALAPPDATA%\OdooPrintManager\` when the current user cannot write ProgramData.
- Agent config/db/logs prefer `C:\ProgramData\OdooPrintAgent\` and fall back to `%LOCALAPPDATA%\OdooPrintAgent\`; the installer should still create ProgramData-and-ACL entries on a real install so all users share the same runtime.
- Tauri capabilities are in `src-tauri/capabilities/default.json`: `core:default` only. No store/shell/fs/http permissions are granted; settings are persisted by Rust commands (`settings.json`), not by a WebView plugin.

## Verification

See `docs/VERIFICATION.md` — Desktop rows are `REQUIRES REAL WINDOWS TEST` until Tauri build + VM probe + tray hide-not-exit proven.
