# ADR-004：project-manager 增补 edit_task + lint_state/reconcile（L8 + 元数据补丁）

- **状态**：Proposed —— 设计经 8-agent sweep + 3-adversary red-team 加固，**等待用户 sign-off 后实现**
- **日期**：2026-06-09
- **作者**：Claude Code（Opus 4.8，主控）+ 设计加固 workflow `wf_f05ebdbc-9e3`
- **目标组件**：`AutoSkills/mcp/project-manager`（`src/state.ts` + `src/index.ts`，新增 `src/lint.ts`）
- **依据**：
  - 实战反馈 `CouncilFlow/project-manager-feedback.md` L8（三处真相静默漂移，无一致性检查）
  - 用户本轮反馈：edit_task 是"唯一真卡手的点"（改 notes/字段必须手搓 tasks.json → 反而制造漂移）
  - 设计加固 workflow：20 基础不变量 + 13 红队补漏 + 5 条向后兼容铁律，全部带 `state.ts` 行号佐证
- **承接**：ADR-001（ops 能力）/ ADR-002（backlog）/ ADR-003（跨项目只读）。本 ADR = **v1.4.0**。

---

## 0. 决策摘要（TL;DR）

| # | 决策 | 结论 |
|---|---|---|
| E1 | `edit_task` | 元数据补丁工具，**绝不碰 status**。14 字段可改（勘误：原文写 13；实际 `DOC_FIELDS` 6 + `NON_DOC_EDITABLE_FIELDS` 8 = 14，见 ADR-005），其余拒绝。写工具（不接 `project_dir`） |
| E2 | acceptance 耦合 | 改 `acceptance_mode` ↔ `needs_manual_review` **必须成对重算**（error 级，写进代码非文档） |
| E3 | 依赖编辑 | 改 `dependencies` 需 存在性 + 无自环 + 无环 + 去重，**原子拒绝** |
| E4 | 字段白名单 | Zod 只声明 14 可改字段（勘误：原文 13）、合并**解析后**对象、不 `.passthrough()` → 审计字段无法泄漏；schema 不得比 `create_tasks` 严 |
| L1 | `lint_state` | **只读**诊断，接 `project_dir`（跨项目巡检，仿 `get_portfolio` 逐项报错）。~22 检查，复用引擎自身走法 |
| L2 | `reconcile` | **写**工具，**只动活动项目**（拒绝 `project_dir`）。**最小安全自动修复集**，逐条审计，幂等 |
| L3 | autofix 范围 | 仅 `progress_drift`（委托 `updateProjectProgress`）+ `self_dependency`（去自环，跳终态）。其余只报告 |
| L4 | 兼容纪律 | 对 `schema_version < CURRENT` 的遗留/手种数据降级 warning；reconcile 不批量重规范化、不重写 DAG、进度委托单一真相源 |

---

## 1. 背景

`project-manager` 有 4 个状态写入口（`update_task_status` 前向机、`close_task`/`reopen_task` 审计旁路、`set_task_priority`），但：

1. **没有通用的元数据补丁入口**。要改一个 task 的 title/notes/依赖/验收字段，只能手搓 `tasks.json` —— 而手搓正是 L8 所说"静默漂移"的来源。`update_task_status` 只能在状态迁移时顺带写 notes，`set_task_priority` 只动 priority。→ **edit_task**。
2. **没有任何一致性检查**（L8）。三处真相（tasks / logs / project 元信息 + focus）可静默漂移。本项目就真命中过两类：`project.json.progress` 与 `tasks.json` 不一致；`status='completed'` 而仍有未完成任务。→ **lint_state / reconcile**。

核心原则（承接 ADR-001/002/003）：加法优先、向后兼容、严格前向状态机不动、所有管理旁路写审计日志、读工具可接 `project_dir`、写工具不接。

---

## 2. Feature 1 · `edit_task`（元数据补丁）

### 2.1 字段权限矩阵

