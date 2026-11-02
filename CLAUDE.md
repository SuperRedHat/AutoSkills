@AGENTS.md

- 会话在本仓库根目录启动。改 P0 代码时用绝对路径指向仓库根目录下的 .autoskills/dev/p0（workflow 代理继承主会话的 shell 目录）。
- AS3-202 修好之前：跑 kit 全套用 Bash 工具（Git Bash），不用 PowerShell 工具；跑的时候不派子代理、不开 workflow。
- 本会话不改用户级。要在真实平台上测的，先用测试实例（环境变量只传给子进程）；隔离不成立时交给临时测试档窗口（AS3-280；诊断测量回退时另开 manual 任务），由负责人在普通终端启动。
- 起 claude 或 codex 子进程（探针、诊断测量）只在 `_private/eval` 的一次性测试仓库或测试实例里；不复制凭据文件。
