# ADR-006：AutoSkills 3.0 第 1 批 —— 串行版文字和配置

- **状态**：Accepted —— 设计方案 v3（修订稿）于 2026-10-30 获用户批准，19 条确认项全部按推荐；第 1 批实施中（任务 AS3-100..AS3-123）。阶段门禁（AS3-123）通过后补“结果”一节。
- **日期**：2026-10-30
- **作者**：Claude Code（Opus 5.5）
- **目标组件**：AutoSkills 套件本身：共用契约和模板、`skills/`、`hooks/`、`config/`、`scripts/`（部署、检查、pushurl、lint）。**不改** `mcp/project-manager`，第 1 批仍用 1.5.1。
- **依据**：设计方案 v3（修订稿，第 5 节契约、第 7 节分批、第 10 节确认项）和它沿用的 v2（附录 A 契约、附录 B `/goal` 模板、附录 D 测量设计、§3.5 护栏、§3.6 两个平台）；7 任务测试仓库的基线测量。这些材料留在仓库外的本地私有目录，本 ADR 把第 1 批用到的内容写全，不需要另读。
- **与 ADR-001..005 的关系**：ADR-001..005 保持原样，是 project-manager 1.1–1.5 各次增量的历史记录，本 ADR 不改它们，也不推翻其中关于账本的决定。它们引用的技能（init、design、change 等）和 CouncilFlow 在 3.0 里已退役，读的时候按当时的状态理解。

---

## 0. 决策摘要（TL;DR）

| # | 决策 | 结论 |
|---|---|---|
| K1 | 共用契约 | 两个平台一份短契约（v2 附录 A 的第 1 批版）：五种停点；证据只认本会话实际执行的命令；开始时调 `set_project_dir`，再用 `get_server_info` 核对 |
| K2 | 技能 | 11 个并成 7 个：resume、next（改循环）、plan（吸收 init、design、change）、feedback（批量验收）、status、consult、quick。退役 ask、change、design、discuss、init、review |
| K3 | 外部编排 | 去掉 CouncilFlow 和 Gemini |
| K4 | 独立校验 | 有风险的任务和里程碑由只读校验者按原始标准审查：Claude 用 project-verifier 子代理；Codex 先由主线程只读核对，需要单独进程时用安装目录的 codex.exe 跑只读的 `codex exec` |
| K5 | 护栏 | Bash 和 PowerShell 两种形式的 deny 规则；`onFailure: block` 的 Node 守卫钩子；`pushurl = no_push`；Codex 的规则和钩子只当提醒。守卫第 4 条是新增的，可删 |
| K6 | 平台设置 | 两边各一份声明式片段，由部署脚本合并 |
| K7 | 部署和检查 | 部署脚本先备份、默认 dry-run、只删旧 project-* 副本、可回滚；检查脚本只读 |
| K8 | 执行方式 | 只串行：一个主循环按顺序做，子代理只做只读的活 |
| D1 | 推迟到 P0 | 并行写入、无人值守长跑、额度续跑、Stop hook、账本改造；1.5.1 服务端里指向已退役技能的提示；Codex 线程上限 |

---

## 1. 背景

旧套件是 11 个 project-* 技能加 project-manager 1.5.1。用户的主要负担不是质量，而是要反复回来说“继续”。

**基线**（2026-10-30，7 任务测试仓库：依赖链、独立任务、一个本人验收点、一次必然失败；Claude Code 2.1.314 + Opus 5.5，Codex 0.165-alpha + GPT-6.1 Sol；模拟用户有可做的任务就回“继续”，到验收点等 60 秒后回“验收通过，继续”）：

