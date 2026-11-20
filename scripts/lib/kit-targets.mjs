// kit-targets: the root mapping, the local config and the target list of the AutoSkills kit. Shared by
// deploy-kit (plan and write), check-kit (compare) and the measurement scripts, so every one of them
// resolves the same paths from the same three roots. Zero dependencies (Node >= 18). Read only: nothing
// in this module writes, moves or deletes files.
// lint-kit: allow-legacy the deletion list names the six retired skills and the old Gemini skill folder it removes
//
// Roots (resolveRoots):
//   home           the user directory (default os.homedir()); every user-level target hangs off it.
//   runtime        the runtime area for hooks and the portable Node (default: runtime in the local config).
//   projects_root  the folder that holds the project repositories (default: projects_root in the local config).
// Tests and drills redirect all three, so they never touch the real user directory, runtime or repos.
//
// Targets of AS3-112a (desiredFiles, legacyRemovals; ADR-006 §2.7, v2 §3.1/§3.5/§3.6, v3 §5):
//   ~/.claude/AGENTS.md, ~/.codex/AGENTS.md   the shared contract (templates/global-AGENTS.md), whole file.
//   ~/.claude/CLAUDE.md                        templates/global-claude-CLAUDE.md, which opens with @AGENTS.md;
//                                              claude_contract=inline puts the contract text in place of the
//                                              import line (fallback when the import does not load).
//   ~/.claude/skills/<7>, ~/.agents/skills/<7> the 7 kit skills, each folder replaced whole.
//   ~/.claude/agents/project-verifier.md       the independent verifier (v2 §3.6).
//   ~/.workflow-core/templates/<file>          every file of templates/; other files there stay.
//   ~/.workflow-core/policies/workflow-rules.md merged: the old "Core Rules" section is removed and a marked
//                                              block points to the contract; the other sections stay.
//   Removed: the old project-* copies only (LEGACY_SKILL_DIRS), and with retireLegacyAgents the 3 old
//   agents of LEGACY_AGENTS. Folders whose name starts with "{" (a failed brace expansion) are listed, never
//   removed. Never targeted: ~/.claude.json, the project-manager dist, verification-profiles.json and
//   acceptance-matrix.json (NEVER_TOUCH), and ~/.workflow-core scripts/, docs/ and backups/.
//
// Targets of AS3-112b (desiredFiles with the local config; ADR-006 §2.5/§2.6):
//   ~/.claude/settings.json   merged with config/claude/settings.fragment.json (mergeClaudeSettings): kit
//                             keys are set, kit deny rules added, kit hook entries replaced; every other key,
//                             rule, hook and plugin stays. Generated from the local config: Edit(//<dir>/**)
//                             for each read-only folder (an Edit rule covers every built-in file-writing tool,
//                             Write included) and Read(//<dir>/**) for each customer-data folder.
//   ~/.codex/config.toml      only the keys of config/codex/config.fragment.toml are set (scripts/lib/
//                             toml-edit.mjs); order, comments, trust, plugin and MCP sections stay.
//   ~/.codex/hooks.json       the filled config/codex/hooks.json; merged like settings.json when it exists.
//                             A portable_node that is not one plain word (PLAIN_COMMAND_WORD) is a conflict.
//   ~/.codex/rules/autoskills.rules   config/codex/rules/autoskills.rules, whole file.
//   <runtime>/hooks/          guard.mjs and session-start.mjs (it imports ./guard.mjs) from hooks/, plus
//                             hook-config.json with runtime, readonly_dirs and kit_repo for the guard.
//   Placeholders in the fragments: <node> = portable_node, <runtime> = the runtime root, <home> = home.
//   The project-manager registration is not touched (batch 1 keeps 1.5.1 on the system Node). The pushurl
//   of each repository is planned by deploy-kit through scripts/set-pushurl.mjs.
// Project layout for the measurement (stageFiles): .claude/AGENTS.md, .claude/CLAUDE.md (@AGENTS.md first),
// .claude/skills/<7>, .agents/skills/<7> and contract/AGENTS.md (the contract text).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyValues, setValue, TomlEditError } from './toml-edit.mjs';

export const KIT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_LOCAL_CONFIG = path.join(KIT_REPO, '_private', 'kit-local.json');
const WIN = process.platform === 'win32';

/** A usage or setup error: the CLIs exit 2 on it. */
export class UsageError extends Error {}