**可编辑（14 个；勘误：原文写 13，实际为 `DOC_FIELDS` 6 + `NON_DOC_EDITABLE_FIELDS` 8 = 14 — 见 ADR-005）**：

| 字段 | 类别 | 校验 | 终态任务 |
|---|---|---|---|
| `title` `description` `notes` `acceptance_criteria` `review_checklist` `files` | 纯文档 | 类型/非空（title 非空白） | ✅ 可改 |
| `dependencies` | 影响流程 | 存在性 + 无自环 + 无环 + 去重，**原子拒绝** | ❌ 禁改 |
| `acceptance_mode` `needs_manual_review` | gate | 枚举 + **成对重算**（见 E2） | ❌ 禁改 |
| `stage_gate` | gate | boolean | ❌ 禁改 |
| `verification_profile` | gate | 复用 `findUnknownProfiles`（policy 文件缺失则宽松不拦） | ❌ 禁改 |
| `verification_commands` | 验证 | string[] | ❌ 禁改 |
| `complexity` | 元数据 | enum S\|M\|L | ✅ 可改 |
| `module` | 元数据 | 非空（注：改 module 改变 `archive_module` 未来扫描范围，需审计标注） | ✅ 可改 |

**禁改（路由到正确工具，输入里出现则显式拒绝并指明去哪）**：
- `status` → `update_task_status` / `close_task` / `reopen_task`
- `id` → v1 不支持（改 id 会孤立所有依赖/replacement 指针；未来 `rename_task` 需复用 close_task 的 dependents-rewrite）
- `created_at` / `updated_at` → 不可变历史 / 服务端盖章（edit 成功时服务端自动 bump updated_at）
- `commit_hash` → 无 setter，手设等于伪造 git 记录（open question：谁是合法 writer）
- `replacement_task_id` / `closed_at` / `close_reason` → close_task/reopen_task 审计旁路专属

### 2.2 硬规则（红队标红，必须在代码里强制）

- **E2 acceptance 耦合**：`normalizeTask` 只在 `needs_manual_review` 非布尔时才从 mode 推导（state.ts:1043-1046）；持久化后它恒为布尔，单改 `acceptance_mode` 会让布尔说谎。进程内 gate 仍对（`requiresManualAcceptance`→`resolveAcceptanceMode` 优先 mode，state.ts:1056-1068），但**外部 reader/技能/看板按 `needs_manual_review` 判会误路由**，且违反 CLAUDE.md "`needs_manual_review==false` 等价 `acceptance_mode=auto`"。
  → 规则：任一被改，置 `needs_manual_review = (acceptance_mode !== 'auto')`；显式给出矛盾对则拒绝。
- **E3 依赖无环**：依赖成环**不会卡死** `getNextTask`（seen-set 只护 replacement 链，runnable filter 不递归 deps），但会变"静默永久死锁 + `blocked_in_progress` 假原因"。校验仿 `validateReplacement`（state.ts:675-706）泛化到 dependency DAG。
- **E4 字段白名单**：Zod 只声明 14 字段（勘误：原文 13）、合并 Zod **解析后**对象（绝不 spread 原始入参、不 `.passthrough()`/`.catchall()`）→ 审计字段无法泄漏。每个可改字段 schema **不得比 `create_tasks` 严**（priority `z.number()` 不加界、profile 自由 string、complexity enum），否则老任务变不可编辑。
- **原子性 & 无噪声**：全字段先校验后整体落盘；空改动（值全等）跳过写入与日志。
- **审计**：`addLog({ kind:'ops_event', event_type:'task_edited', source:'edit_task', task_id, entities:{ changes:[{field,from,to}] } })`，并 bump `updated_at`。不调 `updateProjectProgress`（元数据不改状态计数，同 `set_task_priority`）。
- **priority**：edit_task **禁改**，路由 `set_task_priority`（单一职责，避免双审计轨）。

---

## 3. Feature 2 · `lint_state`（只读）+ `reconcile`（写）

