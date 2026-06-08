# ADR-003：project-manager 跨项目 / portfolio 能力（L6 · Phase 3）

- **状态**：Proposed —— **等待用户 sign-off，未开始写代码**
- **日期**：2026-06-08
- **作者**：Claude Code（Opus 4.8，主控）
- **目标组件**：`AutoSkills/mcp/project-manager`（`src/state.ts` + `src/index.ts`）
- **承接**：ADR-001 / ADR-002（Phase 0/1/2，已实现）。继续叠在 `feat/pm-ops-capabilities` 分支。
- **多模型评审**：CouncilFlow 讨论 `disc_20260608T183815211628Z`（claude 主控 + codex）。
- **拟发布版本**：MCP `1.2.0` → `1.3.0`（加法、向后兼容）。

---

## 0. 背景与痛点（反馈 L6）
`projectDir` / `state` 是模块级**可变全局**（`index.ts:28-29`），`set_project_dir` 直接重赋值。要看另一个项目的状态，必须 `set_project_dir` 切过去、用完**还得记得切回**（反馈作者实测中就忘了切回）。本质痛点是：**无法在不丢失当前活动项目的前提下，查询/汇总另一个项目的状态**。

---

## 0.1 决策摘要（codex 评审后定稿）

| # | 决策 | 取舍 |
|---|---|---|
| **A** | per-call 可选 `project_dir` | **本轮只覆盖只读工具**；`resolveState(project_dir?)` 返回针对该目录的临时 StateManager，**绝不改写全局** `projectDir`/`state`。 |
| **A-write** | 跨项目**写** | **本轮 defer**（codex：显式路径 ≠ 安全的写意图）。设计草案见 §5，留作 3.x，需 `confirm_cross_project` + 审计 + resolved 回显。 |
| **B** | `get_portfolio(project_dirs[])` 只读聚合 | 做。**仅接受 per-call 列表**；注册表文件**不做默认隐式读取源**（codex：否则重新制造隐式上下文问题）。 |
| **C** | pointer 任务类型 | **defer**（最复杂；跨项目依赖/验收/阻塞传播/防环，等读取层稳定再设计）。 |

**不需要新 schema_version**（纯读 + 加法）。**不动** `set_project_dir` 语义与"单活动项目"默认。

---

## 1. A · per-call `project_dir`（只读工具）

### 1.1 `resolveState` 安全契约
```ts
type StateSelection =
  | { ok: true; state: StateManager; resolved: string; state_path: string; active: boolean }
  | { ok: false; error_kind: "not_a_project" | "state_unreadable"; error: string; resolved: string };

function selectState(projectDir?: string): StateSelection;
```
- `projectDir` 缺省 → 返回模块级全局 `state`（`active: true`），行为完全同现状。
- 提供时：
  - **路径加固**（codex）：`path.resolve` → 尽力 `fs.realpathSync`(canonical，解 symlink)；Windows 大小写/UNC/跨盘交给 realpath 归一；失败回退 resolve 值。
  - 校验 `<dir>/.claude/state` 存在：不存在 → `error_kind="not_a_project"`。
  - **绝不**改写模块级 `projectDir`/`state`；只构造一个**临时** `new StateManager(resolved)`。
- **错误分类**（codex：别糊成一个"友好错误"）：`not_a_project`（无 .claude/state）、`state_unreadable`（存在但读/解析失败）。
- **可调试性**（codex）：所有支持 project_dir 的工具返回里带 `resolved_project_dir` + `state_path`。

### 1.2 工具读写分类矩阵（codex：先分类再启用）
- **只读工具（本轮新增可选 `project_dir`，共 10 个）**：`get_project_info`、`get_prd`、`get_architecture`、`get_all_tasks`、`get_task_by_id`、`get_next_task`、`get_logs`、`get_project_context`、`get_current_focus`、`get_server_info`。
- **写工具（本轮不加跨项目 `project_dir`）**：create_tasks / add_subtask / update_task_status / close_task / reopen_task / set_task_priority / update_tasks / close_tasks / archive_module / set_current_focus / add_log / save_prd / save_architecture / update_project_info / migrate_tasks_schema。
- `get_verification_profiles` 读的是全局策略文件，不涉项目 state → 不加 `project_dir`。

> 痛点本质是**读**（"在不切走的情况下看另一项目进展/焦点"）。只读 per-call 已完整消除该痛点；写留到 3.x 受控开放。

---

