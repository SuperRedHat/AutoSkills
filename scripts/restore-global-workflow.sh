#!/usr/bin/env bash
# Restore a workflow snapshot. See restore-global-workflow.ps1.
# Usage: restore-global-workflow.sh --snapshot <path> [--dry-run] [--help]

set -euo pipefail

DRY_RUN=0
SNAPSHOT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --snapshot) SNAPSHOT_PATH="$2"; shift 2 ;;
    --help|-h) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SNAPSHOT_PATH" ]]; then
  echo "Usage: $0 --snapshot <path> [--dry-run]" >&2
  exit 2
fi

if [[ ! -d "$SNAPSHOT_PATH" ]]; then
  echo "Snapshot not found: $SNAPSHOT_PATH" >&2
  exit 1
fi

USER_HOME="${HOME}"
echo "[restore] snapshot = $SNAPSHOT_PATH"
[[ $DRY_RUN -eq 1 ]] && echo "[restore] DRY-RUN mode"

# PM-706: restore REPLACES the target dirs wholesale (everything added after the
# snapshot is removed). Snapshot the CURRENT state first so a mistaken restore
# is itself reversible.
echo "[restore] pre-restore safety snapshot of current state:"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $DRY_RUN -eq 1 ]]; then
  bash "$SCRIPT_DIR/backup-global-workflow.sh" --dry-run
else
  bash "$SCRIPT_DIR/backup-global-workflow.sh"
fi

invoke() {
  local desc="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] $desc"
  else
    echo "[action]  $desc"
    "$@"
  fi
}

restore_dir() {
  local snap_name="$1"; local dst="$2"
  local src="$SNAPSHOT_PATH/$snap_name"
  if [[ -d "$src" ]]; then
    # Pass paths as argv (not interpolated into a bash -c string) — a path with a
    # quote/space cannot break the command or inject.
    invoke "restore $dst" bash -c 'rm -rf -- "$1" && cp -r -- "$2" "$1"' _ "$dst" "$src"
  else
    echo "[info]    skip (not in snapshot): $snap_name"
  fi
}

restore_dir "codex-skills"    "$USER_HOME/.codex/skills"
restore_dir "claude-skills"   "$USER_HOME/.claude/skills"
restore_dir "gemini-skills"   "$USER_HOME/.gemini/skills"
restore_dir "claude-commands" "$USER_HOME/.claude/commands"

GEMINI_SRC="$SNAPSHOT_PATH/gemini-settings.json"
GEMINI_DST="$USER_HOME/.gemini/settings.json"
if [[ -f "$GEMINI_SRC" ]]; then
  invoke "restore $GEMINI_DST" cp "$GEMINI_SRC" "$GEMINI_DST"
fi

echo "[restore] done. Re-run bootstrap.sh to re-register MCP server if needed."
