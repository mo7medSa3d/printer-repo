# Production TLS

The reference Docker Compose deployment exposes the gateway publicly only through Caddy.
The Next.js gateway listens on the private Docker network at `gateway:3000`; Caddy terminates
HTTPS on ports 80/443 and reverse-proxies both HTTP API and WebSocket traffic to the gateway.

Set `GATEWAY_DOMAIN` to a DNS name whose A/AAAA records point to the host. Open TCP 80 and 443
for certificate issuance/renewal and client traffic. Do not publish port 3000 directly in production.

## Transport policy (actual, enforced behavior)

The Odoo branch configuration and the Windows agent deliberately ACCEPT both
`http://` and `https://` Gateway URLs for any host (LAN, loopback, public) —
see `gateway_config._validate_gateway_url`, `validateServerURL`, and
`test_gateway_url_transport.py::test_http_gateway_url_is_accepted_for_any_host`.
There is NO development-only opt-in gate, and no pair of environment variables
that re-enable an HTTP rejection (an older revision documented them; the
behavior was intentionally relaxed to zero-config and the code is authoritative).

Consequences operators must act on:

- Agent secrets, pairing codes, Odoo API keys, and full print documents travel
  IN PLAINTEXT over `http://`. Use `https://` for anything outside a trusted
  LAN segment. Credential theft over HTTP is a deployment configuration
  defect, not an application bypass: the code cannot distinguish the LAN
  threat model from the WAN one.
- Odoo accepts private/loopback/link-local targets (`127.0.0.1`, `192.168/16`,
  `10/8`) by design. Setting the Gateway URL (system administrators only)
  therefore lets the Odoo server issue requests to internal origins (fixed
  `/api/odoo/*` paths, `allow_redirects=False`). Treat the URL field as a
  privileged integration setting, not a user input.