### 3.1 架构
- 新增 `src/lint.ts`：`Finding = { code, severity:'error'|'warning'|'info', message, task_id?, entities? }`；`lintState(sm): { findings, summary:{error,warning,info} }`。纯函数，对 in-memory 数据计算。
- `lint_state` 工具：**只读**，接 `project_dir`（跨项目巡检，仿 `get_portfolio`：per-call、坏项目逐条 error 不拖垮）。
- `reconcile` 工具：**写**，**拒绝 `project_dir`**（静默改外部项目破坏 ADR-003 显式上下文契约；要修别的项目须先 `set_project_dir`）。

### 3.2 铁律（红队）
- **复用引擎自身走法**：`dangling`/`cycle`/`cancelled-deadend`/`superseded-chain` 必须复用 `depSatisfied`(state.ts:333-348) / `endsCancelled`(869-884) / `validateReplacement`(675-706) 的精确逻辑，**绝不重写**，否则与 `getNextTask`/`computeNextTaskBlockedReason` 产生分歧、误报健康的 superseded→done 链。
- **遗留数据降级**：对 `schema_version < CURRENT_SCHEMA_VERSION` 的项目、手种 fixture、被裁剪的 logs，把相关检查降级 warning/info、不硬失败（ClaudeX 曾原样导入 17 个 cancelled 无 close 字段，state.ts:997-999）。
- **replacement_task_id `?? null` 归一**后再判（遗留任务该字段可能 undefined）。
- **日志类检查**用 `logKind()`/`inferKind()` + `event_type ?? type` 解析，与 `getLogs` 一致。

### 3.3 检查清单（~22，Comprehensive）

**依赖 DAG** — error：`dangling_dependency`、`self_dependency`✅、`dependency_cycle`、`duplicate_task_id`；warning：`runnable_dep_on_cancelled_deadend`（仅 todo、复用 endsCancelled、已有 `dependents_blocked_by_cancel` 日志则降级）、`superseded_replacement_chain_broken`（缺 id=error / 终于 cancelled=warning）、`dep_on_superseded_husk_not_rewired`（仅链解析到 done/active 时，info 级）、`duplicate_dependency_id`。

**close/supersede 字段** — error：`superseded_missing_replacement`（status===superseded && replacement null；schema 落后则降 warning）、`replacement_target_missing`、`replacement_chain_cycle`（仅走 replacement 边）；warning：`stale_replacement_on_nonsuperseded`、`stale_close_fields_on_nonterminal`、`terminal_missing_close_audit`（仅 cancelled/superseded，排除 done；schema 落后/遗留则抑制）。

**进度/元信息** — error：`progress_drift`✅ **← 头牌**（legacy 5 键 + dual-rate 8 键 + 交叉一致 `legacy.total===total_all`/`legacy.done===done`；两个 rate 用 epsilon 1e-9；缺 optional D4 字段在 pre-migration 视为不漂移）；warning：`project_status_vs_tasks_inconsistent`（如 `completed` 却有未完成任务）、`acceptance_fields_internal_contradiction`（`needs_manual_review !== (mode!=='auto')`，或 stage_gate 设在非 milestone）、`unknown_status_value`（7-union 外）、`schema_version_behind`（建议 migrate；跨项目只读抑制）、`unknown_verification_profile`（复用 findUnknownProfiles 宽松；跨项目不报）。

**日志/focus** — info：`terminal_status_vs_last_log_drift`（status vs 最近 transition 日志 to_status，catch tasks↔logs 非原子写漂移）、`terminal_task_missing_close_log`（logs 被裁剪则全局抑制）、`timestamp_monotonicity_violation`（`updated_at<created_at` 或 closed_at 越界）、`focus_related_task_missing`（仅匹配本地 id 命名空间者）。

