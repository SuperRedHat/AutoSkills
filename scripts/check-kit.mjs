#!/usr/bin/env node
// check-kit: read-only health check of the AutoSkills kit at the user level (ADR-006 §2.7). Zero
// dependencies (Node >= 18). It prints a PASS, WARN, FAIL table; every FAIL names its fix, which for most
// rows is a new run of deploy-kit.
// lint-kit: allow-legacy check 6 reports old references by name: the retired skills and CouncilFlow
//
// Usage:
//   node scripts/check-kit.mjs [--report-only] [--json] [--home <dir>] [--runtime <dir>] [--projects-root <dir>]
//                              [--local-config <file>]
//
// Roots: the same three roots as deploy-kit (scripts/lib/kit-targets.mjs): --home (default the user
// directory), --runtime and --projects-root (default runtime and projects_root in the local config). The
// local config (default <kit repo>/_private/kit-local.json) gives the read-only and customer-data folders
// the deny rules are generated from and the portable Node; without it those rows cannot be checked and the
// local config row is a FAIL. Tests pass all roots and a local config in a temp dir.
//
// Checks (1-2 from AS3-116a, 3-6 from AS3-116b):
//   1. Effective config (v2 §3.5/§3.6, ADR-006 §2.5/§2.6):
//      Claude  every kit key of config/claude/settings.fragment.json (worktree.baseRef, subagentPromptCacheTtl,
//              env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS) as Claude sees it: managed settings win over
//              ~/.claude/settings.json. The fragment's deny rules by kind (Bash, PowerShell, outbound MCP tools)
//              plus Edit and Read rules for the folders of the local config. Every kit hook group of the
//              fragment registered with its matcher, the guard with onFailure: block, and for every kit hook
//              entry the executable and the script exist (a guard whose script is gone blocks every call).
//      Effort  CLAUDE_CODE_EFFORT_LEVEL (any value overrides the effort a subagent asks for) must be absent from
//              the process environment, the user and machine environment in the registry (HKCU, HKLM) and the
//              env of every settings level: managed, ~/.claude/settings.json and settings.local.json, and
//              .claude/settings.json and settings.local.json of the projects root and of each project in it.
//      Codex   every key of config/codex/config.fragment.toml (model_reasoning_effort, desktop.followUpQueueMode),
//              no agents.default_subagent_reasoning_effort, the guard in ~/.codex/hooks.json with an existing
//              executable and script, ~/.codex/rules/autoskills.rules equal to the repo copy, and a
//              project-manager entry under mcp_servers whose script exists.
//   2. Versions: Claude Code, the Codex desktop app (Appx package) and the codex.exe inside it, the codex that
//      PATH resolves to (WARN when it is the npm package or older than the desktop app's), the system and the
//      portable Node, git, and the SHA-256 of the deployed project-manager dist/index.js (1.5.1 starts with
//      dfe5f8a6; another build is a WARN, a missing one a FAIL). A missing tool is a WARN.
//   3. Skill copies and agent definitions (v2 §3.6, ADR-006 §2.7), compared by name across ~/.claude/skills,
//      ~/.agents/skills, ~/.codex/skills, ~/.gemini/skills, ~/.codex/agents/skills and ~/.workflow-core/skills:
//      the 7 kit skills in ~/.claude/skills and ~/.agents/skills each equal to the repo folder (file set and
//      bytes); the contract files equal to what deploy-kit writes in the recorded claude_contract mode; a
//      retired skill in ~/.claude/skills or ~/.agents/skills, or any project-* copy in the other four, is a
//      FAIL (an old copy or a duplicate). ~/.claude/agents/project-verifier.md must exist and equal the repo
//      copy. The neutral profile of deploy-kit (contract files holding NEUTRAL_MARKER, or a neutral journal
//      in place) is a FAIL that names --rollback <neutral id>, a WARN under --report-only; the contract and
//      kit skill rows are left out while it is in place (they are parked). WARN only, each with a delete
//      command you may run or not: folders whose name starts with "{" (a failed brace expansion), files in
//      ~/.workflow-core/templates/ the kit no longer ships (such as global-codex-AGENTS.md), and the 3 old
//      agents that --retire-legacy-agents archives.
//   4. Hooks: for every hook script and platform the fragments register (config/claude/settings.fragment.json,
//      config/codex/hooks.json), the last heartbeat in <runtime>/hooks/heartbeat/<hook>.jsonl. None at all is
//      a FAIL (the hook never ran); one older than HEARTBEAT_STALE_DAYS is a FAIL for the guard (it fails
//      closed on both platforms, so a guard that stopped running is a fault) and a WARN for session-start.
//      The Codex hook trust per kit handler of ~/.codex/hooks.json, read where C0 found it in config.toml
//      ([hooks.state.'<hooks.json>:<event>:<group>:<handler>'] trusted_hash): trusted (已信任) or not trusted
//      (未信任); any untrusted handler is a WARN, the hash is never checked. The deployed guard's
//      --selftest runs its built-in samples (no stdin, no config, no heartbeat) with the portable Node;
//      anything but "guard selftest: ok" is a FAIL. From AS3-125: the deployed <runtime>/hooks/
//      hook-config.json must parse by the guard's own rules (a JSON object, runtime and kit_repo absolute,
//      readonly_dirs a list of absolute paths) and hold only the keys deploy-kit writes; one the guard
//      cannot load makes it exit 2 on every run, so every matched call is blocked. And the guard command
//      lines registered in ~/.claude/settings.json and ~/.codex/hooks.json run as the platform would run
//      them, once with a synthetic allow input (git status: exit 0, no output) and once with a synthetic
//      deny input (git push: the deny JSON). Claude's command and args start directly; Codex's string runs
//      in each shell it may use (C0 could not tell which): cmd /d /s /c, cmd /c, Windows PowerShell
//      -Command and bash -c when bash is on PATH (sh -c off Windows). A guard that does not start exits with
//      another code than 2, and Codex lets the call through (ADR-006 §4), so any wrong run is a FAIL.
//      Before a deploy both rows are a WARN that reads 未部署 (not deployed): the command-line row when no
//      guard is registered on either platform, the config row when neither the file nor a deployed or
//      registered guard is there.
//   5. pushurl: every repository with remotes under the projects root has pushurl = no_push in its repo
//      config. The scan is set-pushurl's own (planRepos: lstat walk, links never entered, worktrees once,
//      measurement repos skipped); repos in a read-only folder are reported as skipped (跳过), a WARN.
//   6. Project rule files: CLAUDE.md, AGENTS.md, AGENTS.override.md and .claude/CLAUDE.md of the projects
//      root, of each folder in it and of each repository the scan finds. Lines that name a retired skill
//      or CouncilFlow (or council) are listed with a one-line replacement each, as a WARN. Nothing is
//      changed; set_project_dir stays valid in batch 1 and is not reported.
//
// Read only: nothing under the roots is written. CLIs are started only for --version, with
// DISABLE_AUTOUPDATER=1 so none of them updates itself, and codex with CODEX_HOME pointed at an OS temp dir
// (codex writes helper files under its home on every start) that is removed afterwards; an npm package's
// version is read from its package.json instead of running it. Codex's SQLite files are never opened. The
// registry and the Appx package are read through PowerShell's structured output (ConvertTo-Json; only value
// names and error type names, no localized text). Environment values and secrets are never printed: the
// environment rows name where a variable is set, not its value. The pushurl scan runs only reading git
// commands (rev-parse, remote, config --get-all); the guard runs with --selftest and, for the command-line
// row, on synthetic stdin only, in an OS temp dir and with AUTOSKILLS_GUARD_PROBE=1 so it writes no
// heartbeat (a live run must not pass for a real tool call); it only decides, it never runs the command.
//
// Exit codes: 0 = no FAIL, or --report-only (always 0; for the state before a deploy). 1 = at least one
// FAIL. 2 = usage error (unknown option, empty path, a local config that exists but cannot be read).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  KIT_REPO, DEFAULT_LOCAL_CONFIG, KIT_HOOK_SCRIPTS, HOOK_CONFIG_NAME, KIT_SKILLS, RETIRED_SKILLS, KIT_AGENTS, LEGACY_AGENTS, LEGACY_SKILL_DIRS,
  DEFAULT_OPTIONS, UsageError, targetMap, readLocalConfig, recordedOptions, desiredFiles, listFiles, claudePathRule, isKitHook,
  slash, pathKey, within,
} from './lib/kit-targets.mjs';
import { keyValues, getValue, TomlEditError } from './lib/toml-edit.mjs';
import { PROBE_ENV } from '../hooks/guard.mjs';
import { isNeutralText, neutralsInPlace, deployRootOf } from './deploy-kit.mjs';
import { planRepos, scanRepos, DEFAULT_DEPTH, NO_PUSH } from './set-pushurl.mjs';

const USAGE = 'usage: node scripts/check-kit.mjs [--report-only] [--json] [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]';

const SELF = fileURLToPath(import.meta.url);
const WIN = process.platform === 'win32';
export const STATUSES = ['PASS', 'WARN', 'FAIL'];
export const EFFORT_VAR = 'CLAUDE_CODE_EFFORT_LEVEL';
// SHA-256 of dist/index.js of project-manager 1.5.1, the ledger build of batch 1 (ADR-006: not changed in batch 1).
export const PM_SHA256_PREFIX = 'dfe5f8a6';
const PM_VERSION = '1.5.1';
// Kept unset so subagents follow the main thread's effort (v2 §3.6); deploy-kit never writes it, so it never removes it.
const CODEX_FORBIDDEN_KEY = ['agents', 'default_subagent_reasoning_effort'];
const PM_SERVER_NAMES = ['project-manager', 'project_manager'];
const MAX_LISTED = 4;
const VERSION_TIMEOUT_MS = 30_000;
const SELFTEST_TIMEOUT_MS = 60_000;
// The live run of a guard command line: the hook's own timeout (seconds) when set, at most this.
const PROBE_TIMEOUT_MS = 60_000;
// The synthetic inputs of the live run: a harmless shell command the guard allows and a push it denies.
// The guard only reads them; neither command is ever run.
export const PROBE_COMMANDS = { allow: 'git status', deny: 'git push origin main' };
// The keys deploy-kit writes into <runtime>/hooks/hook-config.json (kit-targets desiredFiles).
export const HOOK_CONFIG_KEYS = ['runtime', 'readonly_dirs', 'kit_repo'];
// A heartbeat older than this is reported (WARN), never a FAIL: the hook did run once.
export const HEARTBEAT_STALE_DAYS = 7;
// The folders check 3 compares by name (v2 §3.6): the two the kit deploys to, then the old copy locations.
const SKILL_BASES = ['claudeSkills', 'agentsSkills', 'codexSkills', 'geminiSkills', 'codexAgentSkills', 'workflowSkills'];
// Project rule files check 6 reads in each project folder.
const RULE_FILES = [['CLAUDE.md'], ['AGENTS.md'], ['AGENTS.override.md'], ['.claude', 'CLAUDE.md']];
// What replaces each retired name (ADR-006 §2.2, §2.3): one line per hit in check 6.
const REPLACEMENTS = {
  'project-ask': 'ask in the chat; for a second opinion use project-consult',
  'project-discuss': 'project-consult (a prompt file for an outside model)',
  'project-init': 'project-plan (it took over init, design and change)',
  'project-design': 'project-plan (it took over init, design and change)',
  'project-change': 'project-plan (it took over init, design and change)',
  'project-review': 'the platform\'s own review command; risky tasks get the project-verifier check in project-next',
  councilflow: 'drop it (retired in AutoSkills 3.0); for a second opinion use project-consult',
};
const OLD_REFERENCES = [
  { key: 'councilflow', re: /councilflow/gi },
  // The council command or its .council folder (the same reading as lint-kit's legacy group).
  { key: 'councilflow', re: /(?<![A-Za-z])council(?!flow)/gi },
  { key: null, re: new RegExp(`(?<![A-Za-z0-9_-])(?:${RETIRED_SKILLS.join('|')})(?![A-Za-z0-9_-])`, 'g') },
];
const LINE_SHOWN = 120;

