# 项目契约：AutoSkills

> 只写本项目特有的规则。通用规则在用户级的自主契约（`~/.claude/AGENTS.md`、`~/.codex/AGENTS.md`），这里不复制。
> 由 project-plan 按 AutoSkills 的 `templates/repo-AGENTS.md` 生成；项目级设计经用户确认后，本文件即"已确认的项目契约"。

## 项目
- 主检出：本仓库根目录（主检出，不是 worktree）
- 目标：AutoSkills 3.0 第 2 批（试点）。第一次真跑 2 个 writer：Claude Code 和 Codex 各一遍，只在 `_private/eval` 的测试仓库和测试实例里做，看并行在小范围里对不对、快不快。开跑之前先把 P0 留给第 2 批的事项修完，并行探针在当时的套件和 CLI 版本上重测，通过的能力照 D-4 打开。验收标准 9 条和整个项目的最终效果 8 条写在账本的 PRD 里；计划全文在 `_private/redesign-2026-10/b2/B2-plan-2026-11-13.md`，实现决定记在 ADR-008。
- P0（账本 2.0、runner、v3 契约和 7 个技能 v3，串行可用）已完成，2026-11-13 过了门禁，本地标签 p0-gate-pass。它的设计在归档 `_private/redesign-2026-10/p0/PRD-at-p0-gate-2026-11-13.md` 和 ADR-007 里。
- 非目标：第 3 批和第 4 批的内容（模板和代理定义的正式版、Codex 根线程协议写进技能、回执签名、PathGuard、D 组的其余部分、打开 h4_acceptance；正式 token 门槛、4 个 writer、ultracode 和 ultra 的测量）；部署到用户级和真实迁移（放到最终发布）；在真实项目里并行、写并发超过 2；改别的项目的说明文件；系统 Node、PATH 和用户的持久环境变量。

## 边界
- 只读目录：_private/eval/smoke/readonly-canary、_private/eval/smoke/customer-canary、_private/backup-2026-10-30、_private/backup-2026-11-01-pre-batch1（第 7 题）。
- 不得访问的数据目录：_private/eval/smoke/customer-canary。
- 不复制凭据文件。测试实例要登录时，由负责人在实例里登录。

## 验证
- 默认验证命令：任务里的 verification_commands，在本仓库根目录用 Windows PowerShell 5.1 跑。脚本和测试按自身文件位置找仓库里的文件，不按当前目录。
- 不用匹配不到文件也退出 0 的通配（`node --test` 的通配就是这样）；测试文件一律写全名。
- 重型套件：kit 全套、project-manager 全套 vitest、runner 全套、A 组入口（`mcp/project-manager/tests/ledger/a-group.run.mjs`）、B 组入口（`tests/runner/b-group.run.mjs`）、D 组子集入口（`tests/runner/d-subset.run.mjs`）。只在阶段末和门禁前由主会话跑，一次一个。门禁由 `scripts/b2-gate.mjs --run` 在 p0 worktree 的快照（干净、HEAD 和 tree 固定）里跑；AS3-332 把它做出来之前用 `scripts/p0-gate.mjs --run`。不算"从 main 带前缀跑过就验证了 p0"。
- 2.0、runner 和账本测试用便携 Node：`_private/rt/node-v24.22.2-win-x64/node.exe`。系统 Node 22.17.0 不得打开 ledger.db。
- runner 和账本的测试只用临时运行区或测试实例，不碰真实的 `_private/rt` 里的心跳、令牌和 runner.db。

## 验收
- 用户本人验收点：第 2 批没有。所有任务包括第 2 批门禁 AS3-359，都由程序和独立校验把关，不请负责人签字。
- 两种情况会请负责人到场，都提前说：E7 的真重放如果无人值守做不了，开一次交互窗口（约 10 分钟）；Codex 的实例隔离（AS3-344）补不上时，串行诊断的 Codex 一段走临时测试档窗口（约 110 分钟不能用会话），到时另加一个 manual 任务。
- 要负责人定的事集中提：探针修了 2 轮还不过、要按 D-4 关能力；串行诊断两轮优化后仍超过止损线；套件或门禁查出缺陷、要定现在修还是延后。
- 待验收不挡下游：否。

