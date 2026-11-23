# AutoSkills

> Claude Code 和 Codex 共用的一套项目工作流：一份短的自主契约、7 个 `project-*` 技能、护栏钩子、两个平台的设置片段，三条在会话外面跑的命令（长跑、停、验收包），加上部署、检查和 lint 脚本。任务状态存在 `project-manager` MCP 账本里（1.5.1）。

当前是 **AutoSkills 3.0**。它由两部分组成：

- **第 1 批**（2026-11-01 部署）：串行的契约、技能、钩子和部署脚本。一个主循环按顺序做，子代理只做只读的活。设计决定见 [ADR-006](docs/adr-006-autoskills-3-batch1-serial-kit.md)。
- **收尾**（2026-11-19）：在上面加了三样。长跑驱动让任务一个接一个做下去，不用守着（[docs/run.md](docs/run.md)）；验收包把等你验收的任务排成一页（[docs/accept.md](docs/accept.md)）；手动并行是一套开几个窗口同时做的做法，只有文字（[docs/manual-parallel.md](docs/manual-parallel.md)）。设计决定见 [ADR-009](docs/adr-009-autoskills-3-finish.md)。

3.0 之后又加了四个小项，合起来是 **3.1.0**（版本记录见 [CHANGELOG.md](CHANGELOG.md)）：

