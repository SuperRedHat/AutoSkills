---
name: project-next
description: 按自主契约循环做任务：取就绪任务、实现、验证、提交、记录，再取下一个，直到五种停点之一。用户说"做下一个任务""做 T3.1–T3.5""把剩下的做完"或点名任务、范围时使用。
---

# /project-next — 循环做到停点

循环、停点、证据和提交规则以自主契约为准，这里只写在 project-manager 1.5.1 上的具体做法。不要做完一个任务就结束回合。

## 开始
1. 用主检出的绝对路径调 `set_project_dir`，再用 `get_server_info` 核对 state_files。没有账本时，1.5.1 会返回"run /project-init""Run /project-design first"这类提示：这些已过时，一律改用 project-plan。 <!-- lint-kit: allow-legacy 原样引用 1.5.1 返回的过时提示，紧接着说明改用 project-plan -->
2. 读项目契约（仓库根目录的 AGENTS.md），记下范围、验证命令、本人验收点和"待验收不挡下游"一项。
3. 用户点名了任务或范围，就只在范围内做；范围外的任务一个也不碰。给了截止时间，用命令看一次当前时间。
4. 范围内已有 in_progress 的任务，先接着做它（1.5.1 不允许 in_progress→todo）；notes 里写着"受阻"的，阻塞没解除就跳过。

## 循环（每个任务）

### 1. 取就绪任务
- 不点名、项目契约也没写"待验收不挡下游"时：用 `get_next_task`。
- 点名任务或范围时：用 `get_all_tasks`，按与 `get_next_task` 相同的规则自己筛选，只在范围内取：
  - 状态是 todo；
  - 每个依赖都满足：依赖是 done，或是 superseded 且沿 replacement_task_id 链最终落到 done；cancelled 的依赖不满足；
  - 多个就绪时，priority 大的先做，相同时按创建顺序。
- 项目契约明确写了"待验收不挡下游：是"（写了适用任务的，只对这些任务）时，依赖处于 awaiting_manual_acceptance 且 stage_gate=false 的也算满足。`get_next_task` 不认这条，这时一律用 `get_all_tasks` 按上面的规则自己判断。契约没写明，就按 `get_next_task` 的规则。
- 取不到就绪任务时，用 `get_all_tasks` 看剩下的任务卡在哪，再按下面的停点判断；没有就绪任务本身不等于做完。

### 2. 开始并实现
- `update_task_status(id, "in_progress")`，然后按任务的描述、验收标准和 files 实现。
- 常规选择用合理默认并在 notes 里记下假设；不为单个任务、提交或步骤交接请求确认。

### 3. 验证（证据）
- 在仓库根目录逐条照原样执行 verification_commands，不改写、不拼接、不跳过。条目是 PowerShell 写法时，Claude 上用 PowerShell 工具执行。
- 每条都打印：命令、退出码、日志位置。长输出写到 `<项目>/.autoskills/runs/`；第一次使用时把 `.autoskills/` 加进 `.git/info/exclude`。
- 再逐条核对验收标准：命令覆盖不到的，自己读 diff 或运行交付物确认。
- 失败就修，修完从第一条起重跑。同一根因连续两次没有实质进展，按"受阻"处理（见下）。
- 重型套件只由主会话跑，一次一个；子代理只做只读工作，它的报告只算线索，记完成前主会话自己重跑验证命令。

### 4. 独立校验（只对有风险的任务）
- 触发条件：review_checklist 第一条写"风险：高"，或 stage_gate=true。其余任务跳过这一步。
- 在改成 auto_verified 之前交给只读校验者。只给原始标准和证据：任务描述、验收标准、review_checklist、diff、本会话的命令输出和日志位置；不给实现总结，也不说"已经通过"。
- Claude：用 project-verifier 子代理。
- Codex：主线程按同样的输入只读核对 diff 和命令输出，不靠自己的实现记忆；需要单独进程时，用桌面版安装目录里自带的 codex.exe 跑只读的 `codex exec`，结论文件由主线程导入账本。
- 结论用 `add_log` 记下：违反哪条标准、怎么复现、实际影响，分 blocker、major、minor。
- blocker 和 major 判失败：修复，重跑第 3 步，再校验；最多修 2 轮，仍不过就按"受阻"处理。minor 记下，便宜的顺手修，不自动建新任务。

### 5. 提交
- Conventional Commits，说明里带任务 id，例如 `feat(api): add export endpoint (T3.2)`。
- 只 `git add` 本任务 files 里列出的、在仓库里的路径（括号里的说明不是路径；标了删除的路径照样 add，用来暂存删除）。不用 -A，不用 `.`，也不用 -f。
- 提交号用 `git rev-parse HEAD` 读出，写进 notes 或 `add_log`。只改了 `_private/` 等不进 git 的路径时，在 notes 写"未提交：<原因>"。

### 6. 推进状态，取下一个
- `update_task_status(id, "auto_verified")`，然后按验收字段：
  - acceptance_mode=auto，或 milestone_manual 且 stage_gate=false：改成 done；
  - acceptance_mode=manual，或 milestone_manual 且 stage_gate=true：改成 awaiting_manual_acceptance，把 review_checklist 和证据位置列给用户。
- 只用这些迁移：todo→in_progress→auto_verified→done 或 awaiting_manual_acceptance。awaiting_manual_acceptance 之后只交给 project-feedback 处理用户本人的验收，这里不改它。
- 等用户验收的任务不挡别的任务：回到第 1 步取下一个。
- 给了截止时间时，每做完一个任务用命令看一次当前时间；来不及做完的不开始。

## 受阻
- 1.5.1 没有 blocked 状态：任务保持 in_progress，用 `edit_task` 在 notes 写"受阻：<原因、已试过什么、需要什么>"，并 `add_log`。
- 然后继续做不受它影响的任务，不在这里结束回合。

## 停点（只有这五种）
1. 本轮做完：范围内的任务都已 done。
2. 只剩用户本人能定的事：没有就绪任务，剩下的任务要么在等用户验收，要么依赖还在等验收的任务，要么在等项目级决定。
3. 真的卡住：没有就绪任务，剩下的都受阻并已记录，或依赖被 cancelled。
4. 预算或截止时间到。
5. 用户说暂停，或控制器、账本出错。

停下时说明是哪一种，列出每个任务的状态、提交号（从 git 读出）、验证命令和退出码，以及需要用户做的决定。不是这五种之一，就回到第 1 步继续。
