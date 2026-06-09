import * as fs from "fs";
import * as path from "path";
import { findUnknownProfiles, loadProfileNames } from "./profiles.js";
import { runLint, type LintResult, type Finding } from "./lint.js";

// ---------- Types ----------

export type AcceptanceMode = "auto" | "manual" | "milestone_manual";
// Profile NAMES are defined externally in
// ~/.workflow-core/policies/verification-profiles.json (validated at runtime via
// src/profiles.ts) — adding a profile needs no code change. Canonical names today:
// backend | frontend_unit | frontend_browser | frontend_visual | docs | workflow_meta.
export type VerificationProfile = string;

export interface ProjectInfo {
  name: string;
  created_at: string;
  updated_at: string;
  status: "initialized" | "designed" | "planned" | "in_progress" | "completed";
  tech_stack: string[];
  schema_version?: number;
  progress: {
    // legacy keys (semantics unchanged; old readers/old dist keep working):
    total: number;
    done: number;
    in_progress: number;
    awaiting_acceptance: number;
    todo: number;
    // additive dual-rate fields (D4; optional so pre-migration project.json still reads):
    total_all?: number;
    active_total?: number;
    cancelled?: number;
    superseded?: number;
    closed_total?: number;
    raw_completion_rate?: number;
    active_completion_rate?: number;
  };
}

export interface Task {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  complexity: "S" | "M" | "L";
  acceptance_criteria: string[];
  files: string[];
  module: string;
  needs_manual_review: boolean;
  acceptance_mode?: AcceptanceMode;
  verification_profile?: VerificationProfile;
  verification_commands?: string[];
  review_checklist?: string[];
  stage_gate?: boolean;
  status:
    | "todo"
    | "in_progress"
    | "auto_verified"
    | "awaiting_manual_acceptance"
    | "done"
    | "cancelled"
    | "superseded";
  created_at: string;
  updated_at: string;
  commit_hash: string;
  notes: string;
  priority?: number;
  // Phase 1 close_task fields (set only via the audited close_task bypass):
  replacement_task_id?: string | null;
  closed_at?: string | null;
  close_reason?: string | null;
}

export interface TasksData {
  tasks: Task[];
}

export type LogKind =
  | "task_transition"
  | "ops_event"
  | "decision"
  | "note"
  | "workflow_failure"
  | "focus_update";

export interface LogEntry {
  timestamp: string;
  type: string;
  task_id: string | null;
  from_status: string | null;
  to_status: string | null;
  message: string;
  // Phase 0.4 additive fields (all optional; pre-existing entries infer kind on read):
  kind?: LogKind;
  event_type?: string | null;
  tags?: string[];
  entities?: Record<string, unknown>;
  source?: string | null;
}

export interface LogsData {
  logs: LogEntry[];
}

// ---------- ops / context types (Phase 0) ----------

export type ContextMode = "build" | "ops" | "hybrid";

export interface CurrentFocus {
  schema_version: number;
  summary: string;
  last_event: string | null;
  next_trigger: string | null;
  waiting_on: string[];
  related_task_ids: string[];
  related_entities: Record<string, unknown>;
  source: string | null;
  updated_at: string;
  stale_after: string | null;
}

export interface ProgressMetrics {
  total_all: number;
  active_total: number;
  done: number;
  cancelled: number;
  superseded: number;
  closed_total: number;
  raw_completion_rate: number;
  active_completion_rate: number;
}

export type NextTaskBlockedReason =
  | "none"
  | "all_done"
  | "blocked_in_progress"
  | "blocked_by_cancelled_dep";

export interface GetProjectContextOptions {
  context_mode?: ContextMode;
  max_recent_events?: number;
  include_full_in_progress?: boolean;
}

// Presentation hint only (D1): governs the SUGGESTED section order for a
// consumer; it never filters/permissions/branches the underlying data.
const PRESENTATION_ORDER: Record<ContextMode, string[]> = {
  build: ["next_task", "in_progress_tasks", "tasks_summary", "current_focus", "recent_logs"],
  ops: ["current_focus", "recent_logs", "in_progress_tasks", "next_task", "tasks_summary"],
  hybrid: ["current_focus", "next_task", "in_progress_tasks", "recent_logs", "tasks_summary"],
};

// Maps legacy free-text `type` values to the coarse `kind` discriminator (G4),
// so the 9 real production log types keep their semantics under the 6-value enum.
const KIND_BY_TYPE: Record<string, LogKind> = {
  task_status_change: "task_transition",
  decision: "decision",
  workflow_failure: "workflow_failure",
  focus_update: "focus_update",
  review_completed: "ops_event",
  milestone_gate: "ops_event",
  phase_change: "ops_event",
  manual_acceptance: "ops_event",
  qa: "ops_event",
  smoke_results: "ops_event",
  followup_needed: "ops_event",
};

function inferKind(type: string): LogKind {
  return KIND_BY_TYPE[type] ?? "note";
}

/** On-disk schema version stamped on project.json after migration (G3). */
const CURRENT_SCHEMA_VERSION = 1;

// ---------- Valid state transitions ----------

const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ["in_progress"],
  in_progress: ["auto_verified"],
  auto_verified: ["done", "awaiting_manual_acceptance"],
  awaiting_manual_acceptance: ["done", "in_progress"],
  // Terminal states. cancelled/superseded are reachable ONLY via close_task
  // (the audited management bypass), never through updateTaskStatus, and have
  // no outbound edges — same terminal discipline as `done`.
  cancelled: [],
  superseded: [],
  done: [],
};

// ---------- edit_task field policy (ADR-004 §2.1) ----------

// Pure-documentation fields: no state-machine / DAG invariant depends on them, so
// they are editable even on a TERMINAL task (the "fix a note on a done task" case).
const DOC_FIELDS = [
  "title",
  "description",
  "notes",
  "acceptance_criteria",
  "review_checklist",
  "files",
] as const;

// Editable but flow/gate/DAG-relevant: only on ACTIVE (non-terminal) tasks.
const NON_DOC_EDITABLE_FIELDS = [
  "dependencies",
  "complexity",
  "module",
  "acceptance_mode",
  "needs_manual_review",
  "stage_gate",
  "verification_profile",
  "verification_commands",
] as const;

const EDITABLE_FIELDS: readonly string[] = [...DOC_FIELDS, ...NON_DOC_EDITABLE_FIELDS];

