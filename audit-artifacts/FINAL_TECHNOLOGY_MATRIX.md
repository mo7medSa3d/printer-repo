# FINAL_TECHNOLOGY_MATRIX.md (Phase 2, verified 2026-09-13 via npm registry, nodejs.org index, go.dev, Docker Hub, GitHub releases, odoo.com docs)

| Technology | Repo | Latest stable | Supported? | Security | Breaking/deprecations relevant | Source | Impact / Action |
|---|---|---|---|---|---|---|---|
| Node | engines ≥24.15; .nvmrc 24.21.0; Docker 24.21.0 | 24.21.0 LTS ("Krypton") | yes | current | — | nodejs.org/dist/index.json | sandbox host runs 22 → cannot execute gateway tests here |
| Next.js | 16.3.4 | 16.3.5 (patch) | yes | current | — | registry.npmjs.org/next/latest | 16.3.5 deferred (lockfile regen needs npm install — blocked) |
| React / pg / ws / drizzle-orm / nanoid / tailwind / drizzle-kit | 19.3.0 / 8.23.0 / 8.21.3 / 0.45.2 / 6.0.1 / 4.3.3 / 0.31.10 | identical | yes | current | — | npm registry | none |
| zod | ^4.6.1 | 4.6.4 | yes | current | — | npm registry | none |
| Go | go.mod `go 1.26`; CI 1.27.1 | go1.27.1 | yes | current | language 1.26 vs toolchain 1.27 fine | go.dev/VERSION | none required |
| Tauri | =2.11.5 / build =2.6.3 | 2.11.5 (v3 alpha only) | yes | current | — | api.github.com/repos/tauri-apps/tauri | none |
| reqwest | 0.13.4 rustls | 0.13.x | yes | current | — | Cargo metadata | none |
| PostgreSQL | 16.15-alpine | 16.15 latest of 16; 17.11/18.6 exist | yes (EOL 11/2028) | current | plan 18 upgrade later | Docker Hub tags | none now |
| Caddy | 2.11.3-alpine | 2.11.4 | yes | patch behind | — | Docker Hub | BUMPED to 2.11.4 this cycle |
| Odoo | 19.0.x | 19.x stable | yes | current | — | odoo.com/documentation/19.0 (200) | none |
| gorilla/websocket | v1.5.3 | v1.5.3 (repo archived) | maintenance-only | watch | unmaintained upstream | GitHub | plan migration (nhooyr/x/net) |
| vitest / ESLint / TypeScript | 4.1.11 / 9.39 / 5.7 | 5.0.0 / 10.10 / 7.0.2 | yes | behind majors | TS7 native compiler is the realistic jump | npm registry | NOT NOW (no gratuitous majors) |
| grandcat/zeroconf | v1.0.0 | unmaintained (~2020) | no | stale | — | GitHub | replacement plan item |
| Advisory DBs | npm audit / OSV / govulncheck | — | — | NOT VERIFIED (api.osv.dev unreachable; no node_modules) | CI gates exist (`npm audit --moderate`, govulncheck, cargo audit) but were not observed passing | — | CI must evidence |

Policy applied: CURRENT + STABLE + SUPPORTED + JUSTIFIED. Only the Caddy patch was taken.