## 2. B · `get_portfolio(project_dirs[])`（只读聚合）
- 入参：`project_dirs: string[]`（**仅 per-call，无注册表默认**）。空/缺省 → 报错要求显式传入（codex：不自动读注册表）。
- 逐项目用 `selectState` 解析；逐条返回：
  ```
  { project_dir, resolved_project_dir, ok,
    // ok=true:
    name, status,
    metrics: { total_all, active_total, done, cancelled, superseded, raw_completion_rate, active_completion_rate },
    current_focus: { summary, is_stale } | null,
    next_task: { id, title } | null,
    next_task_blocked_reason,
    // ok=false:
    error_kind, error }
  ```
- 一个项目坏不拖垮整体（逐条 ok/error）。纯读，不引入跨项目写或依赖语义。

---

## 3. 并发 / 安全（codex open question）
- project-manager 是 **stdio 单进程**；StateManager 读写是**同步 fs**（readFileSync/writeFileSync），单次工具调用内 read→write 之间无 await，故进程内无交错。
- **本轮只读** → 不引入任何新的写竞争。
- 已知的**跨进程**风险（多个 CLI 会话各自的 MCP 进程写同一 `.claude/state`）是**既有**问题，非本轮引入；留待 3.x 跨项目写时一并用"临时文件+rename 原子写"加固，并记 `active_project_dir`/`target_project_dir`/`source_tool` 审计字段。本轮文档注明。

---

## 4. 兼容性 / ripple
- **纯加法**：`project_dir` 全部可选；不传 = 现状。`set_project_dir` 与单活动项目默认**不变**。
- **11 个技能**：继续用 `set_project_dir`；`project_dir` 仅用于跨项目**只读**查询（如 project-status / project-resume 想看别的项目，或一个未来的 portfolio 技能）。本轮技能散文**仅注记**该新参数 + `get_portfolio`，不改流程。
- **CouncilFlow**：CF 若需跨项目，仅用只读 portfolio/`project_dir`（integration.md 注明）。CF Python 零改动。
- **无新 schema_version**。

---

## 5. 显式 defer（本轮不做，留设计草案）
- **跨项目写**：写工具加 `project_dir` 时必须 `confirm_cross_project: true`，写一条带 `active_project_dir`/`target_project_dir`/`source_tool`/`request_id` 的审计日志，返回 `resolved_project_dir`，并配原子写 + 更严测试。（codex：显式路径 ≠ 安全写意图。）
- **portfolio 注册表文件**：`~/.workflow-core/portfolio.json` 作为**显式**便利（如单独的 `portfolio_add/list` 工具或显式 `--use-registry`），**绝不**做 `get_portfolio` 的隐式默认源；需处理陈旧路径/跨机迁移/Windows 漫游。
- **pointer 任务类型**（跨项目依赖）：等读取层 + portfolio 稳定再设计。

---

## 6. 分阶段实施（每步 verify + 单独 commit）
| 步骤 | 内容 | profile |
|---|---|---|
| C1 | `selectState(project_dir?)` 安全契约（路径 canonical + 错误分类）+ 单测 | backend |
| C2 | 10 个只读工具加可选 `project_dir`（经 selectState；返回带 resolved_project_dir/state_path）+ 单测（跨项目读、not_a_project、不污染全局） | backend |
| C3 | `get_portfolio(project_dirs[])` 只读聚合 + 单测（多项目、坏项目逐条 error、空列表报错） | backend |
| C4 | 下游同步：README + CF integration.md + project-status/project-resume 注记（跨项目只读 + portfolio）；状态图模板**不涉及** | docs |
| C5 | 收口：clean build + 全量测试 + 舰队 smoke + CHANGELOG + version → 1.3.0 | workflow_meta（stage gate，sign-off） |

> 与 Phase 1/2 同分支，一并部署。

---

## 7. 待确认项（请 sign-off）
1. 采纳 **A(只读 per-call project_dir) + B(portfolio 只读) 本轮、跨项目写 / 注册表 / pointer 全部 defer**？（codex 力主只读先行、写受控后置——我采纳。）
2. **项目根判定 = 有 `.claude/state` 即算项目**（不强制要求 AGENTS.md/manifest）——认可？
3. 错误分类用精简两类 **`not_a_project` / `state_unreadable`**（够用即可，不铺成 codex 列的 5-6 类）——认可？
4. 跨项目**写**确实本轮不做（只读已消除 L6 主痛点），留 3.x——认可？

> 确认后：追加 C1–C5 任务，按序实现验证，C5 收口 gate。
