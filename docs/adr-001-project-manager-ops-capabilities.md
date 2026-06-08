# ADR-001：为 project-manager 增补 ops / 管理能力

- **状态**：Proposed —— **等待用户 sign-off，未开始写代码**
- **日期**：2026-06-08
- **作者**：Claude Code（Opus 4.8，主控）
- **目标组件**：`AutoSkills/mcp/project-manager`（MCP Server，`src/state.ts` + `src/index.ts`）
- **依据**：
  - 实战反馈 `CouncilFlow/project-manager-feedback.md` v3（源码核对 + build/ops 框架）
  - CouncilFlow 多模型讨论 `disc_20260608T082025646299Z`（claude 主控立场 + codex 评审，2 轮）
  - 跨仓库只读 grounding 扫描（6 agent：pm 源码 / 11 技能 / 模板 / CF 集成契约 / 落盘 state / 完整性 critic）
- **不在本 ADR 范围**：L4 批量操作、L5 priority、L6 跨项目/portfolio、L9 verification_profile 去硬枚举 —— 见 §10 Phase 2。

---

## 0. 决策摘要（TL;DR）

| # | 决策 | 结论 | 阶段 |
|---|---|---|---|
| D1 | `context_mode` | 纯"呈现 hint"（`build\|ops\|hybrid`），只影响 `get_project_context` 默认排序/摘要，**不参与权限/过滤/存储/状态机** | 0 |
| D2 | `current_focus` | versioned structured object，存独立 `focus.json`，单槽 v1，带 `updated_at`/`stale_after`/`is_stale` | 0 |
| D3 | 日志富化 | 复用 LogEntry，加 `kind`(粗) + `event_type`(细，承接 legacy `type`) + `tags`/`entities`/`source`；`getLogs` 改为先过滤后切片 | 0(表面) / 1(迁移) |
| D4 | 双完成率 | progress **加法扩展**（保留 legacy 5 键 + 新增 8 键），暴露 `raw`/`active` 两个口径 | 1 |
| D5 | `close_task` | 受审计管理旁路，只到 `cancelled\|superseded`，永不到 `done`；不走 `VALID_TRANSITIONS` | 1 |
| **G1** | getNextTask 依赖语义（最高风险） | **superseded → 在 close 时把 dependents 的依赖改写到 replacement；cancelled → 不满足依赖 + 显式告警，不静默死锁也不静默运行** | 1 |
| **G2** | 测试基建 | **当前零测试基建**，先立 vitest + `test` 脚本 + 真实 state fixture（Phase 0 前置） | 0 |
| **G3** | 舰队迁移 | 加 `schema_version`、progress 加法不替换、读时惰性补算、UTF-8 安全、幂等可跳过 | 1 |
| **G4** | kind 分类法 | `kind`=6 值粗枚举；`event_type`=细类型承接 9 个 legacy `type`，不丢语义 | 1 |

---

## 1. 背景与目标

`project-manager` 的任务模型假设"线性 build DAG"，缺三类能力：**运营/事件驱动**工作的承载、**管理动作**（取消/取代/对齐历史）、**富恢复上下文**。本 ADR 在**不削弱**其"严格前向状态机 + 唯一写入路径 + 可审计"主路径的前提下，补这三类缺口。

核心原则（来自 codex 评审与反馈附 B）：
1. **只补受审计的管理旁路，不改前向主路径**。`done` 仍是经过完整 gauntlet 的终态。
2. **不新建第 4 个真相源**。journal = 现有日志层的"按 kind 过滤视图"，不是新存储。
3. **加法优先、向后兼容**。Phase 0 全加法；Phase 1 的 schema 演进必须惰性、幂等、可回滚。

---

## 2. 关键设计决策（D1–D5）

