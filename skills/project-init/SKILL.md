---
name: project-init
description: 需求分析与 PRD 生成。生成 PRD 后保存到 project-manager MCP，并为新项目落盘 repo-local AGENTS.md / CLAUDE.md 模板。
---

# /project-init — 需求分析与 PRD 生成

## 执行流程

1. 通过对话澄清项目背景、目标用户、核心功能、非功能要求、技术偏好和验收标准。
2. 如果用户显式要求 `discuss <models>`，或需求边界存在明显争议，可先调用 `CouncilFlow` 辅助澄清：
   - 先由当前主控本地整理一句简短 `initial_position`
   - 用户显式给了模型：`council discuss "这个项目的需求边界应该如何定义？" --controller-position "<initial_position>" --models claude,gemini`
   - 用户没给模型：`council discuss "这个项目的需求边界应该如何定义？" --controller-position "<initial_position>"`
   - 不写 `--models` 时，CouncilFlow 会读取项目级 `discussion.default_models`
   - `--controller-position` 用来把当前主控的本地立场显式交给 CouncilFlow，避免同模型自嵌套
   - CouncilFlow 会把这版立场交给外部模型评论；最终结论仍由当前主控综合
   - 只有达到项目级 `discussion.min_rounds` 之后，CouncilFlow 才允许提前收敛
   - 如项目下缺少 `.council/config.yaml`，CouncilFlow 会在首次调用时自动创建项目本地配置模板
   - 优先使用命令返回 JSON 中的 `data.summary_path`
   - 如需手动定位，再读取 `.council/discuss/<discussion_id>/summary.md`
   - 不要依赖不存在的 `latest` 别名目录
   - 讨论结论只作为补充输入，不能替代用户确认
   - 一旦决定进入 discuss，就**必须先调用 CouncilFlow**
   - 如果 `council discuss` 返回错误、缺少 summary artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - **shell 超时恢复协议（0.1.6+，硬前置）**：如果 `council discuss` 自身的 shell 调用出现 timeout 或返回非零，**不要**直接判失败——CouncilFlow 子进程一般还在跑，summary.md 会落盘。必须按下面两段式恢复：
     1. 用 `council status --project-root <root>` 取 `data.state.last_discussion_id`（`DiscussionOrchestrator.run()` 在启动 < 50ms 内就已经写入 state.json）
     2. 调用 `council discussion wait <discussion_id> --project-root <root> --timeout 7200`（mirror `delegation wait`，最大等 2h）
     3. `discussion wait` 完成判定是双条件：`record.status == "completed"` AND `summary.md` 可读
     4. 只有 `discussion wait` 自身报 `error_kind`（`wait_timeout` / `discussion_failed` / `record_corrupt` / `summary_missing` / `discussion_not_found`，或从 record 转发的 provider 错误如 `adapter_missing` / `provider_timeout`），才允许按失败上报协议宣告 workflow 失败
   - 推荐用 `council status` 而不是解析 stderr —— 后者格式没有契约保证
3. 把 `project-init` 视为显式阶段机，而不是“主控聊完就直接写 PRD”：
   - `planner -> synthesizer -> persistence`
4. 先进入 `planner` 阶段。
   - 如果目标项目目录已经明确，且 `council` 可用，必须先按项目配置调用：
     `council delegate --role planner --objective "整理已确认需求边界并形成 PRD 规划输入" --task-summary "需求分析与 PRD 规划"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.planner` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许本地完成这段需求规划
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入 `synthesizer`
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 如果项目目录还未确定，只允许继续做需求澄清；一旦目录确定，planner 阶段就重新受 route-first 约束
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地规划
5. 再进入 `synthesizer` 阶段。
   - 如果项目目录已经明确，且 `council` 可用，必须先按项目配置调用：
     `council delegate --role synthesizer --objective "综合需求澄清与 planner 产物，输出 PRD 草案" --task-summary "PRD 综合整理" --required-artifact planner_result="<planner 的 result artifact>"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.synthesizer` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许本地整理最终 PRD 草案
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再生成面向用户确认的 PRD 版本
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地综合
6. 生成结构化 PRD，等待用户明确确认。
7. 用户确认后：
   - 调用 `save_prd`
   - 调用 `update_project_info`
   - 调用 `add_log`
8. 若项目目录已确定：
   - 生成 repo-local `AGENTS.md`
   - 生成 repo-local `CLAUDE.md`
   - 两者必须来自共享模板，不手写双份规则

## 项目目录状态判定

步骤 4 / 5 / 7 / 8 都依赖"项目目录是否已确定"的判断。统一语义如下：

- **已确定**：本会话已成功调用 `set_project_dir(<path>)`（其返回 `project_dir` 与 `state_exists`）；或用户在对话中明确给出目录路径并已登记。（`get_project_info()` 不返回 `project_dir` 字段，不要以它判定。）
- **未确定**：本会话尚未成功调用 `set_project_dir`，且对话里没有可推断的目录。

项目目录未确定时允许的行为集合：
- 继续需求澄清问答（只在对话内发生）
- 输出 PRD 预览供用户评审（不持久化）
- **禁止**调用 `save_prd` / `update_project_info` / `add_log(type="prd_saved")` 等任何写入 `.claude/state` 的持久化操作
- **禁止**生成 repo-local `AGENTS.md` / `CLAUDE.md`
- **禁止**进入 `planner` / `synthesizer` 的 route-first 委派（没有项目根目录就没有 `.council/` 可读写）

一旦目录确定，立即回到原步骤受 route-first 约束。

## 注意事项

- 不要替用户做决定，模糊之处必须追问
- 在 PRD 未确认前不要写代码
- `discuss` 是显式可选能力，不要在未被要求时默认触发多模型讨论
- 如果用户明确要求多模型澄清，就不要在 discuss 失败后假装这轮多模型分析已经完成
- 有 CouncilFlow 且项目目录已明确时，`planner` / `synthesizer` 都必须先 route；没有 `local_execution` 或显式委派产物前，不要直接把需求规划或 PRD 综合留在主控本地
- repo-local 规则文件只写项目补充项，不复制全局规范全文
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON（`workflow`/`failed_stage`/`error_kind`/`council_available`/`artifact_paths`/`fallback_attempted`/`message`）并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
