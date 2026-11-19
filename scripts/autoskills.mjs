#!/usr/bin/env node
// autoskills: the commands of the kit that run outside a session. Zero dependencies (Node >= 18).
//
//   node scripts/autoskills.mjs run <project dir> [options]     the long-run driver: a fresh headless session a task,
//                                                               then the task's verification commands on the commit
//   node scripts/autoskills.mjs stop <project dir>              ask a running driver to end after the task in hand
//   node scripts/autoskills.mjs accept <project dir> [options]  the acceptance sheet: the tasks waiting for the owner,
//                                                               as one page
//   node scripts/autoskills.mjs help [command]
//
// Exit codes: 0 done, 1 the command failed, 2 usage error.
// This file only finds the command. Each command lives in scripts/lib/<name>/cli.mjs and exports a function
// (args, io) => exit code, with io = {stdout, stderr}.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const COMMANDS = Object.freeze({
  run: { module: 'lib/run/cli.mjs', fn: 'runCommand', summary: 'the long-run driver: a fresh headless session a task' },
  stop: { module: 'lib/run/cli.mjs', fn: 'stopCommand', summary: 'ask a running driver to end after the task in hand' },
  accept: { module: 'lib/accept/cli.mjs', fn: 'acceptCommand', summary: 'the acceptance sheet: tasks waiting for the owner, as one page' },
});

export function usage() {
  const lines = ['Usage: node scripts/autoskills.mjs <command> <project dir> [options]', '', 'Commands:'];
  for (const [name, c] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(8)}${c.summary}`);
  lines.push(`  ${'help'.padEnd(8)}this text; help <command> prints the command's own options`);
  return `${lines.join('\n')}\n`;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [name, ...rest] = argv;
  if (!name) {
    io.stderr.write(usage());
    return 2;
  }
  if (name === 'help' || name === '--help' || name === '-h') {
    if (rest[0] && COMMANDS[rest[0]]) return main([rest[0], '--help'], io);
    io.stdout.write(usage());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.stderr.write(`autoskills: no command "${name}"\n\n${usage()}`);
    return 2;
  }
  const mod = await import(pathToFileURL(path.join(HERE, command.module)).href);
  return mod[command.fn](rest, io);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = Number.isInteger(code) ? code : 1; },
    (err) => {
      process.stderr.write(`autoskills: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    },
  );
}
