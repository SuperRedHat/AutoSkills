// PM-105 (Phase 1.5): migrate_tasks_schema v0->v1. Idempotent, status-preserving,
// log-kind backfill, additive progress, and lossless on real fixtures.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task, type ProjectInfo } from "../src/state";
import { tempCopyOfFixture } from "./helpers";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-mig-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}
function seedInfo(sm: StateManager): void {
  const info: ProjectInfo = {
    name: "t", created_at: "", updated_at: "", status: "in_progress",
    tech_stack: [], progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
  };
  sm.saveProjectInfo(info);
}

describe("migrate v0->v1", () => {
  it("preserves pre-existing cancelled status; initializes replacement_task_id; never mutates status", () => {
    const sm = new StateManager(emptyProject());
    seedInfo(sm);
    sm.createTasks([
      mkTask({ id: "A", status: "done" }),
      mkTask({ id: "C", status: "cancelled" }), // ClaudeX-like pre-existing data
      mkTask({ id: "T", status: "todo" }),
    ]);
    const before = sm.getAllTasks().map((t) => [t.id, t.status]);
    sm.migrateTaskSchema();
    expect(sm.getAllTasks().map((t) => [t.id, t.status])).toEqual(before); // zero status changes
    expect(sm.getTaskById("C")!.status).toBe("cancelled");
    expect(sm.getTaskById("A")!.replacement_task_id ?? null).toBeNull();
  });

  it("stamps schema_version=1 and is idempotent (second run skips)", () => {
    const sm = new StateManager(emptyProject());
    seedInfo(sm);
    sm.createTasks([mkTask({ id: "A", status: "done" })]);
    const r1 = sm.migrateTaskSchema();
    expect(r1.skipped).toBe(false);
    expect(r1.schema_version).toBe(1);
    expect(sm.getProjectInfo()!.schema_version).toBe(1);
    const r2 = sm.migrateTaskSchema();
    expect(r2.skipped).toBe(true);
    expect(r2.migrated).toBe(0);
  });

  it("backfills log kind/event_type by inference without touching the message", () => {
    const sm = new StateManager(emptyProject());
    seedInfo(sm);
    sm.addLog({ timestamp: "2026-01-01T00:00:00.000Z", type: "task_status_change", task_id: "A", from_status: "todo", to_status: "in_progress", message: "A todo -> in_progress" });
    sm.addLog({ timestamp: "2026-01-02T00:00:00.000Z", type: "milestone_gate", task_id: null, from_status: null, to_status: null, message: "gate" });
    sm.migrateTaskSchema();
    expect(sm.getLogs({ kind: "task_transition" }).some((l) => l.message === "A todo -> in_progress")).toBe(true);
    const gate = sm.getLogs({ event_type: "milestone_gate" })[0];
    expect(gate.kind).toBe("ops_event");
    expect(gate.event_type).toBe("milestone_gate");
    expect(gate.message).toBe("gate"); // message untouched
  });

  it("recomputes additive dual-rate progress on migration", () => {
    const sm = new StateManager(emptyProject());
    seedInfo(sm);
    sm.createTasks([mkTask({ id: "A", status: "done" }), mkTask({ id: "C", status: "cancelled" })]);
    sm.migrateTaskSchema();
    const p = sm.getProjectInfo()!.progress;
    expect(p.cancelled).toBe(1);
    expect(p.raw_completion_rate).toBeCloseTo(0.5);
    expect(p.active_completion_rate).toBe(1); // 1 done / 1 active
  });

  it("migrates the real CouncilFlow fixture losslessly (CJK intact, 100% stays raw=active=1, idempotent)", () => {
    const sm = new StateManager(tempCopyOfFixture("councilflow"));
    const beforeTitles = sm.getAllTasks().map((t) => t.title);
    const r = sm.migrateTaskSchema();
    expect(r.skipped).toBe(false);
    expect(r.migrated).toBe(114);
    expect(sm.getAllTasks().map((t) => t.title)).toEqual(beforeTitles); // CJK preserved, no corruption
    const p = sm.getProjectInfo()!.progress;
    expect(p.total).toBe(114);
    expect(p.done).toBe(114);
    expect(p.raw_completion_rate).toBe(1);
    expect(p.active_completion_rate).toBe(1);
    expect(sm.getProjectInfo()!.schema_version).toBe(1);
    expect(sm.migrateTaskSchema().skipped).toBe(true); // idempotent on real data
  });
});