/** The metadata patch edit_task accepts (status / id / timestamps / audit-bypass fields excluded). */
export type TaskEditPatch = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "notes"
    | "acceptance_criteria"
    | "review_checklist"
    | "files"
    | "dependencies"
    | "complexity"
    | "module"
    | "acceptance_mode"
    | "needs_manual_review"
    | "stage_gate"
    | "verification_profile"
    | "verification_commands"
  >
>;

// ---------- State Manager ----------

export class StateManager {
  private stateDir: string;

  constructor(projectDir: string) {
    this.stateDir = path.join(projectDir, ".claude", "state");
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
  }

  private filePath(name: string): string {
    return path.join(this.stateDir, name);
  }

  private readJSON<T>(name: string): T | null {
    const p = this.filePath(name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  }

  private writeJSON<T>(name: string, data: T): void {
    this.ensureDir();
    fs.writeFileSync(this.filePath(name), JSON.stringify(data, null, 2), "utf-8");
  }

  private readMD(name: string): string | null {
    const p = this.filePath(name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8");
  }

  private writeMD(name: string, content: string): void {
    this.ensureDir();
    fs.writeFileSync(this.filePath(name), content, "utf-8");
  }

  // ---------- Project ----------

  getProjectInfo(): ProjectInfo | null {
    return this.readJSON<ProjectInfo>("project.json");
  }

  saveProjectInfo(info: ProjectInfo): void {
    info.updated_at = new Date().toISOString();
    this.writeJSON("project.json", info);
  }

  /**
   * Build the canonical progress object from tasks WITHOUT persisting. Single source
   * of truth for both the writer (updateProjectProgress) and the read-only drift check
   * (lint_state's progress_drift) — so "expected" can never disagree with what a real
   * write would have produced.
   */
  computeProgressObject(tasks: Task[]): ProjectInfo["progress"] {
    const metrics = this.computeProgressMetrics(tasks);
    return {
      // legacy keys — semantics unchanged (in_progress still counts auto_verified):
      total: tasks.length,
      done: metrics.done,
      in_progress: tasks.filter(
        (x) => x.status === "in_progress" || x.status === "auto_verified"
      ).length,
      awaiting_acceptance: tasks.filter((x) => x.status === "awaiting_manual_acceptance").length,
      todo: tasks.filter((x) => x.status === "todo").length,
      // additive dual-rate fields (D4):
      total_all: metrics.total_all,
      active_total: metrics.active_total,
      cancelled: metrics.cancelled,
      superseded: metrics.superseded,
      closed_total: metrics.closed_total,
      raw_completion_rate: metrics.raw_completion_rate,
      active_completion_rate: metrics.active_completion_rate,
    };
  }

  updateProjectProgress(): void {
    const info = this.getProjectInfo();
    const tasks = this.getTasks();
    if (!info || !tasks) return;
    info.progress = this.computeProgressObject(tasks.tasks);
    this.saveProjectInfo(info);
  }

  // ---------- PRD ----------

  getPRD(): string | null {
    return this.readMD("prd.md");
  }

  savePRD(content: string): void {
    this.writeMD("prd.md", content);
  }

  // ---------- Architecture ----------

  getArchitecture(): string | null {
    return this.readMD("architecture.md");
  }

  saveArchitecture(content: string): void {
    this.writeMD("architecture.md", content);
  }

  // ---------- Tasks ----------

  getTasks(): TasksData | null {
    const data = this.readJSON<TasksData>("tasks.json");
    if (!data) return null;
    return {
      tasks: data.tasks.map((task) => this.normalizeTask(task)),
    };
  }

  saveTasks(data: TasksData): void {
    this.writeJSON("tasks.json", data);
  }

  createTasks(tasks: Task[]): { created: number } {
    const now = new Date().toISOString();
    const data = this.getTasks() || { tasks: [] };

    for (const task of tasks) {
      task.created_at = task.created_at || now;
      task.updated_at = task.updated_at || now;
      task.status = task.status || "todo";
      task.commit_hash = task.commit_hash || "";
      task.notes = task.notes || "";
      data.tasks.push(this.normalizeTask(task));
    }

    this.saveTasks(data);
    this.updateProjectProgress();
    return { created: tasks.length };
  }

  getNextTask(): Task | null {
    const data = this.getTasks();
    if (!data) return null;

    const byId = new Map(data.tasks.map((t) => [t.id, t]));

    // A dependency is satisfied iff it is `done`, OR it is `superseded` and its
    // replacement chain terminates in a `done` task (defensive backstop —
    // close_task already rewrites dependents, but hand-edited/legacy data may
    // still point at a superseded id). A `cancelled` dep is NOT satisfied, so
    // its dependents are correctly held back (and surfaced via close_task's
    // ops_event + next_task_blocked_reason) rather than silently run.
    const depSatisfied = (depId: string): boolean => {
      const seen = new Set<string>();
      let cur: string | null | undefined = depId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const dt = byId.get(cur);
        if (!dt) return false;
        if (dt.status === "done") return true;
        if (dt.status === "superseded" && dt.replacement_task_id) {
          cur = dt.replacement_task_id;
          continue;
        }
        return false;
      }
      return false;
    };

    const runnable = data.tasks.filter(
      (t) => t.status === "todo" && t.dependencies.every(depSatisfied)
    );
    if (runnable.length === 0) return null;
    // Highest priority wins; ties keep creation (array) order — a strict `>` in
    // reduce keeps the earlier element on equality (stable, = legacy behavior).
    return runnable.reduce((best, t) =>
      (t.priority ?? 0) > (best.priority ?? 0) ? t : best
    );
  }

  setTaskPriority(id: string, priority: number): { success: boolean; error?: string } {
    const data = this.getTasks();
    if (!data) return { success: false, error: "No tasks found" };
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return { success: false, error: `Task ${id} not found` };
    const old = task.priority ?? 0;
    task.priority = priority;
    task.updated_at = new Date().toISOString();
    this.saveTasks(data);
    this.addLog({
      timestamp: task.updated_at,
      type: "priority_change",
      kind: "ops_event",
      event_type: "priority_change",
      task_id: id,
      from_status: null,
      to_status: null,
      entities: { from: old, to: priority },
      source: "set_task_priority",
      message: `${id} priority ${old} → ${priority}`,
    });
    return { success: true };
  }

  /**
   * edit_task (ADR-004 §2): partial metadata patch that NEVER touches status.
   * Only whitelisted metadata fields are writable; status / id / timestamps and the
   * audit-bypass fields (replacement_task_id / closed_at / close_reason / commit_hash)
   * are rejected. Validates the whole patch atomically before writing, keeps
   * acceptance_mode <-> needs_manual_review coherent (acceptance_mode is the source of
   * truth), guards dependency edits (existence / no self / no cycle / dedupe), and
   * writes a task_edited audit log. A no-op patch (every value already current) skips
   * both the write and the log. Does NOT call updateProjectProgress (metadata edits
   * never change status counts — same as set_task_priority).
   */
  editTask(
    id: string,
    patch: TaskEditPatch
  ): {
    success: boolean;
    error?: string;
    task_id?: string;
    changed_fields?: string[];
    noop?: boolean;
  } {
    const data = this.getTasks();
    if (!data) return { success: false, error: "No tasks found" };
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return { success: false, error: `Task ${id} not found` };

    const prepared = this.prepareTaskEdit(task, patch, data.tasks);
    if (!prepared.success) return { success: false, error: prepared.error };

    // No-op patch (every resolved value already current): skip the write and the log.
    if (prepared.changes.length === 0) {
      return { success: true, task_id: id, changed_fields: [], noop: true };
    }

    // ----- apply atomically + audit -----
    this.applyPreparedTaskEdit(task, prepared.changes);
    this.saveTasks(data);

    this.addLog({
      timestamp: task.updated_at,
      type: "task_edited",
      kind: "ops_event",
      event_type: "task_edited",
      task_id: id,
      from_status: null,
      to_status: null,
      entities: { changes: prepared.changes },
      source: "edit_task",
      message: `${id} edited: ${prepared.changes.map((c) => c.field).join(", ")}`,
    });

    return { success: true, task_id: id, changed_fields: prepared.changes.map((c) => c.field) };
  }

  /**
   * Validate an edit patch against a task and compute the resulting field changes,
   * WITHOUT mutating, saving, or logging. Pure decision logic shared by edit_task and
   * the edit_tasks batch: field whitelist (14 editable keys), terminal-task doc-only
   * rule, per-field type/enum checks, E2 acceptance_mode<->needs_manual_review coupling,
   * E3 dependency existence/self/cycle/dedupe, and the final diff. Returns an error OR
   * the changes array (empty array = no-op). `allTasks` is the full task set used for
   * dependency existence / cycle checks.
   */
  private prepareTaskEdit(
    task: Task,
    patch: TaskEditPatch,
    allTasks: Task[]
  ):
    | { success: false; error: string }
    | { success: true; changes: { field: string; from: unknown; to: unknown }[] } {
    const p = patch as Record<string, unknown>;
    const provided = Object.keys(p).filter((k) => p[k] !== undefined);

    // Reject forbidden/unknown keys explicitly (never silently drop) so a caller
    // cannot mistake an ignored `status`/`id` for an applied change.
    const forbidden = provided.filter((k) => !EDITABLE_FIELDS.includes(k));
    if (forbidden.length) {
      return {
        success: false,
        error: `edit_task cannot change: ${forbidden.join(", ")}. Route status -> update_task_status/close_task/reopen_task; id/created_at/updated_at/commit_hash/replacement_task_id/closed_at/close_reason are not editable.`,
      };
    }
    if (provided.length === 0) {
      return { success: false, error: "edit_task requires at least one field to change." };
    }

    // Terminal tasks: only pure-documentation fields (no gate/flow/DAG fields).
    const isTerminal = ["done", "cancelled", "superseded"].includes(task.status);
    if (isTerminal) {
      const blocked = provided.filter((k) => !(DOC_FIELDS as readonly string[]).includes(k));
      if (blocked.length) {
        return {
          success: false,
          error: `Task ${task.id} is terminal (${task.status}); only documentation fields (${DOC_FIELDS.join(", ")}) are editable on a closed task. Rejected: ${blocked.join(", ")}.`,
        };
      }
    }

    // ----- per-field validation (all-or-nothing: nothing is written until all pass) -----
    // Array-typed fields must be arrays (defensive for direct callers; the MCP Zod layer
    // already enforces this for tool calls). dependencies has its own deeper checks below.
    for (const af of ["acceptance_criteria", "review_checklist", "files", "verification_commands"]) {
      if (provided.includes(af) && !Array.isArray(p[af])) {
        return { success: false, error: `${af} must be an array of strings.` };
      }
    }
    if (provided.includes("title") && (typeof patch.title !== "string" || !patch.title.trim())) {
      return { success: false, error: "title must be a non-empty string." };
    }
    if (provided.includes("module") && (typeof patch.module !== "string" || !patch.module.trim())) {
      return { success: false, error: "module must be a non-empty string." };
    }
    if (provided.includes("complexity") && !["S", "M", "L"].includes(patch.complexity as string)) {
      return { success: false, error: "complexity must be one of S | M | L." };
    }
    if (
      provided.includes("acceptance_mode") &&
      !["auto", "manual", "milestone_manual"].includes(patch.acceptance_mode as string)
    ) {
      return {
        success: false,
        error: "acceptance_mode must be one of auto | manual | milestone_manual.",
      };
    }
    // E2: an explicit (acceptance_mode, needs_manual_review) pair must not contradict.
    if (provided.includes("acceptance_mode") && provided.includes("needs_manual_review")) {
      const expected = patch.acceptance_mode !== "auto";
      if (patch.needs_manual_review !== expected) {
        return {
          success: false,
          error: `Contradictory acceptance pair: acceptance_mode=${patch.acceptance_mode} implies needs_manual_review=${expected}, got ${patch.needs_manual_review}.`,
        };
      }
    }
    // verification_profile validated against the external policy (parity with create_tasks;
    // lenient when the policy file is missing — findUnknownProfiles returns []).
    if (provided.includes("verification_profile") && patch.verification_profile) {
      const { unknown, valid } = findUnknownProfiles([patch.verification_profile]);
      if (unknown.length) {
        return {
          success: false,
          error: `unknown verification_profile "${unknown[0]}". Valid: ${valid.join(", ")}. (Add it to ~/.workflow-core/policies/verification-profiles.json — no code change needed.)`,
        };
      }
    }
    // E3: dependency edit — existence + no self + no cycle + dedupe (atomic reject).
    let normalizedDeps: string[] | undefined;
    if (provided.includes("dependencies")) {
      if (!Array.isArray(patch.dependencies)) {
        return { success: false, error: "dependencies must be an array of task ids." };
      }
      normalizedDeps = [...new Set(patch.dependencies)];
      if (normalizedDeps.includes(task.id)) {
        return { success: false, error: `dependencies cannot include the task itself (${task.id}).` };
      }
      const byId = new Map(allTasks.map((t) => [t.id, t]));
      const missing = normalizedDeps.filter((d) => !byId.has(d));
      if (missing.length) {
        return {
          success: false,
          error: `dependencies reference unknown task(s): ${missing.join(", ")}.`,
        };
      }
      // Adding edge id->d closes a cycle iff d can already reach id via dependencies.
      const reaches = (from: string, target: string): boolean => {
        const seen = new Set<string>();
        const stack = [from];
        while (stack.length) {
          const cur = stack.pop()!;
          if (cur === target) return true;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const t = byId.get(cur);
          if (t) for (const dd of t.dependencies) stack.push(dd);
        }
        return false;
      };
      const cyclic = normalizedDeps.filter((d) => reaches(d, task.id));
      if (cyclic.length) {
        return {
          success: false,
          error: `dependency edit would create a cycle through: ${cyclic.join(", ")}.`,
        };
      }
    }

    // ----- resolve final values, with acceptance coupling realign (E2) -----
    const next: Record<string, unknown> = {};
    for (const k of provided) next[k] = k === "dependencies" ? normalizedDeps : p[k];
    if (provided.includes("acceptance_mode")) {
      // acceptance_mode is source of truth: keep needs_manual_review in lockstep.
      next.needs_manual_review = patch.acceptance_mode !== "auto";
    } else if (provided.includes("needs_manual_review")) {
      const curMode = task.acceptance_mode ?? (task.needs_manual_review ? "manual" : "auto");
      const consistent = patch.needs_manual_review === (curMode !== "auto");
      // Only realign mode when the boolean contradicts it — this preserves an
      // existing milestone_manual when needs_manual_review stays true.
      if (!consistent) next.acceptance_mode = patch.needs_manual_review ? "manual" : "auto";
    }

    // ----- diff: only fields whose value actually changes -----
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    for (const k of Object.keys(next)) {
      const before = (task as unknown as Record<string, unknown>)[k];
      const after = next[k];
      if (!eq(before, after)) changes.push({ field: k, from: before, to: after });
    }
    return { success: true, changes };
  }

  /**
   * Apply a prepared edit's changes to the task in place and stamp `updated_at`. The
   * caller owns saveTasks + the audit log (edit_task uses source="edit_task";
   * edit_tasks will use source="edit_tasks").
   */
  private applyPreparedTaskEdit(
    task: Task,
    changes: { field: string; from: unknown; to: unknown }[]
  ): void {
    for (const c of changes) (task as unknown as Record<string, unknown>)[c.field] = c.to;
    task.updated_at = new Date().toISOString();
  }

  /**
   * Audited reverse of close_task: bring a TERMINAL task (done/cancelled/superseded)
   * back to an active state. Management bypass — does not use VALID_TRANSITIONS.
   * Reopening a superseded task clears its replacement_task_id, but the dependents
   * that were rewired to the replacement at supersede time are NOT auto-restored
   * (the log flags this so the caller can re-point them if needed).
   */
  reopenTask(
    id: string,
    reason: string,
    toStatus: "todo" | "in_progress" = "todo"
  ): { success: boolean; error?: string; task_id?: string } {
    const data = this.getTasks();
    if (!data) return { success: false, error: "No tasks found" };
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return { success: false, error: `Task ${id} not found` };

    if (!["done", "cancelled", "superseded"].includes(task.status)) {
      return {
        success: false,
        error: `Task ${id} is not closed (status=${task.status}); only done/cancelled/superseded can be reopened.`,
      };
    }
    if (!reason || !reason.trim()) {
      return { success: false, error: "reopen_task requires a non-empty reason." };
    }

    const oldStatus = task.status;
    const clearedReplacement =
      oldStatus === "superseded" ? task.replacement_task_id ?? null : null;
    task.status = toStatus;
    task.updated_at = new Date().toISOString();
    task.closed_at = null;
    task.close_reason = null;
    if (oldStatus === "superseded") task.replacement_task_id = null;

    this.saveTasks(data);
    this.updateProjectProgress();

    this.addLog({
      timestamp: task.updated_at,
      type: "task_status_change",
      kind: "task_transition",
      event_type: "task_reopened",
      task_id: id,
      from_status: oldStatus,
      to_status: toStatus,
      entities: {
        reason,
        ...(clearedReplacement ? { cleared_replacement_task_id: clearedReplacement } : {}),
      },
      source: "reopen_task",
      message:
        `${id} ${oldStatus} → ${toStatus} (reopen_task): ${reason}` +
        (clearedReplacement
          ? ` [cleared replacement ${clearedReplacement}; dependents rewired at supersede time are NOT auto-restored]`
          : ""),
    });

    return { success: true, task_id: id };
  }

  updateTasks(
    updates: { id: string; status: Task["status"]; notes?: string }[]
  ): { id: string; success: boolean; error?: string }[] {
    return updates.map((u) => ({ id: u.id, ...this.updateTaskStatus(u.id, u.status, u.notes) }));
  }

  closeTasks(
    closes: {
      id: string;
      status: "cancelled" | "superseded";
      reason: string;
      replacement_task_id?: string;
    }[]
  ): { id: string; success: boolean; error?: string; affected_dependents?: string[] }[] {
    return closes.map((c) => {
      const r = this.closeTask(c.id, c.status, c.reason, c.replacement_task_id);
      return {
        id: c.id,
        success: r.success,
        error: r.error,
        affected_dependents: r.affected_dependents,
      };
    });
  }

  archiveModule(
    module: string,
    reason: string
  ): { closed: string[]; results: { id: string; success: boolean; error?: string }[] } {
    const data = this.getTasks();
    if (!data) return { closed: [], results: [] };
    const targets = data.tasks
      .filter(
        (t) => t.module === module && !["done", "cancelled", "superseded"].includes(t.status)
      )
      .map((t) => t.id);
    const results = targets.map((id) => {
      const r = this.closeTask(id, "cancelled", reason);
      return { id, success: r.success, error: r.error };
    });
    return { closed: results.filter((r) => r.success).map((r) => r.id), results };
  }

  getTaskById(id: string): Task | null {
    const data = this.getTasks();
    if (!data) return null;
    return data.tasks.find((t) => t.id === id) || null;
  }

  updateTaskStatus(
    id: string,
    newStatus: Task["status"],
    notes?: string
  ): { success: boolean; error?: string } {
    const data = this.getTasks();
    if (!data) return { success: false, error: "No tasks found" };

    const task = data.tasks.find((t) => t.id === id);
    if (!task) return { success: false, error: `Task ${id} not found` };

    // Closed states are reachable only through the audited close_task bypass,
    // never the forward gauntlet — keep the main path pure (防假装完成).
    if (newStatus === "cancelled" || newStatus === "superseded") {
      return {
        success: false,
        error: `Use close_task to set "${newStatus}" (audited management bypass); update_task_status only drives the forward state machine.`,
      };
    }

    // Validate transition
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return {
        success: false,
        error: `Invalid transition: ${task.status} → ${newStatus}. Allowed: ${(allowed || []).join(", ")}`,
      };
    }

    // Extra validation: auto_verified → done only if needs_manual_review is false
    if (task.status === "auto_verified" && newStatus === "done" && this.requiresManualAcceptance(task)) {
      return {
        success: false,
        error: `Task ${id} requires manual acceptance. Must go through awaiting_manual_acceptance first.`,
      };
    }

    if (
      task.status === "auto_verified" &&
      newStatus === "awaiting_manual_acceptance" &&
      !this.requiresManualAcceptance(task)
    ) {
      return {
        success: false,
        error: `Task ${id} is configured for automatic acceptance and cannot move to awaiting_manual_acceptance.`,
      };
    }

    const oldStatus = task.status;
    task.status = newStatus;
    task.updated_at = new Date().toISOString();
    if (notes) task.notes = notes;

    this.saveTasks(data);
    this.updateProjectProgress();

    // Auto-log the transition
    this.addLog({
      timestamp: new Date().toISOString(),
      type: "task_status_change",
      kind: "task_transition",
      task_id: id,
      from_status: oldStatus,
      to_status: newStatus,
      message: `${id} ${oldStatus} → ${newStatus}${notes ? ": " + notes : ""}`,
    });

    return { success: true };
  }

