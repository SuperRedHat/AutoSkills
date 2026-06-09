// PM-605 (v1.5.0, ADR-005 §2): rename_task — change id + cascade-rewrite references.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-rename-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("rename_task (PM-605)", () => {
  it("renames a task and rewrites dependents' dependencies (deduped)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B", dependencies: ["A"] }),
      mkTask({ id: "C", dependencies: ["A", "B"] }),
    ]);
    const r = sm.renameTask("A", "A2");
    expect(r.success).toBe(true);
    expect(r.task_id).toBe("A2");
    expect(r.rewired_dependencies?.slice().sort()).toEqual(["B", "C"]);
    expect(sm.getTaskById("A")).toBeNull();
    expect(sm.getTaskById("A2")).toBeTruthy();
    expect(sm.getTaskById("B")!.dependencies).toEqual(["A2"]);
    expect(sm.getTaskById("C")!.dependencies).toEqual(["A2", "B"]);
  });

  it("rejects blank/duplicate new_id and a missing old_id; old===new is a success no-op", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    expect(sm.renameTask("A", "").success).toBe(false);
    expect(sm.renameTask("A", "   ").success).toBe(false);
    expect(sm.renameTask("A", "B").success).toBe(false); // conflict
    expect(sm.renameTask("ZZZ", "X").success).toBe(false); // missing old
    const noop = sm.renameTask("A", "A");
    expect(noop.success).toBe(true);
    expect(noop.noop).toBe(true);
    expect(sm.getLogs({ event_type: "task_renamed" }).length).toBe(0);
    expect(sm.getTaskById("A")).toBeTruthy(); // unchanged
  });

  it("rewrites replacement_task_id pointers across tasks", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "R" })]);
    sm.updateTaskStatus("A", "in_progress");
    sm.closeTask("A", "superseded", "moved", "R"); // A.replacement_task_id = R
    const r = sm.renameTask("R", "R2"); // rename the replacement target
    expect(r.success).toBe(true);
    expect(r.rewired_replacements).toContain("A");
    expect(sm.getTaskById("A")!.replacement_task_id).toBe("R2");
  });

  it("rewrites focus.related_task_ids (deduped)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    sm.setCurrentFocus({ summary: "f", related_task_ids: ["A", "B"] });
    const r = sm.renameTask("A", "A2");
    expect(r.focus_rewritten).toBe(true);
    expect(sm.getCurrentFocus()!.related_task_ids.slice().sort()).toEqual(["A2", "B"]);
  });

  it("keeps logs immutable and appends exactly one task_renamed audit", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress"); // a transition log referencing old id "A"
    const r = sm.renameTask("A", "A2");
    expect(r.success).toBe(true);
    const renamed = sm.getLogs({ event_type: "task_renamed" });
    expect(renamed.length).toBe(1);
    expect(renamed[0].task_id).toBe("A2");
    expect(renamed[0].kind).toBe("ops_event");
    expect(renamed[0].source).toBe("rename_task");
    expect(renamed[0].entities).toMatchObject({ old_id: "A", new_id: "A2", logs_preserved: true });
    // the pre-rename transition log still references the OLD id (immutable history)
    const transitions = sm.getLogs(50).filter((l) => (l.event_type ?? l.type) === "task_status_change");
    expect(transitions.some((l) => l.task_id === "A")).toBe(true);
  });

  it("a terminal task can be renamed without changing status / closed_at / close_reason", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress");
    sm.closeTask("A", "cancelled", "scrapped");
    const before = sm.getTaskById("A")!;
    const r = sm.renameTask("A", "A2");
    expect(r.success).toBe(true);
    const after = sm.getTaskById("A2")!;
    expect(after.status).toBe("cancelled");
    expect(after.close_reason).toBe("scrapped");
    expect(after.closed_at).toBe(before.closed_at);
  });

  it("does NOT reject a rename when a replacement chain legitimately terminates in a done task", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "R" }), mkTask({ id: "X" })]);
    sm.updateTaskStatus("A", "in_progress");
    sm.closeTask("A", "superseded", "->R", "R"); // A.replacement = R
    sm.updateTaskStatus("R", "in_progress");
    sm.updateTaskStatus("R", "auto_verified");
    sm.updateTaskStatus("R", "done"); // R now done — a healthy terminal replacement target
    // renaming unrelated X runs validateTaskGraph over A->R(done); it must NOT reject
    // because validateReplacementGraph (unlike close_task) has no "target must be active" rule.
    const r = sm.renameTask("X", "X2");
    expect(r.success).toBe(true);
  });

  it("ABORTS with no partial write when the rewrite would create a self-dependency", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A", dependencies: ["A"] })]); // pre-corrupt self-loop
    const tasksPath = path.join(dir, ".claude", "state", "tasks.json");
    const before = fs.readFileSync(tasksPath, "utf-8");

    // rename A -> A2 rewrites A's own edge 'A'->'A2', producing a self-loop on A2
    // that validateTaskGraph must reject — aborting the whole operation.
    const r = sm.renameTask("A", "A2");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/itself|self/i);

    // no partial write: tasks.json byte-identical, old id intact, no audit log
    expect(fs.readFileSync(tasksPath, "utf-8")).toBe(before);
    expect(sm.getTaskById("A")).toBeTruthy();
    expect(sm.getTaskById("A2")).toBeNull();
    expect(sm.getLogs({ event_type: "task_renamed" }).length).toBe(0);
  });

  it("after renaming a superseded husk, the chain still resolves and lint stays clean (e2e invariants)", () => {
    const sm = new StateManager(emptyProject());
    // hand-built legacy shape: A superseded->R(done); B still points at the husk A.
    sm.createTasks([
      mkTask({ id: "A", status: "superseded", replacement_task_id: "R" }),
      mkTask({ id: "R", status: "done" }),
      mkTask({ id: "B", dependencies: ["A"] }),
    ]);
    const r = sm.renameTask("A", "A9");
    expect(r.success).toBe(true);
    // id + dependents + replacement chain all rewritten consistently
    expect(sm.getTaskById("B")!.dependencies).toEqual(["A9"]);
    expect(sm.getTaskById("A9")!.replacement_task_id).toBe("R");
    // chain A9(superseded)->R(done) still resolves: B is runnable
    expect(sm.getNextTask()?.id).toBe("B");
    // lint over the renamed graph: no error-severity finding, no dangling/missing
    const findings = sm.lintState().findings;
    expect(findings.filter((f) => f.severity === "error").length).toBe(0);
    expect(findings.some((f) => f.code === "dangling_dependency")).toBe(false);
    expect(findings.some((f) => f.code === "replacement_target_missing")).toBe(false);
    expect(findings.some((f) => f.code === "focus_related_task_missing")).toBe(false);
  });
});
