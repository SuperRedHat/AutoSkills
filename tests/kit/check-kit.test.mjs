// Tests for scripts/check-kit.mjs (node:test, zero dependencies). The three hand-written fake user
// directories in tests/kit/fixtures/home-*/ (deployed, before a deploy, CLAUDE_CODE_EFFORT_LEVEL set) are
// copied into OS temp dirs, their placeholders filled, and check-kit runs on them as a CLI with --home,
// --runtime, --projects-root and --local-config. Each temp tree and each fixture folder is hashed before and
// after the runs to show that check-kit writes nothing. The version rows of those runs come from this machine
// (they are WARN at worst and do not change the exit code); the unit tests drive the registry facts, the
// managed settings, PATH and the version runner with fakes. The last test checks that the real Codex temp
// folder and the real settings files are unchanged after the whole file ran.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeContext, runChecks, countRows, versionChecks, judgeCodexOnPath, findOnPath, npmPackageVersion, runVersion,
  windowsFacts, compareVersions, commandTokens, tomlStrings, hookParts, EFFORT_VAR,
} from '../../scripts/check-kit.mjs';
import { claudePathRule } from '../../scripts/lib/kit-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-kit.mjs');
const FIXTURES = path.join(REPO, 'tests', 'kit', 'fixtures');
const HOMES = ['home-ok', 'home-missing', 'home-effort'];
const SENTINEL = 'max-fixture-sentinel-7f3a';
const WIN = process.platform === 'win32';

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
const tempDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
const fwd = (p) => path.resolve(p).split(path.sep).join('/');

/** sha256 (files) or "dir" of every entry under p, walked with lstat; {} when p does not exist. */
function treeHash(p, out = {}, rel = '') {
  let st;
  try { st = fs.lstatSync(p); } catch { return out; }
  if (st.isSymbolicLink()) out[rel || '.'] = `link:${fs.readlinkSync(p)}`;
  else if (st.isDirectory()) {
    out[rel || '.'] = 'dir';
    for (const n of fs.readdirSync(p).sort()) treeHash(path.join(p, n), out, rel ? `${rel}/${n}` : n);
  } else out[rel || '.'] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return out;
}

// Real files a version query could touch (codex writes helper files under its home when CODEX_HOME is not
// redirected) and the real settings files: fingerprinted before any test runs.
const REAL = [
  path.join(os.homedir(), '.codex', 'tmp'), path.join(os.homedir(), '.codex', 'config.toml'),
  path.join(os.homedir(), '.claude', 'settings.json'),
];
const realFingerprint = () => Object.fromEntries(REAL.map((p) => [p, treeHash(p)]));
const REAL_BEFORE = realFingerprint();
const FIXTURES_BEFORE = Object.fromEntries(HOMES.map((h) => [h, treeHash(path.join(FIXTURES, h))]));

/** The process environment without CLAUDE_CODE_EFFORT_LEVEL (any case), plus extra. */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== EFFORT_VAR));
  return { ...env, ...extra };
}

/**
 * A temp copy of one fixture with its placeholders filled: <home>, <runtime>, <projects>, <projects-posix>
 * (Claude's rule form of the projects folder) and <node> (the Node that runs this test).
 */
function sandbox(name, { dist = true } = {}) {
  const root = tempDir(`check-kit-${name}-`);
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true });
  const sb = { root, home: path.join(root, 'home'), runtime: path.join(root, 'runtime'), projects: path.join(root, 'projects'), local: path.join(root, 'local.json') };
  fs.mkdirSync(sb.projects, { recursive: true });
  const posix = claudePathRule('Edit', sb.projects).slice('Edit('.length, -'/**)'.length);
  const fill = { '<home>': fwd(sb.home), '<runtime>': fwd(sb.runtime), '<projects-posix>': posix, '<projects>': fwd(sb.projects), '<node>': fwd(process.execPath) };
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      const text = fs.readFileSync(p, 'utf8');
      const out = text.replace(/<projects-posix>|<projects>|<home>|<runtime>|<node>/g, (m) => fill[m]);
      if (out !== text) fs.writeFileSync(p, out);
    }
  };
  walk(root);
  if (dist) {
    const file = path.join(sb.home, '.claude', 'mcp-project-manager', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// synthetic ledger build\n');
  }
  sb.args = ['--home', sb.home, '--runtime', sb.runtime, '--projects-root', sb.projects, '--local-config', sb.local];
  return sb;
}

