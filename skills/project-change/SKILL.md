---
name: project-change
description: 评估需求变更影响，更新文档，并追加带结构化验收字段的新任务。如果影响面广或涉及核心选型，可调用 CouncilFlow 进行讨论。
---

# /project-change — 需求变更管理

## 执行流程

1. 调用 `get_prd`、`get_architecture`、`get_all_tasks`、`get_project_info`。
2. 把 `project-change` 视为显式阶段机：
   - `architect -> planner -> synthesizer -> persistence`
3. 先进入 `architect` 阶段，分析变更影响范围。
   - 如果检测到 `council` 可用，则把项目目录下的 `.council/config.yaml` 视为自动分发真源；如文件缺失，CouncilFlow 会在首次调用时自动生成项目本地配置。
   - 如果需要把影响评估分发给非主控模型，必须先按项目配置调用 CouncilFlow：
     `council delegate --role architect --objective "评估此需求变更的影响范围" --task-summary "需求变更影响分析"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.architect` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许继续本地分析
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再继续影响评估
   - 如果 `council delegate` 返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地影响评估
4. 再进入 `planner` 阶段，为确认后的变更范围规划任务和验收策略。
   - 如果 `council` 可用，必须先按项目配置调用：
     `council delegate --role planner --objective "为本次需求变更规划新增/调整任务" --task-summary "变更任务规划" --required-artifact architect_result="<architect 的 result artifact>"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.planner` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许本地完成任务规划
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入 `synthesizer`
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地任务规划
5. 再进入 `synthesizer` 阶段，综合 architect / planner 产物并整理最终变更结论。
   - 如果 `council` 可用，必须先按项目配置调用：
     `council delegate --role synthesizer --objective "综合变更影响评估与任务规划，整理最终变更方案（仅产出 markdown + 任务清单 JSON 草案，不要调用 save_architecture/save_prd/create_tasks/add_log 等 MCP 写入工具；host 主控会在拿到 result.md 后负责落盘）" --task-summary "变更综合整理（artifact-first，0.1.5+）" --required-artifact architect_result="<architect 的 result artifact>" --required-artifact planner_result="<planner 的 result artifact>"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.synthesizer` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许本地整理最终待落盘的变更方案
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/<id>/result.md` 产物，再进入文档/任务更新；**不要**假设 sidecar 已经把变更落盘到 host state
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许显式降级到主控本地综合

### Synthesizer artifact-first 契约（0.1.5+）

- **sidecar synthesizer 只产 artifact**：`.council/delegations/<id>/result.md`，内含：
  - 变更影响分析摘要（基于 architect + planner）
  - 需要更新的 PRD / 架构片段（作为 markdown fragment）
  - 需要新增/调整的任务清单 JSON
- **host 主控负责落盘**（不是 sidecar）：读 result.md → 用户确认 → 依次调用
  - `save_architecture`（若架构文档需要更新）
  - `save_prd`（若 PRD 需要更新）
  - `create_tasks`（写入新增任务）
  - `add_log`（记录变更理由与 decision）
- **原因**：`.claude/state/*` 在 `PROTECTED_WORKFLOW_PATHS` 里；sidecar 若通过 MCP 触及该路径，会被 orchestrator guardrail 回滚并报 `guardrail_violation`

6. 追加新任务时，同时写入：
   - `acceptance_mode`
   - `verification_profile`
   - `verification_commands`
   - `review_checklist`
   - `stage_gate`
   - `needs_manual_review`（兼容）
7. **host 主控**（不是 sidecar）按 synthesizer 的 artifact 依次更新 PRD / 架构文档并记录日志。

## 多模型协作（可选）

如果用户显式要求 `discuss <models>`，或影响评估本身存在明显争议，可在第 3 步 `architect` 阶段前后嵌入一轮讨论：

- **先本地整理一句简短 `initial_position`**
- **影响评估（显式模型）**：`council discuss "此变更对现有系统架构的影响有哪些？" --controller-position "<initial_position>" --models claude,gemini`
- **影响评估（项目默认）**：`council discuss "此变更对现有系统架构的影响有哪些？" --controller-position "<initial_position>"`
- 不写 `--models` 时，CouncilFlow 会自动读取项目级 `discussion.default_models`
- `--controller-position` 用来把当前主控的本地立场显式交给 CouncilFlow，避免同模型自嵌套
- CouncilFlow 会把这版立场交给外部模型评论；最终影响评估仍由当前主控综合
- 只有达到项目级 `discussion.min_rounds` 后，讨论才允许提前收敛
- 一旦决定进入 discuss，这就是硬前置步骤；如果 `council discuss` 返回错误、缺少 summary artifact，或无法完成调用，则**停止当前 workflow 并报告失败**
- **读取结论**：优先使用命令返回 JSON 中的 `data.summary_path`；如需手动定位，再读取 `.council/discuss/<discussion_id>/summary.md`
- **shell 超时恢复协议（0.1.6+，硬前置）**：如果 `council discuss` 自身的 shell 调用出现 timeout 或返回非零，**不要**直接判失败——CouncilFlow 子进程一般还在跑，summary.md 会落盘。必须按下面两段式恢复：
  1. 用 `council status --project-root <root>` 取 `data.state.last_discussion_id`
  2. 调用 `council discussion wait <discussion_id> --project-root <root> --timeout 7200`
  3. `discussion wait` 完成判定是双条件：`record.status == "completed"` AND `summary.md` 可读
  4. 只有 `discussion wait` 自身报 `error_kind=wait_timeout` / `discussion_failed` / `record_corrupt` / `summary_missing` / `discussion_not_found`，才允许按失败上报协议宣告 workflow 失败
- 推荐用 `council status` 而不是解析 stderr

## 注意事项

- 不要在变更管理流程里直接改代码
- 任务验收策略必须在规划阶段写入，不在执行时临时猜测
- 有 CouncilFlow 时，影响评估必须先走配置驱动的讨论/委派；只有工具缺失或不可调用时才纯本地处理
- `architect` / `planner` / `synthesizer` 都属于硬前置阶段；不要在未获得 `local_execution` 或委派产物前直接把变更分析、任务规划或最终综合留给主控
- 读取讨论结论时，优先使用 `initial_position`、`current_controller_position`、`min_rounds` 等显式字段，不依赖隐藏上下文
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow

