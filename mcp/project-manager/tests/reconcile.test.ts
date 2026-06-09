// PM-503 (v1.4.0): reconcile — minimal safe auto-fix set + idempotency.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task, type ProjectInfo } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-recon-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    commit_hash: "", notes: "", ...over,
  } as Task;
}
function seed(tasks: Task[], status: ProjectInfo["status"] = "in_progress"): StateManager {
  const sm = new StateManager(emptyProject());
  sm.saveProjectInfo({
    name: "t", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    status, tech_stack: [], progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
  });
  if (tasks.length) sm.createTasks(tasks);
  return sm;
}

describe("reconcile", () => {
  it("fixes progress_drift via updateProjectProgress and audits it", () => {
    const sm = seed([mkTask({ id: "A" }), mkTask({ id: "B", status: "done" })]);
    const info = sm.getProjectInfo()!;
    info.progress.done = 99; // corrupt
    sm.saveProjectInfo(info);

    const r = sm.reconcile();
    expect(r.fixed.some((f) => f.code === "progress_drift")).toBe(true);
    expect(sm.getProjectInfo()!.progress.done).toBe(1); // B is done
    expect(sm.getLogs({ event_type: "reconcile_progress_recompute" }).length).toBe(1);
    expect(r.remaining.some((f) => f.code === "progress_drift")).toBe(false);
  });

  it("fixes self_dependency on an active task and audits it", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["A"] })]);
    const r = sm.reconcile();
    expect(r.fixed.some((f) => f.code === "self_dependency" && f.task_id === "A")).toBe(true);
    expect(sm.getTaskById("A")!.dependencies).toEqual([]);
    expect(sm.getLogs({ event_type: "reconcile_self_dependency" }).length).toBe(1);
  });

  it("does NOT fix a self_dependency on a terminal task (frozen history)", () => {
    const sm = seed([mkTask({ id: "A", status: "done", dependencies: ["A"] })]);
    const r = sm.reconcile();
    expect(r.fixed.length).toBe(0);
    expect(sm.getTaskById("A")!.dependencies).toEqual(["A"]); // untouched
    expect(r.remaining.some((f) => f.code === "self_dependency")).toBe(true);
  });

  it("does NOT touch non-autofixable findings (dangling deps left for edit_task)", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["ZZZ"] })]);
    const r = sm.reconcile();
    expect(r.fixed.length).toBe(0);
    expect(sm.getTaskById("A")!.dependencies).toEqual(["ZZZ"]); // not rewritten
    expect(r.remaining.some((f) => f.code === "dangling_dependency")).toBe(true);
  });

  it("never mutates task status", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["A"] }), mkTask({ id: "B", status: "done" })]);
    const info = sm.getProjectInfo()!;
    info.progress.todo = 42; // force a progress fix too
    sm.saveProjectInfo(info);
    sm.reconcile();
    expect(sm.getTaskById("A")!.status).toBe("todo");
    expect(sm.getTaskById("B")!.status).toBe("done");
  });

  it("is idempotent: a second run fixes nothing", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["A"] }), mkTask({ id: "B", status: "done" })]);
    const info = sm.getProjectInfo()!;
    info.progress.done = 0; // corrupt
    sm.saveProjectInfo(info);

    const first = sm.reconcile();
    expect(first.fixed.length).toBeGreaterThan(0);
    const second = sm.reconcile();
    expect(second.fixed.length).toBe(0);
  });
});