  /**
   * Audited management bypass to retire a task to a terminal closed state.
   * Only reachable here (never via updateTaskStatus). Does NOT touch
   * VALID_TRANSITIONS. Dependents handling (superseded-rewrite / cancelled-alert)
   * lands in PM-103; here we validate, set status, compute affected dependents
   * for the audit trail, and write the task_closed log.
   */
  closeTask(
    id: string,
    closeStatus: "cancelled" | "superseded",
    reason: string,
    replacementTaskId?: string
  ): {
    success: boolean;
    error?: string;
    task_id?: string;
    affected_dependents?: string[];
    rewired?: string[];
  } {
    const data = this.getTasks();
    if (!data) return { success: false, error: "No tasks found" };

    const task = data.tasks.find((t) => t.id === id);
    if (!task) return { success: false, error: `Task ${id} not found` };

    if (["done", "cancelled", "superseded"].includes(task.status)) {
      return {
        success: false,
        error: `Task ${id} is already terminal (${task.status}); cannot close. (No reopen/un-complete in v1.)`,
      };
    }
    if (!reason || !reason.trim()) {
      return { success: false, error: "close_task requires a non-empty reason." };
    }
    if (closeStatus === "superseded") {
      if (!replacementTaskId) {
        return { success: false, error: "superseded requires replacement_task_id." };
      }
      const check = this.validateReplacement(id, replacementTaskId, data.tasks);
      if (!check.valid) return { success: false, error: check.error };
    }

    const oldStatus = task.status;
    task.status = closeStatus;
    task.updated_at = new Date().toISOString();
    task.closed_at = task.updated_at;
    task.close_reason = reason;

    const affected_dependents = data.tasks
      .filter((t) => t.id !== id && t.dependencies.includes(id))
      .map((t) => t.id);
    const rewired: string[] = [];

    if (closeStatus === "superseded" && replacementTaskId) {
      task.replacement_task_id = replacementTaskId;
      // Rewrite dependents to point at the replacement so the DAG stays runnable
      // (the work moved; dependents should now wait on the replacement, not the husk).
      // The shared rewrite helper skips the husk itself and dedupes.
      rewired.push(...this.rewriteDependencyEdges(data.tasks, id, replacementTaskId, { skipId: id }));
    }

    this.saveTasks(data);
    this.updateProjectProgress();

    this.addLog({
      timestamp: task.updated_at,
      type: "task_status_change",
      kind: "task_transition",
      event_type: "task_closed",
      task_id: id,
      from_status: oldStatus,
      to_status: closeStatus,
      entities: {
        reason,
        ...(replacementTaskId ? { replacement_task_id: replacementTaskId } : {}),
        ...(affected_dependents.length ? { dependents: affected_dependents } : {}),
        ...(rewired.length ? { rewired } : {}),
      },
      source: "close_task",
      message: `${id} ${oldStatus} → ${closeStatus} (close_task): ${reason}`,
    });

    // Cancelling (not superseding) leaves dependents pointing at a dead task.
    // Surface an ops_event so the controller re-points/closes them, rather than
    // a silent deadlock (G1: a cancelled dep must neither run nor stall silently).
    if (closeStatus === "cancelled" && affected_dependents.length) {
      this.addLog({
        timestamp: task.updated_at,
        type: "ops_event",
        kind: "ops_event",
        event_type: "dependents_blocked_by_cancel",
        task_id: id,
        from_status: null,
        to_status: null,
        entities: { cancelled: id, dependents: affected_dependents },
        source: "close_task",
        message: `Cancelling ${id} blocks ${affected_dependents.length} dependent(s): ${affected_dependents.join(", ")}. Re-point or close them.`,
      });
    }

    return { success: true, task_id: id, affected_dependents, rewired };
  }

