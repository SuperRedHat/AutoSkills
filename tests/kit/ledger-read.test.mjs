// Tests for scripts/lib/ledger-read.mjs (node:test, zero dependencies). Every ledger is synthetic and lives in an OS
// temp dir; nothing here reads the state of a real project. The rules under test are the server's own
// (mcp/project-manager/src/state.ts: normalizeTask, getNextTask, requiresManualAcceptance), so a change there has
// to show up here.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readLedger, normalizeTask, readyTasks, nextReady, inProgress, awaitingAcceptance, dependentsOf, unblockedBy,
  statusChangesSince, isBlocked, requiresManualAcceptance, hasLedger, stateDir, LedgerReadError,
} from '../../scripts/lib/ledger-read.mjs';

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function projectWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-read-'));
  temps.push(dir);
  fs.mkdirSync(stateDir(dir), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(stateDir(dir), name), text);
  return dir;
}
const ledger = (tasks, logs) => projectWith({
  'tasks.json': JSON.stringify({ tasks }, null, 2),
  ...(logs ? { 'logs.json': JSON.stringify({ logs }, null, 2) } : {}),
});
const T = (id, extra = {}) => ({
  id, title: `task ${id}`, description: '', dependencies: [], complexity: 'S', acceptance_criteria: [], files: [],
  module: 'm', needs_manual_review: false, status: 'todo', created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z', commit_hash: '', notes: '', ...extra,
});
const ids = (tasks) => tasks.map((t) => t.id);
const norm = (tasks) => tasks.map(normalizeTask);

describe('reading the state files', () => {
  test('a task gets the defaults the server applies on read', () => {
    const raw = { id: 'A', title: 'a', status: 'todo', needs_manual_review: true };
    const t = normalizeTask(raw);
    assert.equal(t.acceptance_mode, 'manual');
    assert.equal(t.needs_manual_review, true);
    assert.deepEqual(t.verification_commands, []);
    assert.deepEqual(t.review_checklist, []);
    assert.equal(t.stage_gate, false);
    assert.equal(t.replacement_task_id, null);
    assert.equal(t.priority, 0);
    assert.deepEqual(t.dependencies, []);
    assert.equal(t.notes, '');
  });

  test('needs_manual_review follows the mode when it is not a boolean; a mode that is there is kept', () => {
    assert.equal(normalizeTask({ id: 'A', acceptance_mode: 'milestone_manual' }).needs_manual_review, true);
    assert.equal(normalizeTask({ id: 'A', acceptance_mode: 'auto' }).needs_manual_review, false);
    assert.equal(normalizeTask({ id: 'A' }).acceptance_mode, 'auto');
    assert.equal(normalizeTask({ id: 'A', acceptance_mode: 'auto', needs_manual_review: true }).acceptance_mode, 'auto');
    assert.equal(normalizeTask({ id: 'A', priority: 7 }).priority, 7);
    assert.equal(normalizeTask({ id: 'A', priority: '7' }).priority, 0);
  });

  test('tasks come back in file order with defaults; a missing logs.json is an empty list', () => {
    const dir = ledger([T('A'), { id: 'B', title: 'b', status: 'done' }]);
    assert.equal(hasLedger(dir), true);
    const { tasks, logs } = readLedger(dir);
    assert.deepEqual(ids(tasks), ['A', 'B']);
    assert.deepEqual(tasks[1].dependencies, []);
    assert.deepEqual(logs, []);
  });

  test('a byte order mark in front of the JSON is tolerated', () => {
    const dir = projectWith({ 'tasks.json': `${String.fromCharCode(0xfeff)}${JSON.stringify({ tasks: [T('A')] })}` });
    assert.deepEqual(ids(readLedger(dir).tasks), ['A']);
  });

  test('no ledger, a wrong top level and broken JSON are three different errors', () => {
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-read-'));
    temps.push(none);
    assert.equal(hasLedger(none), false);
    assert.throws(() => readLedger(none), (err) => err instanceof LedgerReadError && err.code === 'no_ledger');
    assert.throws(() => readLedger(projectWith({ 'tasks.json': '[]' })), (err) => err.code === 'state_file_corrupt');
    assert.throws(() => readLedger(projectWith({ 'tasks.json': '{"tasks": [' })), (err) => err.code === 'state_file_unreadable');
  });
});

