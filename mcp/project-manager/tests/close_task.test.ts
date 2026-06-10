// PM-102 (Phase 1.2): close_task audited management bypass.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-close-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("close_task", () => {
  it("cancels a non-terminal task with reason, stamps fields, writes a task_closed audit log", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress");

    const r = sm.closeTask("A", "cancelled", "out of scope");
    expect(r.success).toBe(true);

    const a = sm.getTaskById("A")!;
    expect(a.status).toBe("cancelled");
    expect(a.close_reason).toBe("out of scope");
    expect(a.closed_at).toBeTruthy();

    const log = sm.getLogs({ event_type: "task_closed" })[0];
    expect(log).toBeTruthy();
    expect(log.kind).toBe("task_transition");
    expect(log.to_status).toBe("cancelled");
    expect(log.source).toBe("close_task");
  });

  // PM-705: a replacement on cancel was silently ignored — caller almost
  // certainly meant superseded.
  it("rejects cancelled with a replacement_task_id instead of silently ignoring it", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    const r = sm.closeTask("A", "cancelled", "nope", "B");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/supersede/);
    expect(sm.getTaskById("A")!.status).toBe("todo"); // untouched
  });

  it("requires a non-empty reason", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    expect(sm.closeTask("A", "cancelled", "").success).toBe(false);
    expect(sm.closeTask("A", "cancelled", "   ").success).toBe(false);
  });

  it("refuses to close an already-terminal task (no un-complete/reopen in v1)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "done" }),
      mkTask({ id: "B", status: "cancelled" }),
    ]);
    expect(sm.closeTask("A", "cancelled", "x").success).toBe(false); // cannot un-complete done
    expect(sm.closeTask("B", "superseded", "x", "A").success).toBe(false); // already closed
  });

  it("superseded requires a valid replacement (present, not self, not closed)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B" }),
      mkTask({ id: "C", status: "cancelled" }),
    ]);
    expect(sm.closeTask("A", "superseded", "r").success).toBe(false); // missing replacement
    expect(sm.closeTask("A", "superseded", "r", "A").success).toBe(false); // self
    expect(sm.closeTask("A", "superseded", "r", "ZZZ").success).toBe(false); // not found
    expect(sm.closeTask("A", "superseded", "r", "C").success).toBe(false); // target closed

    const ok = sm.closeTask("A", "superseded", "replaced by B", "B");
    expect(ok.success).toBe(true);
    expect(sm.getTaskById("A")!.replacement_task_id).toBe("B");
  });

  it("detects replacement cycles", () => {
    const sm = new StateManager(emptyProject());
    // B points its replacement at A; closing A superseded-by-B would loop A->B->A.
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", replacement_task_id: "A" })]);
    const r = sm.closeTask("A", "superseded", "r", "B");
    expect(r.success).toBe(false);
    expect(r.error).toContain("cycle");
  });

  it("reports affected dependents", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B", dependencies: ["A"] }),
      mkTask({ id: "C", dependencies: ["A"] }),
    ]);
    const r = sm.closeTask("A", "cancelled", "scrapped");
    expect(r.affected_dependents?.slice().sort()).toEqual(["B", "C"]);
  });

  it("supersede rewrite dedupes a dependent that already depends on the replacement", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B" }),
      mkTask({ id: "C", dependencies: ["A", "B"] }),
    ]);
    const r = sm.closeTask("A", "superseded", "replaced by B", "B");
    expect(r.success).toBe(true);
    expect(sm.getTaskById("C")!.dependencies).toEqual(["B"]); // not ["B","B"]
  });

  // PM-701: the canonical follow-up pattern — C was created to continue A and
  // depends on it, then A is superseded by C. The A→C edge on C must be DROPPED
  // (not rewritten into a C→C self-dependency that deadlocks C and its subtree).
  it("supersede drops the replacement's own edge to the husk instead of self-rewriting it", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "in_progress" }),
      mkTask({ id: "C", dependencies: ["A"] }),
      mkTask({ id: "D", dependencies: ["C"] }),
    ]);
    const r = sm.closeTask("A", "superseded", "folded into C", "C");
    expect(r.success).toBe(true);
    expect(r.rewired).toContain("C");

    const c = sm.getTaskById("C")!;
    expect(c.dependencies).toEqual([]); // edge dropped, no self-dependency

    // C (and therefore its subtree) stays schedulable.
    const next = sm.getNextTask();
    expect(next?.id).toBe("C");
  });

  it("supersede drops the husk edge but keeps the replacement's other dependencies", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B", status: "done" }),
      mkTask({ id: "C", dependencies: ["A", "B"] }),
    ]);
    const r = sm.closeTask("A", "superseded", "folded into C", "C");
    expect(r.success).toBe(true);
    expect(sm.getTaskById("C")!.dependencies).toEqual(["B"]);
  });

  // PM-701: closeTask now runs the same whole-graph post-validation as rename_task.
  // On abort nothing is persisted (no partial write, no audit log).
  it("aborts with no partial write when the post-transform graph is invalid", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "C", dependencies: ["A"] }),
    ]);
    // Corrupt the graph on disk AFTER creation: give D a dangling dependency so
    // any post-transform validation must fail, then attempt the supersede.
    const tasksPath = path.join(dir, ".claude", "state", "tasks.json");
    const data = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
    data.tasks.push({ ...data.tasks[0], id: "D", dependencies: ["GHOST"] });
    fs.writeFileSync(tasksPath, JSON.stringify(data, null, 2));
    const before = fs.readFileSync(tasksPath, "utf-8");

    const r = sm.closeTask("A", "superseded", "folded into C", "C");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/would corrupt the task graph/);
    expect(fs.readFileSync(tasksPath, "utf-8")).toBe(before); // byte-identical
    expect(sm.getLogs({ event_type: "task_closed" }).length).toBe(0);
  });
});
