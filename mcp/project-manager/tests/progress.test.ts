// PM-104 (Phase 1.4): persisted progress is additive — legacy 5 keys unchanged,
// dual-rate fields added; cancelled/superseded counted and excluded from active.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task, type ProjectInfo } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-prog-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}
function seedProject(sm: StateManager): void {
  const info: ProjectInfo = {
    name: "t", created_at: "", updated_at: "", status: "in_progress",
    tech_stack: [], progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
  };
  sm.saveProjectInfo(info);
}

describe("persisted dual-rate progress", () => {
  it("writes legacy keys + dual-rate fields; cancelled/superseded split raw vs active", () => {
    const sm = new StateManager(emptyProject());
    seedProject(sm);
    sm.createTasks([
      mkTask({ id: "A", status: "done" }),
      mkTask({ id: "C", status: "cancelled" }),
      mkTask({ id: "S", status: "superseded" }),
      mkTask({ id: "T", status: "todo" }),
    ]);
    const p = sm.getProjectInfo()!.progress;

    // legacy (unchanged semantics)
    expect(p.total).toBe(4);
    expect(p.done).toBe(1);
    expect(p.todo).toBe(1);

    // additive dual-rate
    expect(p.total_all).toBe(4);
    expect(p.cancelled).toBe(1);
    expect(p.superseded).toBe(1);
    expect(p.active_total).toBe(2);
    expect(p.closed_total).toBe(3);
    expect(p.raw_completion_rate).toBeCloseTo(0.25);
    expect(p.active_completion_rate).toBeCloseTo(0.5);
  });

  it("a 100%-done project stays raw=active=1 (no false drop)", () => {
    const sm = new StateManager(emptyProject());
    seedProject(sm);
    sm.createTasks([mkTask({ id: "A", status: "done" }), mkTask({ id: "B", status: "done" })]);
    const p = sm.getProjectInfo()!.progress;
    expect(p.raw_completion_rate).toBe(1);
    expect(p.active_completion_rate).toBe(1);
  });
});
