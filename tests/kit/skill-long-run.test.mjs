// Tests for the text that lets a session start the long-run driver (AS3-373; node:test, zero dependencies).
// The skill text, the page next to it (skills/project-next/long-run.md) and the driver are tied together by nothing
// but these checks:
//   - the sentence by which a session knows that the driver started it is the one every driver prompt carries;
//   - the options the page names are options of `run`, and the lock it reads is the driver's lock file;
//   - the page keeps its rules: one ledger entry before the start and none after, read-only while the driver runs,
//     and a session never deletes the lock on its own;
//   - the PowerShell on the page works: the script finder on a deployed layout; the lock check on a live driver, on
//     locks left behind and on locks it cannot read; the launch with spaces and brackets in paths, with and without
//     an old lock, and when the driver does not take the lock.
// The PowerShell tests run Windows PowerShell 5.1 with a temp folder as the user directory. They start stand-ins,
// never the driver, and are skipped off Windows.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskPrompt, multiPrompt, reworkPrompt, giveUpPrompt, resumePrompt } from '../../scripts/lib/run/prompts.mjs';
import { RUN_USAGE } from '../../scripts/lib/run/cli.mjs';
import { lockFile, readLock } from '../../scripts/lib/run-paths.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const NEXT = read('skills', 'project-next', 'SKILL.md');
const RESUME = read('skills', 'project-resume', 'SKILL.md');
const FEEDBACK = read('skills', 'project-feedback', 'SKILL.md');
const PAGE = read('skills', 'project-next', 'long-run.md');
const RUN_DOC = read('docs', 'run.md');
/** The sentence of a driver prompt that the skill text names. */
const MARK = '这是无人值守的运行';
const PHRASES = ['起长跑', '挂着跑', '跑到几点'];
/**
 * The project-manager tools that change the ledger: every registered tool but the get_ ones and the two that only
 * read or only point the server at a project.
 */
const LEDGER_TOOLS = [...read('mcp', 'project-manager', 'src', 'index.ts').matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const LEDGER_WRITES = LEDGER_TOOLS.filter((name) => !name.startsWith('get_') && !['lint_state', 'set_project_dir'].includes(name));
const WIN = process.platform === 'win32';
const slash = (p) => p.split(path.sep).join('/');
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The part of a Markdown text from the first line that starts with `heading` up to the next `## ` heading. */
function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => l.startsWith(heading));
  assert.notEqual(from, -1, `no heading that starts with ${heading}`);
  let to = lines.findIndex((l, i) => i > from && l.startsWith('## '));
  if (to === -1) to = lines.length;
  return lines.slice(from, to).join('\n');
}

