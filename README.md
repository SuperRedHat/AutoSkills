# AutoSkills

> **CouncilFlow 的配套工作流仓库** —— 把 `project-*` 开发流 skills 和 `project-manager` MCP server 一键部署到 Codex / Claude Code / Gemini CLI 三端。

本仓库与 [CouncilFlow](https://github.com/SuperRedHat/CouncilFlow) 是**配套关系**：

- **CouncilFlow** 是 sidecar CLI 本体，提供 `council discuss` / `council delegate` / `council status` 等多模型协作能力
- **AutoSkills**（本仓库）提供让"当前会话主控"能自动触发 CouncilFlow 的那层工作流 skills + 必需的 MCP server + 一键部署脚本

只装 CouncilFlow 能用它的 CLI 命令；只装 AutoSkills 没有 CouncilFlow 可调。两者都装齐才是完整体验。

---

## 内容一览

| 目录 / 文件 | 作用 |
|---|---|
| `skills/project-*/` | 11 个 `project-*` 工作流 skills 源（init / design / plan / next / review / change / ask / feedback / status / resume / discuss） |
| `mcp/project-manager/` | `project-manager` MCP server（Node/TypeScript 工程），bootstrap 时构建并向三端注册 |
| `mcp-manifest.json` | MCP 注册 manifest（单一真源），bootstrap 时消费 |
| `templates/` | 全局 `CLAUDE.md` / `AGENTS.md` 模板（Claude + Codex） |
| `scripts/bootstrap.{ps1,sh}` | 一键安装编排器 |
| `scripts/sync-skills.{ps1,sh}` | 同步 `skills/` 到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.gemini/skills/` |
| `scripts/backup-global-workflow.{ps1,sh}` | 覆盖前做时间戳快照 |
| `scripts/restore-global-workflow.{ps1,sh}` | 从快照反向恢复 |
| `docs/bootstrap.md` | bootstrap 深度文档：每一步、幂等性、快照、回滚 |
| `docs/skills-migration-report.md` | skills 搬迁审计（TASK-065 产出） |
| `docs/mcp-migration-report.md` | MCP server 搬迁审计（TASK-066 产出） |
| `docs/adr-001..004-*.md` | project-manager ops / 管理 / 跨项目 / 元数据补丁 + 一致性检查能力设计（ADR） |
| `mcp/project-manager/CHANGELOG.md` | project-manager 版本变更日志（当前 **v1.4.0**） |

---

## project-manager 能力速览（v1.4.0）

`project-manager` 已从最初的"线性 build 任务 + 日志持久化"扩展为支持**运营 / 管理 / 跨项目**的状态引擎（全程**向后兼容、纯加法**）。完整工具清单见 [mcp/project-manager/README.md](mcp/project-manager/README.md)，设计依据见 `docs/adr-001..004`，版本变更见 [CHANGELOG](mcp/project-manager/CHANGELOG.md)。

- **任务生命周期**：除前向状态机（`todo → in_progress → auto_verified → done`）外，新增终态 `cancelled` / `superseded`，经**受审计的** `close_task` 进入（不污染完成率）；`reopen_task` 受审计地复活终态任务（撤销误关/误完成）。
- **优先级**：任务可带 `priority`，`get_next_task` 优先派高优先级（同分按创建顺序，**永不越过依赖门控**）；`set_task_priority` 事后调整。
- **批量**：`update_tasks` / `close_tasks` / `archive_module` 一次处理多个任务（逐条仍走完整校验）。
- **当前焦点（ops）**：`set_current_focus` / `get_current_focus` 把"在做什么 / 在等什么"记成结构化快照（`focus.json`，带 `is_stale`）——运营 / 事件驱动型工作尤其受用。
- **富日志 / journal**：`add_log` 支持 `kind` / `event_type` / `tags` / `entities`（`task_id` 可为 null = 项目级事件）；`get_logs` 可按 `kind` / `event_type` / `since` 先过滤后切片（journal 视图）。
- **双完成率**：进度同时给 `raw`（含全部任务）与 `active`（剔除已取消 / 被取代）两个口径，避免取消任务后完成率虚高/虚低。
- **跨项目 / portfolio**：所有**只读**工具支持可选 `project_dir`（**不切走**当前项目即可查另一个项目）；`get_portfolio(project_dirs[])` 一次聚合多项目的进度 / 焦点 / 下一个任务。
- **更丰富的恢复上下文**：`get_project_context` 现额外返回 `in_progress` 全文、双完成率 `metrics`、`current_focus`、`next_task_blocked_reason` 诊断——`/project-resume` 因此能直接呈现"现在在哪、在等谁、为何卡住"。
- **元数据补丁（1.4.0）**：`edit_task` 改任务的 `title`/`notes`/`dependencies`/验收字段等**而不触碰 status**（改 `acceptance_mode` 自动同步 `needs_manual_review`、改依赖校验存在/自环/环），终结"改个字段也得手搓 `tasks.json`"。
- **一致性检查 / 修复（1.4.0，L8）**：`lint_state` 只读交叉核对 tasks/project/logs/focus 四处真相（24 检查，头牌 `progress_drift`＝进度与重算不符），可跨项目巡检；`reconcile` 仅对当前项目做安全确定性自动修复（progress 重算 + 去自环），其余交 `edit_task` 手修。

> **升级到 v1.3.0**：旧状态文件**无需改动**即可读（新字段读时计算）；可选地用 `bootstrap.ps1 -MigrateState dir1,dir2` / `bootstrap.sh --migrate-state=dir1,dir2` 把既有项目**幂等**迁移到 schema v1（绝不改任务 status、回填日志 `kind`、补双完成率）。

---

## 前置要求

装 AutoSkills 的新电脑上需要：

| 组件 | 最低版本 | 备注 |
|---|---|---|
| Git | 2.30+ | clone 本私有仓库 |
| Node.js | 20.x LTS+ | 构建 `project-manager` MCP server（TypeScript → JavaScript） |
| PowerShell | 5.1+ (Windows) | 跑 `bootstrap.ps1`（PowerShell 5.x 或 7+ 都可） |
| bash | 4+ (macOS/Linux) | 跑 `bootstrap.sh` |
| Python | 3.8+ | `bootstrap.sh` 用 python3 解析 manifest（PS1 用内置 JSON） |
| CouncilFlow | 0.1.2+ | 已通过 `pipx install git+https://github.com/SuperRedHat/CouncilFlow.git` 装好 |
| Codex CLI / Claude Code CLI / Gemini CLI | 最新 | 至少装一个；bootstrap 会跳过未装的那端（不报错） |
| GitHub 访问凭据 | PAT / SSH | 本仓库是 private |

---

## 安装

### 一、克隆

```bash
# HTTPS + PAT
git clone https://<PAT>@github.com/SuperRedHat/AutoSkills.git

# 或：SSH
git clone git@github.com:SuperRedHat/AutoSkills.git

cd AutoSkills
```

### 二、预演（推荐先 dry-run）

```powershell
# Windows
powershell -NoProfile -File scripts/bootstrap.ps1 -DryRun
```

```bash
# macOS / Linux
bash scripts/bootstrap.sh --dry-run
```

dry-run 下脚本只打印"**将要做什么**"，不写文件系统、不跑 `npm install`、不调三端 CLI。看一遍动作清单确认 OK 再进入正式安装。

### 三、正式安装

```powershell
# Windows
powershell -NoProfile -File scripts/bootstrap.ps1
```

```bash
# macOS / Linux
bash scripts/bootstrap.sh
```

bootstrap 会按顺序执行：

1. **备份** — `~/.workflow-core-backups/<ISO8601>/` 下写快照（skills 三端目录 + `claude-commands/` + `gemini-settings.json` + `codex/claude mcp get` 输出）
2. **同步 skills** — `skills/project-*` 覆盖到 `~/.codex/skills/`、`~/.claude/skills/`、`~/.gemini/skills/`，附 SHA-256 校验
3. **构建 MCP server** — 在 `mcp/project-manager/` 下跑 `npm install && npm run build`，产物 `dist/index.js`
4. **注册三端** — 按 `mcp-manifest.json` 执行：
   - `codex mcp add project-manager -- node <AUTOSKILLS_HOME>/mcp/project-manager/dist/index.js`
   - `claude mcp add project-manager -s user -- node <...同上...>`
   - 合并写入 `~/.gemini/settings.json` 的 `mcpServers.project-manager`（含 `trust: true`）
5. **校验** — `codex mcp get` / `claude mcp get -s user` / 打印 gemini 配置段

任何一端 CLI 未装都会被**跳过**（只打印 info），不会让 bootstrap 失败。

### 四、验证

```bash
# CouncilFlow 能跑
council status

# MCP 三端可见
codex mcp get project-manager
claude mcp get project-manager -s user
python -c "import json; d=json.load(open(f'{__import__(\"os\").path.expanduser(\"~\")}/.gemini/settings.json')); print(d.get('mcpServers',{}).get('project-manager'))"

# 任一主控里新开会话，能调用 /project-status、/project-resume 等 skill
```

---

## 回滚

装错或想恢复到安装前：

```powershell
# Windows：用最近的快照（替换实际路径）
powershell -NoProfile -File scripts/restore-global-workflow.ps1 -SnapshotPath "$env:USERPROFILE\.workflow-core-backups\20260419T201129373Z"
```

```bash
# macOS / Linux
bash scripts/restore-global-workflow.sh --snapshot "$HOME/.workflow-core-backups/20260419T201129373Z"
```

restore 会还原 skills 三端目录、`claude-commands`、`gemini-settings.json`。**不会**反向执行 `codex/claude mcp remove` —— 如需清除 MCP 注册，再跑一次 bootstrap（会重新注册为当前 manifest 定义的状态）或手动 remove。

详见 [docs/bootstrap.md](docs/bootstrap.md)。

---

## 与 CouncilFlow 的关系

```text
┌─ 当前主控 AI (Codex / Claude Code / Gemini CLI) ─┐
│                                                  │
│  /project-init  /project-plan  /project-next ... │  ← AutoSkills skills/
│                    │                             │
│                    ▼                             │
│           project-manager MCP                    │  ← AutoSkills mcp/
│           (状态持久化: PRD / arch / tasks / logs) │
│                    │                             │
│                    ▼                             │
│              CouncilFlow CLI                     │  ← pip / pipx 装
│   council discuss / delegate / synthesize        │
└──────────────────────────────────────────────────┘
```

- AutoSkills 提供**流程**（project-* 工作流 + 状态 MCP）
- CouncilFlow 提供**能力**（多模型讨论 + 委派 + 综合）
- 两者组合出"AI 可驱动的开发工作流"

---

## 排错

常见问题见 [CouncilFlow docs/distribution.md](https://github.com/SuperRedHat/CouncilFlow/blob/main/docs/distribution.md#故障排查)。AutoSkills 特有问题：

- **`npm install` 失败 EACCES** → 不要用 sudo，改 `nvm` / `fnm` / `volta` 管 Node
- **bootstrap 跑完 `codex mcp get` 看不到 project-manager** → 看 `~/.workflow-core-backups/<ts>/mcp-state.log` 里 bootstrap 前后的对比；`codex mcp remove` 清掉再重跑
- **Claude 的 MCP 可见但主控不识别** → 重新打开 Claude 会话；或检查 `claude mcp get project-manager` 是否带 `-s user` 参数
- **SHA-256 校验失败** → 通常是 Windows line-ending 问题（CRLF vs LF），清掉目标目录（`rm -rf ~/.claude/skills/project-*`）重跑 bootstrap

---

## 相关链接

- [CouncilFlow](https://github.com/SuperRedHat/CouncilFlow) — 配套 sidecar 本体
- [docs/bootstrap.md](docs/bootstrap.md) — bootstrap 深度文档
- [mcp-manifest.json](mcp-manifest.json) — MCP 注册真源
- [mcp/project-manager/README.md](mcp/project-manager/README.md) — project-manager 完整工具清单（v1.4.0）
- [mcp/project-manager/CHANGELOG.md](mcp/project-manager/CHANGELOG.md) — project-manager 版本变更
- `docs/adr-001..004-*.md` — ops / 管理 / 跨项目 / 元数据补丁 + 一致性检查能力设计决策
