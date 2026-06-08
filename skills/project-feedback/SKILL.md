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
3. 如果用户反馈意味着**需要返工**（任务方向正确，只是实现有问题）：
   - 调用 `update_task_status(id, "in_progress")`
   - 记录问题描述
   - 如问题属于现有任务继续收口，明确标注需要重新进入哪个 role-driven workflow
   - 如问题更适合作为新增修复工作，创建后续 fix/review 子任务
   - 停止在本技能内继续执行代码、测试或修复，让后续工作回到 `project-next`、`project-review` 等按角色路由的 workflow
   - 如果后续还要继续实现、测试、修复或复审，**必须先调用**对应的 route-first workflow，而不是在 `project-feedback` 内直接继续执行
4. 如果用户反馈意味着**不要再做这个任务**（已超出范围 / 已被另一个任务替代），则走终态关闭路径——`project-feedback` 是 `close_task` 的主要调用方：
   - **取消**（任务作废、无替代）：`close_task(id, "cancelled", reason="<为什么不做>")`（`reason` 必填）
     - 如该任务仍有在跑的 dependents，`close_task` 会发出 `dependents_blocked_by_cancel` 的 ops_event，提示控制器重新指向或一并关闭这些 dependents，避免静默死锁
   - **被替代**（已有新任务接替）：`close_task(id, "superseded", reason="<被谁替代/为什么>", replacement_task_id="<新任务 id>")`（`reason` + `replacement_task_id` 均必填，且会校验 replacement 存在 / 非自身 / 未关闭 / 无替代链环）
     - `superseded` 会自动把原任务的所有 dependent 边改指到 replacement，保持 DAG 可运行
   - `cancelled` / `superseded` 是**终态**（无后继），只能经 `close_task` 进入；`update_task_status` 会拒绝这两个状态并要求改用 `close_task`
   - 关闭后用 `add_log` 记录验收/关闭理由（`close_task` 自身也会写一条 `task_closed` 审计日志，`kind=task_transition`、`event_type=task_closed`、`source=close_task`）
5. 如果某个任务被**误关或重新需要**（之前进了 `done` / `cancelled` / `superseded`，现在要再做），可走复活路径——`reopen_task` 与 `close_task` 同属一组管理动作，调用边界一致（仅 `project-feedback` 或显式控制器/管理决策可调用，role 驱动阶段不调用）：
   - `reopen_task(id, reason, to_status?)`：把终态任务（`done` / `cancelled` / `superseded`）带回 `todo`（默认）或 `in_progress`；`reason` 必填，是 `close_task` 的受审计反向动作
   - 复活 `superseded` 任务会清掉它的 `replacement_task_id`；但当初在 supersede 时被改指到 replacement 的 dependent 边**不会**自动恢复（审计日志会标注这一点，需要时手动重新指向）
   - `reopen_task` 走管理旁路，不经过正常的前向状态机

## 注意事项

- 只处理真正等待人工确认的任务
- `milestone_manual` 的通过反馈应额外记录阶段收口说明
- `project-feedback` 的职责是 gate 收口与任务流转，不是隐式的 `fixer` 或 `tester`
- 区分"返工"与"不做"：返工 → `in_progress`（走 route-first workflow）；不做 → `close_task(cancelled|superseded)`；只有非终态任务可被关闭
- 误关或重新需要的任务可经 `reopen_task(id, reason, to_status?)` 复活（`done` / `cancelled` / `superseded` → `todo` | `in_progress`，`reason` 必填）；它与 `close_task` 调用边界一致，只由 `project-feedback` 或显式控制器/管理决策发起，role 阶段不调用
- 如果反馈意味着还要继续改代码、跑测试或重新审查，应重新进入对应的 route-first workflow，而不是在这里直接继续干活
- 如果人工反馈本身意味着 workflow 已经失败（例如任务被拒收或验收过程中暴露系统性问题），按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
