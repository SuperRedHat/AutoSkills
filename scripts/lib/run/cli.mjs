// The run and stop commands of scripts/autoskills.mjs (AS3-365). The two exports and their form are fixed:
//   runCommand(args, io)  => exit code     args: <project dir> [options]
//   stopCommand(args, io) => exit code     args: <project dir>
// runWith(args, io, deps) is runCommand with the driver's clock, waits and acceptance call open to tests.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasLedger } from '../ledger-read.mjs';
import { stopFile, readLock, autoDir, stopRequested } from '../run-paths.mjs';
import { resolveClaude, killTree } from './session.mjs';
import { Driver } from './driver.mjs';
import { git } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', '..', 'autoskills.mjs');

/** The values this machine's `claude --permission-mode` takes. */
export const PERMISSION_MODES = Object.freeze(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
/** auto: probe 1 and 2 of docs/windows/finish/a-probes.md (a task ran through; blocked calls come back to the session). */
export const DEFAULT_PERMISSION_MODE = 'auto';

export const RUN_USAGE = `Usage: node scripts/autoskills.mjs run <project dir> [options]

The long-run driver: a fresh headless session (claude -p) a task, then the task's verification commands again on the
committed tree, until a stop point. It reads the ledger and never writes it; it never accepts a task for the owner.

Options:
  --model <m>               passed to every session as it is (default: not passed)
  --effort <e>              passed to every session as it is (default: not passed)
  --permission-mode <m>     ${PERMISSION_MODES.join(', ')} (default: ${DEFAULT_PERMISSION_MODE})
  --tasks-per-session <n>   tasks a session may do (default: 1)
  --until <HH:MM>           local time; no new task after it (default: off)
  --max-tasks <n>           no new task after n tasks are done or awaiting acceptance (default: off)
  --verify-timeout-min <n>  a verification command is ended after n minutes (default: 30)
  --idle-min <n>            a session with no output for n minutes is ended, with its process tree (default: 30)
  --cli <file>              the claude executable, or a .mjs stand-in (default: CLAUDE_EXE, else claude on PATH)
  --help                    this text

Stop it: node scripts/autoskills.mjs stop <project dir> (after the task in hand), or Ctrl+C once (the same),
twice (at once: the session in hand ends, its half-done changes stay in the working tree).
Report: <project>/.autoskills/runs/<run>/report.md. Settings: <project>/.autoskills/run.json.
Exit codes: 0 a normal stop point (all done, only the owner's part left, stop file or Ctrl+C, --until, --max-tasks);
1 a brake (no progress, the rest blocked) or an error; 2 usage error.
`;

export const STOP_USAGE = `Usage: node scripts/autoskills.mjs stop <project dir>

Ask the driver that runs in the project to end after the task in hand (it writes <project>/.autoskills/run.stop;
the driver deletes it when it ends). Exit codes: 0 asked, 1 no driver runs there, 2 usage error.
`;

const OPTIONS = {
  model: { type: 'string' }, effort: { type: 'string' }, 'permission-mode': { type: 'string' },
  'tasks-per-session': { type: 'string' }, until: { type: 'string' }, 'max-tasks': { type: 'string' },
  'verify-timeout-min': { type: 'string' }, 'idle-min': { type: 'string' }, cli: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

function positiveInt(v, name) {
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`${name} must be a whole number of 1 or more`);
  return Number(v);
}
function positiveMinutes(v, name) {
  const n = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !(n > 0)) throw new UsageError(`${name} must be a number of minutes above 0`);
  return n;
}

/** The next local time HH:MM after `from` (today, or tomorrow when it has passed). */
export function untilDate(text, from = new Date()) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) throw new UsageError('--until must be HH:MM (local time, 24 hours)');
  const d = new Date(from);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  return d;
}

