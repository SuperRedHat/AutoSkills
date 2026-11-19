// The accept command of scripts/autoskills.mjs: reads a project's ledger and writes the tasks waiting for the owner as
// one self-contained HTML page. It starts no session, spends no tokens and writes nothing to the ledger (AS3-366).
//   acceptCommand(args, io) => exit code     args: <project dir> [--out <file>] [--help]
import fs from 'node:fs';
import path from 'node:path';
import { readLedger, awaitingAcceptance, unblockedBy, hasLedger, LedgerReadError } from '../ledger-read.mjs';
import { acceptanceDir, latestVerify, readLock, stampOf } from '../run-paths.mjs';
import { renderSheet } from './render.mjs';

const USAGE = `Usage: node scripts/autoskills.mjs accept <project dir> [--out <file>]
  Reads the ledger of the project and writes the tasks waiting for the owner's acceptance as one HTML page
  (default: <project>/.autoskills/acceptance/<stamp>.html). Prints the path. Starts no session, writes no ledger.
Options:
  --out <file>   write the page there instead
  --help         this text
Exit codes: 0 done, 1 failed (no ledger, unreadable ledger, cannot write), 2 usage error.
`;

/** Group the waiting tasks by module and order them: gates first, then most unblocked, then ledger order. */
export function arrange(items) {
  const ranked = items
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => (Number(b.task.stage_gate === true) - Number(a.task.stage_gate === true))
      || (b.unblocks.length - a.unblocks.length) || (a.index - b.index));
  const groups = new Map();
  for (const item of ranked) {
    const name = item.task.module || '(无模块)';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups].map(([module, tasks]) => ({ module, tasks }));
}

export async function acceptCommand(args, io) {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(USAGE);
    return 0;
  }
  let project = null;
  let out = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--out') {
      out = args[i + 1];
      i += 1;
      if (!out || out.startsWith('--')) {
        io.stderr.write(`autoskills accept: --out needs a file\n\n${USAGE}`);
        return 2;
      }
    } else if (a.startsWith('-')) {
      io.stderr.write(`autoskills accept: unknown option ${a}\n\n${USAGE}`);
      return 2;
    } else if (project === null) {
      project = a;
    } else {
      io.stderr.write(`autoskills accept: more than one project dir\n\n${USAGE}`);
      return 2;
    }
  }
  if (project === null) {
    io.stderr.write(`autoskills accept: no project dir\n\n${USAGE}`);
    return 2;
  }
  project = path.resolve(project);
  if (!fs.existsSync(project) || !hasLedger(project)) {
    io.stderr.write(`autoskills accept: no ledger in ${project} (expected .claude/state/tasks.json)\n`);
    return 1;
  }
  let ledger;
  try {
    ledger = readLedger(project);
  } catch (err) {
    if (err instanceof LedgerReadError) {
      io.stderr.write(`autoskills accept: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const now = new Date();
  const items = awaitingAcceptance(ledger.tasks).map((task) => ({
    task,
    unblocks: unblockedBy(ledger.tasks, task.id).map((t) => ({ id: t.id, title: t.title })),
    verify: latestVerify(project, task.id),
  }));
  const lock = readLock(project);
  const html = renderSheet({
    project: path.basename(project),
    generatedAt: now.toISOString(),
    groups: arrange(items),
    count: items.length,
    running: Boolean(lock && lock.alive),
  });
  const file = path.resolve(out ?? path.join(acceptanceDir(project), `${stampOf(now)}.html`));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html, 'utf8');
  } catch (err) {
    io.stderr.write(`autoskills accept: cannot write ${file}: ${err.message}\n`);
    return 1;
  }
  io.stdout.write(`${file}\n`);
  return 0;
}