  /**
   * Rewrite every `dependencies[]` edge pointing at `fromId` to `toId` across all
   * tasks (optionally skipping one id, e.g. the husk being superseded / the task being
   * renamed), de-duplicating so a dependent that listed BOTH ends with a single edge.
   * Mutates the passed task objects in place; performs no save/log. Returns the ids of
   * tasks whose dependency list changed.
   * (Extracted from close_task's superseded dependents-rewrite; reused by rename_task.)
   */
  private rewriteDependencyEdges(
    tasks: Task[],
    fromId: string,
    toId: string,
    opts?: { skipId?: string }
  ): string[] {
    const rewired: string[] = [];
    for (const t of tasks) {
      if (opts?.skipId !== undefined && t.id === opts.skipId) continue;
      if (!t.dependencies.includes(fromId)) continue;
      t.dependencies = [...new Set(t.dependencies.map((d) => (d === fromId ? toId : d)))];
      rewired.push(t.id);
    }
    return rewired;
  }

  /**
   * Structural replacement-graph check shared by close_task (via validateReplacement)
   * and rename_task: the replacement is not the source itself, the target exists, and
   * the replacement chain from it does not cycle back to the source. Does NOT enforce
   * the close-time "target must be active" rule — rename_task must accept a chain that
   * legitimately terminates in a done/active task.
   * (Extracted from validateReplacement so rename_task can reuse exists/non-self/no-cycle.)
   */
  private validateReplacementGraph(
    sourceId: string,
    replacementId: string,
    tasks: Task[]
  ): { valid: boolean; error?: string } {
    if (replacementId === sourceId) {
      return { valid: false, error: "replacement_task_id cannot be the task itself." };
    }
    if (!tasks.find((t) => t.id === replacementId)) {
      return { valid: false, error: `replacement_task_id ${replacementId} does not exist.` };
    }
    // Cycle check: follow the replacement chain from the target; reaching the
    // source means closing it would form a cycle.
    const seen = new Set<string>([sourceId]);
    let cursor: string | null | undefined = replacementId;
    while (cursor) {
      if (seen.has(cursor)) {
        return { valid: false, error: `replacement chain forms a cycle at ${cursor}.` };
      }
      seen.add(cursor);
      const next: Task | undefined = tasks.find((t) => t.id === cursor);
      cursor = next?.replacement_task_id ?? null;
    }
    return { valid: true };
  }

