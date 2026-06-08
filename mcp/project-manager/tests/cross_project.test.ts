// PM-302 (Phase 3, C2): cross-project read mechanism. The read tools wire through
// selectState(project_dir) -> resolveProjectDir + a transient StateManager.
// selectState lives in index.ts (importing it would start the MCP server), so we
// exercise the exact mechanism it uses, against the real fixtures.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectDir } from "../src/project_dir";
import { StateManager } from "../src/state";
import { fixtureProject } from "./helpers";

describe("cross-project read mechanism", () => {
  it("resolves another project's dir and reads its state via a transient StateManager", () => {
    const r = resolveProjectDir(fixtureProject("councilflow"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sm = new StateManager(r.resolved);
      expect(sm.getProjectInfo()!.progress.done).toBe(114);
      expect(sm.getProjectContext().tasks_summary.total).toBe(114);
      expect(sm.getAllTasks().length).toBe(114);
    }
  });

  it("two projects resolve to independent state (no shared global)", () => {
    const cf = resolveProjectDir(fixtureProject("councilflow"));
    const nano = resolveProjectDir(fixtureProject("nano"));
    expect(cf.ok && nano.ok).toBe(true);
    if (cf.ok && nano.ok) {
      const a = new StateManager(cf.resolved).getProjectInfo()!.progress.total;
      const b = new StateManager(nano.resolved).getProjectInfo()!.progress.total;
      expect(a).toBe(114);
      expect(b).toBeGreaterThan(0);
      expect(b).not.toBe(a);
    }
  });

  it("a dir with no .claude/state surfaces not_a_project (no crash)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pm-np-"));
    const r = resolveProjectDir(empty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("not_a_project");
  });
});
