# Skills + Templates Migration Report (TASK-065)

**日期**：2026-04-19
**源**：`~/.workflow-core/skills/` + `~/.workflow-core/templates/`
**目标**：`D:/project/AutoSkills/skills/` + `D:/project/AutoSkills/templates/`
**策略**：cp -r（拷贝，非移动）；原始位置保持不动

## 搬迁清单

### skills/ — 11 个 project-* skills 全量搬迁

| Skill | 源 | 目标 | 状态 |
|---|---|---|---|
| project-ask | `~/.workflow-core/skills/project-ask/` | `AutoSkills/skills/project-ask/` | ✅ |
| project-change | `~/.workflow-core/skills/project-change/` | `AutoSkills/skills/project-change/` | ✅ |
| project-design | `~/.workflow-core/skills/project-design/` | `AutoSkills/skills/project-design/` | ✅ |
| project-discuss | `~/.workflow-core/skills/project-discuss/` | `AutoSkills/skills/project-discuss/` | ✅ |
| project-feedback | `~/.workflow-core/skills/project-feedback/` | `AutoSkills/skills/project-feedback/` | ✅ |
| project-init | `~/.workflow-core/skills/project-init/` | `AutoSkills/skills/project-init/` | ✅ |
| project-next | `~/.workflow-core/skills/project-next/` | `AutoSkills/skills/project-next/` | ✅ |
| project-plan | `~/.workflow-core/skills/project-plan/` | `AutoSkills/skills/project-plan/` | ✅ |
| project-resume | `~/.workflow-core/skills/project-resume/` | `AutoSkills/skills/project-resume/` | ✅ |
| project-review | `~/.workflow-core/skills/project-review/` | `AutoSkills/skills/project-review/` | ✅ |
| project-status | `~/.workflow-core/skills/project-status/` | `AutoSkills/skills/project-status/` | ✅ |

### templates/ — 4 个模板全量搬迁（原计划 2 个，实际覆盖 4 个以保持一致性）

| 模板 | 源 | 目标 | 状态 |
|---|---|---|---|
| global-claude-CLAUDE.md | `~/.workflow-core/templates/` | `AutoSkills/templates/` | ✅ |
| global-codex-AGENTS.md | `~/.workflow-core/templates/` | `AutoSkills/templates/` | ✅（任务未显式要求但为保持 Codex 主控完整性一并搬迁） |
| repo-AGENTS.md | `~/.workflow-core/templates/` | `AutoSkills/templates/` | ✅（同上） |
| repo-CLAUDE.md | `~/.workflow-core/templates/` | `AutoSkills/templates/` | ✅ |

## 去个人化替换清单

搬迁前对源做了完整扫描：

- `skills/project-*/**/*.md`：**0 处**包含 `C:\Users\David Zhai` 或 `/c/Users/David Zhai`
- `templates/*.md`：**4 处**，均为 frontmatter 下的 "本文件由 <path> 生成" 注释行

### 替换点明细

所有 4 处均为 templates 文件的第 3 行注释。格式统一替换：

**原（源位置不动，仅 AutoSkills 副本修改）**：
```
> 本文件由 `C:\Users\David Zhai\.workflow-core\templates\<name>` 生成。
```

**新**：
```
> 本文件由 AutoSkills 仓库 `templates/<name>` 经 bootstrap 同步生成。
```

| # | 文件 | 行号 | 替换动作 |
|---|---|---|---|
| 1 | `AutoSkills/templates/global-claude-CLAUDE.md` | 3 | 同上模式 |
| 2 | `AutoSkills/templates/global-codex-AGENTS.md` | 3 | 同上模式 |
| 3 | `AutoSkills/templates/repo-AGENTS.md` | 3 | 同上模式 |
| 4 | `AutoSkills/templates/repo-CLAUDE.md` | 3 | 同上模式 |

## 业务逻辑改动

**零改动**。所有 `SKILL.md` 的 `## 执行流程`、`## 核心约束`、`## 注意事项`、`## 多模型协作（可选）` 等业务章节按字节对拷，未做任何修改。

## 扫描最终状态（搬迁后）

```bash
cd D:/project/AutoSkills
grep -rnIE 'C:\\Users\\David Zhai|/c/Users/David Zhai' skills templates
# → 无匹配

grep -rnIE 'sk-[A-Za-z0-9_-]{20,}|ghp_|xoxb-|AIza[0-9A-Za-z_-]{30,}' skills templates
# → 无匹配
```

## 拷贝策略确认

```bash
cp -r ~/.workflow-core/skills/project-* D:/project/AutoSkills/skills/
cp ~/.workflow-core/templates/*.md D:/project/AutoSkills/templates/
```

- 使用 `cp -r` / `cp`，**不是** `mv`
- 原始 `~/.workflow-core/skills/` 目录未被删除、未被移动、未被修改
- 原始 `~/.workflow-core/templates/` 目录同上

## 验收状态

| 验收项 | 状态 |
|---|---|
| 11 个 project-* skills 搬迁 | ✅ |
| 每个 skill 含 SKILL.md | ✅ |
| templates 含 global-claude-CLAUDE.md + repo-CLAUDE.md | ✅（额外加 2 个） |
| `grep David Zhai` 无匹配 | ✅ |
| `grep secrets pattern` 无匹配 | ✅ |
| 业务逻辑 0 修改 | ✅ |
| 拷贝不是移动 | ✅ |

**建议**：TASK-068 的 `sync-skills.ps1` / `sync-skills.sh` 应基于 AutoSkills 的 `skills/` 和 `templates/` 作为同步源，与 `~/.workflow-core/` 解耦。
