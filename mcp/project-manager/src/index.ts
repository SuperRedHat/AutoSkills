import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StateManager, Task } from "./state.js";
import { findUnknownProfiles } from "./profiles.js";
import { resolveProjectDir } from "./project_dir.js";

// Resolve project directory: env var > search upward for .claude/state/ > cwd
function findProjectDir(): string {
  // 1. Explicit env var
  if (process.env.PROJECT_DIR) return process.env.PROJECT_DIR;

  // 2. Search upward from cwd for .claude/state/
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    const stateDir = path.join(dir, ".claude", "state");
    if (fs.existsSync(stateDir)) return dir;
    dir = path.dirname(dir);
  }

  // 3. Fallback to cwd
  return process.cwd();
}

let projectDir = findProjectDir();
let state = new StateManager(projectDir);
const workflowCoreDir = path.join(os.homedir(), ".workflow-core");

// Cross-project addressing (ADR-003): pick a StateManager for an optional per-call
// project_dir WITHOUT touching the module-global projectDir/state. No project_dir
// => the active project (current behavior). Read-only tools use this; the global
// is never reassigned here (only set_project_dir does that).
type StateSelection =
  | { ok: true; state: StateManager; resolved: string; state_path: string; active: boolean }
  | {
      ok: false;
      error_kind: "not_a_project" | "state_unreadable";
      error: string;
      resolved: string;
    };

function selectState(dir?: string): StateSelection {
  if (!dir) {
    return {
      ok: true,
      state,
      resolved: projectDir,
      state_path: path.join(projectDir, ".claude", "state"),
      active: true,
    };
  }
  const r = resolveProjectDir(dir);
  if (!r.ok) return r;
  // An explicit project_dir that canonically equals the active project IS the active
  // project — reuse the global state and keep active:true, so cross-project suppression
  // (e.g. lint_state's machine-local checks) does not silently weaken a lint of one's
  // own project addressed by absolute path.
  let activeResolved: string;
  try {
    activeResolved = fs.realpathSync(projectDir);
  } catch {
    activeResolved = path.resolve(projectDir);
  }
  if (r.resolved === activeResolved) {
    return {
      ok: true,
      state,
      resolved: projectDir,
      state_path: path.join(projectDir, ".claude", "state"),
      active: true,
    };
  }
  return {
    ok: true,
    state: new StateManager(r.resolved),
    resolved: r.resolved,
    state_path: r.state_path,
    active: false,
  };
}

function selErr(sel: { error_kind: string; error: string }) {
  return {
    content: [
      { type: "text" as const, text: `Error (${sel.error_kind}): ${sel.error}` },
    ],
  };
}

const PROJECT_DIR_PARAM = z
  .string()
  .optional()
  .describe(
    "可选：跨项目只读，定位另一个项目（含 .claude/state 的目录）；不传=当前活动项目，且不会切换活动项目"
  );

// Self-reported MCP server version — read from package.json so the handshake never
// drifts from the real release (falls back to a literal if the file can't be read).
let pkgVersion = "1.4.0";
try {
  pkgVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
  ).version;
} catch {
  // keep the fallback
}

const server = new McpServer({
  name: "project-manager",
  version: pkgVersion,
});

// ==================== Set Project Directory ====================

server.tool(
  "set_project_dir",
  "设置当前项目目录。在会话开始时调用，确保 MCP Server 读写正确项目的状态文件。传入项目根目录的绝对路径。",
  {
    dir: z.string().describe("项目根目录的绝对路径，如 D:/project/ClaudeX"),
  },
  async ({ dir }) => {
    const normalized = path.resolve(dir);
    const stateDir = path.join(normalized, ".claude", "state");
    const exists = fs.existsSync(stateDir);

    projectDir = normalized;
    state = new StateManager(projectDir);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            project_dir: projectDir,
            state_dir: stateDir,
            state_exists: exists,
            message: exists
              ? `Project directory set to ${projectDir}. State files found.`
              : `Project directory set to ${projectDir}. No state files yet (run /project-init to create).`,
          }, null, 2),
        },
      ],
    };
  }
);

// ==================== Project Management ====================

