import * as fs from "fs";
import * as path from "path";

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
};

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

  updateProjectProgress(): void {
    const info = this.getProjectInfo();
    const tasks = this.getTasks();
    if (!info || !tasks) return;

    const t = tasks.tasks;
    const metrics = this.computeProgressMetrics(t);
    info.progress = {
      // legacy keys — semantics unchanged (in_progress still counts auto_verified):
      total: t.length,
      done: metrics.done,
      in_progress: t.filter(
        (x) => x.status === "in_progress" || x.status === "auto_verified"
      ).length,
      awaiting_acceptance: t.filter((x) => x.status === "awaiting_manual_acceptance").length,
      todo: t.filter((x) => x.status === "todo").length,
      // additive dual-rate fields (D4):
      total_all: metrics.total_all,
      active_total: metrics.active_total,
      cancelled: metrics.cancelled,
      superseded: metrics.superseded,
      closed_total: metrics.closed_total,
      raw_completion_rate: metrics.raw_completion_rate,
      active_completion_rate: metrics.active_completion_rate,
    };
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

    if (closeStatus === "superseded") {
      task.replacement_task_id = replacementTaskId ?? null;
      // Rewrite dependents to point at the replacement so the DAG stays runnable
      // (the work moved; dependents should now wait on the replacement, not the husk).
      for (const t of data.tasks) {
        if (t.id !== id && t.dependencies.includes(id)) {
          t.dependencies = t.dependencies.map((d) =>
            d === id ? (replacementTaskId as string) : d
          );
          rewired.push(t.id);
        }
      }
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

  private validateReplacement(
    sourceId: string,
    replacementId: string,
    tasks: Task[]
  ): { valid: boolean; error?: string } {
    if (replacementId === sourceId) {
      return { valid: false, error: "replacement_task_id cannot be the task itself." };
    }
    const target = tasks.find((t) => t.id === replacementId);
    if (!target) {
      return { valid: false, error: `replacement_task_id ${replacementId} does not exist.` };
    }
    if (["cancelled", "superseded"].includes(target.status)) {
      return {
        valid: false,
        error: `replacement_task_id ${replacementId} is itself closed (${target.status}).`,
      };
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
      logs = logs.filter((l) => new Date(l.timestamp).getTime() >= since);
    }

    return opts.limit ? logs.slice(0, opts.limit) : logs;
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
    // superseded deps are rewired/resolvable, so only a cancelled dep is a true
    // dead-end blocker for the diagnostic.
    const cancelledIds = new Set(
      tasks.filter((t) => t.status === "cancelled").map((t) => t.id)
    );
    const blockedByCancelled = todos.some((t) =>
      t.dependencies.some((d) => cancelledIds.has(d))
    );
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

  migrateTaskSchema(): {
    migrated: number;
    logs_migrated: number;
    schema_version: number;
    skipped: boolean;
  } {
    const info = this.getProjectInfo();

    // Idempotency guard (G3): already at the current version -> no-op.
    if (info && (info.schema_version ?? 0) >= CURRENT_SCHEMA_VERSION) {
      return {
        migrated: 0,
        logs_migrated: 0,
        schema_version: info.schema_version ?? 0,
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