// The 7 skills of AutoSkills 3.0 and the 6 retired in batch 1 (same lists as lint-kit).
export const KIT_SKILLS = ['project-consult', 'project-feedback', 'project-next', 'project-plan', 'project-quick', 'project-resume', 'project-status'];
export const RETIRED_SKILLS = ['project-ask', 'project-change', 'project-design', 'project-discuss', 'project-init', 'project-review'];
// Agent definitions the kit deploys to ~/.claude/agents/ (from config/claude/agents/<name>.md).
export const KIT_AGENTS = ['project-verifier'];
// The 3 agents from March that call retired skills (v2 decision 9): archived, then removed, only with
// --retire-legacy-agents.
export const LEGACY_AGENTS = ['code-reviewer', 'researcher', 'tester'];
export const CLAUDE_CONTRACT_MODES = ['import', 'inline'];
export const DEFAULT_OPTIONS = Object.freeze({ claude_contract: 'import', retire_legacy_agents: false });
const IMPORT_LINE = '@AGENTS.md';

// Old skill copies (v2 §3.6 and decision 9, ADR-006 §2.7). select 'retired' removes only RETIRED_SKILLS;
// 'project' removes every project-* folder. Other folders (pdf, playwright, .system, synced ...) are never
// looked at beyond their name.
export const LEGACY_SKILL_DIRS = [
  { key: 'claudeSkills', select: 'retired', reason: 'skill retired in AutoSkills 3.0 (ADR-006 §2.7)' },
  { key: 'codexSkills', select: 'project', reason: 'old copy: Codex reads the kit skills from ~/.agents/skills (v2 §3.6)' },
  { key: 'geminiSkills', select: 'project', reason: 'old copy: Gemini is no longer a kit platform (v2 §3.6)' },
  { key: 'codexAgentSkills', select: 'project', reason: 'old copy left by the former sync script; not a skill location' },
  { key: 'workflowSkills', select: 'project', reason: 'old copy of the former skill source; the kit deploys from its repo' },
];

// workflow-rules.md: the kit block and the section it retires.
export const WF_BEGIN = '<!-- autoskills:begin -->';
export const WF_END = '<!-- autoskills:end -->';
const WF_POINTER = [
  '## AutoSkills 3.0',
  '',
  'The shared rules live in the autonomy contract: `~/.claude/AGENTS.md` and `~/.codex/AGENTS.md` (the same text,',
  'from `templates/global-AGENTS.md` of the AutoSkills repo). Where this file and the contract differ, the contract applies.',
  'Project contracts start from `~/.workflow-core/templates/repo-AGENTS.md`. The former "Core Rules" section is retired.',
];
const WF_RETIRED_SECTION = /^##\s+Core Rules\s*$/i;
const WF_DEFAULT_TITLE = '# Shared Workflow Rules';

// Hook scripts deployed to <runtime>/hooks/ and the guard's config written next to them.
export const KIT_HOOK_SCRIPTS = ['guard.mjs', 'session-start.mjs'];
export const HOOK_CONFIG_NAME = 'hook-config.json';
const PLACEHOLDER_RE = /<(?:node|runtime|home)>/;
// A hook entry of the kit, whatever runtime it points to: its command line runs hooks/guard.mjs or
// hooks/session-start.mjs. Such entries are replaced on a deploy; all other hook entries stay.
const KIT_HOOK_RE = /[\\/]hooks[\\/](?:guard|session-start)\.mjs(?![A-Za-z0-9_.-])/;

// ---------- paths ----------

/** Absolute path with / separators, as written to the local config. */
export const slash = (p) => path.resolve(p).split(path.sep).join('/');

/** Comparison key: resolved, on Windows in lower case. */
export const pathKey = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));

