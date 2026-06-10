<#
.SYNOPSIS
  Sync AutoSkills project-* skills to Codex / Claude / Gemini user directories.

.DESCRIPTION
  Copies skills/project-* from the AutoSkills repo to the three CLI skill
  target roots. Removes orphan project-* dirs, cleans brace-malformed dirs,
  and verifies SHA-256 of SKILL.md after sync.

  AUTOSKILLS_HOME is derived from the script location (parent of scripts/).

.PARAMETER DryRun
  Print planned actions without modifying the filesystem.

.PARAMETER Help
  Show this help text.
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

# AUTOSKILLS_HOME = parent of scripts/
$scriptDir = Split-Path -Parent $PSCommandPath
$autoSkillsHome = Split-Path -Parent $scriptDir
$sourceRoot = Join-Path $autoSkillsHome 'skills'

$userHome = $env:USERPROFILE
$targets = @(
  (Join-Path $userHome '.codex\skills'),
  (Join-Path $userHome '.claude\skills'),
  (Join-Path $userHome '.gemini\skills')
)
$claudeCommandRoot = Join-Path $userHome '.claude\commands'

Write-Output "[sync-skills] AUTOSKILLS_HOME = $autoSkillsHome"
Write-Output "[sync-skills] source         = $sourceRoot"
if ($DryRun) { Write-Output "[sync-skills] DRY-RUN mode (no filesystem changes)" }

$skillNames = Get-ChildItem -Path $sourceRoot -Directory -ErrorAction Stop |
  Where-Object { $_.Name -match '^project-[a-z-]+$' } |
  Select-Object -ExpandProperty Name

if ($skillNames.Count -eq 0) {
  throw "No project-* skills found in $sourceRoot. Aborting."
}

Write-Output "[sync-skills] $($skillNames.Count) skills to sync -> $($targets.Count) targets"

function Invoke-Action {
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) {
    Write-Output "[dry-run] $Description"
  } else {
    Write-Output "[action]  $Description"
    & $Action
  }
}

foreach ($targetRoot in $targets) {
  Write-Output "--- target: $targetRoot ---"

  Invoke-Action "mkdir $targetRoot" {
    if (-not (Test-Path $targetRoot)) { New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null }
  }

  # Remove orphan project-* dirs
  if (Test-Path $targetRoot) {
    Get-ChildItem -Path $targetRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^project-' -and ($skillNames -notcontains $_.Name) } |
      ForEach-Object {
        Invoke-Action "remove orphan $($_.FullName)" { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
      }

    # Remove malformed (brace expansion artifacts). PM-706: scoped to names that
    # also contain 'project-' — an unrelated user skill whose name happens to
    # contain { } or , must never be deleted by our cleanup.
    Get-ChildItem -Path $targetRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '[\{\}\,]' -and $_.Name -like '*project-*' } |
      ForEach-Object {
        Invoke-Action "remove malformed $($_.FullName)" { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
      }
  }

  foreach ($skillName in $skillNames) {
    $sourceDir = Join-Path $sourceRoot $skillName
    $targetDir = Join-Path $targetRoot $skillName

    Invoke-Action "sync $skillName -> $targetDir" {
      if (Test-Path $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
      Get-ChildItem -Path $sourceDir -Recurse -File |
        Where-Object { $_.Extension -ne '.bak' -and $_.Name -notlike '*.bak' } |
        ForEach-Object {
          $rel = $_.FullName.Substring($sourceDir.Length).TrimStart('\', '/')
          $dest = Join-Path $targetDir $rel
          $destDir = Split-Path -Parent $dest
          if ($destDir -and -not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
          Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
        }
    }
  }

  # SHA-256 verification (skip in dry-run)
  if (-not $DryRun) {
    foreach ($skillName in $skillNames) {
      $srcFile = Join-Path (Join-Path $sourceRoot $skillName) 'SKILL.md'
      $tgtFile = Join-Path (Join-Path $targetRoot $skillName) 'SKILL.md'
      if ((Test-Path $srcFile) -and (Test-Path $tgtFile)) {
        $srcHash = (Get-FileHash -LiteralPath $srcFile -Algorithm SHA256).Hash
        $tgtHash = (Get-FileHash -LiteralPath $tgtFile -Algorithm SHA256).Hash
        if ($srcHash -ne $tgtHash) {
          throw "SHA256 mismatch for $skillName in $targetRoot"
        }
      }
    }
    Write-Output "[verify]  SHA-256 OK for $targetRoot"
  }
}

# Clean Claude legacy commands/project-*.md wrappers
if (Test-Path $claudeCommandRoot) {
  foreach ($skillName in $skillNames) {
    $wrapper = Join-Path $claudeCommandRoot ($skillName + '.md')
    if (Test-Path $wrapper) {
      Invoke-Action "remove legacy wrapper $wrapper" { Remove-Item -LiteralPath $wrapper -Force }
    }
  }
}

Write-Output "[sync-skills] done."
