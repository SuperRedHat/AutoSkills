#!/usr/bin/env bash
# Sync AutoSkills project-* skills to Codex / Claude / Gemini user dirs.
# Usage: sync-skills.sh [--dry-run] [--help]

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# AUTOSKILLS_HOME = parent of scripts/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOSKILLS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="$AUTOSKILLS_HOME/skills"

USER_HOME="${HOME}"
TARGETS=(
  "$USER_HOME/.codex/skills"
  "$USER_HOME/.claude/skills"
  "$USER_HOME/.gemini/skills"
)
CLAUDE_COMMAND_ROOT="$USER_HOME/.claude/commands"

echo "[sync-skills] AUTOSKILLS_HOME = $AUTOSKILLS_HOME"
echo "[sync-skills] source         = $SOURCE_ROOT"
[[ $DRY_RUN -eq 1 ]] && echo "[sync-skills] DRY-RUN mode (no filesystem changes)"

# Collect skill names (project-*)
if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "Source not found: $SOURCE_ROOT" >&2
  exit 1
fi

mapfile -t SKILLS < <(find "$SOURCE_ROOT" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | grep -E '^project-[a-z-]+$' | sort)

if [[ ${#SKILLS[@]} -eq 0 ]]; then
  echo "No project-* skills found in $SOURCE_ROOT. Aborting." >&2
  exit 1
fi

echo "[sync-skills] ${#SKILLS[@]} skills to sync -> ${#TARGETS[@]} targets"

invoke() {
  local desc="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] $desc"
  else
    echo "[action]  $desc"
    "$@"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "no sha256 tool" >&2
    exit 3
  fi
}

for TARGET_ROOT in "${TARGETS[@]}"; do
  echo "--- target: $TARGET_ROOT ---"
  invoke "mkdir $TARGET_ROOT" mkdir -p "$TARGET_ROOT"

  if [[ -d "$TARGET_ROOT" ]]; then
    # Orphan project-* cleanup
    for d in "$TARGET_ROOT"/project-*; do
      [[ -d "$d" ]] || continue
      name="$(basename "$d")"
      keep=0
      for s in "${SKILLS[@]}"; do [[ "$s" == "$name" ]] && keep=1 && break; done
      if [[ $keep -eq 0 ]]; then
        invoke "remove orphan $d" rm -rf "$d"
      fi
    done
    # Malformed braces cleanup. PM-706: scoped to names that also contain
    # 'project-' — never delete an unrelated user skill whose name happens to
    # contain { } or ,.
    for d in "$TARGET_ROOT"/*\{* "$TARGET_ROOT"/*\}* "$TARGET_ROOT"/*,*; do
      [[ -e "$d" ]] || continue
      case "$(basename "$d")" in
        *project-*) invoke "remove malformed $d" rm -rf "$d" ;;
        *) echo "[info]    leaving non-project entry alone: $d" ;;
      esac
    done
  fi

  for NAME in "${SKILLS[@]}"; do
    SRC="$SOURCE_ROOT/$NAME"
    DST="$TARGET_ROOT/$NAME"
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "[dry-run] sync $NAME -> $DST"
    else
      echo "[action]  sync $NAME -> $DST"
      rm -rf "$DST"
      mkdir -p "$DST"
      # copy all non-bak files
      (cd "$SRC" && find . -type f ! -name '*.bak' -print0) |
        while IFS= read -r -d '' f; do
          rel="${f#./}"
          dest_path="$DST/$rel"
          mkdir -p "$(dirname "$dest_path")"
          cp "$SRC/$rel" "$dest_path"
        done
    fi
  done

  # SHA-256 verification (skip in dry-run)
  if [[ $DRY_RUN -eq 0 ]]; then
    for NAME in "${SKILLS[@]}"; do
      SRC_FILE="$SOURCE_ROOT/$NAME/SKILL.md"
      DST_FILE="$TARGET_ROOT/$NAME/SKILL.md"
      if [[ -f "$SRC_FILE" && -f "$DST_FILE" ]]; then
        sh1="$(sha256_of "$SRC_FILE")"
        sh2="$(sha256_of "$DST_FILE")"
        if [[ "$sh1" != "$sh2" ]]; then
          echo "SHA256 mismatch for $NAME in $TARGET_ROOT" >&2
          exit 4
        fi
      fi
    done
    echo "[verify]  SHA-256 OK for $TARGET_ROOT"
  fi
done

# Clean Claude legacy wrappers
if [[ -d "$CLAUDE_COMMAND_ROOT" ]]; then
  for NAME in "${SKILLS[@]}"; do
    W="$CLAUDE_COMMAND_ROOT/$NAME.md"
    if [[ -f "$W" ]]; then
      invoke "remove legacy wrapper $W" rm -f "$W"
    fi
  done
fi

echo "[sync-skills] done."