### D1 · context_mode（纯呈现 hint）
- 新增可选参数 `get_project_context(context_mode?: "build"|"ops"|"hybrid")`，默认 `build`（= 现状行为）。
- 语义**仅**为 `get_project_context` 的默认排序/摘要策略：`build` 先 surface 任务 DAG；`ops` 先 surface `current_focus` + 近期 ops 事件；`hybrid` 两者并重。
- **明确不做**：不参与权限、不过滤任务、不隔离存储、不分叉状态机。契约里写死这条，并加测试断言：同一项目在不同 `context_mode` 下返回的 task 集合**完全一致**，只是顺序/详略不同。
- 失败模式（codex/critic）：下游技能把它当硬过滤 → build 看不到 ops 事件、ops 漏掉交付任务。靠上面的"集合一致"测试守住。

### D2 · current_focus（versioned structured object）
- 以真实使用验证过的 `james-monitor-state.json` 为 **seed**，但抽象成稳定协议（不照搬字段名），存**独立文件** `.claude/state/focus.json`（与 project.json 分离，避免合并冲突）。
- 单槽 v1；多槽（按 workstream/entity）留给 Phase 2（与 L6 portfolio 同源）。`related_entities` + `stale_after` 降低单槽被并行事件覆盖的风险。
- Schema 见 §4。
- 新增 MCP 工具 `set_current_focus` / `get_current_focus`；`get_project_context` 一并返回 `current_focus`（带服务端计算的 `is_stale`）。

### D3 · 日志富化（复用 LogEntry，不新建存储）
- LogEntry 增 `kind`（6 值粗枚举）+ `event_type`（细，承接 legacy `type`）+ `tags[]` + `entities{}` + `source`。**保留** legacy `type`/`from_status`/`to_status`/`message`。
- `add_log` 工具开放上述字段（全部 optional，省略时退回旧行为）。
- **journal = 日志的 kind 过滤视图**，不是新存储。为此 `getLogs` 必须**先过滤后切片**（见 §9 修正项）。
- kind/event_type 关系与迁移见 G4（§3.4）。

### D4 · 双完成率（progress 加法扩展）
- progress 对象**加法扩展**：保留 legacy `{total, done, in_progress, awaiting_acceptance, todo}`（语义不变，旧读者不坏），新增 `{total_all, active_total, cancelled, superseded, closed_total, raw_completion_rate, active_completion_rate}`。
- `raw_completion_rate = done / total_all`；`active_completion_rate = done / active_total`，`active_total = total_all − cancelled − superseded`。分母为 0 时率取 0。
- 失败模式（codex）：批量取消后率突然跳升 → 同时暴露两个口径 + 关闭原因（由 close_task 的日志承载），让阶段复盘不被误读。

### D5 · close_task（受审计管理旁路）
- 新增 `close_task(id, status: "cancelled"|"superseded", reason, replacement_task_id?)`。
- **不走 `VALID_TRANSITIONS`**：`updateTaskStatus` 继续**拒绝** `cancelled`/`superseded`（给出"请用 close_task"的报错），保持前向主路径纯净；close_task 是唯一的受审计旁路。
- 约束：源状态必须**非终态**（不能关 `done`，即不能"反完成"——见 §9 非目标）；`reason` 必填；`superseded` 时 `replacement_task_id` 必填且校验（存在 / 非自身 / 非 closed / 替代链无环）。
- 副作用：写 `add_log(kind="task_transition", event_type="task_closed", from_status, to_status, entities={replacement_task_id, dependents}, source="close_task")`；重算 progress；按 G1 处理 dependents。
- 返回：`{ success, task_id, affected_dependents[], rewired[], audit_log_index }`。

---

## 3. 四个必须先定的关键缺口（critic 发现，本 ADR 显式拍板）

### 3.1 G1 — getNextTask 依赖语义（**最高风险，mapper 自相矛盾**）
扫描中两个 mapper 给了**相反**方案："把 cancelled/superseded 当 done 满足依赖" vs "依赖被 cancelled 则拒绝该任务"。前者会让本不该跑的任务跑起来；后者会让 dependent **永久死锁**（正是 D5 要修的 bug）。本 ADR 拍板：

