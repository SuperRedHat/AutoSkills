# 项目契约：AutoSkills

> 只写本项目特有的规则。通用规则在用户级的自主契约（`~/.claude/AGENTS.md`、`~/.codex/AGENTS.md`），这里不复制。
> 由 project-plan 按 AutoSkills 的 `templates/repo-AGENTS.md` 生成；项目级设计经用户确认后，本文件即"已确认的项目契约"。

## 项目
- 主检出：本仓库根目录（主检出，不是 worktree）
- 目标：AutoSkills 3.0 P0。不并行写代码，做出并行安全的账本 2.0、runner、v3 契约和 7 个技能 v3；在测试仓库和测试实例（不成立的平台用临时测试档）里证明可用；用开发诊断守住串行 token 的止损线 1.10（同类比：一句话组对旧一句话组，技能调用组对旧技能调用组）。正式 token 门槛在第 4 批的冻结版本上测。整个项目的最终效果写在 P0 规划的一页设计开头。
- 非目标：部署到用户级和真实迁移（放到最终发布）；第 2–4 批的内容；改别的项目的说明文件；系统 Node、PATH 和用户的持久环境变量。

## 边界
- 只读目录：_private/eval/smoke/readonly-canary、_private/eval/smoke/customer-canary、_private/backup-2026-10-30、_private/backup-2026-11-01-pre-batch1（第 7 题）。
- 不得访问的数据目录：_private/eval/smoke/customer-canary。
- 不复制凭据文件。测试实例要登录时，由负责人在实例里登录。

## 验证
- 默认验证命令：任务里的 verification_commands，在 本仓库根目录 根目录用 Windows PowerShell 5.1 跑。脚本和测试按自身文件位置找仓库里的文件，不按当前目录。
- 不用匹配不到文件也退出 0 的通配（`node --test` 的通配就是这样）；测试文件一律写全名。
- 重型套件：kit 全套、project-manager 全套 vitest、runner 全套、A 组入口（`mcp/project-manager/tests/ledger/a-group.run.mjs`）、B 组入口（`tests/runner/b-group.run.mjs`）、D 组子集入口（`tests/runner/d-subset.run.mjs`）。只在阶段末和门禁前由主会话跑，一次一个。门禁由 `scripts/p0-gate.mjs --run` 在 p0 worktree 的快照（干净、HEAD 和 tree 固定）里跑，不算"从 main 带前缀跑过就验证了 p0"。
- 2.0、runner 和账本测试用便携 Node：`_private/rt/node-v24.22.2-win-x64/node.exe`。系统 Node 22.17.0 不得打开 ledger.db。
- runner 和账本的测试只用临时运行区或测试实例，不碰真实的 `_private/rt` 里的心跳、令牌和 runner.db。

## 验收
- 用户本人验收点：AS3-280（探针窗口）。它可能用到临时测试档，负责人只确认"看过了"或"已恢复"，比对结果由脚本给出。
- AS3-282（诊断测量）在测试实例里跑时是 auto；某个平台隔离不成立、要走临时测试档时，主会话把它收紧成 manual、改用户级=是，按临时测试档窗口处理。
- 其余任务包括 P0 门禁 AS3-283，都由程序和独立校验把关，不请负责人签字。
- 待验收不挡下游：否。

## 其他约定
- `_private/` 不进 git（`.git/info/exclude`）。只改 `_private` 的任务，在账本写"未提交（_private 不进 git）"和改动文件的 sha256。
- 第 1 批已部署（部署 id 20261101-013622-7ec9）。main 保持这个状态，一直到最终发布；本地标签 batch1-deployed 指向它。P0 全部在分支 `p0`、worktree `.autoskills/dev/p0` 上开发。
- 中间版本不部署到用户级。不从 worktree 跑 deploy-kit 的 --apply、--rollback、--neutral。要在真实平台上测的，先用测试实例（`scripts/test-instance.mjs`，环境变量只传给子进程）；隔离不成立的平台才走临时测试档（`scripts/test-profile.mjs`），由负责人在普通终端启动，结束时自动恢复并比对。
- 要子代理或 Codex 子线程的正向用例，只在 p0 实例或 p0 档里做：用户级的第 1 批守卫会拦子代理对 2.0 的写调用。
- worktree 和验证池里不放 junction 或 symlink，尤其不要把 `_private` 链进 worktree（`git worktree remove` 会顺着 junction 清空目标）。
- 原型在 `_private/redesign-2026-10/experiments/`（sqlite/scripts、runner、critic_evidence）和 `_private/eval/probes/rtask/`，worktree 里没有，一律用绝对路径找。搬进仓库的文件，每个跑一次 `lint-kit --check privacy --path <文件>`。
- 账本：P0 到最终发布都用 1.5.1。2.0 只在临时目录、`--home` 重定向、`_private/eval` 测试仓库、测试实例和临时测试档里跑。
- 常规实现选择由主会话定，记进 ADR-007；只把会改最终效果、范围或投入的事交负责人。
- 相关改动合并做一次独立审查：AS3-206/207 一次；AS3-255、AS3-258–262 在 AS3-263 一次；其余高风险任务各自审查。
- kit 测试：AS3-202 修好前，要在 PATH 上第一个 bash 不是 WSL 启动器的环境里跑（例如从 Git Bash 启动）；跑 kit 测试时不能有别的会话或代理在调工具（第 90 条会失败）。
- 迁移不在别的仓库里提交，只写各仓库的 `.git/info/exclude`。
- 仓库已有 git 标签 v1.5.1、v2.0（旧套件），新标签不得重名。标签只打本地，不推送。
- 文档和面向负责人的文字用中文；代码和注释沿用仓库现有的英文。
