# MCP Project Manager

Claude Code 的项目状态管理 MCP Server。提供 PRD、架构文档、任务列表、日志的持久化存储和跨会话恢复。

## 安装

```powershell
cd ~\.claude\mcp-project-manager
npm install
npm run build
```

## 配置

在项目目录的 `.claude/.mcp.json` 中添加（或在全局 `~/.claude/.mcp.json`）：

```json
{
  "mcpServers": {
    "project-manager": {
      "command": "node",
      "args": ["C:/Users/你的用户名/.claude/mcp-project-manager/dist/index.js"],
      "env": {
        "PROJECT_DIR": "."
      }
    }
  }
}
```

## 提供的 Tools

### 项目管理
- `get_project_info` — 获取项目元信息
- `update_project_info` — 更新项目名称、状态、技术栈
- `save_prd` / `get_prd` — 保存/获取 PRD 文档
- `save_architecture` / `get_architecture` — 保存/获取架构设计

### 任务管理
- `create_tasks` — 批量创建任务
- `get_next_task` — 获取下一个可执行任务（自动判断依赖）。把 `cancelled`/`superseded` 视为「已关闭但非完成」：`superseded` 依赖通过替代链解析，`cancelled` 依赖会阻塞其下游并显式上报（不静默死锁）
- `update_task_status` — 更新任务状态（强制校验合法迁移路径）。前向状态机不变：`todo -> in_progress -> auto_verified -> {done | awaiting_manual_acceptance}`，`awaiting_manual_acceptance -> {done | in_progress}`。`done` 仍为需走完整验收的终态。该工具不再接受 `cancelled`/`superseded`，传入会被拒绝并提示改用 `close_task`
- `close_task` — 受审计的管理旁路，把非终态任务关闭到 `cancelled` 或 `superseded`（不走前向状态机；无法关闭/反完成 `done` 任务，v1 不支持 reopen）。`cancelled` 需 `reason`；`superseded` 需 `reason` + `replacement_task_id`（校验存在/非自身/非已关闭/替代链无环）。写入一条 `task_closed` 审计日志（kind=task_transition，event_type=task_closed，source=close_task）。`superseded` 会把被关闭任务的每条下游依赖边改指向其替代任务（保持 DAG 可运行）；`cancelled` 若仍有下游依赖，会发出 `dependents_blocked_by_cancel` ops_event 以便控制器重新指向或关闭它们
- `get_all_tasks` — 获取所有任务（可按状态筛选，含 `cancelled`/`superseded` 终态）
- `get_task_by_id` — 获取单个任务详情
- `add_subtask` — 添加子任务

任务状态枚举共 7 个：`todo`、`in_progress`、`auto_verified`、`awaiting_manual_acceptance`、`done`、`cancelled`、`superseded`。其中 `cancelled`/`superseded` 为终态（无出边），且只能通过 `close_task` 进入，不能经由 `update_task_status` 到达。

### 日志
- `add_log` — 记录操作日志。除原有字段外，还可附带 `kind`（task_transition | ops_event | decision | note | workflow_failure | focus_update）、`event_type`、`tags`、`entities`、`source`；`task_id` 可为 null（用于记录项目级 ops 事件）
- `get_logs` — 获取日志。可传 `{n/limit, kind, event_type, since}`，按 `kind`/`event_type`/`since` 先过滤再截断（journal 视图）

### 上下文恢复
- `get_project_context` — 一次性返回完整项目上下文（向后兼容、增量扩展）。除原有内容外，现在还返回：完整的 `in_progress_tasks`；`tasks_summary.metrics`（`total_all`、`active_total`、`done`、`cancelled`、`superseded`、`closed_total`、`raw_completion_rate`、`active_completion_rate` 双速率指标）；`tasks_summary.next_task_blocked_reason`（none | all_done | blocked_in_progress | blocked_by_cancelled_dep）；`current_focus`（可能为 null，附 `is_stale`）；`schema_version`。新增可选参数：`context_mode`（build | ops | hybrid，仅为展示提示，不作为过滤或权限——各模式下任务集合完全一致）、`max_recent_events`、`include_full_in_progress`
- `get_current_focus` / `set_current_focus` — 读取/写入单槽位的 ops 关注点快照，存储在 `.claude/state/focus.json`。这是辅助性的 ops 级状态、可能过期，并非任务状态；任务 status 仍是权威

### 迁移
- `migrate_tasks_schema` — v0 -> v1 迁移，幂等；从不改动任务 status，回填日志的 `kind`/`event_type`，并写入 `schema_version=1`
