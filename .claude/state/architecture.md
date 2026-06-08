# 架构设计 — project-manager ops/管理能力优化

> 完整设计见 **ADR-001**：`AutoSkills/docs/adr-001-project-manager-ops-capabilities.md`（已 sign-off）。本文是状态库内的浓缩索引。

## 5 决策
- **D1 context_mode**(`build|ops|hybrid`)：纯 `get_project_context` 呈现 hint，不参与权限/过滤/存储/状态机；测试断言"不同 mode 下 task 集合一致"。
- **D2 current_focus**：versioned structured object 存独立 `.claude/state/focus.json`，单槽 v1，带 `updated_at`/`stale_after`，服务端算 `is_stale`。
- **D3 日志富化**：复用 LogEntry，加 `kind`(6 值粗) + `event_type`(细，承接 legacy `type`) + `tags`/`entities`/`source`；保留 legacy 字段；`getLogs` 改先过滤后切片。
- **D4 双完成率**：progress **加法**扩展(保留 legacy 5 键 + 新增 total_all/active_total/cancelled/superseded/closed_total/raw_completion_rate/active_completion_rate)。
- **D5 close_task**：受审计旁路，只到 cancelled/superseded，永不到 done，**不走 VALID_TRANSITIONS**；reason 必填；superseded 强制 replacement 校验+防环；写 add_log 审计。

## 4 关键缺口(已拍板)
- **G1**(最高风险) getNextTask：superseded 依赖→close 时改写 dependents 到 replacement；cancelled 依赖→不满足+告警(不死锁/不误跑)；加 `next_task_blocked_reason` 诊断。
- **G2** 当前零测试基建→Phase 0 先立 vitest+fixture+snapshot。
- **G3** 舰队迁移：加 `schema_version`、progress 加法不替换、读时惰性补算、UTF-8/GBK 安全、幂等。
- **G4** kind(6 值) + event_type(承接 9 个 legacy type) + 迁移推断表。

## 关键 schema
- Task 加 `replacement_task_id?`/`closed_at?`/`close_reason?` + status 加 `cancelled`/`superseded`(仅 close_task 可写)。
- LogEntry 加 `kind?`/`event_type?`/`tags?`/`entities?`/`source?`(LogEntry 不加 stale_after)。
- ProjectInfo 加顶层 `schema_version?`；progress 加法 8 键。
- CurrentFocus 独立文件 focus.json。

## 已核实
CouncilFlow Python 核心 state-agnostic(零硬编码任务状态)→ CF 侧只改 integration.md(9 段)，不动代码。

## 分阶段
- **Phase 0**(低 ripple 纯加法)：0.0 测试基建 → 0.1 characterization → 0.2 get_project_context 加法(含 schema_version/双率读时补算/blocked_reason/context_mode) → 0.3 current_focus → 0.4 add_log+getLogs → 0.5 project-resume 守卫。
- **Phase 1**(状态机+迁移)：1.1 状态枚举 → 1.2 close_task → 1.3 G1 依赖语义 → 1.4 progress 持久化 → 1.5 migrate v0→v1 → 1.6 下游文档/技能/CF/README/manifest 同步 → 1.7 bootstrap 舰队迁移。
- **Phase 2**(deferred)：多槽 focus、reopen_task、context_mode→CF handoff、L4/L5/L6/L9。