- **superseded 依赖 → 改写（rewire）**：在 `close_task(superseded)` 当下，遍历所有 `dependencies` 含 `id` 的任务，把该依赖项**替换为 `replacement_task_id`**，并写审计日志记录改写。这样 DAG 自洽，dependent 自然等待替代任务完成。运行期 `getNextTask` 再加一道防御：若仍遇到 superseded 依赖，沿 `replacement_task_id` 链解析到活跃终点。
- **cancelled 依赖 → 不满足 + 告警**：cancelled 依赖**不计入** doneSet，dependent 不会被 `getNextTask` 返回（正确地"不可运行"）。为避免被误读为死锁/完工，`close_task(cancelled)` 若存在 dependents，**在返回值中列出**并写 `add_log(kind="ops_event", event_type="dependents_blocked_by_cancel")`，迫使主控做决定（改指向 / 取消 / 替代）。
- **诊断字段**：`get_project_context` 增加 `next_task_blocked_reason`（`none` / `all_done` / `blocked_in_progress` / `blocked_by_cancelled_dep`）与 `blocked_by_closed[]`，使 `next_task=null` 不再被误读为"全部完成"。

### 3.2 G2 — 测试基建是 Phase 0 前置（**当前为零**）
扫描确认：`package.json` 无 `test` 脚本、无 vitest/jest、无 `*.test.ts`、两仓均无 CI。所有 mapper 说的"加向后兼容测试"目前**无处落地**。因此 Phase 0 的**第一项**是基建：
- 加 vitest（或 `node:test`）+ `package.json` 的 `test`/`build` 脚本；
- 从真实 state 拷贝 fixture（CouncilFlow 114/114 done + nano/GBK 混编样本）建回归基线；
- 先写 **characterization/snapshot 测试**锁住"现状的 `get_project_context` / progress 行为"，再动它。

### 3.3 G3 — 舰队迁移策略（7 个既有项目，无 schema_version）
- **加法不替换**：`updateProjectProgress` 保留 legacy 5 键、追加新 8 键。旧 dist / 旧读者继续看到旧键，不再 NaN。
- **schema_version**：在 `project.json` 顶层加 `schema_version`（当前缺失 = v0 → 迁到 v1）。迁移据此**幂等、可跳过、可检测半迁移**。
- **读时惰性补算**：`getProjectInfo`/`getProjectContext` 在 `schema_version < 1` 时**只读地**补算新 progress 字段返回；`migrate_tasks_schema` 才做持久化写入。保证迁移**未跑**时也不出 NaN。
- **编码安全**：CouncilFlow/nano/simplatform 等 state 文件含 GBK 混编。迁移必须显式 UTF-8 读写 + "读→spread→只写变更字段"的保值往返，并用真实 GBK fixture 测不损坏。
- **触发方式**：默认惰性（读时补算 + 首次写入持久化）；`bootstrap.ps1/.sh` 增加可选 `-MigrateState` 步骤批量迁移已知项目。`migrate_tasks_schema` **绝不**自动改任何 task 的 status（cancelled/superseded 只能由 close_task 写）。

### 3.4 G4 — kind 分类法 vs 真实数据
真实 `logs.json` 有 9 个 `type`：`task_status_change(387)`、`decision(43)`、`review_completed(10)`、`milestone_gate(3)`、`phase_change(2)`、`smoke_results`、`followup_needed`、`qa`、`manual_acceptance`。6 值 `kind` 装不下，硬塞会把后 7 个压成 `note`、丢掉 project-status/feedback 依赖的语义。拍板：
- `kind`（粗，6 值）：`task_transition | ops_event | decision | note | workflow_failure | focus_update`。
- `event_type`（细，自由字符串）：**承接 legacy `type`**，不丢具体语义。
- 迁移推断表（只读补算 / 持久化时回填，**不改 message**）：

| legacy `type` | → `kind` | → `event_type` |
|---|---|---|
| `task_status_change` | `task_transition` | `task_status_change` |
| `decision` | `decision` | `decision` |
| `workflow_failure` | `workflow_failure` | `workflow_failure` |
| `review_completed` / `milestone_gate` / `phase_change` / `manual_acceptance` / `qa` / `smoke_results` / `followup_needed` | `ops_event` | `<原 type>` |
| 其它/未知 | `note` | `<原 type>` |

