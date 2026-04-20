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
  `council delegate --role synthesizer --objective "综合 architect 产物并整理为最终架构文档草案" --task-summary "架构文档综合整理" --required-artifact architect_result="<architect 的 result artifact>"`
- 不传 `--model`，让 CouncilFlow 从项目级 `roles.synthesizer` 读取目标模型
- 只有在返回 `status = local_execution` 时，当前主控才允许本地整理最终待确认的架构文档版本
- 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入用户确认
- 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地综合

### 第四步：确认
> "以上架构设计是否合理？有需要调整的地方吗？请确认后我将保存。"

**必须等用户明确确认后才能继续。**

### 第五步：存储
用户确认后，使用 MCP 工具：
1. 调用 `save_architecture` 保存架构文档
2. 调用 `update_project_info` 更新状态为 `designed`，更新技术栈
3. 调用 `add_log` 记录 "架构设计已确认并保存"

### 第六步：引导下一步
> "架构设计已保存。你可以使用 /project-plan 进入任务拆解阶段。"

## 设计原则
- 遵循 AGENTS.md 中的所有架构原则
- 目录结构按 feature 组织
- 为可测试性设计，但不过度设计
- 如果 CouncilFlow 可用且你决定走 discuss，不要在未拿到显式讨论结果前假装已经完成多模型架构评估
- 有 CouncilFlow 时，`architect` / `synthesizer` 都必须先 route；没有 `local_execution` 或显式委派产物前，不要直接把架构主体分析和最终综合留在主控本地
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow



## 动态角色路由（0.1.3+）

如果项目 `.council/config.yaml` 配置了动态角色路由（`roles.<role>` 为 list
形式而非简写 string），`council delegate` 返回的 target model 由 CouncilFlow
的路由引擎（`role_router.resolve`）按顺序匹配 `when` 表达式决定；skill 层
**不干预** 路由决策。

一旦拿到 `council delegate` 返回：

- `status = local_execution` → 按现有流程在当前主控本地执行
- `status = delegated` → 读取 `.council/delegations/<id>/result.md` 等 artifact
- `error.kind = routing_no_match` → 按 `docs/integration.md::Workflow Failure
  Report Protocol` 停止 workflow 并上报

动态路由的存在**不改变**本 skill 的阶段机、artifact 消费契约、失败上报协议。
