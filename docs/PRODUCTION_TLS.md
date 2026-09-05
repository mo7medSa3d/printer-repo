# Production TLS

The reference Docker Compose deployment exposes the gateway publicly only through Caddy.
The Next.js gateway listens on the private Docker network at `gateway:3000`; Caddy terminates
HTTPS on ports 80/443 and reverse-proxies both HTTP API and WebSocket traffic to the gateway.

Set `GATEWAY_DOMAIN` to a DNS name whose A/AAAA records point to the host. Open TCP 80 and 443
for certificate issuance/renewal and client traffic. Do not publish port 3000 directly in production.

Odoo branch configuration rejects non-HTTPS Gateway URLs. Windows agents likewise reject `http://`
server URLs unless both explicit development-only environment variables are enabled.
