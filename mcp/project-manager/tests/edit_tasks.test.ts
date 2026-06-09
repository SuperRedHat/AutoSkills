// PM-602 (v1.5.0, ADR-005 §4): edit_tasks — batch metadata patch (per-item, partial success).
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-edits-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("edit_tasks (batch)", () => {
  it("applies each edit and returns per-item results", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    const r = sm.editTasks([
      { id: "A", patch: { title: "AA" } },
      { id: "B", patch: { notes: "bb" } },
    ]);
    expect(r.map((x) => [x.id, x.success])).toEqual([["A", true], ["B", true]]);
    expect(sm.getTaskById("A")!.title).toBe("AA");
    expect(sm.getTaskById("B")!.notes).toBe("bb");
  });

  it("partial success: bad entries fail while good entries still apply", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    const r = sm.editTasks([
      { id: "A", patch: { title: "ok" } },
      { id: "ZZZ", patch: { title: "x" } }, // not found
      { id: "A", patch: { status: "done" } as never }, // forbidden field
    ]);
    expect(r[0].success).toBe(true);
    expect(r[1].success).toBe(false);
    expect(r[2].success).toBe(false);
    expect(sm.getTaskById("A")!.title).toBe("ok");
    expect(sm.getTaskById("A")!.status).toBe("todo"); // never touched
  });

  it("writes one task_edited audit log per non-noop edit with source=edit_tasks", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", title: "old" }), mkTask({ id: "B" })]);
    sm.editTasks([
      { id: "A", patch: { title: "new" } },
      { id: "B", patch: { notes: "n" } },
    ]);
    const logs = sm.getLogs({ event_type: "task_edited" });
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.source === "edit_tasks")).toBe(true);
    expect(logs.every((l) => l.kind === "ops_event")).toBe(true);
  });

  it("empty-diff entry is a success no-op and writes no log", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", title: "same" })]);
    const r = sm.editTasks([{ id: "A", patch: { title: "same" } }]);
    expect(r[0].success).toBe(true);
    expect(r[0].noop).toBe(true);
    expect(r[0].changed_fields).toEqual([]);
    expect(sm.getLogs({ event_type: "task_edited" }).length).toBe(0);
  });

  it("reuses E2 acceptance coupling per entry", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", needs_manual_review: false })]);
    const r = sm.editTasks([{ id: "A", patch: { acceptance_mode: "manual" } }]);
    expect(r[0].changed_fields?.sort()).toEqual(["acceptance_mode", "needs_manual_review"]);
    expect(sm.getTaskById("A")!.needs_manual_review).toBe(true);
  });

  it("a later entry validates against earlier entries' applied state (cross-item DAG)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" }), mkTask({ id: "C" })]);
    // entry 1: B depends on A. entry 2: A depends on B would close a cycle A->B->A
    // ONLY if entry 1 already applied — proving the later edit sees the earlier one.
    const r = sm.editTasks([
      { id: "B", patch: { dependencies: ["A"] } },
      { id: "A", patch: { dependencies: ["B"] } },
    ]);
    expect(r[0].success).toBe(true);
    expect(r[1].success).toBe(false);
    expect(r[1].error).toMatch(/cycle/);
    expect(sm.getTaskById("A")!.dependencies).toEqual([]);
    expect(sm.getTaskById("B")!.dependencies).toEqual(["A"]);
  });

  it("terminal tasks: only doc fields editable in batch", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "done" }), mkTask({ id: "B" })]);
    const r = sm.editTasks([
      { id: "A", patch: { notes: "postmortem" } },
      { id: "A", patch: { dependencies: ["B"] } as never },
    ]);
    expect(r[0].success).toBe(true);
    expect(r[1].success).toBe(false);
    expect(sm.getTaskById("A")!.notes).toBe("postmortem");
  });
});