  private validateReplacement(
    sourceId: string,
    replacementId: string,
    tasks: Task[]
  ): { valid: boolean; error?: string } {
    // Preserve the original error precedence (self -> exists -> terminal -> cycle):
    // run the close-time "must be active" check before delegating the structural
    // self/exists/cycle checks to the shared graph validator. self/exists are cheap
    // and re-run inside the graph check; terminal is still reported before any cycle.
    if (replacementId === sourceId) {
      return { valid: false, error: "replacement_task_id cannot be the task itself." };
    }
    const target = tasks.find((t) => t.id === replacementId);
    if (!target) {
      return { valid: false, error: `replacement_task_id ${replacementId} does not exist.` };
    }
    if (["cancelled", "superseded", "done"].includes(target.status)) {
      return {
        valid: false,
        error: `replacement_task_id ${replacementId} is terminal (${target.status}); a replacement must be an active task. If the work is already complete, cancel the source instead of superseding it.`,
      };
    }
    return this.validateReplacementGraph(sourceId, replacementId, tasks);
  }

  getAllTasks(filter?: { status?: Task["status"] }): Task[] {
    const data = this.getTasks();
    if (!data) return [];

    if (filter?.status) {
      return data.tasks.filter((t) => t.status === filter.status);
    }
    return data.tasks;
  }