- **一句话起长跑**：在 Claude Code 会话里说一句“起长跑”，主控替你在新窗口里起驱动（[docs/run.md](docs/run.md)）。
- **推送要你点同意**：代理发起的 `git push` 不再一律被拒，守卫弹出确认窗，你点了才推（[怎么推送和发布](#怎么推送和发布)）。
- **所有权限模式都弹窗**：Claude Code 的六种权限模式下推送都走确认窗；长跑驱动起的会话带无人值守标记，直接拒绝。
- **发布也由你点同意**：gh 对仓库、版本、PR、workflow 的写操作，带写方法的 gh api，和 npm publish 不再一律被拒，和推送一样走确认窗（[怎么推送和发布](#怎么推送和发布)）。

默认仍然串行。自动并行和账本改造做到试点为止，已存档，不接着做。部署和回滚见 [docs/deploy.md](docs/deploy.md)。

---

## 目录

- [前提](#前提)
- [五分钟上手](#五分钟上手)
- [共用契约](#共用契约)
- [7 个技能](#7-个技能)
- [三条命令](#三条命令)
- [护栏](#护栏)
- [两个平台的设置](#两个平台的设置)
- [部署和检查](#部署和检查)
- [怎么推送和发布](#怎么推送和发布)
- [残余风险](#残余风险)
- [目录说明](#目录说明)
- [文档索引](#文档索引)

---

## 前提

- **系统**：原生 Windows。套件只在 Windows 上部署和测过；钩子的命令行和便携 Node 都按 Windows 写。macOS 和 Linux 上只有 `scripts/bootstrap.sh`（构建和注册 project-manager），套件的其余部分没有在那里跑过。
- **平台**：Claude Code，或 Codex，或两个都装。长跑驱动、验收包和推送的确认窗只在 Claude Code 上有。
- **工具**：git、系统 Node（跑 project-manager 和仓库里的脚本）、Git for Windows 带的 Git Bash（跑 `tests/kit`）。钩子用的是放在运行区里的便携 Node 24.22.2，和系统 Node 分开：bootstrap 发现它不在时会打印下载和校验的做法（[docs/deploy.md](docs/deploy.md)）。
- **一个 Windows 账户**：护栏只防误操作，不做隔离（见[残余风险](#残余风险)）。

---

## 五分钟上手

1. **装**：照[部署和检查](#部署和检查)里“新机器的顺序”跑一遍。新机器上 bootstrap 第一次以退出 3 结束是正常的，照它打印的做法补上本地配置和便携 Node 再跑。部署前关掉所有 Claude Code 和 Codex 会话。
2. **立项**：在你的项目目录里开一个会话，说“规划”。project-plan 起草一页设计（目标、非目标、验收标准、任务拆分），你确认一次；之后它写账本和项目契约。
3. **做**：说“把剩下的做完”。project-next 按顺序取任务、实现、验证、提交、记录，一直做到停点，不用每个任务说一次“继续”。
4. **验收**：到了要你看的地方它会停下，列出等你验收的任务。你点名回一句，比如“T3.1–T3.5 通过，T3.3 按钮错位”。
5. **断了接着做**：新开会话说“继续”。
6. **不想守着**：说“起长跑”，或者在普通终端里敲[三条命令](#三条命令)里的 `run`。跑完看报告，用 `accept` 出一页验收包。
7. **推送**：说“把 main 推上去”，在弹出的确认窗里点同意；发版本也一样，说“发布 v1.2.0”（[怎么推送和发布](#怎么推送和发布)）。

想随时看进度，说“进度”（只读，不改任何东西）。

---

## 共用契约

两个平台读同一份契约（`templates/global-AGENTS.md`，约 50 行），部署到 `~/.claude/AGENTS.md` 和 `~/.codex/AGENTS.md`；`~/.claude/CLAUDE.md` 只写 `@AGENTS.md` 加几行 Claude 专属内容（`templates/global-claude-CLAUDE.md`）。要点：

- **优先级**：平台约束和零例外规则（不改只读目录、不访问客户数据）最先；对外发送（在浏览器里提交表单、发消息、挂商品，发邮件，共享文件，发日历邀请）代理可以自己做，不用请示，无人值守的会话只发你说过要发的，登录和付钱（下单购买、付款、转账）由你自己来；推送和发布（gh 对仓库、版本、PR、workflow 的写操作，带写方法的 gh api，npm publish）默认不做，你说了才发起，要你本人在确认窗里点同意才执行；别的 gh 写操作（issue、secret、gist 等）守卫不认、不弹窗，同样是你说了才做；其余按本轮指令 > 项目契约 > 本契约 > 技能步骤。
- **执行循环**：取就绪任务 → 实现 → 按风险验证 → 提交 → 记录 → 取下一个，直到停点。
- **停点只有五种**：本轮做完；只剩用户本人能定的事；真的卡住；预算或截止时间到；用户说暂停或控制器出错。
- **证据**：只认本会话里实际执行的命令，写明命令、退出码和日志位置；提交号从 git 读取，不得编造。
- **验收**：待验收改成完成，只能在处理用户本人的验收消息时做（project-feedback），并逐字记下原话。
- **子代理**：只有主会话（Codex 里是根线程）写账本、认领任务、提交和记录验收；子代理只读，不调 `set_project_dir`，不调 project-* 技能。
- **账本**：根线程开始时用主检出的绝对路径调一次 `set_project_dir`，再用 `get_server_info` 核对。

各项目自己的规则写在项目根目录的 `AGENTS.md` / `CLAUDE.md`，由 project-plan 按 `templates/repo-AGENTS.md` 生成。需要长跑时，project-plan 最后输出一段能直接粘贴的 `/goal`（模板 `templates/goal.txt`）。

---

## 7 个技能

Claude Code 里用 `/<技能名>`，Codex 里用 `$<技能名>`，也可以直接说触发说法。保留 `project-` 前缀，是为了不和两个平台内置的 `/plan`、`/status`、`/resume`、`/feedback` 撞名。

| 技能 | 用途 | 触发说法 |
|---|---|---|
| **project-plan** | 项目级规划：目标、非目标、验收标准、本人验收点、风险等级和任务拆分；新项目顺带写 PRD、架构和项目契约，需求变了就评估影响、改任务；最后输出 `/goal` | “规划”“立项”“拆任务”“需求变了”“改计划” |
| **project-next** | 按契约**循环做到停点**：取就绪任务、实现、验证、提交、记录，再取下一个；不再一次只做一个任务 | “做下一个任务”“做 T3.1–T3.5”“把剩下的做完” |
| **project-resume** | 新会话或中断后：先对一遍 git 和账本，补记已提交但账本没记的，接着按循环做 | “继续”“继续项目”“接着上次的做”“resume” |
| **project-feedback** | 处理你本人的验收和反馈，可以批量；逐字记下原话、会话 id 和时间，处理完接着做 | “T3.1–T3.5 通过”“T3.3 不行”“验收”“驳回” |
| **project-status** | 只读看进度：完成率、在做什么、卡在哪、等你验收的任务、预计还要多久（标明是估计） | “进度”“状态”“看板”“还剩多少”“status” |
| **project-consult** | 要外部第二意见时，在项目文件夹里写一份自包含的提示词，由你自己复制过去；你把回答贴回来后逐条核实再记进账本 | “问问 Pro”“要个第二意见”“写个咨询提示词” |
| **project-quick** | 小事快修：不碰门禁和接口、一次提交就能回滚、不需要重型套件时用；超出就转成正式任务 | “顺手修一下”“小改一下”“快修” |

有风险的任务和里程碑，由只读的独立校验者按原始验收标准审查：Claude 用 `project-verifier` 子代理（`config/claude/agents/project-verifier.md`，只给读工具）；Codex 先由主线程只读核对。找不到证据的条目就是没满足，只有一个例外：任务做完会停下等你验收时，只有你本人能确认的条目留给你验收（ADR-009 §2.13）。旧版的其余技能已退役，退役说明见 ADR-006 §2.2；部署时会删掉用户级的旧副本。

---

## 三条命令

在**普通的 PowerShell 窗口**里敲，不在 Claude Code 或 Codex 的会话里敲。它们是仓库里的脚本，不部署到用户级；目前只支持 Claude Code。长跑还有一种起法：在 Claude Code 会话里跟主控说一句“起长跑”，它替你在新窗口里起（[docs/run.md](docs/run.md)“在会话里说一句来起”一节）。

| 命令 | 作用 | 说明 |
|---|---|---|
| `node scripts/autoskills.mjs run <项目目录>` | 长跑驱动：每个任务开一个全新的无头会话去做，会话结束后在提交好的代码上把任务的验证命令再跑一遍，到停点就停，留一份报告 | [docs/run.md](docs/run.md) |
| `node scripts/autoskills.mjs stop <项目目录>` | 让正在跑的驱动做完手上的任务后停 | 同上 |
| `node scripts/autoskills.mjs accept <项目目录>` | 验收包：把等你验收的任务排成一页 HTML，不起会话，不花 token | [docs/accept.md](docs/accept.md) |

- 驱动和验收包都**只读账本**。任务状态仍由会话里的技能改；验收仍要你本人在会话里点名任务说通过或驳回。
- 驱动跑着的时候，不要在同一个项目里另开会话记账：账本没有锁，两边同时写会丢更新。说“继续”的会话和处理验收的会话会先查驱动的锁，别的入口不查。
- 想让一个阶段里互不相干的几块同时做，见 [docs/manual-parallel.md](docs/manual-parallel.md)：规划时点名并行，主控拆好块、给出每个窗口的启动命令，你开窗口，做完由主控逐块验证、合并、记账。

---

## 护栏

同一个 Windows 账户下，护栏只防误操作，不承诺隔离（见[残余风险](#残余风险)）。

- **守卫钩子** `hooks/guard.mjs`（PreToolUse，两个平台共用）：
  1. 推送和发布：git push 的各种写法、gh 的写操作（repo、release、pr、workflow 里读以外的子命令）、带写方法的 gh api、npm publish。Claude 上六种权限模式（default、acceptEdits、plan、跳过权限 bypassPermissions、自动模式 auto、dontAsk）守卫都回“询问”，由 Claude Code 弹出确认窗，你点同意才执行（开着窗口时只有跳过权限的模式有人看过弹窗；dontAsk 按它的设计多半会把要问的调用直接拒掉）；读不出模式时、长跑驱动起的会话里、Codex 上，照旧拒绝。删仓库、改可见性这类撤不回来的操作也在里面，窗里的命令请看清再点；
  2. 拦写进登记只读目录的 Edit、Write、NotebookEdit（Codex 是 apply_patch），按真实路径比较；
  3. 拦子代理（带 agent_id 的调用）调账本写工具和 `set_project_dir`；
  4. 在本仓库拦带 `-x` 或 `-X` 的 git clean（保护 `_private/` 里的运行区和部署备份；这一条是新增的，可以删）。

  **出错即拦截，两个平台一样**：守卫出错时原因都写 stderr。Claude 上退出 2，按 `onFailure: "block"` 拦下这次调用；Codex 上输出拒绝 JSON（理由写明守卫出错和原因）并退出 0，Codex 照 JSON 拦下。Codex 上不靠退出 2，是因为 Windows PowerShell 5.1 的 `-Command` 会把退出 2 改成 1，而 Codex 只在退出 2 时拦。所以守卫或它的运行时坏了，匹配到的调用会全部被拦，恢复方法见 [docs/deploy.md](docs/deploy.md#钩子运行时缺失时怎么恢复)。每次运行写一行心跳（只记时间、平台、事件和决定），检查脚本据此确认钩子真的跑过。
- **SessionStart 钩子** `hooks/session-start.mjs`（只在 Claude 注册）：startup、resume、compact 时注入几行提示和会话 id。
- **Claude 的 deny 规则**：设置片段（`config/claude/settings.fragment.json`）里一条也没有；只读目录的 Edit、客户数据目录的 Read 由部署脚本按本地配置生成。推送和发布没有 deny 规则：deny 规则先于守卫的询问，留着就弹不了确认窗，这些命令由守卫管。对外发送类的 MCP 工具（Gmail 发信、回复、转发，Drive 共享，日历建事件、改事件、回复邀请）2026-11-23 起也没有 deny 规则，代理可以直接用。部署时会把以前写进去的那 107 条去掉（git push 10 条，gh 的写操作和 npm publish 90 条，对外发送 7 条），预演的理由里逐条列出。你自己另加的规则不动。
- **Codex 的规则**（`config/codex/rules/autoskills.rules`）：`prefix_rule` 拦简单形式的 git push、gh 写操作、npm publish。规则只匹配简单命令，**只当提醒**，由钩子和 pushurl 兜底。
- **pushurl**：部署时给项目根目录下所有有远端的仓库设 `pushurl = no_push`（`scripts/set-pushurl.mjs`，先记原值，可恢复），登记的只读目录跳过。

钩子由运行区 `_private/rt/` 里的便携 Node 24.22.2 启动；project-manager 仍用系统 Node。

---

## 两个平台的设置

片段里不含本机路径，用 `<home>`、`<runtime>`、`<node>` 占位，由部署脚本合并；合并只动套件的键，其余内容保留。

- **Claude**（`config/claude/settings.fragment.json`）：`subagentPromptCacheTtl: "1h"`；`worktree.baseRef: "head"`；`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=6`；两个钩子（deny 规则只有部署时按本地配置生成的目录规则）。**不设** `CLAUDE_CODE_EFFORT_LEVEL`：设了任何值都会盖过子代理定义里的 effort，检查脚本会查它。
- **Codex**（`config/codex/config.fragment.toml`、`config/codex/hooks.json`）：`model_reasoning_effort = "medium"`（只管 CLI 和默认值）；`[desktop] followUpQueueMode = "steer"`（运行中说“暂停”能及时送达）；不设 `agents.default_subagent_reasoning_effort`；技能装到 `~/.agents/skills`；守卫注册在 `~/.codex/hooks.json`，要在 Codex 的 /hooks 里信任。线程上限没有设。
- **桌面版的用法**：每个新聊天选“完全访问”；规划时可临时选 xhigh，开 `/goal` 前切回执行档位；ultra 只用于又大、又能拆成独立几块、并且有人看着的任务。

---

## 部署和检查

完整步骤、冒烟矩阵和回滚见 **[docs/deploy.md](docs/deploy.md)**。简表：

| 脚本 | 作用 |
|---|---|
| `scripts/bootstrap.ps1` / `bootstrap.sh` | 构建 `mcp/project-manager`，按 `mcp-manifest.json` 向 Claude Code 和 Codex 注册，再检查部署前提并跑一次 deploy-kit 的 dry-run |
| `scripts/deploy-kit.mjs` | 部署套件到用户级。默认 dry-run（只列计划）；`--apply` 先备份、记日志、出错自动回滚；`--rollback <部署 id>`；`--neutral`（测量用的中性档）；`--drill <目录>`（恢复演练）；`--init-local`（本地配置）；`--stage`（测量用的项目级副本） |
| `scripts/check-kit.mjs` | 只读健康检查，输出 PASS、WARN、FAIL 表；`--report-only` 总是退出 0，部署前用 |
| `scripts/set-pushurl.mjs` | 给仓库设 `pushurl = no_push`，或按日志恢复；deploy-kit 部署时调用它 |
| `scripts/lint-kit.mjs` | 套件文本的检查：隐私、工具名、技能格式、旧内容、契约、源码 |
| `scripts/autoskills.mjs` | 会话外面跑的三条命令：`run`、`stop`、`accept`（见[三条命令](#三条命令)）；不部署 |

新机器的顺序：

```powershell
powershell -NoProfile -File scripts/bootstrap.ps1   # 构建和注册 project-manager
node scripts/deploy-kit.mjs --init-local             # 本地配置和两个金丝雀目录
node scripts/deploy-kit.mjs                          # dry-run，看计划
node scripts/deploy-kit.mjs --apply                  # 先关掉所有 Claude Code 和 Codex 会话
node scripts/check-kit.mjs                           # 重开两个平台、在 Codex /hooks 信任钩子之后
```

套件自己的测试：`tests/kit/` 下每个测试文件用 `node --test tests/kit/<文件全名>` 逐个跑，再跑 `node scripts/lint-kit.mjs --check all`。不用通配：`node --test` 的通配匹配不到文件也退出 0。`deploy-kit.test.mjs` 要在没有别的会话调工具时跑，并且只能在主检出跑（它要用不进 git 的恢复工具）。`check-kit.test.mjs` 跑之前把 Codex 彻底退出，跑的时候也不要有别的 Claude Code 会话或窗口开着：它核对真实的 `~/.claude/settings.json` 前后没有变，别的会话一写这个文件它就失败。

---

## 怎么推送和发布

**让代理推**（只在 Claude Code 上）：在开着窗口的会话里说一句“把 <分支> 推上去”。代理从 origin 取地址，写完整地址推送；守卫弹出确认窗，你看清推到哪个地址、哪个分支，点同意才推，点拒绝就不推。每次推送点一次。六种权限模式下守卫回的都是询问。开着窗口时只有跳过权限的模式有人看过弹窗；自动模式（auto）里是分类器替人回答提示，钩子的询问会不会每次都送到确认窗还没有人看过，头一次在这个模式下推送时请留意是不是你自己点的（量过什么、哪些没人看过，见 [docs/push-consent-probe.md](docs/push-consent-probe.md)）。长跑驱动起的会话带着无人值守的标记（环境变量 `AUTOSKILLS_UNATTENDED=1`），守卫见到就直接拒绝推送；别的无头会话（`claude -p`）里没有人能点，推不了；Codex 上照旧全拦。

**让代理发布**（只在 Claude Code 上）：说一句“发布 v1.2.0”“开个 PR”“把这个包发到 npm”。代理发起 gh 或 npm 的命令，守卫照样弹确认窗，窗里写着命令原文，你点同意才执行。发一个版本通常要点两次：推标签一次，建 Release 一次。能弹窗、不能弹窗的情况和推送完全一样。对外发消息（邮件、日历邀请、共享文件这类 MCP 工具）不在里面，照旧不做。

**你自己推**：部署后，项目根目录下有远端的仓库都设了 `pushurl = no_push`，`git push origin <分支>` 会直接失败。在**普通终端**（不是代理的会话）里写完整地址：

```powershell
git push https://github.com/<owner>/<repo>.git <分支>
# 或者从 origin 取地址（不带 --push，取到的是拉取地址）
git push (git remote get-url origin) <分支>
```

写完整地址时不经过远端的 pushurl。守卫和 deny 规则只管代理的工具调用，管不到你自己的终端。不要为了推送去改回 pushurl，代理也不改它。

---

## 残余风险

如实写明，不承诺隔离（详见 ADR-006 §4；长跑驱动和验收包带来的见 ADR-009 §4）：

- **长跑时没有人看着**：无头会话在自动模式下跑，守卫钩子和拒绝规则照常生效（推送和发布在这些会话里直接被拒，不弹窗），但原生 Windows 上没有沙箱。对外发送在这些会话里不拦，契约要求只发你说过要发的。头几次跑完请看报告。
- **驱动跑着的时候，同一个项目里别的会话不能记账**：账本没有锁，只靠技能里的一句话和验收包页首的提示。
- **驱动的几条路只在替身测试里走过**：复验没过以后的返工、接着做断在半路的任务、额度用完以后的等待、会话挂死。

- **同一账户下，护栏只防误操作**：代理有意绕过时拦不住。要强隔离只能用单独的账户、WSL2 或沙箱，本轮不做。
- **对外发送没有拦截**（2026-11-23 起）：代理在浏览器里提交表单、发消息、挂商品，用 Gmail 发信、共享 Drive 文件、发日历邀请，都不弹窗，也没有规则拦，只靠契约里那一句。守卫不看浏览器操作，也不看这些 MCP 工具。“登录和付钱由你来”“无人值守只发你说过的”同样只是契约文字。网页和邮件里的内容可能诱导代理发出不该发的东西；契约写了工具输出和外部内容不能授予权限，这也只是文字。
- **确认窗是最后一道**：发布类命令不再有 deny 规则兜底，你点了同意就执行，包括删仓库、改可见性、`gh api -X DELETE`。窗里守卫写的理由只列出命中的命令名，对哪个仓库做什么要看窗里的命令原文。auto 模式里钩子的询问会不会每次都送到你面前没有量过。
- **守卫只认 gh 的四组命令**：repo、release、pr、workflow 里读以外的子命令，加上带写方法的 gh api。`gh issue create`、`gh secret set`、`gh gist create`、`gh run cancel`、`gh label delete` 这类别的写操作，守卫既不弹窗也不拦，以前的 deny 规则也没有管过它们；只靠契约里“用户说了才做”那一句。
- **登录还在**：gh 和 Windows 凭据管理器里的登录都还在。代理如果在 Codex 上用包裹形式写完整地址推送，pushurl 挡不住，只剩钩子。
- **守卫出错即拦截**：`hook-config.json` 坏了或守卫本身出错时，匹配到的调用全部被拦，直到修好；检查脚本把自检失败、心跳缺失或过期报为 FAIL。Codex 上靠拒绝 JSON 拦截，C0 只实测了 root 线程调 MCP 工具这一种情况；Codex 钩子超时时怎么处理没测。
- **Codex 上守卫起不来时会放行**：便携 Node 不见、`guard.mjs` 加载出错或 shell 找不到命令时，守卫没有任何输出、退出码也不是 2，Codex 就放行（Claude 照样拦）。这是 Codex 上出错即拦截剩下的缺口，由检查脚本的命令行实测和守卫心跳发现。
- **Codex 钩子的命令写法和 matcher 没在 Codex 里跑过**：由部署冒烟（AS3-121）覆盖。Codex 钩子要单独信任，没信任的钩子不运行；检查脚本只看有没有 trusted_hash，不核对哈希。
- **Codex 规则只挡简单命令**：`git -C`、`bash -lc` 或 `powershell -Command` 包裹的命令、用 `;` 串起来的复合命令都匹配不到，只剩钩子和 pushurl 兜底。
- **间接执行能绕过守卫**：写进脚本文件再运行、Invoke-Expression、编码过的命令，守卫都看不到原命令。
- **here-doc 和 here-string 的正文不检查**：未加引号的 bash here-doc 和 PowerShell 的 `@"..."@` 里，命令替换照样会执行，守卫看不到；真正挡推送的是 `pushurl = no_push`。
- **Codex 这边没有读拦截**：客户数据目录的 Read 只靠 Claude 的 deny 规则。
- **子代理写账本的拦截依赖 agent_id**：哪个平台版本不带了，规则 3 就分不出子代理和主会话。
- **Codex 里有守卫看不到的写入工具**：`mcp__node_repl__js`、`mcp__artifact_session__js` 不在 Codex 钩子的 matcher 里；第 1 批子代理只读，所以只记为风险。
- **Codex 上的独立校验较弱**：默认是主线程自己核对，独立性弱于 Claude 的子代理；单独开 `codex exec` 时，Windows 上只读沙箱的效果没验证过。
- **验收原话的记录只能事后核对，不是身份证明**：同一账户下代理也能写这份记录。
- **测量是冒烟级**：基线和第 1 批每组各跑 1 次；长跑驱动的真实试跑也只跑了 1 次（[docs/finish-trial.md](docs/finish-trial.md)）。

---

## 目录说明

| 路径 | 作用 |
|---|---|
| `skills/project-*/` | 7 个技能（`SKILL.md`） |
| `templates/` | 共用契约 `global-AGENTS.md`、Claude 的 `global-claude-CLAUDE.md`、项目契约模板 `repo-AGENTS.md` / `repo-CLAUDE.md`、`/goal` 模板 `goal.txt` |
| `config/claude/` | Claude 的设置片段和 `agents/project-verifier.md` |
| `config/codex/` | Codex 的 `config.fragment.toml`、`hooks.json`、`rules/autoskills.rules` |
| `config/kit-local.example.json` | 本地配置的字段说明（真实值在不进 git 的 `_private/kit-local.json`） |
| `hooks/` | 守卫 `guard.mjs`、`session-start.mjs` 和 `hook-config.example.json` |
| `scripts/` | 部署、检查、pushurl、lint、bootstrap 脚本和三条命令的入口 `autoskills.mjs`；`scripts/lib/` 是共用的目标映射、TOML 定向改写、只读账本读取（`ledger-read.mjs`）、命令在项目里放文件的位置（`run-paths.mjs`），以及长跑驱动（`run/`）和验收包（`accept/`） |
| `tests/kit/` | 套件测试（node:test，夹具全部合成） |
| `mcp/project-manager/` | 账本 MCP 服务端，1.5.1，3.0 没有改它；工具清单见 [它的 README](mcp/project-manager/README.md)，版本记录见 [CHANGELOG](mcp/project-manager/CHANGELOG.md) |
| `mcp-manifest.json` | MCP 注册的单一真源，bootstrap 读它 |
| `docs/deploy.md` | 部署、冒烟、回滚和恢复 |
| `docs/run.md`、`docs/accept.md`、`docs/manual-parallel.md` | 长跑驱动、验收包、手动并行的用法 |
| `docs/finish-trial.md` | 长跑驱动在测试仓库上的一次真实试跑：每个任务的 token 和用时，和 2026-11-01 的数的对比 |
| `docs/windows/finish/` | 收尾这一批用三个手动窗口做时的约定、三份窗口说明、探查记录和实测结果，可以当手动并行的例子看 |
| `docs/adr-006-*.md` | 第 1 批的设计决定、不做的事和残余风险 |
| `docs/adr-009-*.md` | 收尾的设计决定、不做的事和残余风险 |
| `docs/adr-001..005-*.md` 和各份报告 | project-manager 1.1–1.5 和旧套件时期的历史记录，按当时的状态理解 |
| `_private/`（不进 git） | 本机的运行区（便携 Node、已部署的钩子、心跳）、部署记录和备份、本地配置、测量数据 |

---

## 文档索引

| 想知道 | 看哪 |
|---|---|
| 怎么装、怎么回滚、钩子坏了怎么恢复 | [docs/deploy.md](docs/deploy.md)、[docs/bootstrap.md](docs/bootstrap.md) |
| 长跑驱动怎么起、怎么停、报告怎么看 | [docs/run.md](docs/run.md) |
| 验收包长什么样 | [docs/accept.md](docs/accept.md) |
| 几个窗口同时做 | [docs/manual-parallel.md](docs/manual-parallel.md)，例子在 [docs/windows/finish/](docs/windows/finish/README.md) |
| 推送的确认窗量过什么、哪些没人看过 | [docs/push-consent-probe.md](docs/push-consent-probe.md) |
| “起长跑”这句话在真实会话里的表现 | [docs/run-from-session-probe.md](docs/run-from-session-probe.md) |
| 长跑驱动花多少 token 和钱 | [docs/finish-trial.md](docs/finish-trial.md) |
| 为什么这么设计、哪些不做 | [ADR-006](docs/adr-006-autoskills-3-batch1-serial-kit.md)、[ADR-009](docs/adr-009-autoskills-3-finish.md) |
| 账本有哪些工具 | [mcp/project-manager/README.md](mcp/project-manager/README.md) |
| 每个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |
