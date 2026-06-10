// PM-502 (v1.4.0): lint_state read-only consistency engine.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, type Task, type ProjectInfo } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-lint-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    commit_hash: "", notes: "", ...over,
  } as Task;
}
function seed(tasks: Task[], status: ProjectInfo["status"] = "in_progress"): StateManager {
  const sm = new StateManager(emptyProject());
  sm.saveProjectInfo({
    name: "t", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    status, tech_stack: [], progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
  });
  if (tasks.length) sm.createTasks(tasks);
  return sm;
}
/**
 * Seed by writing tasks.json directly — for corruption that create_tasks now
 * refuses to produce (duplicate/blank ids, PM-702). lint must still diagnose
 * these when they enter via hand-edits or legacy files.
 */
function seedFile(tasks: Task[], status: ProjectInfo["status"] = "in_progress"): StateManager {
  const dir = emptyProject();
  const sm = new StateManager(dir);
  sm.saveProjectInfo({
    name: "t", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    status, tech_stack: [], progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
  });
  const statePath = path.join(dir, ".claude", "state");
  fs.mkdirSync(statePath, { recursive: true });
  fs.writeFileSync(path.join(statePath, "tasks.json"), JSON.stringify({ tasks }, null, 2));
  return sm;
}
const codes = (sm: StateManager, o?: { crossProject?: boolean }) =>
  sm.lintState(o).findings.map((f) => f.code);

