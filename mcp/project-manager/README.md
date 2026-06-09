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
- `get_next_task` — 获取下一个可执行任务（自动判断依赖）。把 `cancelled`/`superseded` 视为「已关闭但非完成」：`superseded` 依赖通过替代链解析，`cancelled` 依赖会阻塞其下游并显式上报（不静默死锁）。现在是优先级感知的：返回可运行 `todo` 中 `priority` 最高的一个，同优先级按创建顺序打破平局；优先级永远不会越过依赖门控（高优先级但依赖未满足的任务仍不会被选中）
- `update_task_status` — 更新任务状态（强制校验合法迁移路径）。前向状态机不变：`todo -> in_progress -> auto_verified -> {done | awaiting_manual_acceptance}`，`awaiting_manual_acceptance -> {done | in_progress}`。`done` 仍为需走完整验收的终态。该工具不再接受 `cancelled`/`superseded`，传入会被拒绝并提示改用 `close_task`
- `close_task` — 受审计的管理旁路，把非终态任务关闭到 `cancelled` 或 `superseded`（不走前向状态机；反向恢复改用 `reopen_task`）。`cancelled` 需 `reason`；`superseded` 需 `reason` + `replacement_task_id`（校验存在/非自身/非已关闭/替代链无环）。写入一条 `task_closed` 审计日志（kind=task_transition，event_type=task_closed，source=close_task）。`superseded` 会把被关闭任务的每条下游依赖边改指向其替代任务（保持 DAG 可运行）；`cancelled` 若仍有下游依赖，会发出 `dependents_blocked_by_cancel` ops_event 以便控制器重新指向或关闭它们
- `set_task_priority` — 调整单个任务的优先级（数字，越大越紧急）
- `edit_task` — 编辑任务**元数据**（绝不碰 `status`）。可改 `title`/`description`/`notes`/`acceptance_criteria`/`review_checklist`/`files`/`dependencies`/`complexity`/`module`/`acceptance_mode`/`needs_manual_review`/`stage_gate`/`verification_profile`/`verification_commands`；`status` 请用 `update_task_status`/`close_task`/`reopen_task`，`id`/时间戳/`commit_hash`/`replacement_task_id`/`closed_at`/`close_reason` 不可改。改 `acceptance_mode` 会同步重算 `needs_manual_review`（矛盾对拒绝）；改 `dependencies` 校验存在/自环/环并去重（原子拒绝）；`verification_profile` 按外部策略校验（与 `create_tasks` 一致）；终态任务只许改纯文档字段；空改动跳过写入；写一条 `task_edited` 审计日志（per-field from→to）。仅作用于当前活动项目（不接 `project_dir`）——这是"改个 notes/依赖也得手搓 tasks.json"痛点的正解
- `edit_tasks` — `edit_task` 的批量版本 `[{id, ...可改字段}]`（1.5.0+）：逐项走 `edit_task` 的校验与应用、允许部分成功、逐项返回 `{id, success, error?, changed_fields?, noop?}`；后一条基于前一条成功后的最新状态校验（跨条依赖/环判定一致）；每条成功且非空写一条 `source=edit_tasks` 的 `task_edited` 审计。复用单条 `edit_task` 的字段白名单/E2/E3 校验，绝不碰 `status`
- `update_tasks` — 批量前向推进状态 `[{id, status, notes?}]`：逐项处理、允许部分成功，每项仍走完整的前向状态机校验；不接受 `cancelled`/`superseded`（改用 `close_tasks`）
- `close_tasks` — `close_task` 的批量版本 `[{id, status, reason, replacement_task_id?}]`
- `archive_module` — 归档整个模块：把该模块下所有非终态任务批量 `close_task` 到 `cancelled`，需 `reason`
- `reopen_task` — 受审计的 `close_task` 反向操作：把终态任务（`done`/`cancelled`/`superseded`）拉回 `todo`（默认）或 `in_progress`，`reason` 必填。属管理旁路、不走前向状态机。reopen 一个 `superseded` 任务会清除其 `replacement_task_id`，但当初 supersede 时改指向替代任务的那些下游依赖不会自动恢复（审计日志会标记此情况）
- `rename_task` — 重命名任务 `id` 并级联改写所有引用（`dependencies[]`/`replacement_task_id`/`focus.related_task_ids`，去重）（1.5.0+）。`old_id` 须存在、`new_id` 非空且不与现有 id 冲突、`old_id===new_id` 为成功 noop。落盘前做全局后置校验（无重复 id / dangling / self / 依赖环 / replacement 断裂或成环），失败整体拒绝、**不部分写入**。logs 不可变，仅追加一条 `task_renamed` 审计（含 old/new id、rewired 计数、`focus_rewritten`、`logs_preserved`）。终态任务可 rename（不改 `status`/`closed_at`/`close_reason`）。仅作用于当前活动项目（不接 `project_dir`）
- `get_all_tasks` — 获取所有任务（可按状态筛选，含 `cancelled`/`superseded` 终态）
- `get_task_by_id` — 获取单个任务详情
- `add_subtask` — 添加子任务

任务状态枚举共 7 个：`todo`、`in_progress`、`auto_verified`、`awaiting_manual_acceptance`、`done`、`cancelled`、`superseded`。其中 `cancelled`/`superseded` 为终态（无出边），只能通过 `close_task`/`close_tasks`/`archive_module` 进入，不能经由 `update_task_status` 到达。终态现各有且仅有一条受审计的反向边：经 `reopen_task` 回到 `todo`/`in_progress`（不走前向状态机，属管理旁路）。

任务新增可选字段 `priority`（数字，默认 `0`，越大越紧急），用于 `get_next_task` 的优先级排序，但不改变依赖门控语义。

