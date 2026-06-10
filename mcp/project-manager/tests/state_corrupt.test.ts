// PM-703: state-file corruption handling + atomic writes.
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager, StateFileCorruptError, type Task } from "../src/state";

function emptyProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pm-corrupt-"));
}
function mkTask(over: Partial<Task>): Task {
  return {
    id: "X", title: "t", description: "d", dependencies: [], complexity: "S",
    acceptance_criteria: [], files: [], module: "m", needs_manual_review: false,
    status: "todo", created_at: "", updated_at: "", commit_hash: "", notes: "", ...over,
  } as Task;
}
const stateFile = (dir: string, name: string) => path.join(dir, ".claude", "state", name);

describe("state file corruption (PM-703)", () => {
  it("readJSON surfaces a structured StateFileCorruptError naming the file", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A" })]);
    fs.writeFileSync(stateFile(dir, "tasks.json"), '{"tasks": [tru'); // truncated
    expect(() => sm.getTaskById("A")).toThrow(StateFileCorruptError);
    expect(() => sm.getTaskById("A")).toThrow(/tasks\.json/);
  });

  it("mis-shaped tasks.json (no tasks array) is corrupt, not silently empty", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A" })]);
    fs.writeFileSync(stateFile(dir, "tasks.json"), '{"wrong": true}');
    expect(() => sm.getTaskById("A")).toThrow(/top-level shape/);
  });

  it("lint_state reports state_file_corrupt instead of dying on it", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A" })]);
    fs.writeFileSync(stateFile(dir, "tasks.json"), "not json at all");
    const r = sm.lintState();
    const f = r.findings.filter((x) => x.code === "state_file_corrupt");
    expect(f.length).toBe(1); // deduped (raw + normalized read both fail)
    expect(f[0].severity).toBe("error");
    expect((f[0].entities as { file: string }).file).toBe("tasks.json");
    expect(r.summary.error).toBeGreaterThanOrEqual(1);
  });

  it("lint_state still lints tasks when only logs.json is corrupt", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A", dependencies: ["GHOST"] })]);
    fs.writeFileSync(stateFile(dir, "logs.json"), "{broken");
    const r = sm.lintState();
    const codes = r.findings.map((x) => x.code);
    expect(codes).toContain("state_file_corrupt"); // logs.json reported
    expect(codes).toContain("dangling_dependency"); // tasks still linted
  });

  it("updateTaskStatus fails BEFORE writing tasks.json when logs.json is corrupt (no half-apply)", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress"); // creates logs.json
    fs.writeFileSync(stateFile(dir, "logs.json"), "{boom");
    const before = fs.readFileSync(stateFile(dir, "tasks.json"), "utf-8");

    expect(() => sm.updateTaskStatus("A", "auto_verified")).toThrow(StateFileCorruptError);
    // The transition must NOT have been half-applied to tasks.json.
    expect(fs.readFileSync(stateFile(dir, "tasks.json"), "utf-8")).toBe(before);
    // After restoring logs.json, the SAME transition still succeeds (no
    // confusing "Invalid transition: X → X" from a half-applied first try).
    fs.writeFileSync(stateFile(dir, "logs.json"), '{"logs": []}');
    expect(sm.updateTaskStatus("A", "auto_verified").success).toBe(true);
  });

  it("writes are atomic: no .tmp leftovers, content lands complete", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A" })]);
    sm.updateTaskStatus("A", "in_progress");
    const stateDir = path.join(dir, ".claude", "state");
    const leftovers = fs.readdirSync(stateDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(fs.readFileSync(stateFile(dir, "tasks.json"), "utf-8")).tasks[0].status).toBe("in_progress");
  });

  it("mis-shaped logs.json is reported with the file name", () => {
    const dir = emptyProject();
    const sm = new StateManager(dir);
    sm.createTasks([mkTask({ id: "A" })]);
    fs.writeFileSync(stateFile(dir, "logs.json"), '{"nope": 1}');
    expect(() => sm.getLogs()).toThrow(/logs\.json/);
  });
});
