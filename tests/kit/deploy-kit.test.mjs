// Tests for scripts/deploy-kit.mjs and scripts/lib/kit-targets.mjs (node:test, zero dependencies). Every
// test copies the hand-written fixtures in tests/kit/fixtures/deploy/ into an OS temp dir and passes
// --home, --runtime, --projects-root and --local-config there, so the script never reads targets in the
// real user directory. The last test checks that the real target files and the real runtime area are
// unchanged after the whole file ran.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../../scripts/deploy-kit.mjs';
import {
  KIT_REPO, KIT_SKILLS, LEGACY_SKILL_DIRS, targetMap, mergeWorkflowRules, WF_BEGIN, WF_END,
} from '../../scripts/lib/kit-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'deploy-kit.mjs');
const FIXTURES = path.join(REPO, 'tests', 'kit', 'fixtures', 'deploy');

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

/** The kit's targets in the real user directory: contract files, agents, templates, rules and every
 *  project-* or brace folder in the skill locations. */
function realHomeFingerprint() {
  const t = targetMap({ home: os.homedir(), runtime: os.tmpdir(), projectsRoot: os.tmpdir() });
  const out = {};
  for (const p of [t.claudeAgentsMd, t.claudeMd, t.codexAgentsMd, t.claudeAgents, t.workflowTemplates, t.workflowRules]) out[p] = treeHash(p);
  for (const base of [...new Set([...LEGACY_SKILL_DIRS.map((l) => t[l.key]), t.agentsSkills])]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { /* absent */ }
    for (const n of names.filter((x) => x.startsWith('project-') || x.startsWith('{')).sort()) out[path.join(base, n)] = treeHash(path.join(base, n));
  }
  return out;
}

function realRuntime() {
  try { return JSON.parse(fs.readFileSync(path.join(KIT_REPO, '_private', 'kit-local.json'), 'utf8')).runtime; } catch { return path.join(KIT_REPO, '_private', 'rt'); }
}

const REAL_HOME_BEFORE = realHomeFingerprint();
const REAL_RUNTIME_BEFORE = treeStat(realRuntime());

// ---------- sandbox ----------

/**
 * A fresh temp tree: home/ and projects/ copied from the fixtures, runtime/ with two fake portable Nodes,
 * private/ for the local config. A never-touch ledger build is added here (dist/ is git-ignored).
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

/** Bring the sandbox to the planned state (a stand-in for --apply, which comes with AS3-113). */
function materialize(sb, opts) {
  const plan = buildPlan(sb.roots, opts);
  for (const e of [...plan.create, ...plan.modify]) {
    fs.mkdirSync(path.dirname(e.path), { recursive: true });
    fs.writeFileSync(e.path, e.content);
  }
  for (const e of plan.remove) fs.rmSync(e.path, { recursive: true, force: true });
}

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
  // Only the AS3-112a targets: settings.json and config.toml come with AS3-112b.
  for (const e of [...plan.create, ...plan.modify, ...plan.remove]) assert.ok(!/settings\.json$|config\.toml$/.test(e.path), e.path);
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
  for (const p of all) assert.ok(p.startsWith(`${fwd(sb.home)}/`), `outside the temp home: ${p}`);
});

test('a repeated run after the plan is in place has an empty plan (import and inline)', () => {
  for (const contract of ['import', 'inline']) {
    const sb = sandbox();
    materialize(sb, { claudeContract: contract, retireLegacyAgents: true });
    const plan = planOf(sb, '--claude-contract', contract, '--retire-legacy-agents');
    assert.deepEqual([plan.create, plan.modify, plan.remove], [[], [], []], contract);
    assert.ok(plan.unchanged > 0);
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
  const plan = buildPlan(sb.roots, { claudeContract: 'inline' });
  const claude = plan.modify.find((e) => e.path === path.join(sb.home, '.claude', 'CLAUDE.md')).content.toString('utf8');
  const contract = fs.readFileSync(path.join(REPO, 'templates', 'global-AGENTS.md'), 'utf8');
  assert.ok(claude.startsWith(contract.trimEnd()));
  assert.ok(!/^@AGENTS\.md$/m.test(claude));
  assert.ok(claude.includes('## Claude Code 专属'));
  const imp = buildPlan(sb.roots, {}).modify.find((e) => e.path === path.join(sb.home, '.claude', 'CLAUDE.md')).content.toString('utf8');
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
  // An empty home gets every kit file as a creation and removes nothing.
  const empty = path.join(other, 'empty-home');
  fs.mkdirSync(empty);
  const fresh = planOf({ rootArgs: ['--home', empty, '--local-config', sb.localConfig] });
  assert.deepEqual([fresh.modify.length, fresh.remove.length], [0, 0]);
  assert.ok(fresh.create.every((e) => e.path.startsWith(`${fwd(empty)}/`)));
});

test('unknown options and the modes of later tasks exit 2', () => {
  const sb = sandbox();
  for (const args of [['--bogus'], ['--apply'], ['--rollback', 'x'], ['--neutral'], ['--stage', 'x'], ['--expect-clean'], ['--init-local', '--json']]) {
    const r = run([...sb.rootArgs, ...args]);
    assert.equal(r.status, 2, args.join(' '));
  }
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

test('the real user directory targets and the real runtime are unchanged', () => {
  assert.deepEqual(realHomeFingerprint(), REAL_HOME_BEFORE);
  assert.deepEqual(treeStat(realRuntime()), REAL_RUNTIME_BEFORE);
});