/** True when p is dir or lies below it. */
export function within(p, dir) {
  const k = pathKey(p), d = pathKey(dir);
  return k === d || k.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** p with junctions and symlinks resolved on its longest existing part (the rest appended as given). */
export function realPathOf(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur).replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
      return path.join(real, ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * Every user-level and runtime location the kit knows, resolved from the three roots.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots absolute paths
 * @returns {Record<string, string>} absolute paths
 */
export function targetMap(roots) {
  const h = (...p) => path.join(roots.home, ...p);
  return {
    claudeDir: h('.claude'),
    claudeAgentsMd: h('.claude', 'AGENTS.md'),
    claudeMd: h('.claude', 'CLAUDE.md'),
    claudeSkills: h('.claude', 'skills'),
    claudeAgents: h('.claude', 'agents'),
    claudeSettings: h('.claude', 'settings.json'),
    claudeJson: h('.claude.json'),
    pmServer: h('.claude', 'mcp-project-manager'),
    codexDir: h('.codex'),
    codexAgentsMd: h('.codex', 'AGENTS.md'),
    codexConfig: h('.codex', 'config.toml'),
    codexHooks: h('.codex', 'hooks.json'),
    codexRules: h('.codex', 'rules', 'autoskills.rules'),
    codexSkills: h('.codex', 'skills'),
    codexAgentSkills: h('.codex', 'agents', 'skills'),
    agentsSkills: h('.agents', 'skills'),
    geminiSkills: h('.gemini', 'skills'),
    workflowCore: h('.workflow-core'),
    workflowTemplates: h('.workflow-core', 'templates'),
    workflowSkills: h('.workflow-core', 'skills'),
    workflowRules: h('.workflow-core', 'policies', 'workflow-rules.md'),
    verificationProfiles: h('.workflow-core', 'policies', 'verification-profiles.json'),
    acceptanceMatrix: h('.workflow-core', 'policies', 'acceptance-matrix.json'),
    runtime: roots.runtime,
    runtimeHooks: path.join(roots.runtime, 'hooks'),
    projectsRoot: roots.projectsRoot,
  };
}

/** Paths the kit never writes or removes (ADR-006 §2.7). */
export function neverTouch(roots) {
  const t = targetMap(roots);
  return [t.claudeJson, path.join(t.pmServer, 'dist'), t.verificationProfiles, t.acceptanceMatrix];
}

// ---------- local config ----------

/**
 * Read and check the local config (_private/kit-local.json; fields in config/kit-local.example.json).
 * @param {string} file
 * @returns {object} the parsed config; missing lists are []
 * @throws {UsageError} the file is missing (message names --init-local), unreadable, or a path is not absolute
 */
export function readLocalConfig(file) {
  if (!fs.existsSync(file)) {
    throw new UsageError(`local config ${file} not found; create it first with: node scripts/deploy-kit.mjs --init-local`);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new UsageError(`local config ${file} cannot be read: ${e.message}`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new UsageError(`local config ${file}: not a JSON object`);
  for (const key of ['readonly_dirs', 'customer_data_dirs']) {
    const v = cfg[key] ?? [];
    if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !path.isAbsolute(d))) {
      throw new UsageError(`local config ${file}: ${key} must be a list of absolute paths`);
    }
    cfg[key] = v;
  }
  for (const key of ['runtime', 'projects_root', 'portable_node', 'restore_tool']) {
    const v = cfg[key];
    if (v !== undefined && v !== null && (typeof v !== 'string' || !path.isAbsolute(v))) {
      throw new UsageError(`local config ${file}: ${key} must be an absolute path`);
    }
  }
  return cfg;
}

/**
 * The three roots: command-line values first, then the user directory and the local config.
 * @param {{home?: string, runtime?: string, projectsRoot?: string}} cli
 * @param {object|null} local parsed local config (null: no defaults for runtime and projects_root)
 * @returns {{home: string, runtime: string, projectsRoot: string}} absolute paths
 * @throws {UsageError} a root has neither a command-line value nor a local-config value
 */
export function resolveRoots(cli = {}, local = null) {
  const pick = (flag, key, name) => {
    if (flag) return path.resolve(flag);
    if (local && local[key]) return path.resolve(local[key]);
    throw new UsageError(`no ${name}: pass --${name} or set ${key} in the local config`);
  };
  return {
    home: path.resolve(cli.home || os.homedir()),
    runtime: pick(cli.runtime, 'runtime', 'runtime'),
    projectsRoot: pick(cli.projectsRoot, 'projects_root', 'projects-root'),
  };
}

/**
 * The deploy options recorded in the local config by the last --apply (deploy_options), or the defaults
 * when none are recorded. --dry-run --expect-clean compares against these.
 * @param {object} local parsed local config
 * @returns {{claude_contract: string, retire_legacy_agents: boolean}}
 * @throws {UsageError} deploy_options is present but malformed
 */
export function recordedOptions(local) {
  const d = local?.deploy_options;
  if (d === undefined || d === null) return { ...DEFAULT_OPTIONS };
  const bad = (what) => new UsageError(`local config: deploy_options.${what}`);
  if (typeof d !== 'object' || Array.isArray(d)) throw bad('must be an object');
  const out = { ...DEFAULT_OPTIONS };
  if (d.claude_contract !== undefined) {
    if (!CLAUDE_CONTRACT_MODES.includes(d.claude_contract)) throw bad(`claude_contract must be one of ${CLAUDE_CONTRACT_MODES.join(', ')}`);
    out.claude_contract = d.claude_contract;
  }
  if (d.retire_legacy_agents !== undefined) {
    if (typeof d.retire_legacy_agents !== 'boolean') throw bad('retire_legacy_agents must be true or false');
    out.retire_legacy_agents = d.retire_legacy_agents;
  }
  return out;
}

// ---------- desired state ----------

/** Files under dir, relative with / separators, sorted; links are listed, never entered. */
export function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * ~/.claude/CLAUDE.md for the inline mode: the contract text in place of the leading @AGENTS.md line.
 * @param {string} claudeTemplate text of templates/global-claude-CLAUDE.md
 * @param {string} contract text of templates/global-AGENTS.md
 * @returns {string}
 */
export function inlineClaude(claudeTemplate, contract) {
  const lines = claudeTemplate.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || lines[first].trim() !== IMPORT_LINE) {
    throw new UsageError(`templates/global-claude-CLAUDE.md must open with ${IMPORT_LINE}`);
  }
  return [contract.replace(/\s+$/, ''), ...lines.slice(first + 1)].join('\n');
}

/**
 * workflow-rules.md after the merge: an earlier kit block is dropped, the "## Core Rules" section is removed
 * and the kit block goes right after the title. Other sections and the line endings stay. Applying it to
 * its own output gives the same text.
 * @param {string|null} text current file, or null when it does not exist
 * @returns {string}
 */
export function mergeWorkflowRules(text) {
  const src = text === null ? `${WF_DEFAULT_TITLE}\n` : text;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const b = lines.indexOf(WF_BEGIN);
  const e = b >= 0 ? lines.indexOf(WF_END, b) : -1;
  if (b >= 0 && e > b) {
    lines.splice(b, e - b + 1);
    if (lines[b] === '') lines.splice(b, 1);
  }
  const c = lines.findIndex((l) => WF_RETIRED_SECTION.test(l));
  if (c >= 0) {
    let end = c + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    lines.splice(c, end - c);
  }
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  let at = h1 + 1;
  if (h1 >= 0) {
    if (lines[at] === '') at++;
    else lines.splice(at++, 0, '');
  }
  lines.splice(at, 0, WF_BEGIN, ...WF_POINTER, WF_END, '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join(eol) + eol;
}

// ---------- merged targets: settings.json, hooks.json, config.toml ----------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = (v) => JSON.stringify(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A merge that would have to change a value of the wrong type; the plan reports it as a conflict. */
class MergeError extends Error {}

/**
 * Replace the placeholders <node>, <runtime> and <home> in every string of a fragment.
 * @param {*} value parsed fragment
 * @param {{node: string, runtime: string, home: string}} fill absolute paths with / separators
 * @returns {*} a filled copy
 */
export function fillPlaceholders(value, fill) {
  if (typeof value === 'string') return value.replace(/<(node|runtime|home)>/g, (_, k) => fill[k]);
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, fill));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, fill)]));
  return value;
}

