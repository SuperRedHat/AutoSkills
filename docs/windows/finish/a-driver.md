# 窗口 A：长跑驱动（块名 a，任务 AS3-365）

你在一个手动并行的窗口里，只做这一块。先读 `docs/windows/finish/README.md`（共用的约定，每一条都适用），再读设计页的第 2、10、11 节（`../../../_private/redesign-2026-10/b3/finish-line-design-2026-11-19.md`）。

## 要做成什么

- `node scripts/autoskills.mjs run <项目目录> [选项]`：长跑驱动。每个任务开一个全新的无头会话（`claude -p`）去做；会话结束后，驱动自己在提交好的代码上重跑任务的验证命令；带刹车；结束时出报告。
- `node scripts/autoskills.mjs stop <项目目录>`：写停止文件，让驱动在当前任务做完后停。
- 驱动**不写账本，不改任务状态**。它只读账本（走 `scripts/lib/ledger-read.mjs`），只写自己的文件（走 `scripts/lib/run-paths.mjs`）。
- 驱动**永远不替负责人验收**。

你的文件：`scripts/lib/run/` 下的全部（`cli.mjs` 现在是占位，换掉它；导出的 `runCommand`、`stopCommand` 和它们的形式不变）、`tests/kit/autoskills-run.test.mjs`、`docs/run.md`、`docs/windows/finish/a-probes.md`。

## 第一步：先探三件事

结果写进 `docs/windows/finish/a-probes.md`：做了什么、看到了什么、结论，用掉多少 token。

真实会话只在主检出的 `_private/eval/finish-probe/` 下的一次性测试仓库里起（从这里看是 `../../../_private/eval/finish-probe/`）。测试仓库用 fixture7 建：`../../../_private/eval/harness/make-run.mjs` 会建好仓库、账本种子和挡住往上找真实账本的那个假目录，用 `--arm old`（就是“用户级现在装着的套件”）；它的用法在文件头和 `../../../_private/eval/harness/README.md`。起会话的脚本从 PowerShell 工具启动，不从 Bash 工具启动（Git Bash 下起的会话没有 Bash 工具）。三件事合计估计 60 到 130 万 token，到 200 万就停下报告。

1. **无头会话在用户级现在的套件下能不能顺利跑。** `claude -p "<提示词>" --output-format stream-json --verbose --permission-mode auto`，工作目录是测试仓库，环境变量 `PROJECT_DIR` 指向测试仓库。看：
   - 技能、钩子（守卫的心跳、会话开始那几行提示）、账本服务加载了没有；
   - 提示词“用 project-next 只做 T1；做完、验证、提交、记账就结束；这是无人值守的运行，不要提问，要我定的事写进任务备注和汇报”是不是做完一个任务就结束，任务状态走到了哪。
2. **权限模式。** 本机命令行的 `--permission-mode` 可选值是 acceptEdits、auto、bypassPermissions、manual、dontAsk、plan。
   - 自动模式（auto）在无头会话里能不能顺利做完一个任务；被拦的时候会话怎么收场（退出码、输出里有什么）。
   - 再用 bypassPermissions 跑一次很短的，看守卫钩子和 settings 里的拒绝规则还生不生效（比如让它试一次 `git push --dry-run`，应当被拦下）。
   - 结论只写事实。自动模式能顺利做完一个任务，驱动的默认就用它。**跑不顺就停下**，把现象写清楚交负责人定，不要自己把默认换成 bypassPermissions（负责人 2026-11-19 的决定）。评测驱动里写死的是 bypassPermissions，那是在测试仓库里。
3. **Ctrl+C。** 不起真实会话，用一个替身程序试：驱动在控制台收到 Ctrl+C 时，能不能让子进程不被一起结束（比如 `spawn` 时让子进程不挂在同一个控制台上）。
   - 做得到：第一次 Ctrl+C 等当前任务做完再停，第二次立即停。
   - 做不到：Ctrl+C 立即停，改了一半的留在工作目录里，帮助里照实写。
   - 两种情况下，稳妥的停法都是停止文件。

## 从哪里搬

主检出的 `../../../_private/eval/harness/lib/`：

- `agent.mjs`：起会话、读 stream-json、读用量、认额度用完的规则（`USAGE_LIMIT_RE`）、空闲超时、结束进程树、子进程的环境变量怎么清。
- `util.mjs`：找 claude.exe、读版本、`launchSpec`（`.mjs` 用 Node 跑，所以测试能用替身）、`killTree`。
- `policy.mjs`：刹车的默认值。

只搬用得上的，改成按任务开新会话（不用 `--resume`）。评测驱动里模拟负责人回“继续”“验收通过”的部分不搬。搬进仓库的每个文件跑一次 `node scripts/lint-kit.mjs --check privacy --path <文件>`。

## 行为（验收标准）

**挑任务**

- 读账本用 `readLedger`。先挑进行中的任务（`inProgress`），备注里有“受阻：”的跳过（`isBlocked`）；手动并行的块任务也是“进行中”加“受阻：”，一样跳过。
- 没有进行中的，就取 `readyTasks(tasks, { awaitingBlocks: 设置里的 awaiting_blocks_downstream })` 的第一个。
- 一个能做的都没有：不起会话就停，报告写明原因（全部做完；只剩等负责人验收或决定的；剩下的都受阻）。

