// Tests for scripts/deploy-kit.mjs and scripts/lib/kit-targets.mjs (node:test, zero dependencies). Every
// test copies the hand-written fixtures in tests/kit/fixtures/deploy/ into an OS temp dir and passes
// --home, --runtime, --projects-root and --local-config there, so the script never reads targets in the
// real user directory; the git repositories the pushurl plan looks at are created in the temp projects
// root. The --stage tests write only to folders under <repo>/_private/stage/ named deploy-kit-test-*, removed
// at the end. The last test checks that the real target files, the real runtime area and the .git/config of
// the real repositories are unchanged after the whole file ran.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, STAGE_MANIFEST } from '../../scripts/deploy-kit.mjs';
import {
  KIT_REPO, KIT_SKILLS, LEGACY_SKILL_DIRS, targetMap, mergeWorkflowRules, WF_BEGIN, WF_END,
  readLocalConfig, mergeClaudeSettings, mergeCodexConfig, claudePathRule, isKitHook,
} from '../../scripts/lib/kit-targets.mjs';
import { scanToml, setValue, getValue, keyValues, removeProjectsByPrefix, TomlEditError } from '../../scripts/lib/toml-edit.mjs';
import { applyPlan, scanRepos } from '../../scripts/set-pushurl.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'deploy-kit.mjs');
const FIXTURES = path.join(REPO, 'tests', 'kit', 'fixtures', 'deploy');
const STAGE_ROOT = path.join(REPO, '_private', 'stage');

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

// ---------- real user directory and runtime: fingerprint before any test runs ----------

/** sha256 (files) or "dir"/"link" of every entry under p, walked with lstat; {} when p does not exist. */
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

/** size and mtime of every entry under dir (the runtime holds a whole Node install; hashing it is slow). */
function treeStat(dir, out = {}, rel = '') {
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(p);
    out[r] = `${st.isDirectory() ? 'd' : 'f'}:${st.size}:${st.mtimeMs}`;
    if (st.isDirectory() && !st.isSymbolicLink()) treeStat(p, out, r);
  }
  return out;
}

/** The kit's targets in the real user directory: contract files, agents, templates, rules, the merged
 *  settings and Codex files, and every project-* or brace folder in the skill locations. */
function realHomeFingerprint() {
  const t = targetMap({ home: os.homedir(), runtime: os.tmpdir(), projectsRoot: os.tmpdir() });
  const out = {};
  for (const p of [t.claudeAgentsMd, t.claudeMd, t.codexAgentsMd, t.claudeAgents, t.workflowTemplates, t.workflowRules,
    t.claudeSettings, t.codexConfig, t.codexHooks, path.dirname(t.codexRules)]) out[p] = treeHash(p);
  for (const base of [...new Set([...LEGACY_SKILL_DIRS.map((l) => t[l.key]), t.agentsSkills])]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { /* absent */ }
    for (const n of names.filter((x) => x.startsWith('project-') || x.startsWith('{')).sort()) out[path.join(base, n)] = treeHash(path.join(base, n));
  }
  return out;
}

function realLocal() {
  try { return JSON.parse(fs.readFileSync(path.join(KIT_REPO, '_private', 'kit-local.json'), 'utf8')); } catch { return {}; }
}

function realRuntime() {
  return realLocal().runtime ?? path.join(KIT_REPO, '_private', 'rt');
}

/** The .git/config (or .git file) of every repository under the real projects root, as set-pushurl finds them. */
function realRepoConfigs() {
  const root = realLocal().projects_root ?? path.dirname(KIT_REPO);
  const out = {};
  for (const repo of scanRepos(root).candidates) {
    const git = path.join(repo, '.git');
    out[repo] = treeHash(fs.lstatSync(git).isDirectory() ? path.join(git, 'config') : git);
  }
  return out;
}

const REAL_HOME_BEFORE = realHomeFingerprint();
const REAL_RUNTIME_BEFORE = treeStat(realRuntime());
const REAL_REPOS_BEFORE = realRepoConfigs();

// ---------- sandbox ----------

