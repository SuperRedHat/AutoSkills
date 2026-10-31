@AGENTS.md

## Claude Code 专属
- 子代理只做只读的工作（调研、审查、分析）；带 agent_id 的账本写调用和 set_project_dir 会被守卫钩子拦下。
- 有风险的任务和里程碑，用 project-verifier 子代理按原始验收标准做独立校验，校验前不给它看实现者的成功总结。
- workflow 脚本给每个代理显式写 effort，不靠继承会话档位；提示词里的路径一律用绝对路径（代理继承主会话当前的 shell 目录）。
- ultracode 可用，但不作默认。
