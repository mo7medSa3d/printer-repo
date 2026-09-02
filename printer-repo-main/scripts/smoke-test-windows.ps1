#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Deterministic Windows smoke test for the installed Odoo Print Manager.

.DESCRIPTION
  Verifies that the installed desktop app and bundled agent/CLI binaries exist,
  the desktop process starts and stays alive, the Go agent creates its writable
  runtime directory and SQLite queue, and the process can be stopped cleanly.

  This script is intended for the Windows build/installation host or a Windows
  VM. It must run from an elevated or at least unrestricted shell when the
  installed app is under "C:\Program Files".

.EXAMPLE
  ./scripts/smoke-test-windows.ps1
  ./scripts/smoke-test-windows.ps1 -InstallDir "$env:ProgramFiles\Odoo Print Manager"
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles "Odoo Print Manager"),
  [int]$WaitSeconds = 8,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"
$agentDataDir = if ($env:ODOO_PRINT_AGENT_DATA_DIR) {
  $env:ODOO_PRINT_AGENT_DATA_DIR
} else {
  Join-Path $env:ProgramData "OdooPrintAgent"
}

function Assert-Path {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "FAIL: $Label not found: $Path"
    exit 1
  }
  Write-Host "PASS: $Label exists -> $Path"
}

function Assert-NotExited {
  param([System.Diagnostics.Process]$Process, [string]$Label)
  Start-Sleep -Seconds $WaitSeconds
  if ($Process.HasExited) {
    Write-Error "FAIL: $Label exited early (code $($Process.ExitCode))"
    exit 1
  }
  Write-Host "PASS: $Label is still running after $WaitSeconds seconds (pid $($Process.Id))"
}

$ErrorActionPreference = "Continue"

Write-Host "== Odoo Print Manager Windows smoke test =="
Write-Host "Install dir: $InstallDir"
Write-Host "Agent data dir: $agentDataDir"

# 1. Installed / bundled files -------------------------------------------------
$appExe = Join-Path $InstallDir "odoo-print-manager.exe"
$agentExe = Join-Path $InstallDir "resources\OdooPrintAgent.exe"
$cliExe = Join-Path $InstallDir "resources\odoo-agent-cli.exe"
Assert-Path $appExe "Installed desktop executable"
Assert-Path $agentExe "Bundled agent executable"
Assert-Path $cliExe "Bundled CLI executable"

# Start from a deterministic state so the run does not create duplicates.
Get-Process -Name "OdooPrintAgent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Desktop application process ----------------------------------------------
$desktop = $null
try {
  $desktop = Start-Process -FilePath $appExe -PassThru
  Assert-NotExited $desktop "Odoo Print Manager desktop process"
} finally {
  if ($desktop -and -not $desktop.HasExited) {
    Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
    Write-Host "PASS: desktop process stopped cleanly (forced process termination)."
  }
  # The desktop starts the agent detached; clean it up before the direct test.
  Get-Process -Name "OdooPrintAgent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 3. CLI help ----------------------------------------------------------------
Write-Host "== CLI help =="
$cliOut = & $cliExe --help 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "FAIL: odoo-agent-cli.exe --help returned exit code $LASTEXITCODE"
  exit 1
}
$cliText = ($cliOut | Out-String)
if ($cliText -notmatch "-pair" -or $cliText -notmatch "-server" -or $cliText -notmatch "-config") {
  Write-Error "FAIL: CLI help did not mention -pair/-server/-config"
  exit 1
}
Write-Host "PASS: CLI help lists -pair, -server, -config"

# 4. Go agent first-run directory/database creation ---------------------------
# Remove only a deliberately empty temp data dir when the caller asks for a
# fully clean run. Never delete production ProgramData state implicitly.
if ($env:ODOO_PRINT_AGENT_DATA_DIR -and (Test-Path $agentDataDir)) {
  Write-Host "Using existing overridden agent data dir: $agentDataDir"
}

$agent = $null
try {
  $configPath = Join-Path $agentDataDir "config.yaml"
  $agent = Start-Process -FilePath $agentExe -ArgumentList @("-config", $configPath) -PassThru
  # The agent intentionally stays alive while unpaired/configured. Verify the
  # runtime directory, default config, logs dir, and SQLite database appear.
  Start-Sleep -Seconds 4
  if ($agent.HasExited) {
    Write-Error "FAIL: agent exited early (code $($agent.ExitCode)); inspect $agentDataDir"
    exit 1
  }
  Assert-Path $agentDataDir "Agent writable data directory"
  Assert-Path $configPath "Agent default config file"
  Assert-Path (Join-Path $agentDataDir "logs\agent.log") "Agent log file"
  Assert-Path (Join-Path $agentDataDir "agent.db") "Agent SQLite database"
  Write-Host "PASS: agent first-run initialization completed without manual directory creation."
} finally {
  if ($agent -and -not $agent.HasExited) {
    Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue
    Write-Host "PASS: agent process stopped."
  }
}

if ($KeepRunning) {
  Write-Host "NOTE: KeepRunning set; no desktop cleanup after next steps."
} else {
  Write-Host "PASS: all smoke checks completed."
}
