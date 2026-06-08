# CouncilFlow

## 1. 产品名称
**CouncilFlow**

## 2. 产品定位
`CouncilFlow` 是一个 **CLI-first、本地优先、主控感知** 的多模型协作 sidecar 工具，给 Codex / Claude Code / Gemini CLI 用，主控感知 + 按需调用其他模型参与讨论、分工执行、结果收敛。

（§1-§30 保留 git 历史中的原文，摘要见 commits ef61ba1 及之前的 .claude/state/prd.md）

## 31. 变更记录（2026-04-20，工作流 token 效率优化轮）
0.1.3 发布。详见 git 历史 commits 26259e5 及之前。

## 32. 变更记录（2026-04-20，0.1.4 Claude Variant 路由补丁）
0.1.4 补齐 Claude 家族 variant 路径。详见 CHANGELOG [0.1.4]。

## 33. 变更记录（2026-04-20，0.1.5 Synthesizer artifact-first + Fallback typo 补丁）
0.1.5 修两个 0.1.3 起的结构性缺陷。详见 CHANGELOG [0.1.5] 与 docs/release-notes-0.1.5.md。

## 34. 变更记录（2026-04-21，0.1.6 `council discuss wait` + 恢复契约补丁）

0.1.5 发布后，用户在外部 SDL 项目（Gemini 主控）跑 `project-init` 时反复撞到 `council discuss` shell 超时。0.1.5 已修了 `council delegate` 的 fallback typo，但**discuss 这条路径从来没有对应的恢复机制**。

### 34.1 问题：discuss shell 超时 ↔ provider 总超时不匹配

- `council discuss` 是同步子进程，provider total timeout=7200s，真实多模型讨论常跑 3-10 分钟
- 主控 CLI 的 shell 命令超时层只有 3-4 分钟（Codex / Claude Code / Gemini 都这样）
- `council delegate` 有 `council delegation wait <id>` 做 shell 超时后的 2h 恢复路径
- **`council discuss` 没有对应子命令** —— 用户每次撞到超时都要手动 ls `.council/discuss/` 找产物

2026-04-20 跟 codex 走了一轮 discuss 收敛（disc_20260420T195908387651Z），结论：
- 方向正确（mirror `delegation wait` 模式）
- 但不能直接搬：discussion 启动即落 `record.json(status=running)`，`discuss wait` 完成判定必须是 `record.status=='completed'` **AND** `summary.md` 可读
- `discussion_id` 恢复路径用 `council status --json → state.last_discussion_id`，无需修改 discuss.py 的 stderr 行为

### 34.2 产品要求（0.1.6）

1. **新子命令 `council discuss wait <discussion_id> --timeout 7200 --poll-interval 30`**
   - 完成判定双条件：`record.status == "completed"` AND `summary.md` 可读
   - 退出码 + error_kind mirror `delegation wait`：`wait_timeout` / `discussion_not_found` / `record_corrupt` / `discussion_failed` / `summary_missing`
   - JSON 响应结构 mirror `delegation wait`
2. **不改 `council discuss` 的现有行为**：启动流程、emit 时机、prompt、收敛逻辑全部不动
3. **4 个 skill 协议同步**：`project-init` / `project-design` / `project-change` / `project-ask`
   - 协议补 "shell 超时 → `council status --json` 取 id → `council discuss wait <id>` → 读 summary.md" 两段式
   - AutoSkills + ~/.workflow-core/skills 两仓同步
4. **docs/integration.md** 新增 "Discuss wait (0.1.6+)" 小节，README 审计同步
5. **向后兼容硬红线**：
   - 0.1.5 配置 / 0.1.5 skill 在 0.1.6 下继续工作
   - 0.1.6 skill 在 0.1.5 CouncilFlow 下 wait 命令缺失需优雅降级（`command not found` 不中断 happy path）
   - 0.1.5 的 106 个历史 done 任务零回改

### 34.3 明确不涉及（0.1.6）

- 通用 `council wait <type> <id>` 抽象（codex 讨论建议延后）
- daemon / IPC 推送（过度设计）
- 改 `council discuss` 启动流程或 stderr 输出格式
- 任何 role 路由、变体、guardrail 行为变化

### 34.4 阶段 gate

TASK-110 milestone_manual + stage_gate=true：cf-0.1.6-smoke clean 项目跑"`council discuss` shell 超时模拟 + `council status --json` 取 id + `discuss wait` 拿 summary.md"完整链路；新子命令 7 个错误分类 e2e 验证。

本节补齐 §31.2 隐含承诺的"长任务恢复路径"在 discuss 这一边的能力缺口。
