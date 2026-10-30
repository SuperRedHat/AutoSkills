<#
.SYNOPSIS
  Build and register the project-manager MCP server, then plan the kit deploy.

.DESCRIPTION
  Steps:
    1. npm install + npm run build (build the project-manager MCP server)
    2. Register the MCP server with codex and claude per mcp-manifest.json
    3. Verify the registration visible to each CLI
    4. Check the deploy prerequisites (local config, portable Node), then run
       node scripts/deploy-kit.mjs (a dry-run: the plan only, nothing written)

  The kit itself (contract, skills, settings, hooks, pushurl) is deployed by
  scripts/deploy-kit.mjs, which backs up, keeps a journal and rolls back.
  Order on a new machine:
    1. scripts/bootstrap.ps1                    build and register
    2. node scripts/deploy-kit.mjs --init-local  local config and canaries
    3. node scripts/deploy-kit.mjs              review the plan, then --apply
  When the local config or the portable Node is missing, step 4 prints the
  remedy and exits 3 without running deploy-kit, so no hook is registered.

  Runs under Windows PowerShell 5.1 and PowerShell 7. AUTOSKILLS_HOME is
  derived from the script location.

  Exit codes: 0 = done (the plan printed); 1 = a step failed (npm, registration,
  manifest) or deploy-kit reported conflicts; 2 = deploy-kit usage or setup
  error; 3 = local config or portable Node missing (remedy printed).

.PARAMETER DryRun
  Print planned actions without building or registering; deploy-kit runs as
  its own dry-run, which only reads.

.PARAMETER Force
  Skip interactive confirmation prompts (currently no-op; reserved).

.PARAMETER MigrateState
  Optional list of existing project roots to migrate to schema v1 after the
  build (idempotent; safe to re-run; never changes task status). Default:
  skipped - migration is lazy (the upgraded server backfills on first write,
  and read paths compute the new fields on the fly).

.PARAMETER LocalConfig
  The local config passed to deploy-kit as --local-config. Default:
  <AUTOSKILLS_HOME>/_private/kit-local.json.

.PARAMETER Help
#>
param(
  [switch]$DryRun = $false,
  [switch]$Force = $false,
  [string[]]$MigrateState = @(),
  [string]$LocalConfig = '',
  [switch]$Help = $false
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help -Name $PSCommandPath -Detailed
  exit 0
}

$scriptDir = Split-Path -Parent $PSCommandPath
$autoSkillsHome = Split-Path -Parent $scriptDir
$manifestPath = Join-Path $autoSkillsHome 'mcp-manifest.json'
$mcpProjectDir = Join-Path $autoSkillsHome 'mcp\project-manager'
$deployKit = Join-Path $scriptDir 'deploy-kit.mjs'
$defaultLocalConfig = Join-Path $autoSkillsHome '_private\kit-local.json'
if ($LocalConfig) {
  # Relative to the PowerShell location, not the process directory.
  $localConfigPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LocalConfig)
} else {
  $localConfigPath = $defaultLocalConfig
}
# The portable Node the kit hooks run on (ADR-006); the system Node keeps running project-manager.
$portableNodeVersion = '24.22.2'
$portableNodeArchive = "node-v$portableNodeVersion-win-x64.zip"
$portableNodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'

Write-Output "=========================================="
Write-Output "  AutoSkills Bootstrap"
Write-Output "=========================================="
Write-Output "AUTOSKILLS_HOME  = $autoSkillsHome"
Write-Output "manifest         = $manifestPath"
Write-Output "mcp source dir   = $mcpProjectDir"
Write-Output "local config     = $localConfigPath"
if ($DryRun) { Write-Output "MODE             = DRY-RUN (no build / no registration; deploy-kit plans only)" }
Write-Output ""

function Invoke-Action {
  param([string]$Desc, [scriptblock]$Action)
  if ($DryRun) { Write-Output "[dry-run] $Desc" } else { Write-Output "[action]  $Desc"; & $Action }
}