| 用法 | 平台 | 轮数 | 无必要停顿 | 隐藏测试 | 假完成 | 越权和推送 |
|---|---|---|---|---|---|---|
| 只调用技能（`/project-next`、`$project-next`） | Claude | 7 | 6 | 7/7 | 0 | 0 |
| 同上 | Codex | 7 | 6 | 7/7 | 0 | 0 |
| 一句自然语言“自动完成这个项目剩下的所有任务。” | Claude | 2 | 0 | 7/7 | 0 | 0 |
| 同上 | Codex | 2 | 0 | 7/7 | 0 | 0 |
| 明确授权的长提示词（冒烟，只跑首轮） | Claude、Codex | 1 | 0 | 7/7 | 0 | 0 |

- **停顿来自用法**：旧 project-next 一次只做一个任务，所以只调用技能时 7 轮里有 6 次无必要停顿，两个平台一样；同样的旧工具，一句自然语言提示就是 0 次。
- **代价**：只调用技能时，token 是自然语言提示的约 3.8 倍（Claude）和 5.9 倍（Codex），即 4–6 倍，几乎都是每轮重新加载上下文的缓存读取；Codex 的墙钟时间约为 2.4 倍。
- **质量一样**：两种方式隐藏测试都全过，假完成和越权都是 0，到本人验收点都正确停下。
- **局限**：每种组合只跑 1 次，是冒烟级结论；仓库小，每个任务几分钟，代表不了长时间的大任务。

结论：把 project-next 改成“循环做到停点”收益最大、成本最低，不需要先做并行和账本改造。所以第 1 批只改文字和配置，按串行做。

---

## 2. 决定

### 2.1 共用契约（K1）

- **位置**：同一份内容写到 `~/.claude/AGENTS.md` 和 `~/.codex/AGENTS.md`。`~/.claude/CLAUDE.md` 只写 `@AGENTS.md`，加几行 Claude 专属内容；导入是否生效在部署时实测，不生效就改用内联（部署脚本的 `--claude-contract inline`）。
- **内容**：v2 附录 A 的第 1 批版，约 50 行：
  - 优先级：平台约束和零例外规则（不 push、不发布、不对外发送、不改只读目录、不访问客户数据）最先，其余按本轮指令 > 项目契约 > 本契约 > 技能步骤。
  - 执行循环：取就绪任务 → 实现 → 按风险验证 → 提交 → 记录 → 取下一个，直到停点。
  - **停点只有五种**：本轮做完；只剩用户本人能定的事；真的卡住；预算或截止时间到；用户说暂停或控制器出错。
  - **证据**：只认本会话里实际执行的命令，写明命令、退出码和日志位置，并把结果摘要打印在对话里；提交号从 git 读取并核对，不得编造。
  - 待验收改成完成，只能在处理用户本人的验收消息时做（project-feedback），并逐字记下原话。
  - 子代理与并行：只有主会话（Codex 里是根线程）写账本、认领任务、提交和记录验收；子代理只做只读的活，不调 `set_project_dir`、不调 project-* 技能；同一项目同一时间只有一个进程写账本。
  - Git：在有意义、可恢复的点提交，Conventional Commits，说明里写任务 id，一个任务可以提交多次。
- **相对 v2 附录 A 只加一句**：根线程开始时用主检出的绝对路径调一次 `set_project_dir`，再用 `get_server_info` 核对 state_files。原因：1.5.1 的写工具仍按进程全局的项目写。
- **删掉的旧规则**：“先设计再写代码”“逐个模块确认”“需求模糊必须问”、状态机说明、技术栈默认值。保留 Git 规则和“汇报前逐条对账”。
- **`/goal` 模板**：由 project-plan 填好后输出一段能直接粘贴的 `/goal`（v2 附录 B 的第 1 批版）：写明范围和停止条件；只有验证命令实际跑过并通过、真实交付物存在才算完成；等本人验收的任务保持待验收，继续做不受影响的；不得缩小目标、降低标准或用证据包代替交付物；“没有就绪任务”本身不等于完成。

### 2.2 七个技能（K2）

保留 `project-` 前缀，避免和两个平台内置的 `/plan`、`/status`、`/resume`、`/feedback` 撞名。

