---
name: project-next
description: 执行下一个任务，按结构化验收字段自动验证并决定状态流转。
---

# /project-next — 执行下一个任务

## 执行流程

1. 调用 `get_next_task` 取出可执行任务（该工具已自动过滤 `cancelled` / `superseded` 任务，并会沿 `superseded` 的 replacement 链解析依赖；遇到被 `cancelled` 依赖阻塞时会显式上报而非静默死锁，不会把已关闭任务派回执行）。
2. 调用 `update_task_status(id, "in_progress")`。
3. 如果检测到 `council` 可用，则把项目目录下的 `.council/config.yaml` 视为自动分发真源；如果文件缺失，CouncilFlow 会在首次调用时自动生成一份项目本地配置模板。
4. 如当前任务方案存在明显不确定，且用户显式要求 `discuss`，先调用 `CouncilFlow` 进行方案收敛：
   - 先由当前主控本地整理一句简短 `initial_position`
   - 用户显式给了模型：`council discuss "这个任务应该如何实现最稳妥？" --controller-position "<initial_position>" --models claude,gemini`
   - 用户没给模型：`council discuss "这个任务应该如何实现最稳妥？" --controller-position "<initial_position>"`
   - 不写 `--models` 时，CouncilFlow 会自动读取项目级 `discussion.default_models`
   - `--controller-position` 用来把当前主控的本地立场显式交给 CouncilFlow，避免同模型自嵌套
   - CouncilFlow 会把这版立场交给外部模型评论；实现方案的最终决定仍由当前主控综合
   - 只有达到项目级 `discussion.min_rounds` 后，讨论才允许提前收敛
   - 这一步是硬前置：只要决定进入 discuss，就必须先调用 CouncilFlow；如果 `council discuss` 返回错误、缺少 summary artifact，或无法完成调用，则**停止当前 workflow 并如实报告失败**
   - 优先使用命令返回 JSON 中的 `data.summary_path`
   - 如需手动定位，再读取 `.council/discuss/<discussion_id>/summary.md`
   - 如果去重后没有额外模型，接受 `CouncilFlow` 返回的 warning，并继续当前主控判断
5. 把任务视为一个显式阶段机，而不是“实现完后主控自己顺手测一下”：
   - `implementer -> tester -> reviewer -> [fixer -> tester -> reviewer]* -> synthesizer`

### 超时判定协议（硬前置，适用于所有 `council delegate` 调用）

- `council delegate` 是同步子进程调用，真实 stage（如 Canvas/复杂实现）可能运行几十分钟到两小时
- 本地 shell 的命令超时（通常 3–4 分钟）**不等于** delegation 失败；artifact 还在写
- 当 `council delegate` 自身的 shell 调用出现 timeout / 返回非零、且 `.council/delegations/<id>/handoff.yaml` 已经落盘时，**必须**：
  1. 从 handoff 的路径或 stderr 中提取 `<delegation_id>`
  2. 调用 `council delegation wait <delegation_id> --project-root <repo-root> --timeout 7200`（等待 2h）
  3. `delegation wait` 以轮询方式等 `record.json`；只有它返回 `error_kind=wait_timeout` 或 `record.json` 内 `status=failed`，才允许按 `Workflow Failure Report Protocol` 输出 `workflow_failure`
  4. 如果 `delegation wait` 返回成功，且 `record.json.status=completed`，就当正常的委派产物继续走下一阶段（读 `result.md`）
- 只有 `handoff.yaml` 也缺失（CouncilFlow 根本没启动子进程），才直接按委派失败处理；这种情况一般是 adapter 缺失或配置错误

6. 先进入 `implementer` 阶段。
   - 如果 `council` 可用，必须先按项目配置调用：
     `council delegate --role implementer --objective "实现 XX 功能" --task-summary "编码实现"`
   - 不传 `--model`，让 CouncilFlow 从项目级 `roles.implementer` 读取目标模型
   - 只有在返回 `status = local_execution` 时，当前主控才允许开始本地编码
   - 如果返回 `status = delegated`，则先读取 `.council/delegations/...` 产物，再进入下一阶段；不要在未读取委派结果前直接自己实现
   - 如果返回错误、缺少 handoff/result artifact，或无法完成调用，则**停止当前 workflow 并如实报告失败**
   - 只有在 `council` 明确缺失或不可调用时，才允许退回主控直接执行；这条降级必须在输出中明确说明
7. 再进入 `tester` 阶段。
   - 任务里的 `verification_commands` 与 `verification_profile` 应视为 tester 的输入，不再默认由主控自动本地执行
   - 如果 `council` 可用，必须先按项目配置调用；`verification_commands` 按**可重复的** `--verification-command` 逐条传入，禁止把多条命令用 `&&` 或换行拼成单条字符串塞进 `--input`（legacy 路径已 deprecated，下一个次版本移除）：
     ```
     council delegate --role tester \
       --objective "验证当前任务实现" \
       --task-summary "执行 verification_commands / verification_profile" \
       --input verification_profile="<task.verification_profile>" \
       --verification-command "<task.verification_commands[0]>" \
       --verification-command "<task.verification_commands[1]>" \
       --verification-command "<task.verification_commands[N]>" \
       --required-artifact implementer_result="<上一步 implementer 的 result artifact>" \
       --next-on-success "若验证通过，进入 reviewer 阶段" \
       --next-on-failure "若验证失败，进入 fixer 阶段"
     ```
   - 只有在 `status = local_execution` 时，当前主控才允许亲自运行验证命令
   - 如果返回 `status = delegated`，则先读取 tester 的委派产物，再判断验证是否通过
   - 如果返回错误、缺少 artifact，或无法完成调用，则**停止当前 workflow 并如实报告失败**
   - tester 通过后不要直接收口，必须进入 `reviewer` 阶段