describe('which task is ready', () => {
  test('a todo task is ready when every dependency is done', () => {
    const tasks = norm([T('A', { status: 'done' }), T('B', { dependencies: ['A'] }), T('C', { dependencies: ['A', 'B'] })]);
    assert.deepEqual(ids(readyTasks(tasks)), ['B']);
  });

  test('a dependency in any other state holds the task back', () => {
    for (const status of ['todo', 'in_progress', 'auto_verified', 'awaiting_manual_acceptance', 'cancelled']) {
      const tasks = norm([T('A', { status }), T('B', { dependencies: ['A'] })]);
      assert.equal(readyTasks(tasks).some((t) => t.id === 'B'), false, status);
    }
    assert.deepEqual(readyTasks(norm([T('B', { dependencies: ['gone'] })])), []);
  });

  test('a superseded dependency is followed along its replacement to a done task', () => {
    const chain = (lastStatus) => norm([
      T('A', { status: 'superseded', replacement_task_id: 'A2' }),
      T('A2', { status: 'superseded', replacement_task_id: 'A3' }),
      T('A3', { status: lastStatus }),
      T('B', { dependencies: ['A'] }),
    ]);
    assert.deepEqual(ids(readyTasks(chain('done'))), ['B']);
    assert.equal(readyTasks(chain('in_progress')).some((t) => t.id === 'B'), false);
    assert.equal(readyTasks(chain('cancelled')).some((t) => t.id === 'B'), false);
  });

  test('a superseded dependency without a replacement, and a replacement chain that loops, hold the task back', () => {
    assert.deepEqual(readyTasks(norm([T('A', { status: 'superseded' }), T('B', { dependencies: ['A'] })])), []);
    const loop = norm([
      T('A', { status: 'superseded', replacement_task_id: 'A2' }),
      T('A2', { status: 'superseded', replacement_task_id: 'A' }),
      T('B', { dependencies: ['A'] }),
    ]);
    assert.deepEqual(readyTasks(loop), []);
  });

  test('the highest priority first, ties in creation order; tasks in progress are never handed out', () => {
    const tasks = norm([T('A'), T('B', { priority: 5 }), T('C', { priority: 5 }), T('D', { status: 'in_progress', priority: 9 })]);
    assert.deepEqual(ids(readyTasks(tasks)), ['B', 'C', 'A']);
    assert.equal(nextReady(tasks).id, 'B');
    assert.deepEqual(ids(inProgress(tasks)), ['D']);
    assert.equal(nextReady(norm([T('A', { status: 'done' })])), null);
  });

  test('awaitingBlocks: false lets a task past a dependency awaiting acceptance, but not past a stage gate', () => {
    const tasks = norm([
      T('A', { status: 'awaiting_manual_acceptance', acceptance_mode: 'manual' }),
      T('G', { status: 'awaiting_manual_acceptance', acceptance_mode: 'milestone_manual', stage_gate: true }),
      T('B', { dependencies: ['A'] }),
      T('C', { dependencies: ['G'] }),
    ]);
    assert.deepEqual(ids(readyTasks(tasks)), []);
    assert.deepEqual(ids(readyTasks(tasks, { awaitingBlocks: false })), ['B']);
    assert.deepEqual(ids(awaitingAcceptance(tasks)), ['A', 'G']);
  });
});

describe('what the other commands ask of a ledger', () => {
  test('a task is blocked when its notes hold the mark of project-next', () => {
    assert.equal(isBlocked(normalizeTask(T('A', { notes: '假设：x\n受阻：等上游的接口' }))), true);
    assert.equal(isBlocked(normalizeTask(T('A', { notes: '受阻: waiting' }))), true);
    assert.equal(isBlocked(normalizeTask(T('A', { notes: '没有受阻' }))), false);
    assert.equal(isBlocked(normalizeTask({ id: 'A' })), false);
  });

  test('manual acceptance: manual always, milestone_manual only as a stage gate, auto never', () => {
    const need = (extra) => requiresManualAcceptance(normalizeTask(T('A', extra)));
    assert.equal(need({ acceptance_mode: 'manual' }), true);
    assert.equal(need({ acceptance_mode: 'milestone_manual', stage_gate: true }), true);
    assert.equal(need({ acceptance_mode: 'milestone_manual', stage_gate: false }), false);
    assert.equal(need({ acceptance_mode: 'auto', stage_gate: true }), false);
  });

  test('unblockedBy names the tasks that become ready once the task is done', () => {
    const tasks = norm([
      T('A', { status: 'awaiting_manual_acceptance', acceptance_mode: 'manual' }),
      T('C', { status: 'done' }),
      T('E'),
      T('B', { dependencies: ['A', 'C'] }),
      T('D', { dependencies: ['A', 'E'] }),
    ]);
    assert.deepEqual(ids(unblockedBy(tasks, 'A')), ['B']);
    assert.deepEqual(ids(unblockedBy(tasks, 'C')), []);
  });

  test('dependentsOf lists the open tasks that name the task, closed ones left out', () => {
    const tasks = norm([T('A'), T('B', { dependencies: ['A'] }), T('C', { dependencies: ['A'], status: 'cancelled' }), T('D', { dependencies: ['A'], status: 'in_progress' })]);
    assert.deepEqual(ids(dependentsOf(tasks, 'A')), ['B', 'D']);
  });

  test('statusChangesSince keeps the status changes at or after the time, oldest first', () => {
    const log = (timestamp, extra) => ({ timestamp, type: 'task_status_change', task_id: 'A', from_status: 'todo', to_status: 'in_progress', message: '', ...extra });
    const dir = ledger([T('A')], [
      log('2026-11-19T01:00:00.000Z'),
      log('2026-11-19T02:00:00.000Z', { from_status: 'in_progress', to_status: 'auto_verified' }),
      log('2026-11-19T02:30:00.000Z', { type: 'note', task_id: 'A' }),
      log('2026-11-19T03:00:00.000Z', { task_id: null }),
    ]);
    const changes = statusChangesSince(readLedger(dir).logs, '2026-11-19T02:00:00.000Z');
    assert.deepEqual(changes, [{ task_id: 'A', from: 'in_progress', to: 'auto_verified', at: '2026-11-19T02:00:00.000Z' }]);
  });
});
