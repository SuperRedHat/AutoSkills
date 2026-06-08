#!/usr/bin/env bash
# Snapshot current user's workflow state. See backup-global-workflow.ps1.
# Usage: backup-global-workflow.sh [--dry-run] [--help]

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

USER_HOME="${HOME}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"  # portable (GNU + BSD/macOS); %N is GNU-only
BACKUP_ROOT="$USER_HOME/.workflow-core-backups/$TS"

echo "[backup] target root: $BACKUP_ROOT"
[[ $DRY_RUN -eq 1 ]] && echo "[backup] DRY-RUN mode"

invoke() {
  local desc="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] $desc"
  else
    echo "[action]  $desc"
    "$@"
  fi
}

invoke "mkdir $BACKUP_ROOT" mkdir -p "$BACKUP_ROOT"

snapshot_dir() {
  local src="$1"; local name="$2"
  if [[ -d "$src" ]]; then
    invoke "copy $src -> $BACKUP_ROOT/$name" cp -r "$src" "$BACKUP_ROOT/$name"
  else
    echo "[info]    skip (not found): $src"
  fi
}

snapshot_dir "$USER_HOME/.codex/skills"    "codex-skills"
snapshot_dir "$USER_HOME/.claude/skills"   "claude-skills"
snapshot_dir "$USER_HOME/.gemini/skills"   "gemini-skills"
snapshot_dir "$USER_HOME/.claude/commands" "claude-commands"

GEMINI_SETTINGS="$USER_HOME/.gemini/settings.json"
if [[ -f "$GEMINI_SETTINGS" ]]; then
  invoke "copy $GEMINI_SETTINGS" cp "$GEMINI_SETTINGS" "$BACKUP_ROOT/gemini-settings.json"
fi

# Snapshot MCP registration state
MCP_LOG="$BACKUP_ROOT/mcp-state.log"
if [[ $DRY_RUN -eq 0 ]]; then
  echo "[action]  snapshot MCP state -> $MCP_LOG"
  : > "$MCP_LOG"
  {
    echo "=== codex mcp get project-manager ==="
    (codex mcp get project-manager 2>&1) || echo "codex CLI unavailable"
    echo
    echo "=== claude mcp get project-manager -s user ==="
    (claude mcp get project-manager -s user 2>&1) || echo "claude CLI unavailable"
  } >> "$MCP_LOG"
else
  echo "[dry-run] snapshot MCP state -> $MCP_LOG"
fi

echo "[backup] done: $BACKUP_ROOT"
