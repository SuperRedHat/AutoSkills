# CouncilFlow 架构设计

## 1. 架构目标 / 核心原则 / 技术选型
（§1-§26 保留 git 历史原文，详见 commits 50e68be 及之前的 .claude/state/architecture.md）

## 27. 0.1.3 工作流 token 效率优化轮架构变更
详见 git 历史 commits 4109fd3~26259e5。

## 28. 0.1.4 Claude Variant 路由补丁架构变更
详见 CHANGELOG [0.1.4]。

## 29. 0.1.5 Synthesizer artifact-first + Fallback typo 补丁架构变更
详见 CHANGELOG [0.1.5]。

## 30. 变更记录（2026-04-21，0.1.6 `council discuss wait` 补丁）

### 30.1 改动面（最小）

| 模块 | 改动 |
|---|---|
| `src/councilflow/cli/discuss_wait.py`（新文件） | 实现 `council discuss wait <id>` 子命令；mirror `cli/delegation.py` 的 poll 骨架，但完成判定双条件 |
| `src/councilflow/cli/app.py` | 注册 `discuss wait` 子命令到 typer app |
| `tests/test_cli_discuss_wait.py`（新文件） | 7 场景：completed+summary / running / failed / summary_missing / record_corrupt / discussion_not_found / wait_timeout |
| 4 个 skill SKILL.md（两仓 × 4） | 协议补 shell-timeout 恢复路径 |
| `docs/integration.md` | 新增 "Discuss wait (0.1.6+)" 小节 |

### 30.2 关键设计决策

#### 30.2.1 完成判定为什么要双条件

现状：`discussion_orchestrator.py:93-139` 在 `run()` 开始时立即创建 `discussion_id` 并写 `record.json(status="running")`。这意味着：
- 不能像 `delegation wait` 那样 "record 出现即完成"
- 必须等 `record.status == "completed"`
- 但 record 状态更新和 summary.md 落盘存在写盘竞态，所以追加 "summary.md 可读" 作为第二条件

#### 30.2.2 为什么不改 `cli/discuss.py` 的 stderr 输出

audit 发现 `last_discussion_id` 在 `discussion_orchestrator.py:130` 立即写入 `state.json`。`council status --json` 已经能返回该字段，恢复路径完整。

不改 discuss.py 的 stderr 是为了：
- 避免脆弱的 stderr 解析依赖
- 不引入新的 emit 时机测试面
- 不影响其他依赖 stderr 静默的调用方

#### 30.2.3 错误分类映射

| `error_kind` | 触发 | 退出码 |
|---|---|---|
| `wait_timeout` | 超过 `--timeout` 秒 | 1 |
| `discussion_not_found` | `.council/discuss/<id>/` 不存在 | 1 |
| `record_corrupt` | `record.json` 存在但 JSON 解析失败 | 1 |
| `discussion_failed` | `record.status == "failed"` | 1 |
| `summary_missing` | `record.status == "completed"` 但 summary.md 不存在或不可读 | 1 |
| (success) | record.status=completed AND summary.md 可读 | 0 |

### 30.3 保持不变

- `council discuss` 主命令完全不变（启动、emit、prompt、收敛）
- `council delegation wait` 完全不变
- `discussion_orchestrator.run()` 内部流程完全不变
- `RoleMapping` / `RoleRoute` / `role_router` / `convergence_evaluator` 完全不变
- 所有 provider adapter 完全不变
- `PROTECTED_WORKFLOW_PATHS` / `--allow-workflow-state-write` 完全不变

### 30.4 契约对齐

`discuss wait` 与 `delegation wait` 的契约对齐表：

| 维度 | `delegation wait` | `discuss wait` (0.1.6+) |
|---|---|---|
| 默认超时 | 7200s | 7200s |
| 默认轮询间隔 | 30s | 30s |
| 完成条件 | `record.json` 存在且 status 已知 | record.status==completed AND summary.md 可读 |
| 失败处理 | exit 1 + error_kind | exit 1 + error_kind |
| 恢复路径 | `council status --json` → `state.last_delegation_id` | `council status --json` → `state.last_discussion_id` |

### 30.5 版本策略

**patch bump**（0.1.5 → 0.1.6）。理由：
- 仅新增子命令，无破坏性变化
- 无新协议、无新 CLI 全局参数、无新 config schema
- 0.1.5 配置零修改

CHANGELOG 主项：**Added** discuss wait 子命令；**Changed** 4 个 skill 协议补恢复路径

### 30.6 风险与缓解

1. **0.1.6 skill 在 0.1.5 CouncilFlow 下运行**：wait 子命令缺失会报 `command not found`。skill 协议必须把 wait 调用放在 happy path 之后的"超时恢复"分支里，确保 0.1.5 用户不升级 CouncilFlow 也能用新 skill 走老路径
2. **完成判定的写盘竞态**：record.status=completed 写完到 summary.md 落盘可能有微秒级窗口；轮询会自然处理（下一轮就拿到了）。测试覆盖 summary_missing 这条边

### 30.7 测试策略

- 新增 `tests/test_cli_discuss_wait.py` 覆盖 7 场景
- 现有 347 测试全绿不变
- 新增 ≥ 7 测试 → ≥ 354

本节不 supersede 任何前序架构，纯粹补齐 §27.x 的"长任务恢复"在 discuss 路径上的对称能力。
