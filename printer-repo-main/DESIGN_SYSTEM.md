# Print Gateway — Design System

**Direction:** calm, modern, premium enterprise. A sophisticated blue primary on cool neutrals,
with very subtle blue-tinted surfaces for character. Light mode is the default presentation;
dark mode is the same identity in deep cool slate.

The same brand must be recognisable whether the operator opens the **Desktop Manager (Tauri)**,
the **Web console (Next.js)** or the **Odoo add-on**. Those are three surfaces of one product.

---

## 1. Sources of truth

| Surface | Token file | Consumed by |
|---|---|---|
| Web console + Desktop manager | `src/app/globals.css` | Next.js (`app/layout.tsx`) and Vite/Tauri (`src/desktop/main.tsx` imports the same file) |
| Odoo add-on | `odoo_addons/print_gateway/static/src/scss/print_gateway_tokens.scss` | `web.assets_backend` (see `__manifest__.py`) |
| Odoo skin | `odoo_addons/print_gateway/static/src/scss/print_gateway_backend.scss` | scoped to `.o_pg_view` / `.o_pg_form` / `.o_pg_list` / `.o_pg_kanban` |
| Product mark | `src-tauri/icons/icon-source.svg` → `scripts/generate-icons.mjs` | Tauri icons, `src/app/icon.png`, Odoo module icon |

**Rule:** never write a raw hex value in a component. Add or reuse a token.
Web/desktop components consume tokens through Tailwind utilities (`bg-brand`, `text-ink-2`,
`border-edge`, `bg-ok-bg`…); Odoo consumes them through `--pg-*` custom properties.

---

## 2. Colour

### Brand ramp (light)

| Token | Value | Use |
|---|---|---|
| `--brand-50` / `--pg-brand-50` | `#EFF6FF` | soft blue surface |
| `--brand-100` | `#DBEAFE` | light blue accent, borders |
| `--brand-500` | `#3B82F6` | icon fills, dark-mode primary |
| `--brand-600` | `#2563EB` | **primary brand** |
| `--brand-700` | `#1D4ED8` | hover |
| `--brand-800` | `#1E40AF` | active/pressed |
| `--brand-900` / `--brand-950` | `#1E3A8A` / `#172554` | deep accents |

### Semantic brand aliases (preferred in components)

`--brand`, `--brand-hover`, `--brand-active`, `--brand-contrast`, `--brand-subtle`,
`--brand-subtle-hover`, `--brand-subtle-text`, `--brand-ring`.

Tailwind: `bg-brand`, `hover:bg-brand-hover`, `active:bg-brand-active`, `text-brand-contrast`,
`bg-brand-subtle`, `text-brand-subtle-text`.

### Surfaces, borders, text

