# ADR-005：project-manager v1.5.0 — task identity rename + reconcile safety envelope

- **状态**：Proposed —— 设计经主控（Claude Opus 4.8）对 `state.ts`/`lint.ts`/`index.ts` 逐函数核验 + CouncilFlow architect/planner 影响分析交叉确认，**等待用户 sign-off 后实现**
- **日期**：2026-06-09
- **作者**：Claude Code（Opus 4.8，主控）
- **目标组件**：`AutoSkills/mcp/project-manager`（`src/state.ts` + `src/index.ts` + `src/lint.ts`）
- **承接**：ADR-001（ops 能力）/ ADR-002（backlog）/ ADR-003（跨项目只读）/ ADR-004（edit_task + lint_state/reconcile）。本 ADR = **v1.5.0**，落实 ADR-004 §7 列出的 4 项 deferred。
- **依据**：用户在 `/project-resume` 后明确要求把 ADR-004 §7 的 4 项 deferred 立项为下一个增量。

---

## 0. 决策摘要（TL;DR）

| # | 决策 | 结论 |
|---|---|---|
| R1 | `rename_task` | 改任务 **id** + 级联改写所有引用（`dependencies[]` / `replacement_task_id` / `focus.related_task_ids`）。写工具，**不接 `project_dir`**。最高风险，单独 review gate |
| R2 | rename 审计 | logs **不可变**（历史 `task_id`/message/entities 原样保留）；仅追加一条 `event_type=task_renamed` ops_event，记录 old/new + rewired 计数 |
| R3 | rename 校验 | 落盘前做**全局后置校验**（无重复 id / dangling / self / cycle / replacement 链断裂或成环）；任一失败则整体拒绝、不部分写入 |
| R4 | rename 终态 | 终态任务（done/cancelled/superseded）**可** rename（身份维护，非状态迁移）；但绝不改 `status`/`closed_at`/`close_reason` |
| C1 | 跨项目 `reconcile(project_dir)` | foreign project **只出 dry-run/fix-plan，不落盘**；active project 照常 apply |
| C2 | 跨项目写护栏 | foreign + `apply:true`/`dry_run:false` → 结构化错误 `cross_project_apply_requires_set_project_dir`（含 `resolved_project_dir`）。**不放开外部写**，守住 ADR-003/004 显式上下文契约 |
| B1 | `edit_tasks` | 批量元数据补丁，仿 `closeTasks`/`updateTasks` 的逐条 `.map()` + per-item result + **允许部分成功**。复用 `edit_task` 校验 helper，绝不复制 E2/E3/E4 |
| A1 | reconcile 字段清理 autofix | 新纳入 `stale_close_fields_on_nonterminal` + `stale_replacement_on_nonsuperseded`（**仅 active 任务**）。终态上的同类 finding 保持只报告 |
| S1 | schema_version | **不 bump**（保持 1）。4 项均为工具能力 + 审计事件扩展，无新增必需 on-disk 字段 |

---

## 1. 背景

ADR-004（v1.4.0）交付了 `edit_task`（单条元数据补丁）+ `lint_state`（只读一致性诊断）+ `reconcile`（最小安全 autofix），并在 §7 显式 defer 了 4 项：批量 `edit_tasks`、`rename_task`、reconcile 字段清理类 autofix、跨项目**写** reconcile。本 ADR 落实这 4 项。

核心原则（承接 ADR-001/002/003/004，逐条不动）：

- 加法优先、向后兼容；严格前向状态机不可削弱；`cancelled`/`superseded` 仅经 `close_task`。
- 所有管理旁路写审计日志（`addLog kind=ops_event/decision`）。
- 读工具可接 `project_dir`；**写工具默认不接 `project_dir`**（要写别的项目必须先 `set_project_dir` 切活动项目）——ADR-003/004 的"显式上下文契约"。
- 现有 36 任务、21 测试文件 / 128 用例、`schema_version=1` 必须零回归。

实现复用面（已逐函数核实）：

- `editTask`(state.ts:454) 的字段白名单 / E2 acceptance 成对重算 / E3 依赖无环 / E4 Zod 解析后合并；批量惯例 `closeTasks`(state.ts:700) / `updateTasks`(state.ts:694) 是逐条 `.map()` 包装、返回 per-item result。
- `closeTask`(state.ts:820) superseded 的 dependents-rewrite（state.ts:872-879：`old→new` 映射 + `Set` 去重）。
- `validateReplacement`(state.ts:924)：存在 / 非自身 / 无环 + close-time 的"target 必须 active"。
- `reconcile`(state.ts:1263)：lint → 安全 fix（save-first-then-log、跳终态）→ `{fixed, remaining}`；现注册无参数(index.ts:706)。
- `lint_state` 已接 `project_dir` 并用 `crossProject:!sel.active`(index.ts:693-703)；`selectState`(index.ts:46) 返回 `active` 标志。
- `CurrentFocus.related_task_ids`(state.ts:115)；lint 已有 `focus_related_task_missing` 检查(lint.ts:540)。

