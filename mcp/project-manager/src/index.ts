import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StateManager, Task } from "./state.js";

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

const server = new McpServer({
  name: "project-manager",
  version: "1.0.0",
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

server.tool("get_project_info", "获取项目元信息", {}, async () => {
  const info = state.getProjectInfo();
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

server.tool("get_prd", "获取 PRD 文档", {}, async () => {
  const prd = state.getPRD();
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

server.tool("get_architecture", "获取架构设计文档", {}, async () => {
  const arch = state.getArchitecture();
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
          .enum([
            "backend",
            "frontend_unit",
            "frontend_browser",
            "frontend_visual",
            "docs",
            "workflow_meta",
          ])
          .optional(),
        verification_commands: z.array(z.string()).optional(),
        review_checklist: z.array(z.string()).optional(),
        stage_gate: z.boolean().optional(),
      })
    ).describe("Array of tasks to create"),
  },
  async ({ tasks }) => {
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

server.tool("get_next_task", "获取下一个可执行任务（依赖已全部完成）", {}, async () => {
  const task = state.getNextTask();
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
  "获取所有任务（可按状态筛选）",
  {
    status: z
      .enum([
        "todo",
        "in_progress",
        "auto_verified",
        "awaiting_manual_acceptance",
        "done",
      ])
      .optional()
      .describe("Filter by status"),
  },
  async ({ status }) => {
    const tasks = state.getAllTasks(status ? { status } : undefined);
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
  { id: z.string().describe("Task ID") },
  async ({ id }) => {
    const task = state.getTaskById(id);
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
      .enum([
        "backend",
        "frontend_unit",
        "frontend_browser",
        "frontend_visual",
        "docs",
        "workflow_meta",
      ])
      .optional(),
    verification_commands: z.array(z.string()).optional(),
    review_checklist: z.array(z.string()).optional(),
    stage_gate: z.boolean().optional(),
  },
  async ({ parent_id, ...subtaskData }) => {
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
  "将现有 tasks.json 迁移为兼容 acceptance_mode 的 schema",
  {},
  async () => {
    const result = state.migrateTaskSchema();
    return {
      content: [
        {
          type: "text" as const,
          text: `Migrated ${result.migrated} tasks to the acceptance-mode-compatible schema.`,
        },
      ],
    };
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
    n: z.number().optional().describe("返回条数(默认 10)；等价于 limit，过滤之后才切片"),
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
  },
  async ({ n, kind, event_type, since }) => {
    const logs = state.getLogs({ kind, event_type, since, limit: n ?? 10 });
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
  },
  async ({ context_mode, max_recent_events, include_full_in_progress }) => {
    const context = state.getProjectContext({
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

// ==================== Current Focus (ops) ====================

server.tool(
  "get_current_focus",
  "获取当前焦点快照(ops)：返回 focus.json 结构化对象(含服务端计算的 is_stale)，无则返回 null。",
  {},
  async () => {
    const focus = state.getCurrentFocus();
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
  "获取 MCP Server 诊断信息（当前项目目录、状态文件路径）",
  {},
  async () => {
    const stateDir = path.join(projectDir, ".claude", "state");
    const stateExists = fs.existsSync(stateDir);
    const files = stateExists
      ? fs.readdirSync(stateDir).join(", ")
      : "directory not found";
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              project_dir: projectDir,
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
