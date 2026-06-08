# ADR-002：project-manager 反馈 backlog 收尾（Phase 2 · 批次一）

- **状态**：Proposed —— **等待用户 sign-off，未开始写代码**
- **日期**：2026-06-08
- **作者**：Claude Code（Opus 4.8，主控）
- **目标组件**：`AutoSkills/mcp/project-manager`（`src/state.ts` + `src/index.ts`）
- **承接**：ADR-001（Phase 0/1，已实现）。本批继续叠在 `feat/pm-ops-capabilities` 分支上（Phase 1 尚未合并/部署）。
- **拟发布版本**：MCP `1.1.0` → `1.2.0`（继续加法、向后兼容）
- **本批不含**：current_focus 多槽、context_mode→CF handoff（批次二）；L6 跨项目/portfolio（批次三，架构级，单独设计）。

---

## 0. 决策摘要

| # | 反馈项 | 决策 | 风险 |
|---|---|---|---|
| B1 | **L5** 优先级 | `Task.priority?: number`（默认 0，越大越优先）；`getNextTask` 在「依赖满足的 todo」中取最高优先级，**同分按创建顺序**（= 现状）。新增 `set_task_priority`。 | 低（加法，全 0 时等于现状） |
| B2 | **L4** 批量 | `update_tasks`（批量前向改状态，逐条仍走完整校验）、`close_tasks`（批量关闭）、`archive_module(module, reason)`（把某 module 下所有非终态任务批量 cancel）。 | 低（薄封装，复用现有校验/close_task） |
| B3 | reopen | `reopen_task(id, reason, to_status?)`：受审计地把**终态**任务（done/cancelled/superseded）复活到 todo（默认）或 in_progress。补回 ADR-001 的 v1 非目标，解决「误标 done 无法撤」。 | 中（终态→活跃的反向跳，受审计旁路） |
| B4 | **L9** profile 去硬枚举 | `verification_profile` 校验改为**从外置文件 `~/.workflow-core/policies/verification-profiles.json` 的 keys 动态读取**，不再硬编码 Zod 枚举；加 profile 只改那个文件，不改代码。 | 中（改校验模型，但向后兼容） |

**不需要新的 schema_version**：所有新增 Task 字段（priority）都由 `normalizeTask` 读时补默认，惰性兼容，沿用 v1。

---

## 1. B1 · 任务优先级（L5）

**现状**：`getNextTask` 返回「数组（创建）顺序里第一个依赖满足的 todo」，没有优先级概念——所以会回 3 天前建的旧任务。

**设计**：
- `Task` 加 `priority?: number`（默认 `0`；**约定越大越优先**）。
- `normalizeTask`：`priority: typeof task.priority === "number" ? task.priority : 0`。
- `getNextTask`：在所有「`todo` 且依赖满足（沿用 Phase 1 的 superseded 解析 / cancelled 不满足语义）」的任务里，**选 `priority` 最大者；同分按数组顺序取第一个**（稳定，等于现状）。
- `create_tasks` / `add_subtask` Zod：加 `priority: z.number().optional()`。
- 新增工具 `set_task_priority(id, priority)`（事后调整优先级；写一条 `note`/`ops_event` 日志）。

**向后兼容**：既有任务无 priority → 默认 0 → 全部同分 → 退化为创建顺序 = **完全等于现状**。`get_project_context` 可顺带在 `tasks_summary` 里反映（可选，不强制）。

---

## 2. B2 · 批量操作（L4）

**现状**：只有 `create_tasks` 是批量入口；改状态、关闭都是单条。

**设计**（全部复用现有逐条逻辑，不绕过校验）：
- `update_tasks(updates: [{id, status, notes?}])` → 逐条调 `updateTaskStatus`，返回 `[{id, success, error?}]`。**部分成功**允许（每条独立）。仍走前向 gauntlet + 拒绝 cancelled/superseded（引导 close_task）。
- `close_tasks(closes: [{id, status, reason, replacement_task_id?}])` → 逐条调 `closeTask`，返回逐条结果 + 合并的 `affected_dependents`。
- `archive_module(module, reason)` → 把该 `module` 下所有**非终态**任务批量 `close_task(cancelled, reason)`；返回被关闭列表。（用于「整个模块作废」。）

**价值**：把「关 6 个过期任务」从 6+ 次调用变成 1 次；`archive_module` 一键清场。所有变更照旧写审计日志。

---

## 3. B3 · reopen_task（撤销/复活）

**背景**：ADR-001 把 reopen 列为 v1 非目标；critic 指出「误标 done 无法撤回」是真实运营需求。本批补上。

