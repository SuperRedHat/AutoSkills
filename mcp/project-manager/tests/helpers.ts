import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Root of the committed read-only fixtures (copies of real project state). */
export const FIXTURES_DIR = path.join(HERE, "fixtures");

/** Absolute path to a read-only fixture project dir (contains .claude/state/). */
export function fixtureProject(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Copy a fixture project dir into a fresh temp dir and return its path.
 * Use this for any test that MUTATES state (createTasks/updateTaskStatus/etc.)
 * so the committed fixtures are never polluted. Caller may remove the temp dir,
 * but the OS temp location makes leftovers harmless.
 */
export function tempCopyOfFixture(name: string): string {
  const src = fixtureProject(name);
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `pm-fixture-${name}-`));
  fs.cpSync(src, dst, { recursive: true });
  return dst;
}