  addSubtask(parentId: string, subtask: Task): { success: boolean; error?: string } {
    const data = this.getTasks();
    if (!data) return { success: false, error: "No tasks found" };

    const parent = data.tasks.find((t) => t.id === parentId);
    if (!parent) return { success: false, error: `Parent task ${parentId} not found` };

    subtask.created_at = new Date().toISOString();
    subtask.updated_at = new Date().toISOString();
    subtask.status = "todo";
    subtask.commit_hash = "";
    data.tasks.push(this.normalizeTask(subtask));

    this.saveTasks(data);
    this.updateProjectProgress();
    return { success: true };
  }

  // ---------- Logs ----------

  /** Coarse kind for a log entry: explicit `kind` wins, else inferred from `type`. */
  logKind(entry: LogEntry): LogKind {
    return entry.kind ?? inferKind(entry.type);
  }

  getLogs(
    filter?:
      | number
      | { kind?: LogKind; event_type?: string; since?: string; limit?: number }
  ): LogEntry[] {
    const data = this.readJSON<LogsData>("logs.json");
    if (!data) return [];

    const opts = typeof filter === "number" ? { limit: filter } : filter ?? {};

    let logs = data.logs
      .slice()
      .sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

    // Filter BEFORE slicing, so a kind/event_type/since query never silently
    // drops older matches behind a window of unrelated, more-recent entries.
    if (opts.kind) logs = logs.filter((l) => this.logKind(l) === opts.kind);
    if (opts.event_type) {
      logs = logs.filter((l) => (l.event_type ?? l.type) === opts.event_type);
    }
    if (opts.since) {
      const since = new Date(opts.since).getTime();
      // Ignore an unparseable `since` rather than silently filtering on NaN.
      if (!Number.isNaN(since)) {
        logs = logs.filter((l) => new Date(l.timestamp).getTime() >= since);
      }
    }

    // limit is an explicit non-negative count: 0 => [], undefined => all.
    // (`opts.limit ? …` was wrong — it treated a real limit of 0 as "no limit".)
    return opts.limit != null && opts.limit >= 0 ? logs.slice(0, opts.limit) : logs;
  }

  addLog(entry: LogEntry): void {
    const data = this.readJSON<LogsData>("logs.json") || { logs: [] };
    entry.timestamp = entry.timestamp || new Date().toISOString();
    data.logs.push(entry);
    this.writeJSON("logs.json", data);
  }

  // ---------- Context Recovery ----------

  getCurrentFocus(): (CurrentFocus & { is_stale: boolean }) | null {
    const focus = this.readJSON<CurrentFocus>("focus.json");
    if (!focus) return null;
    const is_stale = focus.stale_after
      ? new Date().getTime() > new Date(focus.stale_after).getTime()
      : false;
    return { ...focus, is_stale };
  }

  setCurrentFocus(input: {
    summary: string;
    last_event?: string | null;
    next_trigger?: string | null;
    waiting_on?: string[];
    related_task_ids?: string[];
    related_entities?: Record<string, unknown>;
    source?: string | null;
    stale_after?: string | null;
  }): CurrentFocus {
    const focus: CurrentFocus = {
      schema_version: 1,
      summary: input.summary,
      last_event: input.last_event ?? null,
      next_trigger: input.next_trigger ?? null,
      waiting_on: input.waiting_on ?? [],
      related_task_ids: input.related_task_ids ?? [],
      related_entities: input.related_entities ?? {},
      source: input.source ?? null,
      updated_at: new Date().toISOString(),
      stale_after: input.stale_after ?? null,
    };
    this.writeJSON("focus.json", focus);
    // Focus changes are an auditable ops event in the existing log stream
    // (no separate journal store). Phase 1 will add the structured `kind` field.
    this.addLog({
      timestamp: focus.updated_at,
      type: "focus_update",
      kind: "focus_update",
      task_id: null,
      from_status: null,
      to_status: null,
      message: `focus: ${focus.summary}`,
    });
    return focus;
  }

