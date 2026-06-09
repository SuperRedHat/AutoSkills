// PM-603 (v1.5.0, ADR-005 §5): reconcile field-cleanup autofix for ACTIVE tasks only.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-rfc-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("reconcile field-cleanup autofix (PM-603)", () => {
  it("lint flags active stale close/replacement as autofixable; terminal stale replacement is not", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "in_progress", closed_at: "2020-01-01T00:00:00Z", close_reason: "leftover" }),
      mkTask({ id: "B", status: "todo", replacement_task_id: "C" }),
      mkTask({ id: "C" }),
      mkTask({ id: "D", status: "done", replacement_task_id: "C" }), // terminal stale replacement
    ]);
    const { findings } = sm.lintState();
    const closeF = findings.find((f) => f.code === "stale_close_fields_on_nonterminal" && f.task_id === "A");
    const replActive = findings.find((f) => f.code === "stale_replacement_on_nonsuperseded" && f.task_id === "B");
    const replTerminal = findings.find((f) => f.code === "stale_replacement_on_nonsuperseded" && f.task_id === "D");
    expect(closeF?.autofixable).toBe(true);
    expect(replActive?.autofixable).toBe(true);
    expect(replTerminal?.autofixable).toBe(false);
  });

  it("reconcile clears active stale close fields + replacement, writes audit, is idempotent", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "in_progress", closed_at: "2020-01-01T00:00:00Z", close_reason: "leftover" }),
      mkTask({ id: "B", status: "todo", replacement_task_id: "C" }),
      mkTask({ id: "C" }),
    ]);
    const r = sm.reconcile();
    const codes = r.fixed.map((f) => f.code);
    expect(codes).toContain("stale_close_fields_on_nonterminal");
    expect(codes).toContain("stale_replacement_on_nonsuperseded");

    const a = sm.getTaskById("A")!;
    expect(a.closed_at).toBeNull();
    expect(a.close_reason).toBeNull();
    expect(a.status).toBe("in_progress"); // status untouched
    expect(sm.getTaskById("B")!.replacement_task_id).toBeNull();

    expect(sm.getLogs({ event_type: "reconcile_stale_close_fields_clear" }).length).toBe(1);
    expect(sm.getLogs({ event_type: "reconcile_stale_replacement_clear" }).length).toBe(1);

    // idempotent: a second run clears nothing more
    const r2 = sm.reconcile();
    expect(r2.fixed.filter((f) => f.code.startsWith("stale_")).length).toBe(0);
  });

  it("does NOT clear a stale replacement on a terminal task (frozen history) — reports only", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A", status: "done", replacement_task_id: "B" }),
      mkTask({ id: "B" }),
    ]);
    const r = sm.reconcile();
    expect(r.fixed.filter((f) => f.code === "stale_replacement_on_nonsuperseded").length).toBe(0);
    expect(sm.getTaskById("A")!.replacement_task_id).toBe("B");
    expect(
      r.remaining.some((f) => f.code === "stale_replacement_on_nonsuperseded" && f.task_id === "A")
    ).toBe(true);
  });

  it("existing autofixes (progress_drift / self_dependency) still work alongside", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", dependencies: ["A"] })]); // self-dependency (active)
    const r = sm.reconcile();
    expect(r.fixed.some((f) => f.code === "self_dependency")).toBe(true);
    expect(sm.getTaskById("A")!.dependencies).toEqual([]);
  });
});
