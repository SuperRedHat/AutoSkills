# 项目契约：AutoSkills

> 只写本项目特有的规则。通用规则在用户级的自主契约（`~/.claude/AGENTS.md`、`~/.codex/AGENTS.md`），这里不复制。
> 由 project-plan 按 AutoSkills 的 `templates/repo-AGENTS.md` 生成；项目级设计经用户确认后，本文件即"已确认的项目契约"。

## 项目
- 主检出：本仓库根目录（主检出，不是 worktree）
- 目标：AutoSkills 3.0 收尾。在现用版（2026-11-01 部署的第 1 批，分支 main）上加三样：长跑驱动（`scripts/autoskills.mjs run`）、验收包（`scripts/autoskills.mjs accept`）、手动并行的技能文字；部署，负责人验收一次，3.0 完工。完工标准 5 条和原来 8 条最终效果的状态写在账本的 PRD 里；设计页是 `_private/redesign-2026-10/b3/finish-line-design-2026-11-19.md`，实现决定记进 ADR-009。
- 已存档：P0 和第 2 批（账本 2.0、runner、自动并行）在分支 `p0` 和 `as3-359`，本地标签 `p0-archive-2026-11-19`、`as3-359-archive-2026-11-19`。worktree `.autoskills/dev/p0` 留着，不在上面开发。
- 非目标：自动并行、账本 2.0、runner 的任何后续；账本迁移和发布窗口；Codex 上的长跑驱动；把命令部署到用户级；守卫钩子的新规则；账本 1.5.1 的修改；换别的工作流层；改别的项目的说明文件；系统 Node、PATH 和用户的持久环境变量。

## 边界
- 只读目录：_private/eval/smoke/readonly-canary、_private/eval/smoke/customer-canary、_private/backup-2026-10-30、_private/backup-2026-11-01-pre-batch1（第 7 题）。
- 不得访问的数据目录：_private/eval/smoke/customer-canary。
- 不复制凭据文件。

## 验证
- 默认验证命令：任务里的 verification_commands，在干活的那个 worktree 的根目录跑。脚本和测试按自身文件位置找仓库里的文件，不按当前目录。
- 不用匹配不到文件也退出 0 的通配（`node --test` 的通配就是这样）；测试文件一律写全名。
- 验证从轻（负责人 2026-11-19 定）：单元测试、一次真实试跑、每样一次独立审查（opus、high）。不做变异测试、证据清单和门禁程序。
- kit 测试（`tests/kit`）用 Bash 工具（Git Bash）跑，PATH 上第一个 bash 不能是 WSL 启动器。`deploy-kit.test.mjs` 只在没有别的会话或窗口在调工具时跑，否则它里面 “the real user directory targets, the real runtime and the .git/config of the real repos are unchanged” 那一条会失败；手动窗口干活期间谁都不跑它，由主控在收窗口以后跑。
- 真实会话（探查、试跑）只在 `_private/eval` 的一次性测试仓库里起，用的是用户级现在的套件。估计的额度：探查 60 到 130 万 token，试跑 400 到 600 万；单次超过上界的 1.5 倍就停下报告，不自动重跑。
- 起真实 claude 会话的脚本从 PowerShell 启动，不从 Git Bash 启动。

## 验收
- 用户本人验收点：一个，AS3-372 完工验收。
- 待验收不挡下游：否。
- 要负责人定的事集中提：无头会话的自动模式跑不顺、要换权限模式时；试跑查出的缺陷要改设计页定下的做法时；估计的额度要超时。

## 其他约定
- `_private/` 不进 git（`.git/info/exclude`）。只改 `_private` 的任务，在账本写"未提交（_private 不进 git）"和改动文件的 sha256。
- 开发在分支 `finish`（worktree `.autoskills/dev/finish`）。三个手动窗口各有分支和 worktree：`finish-a`（`.autoskills/dev/finish-a`，长跑驱动）、`finish-b`（`.autoskills/dev/finish-b`，验收包）、`finish-t`（`.autoskills/dev/finish-t`，套件文字）。main 保持第 1 批已部署的状态，直到 AS3-371 把 finish 合回来；合回来就是 3.0 的最终发布，本地标签 `v3.0`。
- 手动窗口的规矩写在 `docs/windows/finish/`（分支 finish 上）：窗口只改自己说明文件里列的文件；不调 project-manager 的工具，不用 project-* 技能，不合并，不换分支；做完在最后一个提交的说明末尾加一行 `AutoSkills-Done: <块名>`。
- 块任务（AS3-365、AS3-366、AS3-367）在窗口干活期间是“进行中”，备注写着“受阻：窗口 … 在做”。主控不实现它们；窗口都做完以后由主控做 AS3-368，把它们记完成。
- 只有主控写账本，同一时间只有一个会话当主控。
- 部署只由负责人在普通终端执行。主控和窗口都不跑 deploy-kit 的 --apply、--rollback、--neutral，不改用户级。
- worktree 里不放 junction 或 symlink，尤其不要把 `_private` 链进 worktree（`git worktree remove` 会顺着 junction 清空目标）。
- 从 `_private` 搬进仓库的文件，每个跑一次 `lint-kit --check privacy --path <文件>`。
- 账本用 1.5.1，不迁移。
- 常规实现选择由主控定，记进 ADR-009；只把会改完工标准、范围或投入的事交负责人。
- 仓库已有 git 标签 v1.5.1、v2.0（旧套件），新标签不得重名。标签只打本地，不推送。
- 文档和面向负责人的文字用中文；代码和注释沿用仓库现有的英文。
