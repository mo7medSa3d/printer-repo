# Pending CI workflows

These two workflow files are **ready to use but not yet installed** at
`.github/workflows/`.

## Why they live here

The automation account that opened the pull request does not hold GitHub's
`workflows` permission. Installing them was attempted and is **blocked at the
platform level**, by two independent routes:

```
$ git push origin <branch>
 ! [remote rejected] refusing to allow a GitHub App to create or update
   workflow `.github/workflows/gateway-ci.yml` without `workflows` permission

$ gh api -X PUT .../contents/.github/workflows/gateway-ci.yml
 HTTP 403  Resource not accessible by integration
```

This is a credential scope, not a repository setting — no change inside the
repo can work around it. The files are therefore committed here unchanged and
verified (both parse as valid GitHub Actions YAML: `gateway-ci.yml` defines the
`gateway` and `agent` jobs, `odoo-ci.yml` defines `odoo-tests`).

## Installing them

A maintainer with write access needs one command:

```bash
git mv ci/workflows/gateway-ci.yml  .github/workflows/gateway-ci.yml
git mv ci/workflows/odoo-ci.yml     .github/workflows/odoo-ci.yml
rmdir ci/workflows 2>/dev/null; rm -f ci/workflows/README.md
git commit -m "ci: install gateway and Odoo workflows"
```

No edits are required — the files are complete and reference paths relative to
the repository root.

## What they do

| File | Purpose |
|---|---|
| `gateway-ci.yml` | Runs the gateway test suite against a **real PostgreSQL 16 service**, plus typecheck, lint and a production build. Asserts that **no test skipped**, so the database-backed suites cannot silently turn the job into a green no-op. A second job builds and vets the Go agent, runs `go test` and `go test -race`, and cross-compiles for Windows. |
| `odoo-ci.yml` | Installs Odoo 17 and the `print_gateway` addon into a real PostgreSQL and runs the addon's tests (`--test-enable --test-tags /print_gateway`). Fails if `Module print_gateway` never appears in the log, so an install that ran nothing cannot report success. |

`.github/workflows/build-windows.yml` (Go/Tauri/MSI/NSIS packaging) is
untouched and continues to run.

## Until they are installed

These gates are **not running on pull requests yet**. The equivalent checks were
executed locally for this change set; see the PR description for exactly what
passed and what could not be executed in that environment.