// ---------- small helpers ----------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const getAt = (v, p) => p.reduce((o, k) => (isObject(o) ? o[k] : undefined), v);

/** The value of an environment variable, looked up without regard to case on Windows. */
function envGet(env, name) {
  if (!WIN) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Bytes, parsed value and error of a JSON file; exists false when it cannot be read at all. */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { exists: false, value: null }; }
  try { return { exists: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) }; } catch (e) {
    return { exists: true, value: null, error: `not valid JSON (${e.message})` };
  }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** At most MAX_LISTED items, then the count of the rest. */
function listSome(items) {
  const head = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${head} (+${items.length - MAX_LISTED} more)` : head;
}

/** The value of a TOML literal when it is a plain string or a scalar; the literal itself otherwise. */
function tomlScalar(raw) {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (/^'[^']*'$/.test(s)) return s.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
}

/** The strings of a TOML literal (a string or an array of strings), in order. */
export function tomlStrings(raw) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  for (let m = re.exec(raw ?? ''); m; m = re.exec(raw)) {
    if (m[2] !== undefined) out.push(m[2]);
    else { try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); } }
  }
  return out;
}

/** The tokens of a command line: double-quoted parts without their quotes, the rest split at spaces. */
export function commandTokens(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(line ?? ''); m; m = re.exec(line)) out.push(m[1] ?? m[2]);
  return out;
}

/** Major, minor and patch of the first x.y.z in a version text, or null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? m.slice(1, 4).map(Number) : null;
}

/** <0, 0 or >0 like a sort comparator; null when either side has no version. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// ---------- context ----------

/**
 * Roots, target map and local config for one run. Unlike deploy-kit, a missing local config or root is not
 * an error here: the rows that need it say so.
 * @param {{home?: string, runtime?: string, projectsRoot?: string, localConfig?: string}} cli
 * @returns {{roots: object, t: object, local: object|null, localConfig: string, localError: string|null, rootArgs: string}}
 * @throws {UsageError} the local config exists but cannot be read
 */
export function makeContext(cli = {}) {
  const localConfig = path.resolve(cli.localConfig ?? DEFAULT_LOCAL_CONFIG);
  let local = null;
  let localError = null;
  if (fs.existsSync(localConfig)) local = readLocalConfig(localConfig);
  else localError = 'not found';
  const pick = (flag, key) => (flag ? path.resolve(flag) : local?.[key] ? path.resolve(local[key]) : null);
  const roots = { home: path.resolve(cli.home || os.homedir()), runtime: pick(cli.runtime, 'runtime'), projectsRoot: pick(cli.projectsRoot, 'projects_root') };
  // The target map needs all three roots; the checks of this script use only its home targets.
  const t = targetMap({ home: roots.home, runtime: roots.runtime ?? roots.home, projectsRoot: roots.projectsRoot ?? roots.home });
  // The fixes repeat the root options this run was given, so they act on the same targets.
  const q = (p) => `"${slash(p)}"`;
  const rootArgs = [
    cli.home ? ` --home ${q(cli.home)}` : '', cli.runtime ? ` --runtime ${q(cli.runtime)}` : '',
    cli.projectsRoot ? ` --projects-root ${q(cli.projectsRoot)}` : '', cli.localConfig ? ` --local-config ${q(cli.localConfig)}` : '',
  ].join('');
  // deploy-kit --rollback takes only the local config, not the roots (the journal holds them).
  const localArg = cli.localConfig ? ` --local-config ${q(cli.localConfig)}` : '';
  return { roots, t, local, localConfig, localError, rootArgs, localArg };
}

/** The path as shown: ~/... under home, <runtime>/... and <projects>/... under those roots, else absolute. */
function shown(p, roots) {
  const rel = (root, label) => {
    const r = path.relative(root, p);
    return r === '' ? label : `${label}/${r.split(path.sep).join('/')}`;
  };
  if (within(p, roots.home)) return rel(roots.home, '~');
  if (roots.runtime && within(p, roots.runtime)) return rel(roots.runtime, '<runtime>');
  if (roots.projectsRoot && within(p, roots.projectsRoot)) return rel(roots.projectsRoot, '<projects>');
  return slash(p);
}

const deployFix = (ctx) => `re-run deploy-kit: node scripts/deploy-kit.mjs --apply${ctx.rootArgs} (preview with --dry-run)`;

/**
 * Collects the rows of one section. A FAIL always carries its fix; a WARN may carry one (a delete command
 * you may run or not). lines: further lines listed under the row (check 6).
 */
function section(name) {
  const rows = [];
  const add = (status, id, item, detail, fix, lines) => rows.push({
    section: name, id, item, status, detail, ...(status === 'FAIL' || fix ? { fix } : {}), ...(lines?.length ? { lines } : {}),
  });
  return { rows, pass: (...a) => add('PASS', ...a), warn: (...a) => add('WARN', ...a), fail: (...a) => add('FAIL', ...a) };
}

function readFragment(...p) {
  const file = path.join(KIT_REPO, ...p);
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new UsageError(`kit source ${slash(file)} cannot be read: ${e.message}`);
  }
}

// ---------- PATH lookup ----------

/**
 * The first file PATH resolves a command name to (Windows: each folder tried with the PATHEXT endings).
 * @param {string} name
 * @param {object} [env]
 * @returns {string|null}
 */
export function findOnPath(name, env = process.env) {
  const exts = WIN ? (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const raw of (envGet(env, 'PATH') || '').split(path.delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** The npm package version behind a PATH hit when it is an npm shim (the shim's folder holds the package), else null. */
export function npmPackageVersion(hit, pkg) {
  if (!hit || path.extname(hit).toLowerCase() === '.exe') return null;
  const manifest = readJson(path.join(path.dirname(hit), 'node_modules', ...pkg.split('/'), 'package.json'));
  return manifest.value && typeof manifest.value.version === 'string' ? manifest.value.version : null;
}

// ---------- check 1: effective config ----------

/** Every leaf of a settings fragment outside permissions and hooks, as [path, value]. */
function fragmentLeaves(value, at = []) {
  if (!isObject(value)) return [[at, value]];
  return Object.entries(value).filter(([k]) => at.length || (k !== 'permissions' && k !== 'hooks')).flatMap(([k, v]) => fragmentLeaves(v, [...at, k]));
}

/** The command parts of a hook entry: the executable and the kit scripts it runs. */
export function hookParts(hook) {
  const tokens = Array.isArray(hook?.args) ? [hook.command, ...hook.args] : commandTokens(hook?.command);
  const strings = tokens.filter((x) => typeof x === 'string');
  const scripts = strings.filter((x) => KIT_HOOK_SCRIPTS.includes(path.basename(x)) && path.basename(path.dirname(x)) === 'hooks');
  return { exe: strings[0] ?? null, scripts };
}

/** Paths a hook entry needs that do not exist (an executable given by name is looked up on PATH). */
function missingHookPaths(hook) {
  const { exe, scripts } = hookParts(hook);
  const missing = [];
  if (!exe) missing.push('(no command)');
  else if (path.isAbsolute(exe) ? !isFile(exe) : !findOnPath(exe)) missing.push(exe);
  for (const s of scripts) if (!isFile(s)) missing.push(s);
  return missing;
}

/** Every kit hook entry of a hooks object (settings.json or hooks.json), with its event. */
function kitHookEntries(hooks) {
  const out = [];
  if (!isObject(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isKitHook(h)) out.push({ event, matcher: g.matcher, hook: h });
    }
  }
  return out;
}

/** Managed settings files Claude Code reads on this platform (the highest settings level). */
export function managedSettingsFiles(env = process.env) {
  if (WIN) {
    const dirs = [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramData')].filter(Boolean);
    return dirs.map((d) => path.join(d, 'ClaudeCode', 'managed-settings.json'));
  }
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

/** .claude/settings.json and settings.local.json of the projects root and of each folder in it (links not entered). */
export function projectSettingsFiles(projectsRoot) {
  if (!projectsRoot) return [];
  const dirs = [projectsRoot];
  let entries = [];
  try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { /* absent */ }
  for (const e of entries) if (e.isDirectory()) dirs.push(path.join(projectsRoot, e.name));
  return dirs.flatMap((d) => ['settings.json', 'settings.local.json'].map((n) => path.join(d, '.claude', n))).filter(isFile);
}

function claudeChecks(ctx, sec, { managed }) {
  const { t, local } = ctx;
  const s = (p) => shown(p, ctx.roots);
  const fragment = readFragment('config', 'claude', 'settings.fragment.json');
  const user = readJson(t.claudeSettings);
  if (!user.exists) sec.fail('claude.settings', 'Claude settings.json', `${s(t.claudeSettings)} does not exist`, deployFix(ctx));
  else if (user.error) sec.fail('claude.settings', 'Claude settings.json', `${s(t.claudeSettings)} is ${user.error}`, `fix the JSON by hand, then ${deployFix(ctx)}`);
  const settings = isObject(user.value) ? user.value : {};
  const managedValues = managed.map((f) => ({ file: f, ...readJson(f) })).filter((m) => m.exists && isObject(m.value));

  // Kit keys, as Claude resolves them: a managed settings file wins over the user file.
  for (const [keyPath, want] of fragmentLeaves(fragment)) {
    const key = keyPath.join('.');
    const env = keyPath[0] === 'env';
    const over = managedValues.find((m) => getAt(m.value, keyPath) !== undefined);
    const got = over ? getAt(over.value, keyPath) : getAt(settings, keyPath);
    const where = over ? `managed settings ${s(over.file)}` : s(t.claudeSettings);
    // env values are never printed; the row says only whether the kit value is there.
    const value = (v) => (env ? 'another value' : JSON.stringify(v));
    if (JSON.stringify(got) === JSON.stringify(want)) sec.pass(`claude.${key}`, `Claude ${key}`, `${env ? 'the kit value' : JSON.stringify(got)} (${where})`);
    else if (over) sec.fail(`claude.${key}`, `Claude ${key}`, `${where} sets ${value(got)}; the kit sets ${JSON.stringify(want)}`, `change it in ${s(over.file)} (managed settings win over the user file; needs an administrator)`);
    else sec.fail(`claude.${key}`, `Claude ${key}`, got === undefined ? `not set in ${where}; the kit sets ${JSON.stringify(want)}` : `${where} sets ${value(got)}; the kit sets ${JSON.stringify(want)}`, deployFix(ctx));
  }

  // Deny rules by kind: the fragment's, plus the folder rules deploy-kit generates from the local config.
  const have = new Set(Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : []);
  const kitDeny = fragment.permissions?.deny ?? [];
  const kinds = [
    ['bash', 'Claude deny: Bash forms', kitDeny.filter((r) => r.startsWith('Bash('))],
    ['powershell', 'Claude deny: PowerShell forms', kitDeny.filter((r) => r.startsWith('PowerShell('))],
    ['mcp', 'Claude deny: outbound MCP tools', kitDeny.filter((r) => r.startsWith('mcp__'))],
  ];
  for (const [kind, item, want] of kinds) {
    const missing = want.filter((r) => !have.has(r));
    if (!missing.length) sec.pass(`claude.deny.${kind}`, item, `${want.length} rule(s) present`);
    else sec.fail(`claude.deny.${kind}`, item, `${missing.length} of ${want.length} missing: ${listSome(missing)}`, deployFix(ctx));
  }
  const folders = [
    ['readonly', 'Claude deny: read-only folders', 'Edit', 'readonly_dirs'],
    ['customer', 'Claude deny: customer-data folders', 'Read', 'customer_data_dirs'],
  ];
  for (const [kind, item, tool, key] of folders) {
    if (!local) { sec.warn(`claude.deny.${kind}`, item, 'no local config: the folders are not known'); continue; }
    const want = local[key].map((d) => claudePathRule(tool, d));
    const missing = want.filter((r) => !have.has(r));
    if (!want.length) sec.pass(`claude.deny.${kind}`, item, `none registered in the local config (${key})`);
    else if (!missing.length) sec.pass(`claude.deny.${kind}`, item, `${want.length} ${tool} rule(s) present`);
    else sec.fail(`claude.deny.${kind}`, item, `${missing.length} of ${want.length} missing: ${listSome(missing)}`, deployFix(ctx));
  }

  // Hook registration: each kit group of the fragment under its event and matcher, the guard with onFailure: block.
  const entries = kitHookEntries(settings.hooks);
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    for (const g of groups) {
      for (const want of g.hooks ?? []) {
        const script = hookParts(want).scripts.map((x) => path.basename(x))[0];
        const id = `claude.hook.${event}.${script}${g.matcher?.includes('project-manager') ? '.project-manager' : ''}`;
        const item = `Claude hook ${event} ${script} (${g.matcher})`;
        const found = entries.filter((e) => e.event === event && e.matcher === g.matcher && hookParts(e.hook).scripts.some((x) => path.basename(x) === script));
        if (!found.length) { sec.fail(id, item, 'not registered', deployFix(ctx)); continue; }
        if (want.onFailure === 'block' && !found.every((e) => e.hook.onFailure === 'block')) {
          sec.fail(id, item, 'registered without onFailure: "block" (an error in the guard would let the call through)', deployFix(ctx));
          continue;
        }
        sec.pass(id, item, `registered${want.onFailure === 'block' ? ' with onFailure: "block"' : ''}`);
      }
    }
  }
  const broken = entries.flatMap((e) => missingHookPaths(e.hook).map((p) => `${e.event}: ${s(p)}`));
  if (!entries.length) sec.fail('claude.hook.paths', 'Claude hook executables and scripts', 'no kit hook entry in settings.json', deployFix(ctx));
  else if (broken.length) {
    sec.fail('claude.hook.paths', 'Claude hook executables and scripts', `missing: ${listSome([...new Set(broken)])} (a guard with onFailure: "block" whose files are gone blocks every call)`, deployFix(ctx));
  } else sec.pass('claude.hook.paths', 'Claude hook executables and scripts', `${entries.length} kit hook entr${entries.length === 1 ? 'y' : 'ies'}: executable and script exist`);
}

function effortChecks(ctx, sec, { env, facts, managed }) {
  const s = (p) => shown(p, ctx.roots);
  const item = (where) => `${EFFORT_VAR} not set: ${where}`;
  if (envGet(env, EFFORT_VAR) !== undefined) {
    sec.fail('effort.process', item('process environment'), 'set in the environment check-kit runs in (the value is not shown)',
      'remove it where it is set (a shell profile, a launcher script, or the registry rows below), then open a new terminal');
  } else sec.pass('effort.process', item('process environment'), 'not set');

  const reg = [
    ['hkcu', 'HKCU (user environment)', "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_EFFORT_LEVEL', $null, 'User') in PowerShell, then open a new terminal"],
    ['hklm', 'HKLM (machine environment)', "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_EFFORT_LEVEL', $null, 'Machine') in an administrator PowerShell, then open a new terminal"],
  ];
  for (const [key, where, fix] of reg) {
    if (!WIN && !facts.registry) { sec.pass(`effort.${key}`, item(where), 'not Windows: no registry'); continue; }
    const v = facts.registry?.[key];
    if (v === true) sec.fail(`effort.${key}`, item(where), 'set (the value is not shown)', fix);
    else if (v === false) sec.pass(`effort.${key}`, item(where), 'not set');
    else sec.warn(`effort.${key}`, item(where), `unknown: the registry could not be read${facts.registry_error ? ` (${facts.registry_error})` : ''}`);
  }

  const files = [ctx.t.claudeSettings, path.join(ctx.t.claudeDir, 'settings.local.json'), ...managed, ...projectSettingsFiles(ctx.roots.projectsRoot)];
  const set = [];
  const unreadable = [];
  let read = 0;
  for (const f of files) {
    const j = readJson(f);
    if (!j.exists) continue;
    if (j.error) { unreadable.push(s(f)); continue; }
    read++;
    if (isObject(j.value?.env) && Object.keys(j.value.env).some((k) => k.toUpperCase() === EFFORT_VAR)) set.push(s(f));
  }
  const scope = `user, managed and project settings${ctx.roots.projectsRoot ? '' : ' (no projects root: project settings not scanned)'}`;
  if (set.length) {
    sec.fail('effort.settings', item('env of the settings files'), `set in ${listSome(set)} (the value is not shown)`, `remove env.${EFFORT_VAR} from ${listSome(set)}`);
  } else if (unreadable.length) {
    sec.warn('effort.settings', item('env of the settings files'), `not set in ${read} file(s); could not parse ${listSome(unreadable)}`);
  } else sec.pass('effort.settings', item('env of the settings files'), `not set in ${read} file(s) (${scope})`);
}

function codexChecks(ctx, sec) {
  const { t } = ctx;
  const s = (p) => shown(p, ctx.roots);
  const fragmentText = fs.readFileSync(path.join(KIT_REPO, 'config', 'codex', 'config.fragment.toml'), 'utf8');
  let text = null;
  let scanError = null;
  try { text = fs.readFileSync(t.codexConfig, 'utf8'); } catch { /* missing */ }
  if (text !== null) {
    try { keyValues(text); } catch (e) {
      if (!(e instanceof TomlEditError)) throw e;
      scanError = e.message;
    }
  }
  const missingConfig = text === null ? `${s(t.codexConfig)} does not exist` : scanError ? `${s(t.codexConfig)} cannot be read (${scanError})` : null;

  for (const kv of keyValues(fragmentText)) {
    const key = kv.path.join('.');
    const want = tomlScalar(kv.raw);
    if (missingConfig) { sec.fail(`codex.${key}`, `Codex ${key}`, missingConfig, deployFix(ctx)); continue; }
    const got = tomlScalar(getValue(text, kv.path));
    if (got === want) sec.pass(`codex.${key}`, `Codex ${key}`, JSON.stringify(got));
    else sec.fail(`codex.${key}`, `Codex ${key}`, got === undefined ? `not set; the kit sets ${JSON.stringify(want)}` : `${JSON.stringify(got)}; the kit sets ${JSON.stringify(want)}`, deployFix(ctx));
  }

  const forbidden = CODEX_FORBIDDEN_KEY.join('.');
  if (missingConfig && scanError) sec.fail(`codex.${forbidden}`, `Codex ${forbidden} not set`, missingConfig, `fix ${s(t.codexConfig)} by hand`);
  else if (!missingConfig && getValue(text, CODEX_FORBIDDEN_KEY) !== undefined) {
    sec.fail(`codex.${forbidden}`, `Codex ${forbidden} not set`, `set to ${getValue(text, CODEX_FORBIDDEN_KEY).trim()}: subagents would not follow the main thread's effort (ultra would drop to it)`,
      `delete ${CODEX_FORBIDDEN_KEY[1]} from the [${CODEX_FORBIDDEN_KEY[0]}] table of ${s(t.codexConfig)} (deploy-kit does not remove keys)`);
  } else sec.pass(`codex.${forbidden}`, `Codex ${forbidden} not set`, 'not set');

  // hooks.json: the guard, failing closed like on Claude (exit 2 with a reason blocks the call, ADR-006 §7).
  const hooks = readJson(t.codexHooks);
  const guardItem = 'Codex hooks.json guard';
  if (!hooks.exists) sec.fail('codex.hooks', guardItem, `${s(t.codexHooks)} does not exist`, deployFix(ctx));
  else if (hooks.error) sec.fail('codex.hooks', guardItem, `${s(t.codexHooks)} is ${hooks.error}`, `fix the JSON by hand, then ${deployFix(ctx)}`);
  else {
    const entries = kitHookEntries(hooks.value?.hooks);
    const guards = entries.filter((e) => e.event === 'PreToolUse' && hookParts(e.hook).scripts.some((x) => path.basename(x) === 'guard.mjs'));
    const broken = entries.flatMap((e) => missingHookPaths(e.hook).map((p) => s(p)));
    if (!guards.length) sec.fail('codex.hooks', guardItem, 'no PreToolUse entry runs hooks/guard.mjs', deployFix(ctx));
    else if (broken.length) sec.fail('codex.hooks', guardItem, `missing: ${listSome([...new Set(broken)])}`, deployFix(ctx));
    else sec.pass('codex.hooks', guardItem, `registered (${guards.length} PreToolUse entr${guards.length === 1 ? 'y' : 'ies'}); executable and script exist`);
  }

  // Rules file: the same bytes as the repo copy.
  const repoRules = fs.readFileSync(path.join(KIT_REPO, 'config', 'codex', 'rules', 'autoskills.rules'));
  let rules = null;
  try { rules = fs.readFileSync(t.codexRules); } catch { /* missing */ }
  if (rules === null) sec.fail('codex.rules', 'Codex rules file', `${s(t.codexRules)} does not exist`, deployFix(ctx));
  else if (!rules.equals(repoRules)) sec.fail('codex.rules', 'Codex rules file', `${s(t.codexRules)} differs from config/codex/rules/autoskills.rules`, deployFix(ctx));
  else sec.pass('codex.rules', 'Codex rules file', `${s(t.codexRules)} matches the repo`);

  // project-manager registration (deploy-kit does not touch it; bootstrap registers it).
  const regFix = 'register project-manager 1.5.1: scripts/bootstrap.ps1 (or bootstrap.sh) runs codex mcp add from mcp-manifest.json';
  if (missingConfig) { sec.fail('codex.project-manager', 'Codex project-manager registration', missingConfig, regFix); return; }
  const kvs = keyValues(text);
  const name = PM_SERVER_NAMES.find((n) => kvs.some((e) => e.path[0] === 'mcp_servers' && e.path[1] === n));
  if (!name) { sec.fail('codex.project-manager', 'Codex project-manager registration', `no [mcp_servers.project-manager] in ${s(t.codexConfig)}`, regFix); return; }
  const command = tomlScalar(getValue(text, ['mcp_servers', name, 'command']));
  const scripts = tomlStrings(getValue(text, ['mcp_servers', name, 'args'])).filter((a) => /\.[cm]?js$/i.test(a));
  const missing = [
    ...(!command ? ['(no command)'] : path.isAbsolute(command) ? (isFile(command) ? [] : [command]) : (findOnPath(command) ? [] : [command])),
    ...scripts.filter((a) => !isFile(path.resolve(a))),
  ];
  if (missing.length) sec.fail('codex.project-manager', 'Codex project-manager registration', `[mcp_servers.${name}] points to missing ${listSome(missing.map((p) => (path.isAbsolute(p) ? s(p) : p)))}`, regFix);
  else sec.pass('codex.project-manager', 'Codex project-manager registration', `[mcp_servers.${name}]: ${command}${scripts.length ? ` ${scripts.map((a) => s(path.resolve(a))).join(' ')}` : ''}`);
}