/** git in a temp folder, without inherited repo selectors; throws on failure. */
function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/i.test(k)));
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error}`);
  return r.stdout;
}

/**
 * A fresh temp tree: home/ and projects/ copied from the fixtures, runtime/ with two fake portable Nodes,
 * private/ for the local config. A never-touch ledger build is added here (dist/ is git-ignored), and two
 * git repositories with a remote: projects/demo-app (gets pushurl = no_push) and the read-only
 * projects/archive-study/phase1-archive (skipped).
 */
function sandbox({ init = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-kit-'));
  temps.push(root);
  const sb = {
    root, home: path.join(root, 'home'), runtime: path.join(root, 'runtime'), projects: path.join(root, 'projects'),
    privateDir: path.join(root, 'private'),
  };
  sb.localConfig = path.join(sb.privateDir, 'kit-local.json');
  fs.cpSync(path.join(FIXTURES, 'home'), sb.home, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'projects'), sb.projects, { recursive: true });
  const dist = path.join(sb.home, '.claude', 'mcp-project-manager', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(dist), { recursive: true });
  fs.writeFileSync(dist, '// synthetic ledger build\n');
  for (const v of ['1.2.3', '1.10.0']) {
    const dir = path.join(sb.runtime, `node-v${v}-win-x64`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'node.exe'), 'fake');
  }
  fs.mkdirSync(path.join(sb.runtime, 'node-v9.9.9-win-x64'));
  for (const rel of [['demo-app'], ['archive-study', 'phase1-archive']]) {
    const repo = path.join(sb.projects, ...rel);
    git(repo, 'init', '-q');
    git(repo, 'remote', 'add', 'origin', `https://example.invalid/owner/${rel[rel.length - 1]}.git`);
  }
  fs.mkdirSync(sb.privateDir);
  sb.roots = { home: sb.home, runtime: sb.runtime, projectsRoot: sb.projects };
  sb.rootArgs = ['--home', sb.home, '--runtime', sb.runtime, '--projects-root', sb.projects, '--local-config', sb.localConfig];
  if (init) {
    const r = run(['--init-local', '--runtime', sb.runtime, '--projects-root', sb.projects, '--local-config', sb.localConfig]);
    assert.equal(r.status, 0, r.stderr);
  }
  return sb;
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function planOf(sb, ...extra) {
  const r = run([...sb.rootArgs, '--json', ...extra]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const fwd = (p) => path.resolve(p).split(path.sep).join('/');
const inHome = (sb, ...p) => fwd(path.join(sb.home, ...p));
const paths = (list) => list.map((e) => e.path);

const localOf = (sb) => readLocalConfig(sb.localConfig);
const rootsOf = (sb) => ({ home: path.resolve(sb.home), runtime: path.resolve(sb.runtime), projectsRoot: path.resolve(sb.projects) });

/** Bring the sandbox to the planned state (a stand-in for --apply, which comes with AS3-113). */
function materialize(sb, opts = {}) {
  const plan = buildPlan(rootsOf(sb), { ...opts, local: localOf(sb) });
  for (const e of [...plan.create, ...plan.modify]) {
    fs.mkdirSync(path.dirname(e.path), { recursive: true });
    fs.writeFileSync(e.path, e.content);
  }
  for (const e of plan.remove) fs.rmSync(e.path, { recursive: true, force: true });
  const log = path.join(sb.privateDir, `pushurl-${crypto.randomUUID()}.json`);
  assert.equal(applyPlan(plan.pushurlPlan, log).failed, 0);
  return plan;
}

/** Parse TOML text with Python's tomllib (python, else the py launcher); null when neither is there. */
function parseToml(text, dir) {
  const file = path.join(dir, `toml-${crypto.randomUUID()}.toml`);
  fs.writeFileSync(file, text);
  try {
    const code = 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))';
    for (const [cmd, pre] of [['python', []], ['py', ['-3']]]) {
      const r = spawnSync(cmd, [...pre, '-c', code, file], { encoding: 'utf8' });
      if (r.status === 0) return JSON.parse(r.stdout);
      if (r.error?.code !== 'ENOENT' && r.stderr) throw new Error(`${cmd}: ${r.stderr.trim()}`);
    }
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const planned = (plan, ...p) => [...plan.create, ...plan.modify].find((e) => path.resolve(e.path) === path.resolve(...p));
const content = (e) => e.content.toString('utf8');

// ---------- local config ----------

test('dry-run without a local config exits 2 and names --init-local', () => {
  const sb = sandbox({ init: false });
  const r = run(sb.rootArgs);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /local config .* not found/);
  assert.match(r.stderr, /--init-local/);
  assert.deepEqual(fs.readdirSync(sb.privateDir), []);
});

test('--init-local writes the local config and the two canaries, and keeps owner edits on a re-run', () => {
  const sb = sandbox({ init: false });
  const homeBefore = treeHash(sb.home);
  const projectsBefore = treeHash(sb.projects);
  const r = run(['--init-local', '--runtime', sb.runtime, '--projects-root', sb.projects, '--local-config', sb.localConfig]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(sb.localConfig, 'utf8'));
  const ro = fwd(path.join(sb.privateDir, 'eval', 'smoke', 'readonly-canary'));
  const cu = fwd(path.join(sb.privateDir, 'eval', 'smoke', 'customer-canary'));
  assert.deepEqual(cfg.readonly_dirs.sort(), [
    fwd(path.join(sb.projects, 'archive-study', 'phase1-archive')),
    fwd(path.join(sb.projects, 'demo-app', 'vendor-frozen')),
    ro,
  ].sort());
  assert.deepEqual(cfg.customer_data_dirs, [cu]);
  assert.equal(cfg.runtime, fwd(sb.runtime));
  assert.equal(cfg.portable_node, fwd(path.join(sb.runtime, 'node-v1.10.0-win-x64', 'node.exe')));
  assert.equal(cfg.projects_root, fwd(sb.projects));
  assert.equal(cfg.restore_tool, fwd(path.join(sb.privateDir, 'redesign-2026-10', 'step0', 'restore.mjs')));
  assert.equal(cfg.deploy_options, undefined, 'deploy_options is written by --apply, not by --init-local');
  for (const dir of [ro, cu]) assert.ok(fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').length > 0);
  // Only the local config and the canaries were written.
  assert.deepEqual(Object.keys(treeHash(sb.privateDir)).sort(), ['.', 'eval', 'eval/smoke', 'eval/smoke/customer-canary',
    'eval/smoke/customer-canary/README.txt', 'eval/smoke/readonly-canary', 'eval/smoke/readonly-canary/README.txt', 'kit-local.json']);
  assert.deepEqual(treeHash(sb.home), homeBefore);
  assert.deepEqual(treeHash(sb.projects), projectsBefore);

  // The owner adds a customer folder and a deploy records its options: a re-run keeps both.
  const extra = fwd(path.join(sb.root, 'customer-real'));
  cfg.customer_data_dirs.push(extra);
  cfg.deploy_options = { claude_contract: 'inline', retire_legacy_agents: true };
  fs.writeFileSync(sb.localConfig, `${JSON.stringify(cfg, null, 2)}\n`);
  const before = fs.readFileSync(sb.localConfig, 'utf8');
  const again = run(['--init-local', '--local-config', sb.localConfig]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already current/);
  assert.equal(fs.readFileSync(sb.localConfig, 'utf8'), before);
});

test('a malformed local config is a setup error', () => {
  const sb = sandbox({ init: false });
  fs.writeFileSync(sb.localConfig, '{"readonly_dirs": ["relative/dir"]}');
  const r = run(sb.rootArgs);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /readonly_dirs must be a list of absolute paths/);
});

// ---------- dry-run ----------

test('dry-run is the default, prints create, modify and remove with reasons, and writes nothing', () => {
  const sb = sandbox();
  const before = treeHash(sb.root);
  for (const args of [sb.rootArgs, [...sb.rootArgs, '--dry-run'], [...sb.rootArgs, '--retire-legacy-agents', '--claude-contract', 'inline']]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry-run, nothing is written/);
    assert.match(r.stdout, /^create \(\d+\):/m);
    assert.match(r.stdout, /^modify \(\d+\):/m);
    assert.match(r.stdout, /^remove \(\d+\):/m);
    assert.match(r.stdout, /\+ ~\/\.agents\/skills\/project-next\/SKILL\.md {2}\[skills\] \S/);
  }
  assert.deepEqual(treeHash(sb.root), before);
});

