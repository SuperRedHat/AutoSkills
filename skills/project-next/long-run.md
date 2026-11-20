# 在会话里起长跑驱动

用户说"起长跑""挂着跑""跑到几点"时，主会话照这一页把循环交给长跑驱动，然后结束回合。只在 Claude Code 上做。驱动的用法、刹车和报告见套件仓库的 `docs/run.md`。

驱动自己起的会话不看这一页：它的提示词里写着"这是无人值守的运行"。

## 核对锁
驱动跑着的时候拿着锁文件 `<主检出>/.autoskills/run.lock`，里面是 `{pid, run, started_at}`。文件不在，就没有驱动。文件在，用 PowerShell 工具核对（project-resume 和 project-feedback 用的也是这一段）：

```powershell
$lockFile = '<主检出>\.autoskills\run.lock'
if (-not (Test-Path -LiteralPath $lockFile)) { 'no lock' } else {
  $lock = $null; $verdict = 'Unknown'
  try {
    $lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockFile | ConvertFrom-Json
    if (-not $lock -or -not $lock.pid) { throw 'the lock cannot be read' }
    $p = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -ne 'node') { $verdict = 'False' }
    elseif ($p.StartTime.ToUniversalTime() -le ([datetime]$lock.started_at).ToUniversalTime()) { $verdict = 'True' }
    else { $verdict = 'False' }
  } catch { $verdict = 'Unknown' }
  "run $($lock.run) started_at $($lock.started_at) pid $($lock.pid): driver alive $verdict"
}
```

- `driver alive True`：驱动在跑。
- `driver alive Unknown`：没读清楚（锁正在写，或者查不了那个进程）。过两秒再查；还是这样，就当成在跑，告诉用户锁读不清楚（这时没有运行名可报）。
- `driver alive False`：驱动已经不在了，这把锁是它被强行结束时留下的。进程活着、是 node、启动得不比 `started_at` 晚才算驱动，因为进程号会被别的进程再用上。
- `no lock`：没有驱动。

会话不自己删锁文件。用户说删，也先再核对一次：还是 `driver alive False` 才删；`True` 或 `Unknown` 时不删，告诉用户这把锁可能是活驱动的，删了会有两个驱动同时写账本。

## 1. 先收尾
- 项目契约不许在这个项目里起会话的，不起，照实告诉用户。
- 核对锁。`driver alive True` 或 `Unknown`：不起第二个；`True` 时告诉用户运行名和开始时间。`driver alive False` 的旧锁先不管，照常往下做：驱动起来时会自己接手进程已经不在了的锁。
- 手上做了一半的任务，提交到能接着做的地方，在 notes 里写清做到哪：驱动会先接着做 in_progress 的任务。驱动在主检出当前检出的分支上干活，这些提交要在这个分支上。
- 工作目录要干净：`git status --short` 里除了账本目录（`.claude/state/`）和 `.autoskills/` 下的，不能有别的。驱动复验时要求这样。有不是本会话留下的改动，不提交、不丢弃，也不起，交给用户。
- 没有能做的任务（没有 in_progress 的，也没有就绪的）就不起，照 project-next 的停点汇报。

## 2. 找驱动脚本
脚本是套件仓库里的 `scripts/autoskills.mjs`，没有部署到用户级。套件仓库的位置记在 SessionStart 钩子旁边的 `hook-config.json` 里（`kit_repo`）。用 PowerShell 工具读出来：

```powershell
$s = Get-Content -Raw -Encoding UTF8 -LiteralPath "$env:USERPROFILE\.claude\settings.json" | ConvertFrom-Json
$h = $s.hooks.SessionStart.hooks.args | Where-Object { $_ -like '*session-start.mjs' } | Select-Object -First 1
$kit = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path (Split-Path $h) 'hook-config.json') | ConvertFrom-Json).kit_repo
$script = Join-Path $kit 'scripts\autoskills.mjs'
"$script exists: $(Test-Path -LiteralPath $script)"
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

## 5. 在新窗口里起，等它拿到锁
用 PowerShell 工具，不用 Bash 工具。第一行填好，整段一次执行：

```powershell
$project = '<主检出>'; $script = '<脚本>'; $options = '<选项>'
$lockFile = Join-Path $project '.autoskills\run.lock'
$read = { if (Test-Path -LiteralPath $lockFile) { Get-Content -Raw -LiteralPath $lockFile -ErrorAction SilentlyContinue } else { '' } }
$before = & $read
Start-Process powershell.exe -ArgumentList '-NoProfile','-NoExit','-Command',"node '$script' run '$project' $options"
$now = $before
foreach ($i in 1..20) { Start-Sleep -Seconds 1; $now = & $read; if ($now -and $now -ne $before) { break } }
if (-not $now) { 'no lock' } elseif ($now -eq $before) { 'the lock did not change' } else { 'new lock' }
```

`<主检出>` 和 `<脚本>` 填绝对路径；没有选项时写 `$options = ''`。路径里本身有单引号的项目这样起不了，照实告诉用户。不要把 `run` 直接放在本会话里跑：前台会占住会话，后台起的进程会话一关就没了。

- `new lock`：驱动拿到锁了。再核对一次锁，`driver alive True` 就是起来了；`driver alive False` 或 `no lock`，是驱动刚拿到锁就停了，照下面 `no lock` 的两条看。
- `no lock`，而 `.autoskills/runs/` 下有刚建的运行目录：驱动起来又停了（比如没有能做的任务）。读那个目录里的 `report.md`，把原因告诉用户。
- `no lock`，也没有新的运行目录：驱动没起来，报错在新窗口里，请用户看一眼。不换别的办法再起。
- `the lock did not change`：起之前就有锁，这次起的驱动没有拿到它；它为什么没起来，以新窗口里那行报错为准。再核对一次锁：
  - `driver alive True` 或 `Unknown`：是另一个驱动在跑。照实告诉用户，什么都不删。
  - `driver alive False`：多半是旧锁挡住了。锁里的进程号被别的进程占着时，驱动自己只看那个号还在不在，会当成另一个驱动在跑而拒绝起。告诉用户；用户说删，就再核对一次，还是 `False` 才删掉这一个文件，然后重起一次。

## 6. 告诉用户，结束回合
- 运行名（锁里的 `run`）和报告的位置（`.autoskills/runs/<运行名>/report.md`，驱动停下时写好）。
- 怎么停：跟主会话说"停下长跑"，或者在那个窗口按一次 Ctrl+C（做完手上的任务后停；按两次立即停）。不要直接关那个窗口。
- 驱动停下以后说"继续"，主会话照 project-resume 接着做。

## 驱动还在跑的时候
核对锁的结果是 `driver alive True`（或者一直是 `Unknown`）的时候，本会话只读：不写账本，不改工作目录，不提交，不做任务。本会话起过长跑的，之后每次要写账本或改文件之前，先核对锁，不凭印象。
- 用户问进度：读账本（project-status）和 `git log`，不写。
- 用户说"停下长跑"：先核对锁。驱动在跑，就 `node '<脚本>' stop '<主检出>'`：它只在 `.autoskills/` 下放一个停止文件，驱动做完手上的任务后停。驱动不在，就告诉用户没有驱动在跑，不跑 `stop`。
- 用户要验收、改需求或快修：先停下驱动，等核对锁的结果不再是在跑再做。
