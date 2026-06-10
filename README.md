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
| `skills/project-*/` | 11 个 `project-*` 工作流 skills 源——逐个作用与用法见下方 [Skills 一览](#skills-一览11-个-project--工作流) |
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
| `docs/adr-001..005-*.md` | project-manager ops / 管理 / 跨项目 / 元数据补丁 + 一致性检查 / 任务身份与 reconcile 安全包络（ADR） |
| `mcp/project-manager/CHANGELOG.md` | project-manager 版本变更日志（当前 **v1.5.1**） |

---

## Skills 一览（11 个 `project-*` 工作流）

每个 skill 是一段驱动「当前主控 AI」的工作流提示词，部署后在任一主控里用 `/<skill 名>` 触发（或说出触发短语）。它们共享同一套约定：先 `set_project_dir` → 用 `project-manager` MCP 读写状态 → 需要别的模型时按项目级 `.council/config.yaml` 路由到 CouncilFlow。

把它们按一个项目的生命周期串起来最好理解：

> **`init` →（可选 `discuss`）→ `design` → `plan` → `next` ×N →（`review` / `feedback`）**，过程中随时 `ask` / `status` / `resume`，需求变了走 `change`。

| Skill | 触发（典型说法） | 作用 | 怎么用 / 产出 |
|---|---|---|---|
| **project-init** | "开始项目"、"需求分析"、"写 PRD" | 需求澄清并生成 PRD | 对话澄清边界 → 经 `planner`/`synthesizer` 路由 → 用户确认后 `save_prd` 落盘，并为新项目落 repo-local `AGENTS.md`/`CLAUDE.md` |
| **project-design** | "开始设计"、"架构设计"、"系统设计" | 基于已确认 PRD 出架构文档 | 读 PRD → `architect`/`synthesizer` 路由 → 含技术选型/目录结构/接口/数据模型/Mermaid 图 → 确认后 `save_architecture` |
| **project-plan** | "拆任务"、"任务规划"、"plan" | 把 PRD+架构拆成带验收字段的原子任务 | 拓扑拆解 → 每个任务写 `acceptance_mode`/`verification_*`/`stage_gate`/`priority` → 确认后 `create_tasks` |
| **project-next** | "下一个任务"、"继续开发"、"next" | 执行下一个可执行任务（核心循环） | `get_next_task` → 阶段机 `implementer→tester→reviewer→[fixer↻]→synthesizer` → 按验收字段自动验证 → 状态流转 + 独立 commit |
| **project-review** | "审查代码"、"review"、"code review" | 对最近完成任务做代码审查 | 收集 done 任务文件 → `reviewer` 路由 → 分级报告（🚨/⚠️/💡/✅）→ 严重问题自动 `add_subtask` 建修复任务 |
| **project-change** | "需求变更"、"改需求"、"加功能" | 评估变更影响、更新文档、追加任务 | `architect→planner→synthesizer` 评估 → 更新 PRD/架构 → 追加新任务；作废的旧任务用 `close_task(superseded/cancelled)` |
| **project-ask** | "这个怎么实现"、"XX和YY哪个好"、"ask" | 纯顾问模式答疑 | **只读**，绝不改文件/不跑写命令 → `advisor`/`synthesizer` 路由 → 结合项目上下文给方案对比与建议 |
| **project-feedback** | （任务停在 `awaiting_manual_acceptance` 时）"验收"、"通过"、"返工" | 处理人工验收与阶段 gate 收口 | 验收通过 → `done`（含 `milestone_manual+stage_gate` 阶段收口）；返工 → 回 `in_progress` 走 route-first；不做 → `close_task`；误关 → `reopen_task` |
| **project-status** | "进度"、"看板"、"还剩多少"、"status" | 展示项目进度看板 | 读 metrics → ASCII 看板：双完成率（raw/active）+ 各状态任务分组 |
| **project-resume** | "继续项目"、"恢复上下文"、"resume"、"上次做到哪" | 新会话快速恢复上下文 | 先 `set_project_dir` → `get_project_context` → 输出"现在在哪/在等谁/为何卡住/下一个干什么"摘要 |
| **project-discuss** | "讨论一下"、"多模型讨论"、"让其他模型看看" | 独立多模型讨论入口 | 整理 `initial_position` → `council discuss` 引入其他模型评论 → 当前主控综合收敛成可执行结论（**discuss 协议的权威定义在此 skill**，其余 skill 的 discuss 旁路引用它） |

**说明**：上面除 `project-discuss` / `project-ask` 外，主体阶段（planner/architect/synthesizer/implementer/tester/reviewer/fixer）都走 CouncilFlow「route-first」——目标模型若等于当前主控就本地执行（`local_execution`），否则派给 sidecar（`delegated`）；没装 CouncilFlow 时退回主控直接执行。每个 skill 的完整阶段契约、失败上报与超时恢复协议见各自的 `skills/<name>/SKILL.md`。

---

## project-manager 能力速览（v1.5.1）

`project-manager` 已从最初的"线性 build 任务 + 日志持久化"扩展为支持**运营 / 管理 / 跨项目**的状态引擎（全程**向后兼容、纯加法**）。完整工具清单见 [mcp/project-manager/README.md](mcp/project-manager/README.md)，设计依据见 `docs/adr-001..005`，版本变更见 [CHANGELOG](mcp/project-manager/CHANGELOG.md)。

- **任务生命周期**：除前向状态机（`todo → in_progress → auto_verified → done`）外，新增终态 `cancelled` / `superseded`，经**受审计的** `close_task` 进入（不污染完成率）；`reopen_task` 受审计地复活终态任务（撤销误关/误完成）。
- **优先级**：任务可带 `priority`，`get_next_task` 优先派高优先级（同分按创建顺序，**永不越过依赖门控**）；`set_task_priority` 事后调整。
- **批量**：`update_tasks` / `close_tasks` / `archive_module` 一次处理多个任务（逐条仍走完整校验）。
- **当前焦点（ops）**：`set_current_focus` / `get_current_focus` 把"在做什么 / 在等什么"记成结构化快照（`focus.json`，带 `is_stale`）——运营 / 事件驱动型工作尤其受用。
- **富日志 / journal**：`add_log` 支持 `kind` / `event_type` / `tags` / `entities`（`task_id` 可为 null = 项目级事件）；`get_logs` 可按 `kind` / `event_type` / `since` 先过滤后切片（journal 视图）。
- **双完成率**：进度同时给 `raw`（含全部任务）与 `active`（剔除已取消 / 被取代）两个口径，避免取消任务后完成率虚高/虚低。
- **跨项目 / portfolio**：所有**只读**工具支持可选 `project_dir`（**不切走**当前项目即可查另一个项目）；`get_portfolio(project_dirs[])` 一次聚合多项目的进度 / 焦点 / 下一个任务。
- **更丰富的恢复上下文**：`get_project_context` 现额外返回 `in_progress` 全文、双完成率 `metrics`、`current_focus`、`next_task_blocked_reason` 诊断——`/project-resume` 因此能直接呈现"现在在哪、在等谁、为何卡住"。
- **元数据补丁（1.4.0）**：`edit_task` 改任务的 `title`/`notes`/`dependencies`/验收字段等**而不触碰 status**（改 `acceptance_mode` 自动同步 `needs_manual_review`、改依赖校验存在/自环/环），终结"改个字段也得手搓 `tasks.json`"。
- **一致性检查 / 修复（1.4.0，L8）**：`lint_state` 只读交叉核对 tasks/project/logs/focus 四处真相（25 检查，头牌 `progress_drift`＝进度与重算不符），可跨项目巡检；`reconcile` 仅对当前项目做安全确定性自动修复（progress 重算 + 去自环 + active 任务的 stale 字段清理），其余交 `edit_task` 手修；显式 `dry_run:true` 对活动项目也只返回 fix-plan 不落盘。
- **批量元数据补丁 + 任务重命名（1.5.0，ADR-005）**：`edit_tasks` 一次补丁多个任务的元数据字段；`rename_task` 改任务 id 并级联改写 dependencies / replacement_task_id / focus 引用（logs 不可变留痕），落盘前全图后置校验，失败整体拒绝**不部分写**；`reconcile` 支持跨项目 dry-run/fix-plan（foreign 项目绝不落盘）。
- **可靠性强化（1.5.1，审计修复批次）**：全部状态文件写入原子化（tmp+rename，崩溃不再产生截断 JSON）；状态文件损坏时返回带文件名的结构化 `state_file_corrupt` 错误、`lint_state` 容损可诊断；多文件变更前预检衍生文件防"半应用"；Windows 路径大小写归一（`d:/x` 与 `D:/X` 不再被误判为两个项目）；`create_tasks`/`add_subtask` 拒绝重复/空白 id；`close_task` supersede 不再把替代任务自身的依赖边改写成自依赖（与 `rename_task` 同款全图校验）。

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
| CouncilFlow | 0.2.0+ | 已通过 `pipx install git+https://github.com/SuperRedHat/CouncilFlow.git` 装好 |
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

安装安全性（1.5.1 加固）：
- `npm install / build` 退出码被严格检查——构建失败立即终止，**不会**把旧 dist 注册成 MCP server
- 写 `~/.gemini/settings.json` 一律无 BOM；解析失败时**备份原文件并跳过合并**，绝不清空你的既有配置
- skills 同步的"畸形目录清理"只针对名字含 `project-` 的目录，你自己装的其他 skill（即使名字带 `{},`）不会被碰

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

restore 在动手前会**自动对当前状态再做一次快照**（误恢复可再恢复回来），然后整目录还原 skills 三端目录、`claude-commands`、`gemini-settings.json`（快照之后新增的内容会被移除——这正是前置快照存在的原因）。**不会**反向执行 `codex/claude mcp remove` —— 如需清除 MCP 注册，再跑一次 bootstrap（会重新注册为当前 manifest 定义的状态）或手动 remove。

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
- [mcp/project-manager/README.md](mcp/project-manager/README.md) — project-manager 完整工具清单（v1.5.1）
- [mcp/project-manager/CHANGELOG.md](mcp/project-manager/CHANGELOG.md) — project-manager 版本变更
- `docs/adr-001..004-*.md` — ops / 管理 / 跨项目 / 元数据补丁 + 一致性检查能力设计决策
