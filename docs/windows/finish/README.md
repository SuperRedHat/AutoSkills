# 收尾这一批的手动并行：约定和收法

> 这是 2026-11-19 那一批的历史记录，留着当手动并行的例子看。里面的分支和 worktree（`finish`、`finish-a`、`finish-b`、`finish-t`）已经合进 main 并删掉；现在的做法见 [docs/manual-parallel.md](../../manual-parallel.md)，这一趟的实测结果见 [result.md](result.md)。

这一批（AS3-364 到 AS3-372）用三个手动窗口并行做。这一页是三块共用的约定，和主控收窗口的步骤。

设计页在主检出的 `_private/redesign-2026-10/b3/finish-line-design-2026-11-19.md`。从窗口的 worktree 看，主检出在往上三级，也就是 `../../../_private/redesign-2026-10/b3/finish-line-design-2026-11-19.md`。

## 三块和各自的文件

| 块名 | 窗口 | 分支和 worktree | 只改这些 | 账本任务 |
|---|---|---|---|---|
| a | A 长跑驱动 | `finish-a`，`.autoskills/dev/finish-a` | `scripts/lib/run/` 下的文件、`tests/kit/autoskills-run.test.mjs`、`docs/run.md`、`docs/windows/finish/a-probes.md` | AS3-365 |
| b | B 验收包 | `finish-b`，`.autoskills/dev/finish-b` | `scripts/lib/accept/` 下的文件、`tests/kit/autoskills-accept.test.mjs`、`docs/accept.md` | AS3-366 |
| t | T 套件文字 | `finish-t`，`.autoskills/dev/finish-t` | `skills/project-status/SKILL.md`、`skills/project-feedback/SKILL.md`、`skills/project-plan/SKILL.md`、`skills/project-next/SKILL.md`、`config/claude/agents/project-verifier.md`、`docs/manual-parallel.md` | AS3-367 |

每块的说明在本目录：`a-driver.md`、`b-accept.md`、`t-text.md`。

## 冻结的共用文件

契约任务（AS3-364）写的，窗口不改：

- `scripts/autoskills.mjs`：入口，只负责找命令。每个命令是 `(args, io) => 退出码` 的函数，`io` 是 `{stdout, stderr}`。带 `--help` 时打印自己的用法并退出 0（`tests/kit/autoskills-cli.test.mjs` 查这一条）。退出码：0 做完，1 命令失败，2 用法错误。
- `scripts/lib/ledger-read.mjs`：只读地读项目的账本文件。`readLedger(项目)` 给出 `{tasks, logs}`，任务已经补上服务端的默认值；`readyTasks`、`nextReady`、`inProgress`、`awaitingAcceptance`、`isBlocked`、`requiresManualAcceptance`、`dependentsOf`、`unblockedBy`、`statusChangesSince`。读账本只走它，不自己解析 `tasks.json`。
- `scripts/lib/run-paths.mjs`：命令在项目里放文件的位置和格式（锁文件、停止文件、项目设置、每次运行的目录、驱动复验的结果、验收包的目录）。驱动和验收包只通过这些文件碰面，路径只从这里取。
- `tests/kit/ledger-read.test.mjs`、`tests/kit/autoskills-cli.test.mjs`。

觉得共用文件不对或不够用：停下，写明要改什么、为什么，不要自己改。自己那一块要的小工具，放在自己的目录里。

## 每个窗口都要守的

1. **你没有账本工具，这是有意的**（启动时关掉了全部 MCP 服务）。不要去设项目目录，不调 project-manager 的任何工具，不用 project-* 技能，不取别的任务。用户级契约里“开始时先设项目目录”“循环取就绪任务”这些话，在这个窗口里不适用，这不算控制器出错。开工先看一眼自己的工具：要是有名字以 `mcp__project-manager__` 开头的，停下告诉负责人。
2. 只改自己那一块的文件，别的文件只读。
3. 不合并，不换分支，不 push，不动别的 worktree，不改用户级（`~/.claude`、`~/.codex`、`~/.agents`、`~/.workflow-core`）。
4. 测试只跑自己说明里列的测试文件和 lint，用 Bash 工具（Git Bash）跑。不要跑 `tests/kit/deploy-kit.test.mjs`，也不要整个目录一起跑：别的窗口在干活时它会失败。
5. lint：`node scripts/lint-kit.mjs --check all`。worktree 里没有私有词表，它会提示只用内置规则，这是正常的。脚本里不写盘符路径和带用户名的路径；snake_case 的名字不要以工具动词开头（get_、set_、add_、update_、create_、close_、edit_、save_ 这类），代码里用 camelCase；源码里不要有字面的字节序标记。
6. 提交用 Conventional Commits，说明里写任务号，可以提交多次。只 `git add` 自己那一块的文件。
7. **做完**：自测通过后提交。最后一个提交的说明末尾加一行 `AutoSkills-Done: <块名>`（a、b 或 t）；没有新改动就做一个空提交。然后停下，说“这一块做完了”，并列出提交号、跑过的命令和退出码、没做完或拿不准的地方。
8. **卡住**：写明卡在哪、试过什么、需要什么，停下等负责人。不为了过测试去删断言、跳过用例。
9. 要负责人定的事，停下说清事实和选项，不自己定。

## 主控怎么收（AS3-368）

三个窗口都说做完以后，由主控在主检出里做。这时没有窗口在干活。

1. 每块看完成标记和工作目录：
   - `git -C .autoskills/dev/finish-<块名> log -1 --format=%B` 的末尾有 `AutoSkills-Done: <块名>`；
   - `git -C .autoskills/dev/finish-<块名> status --short` 是空的。
2. 每块看改动范围：`git diff --name-only finish...finish-<块名>` 列出的文件都在上表那一块的范围里。超出的逐个看，写进记录。
3. 在那一块的 worktree 里跑它的验证命令（账本任务里的 verification_commands）。
4. 按 t、b、a 的顺序合并：在 `.autoskills/dev/finish` 里 `git merge --no-ff finish-<块名>`。三块的文件不重叠，正常没有冲突；有冲突就停下看原因。
5. 合并后在 `.autoskills/dev/finish` 里跑 lint 和 `tests/kit` 下每个测试文件（全名，Git Bash）。
6. 记账。AS3-365、AS3-366、AS3-367 现在是“进行中”，备注里有一行“受阻：窗口 … 在做”。每个任务：先读出备注，把那一行换成“窗口做完，主控已收：<合并提交号>，验证 <结果>”，再照状态机推进到完成。
7. 把这一趟手动并行的实测写进 `docs/windows/finish/result.md`：每个窗口用了多久、有没有碰账本、合并有没有冲突、关掉 MCP 服务这个办法管不管用、窗口会话对没有账本工具的反应。

独立审查在 AS3-370 统一做，不在收窗口这一步。
