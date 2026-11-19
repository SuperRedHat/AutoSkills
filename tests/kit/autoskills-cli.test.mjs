// Tests for the entry scripts/autoskills.mjs and for scripts/lib/run-paths.mjs (node:test, zero dependencies).
// The entry only finds a command; the commands have their own test files (autoskills-run, autoskills-accept).
// Projects are empty OS temp dirs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, usage, COMMANDS } from '../../scripts/autoskills.mjs';
import {
  safeName, stampOf, readSettings, DEFAULT_SETTINGS, settingsFile, lockFile, stopFile, readLock, stopRequested,
  latestVerify, verifyFile, autoDir, pidAlive,
} from '../../scripts/lib/run-paths.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(REPO, 'scripts', 'autoskills.mjs');
const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', windowsHide: true });

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoskills-cli-'));
  temps.push(dir);
  return dir;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
const sink = () => {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
};

describe('the entry', () => {
  test('help lists every command and exits 0', () => {
    for (const flag of ['help', '--help', '-h']) {
      const r = run(flag);
      assert.equal(r.status, 0, flag);
      for (const name of [...Object.keys(COMMANDS), 'help']) assert.match(r.stdout, new RegExp(`^  ${name}\\s`, 'm'), `${flag}: ${name}`);
    }
    assert.deepEqual(Object.keys(COMMANDS), ['run', 'stop', 'accept']);
  });

  test('no command and an unknown command are usage errors: exit 2, the usage on stderr', () => {
    const none = run();
    assert.equal(none.status, 2);
    assert.equal(none.stderr, usage());
    const unknown = run('frobnicate');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /no command "frobnicate"/);
    assert.equal(unknown.stdout, '');
  });

  test('help <command> hands --help to the command, which exits 0', () => {
    for (const name of Object.keys(COMMANDS)) {
      const r = run('help', name);
      assert.equal(r.status, 0, name);
      assert.match(r.stdout, new RegExp(`autoskills\\.mjs ${name}\\b`), name);
    }
  });

  test('main is callable in the process with its own output', async () => {
    const io = { stdout: sink(), stderr: sink() };
    assert.equal(await main(['help'], io), 0);
    assert.equal(io.stdout.text(), usage());
    assert.equal(await main([], io), 2);
    assert.equal(io.stderr.text(), usage());
  });
});

describe('the files a project keeps for the commands', () => {
  test('a task id becomes a safe file name; a stamp has no colon', () => {
    assert.equal(safeName('AS3-365'), 'AS3-365');
    assert.equal(safeName('T3.2a'), 'T3.2a');
    assert.equal(safeName('a/b\\c:d e'), 'a_b_c_d_e');
    assert.equal(stampOf(new Date('2026-11-19T02:30:05.123Z')), '2026-11-19T02-30-05Z');
  });

  test('settings: the defaults without a file, the file over the defaults', () => {
    const dir = project();
    assert.deepEqual(readSettings(dir), { ...DEFAULT_SETTINGS });
    assert.deepEqual(DEFAULT_SETTINGS, { verify_shell: 'powershell', awaiting_blocks_downstream: true });
    write(settingsFile(dir), { verify_shell: 'bash' });
    assert.deepEqual(readSettings(dir), { verify_shell: 'bash', awaiting_blocks_downstream: true });
    write(settingsFile(dir), { awaiting_blocks_downstream: false, other: 1 });
    assert.deepEqual(readSettings(dir), { verify_shell: 'powershell', awaiting_blocks_downstream: false });
  });

  test('settings: a value that is not allowed is an error, not a default', () => {
    const dir = project();
    write(settingsFile(dir), { verify_shell: 'zsh' });
    assert.throws(() => readSettings(dir), /verify_shell must be one of powershell, bash/);
    write(settingsFile(dir), { awaiting_blocks_downstream: 'no' });
    assert.throws(() => readSettings(dir), /awaiting_blocks_downstream must be true or false/);
    write(settingsFile(dir), '[1]');
    assert.throws(() => readSettings(dir), /not a JSON object/);
    write(settingsFile(dir), '{ broken');
    assert.throws(() => readSettings(dir), /not a JSON object/);
  });

  test('the lock: none, a live driver, a dead one', () => {
    const dir = project();
    assert.equal(readLock(dir), null);
    write(lockFile(dir), { pid: process.pid, run: 'r1', started_at: '2026-11-19T02:30:05Z' });
    assert.deepEqual(readLock(dir), { pid: process.pid, run: 'r1', started_at: '2026-11-19T02:30:05Z', alive: true });
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    const deadPid = Number(gone.stdout);
    assert.equal(pidAlive(deadPid), false);
    write(lockFile(dir), { pid: deadPid, run: 'r0', started_at: '2026-11-19T01:00:00Z' });
    assert.equal(readLock(dir).alive, false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive('12'), false);
  });

  test('a stop request is the stop file', () => {
    const dir = project();
    assert.equal(stopRequested(dir), false);
    write(stopFile(dir), '');
    assert.equal(stopRequested(dir), true);
    assert.equal(path.dirname(stopFile(dir)), autoDir(dir));
  });

  test('latestVerify takes the newest record of a task over all runs', () => {
    const dir = project();
    assert.equal(latestVerify(dir, 'T1'), null);
    write(verifyFile(dir, 'run-a', 'T1'), { task_id: 'T1', commit: 'aaa', clean: true, passed: false, at: '2026-11-19T01:00:00Z', commands: [] });
    write(verifyFile(dir, 'run-b', 'T1'), { task_id: 'T1', commit: 'bbb', clean: true, passed: true, at: '2026-11-19T02:00:00Z', commands: [] });
    write(verifyFile(dir, 'run-b', 'T2'), { task_id: 'T2', commit: 'bbb', clean: true, passed: true, at: '2026-11-19T03:00:00Z', commands: [] });
    write(verifyFile(dir, 'run-c', 'T1'), '{ broken');
    const got = latestVerify(dir, 'T1');
    assert.equal(got.commit, 'bbb');
    assert.equal(got.passed, true);
    assert.equal(got.run, 'run-b');
    assert.equal(latestVerify(dir, 'T9'), null);
  });
});
