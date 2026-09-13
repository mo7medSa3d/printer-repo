# FINAL_MIGRATION_REVIEW.md

## Journal integrity: PASS (33/33 tags ↔ SQL files, verified programmatically)
0000→0032 all present and 1:1 with `drizzle/meta/_journal.json` (idx 0..32).

## New migration 0032_pairing_code_hash_unique (this cycle, additive only)
- Guarded DO block aborts LOUDLY on duplicate pending hashes (operator regenerates codes; nothing deleted — same fail-closed policy as 0029) + partial UNIQUE index `WHERE pairing_code_hash IS NOT NULL`.
- Mirrored in `src/db/schema.ts` (drizzle schema-diff parity) + journal entry idx 32 (`breakpoints: true`, required: file uses a `-->` separator).
- Upgrade-test list extended; cross-cursor semantics: DO block runs in the migrator's transaction like all prior migrations. Apply/rollback NOT executed here (no psql) — CI `db:migrate` + `migration-upgrade.integration` must run.

## 0029 in-place edit (pre-existing worktree state, NOT authored this cycle)
Left intact per "never discard user work" — it is uncommitted/unreleased, so no released database carries the old text yet. Risk recorded: if any environment already applied the HEAD version of 0029, drizzle will NOT re-run the guarded backfill (same tag). Owners must confirm no such environment exists before treating the backfill as universal, or fold the guard into a 0033.

## 0030/0031 (pre-existing untracked)
Included in upgrade-test migration list verification; 0030 deletes manager sessions on upgrade (documented in OPERATIONS.md session-invalidation note, preserved).

## Odoo migrations
`migrations/1.1.0` vs `19.0.1.1.0` dual naming retained (owner decision; out of defect scope — no evidence of mis-ordering beyond naming smell).

## 0028 idempotency repair (this cycle)
0028 was a regenerate-style dump that re-created 5 tables / ~25 columns /
~15 constraints already created by 0005-0027, so every fresh `migrate()`
died (CI evidence: 42P07 `auth_rate_limits`). Repaired WITHOUT changing any
definition: IF NOT EXISTS / IF EXISTS / DO-block guards only, plus the two
convergence statements 0031's composite FKs structurally require
(discovery `tenant_id` columns + backing uniques). A scripted full-chain
collision scan now reports zero bare duplicate-adds (0011/0013/0021/0024/
0025/0027 individually verified as drop-then-add or guarded). 0028 never
completed anywhere via the supported path, so the in-place repair cannot
diverge any applied database.
