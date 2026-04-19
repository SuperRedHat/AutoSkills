---
name: project-plan
description: 基于 PRD 和架构文档拆解任务，并写入结构化验收字段。
---

# /project-plan — 任务拆解与排序

## 执行流程

1. 调用 `get_prd` 和 `get_architecture` 读取上下文。
2. 按拓扑顺序拆解原子任务。
3. 把 `project-plan` 视为显式阶段机，而不是"主控直接拆任务后顺手保存"：
   - `planner -> synthesizer -> persistence`
4. 先进入 `planner` 阶段。
   - 如果 `council` 可用，必须先按项目配置调用：
     `council delegate --role planner --objective "基于 PRD 与架构文档拆解可执行任务" --task-summary "任务拆解"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.planner` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许本地完成任务拆解
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入 `synthesizer`
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地拆解
5. 再进入 `synthesizer` 阶段。
   - 如果 `council` 可用，必须先按项目配置调用：
     `council delegate --role synthesizer --objective "综合 planner 产物并整理为最终任务清单" --task-summary "任务清单综合整理" --required-artifact planner_result="<planner 的 result artifact>"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.synthesizer` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许本地整理最终待确认的任务列表
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入用户确认
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地综合

### 第三步：任务清单
6. 每个任务必须包含：

```json
{
  "id": "TASK-001",
  "title": "简短标题",
  "description": "详细描述",
  "dependencies": ["TASK-ID"],
  "complexity": "S|M|L",
  "acceptance_criteria": ["标准1", "标准2"],
  "files": ["预计涉及文件"],
  "module": "模块名",
  "needs_manual_review": true,
  "acceptance_mode": "auto|manual|milestone_manual",
  "verification_profile": "backend|frontend_unit|frontend_browser|frontend_visual|docs|workflow_meta",
  "verification_commands": ["command"],
  "review_checklist": ["人工检查项"],
  "stage_gate": false,
  "status": "todo"
}
```

7. 优先使用结构化验收字段驱动策略：
   - 普通后端任务：`auto`
   - 普通前端任务：`auto + frontend_browser`
   - 高风险视觉任务：`milestone_manual`
   - 阶段收口任务：`manual`
8. 展示任务列表并等待用户确认。
9. 用户确认后调用 `create_tasks`、`update_project_info`、`add_log`。

## 多模型协作（可选）

如果任务拆解方案或复杂度评估存在争议，可调用 CouncilFlow 进行讨论或委派研究：

- **先本地整理一句简短 `initial_position`**
- **验证方案（显式模型）**：`council discuss "如何拆解 XX 模块的任务？" --controller-position "<initial_position>" --models claude,gemini`
- **验证方案（项目默认）**：`council discuss "如何拆解 XX 模块的任务？" --controller-position "<initial_position>"`
- **读取结论**：优先使用命令返回 JSON 中的 `data.summary_path`；如需手动定位，再读取 `.council/discuss/<discussion_id>/summary.md`
- `--controller-position` 用来把当前主控的本地立场显式交给 CouncilFlow，避免同模型自嵌套。
- CouncilFlow 会把这版立场交给外部模型评论；最终任务拆解仍由当前主控综合。
- 只有达到项目级 `discussion.min_rounds` 后，讨论才允许提前收敛。
- 一旦决定进入 discuss，这就是硬前置步骤；如果 `council discuss` 返回错误、缺少 summary artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- **委派调研**：`council delegate --role architect --objective "调研 XX 方案的复杂度" --task-summary "架构调研"`
- 不传 `--model`，让 CouncilFlow 从项目级 `roles.architect` 读取目标模型
- 如果返回 `status = local_execution`，当前主控才允许继续本地完成这段调研
- 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再继续任务拆解
- 如果 `council delegate` 返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- 如果项目下缺少 `.council/config.yaml`，CouncilFlow 会在首次调用时自动创建项目本地配置模板

## 项目目录状态判定

在 `create_tasks` / `update_project_info` 之前，先用以下逻辑判断项目目录是否已确定：

- **已确定**：调用 `get_project_info()`，`project_dir` 字段非空且指向一个**实际存在**的目录；或用户在对话中明确给出了目录路径并用 `set_project_dir(<path>)` 登记。
- **未确定**：`get_project_info().project_dir` 为空 / 指向不存在的路径，且对话中没有可推断的目录。

项目目录未确定时允许的行为集合：
- 继续需求澄清与任务草案讨论（只在对话内）
- 展示预览性质的任务列表给用户确认
- **禁止**调用 `create_tasks` / `save_prd` / `save_architecture` / `update_project_info` 等任何会写入 `.claude/state` 的持久化操作
- **禁止**生成 repo-local 规则文件

一旦目录确定（`set_project_dir` 被调用成功），再进入 route-first 的 `planner` / `synthesizer` 阶段。

## 注意事项

- 不再只写 `needs_manual_review`
- `needs_manual_review` 仅作为兼容字段保留
- `review_checklist` 只在需要人工确认时填写
- 有 CouncilFlow 时，不要在未获得 `local_execution` 或委派产物前直接跳过 route-first 步骤
- `planner` / `synthesizer` 都属于硬前置阶段；不要把任务拆解或最终清单综合静默留在主控本地
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow


