// Tests for scripts/check-kit.mjs (node:test, zero dependencies). The six hand-written fake user
// directories in tests/kit/fixtures/home-*/ (deployed, before a deploy, CLAUDE_CODE_EFFORT_LEVEL set, old
// and duplicate skill copies, neutral profile, no project-verifier) are copied into OS temp dirs, their
// placeholders filled, the kit groups of their fixture.json installed from the repo and their
// git-remotes.json markers turned into git repositories; check-kit runs on them as a CLI with --home,
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
  windowsFacts, compareVersions, commandTokens, tomlStrings, hookParts, EFFORT_VAR, HEARTBEAT_STALE_DAYS,
  oldReferences, codexHookTrust, registeredHooks, lastHeartbeats, removeCommand, runSelftest,
} from '../../scripts/check-kit.mjs';
import { claudePathRule, desiredFiles, KIT_HOOK_SCRIPTS } from '../../scripts/lib/kit-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-kit.mjs');
const FIXTURES = path.join(REPO, 'tests', 'kit', 'fixtures');
const HOMES = ['home-ok', 'home-missing', 'home-effort', 'home-dup', 'home-neutral', 'home-noverifier'];
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

// Child git runs without inherited repo selectors, so a caller's GIT_DIR never redirects it.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|PREFIX)$/i.test(k)));
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', env: GIT_ENV, windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

/** Every file under dir (absolute paths). */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/**
 * A temp copy of one fixture (laid on its fixture.json base, if any) with its placeholders filled: <home>,
 * <runtime>, <projects>, <projects-posix> (Claude's rule form of the projects folder), <node> (the Node that
 * runs this test) and <recent> (one hour ago). Then the kit groups of fixture.json are installed from the
 * repo where the tree has no file of its own, and every git-remotes.json becomes a repository with those
 * remotes (the marker is removed).
 */
function sandbox(name, { dist = true } = {}) {
  const root = tempDir(`check-kit-${name}-`);
  const specFile = path.join(FIXTURES, name, 'fixture.json');
  const spec = fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : {};
  if (spec.base) fs.cpSync(path.join(FIXTURES, spec.base), root, { recursive: true });
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true });
  const sb = { root, home: path.join(root, 'home'), runtime: path.join(root, 'runtime'), projects: path.join(root, 'projects'), local: path.join(root, 'local.json') };
  fs.mkdirSync(sb.projects, { recursive: true });
  const posix = claudePathRule('Edit', sb.projects).slice('Edit('.length, -'/**)'.length);
  const fill = {
    '<home>': fwd(sb.home), '<runtime>': fwd(sb.runtime), '<projects-posix>': posix, '<projects>': fwd(sb.projects), '<node>': fwd(process.execPath),
    '<recent>': new Date(Date.now() - 3_600_000).toISOString(),
  };
  for (const p of filesUnder(root)) {
    const text = fs.readFileSync(p, 'utf8');
    const out = text.replace(/<projects-posix>|<projects>|<home>|<runtime>|<node>|<recent>/g, (m) => fill[m]);
    if (out !== text) fs.writeFileSync(p, out);
  }
  const kit = spec.kit ?? [];
  const put = (file, content) => {
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const d of desiredFiles({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects })) {
    if (kit.includes(d.group) && ['contract', 'skills', 'agents'].includes(d.group)) put(d.path, d.content);
  }
  if (kit.includes('hooks')) for (const n of KIT_HOOK_SCRIPTS) put(path.join(sb.runtime, 'hooks', n), fs.readFileSync(path.join(REPO, 'hooks', n)));
  for (const marker of filesUnder(root).filter((p) => path.basename(p) === 'git-remotes.json')) {
    const dir = path.dirname(marker);
    const remotes = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker);
    git(['-c', 'init.defaultBranch=main', 'init', '-q', dir]);
    for (const [remote, r] of Object.entries(remotes)) {
      git(['-C', dir, 'remote', 'add', remote, r.url]);
      if (r.pushurl) git(['-C', dir, 'config', `remote.${remote}.pushurl`, r.pushurl]);
    }
  }
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

// ---------- the six fake user directories, through the CLI ----------

// Rows of checks 3-6 that are a WARN on a correct deploy: home-ok has a repository in its read-only folder
// (pushurl skipped). Its config.toml trusts the kit's Codex hook handler, so that row passes.
const DEPLOYED_WARN = ['pushurl.readonly'];

test('deployed home: no FAIL, strict exit 0, every config, copy, hook, pushurl and rules row passes, the tree is unchanged', () => {
  const sb = sandbox('home-ok');
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 0 });
  assert.deepEqual(failIds(json.rows), []);
  for (const r of json.rows.filter((x) => x.section !== 'versions')) {
    // The registry rows depend on this machine; every row from the fake home must pass.
    if (r.id === 'effort.hkcu' || r.id === 'effort.hklm') continue;
    assert.equal(r.status, DEPLOYED_WARN.includes(r.id) ? 'WARN' : 'PASS', `${r.id}: ${r.detail}`);
  }
  for (const s of ['copies', 'hooks', 'pushurl', 'rules']) assert.ok(json.rows.some((r) => r.section === s), `no ${s} rows`);
  assert.match(row(json.rows, 'claude.deny.readonly').detail, /1 Edit rule/);
  assert.match(row(json.rows, 'claude.hook.paths').detail, /3 kit hook entries/);
  assert.equal(row(json.rows, 'version.project-manager').status, 'WARN', 'a synthetic build is not 1.5.1');
  assert.match(row(json.rows, 'contract').detail, /claude_contract import/);
  assert.match(row(json.rows, 'skills.kit.agents').detail, /7 skills match/);
  assert.match(row(json.rows, 'hooks.selftest.guard').detail, /^guard selftest: ok \(\d+ samples\) \(portable Node\)/);
  for (const id of ['hooks.heartbeat.claude.guard', 'hooks.heartbeat.claude.session-start', 'hooks.heartbeat.codex.guard']) assert.match(row(json.rows, id).detail, /1 h ago/);
  assert.match(row(json.rows, 'hooks.codex-trust').detail, /^pre_tool_use:0:0 trusted \(已信任\): trusted_hash in .*\(the hash itself is not checked\)$/);
  assert.match(row(json.rows, 'pushurl.repos').detail, /^1 repo\(s\) with remotes, 1 remote\(s\), all no_push/);
  assert.match(row(json.rows, 'pushurl.readonly').detail, /skipped \(跳过\): <projects>\/demo\/frozen/);
  const text = cli(sb.args);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /0 FAIL/);
  assert.match(text.stdout, /^6\. project rule files/m);
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
    'contract', 'skills.kit.claude', 'skills.kit.agents', 'agents.project-verifier',
    'hooks.heartbeat.claude.guard', 'hooks.heartbeat.claude.session-start', 'hooks.heartbeat.codex.guard', 'hooks.selftest.guard',
    'pushurl.repos',
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
  assert.match(row(json.rows, 'skills.kit.claude').detail, /^7 of 7: project-consult missing/);
  assert.match(row(json.rows, 'hooks.heartbeat.codex.guard').detail, /does not exist: the hook never ran/);
  assert.match(row(json.rows, 'hooks.heartbeat.codex.guard').fix, /Codex \/hooks/);
  assert.match(row(json.rows, 'hooks.selftest.guard').detail, /no output/);
  // Only origin lacks no_push; the mirror remote already has it.
  assert.match(row(json.rows, 'pushurl.repos').detail, /^1 of 2 remote\(s\) in 1 repo\(s\) without no_push: <projects>\/app \(origin\)$/);

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

test('old and duplicate skill copies: FAIL in strict mode; brace folder, outdated template, old agent and rule-file lines are WARN; the tree is unchanged', () => {
  const sb = sandbox('home-dup');
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 1 });
  assert.deepEqual(failIds(json.rows), [
    'skills.kit.agents', 'skills.old.codex', 'skills.old.codex-agent', 'skills.old.gemini', 'skills.old.workflow',
    'skills.retired.agents', 'skills.retired.claude',
  ].sort());
  assert.match(row(json.rows, 'skills.kit.agents').detail, /^1 of 7: project-next differs$/);
  assert.equal(row(json.rows, 'skills.kit.claude').status, 'PASS');
  assert.match(row(json.rows, 'skills.retired.claude').detail, /project-init/);
  assert.match(row(json.rows, 'skills.retired.claude').fix, /deploy-kit\.mjs --apply/);
  assert.match(row(json.rows, 'skills.retired.agents').fix, /Remove-Item -LiteralPath '.*project-review' -Recurse/);
  assert.match(row(json.rows, 'skills.old.codex').detail, /project-next; 1 share a name with a kit skill \(duplicate\)/);
  const brace = row(json.rows, 'skills.brace');
  assert.equal(brace.status, 'WARN');
  assert.match(brace.fix, /^Remove-Item -LiteralPath '.*\{project-init,project-next\}' -Recurse$/);
  const stale = row(json.rows, 'templates.stale');
  assert.equal(stale.status, 'WARN');
  assert.match(stale.detail, /global-codex-AGENTS\.md/);
  assert.match(stale.fix, /^Remove-Item -LiteralPath '.*global-codex-AGENTS\.md'$/);
  assert.equal(row(json.rows, 'agents.legacy').status, 'WARN');
  assert.match(row(json.rows, 'agents.legacy').fix, /--retire-legacy-agents/);
  assert.equal(row(json.rows, 'agents.project-verifier').status, 'PASS');

  // Check 6 lists the lines with a replacement each; set_project_dir and the kit skill names are not reported.
  assert.equal(row(json.rows, 'rules.scan').status, 'WARN');
  const claudeMd = row(json.rows, 'rules.<projects>/legacy/CLAUDE.md');
  assert.equal(claudeMd.status, 'WARN');
  assert.equal(claudeMd.lines.length, 2);
  assert.match(claudeMd.lines[0], /^L4: .*project-init -> project-plan.*; project-design -> project-plan/);
  assert.match(claudeMd.lines[1], /^L5: .*CouncilFlow -> drop it/);
  assert.ok(!claudeMd.lines.some((l) => /set_project_dir|project-next/.test(l.split('=>')[0])));
  const agentsMd = row(json.rows, 'rules.<projects>/legacy/AGENTS.md');
  assert.deepEqual(agentsMd.lines.map((l) => l.split(':')[0]), ['L3']);
  assert.match(agentsMd.lines[0], /project-review -> the platform's own review command/);

  const soft = report(sb, { strict: false, status: 0 });
  assert.deepEqual(failIds(soft.json.rows), failIds(json.rows));
  const text = cli([...sb.args, '--report-only']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /L4: .*=> project-init -> project-plan/);
  assert.match(text.stdout, /optional: Remove-Item -LiteralPath/);
  assert.deepEqual(treeHash(sb.root), before);
});

test('a brace folder and an outdated template on a deployed home are WARN with a delete command; strict mode still exits 0', () => {
  const sb = sandbox('home-ok');
  fs.mkdirSync(path.join(sb.home, '.codex', 'agents', 'skills', '{project-init,project-plan}'), { recursive: true });
  fs.mkdirSync(path.join(sb.home, '.workflow-core', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.workflow-core', 'templates', 'global-codex-AGENTS.md'), '# synthetic\n');
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 0 });
  assert.deepEqual(failIds(json.rows), []);
  for (const id of ['skills.brace', 'templates.stale']) {
    assert.equal(row(json.rows, id).status, 'WARN');
    assert.match(row(json.rows, id).fix, /^Remove-Item -LiteralPath /);
  }
  assert.deepEqual(treeHash(sb.root), before);
});

test('neutral profile: FAIL naming --rollback <neutral id> in strict mode, WARN under --report-only; the tree is unchanged', () => {
  const sb = sandbox('home-neutral');
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 1 });
  assert.deepEqual(failIds(json.rows), ['kit.neutral']);
  const n = row(json.rows, 'kit.neutral');
  assert.match(n.detail, /^neutral 20261030-080000-a1b2 in place: 3 of 3 contract files/);
  assert.match(n.fix, /node scripts\/deploy-kit\.mjs --rollback 20261030-080000-a1b2 --local-config "/);
  // While parked, the contract and kit skill rows are left out.
  for (const id of ['contract', 'skills.kit.claude', 'skills.kit.agents']) assert.ok(!json.rows.some((r) => r.id === id), id);
  const soft = report(sb, { strict: false, status: 0 });
  assert.equal(row(soft.json.rows, 'kit.neutral').status, 'WARN');
  assert.equal(soft.json.counts.FAIL, 0);
  const text = cli([...sb.args, '--report-only']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /WARN {2}neutral profile/);
  assert.deepEqual(treeHash(sb.root), before);
});

test('the neutral line without a journal is still a FAIL; the fix says no journal was found', () => {
  const sb = sandbox('home-neutral');
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: path.join(sb.root, 'elsewhere', 'local.json') });
  const rows = runChecks(ctx, { env: cleanEnv(), facts: NO_FACTS, managed: [], run: noVersions });
  assert.equal(row(rows, 'kit.neutral').status, 'FAIL');
  assert.match(row(rows, 'kit.neutral').detail, /no journal found/);
  assert.match(row(rows, 'kit.neutral').fix, /--rollback <neutral id>/);
  assert.equal(row(runChecks(ctx, { reportOnly: true, env: cleanEnv(), facts: NO_FACTS, managed: [], run: noVersions }), 'kit.neutral').status, 'WARN');
});

test('no project-verifier.md: the only FAIL, with the deploy-kit fix; the tree is unchanged', () => {
  const sb = sandbox('home-noverifier');
  const before = treeHash(sb.root);
  const { json } = report(sb, { status: 1 });
  assert.deepEqual(failIds(json.rows), ['agents.project-verifier']);
  assert.match(row(json.rows, 'agents.project-verifier').detail, /project-verifier\.md does not exist/);
  assert.match(row(json.rows, 'agents.project-verifier').fix, /deploy-kit\.mjs --apply/);
  assert.equal(report(sb, { strict: false, status: 0 }).json.counts.FAIL, 1);
  // A verifier that differs from the repo copy is a FAIL too.
  const sb2 = sandbox('home-ok');
  fs.appendFileSync(path.join(sb2.home, '.claude', 'agents', 'project-verifier.md'), '\nedited\n');
  assert.match(row(report(sb2, { status: 1 }).json.rows, 'agents.project-verifier').detail, /differs/);
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

test('heartbeats: none is a FAIL, an old guard one is a FAIL, an old session-start one a WARN; a failing selftest is a FAIL; the registered hooks come from the fragments', () => {
  assert.deepEqual(registeredHooks(), [
    { hook: 'guard', platform: 'claude' }, { hook: 'session-start', platform: 'claude' }, { hook: 'guard', platform: 'codex' },
  ]);
  const sb = sandbox('home-ok');
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: sb.local });
  const later = new Date(Date.now() + (HEARTBEAT_STALE_DAYS + 3) * 86_400_000);
  const rows = runChecks(ctx, { env: cleanEnv(), facts: NO_FACTS, managed: [], run: noVersions, now: later, selftest: () => ({ ok: false, out: 'guard selftest: 2 of 30 failed' }) });
  // The guard fails closed on both platforms (owner decision 2026-10-31): an old guard heartbeat is a fault.
  for (const id of ['hooks.heartbeat.claude.guard', 'hooks.heartbeat.codex.guard']) {
    assert.equal(row(rows, id).status, 'FAIL');
    assert.match(row(rows, id).detail, /older than 7 days/);
    assert.match(row(rows, id).fix, /run one tool call/);
  }
  assert.match(row(rows, 'hooks.heartbeat.codex.guard').fix, /\/hooks/);
  assert.equal(row(rows, 'hooks.heartbeat.claude.session-start').status, 'WARN');
  const st = row(rows, 'hooks.selftest.guard');
  assert.equal(st.status, 'FAIL');
  assert.match(st.detail, /2 of 30 failed/);
  // A heartbeat file with only Claude lines: the Codex guard never ran.
  const hb = path.join(sb.runtime, 'hooks', 'heartbeat', 'guard.jsonl');
  fs.writeFileSync(hb, `${JSON.stringify({ ts: new Date().toISOString(), platform: 'claude', event: 'PreToolUse', decision: 'allow' })}\nnot json\n`);
  assert.deepEqual(Object.keys(lastHeartbeats(hb).last), ['claude']);
  const r = row(runChecks(ctx, { env: cleanEnv(), facts: NO_FACTS, managed: [], run: noVersions }), 'hooks.heartbeat.codex.guard');
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /no codex line/);
});

