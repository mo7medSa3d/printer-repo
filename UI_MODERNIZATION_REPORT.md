# Printer Gateway — Complete UI/UX Modernization Report

> **Superseded in part (2026-09):** the product has since been rebranded to the
> "Signal Blue" enterprise identity — a sophisticated blue primary (`#2563EB`) on cool
> neutrals, applied repository-wide (web, desktop, Odoo). The structural/UX work described
> below still stands; every colour reference in this document reflects the *previous*
> plum accent. See **[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)** for the current tokens,
> palette and Odoo scoping rules.

Scope: full product modernization of Odoo Print Gateway — Desktop Manager (flagship), Next.js web app, simulator, and Odoo add-on views — with zero changes to backend architecture, database schema, API/IPC contracts, authentication, agent protocol, or printing behavior.

---

## 1. UI/UX Audit Summary

**Audited surfaces:** Desktop Manager (Tauri WebView), web shell (layout/nav), login, landing, console dashboard (agents/printers/jobs), simulator, all 10 Odoo view files, shared states (empty/loading/error/success), dialogs, forms, tables, notifications, dark mode, typography, icons, spacing, and accessibility.

**Problems found (and fixed):**

| Area | Before | After |
|---|---|---|
| Design tokens | none — colors hardcoded (`zinc-*`, `blue-*`, `green-*`) across every surface | full token system; zero hardcoded colors |
| Desktop shell | single overloaded screen, no per-surface navigation, no Agents page | premium 5-page app shell + collapsed rail |
| Desktop statuses | color-only, inconsistent | icon + dot + label everywhere (WCAG 1.4.1) |
| Desktop dialogs | bare `alert()`-style flows | accessible Modal/Drawer with motion, focus management, confirmations |
| Desktop jobs | flat table only | tabs, search, per-printer filter, status pipeline timeline, rich details |
| Desktop agents | no Agents surface at all | dedicated Agents page (this PC + real gateway fleet summary) |
| Web | `alert()` for errors, no delete confirmation, hardcoded statuses, mixed nav | token-based, dismissible notice, confirm modals, unified nav |
| Simulator | old palette, color-only log levels | token-based panels, semantic log levels |
| Odoo | flat forms, no group titles, no status colors | native grouping, help, toggles, semantic tree decorations |
| Motion | ad-hoc | 150–200ms entrance/keyframe microinteractions, globally disabled under `prefers-reduced-motion` |
| Accessibility | missing focus rings, unlabeled icon buttons | focus-visible rings, enforced `aria-label` on IconButton, labelled dialogs, tooltips on collapsed rail |

**Verified against backend:** every action shown exists in the real IPC/API surface (`test_printer`, `discover_printers`, `register_printer`, `start/stop/restart/pair`, `get_printers`, `get_agent_status`, gateway health/jobs). No fake metrics, no invented actions. Destructive actions (Stop agent, delete agent on web) are confirmation-gated.

## 2. What Was Redesigned

- **Desktop Manager** — complete rebuild of the presentation layer on a new shell:
  - Collapsible premium sidebar (64px rail ↔ 240px): brand mark, Dashboard / Printers / Print Jobs / Agents / Settings with counts, `title` tooltips + `aria-label`s when collapsed, bottom Gateway + Agent connection status and version, keyboard-friendly buttons with `aria-current`.
  - Page header with live Agent badge and Refresh-all.
  - **Overview**: honest health banner ("Everything is running normally" / "Needs attention" with reason list), 4 real stat cards (agent/gateway/printers/jobs), printer snapshot, activity panel, recent jobs table.
  - **Printers**: search + status filter, table with type/connection/status + Test/Details, discovery + add-printer modal (spooler/network/USB/IPP), printer drawer (status, connection, protocol, address, stable ID, USB) with **Test print** and **View jobs** (per-printer job filter with removable chip).
  - **Print Jobs**: Tabs (All/Queued/Printing/Completed/Failed) with real counts, search, table, **job drawer with status-pipeline timeline** (Queued → Claimed → Printing → Completed / Failed), retries "x of 5", friendly + technical error details, copyable ID.
  - **Agents** (new): "This PC agent" card (status, service, version, hostname, last status check, local printers, Start/Stop/Restart), "Gateway fleet" card with real `total/online` counts from `/api/health` (honest empty/error states), "How agents work" explainer.
  - **Settings**: Gateway connection (save/check/error), Local agent (status, autostart switch with confirmation semantics), guided 1-2-3 Pairing, Advanced (security + copyable data paths + about/version).