test('the plan covers the contract, the 7 skills on both platforms, the verifier, the templates and workflow-rules.md', () => {
  const sb = sandbox();
  const plan = planOf(sb);
  const written = new Map([...plan.create, ...plan.modify].map((e) => [e.path, e]));
  for (const p of [['.claude', 'AGENTS.md'], ['.codex', 'AGENTS.md'], ['.claude', 'CLAUDE.md'], ['.claude', 'agents', 'project-verifier.md']]) {
    assert.ok(written.has(inHome(sb, ...p)), p.join('/'));
  }
  for (const s of KIT_SKILLS) {
    assert.ok(written.has(inHome(sb, '.claude', 'skills', s, 'SKILL.md')), s);
    assert.ok(written.has(inHome(sb, '.agents', 'skills', s, 'SKILL.md')), s);
  }
  for (const f of fs.readdirSync(path.join(REPO, 'templates'))) assert.ok(written.has(inHome(sb, '.workflow-core', 'templates', f)), f);
  const rules = written.get(inHome(sb, '.workflow-core', 'policies', 'workflow-rules.md'));
  assert.equal(rules.mode, 'merge');
  for (const e of written.values()) assert.ok(e.reason && e.reason.length > 5, `reason for ${e.path}`);
  // Existing files are modifications, new ones creations.
  assert.ok(paths(plan.modify).includes(inHome(sb, '.claude', 'skills', 'project-next', 'SKILL.md')));
  assert.ok(paths(plan.create).includes(inHome(sb, '.claude', 'skills', 'project-quick', 'SKILL.md')));
  assert.deepEqual(plan.conflicts, []);
});

test('the plan adds settings.json, config.toml, the Codex hooks and rules, the runtime hooks and pushurl', () => {
  const sb = sandbox();
  const plan = planOf(sb);
  const mode = (list, ...p) => list.find((e) => e.path === fwd(path.join(...p)))?.mode;
  assert.equal(mode(plan.modify, sb.home, '.claude', 'settings.json'), 'merge');
  assert.equal(mode(plan.modify, sb.home, '.codex', 'config.toml'), 'merge');
  assert.equal(mode(plan.create, sb.home, '.codex', 'hooks.json'), 'whole');
  assert.equal(mode(plan.create, sb.home, '.codex', 'rules', 'autoskills.rules'), 'whole');
  for (const f of ['guard.mjs', 'session-start.mjs', 'hook-config.json']) assert.equal(mode(plan.create, sb.runtime, 'hooks', f), 'whole', f);
  for (const f of ['guard.mjs', 'session-start.mjs']) {
    const e = plan.create.find((x) => x.path === fwd(path.join(sb.runtime, 'hooks', f)));
    assert.equal(e.source, fwd(path.join(REPO, 'hooks', f)));
  }
  // pushurl: the repo with a remote gets no_push; the read-only one is skipped and listed.
  assert.deepEqual(plan.pushurl.map((e) => [e.repo, e.remote, e.original, e.value]), [[fwd(path.join(sb.projects, 'demo-app')), 'origin', null, 'no_push']]);
  const ro = fwd(path.join(sb.projects, 'archive-study', 'phase1-archive'));
  assert.ok(plan.listed.some((e) => e.path === ro && /pushurl not set: read-only dir/.test(e.reason)));
  assert.ok(!plan.pushurl.some((e) => e.repo === ro));
  // The ledger registration is not a target.
  assert.ok(![...plan.create, ...plan.modify].some((e) => /\.claude\.json$|mcp-project-manager/.test(e.path)));
  const text = run(sb.rootArgs).stdout;
  assert.match(text, /~ ~\/\.claude\/settings\.json {2}\[settings, merge\] \S/);
  assert.match(text, /~ ~\/\.codex\/config\.toml {2}\[codex-config, merge\] only the fragment keys \(model_reasoning_effort, desktop\.followUpQueueMode\)/);
  assert.match(text, /\+ <runtime>\/hooks\/hook-config\.json {2}\[runtime\] \S/);
  assert.match(text, /~ <projects>\/demo-app\/\.git\/config {2}\[pushurl\] remote origin: pushurl unset -> no_push/);
  assert.match(text, /to modify \(1 pushurl\)/);
});

