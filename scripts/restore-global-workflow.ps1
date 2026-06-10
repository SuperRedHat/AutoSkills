<#
.SYNOPSIS
  Restore a workflow snapshot created by backup-global-workflow.ps1.

.DESCRIPTION
  Reverses a timestamped backup: re-copies skills / commands / gemini
  settings back to the user home. Does NOT replay codex/claude mcp add —
  re-run bootstrap.ps1 afterwards to re-register MCP servers.

.PARAMETER SnapshotPath
  Absolute path to a snapshot dir under ~/.workflow-core-backups/.

.PARAMETER DryRun
.PARAMETER Help
#>
param(
  [Parameter(Mandatory = $false)]
  [string]$SnapshotPath = "",
  [switch]$DryRun = $false,
  [switch]$Help = $false
)

$ErrorActionPreference = 'Stop'

if ($Help -or -not $SnapshotPath) {
  if (-not $SnapshotPath) { Write-Output "Usage: restore-global-workflow.ps1 -SnapshotPath <path> [-DryRun]" }
  Get-Help -Name $PSCommandPath -Detailed
  exit 0
}

if (-not (Test-Path $SnapshotPath)) {
  throw "Snapshot not found: $SnapshotPath"
}

$userHome = $env:USERPROFILE
Write-Output "[restore] snapshot = $SnapshotPath"
if ($DryRun) { Write-Output "[restore] DRY-RUN mode" }

# PM-706: restore REPLACES the target dirs wholesale (everything added after the
# snapshot is removed). Snapshot the CURRENT state first so a mistaken restore
# is itself reversible.
Write-Output "[restore] pre-restore safety snapshot of current state:"
$preBackupScript = Join-Path (Split-Path -Parent $PSCommandPath) 'backup-global-workflow.ps1'
if ($DryRun) { & $preBackupScript -DryRun } else { & $preBackupScript }

function Invoke-Action {
  param([string]$Desc, [scriptblock]$Action)
  if ($DryRun) { Write-Output "[dry-run] $Desc" } else { Write-Output "[action]  $Desc"; & $Action }
}

$mappings = @(
  @{ src = 'codex-skills';    dst = (Join-Path $userHome '.codex\skills') },
  @{ src = 'claude-skills';   dst = (Join-Path $userHome '.claude\skills') },
  @{ src = 'gemini-skills';   dst = (Join-Path $userHome '.gemini\skills') },
  @{ src = 'claude-commands'; dst = (Join-Path $userHome '.claude\commands') }
)

foreach ($m in $mappings) {
  $src = Join-Path $SnapshotPath $m.src
  if (Test-Path $src) {
    Invoke-Action "restore $($m.dst)" {
      if (Test-Path $m.dst) { Remove-Item -LiteralPath $m.dst -Recurse -Force }
      Copy-Item -Path $src -Destination $m.dst -Recurse -Force
    }
  } else {
    Write-Output "[info]    skip (not in snapshot): $($m.src)"
  }
}

$geminiSettings = Join-Path $SnapshotPath 'gemini-settings.json'
if (Test-Path $geminiSettings) {
  $dst = Join-Path $userHome '.gemini\settings.json'
  Invoke-Action "restore $dst" { Copy-Item -Path $geminiSettings -Destination $dst -Force }
}

Write-Output "[restore] done. Re-run bootstrap.ps1 to re-register MCP server if needed."
