#!/usr/bin/env bash
# Build and register the project-manager MCP server, then plan the kit deploy. See bootstrap.ps1.
# Usage: bootstrap.sh [--dry-run] [--force] [--migrate-state=dir1,dir2] [--local-config=<file>] [--help]
# Order on a new machine: bootstrap.sh -> node scripts/deploy-kit.mjs --init-local -> node scripts/deploy-kit.mjs (then --apply).
#
# Steps: 1. npm install + npm run build; 2. register with codex and claude per mcp-manifest.json; 3. verify;
# 4. check the deploy prerequisites (local config, portable Node), then node scripts/deploy-kit.mjs --dry-run
# (the plan only). The kit itself is deployed by deploy-kit (backup, journal, rollback). A missing local config
# or portable Node prints the remedy and exits 3 without running deploy-kit, so no hook is registered.
# Exit codes: 0 = done; 1 = a step failed or deploy-kit reported conflicts; 2 = usage, or a deploy-kit usage
# or setup error; 3 = local config or portable Node missing; 4 = node not found.

set -euo pipefail

DRY_RUN=0
FORCE=0
MIGRATE_STATE=""
LOCAL_CONFIG_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --migrate-state=*) MIGRATE_STATE="${arg#*=}" ;;
    --local-config=*) LOCAL_CONFIG_ARG="${arg#*=}" ;;
    --help|-h) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOSKILLS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$AUTOSKILLS_HOME/mcp-manifest.json"
