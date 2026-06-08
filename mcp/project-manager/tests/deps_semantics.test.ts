// PM-103 (Phase 1.3, G1 — highest risk): dependency semantics for closed tasks.
// superseded => rewrite dependents to replacement; cancelled => block + alert,
// never silent deadlock and never silent run; getNextTask resolves superseded chains.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-deps-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("superseded => rewrite dependents to the replacement", () => {
  it("rewrites every dependent's edge from the husk to the replacement", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B", dependencies: ["A"] }),
      mkTask({ id: "C", dependencies: ["A"] }),
      mkTask({ id: "R" }),
    ]);
    const r = sm.closeTask("A", "superseded", "moved to R", "R");
    expect(r.success).toBe(true);
    expect(r.rewired?.slice().sort()).toEqual(["B", "C"]);
    expect(sm.getTaskById("B")!.dependencies).toEqual(["R"]);
    expect(sm.getTaskById("C")!.dependencies).toEqual(["R"]);
    expect(sm.getNextTask()?.id).toBe("R"); // husk A no longer blocks; R is runnable
  });

  it("rewired dependents become runnable once the replacement is done", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", dependencies: ["A"] }), mkTask({ id: "R" })]);
    sm.closeTask("A", "superseded", "->R", "R");
    sm.updateTaskStatus("R", "in_progress");
    sm.updateTaskStatus("R", "auto_verified");
    sm.updateTaskStatus("R", "done");
    expect(sm.getNextTask()?.id).toBe("B");
  });

  it("getNextTask defensively resolves a superseded chain even if a dep was not rewritten", () => {
    const sm = new StateManager(emptyProject());
    // Hand-built legacy shape: A superseded->R(done); B still points at A.
    sm.createTasks([
      mkTask({ id: "A", status: "superseded", replacement_task_id: "R" }),
      mkTask({ id: "R", status: "done" }),
      mkTask({ id: "B", dependencies: ["A"] }),
    ]);
    expect(sm.getNextTask()?.id).toBe("B");
  });
});

describe("cancelled => block + alert (no silent deadlock, no silent run)", () => {
  it("holds dependents back, flags the reason, and emits an ops_event alert", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", dependencies: ["A"] })]);
    const r = sm.closeTask("A", "cancelled", "scrapped");
    expect(r.affected_dependents).toEqual(["B"]);

    // B does not silently run...
    expect(sm.getNextTask()).toBeNull();
    // ...and null is explained (not mistaken for "all done")...
    expect(sm.getProjectContext().tasks_summary.next_task_blocked_reason).toBe(
      "blocked_by_cancelled_dep",
    );
    // ...and the controller is alerted to re-point/close the dependents.
    const alert = sm.getLogs({ event_type: "dependents_blocked_by_cancel" })[0];
    expect(alert).toBeTruthy();
    expect(alert.kind).toBe("ops_event");
    expect(alert.entities).toMatchObject({ cancelled: "A", dependents: ["B"] });
  });

  it("cancelling a leaf task with no dependents emits no alert", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    sm.closeTask("A", "cancelled", "leaf");
    expect(sm.getLogs({ event_type: "dependents_blocked_by_cancel" }).length).toBe(0);
  });
});
