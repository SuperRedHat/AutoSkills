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
       - 本阶段所有任务都已 done → 调用 `update_project_info({"status": "<下一阶段或 completed>"})`，并在 log 里写明"阶段 gate closed"
     - 如果用户要求立即进入下一阶段的规划或执行，引导到 `$project-plan` / `$project-next`，不在本技能内启动新任务
3. 如果用户反馈有问题：
   - 调用 `update_task_status(id, "in_progress")`
   - 记录问题描述
   - 如问题属于现有任务继续收口，明确标注需要重新进入哪个 role-driven workflow
   - 如问题更适合作为新增修复工作，创建后续 fix/review 子任务
   - 停止在本技能内继续执行代码、测试或修复，让后续工作回到 `project-next`、`project-review` 等按角色路由的 workflow
   - 如果后续还要继续实现、测试、修复或复审，**必须先调用**对应的 route-first workflow，而不是在 `project-feedback` 内直接继续执行

## 注意事项

- 只处理真正等待人工确认的任务
- `milestone_manual` 的通过反馈应额外记录阶段收口说明
- `project-feedback` 的职责是 gate 收口与任务流转，不是隐式的 `fixer` 或 `tester`
- 如果反馈意味着还要继续改代码、跑测试或重新审查，应重新进入对应的 route-first workflow，而不是在这里直接继续干活
- 如果人工反馈本身意味着 workflow 已经失败（例如任务被拒收或验收过程中暴露系统性问题），按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