### 3.4 reconcile 自动修复集（Minimal，L3）
- ✅ `progress_drift` → 调既有 `state.updateProjectProgress()`（纯由 tasks 派生、只恢复真相；**仅在真有差异时写**，避免 updated_at churn），附 `event_type:'reconcile_progress_recompute'` 审计。
- ✅ `self_dependency` → `deps.filter(d=>d!==id)`（**跳过终态任务**，不重写冻结历史），附 `event_type:'reconcile_self_dependency'` 审计。
- `schema_version_behind` → 只**建议** run `migrate_tasks_schema`（不自动跑，保持 reconcile 外科手术式）。
- 其余一律**只报告**，让用户用 `edit_task` 手修。
- **红线**：reconcile 不批量重规范化任务（那是 migrate 的活）、不自动重连 superseded 依赖、不动 status、进度必须委托 `updateProjectProgress`（legacy 键语义被特征测试锁死）。

---

## 4. 向后兼容（必过的既有不变量，节选）
- 严格前向状态机、cancelled/superseded 仅经 close_task、close_task 审计日志形状（`close_task.test.ts`）。
- progress legacy 5 键语义不变（`in_progress` 含 auto_verified；`total` 为含终态的 raw 计数）—— `state.characterization.test.ts` / `progress.test.ts` 锁死。
- superseded 链防御性解析、cancelled 依赖告警不静默 —— `deps_semantics.test.ts`。
- migrate 幂等不改 status —— `migration.test.ts`。
- 跨项目读不重置 module-global —— `cross_project.test.ts`。
- 无 schema_version bump（两新工具不加任何 on-disk 字段）。

---

## 5. 测试计划
- `edit_task.test.ts`：补 title/notes/deps、拒 status/audit 字段、acceptance 成对重算、依赖环拒绝、profile 校验、Zod 与 create_tasks 同宽、原子性、空改动跳过、终态任务白名单、审计日志形状。
- `lint_state.test.ts`：每个检查族至少一正一负用例（含"健康 superseded→done 链不误报"）、跨项目 project_dir、schema 落后降级。
- `reconcile.test.ts`：只修 progress_drift + self_dependency、跳终态、幂等、不动 deps/status/不批量重写、审计日志、拒 project_dir。
- 既有 18 文件 / 87 测试全过（baseline 已确认绿）。

---

## 6. 任务拆解（→ PM）
- **PM-501** `edit_task`：`StateManager.editTask` + 工具 + E2/E3/E4 规则 + 审计。auto / backend / build+test。
- **PM-502** lint 引擎 + ~22 检查（只读 `src/lint.ts` + `StateManager.lintState`）。auto / backend / build+test。dep: PM-501（共享依赖校验 helper）。
- **PM-503** `reconcile`（最小 autofix）+ 两工具注册（lint_state 接 project_dir / reconcile 拒）。auto / backend / build+test。dep: PM-502。
- **PM-504** 发版收口：版本 1.3.0→1.4.0、CHANGELOG/README、部署到 `~/.claude/mcp-project-manager`、多 agent review。**manual / stage_gate**。dep: PM-501/502/503。

---

## 7. 非目标 / Deferred

> **更新（2026-06-09）**：下列前 4 项已在 **ADR-005（v1.5.0）** 立项落实，详见 `docs/adr-005-task-identity-rename-reconcile-safety-envelope.md`。

- ~~edit_task 批量 `edit_tasks`（v1 单条；以后仿 update_tasks/close_tasks 加）。~~ → **resolved by ADR-005 §4（B1）**
- ~~`rename_task`（改 id + rewrite dependents）。~~ → **resolved by ADR-005 §2（R1-R4）**
- ~~reconcile 的字段清理类 autofix（stale_replacement / stale_close_fields）—— 本轮只报告。~~ → **resolved by ADR-005 §5（A1，仅 active 任务）**
- ~~跨项目**写** reconcile（写仍须显式 set_project_dir）。~~ → **部分 resolved by ADR-005 §3（C1/C2）：跨项目只放开 dry-run/fix-plan，写仍须 set_project_dir**
- `commit_hash` 的合法 setter。 → 仍 deferred（ADR-005 §9）