---

## 4. 数据模型（精确 schema）

```ts
// ---- Task（Phase 1 加 3 字段，全部 optional，向后兼容） ----
status: "todo" | "in_progress" | "auto_verified" | "awaiting_manual_acceptance" | "done"
      | "cancelled" | "superseded";          // 新增两个终态，仅 close_task 可写
replacement_task_id?: string | null;          // superseded 必填，指向替代任务
closed_at?: string | null;                    // close_task 时间戳
close_reason?: string | null;                 // close_task 原因

// ---- LogEntry（Phase 0 加字段；旧条目读时补默认） ----
type: string;                                  // 保留（legacy）
kind?: "task_transition"|"ops_event"|"decision"|"note"|"workflow_failure"|"focus_update";
event_type?: string | null;                    // 细类型，承接 legacy type
tags?: string[];
entities?: Record<string, unknown>;
source?: string | null;
// 保留：timestamp / task_id(可为 null=项目级 ops 事件) / from_status / to_status / message
// 注意：LogEntry 不加 stale_after（事件不会"过期"，那是 dead schema）

// ---- ProjectInfo.progress（加法扩展，legacy 键语义不变） ----
progress: {
  total: number; done: number; in_progress: number;        // legacy（in_progress 仍含 auto_verified）
  awaiting_acceptance: number; todo: number;                // legacy
  total_all: number;            // == total
  active_total: number;         // total_all − cancelled − superseded
  cancelled: number; superseded: number;
  closed_total: number;         // done + cancelled + superseded
  raw_completion_rate: number;      // done / total_all
  active_completion_rate: number;   // done / active_total
};

// ---- CurrentFocus（新文件 focus.json） ----
interface CurrentFocus {
  schema_version: number;        // 1
  summary: string;
  last_event: string | null;
  next_trigger: string | null;
  waiting_on: string[];
  related_task_ids: string[];
  related_entities: Record<string, unknown>;
  source: string | null;
  updated_at: string;            // ISO，setCurrentFocus 写
  stale_after: string | null;    // 可选 ISO
}
// get_current_focus / get_project_context 返回 { ...focus, is_stale: boolean }（服务端按 now>stale_after 计算）

// ---- ProjectInfo 顶层 ----
schema_version?: number;         // 缺失=0；迁移后=1（幂等判据）
```

---

## 5. 状态机与 close_task 语义

- `VALID_TRANSITIONS` **不变**（前向主路径不动）。`updateTaskStatus` 收到 `cancelled`/`superseded` → 报错引导用 `close_task`。
- `close_task` 是**唯一**进入 `cancelled`/`superseded` 的路径，且**只能从非终态进入**。`cancelled`/`superseded` 为终态、无出边（v1 不支持 reopen，见 §9）。
- 依赖语义见 G1（superseded→改写 dependents；cancelled→不满足+告警）。
- `getNextTask`：doneSet 仅含 `done`；解析 superseded 依赖到替代链终点；cancelled 依赖不满足；产出 `next_task_blocked_reason` 诊断。

---

## 6. 迁移策略（见 G3）

- v0→v1：加 `schema_version`、progress 加法字段、LogEntry kind/event_type 回填（按 G4 表）、task 加 `replacement_task_id=null`（**不改 status**）。
- 幂等：`schema_version>=1` 时迁移为 no-op。
- 惰性兜底：迁移未跑时，读路径只读补算，杜绝 NaN / 空字段。
- 编码安全：显式 UTF-8 + 保值往返 + 真实 GBK fixture 测试。
- 回归基准：CouncilFlow（114/114 done、449 条无 kind 日志、`schema_version` 缺失）—— 迁移后 `raw=active=100%`、无静默 status 变更、未知未来字段保留。

---

## 7. 分阶段实施计划 + ripple 矩阵

