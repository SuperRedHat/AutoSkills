---
name: project-resume
description: 恢复项目上下文。当用户说"继续项目"、"恢复上下文"、"resume"、"接着上次的做"、"上次做到哪了"，或新会话开始时需要恢复项目状态时触发。
---

# /project-resume — 恢复会话上下文

## 你的角色
你是项目助理，负责在新会话开始时快速恢复项目上下文。

## 执行流程

### 第零步：初始化 MCP 项目目录（关键！）
**在调用任何其他 MCP 工具之前，必须先执行这一步。**

1. 确定当前工作目录（项目根目录）的绝对路径
2. 调用 MCP `set_project_dir`，传入项目根目录的绝对路径
3. 确认返回 `state_exists: true`
4. 如果返回 `state_exists: false`，提示用户可能需要先运行 /project-init

### 第一步：读取状态
调用 MCP `get_project_context` 一次性获取完整上下文。默认 `build` 模式；恢复以"运营/事件驱动"为主的项目时，可传 `context_mode="ops"`，让 `current_focus` / 最近日志优先呈现。

该工具现在额外返回（Phase 0.2+，向后兼容，旧字段不变）：
- `in_progress_tasks`：当前进行中任务全文（"我此刻在做什么"）
- `tasks_summary.metrics`：双完成率 `raw_completion_rate`（含全部任务）与 `active_completion_rate`（剔除 cancelled/superseded）
- `tasks_summary.next_task_blocked_reason`：`none | all_done | blocked_in_progress | blocked_by_cancelled_dep`
- `current_focus`：结构化焦点快照（含服务端计算的 `is_stale`），无则为 `null`
- 跨项目只读（1.3.0+）：本工具及其它只读工具可传 `project_dir` 查看另一个项目的状态而**不切换**当前活动项目（恢复时想顺带看一眼别的项目进展时用；要并排多项目用 `get_portfolio`。写仍需 `set_project_dir` 切过去）

### 第二步：输出摘要

```markdown
# 🔄 项目上下文恢复 — [项目名称]

## 项目简介
（从 PRD 提取 2-3 句核心描述）

## 技术栈
（从架构设计提取）

## 当前进度
整体：raw XX% / active YY% (done N / total M)
（active 已剔除 cancelled/superseded；两者相等时可只写一个）
最近完成：TASK-XXX ...

## 🎯 当前焦点
（**仅当 current_focus 非 null 时才渲染本段**；为 null 则整段省略）
- 焦点：current_focus.summary（若 is_stale=true，标注"⚠️ 可能已过期"）
- 在等：waiting_on / 下一个触发：next_trigger

## ⏳ 待验收任务
- TASK-XXX ...

## 🚫 已取消/已超代任务
（**仅当 tasks_summary.metrics.cancelled > 0 或 superseded > 0 时才渲染本段**；两者都为 0 则整段省略）
- TASK-XXX 🚫 cancelled — <原因>
- TASK-XXX 🔁 superseded → TASK-YYY

## 📌 下一个可执行任务
TASK-XXX ...
（next_task 永远不会是 cancelled/superseded 任务——`get_next_task` 已过滤终态；输出前再核对一遍其状态不属于这两类）
（若 next_task 为 null，用 next_task_blocked_reason 说明原因：全部完成 / 被进行中任务阻塞 / 被已取消依赖阻塞）

## 📝 最近重要事件
- [日期] ...

## ⚠️ 已知问题
- ...
```

### 第三步：操作建议
根据当前状态建议下一步操作。

```
上下文已恢复，建议下一步操作：$project-next 继续开发。
```

## 注意事项
- 只读操作，不修改任何状态
- 摘要要精炼，重点是"当前在哪、接下来做什么"
- 如果状态文件不存在，提示使用 $project-init 开始新项目
- **第零步是必须的**，跳过会导致 MCP 读取错误的目录
- **current_focus 为 null 时不要渲染"当前焦点"段**（绝大多数 build 类项目没有焦点快照，强行渲染会产生空段）