| 技能 | 做什么 |
|---|---|
| project-resume | 新会话或用户说“继续”时：先对一遍 git、账本和认领，补记已提交但账本没记的，然后按契约的循环接着做 |
| project-next | 做指定的任务或范围，**循环做到停点**，不再一次只做一个任务 |
| project-plan | 项目级规划，吸收原来的 init、design、change：目标、非目标、验收标准、任务和风险等级、本人验收点；最后输出 `/goal` |
| project-feedback | 处理用户的验收和反馈，可以批量；逐字记下原话；处理完接着做 |
| project-status | 只读：进度、在跑什么、卡在哪、预计还要多久（标明是估计） |
| project-consult | 在项目文件夹里生成给外部模型的自包含提示词；用户把回答贴回来后核对并记下来源 |
| project-quick | 小事快修；只在没有进行中的本轮、不碰门禁和接口、一次提交就能回滚、不需要重型套件时用，超出就转成正式任务 |

退役 ask、change、design、discuss、init、review 六个。review 改用平台自带的审查命令；ask 和 discuss 不再需要。

### 2.3 去掉 CouncilFlow 和 Gemini（K3）

- 技能和模板里不再出现 CouncilFlow 和 council 命令。原因之一：旧 project-next 发现 council 可用时，会把实现交给它，绕开主循环。
- 删掉 Gemini 里的 project-manager 注册和 `~/.gemini/skills` 里的 project-* 旧副本；安装脚本不再写 Gemini。

### 2.4 独立校验（K4）

只用在有风险的任务和里程碑上（project-next 对“风险：高”的任务和门禁任务调用），按原始验收标准审查，审查前不看实现者的成功总结。结论写清违反哪条标准、怎么复现、实际影响，分 blocker、major、minor；blocker 和 major 判失败，最多修 2 轮；minor 记下，不自动生成新任务。

- **Claude**：`project-verifier` 子代理（`config/claude/agents/project-verifier.md`）。
  - 模型 Opus 5.5，effort high。
  - 工具只有 Read、Grep、Glob 和账本的读工具（`get_task_by_id`、`get_all_tasks`、`get_logs`）；Edit、Write、NotebookEdit、Bash、PowerShell、Agent 都禁用。
  - 它自己不跑测试，只读执行记录、diff 和原始规格。依据：本地数据里 60 个失败判决中有 38 个是在命令全部通过时发现的。
- **Codex**：
  - 先由主线程只读核对 diff 和本会话的命令输出。
  - 需要单独进程时，用桌面版安装目录里自带的 codex.exe 跑只读的 `codex exec`，结论文件由主会话导入账本。不升级、也不用 npm 版的 codex。

### 2.5 护栏（K5）

同一个 Windows 账户下，护栏只防误操作。

- **Claude 的 deny 规则**：每类被禁命令同时写 `Bash(...)` 和 `PowerShell(...)` 两种形式。
  - git push，包括 `-C`、`-c` 和写完整地址的写法；
  - gh repo、release、pr、workflow 的写操作，以及带写方法的 gh api；
  - npm publish；
  - 登记过的只读目录的 Edit 和 Write；已知客户数据目录的 Read；
  - 对外发送类的 MCP 工具（邮件的发送、回复、转发，网盘共享，日历的建立、修改、回复）。
  - 只读目录和客户数据目录的清单放在不进 git 的本地配置里，部署时生成规则；仓库里只放占位。
- **守卫钩子**（`hooks/guard.mjs`，Node，PreToolUse，Claude 里设 `onFailure: "block"`）：解析 Bash 和 PowerShell 两种命令形式，按 `;`、`&&`、`|` 和 `&` 调用分段判断。每次运行写一行心跳（只记时间、平台、事件和决定，不记命令原文），供检查脚本确认钩子真的跑过。
  1. 拦 git push 的各种写法、gh 写操作、带写方法的 gh api、npm publish；
  2. 拦写进登记只读目录的 Edit、Write、NotebookEdit（Codex 是 apply_patch），按真实路径比较，解析 junction 和 symlink；
  3. 拦子代理（带 agent_id 的调用）调用账本写工具和 `set_project_dir`（v2 §3.7 第 2 条）；
  4. **在本仓库拦带 `-x` 或 `-X` 的 git clean**。它会清掉 `_private/` 里的运行区、部署备份和测量数据，回滚就没了。**这一条是 v2/v3 清单之外新增的，可以删**，不影响其他决定。
