---
name: project-status
description: 查看项目进度。当用户说"进度"、"看板"、"状态"、"status"、"完成了多少"、"还剩多少"时触发。以看板形式展示当前项目的任务状态和整体进度。
---

# /project-status — 项目进度看板

## 你的角色
你是项目状态的报告者，清晰、简洁地展示当前项目进度。

## 执行流程

### 第一步：读取状态
调用 MCP `get_project_info`、`get_all_tasks`、`get_logs`（最近 10 条）。

也可改用一次 `get_project_context` 拿到 `tasks_summary.metrics`（`total_all` / `active_total` / `done` / `cancelled` / `superseded` / `closed_total` / `raw_completion_rate` / `active_completion_rate`），直接得到双完成率与各终态计数，省去本地统计。

跨项目（1.3.0+）：只读工具均可传 `project_dir` 查看**另一个**项目而**不切走**当前项目；要并排看多个项目，用一次 `get_portfolio(project_dirs[])` 直接拿到逐项目的 进度双率/当前焦点/下一个任务 摘要（仅 per-call 列表，不读注册表）。

### 第二步：计算并输出看板

```
📊 项目进度 — [项目名称]

整体进度（raw）：████████░░ 72% (18/25 tasks)        # raw_completion_rate，分母含全部任务
有效进度（active）：█████████░ 86% (18/21 tasks)      # active_completion_rate，分母剔除 cancelled/superseded
（两个比率相等时可只展示一行）

📋 待开始 (4)
   TASK-019  添加导出功能          [M]  依赖: TASK-018

🔧 进行中 (1)
   TASK-018  数据可视化图表        [L]  ⏳ 执行中

⏳ 待验收 (2)
   TASK-016  用户设置页面          [M]  🔍 等待手动测试

✅ 最近完成 (最近 5 个)
   TASK-015  报表导出 API         [M]  ✅ 2h ago

🚫 已取消 / 🔁 已超代 (3)                              # 默认折叠/诊断用，计数为 0 时整段省略
   TASK-011  旧版导出方案          🚫 cancelled  原因: 需求撤回
   TASK-009  临时鉴权中间件        🔁 superseded → TASK-022

📝 最近日志 (最近 5 条)

💡 建议
   → 有 2 个任务等待人工验收，建议先运行 /project-feedback
```

## 注意事项
- 只读操作，不修改任何状态
- 信息要简洁
- 同时给出 raw 与 active 两个完成率（active 已剔除 `cancelled` / `superseded`），不要只报一个让进度看起来虚高或虚低
- "已取消 / 已超代"段是折叠/诊断性质：计数为 0 时整段省略，不要在正常活跃任务里混入终态任务
