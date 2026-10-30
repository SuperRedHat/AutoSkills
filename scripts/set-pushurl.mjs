#!/usr/bin/env node
// set-pushurl: set remote.<name>.pushurl = no_push on every git repository with remotes under a projects
// root, so a git push from an agent fails before it reaches the network (ADR-006 §2.5). Zero dependencies
// (Node >= 18). It never pushes, fetches or otherwise talks to a remote.
//
// Usage:
//   node scripts/set-pushurl.mjs --root <dir> [--depth N] --dry-run
//   node scripts/set-pushurl.mjs --root <dir> [--depth N] --apply [--log <file>]
//   node scripts/set-pushurl.mjs --revert <log> [--root <dir>] [--dry-run]
// Common options: --local-config <file> (default <kit repo>/_private/kit-local.json).
//
// Exit codes: 0 = done (dry-run: plan printed). 1 = a git write failed, or --revert could not restore a
// remote (repo gone, value changed since the apply). 2 = usage or setup error (unknown option, no mode
// or two modes, --root not a directory, --log already exists, local config or log unreadable, a
// relative path in readonly_dirs).
//
// Finding repositories (the same rules serve check-kit, which imports scanRepos):
//   - The walk starts at --root (depth 0) and looks at directories down to --depth (default 4). A
//     directory that holds a .git entry (folder, or file for worktrees and submodules) is a candidate; the
//     walk goes on below it, so nested repos are found too.
//   - Entries are read with lstat and a junction or symlink is never entered: old worktrees can hold a
//     .venv junction to the main checkout, which would scan that checkout again and walk large trees for
//     nothing. Links are listed in the output as "not followed".
//   - node_modules, .venv, venv and .git are not entered.
//   - Candidates are grouped by their git common dir (git rev-parse --git-common-dir, real path), so a
//     worktree is handled once, through the first path that reaches its common dir.
// Skipped repositories (each listed with its reason):
//   - the repo folder or its git common dir lies in a read-only dir registered in the local config
//     (readonly_dirs): the files in their .git must not change. Without the local config nothing is
//     skipped for this reason, and a note says so;
//   - measurement repos under _private/eval/runs/ (any path with those three segments in a row);
//   - repos without remotes; repos where git fails (broken worktree, unsafe ownership).
// Per remote:
//   - "already no_push" when the repo config holds exactly pushurl = no_push (or holds none and every
//     pushurl git sees for the remote is no_push);
//   - otherwise --apply runs git config --file <common dir>/config --replace-all remote.<name>.pushurl
//     no_push. Nothing else in the config is touched. A pushurl set outside the repo config (global or
//     included file) still applies after that; it is reported as a warning, not changed.
// Log: --apply writes the original values of every remote it looks at (a list of pushurl values from the
// repo config, or null for "not set") to the log before it changes anything. The default log is
// <kit repo>/_private/pushurl/pushurl-<timestamp>.json; an existing log file is never overwritten.
// --revert restores the remotes the apply changed: only where the repo config still holds exactly
// no_push (a value changed since is reported, not overwritten); with --root, only repos under it.
// Your own pushes (ADR-006 §4): git push <full url> <branch> in a normal terminal. A full URL does not go
// through the remote's pushurl, so no_push stops only pushes by remote name.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node scripts/set-pushurl.mjs --root <dir> [--depth N] --dry-run|--apply [--log <file>] [--local-config <file>]\n'
  + '       node scripts/set-pushurl.mjs --revert <log> [--root <dir>] [--dry-run] [--local-config <file>]';

const SELF = fileURLToPath(import.meta.url);
const KIT_REPO = path.resolve(path.dirname(SELF), '..');
const WIN = process.platform === 'win32';

export const NO_PUSH = 'no_push';
export const DEFAULT_DEPTH = 4;
export const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '.git']);
export const DEFAULT_LOCAL_CONFIG = path.join(KIT_REPO, '_private', 'kit-local.json');
const DEFAULT_LOG_DIR = path.join(KIT_REPO, '_private', 'pushurl');
const RUNS_SEGMENTS = ['_private', 'eval', 'runs'];
const LOG_TOOL = 'set-pushurl';

/** A usage or setup error: the CLI exits 2 on it. */
export class UsageError extends Error {}

// ---------- paths ----------

/** Real path (junctions and symlinks resolved), or the resolved path when it does not exist. */
function realPath(p) {
  try { return fs.realpathSync.native(p).replace(/^\\\\\?\\(?=[A-Za-z]:)/, ''); } catch { return path.resolve(p); }
}

// Comparison key: the real path, on Windows in lower case.
const pathKey = (p) => (WIN ? realPath(p).toLowerCase() : realPath(p));

