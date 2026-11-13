@AGENTS.md

- 会话在本仓库根目录启动。改 P0 代码时用绝对路径指向仓库根目录下的 .autoskills/dev/p0（workflow 代理继承主会话的 shell 目录）。
- AS3-202 修好之前：跑 kit 全套用 Bash 工具（Git Bash），不用 PowerShell 工具；跑的时候不派子代理、不开 workflow。
- 本会话不改用户级。要在真实平台上测的，先用测试实例（含长期保留的受管实例 diag-p0；环境变量只传给子进程）；隔离不成立时交给临时测试档窗口（第 2 批只有串行诊断的 Codex 一段可能要用，见 AS3-344、AS3-357），由负责人在普通终端启动。
- 起 claude 或 codex 子进程（探针、最小自检、试点、诊断测量）只在 `_private/eval` 的一次性测试仓库或测试实例里；不复制凭据文件。
- 派子代理或开 workflow 时，每个代理显式写 model 和 effort，按任务分配：机械活用 haiku 或 sonnet、low 到 medium；读代码做调查用 sonnet、medium 到 high；高风险改动的独立审查用 opus、high；fable 只用在最难的一两处，不用 max（负责人 2026-11-11：额度有限）。
