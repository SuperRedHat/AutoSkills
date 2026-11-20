---
name: project-resume
description: 在新会话里，或用户说"继续""继续项目""接着上次的做""resume"时使用。先对一遍 git 和账本，补记已提交但账本没记的，接着做卡在 in_progress 的任务，然后按自主契约的循环做到停点。
---

# /project-resume — 对账后接着做

恢复只是循环的入口：对完账就进入 project-next 的同一个循环，不停在摘要上。循环、停点和证据规则以自主契约为准。

## 1. 核对项目
- 用主检出的绝对路径调 `set_project_dir`，再用 `get_server_info` 核对 state_files。没有账本时，1.5.1 会返回"run /project-init""Run /project-design first"这类提示：这些已过时，一律改用 project-plan。 <!-- lint-kit: allow-legacy 原样引用 1.5.1 返回的过时提示，紧接着说明改用 project-plan -->
- 核对仓库、分支、worktree 和本轮目标；读项目契约（仓库根目录的 AGENTS.md）。用户给了范围、预算或截止时间，一并记下。

## 2. 对账（git 和账本）
- 先看有没有长跑在跑（和下面读 git 的命令一起查）：`<主检出>/.autoskills/run.lock` 不在，就没有。在的话，照 project-next 目录的 `long-run.md` 第 6 步的第二段核对；驱动还活着，本会话就只读：不写账本，不改工作目录，不接着做任务；告诉用户运行名和开始时间。看进度、停下它的做法也在那一页。
- 长跑停了以后第一次对账：`.autoskills/runs/` 下最新一次驱动的运行目录（名字是时间）里的 `report.md` 比账本最后一条日志新，就读一遍，把复验没过的、受阻的照实告诉用户，并用 `add_log` 记下读过的运行名。那个目录里没有 `report.md` 的，是驱动被强行结束了：把 `git status` 里留下的半截改动告诉用户。
- 驱动自己起的会话（提示词里写着"这是无人值守的运行"）不做上面两条。
- 读账本：`get_project_context`（含 in_progress_tasks 和最近日志），需要全量时用 `get_all_tasks`。
- 读 git：`git status --short`，以及说明里带任务 id 的提交（如 `git log --oneline -n 50`）。
- 有提交但账本没记的（提交说明里有任务 id，notes 和日志里都没有这个提交号），用 `add_log` 补记提交号和对应任务；状态不跟着改，证据要在本会话重新验证后才算。
- 工作区里不是本轮产生的未提交改动，不丢弃、不覆盖；记下来，和当前任务无关的就不动。
- 账本和 git 对不上又无法判断的，记下差异，按"真的卡住"处理受影响的任务，其余照做。

## 3. 接着做
- 卡在 in_progress 的任务接着做（1.5.1 不允许 in_progress→todo）：先在本会话重跑它的 verification_commands，按结果补实现或往下推进。notes 里写着"受阻"的，阻塞没解除就跳过。
- 卡在 auto_verified 的任务（会话在 auto_verified 和 done 或 awaiting_manual_acceptance 之间中断）也接着处理：在本会话重跑它的 verification_commands；通过就按验收字段推进，规则同 project-next 第 6 步；不通过按 project-next 的"受阻"处理，任务留在 auto_verified（1.5.1 不允许退回 in_progress）。
- 写 notes 前先用 `get_task_by_id` 读出原内容，把新的一段接在后面整段传入：1.5.1 的 `edit_task`、`update_task_status` 会整段覆盖 notes，不能丢掉已记的假设、受阻原因和提交号。
- 然后进入 project-next 的循环（取就绪任务 → 实现 → 验证 → 独立校验 → 提交 → 推进状态 → 取下一个），按同样的规则只在五种停点停下。
- 状态迁移只用 1.5.1 允许的：todo→in_progress→auto_verified→done 或 awaiting_manual_acceptance；awaiting_manual_acceptance 之后只交给 project-feedback。
- 子代理只做只读工作，它的报告只算线索；重型套件只由主会话跑，一次一个。

## 4. 汇报
用户只问进度时，简短回答当前在做什么、做完了什么、在等什么，然后继续。停下时按 project-next 的停点汇报：哪一种停点、每个任务的状态、提交号（从 git 读出）、验证命令和退出码、需要用户做的决定。
