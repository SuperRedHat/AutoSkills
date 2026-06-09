// PM-604 (v1.5.0, ADR-005 §3): cross-project reconcile dry-run / fix-plan.
// The reconcile tool wires through selectState(project_dir): active -> reconcile()
// (apply), foreign -> reconcilePlan() (read-only). selectState lives in index.ts
// (importing it starts the MCP server), so — like cross_project.test.ts — we exercise
// the underlying StateManager.reconcilePlan + the read mechanism (resolveProjectDir +
// a transient StateManager).
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProjectDir } from "../src/project_dir";
import { StateManager, type Task } from "../src/state";

function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}
function projectWithFixables(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-xrec-"));
  const sm = new StateManager(dir);
  sm.createTasks([
    mkTask({ id: "A", dependencies: ["A"] }), // self_dependency (autofixable, active)
    mkTask({ id: "B", status: "in_progress", closed_at: "2020-01-01T00:00:00Z", close_reason: "x" }),
  ]);
  return dir;
}

describe("cross-project reconcile dry-run (PM-604)", () => {
  it("reconcilePlan lists fixable + remaining without writing anything", () => {
    const dir = projectWithFixables();
    const sm = new StateManager(dir);
    const before = fs.readFileSync(path.join(dir, ".claude", "state", "tasks.json"), "utf-8");

    const plan = sm.reconcilePlan();
    expect(plan.fixable.some((f) => f.code === "self_dependency")).toBe(true);
    expect(plan.fixable.some((f) => f.code === "stale_close_fields_on_nonterminal")).toBe(true);
    expect(plan.fixable.every((f) => f.autofixable)).toBe(true);
    expect(plan.remaining.every((f) => !f.autofixable)).toBe(true);

    // dry-run wrote nothing
    const after = fs.readFileSync(path.join(dir, ".claude", "state", "tasks.json"), "utf-8");
    expect(after).toBe(before);
    expect(sm.getTaskById("A")!.dependencies).toEqual(["A"]); // still stale, untouched
  });

  it("foreign project's plan is read-only; only an explicit reconcile() (after set_project_dir) writes it", () => {
    const dir = projectWithFixables();
    // mirrors selectState's foreign branch: resolveProjectDir + a transient StateManager
    const r = resolveProjectDir(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const foreign = new StateManager(r.resolved);
      foreign.reconcilePlan(); // dry-run only
      expect(foreign.getTaskById("A")!.dependencies).toEqual(["A"]); // untouched

      // applying (what set_project_dir + reconcile would do) is what actually clears it
      foreign.reconcile();
      expect(foreign.getTaskById("A")!.dependencies).toEqual([]);
    }
  });

  it("a dir with no .claude/state surfaces not_a_project (no crash) — the guard reconcile/selErr use", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pm-np2-"));
    const r = resolveProjectDir(empty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("not_a_project");
  });
});
