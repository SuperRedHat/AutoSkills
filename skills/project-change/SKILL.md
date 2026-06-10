---
name: project-change
description: 评估需求变更影响，更新文档，并追加带结构化验收字段的新任务。如果影响面广或涉及核心选型，可调用 CouncilFlow 进行讨论。
---

# /project-change — 需求变更管理

## 执行流程

1. 调用 `get_prd`、`get_architecture`、`get_all_tasks`、`get_project_info`。
2. 把 `project-change` 视为显式阶段机：
   - `architect -> planner -> synthesizer -> persistence`
3. 如果检测到 `council` 可用，则把项目目录下的 `.council/config.yaml` 视为自动分发真源；如文件缺失，CouncilFlow 会在首次调用时自动生成项目本地配置。

### 委派契约（适用于本 skill 所有 `council delegate` 调用）

- 不传 `--model`，目标模型由项目级 `roles.<role>` 决定
- `status = local_execution` → 当前主控本地完成该阶段
- `status = delegated` → 先读取 `.council/delegations/<id>/` 产物再进入下一阶段
- 返回错误、缺少 handoff/result artifact，或无法完成调用 → **停止当前 workflow 并报告失败**
- 仅当 `council` 明确缺失或不可调用时，才允许显式降级到主控本地执行

4. 先进入 `architect` 阶段，分析变更影响范围（按委派契约）：
   - `council delegate --role architect --objective "评估此需求变更的影响范围" --task-summary "需求变更影响分析"`
5. 再进入 `planner` 阶段，为确认后的变更范围规划任务和验收策略（按委派契约）：
   - `council delegate --role planner --objective "为本次需求变更规划新增/调整任务" --task-summary "变更任务规划" --required-artifact architect_result="<architect 的 result artifact>"`
6. 再进入 `synthesizer` 阶段，综合 architect / planner 产物并整理最终变更结论（按委派契约）：
   - `council delegate --role synthesizer --objective "综合变更影响评估与任务规划，整理最终变更方案（仅产出 markdown + 任务清单 JSON 草案，不要调用 save_architecture/save_prd/create_tasks/add_log 等 MCP 写入工具；host 主控会在拿到 result.md 后负责落盘）" --task-summary "变更综合整理（artifact-first，0.1.5+）" --required-artifact architect_result="<architect 的 result artifact>" --required-artifact planner_result="<planner 的 result artifact>"`
   - `delegated` 时**不要**假设 sidecar 已经把变更落盘到 host state

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

7. 追加新任务时，同时写入：
   - `acceptance_mode`
   - `verification_profile`
   - `verification_commands`
   - `review_checklist`
   - `stage_gate`
   - `needs_manual_review`（兼容）
8. **host 主控**（不是 sidecar）按 synthesizer 的 artifact 依次更新 PRD / 架构文档并记录日志。
9. 如果本次变更让**既有任务作废**：先创建好替代任务，再由 **host 主控**对每个被替代的旧任务调用 `close_task(old_id, "superseded", reason="<被本次变更替代的原因>", replacement_task_id="<new_id>")`——`superseded` 会自动把旧任务的所有 dependent 边改指到 replacement，保持 DAG 可运行；若旧任务是单纯作废且无替代，则用 `close_task(old_id, "cancelled", reason=...)`。终态关闭只能经 `close_task`（`update_task_status` 会拒绝 `cancelled` / `superseded`），并用 `add_log(kind="decision" 或 "ops_event", entities={"tasks": ["<相关任务id>"]}, ...)` 记录这次取舍（`entities` 是对象/map，传数组会被 schema 拒绝）。

## 多模型协作（可选）

如果用户显式要求 `discuss <models>`，或影响评估本身存在明显争议，可在 `architect` 阶段前后嵌入一轮讨论：

- `council discuss "此变更对现有系统架构的影响有哪些？" --controller-position "<主控本地立场>"`（显式给模型时加 `--models ...`）
- 协议细节（default_models 读取 / min_rounds / `data.summary_path` 读取 / shell 超时两段式恢复 / 失败白名单 / 确认失败才停）**一律遵循 project-discuss 的规范段**；一旦进入即硬前置

## 注意事项

- 不要在变更管理流程里直接改代码
- 任务验收策略必须在规划阶段写入，不在执行时临时猜测
- `architect` / `planner` / `synthesizer` 都属于硬前置阶段；不要在未获得 `local_execution` 或委派产物前直接把变更分析、任务规划或最终综合留给主控
- 读取讨论结论时，优先使用 `initial_position`、`current_controller_position`、`min_rounds` 等显式字段，不依赖隐藏上下文
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