test('settings.json: the merge keeps permissions, hooks, plugins and other keys, and replaces old kit hooks', () => {
  const sb = sandbox();
  const local = localOf(sb);
  const plan = buildPlan(rootsOf(sb), { local });
  const before = JSON.parse(fs.readFileSync(path.join(sb.home, '.claude', 'settings.json'), 'utf8'));
  const after = JSON.parse(content(planned(plan, sb.home, '.claude', 'settings.json')));
  const fragment = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'claude', 'settings.fragment.json'), 'utf8'));
  // Unrelated content stays as it was.
  assert.equal(after.model, 'synthetic');
  assert.deepEqual(after.permissions.allow, before.permissions.allow);
  assert.deepEqual(after.enabledPlugins, before.enabledPlugins);
  assert.equal(after.env.SYNTHETIC_FLAG, '1');
  assert.deepEqual(after.hooks.Stop, before.hooks.Stop);
  assert.deepEqual(Object.keys(after).slice(0, Object.keys(before).length), Object.keys(before), 'existing keys keep their order');
  // Deny: the user's rule first, then every fragment rule, then the generated folder rules.
  assert.equal(after.permissions.deny[0], 'Bash(rm -rf *)');
  for (const rule of fragment.permissions.deny) assert.ok(after.permissions.deny.includes(rule), rule);
  const ro = local.readonly_dirs.map((d) => claudePathRule('Edit', d));
  const cu = local.customer_data_dirs.map((d) => claudePathRule('Read', d));
  assert.deepEqual(after.permissions.deny.slice(-(ro.length + cu.length)), [...ro, ...cu]);
  assert.equal(ro.length, 3);
  for (const r of [...ro, ...cu]) assert.match(r, /^(?:Edit|Read)\(\/\/[^()]+\/\*\*\)$/);
  // Kit keys are set.
  assert.equal(after.subagentPromptCacheTtl, '1h');
  assert.deepEqual(after.worktree, { baseRef: 'head' });
  assert.equal(after.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS, '6');
  assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in after.env));
  // Hooks: the user's PreToolUse group stays first; the old kit hook is taken out of the mixed group (its
  // user hook stays) and the group that held only an old kit hook is gone; the kit groups are appended.
  const pre = after.hooks.PreToolUse;
  assert.deepEqual(pre[0], before.hooks.PreToolUse[0]);
  assert.deepEqual(pre[1], { ...before.hooks.PreToolUse[1], hooks: [before.hooks.PreToolUse[1].hooks[1]] });
  assert.equal(pre.length, 2 + fragment.hooks.PreToolUse.length);
  assert.equal(after.hooks.SessionStart.length, 1);
  const node = fwd(local.portable_node);
  for (const g of [...pre.slice(2), ...after.hooks.SessionStart]) {
    for (const h of g.hooks) {
      assert.ok(isKitHook(h));
      assert.equal(h.command, node);
      assert.ok(h.args[0].startsWith(`${fwd(sb.runtime)}/hooks/`), h.args[0]);
    }
  }
  assert.equal(pre[2].hooks[0].onFailure, 'block');
  assert.doesNotMatch(JSON.stringify(after), /<(?:node|runtime|home)>/);
  // A second merge changes nothing; line endings and indent follow the file.
  const filled = { ...after };
  assert.deepEqual(mergeClaudeSettings(after, JSON.parse(JSON.stringify(after))), filled);
  fs.writeFileSync(path.join(sb.home, '.claude', 'settings.json'), JSON.stringify(before, null, 4).replace(/\n/g, '\r\n'));
  const crlf = content(planned(buildPlan(rootsOf(sb), { local }), sb.home, '.claude', 'settings.json'));
  assert.ok(crlf.includes('\r\n') && !/[^\r]\n/.test(crlf));
  assert.match(crlf, /^\{\r\n {4}"model"/);
  assert.deepEqual(JSON.parse(crlf), after);
});

test('config.toml: only the fragment keys change; comments, order, trust, plugin and MCP sections stay', (t) => {
  const sb = sandbox();
  const file = path.join(sb.home, '.codex', 'config.toml');
  const before = fs.readFileSync(file, 'utf8');
  const after = content(planned(buildPlan(rootsOf(sb), { local: localOf(sb) }), file));
  const a = before.split('\n'), b = after.split('\n');
  assert.equal(b.length, a.length);
  const changed = a.map((l, i) => (l === b[i] ? null : [l, b[i]])).filter(Boolean);
  assert.deepEqual(changed, [
    ['model_reasoning_effort = "xhigh" # this comment stays', 'model_reasoning_effort = "medium" # this comment stays'],
    ['followUpQueueMode = "queue"', 'followUpQueueMode = "steer"'],
  ]);
  assert.equal(mergeCodexConfig(after, fs.readFileSync(path.join(REPO, 'config', 'codex', 'config.fragment.toml'), 'utf8')), after);
  const x = parseToml(before, sb.root);
  if (!x) { t.skip('no Python with tomllib found (python or py -3)'); return; }
  const y = parseToml(after, sb.root);
  x.model_reasoning_effort = 'medium';
  x.desktop.followUpQueueMode = 'steer';
  assert.deepEqual(y, x);
  assert.deepEqual(Object.keys(y), Object.keys(x));
  // A missing file becomes just the fragment keys.
  fs.rmSync(file);
  const fresh = content(planned(buildPlan(rootsOf(sb), { local: localOf(sb) }), file));
  assert.deepEqual(parseToml(fresh, sb.root), { model_reasoning_effort: 'medium', desktop: { followUpQueueMode: 'steer' } });
});

test('hooks.json: an existing file is merged, a new one is the filled fragment', () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.codex', 'hooks.json');
  const fresh = JSON.parse(content(planned(buildPlan(rootsOf(sb), { local: localOf(sb) }), file)));
  const local = localOf(sb);
  assert.equal(fresh.hooks.PreToolUse[0].hooks[0].command, `"${fwd(local.portable_node)}" "${fwd(sb.runtime)}/hooks/guard.mjs" --platform codex`);
  const user = { type: 'command', command: 'node C:/example/user-hooks/audit.mjs' };
  const existing = {
    note: 'synthetic',
    hooks: {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [user] },
        { matcher: '^apply_patch$', hooks: [{ type: 'command', command: '"C:/example/old/node.exe" "C:/example/old/hooks/guard.mjs" --platform codex' }] },
      ],
      PostToolUse: [{ matcher: '.*', hooks: [user] }],
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  const plan = buildPlan(rootsOf(sb), { local });
  const e = planned(plan, file);
  assert.equal(e.mode, 'merge');
  assert.ok(plan.modify.includes(e));
  const merged = JSON.parse(content(e));
  assert.equal(merged.note, 'synthetic');
  assert.deepEqual(merged.hooks.PostToolUse, existing.hooks.PostToolUse);
  assert.deepEqual(merged.hooks.PreToolUse, [existing.hooks.PreToolUse[0], fresh.hooks.PreToolUse[0]]);
  assert.equal(merged.description, fresh.description);
});

