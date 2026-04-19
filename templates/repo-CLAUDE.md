# 项目级开发规范

> 本文件由 AutoSkills 仓库 `templates/repo-CLAUDE.md` 经 bootstrap 同步生成。
> 仅写项目特有的补充规则；全局默认规则来自用户级 `CLAUDE.md`。

## 项目级补充项

- 在首次调用 `project-manager` MCP 之前，先调用 `set_project_dir(<repo-root>)`
- 当前项目如需覆盖默认验收策略，应在任务规划阶段写入：
  - `acceptance_mode`
  - `verification_profile`
  - `verification_commands`
  - `review_checklist`
  - `stage_gate`
- repo-local 规则只补充项目特殊约束，不复制整套全局规则

