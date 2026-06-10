---
name: project-feedback
description: 处理真正等待人工验收的任务反馈，并支持阶段 gate 收口。
---

# /project-feedback — 手动测试反馈处理

## 执行流程

1. 调用 `get_all_tasks(status="awaiting_manual_acceptance")` 找到目标任务。
2. 如果用户反馈通过：
   - 调用 `update_task_status(id, "done")`
   - 调用 `add_log` 记录验收理由与 evidence bundle
   - 提交验收 commit
   - **如果任务 `acceptance_mode == "milestone_manual"` 且 `stage_gate == true`**：
     - 在 `add_log` 里额外记录 `{"stage_gate_closed": true, "phase_summary": "<本阶段收口概述>", "next_phase": "<建议下一阶段>"}`
     - 检查当前阶段内还有没有其它未完成任务：
       - 仍有未完成 → **不要**关阶段 gate，只记录本任务通过
       - 本阶段所有任务都已 done → 项目**全部**完成时调用 `update_project_info({"status": "completed"})`；仍有后续阶段时保持 `in_progress` 不动（status 枚举只收 initialized/designed/planned/in_progress/completed，没有"阶段名"），改用 `add_log(kind="decision", message="阶段 gate closed: <阶段名>")` 记录收口
     - 如果用户要求立即进入下一阶段的规划或执行，引导到 `$project-plan` / `$project-next`，不在本技能内启动新任务
3. 如果用户反馈意味着**需要返工**（任务方向正确，只是实现有问题）：
   - 调用 `update_task_status(id, "in_progress")`，记录问题描述
   - 后续的实现、测试、修复或复审**必须回到**对应的 route-first workflow（`project-next` / `project-review`），不在 `project-feedback` 内直接继续干活；更适合作为新增修复工作时，创建 fix/review 子任务
4. 如果用户反馈意味着**不要再做这个任务**（已超出范围 / 已被另一个任务替代），走终态关闭路径——`project-feedback` 是 `close_task` 的主要调用方（role 驱动阶段不调用）：
   - **取消**（作废、无替代）：`close_task(id, "cancelled", reason=...)`；如有在跑的 dependents，工具会发 `dependents_blocked_by_cancel` 提示重新指向或一并关闭
   - **被替代**：`close_task(id, "superseded", reason=..., replacement_task_id=...)`；dependent 边会自动改指 replacement 保持 DAG 可运行
   - 终态只能经 `close_task` 进入（`update_task_status` 会拒绝）；参数校验与审计行为以工具描述为准
   - 关闭后用 `add_log` 记录验收/关闭理由
5. 如果某个任务被**误关或重新需要**，走复活路径：`reopen_task(id, reason, to_status?)`（终态 → `todo` 默认 / `in_progress`）。调用边界与 `close_task` 一致——仅 `project-feedback` 或显式控制器/管理决策可调用；复活 superseded 任务时被改写过的 dependent 边不会自动恢复（见工具描述与审计日志）。

## 注意事项

- 只处理真正等待人工确认的任务
- `milestone_manual` 的通过反馈应额外记录阶段收口说明
- `project-feedback` 的职责是 gate 收口与任务流转，不是隐式的 `fixer` 或 `tester`
- 区分"返工"与"不做"：返工 → `in_progress`（走 route-first workflow）；不做 → `close_task(cancelled|superseded)`
- 如果人工反馈本身意味着 workflow 已经失败（任务被拒收或验收暴露系统性问题），按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `add_log(type="workflow_failure", ...)`，再停止当前 workflow