/** The options of `run`, checked. Throws UsageError. */
export function parseRun(args, now = new Date()) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) return { help: true };
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'one project dir only' : 'the project dir is missing');
  const permissionMode = v['permission-mode'] ?? DEFAULT_PERMISSION_MODE;
  if (!PERMISSION_MODES.includes(permissionMode)) throw new UsageError(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')}`);
  for (const k of ['model', 'effort', 'cli']) if (v[k] !== undefined && !v[k].trim()) throw new UsageError(`--${k} is empty`);
  return {
    project: path.resolve(positionals[0]),
    model: v.model, effort: v.effort, permissionMode,
    tasksPerSession: v['tasks-per-session'] !== undefined ? positiveInt(v['tasks-per-session'], '--tasks-per-session') : 1,
    until: v.until !== undefined ? untilDate(v.until, now) : null, untilText: v.until ?? null,
    maxTasks: v['max-tasks'] !== undefined ? positiveInt(v['max-tasks'], '--max-tasks') : null,
    verifyTimeoutMs: (v['verify-timeout-min'] !== undefined ? positiveMinutes(v['verify-timeout-min'], '--verify-timeout-min') : 30) * 60000,
    idleMs: (v['idle-min'] !== undefined ? positiveMinutes(v['idle-min'], '--idle-min') : 30) * 60000,
    cli: v.cli,
  };
}

/** The accept command, found through the entry's COMMANDS. */
export async function acceptViaEntry(project, io) {
  const { COMMANDS } = await import(pathToFileURL(ENTRY).href);
  const c = COMMANDS.accept;
  const mod = await import(pathToFileURL(path.join(path.dirname(ENTRY), c.module)).href);
  return mod[c.fn]([project], io);
}

/** Checks of the project before the driver starts: an error text, or null. */
export function projectProblem(project) {
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return `${project} is not a folder`;
  const top = git(['rev-parse', '--show-toplevel'], project);
  if (!top.ok) return `${project} is not in a git repository`;
  const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  if (real(top.out.trim()) !== real(project)) return `${project} is not the root of its repository (${top.out.trim()})`;
  if (!hasLedger(project)) return `${project} has no ledger (.claude/state/tasks.json)`;
  return null;
}

export async function runWith(args, io, deps = {}) {
  let opts;
  try {
    opts = parseRun(args, deps.now ? deps.now() : new Date());
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr.write(`autoskills run: ${e.message}\n\n${RUN_USAGE}`);
    return 2;
  }
  if (opts.help) {
    io.stdout.write(RUN_USAGE);
    return 0;
  }
  const problem = projectProblem(opts.project);
  if (problem) {
    io.stderr.write(`autoskills run: ${problem}\n`);
    return 1;
  }
  opts.cli = resolveClaude(opts.cli, deps.baseEnv || process.env);
  if (!opts.cli) {
    io.stderr.write('autoskills run: cannot find claude; pass --cli <file> or set CLAUDE_EXE\n');
    return 1;
  }
  const driver = new Driver(opts, io, { ...deps, accept: deps.accept || acceptViaEntry });
  if (!deps.signals) return driver.run();
  // Ctrl+C: the session runs in a console of its own and does not get it (a-probes.md, probe 3). The first one ends
  // the run after the task in hand; the second ends the session in hand at once.
  let count = 0;
  const onSigint = () => {
    count += 1;
    if (count === 1) {
      driver.interrupt();
      io.stderr.write('\nCtrl+C：做完当前任务后停（再按一次立即停，改了一半的留在工作目录里）\n');
      return;
    }
    process.exit(driver.abortNow(killTree));
  };
  process.on('SIGINT', onSigint);
  try {
    return await driver.run();
  } finally {
    process.off('SIGINT', onSigint);
  }
}

export async function runCommand(args, io) {
  return runWith(args, io, { signals: true });
}

export async function stopCommand(args, io) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr.write(`autoskills stop: ${e.message}\n\n${STOP_USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout.write(STOP_USAGE);
    return 0;
  }
  if (parsed.positionals.length !== 1) {
    io.stderr.write(`autoskills stop: ${parsed.positionals.length ? 'one project dir only' : 'the project dir is missing'}\n\n${STOP_USAGE}`);
    return 2;
  }
  const project = path.resolve(parsed.positionals[0]);
  const lock = readLock(project);
  if (!lock || !lock.alive) {
    io.stderr.write(`autoskills stop: no driver runs in ${project}${lock ? ` (the lock names pid ${lock.pid}, which is gone)` : ''}; nothing written\n`);
    return 1;
  }
  if (!stopRequested(project)) {
    fs.mkdirSync(autoDir(project), { recursive: true });
    fs.writeFileSync(stopFile(project), `${JSON.stringify({ at: new Date().toISOString(), by: process.pid }, null, 2)}\n`);
  }
  io.stdout.write(`asked the driver (pid ${lock.pid}, run ${lock.run}) to stop after the task in hand: ${stopFile(project)}\n`);
  return 0;
}
