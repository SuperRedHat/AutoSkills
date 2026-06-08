// PM-202 (Phase 2, B3): reopen_task — audited reverse of close_task.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-reopen-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("reopen_task", () => {
  it("reopens a done task to todo, clears close fields, logs task_reopened", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "done", closed_at: "x", close_reason: "y" })]);
    const r = sm.reopenTask("A", "marked done by mistake");
    expect(r.success).toBe(true);
    const a = sm.getTaskById("A")!;
    expect(a.status).toBe("todo");
    expect(a.closed_at ?? null).toBeNull();
    expect(a.close_reason ?? null).toBeNull();
    const log = sm.getLogs({ event_type: "task_reopened" })[0];
    expect(log.kind).toBe("task_transition");
    expect(log.from_status).toBe("done");
    expect(log.to_status).toBe("todo");
  });

  it("can reopen to in_progress", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "done" })]);
    expect(sm.reopenTask("A", "resume", "in_progress").success).toBe(true);
    expect(sm.getTaskById("A")!.status).toBe("in_progress");
  });

  it("reopens a cancelled task", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "cancelled" })]);
    expect(sm.reopenTask("A", "revive").success).toBe(true);
    expect(sm.getTaskById("A")!.status).toBe("todo");
  });

  it("reopening a superseded task clears replacement_task_id and flags it in the log", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "superseded", replacement_task_id: "B" }), mkTask({ id: "B" })]);
    const r = sm.reopenTask("A", "bring back");
    expect(r.success).toBe(true);
    expect(sm.getTaskById("A")!.replacement_task_id ?? null).toBeNull();
    expect(sm.getLogs({ event_type: "task_reopened" })[0].entities).toMatchObject({
      cleared_replacement_task_id: "B",
    });
  });

  it("refuses non-terminal tasks and an empty reason", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "D", status: "done" })]);
    expect(sm.reopenTask("A", "x").success).toBe(false); // not closed
    expect(sm.reopenTask("D", "   ").success).toBe(false); // empty reason
  });

  it("a reopened done->todo task becomes runnable again", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "done" })]);
    expect(sm.getNextTask()).toBeNull(); // all done
    sm.reopenTask("A", "redo");
    expect(sm.getNextTask()?.id).toBe("A");
  });
});
