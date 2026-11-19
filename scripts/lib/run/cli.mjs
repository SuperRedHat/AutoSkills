// The run and stop commands of scripts/autoskills.mjs. This file is a placeholder from the contract task (AS3-364);
// the long-run driver itself is AS3-365 and replaces it. The two exports and their form are fixed:
//   runCommand(args, io)  => exit code     args: <project dir> [options]
//   stopCommand(args, io) => exit code     args: <project dir>
const NOT_BUILT = 'not built yet (AS3-365)';

export async function runCommand(args, io) {
  if (args.includes('--help')) {
    io.stdout.write(`Usage: node scripts/autoskills.mjs run <project dir> [options]\n  ${NOT_BUILT}\n`);
    return 0;
  }
  io.stderr.write(`autoskills run: ${NOT_BUILT}\n`);
  return 1;
}

export async function stopCommand(args, io) {
  if (args.includes('--help')) {
    io.stdout.write(`Usage: node scripts/autoskills.mjs stop <project dir>\n  ${NOT_BUILT}\n`);
    return 0;
  }
  io.stderr.write(`autoskills stop: ${NOT_BUILT}\n`);
  return 1;
}