- **Web app** — token-based shell/nav, modernized console (dismissible notice, delete-agent confirmation modal, copyable pairing codes, mono IDs), login, landing (single brand accent, feature cards), simulator.
- **Odoo views** — all 10 files: native grouping, `boolean_toggle`, `widget="badge"`, semantic `decoration-*` tree colors, `oe_highlight` primary actions, alert callouts, placeholders/help — keeping Odoo's design language intact.
- **Brand details** — app icon usage consistent (desktop sidebar mark, web favicon via `app/icon.png`, browser titles "Odoo Print Manager" / "Odoo Print Gateway"), version presentation in sidebar + settings.

## 3. Design System / Tokens (`src/app/globals.css`)

Single source of truth, imported by both Desktop (Vite) and Web (Next):

- **Brand**: `--brand-50…900` (at the time, brand-700 `#714b67`; **now** `--brand` = `#2563EB`, hover `#1D4ED8`, active `#1E40AF` — see DESIGN_SYSTEM.md), hover/active stairs.
- **Neutrals**: `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--border`, `--border-strong`, `--text / --text-2 / --text-3` (warm ink).
- **Semantic**: `--ok / --warn / --bad / --info` + `-bg` + `-edge` variants; shared by printer/agent/job/gateway statuses (ONLINE/CONNECTED/SUCCESS/READY → ok; OFFLINE/FAILED/ERROR → bad; PRINTING/BUSY → warn; CLAIMED → info).
- **Dark mode**: automatic via `prefers-color-scheme`, same token names — no `dark:` color exceptions.
- **Typography**: Inter-first sans stack; `--font-mono` only for IDs, endpoints, paths, technical data (`Mono` component).
- **Radii/shadow/overlay**: `--radius-card 12px`, `--shadow-card`, `--overlay`.
- **Motion primitives**: `pg-fade-in`, `pg-rise-in`, `pg-slide-in-right`, `pg-toast-in` (150–200ms, easings tuned), globally near-zeroed under `prefers-reduced-motion`.
- **Base**: focus-visible brand ring, selection color, reduced-motion handling.
- Tailwind v4 mapping via `@theme inline` → `bg-app`, `bg-surface*`, `border-edge*`, `text-ink*`, `bg/text/border-ok(-bg/-edge)`, `warn`, `bad`, `info`, `brand-*`.

## 4. Desktop Manager Improvements

- Flagship feel: slim dark-neutral app shell with brand accent, compact density, mono data, technical status language.
- Sidebar: collapse/expand (PanelLeftClose/PanelLeftOpen), tooltips when collapsed, counts per page, bottom gateway + agent status with last-check time, version.
- Overview answers the operational questions immediately (agent connected? printers online? failed printers? queued/failed jobs? gateway healthy? last sync?) using only real data — no fabricated metrics.
- Printers: at-a-glance status (icon+dot+label), contextual actions that exist (Test / Details / View jobs / Discover / Add), destructive actions only via confirmed dialogs.
- Jobs: operational clarity with tabs, filter chip per printer, pipeline visualization in details, clear failed-job treatment (reason + technical detail + retries) and honest "sign in at the gateway dashboard" state when the manager has no gateway session (401s surfaced, never hidden).
- Agents: dedicated experience (new) — local agent + real fleet summary + honest no-data states.
- Settings: logical groups with descriptions; destructive stop-agent requires explicit confirmation modal.
- Microinteractions: button hover/press states, sidebar width transitions, dialog entrance (fade/rise/slide), toast entrance, status dot pulses, row hover — all fast and reduced-motion-safe.

## 5. Web Application Improvements

Same visual language, adapted to browser/management context:

- Token-based shell with branded nav and version chip (routes unchanged).
- Console: shared cards/badges/tables, inline dismissible announcement banner instead of `alert()`, typed delete-agent confirmation modal, pairing codes in warn-tinted copyable box, mono IDs, consistent empty/error/loading states.
- Login: focused branded card, inline `role="alert"` errors, submit loading state, honest session help text. No auth semantics changed.
- Landing: brand hero + single-accent feature grid, real product copy.
- Simulator: token panels, semantic log levels, honest connection states.
- Shared primitives guarantee parity with the desktop (buttons, statuses, cards, dialogs, toasts, tabs).

## 6. Components Created / Reused