server.tool("get_project_info", "获取项目元信息（可选 project_dir 跨项目只读）", { project_dir: PROJECT_DIR_PARAM }, async ({ project_dir }) => {
  const sel = selectState(project_dir);
  if (!sel.ok) return selErr(sel);
  const info = sel.state.getProjectInfo();
  return {
    content: [
      {
        type: "text" as const,
        text: info ? JSON.stringify(info, null, 2) : "No project found. Run /project-init first.",
      },
    ],
  };
});

server.tool(
  "save_prd",
  "保存 PRD 文档",
  { content: z.string().describe("PRD markdown content") },
  async ({ content }) => {
    state.savePRD(content);
    return {
      content: [{ type: "text" as const, text: "PRD saved successfully." }],
    };
  }
);

server.tool("get_prd", "获取 PRD 文档（可选 project_dir 跨项目只读）", { project_dir: PROJECT_DIR_PARAM }, async ({ project_dir }) => {
  const sel = selectState(project_dir);
  if (!sel.ok) return selErr(sel);
  const prd = sel.state.getPRD();
  return {
    content: [
      {
        type: "text" as const,
        text: prd || "No PRD found. Run /project-init first.",
      },
    ],
  };
});

server.tool(
  "save_architecture",
  "保存架构设计文档",
  { content: z.string().describe("Architecture markdown content") },
  async ({ content }) => {
    state.saveArchitecture(content);
    return {
      content: [{ type: "text" as const, text: "Architecture saved successfully." }],
    };
  }
);

server.tool("get_architecture", "获取架构设计文档（可选 project_dir 跨项目只读）", { project_dir: PROJECT_DIR_PARAM }, async ({ project_dir }) => {
  const sel = selectState(project_dir);
  if (!sel.ok) return selErr(sel);
  const arch = sel.state.getArchitecture();
  return {
    content: [
      {
        type: "text" as const,
        text: arch || "No architecture found. Run /project-design first.",
      },
    ],
  };
});

server.tool(
  "update_project_info",
  "更新项目元信息",
  {
    name: z.string().optional().describe("Project name"),
    status: z
      .enum(["initialized", "designed", "planned", "in_progress", "completed"])
      .optional()
      .describe("Project status"),
    tech_stack: z.array(z.string()).optional().describe("Tech stack array"),
  },
  async (params) => {
    let info = state.getProjectInfo();
    if (!info) {
      info = {
        name: params.name || "Untitled",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "initialized",
        tech_stack: [],
        progress: { total: 0, done: 0, in_progress: 0, awaiting_acceptance: 0, todo: 0 },
      };
    }
    if (params.name) info.name = params.name;
    if (params.status) info.status = params.status;
    if (params.tech_stack) info.tech_stack = params.tech_stack;
    state.saveProjectInfo(info);
    return {
      content: [{ type: "text" as const, text: "Project info updated." }],
    };
  }
);

// ==================== Task Management ====================