| Token | Light | Role |
|---|---|---|
| `--bg` | `#F8FAFC` | page canvas |
| `--surface` | `#FFFFFF` | cards, sheets, dialogs |
| `--surface-2` | `#F1F5F9` | inset, table head, hover |
| `--surface-3` | `#E2E8F0` | stronger inset |
| `--surface-accent` | `#EFF6FF` | blue-tinted informational surface, row hover |
| `--border` | `#E2E8F0` | default hairline |
| `--border-strong` | `#CBD5E1` | emphasised border, hover |
| `--border-accent` | `#DBEAFE` | border on blue-tinted surfaces |
| `--text` | `#0F172A` | primary text |
| `--text-2` | `#475569` | body / secondary |
| `--text-3` | `#64748B` | muted, metadata (the brief's "secondary text") |
| `--text-4` | `#94A3B8` | placeholder, disabled, inactive dot |

> **Deliberate exception to the brief's palette:** the brief lists `#64748B` as *secondary text*.
> `#64748B` on `#FFFFFF` is 4.76:1 — fine for metadata, tight for long body copy — so body text
> uses `#475569` (`--text-2`) and `#64748B` is kept for the muted/metadata level (`--text-3`).
> Both come from the same cool-neutral (Slate) family, so the hierarchy stays consistent.

### Status

Each status has an accessible **text** token and a saturated **`-solid`** fill (dots, bars, filled
buttons), plus `-bg` and `-border` tints:

| Status | text | solid | bg | border |
|---|---|---|---|---|
| Success | `#15803D` | `#16A34A` | `#F0FDF4` | `#BBF7D0` |
| Warning | `#B45309` | `#D97706` | `#FFFBEB` | `#FDE68A` |
| Error | `#DC2626` | `#DC2626` | `#FEF2F2` | `#FECACA` |
| Info | `#2563EB` | `#3B82F6` | `#EFF6FF` | `#DBEAFE` |

> The brief's `#16A34A` / `#D97706` are kept as the **fills**; the text variants are one step
> darker so small labels stay AA-legible on white and on their tinted backgrounds.

Status mapping (identical on all three surfaces):

- `online`, `connected`, `success`, `completed`, `ready`, `enabled` → **ok**
- `busy`, `printing` → **warn**
- `offline`, `error`, `failed`, `expired` → **bad**
- `claimed`, `queued` (web/desktop: queued = neutral) → **info**
- `unknown` → **neutral**

---

## 3. Radius, elevation, spacing, motion

| Scale | Values |
|---|---|
| Radius | `4 / 6 / 8 / 10 / 12 / 16 / pill` — controls (`rounded-md` 8px), cards (`rounded-xl` 12px), dialogs (`rounded-2xl` 16px), pills |
| Elevation | `--shadow-xs → --shadow-xl`, cool slate-tinted (`rgba(15,23,42,…)`), never black-heavy |
| Spacing | 4px base: `--space-1 … --space-12` |
| Motion | `--dur-fast 120ms`, `--dur-normal 180ms`, `--dur-slow 240ms`, `--ease-out cubic-bezier(.16,1,.3,1)`; everything neutralised under `prefers-reduced-motion` |

**Gradients:** exactly two sanctioned uses — the 2px `brand-hairline` on hero/auth/Odoo form sheets,
and the near-flat tile gradient of the product mark. Nothing else gradients.

---

## 4. Typography

Inter-first sans stack; monospace reserved for IDs, endpoints, paths and other technical data.

| Level | Size / weight |
|---|---|
| Page title | 20–24px, 600, `-0.015em` |
| Card / section title | 14px, 600 |
| Body | 14px, 400–500, line-height 1.5 |
| Small / metadata | 12px |
| Caption + uppercase label (`.label-caps`) | 11px, 600, `0.06em`, muted |

---

## 5. Interaction states

| State | Treatment |
|---|---|
| Hover (primary) | `--brand-hover` |
| Hover (quiet/ghost) | `--brand-subtle` background + `--brand-subtle-text` |
| Active/pressed | `--brand-active` |
| Focus-visible | 3px `--brand-ring` shadow (`--focus-ring-shadow`) or a 2px `--focus-ring` outline |
| Row hover | `--surface-accent` (`.row-hover`) |
| Selected nav | `--brand-subtle` + 2px brand rail indicator |
| Disabled | 50% opacity, `--surface-2` field background |

---

## 6. Shared component classes

Defined once in `globals.css` and reused by both web and desktop:

`.card`, `.card-interactive`, `.surface-accent`, `.brand-hairline`, `.canvas-wash`,
`.table-head`, `.row-hover`, `.label-caps`, `.focusable`, `.ring-focus`, `.skeleton`,
plus the motion utilities `.pg-fade-in`, `.pg-rise-in`, `.pg-slide-in-right`, `.pg-toast-in`.

React primitives live in `src/components/ui.tsx` (`BrandMark`, `Button`, `IconButton`,
`StatusDot`, `StatusBadge`, `Card`, `CardHeader`, `EmptyState`, `ErrorState`, `LoadingState`,
`Field`, `Input`, `Select`, `Modal`, `Drawer`, `Tabs`, `CopyButton`, `Toast`, `Mono`, `MetaRow`).

---

## 7. Odoo specifics

Odoo is a hosted UI with its own framework, so the brand is applied **as a scoped skin**, not as a
re-implementation:

- All rules are namespaced under `.o_pg_view` (plus `.o_pg_form`, `.o_pg_list`, `.o_pg_kanban`),
  a class the add-on puts on its own view roots. Other Odoo apps are untouched.
- Odoo's own Bootstrap/SCSS variables are **not** overridden — that would repaint the whole
  backend and break customer themes.
- The control panel and breadcrumbs live outside the view root; they are branded only while a
  Print Gateway view is on screen via `.o_action_manager:has(.o_pg_view)`. Browsers without
  `:has()` keep Odoo's native chrome (progressive enhancement, no breakage).
- Status colours reach lists through Odoo's native `decoration-*` mechanism, remapped to the
  shared status tokens; badges (`widget="badge"`) are re-tinted to the same scale.
- Branded kanban cards (`o_pg_kanban`) mirror the desktop's fleet cards; list stays the default
  view so no existing behaviour changes.
- The module icon and the Apps description page (`static/description/index.html`) use the same
  mark and palette as the desktop installer and the web favicon.

---

## 8. Adding to the system

1. Need a colour? Use an existing token. If genuinely new, add it to **both** `globals.css` and
   `print_gateway_tokens.scss`, in light and dark, and document it here.
2. Need a surface? Compose `.card` / `.surface-accent` before inventing new geometry.
3. Need a status? Reuse the ok/warn/bad/info scale — never introduce a new hue for a new state.
