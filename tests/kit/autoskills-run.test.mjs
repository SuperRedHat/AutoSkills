// Tests for the long-run driver: scripts/lib/run/ behind `autoskills.mjs run` and `stop` (node:test, zero
// dependencies). No real session starts: --cli points to a stand-in (a small .mjs this file writes) that plays a
// script against a temp git repo and a temp ledger, the way a session would (status changes with their log lines, new
// tasks, files, commits, an idle hang, a usage limit). Nothing here touches a real project or the user level.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWith, stopCommand, runCommand, parseRun, untilDate, DEFAULT_PERMISSION_MODE } from '../../scripts/lib/run/cli.mjs';
import { Driver, exitCodeOf, NORMAL_ENDS, LIMIT_WAITS_MIN } from '../../scripts/lib/run/driver.mjs';
import { childEnv, outcomeOf, USAGE_LIMIT_RE, sessionArgs, killTree } from '../../scripts/lib/run/session.mjs';
import { dirtyFiles, failureText, shellSpec } from '../../scripts/lib/run/verify.mjs';
import { taskPrompt, reworkPrompt, giveUpPrompt, multiPrompt, resumePrompt } from '../../scripts/lib/run/prompts.mjs';
import { lockFile, stopFile, settingsFile, runsDir, verifyFile, readLock } from '../../scripts/lib/run-paths.mjs';
import { main } from '../../scripts/autoskills.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(REPO, 'scripts', 'autoskills.mjs');

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

// ---------- the stand-in CLI ----------

// It reads its script (FAKE_SCRIPT: a JSON array, one step a session, taken in order), appends what it was started
// with to FAKE_CALLS, applies the step to the repo in its working directory, and prints stream-json.
const FAKE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (stand-in)'); process.exit(0); }
const calls = process.env.FAKE_CALLS;
const prompt = argv[argv.indexOf('-p') + 1];
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const n = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0;
fs.appendFileSync(calls, JSON.stringify({ prompt, argv, cwd: process.cwd(), projectDir: process.env.PROJECT_DIR ?? null,
  claudecode: process.env.CLAUDECODE ?? null, effortEnv: process.env.CLAUDE_EFFORT ?? null, unattended: process.env.AUTOSKILLS_UNATTENDED ?? null }) + '\n');