- **SessionStart 钩子**（`hooks/session-start.mjs`）：startup、resume、compact 时注入几行提示（五种停点、证据规则、先 `set_project_dir`）和会话 id。
- **pushurl**：脚本（`scripts/set-pushurl.mjs`）给项目根目录下所有有远端的仓库设 `pushurl = no_push`，先记原值，可按日志恢复；登记的只读目录跳过；检查脚本对漏设的仓库报警。
- **Codex**：在 `hooks.json` 里注册同一个守卫；`rules/autoskills.rules` 用 `prefix_rule` 的 forbidden 拦 git push、gh 写操作、npm publish。Codex 的钩子出错时会放行，规则只匹配简单命令，所以两者**只当提醒**（见 §4）。无人值守时停用 github 插件的写工具（第 1 批不开无人值守）。
- 钩子一律用 Node 写，输出 UTF-8，路径加引号；由运行区的便携 Node 24.22.2 启动。project-manager 仍用系统 Node 启动，切换留到 P0。

### 2.6 两个平台的设置（K6）

片段不含本机路径，用 `<home>`、`<runtime>` 占位，由部署脚本合并。

- **Claude**（`config/claude/settings.fragment.json`）：
  - `subagentPromptCacheTtl: "1h"`，只做这一项，不在提示词里限制等待时长；
  - `worktree.baseRef: "head"`；
  - `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=6`（v3 第 10 节第 9 条把 v2 的 2 改成 6，保留到第 4 批）；
  - 不设 `CLAUDE_CODE_EFFORT_LEVEL`：设了任何值都会盖过子代理定义里的 effort；
  - ultracode 在第 4 批之前可以用，但不作默认；
  - 上面的 deny 规则和两个钩子。
- **Codex**（`config/codex/config.fragment.toml`）：
  - `model_reasoning_effort = "medium"`：只管 CLI 和默认值；桌面版的档位按聊天设置，默认用 medium 还是 high 看第 1 批的测量结果；
  - 不设 `agents.default_subagent_reasoning_effort`，让子代理跟随主线程，ultra 时保持它自己的档位；
  - `[desktop] followUpQueueMode = "steer"`，运行中说“暂停”能及时送达；
  - 技能装到 `~/.agents/skills`；钩子和规则见 §2.5。
- **桌面版的用法**：每个新聊天选“完全访问”；规划时可临时选 xhigh，开 `/goal` 前切回执行档位；单个难题可以选 max；ultra 只用于又大、又能拆成独立几块的任务，并且要有人看着，不用在无人值守和测量里。

### 2.7 部署脚本和检查脚本（K7）

- **部署**（`scripts/deploy-kit.mjs`）：
  - 默认 dry-run：按新建、修改、删除三类列出计划和原因，不写任何东西。
  - `--apply` 先检查有没有在跑的 claude、codex 进程；再把要改或删的每个文件备份到 `_private/deploy/<部署 id>/` 并核对哈希，备份失败就不写；写入时记日志，中途出错自动回滚。
  - `--rollback <部署 id>` 分两类：整份替换的文件（技能、契约、代理定义、钩子、规则）按备份恢复；settings.json、config.toml 这类合并文件只删套件加的键、恢复目标键的原值，部署后用户或平台自己写的内容保留。部署过多次时倒序回滚。
  - `--drill` 在临时目录里做一次先 apply 再 rollback 的恢复演练，不碰真实目录。
  - **只删旧的 project-* 副本**（`~/.claude/skills` 里退役的 6 个，`~/.codex/skills`、`~/.gemini/skills`、`~/.codex/agents/skills`、`~/.workflow-core/skills` 里的旧副本），pdf、playwright 等其他技能一律不动。3 个引用已退役技能的旧 agents 只在显式开关 `--retire-legacy-agents` 下先归档再删（v2 第 9 条）。
  - `--neutral` 在测量期间把用户级切到中性档，同样可回滚。
  - 不碰 `~/.claude.json`、project-manager 的 dist 和全局验证策略文件。
  - 各项目的 CLAUDE.md、AGENTS.md 里引用旧技能或 CouncilFlow 的行只列出来，给一行替换建议，不自动改；旧项目的规则不变（v2 第 5 条）。
