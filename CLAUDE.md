@AGENTS.md

- 主控的会话在本仓库根目录启动，改代码时用绝对路径指向仓库根目录下的 .autoskills/dev/finish（workflow 代理继承主会话的 shell 目录）。手动窗口在各自的 worktree 里启动。
- 跑 tests/kit 用 Bash 工具（Git Bash），不用 PowerShell 工具；跑 deploy-kit.test.mjs 的时候不派子代理、不开 workflow，也没有别的窗口在干活。
- 本会话不改用户级。起 claude 子进程（探查、试跑）只在 `_private/eval` 的一次性测试仓库里；不复制凭据文件。
- 派子代理或开 workflow 时，每个代理显式写 model 和 effort，按任务分配：机械活用 haiku 或 sonnet、low 到 medium；读代码做调查用 sonnet、medium 到 high；高风险改动的独立审查用 opus、high；fable 只用在最难的一两处，不用 max（负责人 2026-11-11：额度有限）。