function within(key, rootKey) {
  if (key === rootKey) return true;
  return key.startsWith(rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep);
}

/** The path as shown in the output: relative to the root with / when under it, else absolute. */
function shown(p, root) {
  const rel = path.relative(root, p);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p.split(path.sep).join('/');
  return rel.split(path.sep).join('/');
}

function isMeasurementRepo(key) {
  const parts = key.split(path.sep).map((s) => s.toLowerCase());
  for (let i = 0; i + RUNS_SEGMENTS.length <= parts.length; i++) {
    if (RUNS_SEGMENTS.every((s, j) => parts[i + j] === s)) return true;
  }
  return false;
}

// ---------- local config ----------

/**
 * Read-only dirs from the local kit config.
 * @param {string} file path of kit-local.json
 * @returns {{found: boolean, readonlyDirs: string[]}} found=false when the file does not exist
 * @throws {UsageError} the file exists but cannot be read or parsed, or a dir is not an absolute path
 */
export function loadLocalConfig(file) {
  if (!fs.existsSync(file)) return { found: false, readonlyDirs: [] };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new UsageError(`local config ${file} cannot be read: ${e.message}`);
  }
  const dirs = cfg && cfg.readonly_dirs !== undefined ? cfg.readonly_dirs : [];
  if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== 'string')) throw new UsageError(`local config ${file}: readonly_dirs must be a list of paths`);
  for (const d of dirs) if (!path.isAbsolute(d)) throw new UsageError(`local config ${file}: readonly_dirs entry is not an absolute path: ${d}`);
  return { found: true, readonlyDirs: dirs.map((d) => path.resolve(d)) };
}

// ---------- git ----------

// Child git runs without inherited repo selectors, so a caller's GIT_DIR never redirects it.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|PREFIX)$/i.test(k)));

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`git failed to start: ${r.error.message}`);
  return { code: r.status, out: r.stdout, err: (r.stderr || '').trim() };
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

/** pushurl values from one config file (null = not set). */
function fileValues(configFile, remote) {
  const r = git(['config', '--file', configFile, '--get-all', `remote.${remote}.pushurl`]);
  if (r.code === 1) return null;
  if (r.code !== 0) throw new Error(r.err || `git config --get-all exited ${r.code}`);
  return lines(r.out);
}

/** pushurl values git sees for a remote from inside the repo, all config levels. */
function effectiveValues(repo, remote) {
  const r = git(['config', '--get-all', `remote.${remote}.pushurl`], repo);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new Error(r.err || `git config --get-all exited ${r.code}`);
  return lines(r.out);
}

function setNoPush(configFile, remote) {
  const r = git(['config', '--file', configFile, '--replace-all', `remote.${remote}.pushurl`, NO_PUSH]);
  if (r.code !== 0) throw new Error(r.err || `git config --replace-all exited ${r.code}`);
}

function restoreValues(configFile, remote, values) {
  const key = `remote.${remote}.pushurl`;
  const u = git(['config', '--file', configFile, '--unset-all', key]);
  if (u.code !== 0 && u.code !== 5) throw new Error(u.err || `git config --unset-all exited ${u.code}`);
  for (const v of values || []) {
    const a = git(['config', '--file', configFile, '--add', key, v]);
    if (a.code !== 0) throw new Error(a.err || `git config --add exited ${a.code}`);
  }
}

const sameList = (a, b) => (a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]));
const describe = (values) => (values === null ? 'unset' : values.join(', '));

// ---------- scan ----------

/**
 * Directories under root that hold a .git entry, walked with lstat: links are never entered and the
 * SKIP_DIRS names are not entered. Read only.
 * @param {string} root directory to start at (depth 0)
 * @param {{depth?: number}} [opts] deepest level whose directories are looked at
 * @returns {{candidates: string[], links: string[], unreadable: {path: string, why: string}[]}} absolute paths
 */
export function scanRepos(root, { depth = DEFAULT_DEPTH } = {}) {
  const out = { candidates: [], links: [], unreadable: [] };
  const walk = (dir, d) => {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch (e) { out.unreadable.push({ path: dir, why: e.code || e.message }); return; }
    if (names.includes('.git')) {
      try { fs.lstatSync(path.join(dir, '.git')); out.candidates.push(dir); } catch { /* vanished: not a repo */ }
    }
    if (d >= depth) return;
    for (const name of names) {
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { out.unreadable.push({ path: p, why: e.code || e.message }); continue; }
      if (st.isSymbolicLink()) { out.links.push(p); continue; }
      if (st.isDirectory()) walk(p, d + 1);
    }
  };
  walk(path.resolve(root), 0);
  return out;
}

