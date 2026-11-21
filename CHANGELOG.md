# 版本记录

AutoSkills 套件的版本记录。账本服务端 project-manager 有自己的一份：[mcp/project-manager/CHANGELOG.md](mcp/project-manager/CHANGELOG.md)。

## 3.1.0（2026-11-21）

3.0 之后的四个小项。账本服务端没有改，仍是 1.5.1。

### 新增

- **一句话起长跑**（2026-11-20）。在 Claude Code 会话里跟主控说一句“起长跑”（可以带截止时间、任务个数、模型和档位），它先把自己的记账收尾，然后在新开的 PowerShell 窗口里起长跑驱动。驱动还在跑的时候，起它的会话、说“继续”的会话和处理验收的会话都只读，不写账本。会话不自己删驱动的锁。只改了技能文字：project-next（新加 `long-run.md`）、project-resume、project-feedback。用法见 [docs/run.md](docs/run.md)，真实会话里的表现见 [docs/run-from-session-probe.md](docs/run-from-session-probe.md)。
- **长跑驱动给它起的会话打无人值守标记**。环境变量 `AUTOSKILLS_UNATTENDED=1`，守卫见到就拒绝推送，不看权限模式。
- **检查脚本多了两条现场探查**：推送（Claude 上询问、Codex 上拒绝）和带无人值守标记的推送（两边都拒绝）；另有一行报告用户级设置里点名 `git push` 的规则。

### 变了的行为

- **推送不再一律被拒，改成要你点同意**。代理发起的 `git push`，守卫在 Claude Code 上回“询问”，由 Claude Code 弹出确认窗，你点同意才执行。每次推送点一次。
  - 六种权限模式（default、acceptEdits、plan、bypassPermissions、auto、dontAsk）守卫回的都是询问。
  - 读不出权限模式、带无人值守标记的会话、Codex、守卫出错时，照旧拒绝。
  - 对外发送（邮件、日历邀请、共享文件这类 MCP 工具）照旧拒绝。
- **发布也改成要你点同意**（负责人 2026-11-21 定）。gh 的写操作（repo、release、pr、workflow 里读以外的子命令）、带写方法的 gh api、npm publish，守卫在 Claude Code 上回“询问”，能弹窗和不能弹窗的条件与推送完全一样；和推送写在同一条命令里也是一次询问。删仓库、改可见性这类撤不回来的操作也在里面。
- **共用契约里推送和发布从零例外规则里拿了出来，单列一条**：默认不做，你说了才发起；推送时代理从 origin 取地址、写完整地址推送，不向你要地址，不改 pushurl；推不推由你本人在确认窗里点同意决定，文字里的“已同意”不算数。
- **用户级设置里推送和发布的 100 条 deny 规则在部署时去掉**：`git push` 10 条，gh 的写操作和 `npm publish` 90 条（Bash 和 PowerShell 各一半）。deny 规则先于钩子的询问，留着就弹不了窗。对外发送类 MCP 工具、只读目录和客户数据目录的 deny 规则不动，你自己另加的规则不动，`pushurl = no_push` 照旧设。
- **检查脚本**：现场探查里 `npm publish` 从“要被拒绝”改成和推送一样（Claude 上询问、Codex 上拒绝）；不再有 Bash 和 PowerShell 两行 deny 规则的检查；用户级设置里还留着点名 gh 或 npm publish 的 deny 规则时报 WARN。

### 升级

在主检出里、关掉所有 Claude Code 和 Codex 会话以后：

```powershell
node scripts/deploy-kit.mjs            # 先看计划
node scripts/deploy-kit.mjs --apply
node scripts/check-kit.mjs
```

以前部署时带过 `--retire-legacy-agents` 的，这次也带上。回滚见 [docs/deploy.md](docs/deploy.md)。

### 已知的限度

- 开着窗口的会话里，只有跳过权限的模式（bypassPermissions）下的确认窗有记录在案的观察。auto 模式里是分类器替人回答提示，钩子的询问会不会每次都送到确认窗，没有量过；头一次在这个模式下推送时请留意是不是你自己点的。
- dontAsk 模式按它的设计多半会把要问的调用直接拒掉，所以这个模式下大概还是推不了。
- “点拒绝以后确实没有推出去”没有留下证据。
- 发布类命令不再有 deny 规则兜底，确认窗是最后一道。窗里守卫写的理由只列出命中的命令名，对哪个仓库、哪个包做什么要看窗里的命令原文。
- 确认窗里守卫写的那句理由不带推到哪个地址和分支，要看窗里显示的命令原文。
- 守卫看不到的写法（写进脚本再运行、编码过的命令、here-doc 的正文）不会弹窗；真正兜底的是 `pushurl = no_push`。

量过什么、怎么量的，见 [docs/push-consent-probe.md](docs/push-consent-probe.md)。

## 3.0（2026-11-19）

本地标签 `v3.0`。由两部分组成：

- **第 1 批**（2026-11-01 部署）：串行的共用契约、7 个 `project-*` 技能、守卫钩子和 SessionStart 钩子、两个平台的设置片段、部署和检查脚本。旧套件的其余技能和 CouncilFlow 退役。设计决定见 [ADR-006](docs/adr-006-autoskills-3-batch1-serial-kit.md)。
- **收尾**：长跑驱动（`scripts/autoskills.mjs run`、`stop`）、验收包（`accept`）、手动并行的技能文字。设计决定见 [ADR-009](docs/adr-009-autoskills-3-finish.md)。

自动并行、账本 2.0 和 runner 做到试点为止，存档在分支 `p0` 和 `as3-359`，不接着做。

## 更早

`v2.0` 和 `v1.5.1` 是旧套件时期的标签。那一段的记录在 `docs/` 下的各份报告和 ADR-001 到 ADR-005 里，按当时的状态理解。