// ---------- check 2: versions ----------

// Registry and Appx through PowerShell, printed as JSON by PowerShell itself: only whether the variable's name
// is among the value names (never its value), the package's name, version and folder, and the .NET type name
// of an error. Nothing localized is read.
const PS_FACTS = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  `$n = '${EFFORT_VAR}'`,
  '$r = [ordered]@{ hkcu = $null; hklm = $null; registry_error = $null; appx = @(); appx_error = $null }',
  "try { $r.hkcu = @((Get-Item -LiteralPath 'HKCU:\\Environment').GetValueNames()) -contains $n } catch { $r.registry_error = $_.Exception.GetType().Name }",
  "try { $r.hklm = @((Get-Item -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').GetValueNames()) -contains $n } catch { $r.registry_error = $_.Exception.GetType().Name }",
  "try { $r.appx = @(Get-AppxPackage -Name 'OpenAI.Codex' | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; version = [string]$_.Version; install_location = [string]$_.InstallLocation } }) } catch { $r.appx_error = $_.Exception.GetType().Name }",
  'ConvertTo-Json -InputObject ([pscustomobject]$r) -Compress -Depth 4',
].join('; ');

/**
 * Registry and Appx facts on Windows, from PowerShell's structured output. Reads only.
 * @returns {{registry: {hkcu: boolean|null, hklm: boolean|null}|null, registry_error?: string, appx: {name: string,
 *   version: string, install_location: string}[], appx_error?: string}}
 */