test('the runtime hook config feeds the deployed guard: a write into a read-only folder is denied', () => {
  const sb = sandbox();
  materialize(sb);
  const local = localOf(sb);
  const cfg = JSON.parse(fs.readFileSync(path.join(sb.runtime, 'hooks', 'hook-config.json'), 'utf8'));
  assert.deepEqual(cfg, { runtime: fwd(sb.runtime), readonly_dirs: local.readonly_dirs.map(fwd), kit_repo: fwd(REPO) });
  const guard = path.join(sb.runtime, 'hooks', 'guard.mjs');
  const call = (input) => spawnSync(process.execPath, [guard, '--platform', 'claude'], { input: JSON.stringify(input), encoding: 'utf8' });
  const target = path.join(sb.projects, 'demo-app', 'vendor-frozen', 'x.md');
  const denied = call({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target }, cwd: sb.projects });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /"permissionDecision":"deny"/);
  const allowed = call({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(sb.projects, 'demo-app', 'x.md') }, cwd: sb.projects });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
  // session-start runs next to the guard (it imports ./guard.mjs) and both write their heartbeat to the runtime.
  const ss = spawnSync(process.execPath, [path.join(sb.runtime, 'hooks', 'session-start.mjs'), '--platform', 'claude'], { input: '{"source":"startup","session_id":"s1"}', encoding: 'utf8' });
  assert.equal(ss.status, 0, ss.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sb.runtime, 'hooks', 'heartbeat')).sort(), ['guard.jsonl', 'session-start.jsonl']);
});

test('a merged file that cannot be read is a conflict (exit 1), not an overwrite', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.home, '.claude', 'settings.json'), '{ "model": "synthetic", }');
  fs.writeFileSync(path.join(sb.home, '.codex', 'config.toml'), 'model = "unterminated\n');
  const r = run([...sb.rootArgs, '--json']);
  assert.equal(r.status, 1, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.conflicts.map((c) => c.path).sort(), [inHome(sb, '.claude', 'settings.json'), inHome(sb, '.codex', 'config.toml')].sort());
  assert.ok(![...plan.create, ...plan.modify].some((e) => /settings\.json$|config\.toml$/.test(e.path)));
  // A local config without a portable Node cannot fill the hook commands.
  const cfg = JSON.parse(fs.readFileSync(sb.localConfig, 'utf8'));
  cfg.portable_node = null;
  fs.writeFileSync(sb.localConfig, JSON.stringify(cfg));
  const noNode = run(sb.rootArgs);
  assert.equal(noNode.status, 2);
  assert.match(noNode.stderr, /portable_node is not set/);
});

test('removals are only old project-* copies; other skills, the brace folder and the old agents stay', () => {
  const sb = sandbox();
  const plan = planOf(sb);
  const removed = paths(plan.remove).sort();
  assert.deepEqual(removed, [
    inHome(sb, '.claude', 'skills', 'project-ask'),
    inHome(sb, '.claude', 'skills', 'project-init'),
    inHome(sb, '.claude', 'skills', 'project-next', 'references', 'old-notes.md'),
    inHome(sb, '.codex', 'agents', 'skills', 'project-plan'),
    inHome(sb, '.codex', 'skills', 'project-discuss'),
    inHome(sb, '.codex', 'skills', 'project-next'),
    inHome(sb, '.gemini', 'skills', 'project-status'),
    inHome(sb, '.workflow-core', 'skills', 'project-review'),
  ].sort());
  for (const p of removed) assert.ok(p.split('/').some((seg) => seg.startsWith('project-')), p);
  const brace = inHome(sb, '.codex', 'agents', 'skills', '{project-init,project-plan}');
  assert.ok(paths(plan.listed).includes(brace));
  assert.ok(!removed.includes(brace));
  assert.ok(!JSON.stringify(plan).includes('code-reviewer'), 'old agents appear only with --retire-legacy-agents');

  const retire = planOf(sb, '--retire-legacy-agents');
  const agents = retire.remove.filter((e) => e.group === 'legacy-agents');
  assert.deepEqual(paths(agents).sort(), ['code-reviewer', 'researcher', 'tester'].map((a) => inHome(sb, '.claude', 'agents', `${a}.md`)));
  assert.ok(!JSON.stringify(retire).includes('my-helper'));
  assert.deepEqual(paths(retire.remove.filter((e) => e.group !== 'legacy-agents')).sort(), removed);
});

test('never-touch paths stay out of the plan; in ~/.workflow-core only templates, workflow-rules.md and old skills', () => {
  const sb = sandbox();
  const plan = planOf(sb, '--retire-legacy-agents');
  const all = [...plan.create, ...plan.modify, ...plan.remove].map((e) => e.path);
  for (const p of [['.claude.json'], ['.claude', 'mcp-project-manager'], ['.workflow-core', 'policies', 'verification-profiles.json'],
    ['.workflow-core', 'policies', 'acceptance-matrix.json']]) {
    assert.ok(!all.some((x) => x.startsWith(inHome(sb, ...p))), p.join('/'));
  }
  const wf = inHome(sb, '.workflow-core');
  for (const p of all.filter((x) => x.startsWith(`${wf}/`))) {
    assert.match(p.slice(wf.length + 1), /^(?:templates\/[^/]+|policies\/workflow-rules\.md|skills\/project-[^/]+)$/, p);
  }
  assert.ok(paths(plan.listed).includes(inHome(sb, '.workflow-core', 'templates', 'global-codex-AGENTS.md')));
  // Every file lies in the temp home, except the hook files, which go to <runtime>/hooks/.
  for (const p of all) assert.ok(p.startsWith(`${fwd(sb.home)}/`) || /\/hooks\/[^/]+$/.test(p) && p.startsWith(`${fwd(sb.runtime)}/hooks/`), `outside the temp home: ${p}`);
  assert.deepEqual(all.filter((p) => p.startsWith(`${fwd(sb.runtime)}/`)).sort(), ['guard.mjs', 'hook-config.json', 'session-start.mjs'].map((f) => fwd(path.join(sb.runtime, 'hooks', f))));
});