MCP_DIR="$AUTOSKILLS_HOME/mcp/project-manager"
DEPLOY_KIT="$SCRIPT_DIR/deploy-kit.mjs"
if [[ -n "$LOCAL_CONFIG_ARG" ]]; then
  case "$LOCAL_CONFIG_ARG" in
    /*|[A-Za-z]:*) LOCAL_CONFIG="$LOCAL_CONFIG_ARG" ;;
    *) LOCAL_CONFIG="$PWD/$LOCAL_CONFIG_ARG" ;;
  esac
  LOCAL_CONFIG_OPT=" --local-config \"$LOCAL_CONFIG\""
else
  LOCAL_CONFIG="$AUTOSKILLS_HOME/_private/kit-local.json"
  LOCAL_CONFIG_OPT=""
fi
# The portable Node the kit hooks run on (ADR-006); the system Node keeps running project-manager.
PORTABLE_NODE_VERSION="24.22.2"

echo "=========================================="
echo "  AutoSkills Bootstrap"
echo "=========================================="
echo "AUTOSKILLS_HOME = $AUTOSKILLS_HOME"
echo "manifest        = $MANIFEST"
echo "mcp source dir  = $MCP_DIR"
echo "local config    = $LOCAL_CONFIG"
[[ $DRY_RUN -eq 1 ]] && echo "MODE            = DRY-RUN (no build / no registration; deploy-kit plans only)"
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

if ! command -v node >/dev/null 2>&1; then
  echo "node required (build, manifest, deploy-kit)" >&2
  exit 4
fi

# --- Step 1: build MCP server ---
echo "--- Step 1/4: build project-manager MCP server ---"
if [[ ! -d "$MCP_DIR" ]]; then
  echo "MCP project dir not found: $MCP_DIR" >&2
  exit 1
fi

invoke "npm install in $MCP_DIR" bash -c 'cd "$1" && npm install' _ "$MCP_DIR"
invoke "npm run build in $MCP_DIR" bash -c 'cd "$1" && npm run build' _ "$MCP_DIR"
if [[ $DRY_RUN -eq 0 && ! -f "$MCP_DIR/dist/index.js" ]]; then
  echo "Build did not produce dist/index.js" >&2
  exit 1
fi

# --- Step 1.5 (optional): migrate existing project state to schema v1 ---
echo
if [[ -n "$MIGRATE_STATE" ]]; then
  echo "--- Step 1.5 (optional): migrate project state to schema v1 (idempotent) ---"
  STATE_JS="$MCP_DIR/dist/state.js"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] migrate_tasks_schema on: $MIGRATE_STATE"
  else
    [[ -f "$STATE_JS" ]] || { echo "Built state module not found: $STATE_JS" >&2; exit 1; }
    IFS=',' read -ra PROJ_DIRS <<< "$MIGRATE_STATE"
    for proj in "${PROJ_DIRS[@]}"; do
      # Paths via env vars (single-quoted JS reads process.env) — no shell
      # interpolation into the JS source, so no quote-break / injection.
      PM_STATE_JS="$STATE_JS" PM_PROJ_DIR="$proj" node -e 'const{StateManager}=require(process.env.PM_STATE_JS);const r=new StateManager(process.env.PM_PROJ_DIR).migrateTaskSchema();console.log("    "+process.env.PM_PROJ_DIR+" -> "+JSON.stringify(r));'
    done
  fi
else
  echo "--- Step 1.5 (optional): state migration skipped (lazy first-touch). Pass --migrate-state=dir1,dir2 to batch-migrate. ---"
fi

# --- Step 2: register MCP with codex and claude per manifest ---
echo
echo "--- Step 2/4: register MCP server with codex and claude per mcp-manifest.json ---"
if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 1
fi

# Manifest path via env (not interpolated into the JS source) to avoid injection if the path contains a quote.
# One line for the command, then one line per argument.
MANIFEST_LINES="$(PM_MANIFEST="$MANIFEST" node -e '
const m = JSON.parse(require("fs").readFileSync(process.env.PM_MANIFEST, "utf8").replace(/^﻿/, ""));
if (m.version !== 1) { console.error("Unsupported manifest version: " + m.version); process.exit(1); }
const pm = m.servers["project-manager"];
console.log([pm.command, ...pm.args_template].join("\n"));
')"
MCP_COMMAND=""
MCP_ARGS=()
while IFS= read -r line; do
  if [[ -z "$MCP_COMMAND" ]]; then MCP_COMMAND="$line"; continue; fi
  # Expand ${AUTOSKILLS_HOME}
  MCP_ARGS+=("${line//\$\{AUTOSKILLS_HOME\}/$AUTOSKILLS_HOME}")
done <<< "$MANIFEST_LINES"

echo "resolved command: $MCP_COMMAND ${MCP_ARGS[*]}"

# codex
HAS_CODEX=0; command -v codex >/dev/null 2>&1 && HAS_CODEX=1
if [[ $HAS_CODEX -eq 1 ]]; then
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
HAS_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAS_CLAUDE=1
if [[ $HAS_CLAUDE -eq 1 ]]; then
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

# --- Step 3: verify ---
echo
echo "--- Step 3/4: verify MCP visible to codex and claude ---"
if [[ $DRY_RUN -eq 1 ]]; then
  [[ $HAS_CODEX -eq 1 ]] && echo "[dry-run] codex mcp get project-manager"
  [[ $HAS_CLAUDE -eq 1 ]] && echo "[dry-run] claude mcp get project-manager -s user"
else
  if [[ $HAS_CODEX -eq 1 ]]; then
    echo "[verify]  codex mcp get project-manager:"
    codex mcp get project-manager 2>&1 | sed 's/^/    /'
  fi
  if [[ $HAS_CLAUDE -eq 1 ]]; then
    echo "[verify]  claude mcp get project-manager -s user:"
    claude mcp get project-manager -s user 2>&1 | sed 's/^/    /'
  fi
fi

# --- Step 4: deploy prerequisites, then the deploy-kit plan ---
echo
echo "--- Step 4/4: check the deploy prerequisites, then plan the kit deploy ---"
# Prints "<status>\t<runtime>\t<portable_node>": status is ok, no-config, bad-config, no-node-set or no-node-file.
# Without a config the default runtime area is searched for node-v*/ the way deploy-kit --init-local does.
CHECK="$(PM_LOCAL_CONFIG="$LOCAL_CONFIG" PM_RUNTIME="$AUTOSKILLS_HOME/_private/rt" node -e '
const fs = require("fs"), path = require("path");
const out = (s, rt, n) => console.log([s, rt, n || ""].join("\t"));
const findNode = (rt) => {
  let names = [];
  try { names = fs.readdirSync(rt); } catch { return null; }
  const ver = (n) => (/^node-v(\d+)\.(\d+)\.(\d+)-/.exec(n) || []).slice(1).map(Number);
  const c = names.filter((n) => ver(n).length === 3).sort((a, b) => { const x = ver(a), y = ver(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  for (const n of c) for (const b of [["node.exe"], ["bin", "node"]]) { const p = path.join(rt, n, ...b); if (fs.existsSync(p)) return p; }
  return null;
};
const file = process.env.PM_LOCAL_CONFIG;
let rt = process.env.PM_RUNTIME;
if (!fs.existsSync(file)) { out(findNode(rt) ? "no-config" : "no-config-no-node", rt); process.exit(0); }
let c;
try { c = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { c = null; }
if (!c || typeof c !== "object" || Array.isArray(c)) { out("bad-config", rt); process.exit(0); }
if (c.runtime) rt = c.runtime;
if (!c.portable_node) out("no-node-set", rt);
else if (!fs.existsSync(c.portable_node) || !fs.statSync(c.portable_node).isFile()) out("no-node-file", rt, c.portable_node);
else out("ok", rt, c.portable_node);
')"
IFS=$'\t' read -r CHECK_STATUS RUNTIME PORTABLE_NODE <<< "$CHECK"
MISSING_CONFIG=0; MISSING_NODE=0
case "$CHECK_STATUS" in
  ok) echo "[ok]      local config $LOCAL_CONFIG; portable Node $PORTABLE_NODE" ;;
  no-config) echo "[missing] local config not found: $LOCAL_CONFIG"; MISSING_CONFIG=1 ;;
  no-config-no-node)
    echo "[missing] local config not found: $LOCAL_CONFIG"
    echo "[missing] portable Node: no node-v*/ Node under the default runtime area $RUNTIME"
    MISSING_CONFIG=1; MISSING_NODE=1 ;;
  bad-config) echo "[missing] local config is not a valid JSON object: $LOCAL_CONFIG"; MISSING_CONFIG=2 ;;
  no-node-set) echo "[missing] portable Node: portable_node is not set in $LOCAL_CONFIG"; MISSING_NODE=1 ;;
  no-node-file) echo "[missing] portable Node: $PORTABLE_NODE does not exist"; MISSING_NODE=1 ;;
  *) echo "local config check failed: $CHECK" >&2; exit 1 ;;
