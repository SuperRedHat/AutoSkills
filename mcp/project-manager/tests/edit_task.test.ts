// PM-501 (v1.4.0): edit_task — metadata patch that never touches status.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task } from "../src/state";
import { loadProfileNames } from "../src/profiles";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-edit-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}

describe("edit_task", () => {
  it("rejects a non-existent task and an empty patch", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    expect(sm.editTask("ZZZ", { notes: "x" }).success).toBe(false);
    expect(sm.editTask("A", {}).success).toBe(false);
  });

  it("patches documentation fields without changing status, and bumps updated_at", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress");
    const before = sm.getTaskById("A")!;

    const r = sm.editTask("A", { title: "new title", notes: "fixed note", files: ["a.ts"] });
    expect(r.success).toBe(true);
    expect(r.changed_fields?.sort()).toEqual(["files", "notes", "title"]);

    const a = sm.getTaskById("A")!;
    expect(a.status).toBe("in_progress"); // untouched
    expect(a.title).toBe("new title");
    expect(a.notes).toBe("fixed note");
    expect(a.files).toEqual(["a.ts"]);
    expect(a.created_at).toBe(before.created_at); // immutable
    expect(a.updated_at).not.toBe(before.updated_at); // stamped
  });

  it("rejects forbidden / audit-only fields explicitly", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    for (const bad of [
      { status: "done" },
      { id: "B" },
      { created_at: "2020" },
      { commit_hash: "deadbeef" },
      { replacement_task_id: "B" },
      { closed_at: "2020" },
      { close_reason: "x" },
    ]) {
      const r = sm.editTask("A", bad as never);
      expect(r.success, JSON.stringify(bad)).toBe(false);
    }
    expect(sm.getTaskById("A")!.status).toBe("todo");
  });

  it("title must be non-empty; complexity/acceptance_mode are enum-validated", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    expect(sm.editTask("A", { title: "   " }).success).toBe(false);
    expect(sm.editTask("A", { complexity: "XL" as never }).success).toBe(false);
    expect(sm.editTask("A", { acceptance_mode: "sometimes" as never }).success).toBe(false);
  });

  it("E2: editing acceptance_mode re-derives needs_manual_review", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", needs_manual_review: false })]); // auto

    sm.editTask("A", { acceptance_mode: "manual" });
    let a = sm.getTaskById("A")!;
    expect(a.acceptance_mode).toBe("manual");
    expect(a.needs_manual_review).toBe(true);

    sm.editTask("A", { acceptance_mode: "auto" });
    a = sm.getTaskById("A")!;
    expect(a.needs_manual_review).toBe(false);
  });

  it("E2: a contradictory acceptance pair is rejected; coherent pair accepted", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    expect(sm.editTask("A", { acceptance_mode: "manual", needs_manual_review: false }).success).toBe(false);
    expect(sm.editTask("A", { acceptance_mode: "manual", needs_manual_review: true }).success).toBe(true);
  });

  it("E2: editing only needs_manual_review preserves milestone_manual when still consistent", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", acceptance_mode: "milestone_manual", needs_manual_review: true })]);
    // needs_manual_review stays true => consistent with milestone_manual => mode preserved
    sm.editTask("A", { needs_manual_review: true });
    expect(sm.getTaskById("A")!.acceptance_mode).toBe("milestone_manual");
    // flipping to false contradicts milestone_manual => realign to auto
    sm.editTask("A", { needs_manual_review: false });
    expect(sm.getTaskById("A")!.acceptance_mode).toBe("auto");
  });

  it("E3: dependency edit rejects self / dangling / cycle and dedupes", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([
      mkTask({ id: "A" }),
      mkTask({ id: "B" }),
      mkTask({ id: "C", dependencies: ["A"] }),
    ]);
    expect(sm.editTask("A", { dependencies: ["A"] }).success).toBe(false); // self
    expect(sm.editTask("A", { dependencies: ["ZZZ"] }).success).toBe(false); // dangling
    // C depends on A; making A depend on C would cycle A->C->A
    expect(sm.editTask("A", { dependencies: ["C"] }).success).toBe(false);
    // valid + duplicates collapsed
    const r = sm.editTask("A", { dependencies: ["B", "B"] });
    expect(r.success).toBe(true);
    expect(sm.getTaskById("A")!.dependencies).toEqual(["B"]);
  });

  it("terminal tasks: doc fields editable, flow/gate fields rejected", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", status: "done" }), mkTask({ id: "B" })]);
    expect(sm.editTask("A", { notes: "postmortem" }).success).toBe(true);
    expect(sm.getTaskById("A")!.notes).toBe("postmortem");
    expect(sm.editTask("A", { dependencies: ["B"] }).success).toBe(false);
    expect(sm.editTask("A", { acceptance_mode: "manual" }).success).toBe(false);
  });

  it("no-op patch: skips write and writes no audit log", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", title: "same" })]);
    const r = sm.editTask("A", { title: "same" });
    expect(r.success).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.changed_fields).toEqual([]);
    expect(sm.getLogs({ event_type: "task_edited" }).length).toBe(0);
  });

  it("writes a task_edited audit log with per-field from->to", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", title: "old" })]);
    sm.editTask("A", { title: "brand new" });
    const log = sm.getLogs({ event_type: "task_edited" })[0];
    expect(log).toBeTruthy();
    expect(log.kind).toBe("ops_event");
    expect(log.source).toBe("edit_task");
    expect(log.task_id).toBe("A");
    const changes = (log.entities as { changes: { field: string; from: unknown; to: unknown }[] }).changes;
    expect(changes).toContainEqual({ field: "title", from: "old", to: "brand new" });
  });

  it("editing metadata does not change project progress counts", () => {
    const sm = new StateManager(emptyProject());
    sm.saveProjectInfo({
      name: "t", created_at: "", updated_at: "", status: "in_progress",
      tech_stack: [], progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
    });
    sm.createTasks([mkTask({ id: "A" }), mkTask({ id: "B", status: "todo" })]);
    const before = sm.getProjectInfo()!.progress;
    sm.editTask("A", { title: "x", description: "y" });
    expect(sm.getProjectInfo()!.progress).toEqual(before);
  });

  it("E2 audit: derived needs_manual_review appears in changed_fields and the audit log", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A", needs_manual_review: false })]); // auto
    const r = sm.editTask("A", { acceptance_mode: "manual" });
    expect(r.changed_fields?.sort()).toEqual(["acceptance_mode", "needs_manual_review"]);
    const log = sm.getLogs({ event_type: "task_edited" })[0];
    const changes = (log.entities as { changes: { field: string; from: unknown; to: unknown }[] }).changes;
    expect(changes).toContainEqual({ field: "needs_manual_review", from: false, to: true });
  });

  it("array fields must be arrays (direct caller)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    expect(sm.editTask("A", { files: "x.ts" as never }).success).toBe(false);
    expect(sm.editTask("A", { verification_commands: "npm test" as never }).success).toBe(false);
  });

  it("verification_profile is validated against the external policy (when present)", () => {
    const sm = new StateManager(emptyProject());
    sm.createTasks([mkTask({ id: "A" })]);
    // Only assert rejection when the machine actually has a policy file with profiles;
    // findUnknownProfiles is lenient (flags nothing) when the file is missing.
    if (loadProfileNames().length > 0) {
      expect(sm.editTask("A", { verification_profile: "__definitely_not_a_real_profile__" }).success).toBe(false);
    } else {
      expect(sm.editTask("A", { verification_profile: "anything" }).success).toBe(true);
    }
  });
});
