# Security model

Verified against `src/lib/*.ts`, `src/app/api/**`, `agent/internal/**` and
`odoo_addons/print_gateway/security/*`. Claims are limited to what the code actually does.

## 1. Three separate authentication domains

| Domain | Credential | Storage | Verification |
|---|---|---|---|
| Agent | `Authorization: Bearer <agentId>:<secret>` | `agents.secret` = SHA-256 of a 24-byte random secret; plaintext returned once at pairing | `src/lib/agent-auth.ts` — constant-time compare, equal-length dummy compare on length mismatch |
| Manager | `mgr_session` httpOnly cookie (or `Authorization: Bearer <jwt>`) | HS256 JWT signed with `GATEWAY_JWT_SECRET`; `jti` row in `manager_sessions` | `src/lib/manager-auth.ts` — timing-safe HMAC, `exp` check, then the session row must exist, be unrevoked and unexpired |
| Odoo | `Authorization: Bearer odoo_<key>` or `X-Api-Key` | `api_keys.hashed_key` = SHA-256; prefix `odoo_` required | `src/lib/odoo-auth.ts` — hash lookup, revocation check, branch scope, timing-safe compare |

A credential from one domain is never accepted by another. The only endpoint that accepts
two domains on purpose is `POST /api/printers/:id/test-print` (manager session **or** a
branch-scoped Odoo key, because the addon's Test Print button has no manager session).

## 2. Manager sessions

* 8-hour lifetime (`MAX_AGE_SECONDS`), cookie is `httpOnly`.
* Self-contained HS256 token **plus** a server-side `manager_sessions` row, so logout
  (`POST /api/auth/manager/logout`) really revokes the token — a stolen cookie stops working.
* `GATEWAY_JWT_SECRET` must be at least 32 characters; the code refuses to sign otherwise.
* Password check (`verifyManagerPassword`): prefers `MANAGER_PASSWORD_HASH` in scrypt
  `salt:derived-hex` form, falls back to `MANAGER_PASSWORD`; both paths run
  timing-equalising work so a wrong username costs the same as a wrong password.
* Login fails closed when manager auth is not configured (HTTP 500, never "allow all").
* Login is rate-limited per IP and per account identifier in PostgreSQL
  (`src/lib/auth-rate-limit.ts`, table `auth_rate_limits`) so multiple gateway
  instances share the same counters. Repeated failures return HTTP 429 with
  `Retry-After` and a generic message (no user enumeration). A successful login
  clears the account bucket. Set `TRUST_PROXY=1` when a reverse proxy forwards
  `X-Forwarded-For`.
* Manager sessions are **global**, not branch-scoped — a manager sees every branch.

## 3. Odoo API keys

* Created by a manager (`POST /api/odoo/keys`); the plaintext is shown exactly once.
* Optional `branchId` scope: `isBranchScopedKeyAllowed` compares `String(keyBranch)` with
  `String(requestedBranch)`, so Odoo integer ids and gateway text ids cannot drift apart.
* Optional `allowedDocumentTypes`: `isOdooKeyAllowedForDocumentType` trims and lower-cases
  both sides, matching the routing layer's normalisation (a key listing `invoice` accepts a
  job for `Invoice`; a type that is genuinely absent is still rejected with 403).
* `scope: "read_only"` blocks every write operation.
* `lastUsedAt` is updated asynchronously; the raw key is never logged.

## 4. Agent authentication and isolation

* Pairing codes are 6 characters from an unambiguous alphabet, generated with
  `crypto.randomBytes` (~31 bits), valid 30 minutes, single-use with a re-check on the
  UPDATE so a racing second registration gets 409.
* Every agent endpoint resolves the agent from the bearer token; job queries are filtered by
  `agent_id` (and `branch_id` when the agent is branch-scoped).
* `PATCH /api/agent/jobs` answers **404 "Job not found"** both for unknown ids and for
  another agent's job, so job ids cannot be probed.
* The heartbeat upsert refuses to touch a printer row owned by a different agent
  (`skippedPrinters` in the response).
* On the agent host the secret is sealed with DPAPI on Windows
  (`CURRENT_USER` + `LOCAL_MACHINE` scope) and stored as an owner-only (0600) base64 file
  elsewhere (`agent/internal/storage`).

## 5. Branch isolation

