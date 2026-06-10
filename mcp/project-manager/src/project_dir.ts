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
 * PM-704: canonicalize a path for identity comparison. Plain realpathSync does
 * NOT true-case Windows paths (it preserves the caller's casing), so
 * `d:/project/x` and `D:/project/X` compared unequal and the active project
 * was misclassified as foreign. realpathSync.native returns the on-disk casing.
 */
export function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      // The path may not exist; the caller's stat will classify it.
      return resolved;
    }
  }
}

/** Case-aware path identity: Windows filesystems are case-insensitive. */
export function samePath(a: string, b: string): boolean {
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Resolve a (possibly relative / symlinked) project dir to a canonical path and
 * validate that it is an initialized project (`.claude/state` is a directory).
 * canonicalizePath resolves symlinks and (via realpathSync.native) true-cases
 * Windows paths. Never mutates any global state.
 */
export function resolveProjectDir(dir: string): DirResolution {
  const resolved = canonicalizePath(dir);

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
