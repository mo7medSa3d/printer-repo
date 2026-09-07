# Configuration

## Gateway server

Gateway runtime settings remain in `.env` and deployment secrets.

Key values include `DATABASE_URL`, manager authentication, `GATEWAY_JWT_SECRET`, `ODOO_DATABASE_NAME` in production, and proxy/trust settings required by the deployment.

`ODOO_DATABASE_NAME` binds Odoo API access to the one Odoo database served by the Gateway installation.

## Agent

The Go Agent stores its Gateway URL, agent identity/secret, local queue settings, and printer runtime configuration in its protected data directory. Printer identity and capabilities are runtime-owned by the Agent/Gateway.

## Odoo addon

The addon has only three business-facing models:

| Model | Configuration |
|---|---|
| `print_gateway.gateway_config` | Odoo company, enabled, Gateway URL, API key, connection-test state |
| `print_gateway.binding` | Native Odoo destination/context, document type, Gateway printer id, enabled, priority |
| `print_gateway.print_job` | Durable print operation, idempotency key, status and retry state |

Normal configuration is only:

`Gateway URL + API Key + Test Connection + Enable`

Then define:

`Destination + Document Type -> Printer`

No Gateway Branch ID, Gateway destination id, duplicate document catalog, agent id, or printer provisioning setting exists in the Odoo module.

## URL security

Gateway URLs must use HTTP/HTTPS, include a host, contain no userinfo/query/fragment, and be an origin rather than an API path. Local/private addresses are rejected unless explicitly allow-listed by deployment policy. Requests disable redirects.

## API keys

Odoo API keys are installation-level. Gateway stores only the cryptographic hash. The raw value is returned once from the manager **Generate API Key** action and is never returned by list/read endpoints. Revoke immediately invalidates authentication.

## Runtime ports

Gateway HTTP and Agent WebSocket share the configured Gateway port. PostgreSQL is deployment-local. Agents require outbound HTTPS/WSS connectivity to Gateway; printers use the transports supported by their runtime configuration.