  private computeProgressMetrics(tasks: Task[]): ProgressMetrics {
    const total_all = tasks.length;
    // `s` is typed as string (not the status union) so that referencing the
    // Phase-1 statuses "cancelled"/"superseded" here compiles cleanly while the
    // Task.status union still has only the legacy five values.
    const count = (s: string) => tasks.filter((t) => t.status === s).length;
    const done = count("done");
    const cancelled = count("cancelled");
    const superseded = count("superseded");
    const closed_total = done + cancelled + superseded;
    const active_total = total_all - cancelled - superseded;
    const rate = (num: number, den: number) => (den > 0 ? num / den : 0);
    return {
      total_all,
      active_total,
      done,
      cancelled,
      superseded,
      closed_total,
      raw_completion_rate: rate(done, total_all),
      active_completion_rate: rate(done, active_total),
    };
  }

  private computeNextTaskBlockedReason(
    tasks: Task[],
    nextTask: Task | null
  ): NextTaskBlockedReason {
    if (nextTask) return "none";
    const todos = tasks.filter((t) => t.status === "todo");
    if (todos.length === 0) return "all_done";
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // Resolve a dependency through superseded->replacement chains and report
    // whether it bottoms out in a cancelled task — the true dead-end blocker.
    // (A direct-only check missed transitive blocks and superseded chains that
    // terminate in cancelled; this mirrors getNextTask's depSatisfied walk.)
    const endsCancelled = (depId: string): boolean => {
      const seen = new Set<string>();
      let cur: string | null | undefined = depId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const dt = byId.get(cur);
        if (!dt) return false;
        if (dt.status === "cancelled") return true;
        if (dt.status === "superseded" && dt.replacement_task_id) {
          cur = dt.replacement_task_id;
          continue;
        }
        return false;
      }
      return false;
    };
    const blockedByCancelled = todos.some((t) => t.dependencies.some(endsCancelled));
    return blockedByCancelled ? "blocked_by_cancelled_dep" : "blocked_in_progress";
  }

  getProjectContext(opts: GetProjectContextOptions = {}): {
    project: ProjectInfo | null;
    schema_version: number;
    context_mode: ContextMode;
    presentation_order: string[];
    prd_summary: string | null;
    architecture_summary: string | null;
    tasks_summary: {
      total: number;
      by_status: Record<string, number>;
      next_task: Task | null;
      next_task_blocked_reason: NextTaskBlockedReason;
      awaiting_acceptance: Task[];
      metrics: ProgressMetrics;
    };
    in_progress_tasks: Task[];
    current_focus: (CurrentFocus & { is_stale: boolean }) | null;
    recent_logs: LogEntry[];
  } {
    const mode: ContextMode = opts.context_mode ?? "build";
    const includeFullInProgress = opts.include_full_in_progress ?? true;
    const maxRecent =
      opts.max_recent_events ?? (mode === "ops" ? 20 : mode === "hybrid" ? 15 : 10);

    const project = this.getProjectInfo();
    const prd = this.getPRD();
    const arch = this.getArchitecture();
    const tasksData = this.getTasks();
    const logs = this.getLogs(maxRecent);

    // Extract first 500 chars of PRD/architecture as summary
    const prdSummary = prd ? prd.substring(0, 500) + (prd.length > 500 ? "..." : "") : null;
    const archSummary = arch ? arch.substring(0, 500) + (arch.length > 500 ? "..." : "") : null;

    const tasks = tasksData?.tasks || [];
    const byStatus: Record<string, number> = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }
    const nextTask = this.getNextTask();

    return {
      project,
      schema_version: project?.schema_version ?? 0,
      context_mode: mode,
      presentation_order: PRESENTATION_ORDER[mode],
      prd_summary: prdSummary,
      architecture_summary: archSummary,
      tasks_summary: {
        total: tasks.length,
        by_status: byStatus,
        next_task: nextTask,
        next_task_blocked_reason: this.computeNextTaskBlockedReason(tasks, nextTask),
        awaiting_acceptance: tasks.filter(
          (t) => t.status === "awaiting_manual_acceptance"
        ),
        metrics: this.computeProgressMetrics(tasks),
      },
      in_progress_tasks: includeFullInProgress
        ? tasks.filter((t) => t.status === "in_progress")
        : [],
      current_focus: this.getCurrentFocus(),
      recent_logs: logs,
    };
  }

  /** Compact read-only summary for cross-project portfolio aggregation (ADR-003 B). */
  getPortfolioSummary(): {
    name: string | null;
    status: string | null;
    metrics: ProgressMetrics;
    current_focus: { summary: string; is_stale: boolean } | null;
    next_task: { id: string; title: string } | null;
    next_task_blocked_reason: NextTaskBlockedReason;
  } {
    const ctx = this.getProjectContext();
    const focus = ctx.current_focus;
    const nt = ctx.tasks_summary.next_task;
    return {
      name: ctx.project?.name ?? null,
      status: ctx.project?.status ?? null,
      metrics: ctx.tasks_summary.metrics,
      current_focus: focus ? { summary: focus.summary, is_stale: focus.is_stale } : null,
      next_task: nt ? { id: nt.id, title: nt.title } : null,
      next_task_blocked_reason: ctx.tasks_summary.next_task_blocked_reason,
    };
  }

  /**
   * lint_state (ADR-004 §3): read-only consistency scan over tasks/project/logs/focus.
   * The IO boundary — gathers raw + normalized data and an "expected" progress object
   * (built by the SAME computeProgressObject the writer uses), then delegates to the
   * pure runLint. Never mutates. `crossProject` suppresses machine-local checks
   * (profiles / schema / etc.) when linting a foreign project read-only.
   */
  lintState(opts: { crossProject?: boolean } = {}): LintResult {
    const tasksRaw = this.readJSON<TasksData>("tasks.json")?.tasks ?? [];
    const tasks = this.getTasks()?.tasks ?? [];
    const info = this.getProjectInfo();
    return runLint({
      tasksRaw,
      tasks,
      actualProgress: info?.progress ?? null,
      expectedProgress: info ? this.computeProgressObject(tasks) : null,
      projectStatus: info?.status ?? null,
      schemaVersion: info?.schema_version ?? 0,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      logs: this.getLogs(),
      focus: this.readJSON<CurrentFocus>("focus.json"),
      validProfiles: loadProfileNames(),
      crossProject: !!opts.crossProject,
    });
  }

  /**
   * reconcile (ADR-004 §3.4): apply ONLY the safe, deterministic auto-fixes for the
   * current active project, audit each, and return what was fixed + what remains for
   * a human. The auto-fix set is intentionally minimal:
   *   - progress_drift     -> updateProjectProgress() (the existing single source of truth)
   *   - self_dependency    -> drop the self edge, but ONLY on active tasks (never rewrite
   *                           frozen terminal history)
   * Everything else is reported as `remaining` (fix it via edit_task). Idempotent: a
   * second run with no new drift fixes nothing. Active-project-only — there is no
   * project_dir param (silent cross-project writes would break the ADR-003 contract).
   */
  reconcile(): {
    fixed: { code: string; task_id: string | null; detail: string }[];
    remaining: Finding[];
  } {
    const fixed: { code: string; task_id: string | null; detail: string }[] = [];
    const { findings } = this.lintState();

    // self_dependency: single-valued, deterministic (drop d === id). Skip terminal tasks.
    const selfFixes = findings.filter((f) => f.code === "self_dependency");
    if (selfFixes.length) {
      const data = this.getTasks();
      if (data) {
        const applied: { id: string; ts: string }[] = [];
        for (const f of selfFixes) {
          const t = data.tasks.find((x) => x.id === f.task_id);
          if (!t || ["done", "cancelled", "superseded"].includes(t.status)) continue;
          if (!t.dependencies.includes(t.id)) continue;
          t.dependencies = t.dependencies.filter((d) => d !== t.id);
          t.updated_at = new Date().toISOString();
          applied.push({ id: t.id, ts: t.updated_at });
        }
        // Save FIRST, then log — so a saveTasks failure never leaves orphan audit
        // entries asserting a fix that did not land (matches updateTaskStatus/closeTask).
        if (applied.length) {
          this.saveTasks(data);
          for (const a of applied) {
            this.addLog({
              timestamp: a.ts,
              type: "reconcile",
              kind: "ops_event",
              event_type: "reconcile_self_dependency",
              task_id: a.id,
              from_status: null,
              to_status: null,
              entities: { removed_dependency: a.id },
              source: "reconcile",
              message: `reconcile: removed self-dependency on ${a.id}`,
            });
            fixed.push({ code: "self_dependency", task_id: a.id, detail: "removed self-dependency edge" });
          }
        }
      }
    }

    // progress_drift: recompute via the audited single source of truth (only when drifted).
    const prog = findings.find((f) => f.code === "progress_drift");
    if (prog) {
      const before = this.getProjectInfo()?.progress ?? null;
      this.updateProjectProgress();
      const after = this.getProjectInfo()?.progress ?? null;
      this.addLog({
        timestamp: new Date().toISOString(),
        type: "reconcile",
        kind: "ops_event",
        event_type: "reconcile_progress_recompute",
        task_id: null,
        from_status: null,
        to_status: null,
        entities: {
          before,
          after,
          drifted_fields: (prog.entities as Record<string, unknown> | undefined)?.drifted_fields,
        },
        source: "reconcile",
        message: "reconcile: recomputed project.json.progress",
      });
      fixed.push({ code: "progress_drift", task_id: null, detail: "recomputed project.json.progress" });
    }

    // remaining = a fresh lint AFTER the safe fixes (manual items + anything left).
    return { fixed, remaining: this.lintState().findings };
  }

  migrateTaskSchema(): {
    migrated: number;
    logs_migrated: number;
    schema_version: number;
    skipped: boolean;
  } {
    const info = this.getProjectInfo();

    // Idempotency guard (G3): no project.json (nothing to stamp) OR already at the
    // current version -> no-op. Skipping when project.json is absent avoids a
    // non-idempotent partial run that reports v1 without ever stamping it.
    if (!info || (info.schema_version ?? 0) >= CURRENT_SCHEMA_VERSION) {
      return {
        migrated: 0,
        logs_migrated: 0,
        schema_version: info?.schema_version ?? 0,
        skipped: true,
      };
    }

    // 1. Tasks: normalize (fills defaults incl. replacement_task_id=null). This
    //    NEVER changes status — pre-existing cancelled/superseded data (e.g.
    //    ClaudeX's 17 cancelled tasks) is preserved verbatim.
    const tasksData = this.readJSON<TasksData>("tasks.json");
    let migrated = 0;
    if (tasksData) {
      const normalized = tasksData.tasks.map((task) => this.normalizeTask(task));
      this.saveTasks({ tasks: normalized });
      migrated = normalized.length;
    }

    // 2. Logs: backfill kind/event_type by inference (G4) without touching the
    //    message/timestamp. Value-preserving round-trip (UTF-8 in/out).
    const logsData = this.readJSON<LogsData>("logs.json");
    let logs_migrated = 0;
    if (logsData) {
      for (const entry of logsData.logs) {
        if (!entry.kind) {
          entry.kind = inferKind(entry.type);
          if (entry.event_type == null) entry.event_type = entry.type;
          logs_migrated++;
        }
      }
      this.writeJSON("logs.json", logsData);
    }

    // 3. Stamp schema_version, then recompute additive dual-rate progress
    //    (updateProjectProgress re-reads the stamped info and preserves it).
    if (info) {
      info.schema_version = CURRENT_SCHEMA_VERSION;
      this.saveProjectInfo(info);
    }
    this.updateProjectProgress();

    return {
      migrated,
      logs_migrated,
      schema_version: CURRENT_SCHEMA_VERSION,
      skipped: false,
    };
  }

  private normalizeTask(task: Task): Task {
    const acceptanceMode = this.resolveAcceptanceMode(task);
    return {
      ...task,
      needs_manual_review:
        typeof task.needs_manual_review === "boolean"
          ? task.needs_manual_review
          : acceptanceMode !== "auto",
      acceptance_mode: acceptanceMode,
      verification_commands: task.verification_commands || [],
      review_checklist: task.review_checklist || [],
      stage_gate: task.stage_gate || false,
      replacement_task_id: task.replacement_task_id ?? null,
      priority: typeof task.priority === "number" ? task.priority : 0,
    };
  }

  private resolveAcceptanceMode(task: Task): AcceptanceMode {
    if (task.acceptance_mode) return task.acceptance_mode;
    return task.needs_manual_review ? "manual" : "auto";
  }

  private requiresManualAcceptance(task: Task): boolean {
    const acceptanceMode = this.resolveAcceptanceMode(task);
    if (acceptanceMode === "manual") return true;
    if (acceptanceMode === "milestone_manual") {
      return Boolean(task.stage_gate);
    }
    return false;
  }
}
