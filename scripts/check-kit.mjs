#!/usr/bin/env node
// check-kit: read-only health check of the AutoSkills kit at the user level (ADR-006 §2.7). Zero
// dependencies (Node >= 18). It prints a PASS, WARN, FAIL table; every FAIL names its fix, which for most
// rows is a new run of deploy-kit.
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
// Checks (AS3-116a; AS3-116b adds duplicate skills, agent definitions, hook heartbeats, pushurl and the
// project rule files):
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
//
// Read only: nothing under the roots is written. CLIs are started only for --version, with
// DISABLE_AUTOUPDATER=1 so none of them updates itself, and codex with CODEX_HOME pointed at an OS temp dir
// (codex writes helper files under its home on every start) that is removed afterwards; an npm package's
// version is read from its package.json instead of running it. Codex's SQLite files are never opened. The
// registry and the Appx package are read through PowerShell's structured output (ConvertTo-Json; only value
// names and error type names, no localized text). Environment values and secrets are never printed: the
// environment rows name where a variable is set, not its value.
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
  KIT_REPO, DEFAULT_LOCAL_CONFIG, KIT_HOOK_SCRIPTS, UsageError,
  targetMap, readLocalConfig, claudePathRule, isKitHook, slash, pathKey, within,
} from './lib/kit-targets.mjs';
import { keyValues, getValue, TomlEditError } from './lib/toml-edit.mjs';

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
  try { return { exists: true, value: JSON.parse(text.replace(/^﻿/, '')) }; } catch (e) {
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
  return { roots, t, local, localConfig, localError, rootArgs };
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

/** Collects the rows of one section. */
function section(name) {
  const rows = [];
  const add = (status, id, item, detail, fix) => rows.push({ section: name, id, item, status, detail, ...(status === 'FAIL' ? { fix } : {}) });
  return { rows, pass: (...a) => add('PASS', ...a), warn: (...a) => add('WARN', ...a), fail: (...a) => add('FAIL', ...a) };
}

function readFragment(...p) {
  const file = path.join(KIT_REPO, ...p);
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
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

  // hooks.json: the guard as a reminder (Codex lets a call through when a hook fails).
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

// ---------- run ----------

/**
 * Run checks 1 and 2. Reads only (CLIs are started for --version as runVersion describes).
 * @param {object} ctx makeContext
 * @param {{env?: object, facts?: object, managed?: string[], run?: Function}} [deps] tests replace the
 *   environment, the Windows facts, the managed settings files and the version runner
 * @returns {{section: string, id: string, item: string, status: string, detail: string, fix?: string}[]}
 */
export function runChecks(ctx, { env = process.env, facts, managed = managedSettingsFiles(), run = runVersion } = {}) {
  const f = facts ?? windowsFacts();
  const config = section('config');
  if (ctx.local) config.pass('local-config', 'local config', slash(ctx.localConfig));
  else config.fail('local-config', 'local config', `${slash(ctx.localConfig)} ${ctx.localError}`, 'create it: node scripts/deploy-kit.mjs --init-local');
  claudeChecks(ctx, config, { managed });
  effortChecks(ctx, config, { env, facts: f, managed });
  codexChecks(ctx, config);
  const versions = section('versions');
  versionChecks(ctx, versions, { facts: f, env, run });
  return [...config.rows, ...versions.rows];
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
  for (const name of ['config', 'versions']) {
    console.log(name === 'config' ? '1. effective config' : '2. versions');
    for (const r of rows.filter((x) => x.section === name)) {
      console.log(`  ${r.status}  ${r.item.padEnd(width)}  ${r.detail}`);
      if (r.fix) console.log(`  ${' '.repeat(4)}  ${' '.repeat(width)}  fix: ${r.fix}`);
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
  const rows = runChecks(ctx);
  const counts = countRows(rows);
  const exit = opts.reportOnly || !counts.FAIL ? 0 : 1;
  if (opts.json) {
    const roots = { home: slash(ctx.roots.home), runtime: ctx.roots.runtime && slash(ctx.roots.runtime), projects_root: ctx.roots.projectsRoot && slash(ctx.roots.projectsRoot) };
    console.log(JSON.stringify({ tool: 'check-kit', report_only: opts.reportOnly, roots, local_config: slash(ctx.localConfig), counts, exit, rows }, null, 2));
  } else printTable(ctx, rows, opts.reportOnly);
  return exit;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  return WIN ? a.toLowerCase() === SELF.toLowerCase() : a === SELF;
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