**设计**：
- `reopen_task(id, reason, to_status?: "todo" | "in_progress")`：
  - 仅允许源状态为**终态**（`done` / `cancelled` / `superseded`）；非终态 → 报错「task is not closed」。
  - `to_status` 默认 `"todo"`；可选 `"in_progress"`。`reason` 必填。
  - 效果：置 `status=to_status`；清空 `closed_at` / `close_reason`；若原为 `superseded`，清空 `replacement_task_id` 并在日志注明（**注意**：supersede 当时已把下游依赖改指到 replacement，reopen **不自动改回**——日志显式提示，必要时人工/`update_tasks` 再调整）。
  - 写审计日志 `kind=task_transition, event_type=task_reopened, source=reopen_task, from_status, to_status`；重算 progress。
  - 是**受审计的管理旁路**（与 close_task 对称），不走 VALID_TRANSITIONS 前向边。
- 调用边界（同 close_task）：正常只由 **project-feedback / 控制器管理决策**调用，role 阶段不调。

**状态机影响**：终态不再「绝对无出边」——多了一条 `done|cancelled|superseded --reopen_task--> todo|in_progress` 的受审计反向边。需更新状态图模板（见 §5）。

---

## 4. B4 · verification_profile 去硬枚举（L9）

**现状**：profile **名字**硬编码 3 处（TS 类型 `state.ts` + create_tasks/add_subtask 两个 Zod 枚举 `index.ts`），但**定义**在外置 `~/.workflow-core/policies/verification-profiles.json`——加一个 profile 要改 3 处代码。

**设计**：
- `VerificationProfile` 类型放宽为 `string`（保留已知名做注释/文档，不再做穷举联合）。
- `create_tasks` / `add_subtask` 的 `verification_profile`：`z.enum([...])` → `z.string().optional()`。
- 新增内部 helper `loadProfileNames()`：读外置文件的 `Object.keys(profiles)`（复用 `get_verification_profiles` 的读取路径）。
- 校验在**工具 handler 层**做：若传了 `verification_profile` 且不在外置文件 keys 里 → **拒绝并报错**，错误信息列出当前合法名字；若外置文件缺失 → 宽松放行（不阻塞）。
- 这样**加一个 profile 只需编辑那个 JSON 文件**，代码零改动。

**向后兼容**：现有任务用的 `backend`/`frontend_unit`/`workflow_meta` 等都是该文件的 keys → 仍合法。

---

## 5. 下游 ripple（doc/skill 同步）

- **状态图模板 ×2**（global-claude-CLAUDE.md / global-codex-AGENTS.md）：加 `reopen_task` 反向边说明（终态不再绝对无出边）。
- **README** + **CouncilFlow integration.md**：新增工具（`update_tasks` / `close_tasks` / `archive_module` / `reopen_task` / `set_task_priority`）、`priority` 字段、profile 改为外置可扩展。
- **project-plan** 技能：可在任务里写 `priority`；profile 现在从外置文件取（加新 profile 改文件即可）。
- **project-feedback / project-next** 技能：`reopen_task` 的调用边界（同 close_task，归管理决策）。
- CouncilFlow Python：**预计仍零改动**（state-agnostic）；实现时再核实一次。

---

## 6. 分阶段实施（每步 verify + 单独 commit，沿用 Phase 1 节奏）

| 步骤 | 内容 | profile |
|---|---|---|
| B1 | priority 字段 + getNextTask 优先级 + set_task_priority + 测试 | backend |
| B3 | reopen_task 方法+工具（终态校验、清字段、审计日志）+ 测试 | backend |
| B2 | update_tasks / close_tasks / archive_module + 测试 | backend |
| B4 | profile 动态校验（去 Zod 硬枚举 + handler 校验）+ 测试 | backend |
| B5 | 下游同步：状态图模板 ×2 / README / CF integration.md / project-plan/feedback/next | docs |
| B6 | 收口：clean build + 全量测试 + CHANGELOG + version → 1.2.0 | workflow_meta（stage gate，sign-off） |

> 验证基线沿用：每步 `npm --prefix mcp/project-manager run build` + `npm --prefix mcp/project-manager test`；characterization 快照若因 getNextTask 优先级/新工具而变，在同一 commit 内更新并注明。
> 部署与 Phase 1 合并：本批与 Phase 1 同分支，**一并部署/合并**（不单独部署）。

---

## 7. 待确认项（请 sign-off）
1. 采纳 B1–B4 定稿？特别是：
   - **B1 优先级约定「越大越优先、同分按创建顺序」**（是否反过来，或用 high/medium/low 枚举？我选数值是为灵活）。
   - **B3 reopen 的边界**：允许从 `done` 复活（撤销误完成）；superseded 复活时**不自动改回**已被改写的下游依赖（仅日志提示）——认可？
   - **B4 未知 profile 名「拒绝并提示」**（而非静默放行）——认可？
2. `archive_module`（整模块作废）是否要做，还是只留 `update_tasks` + `close_tasks`？
3. 不引入新 schema_version（靠 normalizeTask 读时补默认）——认可？

> 确认后：在 AutoSkills 项目里 `create_tasks` 追加 B1–B6 任务，按序实现并验证，最后到 B6 收口 gate。
