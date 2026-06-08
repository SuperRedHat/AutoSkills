# 全局开发规范

> 本文件由 AutoSkills 仓库 `templates/global-codex-AGENTS.md` 经 bootstrap 同步生成。
> 项目级别的 `AGENTS.md` 可覆盖或补充此处规则。

---

## 一、工作流规则（最高优先级）

### 核心流程约束
- 在写任何代码之前，必须先完成设计文档并等待用户明确确认。
- 每完成一个任务必须运行验证命令，验证通过才能继续下一步。
- 不要一次性生成大量代码，分模块逐步实现并验证。
- 涉及架构变更时必须先更新设计文档，等用户确认后再改代码。

### Git 规范
- Commit message 遵循 Conventional Commits：`type(scope): description`
- 自动 commit 默认开启
- 自动 push 默认关闭，除非用户明确要求
- 每个任务完成后单独 commit

### 任务状态机
```text
todo -> in_progress -> auto_verified -> done                         (acceptance_mode=auto)
todo -> in_progress -> auto_verified -> awaiting_manual_acceptance  (acceptance_mode=manual)
todo -> in_progress -> auto_verified -> done                        (acceptance_mode=milestone_manual and stage_gate=false)
todo -> in_progress -> auto_verified -> awaiting_manual_acceptance  (acceptance_mode=milestone_manual and stage_gate=true)
awaiting_manual_acceptance -> in_progress

# 终止状态 cancelled / superseded：无出边，仅可经 close_task 进入（受审计的管理旁路，update_task_status 不接受这两个状态）
# 仅 project-feedback（人工 gate 拒绝）或控制器/管理决策可调用 close_task；角色工作流阶段只上报失败，不调用 close_task
任意非终止状态 --close_task(cancelled, reason)--> cancelled
任意非终止状态 --close_task(superseded, reason, replacement_task_id)--> superseded

# 终止状态 done / cancelled / superseded：现各有唯一一条「受审计」反向边，经 reopen_task 回到 todo（默认）或 in_progress（reason 必填，受审计管理旁路，正常只由 project-feedback/控制器调用；不走正向状态机）
done / cancelled / superseded --reopen_task(reason, to_status?)--> todo | in_progress
```

> getNextTask 把 cancelled / superseded 视为「已关闭但非 done」：superseded 依赖沿 replacement 链改指向替代任务，cancelled 依赖会阻塞其下游（显式上报，不静默死锁）。

### 任务验收字段
规划任务时优先写入以下字段：

- `acceptance_mode: auto | manual | milestone_manual`
- `verification_profile`
- `verification_commands`
- `review_checklist`
- `stage_gate`

兼容旧项目时：

- `needs_manual_review == false` 等价于 `acceptance_mode=auto`
- `needs_manual_review == true` 等价于 `acceptance_mode=manual`

### 前端任务默认策略
- 普通前端组件/页面/交互：默认 `acceptance_mode=auto` + `verification_profile=frontend_browser`
- 高风险视觉任务：使用 `milestone_manual` 或 `manual`
- 以下情况默认保留人工 gate：
  - 大范围响应式重做
  - 复杂动画或过渡系统
  - 截图、图片处理、视觉回归敏感任务
  - 阶段收口页或里程碑演示页

### MCP 工具使用
本工作流依赖 `project-manager` MCP Server 进行状态持久化，存储路径为项目根目录 `.claude/state/`。

关键规则：

- 在每个新会话中第一次调用任何 MCP 工具之前，必须先调用 `set_project_dir`
- 在 `project-plan` 和 `project-change` 中写入结构化验收字段，而不是只写 `needs_manual_review`

---

## 二、架构与质量原则

- 遵循 SOLID / DRY / KISS / 关注点分离
- 表现层 -> 业务层 -> 数据层
- API 统一响应格式：`{ data, meta?, error? }`
- 所有外部输入必须校验
- 核心业务逻辑必须有自动化测试

### 前端验证基线
- 默认验证顺序：
  - `pnpm exec eslint .`
  - `pnpm exec tsc -b`
  - `pnpm exec vitest run`
  - `pnpm exec playwright test`
- 普通前端任务通过上述验证后可自动验收
- 只有高风险视觉任务和阶段 gate 需要人工确认

---

## 三、协作模式

- 遇到模糊需求主动追问，不要假设
- 给出技术方案时说明理由和权衡
- 执行破坏性操作前先告知用户
- 顾问模式只回答问题，不修改文件

