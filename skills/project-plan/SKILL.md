---
name: project-plan
description: 项目级规划：目标、非目标、验收标准、本人验收点、风险等级和任务拆分；新项目顺带写 PRD、架构和项目契约，需求变更时评估影响并改任务；最后输出一段能直接粘贴的 /goal。用户说"规划""立项""拆任务""需求变了""改计划"，或项目还没有账本时使用。
---

# /project-plan — 项目级规划

整个技能只在一处停下来：项目级设计请用户确认（契约规定这件事由用户处理）。确认后落盘、写项目契约、输出 /goal，都不再请求确认。循环、停点和证据规则以自主契约为准，这里只写在 project-manager 1.5.1 上的具体做法。小项目一页就够。

## 1. 开始
- 用主检出的绝对路径调 `set_project_dir`，再用 `get_server_info` 核对 state_files。没有账本时，1.5.1 的 `set_project_dir` 返回"run /project-init to create"，`get_project_info` 和 `get_prd` 返回"Run /project-init first"，`get_architecture` 返回"Run /project-design first"：这些提示已过时，一律由 project-plan 处理。 <!-- lint-kit: allow-legacy 原样引用 1.5.1 返回的过时提示，紧接着说明由 project-plan 处理 -->
- 项目目录还没定时，只在对话里起草：不调写账本的工具，也不在项目里写文件。
- 读已有的：`get_project_context`（需要全文时用 `get_prd`、`get_architecture`、`get_all_tasks`），仓库根目录的 AGENTS.md、CLAUDE.md、README 和代码结构。
- 分三种情况：
  - 新项目（没有账本，或账本里没有任务）：第 2–4 步，再第 6 步。
  - 需求变更（已有任务，用户要加、改或去掉需求）：第 5 步，再第 6 步。
  - 规划已确认，只差 /goal：直接第 6 步。

## 2. 起草项目级设计（一页）
- 目标（一句话）、非目标、验收标准、用户本人验收点（视觉、实物或里程碑；没有写"无"）、本轮范围和停点；用户给了预算或截止时间，一并写上。
- 不清楚的地方用合理默认，作为"假设"列在页尾。只有用户能提供的信息，集中列成问题，和设计确认一起问，不分几次问。
- 需要时写架构：技术选型（每项给备选和理由）、目录和模块职责、接口和数据模型。没有值得记的选型和边界就不写。
- 任务拆分：字段按第 3 步。每个任务交付一个能打开或能运行的产物，能单独验证、单独提交。
  - 粒度：默认串行。一个任务是一个模块或目录级的、能独立验证的交付，不拆成零碎的小步；改接口、数据格式或安全的改动单独成任务，哪怕很小。
  - 本人验收点：同一个阶段要用户看的东西（界面、手册、演示）合成一个验收任务，放在阶段边界，单独成任务。这不减少要用户看的东西：视觉和实物仍由用户验收；用截图基线做回归的，基线先由用户认一次。
  - 并行：只在用户点名某个阶段并行时用。拆成契约任务（共用的接口、类型、目录骨架，串行先做）、几个块任务（各自的目录、各自的验证命令、各自一份窗口说明文件，互不改同一批文件）和联调任务（串行后做）。做法见套件仓库（AutoSkills）的 `docs/manual-parallel.md`，记账和收窗口见 project-next。
- 项目契约草稿：读部署后的模板 `~/.workflow-core/templates/repo-AGENTS.md` 和 `~/.workflow-core/templates/repo-CLAUDE.md`，逐项填模板里的占位。不抄自主契约的通用规则，技能里也不另存一份模板。仓库里已有 AGENTS.md 或 CLAUDE.md 时不覆盖：原有内容保留，列出要补的项；要删的条目一并请用户确认。
- 把这一页展示给用户确认，任务列成表（id、标题、依赖、风险、验收模式、验证命令）。这是唯一一次停下来等确认；用户回"按推荐"，就按页上的推荐和假设定下。