function cli(args, env = cleanEnv()) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 180_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** check-kit --json on a sandbox; asserts the exit code and returns the parsed report and the raw output. */
function report(sb, { strict = true, env, status }) {
  const r = cli([...sb.args, '--json', ...(strict ? [] : ['--report-only'])], env);
  assert.equal(r.status, status, `exit ${r.status}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`);
  return { json: JSON.parse(r.stdout), raw: r.stdout + r.stderr };
}

const failIds = (rows) => rows.filter((r) => r.status === 'FAIL').map((r) => r.id).sort();
const row = (rows, id) => { const r = rows.find((x) => x.id === id); assert.ok(r, `no row ${id}`); return r; };

// ---------- the three fake user directories, through the CLI ----------

test('deployed home: no FAIL, strict exit 0, every config row passes, the tree is unchanged', () => {
  const sb = sandbox('home-ok');
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 0 });
  assert.deepEqual(failIds(json.rows), []);
  for (const r of json.rows.filter((x) => x.section === 'config')) {
    // The registry rows depend on this machine; every row from the fake home must pass.
    if (r.id === 'effort.hkcu' || r.id === 'effort.hklm') continue;
    assert.equal(r.status, 'PASS', `${r.id}: ${r.detail}`);
  }
  assert.match(row(json.rows, 'claude.deny.readonly').detail, /1 Edit rule/);
  assert.match(row(json.rows, 'claude.hook.paths').detail, /3 kit hook entries/);
  assert.equal(row(json.rows, 'version.project-manager').status, 'WARN', 'a synthetic build is not 1.5.1');
  const text = cli(sb.args);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /0 FAIL/);
  assert.deepEqual(treeHash(sb.root), before);
});

test('home before a deploy: the gaps are FAIL with a fix each; strict exit 1, --report-only exit 0; the tree is unchanged', () => {
  const sb = sandbox('home-missing', { dist: false });
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 1 });
  assert.deepEqual(failIds(json.rows), [
    'claude.deny.bash', 'claude.deny.customer', 'claude.deny.mcp', 'claude.deny.powershell', 'claude.deny.readonly',
    'claude.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS', 'claude.hook.PreToolUse.guard.mjs', 'claude.hook.SessionStart.session-start.mjs',
    'claude.hook.paths', 'claude.subagentPromptCacheTtl', 'claude.worktree.baseRef',
    'codex.agents.default_subagent_reasoning_effort', 'codex.desktop.followUpQueueMode', 'codex.hooks', 'codex.model_reasoning_effort',
    'codex.project-manager', 'codex.rules', 'version.project-manager',
  ].sort());
  for (const r of json.rows.filter((x) => x.status === 'FAIL')) assert.ok(r.fix && r.fix.length > 10, `${r.id} has no fix`);
  assert.match(row(json.rows, 'claude.worktree.baseRef').fix, /deploy-kit\.mjs --apply --home /);
  assert.match(row(json.rows, 'claude.hook.PreToolUse.guard.mjs').detail, /onFailure/);
  assert.match(row(json.rows, 'claude.hook.paths').detail, /old\/hooks\/guard\.mjs/);
  assert.equal(row(json.rows, 'claude.hook.PreToolUse.guard.mjs.project-manager').status, 'PASS');
  assert.match(row(json.rows, 'claude.deny.bash').detail, /^48 of 50 missing/);
  assert.match(row(json.rows, 'claude.deny.powershell').detail, /^50 of 50 missing/);
  // An env value in settings is not printed, only that it differs.
  assert.doesNotMatch(row(json.rows, 'claude.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS').detail, /"2"/);
  assert.match(row(json.rows, 'codex.agents.default_subagent_reasoning_effort').fix, /delete default_subagent_reasoning_effort/);
  for (const id of ['effort.process', 'effort.settings']) assert.equal(row(json.rows, id).status, 'PASS');

  const soft = report(sb, { strict: false, status: 0 });
  assert.equal(soft.json.report_only, true);
  assert.deepEqual(failIds(soft.json.rows), failIds(json.rows));
  const text = cli([...sb.args, '--report-only']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /FAIL {2}Claude worktree\.baseRef/);
  assert.match(text.stdout, /fix: re-run deploy-kit/);
  assert.deepEqual(treeHash(sb.root), before);
});