test('a repeated run after the plan is in place has an empty plan (import and inline)', () => {
  for (const contract of ['import', 'inline']) {
    const sb = sandbox();
    materialize(sb, { claudeContract: contract, retireLegacyAgents: true });
    const plan = planOf(sb, '--claude-contract', contract, '--retire-legacy-agents');
    assert.deepEqual([plan.create, plan.modify, plan.remove, plan.pushurl, plan.conflicts], [[], [], [], [], []], contract);
    assert.ok(plan.unchanged > 0);
    assert.equal(git(path.join(sb.projects, 'demo-app'), 'config', '--get', 'remote.origin.pushurl').trim(), 'no_push');
    // The merged files kept their own content.
    const settings = JSON.parse(fs.readFileSync(path.join(sb.home, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.enabledPlugins['synthetic-plugin@synthetic-market'] && settings.permissions.deny.includes('Bash(rm -rf *)'));
    const toml = fs.readFileSync(path.join(sb.home, '.codex', 'config.toml'), 'utf8');
    assert.ok(toml.includes('[plugins."github@synthetic-curated"]') && toml.includes('[mcp_servers.project-manager]') && toml.includes('# this comment stays'));
    // The kept parts are still there.
    assert.ok(fs.existsSync(path.join(sb.home, '.codex', 'skills', 'pdf', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(sb.home, '.claude', 'skills', 'other-tool', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(sb.home, '.claude', 'agents', 'my-helper.md')));
    assert.ok(fs.existsSync(path.join(sb.home, '.codex', 'agents', 'skills', '{project-init,project-plan}', 'SKILL.md')));
    const rules = fs.readFileSync(path.join(sb.home, '.workflow-core', 'policies', 'workflow-rules.md'), 'utf8');
    assert.ok(rules.includes(WF_BEGIN) && rules.includes('## Task Schema') && !rules.includes('## Core Rules'));
    // Switching the contract mode changes only ~/.claude/CLAUDE.md.
    const other = planOf(sb, '--claude-contract', contract === 'import' ? 'inline' : 'import', '--retire-legacy-agents');
    assert.deepEqual([paths(other.create), paths(other.modify), paths(other.remove)], [[], [inHome(sb, '.claude', 'CLAUDE.md')], []]);
  }
});

test('--claude-contract inline puts the contract in place of the import line', () => {
  const sb = sandbox();
  const plan = buildPlan(sb.roots, { claudeContract: 'inline', local: localOf(sb) });
  const claude = plan.modify.find((e) => e.path === path.join(sb.home, '.claude', 'CLAUDE.md')).content.toString('utf8');
  const contract = fs.readFileSync(path.join(REPO, 'templates', 'global-AGENTS.md'), 'utf8');
  assert.ok(claude.startsWith(contract.trimEnd()));
  assert.ok(!/^@AGENTS\.md$/m.test(claude));
  assert.ok(claude.includes('## Claude Code 专属'));
  const imp = buildPlan(sb.roots, { local: localOf(sb) }).modify.find((e) => e.path === path.join(sb.home, '.claude', 'CLAUDE.md')).content.toString('utf8');
  assert.ok(imp.startsWith('@AGENTS.md'));
  assert.equal(run([...sb.rootArgs, '--claude-contract', 'copy']).status, 2);
});

test('all three roots are redirected; runtime and projects root default to the local config', () => {
  const sb = sandbox();
  const plan = planOf(sb);
  assert.deepEqual(plan.roots, { home: fwd(sb.home), runtime: fwd(sb.runtime), projects_root: fwd(sb.projects) });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-kit-other-'));
  temps.push(other);
  const moved = planOf({ rootArgs: ['--home', sb.home, '--runtime', path.join(other, 'rt'), '--projects-root', other, '--local-config', sb.localConfig] });
  assert.deepEqual(moved.roots, { home: fwd(sb.home), runtime: fwd(path.join(other, 'rt')), projects_root: fwd(other) });
  const defaults = planOf({ rootArgs: ['--home', sb.home, '--local-config', sb.localConfig] });
  assert.deepEqual(defaults.roots, plan.roots);
  // An empty home gets every kit file as a creation and removes nothing; the hook files go to the runtime.
  const empty = path.join(other, 'empty-home');
  fs.mkdirSync(empty);
  const fresh = planOf({ rootArgs: ['--home', empty, '--local-config', sb.localConfig] });
  assert.deepEqual([fresh.modify.length, fresh.remove.length], [0, 0]);
  assert.ok(fresh.create.every((e) => e.path.startsWith(`${fwd(empty)}/`) || e.path.startsWith(`${fwd(sb.runtime)}/hooks/`)), 'creations in the home or <runtime>/hooks');
  assert.equal(fresh.create.filter((e) => e.path.startsWith(`${fwd(sb.runtime)}/`)).length, 3);
  // The moved runtime and projects root carry the plan with them.
  assert.ok(moved.create.some((e) => e.path === fwd(path.join(other, 'rt', 'hooks', 'guard.mjs'))));
  assert.deepEqual(moved.pushurl, []);
});

test('unknown options, misplaced options and the modes of later tasks exit 2', () => {
  const sb = sandbox();
  for (const args of [['--bogus'], ['--apply'], ['--rollback', 'x'], ['--neutral'], ['--stage', 'x'], ['--init-local', '--json'],
    ['--expect-clean', '--claude-contract', 'inline'], ['--expect-clean', '--retire-legacy-agents'], ['--layout', 'project'], ['--force']]) {
    const r = run([...sb.rootArgs, ...args]);
    assert.equal(r.status, 2, args.join(' '));
  }
});

// ---------- --expect-clean ----------

test('--expect-clean exits 1 while the plan is not empty and 0 once the deploy is in place', () => {
  const sb = sandbox();
  const before = run([...sb.rootArgs, '--dry-run', '--expect-clean']);
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stdout, /expect-clean: the plan is not empty/);
  materialize(sb);
  const clean = run([...sb.rootArgs, '--dry-run', '--expect-clean']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /expect-clean: the plan is empty/);
  const json = JSON.parse(run([...sb.rootArgs, '--expect-clean', '--json']).stdout);
  assert.deepEqual([json.expect_clean, json.clean, json.options], [true, true, { claude_contract: 'import', retire_legacy_agents: false }]);
  // Any drift of a kit target makes it fail again.
  fs.appendFileSync(path.join(sb.home, '.codex', 'rules', 'autoskills.rules'), '\n# local edit\n');
  assert.equal(run([...sb.rootArgs, '--expect-clean']).status, 1);
});

test('--expect-clean compares with the options recorded in the local config (deploy_options)', () => {
  const sb = sandbox();
  materialize(sb, { claudeContract: 'inline', retireLegacyAgents: true });
  // Nothing recorded: the defaults (import) differ from the inline deploy.
  const unrecorded = JSON.parse(run([...sb.rootArgs, '--expect-clean', '--json']).stdout);
  assert.equal(unrecorded.clean, false);
  assert.deepEqual(paths(unrecorded.modify), [inHome(sb, '.claude', 'CLAUDE.md')]);
  // Recorded as AS3-113's --apply will: clean, while a plain dry-run with the defaults still shows CLAUDE.md.
  const cfg = JSON.parse(fs.readFileSync(sb.localConfig, 'utf8'));
  cfg.deploy_options = { claude_contract: 'inline', retire_legacy_agents: true };
  fs.writeFileSync(sb.localConfig, `${JSON.stringify(cfg, null, 2)}\n`);
  const recorded = run([...sb.rootArgs, '--dry-run', '--expect-clean']);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  assert.match(recorded.stdout, /claude contract inline; retire legacy agents yes/);
  assert.equal(planOf(sb).modify.length, 1);
  // A malformed record is a setup error.
  cfg.deploy_options = { claude_contract: 'copy' };
  fs.writeFileSync(sb.localConfig, JSON.stringify(cfg));
  const bad = run([...sb.rootArgs, '--expect-clean']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /deploy_options\.claude_contract/);
});

// ---------- --stage ----------

const stageDirs = [];
after(() => {
  for (const d of stageDirs) fs.rmSync(d, { recursive: true, force: true });
  // _private/stage/ itself goes too when the tests created it and left it empty.
  try { if (!fs.readdirSync(STAGE_ROOT).length) fs.rmdirSync(STAGE_ROOT); } catch { /* absent or in use */ }
});

function stageDir(name) {
  const d = path.join(STAGE_ROOT, `deploy-kit-test-${process.pid}-${name}`);
  stageDirs.push(d);
  return d;
}

test('--stage writes the project layout into a folder inside _private/', () => {
  const dest = stageDir('layout');
  const r = run(['--stage', dest, '--layout', 'project']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /staged \d+ file\(s\) in the project layout/);
  const contract = fs.readFileSync(path.join(REPO, 'templates', 'global-AGENTS.md'));
  assert.ok(fs.readFileSync(path.join(dest, '.claude', 'AGENTS.md')).equals(contract));
  assert.ok(fs.readFileSync(path.join(dest, 'contract', 'AGENTS.md')).equals(contract));
  const claude = fs.readFileSync(path.join(dest, '.claude', 'CLAUDE.md'), 'utf8');
  assert.equal(claude.split(/\r?\n/)[0], '@AGENTS.md');
  assert.ok(fs.readFileSync(path.join(dest, '.claude', 'CLAUDE.md')).equals(fs.readFileSync(path.join(REPO, 'templates', 'global-claude-CLAUDE.md'))));
  for (const base of [['.claude', 'skills'], ['.agents', 'skills']]) {
    assert.deepEqual(fs.readdirSync(path.join(dest, ...base)).sort(), [...KIT_SKILLS].sort());
    for (const s of KIT_SKILLS) {
      assert.ok(fs.readFileSync(path.join(dest, ...base, s, 'SKILL.md')).equals(fs.readFileSync(path.join(REPO, 'skills', s, 'SKILL.md'))), s);
    }
  }
  assert.deepEqual(fs.readdirSync(dest).sort(), ['.agents', '.claude', 'contract', STAGE_MANIFEST].sort());
  assert.deepEqual(fs.readdirSync(path.join(dest, '.claude')).sort(), ['AGENTS.md', 'CLAUDE.md', 'skills']);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, STAGE_MANIFEST), 'utf8'));
  assert.equal(manifest.layout, 'project');
  for (const f of manifest.files) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, ...f.path.split('/')))).digest('hex'), f.sha256, f.path);
  }
  assert.ok(!fs.readdirSync(STAGE_ROOT).some((n) => n.endsWith('.tmp')), 'no temp folder left');
});