## 3. 任务字段（create_tasks 的 schema）
- 必填：id、title、description、dependencies、complexity（S/M/L）、acceptance_criteria、files、module、needs_manual_review（acceptance_mode 不是 auto 时为 true，否则为 false）。
- 另填：
  - acceptance_mode：auto、manual 或 milestone_manual。milestone_manual 只有配 stage_gate=true 时才需要人工验收；stage_gate=false 时和 auto 一样直接完成。
  - verification_profile：先调 `get_verification_profiles` 取合法名字，只用其中的；没有贴切的就选最接近的，具体做法写在 verification_commands 里。
  - verification_commands：从仓库根目录在 Windows PowerShell 5.1 里能直接跑，一条一个命令；不用 &&，不依赖 pwsh。交付物缺失或出错时命令必须返回非零（通配一个文件都匹配不到却照样退出 0 的写法不能用）。
  - review_checklist：第一条固定写"风险：<高|中|低>；改用户级文件：<是|否>"，后面写命令覆盖不到、要人看的检查项。
  - stage_gate：阶段收口、里程碑演示、用户本人验收后下游才能开始的任务为 true。
  - priority：数字，越大越先做；同分按创建顺序。
- 风险等级：改门禁、接口、数据格式或安全相关的，删数据的，不好回滚的为"高"；文档或局部小改为"低"；其余为"中"。project-next 据第一条决定要不要做独立校验：风险为高或 stage_gate=true 的任务要做。
- 改用户级文件（如 `~/.claude`、`~/.codex` 下的文件）的任务，acceptance_mode 用 manual 或 milestone_manual；用 milestone_manual 时配 stage_gate=true，否则不会停下等验收。
- 对应用户本人验收点（视觉、实物、里程碑）的任务，同样用 manual 或配 stage_gate=true 的 milestone_manual。
- 依赖只写真正需要的前置；能并排做的任务不互相依赖。

## 4. 确认后落盘
按顺序做，中间不再请求确认：
1. `save_prd` 存这一页；写了架构的，`save_architecture`。
2. `create_tasks` 一次写入全部任务，按依赖顺序排列。1.5.1 只查 id 是否重复，所以接着跑 `lint_state`：有悬空依赖、环或验收字段自相矛盾的，用 `edit_task` 修好再跑一次。
3. `update_project_info`：name、tech_stack，status 设为 planned。
4. 新项目：在仓库根目录按确认的草稿写 AGENTS.md 和 CLAUDE.md，只 `git add` 这两个文件并提交（如 `docs(project): add project contract`），提交号用 `git rev-parse HEAD` 读出。不是 git 仓库的，记"未提交：<原因>"。
5. `add_log` 记一条：规划已确认，逐字写下用户确认的原话、任务 id 范围和提交号。
6. 输出 /goal（第 6 步）。

## 5. 需求变更
- 列出受影响的目标、验收标准、任务、文件和依赖。
- 受限修改：不降验收模式、不删本人验收点、不去掉必要依赖、不缩小已确认的范围，除非有用户本人的验收记录（原话逐字记在账本里）。
- 变更触及已确认的项目级设计（目标、非目标、验收标准、本人验收点），或要做没有验收记录的受限修改时，改好那一页，连同选项和影响回第 2 步请用户确认，不受影响的改动照做；在已确认范围内的，直接改，改完汇报。
- 账本操作：
  - 新任务：`create_tasks`，字段按第 3 步。
  - 改任务：`edit_task`、`edit_tasks`。它们不碰状态；改 acceptance_mode 会同步 needs_manual_review；终态任务只能改纯文档字段。改优先级用 `set_task_priority`。
  - 被新任务取代：先建新任务，再 `close_task(id, "superseded", reason, replacement_task_id)`，下游依赖会自动改指到新任务。单纯作废用 `close_task(id, "cancelled", reason)`；作废已确认的任务等于缩小范围，按受限修改处理。
  - 已完成的任务要返工：新建任务，不改原任务。
- 文档跟着改：`save_prd`、`save_architecture`；项目契约的内容变了，一并改 AGENTS.md 并提交。
- `add_log(type="decision", ...)` 记下改了什么、为什么；entities 写成对象，如 `{"tasks": ["T3.2"]}`（传数组会被拒）。最后跑一次 `lint_state`。

## 6. 输出 /goal
- 读 `~/.workflow-core/templates/goal.txt`（AutoSkills 的 `templates/goal.txt` 部署到这里），只替换尖括号里的占位：项目、里程碑或任务范围（如 T3.1–T3.5）、一句话目标、停止条件里的验收标准。其余各行逐字保留，不增、不删、不改写。读不到这个文件就如实说明，不凭记忆写。
- 放在回复最后的一个代码块里，能直接粘贴：Codex 上直接粘贴；Claude 上需要长跑时用。
- 用户在本轮已经要求接着做的，输出 /goal 后直接进入 project-next 的循环，不等粘贴。