test('CLAUDE_CODE_EFFORT_LEVEL in the process and in two settings files: FAIL in strict mode, the value is never printed', () => {
  const sb = sandbox('home-effort');
  const before = treeHash(sb.root);
  const env = cleanEnv({ [EFFORT_VAR]: SENTINEL });
  const { json, raw } = report(sb, { env, status: 1 });
  assert.deepEqual(failIds(json.rows), ['effort.process', 'effort.settings']);
  const settings = row(json.rows, 'effort.settings');
  assert.match(settings.detail, /~\/\.claude\/settings\.json/);
  assert.match(settings.detail, /<projects>\/demo\/\.claude\/settings\.local\.json/);
  assert.match(settings.fix, /remove env\.CLAUDE_CODE_EFFORT_LEVEL/);
  assert.ok(row(json.rows, 'effort.process').fix);
  assert.ok(!raw.includes(SENTINEL), 'the variable value leaked into the output');
  const text = cli(sb.args, env);
  assert.equal(text.status, 1);
  assert.ok(!text.stdout.includes(SENTINEL) && !text.stderr.includes(SENTINEL));
  assert.equal(report(sb, { strict: false, env, status: 0 }).json.counts.FAIL, 2);
  // Without the process variable only the settings row fails.
  assert.deepEqual(failIds(report(sb, { status: 1 }).json.rows), ['effort.settings']);
  assert.deepEqual(treeHash(sb.root), before);
});

// ---------- unit tests with fakes ----------

const NO_FACTS = { registry: { hkcu: false, hklm: false }, appx: [] };
const noVersions = () => ({ ok: false, out: '', error: 'not run in this test' });

test('the registry rows: set is a FAIL with the PowerShell fix, unreadable is a WARN', () => {
  const sb = sandbox('home-ok');
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: sb.local });
  const rows = runChecks(ctx, { env: cleanEnv(), facts: { registry: { hkcu: true, hklm: false }, appx: [] }, managed: [], run: noVersions });
  assert.equal(row(rows, 'effort.hkcu').status, 'FAIL');
  assert.match(row(rows, 'effort.hkcu').fix, /SetEnvironmentVariable\('CLAUDE_CODE_EFFORT_LEVEL', \$null, 'User'\)/);
  assert.equal(row(rows, 'effort.hklm').status, 'PASS');
  const unknown = runChecks(ctx, { env: cleanEnv(), facts: { registry: null, registry_error: 'SecurityException', appx: [] }, managed: [], run: noVersions });
  if (WIN) assert.equal(row(unknown, 'effort.hkcu').status, 'WARN');
  assert.equal(row(unknown, 'version.codex-desktop').status, 'WARN');
});

test('a managed settings file wins: another baseRef there is a FAIL that names the managed file', () => {
  const sb = sandbox('home-ok');
  const managed = path.join(tempDir('check-kit-managed-'), 'managed-settings.json');
  fs.writeFileSync(managed, JSON.stringify({ worktree: { baseRef: 'fresh' }, env: { [EFFORT_VAR]: SENTINEL } }));
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: sb.local });
  const rows = runChecks(ctx, { env: cleanEnv(), facts: NO_FACTS, managed: [managed], run: noVersions });
  const r = row(rows, 'claude.worktree.baseRef');
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /managed settings/);
  assert.match(r.fix, /managed settings win/);
  assert.equal(row(rows, 'effort.settings').status, 'FAIL');
  assert.ok(!JSON.stringify(rows).includes(SENTINEL));
});

