// PM-003 (Phase 0.2): additive get_project_context behavior — dual-rate metrics,
// in_progress full text + budget switch, next_task_blocked_reason diagnostic, and
// context_mode as a presentation hint (NOT a filter). All additive; the legacy
// fields are covered by state.characterization.test.ts.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";
import { fixtureProject } from "./helpers";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-ctx-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("metrics (read-time dual completion rate)", () => {
  it("all-done project => raw=active=1, no closed states yet", () => {
    const ctx = new StateManager(fixtureProject("councilflow")).getProjectContext();
    const m = ctx.tasks_summary.metrics;
    expect(m.total_all).toBe(114);
    expect(m.done).toBe(114);
    expect(m.cancelled).toBe(0);
    expect(m.superseded).toBe(0);
    expect(m.active_total).toBe(114);
    expect(m.raw_completion_rate).toBe(1);
    expect(m.active_completion_rate).toBe(1);
    expect(ctx.schema_version).toBe(0); // fixture predates schema_version stamping
    expect(ctx.current_focus).toBeNull();
  });

  it("rates are 0 (not NaN) when the project has no tasks", () => {
    const ctx = new StateManager(emptyProject()).getProjectContext();
    expect(ctx.tasks_summary.metrics.raw_completion_rate).toBe(0);
    expect(ctx.tasks_summary.metrics.active_completion_rate).toBe(0);
  });
});

describe("in_progress_tasks + budget switch", () => {
  it("returns in_progress full text; include_full_in_progress=false empties it but keeps metrics", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B" })]);
    sm.updateTaskStatus("A", "in_progress");

    const full = sm.getProjectContext();
    expect(full.in_progress_tasks.map((t) => t.id)).toEqual(["A"]);
    expect(full.in_progress_tasks[0].title).toBe("t"); // full object, not just id

    const lean = sm.getProjectContext({ include_full_in_progress: false });
    expect(lean.in_progress_tasks).toEqual([]);
    expect(lean.tasks_summary.metrics.total_all).toBe(2); // budget switch does not change metrics
  });
});

describe("next_task_blocked_reason diagnostic", () => {
  it("all_done when nothing is left and next_task is null", () => {
    const ctx = new StateManager(fixtureProject("councilflow")).getProjectContext();
    expect(ctx.tasks_summary.next_task).toBeNull();
    expect(ctx.tasks_summary.next_task_blocked_reason).toBe("all_done");
  });

  it("blocked_in_progress when the only todo waits on an in_progress dep", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", dependencies: ["A"] })]);
    sm.updateTaskStatus("A", "in_progress");
    const ctx = sm.getProjectContext();
    expect(ctx.tasks_summary.next_task).toBeNull();
    expect(ctx.tasks_summary.next_task_blocked_reason).toBe("blocked_in_progress");
  });

  it("none when a runnable next task exists", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    const ctx = sm.getProjectContext();
    expect(ctx.tasks_summary.next_task?.id).toBe("A");
    expect(ctx.tasks_summary.next_task_blocked_reason).toBe("none");
  });
});

describe("context_mode is a presentation hint only (D1)", () => {
  it("identical task set across modes, different presentation_order, more logs in ops", () => {
    const sm = new StateManager(fixtureProject("councilflow"));
    const build = sm.getProjectContext({ context_mode: "build" });
    const ops = sm.getProjectContext({ context_mode: "ops" });

    // set consistency — mode must NOT filter tasks
    expect(ops.tasks_summary.total).toBe(build.tasks_summary.total);
    expect(ops.tasks_summary.by_status).toEqual(build.tasks_summary.by_status);
    expect(ops.in_progress_tasks.map((t) => t.id)).toEqual(
      build.in_progress_tasks.map((t) => t.id),
    );

    // presentation differs
    expect(build.context_mode).toBe("build");
    expect(ops.context_mode).toBe("ops");
    expect(ops.presentation_order).not.toEqual(build.presentation_order);

    // ops surfaces more recent logs by default
    expect(ops.recent_logs.length).toBeGreaterThanOrEqual(build.recent_logs.length);
  });

  it("max_recent_events overrides the mode default", () => {
    const sm = new StateManager(fixtureProject("councilflow"));
    expect(sm.getProjectContext({ max_recent_events: 3 }).recent_logs.length).toBe(3);
  });
});
