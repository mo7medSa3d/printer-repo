# Project Context

## Overview
This project is an Odoo Print Gateway. It manages silent Odoo 19 printing via a Next.js Gateway, a Go Windows Agent, and a Tauri Desktop Manager.
The architecture includes tenant isolation, centralized authorization, and robust job delivery tracking.

## Baseline Tools
- Node `>= 24.15.0`
- pnpm `12.x`
- Go `1.26` (environment currently `1.24.3`)
- Rust `1.90` (environment currently `1.94.0`)
- Docker `29.2.1`

## Migrations
- `drizzle/` has 37 migrations up to `0036_print_job_request_id.sql`.

## Phase State
- **Phase 00:** COMPLETED.