server.tool(
  "create_tasks",
  "批量创建任务",
  {
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        dependencies: z.array(z.string()),
        complexity: z.enum(["S", "M", "L"]),
        acceptance_criteria: z.array(z.string()),
        files: z.array(z.string()),
        module: z.string(),
        needs_manual_review: z.boolean(),
        acceptance_mode: z.enum(["auto", "manual", "milestone_manual"]).optional(),
        verification_profile: z
          .string()
          .optional()
          .describe("profile 名（运行时按外置 verification-profiles.json 校验）"),
        verification_commands: z.array(z.string()).optional(),
        review_checklist: z.array(z.string()).optional(),
        stage_gate: z.boolean().optional(),
        priority: z.number().optional().describe("越大越优先（默认 0）"),
      })
    ).describe("Array of tasks to create"),
  },
  async ({ tasks }) => {
    const { unknown, valid } = findUnknownProfiles(tasks.map((t) => t.verification_profile));
    if (unknown.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: unknown verification_profile(s): ${unknown.join(", ")}. Valid: ${valid.join(", ")}. (Add new profiles to ~/.workflow-core/policies/verification-profiles.json — no code change needed.)`,
          },
        ],
      };
    }
    const fullTasks: Task[] = tasks.map((t) => ({
      ...t,
      status: "todo" as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      commit_hash: "",
      notes: "",
    }));
    const result = state.createTasks(fullTasks);
    return {
      content: [
        { type: "text" as const, text: `Created ${result.created} tasks.` },
      ],
    };
  }
);

server.tool("get_next_task", "获取下一个可执行任务（依赖已全部完成；可选 project_dir 跨项目只读）", { project_dir: PROJECT_DIR_PARAM }, async ({ project_dir }) => {
  const sel = selectState(project_dir);
  if (!sel.ok) return selErr(sel);
  const task = sel.state.getNextTask();
  return {
    content: [
      {
        type: "text" as const,
        text: task
          ? JSON.stringify(task, null, 2)
          : "No available tasks. All tasks may be done, blocked by dependencies, or awaiting acceptance.",
      },
    ],
  };
});

server.tool(
  "update_task_status",
  "更新任务状态（严格校验合法迁移路径）",
  {
    id: z.string().describe("Task ID"),
    status: z.enum([
      "todo",
      "in_progress",
      "auto_verified",
      "awaiting_manual_acceptance",
      "done",
    ]).describe("New status"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ id, status, notes }) => {
    const result = state.updateTaskStatus(id, status, notes);
    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `Task ${id} updated to ${status}.`
            : `Error: ${result.error}`,
        },
      ],
    };
  }
);

server.tool(
  "get_all_tasks",
  "获取所有任务（可按状态筛选，含 cancelled/superseded 终态）",
  {
    status: z
      .enum([
        "todo",
        "in_progress",
        "auto_verified",
        "awaiting_manual_acceptance",
        "done",
        "cancelled",
        "superseded",
      ])
      .optional()
      .describe("Filter by status"),
    project_dir: PROJECT_DIR_PARAM,
  },
  async ({ status, project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    const tasks = sel.state.getAllTasks(status ? { status } : undefined);
    return {
      content: [
        {
          type: "text" as const,
          text: tasks.length > 0
            ? JSON.stringify(tasks, null, 2)
            : "No tasks found.",
        },
      ],
    };
  }
);

server.tool(
  "get_task_by_id",
  "获取单个任务详情",
  { id: z.string().describe("Task ID"), project_dir: PROJECT_DIR_PARAM },
  async ({ id, project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    const task = sel.state.getTaskById(id);
    return {
      content: [
        {
          type: "text" as const,
          text: task ? JSON.stringify(task, null, 2) : `Task ${id} not found.`,
        },
      ],
    };
  }
);

server.tool(
  "add_subtask",
  "添加子任务（如 review 修复任务）",
  {
    parent_id: z.string().describe("Parent task ID"),
    id: z.string().describe("New subtask ID"),
    title: z.string(),
    description: z.string(),
    dependencies: z.array(z.string()),
    complexity: z.enum(["S", "M", "L"]),
    acceptance_criteria: z.array(z.string()),
    files: z.array(z.string()),
    module: z.string(),
    needs_manual_review: z.boolean(),
    acceptance_mode: z.enum(["auto", "manual", "milestone_manual"]).optional(),
    verification_profile: z
      .string()
      .optional()
      .describe("profile 名（运行时按外置 verification-profiles.json 校验）"),
    verification_commands: z.array(z.string()).optional(),
    review_checklist: z.array(z.string()).optional(),
    stage_gate: z.boolean().optional(),
    priority: z.number().optional().describe("越大越优先（默认 0）"),
  },
  async ({ parent_id, ...subtaskData }) => {
    const { unknown, valid } = findUnknownProfiles([subtaskData.verification_profile]);
    if (unknown.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: unknown verification_profile "${unknown[0]}". Valid: ${valid.join(", ")}. (Add it to ~/.workflow-core/policies/verification-profiles.json — no code change needed.)`,
          },
        ],
      };
    }
    const subtask: Task = {
      ...subtaskData,
      status: "todo",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      commit_hash: "",
      notes: `Subtask of ${parent_id}`,
    };
    const result = state.addSubtask(parent_id, subtask);
    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `Subtask ${subtaskData.id} added under ${parent_id}.`
            : `Error: ${result.error}`,
        },
      ],
    };
  }
);