# Reads a UTF-8 JSON file (with or without BOM). Get-Content in 5.1 would decode it as ANSI.
function Read-JsonFile {
  param([string]$Path)
  return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

# Newest node-v*/node.exe under the runtime area, or $null (deploy-kit --init-local looks the same way).
function Find-PortableNode {
  param([string]$Runtime)
  if (-not (Test-Path -LiteralPath $Runtime -PathType Container)) { return $null }
  $dirs = Get-ChildItem -LiteralPath $Runtime -Directory | Where-Object { $_.Name -match '^node-v\d+\.\d+\.\d+-' } |
    Sort-Object -Descending { $v = [regex]::Match($_.Name, '^node-v(\d+)\.(\d+)\.(\d+)-').Groups; [version]"$($v[1].Value).$($v[2].Value).$($v[3].Value)" }
  foreach ($d in $dirs) {
    $exe = Join-Path $d.FullName 'node.exe'
    if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  }
  return $null
}

function Get-LocalConfigOption {
  if ($LocalConfig) { return " --local-config `"$localConfigPath`"" }
  return ''
}

function Write-PortableNodeRemedy {
  param([string]$Runtime)
  $base = "https://nodejs.org/dist/v$portableNodeVersion"
  Write-Output "  Install the portable Node $portableNodeVersion into the runtime area (the system Node stays as it is):"
  Write-Output "    1. Download $base/$portableNodeArchive and $base/SHASUMS256.txt"
  Write-Output "    2. Verify: (Get-FileHash .\$portableNodeArchive -Algorithm SHA256).Hash must equal the hash on the"
  Write-Output "       '$portableNodeArchive' line of SHASUMS256.txt ($portableNodeSha256)"
  Write-Output "    3. Expand-Archive .\$portableNodeArchive -DestinationPath `"$Runtime`""
  Write-Output "       (gives $(Join-Path (Join-Path $Runtime "node-v$portableNodeVersion-win-x64") 'node.exe'))"
}

# --- Step 1: build MCP server ---
Write-Output "--- Step 1/4: build project-manager MCP server ---"
if (-not (Test-Path $mcpProjectDir)) {
  throw "MCP project dir not found: $mcpProjectDir"
}
Invoke-Action "npm install in $mcpProjectDir" {
  Push-Location $mcpProjectDir
  try { npm install } finally { Pop-Location }
  # PM-706: native commands do not trip $ErrorActionPreference='Stop' in PS 5.1 -
  # without this check a failed install continued and a stale dist got registered.
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
}
Invoke-Action "npm run build in $mcpProjectDir" {
  Push-Location $mcpProjectDir
  try { npm run build } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE) - refusing to register a stale dist" }
  $distIndex = Join-Path $mcpProjectDir 'dist\index.js'
  if (-not (Test-Path $distIndex)) { throw "Build did not produce $distIndex" }
}

# --- Step 1.5 (optional): migrate existing project state to schema v1 ---
Write-Output ""
if ($MigrateState.Count -gt 0) {
  Write-Output "--- Step 1.5 (optional): migrate $($MigrateState.Count) project(s) to schema v1 ---"
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
  Write-Output "--- Step 1.5 (optional): state migration skipped (lazy first-touch). Pass -MigrateState dir1,dir2 to batch-migrate. ---"
}

# --- Step 2: register MCP with codex and claude ---
Write-Output ""
Write-Output "--- Step 2/4: register MCP server with codex and claude per mcp-manifest.json ---"
if (-not (Test-Path $manifestPath)) {
  throw "Manifest not found: $manifestPath"
}
$manifest = Read-JsonFile $manifestPath
if ($manifest.version -ne 1) { throw "Unsupported manifest version: $($manifest.version)" }

$pm = $manifest.servers.'project-manager'
$command = $pm.command
$argsTemplate = $pm.args_template

# Expand ${AUTOSKILLS_HOME} placeholder
$expandedArgs = @()
foreach ($a in $argsTemplate) {
  $expandedArgs += ($a -replace '\$\{AUTOSKILLS_HOME\}', $autoSkillsHome)
}
Write-Output "resolved command: $command $($expandedArgs -join ' ')"

# codex - PM-706: skip gracefully when the CLI is absent (bash pair behavior);
# a missing optional CLI must not abort the install halfway.
$hasCodex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
if ($hasCodex) {
  Invoke-Action "codex mcp add project-manager" {
    try { codex mcp remove project-manager 2>&1 | Out-Null } catch {}
    $argList = @('mcp', 'add', 'project-manager', '--', $command) + $expandedArgs
    & codex @argList
    if ($LASTEXITCODE -ne 0) { throw "codex mcp add failed (exit $LASTEXITCODE)" }
  }
} else {
  Write-Output "[info]    codex CLI not found, skipping codex registration"
}

# claude (user scope)
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
if ($hasClaude) {
  Invoke-Action "claude mcp add project-manager (user scope)" {
    try { claude mcp remove project-manager -s user 2>&1 | Out-Null } catch {}
    $argList = @('mcp', 'add', 'project-manager', '-s', 'user', '--', $command) + $expandedArgs
    & claude @argList
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed (exit $LASTEXITCODE)" }
  }
} else {
  Write-Output "[info]    claude CLI not found, skipping claude registration"
}

# --- Step 3: verify ---
Write-Output ""
Write-Output "--- Step 3/4: verify MCP visible to codex and claude ---"
if ($DryRun) {
  if ($hasCodex) { Write-Output "[dry-run] codex mcp get project-manager" }
  if ($hasClaude) { Write-Output "[dry-run] claude mcp get project-manager -s user" }
} else {
  if ($hasCodex) {
    Write-Output "[verify]  codex mcp get project-manager:"
    codex mcp get project-manager 2>&1 | ForEach-Object { "    $_" }
  }
  if ($hasClaude) {
    Write-Output "[verify]  claude mcp get project-manager -s user:"
    claude mcp get project-manager -s user 2>&1 | ForEach-Object { "    $_" }
  }
}

# --- Step 4: deploy prerequisites, then the deploy-kit plan ---
Write-Output ""
Write-Output "--- Step 4/4: check the deploy prerequisites, then plan the kit deploy ---"
$runtime = Join-Path $autoSkillsHome '_private\rt'
$missing = @()
if (-not (Test-Path -LiteralPath $localConfigPath -PathType Leaf)) {
  Write-Output "[missing] local config not found: $localConfigPath"
  $missing += 'config'
  if (-not (Find-PortableNode $runtime)) {
    Write-Output "[missing] portable Node: no node-v*\node.exe under the default runtime area $runtime"
    $missing += 'node'
  }
} else {
  try { $local = Read-JsonFile $localConfigPath } catch { $local = $null }
  if (-not ($local -is [System.Management.Automation.PSCustomObject])) {
    Write-Output "[missing] local config is not a valid JSON object: $localConfigPath"
    $missing += 'badconfig'
  } else {
    if ($local.runtime) { $runtime = $local.runtime }
    if (-not $local.portable_node) {
      Write-Output "[missing] portable Node: portable_node is not set in $localConfigPath"
      $missing += 'node'
    } elseif (-not (Test-Path -LiteralPath $local.portable_node -PathType Leaf)) {
      Write-Output "[missing] portable Node: $($local.portable_node) does not exist"
      $missing += 'node'
    } else {
      Write-Output "[ok]      local config $localConfigPath; portable Node $($local.portable_node)"
    }
  }
}
if ($missing.Count -gt 0) {
  # deploy-kit writes the hooks that run on the portable Node; stop here so no hook is registered.
  Write-Output ""
  Write-Output "Remedy (then re-run this script):"
  if ($missing -contains 'node') { Write-PortableNodeRemedy $runtime }
  $initArgs = if ($missing -contains 'node') { " --runtime `"$runtime`"" } else { '' }
  if ($missing -contains 'badconfig') { Write-Output "  Fix the JSON in $localConfigPath, or move the file aside so a new one is written:" }
  Write-Output "  Write the local config (only it and the two canary folders under _private/; it finds the portable Node):"
  Write-Output "    node scripts/deploy-kit.mjs --init-local$initArgs$(Get-LocalConfigOption)"
  Write-Output "  Then add real customer-data folders to customer_data_dirs in that file by hand."
  Write-Output ""
  Write-Output "Bootstrap stopped: deploy prerequisites missing; deploy-kit was not run."
  exit 3
}

$deployArgs = @($deployKit, '--dry-run')
if ($LocalConfig) { $deployArgs += @('--local-config', $localConfigPath) }
Write-Output "[run]     node scripts/deploy-kit.mjs --dry-run$(Get-LocalConfigOption)"
& node @deployArgs
$deployExit = $LASTEXITCODE
if ($deployExit -ne 0) {
  Write-Output ""
  Write-Output "Bootstrap stopped: deploy-kit exited $deployExit (see above)."
  exit $deployExit
}

Write-Output ""
Write-Output "=========================================="
Write-Output "  Bootstrap complete."
Write-Output "=========================================="
Write-Output "Next: close every Claude Code and Codex session, review the plan above, then deploy with"
Write-Output "  node scripts/deploy-kit.mjs --apply$(Get-LocalConfigOption)"