/**
 * The plan for every repository under root: which remotes get pushurl = no_push and which repos are
 * skipped, with reasons. Read only.
 * @param {string} root
 * @param {{depth?: number, readonlyDirs?: string[]}} [opts]
 * @returns {{root: string, repos: object[], skipped: {path: string, reason: string}[], links: string[], unreadable: object[]}}
 *   repos[]: {path, commonDir, config, remotes: [{name, original: string[]|null, effective: string[],
 *   action: 'set'|'unchanged', outside: string[]}]}
 */
export function planRepos(root, { depth = DEFAULT_DEPTH, readonlyDirs = [] } = {}) {
  const absRoot = path.resolve(root);
  const scan = scanRepos(absRoot, { depth });
  const roKeys = readonlyDirs.map((d) => ({ dir: d, key: pathKey(d) }));
  const plan = { root: absRoot, repos: [], skipped: [], links: scan.links, unreadable: scan.unreadable };
  const seen = new Map();
  for (const repo of scan.candidates) {
    const skip = (reason) => plan.skipped.push({ path: repo, reason });
    const repoKey = pathKey(repo);
    if (isMeasurementRepo(repoKey)) { skip('measurement repo under _private/eval/runs/'); continue; }
    const roSkip = (ro) => skip(`read-only dir ${ro.dir} (registered in the local config)`);
    // A repo folder in a read-only dir is skipped before git runs in it at all.
    let ro = roKeys.find((r) => within(repoKey, r.key));
    if (ro) { roSkip(ro); continue; }
    const rp = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
    if (rp.code !== 0) { skip(`git failed: ${rp.err.split(/\r?\n/)[0] || `exit ${rp.code}`}`); continue; }
    const commonDir = path.resolve(rp.out.trim());
    const commonKey = pathKey(commonDir);
    ro = roKeys.find((r) => within(commonKey, r.key));
    if (ro) { roSkip(ro); continue; }
    if (seen.has(commonKey)) { skip(`same git common dir as ${shown(seen.get(commonKey), absRoot)} (worktree)`); continue; }
    seen.set(commonKey, repo);
    const rr = git(['remote'], repo);
    if (rr.code !== 0) { skip(`git failed: ${rr.err.split(/\r?\n/)[0] || `exit ${rr.code}`}`); continue; }
    const names = lines(rr.out).map((s) => s.trim()).filter(Boolean);
    if (!names.length) { skip('no remotes'); continue; }
    const config = path.join(commonDir, 'config');
    try {
      const remotes = names.map((name) => {
        const original = fileValues(config, name);
        const effective = effectiveValues(repo, name);
        // Values from other config levels: the effective list minus the repo config's own values.
        const outside = [...effective];
        for (const v of original || []) { const i = outside.indexOf(v); if (i >= 0) outside.splice(i, 1); }
        // Already done: the repo config holds exactly no_push, or holds nothing and every value git sees is
        // no_push. Values from other levels are never changed here, only reported (outside).
        const done = sameList(original, [NO_PUSH]) || (original === null && effective.length > 0 && effective.every((v) => v === NO_PUSH));
        const action = done ? 'unchanged' : 'set';
        return { name, original, effective, outside: outside.filter((v) => v !== NO_PUSH), action };
      });
      plan.repos.push({ path: repo, commonDir, config, remotes });
    } catch (e) {
      skip(`git failed: ${e.message.split(/\r?\n/)[0]}`);
    }
  }
  return plan;
}

// ---------- apply and revert ----------

function writeLogFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

/**
 * Write the originals of every planned remote to logFile, then set pushurl = no_push where needed.
 * @param {object} plan from planRepos
 * @param {string} logFile must not exist yet
 * @returns {{results: {repo: string, remote: string, status: string, detail?: string}[], failed: number}}
 */
export function applyPlan(plan, logFile) {
  if (fs.existsSync(logFile)) throw new UsageError(`log ${logFile} already exists; it is never overwritten`);
  const entries = plan.repos.flatMap((r) => r.remotes.map((m) => ({
    repo: r.path, git_common_dir: r.commonDir, config: r.config, remote: m.name, original: m.original, action: m.action,
  })));
  writeLogFile(logFile, { tool: LOG_TOOL, version: 1, created: new Date().toISOString(), root: plan.root, value: NO_PUSH, entries });
  const results = [];
  let failed = 0;
  for (const e of entries) {
    if (e.action !== 'set') { results.push({ repo: e.repo, remote: e.remote, status: 'unchanged' }); continue; }
    try {
      setNoPush(e.config, e.remote);
      results.push({ repo: e.repo, remote: e.remote, status: 'set' });
    } catch (err) {
      failed++;
      results.push({ repo: e.repo, remote: e.remote, status: 'failed', detail: err.message.split(/\r?\n/)[0] });
    }
  }
  return { results, failed };
}

