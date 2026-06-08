// Characterization tests: lock the CURRENT behavior of StateManager before the
// Phase 0/1 ops changes touch it. These assertions encode the contract that must
// survive the additive changes (legacy progress keys, getNextTask gauntlet, the
// 500-char context summaries, getLogs slice). If a later phase changes one of
// these intentionally, that test should be updated in the same commit with a note.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";
import { fixtureProject, tempCopyOfFixture } from "./helpers";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-empty-"));
}

function mkTask(over: Partial<Task>): Task {
  return {
    id: "X",
    title: "t",
    description: "d",
    dependencies: [],
    complexity: "S",
    acceptance_criteria: [],
    files: [],
    module: "m",
    needs_manual_review: false,
    status: "todo",
    created_at: "",
    updated_at: "",
    commit_hash: "",
    notes: "",
    ...over,
  } as Task;
}

describe("getProjectContext (current shape)", () => {
  const ctx = new StateManager(fixtureProject("councilflow")).getProjectContext();

  it("summarizes prd/architecture to 500 chars with ellipsis when longer", () => {
    for (const s of [ctx.prd_summary, ctx.architecture_summary]) {
      expect(typeof s).toBe("string");
      if (s && s.endsWith("...")) {
        expect(s.length).toBe(503); // 500 chars + "..."
      }
    }
  });

  it("exposes tasks_summary with total/by_status/next_task/awaiting_acceptance", () => {
    expect(ctx.tasks_summary.total).toBe(114);
    expect(ctx.tasks_summary.by_status.done).toBe(114);
    expect(ctx.tasks_summary.next_task).toBeNull(); // all done
    expect(ctx.tasks_summary.awaiting_acceptance).toEqual([]);
  });

  it("returns at most 10 recent logs", () => {
    expect(ctx.recent_logs.length).toBeLessThanOrEqual(10);
  });

  // Updated in PM-003 (Phase 0.2): these fields are now additively exposed.
  // Detailed behavior lives in context.ops.test.ts; here we only assert the
  // contract shape so the characterization stays honest about what changed.
  it("now additively exposes in_progress_tasks + current_focus + metrics + mode (Phase 0.2)", () => {
    expect(Array.isArray(ctx.in_progress_tasks)).toBe(true);
    expect(ctx.current_focus).toBeNull(); // no focus.json in fixture
    expect(ctx.context_mode).toBe("build");
    expect(ctx.tasks_summary.metrics.total_all).toBe(114);
    expect(ctx.tasks_summary.next_task_blocked_reason).toBe("all_done");
  });
});

describe("updateProjectProgress (current legacy 5-key shape)", () => {
  it("emits exactly {total,done,in_progress,awaiting_acceptance,todo}", () => {
    const sm = new StateManager(tempCopyOfFixture("councilflow"));
    sm.updateProjectProgress();
    const p = sm.getProjectInfo()!.progress;
    expect(Object.keys(p).sort()).toEqual(
      ["awaiting_acceptance", "done", "in_progress", "todo", "total"].sort(),
    );
    expect(p.total).toBe(114);
    expect(p.done).toBe(114);
    expect(p.in_progress).toBe(0);
    expect(p.todo).toBe(0);
  });
});

describe("getLogs (current slice behavior, no kind filter)", () => {
  it("returns the n most-recent entries sorted by timestamp desc", () => {
    const sm = new StateManager(fixtureProject("councilflow"));
    const five = sm.getLogs(5);
    expect(five.length).toBe(5);
    for (let i = 1; i < five.length; i++) {
      expect(new Date(five[i - 1].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(five[i].timestamp).getTime(),
      );
    }
  });
});

describe("getNextTask + state-machine gauntlet (current semantics)", () => {
  it("returns the first todo whose deps are all done, and only 'done' satisfies deps", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", dependencies: ["A"] })]);

    expect(sm.getNextTask()?.id).toBe("A"); // B is blocked by A

    // forward-only gauntlet: cannot skip straight to done
    expect(sm.updateTaskStatus("A", "done").success).toBe(false);
    expect(sm.updateTaskStatus("A", "in_progress").success).toBe(true);
    expect(sm.updateTaskStatus("A", "auto_verified").success).toBe(true);
    expect(sm.updateTaskStatus("A", "done").success).toBe(true);

    expect(sm.getNextTask()?.id).toBe("B"); // A done -> B unblocked
  });

  it("rejects cancelled/superseded today (no such states pre-Phase-1)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress");
    // these statuses do not exist yet; transition must be rejected
    expect(sm.updateTaskStatus("A", "cancelled" as Task["status"]).success).toBe(false);
    expect(sm.updateTaskStatus("A", "superseded" as Task["status"]).success).toBe(false);
  });
});