/**
 * A Claude permission rule for a folder and everything below it. Claude matches paths in POSIX form and
 * writes absolute paths with a leading //; a Windows drive path C:\x\y becomes //c/x/y (Claude Code
 * permissions docs). Whether the rule really stops the call is part of the deploy smoke matrix (AS3-121).
 * @param {'Edit'|'Read'} tool
 * @param {string} dir absolute folder
 * @returns {string} e.g. Edit(//c/x/y/**)
 */
export function claudePathRule(tool, dir) {
  const s = slash(dir).replace(/\/+$/, '');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  const posix = m ? `//${m[1].toLowerCase()}/${m[2]}` : `/${s}`;
  return `${tool}(${posix.replace(/\/+$/, '')}/**)`;
}

/**
 * A Codex hook command is one string, and which shell Codex runs it in is not known (C0 T-meta: hook_shell
 * null). The only form C0 ran is a bare executable followed by quoted paths (node "<path>" "<path>"); a
 * quoted first word fails under powershell -Command and a plain cmd /c (tried on the dev machine,
 * 2026-10-31; tests/kit/deploy-kit.test.mjs runs the filled command in each). So the Node path that starts
 * the command must be one plain word: no space, no quote, no shell character (a ~ inside the word, as in a
 * Windows short name, is plain). The quoted script path after it may hold spaces.
 */
export const PLAIN_COMMAND_WORD = /^[A-Za-z0-9_.:/+-][A-Za-z0-9_.:/+~-]*$/;

/** True for a hook entry of the kit (its command or args run hooks/guard.mjs or hooks/session-start.mjs). */
export function isKitHook(hook) {
  if (!isObject(hook)) return false;
  const parts = [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])].filter((x) => typeof x === 'string');
  return parts.some((x) => KIT_HOOK_RE.test(x));
}

/**
 * One event's matcher groups after the merge: a group equal to a kit group stays where it is; kit hook
 * entries elsewhere (an older runtime path or Node) are taken out, and a group left empty by that goes;
 * kit groups not present yet are appended. User groups and their order stay.
 * @param {object[]|undefined} existing
 * @param {object[]} kit filled kit groups
 * @returns {object[]}
 */