test('--stage replaces only an earlier stage, and only with --force', () => {
  const dest = stageDir('force');
  assert.equal(run(['--stage', dest, '--layout', 'project']).status, 0);
  fs.writeFileSync(path.join(dest, 'stray.txt'), 'x');
  const again = run(['--stage', dest, '--layout', 'project']);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /not empty/);
  const forced = run(['--stage', dest, '--layout', 'project', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /earlier stage replaced/);
  assert.ok(!fs.existsSync(path.join(dest, 'stray.txt')));
  // A folder --stage did not write is never replaced, not even with --force.
  const foreign = stageDir('foreign');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'keep.txt'), 'owner data');
  const refused = run(['--stage', foreign, '--layout', 'project', '--force']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(STAGE_MANIFEST.replace('.', '\\.')));
  assert.deepEqual(fs.readdirSync(foreign), ['keep.txt']);
});

test('--stage refuses targets outside _private/ and needs --layout project', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-kit-stage-'));
  temps.push(outside);
  for (const dest of [path.join(outside, 'stage'), path.join(REPO, '_private'), path.join(REPO, 'stage-out'), path.join(REPO, '_private', '..', 'x')]) {
    const r = run(['--stage', dest, '--layout', 'project', '--force']);
    assert.equal(r.status, 2, dest);
    assert.match(r.stderr, /only to a folder inside/);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(!fs.existsSync(path.join(REPO, 'stage-out')) && !fs.existsSync(path.join(REPO, 'x')));
  const dest = stageDir('usage');
  for (const args of [['--stage', dest], ['--stage', dest, '--layout', 'user'], ['--stage', dest, '--layout', 'project', '--home', outside],
    ['--stage', dest, '--layout', 'project', '--expect-clean']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
  assert.ok(!fs.existsSync(dest));
});

// ---------- toml-edit ----------

test('removeProjectsByPrefix drops only the trust sections inside the folder', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'home', '.codex', 'config.toml'), 'utf8');
  const r = removeProjectsByPrefix(text, 'C:/example/kit/_private/eval/runs');
  assert.deepEqual(r.removed, [
    'C:\\example\\kit\\_private\\eval\\runs\\codex-old\\repo',
    'c:\\example\\kit\\_private\\eval\\runs\\codex-new\\repo',
    '\\\\?\\C:\\example\\kit\\_private\\eval\\runs\\verbatim',
  ]);
  const left = scanToml(r.text).filter((e) => e.kind === 'header' && e.path[0] === 'projects').map((e) => e.path[1]);
  assert.deepEqual(left, ['c:\\example\\kit\\_private\\eval\\runs2\\keep', 'c:\\example\\work\\app']);
  // Everything else is byte for byte the same; the comment above [plugins...] stays with it.
  assert.ok(r.text.includes('# Plugins (this comment belongs to the next section)\n[plugins."github@synthetic-curated"]'));
  assert.ok(r.text.includes('# Trust entries as Codex writes them'));
  const kept = text.split('\n').filter((l) => !/runs\\\\(?:codex-old|codex-new|verbatim)|runs\\(?:codex-old|codex-new|verbatim)/.test(l));
  for (const l of kept.filter((x) => x && x !== 'trust_level = "trusted"')) assert.ok(r.text.includes(l), l);
  assert.equal(r.text.split('\n').filter((l) => l === 'trust_level = "trusted"').length, 2);
  // The same with \ separators; nothing matches a sibling folder; a second run removes nothing.
  assert.equal(removeProjectsByPrefix(text, 'c:\\example\\kit\\_private\\eval\\runs\\').text, r.text);
  assert.deepEqual(removeProjectsByPrefix(text, 'C:/example/kit/_private/eval/run').removed, []);
  assert.equal(removeProjectsByPrefix(r.text, 'C:/example/kit/_private/eval/runs').text, r.text);
  // Dotted trust keys at the root go too.
  const dotted = 'a = 1\nprojects."C:\\\\example\\\\runs\\\\x".trust_level = "trusted"\nb = 2\n';
  assert.deepEqual(removeProjectsByPrefix(dotted, 'C:/example/runs'), { text: 'a = 1\nb = 2\n', removed: ['C:\\example\\runs\\x'] });
  // A comment block at the end of the file is not part of the section above it.
  assert.equal(removeProjectsByPrefix("a = 1\n[projects.'C:/example/runs/y']\ntrust_level = \"trusted\"\n\n# tail note\n", 'C:/example/runs').text, 'a = 1\n# tail note\n');
});

