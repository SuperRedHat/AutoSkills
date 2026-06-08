// PM-203 (Phase 2, B2 / L4): batch operations — update_tasks / close_tasks / archive_module.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-batch-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("batch operations", () => {
  it("update_tasks applies each independently (partial success), still validating per item", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    // A: valid todo->in_progress; B: invalid todo->done (skips gauntlet) -> rejected
    const res = sm.updateTasks([
      { id: "A", status: "in_progress" },
      { id: "B", status: "done" },
    ]);
    expect(res.find((r) => r.id === "A")!.success).toBe(true);
    expect(res.find((r) => r.id === "B")!.success).toBe(false);
    expect(sm.getTaskById("A")!.status).toBe("in_progress");
    expect(sm.getTaskById("B")!.status).toBe("todo"); // unchanged
  });

  it("close_tasks batch-closes several with per-item results", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" }), mkTask({ id: "C" })]);
    const res = sm.closeTasks([
      { id: "A", status: "cancelled", reason: "x" },
      { id: "B", status: "cancelled", reason: "y" },
    ]);
    expect(res.every((r) => r.success)).toBe(true);
    expect(sm.getAllTasks({ status: "cancelled" }).map((t) => t.id).sort()).toEqual(["A", "B"]);
    expect(sm.getTaskById("C")!.status).toBe("todo"); // untouched
  });

  it("archive_module cancels all non-terminal tasks in a module, leaving others untouched", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", module: "old" }),
      mkTask({ id: "B", module: "old", status: "done" }), // already terminal -> untouched
      mkTask({ id: "C", module: "old" }),
      mkTask({ id: "D", module: "keep" }), // other module -> untouched
    ]);
    const r = sm.archiveModule("old", "module scrapped");
    expect(r.closed.slice().sort()).toEqual(["A", "C"]);
    expect(sm.getTaskById("A")!.status).toBe("cancelled");
    expect(sm.getTaskById("C")!.status).toBe("cancelled");
    expect(sm.getTaskById("B")!.status).toBe("done"); // untouched
    expect(sm.getTaskById("D")!.status).toBe("todo"); // untouched
  });
});