export function mergeHookGroups(existing, kit) {
  const want = kit.map((g) => ({ g, key: stable(g), used: false }));
  const out = [];
  for (const g of existing ?? []) {
    const w = want.find((x) => !x.used && x.key === stable(g));
    if (w) { w.used = true; out.push(g); continue; }
    if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isKitHook)) { out.push(g); continue; }
    const rest = g.hooks.filter((h) => !isKitHook(h));
    if (rest.length) out.push({ ...g, hooks: rest });
  }
  for (const w of want) if (!w.used) out.push(clone(w.g));
  return out;
}

/** Kit values into cur: objects merged key by key, list entries added when missing, other values set. */
function mergeValue(cur, kit, at) {
  if (isObject(kit)) {
    if (cur === undefined) cur = {};
    if (!isObject(cur)) throw new MergeError(`${at} is not an object`);
    for (const [k, v] of Object.entries(kit)) cur[k] = mergeValue(cur[k], v, at ? `${at}.${k}` : k);
    return cur;
  }
  if (Array.isArray(kit)) {
    if (cur === undefined) cur = [];
    if (!Array.isArray(cur)) throw new MergeError(`${at} is not a list`);
    for (const x of kit) if (!cur.some((y) => stable(y) === stable(x))) cur.push(clone(x));
    return cur;
  }
  return kit;
}

/** The hooks object of a settings or hooks.json file after the merge (per event, mergeHookGroups). */
function mergeHooks(cur, kitHooks) {
  if (cur === undefined) cur = {};
  if (!isObject(cur)) throw new MergeError('hooks is not an object');
  for (const [event, groups] of Object.entries(kitHooks ?? {})) {
    if (cur[event] !== undefined && !Array.isArray(cur[event])) throw new MergeError(`hooks.${event} is not a list`);
    cur[event] = mergeHookGroups(cur[event], groups);
  }
  return cur;
}

/**
 * Deny rules the kit wrote into ~/.claude/settings.json up to 2026-11 and no longer wants there: the ten
 * git push rules. A deny rule in the settings wins over the guard's "ask" (docs/push-consent-probe.md), so
 * with them in place the owner would never get the confirmation dialog for a push (AS3-379). The guard
 * still sees every push; gh writes and npm publish keep their deny rules.
 */
export const RETIRED_CLAUDE_DENY = Object.freeze(['Bash', 'PowerShell'].flatMap((tool) => [
  'git push *', 'git -C * push', 'git -C * push *', 'git -c * push', 'git -c * push *',
].map((rule) => `${tool}(${rule})`)));

/**
 * ~/.claude/settings.json after the merge: the kit keys of the filled fragment are set (env and worktree
 * key by key), its deny rules added where missing, the retired kit deny rules (RETIRED_CLAUDE_DENY) taken
 * out, its hook groups merged (mergeHookGroups). Every other
 * key, permission rule, hook and plugin stays, in its order. Applying it to its own output changes nothing.
 * @param {object|null} current parsed settings, or null when the file does not exist
 * @param {object} fragment filled fragment, deny rules for the local folders included
 * @returns {object}
 * @throws {MergeError} a kit key holds a value of another type
 */
export function mergeClaudeSettings(current, fragment) {
  const out = current === null ? {} : clone(current);
  if (!isObject(out)) throw new MergeError('the file does not hold a JSON object');
  const { hooks, ...rest } = fragment;
  mergeValue(out, rest, '');
  if (Array.isArray(out.permissions?.deny)) out.permissions.deny = out.permissions.deny.filter((rule) => !RETIRED_CLAUDE_DENY.includes(rule));
  if (hooks) out.hooks = mergeHooks(out.hooks, hooks);
  return out;
}

/**
 * ~/.codex/hooks.json after the merge: the kit hook groups are merged (mergeHookGroups), every other key and
 * hook stays; the fragment's description is added only when the file has none.
 * @param {object|null} current parsed file, or null when it does not exist (the fragment is used whole)
 * @param {object} fragment filled config/codex/hooks.json
 * @returns {object}
 * @throws {MergeError}
 */
export function mergeCodexHooks(current, fragment) {
  if (current === null) return clone(fragment);
  const out = clone(current);
  if (!isObject(out)) throw new MergeError('the file does not hold a JSON object');
  for (const [k, v] of Object.entries(fragment)) {
    if (k === 'hooks') out.hooks = mergeHooks(out.hooks, v);
    else if (out[k] === undefined) out[k] = clone(v);
  }
  return out;
}

/**
 * ~/.codex/config.toml after the merge: each key of the fragment is set with toml-edit's setValue, so only
 * those values change; comments, order and every other section stay.
 * @param {string|null} current file text, or null when it does not exist
 * @param {string} fragmentText config/codex/config.fragment.toml
 * @returns {string}
 * @throws {TomlEditError}
 */