**勘误（本 ADR 顺带修正 ADR-004）**：ADR-004 文案多处写"13 可编辑字段"，实际代码 `EDITABLE_FIELDS = DOC_FIELDS(6) + NON_DOC_EDITABLE_FIELDS(8) = 14`。本 ADR 把口径统一为 **14**。

---

## 2. Feature R · `rename_task`（改 id + 级联引用改写）

**风险最高**：它改变任务身份，触碰所有"任务 id 即引用"的地方，但**不改变任务状态**。

### 2.1 语义
- active-project-only，**不接 `project_dir`**（与所有写工具一致）。
- `old_id` 必须存在；`new_id` 必须非空且**不与现有 id 冲突**。
- `old_id === new_id` → **成功 noop**（不写审计），与 `edit_task` 空改动跳过同风格。
- 改写范围（一次性原子落盘）：
  1. 目标任务 `id: old_id → new_id`
  2. 所有任务 `dependencies[]` 中 `old_id → new_id`，**去重**（`Set`）
  3. 所有任务 `replacement_task_id === old_id → new_id`
  4. `focus.json.related_task_ids` 中 `old_id → new_id`，**去重**
  5. 历史 `logs.json` 的 `task_id`/message/entities **不改**（不可变历史，R2）

### 2.2 审计（R2）
追加一条 `addLog({ kind:'ops_event', event_type:'task_renamed', source:'rename_task', task_id:new_id, entities:{ old_id, new_id, rewired_dependencies, rewired_replacements, focus_rewritten, logs_preserved:true } })`。

### 2.3 校验（R3，红线）
- 落盘**前**做全局后置校验：无重复 id、无 dangling 依赖、无 self-dep、无依赖环、无 replacement 链断裂/成环。任一失败 → 整体拒绝、零部分写入。
- **不要**对全量现存 replacement 链直接复用当前 `validateReplacement`：它是 close-time 校验，会拒绝 terminal replacement target，但一个 replacement task 后续变 `done` 是健康状态。→ 从 `validateReplacement` 抽出"存在 / 非自身 / 无环"公共链路校验（PM-601），close_task 仍**额外**保留"target 必须 active"。

### 2.4 终态交互（R4）
终态任务可 rename（身份维护），但绝不改 `status`/`closed_at`/`close_reason`。rename cancelled 任务 → 依赖继续阻塞在 new_id；rename superseded source → 保留 replacement 链；rename replacement target → 改写所有指向它的 `replacement_task_id`。

---

## 3. Feature C · 跨项目 `reconcile(project_dir)`（安全包络）

ADR-004 §3.1/§3.2 显式拒绝 `reconcile` 接 `project_dir`（静默改外部项目破坏 ADR-003 契约）。本 ADR **不推翻**该契约，而是给出安全包络。

### 3.1 API 行为
- `reconcile()` 无参数：现有行为，对当前活动项目 apply。
- `reconcile({ project_dir })` 解析为**当前 active project**：可 apply，行为等同当前项目（复用 `selectState` 的 `active:true`，含绝对路径指向自身的情形）。
- `reconcile({ project_dir })` 为 **foreign project**：**只返回 dry-run / fix-plan**（= lint + "若 apply 会修哪些"清单），**不写** tasks/project/logs。
- foreign + `apply:true` 或 `dry_run:false`：返回结构化错误 `cross_project_apply_requires_set_project_dir`，含 `resolved_project_dir` 与"先 set_project_dir 再 reconcile"的提示。
- 目录解析 / 错误分类复用 `selectState` / `resolveProjectDir`，与 `lint_state` / `get_portfolio` 一致（逐项 `not_a_project` / `state_unreadable`）。

### 3.2 权衡
- ✅ 不破坏显式上下文契约，避免静默改错项目；跨项目可"看诊断 + 看修复计划"。
- ⚠️ 一条命令修复外部项目仍不行——这是**有意**的安全边界。
- ❌ 否决方案：`confirm/apply` 双确认后直接写 foreign。它会把写工具变成 per-call project writer，需要专门 ADR 推翻 ADR-003/004，本轮不做。

---

## 4. Feature B · `edit_tasks`（批量元数据补丁）

- `StateManager.editTasks(edits)` 仿 `closeTasks`/`updateTasks`：逐条 `.map(e => ({ id:e.id, ...this.editTask(e.id, e.patch) }))`，返回 `[{ id, success, error?, changed_fields?, noop? }]`，**允许部分成功**（非全-or-无）。
- 逐条按顺序校验并应用；后一条基于前一条成功后的最新状态校验 DAG，因此最终仍无环。
- 复用 PM-601 抽出的 `edit_task` 校验 helper（字段白名单 / E2 / E3 / E4 / diff），**绝不复制**出第二套逻辑。
- 有效 diff 为空 → 该条成功 noop，不写 tasks、不写 log；每个成功且非 noop 的条目写 `task_edited` 审计，`source='edit_tasks'`。
- **不动** `edit_task` 单条工具的现有行为（含"语法空 patch `{}` 失败"，由 `edit_task.test.ts` 锁死）。