test('no local config: its row is a FAIL naming --init-local, the folder rows WARN, the rest still runs', () => {
  const sb = sandbox('home-ok');
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: path.join(sb.root, 'absent.json') });
  const rows = runChecks(ctx, { env: cleanEnv(), facts: NO_FACTS, managed: [], run: noVersions });
  assert.match(row(rows, 'local-config').fix, /--init-local/);
  assert.equal(row(rows, 'claude.deny.readonly').status, 'WARN');
  assert.equal(row(rows, 'claude.worktree.baseRef').status, 'PASS');
  assert.equal(row(rows, 'version.node-portable').status, 'WARN');
});

test('codex on PATH: the npm package and an older binary are WARN; the desktop exe or a newer one pass', () => {
  assert.equal(judgeCodexOnPath({ hit: null }).status, 'PASS');
  const desk = { desktopExe: path.resolve('/apps/codex/codex.exe'), desktopVersion: 'codex-cli 0.165.0-alpha.1' };
  assert.equal(judgeCodexOnPath({ ...desk, hit: desk.desktopExe }).status, 'PASS');
  assert.equal(judgeCodexOnPath({ ...desk, hit: path.resolve('/npm/codex.cmd'), npmVersion: '0.200.0' }).status, 'WARN');
  assert.equal(judgeCodexOnPath({ ...desk, hit: path.resolve('/bin/codex.exe'), version: 'codex-cli 0.150.2' }).status, 'WARN');
  assert.equal(judgeCodexOnPath({ ...desk, hit: path.resolve('/bin/codex.exe'), version: 'codex-cli 0.165.0' }).status, 'PASS');
  assert.equal(judgeCodexOnPath({ ...desk, hit: path.resolve('/bin/codex.exe'), version: null }).status, 'WARN');
  assert.ok(compareVersions('v24.22.2', 'v22.17.0') > 0);
  assert.equal(compareVersions('x', '1.0.0'), null);
});

test('PATH lookup finds an npm shim and reads the version from its package.json without running it', () => {
  const dir = tempDir('check-kit-path-');
  const shim = path.join(dir, WIN ? 'codex.cmd' : 'codex');
  fs.writeFileSync(shim, 'exit 1\n');
  if (!WIN) fs.chmodSync(shim, 0o755);
  const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.100.1' }));
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  const hit = findOnPath('codex', env);
  assert.equal(hit && path.resolve(hit), path.resolve(shim));
  assert.equal(npmPackageVersion(hit, '@openai/codex'), '0.100.1');
  assert.equal(findOnPath('absent-tool-xyz', env), null);
});

test('version rows: codex runs with CODEX_HOME in a temp dir that is removed; the codex on PATH older than the desktop one is a WARN', () => {
  const sb = sandbox('home-ok');
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: sb.local });
  const install = tempDir('check-kit-appx-');
  const desktopExe = path.join(install, 'app', 'resources', 'codex.exe');
  fs.mkdirSync(path.dirname(desktopExe), { recursive: true });
  fs.writeFileSync(desktopExe, 'fake');
  const bin = tempDir('check-kit-bin-');
  const oldExe = path.join(bin, WIN ? 'codex.exe' : 'codex');
  fs.writeFileSync(oldExe, 'fake');
  if (!WIN) fs.chmodSync(oldExe, 0o755);
  const calls = [];
  const run = (file, extraEnv = {}) => {
    calls.push({ file: path.resolve(file), codexHome: extraEnv.CODEX_HOME, homeExists: !!extraEnv.CODEX_HOME && fs.existsSync(extraEnv.CODEX_HOME) });
    if (path.resolve(file) === path.resolve(desktopExe)) return { ok: true, out: 'codex-cli 0.165.0' };
    if (path.resolve(file) === path.resolve(oldExe)) return { ok: true, out: 'codex-cli 0.120.0' };
    return { ok: true, out: 'v1.0.0' };
  };
  const rows = [];
  const sec = { pass: (...a) => rows.push(['PASS', ...a]), warn: (...a) => rows.push(['WARN', ...a]), fail: (...a) => rows.push(['FAIL', ...a]) };
  const facts = { registry: null, appx: [{ name: 'OpenAI.Codex', version: '1.2.3.0', install_location: install }] };
  versionChecks(ctx, sec, { facts, env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, run });
  const byId = Object.fromEntries(rows.map(([status, id, , detail]) => [id, { status, detail }]));
  assert.equal(byId['version.codex-desktop'].status, 'PASS');
  assert.equal(byId['version.codex-exe'].detail, 'codex-cli 0.165.0');
  assert.equal(byId['version.codex-path'].status, 'WARN');
  assert.match(byId['version.codex-path'].detail, /older than the desktop app/);
  const codexCalls = calls.filter((c) => c.file === path.resolve(desktopExe) || c.file === path.resolve(oldExe));
  assert.equal(codexCalls.length, 2);
  for (const c of codexCalls) {
    assert.ok(c.homeExists, 'codex ran without a temp CODEX_HOME');
    assert.ok(path.resolve(c.codexHome).startsWith(path.resolve(os.tmpdir())));
    assert.ok(!fs.existsSync(c.codexHome), 'the temp CODEX_HOME was not removed');
  }
  assert.equal(byId['version.node-portable'].status, 'PASS');
  assert.equal(byId['version.project-manager'].status, 'WARN');
});