esac

if [[ $MISSING_CONFIG -ne 0 || $MISSING_NODE -eq 1 ]]; then
  # deploy-kit writes the hooks that run on the portable Node; stop here so no hook is registered.
  echo
  echo "Remedy (then re-run this script):"
  INIT_ARGS=""
  if [[ $MISSING_NODE -eq 1 ]]; then
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64) ARCHIVE="node-v$PORTABLE_NODE_VERSION-linux-x64.tar.xz" ;;
      Linux-aarch64) ARCHIVE="node-v$PORTABLE_NODE_VERSION-linux-arm64.tar.xz" ;;
      Darwin-arm64) ARCHIVE="node-v$PORTABLE_NODE_VERSION-darwin-arm64.tar.gz" ;;
      Darwin-*) ARCHIVE="node-v$PORTABLE_NODE_VERSION-darwin-x64.tar.gz" ;;
      *) ARCHIVE="node-v$PORTABLE_NODE_VERSION-win-x64.zip" ;;
    esac
    BASE="https://nodejs.org/dist/v$PORTABLE_NODE_VERSION"
    echo "  Install the portable Node $PORTABLE_NODE_VERSION into the runtime area (the system Node stays as it is):"
    echo "    1. Download $BASE/$ARCHIVE and $BASE/SHASUMS256.txt"
    echo "    2. Verify: grep \" $ARCHIVE\$\" SHASUMS256.txt | sha256sum -c -   (macOS: shasum -a 256 -c -)"
    if [[ "$ARCHIVE" == *.zip ]]; then
      echo "    3. unzip $ARCHIVE -d \"$RUNTIME\"   (gives $RUNTIME/${ARCHIVE%.zip}/node.exe)"
    else
      echo "    3. mkdir -p \"$RUNTIME\" && tar -xf $ARCHIVE -C \"$RUNTIME\"   (gives $RUNTIME/${ARCHIVE%.tar.*}/bin/node)"
    fi
    INIT_ARGS=" --runtime \"$RUNTIME\""
  fi
  [[ $MISSING_CONFIG -eq 2 ]] && echo "  Fix the JSON in $LOCAL_CONFIG, or move the file aside so a new one is written:"
  echo "  Write the local config (only it and the two canary folders under _private/; it finds the portable Node):"
  echo "    node scripts/deploy-kit.mjs --init-local$INIT_ARGS$LOCAL_CONFIG_OPT"
  echo "  Then add real customer-data folders to customer_data_dirs in that file by hand."
  echo
  echo "Bootstrap stopped: deploy prerequisites missing; deploy-kit was not run."
  exit 3
fi

DEPLOY_ARGS=("$DEPLOY_KIT" --dry-run)
[[ -n "$LOCAL_CONFIG_ARG" ]] && DEPLOY_ARGS+=(--local-config "$LOCAL_CONFIG")
echo "[run]     node scripts/deploy-kit.mjs --dry-run$LOCAL_CONFIG_OPT"
set +e
node "${DEPLOY_ARGS[@]}"
DEPLOY_EXIT=$?
set -e
if [[ $DEPLOY_EXIT -ne 0 ]]; then
  echo
  echo "Bootstrap stopped: deploy-kit exited $DEPLOY_EXIT (see above)."
  exit $DEPLOY_EXIT
fi

echo
echo "=========================================="
echo "  Bootstrap complete."
echo "=========================================="
echo "Next: close every Claude Code and Codex session, review the plan above, then deploy with"
echo "  node scripts/deploy-kit.mjs --apply$LOCAL_CONFIG_OPT"
