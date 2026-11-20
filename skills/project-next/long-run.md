# 在会话里起长跑驱动

用户说"起长跑""挂着跑""跑到几点"时，主会话照这一页把循环交给长跑驱动，然后结束回合。只在 Claude Code 上做。驱动的用法、刹车和报告见套件仓库的 `docs/run.md`。

驱动自己起的会话不看这一页：它的提示词里写着"这是无人值守的运行"。

## 1. 先收尾
- 项目契约不许在这个项目里起会话的，不起，照实告诉用户。
- 已经有驱动在跑（查法见第 6 步）就不起第二个，告诉用户运行名和开始时间。
- 手上做了一半的任务，提交到能接着做的地方，在 notes 里写清做到哪：驱动会先接着做 in_progress 的任务。
- 工作目录要干净：`git status --short` 里除了账本目录（`.claude/state/`）和 `.autoskills/` 下的，不能有别的。驱动复验时要求这样。
- 没有能做的任务（没有 in_progress 的，也没有就绪的）就不起，照 project-next 的停点汇报。

## 2. 找驱动脚本
脚本是套件仓库里的 `scripts/autoskills.mjs`，没有部署到用户级。套件仓库的位置记在 SessionStart 钩子旁边的 `hook-config.json` 里（`kit_repo`）。用 PowerShell 工具读出来：

```powershell
$s = Get-Content -Raw "$env:USERPROFILE\.claude\settings.json" | ConvertFrom-Json
$h = $s.hooks.SessionStart.hooks.args | Where-Object { $_ -like '*session-start.mjs' } | Select-Object -First 1
$kit = (Get-Content -Raw (Join-Path (Split-Path $h) 'hook-config.json') | ConvertFrom-Json).kit_repo
$script = Join-Path $kit 'scripts\autoskills.mjs'
"$script exists: $(Test-Path $script)"
```

读不出来，或者脚本不在那里，就问用户套件仓库在哪，不猜。

## 3. 选项
只按用户说的加，没说的不加：
- 截止时间（"到早上 7 点"）：`--until 07:00`，本地时间，24 小时制。
- 个数（"只做 2 个"）：`--max-tasks 2`。
- 模型、档位：`--model <模型>`、`--effort <档位>`。
- 一个会话连做几个任务：`--tasks-per-session <N>`。

## 4. 起之前记一条
`add_log` 记下：要起长跑、选项、当前时间（用命令读）。这是驱动停下之前本会话最后一次写账本。

## 5. 在新窗口里起
用 PowerShell 工具，不用 Bash 工具。一条命令，它马上返回：

```powershell
Start-Process powershell.exe -WorkingDirectory '<主检出>' -ArgumentList '-NoProfile','-NoExit','-Command',"node '<脚本>' run '<主检出>' <选项>"
```

`<主检出>` 和 `<脚本>` 填绝对路径，外面的单引号留着。不要把 `run` 直接放在本会话里跑：前台会占住会话，后台起的进程会话一关就没了。

## 6. 核对起来了
等 5 秒，读锁文件 `<主检出>/.autoskills/run.lock`（里面是 `{pid, run, started_at}`），再看这个 pid 是不是还活着、是不是 node：

```powershell
$lock = Get-Content -Raw '<主检出>\.autoskills\run.lock' | ConvertFrom-Json
Get-Process -Id $lock.pid -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime
```

- 锁在，进程活着：起来了。
- 没有锁，`.autoskills/runs/` 下有刚建的运行目录：驱动起来又停了（比如没有能做的任务）。读那个目录里的 `report.md`，把原因告诉用户。
- 没有锁，也没有新的运行目录：驱动没起来，报错在新窗口里，请用户看一眼。不换别的办法再起。

## 7. 告诉用户，结束回合
- 运行名（锁里的 `run`）和报告的位置（`.autoskills/runs/<运行名>/report.md`，驱动停下时写好）。
- 怎么停：跟主会话说"停下长跑"，或者在那个窗口按一次 Ctrl+C（做完手上的任务后停；按两次立即停）。不要直接关那个窗口。
- 驱动停下以后说"继续"，主会话照 project-resume 接着做。

## 驱动还在跑的时候
锁里的进程还活着，本会话只读：不写账本，不改工作目录，不提交，不做任务。
- 用户问进度：读账本（project-status）和 `git log`，不写。
- 用户说"停下长跑"：`node '<脚本>' stop '<主检出>'`。它只在 `.autoskills/` 下放一个停止文件，驱动做完手上的任务后停。
- 用户要验收、改需求或快修：先停下驱动，等锁里的进程没了再做。