---

## 5. Feature A · reconcile 字段清理类 autofix

在现有最小集（`progress_drift` + `self_dependency`）外，新纳入两项**仅 active 任务**的字段清理：

| finding | 处置 | 理由 | 审计 event_type |
|---|---|---|---|
| `stale_close_fields_on_nonterminal`（active） | 纳入 autofix | active 任务残留 `closed_at`/`close_reason` 是派生异常；清空即恢复真相；不改 status；幂等 | `reconcile_stale_close_fields_clear` |
| `stale_replacement_on_nonsuperseded`（active） | 纳入 autofix | active 任务不应带 replacement 指针；清 `null` 确定性恢复 | `reconcile_stale_replacement_clear` |
| `stale_replacement_on_nonsuperseded`（终态 done/cancelled） | **保持只报告** | 涉及终态历史冻结，字段异常也不自动重写 terminal task |
| 其余 lint finding | 保持只报告 | 需业务判断或会重写历史（dangling dep / missing replacement / terminal audit 缺失） |

实现要点：`lint.ts` 给上述 active-only finding 设 `autofixable:true`；`reconcile` 只改目标字段、不改 status、不批量重规范化、**不碰终态**；每条清理 save-first-then-log 写 ops_event；第二次 reconcile `fixed` 必为空（幂等）。

---

## 6. 向后兼容（必过的既有不变量）

- 严格前向状态机；`cancelled`/`superseded` 仅经 `close_task`；`update_task_status` 仍拒绝终态。
- progress legacy 5 键 + dual-rate 8 键语义不变（`state.characterization.test.ts` / `progress.test.ts` 锁死）。
- superseded 链防御性解析、cancelled 依赖告警不静默（`deps_semantics.test.ts`）；close_task 审计日志形状（`close_task.test.ts`）。
- migrate 幂等不改 status（`migration.test.ts`）；跨项目读不重置 module-global（`cross_project.test.ts`）。
- **无 schema_version bump**（S1）：新工具不加任何必需 on-disk 字段；`event_type` 是开放字符串；focus rewrite 复用现有 schema。

---

## 7. 测试计划

- 既有：`edit_task.test.ts`（空 patch 仍失败、E2/E3/E4 不回退）、`reconcile.test.ts`（progress/self_dependency/幂等不受影响）、`cross_project.test.ts`（foreign reconcile dry-run 不写外部）、`deps_semantics.test.ts`/`close_task.test.ts`（抽 helper 后 supersede rewrite + dedupe 不变）、`migration.test.ts`（仍 v1）。
- 新增：`edit_tasks.test.ts`、`rename_task.test.ts`、`reconcile_field_cleanup.test.ts`、`cross_project_reconcile.test.ts`，并扩 `lint_state.test.ts`（autofixable flags）、`current_focus.test.ts`（rename 改写 related_task_ids）。

---

## 8. 任务拆解（→ PM，线性链）

六个任务都重改 `state.ts`，并行必冲突，故串行：

- **PM-601** 抽公共 helper（edit 校验 `prepareTaskEdit`/`applyPreparedTaskEdit`、引用 rewrite helper、replacement graph 公共校验），零行为变更。auto / state-core。
- **PM-602** `edit_tasks` 批量（复用 PM-601 helper）。auto / task-edit。dep: PM-601。
- **PM-603** reconcile 字段清理 autofix + lint autofixable flags。auto / reconcile。dep: PM-602。
- **PM-604** 跨项目 reconcile dry-run/fix-plan。auto / cross-project-reconcile。dep: PM-603。
- **PM-605** `rename_task`（最高风险，单独 review gate）。**manual** / task-identity。dep: PM-604。
- **PM-606** ADR-005 收口（flip Proposed→Accepted）+ ADR-004 §7/13→14 勘误 + CHANGELOG/README + 1.4.0→1.5.0 + 部署 + 多 agent review。**milestone_manual + stage_gate**。dep: PM-605。

---

## 9. 非目标 / Deferred（v1.5）

- 跨项目**写** reconcile（一条命令修外部项目）——仍须显式 `set_project_dir`（C2 的有意边界）。
- `rename_task` 回填历史 logs 的旧 id（logs 保持不可变，靠 `task_renamed` 审计追溯）。
- 批量 `rename_tasks`、批量 reconcile autofix 跨多项目、`commit_hash` 合法 setter（承接 ADR-004 §7）。
- 多槽 focus、`reopen_task` 已在更早 ADR 处置，本轮不动。