const step = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, 'utf8'))[n] || {};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'fake-' + n, model: flag('--model') || 'stand-in', permissionMode: flag('--permission-mode'), tools: [], mcp_servers: [] });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A process of the session's own (what a Bash call or a test run is to a real session); it ends by itself after 60 s.
// It is detached on purpose: an attached child of a Node process on Windows ends as soon as its parent does, whoever
// ended the parent, so only a detached one tells "the whole tree was ended" from "the session alone was ended".
if (step.grandchild) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60000)'], { stdio: 'ignore', detached: true });
  c.unref();
  fs.writeFileSync(path.join(path.dirname(calls), 'grandchild.pid'), String(c.pid));
}
if (step.idleMs) sleep(step.idleMs);
const state = path.join(process.cwd(), '.claude', 'state');
const tf = path.join(state, 'tasks.json'), lf = path.join(state, 'logs.json');
const ledger = JSON.parse(fs.readFileSync(tf, 'utf8'));
const logs = fs.existsSync(lf) ? JSON.parse(fs.readFileSync(lf, 'utf8')) : { logs: [] };
let touched = false;
for (const t of step.newTasks || []) { ledger.tasks.push(t); touched = true; }
for (const [id, notes] of Object.entries(step.notes || {})) { ledger.tasks.find((t) => t.id === id).notes = notes; touched = true; }
for (const [id, to] of Object.entries(step.status || {})) {
  const t = ledger.tasks.find((x) => x.id === id);
  logs.logs.push({ id: 'l' + logs.logs.length, type: 'task_status_change', task_id: id, from_status: t.status, to_status: to, timestamp: new Date().toISOString(), message: '' });
  t.status = to; touched = true;
}
if (touched) { fs.writeFileSync(tf, JSON.stringify(ledger, null, 2)); fs.writeFileSync(lf, JSON.stringify(logs, null, 2)); }
const git = (...a) => spawnSync('git', a, { cwd: process.cwd(), encoding: 'utf8' });
for (const [rel, text] of Object.entries(step.files || {})) { fs.mkdirSync(path.dirname(rel), { recursive: true }); fs.writeFileSync(rel, text); }
if (step.commit) { git('add', '-A'); git('commit', '-q', '-m', step.commit); }
for (const [rel, text] of Object.entries(step.dirty || {})) fs.writeFileSync(rel, text);
if (step.stopFile) { fs.mkdirSync('.autoskills', { recursive: true }); fs.writeFileSync(path.join('.autoskills', 'run.stop'), '{}'); }
if (step.usageLimit) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit · resets 3am", usage: { input_tokens: 10, output_tokens: 1 } });
  process.exit(1);
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'did step ' + n }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'step ' + n + ' done', session_id: 'fake-' + n,
  usage: { input_tokens: step.tokens ?? 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
process.exit(step.exit ?? 0);
`;

const T = (id, extra = {}) => ({
  id, title: `task ${id}`, description: '', dependencies: [], complexity: 'S', acceptance_criteria: [], files: [],
  module: 'm', needs_manual_review: false, acceptance_mode: 'auto', status: 'todo', created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z', commit_hash: '', notes: '', verification_commands: ['node pass.mjs'], priority: 0, ...extra,
});

const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A temp project: a git repo with one commit, a ledger, the stand-in and its script. */
function project({ tasks, script = [], settings = { verify_shell: 'bash' } }) {
  const dir = tempDir('autoskills-run-');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  gitIn(proj, 'init', '-q');
  gitIn(proj, 'config', 'user.name', 'test');
  gitIn(proj, 'config', 'user.email', 'noreply@example.invalid');
  gitIn(proj, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/state/\n');
  fs.writeFileSync(path.join(proj, 'pass.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(proj, 'fail.mjs'), 'console.log("failing on purpose"); process.exit(3);\n');
  fs.writeFileSync(path.join(proj, 'check.mjs'), "import fs from 'node:fs'; process.exit(fs.existsSync('fixed.txt') ? 0 : 1);\n");
  gitIn(proj, 'add', '-A');
  gitIn(proj, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(proj, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'state', 'tasks.json'), JSON.stringify({ tasks }, null, 2));
  fs.writeFileSync(path.join(proj, '.claude', 'state', 'logs.json'), JSON.stringify({ logs: [] }, null, 2));
  if (settings) {
    fs.mkdirSync(path.join(proj, '.autoskills'), { recursive: true });
    fs.writeFileSync(settingsFile(proj), JSON.stringify(settings));
  }
  const fake = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(fake, FAKE);
  const scriptFile = path.join(dir, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const callsFile = path.join(dir, 'calls.jsonl');
  return {
    dir, proj, fake, scriptFile, callsFile,
    calls: () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []),
    ledger: () => JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'state', 'tasks.json'), 'utf8')).tasks,
    head: () => gitIn(proj, 'rev-parse', 'HEAD'),
    runs: () => (fs.existsSync(runsDir(proj)) ? fs.readdirSync(runsDir(proj)) : []),
  };
}

const sink = () => {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
};

/** Run the driver in this process against a project made by project(). */
async function drive(p, extraArgs = [], deps = {}) {
  const io = { stdout: sink(), stderr: sink() };
  const waits = [];
  const code = await runWith([p.proj, '--cli', p.fake, ...extraArgs], io, {
    baseEnv: { ...process.env, FAKE_SCRIPT: p.scriptFile, FAKE_CALLS: p.callsFile, CLAUDECODE: '1', CLAUDE_EFFORT: 'max' },
    sleep: async (ms) => { waits.push(ms); },
    limitWaitsMs: [10, 20, 40, 60],
    pollMs: 20,
    accept: async () => 0,
    ...deps,
  });
  const runs = p.runs();
  const run = runs.sort().at(-1);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const record = run ? JSON.parse(read(path.join(runsDir(p.proj), run, 'run.json')) || 'null') : null;
  return { code, io, run, record, report: run ? read(path.join(runsDir(p.proj), run, 'report.md')) : null, waits };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The process the stand-in started with `grandchild: true`: its pid, and whether it is gone within 5 s. */
async function grandchildGone(p) {
  const pid = Number(fs.readFileSync(path.join(p.dir, 'grandchild.pid'), 'utf8'));
  for (let i = 0; i < 50 && pidAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  const gone = !pidAlive(pid);
  if (!gone) killTree(pid);
  return { pid, gone };
}

const promptsOf = (p) => p.calls().map((c) => c.prompt);
const named = (p) => promptsOf(p).map((s) => (/只做 (\S+?)；/.exec(s) || /从 (\S+?) 开始/.exec(s) || [null, '?'])[1]);

// ---------- usage and the command entry ----------

describe('the commands and their options', () => {
  test('run --help and stop --help print their usage and exit 0, through the entry too', () => {
    for (const name of ['run', 'stop']) {
      const r = spawnSync(process.execPath, [ENTRY, name, '--help'], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, name);
      assert.match(r.stdout, new RegExp(`autoskills\\.mjs ${name} <project dir>`));
    }
    const r = spawnSync(process.execPath, [ENTRY, 'help', 'run'], { encoding: 'utf8', windowsHide: true });
    for (const opt of ['--model', '--effort', '--permission-mode', '--tasks-per-session', '--until', '--max-tasks', '--cli', '--idle-min', '--verify-timeout-min']) {
      assert.ok(r.stdout.includes(opt), opt);
    }
  });

  test('usage errors exit 2 with the usage on stderr', async () => {
    const cases = [[], ['a', 'b'], ['p', '--frob'], ['p', '--until', '25:00'], ['p', '--until', '7'], ['p', '--max-tasks', '0'],
      ['p', '--max-tasks', 'x'], ['p', '--tasks-per-session', '1.5'], ['p', '--permission-mode', 'yolo'], ['p', '--idle-min', '0'],
      ['p', '--verify-timeout-min', '-1'], ['p', '--model', ' ']];
    for (const args of cases) {
      const io = { stdout: sink(), stderr: sink() };
      assert.equal(await runWith(args, io, {}), 2, args.join(' '));
      assert.match(io.stderr.text(), /Usage: node scripts\/autoskills\.mjs run/, args.join(' '));
    }
    for (const args of [[], ['a', 'b'], ['a', '--x']]) {
      const io = { stdout: sink(), stderr: sink() };
      assert.equal(await stopCommand(args, io), 2, args.join(' '));
    }
  });

  test('the defaults: auto permission mode, one task a session, 30-minute timeouts, nothing else on', () => {
    const o = parseRun(['proj']);
    assert.equal(DEFAULT_PERMISSION_MODE, 'auto');
    assert.equal(o.permissionMode, 'auto');
    assert.equal(o.tasksPerSession, 1);
    assert.equal(o.verifyTimeoutMs, 30 * 60000);
    assert.equal(o.idleMs, 30 * 60000);
    assert.equal(o.until, null);
    assert.equal(o.maxTasks, null);
    assert.equal(o.model, undefined);
    assert.equal(o.effort, undefined);
  });

  test('--until is the next local HH:MM: later today, or tomorrow when it has passed', () => {
    const from = new Date(2026, 10, 19, 23, 0, 0);
    const u = untilDate('07:00', from);
    assert.deepEqual([u.getDate(), u.getHours(), u.getMinutes()], [20, 7, 0]);
    const v = untilDate('23:30', from);
    assert.deepEqual([v.getDate(), v.getHours(), v.getMinutes()], [19, 23, 30]);
  });

  test('a folder that is not a project with a ledger: exit 1, nothing started', async () => {
    const io = { stdout: sink(), stderr: sink() };
    assert.equal(await runWith([path.join(os.tmpdir(), 'no-such-dir-autoskills')], io, {}), 1);
    const p = project({ tasks: [T('T1')] });
    fs.rmSync(path.join(p.proj, '.claude', 'state', 'tasks.json'));
    const r = await drive(p);
    assert.equal(r.code, 1);
    assert.match(r.io.stderr.text(), /no ledger/);
    assert.equal(p.calls().length, 0);
  });

  test('a session: a fresh claude -p a task, PROJECT_DIR set, the parent session variables gone, model and effort only when given', async () => {
    const p = project({ tasks: [T('T1'), T('T2')], script: [{ status: { T1: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(T1): a' }, { status: { T2: 'done' }, files: { 'b.txt': '1' }, commit: 'feat(T2): b' }] });
    const r = await drive(p, ['--max-tasks', '1']);
    assert.equal(r.code, 0);
    let [c] = p.calls();
    assert.equal(c.prompt, taskPrompt('T1'));
    assert.match(c.prompt, /^用 project-next 只做 T1；做完、验证、提交、记账就结束；这是无人值守的运行，不要提问，要我定的事写进任务备注和汇报。$/);
    assert.deepEqual(c.argv.slice(2), ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto']);
    assert.ok(!c.argv.includes('--resume'));
    assert.equal(fs.realpathSync.native(c.cwd), fs.realpathSync.native(p.proj));
    assert.equal(c.projectDir, p.proj);
    assert.equal(c.claudecode, null);
    assert.equal(c.effortEnv, null);
    // The session the driver started carries the unattended mark: the guard hook denies a git push there in every mode.
    assert.equal(c.unattended, '1');
    await drive(p, ['--model', 'claude-opus-5-5', '--effort', 'high', '--permission-mode', 'bypassPermissions']);
    c = p.calls()[1];
    assert.equal(c.unattended, '1', 'whatever the permission mode');
    assert.deepEqual(c.argv.slice(2), ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5-5', '--effort', 'high']);
  });

  test('--tasks-per-session 2 names the first task and lets the session take one more; both are verified', async () => {
    const p = project({ tasks: [T('T1'), T('T2')], script: [{ status: { T1: 'done', T2: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(T1,T2): both' }] });
    const r = await drive(p, ['--tasks-per-session', '2']);
    assert.equal(r.code, 0);
    assert.equal(p.calls().length, 1);
    assert.equal(p.calls()[0].prompt, multiPrompt('T1', 2));
    assert.deepEqual(r.record.sessions[0].verified.map((v) => [v.task, v.passed]), [['T1', true], ['T2', true]]);
    assert.equal(r.record.end_reason, 'all_done');
  });
});

// ---------- picking ----------

describe('picking the task', () => {
  test('in progress first, a blocked one skipped; then ready ones by priority, ties in ledger order', async () => {
    const tasks = [
      T('A'), T('B', { priority: 5 }), T('C', { status: 'in_progress', notes: '受阻：窗口 a 在做' }), T('D', { status: 'in_progress' }),
      T('E', { dependencies: ['A'] }), T('F', { notes: '受阻: 等负责人定' }),
    ];
    const done = (id) => ({ status: { [id]: 'done' }, files: { [`${id}.txt`]: id }, commit: `feat(${id})` });
    const p = project({ tasks, script: [done('D'), done('B'), done('A'), done('E')] });
    const r = await drive(p);
    assert.deepEqual(named(p), ['D', 'B', 'A', 'E']);
    assert.equal(r.record.end_reason, 'blocked');
    assert.equal(r.code, 1);
    assert.match(r.record.end_detail, /C、F/);
  });

  test('a task awaiting acceptance holds its dependents back, unless the settings say it does not', async () => {
    const tasks = [T('G', { status: 'awaiting_manual_acceptance', acceptance_mode: 'manual' }), T('H', { dependencies: ['G'] })];
    let p = project({ tasks });
    let r = await drive(p);
    assert.equal(p.calls().length, 0);
    assert.equal(r.record.end_reason, 'owner');
    assert.equal(r.code, 0);
    assert.match(r.record.end_detail, /待验收：G/);
    p = project({ tasks, settings: { verify_shell: 'bash', awaiting_blocks_downstream: false }, script: [{ status: { H: 'done' }, files: { 'h.txt': 'h' }, commit: 'feat(H)' }] });
    r = await drive(p);
    assert.deepEqual(named(p), ['H']);
    assert.equal(r.record.end_reason, 'owner');
  });

  test('nothing to do: no session; all done is exit 0, only the owner left is exit 0, the rest blocked is exit 1', async () => {
    let p = project({ tasks: [T('A', { status: 'done' }), T('B', { status: 'cancelled' })] });
    let r = await drive(p);
    assert.deepEqual([r.code, r.record.end_reason, p.calls().length], [0, 'all_done', 0]);
    assert.match(r.report, /全部做完/);
    p = project({ tasks: [T('A', { status: 'awaiting_manual_acceptance', acceptance_mode: 'manual' })] });
    r = await drive(p);
    assert.deepEqual([r.code, r.record.end_reason, p.calls().length], [0, 'owner', 0]);
    p = project({ tasks: [T('A', { notes: '受阻：缺账号' }), T('B', { dependencies: ['A'] })] });
    r = await drive(p);
    assert.deepEqual([r.code, r.record.end_reason, p.calls().length], [1, 'blocked', 0]);
    assert.match(r.report, /A task A：受阻：缺账号/);
  });

  test('blocked tasks and tasks awaiting acceptance together: the reason names both (exit 1)', async () => {
    const p = project({ tasks: [T('A', { notes: '受阻：缺账号' }), T('B', { status: 'awaiting_manual_acceptance', acceptance_mode: 'manual' })] });
    const r = await drive(p);
    assert.deepEqual([r.code, r.record.end_reason, p.calls().length], [1, 'blocked', 0]);
    assert.match(r.record.end_detail, /受阻 A；待验收 B/);
    assert.match(r.report, /## 等你验收的\n\n- B task B/);
  });

  test('a task a session left at auto_verified is in hand: it is named before any ready task', async () => {
    const tasks = [T('A'), T('B', { status: 'auto_verified' }), T('C', { status: 'auto_verified', notes: '受阻：等负责人定' })];
    const done = (id) => ({ status: { [id]: 'done' }, files: { [`${id}.txt`]: id }, commit: `feat(${id})` });
    const p = project({ tasks, script: [done('B'), done('A')] });
    const r = await drive(p);
    assert.deepEqual(named(p), ['B', 'A'], 'B first; the blocked C is skipped');
    assert.equal(promptsOf(p)[0], resumePrompt('B'), 'the prompt says where the task stands and names project-resume');
    assert.match(promptsOf(p)[0], /project-resume.*auto_verified/);
    assert.equal(promptsOf(p)[1], taskPrompt('A'));
    assert.equal(r.record.verifies.B.passed, true);
    assert.deepEqual([r.code, r.record.end_reason], [1, 'blocked']);
    assert.match(r.record.end_detail, /剩下的都受阻：C/);
  });
});

// ---------- the driver's verification ----------

describe('verification on the committed tree', () => {
  test('passed: the verify file has the form of run-paths.mjs, one log a command, the commit is HEAD', async () => {
    const p = project({ tasks: [T('T1', { verification_commands: ['node pass.mjs', 'node -e "console.log(42)"'] })], script: [{ status: { T1: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(T1): a' }] });
    const r = await drive(p);
    assert.equal(r.code, 0);
    const v = JSON.parse(fs.readFileSync(verifyFile(p.proj, r.run, 'T1'), 'utf8'));
    assert.deepEqual(Object.keys(v).sort(), ['at', 'clean', 'commands', 'commit', 'passed', 'task_id']);
    assert.equal(v.task_id, 'T1');
    assert.equal(v.commit, p.head());
    assert.equal(v.clean, true);
    assert.equal(v.passed, true);
    assert.deepEqual(v.commands.map((c) => [c.command, c.exit_code]), [['node pass.mjs', 0], ['node -e "console.log(42)"', 0]]);
    for (const c of v.commands) {
      assert.equal(typeof c.ms, 'number');
      assert.match(c.log, /^\.autoskills\/runs\/[^/]+\/tasks\/T1\.verify-\d\.log$/);
    }
    assert.match(fs.readFileSync(path.join(p.proj, v.commands[1].log), 'utf8'), /42/);
    assert.match(r.report, new RegExp(`\\| T1 task T1 \\| 完成 \\| ${p.head().slice(0, 7)} \\| 通过 \\|`));
  });

  test('the default shell is PowerShell 5.1; bash is Git for Windows bash, not the WSL launcher', async () => {
    assert.deepEqual(shellSpec('powershell', 'x'), { cmd: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-Command', 'x'] });
    if (process.platform === 'win32') {
      const b = shellSpec('bash', 'x');
      assert.doesNotMatch(b.cmd, /system32|windowsapps/i);
      assert.match(b.cmd, /bash\.exe$/i);
      assert.deepEqual(b.argv, ['-c', 'x']);
    }
    const p = project({ tasks: [T('T1', { verification_commands: ['node fail.mjs'] })], settings: null, script: [{ status: { T1: 'awaiting_manual_acceptance' }, files: { 'a.txt': '1' }, commit: 'feat(T1)' }] });
    const r = await drive(p);
    const v = JSON.parse(fs.readFileSync(verifyFile(p.proj, r.run, 'T1'), 'utf8'));
    assert.equal(v.commands[0].exit_code, 1, 'powershell -Command reports a failed native command as 1');
    assert.match(fs.readFileSync(path.join(p.proj, v.commands[0].log), 'utf8'), /failing on purpose/);
  });

  test('a tree that is not clean: clean false, passed false, no command runs; the ledger and .autoskills do not count', async () => {
    const p = project({ tasks: [T('T1')], script: [{ status: { T1: 'awaiting_manual_acceptance' }, files: { 'a.txt': '1' }, commit: 'feat(T1)', dirty: { 'left.txt': 'x' } }] });
    const r = await drive(p);
    const v = JSON.parse(fs.readFileSync(verifyFile(p.proj, r.run, 'T1'), 'utf8'));
    assert.equal(v.clean, false);
    assert.equal(v.passed, false);
    assert.deepEqual(v.commands, []);
    assert.deepEqual(v.dirty, ['?? left.txt']);
    assert.deepEqual(dirtyFiles(p.proj), ['?? left.txt'], 'run.json, run.lock, runs/ and the ledger are not listed');
    assert.match(failureText(v), /工作目录不干净.*left\.txt/);
  });

  test('a task with no verification commands: passed null with the reason', async () => {
    const p = project({ tasks: [T('T1', { verification_commands: [] })], script: [{ status: { T1: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(T1)' }] });
    const r = await drive(p);
    const v = JSON.parse(fs.readFileSync(verifyFile(p.proj, r.run, 'T1'), 'utf8'));
    assert.equal(v.passed, null);
    assert.equal(v.clean, true);
    assert.match(v.reason, /no verification commands/);
    assert.equal(r.code, 0);
    assert.match(r.report, /没复验：任务没有验证命令/);
  });

  test('failed while awaiting acceptance: the task is left alone, the report says reject; no rework', async () => {
    const p = project({
      tasks: [T('T6', { acceptance_mode: 'manual', verification_commands: ['node fail.mjs'] }), T('T7')],
      script: [{ status: { T6: 'awaiting_manual_acceptance' }, files: { 'a.txt': '1' }, commit: 'feat(T6)' }, { status: { T7: 'done' }, files: { 'b.txt': '1' }, commit: 'feat(T7)' }],
    });
    const r = await drive(p);
    assert.deepEqual(named(p), ['T6', 'T7']);
    assert.equal(p.ledger().find((t) => t.id === 'T6').status, 'awaiting_manual_acceptance');
    assert.ok(r.record.reject_suggested.T6);
    assert.equal(r.record.rework.length, 0);
    assert.match(r.report, /## 等你验收的\n\n- T6 task T6：复验没过：`node fail\.mjs` 退出码 3.*复验没过，建议驳回/);
    assert.equal(r.record.end_reason, 'owner');
  });

  test('failed when done: the driver names a rework session before any other task; a passing rework closes it', async () => {
    const R1 = T('R1', { title: 'T1 的返工（第 1 轮）', priority: 99, verification_commands: ['node check.mjs'] });
    const p = project({
      tasks: [T('T1', { verification_commands: ['node check.mjs'] }), T('T2')],
      script: [
        { status: { T1: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(T1): without the fix' },
        { newTasks: [{ ...R1, status: 'done' }], files: { 'fixed.txt': 'ok' }, commit: 'fix(R1): the fix' },
        { status: { T2: 'done' }, files: { 'b.txt': '1' }, commit: 'feat(T2)' },
      ],
    });
    const r = await drive(p);
    const prompts = promptsOf(p);
    assert.equal(prompts.length, 3);
    assert.equal(prompts[1], reworkPrompt({ failedTask: 'T1', origin: 'T1', round: 1, failure: failureText(r.record.verifies.T1) }));
    assert.match(prompts[1], /复验 T1 没过：第 1 条验证命令 `node check\.mjs` 退出码 1，日志在 \.autoskills\/runs\/.+\/T1\.verify-1\.log/);
    assert.match(prompts[1], /照 project-plan 的做法新建一个返工任务：依赖为空，优先级比账本里所有任务都高，验证命令和 T1 的一样/);
    assert.match(prompts[2], /只做 T2/);
    assert.equal(r.record.verifies.R1.passed, true);
    assert.deepEqual(r.record.rework.map((l) => [l.origin, l.round, l.tasks.join(), l.closed]), [['T1', 1, 'R1', 'passed']]);
    assert.equal(r.code, 0);
    assert.match(r.report, /## 返工\n\n- T1：第 1 轮；返工任务 R1；复验通过/);
  });

  test('two rework rounds that still fail: the rework task gets a 受阻 note from a session and is skipped', async () => {
    const R = (id, round) => T(id, { title: `T1 的返工（第 ${round} 轮）`, priority: 99, verification_commands: ['node check.mjs'], status: 'done' });
    const p = project({
      tasks: [T('T1', { verification_commands: ['node check.mjs'] }), T('T2')],
      script: [
        { status: { T1: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(T1)' },
        { newTasks: [R('R1', 1)], files: { 'b.txt': '1' }, commit: 'fix(R1): not yet' },
        { newTasks: [R('R2', 2)], files: { 'c.txt': '1' }, commit: 'fix(R2): not yet' },
        { notes: { R2: '受阻：驱动复验两轮没过' } },
        { status: { T2: 'done' }, files: { 'd.txt': '1' }, commit: 'feat(T2)' },
      ],
    });
    const r = await drive(p);
    const prompts = promptsOf(p);
    assert.equal(prompts.length, 5);
    assert.match(prompts[1], /新建一个返工任务.*（第 1 轮）/);
    assert.match(prompts[2], /复验 R1（T1 的返工）没过/);
    assert.match(prompts[2], /第 2 轮，也是最后一轮/);
    assert.equal(prompts[3], giveUpPrompt({ taskId: 'R2', origin: 'T1', failure: failureText(r.record.verifies.R2) }));
    assert.match(prompts[3], /在 R2 的备注里加一行“受阻：/);
    assert.match(prompts[4], /只做 T2/);
    assert.deepEqual(r.record.rework.map((l) => [l.round, l.tasks.join(), l.closed]), [[2, 'R1,R2', 'blocked']]);
    assert.ok(r.record.skipped.includes('R2'));
    assert.match(r.report, /两轮没过，标受阻并跳过/);
    assert.match(r.report, /## 受阻的\n\n- R2 T1 的返工（第 2 轮）（完成）：驱动跳过；受阻：驱动复验两轮没过/);
  });
});

// ---------- brakes ----------

describe('brakes and stop requests', () => {
  const doneStep = (id) => ({ status: { [id]: 'done' }, files: { [`${id}.txt`]: id }, commit: `feat(${id})` });

  test('--max-tasks N: no new task after N are finished; exit 0', async () => {
    const p = project({ tasks: [T('A'), T('B'), T('C')], script: [doneStep('A'), doneStep('B'), doneStep('C')] });
    const r = await drive(p, ['--max-tasks', '2']);
    assert.deepEqual(named(p), ['A', 'B']);
    assert.deepEqual([r.code, r.record.end_reason], [0, 'max_tasks']);
  });

  test('--until not reached: every task is opened; exit 0', async () => {
    const p = project({ tasks: [T('A'), T('B')], script: [doneStep('A'), doneStep('B')] });
    const clock = new Date(2026, 10, 19, 6, 50, 0);
    const now = () => clock;
    const io = { stdout: sink(), stderr: sink() };
    const code = await runWith([p.proj, '--cli', p.fake, '--until', '07:00'], io, {
      baseEnv: { ...process.env, FAKE_SCRIPT: p.scriptFile, FAKE_CALLS: p.callsFile }, now, accept: async () => 0,
      sleep: async () => {},
    });
    // The clock never moves: both tasks start before 07:00.
    assert.equal(code, 0);
    assert.deepEqual(named(p), ['A', 'B']);
  });

  test('--until passes while a task is in hand: that task is finished and verified, the next one is not opened', async () => {
    const q = project({ tasks: [T('A'), T('B')], script: [doneStep('A'), doneStep('B')] });
    // 06:50 until the session of A has started, 07:01 from then on: the time passes during A.
    const stepping = () => (q.calls().length >= 1 ? new Date(2026, 10, 19, 7, 1, 0) : new Date(2026, 10, 19, 6, 50, 0));
    const r = await drive(q, ['--until', '07:00'], { now: stepping });
    assert.deepEqual(named(q), ['A'], 'A started before 07:00 and B did not start after it');
    assert.equal(r.record.sessions.length, 1);
    assert.equal(r.record.sessions[0].error_kind, null, 'the session in hand ran to its end');
    assert.equal(r.record.verifies.A.passed, true, 'the task in hand was still verified');
    assert.deepEqual(q.ledger().map((t) => t.status), ['done', 'todo']);
    assert.deepEqual([r.code, r.record.end_reason], [0, 'until']);
    assert.match(r.io.stdout.text(), /到了 --until 07:00/);
  });

  test('no progress: three sessions in a row with no commit and no status change stop the run; exit 1; the ledger is untouched', async () => {
    const p = project({ tasks: [T('A'), T('B')], script: [{}, {}, {}, {}] });
    const tf = path.join(p.proj, '.claude', 'state', 'tasks.json');
    const lf = path.join(p.proj, '.claude', 'state', 'logs.json');
    const before = [fs.readFileSync(tf, 'utf8'), fs.readFileSync(lf, 'utf8')];
    const r = await drive(p);
    assert.equal(p.calls().length, 3);
    assert.deepEqual([r.code, r.record.end_reason], [1, 'no_progress']);
    assert.deepEqual([fs.readFileSync(tf, 'utf8'), fs.readFileSync(lf, 'utf8')], before, 'the driver never writes the ledger');
    assert.match(r.report, /没进展（刹车）/);
  });

  test('a session that goes quiet is ended with its tree after --idle-min; the next session goes on with the task', async () => {
    const p = project({ tasks: [T('A')], script: [{ idleMs: 20000, grandchild: true }, doneStep('A')] });
    const t0 = Date.now();
    const r = await drive(p, ['--idle-min', '0.02']);
    assert.ok(Date.now() - t0 < 15000, 'the quiet session did not run its 20 s');
    assert.equal((await grandchildGone(p)).gone, true, 'the process the quiet session had started ended with it');
    assert.deepEqual(r.record.sessions.map((s) => s.error_kind), ['idle_timeout', null]);
    assert.deepEqual(named(p), ['A', 'A']);
    assert.deepEqual([r.code, r.record.end_reason], [0, 'all_done']);
  });

  test('usage limit: wait 10, 20, 40, then 60 minutes, retry the same task, report the waits; not a failure', async () => {
    assert.deepEqual(LIMIT_WAITS_MIN, [10, 20, 40, 60]);
    const p = project({ tasks: [T('A')], script: [{ usageLimit: true }, { usageLimit: true }, { usageLimit: true }, { usageLimit: true }, { usageLimit: true }, doneStep('A')] });
    const r = await drive(p, [], { limitWaitsMs: LIMIT_WAITS_MIN.map((m) => m * 60000), pollMs: 3600000 });
    assert.deepEqual(r.record.waits.map((w) => w.minutes), [10, 20, 40, 60, 60]);
    assert.deepEqual(r.waits, [10, 20, 40, 60, 60].map((m) => m * 60000));
    assert.deepEqual(r.record.sessions.map((s) => s.error_kind), ['usage_limit', 'usage_limit', 'usage_limit', 'usage_limit', 'usage_limit', null]);
    assert.deepEqual([r.code, r.record.end_reason], [0, 'all_done']);
    assert.match(r.report, /## 额度等待\n\n等了 5 次，合计 190 分钟/);
  });

  test('the stop file: the driver ends after the task in hand (exit 0) and deletes it', async () => {
    const p = project({ tasks: [T('A'), T('B')], script: [{ ...doneStep('A'), stopFile: true }, doneStep('B')] });
    const r = await drive(p);
    assert.deepEqual(named(p), ['A']);
    assert.deepEqual([r.code, r.record.end_reason], [0, 'stop_file']);
    assert.equal(fs.existsSync(stopFile(p.proj)), false);
    assert.equal(r.record.verifies.A.passed, true, 'the task in hand was still verified');
  });

  test('Ctrl+C once is a stop request too: the driver ends before the next task (exit 0)', async () => {
    const p = project({ tasks: [T('A')], script: [doneStep('A')] });
    const opts = parseRun([p.proj, '--cli', p.fake]);
    const d = new Driver(opts, { stdout: sink(), stderr: sink() }, { baseEnv: { ...process.env, FAKE_SCRIPT: p.scriptFile, FAKE_CALLS: p.callsFile }, accept: async () => 0 });
    d.interrupt();
    assert.equal(await d.run(), 0);
    assert.equal(d.endReason, 'interrupt');
    assert.equal(p.calls().length, 0);
    assert.equal(fs.existsSync(lockFile(p.proj)), false);
  });

  test('Ctrl+C twice: the session in hand ends at once with its tree, the record says so, the lock goes (exit 1)', async () => {
    const p = project({ tasks: [T('A')], script: [{ idleMs: 30000, grandchild: true }] });
    const opts = parseRun([p.proj, '--cli', p.fake]);
    const d = new Driver(opts, { stdout: sink(), stderr: sink() }, { baseEnv: { ...process.env, FAKE_SCRIPT: p.scriptFile, FAKE_CALLS: p.callsFile }, accept: async () => 0, pollMs: 20 });
    const t0 = Date.now();
    const running = d.run();
    while (!d.currentChild) await new Promise((r) => setTimeout(r, 20));
    const pid = d.currentChild.pid;
    // The session is in hand once the stand-in has started its own process.
    while (!fs.existsSync(path.join(p.dir, 'grandchild.pid'))) await new Promise((r) => setTimeout(r, 20));
    while (!fs.readFileSync(path.join(p.dir, 'grandchild.pid'), 'utf8')) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pidAlive(Number(fs.readFileSync(path.join(p.dir, 'grandchild.pid'), 'utf8'))), true, 'the session\'s own process runs before the second Ctrl+C');
    d.interrupt();
    assert.equal(d.abortNow(killTree), 1);
    assert.equal(await running, 1);
    assert.ok(Date.now() - t0 < 20000, 'the session did not run its 30 s');
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false);
    assert.equal((await grandchildGone(p)).gone, true, 'the process the session had started ended with it');
    assert.equal(fs.existsSync(lockFile(p.proj)), false);
    const rec = JSON.parse(fs.readFileSync(path.join(runsDir(p.proj), p.runs()[0], 'run.json'), 'utf8'));
    assert.equal(rec.end_reason, 'interrupt_now');
    assert.match(fs.readFileSync(path.join(runsDir(p.proj), p.runs()[0], 'report.md'), 'utf8'), /第二次 Ctrl\+C/);
  });

  test('a verification command that runs past --verify-timeout-min is ended: no exit code, not passed', async () => {
    const p = project({
      tasks: [T('A', { acceptance_mode: 'manual', verification_commands: ['node -e "setTimeout(() => {}, 30000)"'] })],
      script: [{ status: { A: 'awaiting_manual_acceptance' }, files: { 'a.txt': '1' }, commit: 'feat(A)' }],
    });
    const t0 = Date.now();
    const r = await drive(p, ['--verify-timeout-min', '0.02']);
    assert.ok(Date.now() - t0 < 25000);
    const v = r.record.verifies.A;
    assert.equal(v.passed, false);
    assert.deepEqual([v.commands[0].exit_code, v.commands[0].timed_out], [null, true]);
    assert.match(r.report, /超时.*复验没过，建议驳回/);
  });

  test('exit codes: 0 for the normal stop points, 1 for brakes and errors', () => {
    assert.deepEqual([...NORMAL_ENDS].sort(), ['all_done', 'interrupt', 'max_tasks', 'owner', 'stop_file', 'until']);
    for (const r of NORMAL_ENDS) assert.equal(exitCodeOf(r), 0, r);
    for (const r of ['no_progress', 'blocked', 'error', 'interrupt_now']) assert.equal(exitCodeOf(r), 1, r);
  });
});

// ---------- the lock and stop ----------

describe('one driver a project', () => {
  test('a live driver holds the lock: a second one refuses (exit 1); stop asks it to end and writes the stop file', async () => {
    const p = project({ tasks: [T('A')], script: [doneStep()] });
    function doneStep() { return { status: { A: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(A)' }; }
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    try {
      fs.writeFileSync(lockFile(p.proj), JSON.stringify({ pid: alive.pid, run: 'other', started_at: '2026-11-19T00:00:00Z' }));
      const r = await drive(p);
      assert.equal(r.code, 1);
      assert.match(r.io.stderr.text(), new RegExp(`another driver runs in this project \\(pid ${alive.pid}, run other`));
      assert.equal(p.calls().length, 0);
      assert.equal(readLock(p.proj).pid, alive.pid, 'the other driver keeps its lock');
      const io = { stdout: sink(), stderr: sink() };
      assert.equal(await stopCommand([p.proj], io), 0);
      assert.ok(fs.existsSync(stopFile(p.proj)));
      assert.match(io.stdout.text(), /stop after the task in hand/);
    } finally {
      alive.kill();
    }
  });

  test('a lock whose driver is gone is taken over and noted; the lock goes when the run ends; stop then has nothing to ask', async () => {
    const p = project({ tasks: [T('A')], script: [{ status: { A: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(A)' }] });
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    fs.writeFileSync(lockFile(p.proj), JSON.stringify({ pid: Number(gone.stdout), run: 'old-run', started_at: '2026-11-18T00:00:00Z' }));
    fs.writeFileSync(stopFile(p.proj), '{}');
    const r = await drive(p);
    assert.equal(r.code, 0);
    assert.equal(p.calls().length, 1, 'a stop file left by the dead driver does not stop the new one');
    assert.match(r.report, new RegExp(`接手了旧锁：pid ${gone.stdout} 的驱动（运行 old-run`));
    assert.match(r.report, /删掉了上一次没收尾的驱动留下的停止文件/);
    assert.equal(fs.existsSync(lockFile(p.proj)), false);
    const io = { stdout: sink(), stderr: sink() };
    assert.equal(await stopCommand([p.proj], io), 1);
    assert.equal(fs.existsSync(stopFile(p.proj)), false);
  });

  test('a lock file that cannot be read is replaced, not kept; no file is left beside the lock', async () => {
    const p = project({ tasks: [T('A')], script: [{ status: { A: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(A)' }] });
    fs.writeFileSync(lockFile(p.proj), 'not json');
    let seen = null;
    let beside = null;
    const r = await drive(p, [], { accept: async (proj) => { seen = readLock(proj); beside = fs.readdirSync(path.dirname(lockFile(proj))).filter((n) => n.startsWith('run.lock')); return 0; } });
    assert.equal(r.code, 0);
    assert.equal(seen.pid, process.pid);
    assert.deepEqual(beside, ['run.lock'], 'the lock moved aside is deleted');
    assert.equal(fs.existsSync(lockFile(p.proj)), false);
  });

  // Six drivers start on one project at the same instant (each waits for the same go file, then takes the lock and,
  // when it got it, holds it for a while). Whatever was there before, exactly one of them holds the lock.
  const RACER = String.raw`
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [driverFile, project, goFile, outFile] = process.argv.slice(2);
const { Driver } = await import(pathToFileURL(driverFile).href);
const d = new Driver({ project }, { stdout: { write() {} }, stderr: { write() {} } });
d.startedAt = new Date().toISOString();
d.run = 'race-' + process.pid;
fs.writeFileSync(outFile + '.ready', '');
while (!fs.existsSync(goFile)) { /* spin: all racers leave this loop within the same millisecond or two */ }
const err = d.lock();
fs.writeFileSync(outFile, JSON.stringify({ pid: process.pid, got: err === null, err }));
if (err === null) setTimeout(() => {}, 4000);
`;
  async function race(prepare) {
    const p = project({ tasks: [T('A')] });
    prepare(p);
    const racer = path.join(p.dir, 'racer.mjs');
    fs.writeFileSync(racer, RACER);
    const go = path.join(p.dir, 'go');
    const outs = Array.from({ length: 6 }, (_, i) => path.join(p.dir, `racer-${i}.json`));
    const kids = outs.map((out) => spawn(process.execPath, [racer, path.join(REPO, 'scripts', 'lib', 'run', 'driver.mjs'), p.proj, go, out], { stdio: 'ignore', windowsHide: true }));
    try {
      const until = Date.now() + 20000;
      while (!outs.every((o) => fs.existsSync(`${o}.ready`)) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      assert.ok(outs.every((o) => fs.existsSync(`${o}.ready`)), 'all six racers are ready');
      fs.writeFileSync(go, '');
      while (!outs.every((o) => fs.existsSync(o) && fs.readFileSync(o, 'utf8')) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      const results = outs.map((o) => JSON.parse(fs.readFileSync(o, 'utf8')));
      const lock = readLock(p.proj);
      return { p, results, winners: results.filter((r) => r.got), lock };
    } finally {
      for (const k of kids) k.kill();
    }
  }
  const exactlyOne = ({ p, results, winners, lock }, what) => {
    assert.equal(winners.length, 1, `${what}: ${JSON.stringify(results)}`);
    assert.equal(lock.pid, winners[0].pid, 'the lock names the one that got it');
    assert.equal(lock.alive, true);
    for (const r of results.filter((x) => !x.got)) assert.match(r.err, /another driver runs in this project/, what);
    assert.deepEqual(fs.readdirSync(path.dirname(lockFile(p.proj))).filter((n) => n.startsWith('run.lock')), ['run.lock'], 'no takeover file is left');
  };
  test('six drivers starting at once on a project without a lock: exactly one holds it', async () => {
    exactlyOne(await race(() => {}), 'no lock');
  });
  test('six drivers starting at once on a lock left by a dead driver: exactly one takes it over', async () => {
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    exactlyOne(await race((p) => fs.writeFileSync(lockFile(p.proj), JSON.stringify({ pid: Number(gone.stdout), run: 'old-run', started_at: '2026-11-18T00:00:00Z' }))), 'dead lock');
  });
  test('six drivers starting at once on a lock file that cannot be read: exactly one replaces it', async () => {
    exactlyOne(await race((p) => fs.writeFileSync(lockFile(p.proj), 'not json')), 'unreadable lock');
  });

  test('while it runs, the lock names this process and this run', async () => {
    let seen = null;
    const p = project({ tasks: [T('A')], script: [{ status: { A: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(A)' }] });
    const r = await drive(p, [], { accept: async (proj) => { seen = readLock(proj); return 0; } });
    assert.equal(seen.pid, process.pid);
    assert.equal(seen.run, r.run);
    assert.equal(seen.alive, true);
  });
});

// ---------- the report ----------

describe('the report and the run record', () => {
  test('one row a task with result, commit, verification, tokens, time; totals; awaiting; blocked; the acceptance sheet', async () => {
    const p = project({
      tasks: [T('A'), T('B', { acceptance_mode: 'manual' }), T('C', { notes: '受阻：要负责人给账号' })],
      script: [
        { status: { A: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(A): a', tokens: 5000 },
        { status: { B: 'awaiting_manual_acceptance' }, files: { 'b.txt': '1' }, commit: 'feat(B): b', tokens: 7000 },
      ],
    });
    const r = await drive(p, [], { accept: undefined });
    const commits = gitIn(p.proj, 'log', '--format=%h %s', '-2').split('\n');
    assert.equal(r.code, 1, 'C is blocked');
    assert.equal(r.record.end_reason, 'blocked');
    assert.match(r.report, /^# 长跑报告 /);
    assert.match(r.report, /\| 任务 \| 结果 \| 提交 \| 复验 \| token \| 用时 \|/);
    assert.match(r.report, new RegExp(`\\| A task A \\| 完成 \\| ${commits[1].slice(0, 7)} \\| 通过 \\| 5,100 \\| \\d+ 秒 \\|`));
    assert.match(r.report, new RegExp(`\\| B task B \\| 待验收 \\| ${commits[0].slice(0, 7)} \\| 通过 \\| 7,100 \\|`));
    assert.match(r.report, /## 合计\n\n- 会话 2 个，做完（完成或待验收）2 个任务\n- token 12,200，平均每个任务 6,100/);
    assert.match(r.report, /## 等你验收的\n\n- B task B：复验通过/);
    assert.match(r.report, /## 受阻的\n\n- C task C：受阻：要负责人给账号/);
    assert.match(r.report, /## 额度等待\n\n没有等过。/);
    // The acceptance sheet goes through the entry's COMMANDS (a placeholder that exits 1 until AS3-366 is merged).
    assert.equal(typeof r.record.accept.exit_code, 'number');
    assert.ok(fs.existsSync(path.join(p.proj, r.record.accept.log)));
    if (r.record.accept.exit_code === 0) assert.match(r.report, /## 验收包\n\n出了/);
    else assert.match(r.report, new RegExp(`## 验收包\\n\\n没出成：accept 命令退出码 ${r.record.accept.exit_code}`));
    assert.equal(r.record.tokens_total, 12200);
    assert.equal(r.record.sessions.length, 2);
    assert.match(r.io.stdout.text(), /已用 5,100 token；做完 1 个任务，平均每个 5,100；还有 2 个没做完，按平均约还要 10,200/);
  });

  test('an acceptance sheet that throws is one line in the report and does not change the exit code', async () => {
    const p = project({ tasks: [T('A')], script: [{ status: { A: 'done' }, files: { 'a.txt': '1' }, commit: 'feat(A)' }] });
    const r = await drive(p, [], { accept: async () => { throw new Error('sheet broke'); } });
    assert.equal(r.code, 0);
    assert.match(r.report, /没出成：accept 命令退出码 null/);
  });

  test('a CLI that cannot start: exit 1, the report says so, the lock goes', async () => {
    const p = project({ tasks: [T('A')] });
    const io = { stdout: sink(), stderr: sink() };
    const code = await runWith([p.proj, '--cli', path.join(p.dir, 'no-such-claude.exe')], io, { accept: async () => 0 });
    assert.equal(code, 1);
    const run = p.runs()[0];
    const rec = JSON.parse(fs.readFileSync(path.join(runsDir(p.proj), run, 'run.json'), 'utf8'));
    assert.equal(rec.end_reason, 'error');
    assert.equal(fs.existsSync(lockFile(p.proj)), false);
  });
});

