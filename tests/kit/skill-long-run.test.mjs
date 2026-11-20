// Tests for the text that lets a session start the long-run driver (AS3-373; node:test, zero dependencies).
// The skill text, the page next to it (skills/project-next/long-run.md) and the driver are tied together by nothing
// but these checks:
//   - the sentence by which a session knows that the driver started it is the one every driver prompt carries;
//   - the options the page names are options of `run`, and the lock it reads is the driver's lock file;
//   - the page keeps its rules: one ledger entry before the start and none after, read-only while the driver runs;
//   - the PowerShell on the page works: the script finder on a deployed layout, the launch line with spaces in
//     paths, the lock check on a live driver, a stale lock and no lock.
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
const PAGE = read('skills', 'project-next', 'long-run.md');
const RUN_DOC = read('docs', 'run.md');
/** The sentence of a driver prompt that the skill text names. */
const MARK = '这是无人值守的运行';
const PHRASES = ['起长跑', '挂着跑', '跑到几点'];
/** project-manager tools that change the ledger and could be named in a step. */
const LEDGER_WRITES = ['add_log', 'update_task_status', 'update_tasks', 'edit_task', 'create_tasks', 'set_current_focus'];
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

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
/** A temp folder whose name has a space in it. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill long-run '));
  temps.push(dir);
  return dir;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
/** Run a script text in Windows PowerShell 5.1 (a file with a BOM, so that paths outside ASCII survive). */
function powershell(dir, name, script, env = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `﻿${script}\r\n`, 'utf8');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 60000,
  });
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
    assert.ok(PAGE.includes(MARK), 'the page names it');
    assert.ok(section(RESUME, '## 2.').includes(MARK), 'project-resume names it');
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
    assert.ok(first.includes('`long-run.md`') && first.includes('第 6 步'), 'it uses the check of the page');
  });

  test('every option the page names is an option of run', () => {
    const options = (text) => [...new Set(text.match(/--[a-z][a-z-]+/g) || [])];
    const known = options(RUN_USAGE.slice(RUN_USAGE.indexOf('Options:')));
    const named = options(section(PAGE, '## 3.'));
    for (const must of ['--until', '--max-tasks']) assert.ok(named.includes(must), `the page names ${must}`);
    for (const o of named) assert.ok(known.includes(o), `${o} is an option of run`);
    const launch = powershellBlocks(section(PAGE, '## 5.'));
    assert.equal(launch.length, 1);
    assert.match(launch[0], /^Start-Process powershell\.exe .*'-NoExit','-Command',"node '<脚本>' run '<主检出>' <选项>"$/);
    assert.ok(section(PAGE, '## 驱动还在跑的时候').includes("node '<脚本>' stop '<主检出>'"));
  });

  test('the page reads the lock file of the driver, with its three fields', () => {
    assert.ok(PAGE.includes(slash(lockFile('<主检出>'))), 'the prose names the path the driver uses');
    assert.ok(powershellBlocks(section(PAGE, '## 6.')).every((b) => b.includes(lockFile('<主检出>').split('/').join('\\'))), 'so does the PowerShell');
    assert.ok(PAGE.includes('{pid, run, started_at}'));
  });

  test('one ledger entry before the start and none after; read-only while the driver runs', () => {
    const before = section(PAGE, '## 4.');
    assert.ok(before.includes('add_log') && before.includes('最后一次写账本'));
    for (const heading of ['## 5.', '## 6.', '## 7.']) {
      const part = section(PAGE, heading);
      for (const tool of LEDGER_WRITES) assert.ok(!part.includes(tool), `${heading} names no ledger write (${tool})`);
    }
    const running = section(PAGE, '## 驱动还在跑的时候');
    for (const rule of ['只读', '不写账本', '不改工作目录', '不提交', '不做任务', '不凭印象']) assert.ok(running.includes(rule), rule);
    for (const tool of LEDGER_WRITES) assert.ok(!running.includes(tool), `the section names no ledger write (${tool})`);
  });

  test('the run guide tells how to start it from a session and points to the probe record', () => {
    const part = section(RUN_DOC, '## 在会话里说一句来起');
    assert.ok(part.includes('起长跑') && part.includes('`long-run.md`'));
    assert.ok(part.includes('run-from-session-probe.md'));
    const record = read('docs', 'run-from-session-probe.md');
    for (const heading of ['## 结论', '## 证据在哪']) assert.ok(record.includes(heading), `the probe record has ${heading}`);
  });
});

