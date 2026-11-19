// run-paths: where the autoskills commands keep their own files inside a project, and the form of each. The driver
// (run, stop) and the acceptance sheet (accept) meet only through these files, so both use these helpers and no path
// of their own. Zero dependencies (Node >= 18).
//
//   <project>/.autoskills/run.lock             {pid, run, started_at}: one driver a project
//   <project>/.autoskills/run.stop             a stop request: the driver ends after the task in hand
//   <project>/.autoskills/run.json             the project's settings, all optional:
//                                              {verify_shell: "powershell" | "bash", awaiting_blocks_downstream: true | false}
//   <project>/.autoskills/runs/<run>/run.json  the driver's record of one run
//   <project>/.autoskills/runs/<run>/report.md
//   <project>/.autoskills/runs/<run>/tasks/<task>.verify.json
//        the driver's own run of a task's verification commands on the committed tree:
//        {task_id, commit, clean, passed, at, commands: [{command, exit_code, ms, log}]}
//   <project>/.autoskills/acceptance/<stamp>.html   an acceptance sheet
import fs from 'node:fs';
import path from 'node:path';

export const AUTO_REL = '.autoskills';
export const VERIFY_SHELLS = Object.freeze(['powershell', 'bash']);
export const DEFAULT_SETTINGS = Object.freeze({ verify_shell: 'powershell', awaiting_blocks_downstream: true });

export const autoDir = (project) => path.join(project, AUTO_REL);
export const lockFile = (project) => path.join(autoDir(project), 'run.lock');
export const stopFile = (project) => path.join(autoDir(project), 'run.stop');
export const settingsFile = (project) => path.join(autoDir(project), 'run.json');
export const runsDir = (project) => path.join(autoDir(project), 'runs');
export const runDir = (project, run) => path.join(runsDir(project), run);
export const runRecordFile = (project, run) => path.join(runDir(project, run), 'run.json');
export const reportFile = (project, run) => path.join(runDir(project, run), 'report.md');
export const acceptanceDir = (project) => path.join(autoDir(project), 'acceptance');

/** A task id as a file name: anything outside letters, digits, dot, dash and underscore becomes an underscore. */
export const safeName = (taskId) => String(taskId).replace(/[^A-Za-z0-9._-]/g, '_');
export const verifyFile = (project, run, taskId) => path.join(runDir(project, run), 'tasks', `${safeName(taskId)}.verify.json`);

/** A name for a run or a sheet from a time: 2026-11-19T02-30-05Z. */
export const stampOf = (date = new Date()) => date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

const BOM = String.fromCharCode(0xfeff);
const stripBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text);

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return fallback;
  }
}

/** The project's settings over the defaults. A value that is not allowed is an error, not a silent default. */
export function readSettings(project) {
  const file = settingsFile(project);
  if (!fs.existsSync(file)) return { ...DEFAULT_SETTINGS };
  const raw = readJsonOr(file, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: not a JSON object`);
  const out = { ...DEFAULT_SETTINGS };
  if (raw.verify_shell !== undefined) {
    if (!VERIFY_SHELLS.includes(raw.verify_shell)) throw new Error(`${file}: verify_shell must be one of ${VERIFY_SHELLS.join(', ')}`);
    out.verify_shell = raw.verify_shell;
  }
  if (raw.awaiting_blocks_downstream !== undefined) {
    if (typeof raw.awaiting_blocks_downstream !== 'boolean') throw new Error(`${file}: awaiting_blocks_downstream must be true or false`);
    out.awaiting_blocks_downstream = raw.awaiting_blocks_downstream;
  }
  return out;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The lock of a project: null without one, else {pid, run, started_at, alive}. */
export function readLock(project) {
  const lock = readJsonOr(lockFile(project), null);
  if (!lock || typeof lock !== 'object') return null;
  return { pid: lock.pid ?? null, run: lock.run ?? null, started_at: lock.started_at ?? null, alive: pidAlive(lock.pid) };
}

export const stopRequested = (project) => fs.existsSync(stopFile(project));

/** The newest record of the driver's own verification of a task over all runs, or null. */
export function latestVerify(project, taskId) {
  const root = runsDir(project);
  if (!fs.existsSync(root)) return null;
  let best = null;
  for (const run of fs.readdirSync(root)) {
    const rec = readJsonOr(verifyFile(project, run, taskId), null);
    if (!rec || typeof rec !== 'object') continue;
    if (!best || Date.parse(rec.at) > Date.parse(best.at)) best = { ...rec, run };
  }
  return best;
}
