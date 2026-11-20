# 守卫回“询问”时 Claude Code 怎么表现：探查记录（AS3-378）

2026-11-20，在一次性测试仓库上做。目的是给“推送要负责人点同意”定守卫的做法：守卫见到 `git push` 不再回拒绝，改回“询问”（`permissionDecision: "ask"`），由负责人在弹窗里点。

主控量的是**无头会话**（`claude -p`）。交互式会话里弹不弹窗，只有坐在窗口前的人看得到：负责人看了一种模式，记在“负责人在交互式会话里看到的”一节。

## 结论

- 无头会话里，钩子回“询问”的那次调用**没有执行**，六种权限模式都一样，跳过权限的模式也一样。
- 被拦下的调用，会话拿到的工具结果就是钩子写的理由；结果记录的 `permission_denials` 里有这一次。
- 钩子的输入里有 `permission_mode` 字段，六种模式各自如实带着。守卫可以按它分别处理。
- 设置里的 deny 规则先于钩子的“询问”：两样都命中时，调用被规则拒绝，理由是规则的那一句，不是钩子的。所以用户级设置里 `git push` 的 deny 规则不去掉，就弹不了窗。

## 怎么做的

- 测试仓库是评测夹具的一份新副本，在 `_private/eval` 下。项目级的 `.claude/settings.json` 里登记了一个 PreToolUse 钩子，只管 Bash 和 PowerShell。
- 钩子是个小脚本：把每次收到的输入记一行；命令里带标记 `ask-probe-marker` 或 `deny-rule-marker` 时回“询问”，别的不回。
- 用的是无害的替身命令 `echo ask-probe-marker`，不是 `git push`：用户级现在的守卫见到 `git push` 会先拒绝，几个钩子的结论里拒绝优先。
- 同一个设置文件里另有一条 deny 规则 `Bash(echo deny-rule-marker*)`，用来看规则和钩子谁先。
- 每个会话只听到一句话：用 Bash 运行这条命令一次，被拒绝就照实说，不换写法再试。模型是 claude-haiku-5-5、档位 low。量的是命令行工具的行为，和模型无关。
- 命令行工具的版本是 2.1.329。

## 量到的

| 权限模式 | 钩子回的 | 命令执行了吗 | 会话拿到的工具结果 | `permission_denials` |
|---|---|---|---|---|
| default | 询问 | 没有 | 钩子的理由 | 1 条 |
| acceptEdits | 询问 | 没有 | 钩子的理由 | 1 条 |
| auto | 询问 | 没有 | 钩子的理由 | 1 条 |
| bypassPermissions | 询问 | 没有 | 钩子的理由 | 1 条 |
| dontAsk | 询问 | 没有 | 钩子的理由 | 1 条 |
| plan | 询问 | 没有 | 钩子的理由 | 1 条 |
| auto，命令同时命中 deny 规则 | 询问 | 没有 | 规则的拒绝：“Permission to use Bash with command … has been denied.” | 1 条 |

- 七个会话各只调了一次工具，没有换写法重试。
- 前六个会话的原始输出里都有 `permission_denied` 这条系统记录；命中 deny 规则的那一个没有这条记录，但 `permission_denials` 里同样有。
- 钩子每次收到的输入里有这些字段：`session_id`、`transcript_path`、`cwd`、`prompt_id`、`permission_mode`、`effort`、`hook_event_name`、`tool_name`、`tool_use_id`，加上 `tool_input`。
- 七个会话共用 518,875 token，命令行报 0.111 美元。

## 文档里查到、没有自己量的

这些是查官方文档得到的说法，只当线索：

- 交互式会话里，钩子回“询问”会弹出确认窗，钩子写的理由显示在窗里。
- 自动模式下，钩子的“询问”通常会送到确认窗，不由分类器定。“通常”指什么，文档没有说。
- 跳过权限的模式下钩子的“询问”还弹不弹，文档没有写（负责人后来看到是弹的，见下面）。
- 几个钩子结论不同时，拒绝优先于询问，询问优先于放行。
- Codex 的钩子不支持“询问”：回了会被当成钩子出错，调用照常执行。所以 Codex 上只能照旧回拒绝。

## 负责人在交互式会话里看到的（2026-11-21）

负责人在同一个测试仓库里开了一个交互式会话，说了那句话。钩子的日志记下两次调用，权限模式都是 bypassPermissions，钩子回的都是询问。他看到的是：

- 弹出了确认窗，窗里有 “Hook PreToolUse:Bash requires confirmation for this command” 和钩子写的那句理由，选项是 Yes 和 No。
- 点 Yes 以后命令执行了，输出 `ask-probe-marker`。

所以开着窗口的跳过权限模式下，钩子的询问会弹窗。负责人据此定了：这个模式下推送也弹窗，不照旧拒绝。

守卫现在回询问的模式是 default、acceptEdits、plan 和 bypassPermissions。四种里只有 bypassPermissions 有人看过；另外三种是每个提示都由人回答的模式，按这一点当成会弹。auto 没有放进去：那个模式里是分类器替人回答提示，文档只说钩子的询问“通常”会送到确认窗。等有人在交互式的 auto 会话里看过再定。

## 没有量到的

- **交互式的 default、acceptEdits、plan、auto 四种模式。** 没有人看过。前三种守卫已经回询问，auto 回拒绝。
- **点 No 以后。** 负责人那一次点的是 Yes。点 No 以后命令是不是确实没有执行，留到验收时看。
- **设置里的 allow 规则会不会盖过钩子的“询问”。** 没有量。
- **PowerShell 工具。** 七次都是 Bash 工具。钩子对两个工具都登记了，PowerShell 那一边没有触发过。

## 还可以接着看的

测试仓库和钩子都留着。要看别的模式（比如 auto），在那个仓库里用那种模式开一个交互式会话，说一句“用 Bash 运行 echo ask-probe-marker”，看有没有确认窗、窗里有没有钩子写的那句理由；点同意以后命令有没有执行。常用的权限模式各试一次。位置和结果记在账本 AS3-381 里。

## 证据在哪

都在主检出不进 git 的目录里。

| 东西 | 位置 |
|---|---|
| 七个会话的原始输出和摘要 | `.autoskills/runs/as3-378/` 下的 `ask-<模式>.*`、`denyrule-auto.*` |
| 逐个会话的读数（命令执行没有、工具结果、拒绝记录、钩子看到的输入） | 同一目录的 `01-results.log`，由 `read-results.mjs` 读出 |
| 钩子脚本、设置文件和钩子自己记的输入 | 测试仓库 `_private/eval/push-consent-probe/pc1/repo/.claude/` 下的 `ask-hook.mjs`、`settings.json`、`ask-hook.log` |