### Phase 0 —— 低 ripple、纯加法、不碰状态机（先做、可独立交付）
> codex 修正："Phase 0 非零 ripple"——它改了 `get_project_context` **返回契约**，波及调用方 prompt、token 预算、测试快照、`project-resume` 渲染。故 Phase 0 含少量技能改动 + 兼容测试。

| 步骤 | 内容 | 文件 |
|---|---|---|
| 0.0 | **测试基建**（vitest + test/build 脚本 + 真实 fixture）【G2】 | `mcp/project-manager/package.json`（新增 test runner）、`tests/`（新建） |
| 0.1 | characterization/snapshot 测试锁住现状 | `tests/*.test.ts` |
| 0.2 | `get_project_context` 加法：`in_progress_tasks` 全文 + `current_focus`(读) + 双率(读时补算) + `next_task_blocked_reason` + 可选 `max_recent_events`/`include_full_in_progress`/`context_mode` | `src/state.ts` getProjectContext、`src/index.ts` 工具签名 |
| 0.3 | `CurrentFocus` 类型 + `focus.json` 存储 + `get/set_current_focus` 工具 | `src/state.ts`、`src/index.ts` |
| 0.4 | `add_log` 开放 kind/event_type/tags/entities/source（optional）+ `getLogs` 先过滤后切片【§9】 | `src/state.ts` addLog/getLogs、`src/index.ts` add_log |
| 0.5 | `project-resume` 加守卫"current_focus 有值才渲染焦点段"【critic】+ 各读侧技能注记 | `skills/project-resume/SKILL.md`（+ project-discuss/design 注记） |
| 0.6 | `schema_version` 引入（写入时盖章；读时惰性补算） | `src/state.ts` |

### Phase 1 —— 高 ripple、状态机 + 迁移（需 Phase 0 sign-off 后）
| 步骤 | 内容 | 文件 |
|---|---|---|
| 1.1 | Task.status 加 cancelled/superseded；updateTaskStatus 拒绝并引导 | `src/state.ts`、`src/index.ts`（update_task_status / get_all_tasks 枚举） |
| 1.2 | `close_task` 方法 + 工具（reason 必填、replacement 校验、防环、非终态源） | `src/state.ts`、`src/index.ts` |
| 1.3 | G1 依赖语义：supersede 时改写 dependents + cancelled 告警 + getNextTask 解析/过滤 | `src/state.ts` |
| 1.4 | progress 双率字段持久化（加法） | `src/state.ts` updateProjectProgress |
| 1.5 | `migrate_tasks_schema` v0→v1（幂等、编码安全、不改 status、回填 kind） | `src/state.ts`、`src/index.ts` |
| 1.6 | **下游文档/技能同步**：状态图模板 ×2、11 技能中受影响 7 个、CF `integration.md`(9 段)、`README.md`、`mcp-manifest.json` 漂移 | `templates/global-claude-CLAUDE.md`、`templates/global-codex-AGENTS.md`、`templates/repo-{CLAUDE,AGENTS}.md`、`skills/project-{next,feedback,status,change,review,resume,plan}/SKILL.md`、`CouncilFlow/docs/integration.md`、`mcp/project-manager/README.md`、`mcp-manifest.json` |
| 1.7 | 舰队迁移：`bootstrap.ps1/.sh` 可选 `-MigrateState` | `scripts/bootstrap.ps1`、`scripts/bootstrap.sh` |

### ripple 总览（来自扫描，按 severity）
- **CouncilFlow Python 源码：零改动**（已核实 state-agnostic）。CF 侧只改 `integration.md` 文档 9 段。
- **高 severity 技能**：project-next（fixer→close_task 路径）、project-feedback（拒绝→close_task vs 退回修改）、project-status（双率 + closed 看板段）。
- **模板 ×2 高 severity**：global-claude-CLAUDE.md / global-codex-AGENTS.md 的状态图（第 22-29 行）。
- **README / mcp-manifest.json 文档漂移**：纳入 1.6 一并修。

---

## 8. 向后兼容 / 混合版本舰队