server.tool(
  "close_task",
  "关闭任务到 cancelled/superseded（受审计管理旁路，不走前向状态机）。只能从非终态进入；cancelled 需 reason；superseded 需 reason + replacement_task_id（校验存在/非自身/非closed/无环）。写一条 task_closed 审计日志。",
  {
    id: z.string().describe("要关闭的任务 ID"),
    status: z.enum(["cancelled", "superseded"]).describe("关闭目标态"),
    reason: z.string().describe("关闭原因（必填）"),
    replacement_task_id: z
      .string()
      .optional()
      .describe("superseded 时必填：替代任务 ID"),
  },
  async ({ id, status, reason, replacement_task_id }) => {
    const r = state.closeTask(id, status, reason, replacement_task_id);
    return {
      content: [
        {
          type: "text" as const,
          text: r.success
            ? `Task ${id} closed as ${status}.` +
              (r.affected_dependents?.length
                ? ` Affected dependents: ${r.affected_dependents.join(", ")}.`
                : "")
            : `Error: ${r.error}`,
        },
      ],
    };
  }
);

server.tool(
  "update_tasks",
  "批量前向改状态（逐条仍走完整校验，允许部分成功；不接受 cancelled/superseded——请用 close_tasks）。",
  {
    updates: z
      .array(
        z.object({
          id: z.string(),
          status: z.enum([
            "todo",
            "in_progress",
            "auto_verified",
            "awaiting_manual_acceptance",
            "done",
          ]),
          notes: z.string().optional(),
        })
      )
      .describe("批量状态更新"),
  },
  async ({ updates }) => {
    const r = state.updateTasks(updates);
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  }
);

server.tool(
  "close_tasks",
  "批量关闭任务（逐条走 close_task：cancelled 需 reason；superseded 需 reason + replacement_task_id）。",
  {
    closes: z
      .array(
        z.object({
          id: z.string(),
          status: z.enum(["cancelled", "superseded"]),
          reason: z.string(),
          replacement_task_id: z.string().optional(),
        })
      )
      .describe("批量关闭"),
  },
  async ({ closes }) => {
    const r = state.closeTasks(closes);
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  }
);

server.tool(
  "archive_module",
  "把某 module 下所有非终态任务批量取消（close_task cancelled）。用于整模块作废。",
  {
    module: z.string().describe("模块名"),
    reason: z.string().describe("作废原因"),
  },
  async ({ module, reason }) => {
    const r = state.archiveModule(module, reason);
    return {
      content: [
        {
          type: "text" as const,
          text: `Archived module "${module}": cancelled ${r.closed.length} task(s)${r.closed.length ? " (" + r.closed.join(", ") + ")" : ""}.`,
        },
      ],
    };
  }
);

server.tool(
  "reopen_task",
  "复活终态任务（受审计管理旁路，不走前向状态机）：把 done/cancelled/superseded 移回 todo（默认）或 in_progress。reason 必填。superseded 复活会清空 replacement_task_id；其在 supersede 时被改写的下游依赖不会自动改回（见审计日志）。",
  {
    id: z.string().describe("Task ID"),
    reason: z.string().describe("复活原因（必填）"),
    to_status: z.enum(["todo", "in_progress"]).optional().describe("复活目标态（默认 todo）"),
  },
  async ({ id, reason, to_status }) => {
    const r = state.reopenTask(id, reason, to_status ?? "todo");
    return {
      content: [
        {
          type: "text" as const,
          text: r.success
            ? `Task ${id} reopened to ${to_status ?? "todo"}.`
            : `Error: ${r.error}`,
        },
      ],
    };
  }
);

server.tool(
  "set_task_priority",
  "调整任务优先级（数值，越大越优先）。get_next_task 在依赖满足的 todo 中优先返回高优先级者，同分按创建顺序。",
  {
    id: z.string().describe("Task ID"),
    priority: z.number().describe("越大越优先（默认 0）"),
  },
  async ({ id, priority }) => {
    const r = state.setTaskPriority(id, priority);
    return {
      content: [
        {
          type: "text" as const,
          text: r.success ? `Task ${id} priority set to ${priority}.` : `Error: ${r.error}`,
        },
      ],
    };
  }
);