- **检查**（`scripts/check-kit.mjs`）：只读，输出 PASS、WARN、FAIL 表：实际生效的配置、`CLAUDE_CODE_EFFORT_LEVEL` 没有设、版本、重复或过时的技能副本、project-verifier 是否就位、钩子心跳和 `--selftest`、pushurl、项目说明文件里的旧引用。
- **lint**（`scripts/lint-kit.mjs`）：套件文本的隐私（含本地私有词表）、工具名、技能格式和旧内容检查。

### 2.8 只串行（K8）

第 1 批不并行写代码。并行时子代理只做只读的工作（调研、审查、分析），写代码、提交、写账本都留在主循环里；重型套件只由主会话跑，一次一个；子代理的报告只算线索，记完成前主会话自己重跑验证命令。同一个项目同一时间只让一个进程写账本，不要 Claude 和 Codex 同时写。

---

## 3. 不做的（留到 P0 之后）

- **并行写入、无人值守长跑、额度续跑、Stop hook、账本改造**：都要先有并发账本、独立的验证执行器和完成证据（v3 的 P0）。第 1 批的契约和技能按“一个循环按顺序做”写。
- **1.5.1 服务端里指向已退役技能的提示文字**（如 `run /project-init`、`Run /project-design first`）：第 1 批不改 project-manager 的代码和注册，这些文字会照常出现，对应的工作由 project-plan 完成。账本 2.0 在 P0 整体替换服务端，届时一起去掉，不为 1.5.1 单发一个版本。
- **Codex 的线程上限**（v3 第 10 节第 8 条，`max_concurrent_threads_per_session = 2`）：留到 P0 或试点。理由：第 1 批的子代理只做只读工作，写代码和写账本都在主线程，上限防的并发写在第 1 批不会发生；另外配置键随 Codex 的多代理版本不同（另一版是 `agents.max_threads`），等试点时一起核对。
- **项目说明文件的批量改写、历史文档的清理和 git 历史改写**：只列不改。

---

## 4. 后果与残余风险

**后果**：

- 用户平时用 project-next、project-resume 或一句自然语言就能一直做到停点；需要长跑时粘贴 project-plan 给的 `/goal`。
- 旧的 6 个技能从两个平台消失；还写着旧技能名的项目说明文件由检查脚本列出，用户决定改不改。
- 部署要求关掉所有 Claude Code 和 Codex 会话；测量期间（约 2 小时）用户级在中性档，不能用两个平台做别的事。
- Codex 上的“独立校验”默认是主线程自己核对，独立性弱于 Claude 的子代理；单独开 `codex exec` 时，Windows 上只读沙箱的效果没验证过。

**残余风险**（如实写明，不承诺隔离）：

