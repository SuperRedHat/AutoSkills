---
name: project-next
description: 执行下一个任务，按结构化验收字段自动验证并决定状态流转。
---

# /project-next — 执行下一个任务

## 执行流程

1. 调用 `get_next_task` 取出可执行任务（已过滤终态、沿 replacement 链解析依赖、优先级感知；被 cancelled 依赖阻塞会显式上报）。
2. 调用 `update_task_status(id, "in_progress")`。
3. 如果检测到 `council` 可用，则把项目目录下的 `.council/config.yaml` 视为自动分发真源；文件缺失时 CouncilFlow 会在首次调用时自动生成模板。
4. 如当前任务方案存在明显不确定，且用户显式要求 `discuss`，先走一轮多模型讨论：
   - `council discuss "这个任务应该如何实现最稳妥？" --controller-position "<主控本地立场>"`（用户显式给模型时加 `--models ...`）
   - 协议细节（default_models 读取 / min_rounds / `data.summary_path` 读取 / shell 超时两段式恢复 / 确认失败才停）**一律遵循 project-discuss 的规范段**（最易错且不可省的一点先记住：shell 超时/非零退出 ≠ 讨论失败——用 `council status` 取 `last_discussion_id` → `council discussion wait <id> --timeout 7200` 等到底再判）；这一步一旦进入即硬前置
5. 把任务视为一个显式阶段机，而不是"实现完后主控自己顺手测一下"：
   - `implementer -> tester -> reviewer -> [fixer -> tester -> reviewer]* -> synthesizer`

### 委派契约（适用于下面所有 `council delegate` 阶段调用）

- 不传 `--model`，目标模型由项目级 `roles.<role>` 决定（含动态路由 list 形式，0.1.3+：路由引擎按 `when` 匹配决定，skill 层不干预；`error.error_kind = routing_no_match` 按失败上报协议处理）
- 返回 `status = local_execution` → 当前主控本地执行该阶段
- 返回 `status = delegated` → 先读取 `.council/delegations/<id>/` 产物（result.md 等），再进入下一阶段
- 返回错误、缺少 handoff/result artifact，或无法完成调用 → **停止当前 workflow 并如实报告失败**
- 仅当 `council` 明确缺失或不可调用时，才允许降级为主控直接执行，且必须在输出中说明

### 超时判定协议（硬前置，适用于所有 `council delegate` 调用）

- `council delegate` 是同步子进程调用，真实 stage（如 Canvas/复杂实现）可能运行几十分钟到两小时
- 本地 shell 的命令超时（通常 3–4 分钟）**不等于** delegation 失败；artifact 还在写
- 当 shell 调用 timeout / 非零退出、且 `.council/delegations/<id>/handoff.yaml` 已落盘时，**必须**：
  1. 从 handoff 路径或 stderr 提取 `<delegation_id>`
  2. 调用 `council delegation wait <delegation_id> --project-root <repo-root> --timeout 7200`
  3. 只有 wait 返回 `error_kind=wait_timeout` 或 `record.json` 内 `status=failed`，才允许按 `Workflow Failure Report Protocol` 输出 `workflow_failure`
  4. wait 成功且 `record.json.status=completed` → 当正常委派产物继续（读 `result.md`）
- 只有 `handoff.yaml` 也缺失（子进程根本没启动），才直接按委派失败处理（一般是 adapter 缺失或配置错误）

6. 先进入 `implementer` 阶段（按上方委派契约）：
   - `council delegate --role implementer --objective "实现 XX 功能" --task-summary "编码实现"`
   - 未读取委派结果前不要直接自己实现
7. 再进入 `tester` 阶段（按上方委派契约）：
   - 任务里的 `verification_commands` / `verification_profile` 是 tester 的输入，不是主控默认本地动作；`local_execution` 时才允许主控亲自运行验证
   - `verification_commands` 必须以**可重复的** `--verification-command` 逐条传入，禁止用 `&&` 拼接塞进 `--input`（legacy 已 deprecated；PRD §27.5 / §29.7 硬约束）：
     ```
     council delegate --role tester \
       --objective "验证当前任务实现" \
       --task-summary "执行 verification_commands / verification_profile" \
       --input verification_profile="<task.verification_profile>" \
       --verification-command "<task.verification_commands[0]>" \
       --verification-command "<task.verification_commands[N]>" \
       --required-artifact implementer_result="<implementer 的 result artifact>" \
       --next-on-success "若验证通过，进入 reviewer 阶段" \
       --next-on-failure "若验证失败，进入 fixer 阶段"
     ```
   - tester 通过后不要直接收口，必须进入 `reviewer` 阶段
8. tester 通过后，强制进入 `reviewer` 阶段（按上方委派契约）：
   - `council delegate --role reviewer --objective "复审当前任务实现是否语义正确" --task-summary "基于 tester 通过结果做语义复审" --required-artifact implementer_result="<implementer 的 result artifact>" --required-artifact tester_result="<tester 的 result artifact>" --input review_checklist="<task.review_checklist>" --next-on-success "若 reviewer 通过，进入 synthesizer / 状态流转" --next-on-failure "若 reviewer 发现问题，进入 fixer 阶段"`
   - `delegated` 时先读 reviewer 产物，再判断是否存在 findings
9. 如果 tester 或 reviewer 明确判定失败，进入 `fixer` 阶段（按上方委派契约），再回到 `tester` 与 `reviewer`：
   - `council delegate --role fixer --objective "根据 tester / reviewer 结果修复问题" --task-summary "修复验证或复审阶段发现的问题" --required-artifact tester_result="<tester 的 result artifact>" --required-artifact reviewer_findings="<reviewer 的 findings artifact>" --next-on-success "修复完成后重新进入 tester，再进入 reviewer" --next-on-failure "停止 workflow 并报告 fixer 阶段失败"`
   - 如果 fixer 阶段发现任务本身**无法修复 / 超出范围 / 被前置条件长期阻塞**，role 阶段不要无限循环重试：fixer 只负责如实报告，由**控制器/管理决策**（不是 role 阶段）用 `close_task(id, "cancelled", reason=...)` 关闭，或升级到 `project-feedback` 处理（`close_task` / `reopen_task` 不归 role 阶段调用，`workflow_failure` 日志也不构成关闭授权）
10. 只有当 tester 与 reviewer 都明确通过后，当前主控才负责收口、状态流转与最终汇报。
11. 验证通过后调用 `update_task_status(id, "auto_verified")`。
12. 按全局规范的任务状态机决定下一状态（`acceptance_mode` / `stage_gate` 映射与 `needs_manual_review` 兼容规则见全局 CLAUDE.md / AGENTS.md 的「任务状态机」「任务验收字段」段）。
13. 生成独立 commit，并报告修改、验证结果和状态。

## 注意事项

- 不要在实现前跳过设计确认
- 自动验收不等于跳过验证
- `discuss` 是显式可选步骤，不要把它变成每个任务默认都会触发的隐藏动作
- 当任务等待人工确认时，输出 `review_checklist`
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON（`workflow=project-next`、对应 `failed_stage`）并调用 `project-manager` MCP `add_log(type="workflow_failure", task_id=<task id>, ...)`，再停止当前 workflow