`verification_profile` 的取值（profile 名）在运行时校验：合法名取自外部策略文件 `~/.workflow-core/policies/verification-profiles.json` 的 `profiles` 键，不再是写死的枚举。新增一个 profile 只需编辑该 JSON 文件，无需改代码；未知名会被拒绝（仅当该文件缺失时宽松放行）。`get_verification_profiles` 可读取这些共享定义。

### 日志
- `add_log` — 记录操作日志。除原有字段外，还可附带 `kind`（task_transition | ops_event | decision | note | workflow_failure | focus_update）、`event_type`、`tags`、`entities`、`source`；`task_id` 可为 null（用于记录项目级 ops 事件）
- `get_logs` — 获取日志。可传 `{n/limit, kind, event_type, since}`，按 `kind`/`event_type`/`since` 先过滤再截断（journal 视图）

### 上下文恢复
- `get_project_context` — 一次性返回完整项目上下文（向后兼容、增量扩展）。除原有内容外，现在还返回：完整的 `in_progress_tasks`；`tasks_summary.metrics`（`total_all`、`active_total`、`done`、`cancelled`、`superseded`、`closed_total`、`raw_completion_rate`、`active_completion_rate` 双速率指标）；`tasks_summary.next_task_blocked_reason`（none | all_done | blocked_in_progress | blocked_by_cancelled_dep）；`current_focus`（可能为 null，附 `is_stale`）；`schema_version`。新增可选参数：`context_mode`（build | ops | hybrid，仅为展示提示，不作为过滤或权限——各模式下任务集合完全一致）、`max_recent_events`、`include_full_in_progress`
- `get_current_focus` / `set_current_focus` — 读取/写入单槽位的 ops 关注点快照，存储在 `.claude/state/focus.json`。这是辅助性的 ops 级状态、可能过期，并非任务状态；任务 status 仍是权威

### 一致性检查 / 修复（lint，1.4.0+）
- `lint_state` — **只读**一致性扫描（L8）：交叉核对 tasks / project.json / logs / focus 四处真相，返回 `{ findings:[{code, severity:error|warning|info, message, task_id?, entities?, autofixable?}], summary }`。共 25 个检查，分四族：依赖 DAG（dangling/self/cycle/重复 id/空 id/cancelled 死链/superseded 断链/husk 未改写/重复依赖）、close-supersede 字段完整性（superseded 缺替代/替代缺失/替代链环/非 superseded 残留替代/非终态残留 close 字段/终态缺 close 审计）、进度元信息（**`progress_drift`**＝`project.json.progress` 与重算不符，L8 头牌；status 与任务不符/acceptance 字段矛盾/未知 status/schema 落后/未知 profile）、日志-focus（status 与最近日志不符/终态缺 close 日志/时间戳逆序/focus 引用已删任务）。检测复用引擎自身的 `depSatisfied`/`endsCancelled`/`validateReplacement` 走法——健康的 `superseded → done` 链不会误报。可接 `project_dir` 跨项目只读巡检（机器本地检查如 schema/profile 自动抑制）。纯读不改。
- `reconcile` — 安全确定性自动修复：修 `progress_drift`（调既有 `updateProjectProgress` 重算）与 `self_dependency`（去自环、跳终态）；**1.5.0+ 新增** active 任务的字段清理 `stale_close_fields_on_nonterminal`（清 `closed_at`/`close_reason`）与 `stale_replacement_on_nonsuperseded`（清残留 `replacement_task_id`），仅限 active 任务、跳终态（终态保持只报告，冻结历史），各写 `reconcile_stale_*_clear` 审计，幂等；其余 findings 作 `remaining` 返回交 `edit_task` 手修。**1.5.0+ 可接 `project_dir`**：解析为当前活动项目时照常 apply；**foreign 项目只返回 dry-run / fix-plan（不落盘）**，对 foreign 强制写（`apply:true` / `dry_run:false`）返回 `cross_project_apply_requires_set_project_dir` + `resolved_project_dir`——要真正修别的项目请先 `set_project_dir` 切过去。

### 迁移
- `migrate_tasks_schema` — v0 -> v1 迁移，幂等；从不改动任务 status，回填日志的 `kind`/`event_type`，并写入 `schema_version=1`

### 跨项目 / portfolio（只读，1.3.0+）
- 所有**只读**工具（`get_project_info` / `get_prd` / `get_architecture` / `get_all_tasks` / `get_task_by_id` / `get_next_task` / `get_logs` / `get_project_context` / `get_current_focus` / `get_server_info`）新增可选 `project_dir`：定位另一个项目（含 `.claude/state` 的目录）做**只读**查询，**不切换**当前活动项目、**不改写**任何全局态（消除"`set_project_dir` 切过去还得记得切回"的痛点）。不传 = 当前活动项目，行为完全同现状。路径会 canonical 化（解 symlink / Windows 大小写 / UNC）；非项目目录返回 `not_a_project` / `state_unreadable` 分类错误。`get_server_info` 会回显 `resolved` / `active_project` 便于排错。
- `get_portfolio` — 跨项目只读聚合：对传入的 `project_dirs[]`（**仅 per-call 列表，不读任何注册表**）逐项目返回 `name`/`status`/双率 metrics/`current_focus`/`next_task`/`next_task_blocked_reason` 摘要；坏项目逐条 `error`，不拖垮整体。
- **写工具默认只动活动项目**（跨项目写仍需 `set_project_dir` 切过去）；1.5.0+ `reconcile` 可对 foreign 项目产出**只读 dry-run / fix-plan**（真正落盘仍须切过去）。portfolio 注册表 / pointer 任务类型留待后续。