server.tool(
  "edit_task",
  "编辑任务元数据（绝不碰 status）。可改 title/description/notes/acceptance_criteria/review_checklist/files/dependencies/complexity/module/acceptance_mode/needs_manual_review/stage_gate/verification_profile/verification_commands；status 请用 update_task_status/close_task/reopen_task，id/时间戳/commit_hash/replacement_task_id/closed_at/close_reason 不可改。改 acceptance_mode 会同步 needs_manual_review；改 dependencies 校验存在/自环/环并去重；终态任务只许改纯文档字段；空改动跳过。写一条 task_edited 审计日志。仅作用于当前活动项目（不接 project_dir）。",
  {
    id: z.string().describe("Task ID"),
    title: z.string().optional(),
    description: z.string().optional(),
    notes: z.string().optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    review_checklist: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).optional(),
    complexity: z.enum(["S", "M", "L"]).optional(),
    module: z.string().optional(),
    acceptance_mode: z.enum(["auto", "manual", "milestone_manual"]).optional(),
    needs_manual_review: z.boolean().optional(),
    stage_gate: z.boolean().optional(),
    verification_profile: z
      .string()
      .optional()
      .describe("profile 名（运行时按外置 verification-profiles.json 校验）"),
    verification_commands: z.array(z.string()).optional(),
  },
  async ({ id, ...rest }) => {
    // Forward only fields the caller actually supplied (Zod gives undefined for omitted
    // keys, and z.object strips anything not declared above — so audit-only fields can
    // never reach editTask through this tool).
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    const r = state.editTask(id, patch as Parameters<typeof state.editTask>[1]);
    return {
      content: [
        {
          type: "text" as const,
          text: r.success
            ? r.noop
              ? `Task ${id}: no changes (all provided values already current).`
              : `Task ${id} edited: ${(r.changed_fields ?? []).join(", ")}.`
            : `Error: ${r.error}`,
        },
      ],
    };
  }
);

server.tool(
  "edit_tasks",
  "批量元数据补丁（逐条走 edit_task 的校验与应用，绝不碰 status；允许部分成功，逐条返回 { id, success, error?, changed_fields?, noop? }）。可改字段同 edit_task；改 acceptance_mode 会同步 needs_manual_review；改 dependencies 校验存在/自环/环并去重；终态任务只许改纯文档字段；空改动跳过。每条成功且非空各写一条 source=edit_tasks 审计日志。后一条基于前一条成功后的最新状态校验。仅作用于当前活动项目（不接 project_dir）。",
  {
    edits: z
      .array(
        z.object({
          id: z.string().describe("Task ID"),
          title: z.string().optional(),
          description: z.string().optional(),
          notes: z.string().optional(),
          acceptance_criteria: z.array(z.string()).optional(),
          review_checklist: z.array(z.string()).optional(),
          files: z.array(z.string()).optional(),
          dependencies: z.array(z.string()).optional(),
          complexity: z.enum(["S", "M", "L"]).optional(),
          module: z.string().optional(),
          acceptance_mode: z.enum(["auto", "manual", "milestone_manual"]).optional(),
          needs_manual_review: z.boolean().optional(),
          stage_gate: z.boolean().optional(),
          verification_profile: z
            .string()
            .optional()
            .describe("profile 名（运行时按外置 verification-profiles.json 校验）"),
          verification_commands: z.array(z.string()).optional(),
        })
      )
      .describe("批量元数据补丁"),
  },
  async ({ edits }) => {
    // Strip undefined keys per entry so audit-only fields can never reach editTasks
    // (z.object already strips undeclared keys; this drops omitted optionals).
    const calls = edits.map((e) => {
      const { id, ...rest } = e;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      return { id, patch: patch as Parameters<typeof state.editTask>[1] };
    });
    const r = state.editTasks(calls);
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  }
);

