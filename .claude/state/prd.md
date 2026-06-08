# PRD — project-manager ops/管理能力优化

## 问题
`project-manager`(AutoSkills MCP) 任务模型假设线性 build DAG，缺三类能力：① 运营/事件驱动工作的承载；② 管理动作(取消/取代/对齐历史)；③ 富恢复上下文。用户在真实 Upwork 接单中被迫手搓 `james-monitor-state.json` 补 ops 原语——证明工具有真实缺口。

## 目标
在**不削弱**严格前向状态机(可审计主路径)的前提下，补 ops/管理/富恢复能力。原则：只补受审计旁路、不新建第 4 真相源、加法优先向后兼容。

## 范围(5 决策 + 4 关键缺口)
- D1 `context_mode`(纯呈现 hint) / D2 `current_focus`(独立 focus.json) / D3 日志富化(kind+event_type) / D4 双完成率(progress 加法) / D5 `close_task`(受审计旁路)。
- G1 getNextTask 依赖语义 / G2 测试基建 / G3 舰队迁移 / G4 kind 分类法。
- 详见架构文档 / ADR-001。

## 非目标(v1)
不"反完成"已 done(无 reopen)；current_focus 单槽；不动 L4 批量 / L5 priority / L6 跨项目 / L9 profile 硬枚举。

## 成功标准
- Phase 0：加法零破坏——characterization 快照绿、7 项目舰队读取无 NaN、`context_mode` 集合一致。
- Phase 1：状态机+迁移幂等无损(真实 GBK fixture)、G1 依赖语义用例绿、全下游文档/11 技能一致。

## 依据
反馈 `CouncilFlow/project-manager-feedback.md` v3；多模型讨论 `disc_20260608T082025646299Z`(claude+codex)；架构 ADR-001 `AutoSkills/docs/adr-001-project-manager-ops-capabilities.md`。