export function mergeCodexConfig(current, fragmentText) {
  let text = current ?? '';
  for (const kv of keyValues(fragmentText)) text = setValue(text, kv.path, kv.raw);
  return text;
}

/** Bytes, text and parsed value of a JSON target; error is set when the file exists but does not parse. */
function readJsonTarget(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return { exists: false, raw: null, text: null, value: null }; }
  const text = raw.toString('utf8');
  try { return { exists: true, raw, text, value: JSON.parse(text.replace(/^\uFEFF/, '')) }; } catch (e) {
    return { exists: true, raw, text, value: null, error: `not valid JSON (${e.message}); fix or move it by hand` };
  }
}

/** JSON text in the style of the file it replaces: its indent, line endings and byte-order mark. */
export function jsonLike(value, like) {
  const indent = (like && /^([ \t]+)"/m.exec(like)?.[1]) || '  ';
  const eol = like && like.includes('\r\n') ? '\r\n' : '\n';
  const bom = like && like.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  return bom + JSON.stringify(value, null, indent).replace(/\n/g, eol) + eol;
}

// ---------- target list and project layout ----------

/** The kit's own sources in the repo: contract, Claude entry file and the files of the 7 skills. */
function kitSources(repo) {
  const r = (...p) => path.join(repo, ...p);
  const need = (file) => { if (!fs.existsSync(file)) throw new UsageError(`kit source missing: ${file}`); return file; };
  const skillsDir = need(r('skills'));
  const present = fs.readdirSync(skillsDir).filter((n) => fs.statSync(path.join(skillsDir, n)).isDirectory()).sort();
  if (present.join(',') !== [...KIT_SKILLS].sort().join(',')) {
    throw new UsageError(`skills/ must hold exactly the 7 kit skills (${KIT_SKILLS.join(', ')}); found: ${present.join(', ') || 'none'}`);
  }
  const skills = KIT_SKILLS.flatMap((skill) => listFiles(r('skills', skill)).map((rel) => ({ rel: `${skill}/${rel}`, src: r('skills', skill, ...rel.split('/')) })));
  return { r, need, contract: need(r('templates', 'global-AGENTS.md')), claude: need(r('templates', 'global-claude-CLAUDE.md')), skills };
}

/**
 * The files the kit wants on disk, with their content. Reads the repo, the local config and, for merged
 * files, the current target. Writes nothing.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @param {{claudeContract?: string, repo?: string, local?: object|null}} [opts] local: the parsed local
 *   config; without it only the AS3-112a targets are listed (contract, skills, agent, templates, rules file)
 * @returns {{path: string, content?: Buffer, group: string, mode: 'whole'|'merge', source?: string, reason: string,
 *   conflict?: string}[]} an entry with conflict cannot be planned (a merged file that does not parse)
 * @throws {UsageError} the repo lacks a source, skills/ does not hold exactly the 7 kit skills, or the local
 *   config has no portable_node for the hook commands
 */
export function desiredFiles(roots, { claudeContract = DEFAULT_OPTIONS.claude_contract, repo = KIT_REPO, local = null } = {}) {
  if (!CLAUDE_CONTRACT_MODES.includes(claudeContract)) {
    throw new UsageError(`claude contract mode must be one of ${CLAUDE_CONTRACT_MODES.join(', ')}: ${claudeContract}`);
  }
  const t = targetMap(roots);
  const src = kitSources(repo);
  const { r, need } = src;
  const out = [];
  const copy = (target, source, group, reason) => out.push({ path: target, content: fs.readFileSync(need(source)), group, mode: 'whole', source, reason });

  copy(t.claudeAgentsMd, src.contract, 'contract', 'shared contract (v3 §5: the same text for both platforms)');
  copy(t.codexAgentsMd, src.contract, 'contract', 'shared contract (v3 §5: the same text for both platforms)');
  if (claudeContract === 'inline') {
    const text = inlineClaude(readText(src.claude), readText(src.contract));
    out.push({ path: t.claudeMd, content: Buffer.from(text, 'utf8'), group: 'contract', mode: 'whole', reason: 'Claude entry file with the contract inline (--claude-contract inline)' });
  } else {
    copy(t.claudeMd, src.claude, 'contract', `Claude entry file: ${IMPORT_LINE} plus the Claude-only lines (v3 §5)`);
  }

  for (const base of [t.claudeSkills, t.agentsSkills]) {
    for (const s of src.skills) copy(path.join(base, ...s.rel.split('/')), s.src, 'skills', 'kit skill (ADR-006 §2.7)');
  }

  for (const agent of KIT_AGENTS) {
    copy(path.join(t.claudeAgents, `${agent}.md`), r('config', 'claude', 'agents', `${agent}.md`), 'agents', 'independent verifier (v2 §3.6)');
  }

  for (const rel of listFiles(need(r('templates')))) {
    copy(path.join(t.workflowTemplates, ...rel.split('/')), r('templates', ...rel.split('/')), 'templates', 'kit template (project-plan reads the deployed copies)');
  }

  const current = fs.existsSync(t.workflowRules) ? readText(t.workflowRules) : null;
  out.push({
    path: t.workflowRules, content: Buffer.from(mergeWorkflowRules(current), 'utf8'), group: 'policies', mode: 'merge',
    reason: 'point the shared rules to the contract; the old Core Rules section is removed, other sections stay',
  });
  if (!local) return out;

  // AS3-112b: platform settings, hooks, rules and the runtime area.
  if (!local.portable_node) {
    throw new UsageError(`portable_node is not set in the local config: the hook commands run the portable Node; put a node-v*/ Node under ${slash(roots.runtime)} and run deploy-kit --init-local --runtime <dir>`);
  }
  const fill = { node: slash(local.portable_node), runtime: slash(roots.runtime), home: slash(roots.home) };
  const fragment = (...p) => {
    const file = need(r(...p));
    let v;
    try { v = JSON.parse(readText(file)); } catch (e) { throw new UsageError(`kit source ${file} is not valid JSON: ${e.message}`); }
    const filled = fillPlaceholders(v, fill);
    if (PLACEHOLDER_RE.test(JSON.stringify(filled))) throw new UsageError(`kit source ${file}: a placeholder is left after filling`);
    return filled;
  };
  // A merged JSON file: unchanged content keeps its exact bytes, so formatting alone never shows as a change.
  const mergedJson = (target, cur, merged, extra) => {
    const same = cur.exists && stable(merged) === stable(cur.value);
    out.push({ path: target, content: same ? cur.raw : Buffer.from(jsonLike(merged, cur.text), 'utf8'), ...extra });
  };
  const conflict = (target, group, why) => out.push({ path: target, group, mode: 'merge', conflict: why, reason: why });

  const settingsSrc = r('config', 'claude', 'settings.fragment.json');
  const settings = fragment('config', 'claude', 'settings.fragment.json');
  settings.permissions ??= {};
  settings.permissions.deny = [
    ...(settings.permissions.deny ?? []),
    ...(local.readonly_dirs ?? []).map((d) => claudePathRule('Edit', d)),
    ...(local.customer_data_dirs ?? []).map((d) => claudePathRule('Read', d)),
  ];
  const curSettings = readJsonTarget(t.claudeSettings);
  if (curSettings.error) conflict(t.claudeSettings, 'settings', curSettings.error);
  else {
    try {
      mergedJson(t.claudeSettings, curSettings, mergeClaudeSettings(curSettings.value, settings), {
        group: 'settings', mode: 'merge', source: settingsSrc,
        reason: 'kit settings, deny rules (read-only and customer-data folders from the local config) and hooks; other keys stay',
      });
    } catch (e) {
      if (!(e instanceof MergeError)) throw e;
      conflict(t.claudeSettings, 'settings', `cannot merge: ${e.message}; fix it by hand`);
    }
  }

  const tomlSrc = need(r('config', 'codex', 'config.fragment.toml'));
  const tomlFragment = readText(tomlSrc);
  const curToml = fs.existsSync(t.codexConfig) ? fs.readFileSync(t.codexConfig) : null;
  try {
    const before = curToml === null ? null : curToml.toString('utf8');
    const after = mergeCodexConfig(before, tomlFragment);
    out.push({
      path: t.codexConfig, content: after === before ? curToml : Buffer.from(after, 'utf8'), group: 'codex-config', mode: 'merge', source: tomlSrc,
      reason: `only the fragment keys (${keyValues(tomlFragment).map((kv) => kv.path.join('.')).join(', ')}); comments, order and other sections stay`,
    });
  } catch (e) {
    if (!(e instanceof TomlEditError)) throw e;
    conflict(t.codexConfig, 'codex-config', `cannot edit: ${e.message}; fix it by hand`);
  }

  const hooksSrc = r('config', 'codex', 'hooks.json');
  const codexHooks = fragment('config', 'codex', 'hooks.json');
  const curHooks = readJsonTarget(t.codexHooks);
  if (curHooks.error) conflict(t.codexHooks, 'hooks', curHooks.error);
  else if (!PLAIN_COMMAND_WORD.test(fill.node)) {
    conflict(t.codexHooks, 'hooks', `portable_node ${fill.node} is not one plain word (a space or a shell character): the Codex hook command `
      + 'starts with the bare Node path (ADR-006 §7); move the portable Node to a folder without spaces and update portable_node');
  } else {
    try {
      mergedJson(t.codexHooks, curHooks, mergeCodexHooks(curHooks.value, codexHooks), {
        group: 'hooks', mode: curHooks.exists ? 'merge' : 'whole', source: hooksSrc,
        reason: curHooks.exists ? 'Codex guard hook merged into the existing hooks.json; other hooks stay' : 'Codex guard hook (fails closed: a guard error blocks the call)',
      });
    } catch (e) {
      if (!(e instanceof MergeError)) throw e;
      conflict(t.codexHooks, 'hooks', `cannot merge: ${e.message}; fix it by hand`);
    }
  }
  copy(t.codexRules, r('config', 'codex', 'rules', 'autoskills.rules'), 'rules', 'Codex execpolicy rules for push and publish (a reminder, ADR-006 §2.5)');

  for (const name of KIT_HOOK_SCRIPTS) copy(path.join(t.runtimeHooks, name), r('hooks', name), 'runtime', 'hook script, run by the portable Node from the runtime area');
  const hookConfig = { runtime: slash(roots.runtime), readonly_dirs: (local.readonly_dirs ?? []).map(slash), kit_repo: slash(repo) };
  out.push({
    path: path.join(t.runtimeHooks, HOOK_CONFIG_NAME), content: Buffer.from(`${JSON.stringify(hookConfig, null, 2)}\n`, 'utf8'), group: 'runtime', mode: 'whole',
    reason: 'guard config from the local config: runtime (heartbeat), read-only folders, kit repo',
  });
  return out;
}

/**
 * The kit in the project layout the measurement scripts stage into a test repo (v2 appendix D): paths
 * relative to the stage folder, / separators.
 * @param {string} [repo]
 * @returns {{rel: string, content: Buffer, source: string}[]}
 * @throws {UsageError} a kit source is missing or the Claude entry file does not open with @AGENTS.md
 */
export function stageFiles(repo = KIT_REPO) {
  const src = kitSources(repo);
  if (readText(src.claude).split(/\r?\n/).find((l) => l.trim() !== '')?.trim() !== IMPORT_LINE) {
    throw new UsageError(`templates/global-claude-CLAUDE.md must open with ${IMPORT_LINE}`);
  }
  const contract = fs.readFileSync(src.contract);
  const out = [
    { rel: '.claude/AGENTS.md', content: contract, source: src.contract },
    { rel: '.claude/CLAUDE.md', content: fs.readFileSync(src.claude), source: src.claude },
  ];
  for (const base of ['.claude/skills', '.agents/skills']) {
    for (const s of src.skills) out.push({ rel: `${base}/${s.rel}`, content: fs.readFileSync(s.src), source: s.src });
  }
  out.push({ rel: 'contract/AGENTS.md', content: contract, source: src.contract });
  return out;
}

/**
 * Kit skill folders on the target side; files in them that the repo copy lacks are removed with the deploy
 * (each folder is replaced whole).
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @returns {string[]} absolute folder paths
 */
export function kitSkillDirs(roots) {
  const t = targetMap(roots);
  return [t.claudeSkills, t.agentsSkills].flatMap((base) => KIT_SKILLS.map((s) => path.join(base, s)));
}

/**
 * Old copies to remove and folders that are only listed. Reads directory entries only.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @param {{retireLegacyAgents?: boolean}} [opts]
 * @returns {{remove: {path: string, kind: 'dir'|'file'|'link', files: string[], group: string, reason: string}[],
 *   listed: {path: string, reason: string}[]}}
 */
export function legacyRemovals(roots, { retireLegacyAgents = false } = {}) {
  const t = targetMap(roots);
  const remove = [];
  const listed = [];
  const entry = (p, group, reason) => {
    const st = fs.lstatSync(p);
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    remove.push({ path: p, kind, files: kind === 'dir' ? listFiles(p) : [], group, reason });
  };
  for (const loc of LEGACY_SKILL_DIRS) {
    const base = t[loc.key];
    let names;
    try { names = fs.readdirSync(base).sort(); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('{') && name.includes('project-')) {
        listed.push({ path: path.join(base, name), reason: 'not removed: the name does not start with project- (a failed brace expansion); check-kit warns and names the delete command' });
        continue;
      }
      const hit = loc.select === 'retired' ? RETIRED_SKILLS.includes(name) : /^project-/.test(name);
      if (hit) entry(path.join(base, name), 'legacy-skills', loc.reason);
    }
  }
  if (retireLegacyAgents) {
    for (const agent of LEGACY_AGENTS) {
      const p = path.join(t.claudeAgents, `${agent}.md`);
      if (fs.existsSync(p)) entry(p, 'legacy-agents', 'old agent that calls retired skills (v2 decision 9): archived under _private/deploy/<id>/ first, then removed');
    }
  }
  return { remove, listed };
}