Enforced in routing (`src/lib/routing.ts`), job creation, the sync endpoint, the manager
bindings endpoint and the agent endpoints. A binding can never connect resources across
branches, and a cross-branch printer/destination is refused rather than silently skipped.
See [../ARCHITECTURE.md](../ARCHITECTURE.md) §5.

## 6. Input validation

* **Payload**: `type ∈ raw|escpos|pdf`, `encoding = base64`, decoded size 1 B … 5 MiB, and a
  canonical base64 round-trip check so the gateway can never accept something the Go agent's
  strict decoder would reject (`src/lib/payload.ts`, `agent/internal/payload/payload.go`).
* **PDF**: `%PDF-` header within the first 64 bytes and `%%EOF` within the last 4 KiB before
  anything is written to disk or handed to a driver.
* **Printer registration**: type/protocol/connection/status whitelists, `ip:port` validation,
  spooler name requirement, id pattern `^[a-z0-9_][a-z0-9_-]*$`.
* **Sync**: whole-payload validation before any mutation; ids normalised to strings.
* **WebSocket**: 64 KiB frame cap, JSON-only, unknown message types ignored.
* Job `error` strings from agents are truncated to 2000 characters.

## 7. Command execution and file handling on the agent

* **No shell is ever used for printing.** The PDF helper is executed with
  `exec.CommandContext(argv[0], argv[1:]...)`; `{printer}` and `{file}` are substituted as
  whole argv elements, so spaces, `&`, `;`, quotes or newlines in a printer name cannot
  become commands. A unit test asserts the sources contain no `sh -c`, `cmd /C`, `bash` or
  `powershell` invocation.
* **Printer names** are validated (`ValidatePDFPrinterName`): no control characters, no
  quote characters, ≤ 220 bytes. On Windows the name is passed as a single quoted parameter
  to `ShellExecuteExW`, which is safe precisely because quotes are rejected.
* **Temporary files**: `os.MkdirTemp` (0700) + `os.CreateTemp` (0600). Names come from the OS
  random-name API — never from the job id, printer name or payload metadata — and the
  directory is removed on every exit path (success, failure, panic). Tests assert the file
  exists during the print and is gone afterwards in both outcomes.
* Payload bytes are size-capped before they are written anywhere.

## 8. Replay / duplicate protection

* `(branch_id, idempotency_key)` partial unique index: a retried Odoo request returns the
  existing job instead of creating a second one.
* A reclaim or redelivery reuses the **same job id**; new ids are never minted for retries.
* The agent's local SQLite queue is keyed by the gateway job id with `INSERT OR IGNORE`, and
  a job that already succeeded locally is never printed twice.
* Not protected: a job that was physically printing when the agent crashed. The outcome is
  unknown and is reported as such (`AGENT_RESTART_DURING_PRINT`); `agent.reprint_after_crash`
  decides whether it may be printed again. **No exactly-once printing guarantee is claimed.**

## 9. Secrets handling

* Agent secrets, Odoo keys and manager passwords are only ever stored hashed (or DPAPI-sealed
  on the agent host). Plaintext appears once, in the response that creates them.
* `GET /api/agents`, `/api/agents/:id`, `/api/odoo/agents` and `/api/odoo/sync` strip
  `secret` and `pairingCode` before returning rows.
* `.env` is git-ignored; `.env.example` contains placeholders only.
* Logs never contain raw keys or payload bodies.

## 10. Odoo-side security

* Write/create/unlink on branches, destinations, document types and bindings require
  `base.group_system`; ordinary users get read-only access, which keeps the
  `gateway_api_key` password field out of their reach.
* `_check_company_access` prevents acting on another company's branch, including printing.
* Record rules filter by company (`security/security.xml`).
* Regression tests live in `odoo_addons/print_gateway/tests/test_security_regressions.py`
  (**REQUIRES LIVE ODOO** to execute).
  A historical, more detailed audit is kept in
  `odoo_addons/print_gateway/SECURITY_AUDIT.md`.

## 11. Transport security

TLS is expected to be terminated in front of the gateway (reverse proxy or platform).
Agents connect outbound only (HTTPS + WSS) — no inbound ports are opened on the shop-floor
PC. The desktop app refuses gateway URLs with embedded credentials, query strings or
fragments, and requires `http://` or `https://`.

## 12. Known limitations

* No rate limiting on authentication endpoints.
* `Content-Length` is not checked before `req.json()`; the 5 MiB cap is enforced during
  validation.
* No audit log of manager actions beyond the job/printer rows themselves.
* Manager authorization is coarse (one global role).
