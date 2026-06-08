<#
.SYNOPSIS
  One-click install of AutoSkills on a new machine.

.DESCRIPTION
  Orchestrates:
    1. backup-global-workflow.ps1  (snapshot current state)
    2. sync-skills.ps1             (deploy project-* to 3 CLIs)
    3. npm install + npm run build (build project-manager MCP server)
    4. Register MCP with codex / claude / gemini per mcp-manifest.json
    5. Verify registration visible to each CLI

  AUTOSKILLS_HOME is derived from the script location.

.PARAMETER DryRun
  Print planned actions without touching the filesystem or registering MCP.

.PARAMETER Force
  Skip interactive confirmation prompts (currently no-op; reserved).

.PARAMETER MigrateState
  Optional list of existing project roots to migrate to schema v1 after the
  build (idempotent; safe to re-run; never changes task status). Default:
  skipped — migration is lazy (the upgraded server backfills on first write,
  and read paths compute the new fields on the fly).

.PARAMETER Help
#>
param(
  [switch]$DryRun = $false,
  [switch]$Force = $false,
  [string[]]$MigrateState = @(),
  [switch]$Help = $false
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help -Name $PSCommandPath -Detailed
  exit 0
}

$scriptDir = Split-Path -Parent $PSCommandPath
$autoSkillsHome = Split-Path -Parent $scriptDir
$userHome = $env:USERPROFILE
$manifestPath = Join-Path $autoSkillsHome 'mcp-manifest.json'
$mcpProjectDir = Join-Path $autoSkillsHome 'mcp\project-manager'

Write-Output "=========================================="
Write-Output "  AutoSkills Bootstrap"
Write-Output "=========================================="
Write-Output "AUTOSKILLS_HOME  = $autoSkillsHome"
Write-Output "USER_HOME        = $userHome"
Write-Output "manifest         = $manifestPath"
Write-Output "mcp source dir   = $mcpProjectDir"
if ($DryRun) { Write-Output "MODE             = DRY-RUN (no writes / no CLI calls)" }
Write-Output ""

function Invoke-Action {
  param([string]$Desc, [scriptblock]$Action)
  if ($DryRun) { Write-Output "[dry-run] $Desc" } else { Write-Output "[action]  $Desc"; & $Action }
}

# --- Step 1: backup ---
Write-Output "--- Step 1/5: backup current state ---"
$backupScript = Join-Path $scriptDir 'backup-global-workflow.ps1'
if ($DryRun) {
  & $backupScript -DryRun
} else {
  & $backupScript
}

# --- Step 2: sync skills ---
Write-Output ""
Write-Output "--- Step 2/5: sync skills to 3 CLIs ---"
$syncScript = Join-Path $scriptDir 'sync-skills.ps1'
if ($DryRun) {
  & $syncScript -DryRun
} else {
  & $syncScript
}

# --- Step 3: build MCP server ---
Write-Output ""
Write-Output "--- Step 3/5: build project-manager MCP server ---"
if (-not (Test-Path $mcpProjectDir)) {
  throw "MCP project dir not found: $mcpProjectDir"
}
Invoke-Action "npm install in $mcpProjectDir" {
  Push-Location $mcpProjectDir
  try { npm install } finally { Pop-Location }
}
Invoke-Action "npm run build in $mcpProjectDir" {
  Push-Location $mcpProjectDir
  try { npm run build } finally { Pop-Location }
  $distIndex = Join-Path $mcpProjectDir 'dist\index.js'
  if (-not (Test-Path $distIndex)) { throw "Build did not produce $distIndex" }
}

# --- Step 3.5 (optional): migrate existing project state to schema v1 ---
Write-Output ""
if ($MigrateState.Count -gt 0) {
  Write-Output "--- Step 3.5 (optional): migrate $($MigrateState.Count) project(s) to schema v1 ---"
  $statePath = Join-Path $mcpProjectDir 'dist\state.js'
  Invoke-Action "migrate_tasks_schema on provided project roots (idempotent)" {
    if (-not (Test-Path $statePath)) { throw "Built state module not found: $statePath" }
    # Pass paths via env vars (NOT interpolated into the JS source) so a path with
    # a quote/backslash/space can neither break the JS string nor inject code.
    $env:PM_STATE_JS = ($statePath -replace '\\', '/')
    $js = "const{StateManager}=require(process.env.PM_STATE_JS);const r=new StateManager(process.env.PM_PROJ_DIR).migrateTaskSchema();console.log('    '+process.env.PM_PROJ_DIR+' -> '+JSON.stringify(r));"
    foreach ($proj in $MigrateState) {
      $env:PM_PROJ_DIR = $proj
      node -e $js
    }
    Remove-Item Env:\PM_STATE_JS, Env:\PM_PROJ_DIR -ErrorAction SilentlyContinue
  }
} else {
  Write-Output "--- Step 3.5 (optional): state migration skipped (lazy first-touch). Pass -MigrateState dir1,dir2 to batch-migrate. ---"
}

