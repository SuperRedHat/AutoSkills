// The accept command of scripts/autoskills.mjs. This file is a placeholder from the contract task (AS3-364); the
// acceptance sheet itself is AS3-366 and replaces it. The export and its form are fixed:
//   acceptCommand(args, io) => exit code     args: <project dir> [options]
const NOT_BUILT = 'not built yet (AS3-366)';

export async function acceptCommand(args, io) {
  if (args.includes('--help')) {
    io.stdout.write(`Usage: node scripts/autoskills.mjs accept <project dir> [options]\n  ${NOT_BUILT}\n`);
    return 0;
  }
  io.stderr.write(`autoskills accept: ${NOT_BUILT}\n`);
  return 1;
}
