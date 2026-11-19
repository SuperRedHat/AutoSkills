---
name: project-status
description: 只读看进度：完成率、在做什么、卡在哪、等用户验收的任务（带 review_checklist）、预计还要多久（标明是估计）。只调读工具，不写账本，不改文件。用户说"进度""状态""看板""还剩多少""status"时使用。
---

# /project-status — 只读进度

## 只读（写死）
- 只调读工具：`get_server_info`、`get_project_context`、`get_all_tasks`、`get_task_by_id`、`get_logs`、`get_current_focus`；看多个项目时用 `get_portfolio`。
- 不调任何写账本的工具，也不调 `set_project_dir`（它会切换服务端的当前项目）。本会话还没对准这个项目时，给每个读工具传 `project_dir`（主检出的绝对路径）。
- 不改文件、不提交、不写 `.autoskills/`；git 只读（`git status --short`、`git log --oneline`）。
- 在循环中被问到进度时，简短答完接着做，不取消正在执行的目标。

## 1. 读
- `get_project_context`：tasks_summary 里的 metrics（raw 和 active 完成率）、by_status、awaiting_acceptance（含 review_checklist）、next_task 和 next_task_blocked_reason；in_progress_tasks；current_focus；recent_logs。
- 要看依赖或 notes 时用 `get_all_tasks`；估计时间用 `get_logs(kind="task_transition", n=50)`。

## 2. 判断
- 在做什么：in_progress 的任务；current_focus 没过期时附上它的 summary。
- 卡在哪：
  - notes 里写着"受阻"的任务，附原因；
  - next_task_blocked_reason 不是 none 或 all_done 时，说明是哪种；
  - 依赖被 cancelled 的任务；
  - 只因依赖还在等用户验收而不能开始的任务。
- 等用户验收：awaiting_manual_acceptance 的任务，逐个列 review_checklist（第一条压成"风险 中，改用户级文件 否"这样一行）。`<项目>/.autoskills/acceptance/` 下有当天的 HTML 验收包时，在这一段末尾给出它的路径。
- 预计还要多久（估计）：
  - 从 task_transition 日志算最近完成的任务从 →in_progress 到 →auto_verified 的时长，取中位数，乘以还没完成的 todo 和 in_progress 任务数；
  - 等用户验收的时间不算在内，单独写"另有 n 个等你验收"；
  - 样本少于 3 个时写"样本不足，暂不估计"；
  - 一律标"估计"，写明样本数和方法，不当承诺。

## 3. 输出（一屏能看完，不超过约 20 行）
```
<项目名> 进度：done 18/25（raw 72%，active 86%）
在做：T3.2 导出接口（in_progress）
卡住：T3.4 受阻：缺测试账号 | T3.6 依赖 T3.5 等验收
等你验收（2）：
  T3.1 设置页面  风险 中，改用户级文件 否
    - 窄屏下表单不溢出
    - 深色模式对比度
预计还要：约 3 小时（估计：最近 6 个任务的中位数 × 4 个未完成任务）
建议：先验收 T3.1、T3.5（回复如"T3.1、T3.5 通过"）
```
- 两个完成率相等时只写一个；cancelled、superseded 不为 0 时，在第一行末尾加计数。
- 每段最多列 5 个任务，多出的写"另有 n 个"；某段为空就整段省略。
- 只报读到的数字和 id，读不到的写"未核实"。