describe("lint_state", () => {
  it("a well-formed, migrated project has no error/warning findings", () => {
    const sm = seed([mkTask({ id: "A" }), mkTask({ id: "B", status: "done" })]);
    sm.migrateTaskSchema();
    const r = sm.lintState();
    expect(r.summary.error).toBe(0);
    expect(r.summary.warning).toBe(0);
  });

  it("progress_drift: actual project.json.progress != recompute (autofixable)", () => {
    const sm = seed([mkTask({ id: "A" }), mkTask({ id: "B", status: "done" })]);
    const info = sm.getProjectInfo()!;
    info.progress.done = 99; // hand-corrupt
    sm.saveProjectInfo(info);
    const f = sm.lintState().findings.find((x) => x.code === "progress_drift");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("error");
    expect(f!.autofixable).toBe(true);
    expect((f!.entities as { drifted_fields: { field: string }[] }).drifted_fields.map((d) => d.field)).toContain("done");
  });

  it("dangling_dependency: active task depends on a non-existent id", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["ZZZ"] })]);
    expect(codes(sm)).toContain("dangling_dependency");
  });

  it("self_dependency: flagged as error + autofixable", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["A"] })]);
    const f = sm.lintState().findings.find((x) => x.code === "self_dependency");
    expect(f?.severity).toBe("error");
    expect(f?.autofixable).toBe(true);
  });

  it("dependency_cycle: A<->B reported once", () => {
    const sm = seed([mkTask({ id: "A", dependencies: ["B"] }), mkTask({ id: "B", dependencies: ["A"] })]);
    const cy = sm.lintState().findings.filter((x) => x.code === "dependency_cycle");
    expect(cy.length).toBe(1);
  });

  it("duplicate_task_id: two tasks share an id", () => {
    // create_tasks rejects duplicates since PM-702, so seed the corruption at
    // the file level (hand-edit / legacy data path).
    const sm = seedFile([mkTask({ id: "A" }), mkTask({ id: "A", title: "dup" })]);
    expect(codes(sm)).toContain("duplicate_task_id");
  });

  it("unknown_status_value: status outside the 7-value set", () => {
    const sm = seed([mkTask({ id: "A", status: "blocked" as Task["status"] })]);
    expect(codes(sm)).toContain("unknown_status_value");
  });

  it("superseded_missing_replacement: error once migrated to v1", () => {
    const sm = seed([mkTask({ id: "A", status: "superseded" })]);
    sm.migrateTaskSchema();
    const f = sm.lintState().findings.find((x) => x.code === "superseded_missing_replacement");
    expect(f?.severity).toBe("error");
  });

  it("replacement_target_missing + replacement_chain_cycle", () => {
    const missing = seed([mkTask({ id: "A", status: "superseded", replacement_task_id: "ZZZ" })]);
    expect(codes(missing)).toContain("replacement_target_missing");

    const cyc = seed([
      mkTask({ id: "A", status: "superseded", replacement_task_id: "B" }),
      mkTask({ id: "B", status: "superseded", replacement_task_id: "A" }),
    ]);
    expect(codes(cyc)).toContain("replacement_chain_cycle");
  });

  it("stale_replacement_on_nonsuperseded: replacement set on a todo task", () => {
    const sm = seed([mkTask({ id: "A", replacement_task_id: "B" }), mkTask({ id: "B" })]);
    expect(codes(sm)).toContain("stale_replacement_on_nonsuperseded");
  });

  it("project_status_vs_tasks_inconsistent: completed but open work remains", () => {
    const sm = seed([mkTask({ id: "A" })], "completed");
    expect(codes(sm)).toContain("project_status_vs_tasks_inconsistent");
  });

  it("acceptance_fields_internal_contradiction: manual mode but needs_manual_review=false", () => {
    const sm = seed([mkTask({ id: "A", acceptance_mode: "manual", needs_manual_review: false })]);
    expect(codes(sm)).toContain("acceptance_fields_internal_contradiction");
  });

  it("healthy superseded->done chain is NOT an error (husk is info only)", () => {
    const sm = seed([
      mkTask({ id: "A", status: "done" }),
      mkTask({ id: "B", status: "superseded", replacement_task_id: "A" }),
      mkTask({ id: "C", dependencies: ["B"] }),
    ]);
    sm.migrateTaskSchema();
    const r = sm.lintState();
    // C->B(superseded)->A(done) resolves: no dependency error on C
    expect(r.findings.some((f) => f.code === "dangling_dependency")).toBe(false);
    expect(r.findings.some((f) => f.code === "superseded_replacement_chain_broken")).toBe(false);
    expect(r.findings.some((f) => f.code === "dep_on_superseded_husk_not_rewired" && f.severity === "info")).toBe(true);
  });

  it("cross-project lint suppresses machine-local checks (schema/profile)", () => {
    const sm = seed([mkTask({ id: "A" })]); // schema_version 0 (un-migrated)
    expect(codes(sm)).toContain("schema_version_behind");
    expect(codes(sm, { crossProject: true })).not.toContain("schema_version_behind");
  });

  // ---- review-driven regression guards (v1.4.0 triage) ----

  it("superseded chain ending on an ACTIVE replacement is pending, not broken", () => {
    const sm = seed([
      mkTask({ id: "A", status: "superseded", replacement_task_id: "B" }),
      mkTask({ id: "B", status: "in_progress" }),
      mkTask({ id: "C", dependencies: ["A"] }),
    ]);
    sm.migrateTaskSchema();
    expect(codes(sm)).not.toContain("superseded_replacement_chain_broken");
  });

  it("a dependency cycle among already-DONE tasks is NOT flagged (frozen, not a deadlock)", () => {
    const sm = seed([
      mkTask({ id: "A", status: "done", dependencies: ["B"] }),
      mkTask({ id: "B", status: "done", dependencies: ["A"] }),
    ]);
    expect(codes(sm)).not.toContain("dependency_cycle");
  });

  it("self_dependency on a terminal task is reported but NOT autofixable", () => {
    const sm = seed([mkTask({ id: "A", status: "done", dependencies: ["A"] })]);
    const f = sm.lintState().findings.find((x) => x.code === "self_dependency");
    expect(f?.severity).toBe("error");
    expect(f?.autofixable).toBe(false);
  });

  it("a blank task id is reported as blank_task_id, not duplicate_task_id", () => {
    // create_tasks rejects blank ids since PM-702; seed at the file level.
    const sm = seedFile([mkTask({ id: "   " })]);
    const c = codes(sm);
    expect(c).toContain("blank_task_id");
    expect(c).not.toContain("duplicate_task_id");
  });
});
