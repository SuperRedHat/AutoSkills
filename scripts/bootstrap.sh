#!/usr/bin/env bash
# One-click install of AutoSkills on a new machine. See bootstrap.ps1.
# Usage: bootstrap.sh [--dry-run] [--force] [--migrate-state=dir1,dir2] [--help]

set -euo pipefail

DRY_RUN=0
FORCE=0
MIGRATE_STATE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --migrate-state=*) MIGRATE_STATE="${arg#*=}" ;;
    --help|-h) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOSKILLS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_HOME="${HOME}"
MANIFEST="$AUTOSKILLS_HOME/mcp-manifest.json"
MCP_DIR="$AUTOSKILLS_HOME/mcp/project-manager"

echo "=========================================="
echo "  AutoSkills Bootstrap"
echo "=========================================="
echo "AUTOSKILLS_HOME = $AUTOSKILLS_HOME"
echo "USER_HOME       = $USER_HOME"
echo "manifest        = $MANIFEST"
echo "mcp source dir  = $MCP_DIR"
[[ $DRY_RUN -eq 1 ]] && echo "MODE            = DRY-RUN (no writes / no CLI calls)"
echo

invoke() {
  local desc="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] $desc"
  else
    echo "[action]  $desc"
    "$@"
  fi
}

# --- Step 1: backup ---
echo "--- Step 1/5: backup current state ---"
if [[ $DRY_RUN -eq 1 ]]; then
  bash "$SCRIPT_DIR/backup-global-workflow.sh" --dry-run
else
  bash "$SCRIPT_DIR/backup-global-workflow.sh"
fi

# --- Step 2: sync skills ---
echo
echo "--- Step 2/5: sync skills to 3 CLIs ---"
if [[ $DRY_RUN -eq 1 ]]; then
  bash "$SCRIPT_DIR/sync-skills.sh" --dry-run
else
  bash "$SCRIPT_DIR/sync-skills.sh"
fi

# --- Step 3: build MCP server ---
echo
echo "--- Step 3/5: build project-manager MCP server ---"
if [[ ! -d "$MCP_DIR" ]]; then
  echo "MCP project dir not found: $MCP_DIR" >&2
  exit 1
fi

invoke "npm install in $MCP_DIR" bash -c 'cd "$1" && npm install' _ "$MCP_DIR"
invoke "npm run build in $MCP_DIR" bash -c 'cd "$1" && npm run build' _ "$MCP_DIR"
if [[ $DRY_RUN -eq 0 && ! -f "$MCP_DIR/dist/index.js" ]]; then
  echo "Build did not produce dist/index.js" >&2
  exit 3
fi

# --- Step 3.5 (optional): migrate existing project state to schema v1 ---
echo
if [[ -n "$MIGRATE_STATE" ]]; then
  echo "--- Step 3.5 (optional): migrate project state to schema v1 (idempotent) ---"
  STATE_JS="$MCP_DIR/dist/state.js"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] migrate_tasks_schema on: $MIGRATE_STATE"
  else
    [[ -f "$STATE_JS" ]] || { echo "Built state module not found: $STATE_JS" >&2; exit 3; }
    IFS=',' read -ra PROJ_DIRS <<< "$MIGRATE_STATE"
    for proj in "${PROJ_DIRS[@]}"; do
      # Paths via env vars (single-quoted JS reads process.env) — no shell
      # interpolation into the JS source, so no quote-break / injection.
      PM_STATE_JS="$STATE_JS" PM_PROJ_DIR="$proj" node -e 'const{StateManager}=require(process.env.PM_STATE_JS);const r=new StateManager(process.env.PM_PROJ_DIR).migrateTaskSchema();console.log("    "+process.env.PM_PROJ_DIR+" -> "+JSON.stringify(r));'
    done
  fi
else
  echo "--- Step 3.5 (optional): state migration skipped (lazy first-touch). Pass --migrate-state=dir1,dir2 to batch-migrate. ---"
fi

# --- Step 4: register MCP with 3 CLIs per manifest ---
echo
echo "--- Step 4/5: register MCP server with 3 CLIs per mcp-manifest.json ---"
if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 1
fi

# Parse JSON via python3 (portable on any bootstrap box; node is also available)
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 required to parse manifest" >&2
  exit 4
fi

# Manifest path via env (not interpolated into the Python string literal) to avoid
# injection if the path contains a quote.
export PM_MANIFEST="$MANIFEST"
MCP_COMMAND="$(python3 -c "import json,os; m=json.load(open(os.environ['PM_MANIFEST'],encoding='utf-8')); print(m['servers']['project-manager']['command'])")"
MCP_ARGS_RAW="$(python3 -c "import json,os; m=json.load(open(os.environ['PM_MANIFEST'],encoding='utf-8')); print('\n'.join(m['servers']['project-manager']['args_template']))")"
TRUST_GEMINI="$(python3 -c "import json,os; m=json.load(open(os.environ['PM_MANIFEST'],encoding='utf-8')); print(str(m['servers']['project-manager']['trust']['gemini']).lower())")"