- progress **加法**：新旧键并存，旧 dist / 旧读者不坏。
- get_project_context **加法**：新字段对"忽略未知字段"的消费者无害；对解析具体字段的技能，靠 0.1 快照测试 + 0.5 守卫保证不产生空段/报错。
- close_task 的 cancelled/superseded 对旧读者表现为"未知 status 字符串"——旧 UI 至多显示原值，不崩溃（终态、不参与旧 VALID_TRANSITIONS）。
- 回滚安全：因 progress 不替换、status 仅加值、迁移幂等，回退到旧 dist 仍可读。

---

## 9. 次要修正与显式非目标

- **getLogs 先过滤后切片**（critic 正确性项）：现状 `getLogs(n)` 先取最近 n 再过滤，会让 `kind`/`event_type` 过滤"漏掉更早的匹配项"。改为 `getLogs(filter?: {kind?, event_type?, since?, limit?})`，**先过滤后切片**。journal 视图依赖此修正。
- **stale_after 归属**：仅 `current_focus` 有 `stale_after`；服务端按 `now > stale_after` 算 `is_stale` 一并返回，**永不抑制**焦点（由消费者决定如何呈现，project-resume 标注"可能已过期"）。LogEntry **不加** stale_after。
- **README / mcp-manifest.json 漂移**：`integration.md` 写的是 `${MCP_HOME}` + env，真实 manifest 用 `${AUTOSKILLS_HOME}` + 空 env + `mcp/project-manager/dist`。1.6 一并对齐，避免文档继续漂。
- **context_mode / current_focus → CouncilFlow handoff**：v1 **不**把 ops 上下文注入 CF 委派 payload（保持 CF state-agnostic，避免范围蔓延）。这是**显式已知边界**，非静默 dead-end；是否注入留待 Phase 2。
- **非目标（v1）**：① 不支持"反完成"已 `done` 的任务（无 reopen）；如确有需要，走未来 `reopen_task` 或人工编辑，以保 `done` 完整性。② 不支持 current_focus 多槽。③ 不动 verification_profile 硬枚举（L9）/priority（L5）/批量（L4）/跨项目（L6）。

---

## 10. 留待 Phase 2 的开放问题
1. current_focus 多槽（按 workstream/entity）—— 与 L6 portfolio 同源。
2. `reopen_task`（从终态受审计地复活）。
3. context_mode/current_focus 是否进 CF handoff。
4. L4 批量 / L5 priority / L6 跨项目 / L9 profile 去硬枚举。
5. ops event 的最小必填字段是否强约束（v1 仅 `kind` 必填，其余 optional）。

---

## 11. 验证策略
- 每步以 §7 的测试基建跑 `npm test`；改 `get_project_context`/progress 前后比对快照。
- 迁移以真实 fixture（CouncilFlow 100% done、nano GBK 混编）做幂等 + 无损 + 无 NaN 回归。
- G1 依赖语义专门用例：supersede 改写 dependents、cancelled 告警不死锁、replacement 防环。
- `context_mode` 集合一致性断言（防被当过滤）。
- 全部通过后才进入下游文档/技能同步（1.6），并对 11 技能散文做一致性走查。

---

## 12. 决策待确认项（请 sign-off）
1. 采纳上面 D1–D5 + G1–G4 的**定稿**？特别是 **G1 的 supersede-rewire / cancelled-告警**语义。
2. 采纳 **Phase 0 先立测试基建（0.0）**，再做加法功能？
3. ADR 落点 `AutoSkills/docs/adr-001-...md` 是否合适，是否要把本优化作为**受 project-manager 跟踪的项目**（在 AutoSkills 下 init/plan 任务）来管理？
4. §9 三个**非目标**（不反完成 done / 单槽 focus / 不动 L4-L6/L9）是否认可？

> 确认后：`/project-plan` 拆 Phase 0 任务（acceptance_mode 多为 auto + verification_profile=backend/workflow_meta；1.6 文档项用 milestone_manual），按 0.0 → 0.6 落地并验证，再进 Phase 1。