/**
 * Read an apply log.
 * @param {string} file
 * @returns {{root: string, entries: object[]}}
 */
export function readLog(file) {
  let log;
  try { log = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new UsageError(`log ${file} cannot be read: ${e.message}`);
  }
  if (!log || log.tool !== LOG_TOOL || !Array.isArray(log.entries)) throw new UsageError(`${file} is not a set-pushurl log`);
  for (const e of log.entries) {
    if (!e || typeof e.repo !== 'string' || typeof e.config !== 'string' || typeof e.remote !== 'string'
      || !(e.original === null || (Array.isArray(e.original) && e.original.every((v) => typeof v === 'string')))) {
      throw new UsageError(`${file}: malformed entry ${JSON.stringify(e)}`);
    }
  }
  return log;
}

/**
 * Restore the remotes an apply changed, from its log.
 * @param {object} log from readLog
 * @param {{root?: string, readonlyDirs?: string[], dryRun?: boolean}} [opts]
 * @returns {{results: {repo: string, remote: string, status: string, detail?: string}[], failed: number}}
 *   status: restored | would restore | already restored | not changed by the apply | outside --root |
 *   skipped (failed counts the skips that leave a remote unrestored, and git errors)
 */
export function revertLog(log, { root, readonlyDirs = [], dryRun = false } = {}) {
  const rootKey = root ? pathKey(root) : null;
  const roKeys = readonlyDirs.map((d) => ({ dir: d, key: pathKey(d) }));
  const results = [];
  let failed = 0;
  for (const e of log.entries) {
    const res = (status, detail) => results.push({ repo: e.repo, remote: e.remote, status, ...(detail ? { detail } : {}) });
    if (e.action !== 'set') { res('not changed by the apply'); continue; }
    const repoKey = pathKey(e.repo);
    if (rootKey && !within(repoKey, rootKey)) { res('outside --root'); continue; }
    const ro = roKeys.find((r) => within(repoKey, r.key) || within(pathKey(path.dirname(e.config)), r.key));
    if (ro) { failed++; res('skipped', `read-only dir ${ro.dir} (registered in the local config)`); continue; }
    if (!fs.existsSync(e.config)) { failed++; res('skipped', `repo config ${e.config} no longer exists`); continue; }
    try {
      const now = fileValues(e.config, e.remote);
      if (sameList(now, e.original)) { res('already restored'); continue; }
      if (!sameList(now, [NO_PUSH])) { failed++; res('skipped', `changed since the apply (now: ${describe(now)}); left as it is`); continue; }
      if (dryRun) { res('would restore', describe(e.original)); continue; }
      restoreValues(e.config, e.remote, e.original);
      res('restored', describe(e.original));
    } catch (err) {
      failed++;
      res('failed', err.message.split(/\r?\n/)[0]);
    }
  }
  return { results, failed };
}

// ---------- main ----------