server.tool("get_verification_profiles", "获取共享 verification profile 定义", {}, async () => {
  const verificationProfilesPath = path.join(
    workflowCoreDir,
    "policies",
    "verification-profiles.json"
  );
  const content = fs.existsSync(verificationProfilesPath)
    ? fs.readFileSync(verificationProfilesPath, "utf-8")
    : JSON.stringify(
        {
          error: "verification profiles file not found",
          path: verificationProfilesPath,
        },
        null,
        2
      );
  return {
    content: [{ type: "text" as const, text: content }],
  };
});

server.tool(
  "migrate_tasks_schema",
  "将现有 state 迁移到 schema v1（幂等、不改任务 status、回填日志 kind、补双率 progress、盖 schema_version）。已是 v1 则跳过。",
  {},
  async () => {
    const r = state.migrateTaskSchema();
    return {
      content: [
        {
          type: "text" as const,
          text: r.skipped
            ? `Already at schema v${r.schema_version}; migration skipped (no-op).`
            : `Migrated to schema v${r.schema_version}: ${r.migrated} tasks normalized, ${r.logs_migrated} log entries backfilled with kind/event_type. Task statuses unchanged; progress recomputed (dual-rate).`,
        },
      ],
    };
  }
);

server.tool(
  "lint_state",
  "只读一致性检查（L8）：交叉核对 tasks/project/logs/focus 四处真相，报告漂移 findings（{code,severity:error|warning|info,message,task_id?,entities?,autofixable?}）+ 计数汇总。可接 project_dir 跨项目只读巡检（仿 get_portfolio，机器本地检查如 schema/profile 自动抑制）。纯读，不改任何状态。",
  { project_dir: PROJECT_DIR_PARAM },
  async ({ project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    // An explicit project_dir is treated as a cross-project read (suppresses
    // machine-local checks); the active project (no project_dir) lints fully.
    const r = sel.state.lintState({ crossProject: !sel.active });
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  }
);

server.tool(
  "reconcile",
  "应用安全确定性自动修复（L8）：修 progress_drift + self_dependency + active task 的 stale_close_fields/stale_replacement（跳终态、逐条 reconcile_* 审计、幂等）；其余 findings 作为 remaining 返回，请用 edit_task 手修。默认只动当前活动项目。可接 project_dir：解析为当前活动项目时照常 apply；解析为 foreign 项目时**只返回 dry-run/fix-plan（不落盘）**——要真正修别的项目请先 set_project_dir 切过去（对 foreign 传 apply:true 或 dry_run:false 会被拒，返回 cross_project_apply_requires_set_project_dir + resolved_project_dir）。",
  {
    project_dir: PROJECT_DIR_PARAM,
    apply: z
      .boolean()
      .optional()
      .describe("对 foreign 项目强制落盘（会被拒，提示先 set_project_dir）；活动项目恒落盘，可省"),
    dry_run: z
      .boolean()
      .optional()
      .describe("显式 dry_run；foreign 默认即 dry-run，对 foreign 传 false 强制落盘会被拒"),
  },
  async ({ project_dir, apply, dry_run }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    if (sel.active) {
      // Active project (no project_dir, or a project_dir canonically equal to it): apply.
      const r = sel.state.reconcile();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ mode: "applied", resolved_project_dir: sel.resolved, ...r }, null, 2),
          },
        ],
      };
    }
    // Foreign project: dry-run only. An explicit request to write it is refused —
    // writes must go through the active project (set_project_dir first).
    if (apply === true || dry_run === false) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: "cross_project_apply_requires_set_project_dir",
                message: `reconcile will not write a foreign project. Run set_project_dir("${sel.resolved}") to make it active, then reconcile.`,
                resolved_project_dir: sel.resolved,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    const plan = sel.state.reconcilePlan();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ mode: "dry_run", resolved_project_dir: sel.resolved, ...plan }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "rename_task",
  "重命名任务 id 并级联改写所有引用（dependencies[]/replacement_task_id/focus.related_task_ids，去重）。old_id 必须存在；new_id 非空且不与现有 id 冲突；old_id===new_id 为成功 noop。落盘前做全局后置校验（无重复 id / dangling / self / 依赖环 / replacement 缺失或成环），失败则整体拒绝、不部分写入。logs 不可变，仅追加一条 task_renamed 审计（含 old_id/new_id/rewired 计数/focus_rewritten/logs_preserved）。终态任务可 rename（不改 status/closed_at/close_reason）。仅作用于当前活动项目（不接 project_dir）。",
  {
    old_id: z.string().describe("现有任务 id"),
    new_id: z.string().describe("新任务 id（非空、不与现有 id 冲突）"),
  },
  async ({ old_id, new_id }) => {
    const r = state.renameTask(old_id, new_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  }
);