# Expand ${AUTOSKILLS_HOME}
MCP_ARGS=()
while IFS= read -r line; do
  MCP_ARGS+=("${line//\$\{AUTOSKILLS_HOME\}/$AUTOSKILLS_HOME}")
done <<< "$MCP_ARGS_RAW"

echo "resolved command: $MCP_COMMAND ${MCP_ARGS[*]}"

# codex
if command -v codex >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] codex mcp add project-manager"
  else
    echo "[action]  codex mcp add project-manager"
    (codex mcp remove project-manager 2>/dev/null) || true
    codex mcp add project-manager -- "$MCP_COMMAND" "${MCP_ARGS[@]}"
  fi
else
  echo "[info]    codex CLI not found, skipping codex registration"
fi

# claude (user scope)
if command -v claude >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] claude mcp add project-manager -s user"
  else
    echo "[action]  claude mcp add project-manager -s user"
    (claude mcp remove project-manager -s user 2>/dev/null) || true
    claude mcp add project-manager -s user -- "$MCP_COMMAND" "${MCP_ARGS[@]}"
  fi
else
  echo "[info]    claude CLI not found, skipping claude registration"
fi

# gemini (settings.json edit)
GEMINI_SETTINGS="$USER_HOME/.gemini/settings.json"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] gemini mcp register (edit $GEMINI_SETTINGS, trust=$TRUST_GEMINI)"
else
  echo "[action]  gemini mcp register (edit $GEMINI_SETTINGS, trust=$TRUST_GEMINI)"
  mkdir -p "$USER_HOME/.gemini"
  # Build the args JSON from the array via argv (no word-splitting / single-element
  # collapse), then pass everything through env into a QUOTED heredoc so nothing is
  # shell-interpolated into the Python source (no injection, no triple-quote break).
  MCP_ARGS_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${MCP_ARGS[@]}")"
  PM_GEMINI_SETTINGS="$GEMINI_SETTINGS" PM_MCP_COMMAND="$MCP_COMMAND" PM_MCP_ARGS_JSON="$MCP_ARGS_JSON" PM_TRUST_GEMINI="$TRUST_GEMINI" python3 - <<'PYEOF'
import json, os, shutil, sys, time
path = os.environ['PM_GEMINI_SETTINGS']
data = {}
if os.path.isfile(path):
    # PM-706: utf-8-sig tolerates the BOM that Windows PowerShell 5.1 used to
    # write. On a REAL parse failure, back the file up and SKIP the merge —
    # never silently replace the user's settings with an empty object.
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
    except Exception as exc:
        backup = path + '.bak-' + time.strftime('%Y%m%dT%H%M%S')
        shutil.copy2(path, backup)
        print('[warn]    ' + path + ' is not valid JSON (' + str(exc) + ');')
        print('[warn]    backed it up to ' + backup + ' and SKIPPING gemini registration.')
        print('[warn]    Fix the file, then re-run bootstrap to register the MCP server for gemini.')
        sys.exit(0)
data.setdefault('mcpServers', {})
data['mcpServers']['project-manager'] = {
    'command': os.environ['PM_MCP_COMMAND'],
    'args': json.loads(os.environ['PM_MCP_ARGS_JSON']),
    'trust': os.environ['PM_TRUST_GEMINI'].lower() == 'true',
}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
fi

# --- Step 5: verify ---
echo
echo "--- Step 5/5: verify MCP visible to all 3 CLIs ---"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] codex mcp get / claude mcp get / gemini settings.json"
else
  if command -v codex >/dev/null 2>&1; then
    echo "[verify]  codex mcp get project-manager:"
    codex mcp get project-manager 2>&1 | sed 's/^/    /'
  fi
  if command -v claude >/dev/null 2>&1; then
    echo "[verify]  claude mcp get project-manager -s user:"
    claude mcp get project-manager -s user 2>&1 | sed 's/^/    /'
  fi
  echo "[verify]  gemini settings.json mcpServers.project-manager:"
  if [[ -f "$GEMINI_SETTINGS" ]]; then
    python3 -c "import json; d=json.load(open(r'$GEMINI_SETTINGS',encoding='utf-8')); pm=d.get('mcpServers',{}).get('project-manager'); print('    command =', pm.get('command')) if pm else print('    MISSING'); print('    args    =', ' '.join(pm.get('args',[]))) if pm else None; print('    trust   =', pm.get('trust')) if pm else None"
  fi
fi

echo
echo "=========================================="
echo "  Bootstrap complete."
echo "=========================================="
