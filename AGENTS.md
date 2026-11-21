# 项目契约：AutoSkills

> 只写本项目特有的规则。通用规则在用户级的自主契约（`~/.claude/AGENTS.md`、`~/.codex/AGENTS.md`），这里不复制。
> 由 project-plan 按 AutoSkills 的 `templates/repo-AGENTS.md` 生成；项目级设计经用户确认后，本文件即"已确认的项目契约"。

## 项目
- 主检出：本仓库根目录（主检出，不是 worktree）
- 目标：维护 AutoSkills 3.0。3.0 在 2026-11-19 收尾，2026-11-20 负责人验收通过（AS3-372）：第 1 批的串行套件（2026-11-01 部署）加上长跑驱动（`scripts/autoskills.mjs run`）、验收包（`scripts/autoskills.mjs accept`）和手动并行的技能文字，本地标签 `v3.0`。设计决定在 ADR-006 和 ADR-009；完工标准 5 条和原来 8 条最终效果的状态在账本的 PRD 里。3.0 之后的小项“一句话起长跑”（AS3-373 到 AS3-375）2026-11-20 部署并验收通过：负责人在会话里说一句“起长跑”，主控在新窗口里起长跑驱动，驱动还在跑的时候自己只读；只改了技能文字，范围、假设和负责人本人那一次试跑的记录在 PRD 最后一节。另一个小项“推送要负责人点同意”（AS3-378 到 AS3-381）2026-11-21 部署并验收通过：守卫见到 `git push` 不再一律拒绝，在 Claude 上弹出确认，负责人点了才推；发布、gh 的写操作和对外发送照旧不做，`pushurl = no_push` 留着，Codex 照旧全拦。范围、假设和当时哪些权限模式弹窗在 PRD 里。再一个小项“推送在所有权限模式下都弹窗”（AS3-382 到 AS3-384，负责人 2026-11-21 定）同一天部署并验收通过：守卫回询问的权限模式扩到 Claude Code 的全部六种（加上 auto 和 dontAsk），长跑驱动起的会话带标记 `AUTOSKILLS_UNATTENDED=1`，守卫见到就拒绝推送。合并提交是 bbb26e1；范围、假设和没有量过的地方在 PRD 最后一节。现在没有进行中的任务。之后要做新的事，先用 project-plan 立项，再改这一节。
- 已存档：P0 和第 2 批（账本 2.0、runner、自动并行）在分支 `p0` 和 `as3-359`，本地标签 `p0-archive-2026-11-19`、`as3-359-archive-2026-11-19`。worktree `.autoskills/dev/p0` 留着，不在上面开发。
- 非目标（没有新的项目级设计确认之前）：自动并行、账本 2.0、runner 的任何后续；账本迁移和发布窗口；Codex 上的长跑驱动；把命令部署到用户级；守卫钩子的新规则；账本 1.5.1 的修改；换别的工作流层；改别的项目的说明文件；系统 Node、PATH 和用户的持久环境变量。

## 边界
- 只读目录：_private/eval/smoke/readonly-canary、_private/eval/smoke/customer-canary、_private/backup-2026-10-30、_private/backup-2026-11-01-pre-batch1（第 7 题）。
- 不得访问的数据目录：_private/eval/smoke/customer-canary。
- 不复制凭据文件。

## 验证
- 默认验证命令：任务里的 verification_commands，在干活的那个检出的根目录跑。脚本和测试按自身文件位置找仓库里的文件，不按当前目录。
- 不用匹配不到文件也退出 0 的通配（`node --test` 的通配就是这样）；测试文件一律写全名。
- 验证的轻重由每次规划定。3.0 收尾这一批定的是从轻（负责人 2026-11-19；ADR-009 §2.15）。
- 跑 `tests/kit/check-kit.test.mjs` 之前把 Codex 彻底退出：它的后台进程开着时，这个文件一加载就读真实的 `~/.codex/tmp`，碰到被占用的锁文件就退出 1。跑它的时候也不能有别的 Claude Code 会话或窗口开着（负责人 2026-11-21 定）：它里面 “the fixtures, the real Codex temp folder and the real settings files are unchanged” 那一条核对真实的 `~/.claude/settings.json`，别的进程一写这个文件就失败。
- kit 测试（`tests/kit`）用 Bash 工具（Git Bash）跑，PATH 上第一个 bash 不能是 WSL 启动器。`deploy-kit.test.mjs` 只在主检出、并且没有别的会话或窗口在调工具时跑：它要用 `_private` 里的恢复工具（worktree 里没有）；别的会话一调工具，它里面 “the real user directory targets, the real runtime and the .git/config of the real repos are unchanged” 那一条就会失败。
- worktree 里没有私有词表，那里的 lint 只用内置的 privacy 规则。从 `_private` 搬进仓库的文件和新写的文档，在主检出里跑 `node scripts/lint-kit.mjs --check privacy --path <文件>`（路径可以指到 worktree 里的文件），这样才带词表。
- 真实会话（探查、试跑）只在 `_private/eval` 的一次性测试仓库里起，用的是用户级现在的套件。起真实 claude 会话的脚本从 PowerShell 启动，不从 Git Bash 启动。

## 验收
- 用户本人验收点：现在没有。3.0 的完工验收 AS3-372 和一句话起长跑的验收 AS3-375 在 2026-11-20 通过，推送要点同意的验收 AS3-381 和所有权限模式都弹窗的验收 AS3-384 在 2026-11-21 通过。
- 待验收不挡下游：否。

## 其他约定
- `_private/` 不进 git（`.git/info/exclude`）。只改 `_private` 的任务，在账本写"未提交（_private 不进 git）"和改动文件的 sha256。
- main 是已部署的状态。开发在分支上做，worktree 放在 `.autoskills/dev/<分支名>`，做完合回 main。收尾用过的分支 `finish`、`finish-a`、`finish-b`、`finish-t` 和一句话起长跑用过的 `run-from-session` 都已合进 main，分支和 worktree 在 2026-11-20 按负责人的话删了；推送两个小项用过的 `push-consent`、`push-all-modes` 在 2026-11-21 同样合并后删了。
- 手动并行的做法在 `docs/manual-parallel.md`；收尾这一批的窗口说明和实测在 `docs/windows/finish/`。
- 只有主控写账本，同一时间只有一个会话当主控。长跑驱动在本仓库上跑着的时候，别的会话不记账。
- 部署只由负责人在普通终端、在主检出里执行。会话不跑 deploy-kit 的 --apply、--rollback、--neutral，不改用户级。
- worktree 里不放 junction 或 symlink，尤其不要把 `_private` 链进 worktree（`git worktree remove` 会顺着 junction 清空目标）。
- 账本用 1.5.1，不迁移。
- 仓库已有 git 标签 v1.5.1、v2.0（旧套件）、v3.0 和 v3.1.0，新标签不得重名。标签只打本地，不推送。
- 文档和面向负责人的文字用中文；代码和注释沿用仓库现有的英文。