**Shared library `src/components/ui.tsx`** (used by both platforms):
Button (primary/secondary/ghost/danger, sizes, loading) · IconButton (label enforced) · StatusDot · StatusBadge (icon+dot+label) · Card/CardHeader · EmptyState (explains *what happened / why / what next*, with action) · ErrorState (actionable retry) · LoadingState (skeleton rows, layout-stable) · Field/Input/Select · Modal & Drawer (Escape, backdrop, focus trap/restore, labelled, entrance motion) · Tabs (counts + brand underline) · Toast (role=status, dismissible) · CopyButton · Mono · MetaRow.

**In-file Desktop primitives:** JobTimeline (status pipeline), status vocabulary (`printerTone/jobTone/labelPrinter/labelJob`), `humanType/humanConnection/printerEndpoint`, friendly error mapping. **Dependencies reused, none added:** `lucide-react`, Tailwind v4, React 19, Tauri v2 IPC.

## 7. Architectural Changes Required

**None.** The entire modernization is presentation-layer:

- No backend/API/DB/auth/IPC contract changes.
- All Desktop IPC calls are exactly the original ones (`get_agent_status`, `get_printers`, `discover_printers`, `register_printer`, `test_printer`, `start/stop/restart_agent`, `pair_agent`, `get/set_gateway_url`, `get/set_autostart`, `get_runtime_paths`, `get_app_version`, `fetchGatewayJobs`, `fetchGatewayHealth`, tray events).
- Web client uses the existing Next API routes unchanged.
- The one desktop-side behavioral clarification (prior audit, kept): Jobs tab explicitly tells the user a manager session is needed at the gateway dashboard instead of failing silently — same underlying 401.

## 8. Verification Results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` | ✅ 47 passed (7 files), 1 skipped |
| `npm run build` | ✅ Next build OK |
| `npm run desktop:vite:build` | ✅ pass (266 kB JS / 40 kB CSS bundle) |
| `npm ci --dry-run` | ✅ resolves cleanly |
| `git diff --check` | ✅ clean |
| Odoo view XML parse (all files) | ✅ well-formed |
| Odoo view→model field reference check | ✅ all fields exist |
| Live web preview | ✅ `/`, `/login`, `/simulator` 200; `/dashboard` 307 → login (correct) |
| Remaining hardcoded legacy colors in UI | ✅ none (`grep` for `zinc-/gray-/blue-/green-` in `src/app|src/components|src/desktop`) |

## 9. Remaining Limitations

- **Desktop pixel QA**: the Tauri shell cannot be screenshotted in this environment; verified via typecheck, Vite build, and code review of the rendered structure.
- **Odoo visual QA**: static verification only (XML well-formedness + field refs); no running Odoo instance. Only native elements used, so risk is limited to arch details across Odoo versions.
- **Theme toggle**: dark/light follows the OS automatically; an in-app manual theme override is not implemented (would need persisted preference plumbing across Desktop + Web — left as follow-up).
- **Fleet detail**: per-agent listing (pairing codes, per-agent printers) requires the gateway manager session; desktop shows real aggregate counts from `/api/health` plus honest guidance.
- **No visual regression suite**: no Playwright/Percy added (per "no new dependencies"); could be added on request.
- **Odoo brand color**: *(superseded)* the add-on now ships a scoped brand layer — `--pg-*` tokens plus a skin bound to `.o_pg_view` / `.o_pg_form` / `.o_pg_list` / `.o_pg_kanban` — so Odoo carries the same blue identity while Odoo's own theme and every other app stay untouched. See DESIGN_SYSTEM.md §7.

## 10. Environment-Gated Checks

- **Go** (`go build ./...`, `go vet ./...`, `go test ./...`, `go test -race ./...`): toolchain not installed in this sandbox (`go: command not found`). Agent code was **not** touched by this effort; the earlier full audit pass on this branch ran the complete Go matrix (build/vet/test/race + Windows cross-build) green.
- **Rust/Tauri** (`cargo check`, `cargo tauri build`): no `cargo`/`rustc` in the environment. Rust surface (`src-tauri/`) untouched except a prior-audit fix; Tauri config (`window.title = "Odoo Print Manager"`), capabilities and IPC commands were reviewed statically. Recommended: run `cargo check` + `cargo tauri build` in a Rust-enabled CI, and commit `src-tauri/Cargo.lock` after the first successful build (currently not tracked).
