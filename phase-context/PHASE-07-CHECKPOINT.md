# Phase 07 - Credentials / Integrations

## Verification
- Investigated `src/lib/odoo-auth.ts`, `src/lib/manager-auth.ts`, `src/lib/agent-auth.ts`.
- Verified Odoo API keys (installation-scoped) are securely generated and strictly hashed with sha256.
- Raw secrets are never stored inside the Postgres database, only hashes.
- Verified Manager auth implements correct scrypt logic for password verification.
- Verified that timing attacks are prevented by using `timingSafeEqualStr`.
- Checked key creation and revocation procedures.

## Findings
- Secure credential handling is consistently employed across Odoo keys, Desktop sessions, Agent pairings, and Manager passwords.
