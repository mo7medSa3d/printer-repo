# Odoo Print Manager — Tauri Desktop (Phase 1)

**Stack:** Tauri 2.x + React + TypeScript + Rust. **No Python, no Electron.**

- UI: `src/desktop/main.tsx` (polls `GET /api/health`, thin Tauri invokes)
- Rust: `src-tauri/src/{main.rs,tray.rs,commands.rs}` — thin, allowlisted shell only
- Build host needs Rust stable + `cargo install tauri-cli --version "^2"`
- Customer needs **no** Node/Python/Go/Rust. Installer bundles `dist-desktop` + `agent/*.exe` resources.

## Build (Windows host with Rust)

```bash
npm install
npm run desktop:vite:build    # produces dist-desktop/ (224K, no Tauri API externalized)
cargo tauri build              # needs WebView2 SDK on Windows; produces src-tauri/target/release/bundle/nsis/*.exe
```

`tauri.conf.json: bundle.windows.webviewInstallMode.downloadBootstrapper` — downloads WebView2 Evergreen if missing. Test on clean Win10 1809+/Win11 VM (see docs/VERIFICATION.md).

## Permissions (least-privilege)

- `C:\ProgramData\OdooPrintManager\settings.json` — installer `mkdir` with SYSTEM:F, Administrators:F; Manager writes via `tauri-plugin-store` (verify `icacls` on VM).
- `C:\ProgramData\OdooPrintAgent\config.yaml|agent.db|logs` — SYSTEM:F, Administrators:F, Service SID F. Manager never writes except via elevated CLI.

## Verification

See `docs/VERIFICATION.md` — Desktop rows are `REQUIRES REAL WINDOWS TEST` until Tauri build + VM probe + tray hide-not-exit proven.