test('runVersion starts a CLI with DISABLE_AUTOUPDATER=1 and the extra environment', () => {
  const dir = tempDir('check-kit-run-');
  let probe;
  if (WIN) {
    probe = path.join(dir, 'probe.cmd');
    fs.writeFileSync(probe, '@echo updater=%DISABLE_AUTOUPDATER% home=%CODEX_HOME%\r\n');
  } else {
    probe = path.join(dir, 'probe');
    fs.writeFileSync(probe, '#!/bin/sh\necho "updater=$DISABLE_AUTOUPDATER home=$CODEX_HOME"\n');
    fs.chmodSync(probe, 0o755);
  }
  const r = runVersion(probe, { CODEX_HOME: 'temp-home' });
  assert.ok(r.ok, r.error);
  assert.equal(r.out, 'updater=1 home=temp-home');
  assert.equal(runVersion(path.join(dir, 'absent.exe')).ok, false);
});

test('Windows facts come from structured PowerShell output: booleans for the registry, a list for Appx', { skip: WIN ? false : 'not Windows' }, () => {
  const f = windowsFacts();
  assert.ok(f.registry, `registry not read: ${f.registry_error}`);
  assert.equal(typeof f.registry.hkcu, 'boolean');
  assert.equal(typeof f.registry.hklm, 'boolean');
  assert.ok(Array.isArray(f.appx));
  for (const p of f.appx) assert.deepEqual(Object.keys(p).sort(), ['install_location', 'name', 'version']);
});

test('helpers: command tokens, TOML strings, hook parts, row counts', () => {
  assert.deepEqual(commandTokens('"C:/a b/node.exe" "C:/example/hooks/guard.mjs" --platform codex'), ['C:/a b/node.exe', 'C:/example/hooks/guard.mjs', '--platform', 'codex']);
  assert.deepEqual(tomlStrings('["C:/example/index.js", \'D:\\example\\z.js\']'), ['C:/example/index.js', 'D:\\example\\z.js']);
  assert.deepEqual(hookParts({ command: '/opt/node', args: ['/rt/hooks/session-start.mjs', '--platform', 'claude'] }), { exe: '/opt/node', scripts: ['/rt/hooks/session-start.mjs'] });
  assert.deepEqual(hookParts({ command: '"/opt/node" "/rt/other/guard.mjs"' }).scripts, []);
  assert.deepEqual(countRows([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'FAIL' }]), { PASS: 1, WARN: 0, FAIL: 2 });
});

test('usage errors exit 2', () => {
  assert.equal(cli(['--bogus']).status, 2);
  assert.equal(cli(['--home', '']).status, 2);
  const bad = path.join(tempDir('check-kit-badlocal-'), 'kit-local.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(cli(['--local-config', bad, '--report-only']).status, 2);
  assert.equal(cli(['--help']).status, 0);
});

test('the fixtures, the real Codex temp folder and the real settings files are unchanged', () => {
  for (const h of HOMES) assert.deepEqual(treeHash(path.join(FIXTURES, h)), FIXTURES_BEFORE[h], h);
  assert.deepEqual(realFingerprint(), REAL_BEFORE);
});
