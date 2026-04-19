<#
.SYNOPSIS
  Snapshot the current user's workflow state before bootstrap / reinstall.

.DESCRIPTION
  Writes a timestamped backup to ~/.workflow-core-backups/<ISO8601>/ covering:
    - ~/.codex/skills/project-*
    - ~/.claude/skills/project-*
    - ~/.gemini/skills/project-*
    - ~/.claude/commands/project-*.md
    - ~/.gemini/settings.json (mcpServers section)
    - Output of `codex mcp get project-manager`
    - Output of `claude mcp get project-manager -s user`

.PARAMETER DryRun
.PARAMETER Help
#>
param(
  [switch]$DryRun = $false,
  [switch]$Help = $false
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help -Name $PSCommandPath -Detailed
  exit 0
}

$userHome = $env:USERPROFILE
$timestamp = Get-Date -Format "yyyyMMddTHHmmssfffZ"
$backupRoot = Join-Path $userHome ".workflow-core-backups\$timestamp"

Write-Output "[backup] target root: $backupRoot"
if ($DryRun) { Write-Output "[backup] DRY-RUN mode" }

function Invoke-Action {
  param([string]$Desc, [scriptblock]$Action)
  if ($DryRun) { Write-Output "[dry-run] $Desc" } else { Write-Output "[action]  $Desc"; & $Action }
}

Invoke-Action "mkdir $backupRoot" { New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null }

$pathsToSnapshot = @(
  @{ src = (Join-Path $userHome '.codex\skills');    dst = 'codex-skills' },
  @{ src = (Join-Path $userHome '.claude\skills');   dst = 'claude-skills' },
  @{ src = (Join-Path $userHome '.gemini\skills');   dst = 'gemini-skills' },
  @{ src = (Join-Path $userHome '.claude\commands'); dst = 'claude-commands' }
)

foreach ($p in $pathsToSnapshot) {
  if (Test-Path $p.src) {
    $dst = Join-Path $backupRoot $p.dst
    Invoke-Action "copy $($p.src) -> $dst" {
      Copy-Item -Path $p.src -Destination $dst -Recurse -Force
    }
  } else {
    Write-Output "[info]    skip (not found): $($p.src)"
  }
}

$geminiSettings = Join-Path $userHome '.gemini\settings.json'
if (Test-Path $geminiSettings) {
  $dst = Join-Path $backupRoot 'gemini-settings.json'
  Invoke-Action "copy $geminiSettings" { Copy-Item -Path $geminiSettings -Destination $dst -Force }
}

# Snapshot MCP registration state
$mcpLog = Join-Path $backupRoot 'mcp-state.log'
Invoke-Action "snapshot codex/claude MCP state -> $mcpLog" {
  '' | Out-File -FilePath $mcpLog -Encoding UTF8
  "=== codex mcp get project-manager ===" | Out-File -FilePath $mcpLog -Append -Encoding UTF8
  try { codex mcp get project-manager 2>&1 | Out-File -FilePath $mcpLog -Append -Encoding UTF8 } catch { "codex CLI unavailable" | Out-File -FilePath $mcpLog -Append -Encoding UTF8 }
  "" | Out-File -FilePath $mcpLog -Append -Encoding UTF8
  "=== claude mcp get project-manager -s user ===" | Out-File -FilePath $mcpLog -Append -Encoding UTF8
  try { claude mcp get project-manager -s user 2>&1 | Out-File -FilePath $mcpLog -Append -Encoding UTF8 } catch { "claude CLI unavailable" | Out-File -FilePath $mcpLog -Append -Encoding UTF8 }
}

Write-Output "[backup] done: $backupRoot"
