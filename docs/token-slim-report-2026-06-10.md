# PM-708 skills/templates token 瘦身报告（2026-06-10）

## 总览

| 指标 | 值 |
|---|---|
| 基线（11 SKILL.md + 4 templates） | 82,806 字节 |
| 瘦身后 | 59,886 字节 |
| **节省** | **22,920 字节（27.7%）** |
| 净删减行数 | 388 删 / 176 增 = 212 行 |

目标是 ≥12KB，实际节省近一倍。

## 去重手法（每条被删内容都确认权威位置仍在）

1. **委派契约统一**：每个 skill 把 route-first 5 条军规（不传 --model / local_execution / delegated / 失败停 / 降级说明）从"每个 role 阶段重复一遍"收敛为文件内一段「委派契约」+ 各阶段一行命令。原先 project-next 4 个角色 × 5 条、project-plan/change/design/init/ask 各 2-3 角色 × 5 条。
2. **discuss 协议单一权威**：project-init / design / plan / change / ask / next / review 里的 discuss 协议块（default_models / min_rounds / summary_path / shell 超时两段式恢复 / 失败白名单）替换为一行"遵循 project-discuss 的规范段"。完整协议只保留在 **project-discuss**（其规范段已含 0.1.6 恢复协议 + 转发 provider error kinds 白名单）。
3. **超时恢复协议**：discussion wait 全文只留在 project-discuss；project-next 保留 delegation wait 全文（委派与讨论是两套 wait，各自的权威 skill 保留）。
4. **动态角色路由段**：project-next / project-review 末尾自述 no-op 的「动态角色路由 0.1.3+」整段（~730B×2）压缩为委派契约里一句。
5. **project-next 注意事项去自我重复**：删掉与编号流程逐字重复的 timeout/verification-command/reviewer 强制等条目。
6. **状态机/兼容映射**：project-next 的 acceptance_mode→next-status 4 行映射 + needs_manual_review 兼容段，指向全局模板的「任务状态机」段（bootstrap 已装到用户级 CLAUDE.md，每会话加载）。
7. **repo 模板**：repo-CLAUDE.md / repo-AGENTS.md 删掉与全局模板重复的通用规则（set_project_dir / 5 验收字段 / close_task），改为"只写项目特有"的占位骨架——符合其自身声明。
8. **frontmatter description**：删 discuss / resume / status / init 的机制尾句，保留全部触发短语 + 一句 purpose（这些 description 注入每会话 system prompt）。

## 质量保障

去重后逐条核对关键行为句仍在权威位置（grep 验证）：

| 行为句 | 留存文件数 |
|---|---|
| 可重复 `--verification-command`（legacy 禁用） | project-next |
| `guardrail_violation` artifact-first 契约 | 3（plan/design/change） |
| `close_task` 终态关闭 | 6 |
| `reopen_task` 复活 | 2（next/feedback） |
| Workflow Failure Report Protocol | 9 |
| `set_project_dir` 优先 | 4 |
| `stage_gate=true` 才触发 gate | project-plan |
| `data.summary_path` 读取 | 8 |
| `error.error_kind`（CLI 真实字段名） | 2（next/review） |
| discussion/delegation wait 恢复 | discuss + next |
| milestone_manual 验收策略 | plan/feedback（+全局模板状态机） |

11 个 SKILL.md frontmatter 完整性全部通过；未触碰 MCP server 源码与测试。
