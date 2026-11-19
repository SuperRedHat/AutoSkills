# 窗口 A 的探查和短试跑（AS3-365）

2026-11-19 做。真实会话都在主检出的 `_private/eval/finish-probe/` 下的一次性测试仓库里起，仓库用 fixture7 建（`make-run.mjs --platform claude --arm old --runs-dir ../finish-probe`，用户级现在装着的套件）。起会话的脚本从 PowerShell 工具启动。命令行 claude 2.1.328，模型 claude-opus-5-5、档位 high（用户设置里的默认模型是 Fable 5.2，为省额度显式指定）。

会话都经驱动自己的会话模块 `scripts/lib/run/session.mjs` 起：清掉上一层会话的环境变量（CLAUDECODE、CLAUDE_EFFORT 等），设 `PROJECT_DIR` 为测试仓库，参数 `claude -p <提示词> --output-format stream-json --verbose --permission-mode <模式> --model claude-opus-5-5 --effort high`，工作目录是测试仓库。原始输出在各运行目录的 `logs/<标签>.stdout.jsonl`，摘要在 `logs/<标签>.summary.json`。

## 1. 无头会话在用户级现在的套件下能不能顺利跑

**做了什么**：仓库 `finish-probe/p1-auto`，自动模式，提示词“用 project-next 只做 T1；做完、验证、提交、记账就结束；这是无人值守的运行，不要提问，要我定的事写进任务备注和汇报。”

**看到了什么**：

- 退出码 0，result 是 success，88 秒，20 轮，权限拒绝 0 次。
- 加载：init 事件里 project-manager 服务 connected，账本工具 33 个，project-* 技能 7 个都在。会话调了 Skill(project-next)，账本工具调了 9 次（set_project_dir、get_server_info、get_task_by_id、update_task_status 三次、add_log 等）。
- 钩子：输出里有 SessionStart 钩子的 hook_started 和 hook_response（exit 0），附加的上下文就是会话开始那几行提示（会话 id、先 set_project_dir、五种停点、证据规则）。守卫心跳 `_private/rt/hooks/heartbeat/guard.jsonl` 在会话那段时间里有 33 行 PreToolUse allow；心跳不带会话 id，同一时段别的会话也在写，所以只能说有心跳，分不清每一行是谁的。守卫拦人的效果见第 2 项。
- 做完一个就结束：T1 从 todo 到 done（auto_verified → done），一条提交 `db09f75 feat(T1): …`，只改 `src/money.mjs`，工作目录干净；T2 到 T7 都没动。最后的汇报写“本轮只做 T1，到这里结束”。
- 要负责人定的事（金额上限怎么处理等三条假设）写进了 T1 的备注和汇报，没有提问。
- 顺带看到的：project-next 把自己的验证日志写在 `.autoskills/runs/T1-verify.log`，并把 `.autoskills/` 加进了仓库的 `.git/info/exclude`。驱动的运行目录也在 `.autoskills/runs/<运行名>/` 下，运行名是时间戳，不会和这些文件撞名；`latestVerify` 读到这些文件会跳过。驱动判断工作目录干净时本来就不算 `.autoskills/`。

**token**：672,168（输入 665,480，其中缓存读 629,426、缓存写 36,022；输出 6,688）。

**结论**：顺利。技能、钩子、账本服务都加载了，“只做 T1”做完一个就结束，状态走到 done。

## 2. 权限模式

**做了什么**：

- 自动模式做完一个任务：就是第 1 项。
- 被拦的时候怎么收场：仓库 `finish-probe/p2-bypass`，先用 bypassPermissions、再用 auto 各起一个短会话，提示词让它在仓库根目录逐条照抄运行四条命令，每条一个 Bash 调用，被拦了不换写法：`mkdir probe-tmp`、`git push --dry-run origin HEAD`、`git --no-pager push --dry-run origin HEAD`、`rm -rf probe-tmp`（auto 那次目录名是 probe-tmp2）。第 3 条的写法不在 settings 的拒绝规则里，只有守卫认得；第 4 条只在拒绝规则里。测试仓库的远端是本地裸仓库，本身也拒绝推送。

**看到了什么**（两种模式结果相同）：

| 命令 | bypassPermissions | auto |
|---|---|---|
| mkdir | 执行了 | 执行了 |
| `git push --dry-run …` | 被守卫钩子拦：`PreToolUse:Bash hook error: AutoSkills 守卫拒绝了这条命令：git push 会推送或发布到远端…` | 同左 |
| `git --no-pager push --dry-run …` | 被守卫钩子拦，原文同上 | 同左 |
| `rm -rf …` | 被拒绝规则拦：`Permission to use Bash with command rm -rf probe-tmp has been denied.` | 同左 |

- 两次会话都是退出码 0、result success、permission_denials 3，被拦的调用作为错误结果回到会话里，会话照常写完汇报就结束，没有卡住等人点。没有换写法重试。
- 测试仓库的推送日志（`logs/push-attempts.log`）不存在，说明推送没走到 git。
- 用时和 token：bypassPermissions 39 秒、187,541；auto 43 秒、188,229。

**结论**：

- 自动模式在无头会话里能顺利做完一个任务；被拦时会话收到错误、照常收场，退出码 0，输出 result 里 `permission_denials` 记着次数。驱动的默认权限模式用 auto。
- 换成 bypassPermissions，守卫钩子和 settings 的拒绝规则都还生效。
- 没碰到的：自动模式自己的分类器拦下命令的情形没有触发到（被拦的都是钩子和拒绝规则）。分类器拦下时会话怎么收场，没有实测。