/** The PowerShell code blocks of a Markdown text. */
const powershellBlocks = (text) => [...text.matchAll(/```powershell\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]);
/** The one PowerShell block of a section of the page. */
function pageBlock(heading) {
  const blocks = powershellBlocks(section(PAGE, heading));
  assert.equal(blocks.length, 1, `${heading} has one PowerShell block`);
  return blocks[0];
}

const temps = [];
const children = [];
after(() => {
  for (const pid of children) { try { process.kill(pid); } catch { /* gone */ } }
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
/** A temp folder whose name has a space in it. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill long-run '));
  temps.push(dir);
  return dir;
}
/** A project folder with a space and brackets in its name (PowerShell reads brackets as a pattern unless told not to). */
function projectDir(dir, name = 'a [project]') {
  const project = path.join(dir, name);
  fs.mkdirSync(project, { recursive: true });
  return project;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
/** A script text as a file Windows PowerShell 5.1 reads right (with a BOM, so that paths outside ASCII survive). */
function scriptFile(dir, name, script) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `﻿${script}\r\n`, 'utf8');
  return file;
}
function powershell(dir, name, script, env = {}) {
  return spawnSync('powershell.exe', [...PS_ARGS, scriptFile(dir, name, script)], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 90000,
  });
}
/** The same without waiting: resolves to {status, stdout, stderr}. */
function powershellAsync(dir, name, script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [...PS_ARGS, scriptFile(dir, name, script)], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
/** The lock check of the page for a project: its one output line. */
function checkLock(dir, name, project) {
  const r = powershell(dir, name, pageBlock('## 核对锁').replaceAll('<主检出>', project));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), '', 'the check prints no error');
  return r.stdout.trim();
}
/** A process number that no longer exists. */
function deadPid() {
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  assert.equal(gone.status, 0);
  return gone.pid;
}

describe('the skill text', () => {
  test('project-next sends the three phrases to the page that sits next to it', () => {
    const description = /^description: (.*)$/m.exec(NEXT)[1];
    for (const phrase of PHRASES) assert.ok(description.includes(`"${phrase}"`), `the description names ${phrase}`);
    const part = section(NEXT, '## 长跑');
    for (const phrase of PHRASES) assert.ok(part.split('\n')[0].includes(phrase), `the heading names ${phrase}`);
    assert.ok(part.includes('`long-run.md`'));
    assert.ok(part.includes('Claude Code') && part.includes('Codex'), 'says where it exists and where it does not');
    assert.ok(fs.existsSync(path.join(REPO, 'skills', 'project-next', 'long-run.md')));
    for (const phrase of PHRASES) assert.ok(PAGE.includes(phrase), `the page names ${phrase}`);
  });

  test('the loop of project-next has no lock check: a session the driver started must not stop on its own driver', () => {
    const lines = NEXT.split(/\r?\n/);
    const from = lines.findIndex((l) => l.startsWith('## 开始'));
    const to = lines.findIndex((l) => l.startsWith('## 长跑'));
    assert.ok(from !== -1 && to > from, 'the section 长跑 comes after the loop');
    assert.ok(lines.findIndex((l) => l.startsWith('## 停点')) > to, 'and before the stop points');
    assert.ok(!lines.slice(from, to).join('\n').includes('run.lock'));
  });

  test('a session the driver started is told apart by the sentence every driver prompt carries', () => {
    const prompts = {
      task: taskPrompt('T1'),
      multi: multiPrompt('T1', 3),
      resume: resumePrompt('T1'),
      rework: reworkPrompt({ failedTask: 'T1', origin: 'T1', round: 1, failure: 'exit 1' }),
      giveUp: giveUpPrompt({ taskId: 'T2', origin: 'T1', failure: 'exit 1' }),
    };
    for (const [name, text] of Object.entries(prompts)) assert.ok(text.includes(MARK), `the ${name} prompt carries the sentence`);
    assert.ok(section(NEXT, '## 长跑').includes(MARK), 'project-next names it');
    assert.ok(PAGE.indexOf(MARK) !== -1 && PAGE.indexOf(MARK) < PAGE.indexOf('## 核对锁'), 'the page names it before its first step');
    // The resume prompt sends a driver session to project-resume: the exception must stand before the lock check.
    const resume = section(RESUME, '## 2.');
    assert.ok(resume.indexOf(MARK) !== -1 && resume.indexOf(MARK) < resume.indexOf('.autoskills/run.lock'), 'project-resume names it before the lock');
  });

  test('project-resume looks for a running driver before it reads or writes the ledger', () => {
    const part = section(RESUME, '## 2.');
    const lock = part.indexOf('.autoskills/run.lock');
    assert.notEqual(lock, -1);
    for (const tool of ['get_project_context', 'add_log']) {
      assert.ok(part.indexOf(tool) > lock, `the lock comes before ${tool}`);
    }
    const first = part.slice(lock, part.indexOf('get_project_context'));
    assert.ok(first.includes('只读') && first.includes('不写账本'));
    assert.ok(first.includes('`long-run.md`') && first.includes('核对锁'), 'it uses the check of the page');
    assert.ok(first.includes('`driver alive True`') && first.includes('`Unknown`') && first.includes('`driver alive False`'));
  });

  test('project-feedback uses the same lock check', () => {
    const part = section(FEEDBACK, '## 1.');
    assert.ok(part.includes('.autoskills/run.lock') && part.includes('`long-run.md`') && part.includes('核对锁'));
    assert.ok(part.includes('`driver alive True`') && part.includes('`Unknown`') && part.includes('`driver alive False`'));
    assert.ok(!part.includes('进程还活着'), 'not by the process number alone');
  });

  test('every option the page names is an option of run', () => {
    const options = (text) => [...new Set(text.match(/--[a-z][a-z-]+/g) || [])];
    const known = options(RUN_USAGE.slice(RUN_USAGE.indexOf('Options:')));
    const named = options(section(PAGE, '## 3.'));
    for (const must of ['--until', '--max-tasks']) assert.ok(named.includes(must), `the page names ${must}`);
    for (const o of named) assert.ok(known.includes(o), `${o} is an option of run`);
    const launch = pageBlock('## 5.').split(/\r?\n/);
    assert.equal(launch[0], "$project = '<主检出>'; $script = '<脚本>'; $options = '<选项>'");
    // No -WorkingDirectory: Start-Process reads it as a pattern and fails on a folder with brackets in its name, and
    // the driver takes the project from its argument, not from where it was started.
    assert.ok(launch.includes("Start-Process powershell.exe -ArgumentList '-NoProfile','-NoExit','-Command',\"node '$script' run '$project' $options\""));
    assert.ok(section(PAGE, '## 驱动还在跑的时候').includes("node '<脚本>' stop '<主检出>'"));
  });

  test('the page reads the lock file of the driver, with its three fields', () => {
    assert.ok(section(PAGE, '## 核对锁').includes(slash(lockFile('<主检出>'))), 'the prose names the path the driver uses');
    assert.ok(pageBlock('## 核对锁').includes(`'${lockFile('<主检出>').split('/').join('\\')}'`), 'so does the check');
    assert.equal(path.join('P', '.autoskills\\run.lock'.split('\\').join(path.sep)), lockFile('P'));
    assert.ok(pageBlock('## 5.').includes("Join-Path $project '.autoskills\\run.lock'"), 'and the launch');
    assert.ok(PAGE.includes('{pid, run, started_at}'));
  });

  test('one ledger entry before the start and none after; read-only while the driver runs', () => {
    assert.ok(LEDGER_TOOLS.length >= 30, `the tool registry was read (${LEDGER_TOOLS.length} tools)`);
    for (const tool of ['add_log', 'update_task_status', 'update_tasks', 'edit_task', 'close_task', 'save_prd', 'set_task_priority']) {
      assert.ok(LEDGER_WRITES.includes(tool), `${tool} counts as a ledger write`);
    }
    const before = section(PAGE, '## 4.');
    assert.ok(before.includes('add_log') && before.includes('最后一次写账本'));
    for (const heading of ['## 核对锁', '## 5.', '## 6.', '## 驱动还在跑的时候']) {
      const part = section(PAGE, heading);
      for (const tool of LEDGER_WRITES) assert.ok(!part.includes(tool), `${heading} names no ledger write (${tool})`);
    }
    const running = section(PAGE, '## 驱动还在跑的时候');
    for (const rule of ['只读', '不写账本', '不改工作目录', '不提交', '不做任务', '不凭印象']) assert.ok(running.includes(rule), rule);
    assert.ok(running.includes('`driver alive True`') && running.includes('`Unknown`'), 'a check that cannot be read counts as running');
  });

  test('a session does not delete the lock on its own, whatever the check says', () => {
    const check = section(PAGE, '## 核对锁');
    for (const verdict of ['`driver alive True`', '`driver alive Unknown`', '`driver alive False`', '`no lock`']) {
      assert.ok(check.includes(`- ${verdict}`), `the page says what ${verdict} means`);
    }
    assert.ok(/`driver alive Unknown`[^\n]*当成在跑/.test(check));
    assert.ok(check.includes('会话不删锁文件，用户说删才删'));
    for (const [name, text] of [['the page', PAGE], ['project-resume', RESUME], ['project-feedback', FEEDBACK], ['project-next', NEXT]]) {
      assert.ok(!text.includes('Remove-Item'), `${name} gives no command that deletes`);
    }
    const first = section(PAGE, '## 1.');
    assert.ok(/`driver alive True` 或 `Unknown`[^\n]*不起第二个/.test(first));
    assert.ok(/`driver alive False`[^\n]*照常往下做/.test(first));
    assert.ok(/`driver alive False`[^\n]*不删它/.test(section(RESUME, '## 2.')));
    // The three results of the launch. The lock goes in one case only: it was there before, the check says False,
    // the user says so, and the check says False once more.
    const launch = section(PAGE, '## 5.');
    for (const result of ['`new lock`', '`no lock`', '`the lock did not change`']) assert.ok(launch.includes(`- ${result}`), result);
    const unchanged = launch.slice(launch.indexOf('- `the lock did not change`'));
    assert.ok(unchanged.includes('再核对一次锁'), 'an unchanged lock is checked before anything is said about it');
    assert.ok(/`driver alive True` 或 `Unknown`：是另一个驱动在跑[^\n]*什么都不删/.test(unchanged));
    assert.ok(/`driver alive False`：[^\n]*用户说删，就再核对一次，还是 `False` 才删掉这一个文件/.test(unchanged));
    assert.ok(launch.includes("没有选项时写 `$options = ''`"), 'no option is an empty string, not the placeholder');
  });

  test('the run guide tells how to start it from a session and points to the probe record', () => {
    const part = section(RUN_DOC, '## 在会话里说一句来起');
    assert.ok(part.includes('起长跑') && part.includes('`long-run.md`'));
    assert.ok(part.includes('拒绝起') && part.includes('你说删它才删'), 'it says what happens to a lock left behind');
    assert.ok(part.includes('run-from-session-probe.md'));
    const record = read('docs', 'run-from-session-probe.md');
    for (const heading of ['## 结论', '## 证据在哪']) assert.ok(record.includes(heading), `the probe record has ${heading}`);
  });
});

describe('the PowerShell on the page', { skip: WIN ? false : 'Windows PowerShell only' }, () => {
  test('the finder reads the kit repo from the hook config next to the SessionStart hook of a deployed layout', () => {
    const dir = tempDir();
    // A user directory with a space and with characters outside ASCII in its name; a runtime area and a kit repo
    // with brackets in theirs.
    const home = path.join(dir, 'home 目录');
    const runtime = path.join(dir, 'rt [1]');
    const kit = path.join(dir, 'kit [repo]');
    write(path.join(kit, 'scripts', 'autoskills.mjs'), '// a stand-in for the entry\n');
    // The settings file as deploy-kit writes it: the kit fragment with its placeholders filled.
    const filled = read('config', 'claude', 'settings.fragment.json')
      .replaceAll('<node>', 'node').replaceAll('<runtime>', slash(runtime)).replaceAll('<home>', slash(home));
    const settings = JSON.parse(filled);
    // A hook of someone else's in front of the kit's, without args and with text outside ASCII: the finder must
    // pass over it, and must read the file as UTF-8.
    settings.hooks.SessionStart.unshift({ matcher: 'startup', hooks: [{ type: 'command', command: 'echo 别的钩子“带引号”' }] });
    write(path.join(home, '.claude', 'settings.json'), settings);
    write(path.join(runtime, 'hooks', 'hook-config.json'), { runtime: slash(runtime), readonly_dirs: [], kit_repo: slash(kit) });

    const r = powershell(dir, 'find.ps1', pageBlock('## 2.'), { USERPROFILE: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), '');
    assert.ok(r.stdout.replaceAll('\\', '/').includes(`${slash(kit)}/scripts/autoskills.mjs exists: True`), r.stdout);
  });

  test('the lock check: a live driver, a process number that was used again, a dead process, no lock', async () => {
    const dir = tempDir();
    const project = projectDir(dir);
    assert.equal(checkLock(dir, 'no-lock.ps1', project), 'no lock');

    // A live node process stands in for the driver. The lock is written after it started, as the driver's is.
    const standIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    children.push(standIn.pid);
    await pause(500);
    write(lockFile(project), { pid: standIn.pid, run: 'R1', started_at: new Date().toISOString() });
    assert.equal(readLock(project).alive, true, 'the driver reads the same file as alive');
    assert.match(checkLock(dir, 'alive.ps1', project), /^run R1 started_at \S+ pid \d+: driver alive True$/);
    // The same process under a lock from before it started: the driver of that lock is gone and its process
    // number went to another process. The driver itself would still call this lock alive.
    write(lockFile(project), { pid: standIn.pid, run: 'R0', started_at: '2020-01-01T00:00:00.000Z' });
    assert.equal(readLock(project).alive, true);
    assert.match(checkLock(dir, 'reused.ps1', project), /^run R0 .*: driver alive False$/);
    // A process that is not node under the lock's number: this test's own PowerShell would do, but any other name
    // serves; the system process 4 always exists on Windows.
    write(lockFile(project), { pid: 4, run: 'R3', started_at: new Date().toISOString() });
    assert.match(checkLock(dir, 'not-node.ps1', project), /^run R3 .*: driver alive False$/);

    standIn.kill();
    for (let i = 0; i < 50 && standIn.exitCode === null && standIn.signalCode === null; i += 1) await pause(100);
    write(lockFile(project), { pid: standIn.pid, run: 'R2', started_at: new Date().toISOString() });
    assert.match(checkLock(dir, 'gone.ps1', project), /^run R2 .*: driver alive False$/);
  });

  test('the lock check: a lock it cannot read is Unknown, never False', () => {
    const dir = tempDir();
    const project = projectDir(dir);
    const cases = {
      'an empty file, as while the driver writes it': '',
      'half a lock': '{\n  "pid": 1234,\n  "run": "R',
      'no process number': JSON.stringify({ run: 'R', started_at: new Date().toISOString() }),
      'a process number that is no number': JSON.stringify({ pid: 'abc', run: 'R', started_at: new Date().toISOString() }),
      'a start time that is no time': JSON.stringify({ pid: process.pid, run: 'R', started_at: 'yesterday' }),
    };
    let n = 0;
    for (const [what, text] of Object.entries(cases)) {
      n += 1;
      write(lockFile(project), text);
      assert.match(checkLock(dir, `unknown-${n}.ps1`, project), /: driver alive Unknown$/, what);
    }
  });

  /** The launch block of the page for a test: filled in, with a hidden window that ends with the stand-in. */
  function launchScript(project, standIn) {
    const script = pageBlock('## 5.')
      // Two differences from the page, so that a test leaves nothing on the screen: no -NoExit and a hidden window.
      .replace('Start-Process powershell.exe', 'Start-Process powershell.exe -WindowStyle Hidden')
      .replace("'-NoExit',", '')
      .replace('<主检出>', project)
      .replace('<脚本>', standIn)
      .replace('<选项>', '--until 07:00 --max-tasks 2');
    assert.ok(!/<[^>]*>/.test(script.split(/\r?\n/)[0]), 'the first line is filled in');
    return script;
  }
  /** A stand-in for the driver: it records how it was started; with takesLock it writes a lock of its own and stays. */
  function standInFile(dir, name, { takesLock }) {
    const file = path.join(dir, name);
    write(file, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const [, project] = process.argv.slice(2);',
      "fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'started.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));",
      takesLock
        ? "setTimeout(() => { fs.mkdirSync(path.join(project, '.autoskills'), { recursive: true }); fs.writeFileSync(path.join(project, '.autoskills', 'run.lock'), JSON.stringify({ pid: process.pid, run: 'NEW', started_at: new Date().toISOString() })); }, 2500); setTimeout(() => {}, 90000);"
        : '',
      '',
    ].join('\n'));
    return file;
  }
  const startedBy = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'started.json'), 'utf8'));

  test('the launch: arguments arrive whole, the wait lasts until the driver has the lock, and the check then says True', async () => {
    const dir = tempDir();
    const project = projectDir(dir);
    const began = Date.now();
    const r = powershell(dir, 'launch.ps1', launchScript(project, standInFile(dir, 'takes lock.mjs', { takesLock: true })));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'new lock', r.stderr);
    assert.ok(Date.now() - began >= 2000, 'it waited for the lock');
    const started = startedBy(dir);
    children.push(started.pid);
    assert.deepEqual(started.argv, ['run', project, '--until', '07:00', '--max-tasks', '2']);
    assert.match(checkLock(dir, 'after.ps1', project), /^run NEW started_at \S+ pid \d+: driver alive True$/);
  });

  test('the launch with an old lock: taken over is a new lock; not taken over, the lock did not change; no driver, no lock', async () => {
    // Taken over: the old lock (a process that is gone) is replaced by the stand-in's.
    const dirA = tempDir();
    const projectA = projectDir(dirA);
    write(lockFile(projectA), { pid: deadPid(), run: 'OLD', started_at: '2026-11-19T00:00:00.000Z' });
    assert.match(checkLock(dirA, 'old.ps1', projectA), /^run OLD .*: driver alive False$/);
    const a = powershell(dirA, 'launch.ps1', launchScript(projectA, standInFile(dirA, 'takes lock.mjs', { takesLock: true })));
    assert.equal(a.stdout.trim(), 'new lock', a.stderr);
    children.push(startedBy(dirA).pid);
    assert.match(checkLock(dirA, 'after.ps1', projectA), /^run NEW .*: driver alive True$/);

    // Not taken over (the driver refuses a lock whose process number is in use), and no lock at all: both take the
    // whole wait, so they run side by side.
    const dirB = tempDir();
    const projectB = projectDir(dirB);
    const old = { pid: process.pid, run: 'OLD', started_at: '2020-01-01T00:00:00.000Z' };
    write(lockFile(projectB), old);
    const dirC = tempDir();
    const projectC = projectDir(dirC);
    const [b, c] = await Promise.all([
      powershellAsync(dirB, 'launch.ps1', launchScript(projectB, standInFile(dirB, 'refuses.mjs', { takesLock: false }))),
      powershellAsync(dirC, 'launch.ps1', launchScript(projectC, standInFile(dirC, 'refuses.mjs', { takesLock: false }))),
    ]);
    assert.equal(b.stdout.trim(), 'the lock did not change', b.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(projectB), 'utf8')), old, 'and it is still there');
    assert.deepEqual(startedBy(dirB).argv.slice(0, 2), ['run', projectB], 'the stand-in did run');
    assert.equal(c.stdout.trim(), 'no lock', c.stderr);
    assert.ok(!fs.existsSync(lockFile(projectC)));
  });
});
