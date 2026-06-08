import * as fs from "fs";
import * as path from "path";

// Cross-project addressing safety contract (ADR-003 §1.1). Pure (fs/path only),
// so it is unit-testable without importing index.ts (which would start the server).
export type DirResolution =
  | { ok: true; resolved: string; state_path: string }
  | {
      ok: false;
      error_kind: "not_a_project" | "state_unreadable";
      error: string;
      resolved: string;
    };

/**
 * Resolve a (possibly relative / symlinked) project dir to a canonical path and
 * validate that it is an initialized project (`.claude/state` is a directory).
 * realpathSync canonicalizes symlinks and normalizes Windows case / UNC paths.
 * Never mutates any global state.
 */
export function resolveProjectDir(dir: string): DirResolution {
  let resolved = path.resolve(dir);
  try {
    resolved = fs.realpathSync(resolved); // canonical: symlinks, Windows case, UNC
  } catch {
    // The path may not exist; keep the resolve() value and let the stat below classify it.
  }

  const statePath = path.join(resolved, ".claude", "state");
  let st: fs.Stats;
  try {
    st = fs.statSync(statePath);
  } catch {
    return {
      ok: false,
      error_kind: "not_a_project",
      error: `No .claude/state under ${resolved} — not an initialized project.`,
      resolved,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      error_kind: "state_unreadable",
      error: `${statePath} exists but is not a directory.`,
      resolved,
    };
  }
  return { ok: true, resolved, state_path: statePath };
}