function parseCli(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' }, depth: { type: 'string' }, 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' },
        revert: { type: 'string' }, log: { type: 'string' }, 'local-config': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (a.help) return { help: true };
  const revert = a.revert !== undefined;
  if (revert && a.apply) throw new UsageError('--apply and --revert exclude each other');
  if (!revert && a.apply && a['dry-run']) throw new UsageError('--dry-run and --apply exclude each other');
  if (!revert && !a.apply && !a['dry-run']) throw new UsageError('one of --dry-run, --apply or --revert <log> is required');
  if (revert && !a.revert.trim()) throw new UsageError('--revert needs a log file');
  if (a.log !== undefined && !a.apply) throw new UsageError('--log is only used with --apply');
  if (revert && a.depth !== undefined) throw new UsageError('--depth is not used with --revert');
  let depth = DEFAULT_DEPTH;
  if (a.depth !== undefined) {
    if (!/^\d+$/.test(a.depth)) throw new UsageError(`--depth must be a whole number: ${a.depth}`);
    depth = Number(a.depth);
  }
  let root = null;
  if (a.root !== undefined) {
    root = path.resolve(a.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`root is not a directory: ${a.root}`);
  } else if (!revert) throw new UsageError('--root is required');
  const mode = revert ? 'revert' : a.apply ? 'apply' : 'dry-run';
  return {
    mode, root, depth, dryRun: !!a['dry-run'], revertLog: revert ? path.resolve(a.revert) : null,
    log: a.log !== undefined ? path.resolve(a.log) : null, localConfig: path.resolve(a['local-config'] ?? DEFAULT_LOCAL_CONFIG),
  };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function printPlan(plan, results) {
  const status = new Map((results || []).map((r) => [`${r.repo}\n${r.remote}`, r]));
  let toSet = 0, already = 0, failed = 0;
  for (const repo of plan.repos) {
    console.log(`repo ${shown(repo.path, plan.root)}`);
    for (const m of repo.remotes) {
      const was = `was ${describe(m.original)}`;
      let line;
      if (m.action === 'unchanged') { already++; line = `already ${NO_PUSH}`; } else if (!results) {
        toSet++; line = `would set pushurl = ${NO_PUSH} (${was})`;
      } else {
        const r = status.get(`${repo.path}\n${m.name}`);
        if (r && r.status === 'set') { toSet++; line = `set pushurl = ${NO_PUSH} (${was})`; } else { failed++; line = `FAILED: ${r ? r.detail : 'not run'} (${was})`; }
      }
      if (m.outside.length) line += `; warning: ${m.outside.length} pushurl value(s) set outside the repo config still apply`;
      console.log(`  remote ${m.name}: ${line}`);
    }
  }
  for (const s of plan.skipped) console.log(`skip ${shown(s.path, plan.root)}: ${s.reason}`);
  for (const l of plan.links) console.log(`link ${shown(l, plan.root)}: junction or symlink, not followed`);
  for (const u of plan.unreadable) console.log(`unreadable ${shown(u.path, plan.root)}: ${u.why}`);
  const remotes = plan.repos.reduce((n, r) => n + r.remotes.length, 0);
  const verb = results ? 'set' : 'to set';
  console.log(`set-pushurl: ${plan.repos.length} repo(s), ${remotes} remote(s): ${toSet} ${verb}, ${already} already ${NO_PUSH}`
    + `${failed ? `, ${failed} failed` : ''}; ${plan.skipped.length} repo(s) skipped, ${plan.links.length} link(s) not followed`);
  return failed;
}

function run(argv) {
  const opts = parseCli(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  const local = loadLocalConfig(opts.localConfig);
  if (!local.found) {
    console.error(`set-pushurl: note: local config ${opts.localConfig} not found; read-only dirs are not skipped `
      + '(create it with deploy-kit --init-local, or name one with --local-config)');
  }

  if (opts.mode === 'revert') {
    const log = readLog(opts.revertLog);
    const base = opts.root || log.root || process.cwd();
    console.log(`set-pushurl: ${opts.dryRun ? 'revert dry-run' : 'revert'} from ${opts.revertLog}${opts.root ? ` (repos under ${opts.root})` : ''}`);
    const { results, failed } = revertLog(log, { root: opts.root, readonlyDirs: local.readonlyDirs, dryRun: opts.dryRun });
    let lastRepo = null;
    for (const r of results) {
      if (r.repo !== lastRepo) { console.log(`repo ${shown(r.repo, base)}`); lastRepo = r.repo; }
      console.log(`  remote ${r.remote}: ${r.status}${r.detail ? (r.status === 'restored' || r.status === 'would restore' ? ` to ${r.detail}` : `: ${r.detail}`) : ''}`);
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    console.log(`set-pushurl: ${count(opts.dryRun ? 'would restore' : 'restored')} ${opts.dryRun ? 'to restore' : 'restored'}, `
      + `${count('already restored')} already restored, ${count('not changed by the apply')} not changed by the apply, ${failed} not restored`);
    return failed ? 1 : 0;
  }

  console.log(`set-pushurl: ${opts.mode} under ${opts.root} (depth ${opts.depth})`);
  const plan = planRepos(opts.root, { depth: opts.depth, readonlyDirs: local.readonlyDirs });
  if (opts.mode === 'dry-run') { printPlan(plan, null); return 0; }
  const logFile = opts.log || path.join(DEFAULT_LOG_DIR, `pushurl-${stamp()}.json`);
  const { results } = applyPlan(plan, logFile);
  const failed = printPlan(plan, results);
  console.log(`set-pushurl: log ${logFile}`);
  console.log(`set-pushurl: undo with: node scripts/set-pushurl.mjs --revert "${logFile}"`);
  console.log('set-pushurl: push yourself with git push <full url> <branch> in a normal terminal (ADR-006 §4)');
  return failed ? 1 : 0;
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
    console.error(e instanceof UsageError ? `set-pushurl: ${e.message}\n${USAGE}` : `set-pushurl: error: ${e.stack || e}`);
    process.exitCode = 2;
  }
}