test('the deployed guard selftest runs the real samples and writes no heartbeat', () => {
  const runtime = tempDir('check-kit-selftest-');
  fs.mkdirSync(path.join(runtime, 'hooks'));
  for (const n of KIT_HOOK_SCRIPTS) fs.copyFileSync(path.join(REPO, 'hooks', n), path.join(runtime, 'hooks', n));
  fs.writeFileSync(path.join(runtime, 'hooks', 'hook-config.json'), JSON.stringify({ runtime: fwd(runtime) }));
  const before = treeHash(runtime);
  const r = runSelftest(process.execPath, path.join(runtime, 'hooks', 'guard.mjs'));
  assert.ok(r.ok, r.out);
  assert.match(r.out, /^guard selftest: ok \(\d+ samples\)$/);
  assert.deepEqual(treeHash(runtime), before);
  const stub = path.join(runtime, 'stub.mjs');
  fs.writeFileSync(stub, '// prints nothing\n');
  assert.equal(runSelftest(process.execPath, stub).ok, false);
});

test('Codex hook trust: one entry per kit handler, trusted only by its own hooks.state table', () => {
  const file = WIN ? 'C:\\example\\home\\.codex\\hooks.json' : '/example/home/.codex/hooks.json';
  const kit = { type: 'command', command: '/opt/node "/rt/hooks/guard.mjs" --platform codex' };
  const user = { type: 'command', command: 'node /example/user-hooks/audit.mjs' };
  const hooks = { PreToolUse: [{ matcher: '^Bash$', hooks: [user] }, { matcher: '^apply_patch$', hooks: [user, kit] }], SessionStart: [{ hooks: [kit] }] };
  const table = (key, value = '"sha256:9e9f"') => `[hooks.state.'${key}']\ntrusted_hash = ${value}\n`;
  assert.deepEqual(codexHookTrust(null, file, hooks), [
    { handler: 'pre_tool_use:1:1', trusted: false }, { handler: 'session_start:0:0', trusted: false },
  ]);
  // Slashes (and on Windows case) of the hooks.json path do not matter; the event, group and index do, and
  // project trust or another file's table never counts.
  const spelled = WIN ? 'c:/EXAMPLE/home/.codex/hooks.json' : file;
  const toml = [
    'model = "gpt-5"', `[projects.'${file}:session_start:0:0']`, 'trust_level = "trusted"',
    table(`${spelled}:pre_tool_use:1:1`), table(`${file}:pre_tool_use:0:0`), table(`${file}:session_start:0:0`, '""'),
    table('/example/other/.codex/hooks.json:session_start:0:0'),
  ].join('\n');
  assert.deepEqual(codexHookTrust(toml, file, hooks), [
    { handler: 'pre_tool_use:1:1', trusted: true }, { handler: 'session_start:0:0', trusted: false },
  ]);
  assert.deepEqual(codexHookTrust('[broken\n', file, hooks).map((x) => x.trusted), [false, false]);
  assert.deepEqual(codexHookTrust(toml, file, { PreToolUse: [{ hooks: [user] }] }), []);
});