# --- Step 4: register MCP with 3 CLIs ---
Write-Output ""
Write-Output "--- Step 4/5: register MCP server with 3 CLIs per mcp-manifest.json ---"
if (-not (Test-Path $manifestPath)) {
  throw "Manifest not found: $manifestPath"
}
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
if ($manifest.version -ne 1) { throw "Unsupported manifest version: $($manifest.version)" }

$pm = $manifest.servers.'project-manager'
$command = $pm.command
$argsTemplate = $pm.args_template
$trust = $pm.trust

# Expand ${AUTOSKILLS_HOME} placeholder
$expandedArgs = @()
foreach ($a in $argsTemplate) {
  $expandedArgs += ($a -replace '\$\{AUTOSKILLS_HOME\}', $autoSkillsHome)
}
Write-Output "resolved command: $command $($expandedArgs -join ' ')"

# codex
Invoke-Action "codex mcp add project-manager" {
  try { codex mcp remove project-manager 2>&1 | Out-Null } catch {}
  $argList = @('mcp', 'add', 'project-manager', '--', $command) + $expandedArgs
  & codex @argList
}

# claude (user scope)
Invoke-Action "claude mcp add project-manager (user scope)" {
  try { claude mcp remove project-manager -s user 2>&1 | Out-Null } catch {}
  $argList = @('mcp', 'add', 'project-manager', '-s', 'user', '--', $command) + $expandedArgs
  & claude @argList
}

# gemini (settings.json edit)
Invoke-Action "gemini mcp register (settings.json merge, trust=$($trust.gemini))" {
  $geminiSettingsPath = Join-Path $userHome '.gemini\settings.json'
  $settings = if (Test-Path $geminiSettingsPath) { Get-Content -Raw -Path $geminiSettingsPath | ConvertFrom-Json } else { [PSCustomObject]@{} }
  if (-not $settings.mcpServers) { $settings | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) -Force }
  $settings.mcpServers | Add-Member -NotePropertyName 'project-manager' -NotePropertyValue ([PSCustomObject]@{
    command = $command
    args = $expandedArgs
    trust = [bool]$trust.gemini
  }) -Force
  $settings | ConvertTo-Json -Depth 8 | Out-File -FilePath $geminiSettingsPath -Encoding UTF8
}

# --- Step 5: verify ---
Write-Output ""
Write-Output "--- Step 5/5: verify MCP visible to all 3 CLIs ---"
if ($DryRun) {
  Write-Output "[dry-run] codex mcp get project-manager"
  Write-Output "[dry-run] claude mcp get project-manager -s user"
  Write-Output "[dry-run] read ~/.gemini/settings.json"
} else {
  Write-Output "[verify]  codex mcp get project-manager:"
  codex mcp get project-manager 2>&1 | ForEach-Object { "    $_" }
  Write-Output "[verify]  claude mcp get project-manager -s user:"
  claude mcp get project-manager -s user 2>&1 | ForEach-Object { "    $_" }
  Write-Output "[verify]  gemini settings.json mcpServers.project-manager:"
  $geminiSettingsPath = Join-Path $userHome '.gemini\settings.json'
  if (Test-Path $geminiSettingsPath) {
    $g = Get-Content -Raw -Path $geminiSettingsPath | ConvertFrom-Json
    if ($g.mcpServers.'project-manager') {
      "    command = $($g.mcpServers.'project-manager'.command)"
      "    args    = $($g.mcpServers.'project-manager'.args -join ' ')"
      "    trust   = $($g.mcpServers.'project-manager'.trust)"
    } else {
      Write-Warning "project-manager not present in gemini settings.json"
    }
  }
}

Write-Output ""
Write-Output "=========================================="
Write-Output "  Bootstrap complete."
Write-Output "=========================================="
