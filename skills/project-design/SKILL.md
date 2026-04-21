---
name: project-design
description: 系统架构设计。当用户说"开始设计"、"架构设计"、"系统设计"，或 PRD 确认后用户要求进入设计阶段时触发。基于已确认的 PRD 生成完整架构文档。前置条件：PRD 已通过 project-manager MCP 存储。
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
如果遇到复杂的技术选型或架构争议，可以调用 CouncilFlow 引入其他模型进行讨论：

- **先本地整理一句简短 `initial_position`**
- **发起讨论（显式模型）**：`council discuss "关于 XX 的技术选型争议" --controller-position "<initial_position>" --models claude,gemini`
- **发起讨论（项目默认）**：`council discuss "关于 XX 的技术选型争议" --controller-position "<initial_position>"`
- **查阅结论**：优先使用命令返回 JSON 中的 `data.summary_path`；如需手动定位，再读取 `.council/discuss/<discussion_id>/summary.md` 并将其纳入最终架构设计中。
- `--controller-position` 用来把当前主控的本地立场显式交给 CouncilFlow，避免同模型自嵌套。
- CouncilFlow 会把这版立场分发给外部模型评论；最终架构结论仍由当前主控综合。
- 只有达到项目级 `discussion.min_rounds` 后，讨论才允许提前收敛。
- 如果项目下缺少 `.council/config.yaml`，CouncilFlow 会在首次调用时自动创建项目本地配置模板。
- 一旦决定进入 discuss，就**必须先调用 CouncilFlow**
- 如果 `council discuss` 返回错误、缺少 summary artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- **shell 超时恢复协议（0.1.6+，硬前置）**：如果 `council discuss` 自身的 shell 调用出现 timeout 或返回非零，**不要**直接判失败——CouncilFlow 子进程一般还在跑，summary.md 会落盘。必须按下面两段式恢复：
  1. 用 `council status --json --project-root <root>` 取 `data.state.last_discussion_id`
  2. 调用 `council discussion wait <discussion_id> --project-root <root> --timeout 7200`
  3. `discussion wait` 完成判定是双条件：`record.status == "completed"` AND `summary.md` 可读
  4. 只有 `discussion wait` 自身报 `error_kind=wait_timeout` / `discussion_failed` / `record_corrupt` / `summary_missing` / `discussion_not_found`，才允许按失败上报协议宣告 workflow 失败
- 推荐用 `council status --json` 而不是解析 stderr

### 第三步：进入显式阶段机
把 `project-design` 视为：

- `architect -> synthesizer -> persistence`

先进入 `architect` 阶段。

- 如果 `council` 可用，必须先按项目配置调用：
  `council delegate --role architect --objective "基于已确认 PRD 产出架构方案与权衡" --task-summary "架构设计"`
- 不传 `--model`，让 CouncilFlow 从项目级 `roles.architect` 读取目标模型
- 只有在返回 `status = local_execution` 时，当前主控才允许本地输出架构设计的主体分析
- 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入 `synthesizer`
- 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地架构设计

再进入 `synthesizer` 阶段。

- 如果 `council` 可用，必须先按项目配置调用：
  `council delegate --role synthesizer --objective "综合 architect 产物并整理为最终架构文档草案（仅产出 markdown，不要调用 save_architecture/save_prd/create_tasks/add_log 等 MCP 写入工具；host 主控会在拿到 result.md 后负责落盘）" --task-summary "架构文档综合整理（artifact-first，0.1.5+）" --required-artifact architect_result="<architect 的 result artifact>"`
- 不传 `--model`，让 CouncilFlow 从项目级 `roles.synthesizer` 读取目标模型
- 只有在返回 `status = local_execution` 时，当前主控才允许本地整理最终待确认的架构文档版本
- 如果返回 `status = delegated`，则先读取 `.council/delegations/<id>/result.md` 产物，再进入用户确认；**不要**假设 sidecar 已经把架构文档写进了 host state
- 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地综合

### Synthesizer artifact-first 契约（0.1.5+）

这是 0.1.5 为了解决 cnchess 测试暴露的 `guardrail_violation` 问题新增的硬约束：

- **sidecar synthesizer 只产 artifact**：`.council/delegations/<id>/result.md`（markdown），不直接写 `.claude/state/architecture.md`
- **host 主控负责落盘**：读 result.md → 组织成最终架构稿 → 调 MCP `save_architecture`
- **原因**：`.claude/state/*` 在 `PROTECTED_WORKFLOW_PATHS` 里；sidecar 若通过 MCP 或直写文件触及该路径，会被 orchestrator guardrail 回滚并报 `guardrail_violation`
- **向后兼容**：`--allow-workflow-state-write` flag 仍然存在作为 opt-in 逃生舱，但 project-design 默认不使用；若你显式要用，需要在 `council delegate` 命令行加 `--allow-workflow-state-write` 并理解风险

### 第四步：确认
> "以上架构设计是否合理？有需要调整的地方吗？请确认后我将保存。"

**必须等用户明确确认后才能继续。**

### 第五步：存储
用户确认后，**host 主控**使用 MCP 工具（不是 sidecar）：
1. 如果 synthesizer 走了 `status=delegated`：先读 `.council/delegations/<id>/result.md`，在它的基础上整理最终架构文档，再调 `save_architecture`
2. 如果 synthesizer 走了 `status=local_execution`：直接用主控本地整理好的草稿调 `save_architecture`
3. 调用 `update_project_info` 更新状态为 `designed`，更新技术栈
4. 调用 `add_log` 记录 "架构设计已确认并保存"

### 第六步：引导下一步
> "架构设计已保存。你可以使用 /project-plan 进入任务拆解阶段。"

## 设计原则
- 遵循 AGENTS.md 中的所有架构原则
- 目录结构按 feature 组织
- 为可测试性设计，但不过度设计
- 如果 CouncilFlow 可用且你决定走 discuss，不要在未拿到显式讨论结果前假装已经完成多模型架构评估
- 有 CouncilFlow 时，`architect` / `synthesizer` 都必须先 route；没有 `local_execution` 或显式委派产物前，不要直接把架构主体分析和最终综合留在主控本地
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow

