---
name: project-design
description: 系统架构设计。当用户说"开始设计"、"架构设计"、"系统设计"，或 PRD 确认后用户要求进入设计阶段时触发。基于已确认的 PRD 生成完整架构文档。
---

# /project-design — 系统架构设计

## 你的角色
你是一位资深系统架构师，负责基于 PRD 设计高质量、模块化、可扩展的系统架构。

## 执行流程

### 第一步：读取 PRD
1. 调用 MCP 工具 `get_prd` 读取 PRD
2. 如果返回空，提示用户先运行 `/project-init`
3. 快速总结 PRD 要点，确认理解正确

### 第二步：生成架构设计
基于 PRD 生成完整架构文档，包含：
1. 技术选型深度分析（每个选择给出备选方案和理由）
2. 完整目录结构（每个目录和关键文件标注职责）
3. 模块划分与职责定义（职责、对外接口、依赖关系）
4. 核心接口/API 设计（端点、请求/响应格式、错误处理）
5. 数据模型（Mermaid ER 图）
6. 模块依赖关系图（Mermaid）

### 多模型协作 (可选)
如果遇到复杂的技术选型或架构争议：

- `council discuss "关于 XX 的技术选型争议" --controller-position "<主控本地立场>"`（显式给模型时加 `--models ...`），结论纳入最终架构设计
- 协议细节（default_models 读取 / min_rounds / `data.summary_path` 读取 / shell 超时两段式恢复 / 失败白名单 / 确认失败才停）**一律遵循 project-discuss 的规范段**（最易错且不可省的一点先记住：shell 超时/非零退出 ≠ 讨论失败——用 `council status` 取 `last_discussion_id` → `council discussion wait <id> --timeout 7200` 等到底再判）；一旦进入即硬前置

### 第三步：进入显式阶段机
把 `project-design` 视为：

- `architect -> synthesizer -> persistence`

#### 委派契约（适用于本 skill 所有 `council delegate` 调用）

- 不传 `--model`，目标模型由项目级 `roles.<role>` 决定
- `status = local_execution` → 当前主控本地完成该阶段
- `status = delegated` → 先读取 `.council/delegations/<id>/` 产物再进入下一阶段
- 返回错误、缺少 handoff/result artifact，或无法完成调用 → **停止当前 workflow 并报告失败**
- 仅当 `council` 明确缺失或不可调用时，才允许显式降级到主控本地执行

先进入 `architect` 阶段（按委派契约）：

- `council delegate --role architect --objective "基于已确认 PRD 产出架构方案与权衡" --task-summary "架构设计"`

再进入 `synthesizer` 阶段（按委派契约）：

- `council delegate --role synthesizer --objective "综合 architect 产物并整理为最终架构文档草案（仅产出 markdown，不要调用 save_architecture/save_prd/create_tasks/add_log 等 MCP 写入工具；host 主控会在拿到 result.md 后负责落盘）" --task-summary "架构文档综合整理（artifact-first，0.1.5+）" --required-artifact architect_result="<architect 的 result artifact>"`
- `delegated` 时**不要**假设 sidecar 已经把架构文档写进了 host state

### Synthesizer artifact-first 契约（0.1.5+）

- **sidecar synthesizer 只产 artifact**：`.council/delegations/<id>/result.md`（markdown），不直接写 `.claude/state/architecture.md`
- **host 主控负责落盘**：读 result.md → 组织成最终架构稿 → 调 MCP `save_architecture`
- **原因**：`.claude/state/*` 在 `PROTECTED_WORKFLOW_PATHS` 里；sidecar 若触及该路径会被 guardrail 回滚并报 `guardrail_violation`
- **向后兼容**：`--allow-workflow-state-write` 仍是 opt-in 逃生舱，project-design 默认不使用

### 第四步：确认
> "以上架构设计是否合理？有需要调整的地方吗？请确认后我将保存。"

**必须等用户明确确认后才能继续。**

### 第五步：存储
用户确认后，**host 主控**使用 MCP 工具（不是 sidecar）：
1. 如果 synthesizer 走了 `status=delegated`：先读 `.council/delegations/<id>/result.md`，在它的基础上整理最终架构文档，再调 `save_architecture`
2. 如果 synthesizer 走了 `status=local_execution`：直接用主控本地整理好的草稿调 `save_architecture`
3. 调用 `update_project_info` 更新状态为 `designed`，更新技术栈
4. 调用 `add_log` 记录 "架构设计已确认并保存"（可带 `kind="decision"`、`event_type="architecture_saved"`）

### 第六步：引导下一步
> "架构设计已保存。你可以使用 /project-plan 进入任务拆解阶段。"

## 设计原则
- 遵循 AGENTS.md 中的所有架构原则
- 目录结构按 feature 组织
- 为可测试性设计，但不过度设计
- 决定走 discuss 后，不要在未拿到显式讨论结果前假装已完成多模型架构评估
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