export function windowsFacts() {
  if (!WIN) return { registry: null, appx: [], appx_error: 'not Windows' };
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_FACTS],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  let v = null;
  try { v = r.status === 0 ? JSON.parse(r.stdout.trim()) : null; } catch { v = null; }
  if (!v) {
    const why = r.error ? r.error.code || 'spawn error' : `powershell.exe exit ${r.status}`;
    return { registry: null, registry_error: why, appx: [], appx_error: why };
  }
  const appx = v.appx == null ? [] : Array.isArray(v.appx) ? v.appx : [v.appx];
  return {
    registry: { hkcu: typeof v.hkcu === 'boolean' ? v.hkcu : null, hklm: typeof v.hklm === 'boolean' ? v.hklm : null },
    ...(v.registry_error ? { registry_error: v.registry_error } : {}),
    appx, ...(v.appx_error ? { appx_error: v.appx_error } : {}),
  };
}

/**
 * The first output line of `<file> --version`. Every run gets DISABLE_AUTOUPDATER=1; codex also gets a
 * CODEX_HOME in an OS temp dir (extraEnv), so its start writes nothing in the user directory.
 * @returns {{ok: boolean, out: string, error?: string}}
 */
export function runVersion(file, extraEnv = {}) {
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1', ...extraEnv };
  const opts = { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS, env };
  const ext = path.extname(file).toLowerCase();
  // A .cmd or .bat runs only through cmd.exe.
  const r = WIN && (ext === '.cmd' || ext === '.bat')
    ? spawnSync(envGet(process.env, 'ComSpec') || 'cmd.exe', ['/d', '/s', '/c', `""${file}" --version"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(file, ['--version'], opts);
  if (r.error) return { ok: false, out: '', error: r.error.code || r.error.message };
  const out = `${r.stdout ?? ''}`.trim().split(/\r?\n/)[0] ?? '';
  if (r.status !== 0 || !out) return { ok: false, out, error: `exit ${r.status}` };
  return { ok: true, out };
}

/**
 * The verdict on the codex that PATH resolves to. WARN for the npm package and for a binary older than the
 * desktop app's codex.exe; PASS for the desktop exe itself, a binary as new, or no codex on PATH.
 * @param {{hit: string|null, npmVersion: string|null, version: string|null, desktopExe: string|null, desktopVersion: string|null}} x
 * @returns {{status: 'PASS'|'WARN', detail: string}} detail without the path (the caller adds it)
 */
export function judgeCodexOnPath({ hit, npmVersion, version, desktopExe, desktopVersion }) {
  const desk = desktopVersion ? `the desktop app's codex.exe is ${desktopVersion}` : 'the desktop app\'s codex.exe version is unknown';
  if (!hit) return { status: 'PASS', detail: 'no codex on PATH (only the desktop app\'s codex.exe)' };
  if (desktopExe && pathKey(hit) === pathKey(desktopExe)) return { status: 'PASS', detail: 'the desktop app\'s codex.exe' };
  if (npmVersion) return { status: 'WARN', detail: `the npm package ${npmVersion}, not the desktop app's codex.exe; ${desk}` };
  const cmp = compareVersions(version, desktopVersion);
  if (cmp === null) return { status: 'WARN', detail: `${version || 'version unknown'}; cannot compare: ${desk}` };
  if (cmp < 0) return { status: 'WARN', detail: `${version}: older than the desktop app (${desk})` };
  return { status: 'PASS', detail: `${version} (${desk})` };
}

/**
 * The version rows. Starts CLIs only for --version (see runVersion); reads the project-manager build's bytes.
 * @param {object} ctx makeContext
 * @param {object} sec section collector
 * @param {{facts: object, env?: object, run?: Function}} deps run defaults to runVersion
 */
export function versionChecks(ctx, sec, { facts, env = process.env, run = runVersion }) {
  const s = (p) => shown(p, ctx.roots);
  let codexHome = null;
  const codexEnv = () => {
    codexHome ??= fs.mkdtempSync(path.join(os.tmpdir(), 'check-kit-codex-home-'));
    return { CODEX_HOME: codexHome };
  };
  try {
    const claude = findOnPath('claude', env);
    const claudeNpm = npmPackageVersion(claude, '@anthropic-ai/claude-code');
    if (!claude) sec.warn('version.claude', 'Claude Code', 'claude not found on PATH');
    else if (claudeNpm) sec.pass('version.claude', 'Claude Code', `${claudeNpm} (npm package, ${s(claude)})`);
    else {
      const v = run(claude);
      if (v.ok) sec.pass('version.claude', 'Claude Code', `${v.out} (${s(claude)})`);
      else sec.warn('version.claude', 'Claude Code', `${s(claude)} --version failed (${v.error})`);
    }

    const pkg = facts.appx?.[0];
    let desktopExe = null;
    let desktopVersion = null;
    if (!pkg) sec.warn('version.codex-desktop', 'Codex desktop app', `not found (Get-AppxPackage OpenAI.Codex${facts.appx_error ? `: ${facts.appx_error}` : ''})`);
    else {
      sec.pass('version.codex-desktop', 'Codex desktop app', `${pkg.name} ${pkg.version}`);
      const exe = path.join(pkg.install_location, 'app', 'resources', 'codex.exe');
      if (!isFile(exe)) sec.warn('version.codex-exe', 'Codex codex.exe in the desktop app', `not found at ${slash(exe)}`);
      else {
        desktopExe = exe;
        const v = run(exe, codexEnv());
        if (v.ok) { desktopVersion = v.out; sec.pass('version.codex-exe', 'Codex codex.exe in the desktop app', v.out); }
        else sec.warn('version.codex-exe', 'Codex codex.exe in the desktop app', `--version failed (${v.error})`);
      }
    }
    const hit = findOnPath('codex', env);
    const npmVersion = npmPackageVersion(hit, '@openai/codex');
    let version = null;
    if (hit && !npmVersion && !(desktopExe && pathKey(hit) === pathKey(desktopExe))) {
      const v = run(hit, codexEnv());
      version = v.ok ? v.out : null;
    }
    const j = judgeCodexOnPath({ hit, npmVersion, version, desktopExe, desktopVersion });
    sec[j.status === 'PASS' ? 'pass' : 'warn']('version.codex-path', 'codex on PATH', `${j.detail}${hit ? ` (${s(hit)})` : ''}`);

    const node = findOnPath('node', env);
    if (!node) sec.warn('version.node-system', 'system Node', 'node not found on PATH');
    else {
      const v = run(node);
      sec[v.ok ? 'pass' : 'warn']('version.node-system', 'system Node', v.ok ? `${v.out} (${s(node)})` : `${s(node)} --version failed (${v.error})`);
    }
    const portable = ctx.local?.portable_node;
    if (!portable) sec.warn('version.node-portable', 'portable Node', 'portable_node is not set in the local config');
    else if (!isFile(portable)) sec.warn('version.node-portable', 'portable Node', `${s(portable)} does not exist (the hook commands run it)`);
    else {
      const v = run(portable);
      sec[v.ok ? 'pass' : 'warn']('version.node-portable', 'portable Node', v.ok ? `${v.out} (${s(portable)})` : `${s(portable)} --version failed (${v.error})`);
    }
    const git = findOnPath('git', env);
    if (!git) sec.warn('version.git', 'git', 'git not found on PATH');
    else {
      const v = run(git);
      sec[v.ok ? 'pass' : 'warn']('version.git', 'git', v.ok ? `${v.out} (${s(git)})` : `${s(git)} --version failed (${v.error})`);
    }

    const dist = path.join(ctx.t.pmServer, 'dist', 'index.js');
    let buf = null;
    try { buf = fs.readFileSync(dist); } catch { /* missing */ }
    const item = 'project-manager build (dist/index.js)';
    if (buf === null) sec.fail('version.project-manager', item, `${s(dist)} does not exist`, `install project-manager ${PM_VERSION}: scripts/bootstrap.ps1 (or bootstrap.sh)`);
    else {
      const h = sha256(buf);
      if (h.startsWith(PM_SHA256_PREFIX)) sec.pass('version.project-manager', item, `${PM_VERSION} (sha256 ${h.slice(0, 16)}...)`);
      else sec.warn('version.project-manager', item, `sha256 ${h.slice(0, 16)}... is not ${PM_VERSION} (${PM_SHA256_PREFIX}...): batch 1 expects ${PM_VERSION}`);
    }
  } finally {
    if (codexHome) fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

// ---------- check 3: skill copies and agent definitions ----------

/** A PowerShell command that deletes p (a folder with -Recurse); the path in single quotes. */
export function removeCommand(p, dir) {
  return `Remove-Item -LiteralPath '${path.resolve(p).replace(/'/g, "''")}'${dir ? ' -Recurse' : ''}`;
}

/** Entry names of a folder, sorted; [] when it cannot be read. */
function names(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

/** True for a real folder (a link to one is not followed). */
function isDir(p) {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

function readBytes(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

/**
 * How a deployed folder differs from the wanted files: 'missing', 'differs' (another file set or other
 * bytes) or null when it is the same.
 * @param {string} dir
 * @param {{rel: string, content: Buffer}[]} want files relative to dir with / separators
 */
function folderState(dir, want) {
  if (!isDir(dir)) return 'missing';
  let have;
  try { have = listFiles(dir); } catch { return 'differs'; }
  if ([...have].sort().join('\n') !== want.map((w) => w.rel).sort().join('\n')) return 'differs';
  return want.every((w) => readBytes(path.join(dir, ...w.rel.split('/')))?.equals(w.content)) ? null : 'differs';
}

/**
 * Check 3. The wanted contract, skill and agent files come from kit-targets' desiredFiles (the bytes
 * deploy-kit writes), in the claude_contract mode the local config records.
 * @param {object} ctx makeContext
 * @param {object} sec section collector
 * @param {{reportOnly?: boolean}} [opts] the neutral row is a WARN under --report-only, else a FAIL
 */
export function copyChecks(ctx, sec, { reportOnly = false } = {}) {
  const { t, roots } = ctx;
  const s = (p) => shown(p, roots);
  let options = { ...DEFAULT_OPTIONS };
  try { options = recordedOptions(ctx.local); } catch { /* malformed deploy_options: deploy-kit reports it */ }
  const fullRoots = { home: roots.home, runtime: roots.runtime ?? roots.home, projectsRoot: roots.projectsRoot ?? roots.home };
  const desired = desiredFiles(fullRoots, { claudeContract: options.claude_contract });
  const wantAt = (p) => desired.find((d) => pathKey(d.path) === pathKey(p));

  // Neutral profile: the contract files hold the neutral line, or a neutral journal is still in place.
  const contractFiles = [t.claudeMd, t.claudeAgentsMd, t.codexAgentsMd];
  const neutralFiles = contractFiles.filter((p) => { const b = readBytes(p); return b !== null && isNeutralText(b.toString('utf8')); });
  const records = neutralsInPlace(ctx.localConfig);
  const neutral = neutralFiles.length > 0 || records.length > 0;
  const neutralItem = 'neutral profile (deploy-kit --neutral)';
  if (neutral) {
    const id = records.length ? records[records.length - 1].id : null;
    const detail = `neutral ${id ?? '(no journal found)'} in place: ${neutralFiles.length} of 3 contract files hold the neutral line; the kit skills and contract are parked for a measurement (their rows are skipped)`;
    const fix = id
      ? `roll the neutral back: node scripts/deploy-kit.mjs --rollback ${id}${ctx.localArg}`
      : `roll the neutral back: node scripts/deploy-kit.mjs --rollback <neutral id>${ctx.localArg}; no neutral journal is in place under ${s(deployRootOf(ctx.localConfig))}, so without one ${deployFix(ctx)}`;
    sec[reportOnly ? 'warn' : 'fail']('kit.neutral', neutralItem, detail, fix);
  } else {
    sec.pass('kit.neutral', neutralItem, 'not in place');
    const bad = contractFiles.map((p) => {
      const b = readBytes(p);
      return b === null ? `${s(p)} missing` : b.equals(wantAt(p).content) ? null : `${s(p)} differs`;
    }).filter(Boolean);
    const item = 'contract files (~/.claude/AGENTS.md and CLAUDE.md, ~/.codex/AGENTS.md)';
    if (bad.length) sec.fail('contract', item, `${listSome(bad)} (claude_contract ${options.claude_contract})`, deployFix(ctx));
    else sec.pass('contract', item, `match the repo (claude_contract ${options.claude_contract})`);

    for (const [key, label] of [['claudeSkills', 'claude'], ['agentsSkills', 'agents']]) {
      const base = t[key];
      const states = KIT_SKILLS.map((skill) => {
        const dir = path.join(base, skill);
        const want = desired.filter((d) => d.group === 'skills' && within(d.path, dir))
          .map((d) => ({ rel: path.relative(dir, d.path).split(path.sep).join('/'), content: d.content }));
        const st = folderState(dir, want);
        return st ? `${skill} ${st}` : null;
      }).filter(Boolean);
      const item = `kit skills in ${s(base)}`;
      if (states.length) sec.fail(`skills.kit.${label}`, item, `${states.length} of ${KIT_SKILLS.length}: ${listSome(states)}`, deployFix(ctx));
      else sec.pass(`skills.kit.${label}`, item, `${KIT_SKILLS.length} skills match the repo`);
    }
  }

  // Retired skills where the kit deploys: an old copy next to the kit skills. deploy-kit removes them from
  // ~/.claude/skills only (LEGACY_SKILL_DIRS); in ~/.agents/skills they are deleted by hand.
  for (const [key, label, byDeploy] of [['claudeSkills', 'claude', true], ['agentsSkills', 'agents', false]]) {
    const base = t[key];
    const old = names(base).filter((n) => RETIRED_SKILLS.includes(n));
    const item = `retired skills in ${s(base)}`;
    if (!old.length) { sec.pass(`skills.retired.${label}`, item, 'none'); continue; }
    const fix = byDeploy ? deployFix(ctx) : `delete them (deploy-kit does not remove them here): ${old.map((n) => removeCommand(path.join(base, n), true)).join('; ')}`;
    sec.fail(`skills.retired.${label}`, item, `${old.length} old cop${old.length === 1 ? 'y' : 'ies'}: ${listSome(old)}`, fix);
  }

  // The old copy locations: any project-* folder there is an old copy, and one named like a kit skill is a
  // duplicate a platform may list beside the deployed one. deploy-kit removes them after a backup.
  for (const loc of LEGACY_SKILL_DIRS.filter((l) => l.key !== 'claudeSkills')) {
    const base = t[loc.key];
    const old = names(base).filter((n) => /^project-/.test(n));
    const id = `skills.old.${loc.key.replace(/Skills$/, '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const item = `old skill copies in ${s(base)}`;
    if (!old.length) { sec.pass(id, item, 'none'); continue; }
    const dup = old.filter((n) => KIT_SKILLS.includes(n));
    sec.fail(id, item, `${old.length} project-* folder(s): ${listSome(old)}${dup.length ? `; ${dup.length} share a name with a kit skill (duplicate)` : ''}`, deployFix(ctx));
  }

  // Folders from a failed brace expansion ({project-init,project-next,...}): deploy-kit only lists them.
  const braces = SKILL_BASES.flatMap((key) => names(t[key]).filter((n) => n.startsWith('{')).map((n) => path.join(t[key], n)));
  if (braces.length) {
    sec.warn('skills.brace', 'folders named {...} (failed brace expansion)', `${braces.length}: ${listSome(braces.map(s))}; not a skill; delete or keep, your call`,
      braces.map((p) => removeCommand(p, isDir(p))).join('; '));
  }

  // Files in ~/.workflow-core/templates the kit no longer ships (such as global-codex-AGENTS.md); deploy-kit
  // leaves them and lists them.
  let stale = [];
  try {
    const own = new Set(listFiles(path.join(KIT_REPO, 'templates')));
    stale = listFiles(t.workflowTemplates).filter((rel) => !own.has(rel)).map((rel) => path.join(t.workflowTemplates, ...rel.split('/')));
  } catch { /* no deployed templates */ }
  if (stale.length) {
    sec.warn('templates.stale', 'outdated templates', `${stale.length} file(s) the kit no longer ships: ${listSome(stale.map(s))}; delete or keep, your call`,
      stale.map((p) => removeCommand(p, false)).join('; '));
  }

  // Agent definitions: the verifier must be there and equal the repo copy.
  for (const agent of KIT_AGENTS) {
    const p = path.join(t.claudeAgents, `${agent}.md`);
    const b = readBytes(p);
    const item = `agent definition ${agent}`;
    if (b === null) sec.fail(`agents.${agent}`, item, `${s(p)} does not exist (risky tasks and milestones get no independent check)`, deployFix(ctx));
    else if (!b.equals(wantAt(p).content)) sec.fail(`agents.${agent}`, item, `${s(p)} differs from config/claude/agents/${agent}.md`, deployFix(ctx));
    else sec.pass(`agents.${agent}`, item, `${s(p)} matches the repo`);
  }
  const legacy = LEGACY_AGENTS.map((a) => path.join(t.claudeAgents, `${a}.md`)).filter(isFile);
  if (legacy.length) {
    sec.warn('agents.legacy', 'old agents that call retired skills', `${listSome(legacy.map(s))}; kept unless you deploy with --retire-legacy-agents`,
      `node scripts/deploy-kit.mjs --apply --retire-legacy-agents${ctx.rootArgs} archives, then removes them (preview with --dry-run)`);
  }
}

// ---------- check 4: hooks ----------

/**
 * The hook scripts and platforms the fragments register, each once: [{hook, platform}] from
 * config/claude/settings.fragment.json and config/codex/hooks.json (the platform from --platform).
 */
export function registeredHooks() {
  const out = [];
  const add = (hooks, fallback) => {
    for (const groups of Object.values(isObject(hooks) ? hooks : {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          const tokens = Array.isArray(h.args) ? [h.command, ...h.args] : commandTokens(h.command);
          const i = tokens.indexOf('--platform');
          const platform = i >= 0 && tokens[i + 1] ? tokens[i + 1] : fallback;
          for (const hook of hookParts(h).scripts.map((x) => path.basename(x, '.mjs'))) {
            if (!out.some((o) => o.hook === hook && o.platform === platform)) out.push({ hook, platform });
          }
        }
      }
    }
  };
  add(readFragment('config', 'claude', 'settings.fragment.json').hooks, 'claude');
  add(readFragment('config', 'codex', 'hooks.json').hooks, 'codex');
  return out;
}

/**
 * The newest heartbeat time per platform in one heartbeat file ({ts, platform, event, decision} lines;
 * lines that do not parse are skipped).
 * @param {string} file
 * @returns {{exists: boolean, last: Record<string, Date>}}
 */
export function lastHeartbeats(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { exists: false, last: {} }; }
  const last = {};
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = new Date(e?.ts);
    if (typeof e?.platform !== 'string' || Number.isNaN(at.getTime())) continue;
    if (!last[e.platform] || at > last[e.platform]) last[e.platform] = at;
  }
  return { exists: true, last };
}

/** A hooks.json event name in the snake_case form of Codex's trust keys: PreToolUse -> pre_tool_use. */
export const snakeEvent = (event) => String(event).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Codex hook trust per kit handler, where C0 T-meta found it (codex-cli 0.166): config.toml holds one table
 * per trusted handler, [hooks.state.'<absolute hooks.json>:<snake_case event>:<group>:<handler>'] with
 * trusted_hash = "sha256:...", group and handler counted from 0. Trusting a project does not trust its
 * hooks. The hash method is unknown, so a trusted_hash that is there reads as trusted, never as "the hash
 * matches"; C0 saw the layout for a project hooks.json, the user-level one is assumed to be the same.
 * @param {string|null} toml config.toml text, or null when it does not exist
 * @param {string} hooksFile absolute path of the hooks.json the handlers are in
 * @param {object} hooks the hooks object of that file
 * @returns {{handler: string, trusted: boolean}[]} one entry per kit handler, handler = <event>:<group>:<index>
 */
export function codexHookTrust(toml, hooksFile, hooks) {
  const norm = (p) => (WIN ? slash(p).toLowerCase() : slash(p));
  const trusted = new Set();
  if (toml !== null) {
    let kvs = [];
    try { kvs = keyValues(toml); } catch (e) { if (!(e instanceof TomlEditError)) throw e; }
    for (const kv of kvs) {
      const [a, b, key, leaf] = kv.path;
      if (a !== 'hooks' || b !== 'state' || leaf !== 'trusted_hash' || kv.path.length !== 4) continue;
      if (!/^"sha256:[0-9a-f]+"$/i.test(String(kv.raw).trim())) continue;
      const m = /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(key);
      if (m) trusted.add(`${norm(m[1])}|${m[2]}:${m[3]}:${m[4]}`);
    }
  }
  const out = [];
  for (const [event, groups] of Object.entries(isObject(hooks) ? hooks : {})) {
    (Array.isArray(groups) ? groups : []).forEach((g, gi) => {
      (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => {
        if (!isKitHook(h)) return;
        const handler = `${snakeEvent(event)}:${gi}:${hi}`;
        out.push({ handler, trusted: trusted.has(`${norm(hooksFile)}|${handler}`) });
      });
    });
  }
  return out;
}

/**
 * The guard's --selftest: its built-in samples only, in memory (no stdin, no config, no heartbeat).
 * @param {string} node the Node to run it with
 * @param {string} script the deployed guard.mjs
 * @returns {{ok: boolean, out: string}} out: the last output line
 */
export function runSelftest(node, script) {
  const r = spawnSync(node, [script, '--selftest'], { encoding: 'utf8', windowsHide: true, timeout: SELFTEST_TIMEOUT_MS });
  if (r.error) return { ok: false, out: r.error.code || r.error.message };
  const lines = `${r.stdout ?? ''}`.trim().split(/\r?\n/).filter(Boolean);
  const out = lines[lines.length - 1] ?? '';
  return { ok: r.status === 0 && /^guard selftest: ok \(\d+ samples\)$/.test(out), out: out || `exit ${r.status}, no output` };
}

/**
 * Check 4.
 * @param {object} ctx makeContext
 * @param {object} sec section collector
 * @param {{now?: Date, selftest?: Function}} [deps] tests fix the clock and may replace the selftest runner
 */
export function hookChecks(ctx, sec, { now = new Date(), selftest = runSelftest } = {}) {
  const s = (p) => shown(p, ctx.roots);
  const runtime = ctx.roots.runtime;
  for (const { hook, platform } of registeredHooks()) {
    const id = `hooks.heartbeat.${platform}.${hook}`;
    const item = `heartbeat ${hook} (${platform})`;
    if (!runtime) { sec.warn(id, item, 'no runtime root: the heartbeat folder is not known'); continue; }
    const file = path.join(runtime, 'hooks', 'heartbeat', `${hook}.jsonl`);
    const hb = lastHeartbeats(file);
    const at = hb.last[platform];
    if (!at) {
      const how = platform === 'codex' ? 'trust the hook once in Codex /hooks, then run one tool call in Codex'
        : `start a Claude Code session${hook === 'guard' ? ' and run one tool call' : ''}`;
      sec.fail(id, item, hb.exists ? `no ${platform} line in ${s(file)}: the hook never ran` : `${s(file)} does not exist: the hook never ran`,
        `${how}; if it stays empty, check the hook rows of check 1`);
      continue;
    }
    const days = (now - at) / 86_400_000;
    const age = days < 1 ? `${Math.max(0, Math.round(days * 24))} h ago` : `${Math.floor(days)} day(s) ago`;
    const detail = `last ${at.toISOString()} (${age}; older than ${HEARTBEAT_STALE_DAYS} days)`;
    // The guard fails closed on both platforms, so an old guard heartbeat is a guard fault (it may not be
    // running, or not trusted any more); the SessionStart hook only adds hints.
    if (days > HEARTBEAT_STALE_DAYS && hook === 'guard') {
      sec.fail(id, item, detail, `${platform === 'codex' ? 'check the trust row below and /hooks in Codex, then run one tool call in Codex'
        : 'run one tool call in Claude Code'}; if no new line appears, check the hook rows of check 1 and the selftest row`);
    } else if (days > HEARTBEAT_STALE_DAYS) sec.warn(id, item, detail);
    else sec.pass(id, item, `last ${at.toISOString()} (${age})`);
  }

  // Trust per kit handler of ~/.codex/hooks.json. A WARN, not a FAIL: the layout was read from a project
  // hooks.json in C0; the guard heartbeat above is the row that shows whether the hook really runs.
  let toml = null;
  try { toml = fs.readFileSync(ctx.t.codexConfig, 'utf8'); } catch { /* missing */ }
  const hooksJson = readJson(ctx.t.codexHooks);
  const trust = hooksJson.exists && !hooksJson.error ? codexHookTrust(toml, ctx.t.codexHooks, hooksJson.value?.hooks) : [];
  const trustItem = 'Codex hook trust';
  const shownTrust = trust.map((x) => `${x.handler} ${x.trusted ? 'trusted (已信任)' : 'not trusted (未信任)'}`).join(', ');
  const trustFix = `open Codex, trust the AutoSkills hook in /hooks (Codex writes [hooks.state.'${slash(ctx.t.codexHooks)}:<event>:<group>:<handler>'] into ${s(ctx.t.codexConfig)})`;
  if (!trust.length) sec.warn('hooks.codex-trust', trustItem, `no kit handler in ${s(ctx.t.codexHooks)} (see the codex.hooks row)`);
  else if (trust.every((x) => x.trusted)) sec.pass('hooks.codex-trust', trustItem, `${shownTrust}: trusted_hash in ${s(ctx.t.codexConfig)} (the hash itself is not checked)`);
  else sec.warn('hooks.codex-trust', trustItem, `${shownTrust}: no trusted_hash in ${s(ctx.t.codexConfig)} for the untrusted ones`, trustFix);

  const item = 'guard --selftest (deployed rules)';
  if (!runtime) { sec.warn('hooks.selftest.guard', item, 'no runtime root: the deployed guard is not known'); return; }
  const guard = path.join(runtime, 'hooks', 'guard.mjs');
  if (!isFile(guard)) { sec.fail('hooks.selftest.guard', item, `${s(guard)} does not exist`, deployFix(ctx)); return; }
  const portable = ctx.local?.portable_node;
  const node = portable && isFile(portable) ? portable : process.execPath;
  const via = node === portable ? 'portable Node' : 'the Node running check-kit; the portable Node was not found';
  const r = selftest(node, guard);
  if (r.ok) sec.pass('hooks.selftest.guard', item, `${r.out} (${via})`);
  else sec.fail('hooks.selftest.guard', item, `${s(guard)} --selftest: ${r.out} (${via})`, deployFix(ctx));
}

// ---------- check 4, AS3-125: hook-config.json and the live guard command line ----------

/**
 * What is wrong with a hook-config.json text. load: true are the guard's own load errors (loadConfig in
 * hooks/guard.mjs, the same rules; a test holds the two together): the guard exits 2 on every run. load:
 * false is a key the guard does not know; it ignores those.
 * @param {string} text
 * @returns {{load: boolean, text: string}[]} empty when the file is fine
 */
export function hookConfigProblems(text) {
  let cfg;
  try { cfg = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { return [{ load: true, text: 'not valid JSON' }]; }
  if (!isObject(cfg)) return [{ load: true, text: 'not a JSON object' }];
  const absolute = (v) => typeof v === 'string' && path.isAbsolute(v);
  const out = [];
  for (const key of ['runtime', 'kit_repo']) {
    if (cfg[key] !== undefined && !absolute(cfg[key])) out.push({ load: true, text: `${key} is not an absolute path (${JSON.stringify(cfg[key])})` });
  }
  if (cfg.readonly_dirs !== undefined) {
    if (!Array.isArray(cfg.readonly_dirs)) out.push({ load: true, text: 'readonly_dirs is not a list' });
    else {
      const bad = cfg.readonly_dirs.filter((d) => !absolute(d));
      if (bad.length) out.push({ load: true, text: `readonly_dirs: ${bad.length} entr${bad.length === 1 ? 'y is' : 'ies are'} not an absolute path (${listSome(bad.map((d) => JSON.stringify(d)))})` });
    }
  }
  const unknown = Object.keys(cfg).filter((k) => !HOOK_CONFIG_KEYS.includes(k));
  if (unknown.length) out.push({ load: false, text: `unknown key(s) ${listSome(unknown.map((k) => JSON.stringify(k)))}` });
  return out;
}

/**
 * The guard entries (PreToolUse, hooks/guard.mjs) registered in ~/.claude/settings.json and
 * ~/.codex/hooks.json, each distinct command line once.
 * @returns {{platform: string, command: string, args: string[]|null, timeout?: number, onFailure?: string, hook: object}[]}
 */
export function guardCommandLines(ctx) {
  const out = [];
  const key = (x) => JSON.stringify([x.platform, x.command, x.args, x.onFailure]);
  const add = (platform, file) => {
    const j = readJson(file);
    for (const e of kitHookEntries(isObject(j.value) ? j.value.hooks : null)) {
      if (e.event !== 'PreToolUse' || !hookParts(e.hook).scripts.some((x) => path.basename(x) === 'guard.mjs')) continue;
      const h = e.hook;
      const entry = { platform, command: h.command, args: Array.isArray(h.args) ? h.args : null, timeout: h.timeout, onFailure: h.onFailure, hook: h };
      if (!out.some((o) => key(o) === key(entry))) out.push(entry);
    }
  };
  add('claude', ctx.t.claudeSettings);
  add('codex', ctx.t.codexHooks);
  return out;
}

/**
 * How a hook command string is started: in each shell the platform may use. Codex's hook shell is not known
 * (C0 T-meta hook_shell null), so the line must work in all of them; bash only when PATH has one outside
 * the Windows folder (System32\bash.exe is the WSL launcher).
 * @param {string} line
 * @param {object} [env]
 * @returns {{via: string, file: string, args: string[], verbatim?: boolean}[]}
 */
export function shellForms(line, env = process.env) {
  if (!WIN) return [{ via: 'sh -c', file: '/bin/sh', args: ['-c', line] }];
  const comspec = envGet(env, 'ComSpec') || 'cmd.exe';
  const forms = [
    { via: 'cmd /d /s /c', file: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true },
    { via: 'cmd /c', file: comspec, args: ['/c', line], verbatim: true },
    { via: 'powershell -Command', file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', line] },
  ];
  const bash = findOnPath('bash', env);
  const windir = envGet(env, 'SystemRoot');
  if (bash && !(windir && within(bash, windir))) forms.push({ via: 'bash -c', file: bash, args: ['-c', line] });
  return forms;
}

/** The synthetic PreToolUse input of one live run, shaped like the platform's (C0). */
export function probeInput(platform, command) {
  const base = { session_id: 'check-kit-probe', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: os.tmpdir() };
  return JSON.stringify(platform === 'codex' ? { ...base, turn_id: 'check-kit-probe', tool_use_id: 'check-kit-probe' } : { ...base, permission_mode: 'default' });
}

/**
 * One live run: the form started with the input on stdin, in the OS temp dir, with PROBE_ENV=1 (the guard
 * then writes no heartbeat).
 * @returns {{status: number|null, stdout: string, stderr: string, error?: string}}
 */
export function runProbe(form, input, timeoutMs, env = process.env) {
  const r = spawnSync(form.file, form.args, {
    input, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: !!form.verbatim, timeout: timeoutMs,
    cwd: os.tmpdir(), env: { ...env, [PROBE_ENV]: '1' }, maxBuffer: 1024 * 1024,
  });
  return { status: r.status, stdout: `${r.stdout ?? ''}`, stderr: `${r.stderr ?? ''}`, ...(r.error ? { error: r.error.code || r.error.message } : {}) };
}

/** The first stderr line, cut; '' when it is empty or not readable text (a shell's message in another code page). */
function firstLine(text) {
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return /[\uFFFD\u0000-\u0008]/.test(line) ? '' : line.slice(0, 160);
}

/**
 * The verdict on one live run. kind: ok; start (the run did not end with 0 or 2: the guard did not start or
 * did not finish, or a shell passed its exit 2 on as another code; Windows PowerShell -Command turns a
 * native exit 2 into 1); error (the guard ran and failed closed, exit 2); wrong (it ran and decided wrong).
 * @param {'allow'|'deny'} expect
 * @param {{status: number|null, stdout: string, stderr: string, error?: string}} r
 * @returns {{kind: 'ok'|'start'|'error'|'wrong', detail: string}}
 */
export function judgeProbe(expect, r) {
  const why = (text) => (firstLine(text) ? `: ${firstLine(text)}` : '');
  if (r.error === 'ETIMEDOUT') return { kind: 'start', detail: 'timed out' };
  if (r.error) return { kind: 'start', detail: `cannot be started (${r.error})` };
  if (r.status === null) return { kind: 'start', detail: 'ended by a signal' };
  if (r.status === 2) return { kind: 'error', detail: `exit 2${why(r.stderr)}` };
  if (r.status !== 0) {
    const relayed = firstLine(r.stderr).startsWith('AutoSkills 守卫') ? ' (the guard failed closed, the shell passed on another code than 2)' : '';
    return { kind: 'start', detail: `exit ${r.status}${relayed}${why(r.stderr)}` };
  }
  const out = r.stdout.trim();
  if (expect === 'allow') return out ? { kind: 'wrong', detail: `exit 0 with output (expected none): ${out.slice(0, 120)}` } : { kind: 'ok', detail: 'allowed' };
  let j = null;
  try { j = JSON.parse(out.split(/\r?\n/).pop()); } catch { /* not JSON */ }
  const o = j?.hookSpecificOutput;
  if (o?.hookEventName === 'PreToolUse' && o?.permissionDecision === 'deny') return { kind: 'ok', detail: 'denied' };
  return { kind: 'wrong', detail: out ? `exit 0 without the deny JSON: ${out.slice(0, 120)}` : 'exit 0 without output (the push was not denied)' };
}

/** The hook-config.json row. */
export function hookConfigChecks(ctx, sec) {
  const s = (p) => shown(p, ctx.roots);
  const item = 'guard config hook-config.json';
  const runtime = ctx.roots.runtime;
  if (!runtime) { sec.warn('hooks.config', item, 'no runtime root: the deployed file is not known'); return; }
  const file = path.join(runtime, 'hooks', HOOK_CONFIG_NAME);
  const blocked = 'the guard cannot load it and exits 2 on every run: every matched call is blocked on both platforms until it is fixed (这时每次匹配到的调用都会被拦)';
  const fix = `${deployFix(ctx)}; it writes the file from the local config (or correct it by hand)`;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') { sec.fail('hooks.config', item, `${s(file)} cannot be read (${e.code || e.message}): ${blocked}`, fix); return; }
    const deployed = isFile(path.join(runtime, 'hooks', 'guard.mjs')) || guardCommandLines(ctx).length > 0;
    if (!deployed) sec.warn('hooks.config', item, `not deployed (未部署): ${s(file)} does not exist and no guard is deployed or registered`);
    else sec.fail('hooks.config', item, `${s(file)} does not exist: the guard runs without the read-only folders and kit_repo and writes no heartbeat`, deployFix(ctx));
    return;
  }
  const problems = hookConfigProblems(text);
  const load = problems.filter((p) => p.load);
  if (load.length) { sec.fail('hooks.config', item, `${s(file)}: ${load.map((p) => p.text).join('; ')}: ${blocked}`, fix); return; }
  if (problems.length) {
    sec.fail('hooks.config', item, `${s(file)}: ${problems.map((p) => p.text).join('; ')}: deploy-kit writes only ${HOOK_CONFIG_KEYS.join(', ')}; the guard ignores other keys, so a misspelled key leaves its setting off (the file was edited by hand or comes from another kit version)`, fix);
    return;
  }
  const cfg = JSON.parse(text.replace(/^\uFEFF/, ''));
  const keys = HOOK_CONFIG_KEYS.filter((k) => cfg[k] !== undefined).map((k) => (k === 'readonly_dirs' ? `readonly_dirs (${cfg[k].length})` : k));
  sec.pass('hooks.config', item, `${s(file)}: loads, absolute paths, keys ${keys.length ? keys.join(', ') : '(none)'}`);
}

/**
 * The live row: every registered guard command line, run as its platform runs it, with the synthetic allow
 * and deny input.
 * @param {object} ctx makeContext
 * @param {object} sec section collector
 * @param {{probe?: Function, env?: object}} [deps] probe(form, input, timeoutMs) defaults to runProbe
 */
export function liveGuardChecks(ctx, sec, { probe = runProbe, env = process.env } = {}) {
  const s = (p) => shown(p, ctx.roots);
  const item = 'guard command line, live run (synthetic allow and deny)';
  const entries = guardCommandLines(ctx);
  if (!entries.length) {
    sec.warn('hooks.live.guard', item, `not deployed (未部署): no guard registered in ${s(ctx.t.claudeSettings)} or ${s(ctx.t.codexHooks)}; nothing run`);
    return;
  }
  const runs = [];
  const skipped = [];
  for (const e of entries) {
    const forms = e.args ? [{ via: 'command + args', file: e.command, args: e.args }] : shellForms(String(e.command ?? ''), env);
    const timeout = Math.min(PROBE_TIMEOUT_MS, typeof e.timeout === 'number' && e.timeout > 0 ? e.timeout * 1000 : PROBE_TIMEOUT_MS);
    for (const form of forms) {
      for (const expect of ['allow', 'deny']) {
        const r = probe(form, probeInput(e.platform, PROBE_COMMANDS[expect]), timeout);
        // A shell that is not on this machine says nothing about the hook.
        if (!e.args && r.error === 'ENOENT') { if (!skipped.includes(form.via)) skipped.push(form.via); continue; }
        runs.push({ e, via: form.via, expect, ...judgeProbe(expect, r) });
      }
    }
  }
  const per = ['claude', 'codex'].map((p) => {
    const mine = runs.filter((r) => r.e.platform === p);
    return mine.length ? `${p}: ${[...new Set(mine.map((r) => r.via))].join(', ')}` : `${p}: not registered`;
  }).join('; ');
  const bad = runs.filter((r) => r.kind !== 'ok');
  const skip = skipped.length ? `; skipped (not on this machine): ${skipped.join(', ')}` : '';
  if (!bad.length) {
    sec.pass('hooks.live.guard', item, `${runs.length} run(s): ${PROBE_COMMANDS.allow} allowed without output, ${PROBE_COMMANDS.deny} denied (${per})${skip}`);
    return;
  }
  // What each kind of wrong run means on its platform (ADR-006 §4).
  const effects = [];
  const any = (f) => bad.some(f);
  if (any((r) => r.e.platform === 'codex' && r.kind === 'start')) effects.push('Codex blocks only on exit 2: where this line ends with another code (the guard does not start, or the shell does not pass its exit 2 on), Codex lets every matched call through unguarded (守卫起不来时 Codex 会放行)');
  if (any((r) => r.e.platform === 'claude' && r.kind === 'start' && r.e.onFailure === 'block')) effects.push('Claude blocks every matched call (onFailure: "block")');
  if (any((r) => r.e.platform === 'claude' && r.kind === 'start' && r.e.onFailure !== 'block')) effects.push('Claude lets the call through (registered without onFailure: "block")');
  if (any((r) => r.kind === 'error')) effects.push('the guard failed closed (exit 2): every matched call is blocked');
  if (any((r) => r.kind === 'wrong')) effects.push('the guard ran but decided wrong');
  const fixes = [];
  if (any((r) => r.kind === 'start')) {
    const missing = [...new Set(bad.filter((r) => r.kind === 'start').flatMap((r) => missingHookPaths(r.e.hook).map(s)))];
    fixes.push(`${missing.length ? `missing: ${listSome(missing)}; ` : ''}restore the portable Node and <runtime>/hooks/guard.mjs (rename back, reinstall) or ${deployFix(ctx)}; then run the deployed guard's --selftest by hand`);
  }
  if (any((r) => r.kind === 'error')) fixes.push('the guard\'s reason is in the lines below; a hook-config.json problem also shows in the row above');
  if (any((r) => r.kind === 'wrong')) fixes.push(`the deployed guard.mjs does not decide like the repo's: ${deployFix(ctx)}`);
  sec.fail('hooks.live.guard', item, `${bad.length} of ${runs.length} run(s) wrong: ${effects.join('; ')} (${per})${skip}`, fixes.join('; '),
    bad.map((r) => `${r.e.platform}, ${r.via}, ${r.expect} (${PROBE_COMMANDS[r.expect]}): ${r.detail}`));
}

// ---------- check 5: pushurl ----------

/**
 * Check 5 with set-pushurl's own plan (read only: rev-parse, remote, config --get-all). A remote whose repo
 * config is not no_push is a FAIL; repos in a read-only folder are skipped (跳过) and reported as a WARN.
 */
export function pushurlChecks(ctx, sec) {
  const s = (p) => shown(p, ctx.roots);
  const root = ctx.roots.projectsRoot;
  const item = 'pushurl = no_push';
  if (!root) { sec.warn('pushurl.repos', item, 'no projects root: not checked'); return; }
  if (!isDir(root)) { sec.warn('pushurl.repos', item, `${s(root)} is not a folder: not checked`); return; }
  const plan = planRepos(root, { readonlyDirs: ctx.local?.readonly_dirs ?? [] });
  const missing = plan.repos.flatMap((r) => r.remotes.filter((m) => m.action === 'set').map((m) => `${s(r.path)} (${m.name})`));
  const remotes = plan.repos.reduce((n, r) => n + r.remotes.length, 0);
  const links = plan.links.length ? `; ${plan.links.length} link(s) not followed` : '';
  if (missing.length) {
    sec.fail('pushurl.repos', item, `${missing.length} of ${remotes} remote(s) in ${plan.repos.length} repo(s) without ${NO_PUSH}: ${listSome(missing)}${links}`, deployFix(ctx));
  } else {
    sec.pass('pushurl.repos', item, `${plan.repos.length} repo(s) with remotes, ${remotes} remote(s), all ${NO_PUSH}${links}${ctx.local ? '' : ' (no local config: read-only folders not known)'}`);
  }
  const outside = plan.repos.flatMap((r) => r.remotes.filter((m) => m.outside.length).map((m) => `${s(r.path)} (${m.name})`));
  if (outside.length) {
    sec.warn('pushurl.outside', 'pushurl set outside the repo config', `${listSome(outside)}: git also pushes to a pushurl from the global or an included config; check it by hand`);
  }
  const ro = plan.skipped.filter((x) => x.reason.startsWith('read-only dir'));
  if (ro.length) {
    sec.warn('pushurl.readonly', 'pushurl in read-only folders', `skipped (跳过): ${listSome(ro.map((x) => s(x.path)))}; their .git/config is not changed; set ${NO_PUSH} there by hand if you want`);
  }
  const failed = plan.skipped.filter((x) => x.reason.startsWith('git failed'));
  if (failed.length) sec.warn('pushurl.git-failed', 'repos git could not read', listSome(failed.map((x) => `${s(x.path)}: ${x.reason}`)));
}

// ---------- check 6: project rule files ----------

/**
 * The lines of a rule file that name a retired skill or CouncilFlow, each with its replacement.
 * @param {string} text
 * @returns {{line: number, text: string, hits: string[], suggestion: string}[]}
 */
export function oldReferences(text) {
  const out = [];
  String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    const hits = [];
    const trimmed = line.trim();
    let first = trimmed.length;
    for (const r of OLD_REFERENCES) {
      for (const m of trimmed.matchAll(r.re)) {
        const key = r.key ?? m[0];
        if (!hits.includes(key)) hits.push(key);
        first = Math.min(first, m.index);
      }
    }
    if (!hits.length) return;
    // A long line is cut to LINE_SHOWN characters around its first hit.
    const start = trimmed.length > LINE_SHOWN && first > LINE_SHOWN - 40 ? first - 40 : 0;
    const cut = trimmed.slice(start, start + LINE_SHOWN);
    out.push({
      line: i + 1, text: `${start ? '...' : ''}${cut}${start + LINE_SHOWN < trimmed.length ? '...' : ''}`, hits,
      suggestion: hits.map((h) => `${h === 'councilflow' ? 'CouncilFlow' : h} -> ${REPLACEMENTS[h]}`).join('; '),
    });
  });
  return out;
}

/** The rule files check 6 reads: in the projects root, each folder in it and each repo the scan finds. */
export function projectRuleFiles(root) {
  const dirs = [root, ...names(root).map((n) => path.join(root, n)).filter(isDir), ...scanRepos(root, { depth: DEFAULT_DEPTH }).candidates];
  const seen = new Set();
  const files = [];
  for (const d of dirs) {
    if (seen.has(pathKey(d))) continue;
    seen.add(pathKey(d));
    // Measurement repos under _private/eval/runs/ are skipped, as set-pushurl does.
    if (/[\\/]_private[\\/]eval[\\/]runs(?:[\\/]|$)/i.test(path.resolve(d))) continue;
    for (const f of RULE_FILES) {
      const p = path.join(d, ...f);
      if (isFile(p)) files.push(p);
    }
  }
  return files;
}

/** Check 6: lists the lines and their replacements, never changes a file. */
export function ruleFileChecks(ctx, sec) {
  const s = (p) => shown(p, ctx.roots);
  const root = ctx.roots.projectsRoot;
  const item = 'project rule files (CLAUDE.md, AGENTS.md)';
  if (!root) { sec.warn('rules.scan', item, 'no projects root: not scanned'); return; }
  const files = isDir(root) ? projectRuleFiles(root) : [];
  const found = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const refs = oldReferences(text);
    if (refs.length) found.push({ f, refs });
  }
  if (!found.length) { sec.pass('rules.scan', item, `${files.length} file(s) read; none names a retired skill or CouncilFlow`); return; }
  const count = found.reduce((n, x) => n + x.refs.length, 0);
  sec.warn('rules.scan', item, `${found.length} of ${files.length} file(s) name a retired skill or CouncilFlow (${count} line(s)); listed below, nothing changed`);
  const readonly = ctx.local?.readonly_dirs ?? [];
  for (const { f, refs } of found) {
    const ro = readonly.some((d) => within(f, d)) ? ' (read-only folder: change it only with its owner)' : '';
    sec.warn(`rules.${s(f)}`, `rules ${s(f)}`, `${refs.length} line(s)${ro}`, null, refs.map((r) => `L${r.line}: ${r.text}  => ${r.suggestion}`));
  }
}

// ---------- run ----------

// The sections in report order, with their headings.
const SECTIONS = [
  ['config', '1. effective config'], ['versions', '2. versions'], ['copies', '3. skill copies and agent definitions'],
  ['hooks', '4. hooks'], ['pushurl', '5. pushurl'], ['rules', '6. project rule files (listed only, never changed)'],
];

/**
 * Run checks 1 to 6. Reads only (CLIs are started for --version as runVersion describes, the deployed
 * guard for --selftest and its registered command lines on synthetic stdin with no heartbeat, git only for
 * reading commands).
 * @param {object} ctx makeContext
 * @param {{reportOnly?: boolean, env?: object, facts?: object, managed?: string[], run?: Function, now?: Date,
 *   selftest?: Function, probe?: Function}} [deps] reportOnly turns the neutral FAIL into a WARN; tests replace
 *   the environment, the Windows facts, the managed settings files, the version runner, the clock, the
 *   selftest runner and the live-run runner
 * @returns {{section: string, id: string, item: string, status: string, detail: string, fix?: string, lines?: string[]}[]}
 */
export function runChecks(ctx, { reportOnly = false, env = process.env, facts, managed = managedSettingsFiles(), run = runVersion, now, selftest, probe } = {}) {
  const f = facts ?? windowsFacts();
  const config = section('config');
  if (ctx.local) config.pass('local-config', 'local config', slash(ctx.localConfig));
  else config.fail('local-config', 'local config', `${slash(ctx.localConfig)} ${ctx.localError}`, 'create it: node scripts/deploy-kit.mjs --init-local');
  claudeChecks(ctx, config, { managed });
  effortChecks(ctx, config, { env, facts: f, managed });
  codexChecks(ctx, config);
  const versions = section('versions');
  versionChecks(ctx, versions, { facts: f, env, run });
  const copies = section('copies');
  copyChecks(ctx, copies, { reportOnly });
  const hooks = section('hooks');
  hookChecks(ctx, hooks, { now, selftest });
  hookConfigChecks(ctx, hooks);
  liveGuardChecks(ctx, hooks, { probe, env });
  const pushurl = section('pushurl');
  pushurlChecks(ctx, pushurl);
  const rules = section('rules');
  ruleFileChecks(ctx, rules);
  return [config, versions, copies, hooks, pushurl, rules].flatMap((x) => x.rows);
}

/** PASS, WARN and FAIL counts. */
export function countRows(rows) {
  const c = Object.fromEntries(STATUSES.map((x) => [x, 0]));
  for (const r of rows) c[r.status]++;
  return c;
}

function printTable(ctx, rows, reportOnly) {
  const roots = ctx.roots;
  console.log(`check-kit: read only${reportOnly ? ', --report-only (exit 0 whatever the result)' : ''}`);
  console.log(`  home ${slash(roots.home)}; runtime ${roots.runtime ? slash(roots.runtime) : '(not set)'}; projects root ${roots.projectsRoot ? slash(roots.projectsRoot) : '(not set)'}`);
  const width = Math.min(60, Math.max(...rows.map((r) => r.item.length)));
  const pad = `  ${' '.repeat(4)}  ${' '.repeat(width)}  `;
  for (const [name, heading] of SECTIONS) {
    console.log(heading);
    for (const r of rows.filter((x) => x.section === name)) {
      console.log(`  ${r.status}  ${r.item.padEnd(width)}  ${r.detail}`);
      for (const l of r.lines ?? []) console.log(`${pad}${l}`);
      // A WARN's command is yours to run or not.
      if (r.fix) console.log(`${pad}${r.status === 'FAIL' ? 'fix' : 'optional'}: ${r.fix}`);
    }
  }
  const c = countRows(rows);
  console.log(`check-kit: ${c.PASS} PASS, ${c.WARN} WARN, ${c.FAIL} FAIL${reportOnly && c.FAIL ? ' (--report-only: the FAIL rows are the gaps a deploy closes or that need you)' : ''}`);
}

function parseCli(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        'report-only': { type: 'boolean' }, json: { type: 'boolean' },
        home: { type: 'string' }, runtime: { type: 'string' }, 'projects-root': { type: 'string' }, 'local-config': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (a.help) return { help: true };
  for (const k of ['home', 'runtime', 'projects-root', 'local-config']) {
    if (a[k] !== undefined && !a[k].trim()) throw new UsageError(`--${k} needs a path`);
  }
  return { reportOnly: !!a['report-only'], json: !!a.json, home: a.home, runtime: a.runtime, projectsRoot: a['projects-root'], localConfig: a['local-config'] };
}

function run(argv) {
  const opts = parseCli(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  const ctx = makeContext(opts);
  const rows = runChecks(ctx, { reportOnly: opts.reportOnly });
  const counts = countRows(rows);
  const exit = opts.reportOnly || !counts.FAIL ? 0 : 1;
  if (opts.json) {
    const roots = { home: slash(ctx.roots.home), runtime: ctx.roots.runtime && slash(ctx.roots.runtime), projects_root: ctx.roots.projectsRoot && slash(ctx.roots.projectsRoot) };
    console.log(JSON.stringify({ tool: 'check-kit', report_only: opts.reportOnly, roots, local_config: slash(ctx.localConfig), counts, exit, rows }, null, 2));
  } else printTable(ctx, rows, opts.reportOnly);
  return exit;
}

// Both sides by real path, as in the hooks: Node gives the main module its real path, so a start through a
// junction or symlink would otherwise skip run() and exit 0 without a word.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  let a, b;
  try { a = fs.realpathSync(path.resolve(process.argv[1])); b = fs.realpathSync(SELF); } catch { return false; }
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) console.error(`check-kit: ${e.message}\n${USAGE}`);
    else console.error(`check-kit: error: ${e.stack || e}`);
    process.exitCode = 2;
  }
}