test('Codex hook trust row: PASS when every kit handler is trusted, WARN with the /hooks fix when one is not', () => {
  const sb = sandbox('home-ok');
  const ctx = makeContext({ home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects, localConfig: sb.local });
  const trustRow = () => row(runChecks(ctx, { env: cleanEnv(), facts: NO_FACTS, managed: [], run: noVersions }), 'hooks.codex-trust');
  assert.equal(trustRow().status, 'PASS');
  const config = path.join(sb.home, '.codex', 'config.toml');
  const text = fs.readFileSync(config, 'utf8');
  fs.writeFileSync(config, text.slice(0, text.indexOf('[hooks.state.')));
  const untrusted = trustRow();
  assert.equal(untrusted.status, 'WARN');
  assert.match(untrusted.detail, /^pre_tool_use:0:0 not trusted \(未信任\)/);
  assert.match(untrusted.fix, /\/hooks/);
});

test('rule-file lines: retired skills and CouncilFlow with a replacement each; kit skills and set_project_dir are not reported', () => {
  const refs = oldReferences([
    '先调用 set_project_dir。', '用 /project-next 和 $project-plan。', '旧流程：/project-init，然后 project-discuss。',
    '分歧交给 CouncilFlow（council discuss）。', 'project-initiative 不是技能名。',
  ].join('\r\n'));
  assert.deepEqual(refs.map((r) => r.line), [3, 4]);
  assert.deepEqual(refs[0].hits, ['project-init', 'project-discuss']);
  assert.match(refs[0].suggestion, /^project-init -> project-plan .*; project-discuss -> project-consult/);
  assert.deepEqual(refs[1].hits, ['councilflow']);
  const long = oldReferences(`${'x'.repeat(300)} /project-review ${'y'.repeat(300)}`)[0];
  assert.ok(long.text.startsWith('...') && long.text.endsWith('...') && long.text.includes('project-review'), long.text);
});

test('removeCommand quotes the path for PowerShell', () => {
  const quoted = path.resolve('/tmp/it\'s');
  assert.equal(removeCommand(quoted, true), `Remove-Item -LiteralPath '${quoted.replace('\'', '\'\'')}' -Recurse`);
  assert.equal(removeCommand(path.resolve('/tmp/a.md'), false), `Remove-Item -LiteralPath '${path.resolve('/tmp/a.md')}'`);
});

test('usage errors exit 2', () => {
  assert.equal(cli(['--bogus']).status, 2);
  assert.equal(cli(['--home', '']).status, 2);
  const bad = path.join(tempDir('check-kit-badlocal-'), 'kit-local.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(cli(['--local-config', bad, '--report-only']).status, 2);
  assert.equal(cli(['--help']).status, 0);
});

test('started through a junction (symlink elsewhere) to scripts/: check-kit still runs', () => {
  const link = path.join(tempDir('check-kit-link-'), 'scripts-link');
  fs.symlinkSync(path.join(REPO, 'scripts'), link, WIN ? 'junction' : 'dir');
  try {
    const viaLink = path.join(link, 'check-kit.mjs');
    assert.notEqual(fs.realpathSync(viaLink).toLowerCase(), viaLink.toLowerCase(), 'the path really goes through a link');
    const r = spawnSync(process.execPath, [viaLink, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: node scripts\/check-kit\.mjs/, 'the usage is printed, so run() ran');
    assert.equal(spawnSync(process.execPath, [viaLink, '--bogus'], { encoding: 'utf8' }).status, 2);
  } finally {
    fs.unlinkSync(link);
  }
});

test('the fixtures, the real Codex temp folder and the real settings files are unchanged', () => {
  for (const h of HOMES) assert.deepEqual(treeHash(path.join(FIXTURES, h)), FIXTURES_BEFORE[h], h);
  assert.deepEqual(realFingerprint(), REAL_BEFORE);
});