## 其他约定
- `_private/` 不进 git（`.git/info/exclude`）。只改 `_private` 的任务，在账本写"未提交（_private 不进 git）"和改动文件的 sha256。
- 第 1 批已部署（部署 id 20261101-013622-7ec9）。main 保持这个状态，一直到最终发布；本地标签 batch1-deployed 指向它。第 2 批接着在分支 `p0`、worktree `.autoskills/dev/p0` 上开发，名字不改；P0 门禁的快照是本地标签 p0-gate-pass。
- 中间版本不部署到用户级。不从 worktree 跑 deploy-kit 的 --apply、--rollback、--neutral。要在真实平台上测的，先用测试实例（`scripts/test-instance.mjs`，环境变量只传给子进程）；隔离不成立的平台才走临时测试档（`scripts/test-profile.mjs`），由负责人在普通终端启动，结束时自动恢复并比对。
- 要子代理或 Codex 子线程的正向用例，只在 p0 实例或 p0 档里做：用户级的第 1 批守卫会拦子代理对 2.0 的写调用。
- 测试实例长期保留（2026-11-11 起）：受管实例 diag-p0 不再每次销毁重建，里面留着负责人的登录；套件变了用 `scripts/test-instance.mjs --refresh` 只换套件文件。主会话可以在负责人不在场时用它跑最小自检（`scripts/platform-selfcheck.mjs`），只在门禁时和发现 CLI 版本变了时跑；第 2 批的并行探针、并行金丝雀和试点也在这个实例里无人值守跑。实例 runner 的计划任务 `AutoSkills-runner-diag-p0` 平时不运行，最终发布时删除；它指向实例里路径固定的启动文件（`rt/runner/start.mjs`），套件刷新后不用重新注册，便携 Node 或实例的位置变了才要。
- 真实平台运行的额度上限（负责人 2026-11-13 定），超过就停下报告，不自动重跑：最小自检每次 250 万 token；并行金丝雀每次 150 万，和最小自检分开算；探针窗口每个平台每次 1000 万；试点每个场景每次 500 万，整个试点（两个平台、含干跑）4000 万。串行 token 诊断在批末照 P0 的规格完整跑一次（估计约 6200 万）。
- 无人值守的 Codex 测试运行（探针、最小自检、试点、诊断测量）一律带 `--dangerously-bypass-hook-trust`，同一平台的新旧变体都带，事先写进规格。这些运行不检验"信任"这一环，留到最终发布时核对。
- 平台 CLI 更新不让已有证据作废，只有被测套件变了才作废；门禁时在当时的 CLI 版本上重跑最小自检。
- 能力开关按探针重测的结果开关，只在测试实例和测试账本里生效。CLI 更新后跑并行金丝雀重新核对，对不上只暂停那一个能力，串行不受影响。
- worktree 和验证池里不放 junction 或 symlink，尤其不要把 `_private` 链进 worktree（`git worktree remove` 会顺着 junction 清空目标）。
- 原型在 `_private/redesign-2026-10/experiments/`（sqlite/scripts、runner、critic_evidence）和 `_private/eval/probes/rtask/`，worktree 里没有，一律用绝对路径找。搬进仓库的文件，每个跑一次 `lint-kit --check privacy --path <文件>`。
- 账本：P0 到最终发布都用 1.5.1。2.0 只在临时目录、`--home` 重定向、`_private/eval` 测试仓库、测试实例和临时测试档里跑。
- 常规实现选择由主会话定，记进 ADR-008（P0 的在 ADR-007）；只把会改最终效果、范围或投入的事交负责人。
- 套件或门禁的测试失败时，先查失败的测试是不是某条验收标准的证据、能不能确定性重现；是缺陷的话，延后修由负责人定，主会话只给建议。
- 相关改动合并做独立审查：AS3-332 到 AS3-349 在 AS3-350 分三组各审一次（账本和服务端、runner、套件文字和模板）；其余高风险任务各自审查。
- kit 测试：AS3-202 修好前，要在 PATH 上第一个 bash 不是 WSL 启动器的环境里跑（例如从 Git Bash 启动）；跑 kit 测试时不能有别的会话或代理在调工具（第 90 条会失败）。
- 迁移不在别的仓库里提交，只写各仓库的 `.git/info/exclude`。
- 仓库已有 git 标签 v1.5.1、v2.0（旧套件），新标签不得重名。标签只打本地，不推送。
- 文档和面向负责人的文字用中文；代码和注释沿用仓库现有的英文。