test('setValue edits in place, adds missing keys and tables, and refuses edits TOML would reject', () => {
  const doc = '# head\nmodel = "m" # keep\n\n# about x\n[x]\na = 1\n\n[x.y]\nb = """\n[not.a.header]\n"""\n';
  assert.equal(setValue(doc, ['model'], '"n"'), doc.replace('"m" # keep', '"n" # keep'));
  assert.equal(setValue(doc, ['model'], '"m"'), doc);
  assert.equal(setValue(doc, ['top'], 'true'), doc.replace('# keep\n', '# keep\ntop = true\n'));
  assert.equal(setValue(doc, ['x', 'c'], '2'), doc.replace('a = 1\n', 'a = 1\nc = 2\n'));
  assert.equal(setValue(doc, ['z', 'k'], '"v"'), `${doc}\n[z]\nk = "v"\n`);
  assert.equal(getValue(doc, ['x', 'y', 'b']), '"""\n[not.a.header]\n"""');
  assert.deepEqual(keyValues(doc).map((k) => k.path.join('.')), ['model', 'x.a', 'x.y.b']);
  // Root key into a file that starts with a table: above the comments of that table.
  assert.equal(setValue('# t\n[t]\nk = 1\n', ['r'], '1'), 'r = 1\n\n# t\n[t]\nk = 1\n');
  // CRLF files get CRLF lines.
  assert.equal(setValue('a = 1\r\n', ['b'], '2'), 'a = 1\r\nb = 2\r\n');
  assert.throws(() => setValue('desktop = { followUpQueueMode = "queue" }\n', ['desktop', 'followUpQueueMode'], '"steer"'), TomlEditError);
  assert.throws(() => setValue('desktop.other = 1\n', ['desktop', 'followUpQueueMode'], '"steer"'), TomlEditError);
  assert.equal(setValue('desktop.followUpQueueMode = "queue"\n', ['desktop', 'followUpQueueMode'], '"steer"'), 'desktop.followUpQueueMode = "steer"\n');
  assert.throws(() => setValue('a = "open\n', ['a'], '1'), TomlEditError);
  assert.throws(() => setValue('[[arr]]\nk = 1\n', ['arr', 'k'], '2'), TomlEditError);
});

// ---------- workflow-rules.md merge ----------

test('mergeWorkflowRules drops Core Rules, keeps the other sections and line endings, and is idempotent', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'home', '.workflow-core', 'policies', 'workflow-rules.md'), 'utf8');
  const merged = mergeWorkflowRules(text);
  assert.ok(merged.startsWith(`# Shared Workflow Rules\n\n${WF_BEGIN}\n`));
  assert.ok(merged.includes(`${WF_END}\n\nVersion:`));
  assert.ok(!merged.includes('Core Rules\n') && !merged.includes('Synthetic old rule'));
  assert.ok(merged.includes('## Task Schema') && merged.includes('## Acceptance Rules'));
  assert.equal(mergeWorkflowRules(merged), merged);
  const crlf = mergeWorkflowRules(text.replace(/\n/g, '\r\n'));
  assert.equal(crlf, merged.replace(/\n/g, '\r\n'));
  assert.equal(mergeWorkflowRules(crlf), crlf);
  const none = mergeWorkflowRules(null);
  assert.ok(none.startsWith(`# Shared Workflow Rules\n\n${WF_BEGIN}`));
  assert.equal(mergeWorkflowRules(none), none);
});

// ---------- last: the real user directory and runtime ----------

test('the real user directory targets, the real runtime and the .git/config of the real repos are unchanged', () => {
  assert.deepEqual(realHomeFingerprint(), REAL_HOME_BEFORE);
  assert.deepEqual(treeStat(realRuntime()), REAL_RUNTIME_BEFORE);
  assert.deepEqual(realRepoConfigs(), REAL_REPOS_BEFORE);
  assert.ok(Object.keys(REAL_REPOS_BEFORE).length > 0, 'the real projects root holds repositories');
});
