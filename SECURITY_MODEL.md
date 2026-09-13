# Security Model

## Identity
Human manager sessions, Odoo API keys, Agents, and future API clients are separate credential classes. Agent credentials are not treated as human sessions.

## Authorization
Server-side tenant context is mandatory for runtime resources. Client-supplied `tenant_id` is not trusted. Manager sessions bind the tenant at authentication time. Odoo tenant context comes from the API-key record.

## Pairing
Pairing remains short-lived/hashed and is intended only for bootstrap. Successful pairing mints the Agent credential; the pairing value is not the long-term identity.

## Job security
Keep the existing claim-token fencing, stale-claim recovery, and `SKIP LOCKED` behavior. Do not retry blindly after uncertain physical outcomes.

## Request security
The custom Next.js server guard checks `Content-Length` without consuming the incoming request stream. The reverse proxy remains responsible for the edge request-size limit.

## Secrets
Never log raw API keys, Agent secrets, passwords, or pairing values. Production Manager login requires a password hash rather than plaintext configuration.