// ==================== Logs ====================

server.tool(
  "add_log",
  "记录操作日志。kind 为粗分类(省略则按 type 推断)，event_type 承接细类型，entities/tags 用于结构化检索(proposal-id/合同号等)。task_id 可为 null 表示项目级 ops 事件。",
  {
    type: z.string().describe("Log type (e.g., task_status_change, decision, review_completed)"),
    message: z.string().describe("Log message"),
    task_id: z.string().nullable().optional().describe("Related task ID (null = 项目级事件)"),
    kind: z
      .enum([
        "task_transition",
        "ops_event",
        "decision",
        "note",
        "workflow_failure",
        "focus_update",
      ])
      .optional()
      .describe("粗分类；省略则按 type 推断"),
    event_type: z.string().nullable().optional().describe("细类型(承接 legacy type 语义)"),
    tags: z.array(z.string()).optional().describe("标签"),
    entities: z.record(z.any()).optional().describe("关联实体(proposal-id/合同号等)"),
    source: z.string().nullable().optional().describe("来源"),
  },
  async ({ type, message, task_id, kind, event_type, tags, entities, source }) => {
    state.addLog({
      timestamp: new Date().toISOString(),
      type,
      kind,
      event_type: event_type ?? null,
      tags,
      entities,
      source: source ?? null,
      task_id: task_id || null,
      from_status: null,
      to_status: null,
      message,
    });
    return {
      content: [{ type: "text" as const, text: "Log entry added." }],
    };
  }
);

