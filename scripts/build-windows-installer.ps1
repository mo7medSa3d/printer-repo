#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot production build of the Odoo Print Manager Windows installer.

.DESCRIPTION
  Orchestrates the full pipeline on a Windows build host:

    1. Prerequisite check (Node.js, npm, Go, Rust, tauri-cli)
    2. npm ci                      (pinned dependency install)
    3. npm run typecheck + lint    (gateway + desktop frontend)
    4. npm run desktop:vite:build  (React UI -> dist-desktop/)
    5. Go agent: vet + tests + release build (-trimpath -ldflags "-s -w")
    6. cargo tauri build           (embeds frontend + agent exes -> NSIS/MSI)

  Outputs (default target x86_64-pc-windows-msvc):
    src-tauri\target\<target>\release\bundle\nsis\Odoo Print Manager_<ver>_x64-setup.exe
    src-tauri\target\<target>\release\bundle\msi\Odoo Print Manager_<ver>_x64_en-US.msi

  The bundle is fully standalone: customers need no Node.js, Go, Rust or
  Python. WebView2 is fetched at install time via the bootstrapper (see
  bundle.windows.webviewInstallMode in src-tauri/tauri.conf.json).

.EXAMPLE
  pwsh -File scripts/build-windows-installer.ps1
  pwsh -File scripts/build-windows-installer.ps1 -Bundles nsis -SkipNpmInstall
#>
[CmdletBinding()]
param(
  # Rust target triple for the desktop app.
  [string]$Target = "x86_64-pc-windows-msvc",
  # Comma-separated Tauri bundles ("nsis", "msi", or "nsis,msi").
  [string]$Bundles = "nsis,msi",
  # Skip `npm ci` (use the existing node_modules).
  [switch]$SkipNpmInstall,
  # Skip Go vet + unit tests (CI already ran them).
  [switch]$SkipGoTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot  = Split-Path -Parent $PSScriptRoot
$agentDir  = Join-Path $repoRoot "agent"
$bundleDir = Join-Path $repoRoot "src-tauri\target\$Target\release\bundle"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Assert-Command([string]$Name, [string]$InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Prerequisite missing: '$Name'. $InstallHint"
  }
  Write-Host ("  {0,-8} {1}" -f $Name, (Get-Command $Name).Source)
}

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
Write-Step "Prerequisite check"
Assert-Command node   "Install Node.js >= 22 LTS (see .nvmrc)."
Assert-Command npm    "Install Node.js >= 22 LTS (see .nvmrc)."
Assert-Command go     "Install Go >= 1.21 from https://go.dev/dl/."
Assert-Command rustc  "Install Rust stable: https://rustup.rs/."
Assert-Command cargo  "Install Rust stable: https://rustup.rs/."
& cargo tauri --version *> $null
if ($LASTEXITCODE -ne 0) {
  throw "tauri-cli missing. Install once with: cargo install tauri-cli --version `"^2`" --locked"
}
Write-Host "  tauri-cli present"

# ── 2-4. Node pipeline ───────────────────────────────────────────────────────
if (-not $SkipNpmInstall) {
  Write-Step "npm ci (pinned dependency install)"
  npm --prefix $repoRoot ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
}

Write-Step "TypeScript typecheck"
npm --prefix $repoRoot run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed with exit code $LASTEXITCODE" }

Write-Step "ESLint"
npm --prefix $repoRoot run lint
if ($LASTEXITCODE -ne 0) { throw "lint failed with exit code $LASTEXITCODE" }

Write-Step "Desktop frontend build (Vite -> dist-desktop)"
npm --prefix $repoRoot run desktop:vite:build
if ($LASTEXITCODE -ne 0) { throw "vite build failed with exit code $LASTEXITCODE" }

# ── 5. Go agent (release flags) ──────────────────────────────────────────────
Push-Location $agentDir
try {
  if (-not $SkipGoTests) {
    Write-Step "Go vet"
    go vet .\...
    if ($LASTEXITCODE -ne 0) { throw "go vet failed with exit code $LASTEXITCODE" }

    Write-Step "Go tests"
    go test .\... -race -count=1
    if ($LASTEXITCODE -ne 0) { throw "go tests failed with exit code $LASTEXITCODE" }
  }

  Write-Step "Building OdooPrintAgent.exe (release)"
  go build -trimpath -ldflags "-s -w" -o OdooPrintAgent.exe .\cmd\agent
  if ($LASTEXITCODE -ne 0) { throw "agent build failed with exit code $LASTEXITCODE" }

  Write-Step "Building odoo-agent-cli.exe (release)"
  go build -trimpath -ldflags "-s -w" -o odoo-agent-cli.exe .\cmd\cli
  if ($LASTEXITCODE -ne 0) { throw "cli build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# Tauri bundles these EXEs as resources — a missing file fails the bundler
# late; fail early with a clear message instead.
foreach ($exe in @("OdooPrintAgent.exe", "odoo-agent-cli.exe")) {
  $exePath = Join-Path $agentDir $exe
  if (-not (Test-Path $exePath)) { throw "Missing build output: $exePath" }
  $size = (Get-Item $exePath).Length
  if ($size -le 0) { throw "Empty build output: $exePath" }
  Write-Host "  $exe -> $([math]::Round($size / 1MB, 1)) MB"
}

# ── 6. Tauri bundle ──────────────────────────────────────────────────────────
Write-Step "cargo tauri build (--target $Target --bundles $Bundles)"
Push-Location $repoRoot
try {
  cargo tauri build --target $Target --bundles $Bundles
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# ── 7. Artifact verification + summary ───────────────────────────────────────
Write-Step "Verifying installer artifacts"
$artifacts = @()
if ($Bundles -match "nsis") {
  $artifacts += Get-ChildItem (Join-Path $bundleDir "nsis\*.exe") -ErrorAction SilentlyContinue
  if (-not $artifacts) { throw "NSIS installer missing under $bundleDir\nsis" }
}
if ($Bundles -match "msi") {
  $msi = Get-ChildItem (Join-Path $bundleDir "msi\*.msi") -ErrorAction SilentlyContinue
  if (-not $msi) { throw "MSI installer missing under $bundleDir\msi" }
  $artifacts += $msi
}

Write-Host ""
Write-Host "Build succeeded. Installer artifacts:" -ForegroundColor Green
foreach ($a in $artifacts) {
  Write-Host ("  {0}  ({1:N1} MB)" -f $a.FullName, ($a.Length / 1MB))
}

Write-Host @"

Next steps for a production release:
  1. Smoke-test on a CLEAN Windows VM (no Node/Go/Rust — WebView2 must come
     from the installer bootstrapper):
       .\\scripts\\smoke-test-windows.ps1
  2. Test upgrade + uninstall paths: install previous version, upgrade,
     run the app, then uninstall and confirm Add/Remove Programs is clean.
"@ -ForegroundColor DarkGray
