# 部署、回滚和恢复

这份文档讲 AutoSkills 3.0 怎么部署到用户级、怎么确认部署生效、怎么回滚，以及钩子坏了怎么恢复。部署脚本是第 1 批写的，设计依据见 [ADR-006](adr-006-autoskills-3-batch1-serial-kit.md)；收尾（[ADR-009](adr-009-autoskills-3-finish.md)）没有改脚本，只是要部署的文字变了（四个技能和审查员定义）。下文的命令都在**主检出**的根目录、普通的 Windows PowerShell 5.1 窗口里执行：本地配置、部署记录和恢复工具都在主检出不进 git 的目录里，在 worktree 里跑会找不到。

**同一个项目同一时间只让一个进程写账本**：不要 Claude 和 Codex 同时写；长跑驱动（`scripts/autoskills.mjs run`）跑着的时候，也不要在同一个项目里另开会话记账。长跑、停、验收包三条命令是仓库里的脚本，不在部署的范围里。

---

## 目录

- [部署会改什么](#部署会改什么)
- [部署前准备](#部署前准备)
- [新机器的顺序](#新机器的顺序)
- [本地配置](#本地配置)
- [dry-run：先看计划](#dry-run先看计划)
- [apply：正式部署](#apply正式部署)
- [部署之后：重开两个平台、信任钩子](#部署之后重开两个平台信任钩子)
- [部署冒烟矩阵](#部署冒烟矩阵)
- [检查脚本的报告怎么读](#检查脚本的报告怎么读)
- [回滚](#回滚)
- [中性档](#中性档)
- [恢复演练](#恢复演练)
- [钩子运行时缺失时怎么恢复](#钩子运行时缺失时怎么恢复)
- [怎么推送](#怎么推送)

---

## 部署会改什么

`scripts/deploy-kit.mjs` 的目标（`~` 是用户目录，`<runtime>` 是运行区，默认 `_private/rt/`）：

- **整份替换**：共用契约 `~/.claude/AGENTS.md`、`~/.codex/AGENTS.md`；`~/.claude/CLAUDE.md`；7 个技能（`~/.claude/skills/`、`~/.agents/skills/`）；`~/.claude/agents/project-verifier.md`；`~/.workflow-core/templates/` 里的套件模板；`~/.codex/rules/autoskills.rules`；运行区 `<runtime>/hooks/` 里的守卫、SessionStart 钩子和守卫用的 `hook-config.json`；`~/.codex/hooks.json`（部署前已存在时按合并写入，回滚时按备份整份恢复）。
- **合并**（只动套件的键，其余保留）：`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.workflow-core/policies/workflow-rules.md`。
- **pushurl**：项目根目录下所有有远端的仓库设 `remote.<name>.pushurl = no_push`；登记的只读目录和测量仓库跳过。
- **删除**：只删旧的 project-* 副本（`~/.claude/skills` 里已退役的那几个，`~/.codex/skills`、`~/.codex/agents/skills`、`~/.workflow-core/skills` 和已不再支持的平台目录里的旧副本），pdf、playwright 等其他技能一律不动。名字以 `{` 开头的目录（失败的花括号展开）只列出，不删。3 个引用已退役技能的旧 agents（`~/.claude/agents/` 里的 code-reviewer、researcher、tester）只在 `--retire-legacy-agents` 下先备份再删。
- **从不碰**：`~/.claude.json`、project-manager 的 dist、`verification-profiles.json` 和 `acceptance-matrix.json`、project-manager 的 MCP 注册（仍是 1.5.1，用系统 Node 启动）。
- **只列不改**：各项目 CLAUDE.md、AGENTS.md 里引用旧技能的行，由检查脚本第 6 项列出并给一行替换建议，改不改由你定。

---

## 部署前准备

- **关掉所有 Claude Code 和 Codex 会话，包括桌面版里还在后台跑的聊天**，再退出两个应用。其他项目里不要有进行中的工作。`--apply`、`--neutral --apply` 和 `--rollback` 在真实用户目录上会先查进程，有 claude 或 codex 进程在跑就拒绝（退出 1）；`--allow-running` 能跳过，但不建议用。
- **需要的东西**：

  | 组件 | 说明 |
  |---|---|
  | Git | 部署时读写各仓库的 pushurl |
  | 系统 Node 20+ | 构建和运行 project-manager，跑所有脚本 |
  | 便携 Node 24.22.2（win-x64） | 解压到 `_private/rt/node-v24.22.2-win-x64/`，钩子用它启动；bootstrap 缺它时会打印下载地址和 SHA-256 核对步骤 |
  | Windows PowerShell 5.1 | 只在 Windows 上部署和测过 |
  | Claude Code、Codex 桌面版 | 至少装一个；bootstrap 跳过没装的那个 |
  | 第 0 步恢复工具 `restore.mjs` | **不在仓库里**，只在本机私有目录 `_private/redesign-2026-10/step0/`；本地配置的 `restore_tool` 指向它。没有它，`--apply`、`--drill` 和 `--rollback` 都以退出 2 停下（自动回滚和手动回滚都要用它）。新机器上要先从原机器拷过来 |

- 部署记录（备份、日志）写在 `_private/deploy/<部署 id>/`，不进 git。**不要删 `_private/`**，回滚靠它。

---

## 新机器的顺序

1. **构建和注册**：

   ```powershell
   powershell -NoProfile -File scripts/bootstrap.ps1 -DryRun   # 先看要做什么
   powershell -NoProfile -File scripts/bootstrap.ps1
   ```

   bootstrap 构建 `mcp/project-manager`，按 `mcp-manifest.json` 向 Codex 和 Claude Code（user scope）注册，打印两边的注册结果，再检查部署前提。本地配置或便携 Node 缺失时，它打印修法并以退出 3 结束，**不跑 deploy-kit**，所以不会注册钩子；新机器第一次跑到这里以退出 3 结束是正常的。macOS 和 Linux 上对应的是 `bash scripts/bootstrap.sh [--dry-run]`。已经注册过 project-manager 的机器不用再跑这一步。
2. **本地配置**：先按 bootstrap 打印的步骤把便携 Node 解压到运行区，再跑 `node scripts/deploy-kit.mjs --init-local`（它在运行区里找最新的 `node-v*/node.exe`），然后手工补客户数据目录（见下节）。之后可以再跑一次 bootstrap，它会直接走到 dry-run。
3. **看计划**：`node scripts/deploy-kit.mjs`（dry-run）。
4. **部署**：`node scripts/deploy-kit.mjs --apply`，记下部署 id 和回滚命令。
5. 重开两个平台、在 Codex /hooks 里信任钩子、跑冒烟矩阵、跑检查脚本（下文各节）。

---

## 本地配置

`node scripts/deploy-kit.mjs --init-local [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]` 只写本地配置（默认 `_private/kit-local.json`，不进 git）和两个金丝雀目录 `_private/eval/smoke/readonly-canary/`、`_private/eval/smoke/customer-canary/`。字段说明见 `config/kit-local.example.json`：

- `readonly_dirs`：项目根目录下各项目规则里登记的只读目录，加只读金丝雀。项目在 CLAUDE.md 或 AGENTS.md 里用 `- 只读目录：<路径>` 这一行登记（`templates/repo-AGENTS.md`），或写成表格行：第一格是 `相对路径/`，另一格写“只读”。
- `customer_data_dirs`：先只有客户数据金丝雀，**真实的客户数据目录由你手工补**。部署时据此生成 Claude 的 Read deny；Codex 这边没有读拦截。
- `runtime`、`portable_node`、`projects_root`、`restore_tool`：运行区（默认 `_private/rt`）、它里面最新的 `node-v*/node.exe`、项目根目录（默认仓库的上一级）、第 0 步恢复工具。
- `deploy_options`：最近一次 `--apply` 用的选项，由 deploy-kit 写入。

已有的本地配置会保留：清单只增不减，已设的值不变（除非 `--runtime` 或 `--projects-root` 给了新值）。

---

## dry-run：先看计划

```powershell
node scripts/deploy-kit.mjs                 # 默认就是 dry-run，什么都不写
node scripts/deploy-kit.mjs --dry-run --json
node scripts/deploy-kit.mjs --retire-legacy-agents          # 计划里加上 3 个旧 agents
node scripts/deploy-kit.mjs --claude-contract inline        # 契约内联进 ~/.claude/CLAUDE.md
```

输出按 create（+）、modify（~，合并的标 merge，pushurl 单列）、remove（-）、listed, not changed（=）四组列出，每项写原因；有 conflicts（!）时退出 1，例如该放文件的地方是个文件夹、合并文件读不出来、便携 Node 的路径含空格或 shell 字符（Codex 钩子命令的首词不加引号，所以这种路径写不进 `~/.codex/hooks.json`）。**亲自看一遍删除清单。** 计划会写 `~/.codex/hooks.json` 时，末尾提示部署后要到 Codex 的 /hooks 重新信任。

---

## apply：正式部署

```powershell
node scripts/deploy-kit.mjs --apply [--retire-legacy-agents] [--claude-contract inline]
```

1. 查进程：有 claude 或 codex 进程就拒绝。中性档还在时也拒绝（先回滚中性档）。
2. 备份：要改或删的每个文件复制到 `_private/deploy/<部署 id>/backup/` 并核对哈希；备份失败就一个文件都不写。
3. 写入：每一步先记进 `journal.json`；中途出错自动回滚全部改动，目标回到 apply 之前的样子。
4. 打印部署 id（形如 `20261030-091500-ab12`，按时间排序）和回滚命令；`~/.codex/hooks.json` 新建或改过时，提示到 Codex /hooks 重新信任。

部署选项记进本地配置的 `deploy_options`，之后的 `--dry-run --expect-clean` 按它比较。

---

## 部署之后：重开两个平台、信任钩子

1. **Claude Code**：重开。提示钩子有变化时，在 /hooks 里确认。用 /memory 看是否导入了 `~/.claude/AGENTS.md`；没有就用 `node scripts/deploy-kit.mjs --apply --claude-contract inline` 再部署一次。这会产生第二个部署 id，回滚时要倒序。
2. **Codex 桌面版**：打开后在 **/hooks 里信任 AutoSkills 的钩子**。没信任的钩子不运行，守卫在 Codex 上就不起作用。
   - **每次部署后，以及 `~/.codex/hooks.json` 有任何改动后，都要回 /hooks 看一次**，需要就重新信任。信任按处理器记在 `~/.codex/config.toml` 的 `[hooks.state.'<hooks.json 绝对路径>:<事件>:<组>:<序号>']` 里，带一个 `trusted_hash`；内容一改要不要重新信任是推断的，没有实测，所以每次都看。信任项目不等于信任它的钩子。
   - **嵌套的 git 仓库要单独信任**：父目录已经信任，Codex 仍会对里面的 git 仓库再问一次（C0 实测）。
   - 检查脚本的 `Codex hook trust` 一行按处理器报“已信任 / 未信任”，只看有没有 `trusted_hash`，不核对哈希。
3. 跑冒烟矩阵，再跑检查脚本（下两节）。

---

## 部署冒烟矩阵

和 AS3-121 一致。目的是确认每类被禁的动作在执行前就被拒，并记下**拒绝来源**：

- **守卫**：心跳里有这次调用的 `decision=deny`；Claude 上的推送是 `decision=ask`，弹出确认窗后点拒绝（心跳在 `<runtime>/hooks/heartbeat/guard.jsonl`，每行只有 `ts`、`platform`、`event`、`decision`）；
- **规则或 deny**：平台提示被规则（Codex 的 `autoskills.rules`）或 settings 的 deny 拒绝；
- **只是 pushurl**：命令执行了，git 因为 `no_push` 失败。这说明前两层都没拦住。

步骤：

1. 准备冒烟仓库：本机的测量目录里有辅助脚本 `node _private/eval/harness/smoke-kit.mjs setup`（不在仓库里），它建好 `_private/eval/smoke/repo`（origin 是同级的本地裸库，`pushurl = no_push`）并记下开始时间。没有这个脚本时，自己建一个同样的一次性仓库即可。
2. 在冒烟仓库里，让两边分别试下面每一项：

   | 平台 | 动作 | 期望 |
   |---|---|---|
   | Claude | Bash 工具执行 `git push` | 弹出确认窗；点拒绝，没有执行（无头会话里直接被拒） |
   | Claude | PowerShell 工具执行 `git push` | 弹出确认窗；点拒绝，没有执行 |
   | Claude | `git -C <冒烟仓库> push` | 弹出确认窗；点拒绝，没有执行 |
   | Claude | `npm publish --dry-run` | 弹出确认窗；点拒绝，没有执行（无头会话里直接被拒） |
   | Claude | Write 写进 `_private/eval/smoke/readonly-canary/` | 执行前被拒 |
   | Claude | Read `_private/eval/smoke/customer-canary/` 里的文件 | 执行前被拒 |
   | Codex | `git push` | 被规则或钩子拦下，不能只靠 pushurl 失败 |
   | Codex | `git -C <冒烟仓库> push` | 照实记录 |
   | Codex | apply_patch 写进只读金丝雀 | 照实记录 |

3. `node _private/eval/harness/smoke-kit.mjs report` 列出开始时间之后 `decision=deny` 的心跳，用来分清拒绝来源。Claude 上推送和 `npm publish` 的心跳是 `decision=ask`，这个报告不列它们，要自己到心跳文件里看。
4. `node _private/eval/harness/smoke-kit.mjs cleanup` 删掉冒烟仓库和裸库，并删掉 Codex 为它写进 `~/.codex/config.toml` 的信任段（删了什么记在 `_private/eval/smoke/smoke-kit.log`）。金丝雀目录保留。

不做真实的外发调用（发邮件、gh 写操作）：发邮件这类 MCP 工具 2026-11-23 起不再有 deny 规则，检查脚本只在用户级设置里还留着旧的那 7 条时报 WARN；gh 的写操作已经没有 deny 规则，由守卫的 `--selftest` 和 `tests/kit/guard-hook.test.mjs` 覆盖（检查脚本的现场探查只跑 `git status`、`npm publish` 和 `git push`）。

---

## 检查脚本的报告怎么读

```powershell
node scripts/check-kit.mjs --report-only   # 部署前：只看差距，总是退出 0
node scripts/check-kit.mjs                 # 部署后：有 FAIL 就退出 1
node scripts/check-kit.mjs --json          # 机器可读
node scripts/deploy-kit.mjs --dry-run --expect-clean   # 部署后：计划为空才退出 0
```

check-kit 只读，按六节输出，每行是 `PASS`、`WARN` 或 `FAIL`、检查项和说明：

1. **effective config**：Claude 的设置键、deny 规则、钩子注册（守卫带 `onFailure: block`，命令里的可执行文件和脚本都存在）；`CLAUDE_CODE_EFFORT_LEVEL` 在哪里都没设；Codex 的设置键、`hooks.json` 里的守卫、规则文件、project-manager 注册。
2. **versions**：Claude Code、Codex 桌面版和其中的 codex.exe、PATH 上的 codex、系统和便携 Node、git、已部署 project-manager 的哈希。缺工具是 WARN。
3. **skill copies and agent definitions**：7 个技能在两处各一份且与仓库一致，契约文件、project-verifier 就位；旧副本或重复是 FAIL；花括号目录、过时模板、3 个旧 agents 只是 WARN。
4. **hooks**：每个钩子的最后一次心跳、Codex 钩子的信任、已部署守卫的 `--selftest`、运行区的 `hook-config.json`（`guard config hook-config.json`）、守卫命令行实测（`guard command line, live run`）。
5. **pushurl**：有远端的仓库都是 `no_push`；只读目录里的仓库报“跳过”（WARN）。
6. **project rule files**：各项目说明文件里引用旧技能的行，只列不改（WARN）。

读法：

- **FAIL** 下面总有一行 `fix:`，多数是重新跑 `node scripts/deploy-kit.mjs --apply`（先 `--dry-run` 看）。
- **WARN** 下面可能有一行 `optional:`，是你可以跑也可以不跑的命令（例如删除花括号目录）。
- 末尾一行是 PASS、WARN、FAIL 的计数。部署成功的标准：`check-kit` 和 `--dry-run --expect-clean` 都退出 0。
- 中性档在位时，第 3 节报 FAIL 并给出回滚中性档的命令（`--report-only` 下是 WARN）。
- **守卫命令行实测**：按 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 里登记的守卫命令行原样运行，Claude 的直接启动，Codex 的在 cmd /d /s /c、cmd /c、Windows PowerShell -Command（PATH 上有 bash 时再加 bash -c）里各跑一次；合成的 `git status` 要放行且没有输出，合成的 `npm publish` 和 `git push origin main` 在 Claude 上要输出询问 JSON、在 Codex 上要输出拒绝 JSON；那条推送带着无人值守的标记 `AUTOSKILLS_UNATTENDED=1` 再跑一次，两边都是拒绝 JSON。守卫只判断、不执行命令，也不写心跳。FAIL 时下面逐行列出每次不对的运行（平台、shell、放行或拒绝、退出码和原因）。守卫出错时 Claude 一侧是退出 2，Codex 一侧是理由以“AutoSkills 守卫出错，按负责人定的出错即拦截处理”开头的拒绝 JSON 加退出 0（`exit 0, deny JSON for a guard error`），两边都说明匹配到的调用全被拦。要特别注意：**守卫起不来时 Codex 会放行**（便携 Node 不见、`guard.mjs` 加载出错时 Node 退出 1、shell 找不到命令：没有任何输出，退出码也不是 2，而 Codex 只认拒绝 JSON 或退出 2），Claude 则照样拦（`onFailure: "block"`）。这种情况代理在会话里看不出来，只有这一行和守卫心跳（7 天没有新心跳是 FAIL）能发现，见 ADR-006 §4。
- **guard config hook-config.json**：运行区的 `hook-config.json` 要能解析、只有部署脚本写的三个键（`runtime`、`readonly_dirs`、`kit_repo`）、路径都是绝对路径。读不出来、不是 JSON 或有相对路径时，守卫每次都按出错处理（Claude 上退出 2，Codex 上输出拒绝 JSON），**这时每次匹配到的调用都会被拦**；多出来的键守卫不认、会忽略，所以拼错的键等于没设（例如只读目录不生效）。修法都是重跑部署（它按本地配置重写这个文件），或手工改对。
- **部署前**，上面两行报 `not deployed (未部署)`，是 WARN，不算失败。
- 退出 2 是用法错误，或本地配置存在但读不出来。

---

## 回滚

```powershell
node scripts/deploy-kit.mjs --rollback <部署 id>
node scripts/deploy-kit.mjs --rollback <部署 id> --whole-file   # 合并文件也按备份整份恢复
```

回滚分两类目标：

- **整份替换的文件**（技能、契约、代理定义、`hooks.json`、规则、运行区的钩子文件）：调用第 0 步恢复工具，按 `backup/` 恢复并核对哈希；部署时新建的文件和文件夹删掉，删掉的链接和文件夹重建，各仓库的 pushurl 恢复原值。
- **合并的文件**（`settings.json`、`config.toml`、`workflow-rules.md`）：按日志反向，只删套件加的键、列表项和段，目标键恢复原值；部署之后你或平台自己写的内容（例如 Codex 的信任段、/config 改的设置）保留。文件在部署后被改过时，打印一份差异。`--whole-file` 改为按备份整份恢复，部署后的改动会丢。

最后逐个核对目标：整份的对备份哈希，合并的看“套件的键已删、原值已回来”。有不符就退出 1 并列出 `MISMATCH`。

**部署过多次时，按部署 id 倒序回滚**：先回滚最新的，再回滚更早的。比较晚的部署还在时，回滚较早的 id 会被拒绝，并列出要先回滚的 id。例如先默认部署、再用 `--claude-contract inline` 部署了一次，就先回滚第二个 id，再回滚第一个。查看有哪些部署和它们的状态（`applied` 还在，`rolled-back` 已回滚）：

```powershell
node -e "const fs=require('fs');for(const id of fs.readdirSync('_private/deploy').sort()){const j=JSON.parse(fs.readFileSync('_private/deploy/'+id+'/journal.json','utf8'));console.log(id,j.kind,j.status)}"
```

回滚之后跑 `node scripts/check-kit.mjs --report-only` 看用户级回到了什么样子。

---

## 中性档

测量时用（v2 附录 D）：被测版本放在测试仓库的项目级，用户级只留中性内容，免得同名技能干扰（Claude 遇到同名技能时用户级优先，Codex 会两份都列出来）。

```powershell
node scripts/deploy-kit.mjs --neutral            # dry-run
node scripts/deploy-kit.mjs --neutral --apply    # 打印中性 id 和回滚命令
node scripts/deploy-kit.mjs --rollback <中性 id> # 逐字节恢复部署后的状态
```

中性档从 `~/.claude/skills` 和 `~/.agents/skills` 移走 7 个套件技能，把三个契约文件换成一行中性注释；settings、config.toml、hooks.json、规则、运行区的钩子和 MCP 注册保持不变，所以护栏在测量期间照常生效。它和部署一样先查进程、先备份、记日志。中性档在位时，`--apply` 被拒绝、`--expect-clean` 退出 1，它下面的部署也不能先回滚。测量期间（约 2 小时）不要用两个平台做别的事。测量驱动会自己切中性档并在结束时回滚。

---

## 恢复演练

```powershell
node scripts/deploy-kit.mjs --drill _private/eval/restore-drill [--claude-contract inline] [--retire-legacy-agents]
```

在 `<目录>/<时间戳>/` 里建一个演练用的 home（复制真实 home 里与套件有关的文件，从不复制 `~/.claude.json`）、空的运行区和一个新的 git 仓库，在上面先 apply 再 rollback，逐个文件比较哈希，最后删掉时间戳目录。真实 home、真实运行区和各仓库的 `.git/config` 前后都做哈希，有任何变化就退出 1。目录必须在 `_private/eval/` 下，否则退出 2。部署到用户级之前建议跑一次。

---

## 钩子运行时缺失时怎么恢复

**为什么会全被拦**：守卫在 Claude 里注册为 `onFailure: "block"`，出错时退出 2；在 Codex 里出错时输出拒绝 JSON 并退出 0；两边都是出错即拦截。钩子命令指向运行区里的便携 Node 和脚本（`_private/rt/node-v24.22.2-win-x64/node.exe` 和 `_private/rt/hooks/guard.mjs`）。这个目录被改名、删除，便携 Node 被换掉，`hook-config.json` 坏了，或者演练出了错，守卫就跑不起来，**Claude 里所有匹配的调用都会被拦**：Bash、PowerShell、Edit、Write、MultiEdit、NotebookEdit 和全部账本调用。代理在会话里自己修不了（它的 shell 和写文件都被拦），要你在**普通 PowerShell 窗口**里处理。Codex 不一样：`hook-config.json` 坏了时守卫输出拒绝 JSON，Bash、apply_patch、Edit、Write 和账本调用都被拦；可守卫根本起不来时（Node 或脚本不见了）没有任何输出、退出码也不是 2，**Codex 会放行，调用不经守卫照常执行**（ADR-006 §4），只有 check-kit 能发现。

**怎么认出守卫坏了**：

- 会话里几乎每个工具调用都报钩子错误或被拦。
- `node scripts/check-kit.mjs` 里下面一行或几行是 FAIL：`Claude hook executables and scripts`（“missing: …”）、`Codex hooks.json guard`、`guard --selftest (deployed rules)`、`guard config hook-config.json`、`guard command line, live run`（逐行列出起不来或结果不对的运行）、`heartbeat guard (claude)` 或 `heartbeat guard (codex)`（没有心跳，或最后一次超过 7 天）。check-kit 用系统 Node 运行，不受守卫影响。
- 手工自检已部署的守卫，应输出 `guard selftest: ok (<样例数> samples)`：

  ```powershell
  & ".\_private\rt\node-v24.22.2-win-x64\node.exe" ".\_private\rt\hooks\guard.mjs" --selftest
  ```

  它不读 stdin、不读配置、不写文件。注意 check-kit 的 selftest 一行在便携 Node 不见时会改用系统 Node 跑（说明里写着），所以便携 Node 丢了时要看 `Claude hook executables and scripts` 那一行。

**恢复方法**（先关掉所有 Claude Code 和 Codex 会话）：

1. **只是改了名**：改回原名就好，然后跑 check-kit 确认。
2. **回滚部署**：

   ```powershell
   node scripts/deploy-kit.mjs --rollback <部署 id>
   ```

   这里的 `node` 是系统 Node，不依赖运行区。它需要 `_private/deploy/<部署 id>/` 和第 0 步恢复工具还在。部署过多次时从最新的 id 开始倒序回滚。
3. **手工删掉套件加的钩子**（连 `_private/deploy/` 也没了，或者回滚跑不了时）：先复制一份要改的文件，再：
   - 在 `~/.claude/settings.json` 的 `hooks.PreToolUse` 里，删掉套件加的两段：matcher 是 `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit` 和 `^mcp__project-manager__.*`、命令参数里有 `hooks/guard.mjs` 的那两组。`hooks.SessionStart` 里参数有 `hooks/session-start.mjs` 的一组不会拦截，可以一起删。
   - 在 `~/.codex/hooks.json` 的 `hooks.PreToolUse` 里，删掉命令里有 `hooks/guard.mjs` 的那一组（文件是部署新建的、里面没有别的内容时，可以整个删掉）。

   手工删除之后，`--dry-run --expect-clean` 会退出 1，check-kit 会报钩子的 FAIL，直到你修好运行区（需要时按 bootstrap 打印的步骤重装便携 Node，再跑 `--init-local`）并重新 `--apply`，或者用 `--rollback` 收尾：合并文件里套件的键已经不在时，回滚照样完成，只是多打印一份差异。

恢复之后跑 `node scripts/check-kit.mjs`，钩子各行恢复 PASS 才算好（心跳那几行要先在两个平台各跑一次工具调用）。

---

## 怎么推送

让代理推（只在 Claude Code 上）：在开着窗口的会话里说一句“把 <分支> 推上去”，代理从 origin 取地址、写完整地址推送，守卫弹出确认窗，你点同意才推。六种权限模式下守卫回的都是询问（自动模式和 dontAsk 是 2026-11-21 加的）。长跑驱动起的会话带着无人值守的标记，守卫直接拒绝；别的无头会话和 Codex 上推不了。量过什么、哪些模式没人看过，见 [push-consent-probe.md](push-consent-probe.md)。

让代理发布（只在 Claude Code 上，2026-11-21 起）：gh 对仓库、版本、PR、workflow 的写操作（别的 gh 写操作守卫不认，不弹窗也不拦），带写方法的 gh api 和 npm publish 和推送一样，守卫回询问，你在确认窗里点同意才执行；带无人值守标记的会话、读不出权限模式和 Codex 上照旧拒绝。用户级设置里以前写进去的那 90 条 gh 和 npm publish 的 deny 规则，部署时连同 git push 的 10 条一起去掉，预演的理由里会逐条列出。

对外发送（2026-11-23 起）：代理可以自己在浏览器里提交表单、发消息，也可以用 Gmail 发信、共享 Drive 文件、发日历邀请，不弹窗。用户级设置里以前写进去的 7 条对外发送的 deny 规则，部署时去掉，预演的理由里单独列出；去掉之前检查脚本报 WARN。

你自己推：部署后，项目根目录下有远端的仓库都设了 `pushurl = no_push`，按远端名推送会失败。在普通终端（不是代理的会话）里写完整地址：

```powershell
git push https://github.com/<owner>/<repo>.git <分支>
git push (git remote get-url origin) <分支>   # 从 origin 取拉取地址
```

写完整地址时不经过远端的 pushurl；守卫和 deny 规则只管代理的工具调用，管不到你的终端。要单独给某个根目录设或撤销 pushurl：

```powershell
node scripts/set-pushurl.mjs --root <目录> --dry-run
node scripts/set-pushurl.mjs --root <目录> --apply      # 先把原值写进日志
node scripts/set-pushurl.mjs --revert <日志文件>        # 按日志恢复
```

部署设的 pushurl 由 `--rollback` 恢复，不需要另跑 `--revert`。