8. tester 通过后，强制进入 `reviewer` 阶段。
   - 如果 `council` 可用，必须先按项目配置调用：
     `council delegate --role reviewer --objective "复审当前任务实现是否语义正确" --task-summary "基于 tester 通过结果做语义复审" --required-artifact implementer_result="<implementer 的 result artifact>" --required-artifact tester_result="<tester 的 result artifact>" --input review_checklist="<task.review_checklist>" --next-on-success "若 reviewer 通过，进入 synthesizer / 状态流转" --next-on-failure "若 reviewer 发现问题，进入 fixer 阶段"`
   - 只有在 `status = local_execution` 时，当前主控才允许亲自执行 review
   - 如果返回 `status = delegated`，则先读取 reviewer 产物，再判断是否存在 findings
   - 如果返回错误、缺少 artifact，或无法完成调用，则**停止当前 workflow 并如实报告失败**
9. 如果 tester 或 reviewer 明确判定失败，则进入 `fixer` 阶段，再回到 `tester` 与 `reviewer`。
   - `fixer` 同样必须先走：
     `council delegate --role fixer --objective "根据 tester / reviewer 结果修复问题" --task-summary "修复验证或复审阶段发现的问题" --required-artifact tester_result="<tester 的 result artifact>" --required-artifact reviewer_findings="<reviewer 的 findings artifact>" --next-on-success "修复完成后重新进入 tester，再进入 reviewer" --next-on-failure "停止 workflow 并报告 fixer 阶段失败"`
   - 只有在 `status = local_execution` 时，当前主控才允许本地修复
   - 如果返回 `status = delegated`，则先读取 fixer 产物，再重新进入 tester
   - 如果返回错误、缺少 artifact，或无法完成调用，则**停止当前 workflow 并如实报告失败**
   - 如果 fixer 阶段发现任务本身**无法修复 / 超出范围 / 被前置条件长期阻塞**，role 阶段不要无限循环重试：fixer 只负责如实报告，由**控制器/管理决策**（不是 role 阶段）用 `close_task(id, "cancelled", reason=...)` 关闭，或升级到 `project-feedback` 处理（`close_task` 不归 role 阶段调用，`workflow_failure` 日志也不构成关闭授权）
10. 只有当 tester 与 reviewer 都明确通过后，当前主控才负责收口、状态流转与最终汇报。
11. 验证通过后调用 `update_task_status(id, "auto_verified")`。
12. 根据 `acceptance_mode` 和 `stage_gate` 决定下一状态：
   - `auto` -> `done`
   - `manual` -> `awaiting_manual_acceptance`
   - `milestone_manual` + `stage_gate=false` -> `done`
   - `milestone_manual` + `stage_gate=true` -> `awaiting_manual_acceptance`
13. 生成独立 commit，并报告修改、验证结果和状态。

## 兼容规则

如果任务没有 `acceptance_mode`：

- `needs_manual_review == false` 视为 `auto`
- `needs_manual_review == true` 视为 `manual`

## 注意事项

- 不要在实现前跳过设计确认
- 自动验收不等于跳过验证
- `discuss` 是显式可选步骤，不要把它变成每个任务默认都会触发的隐藏动作
- 有 CouncilFlow 时，必须先路由、后执行；没有 `local_execution` 或显式委派产物前，不要直接开始本地编码、测试或修复
- `council delegate` 是同步子进程调用，shell 超时不等于失败；handoff 已生成时必须用 `council delegation wait <id> --timeout 7200` 继续等到 2 小时后才允许宣告失败
- `verification_commands` 属于 tester 阶段输入，不是主控默认本地动作
- `verification_commands` 必须以可重复的 `--verification-command` 逐条传入，禁止再用 `--input verification_commands="cmd1 && cmd2"` 的 legacy 写法（PRD §27.5 / §29.7 硬约束）
- tester 通过后仍必须进入 reviewer；不要把 tester 通过误当成任务已经可以直接收口
- reviewer 有 findings 时必须进入 fixer，再回到 tester 与 reviewer；不要把失败修补混进主控的未授权本地动作里
- 只有 tester 与 reviewer 都明确通过后，才允许进入 synthesizer、状态流转与 commit
- 当任务等待人工确认时，输出 `review_checklist`
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON（`workflow=project-next`、对应 `failed_stage`）并调用 `project-manager` MCP `add_log(type="workflow_failure", task_id=<task id>, ...)`，再停止当前 workflow



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
