// PM-201 (Phase 2, B1 / L5): task priority on getNextTask.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-prio-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("task priority", () => {
  it("all-default priority => creation order (unchanged legacy behavior)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    expect(sm.getNextTask()?.id).toBe("A");
  });

  it("higher priority wins among runnable todos", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", priority: 5 })]);
    expect(sm.getNextTask()?.id).toBe("B");
  });

  it("ties keep creation order (stable)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", priority: 5 }), mkTask({ id: "C", priority: 5 })]);
    expect(sm.getNextTask()?.id).toBe("A");
  });

  it("priority never overrides dependency gating", () => {
    const sm = new StateManager(emptyProject());
    // B is highest priority but blocked by A; A (lower) must still come first.
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", priority: 9, dependencies: ["A"] })]);
    expect(sm.getNextTask()?.id).toBe("A");
  });

  it("set_task_priority re-selects and logs a priority_change ops_event", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    expect(sm.getNextTask()?.id).toBe("A");
    expect(sm.setTaskPriority("B", 10).success).toBe(true);
    expect(sm.getNextTask()?.id).toBe("B");
    const log = sm.getLogs({ event_type: "priority_change" })[0];
    expect(log.kind).toBe("ops_event");
    expect(log.entities).toMatchObject({ to: 10 });
  });

  it("normalizeTask defaults priority to 0 for legacy tasks", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    expect(sm.getTaskById("A")!.priority).toBe(0);
  });
});
