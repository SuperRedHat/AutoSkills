// PM-301 (Phase 3, C1): resolveProjectDir safety contract.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectDir, canonicalizePath, samePath } from "../src/project_dir";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-dir-"));
}

describe("resolveProjectDir", () => {
  it("resolves a valid project dir to a canonical path + state_path", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".claude", "state"), { recursive: true });
    const r = resolveProjectDir(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // canonicalizePath uses realpathSync.native (true-cases Windows paths,
      // expands 8.3 short names) — compare against the same canonical form.
      expect(r.resolved).toBe(canonicalizePath(dir));
      expect(r.state_path).toBe(path.join(canonicalizePath(dir), ".claude", "state"));
    }
  });

  it("flags a non-existent dir as not_a_project", () => {
    const missing = path.join(os.tmpdir(), "pm-dir-does-not-exist-xyz");
    const r = resolveProjectDir(missing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("not_a_project");
  });

  it("flags an existing dir without .claude/state as not_a_project", () => {
    const dir = tmp(); // no .claude/state
    const r = resolveProjectDir(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("not_a_project");
  });

  it("flags .claude/state that is a file (not a directory) as state_unreadable", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "state"), "not a dir", "utf-8");
    const r = resolveProjectDir(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("state_unreadable");
  });

  it("normalizes a relative-style path to absolute", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".claude", "state"), { recursive: true });
    // pass a non-normalized path with a trailing '.' segment
    const r = resolveProjectDir(path.join(dir, "."));
    expect(r.ok).toBe(true);
    if (r.ok) expect(path.isAbsolute(r.resolved)).toBe(true);
  });

  // PM-704: drive-letter/case variants are routine across Windows shells; they
  // must resolve to the SAME canonical path or the active project gets
  // misclassified as foreign (silently weakening lint, blocking reconcile).
  it("treats case variants of the same dir as the same project (win32)", () => {
    if (process.platform !== "win32") return;
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".claude", "state"), { recursive: true });
    const lower = dir.toLowerCase();
    const r1 = resolveProjectDir(dir);
    const r2 = resolveProjectDir(lower);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.resolved).toBe(r2.resolved); // identical true-cased strings
      expect(samePath(r1.resolved, r2.resolved)).toBe(true);
    }
  });

  it("samePath is case-insensitive on win32 only", () => {
    if (process.platform === "win32") {
      expect(samePath("C:\\A\\b", "c:\\a\\B")).toBe(true);
    } else {
      expect(samePath("/a/b", "/A/B")).toBe(false);
    }
  });
});