describe('the PowerShell on the page', { skip: WIN ? false : 'Windows PowerShell only' }, () => {
  test('the finder reads the kit repo from the hook config next to the SessionStart hook of a deployed layout', () => {
    const dir = tempDir();
    // A user directory with a space and with characters outside ASCII in its name.
    const home = path.join(dir, 'home 目录');
    const runtime = path.join(dir, 'rt');
    // The settings file as deploy-kit writes it: the kit fragment with its placeholders filled.
    const filled = read('config', 'claude', 'settings.fragment.json')
      .replaceAll('<node>', 'node').replaceAll('<runtime>', slash(runtime)).replaceAll('<home>', slash(home));
    const settings = JSON.parse(filled);
    // A hook of someone else's in front of the kit's, without args and with text outside ASCII: the finder must
    // pass over it, and must read the file as UTF-8.
    settings.hooks.SessionStart.unshift({ matcher: 'startup', hooks: [{ type: 'command', command: 'echo 别的钩子“带引号”' }] });
    write(path.join(home, '.claude', 'settings.json'), settings);
    write(path.join(runtime, 'hooks', 'hook-config.json'), { runtime: slash(runtime), readonly_dirs: [], kit_repo: slash(REPO) });

    const blocks = powershellBlocks(section(PAGE, '## 2.'));
    assert.equal(blocks.length, 1);
    const r = powershell(dir, 'find.ps1', blocks[0], { USERPROFILE: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), '');
    assert.ok(r.stdout.replaceAll('\\', '/').includes(`${slash(REPO)}/scripts/autoskills.mjs exists: True`), r.stdout);
  });

  test('the launch line starts a window of its own and hands the arguments over whole, spaces in paths included', async () => {
    const dir = tempDir();
    const project = path.join(dir, 'a project');
    fs.mkdirSync(project);
    const standIn = path.join(dir, 'stand in.mjs');
    const out = path.join(dir, 'started.json');
    write(standIn, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`,
      '',
    ].join('\n'));

    const line = powershellBlocks(section(PAGE, '## 5.'))[0];
    // Two differences from the page, so that the test leaves nothing on the screen: no -NoExit (the window ends with
    // the stand-in) and a hidden window.
    const script = line
      .replace('Start-Process powershell.exe', 'Start-Process powershell.exe -WindowStyle Hidden')
      .replace("'-NoExit',", '')
      .replaceAll('<主检出>', project)
      .replace('<脚本>', standIn)
      .replace('<选项>', '--until 07:00 --max-tasks 2');
    assert.ok(!script.includes('<'), script);
    const r = powershell(dir, 'launch.ps1', script);
    assert.equal(r.status, 0, r.stderr);

    for (let i = 0; i < 150 && !fs.existsSync(out); i += 1) await pause(200);
    assert.ok(fs.existsSync(out), 'the stand-in started');
    // The file is written in one call, but the read can still come first: one short wait, then parse.
    await pause(200);
    const started = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(started.argv, ['run', project, '--until', '07:00', '--max-tasks', '2']);
    const real = (p) => fs.realpathSync.native(p).toLowerCase();
    assert.equal(real(started.cwd), real(project));
  });

  test('the lock check tells a live driver from a lock whose process number was used again, a dead one and no lock', async () => {
    const dir = tempDir();
    const project = path.join(dir, 'a project');
    fs.mkdirSync(project);
    const blocks = powershellBlocks(section(PAGE, '## 6.')).map((b) => b.replaceAll('<主检出>', project));
    assert.equal(blocks.length, 2, 'the wait and the check');
    const check = (name, script = blocks[1]) => {
      const r = powershell(dir, name, script);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };

    assert.equal(check('no-lock.ps1'), 'no lock');

    // A live node process stands in for the driver. The lock is written after it started, as the driver's is.
    const standIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await pause(500);
      write(lockFile(project), { pid: standIn.pid, run: 'R1', started_at: new Date().toISOString() });
      assert.equal(readLock(project).alive, true, 'the driver reads the same file as alive');
      const began = Date.now();
      // With the lock there, the wait in front of the check ends at once.
      assert.match(check('alive.ps1', `${blocks[0]}\r\n${blocks[1]}`), /^run R1 started_at \S+ pid \d+: driver alive True$/);
      assert.ok(Date.now() - began < 15000, 'no 20 second wait when the lock is there');
      // A lock written well after the process started is still the normal case.
      write(lockFile(project), { pid: standIn.pid, run: 'R0', started_at: new Date(Date.now() + 3600000).toISOString() });
      assert.match(check('later-lock.ps1'), /driver alive True$/);
      // The same process under a lock from before it started: the driver of that lock is gone and its process
      // number went to another process.
      write(lockFile(project), { pid: standIn.pid, run: 'R0', started_at: '2020-01-01T00:00:00.000Z' });
      assert.match(check('reused.ps1'), /^run R0 .*: driver alive False$/);
    } finally {
      standIn.kill();
    }
    for (let i = 0; i < 50 && standIn.exitCode === null && standIn.signalCode === null; i += 1) await pause(100);
    write(lockFile(project), { pid: standIn.pid, run: 'R2', started_at: new Date().toISOString() });
    assert.match(check('gone.ps1'), /^run R2 .*: driver alive False$/);
  });
});