// ---------- pieces ----------

describe('pieces', () => {
  test('the session environment drops what a parent session set and pins PROJECT_DIR', () => {
    const { env, stripped } = childEnv('X:/p', { CLAUDECODE: '1', CLAUDE_EFFORT: 'max', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 's', PROJECT_DIR: 'Y:/q', KEEP: 'k', CLAUDE_CODE_SUBAGENT_MODEL: 'm' });
    assert.equal(env.PROJECT_DIR, 'X:/p');
    assert.equal(env.KEEP, 'k');
    // The guard hook reads this mark and denies a git push in every permission mode (hooks/guard.mjs).
    assert.equal(env.AUTOSKILLS_UNATTENDED, '1');
    assert.equal(childEnv('X:/p', { AUTOSKILLS_UNATTENDED: '0' }).env.AUTOSKILLS_UNATTENDED, '1', 'a value from outside does not take the mark away');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm', 'the owner\'s own settings stay');
    for (const k of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) assert.equal(env[k], undefined, k);
    assert.deepEqual(stripped.sort(), ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT']);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });

  test('how a session ended: usage limit by the harness rule, idle, api, process', () => {
    const acc = (result) => ({ sessionId: null, init: null, result, lastText: '', toolCalls: 0, kitCalls: 0, skills: [], hooks: [], events: 0, badLines: 0 });
    assert.equal(outcomeOf(acc({ subtype: 'success', is_error: false, result: 'ok' }), { code: 0 }).errorKind, null);
    assert.equal(outcomeOf(acc({ subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit" }), { code: 1, stderrTail: '' }).errorKind, 'usage_limit');
    assert.equal(outcomeOf(acc(null), { code: 1, stderrTail: 'API Error: 429 Too Many Requests' }).errorKind, 'usage_limit');
    assert.equal(outcomeOf(acc(null), { code: null, killed: 'idle', stderrTail: '' }).errorKind, 'idle_timeout');
    assert.equal(outcomeOf(acc({ subtype: 'error_during_execution', is_error: true, result: 'boom' }), { code: 1, stderrTail: '' }).errorKind, 'api');
    assert.equal(outcomeOf(acc(null), { code: 1, stderrTail: '' }).errorKind, 'process');
    assert.ok(USAGE_LIMIT_RE.test('limit reached'));
    assert.deepEqual(sessionArgs({ prompt: 'p', permissionMode: 'auto' }), ['-p', 'p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto']);
  });

  test('the entry finds run and stop through COMMANDS', async () => {
    const io = { stdout: sink(), stderr: sink() };
    assert.equal(await main(['run', '--help'], io), 0);
    assert.equal(await main(['stop', '--help'], io), 0);
    assert.equal(typeof runCommand, 'function');
  });
});
