// The long-run driver: a fresh headless session a task, then the driver's own verification on the committed tree,
// with brakes, until a stop point. It reads the ledger (ledger-read.mjs) and writes only its own files
// (run-paths.mjs): it never changes a task's status and never accepts anything for the owner.
import fs from 'node:fs';
import path from 'node:path';
import { readLedger, readyTasks, inProgress, awaitingAcceptance, isBlocked, CLOSED, statusChangesSince } from '../ledger-read.mjs';
import {
  lockFile, stopFile, readLock, readSettings, runDir, runRecordFile, reportFile, stampOf, stopRequested, autoDir,
} from '../run-paths.mjs';
import { runSession, childEnv, sessionArgs, cliVersion } from './session.mjs';
import { verifyTask, failureText, headOf, commitsBetween } from './verify.mjs';
import { taskPrompt, multiPrompt, reworkPrompt, giveUpPrompt, resumePrompt } from './prompts.mjs';
import { renderReport } from './report.mjs';

/** Waits after the subscription's usage runs out, in minutes; the last one repeats. */
export const LIMIT_WAITS_MIN = Object.freeze([10, 20, 40, 60]);
/** Sessions in a row with no new commit and no status change before the driver stops. */
export const NO_PROGRESS_LIMIT = 3;
/** Rework rounds of one task before its rework task is marked blocked and skipped. */
export const REWORK_ROUNDS = 2;
/** Rework prompts in a row that create no rework task before the driver gives that rework up. */
const REWORK_TRIES = 2;
const FINISHED = ['done', 'awaiting_manual_acceptance'];
// Taking the lock: how often it is tried, how long a try waits, and how often a lock that does not parse is read
// again before it counts as broken.
const LOCK_TRIES = 60;
const LOCK_PAUSE_MS = 50;
const LOCK_UNREADABLE_TRIES = 5;

/** Blocks this thread for ms; the lock's short waits happen before anything else runs. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** End reasons that are normal stop points: exit 0. Every other reason is a brake or an error: exit 1. */
export const NORMAL_ENDS = Object.freeze(['all_done', 'owner', 'stop_file', 'interrupt', 'until', 'max_tasks']);
export const exitCodeOf = (reason) => (NORMAL_ENDS.includes(reason) ? 0 : 1);

const snapshotOf = (tasks) => new Map(tasks.map((t) => [t.id, t.status]));
const mentions = (text, id) => new RegExp(`(^|[^A-Za-z0-9_.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`).test(text || '');

export class Driver {
  /**
   * @param {object} opts  project, cli, model, effort, permissionMode, tasksPerSession, until (Date|null), maxTasks,
   *                       verifyTimeoutMs, idleMs
   * @param {object} io    {stdout, stderr}
   * @param {object} deps  now, sleep, baseEnv, limitWaitsMs, pollMs, accept (project, io) => exit code
   */
  constructor(opts, io, deps = {}) {
    this.o = opts;
    this.io = io;
    this.now = deps.now || (() => new Date());
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseEnv = deps.baseEnv || process.env;
    this.limitWaitsMs = deps.limitWaitsMs || LIMIT_WAITS_MIN.map((m) => m * 60000);
    this.pollMs = deps.pollMs ?? 1000;
    this.accept = deps.accept || null;
    this.interrupted = false;
    this.currentChild = null;
    this.lineages = [];
    this.skip = new Set();
    this.finished = new Set();
    this.rejectSuggested = new Map();
    this.sessions = [];
    this.waits = [];
    this.verifies = new Map();
    this.noProgress = 0;
    this.limitStreak = 0;
    this.tokens = 0;
    this.notes = [];
  }

  say(line) { this.io.stdout.write(`${line}\n`); }

  /** First Ctrl+C: end after the task in hand, like the stop file. */
  interrupt() { this.interrupted = true; }

  newRunName() {
    const base = stampOf(this.now());
    let name = base;
    for (let i = 2; fs.existsSync(runDir(this.o.project, name)); i += 1) name = `${base}-${i}`;
    return name;
  }

