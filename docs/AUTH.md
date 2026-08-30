# Manager Authentication — Spec (Implemented)

> Three security domains remain separate: Agent (`Bearer agt:secret`), Odoo (`Bearer odoo_xxx`), Manager (httpOnly JWT).

## Manager Session

- **Login:** `POST /api/auth/manager/login` `{username,password}` → validates against `MANAGER_USERNAME` + (`MANAGER_PASSWORD_HASH` scrypt `salt:hex` or `MANAGER_PASSWORD` fallback). On success creates `manager_sessions` row `jti, expiresAt=now+8h` and returns `Set-Cookie: mgr_session=<HS256 JWT>; Path=/; HttpOnly; SameSite=Lax; Secure(prod); Max-Age=28800`. JWT payload `{jti, iat, exp, sub:"manager"}`, HMAC-SHA256 with `GATEWAY_JWT_SECRET` (≥32 chars). See `src/lib/manager-auth.ts:15`.
- **Verification:** `validateManager(req)` checks cookie `mgr_session` else `Authorization: Bearer <jwt>`, verifies HMAC timing-safe, checks `manager_sessions` not revoked/expired. Used by `GET /api/agents`, `/api/printers`, `/api/jobs`, `/api/printers/:id/test-*`, `/api/odoo/keys`.
- **Pages & actions too:** the `/dashboard` server component verifies the same cookie via `verifyManagerToken` + `validateManagerClaims` and `redirect("/login")` otherwise (it renders DB data directly — without the check it would bypass the API guards entirely), and selects agent rows **without** `agents.secret`. Every `"use server"` action in `src/app/actions.ts` runs `requireManager()` first — server actions are public POST endpoints and are NOT implicitly authenticated.
- **Jobs filter:** `GET /api/jobs` filters (`status`, `printerId`, `agentId`) are applied in SQL `WHERE` before `LIMIT`; an unknown `status` value returns `400`.
- **Logout:** `POST /api/auth/manager/logout` → `manager_sessions.revokedAt=now` + `Set-Cookie` clear.
- **Me:** `GET /api/auth/manager/me` → `{authenticated, jti, exp}`.
- **Expiry:** 8h fixed, no sliding. After expiry client must re-login. `manager_sessions.expiresAt` indexed.
- **Revocation:** server-side `jti` row; logout or admin `UPDATE manager_sessions SET revokedAt`. Cookie theft after logout is useless.
- **Scope:** manager can read agents/printers/jobs, create printers, `test-connection`/`test-print`, manage `api_keys` list. Cannot read `agents.secret` (stripped in `GET /api/agents/[id]:14`) or `api_keys.hashedKey`.

## Tauri Cookie Preservation — Verification Required (Constraint 2)

Tauri WebView `fetch` does NOT automatically persist httpOnly cookies like a browser. Verification flow before claiming green:

1. `fetch(gatewayUrl + "/api/auth/manager/login", {method:"POST", body: JSON, credentials:"include"})` → capture `Set-Cookie`.
2. `fetch(gatewayUrl + "/api/agents", {credentials:"include"})` → must return 200 without re-login.
3. If `fetch` drops cookies, switch to `tauri-plugin-http` with explicit cookie jar or store JWT in `tauri-plugin-store` + `Authorization: Bearer` header.

Status: **NOT VERIFIED** on real Tauri WebView — requires `REQUIRES REAL WINDOWS TEST` in `docs/VERIFICATION.md` W5.

## Odoo API Key

- Created via `POST /api/odoo/keys` (manager auth). Raw key `odoo_<base64url>` shown once, stored as `SHA256 hashedKey` in `api_keys`. Validated via `validateOdooKey(req)` `src/lib/odoo-auth.ts:23` (`Authorization: Bearer odoo_xxx` or `X-Api-Key`). `POST /api/print/jobs` requires it; `GET /api/print/jobs?id=...` polls status.

## Agent Credential

- `Bearer <agentId>:<secret>` → `validateAgent` `src/lib/agent-auth.ts:47` timing-safe hash. Used only for `POST /api/agent/heartbeat`, `GET/PATCH /api/agent/jobs`, `WS /api/agent/ws`. Never exposed to manager or Tauri renderer. Pairing via `odoo-agent-cli.exe -pair` persists to `C:\ProgramData\OdooPrintAgent\config.yaml` (least-privilege ACL).

## Env Required

```
DATABASE_URL=postgresql://...
GATEWAY_JWT_SECRET=<≥32 chars random>
MANAGER_USERNAME=admin
MANAGER_PASSWORD_HASH=<scrypt salt:hex>  # or MANAGER_PASSWORD for dev
```
