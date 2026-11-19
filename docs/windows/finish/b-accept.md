# 窗口 B：验收包（块名 b，任务 AS3-366）

你在一个手动并行的窗口里，只做这一块。先读 `docs/windows/finish/README.md`（共用的约定，每一条都适用），再读设计页的第 3 节（`../../../_private/redesign-2026-10/b3/finish-line-design-2026-11-19.md`）。

## 要做成什么

`node scripts/autoskills.mjs accept <项目目录> [选项]`：读项目的账本，把等负责人验收的任务排成一页 HTML，写到项目里，打印路径。不起会话，不花 token，不写账本。

负责人拿这一页做两件事：一眼看清有哪些在等他、先看哪个；照着页面逐个检查，然后回一句话批量通过或驳回。

你的文件：`scripts/lib/accept/` 下的全部（`cli.mjs` 现在是占位，换掉它；导出的 `acceptCommand` 和它的形式不变）、`tests/kit/autoskills-accept.test.mjs`、`docs/accept.md`。

## 行为（验收标准）

**输入**

- 读账本只走 `scripts/lib/ledger-read.mjs`：`readLedger`、`awaitingAcceptance`、`unblockedBy`、`requiresManualAcceptance`。
- 驱动复验的结果用 `scripts/lib/run-paths.mjs` 的 `latestVerify(项目, 任务号)` 取（没有就是 null）；有没有长跑在跑用 `readLock(项目)` 看（`alive` 为真才算）。

**输出**

- 页面写到 `acceptanceDir(项目)` 下，文件名是 `stampOf()` 加 `.html`；`--out <文件>` 可以改位置。路径打印在标准输出上，单独一行。
- 没有待验收的任务：照样出页面，写明“没有等你验收的任务”，退出 0。
- 项目没有账本：标准错误上说明，退出 1。用法错误退出 2。带 `--help` 时打印用法并退出 0。

**页面内容**

- 页首：项目目录的名字、生成时间、待验收的个数；一句可以直接回的例子，例子里点名任务，比如“T3.5、T3.8 通过”和“T3.6 驳回：<原因>”（不点名的“都通过”验收技能不认）。
- 有长跑在跑时，页首有一行提示：先停下长跑再验收（两边同时写账本会丢更新）。
- 任务按模块分组。排序：门禁任务（`stage_gate` 为真）在前；其次按“通过后能放开几个任务”（`unblockedBy` 的个数）从多到少；再按账本里的先后。组的先后看组里排最前的那个任务。
- 每个任务一块：
  - 任务号、标题；是门禁任务就标出来；
  - 驱动复验的结果：通过、没过（标出“建议驳回”，列出没过的命令和日志位置）、或者“没有复验记录”；
  - 验收标准（逐条）；
  - 检查清单（逐条；第一条是风险那一行）；
  - 备注原文（里面有提交号、证据位置、假设）；
  - 通过后能放开的任务（任务号和标题）。
- 页面是自包含的一个文件：不引用任何外部资源，不需要脚本也能看全。任务里的文字一律转义，尖括号和引号不会变成标签或属性。
- 页面文字用中文，适合打开就读：有标题层级，跟随浏览器的深浅色，窄屏不出横向滚动条（宽表格在自己的容器里滚）。

**测试**

`tests/kit/autoskills-accept.test.mjs`，账本都是临时目录里造的：

- 分组和排序（门禁在前、放开的多的在前、同分按先后）；
- 转义（标题、备注、验收标准里带尖括号、引号、`&`）；
- 没有待验收；没有账本；
- 有复验记录（通过的、没过的）和没有记录；
- 有活着的锁和没有锁；
- `--out`、`--help`、用法错误的退出码；
- 页面里没有 `http://`、`https://` 开头的引用。

**给负责人的用法**：`docs/accept.md`（中文）：命令怎么敲、页面怎么读、看完怎么回、长跑在跑时为什么先停。

## 自测

```
node --test tests/kit/autoskills-accept.test.mjs
node --test tests/kit/autoskills-cli.test.mjs
node --test tests/kit/ledger-read.test.mjs
node scripts/lint-kit.mjs --check all
```

做完的标记：最后一个提交的说明末尾加一行 `AutoSkills-Done: b`。
