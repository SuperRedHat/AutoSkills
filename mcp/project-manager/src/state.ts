import * as fs from "fs";
import * as path from "path";

// ---------- Types ----------

export type AcceptanceMode = "auto" | "manual" | "milestone_manual";
export type VerificationProfile =
  | "backend"
  | "frontend_unit"
  | "frontend_browser"
  | "frontend_visual"
  | "docs"
  | "workflow_meta";

export interface ProjectInfo {
  name: string;
  created_at: string;
  updated_at: string;
  status: "initialized" | "designed" | "planned" | "in_progress" | "completed";
  tech_stack: string[];
  progress: {
    total: number;
    done: number;
    in_progress: number;
    awaiting_acceptance: number;
    todo: number;
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
    | "done";
  created_at: string;
  updated_at: string;
  commit_hash: string;
  notes: string;
}

export interface TasksData {
  tasks: Task[];
}

export interface LogEntry {
  timestamp: string;
  type: string;
  task_id: string | null;
  from_status: string | null;
  to_status: string | null;
  message: string;
}

export interface LogsData {
  logs: LogEntry[];
}

// ---------- Valid state transitions ----------

const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ["in_progress"],
  in_progress: ["auto_verified"],
  auto_verified: ["done", "awaiting_manual_acceptance"],
  awaiting_manual_acceptance: ["done", "in_progress"],
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

    info.progress = {
      total: tasks.tasks.length,
      done: tasks.tasks.filter((t) => t.status === "done").length,
      in_progress: tasks.tasks.filter(
        (t) => t.status === "in_progress" || t.status === "auto_verified"
      ).length,
      awaiting_acceptance: tasks.tasks.filter(
        (t) => t.status === "awaiting_manual_acceptance"
      ).length,
      todo: tasks.tasks.filter((t) => t.status === "todo").length,
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

    const doneTasks = new Set(
      data.tasks.filter((t) => t.status === "done").map((t) => t.id)
    );

    return (
      data.tasks.find(
        (t) =>
          t.status === "todo" &&
          t.dependencies.every((dep) => doneTasks.has(dep))
      ) || null
    );
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
      task_id: id,
      from_status: oldStatus,
      to_status: newStatus,
      message: `${id} ${oldStatus} → ${newStatus}${notes ? ": " + notes : ""}`,
    });

    return { success: true };
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

  getLogs(n?: number): LogEntry[] {
    const data = this.readJSON<LogsData>("logs.json");
    if (!data) return [];

    const logs = data.logs.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return n ? logs.slice(0, n) : logs;
  }

  addLog(entry: LogEntry): void {
    const data = this.readJSON<LogsData>("logs.json") || { logs: [] };
    entry.timestamp = entry.timestamp || new Date().toISOString();
    data.logs.push(entry);
    this.writeJSON("logs.json", data);
  }

  // ---------- Context Recovery ----------

  getProjectContext(): {
    project: ProjectInfo | null;
    prd_summary: string | null;
    architecture_summary: string | null;
    tasks_summary: {
      total: number;
      by_status: Record<string, number>;
      next_task: Task | null;
      awaiting_acceptance: Task[];
    };
    recent_logs: LogEntry[];
  } {
    const project = this.getProjectInfo();
    const prd = this.getPRD();
    const arch = this.getArchitecture();
    const tasksData = this.getTasks();
    const logs = this.getLogs(10);

    // Extract first 500 chars of PRD as summary
    const prdSummary = prd ? prd.substring(0, 500) + (prd.length > 500 ? "..." : "") : null;
    const archSummary = arch ? arch.substring(0, 500) + (arch.length > 500 ? "..." : "") : null;

    const tasks = tasksData?.tasks || [];
    const byStatus: Record<string, number> = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }

    return {
      project,
      prd_summary: prdSummary,
      architecture_summary: archSummary,
      tasks_summary: {
        total: tasks.length,
        by_status: byStatus,
        next_task: this.getNextTask(),
        awaiting_acceptance: tasks.filter(
          (t) => t.status === "awaiting_manual_acceptance"
        ),
      },
      recent_logs: logs,
    };
  }

  migrateTaskSchema(): { migrated: number } {
    const data = this.readJSON<TasksData>("tasks.json");
    if (!data) return { migrated: 0 };
    const normalizedTasks = data.tasks.map((task) => this.normalizeTask(task));
    this.saveTasks({ tasks: normalizedTasks });
    this.updateProjectProgress();
    return { migrated: normalizedTasks.length };
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
