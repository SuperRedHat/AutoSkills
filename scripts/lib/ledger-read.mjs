// ledger-read: a read-only view of the project-manager 1.5.1 state files of a project, for the autoskills commands
// (run, accept). Zero dependencies (Node >= 18). Nothing here writes: a ledger has one writer at a time, and that is
// the server process of a session.
//
// The rules mirror mcp/project-manager/src/state.ts:
//   normalizeTask              the defaults the server applies when it reads a task
//   getNextTask                a task is ready when it is todo and every dependency is done; a superseded dependency
//                              is followed along its replacement; the highest priority first, ties in creation order
//   requiresManualAcceptance   manual always, milestone_manual only as a stage gate
// One rule is not the server's: the project contract may say that a task awaiting acceptance does not hold its
// dependents back (skills/project-next/SKILL.md); awaitingBlocks: false reads the ledger that way, stage gates excepted.
import fs from 'node:fs';
import path from 'node:path';

export const STATE_REL = path.join('.claude', 'state');
/** How project-next marks a task it cannot go on with: a note that holds one of these. */
export const BLOCKED_MARKS = Object.freeze(['受阻：', '受阻:']);
export const CLOSED = Object.freeze(['done', 'cancelled', 'superseded']);

export const stateDir = (projectDir) => path.join(projectDir, STATE_REL);
export const hasLedger = (projectDir) => fs.existsSync(path.join(stateDir(projectDir), 'tasks.json'));

export class LedgerReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerReadError';
    this.code = code;
  }
}

// A byte order mark in front of the JSON is dropped (some editors write one).
const BOM = String.fromCharCode(0xfeff);
const stripBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text);

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The server writes a file as tmp + rename, so a reader sees the old file or the new one. A read can still fail
// for a moment on Windows while the rename is under way; a few tries cover that.
function readJson(file, { attempts = 5, waitMs = 40 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err.code === 'ENOENT') throw new LedgerReadError('no_ledger', `${file} is not there`);
      last = err;
      if (i + 1 < attempts) pause(waitMs);
    }
  }
  throw new LedgerReadError('state_file_unreadable', `${file}: ${last.message}`);
}

export function normalizeTask(task) {
  const mode = task.acceptance_mode || (task.needs_manual_review ? 'manual' : 'auto');
  return {
    ...task,
    needs_manual_review: typeof task.needs_manual_review === 'boolean' ? task.needs_manual_review : mode !== 'auto',
    acceptance_mode: mode,
    verification_commands: task.verification_commands || [],
    review_checklist: task.review_checklist || [],
    stage_gate: task.stage_gate || false,
    replacement_task_id: task.replacement_task_id ?? null,
    priority: typeof task.priority === 'number' ? task.priority : 0,
    // The server keeps these two as they are; a reader of raw files is safer with a list and a string.
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    notes: typeof task.notes === 'string' ? task.notes : '',
  };
}

/** The ledger of a project: {tasks, logs}, tasks in creation order with the server's defaults. */
export function readLedger(projectDir) {
  const dir = stateDir(projectDir);
  const data = readJson(path.join(dir, 'tasks.json'));
  if (!data || !Array.isArray(data.tasks)) throw new LedgerReadError('state_file_corrupt', 'tasks.json: the top level must be { tasks: [...] }');
  let logs = [];
  const logsFile = path.join(dir, 'logs.json');
  if (fs.existsSync(logsFile)) {
    const l = readJson(logsFile);
    if (l && Array.isArray(l.logs)) logs = l.logs;
  }
  return { tasks: data.tasks.map(normalizeTask), logs };
}

export const requiresManualAcceptance = (task) => task.acceptance_mode === 'manual'
  || (task.acceptance_mode === 'milestone_manual' && task.stage_gate === true);

export const isBlocked = (task) => BLOCKED_MARKS.some((mark) => (task.notes || '').includes(mark));

const indexById = (tasks) => new Map(tasks.map((t) => [t.id, t]));

export function dependencySatisfied(byId, depId, { awaitingBlocks = true } = {}) {
  const seen = new Set();
  let cur = depId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const dep = byId.get(cur);
    if (!dep) return false;
    if (dep.status === 'done') return true;
    if (dep.status === 'superseded' && dep.replacement_task_id) {
      cur = dep.replacement_task_id;
      continue;
    }
    return !awaitingBlocks && dep.status === 'awaiting_manual_acceptance' && !dep.stage_gate;
  }
  return false;
}

/** The ready tasks, the one the server would hand out first. */
export function readyTasks(tasks, opts = {}) {
  const byId = indexById(tasks);
  return tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === 'todo' && task.dependencies.every((d) => dependencySatisfied(byId, d, opts)))
    .sort((a, b) => (b.task.priority - a.task.priority) || (a.index - b.index))
    .map(({ task }) => task);
}

export const nextReady = (tasks, opts = {}) => readyTasks(tasks, opts)[0] ?? null;
export const inProgress = (tasks) => tasks.filter((t) => t.status === 'in_progress');
export const awaitingAcceptance = (tasks) => tasks.filter((t) => t.status === 'awaiting_manual_acceptance');
/** Open tasks that name `id` among their dependencies. */
export const dependentsOf = (tasks, id) => tasks.filter((t) => !CLOSED.includes(t.status) && t.dependencies.includes(id));

/** The todo tasks that become ready once `id` is done (and are not ready now). */
export function unblockedBy(tasks, id, opts = {}) {
  const now = new Set(readyTasks(tasks, opts).map((t) => t.id));
  const after = readyTasks(tasks.map((t) => (t.id === id ? { ...t, status: 'done' } : t)), opts);
  return after.filter((t) => !now.has(t.id));
}

/** The status changes the server logged at or after `since` (an ISO time), oldest first. */
export function statusChangesSince(logs, since) {
  const from = Date.parse(since);
  return logs
    .filter((l) => l && l.type === 'task_status_change' && l.task_id && Date.parse(l.timestamp) >= from)
    .map((l) => ({ task_id: l.task_id, from: l.from_status ?? null, to: l.to_status ?? null, at: l.timestamp }));
}