**起会话**

- 每个任务一个全新的 `claude -p`，工作目录是项目根目录，提示词点名任务号。提示词的文字集中放在一个文件里。
- 环境变量照评测驱动的做法清掉上一层会话带来的那些，并设 `PROJECT_DIR`。
- 选项：`--model`、`--effort` 原样传给会话，默认不传；`--permission-mode` 的默认按上面第 2 项的结论；`--tasks-per-session N`，默认 1；`--cli <可执行文件或 .mjs>` 指定命令行（测试用替身）。

**会话结束以后**

- 用 `statusChangesSince(logs, 会话开始的时间)` 和 git 的 HEAD 前后对比，判断这个任务的状态变没变、有没有新提交。
- 任务到了完成或待验收：驱动复验。
  - 先看工作目录干不干净：`git status --porcelain` 里没有东西才算干净，账本目录（`.claude/state/`）和 `.autoskills/` 下的不算。
  - 把任务的 verification_commands 逐条重跑，一条一个进程，工作目录是项目根目录，每条有超时（默认 30 分钟，可以用选项改），输出写进这次运行的目录。
  - 用哪个 shell 看项目设置的 `verify_shell`：`powershell` 用 `powershell.exe -NoProfile -NonInteractive -Command`；`bash` 用 Git for Windows 的 bash.exe，不能用 WSL 的启动器。
  - 结果用 `verifyFile()` 写成 `run-paths.mjs` 文件头写明的形式。不干净记 `clean: false`、`passed: false`；任务没有验证命令记 `passed: null` 并写明原因。
- 复验没过：
  - 任务已经是完成：下一个会话的提示词写明哪条命令没过、退出码、日志在哪，要求照 project-plan 的做法新建一个返工任务（依赖为空，优先级最高，验证命令和原任务一样）并只做它。同一个任务修两轮还不过，要求会话在返工任务的备注里写“受阻：…”，驱动之后跳过它。
  - 任务在待验收：不动它，报告里标出“复验没过，建议驳回”。
  - 复验没过时，下一个做什么由驱动点名，别的任务不抢在返工前面。

**刹车**（任何限额都只管还开不开下一个任务，不打断正在做的任务）

| 管什么 | 做法 | 默认 |
|---|---|---|
| token 预算 | 不设。每做完一个任务打印已用多少，按当前平均推算剩下的 | 关 |
| 时间 | `--until HH:MM`（本地时间）以后不再开新任务 | 关 |
| 任务数 | `--max-tasks N` | 关 |
| 没进展 | 连续 3 个会话既没有新提交、任务状态也没变，就停 | 开 |
| 同一个任务反复不过 | 修两轮还不过，跳过 | 开 |
| 会话挂死 | 30 分钟没有任何输出才结束这个会话（结束整个进程树）；下一个会话接着做 | 开 |
| 额度用完 | 认到以后等一段时间再试（10、20、40 分钟，之后每次 60 分钟），恢复后接着跑；等待记进报告 | 开 |
| 停止文件 | `stop` 命令写它；驱动做完当前任务后停，退出时删掉它 | — |

**锁**：启动时写锁文件（pid、运行名、开始时间），退出时删。项目里已有活着的驱动就拒绝启动；锁里的进程已经不在了，就接手并在报告里记一句。

**报告和退出码**

- `runRecordFile()` 记这次运行；`reportFile()` 是给负责人看的 `report.md`（中文）：每个任务一行，写结果、提交号、复验结果、token、用时；合计；哪些在等验收；哪些受阻、为什么；等了几次额度。
- 结束时经入口的 `COMMANDS` 调一次 accept 命令出验收包；它失败只在报告里记一行，不影响退出码（你这条分支上它还是占位）。
- 退出码：0 停在正常的停点（都做完了、只剩负责人的事、停止文件、到了 `--until` 或 `--max-tasks`）；1 被刹车停下或出错；2 用法错误。带 `--help` 时打印用法并退出 0。

**测试**

- `tests/kit/autoskills-run.test.mjs` 用一个替身命令行（一个小的 `.mjs`，照剧本改临时仓库和临时账本，像会话那样）覆盖上面每一条：挑任务的顺序和跳过、没有能做的任务、复验通过和没过的两种去向、不干净的工作目录、每个刹车、停止文件、锁、报告的内容、退出码。
- 测试不起真实会话，不碰真实的项目和用户级。

**给负责人的用法**：`docs/run.md`（中文）：一条命令怎么敲、每个选项、怎么停、报告在哪、项目设置文件怎么写、跑着的时候不要在同一个项目里另开会话记账。

## 第二步之后：短试跑

单元测试都过了以后，用 fixture7 做一次短试跑：`--max-tasks 2`，Opus 5.5、high，不超过 150 万 token。把每个任务的 token、会话数、碰到的问题写进 `a-probes.md`。整趟的试跑是合并以后的事（AS3-369），不在这个窗口做。

## 自测

```
node --test tests/kit/autoskills-run.test.mjs
node --test tests/kit/autoskills-cli.test.mjs
node --test tests/kit/ledger-read.test.mjs
node scripts/lint-kit.mjs --check all
```

做完的标记：最后一个提交的说明末尾加一行 `AutoSkills-Done: a`。
