// PM-101 (Phase 1.1): cancelled/superseded terminal states. They are reachable
// ONLY via close_task (PM-102); updateTaskStatus must refuse them, and they have
// no outbound transitions. get_all_tasks can filter them; metrics count them.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-cs-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("cancelled/superseded terminal states", () => {
  it("updateTaskStatus refuses cancelled/superseded and points to close_task", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress");

    const c = sm.updateTaskStatus("A", "cancelled");
    expect(c.success).toBe(false);
    expect(c.error).toContain("close_task");

    const s = sm.updateTaskStatus("A", "superseded");
    expect(s.success).toBe(false);
    expect(s.error).toContain("close_task");
  });

  it("are terminal: no outbound transition via updateTaskStatus", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "cancelled" }),
      mkTask({ id: "B", status: "superseded" }),
    ]);
    expect(sm.updateTaskStatus("A", "in_progress").success).toBe(false);
    expect(sm.updateTaskStatus("B", "in_progress").success).toBe(false);
  });

  it("get_all_tasks filters by them; metrics count them and split raw vs active", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "done" }),
      mkTask({ id: "C", status: "cancelled" }),
      mkTask({ id: "S", status: "superseded" }),
      mkTask({ id: "T", status: "todo" }),
    ]);
    expect(sm.getAllTasks({ status: "cancelled" }).map((t) => t.id)).toEqual(["C"]);
    expect(sm.getAllTasks({ status: "superseded" }).map((t) => t.id)).toEqual(["S"]);

    const m = sm.getProjectContext().tasks_summary.metrics;
    expect(m.total_all).toBe(4);
    expect(m.done).toBe(1);
    expect(m.cancelled).toBe(1);
    expect(m.superseded).toBe(1);
    expect(m.active_total).toBe(2); // 4 - cancelled - superseded
    expect(m.closed_total).toBe(3); // done + cancelled + superseded
    expect(m.raw_completion_rate).toBeCloseTo(0.25); // 1/4
    expect(m.active_completion_rate).toBeCloseTo(0.5); // 1/2
  });
});