## 3. Ctrl+C

**做了什么**：不起真实会话。替身程序在会话目录的 scratchpad 里（`ctrlc/`）：替身驱动（node）起替身会话（node，不处理 SIGINT，所以默认收到 Ctrl+C 就退出），替身会话干 8 秒活，并起两个 powershell 孙进程，查它们有没有控制台窗口、窗口可不可见。替身驱动收到第一次 Ctrl+C 只记一行，第二次 `taskkill /T /F` 结束替身会话的进程树再退出。替身驱动用 `Start-Process` 起在新控制台里，再由另一个 PowerShell 进程 `AttachConsole` 到那个控制台、`GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)`，和在那个控制台里按 Ctrl+C 一样，发给挂在这个控制台上的全部进程。

**看到了什么**：

| 替身会话怎么起 | Ctrl+C | 结果 |
|---|---|---|
| `spawn`，`windowsHide: false`（和驱动同一个控制台，对照组） | 1 次 | 替身会话立即被结束，退出码 3221225786（0xC000013A，Ctrl+C 结束） |
| `spawn`，`windowsHide: true`（评测驱动和本驱动的写法） | 1 次 | 替身会话没收到，干完 8 秒、正常退出 0；驱动等它结束后才退出 |
| 同上 | 2 次 | 第二次时驱动结束进程树、退出；替身会话不在了 |
| `spawn`，`detached: true` | 1 次 / 2 次 | 和上面两行一样；但替身会话起的、没有隐藏窗口的孙进程，有了**可见的**控制台窗口 |

`windowsHide: true` 时，会话拿到的是自己的一个隐藏控制台（孙进程查到的控制台窗口句柄是 0、不可见），不挂在驱动的控制台上，所以收不到驱动窗口里的 Ctrl+C。

**结论**：做得到。驱动用 `windowsHide: true` 起会话（不用 detached，免得会话起的程序弹窗口）。第一次 Ctrl+C 等当前任务做完再停；第二次结束当前会话的进程树，立即停，改了一半的留在工作目录里。稳妥的停法仍是停止文件（`autoskills.mjs stop`）。设计页和评测驱动里说的“命令行自己也可能收到它”，在 `windowsHide: true` 下不成立。

没覆盖的：只在一个由 `Start-Process` 新开的控制台里试过，没在 Windows Terminal 的标签页里实际按键；按 Windows 的控制台机制两者一样，没有单独核实。

## 探查合计

三次真实会话：672,168 + 187,541 + 188,229 = 1,047,938 token，在估计的 60 到 130 万之内。Ctrl+C 不用额度。

## 短试跑

单元测试都过、提交 c899c8b 以后做。仓库 `finish-probe/p3-trial`（fixture7 新建），从 PowerShell 工具敲：

```
node scripts/autoskills.mjs run <p3-trial>/repo --max-tasks 2 --model claude-opus-5-5 --effort high
```

没写项目设置，复验用默认的 PowerShell 5.1。控制台输出存在会话 scratchpad 的 `trial.console.log`，报告在测试仓库的 `.autoskills/runs/2026-11-19T03-25-39Z/report.md`。

**结果**：退出码 0，停在“做完了 --max-tasks 2 个任务”，2 分 58 秒。

| 任务 | 会话 | token | 用时 | 轮数 | 权限拒绝 | 账本调用 | 提交 | 驱动复验 |
|---|---|---|---|---|---|---|---|---|
| T1 | 1 | 657,958 | 90 秒 | 19 | 0 | 8 | dcd9e03 | 通过（`node --test test/money.test.mjs`，退出码 0） |
| T2 | 1 | 659,168 | 86 秒 | 17 | 0 | 8 | f77658d | 通过（`node --test test/money.test.mjs test/record.test.mjs`，退出码 0） |
| 合计 | 2 | 1,317,126 | 2 分 56 秒 | | | | | |

- 每个会话都只做了点名的任务，状态走到 done，一条提交，工作目录干净；T3 到 T7 没动。
- 每个任务约 66 万 token，和第 1 项探查（同一个 T1，67 万）一致。输入里绝大部分是缓存读；固定开销（技能、契约、账本工具说明）每个会话都要付一遍，这是设计页第 11 节说的“没实测”那一条的第一个数。
- 结束时经入口调 accept：这条分支上还是占位，退出码 1，报告里记了一行“没出成”，没影响退出码。
- 锁文件和停止文件结束后都不在了。

**碰到的问题**：

- project-next 会话把自己的验证日志放在 `.autoskills/runs/<时间>-<任务>-verify/` 下（这次是 `2026-11-19T03-26-32Z-T1-verify/`、`…-T2-verify/`，里面是测试日志和它另写的规格核对脚本），和驱动的运行目录挤在同一个 `runs/` 里。名字不会和驱动的运行名撞（驱动的是纯时间戳），里面也没有 `tasks/<任务>.verify.json`，所以 `latestVerify` 不受影响；驱动判断干净时也不算 `.autoskills/`。但读 `runs/` 的程序（验收包）要能容忍这些不是驱动建的目录。会话还会把 `.autoskills/` 写进 `.git/info/exclude`。这是现用版技能的行为，不在这一块改，报给主控。
- 没碰到复验没过、额度用完、会话挂死：这些路径只在替身测试里走过。

**token**：试跑 1,317,126，在 150 万以内。探查加试跑合计 2,365,064。
