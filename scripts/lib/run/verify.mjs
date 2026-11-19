// The driver's own run of a task's verification commands on the committed tree. Nothing here writes the ledger; the
// result goes to the verify file of run-paths.mjs. Zero dependencies (Node >= 18).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { verifyFile, safeName, runDir } from '../run-paths.mjs';
import { killTree } from './session.mjs';

/** Paths that do not count against a clean tree: the ledger and the commands' own folder. */
export const CLEAN_EXEMPT = Object.freeze(['.claude/state/', '.autoskills/']);

export function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, out: String(r.stdout || ''), err: String(r.stderr || r.error?.message || '') };
}

export function headOf(project) {
  const r = git(['rev-parse', 'HEAD'], project);
  return r.ok ? r.out.trim() : null;
}

/** Commits in from..to, oldest first: [{sha, subject}]. */
export function commitsBetween(project, from, to) {
  if (!to || from === to) return [];
  const r = git(['log', '--reverse', '--format=%H%x1f%s', from ? `${from}..${to}` : to], project);
  if (!r.ok) return [];
  return r.out.split(/\r?\n/).filter(Boolean).map((l) => { const [sha, subject] = l.split('\x1f'); return { sha, subject: subject || '' }; });
}

/**
 * What `git status --porcelain` lists outside the exempt paths, or null when git cannot say.
 * Renames and copies list both paths; a path counts when either is outside the exempt ones.
 */
export function dirtyFiles(project) {
  const r = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], project);
  if (!r.ok) return null;
  const parts = r.out.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    const files = [e.slice(3)];
    if (/[RC]/.test(xy)) { files.push(parts[i + 1] || ''); i += 1; }
    if (files.some((f) => f && !CLEAN_EXEMPT.some((p) => f === p.slice(0, -1) || f.startsWith(p)))) out.push(`${xy} ${files.filter(Boolean).join(' <- ')}`);
  }
  return out;
}

/**
 * Git for Windows' bash.exe, found from `git --exec-path` (<git>/mingw64/libexec/git-core, so <git>/bin/bash.exe),
 * else the first bash.exe on PATH that is not the WSL launcher (System32, WindowsApps). Elsewhere: bash.
 */
export function gitBash(env = process.env) {
  if (process.platform !== 'win32') return 'bash';
  const r = git(['--exec-path'], undefined);
  if (r.ok) {
    const root = path.resolve(r.out.trim(), '..', '..', '..');
    for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
      const file = path.join(root, ...rel);
      if (fs.existsSync(file)) return file;
    }
  }
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  for (const dir of (env[key] || '').split(path.delimiter)) {
    if (!dir || /\\(system32|windowsapps)(\\|$)/i.test(dir)) continue;
    const file = path.join(dir.replace(/^"|"$/g, ''), 'bash.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** How one verification command is started under the project's verify_shell. */
export function shellSpec(shell, command, env = process.env) {
  if (shell === 'bash') {
    const bash = gitBash(env);
    if (!bash) throw new Error('verify_shell is bash, but Git for Windows bash.exe was not found (the WSL launcher does not count)');
    return { cmd: bash, argv: ['-c', command] };
  }
  return { cmd: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-Command', command] };
}

function runOne({ spec, cwd, env, timeoutMs, logFile, command }) {
  return new Promise((resolve) => {
    const started = Date.now();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.createWriteStream(logFile);
    log.write(`$ ${command}\n`);
    let child;
    try {
      child = spawn(spec.cmd, spec.argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      log.end(`\n[driver] could not start: ${e.message}\n`, () => resolve({ exit_code: null, ms: 0, timed_out: false, error: e.message }));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.stdout.on('data', (b) => log.write(b));
    child.stderr.on('data', (b) => log.write(b));
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const tailNote = timedOut ? `\n[driver] ended after ${Math.round(timeoutMs / 1000)} s without finishing\n` : `\n[driver] exit ${code}\n`;
      log.end(tailNote, () => resolve({ exit_code: timedOut ? null : code, ms: Date.now() - started, timed_out: timedOut, error: error || null }));
    };
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code, null));
  });
}

/**
 * Verify one task: the tree must be clean, then every verification command runs in its own process in the project
 * root, in order. Writes and returns {task_id, commit, clean, passed, at, commands: [{command, exit_code, ms, log}]}
 * plus reason (why passed is false or null) and dirty (the files that made the tree unclean). log is relative to the
 * project, with forward slashes.
 */
export async function verifyTask({ project, run, task, shell, timeoutMs, env, now = () => new Date() }) {
  const at = now().toISOString();
  const commit = headOf(project);
  const dirty = dirtyFiles(project);
  const base = { task_id: task.id, commit, at };
  let rec;
  if (dirty === null) {
    rec = { ...base, clean: false, passed: false, commands: [], reason: 'git status failed', dirty: [] };
  } else if (dirty.length) {
    rec = { ...base, clean: false, passed: false, commands: [], reason: `the working tree is not clean (${dirty.length} file(s) not committed)`, dirty };
  } else if (!task.verification_commands.length) {
    rec = { ...base, clean: true, passed: null, commands: [], reason: 'the task has no verification commands' };
  } else {
    const commands = [];
    let passed = true;
    let reason = null;
    for (const [i, command] of task.verification_commands.entries()) {
      const logRel = path.posix.join('.autoskills', 'runs', run, 'tasks', `${safeName(task.id)}.verify-${i + 1}.log`);
      const logFile = path.join(runDir(project, run), 'tasks', `${safeName(task.id)}.verify-${i + 1}.log`);
      let r;
      try {
        r = await runOne({ spec: shellSpec(shell, command, env), cwd: project, env, timeoutMs, logFile, command });
      } catch (e) {
        r = { exit_code: null, ms: 0, timed_out: false, error: e.message };
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, `$ ${command}\n[driver] could not start: ${e.message}\n`);
      }
      const entry = { command, exit_code: r.exit_code, ms: r.ms, log: logRel };
      if (r.timed_out) entry.timed_out = true;
      if (r.error) entry.error = r.error;
      commands.push(entry);
      if (r.exit_code !== 0 && passed) {
        passed = false;
        reason = r.timed_out ? `command ${i + 1} did not finish in ${Math.round(timeoutMs / 60000)} min` : `command ${i + 1} exited ${r.exit_code}`;
      }
    }
    rec = { ...base, clean: true, passed, commands, ...(reason ? { reason } : {}) };
  }
  const file = verifyFile(project, run, task.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/** The first failure of a verify record, in words for a session prompt or the report (Chinese, for the owner). */
export function failureText(rec) {
  if (!rec) return '没有复验记录';
  if (!rec.clean) {
    const files = (rec.dirty || []).slice(0, 10).join('；');
    return rec.dirty?.length ? `工作目录不干净，没提交的文件：${files}${rec.dirty.length > 10 ? ` 等 ${rec.dirty.length} 个` : ''}` : `工作目录检查失败（${rec.reason}）`;
  }
  const bad = rec.commands.find((c) => c.exit_code !== 0);
  if (!bad) return '';
  const i = rec.commands.indexOf(bad) + 1;
  const how = bad.timed_out ? '超时没跑完' : bad.exit_code === null ? `没能启动（${bad.error || '未知原因'}）` : `退出码 ${bad.exit_code}`;
  return `第 ${i} 条验证命令 \`${bad.command}\` ${how}，日志在 ${bad.log}`;
}