  /** Take the project's lock. Returns an error text when a live driver holds it. */
  lock() {
    const file = lockFile(this.o.project);
    const refuse = (held) => `another driver runs in this project (pid ${held.pid}, run ${held.run}, started ${held.started_at}); `
      + `if none does, delete ${file}`;
    fs.mkdirSync(autoDir(this.o.project), { recursive: true });
    const body = `${JSON.stringify({ pid: process.pid, run: this.run, started_at: this.startedAt }, null, 2)}\n`;
    // Exclusive create: of several drivers that create the same file, one succeeds.
    const create = (target, text) => {
      try {
        fs.writeFileSync(target, text, { flag: 'wx' });
        return true;
      } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
      }
    };
    // Two drivers must not both hold the lock.
    // - No lock: the exclusive create is the whole step.
    // - A lock is there: a live driver's is never touched.
    // - A lock left behind is replaced by one driver at a time. The takeover file is created exclusively too; only
    //   inside that section is a lock ever deleted, and only the one that was read there: a dead driver's, or a file
    //   that was there and did not parse on any of several reads (a lock is unreadable for an instant while its
    //   driver writes it). A lock that was not there at a read is not deleted, whatever appears under the name after.
    // - The takeover file is never deleted by anyone but the driver that created it: a driver that died inside the
    //   section leaves it, and a later start that cannot take over says so instead of guessing.
    // What this does not cover: a driver that stalls between creating its lock file and writing it for longer than
    // the re-reads take (LOCK_UNREADABLE_TRIES x LOCK_PAUSE_MS) can have its lock taken for a broken one.
    const takeover = `${file}.takeover`;
    let taken = false;
    for (let attempt = 0; attempt < LOCK_TRIES && !taken; attempt += 1) {
      if (create(file, body)) { taken = true; break; }
      const held = readLock(this.o.project);
      if (held && held.alive && held.pid !== process.pid) return refuse(held);
      if (!create(takeover, `${process.pid}\n`)) { pause(LOCK_PAUSE_MS); continue; }
      try {
        let again = readLock(this.o.project);
        let broken = !again && fs.existsSync(file);
        for (let i = 0; broken && i < LOCK_UNREADABLE_TRIES; i += 1) {
          pause(LOCK_PAUSE_MS);
          again = readLock(this.o.project);
          broken = !again && fs.existsSync(file);
        }
        if (again && again.alive && again.pid !== process.pid) return refuse(again);
        let note = null;
        if (again || broken) {
          fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 20 });
          note = again
            ? `接手了旧锁：pid ${again.pid} 的驱动（运行 ${again.run}，${again.started_at} 开始）已经不在了。`
            : '换掉了一个读不出来的锁文件。';
        }
        if (create(file, body)) {
          taken = true;
          if (note) this.notes.push(note);
        }
      } finally {
        fs.rmSync(takeover, { force: true });
      }
    }
    if (!taken) {
      const held = readLock(this.o.project);
      if (held && held.alive && held.pid !== process.pid) return refuse(held);
      return `could not take the lock ${file}${fs.existsSync(takeover) ? `: a driver that was replacing an old lock left ${takeover}; if no driver is starting now, delete that file` : ''}; try again`;
    }
    this.locked = true;
    // `stop` writes the stop file only while a driver runs, and the driver deletes it when it ends; one found now was
    // left by a driver that did not end normally.
    if (stopRequested(this.o.project)) {
      fs.rmSync(stopFile(this.o.project), { force: true });
      this.notes.push('删掉了上一次没收尾的驱动留下的停止文件。');
    }
    return null;
  }

  unlock() {
    if (!this.locked) return;
    const held = readLock(this.o.project);
    if (held && held.pid === process.pid && held.run === this.run) fs.rmSync(lockFile(this.o.project), { force: true });
    this.locked = false;
  }

  /** What to do next: {kind, taskId, prompt, lineage?} or {stop, detail}. */
  pick(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const lin of this.lineages) {
      if (lin.closed) continue;
      if (lin.giveUp) return { kind: 'give_up', taskId: lin.failedTask, lineage: lin, prompt: giveUpPrompt({ taskId: lin.failedTask, origin: lin.origin, failure: failureText(lin.failure) }) };
      const t = lin.task ? byId.get(lin.task) : null;
      if (!t) {
        if (lin.tries >= REWORK_TRIES) {
          lin.closed = 'no_rework_task';
          this.skip.add(lin.failedTask);
          continue;
        }
        return { kind: 'rework', taskId: lin.failedTask, lineage: lin, prompt: reworkPrompt({ failedTask: lin.failedTask, origin: lin.origin, round: lin.round, failure: failureText(lin.failure) }) };
      }
      if (isBlocked(t)) { lin.closed = 'blocked'; this.skip.add(t.id); continue; }
      if (t.status === 'todo' || t.status === 'in_progress') return { kind: 'task', taskId: t.id, lineage: lin, prompt: taskPrompt(t.id) };
    }
    const usable = (t) => !isBlocked(t) && !this.skip.has(t.id);
    const n = this.perSession();
    const named = (t, kind) => ({ kind, taskId: t.id, prompt: n > 1 ? multiPrompt(t.id, n) : taskPrompt(t.id) });
    // A task in hand: in progress, or left at auto_verified by a session that ended between that step and the next
    // one (done or awaiting acceptance). Neither is ready by the server's rule, so without this nobody would finish it.
    const going = [...inProgress(tasks), ...tasks.filter((t) => t.status === 'auto_verified')].find(usable);
    if (going) return going.status === 'auto_verified' ? { kind: 'task', taskId: going.id, prompt: resumePrompt(going.id) } : named(going, 'task');
    const ready = readyTasks(tasks, { awaitingBlocks: this.settings.awaiting_blocks_downstream }).find(usable);
    if (ready) return named(ready, 'task');
    const open = tasks.filter((t) => !CLOSED.includes(t.status));
    if (!open.length) return { stop: 'all_done', detail: '账本里的任务全部关闭了' };
    const blocked = open.filter((t) => isBlocked(t) || this.skip.has(t.id));
    const waiting = awaitingAcceptance(tasks).map((t) => t.id);
    if (!blocked.length) {
      return { stop: 'owner', detail: `只剩等负责人验收或决定的${waiting.length ? `（待验收：${waiting.join('、')}）` : ''}` };
    }
    const ids = blocked.map((t) => t.id).join('、');
    return { stop: 'blocked', detail: waiting.length ? `剩下的不是受阻就是在等验收：受阻 ${ids}；待验收 ${waiting.join('、')}` : `剩下的都受阻：${ids}` };
  }

  perSession() {
    const n = this.o.tasksPerSession || 1;
    return this.o.maxTasks ? Math.max(1, Math.min(n, this.o.maxTasks - this.finished.size)) : n;
  }

  /** A brake or a stop request that holds before the next session, or null. */
  brake() {
    if (stopRequested(this.o.project)) return { stop: 'stop_file', detail: `有停止文件 ${stopFile(this.o.project)}` };
    if (this.interrupted) return { stop: 'interrupt', detail: '收到 Ctrl+C' };
    if (this.o.until && this.now() >= this.o.until) return { stop: 'until', detail: `到了 --until ${this.o.untilText}` };
    if (this.o.maxTasks && this.finished.size >= this.o.maxTasks) return { stop: 'max_tasks', detail: `做完了 --max-tasks ${this.o.maxTasks} 个任务` };
    if (this.noProgress >= NO_PROGRESS_LIMIT) return { stop: 'no_progress', detail: `连续 ${NO_PROGRESS_LIMIT} 个会话既没有新提交、任务状态也没变` };
    return null;
  }

  async waitForLimit(pick) {
    const ms = this.limitWaitsMs[Math.min(this.limitStreak, this.limitWaitsMs.length - 1)];
    this.limitStreak += 1;
    const wait = { at: this.now().toISOString(), task: pick.taskId, minutes: Math.round(ms / 600) / 100 };
    this.waits.push(wait);
    this.say(`额度用完了：等 ${wait.minutes} 分钟再接着做 ${pick.taskId}（第 ${this.waits.length} 次等待）`);
    this.writeRecord();
    // Sleep in slices so a stop file or a Ctrl+C ends the wait.
    for (let left = ms; left > 0;) {
      if (stopRequested(this.o.project) || this.interrupted) return;
      const slice = Math.min(this.pollMs, left);
      await this.sleep(slice);
      left -= slice;
    }
  }

  async runOneSession(pick, before) {
    const n = this.sessions.length + 1;
    const tag = `${String(n).padStart(3, '0')}-${pick.taskId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const dir = path.join(runDir(this.o.project, this.run), 'sessions');
    const startedAt = this.now().toISOString();
    const headBefore = headOf(this.o.project);
    this.say(`[${startedAt}] 会话 ${n}：${pick.kind === 'task' ? '' : `${pick.kind} `}${pick.taskId}`);
    const { env } = childEnv(this.o.project, this.baseEnv);
    const args = sessionArgs({ prompt: pick.prompt, permissionMode: this.o.permissionMode, model: this.o.model, effort: this.o.effort });
    const { outcome, ms } = await runSession({
      cli: this.o.cli, args, cwd: this.o.project, env, idleMs: this.o.idleMs, pollMs: this.pollMs,
      stdoutFile: path.join(dir, `${tag}.stdout.jsonl`), stderrFile: path.join(dir, `${tag}.stderr.log`),
      onChild: (c) => { this.currentChild = c; },
    });
    this.currentChild = null;
    const headAfter = headOf(this.o.project);
    const rec = {
      n, kind: pick.kind, task: pick.taskId, prompt: pick.prompt, started_at: startedAt, ended_at: this.now().toISOString(), ms,
      exit_code: outcome.exitCode, error_kind: outcome.errorKind, session_id: outcome.sessionId,
      model: outcome.init?.model ?? null, permission_mode: outcome.init?.permission_mode ?? null,
      tokens: outcome.tokens, cost_usd: outcome.costUsd, detail: outcome.detail, skills: outcome.skills,
      tool_calls: outcome.toolCalls, ledger_calls: outcome.kitCalls,
      head_before: headBefore, head_after: headAfter, commits: commitsBetween(this.o.project, headBefore, headAfter),
      stdout: path.posix.join('.autoskills', 'runs', this.run, 'sessions', `${tag}.stdout.jsonl`),
      stderr: path.posix.join('.autoskills', 'runs', this.run, 'sessions', `${tag}.stderr.log`),
      final_tail: outcome.finalText.slice(-800),
      changes: [], new_tasks: [], verified: [],
    };
    this.sessions.push(rec);
    this.tokens += outcome.tokens.total || 0;
    return { rec, outcome, before };
  }

  /** After a session: read what changed, verify what was finished, and decide about rework. */
  async afterSession(pick, rec, beforeTasks) {
    const { tasks, logs } = readLedger(this.o.project);
    const before = snapshotOf(beforeTasks);
    const changed = new Set(statusChangesSince(logs, rec.started_at).map((c) => c.task_id));
    for (const t of tasks) if (before.get(t.id) !== t.status) changed.add(t.id);
    rec.changes = [...changed].map((id) => ({ task: id, from: before.get(id) ?? null, to: tasks.find((t) => t.id === id)?.status ?? null }));
    rec.new_tasks = tasks.filter((t) => !before.has(t.id)).map((t) => t.id);
    const progressed = rec.head_after !== rec.head_before || rec.changes.some((c) => c.from !== c.to);
    this.noProgress = progressed ? 0 : this.noProgress + 1;

    if (pick.kind === 'rework') {
      pick.lineage.tries += 1;
      const fresh = tasks.filter((t) => rec.new_tasks.includes(t.id));
      const mine = fresh.find((t) => mentions(`${t.title} ${t.description}`, pick.lineage.origin)) || fresh[0];
      if (mine) { pick.lineage.task = mine.id; pick.lineage.tasks.push(mine.id); }
    }
    if (pick.kind === 'give_up') {
      pick.lineage.closed = 'blocked';
      this.skip.add(pick.lineage.failedTask);
      return;
    }

    for (const t of tasks) {
      if (!changed.has(t.id) || !FINISHED.includes(t.status)) continue;
      this.finished.add(t.id);
      const v = await verifyTask({
        project: this.o.project, run: this.run, task: t, shell: this.settings.verify_shell, timeoutMs: this.o.verifyTimeoutMs,
        env: childEnv(this.o.project, this.baseEnv).env, now: this.now,
      });
      this.verifies.set(t.id, v);
      rec.verified.push({ task: t.id, status: t.status, passed: v.passed, clean: v.clean });
      const word = v.passed === true ? '通过' : v.passed === null ? '没复验（任务没有验证命令）' : `没过：${failureText(v)}`;
      this.say(`  ${t.id} ${t.status === 'done' ? '完成' : '待验收'}，复验${word}`);
      const lin = this.lineages.find((l) => !l.closed && l.task === t.id);
      if (v.passed !== false) {
        if (lin) lin.closed = 'passed';
        continue;
      }
      if (t.status === 'awaiting_manual_acceptance') {
        this.rejectSuggested.set(t.id, failureText(v));
        if (lin) { lin.closed = 'awaiting'; }
        continue;
      }
      if (lin && lin.round >= REWORK_ROUNDS) {
        lin.giveUp = true;
        lin.failedTask = t.id;
        lin.failure = v;
      } else if (lin) {
        lin.round += 1;
        lin.failedTask = t.id;
        lin.failure = v;
        lin.task = null;
        lin.tries = 0;
      } else if (!this.lineages.some((l) => l.tasks.includes(t.id) || l.origin === t.id)) {
        this.lineages.push({ origin: t.id, failedTask: t.id, round: 1, task: null, tasks: [], tries: 0, failure: v, closed: null, giveUp: false });
      }
    }
  }

  progressLine(tasks) {
    const done = this.finished.size;
    const open = tasks.filter((t) => !CLOSED.includes(t.status) && t.status !== 'awaiting_manual_acceptance').length;
    const avg = done ? Math.round(this.tokens / done) : null;
    return `  已用 ${this.tokens.toLocaleString('en-US')} token；做完 ${done} 个任务${avg ? `，平均每个 ${avg.toLocaleString('en-US')}` : ''}；`
      + `还有 ${open} 个没做完${avg && open ? `，按平均约还要 ${(avg * open).toLocaleString('en-US')}` : ''}`;
  }

  record() {
    return {
      run: this.run, project: this.o.project, pid: process.pid, started_at: this.startedAt, ended_at: this.endedAt || null,
      end_reason: this.endReason || null, end_detail: this.endDetail || null, exit_code: this.exitCode ?? null,
      options: {
        cli: this.o.cli, cli_version: this.cliVersion || null, model: this.o.model || null, effort: this.o.effort || null,
        permission_mode: this.o.permissionMode, tasks_per_session: this.o.tasksPerSession, until: this.o.untilText || null,
        max_tasks: this.o.maxTasks || null, verify_timeout_min: this.o.verifyTimeoutMs / 60000, idle_min: this.o.idleMs / 60000,
      },
      settings: this.settings, notes: this.notes, tokens_total: this.tokens,
      sessions: this.sessions, waits: this.waits, finished: [...this.finished],
      verifies: Object.fromEntries(this.verifies),
      rework: this.lineages.map(({ failure, ...l }) => ({ ...l, failure: failureText(failure) })),
      reject_suggested: Object.fromEntries(this.rejectSuggested),
      skipped: [...this.skip], accept: this.acceptResult || null,
    };
  }

  writeRecord() {
    const file = runRecordFile(this.o.project, this.run);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(this.record(), null, 2)}\n`);
  }

  /** The whole run. Returns the exit code. */
  async run() {
    const p = this.o.project;
    this.startedAt = this.now().toISOString();
    this.run = this.newRunName();
    try {
      this.settings = readSettings(p);
    } catch (e) {
      this.io.stderr.write(`autoskills run: ${e.message}\n`);
      return 1;
    }
    const lockError = this.lock();
    if (lockError) {
      this.io.stderr.write(`autoskills run: ${lockError}\n`);
      return 1;
    }
    this.cliVersion = cliVersion(this.o.cli);
    this.say(`autoskills run ${this.run}：项目 ${p}；命令行 ${this.o.cli}${this.cliVersion ? `（${this.cliVersion}）` : ''}；权限模式 ${this.o.permissionMode}`);
    for (const note of this.notes) this.say(`  ${note}`);
    let tasks = [];
    try {
      for (;;) {
        const b = this.brake();
        if (b) { this.end(b); break; }
        ({ tasks } = readLedger(p));
        const pick = this.pick(tasks);
        if (pick.stop) { this.end(pick); break; }
        const { rec, outcome } = await this.runOneSession(pick, tasks);
        if (this.aborted) return this.exitCode;
        if (outcome.errorKind === 'spawn') {
          this.end({ stop: 'error', detail: `起不了会话：${outcome.finalText || rec.stderr}` });
          break;
        }
        if (outcome.errorKind === 'usage_limit') {
          rec.usage_limit = true;
          await this.afterSession(pick, rec, tasks);
          this.writeRecord();
          if (pick.lineage && pick.kind === 'rework' && !pick.lineage.task) pick.lineage.tries -= 1;
          this.noProgress = 0;
          await this.waitForLimit(pick);
          continue;
        }
        this.limitStreak = 0;
        if (outcome.errorKind) this.say(`  会话没有正常结束：${outcome.errorKind}${outcome.errorKind === 'idle_timeout' ? `（${this.o.idleMs / 60000} 分钟没有输出，结束了整个进程树；下一个会话接着做）` : ''}`);
        await this.afterSession(pick, rec, tasks);
        ({ tasks } = readLedger(p));
        this.say(this.progressLine(tasks));
        this.writeRecord();
      }
    } catch (e) {
      this.end({ stop: 'error', detail: `出错：${e && e.message ? e.message : e}` });
    }
    return this.finish(tasks);
  }

  end({ stop, detail }) {
    this.endReason = stop;
    this.endDetail = detail;
    this.exitCode = exitCodeOf(stop);
    this.say(`停下：${detail}`);
  }

  /** Report, acceptance sheet, files: the same whether the run ended at a stop point or on an error. */
  async finish(tasksAtEnd) {
    let tasks = tasksAtEnd;
    try { ({ tasks } = readLedger(this.o.project)); } catch { /* keep the last read */ }
    this.endedAt = this.now().toISOString();
    if (this.accept) {
      const out = [];
      const sink = { write: (s) => { out.push(String(s)); return true; } };
      let code;
      try {
        code = await this.accept(this.o.project, { stdout: sink, stderr: sink });
      } catch (e) {
        code = null;
        out.push(String(e && e.message ? e.message : e));
      }
      const log = path.join(runDir(this.o.project, this.run), 'accept.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.writeFileSync(log, out.join(''));
      this.acceptResult = { exit_code: code, log: path.posix.join('.autoskills', 'runs', this.run, 'accept.log') };
    }
    this.writeRecord();
    const report = reportFile(this.o.project, this.run);
    fs.writeFileSync(report, renderReport(this.record(), tasks));
    if (fs.existsSync(stopFile(this.o.project))) fs.rmSync(stopFile(this.o.project), { force: true });
    this.unlock();
    this.say(`报告：${report}`);
    return this.exitCode;
  }

  /** Second Ctrl+C: the session in hand is ended at once (its whole tree), the files are written, the lock goes. */
  abortNow(killTree) {
    this.aborted = true;
    if (this.currentChild) killTree(this.currentChild.pid);
    this.end({ stop: 'interrupt_now', detail: '第二次 Ctrl+C：当前会话立即结束，改了一半的留在工作目录里' });
    this.endedAt = this.now().toISOString();
    try {
      this.writeRecord();
      let tasks = [];
      try { ({ tasks } = readLedger(this.o.project)); } catch { /* none */ }
      fs.writeFileSync(reportFile(this.o.project, this.run), renderReport(this.record(), tasks));
    } catch { /* the lock still goes */ }
    this.unlock();
    return this.exitCode;
  }
}
