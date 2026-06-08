// PM-401: regression tests for the confirmed audit findings (batch 1, TS).
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-audit-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}
function log(ts: string, message: string): void {}

describe("audit fixes (batch 1)", () => {
  it("getLogs limit=0 returns [] (not all); invalid `since` is ignored, not silently wrong", () => {
    const sm = new StateManager(emptyProject());
    for (let i = 1; i <= 5; i++) {
      sm.addLog({ timestamp: `2026-02-0${i}T00:00:00.000Z`, type: "note", task_id: null, from_status: null, to_status: null, message: `n${i}` });
    }
    expect(sm.getLogs({ limit: 0 })).toEqual([]); // was: returned ALL (0 treated as falsy)
    expect(sm.getLogs({ since: "not-a-date" }).length).toBe(5); // NaN since -> filter ignored
    expect(sm.getLogs({ since: "2026-02-03T00:00:00.000Z" }).length).toBe(3); // valid since still filters
  });

  it("migrate is a no-op when project.json is absent (no false schema_version=1 claim)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]); // tasks.json exists; project.json does not
    const r = sm.migrateTaskSchema();
    expect(r.skipped).toBe(true);
    expect(r.schema_version).toBe(0);
  });

  it("validateReplacement rejects a terminal (done) replacement target", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "D", status: "done" })]);
    sm.updateTaskStatus("A", "in_progress");
    const r = sm.closeTask("A", "superseded", "replace by a done task", "D");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/terminal|done/);
  });

  it("blocked_by_cancelled_dep is detected through a superseded chain that ends in cancelled", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "C", status: "cancelled" }),
      mkTask({ id: "B", status: "superseded", replacement_task_id: "C" }),
      mkTask({ id: "A", dependencies: ["B"] }),
    ]);
    const ctx = sm.getProjectContext();
    expect(ctx.tasks_summary.next_task).toBeNull();
    expect(ctx.tasks_summary.next_task_blocked_reason).toBe("blocked_by_cancelled_dep");
  });

  it("done is a terminal state with no outbound transition", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "done" })]);
    expect(sm.updateTaskStatus("A", "in_progress").success).toBe(false);
  });
});