server.tool(
  "get_logs",
  "获取操作日志(可作 journal 视图)。kind/event_type/since 在切片之前过滤，避免被更新的无关条目挤掉更早的匹配项。",
  {
    n: z.number().int().min(1).optional().describe("返回条数(默认 10，>=1)；等价于 limit，过滤之后才切片"),
    kind: z
      .enum([
        "task_transition",
        "ops_event",
        "decision",
        "note",
        "workflow_failure",
        "focus_update",
      ])
      .optional()
      .describe("按粗分类过滤(对旧条目按 type 推断)"),
    event_type: z.string().optional().describe("按细类型过滤(匹配 event_type，回退 type)"),
    since: z.string().optional().describe("仅返回该 ISO 时间(含)之后的日志"),
    project_dir: PROJECT_DIR_PARAM,
  },
  async ({ n, kind, event_type, since, project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    const logs = sel.state.getLogs({ kind, event_type, since, limit: n ?? 10 });
    return {
      content: [
        {
          type: "text" as const,
          text: logs.length > 0
            ? JSON.stringify(logs, null, 2)
            : "No logs found.",
        },
      ],
    };
  }
);

// ==================== Context Recovery ====================

server.tool(
  "get_project_context",
  "获取完整项目上下文（用于新会话恢复）。返回 PRD/架构摘要 + 任务状态(含双完成率 metrics) + in_progress 全文 + current_focus + 最近日志 + next_task_blocked_reason 诊断。context_mode 仅影响呈现排序/摘要，不过滤任务。",
  {
    context_mode: z
      .enum(["build", "ops", "hybrid"])
      .optional()
      .describe("呈现 hint（默认 build）。仅影响默认排序/摘要，不参与权限/过滤/状态机。"),
    max_recent_events: z
      .number()
      .optional()
      .describe("返回的最近日志条数（默认 build=10 / hybrid=15 / ops=20）"),
    include_full_in_progress: z
      .boolean()
      .optional()
      .describe("是否返回 in_progress 任务全文（默认 true；token 预算紧张时设 false）"),
    project_dir: PROJECT_DIR_PARAM,
  },
  async ({ context_mode, max_recent_events, include_full_in_progress, project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    const context = sel.state.getProjectContext({
      context_mode,
      max_recent_events,
      include_full_in_progress,
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(context, null, 2) },
      ],
    };
  }
);

// ==================== Portfolio (cross-project, read-only) ====================

server.tool(
  "get_portfolio",
  "跨项目只读聚合：对传入的每个项目目录返回 进度双率 / 当前焦点 / 下一个任务 / 阻塞原因 摘要。仅接受 per-call project_dirs[]（不读任何注册表，避免隐式上下文）。坏项目逐条返回 error，不拖垮整体。纯读，不改任何项目状态。",
  {
    project_dirs: z
      .array(z.string())
      .min(1)
      .describe("要聚合的项目根目录列表（每个含 .claude/state）；必填，不读注册表"),
  },
  async ({ project_dirs }) => {
    const entries = project_dirs.map((dir) => {
      const sel = selectState(dir);
      if (!sel.ok) {
        return {
          project_dir: dir,
          resolved_project_dir: sel.resolved,
          ok: false,
          error_kind: sel.error_kind,
          error: sel.error,
        };
      }
      return {
        project_dir: dir,
        resolved_project_dir: sel.resolved,
        ok: true,
        ...sel.state.getPortfolioSummary(),
      };
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
    };
  }
);

// ==================== Current Focus (ops) ====================

server.tool(
  "get_current_focus",
  "获取当前焦点快照(ops)：返回 focus.json 结构化对象(含服务端计算的 is_stale)，无则返回 null。",
  { project_dir: PROJECT_DIR_PARAM },
  async ({ project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    const focus = sel.state.getCurrentFocus();
    return {
      content: [
        { type: "text" as const, text: focus ? JSON.stringify(focus, null, 2) : "null" },
      ],
    };
  }
);

server.tool(
  "set_current_focus",
  "设置当前焦点快照(ops)：单槽 pinned 指针，写入 .claude/state/focus.json；updated_at 由服务端盖章；并记一条 focus_update 日志。",
  {
    summary: z.string().describe("当前在做/在等什么的一句话"),
    last_event: z.string().nullable().optional().describe("上一个关键事件"),
    next_trigger: z.string().nullable().optional().describe("下一个触发条件"),
    waiting_on: z.array(z.string()).optional().describe("在等待的实体/人/任务"),
    related_task_ids: z.array(z.string()).optional().describe("关联任务 ID"),
    related_entities: z
      .record(z.any())
      .optional()
      .describe("关联实体(proposal-id/合同号等)"),
    source: z.string().nullable().optional().describe("来源(如 manual / workflow 名)"),
    stale_after: z
      .string()
      .nullable()
      .optional()
      .describe("过期时间 ISO；超过则 is_stale=true"),
  },
  async (input) => {
    const focus = state.setCurrentFocus(input);
    return {
      content: [
        { type: "text" as const, text: `Current focus updated at ${focus.updated_at}.` },
      ],
    };
  }
);

// ==================== Diagnostics ====================

server.tool(
  "get_server_info",
  "获取 MCP Server 诊断信息（当前项目目录、状态文件路径；可选 project_dir 跨项目只读探测，返回 resolved/active）",
  { project_dir: PROJECT_DIR_PARAM },
  async ({ project_dir }) => {
    const sel = selectState(project_dir);
    if (!sel.ok) return selErr(sel);
    const stateDir = sel.state_path;
    let stateExists = false;
    let files: string;
    try {
      const st = fs.statSync(stateDir);
      stateExists = st.isDirectory();
      files = st.isDirectory()
        ? fs.readdirSync(stateDir).join(", ")
        : "state path exists but is not a directory";
    } catch {
      files = "directory not found";
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              project_dir: sel.resolved,
              active_project: sel.active,
              state_dir: stateDir,
              state_exists: stateExists,
              state_files: files,
              cwd: process.cwd(),
              env_PROJECT_DIR: process.env.PROJECT_DIR || "not set",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ==================== Start Server ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Project Manager server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