- **同一账户下，护栏只防误操作**：代理有意绕过时拦不住。要强隔离只能用单独的账户、WSL2 或沙箱，本轮不做。
- **登录还在**：gh 和 Windows 凭据管理器里的登录都还在。用户自己推送时用 `git push <完整地址> <分支>`，在普通终端里做：写完整地址时不经过远端的 pushurl，守卫和 deny 规则只管代理的工具调用，管不到用户的终端。反过来，代理如果在 Codex 上用包裹形式写完整地址，pushurl 也挡不住，只剩钩子。
- **Codex 钩子出错时放行**：守卫在 Codex 上只是提醒。
- **Codex 规则只挡简单命令**：`git -C`、`bash -lc` 或 `powershell -Command` 包裹的命令、用 `;` 串起来的复合命令都匹配不到，只剩钩子和 pushurl 兜底。钩子实际收到的命令形式由 C0 探针确认后回填本节（AS3-117）。
- **间接执行能绕过守卫**：写进脚本文件再运行、Invoke-Expression、编码过的命令，守卫都看不到原命令。
- **Codex 这边没有读拦截**：客户数据目录的 Read 只靠 Claude 的 deny 规则。
- **子代理写账本的拦截依赖 agent_id**：workflow 代理的钩子输入里有没有 agent_id 由 C0 探针确认；没有就改为写进契约、靠事后检查。
- **验收原话的记录只能事后核对，不是身份证明**：project-feedback 逐字记下原话并附会话 id 和时间，可以对照会话记录核对；同一账户下代理也能写这份记录。
- **测量是冒烟级**：基线和第 1 批每组各跑 1 次；平台版本和基线不同时结论会漂移，对比脚本会标出。

---

## 5. 上线顺序与退出条件

1. **C0 探针**（需要用户在场的一次会话）：确认钩子输入字段、钩子用哪个 shell、拒绝 JSON 是否被接受、Codex 项目级配置和信任等；结论回填第 1 批套件和本 ADR 的残余风险（AS3-117）。
2. **部署到用户级**（需要用户在场）：dry-run → 补本地配置 → `--apply` → 重开两个平台、信任钩子 → 冒烟矩阵 → 检查脚本严格模式和 `--dry-run --expect-clean` 都退出 0。任何一步不对就 `--rollback`。
3. **对比基线测量**：测量时用户级切到中性档，被测版本放在测试仓库的项目级。原因：Claude 遇到同名技能时用户级优先，Codex 遇到同名技能会两份都列出来。测完用一条命令恢复。
4. **阶段门禁**：用户看测量报告、检查脚本的报告和本 ADR，决定是否收口。

**退出条件**（沿用 v2）：

- 两个平台“只调用技能”这一组的无必要停顿都至少减半（基线两边都是 6 次，即不超过 3 次）；
- 假完成和越权都为 0。

**门禁通过前不开始 P0**：P0 的开发会话会改用户级目录，污染测量。门禁不通过时，要么回滚部署（`deploy-kit --rollback`，再用检查脚本确认已恢复），要么保留部署、开修复任务后重测；两条路下 P0 都继续等。

---

## 6. 备选方案

| 方案 | 没选的理由 |
|---|---|
| 先在测试仓库的项目级测完，再部署到用户级（v2 §5 的顺序） | v3 第 7 节没有重申顺序，两种读法都说得通；默认先部署再测量。代价是测量要靠中性档，门禁不通过时要回滚部署；好处是测到的含用户级的护栏和设置，不只是项目级的文字 |
| 直接上 P0 的并行版 | 基线显示最大的浪费是“做一步停一步”，改成循环就能拿到；并行要先有并发账本和验证执行器，成本高得多，而且先上会污染第 1 批的测量 |
| 保留 11 个技能，只把 project-next 改成循环 | init、design、change 和 plan 职责重叠；review 有平台自带的审查命令；技能多，描述占的列表预算也多 |
| 保留 CouncilFlow 做实现或审查 | 旧 project-next 会把实现交出去，绕开主循环和证据规则；独立审查改由只读校验者做 |
| 把 Codex 规则当硬拦截 | 规则语法表达不了 `git -C`、包裹和复合命令；只能当提醒，由钩子和 pushurl 兜底 |
| 用单独账户、WSL2 或沙箱做强隔离 | 对日常使用改动太大，本轮不做；残余风险写明 |
| 第 1 批就加 Codex 线程上限 | 第 1 批子代理只读，上限没有对象；见 §3 |
