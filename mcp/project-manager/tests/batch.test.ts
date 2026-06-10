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

// PM-702: id hygiene at creation time — duplicates were previously pushed
// straight through, after which Map lookups (last-wins) and find lookups
// (first-wins) diverge on the same id.
describe("create_tasks / add_subtask id hygiene (PM-702)", () => {
  it("rejects an id that already exists — all-or-nothing, nothing written", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    const r = sm.createTasks([mkTask({ id: "B" }), mkTask({ id: "A" })]);
    expect(r.created).toBe(0);
    expect(r.error).toMatch(/duplicate task id/);
    expect(sm.getTaskById("B")).toBeNull(); // B from the rejected batch not created
  });

  it("rejects duplicates within one batch", () => {
    const sm = new StateManager(emptyProject());
    const r = sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "A" })]);
    expect(r.created).toBe(0);
    expect(r.error).toMatch(/duplicate task id/);
    expect(sm.getAllTasks().length).toBe(0);
  });

  it("trims ids and dependencies; a trimmed id collides with its untrimmed twin", () => {
    const sm = new StateManager(emptyProject());
    const r1 = sm.createTasks([mkTask({ id: "  A  " })]);
    expect(r1.created).toBe(1);
    expect(sm.getTaskById("A")).toBeTruthy(); // stored trimmed
    const r2 = sm.createTasks([mkTask({ id: " A" })]);
    expect(r2.created).toBe(0); // collides with existing A after trim
  });

  it("rejects an empty id after trim", () => {
    const sm = new StateManager(emptyProject());
    const r = sm.createTasks([mkTask({ id: "   " })]);
    expect(r.created).toBe(0);
    expect(r.error).toMatch(/empty task id/);
  });

  it("does NOT police graph shape at creation (lint/reconcile own that), only id uniqueness", () => {
    const sm = new StateManager(emptyProject());
    // Self/dangling deps still create fine — lint_state diagnoses them, and
    // tests/fixtures rely on createTasks as the seeding path for dirty graphs.
    const r = sm.createTasks([mkTask({ id: "A", dependencies: ["GHOST"] })]);
    expect(r.created).toBe(1);
    const lint = sm.lintState();
    expect(lint.findings.some((f) => f.code === "dangling_dependency")).toBe(true);
  });

  it("add_subtask rejects an existing id and trims the new one", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "P" })]);
    expect(sm.addSubtask("P", mkTask({ id: "P" })).success).toBe(false);
    expect(sm.addSubtask("P", mkTask({ id: "  " })).success).toBe(false);
    expect(sm.addSubtask("P", mkTask({ id: " S1 " })).success).toBe(true);
    expect(sm.getTaskById("S1")).toBeTruthy();
  });
});
