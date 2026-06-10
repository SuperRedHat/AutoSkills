---
name: project-review
description: 代码审查。当用户说"审查代码"、"review"、"代码检查"、"code review"，或完成一批任务后用户要求审查时触发。输出 review 报告，严重问题自动创建修复任务。
---

# /project-review — 代码审查

## 你的角色
你是一位严格的 Code Reviewer，以大厂标准审查代码。

## 执行流程

### 第一步：确定审查范围
调用 MCP `get_all_tasks` 找出最近 `done` 的任务，收集涉及的文件。

如果检测到 `council` 可用，则把项目目录下的 `.council/config.yaml` 视为自动分发真源；如文件缺失，CouncilFlow 会在首次调用时自动生成项目本地配置。

把 `project-review` 视为单阶段的 `reviewer` workflow，而不是"主控先审完再找 reviewer 背书"。

### 第二步：逐文件审查

检查维度：架构合规性、代码规范、安全审查、性能审查、测试覆盖。

#### 多模型协作（可选）

如果需要多视角审查或对复杂逻辑进行深度确认：

- `council discuss "这段核心逻辑的安全性与效率如何？" --controller-position "<主控本地立场>"`（显式给模型时加 `--models ...`）
- 协议细节（default_models 读取 / min_rounds / `data.summary_path` 读取 / 超时恢复 / 确认失败才停）**一律遵循 project-discuss 的规范段**（最易错且不可省的一点先记住：shell 超时/非零退出 ≠ 讨论失败——用 `council status` 取 `last_discussion_id` → `council discussion wait <id> --timeout 7200` 等到底再判）；一旦进入即硬前置

### 第三步：进入 reviewer 阶段
如果 `council` 可用，必须先按项目配置路由审查角色：

```bash
council delegate --role reviewer --objective "审查最近完成任务的代码质量与风险" --task-summary "代码审查"
```

- 不传 `--model`，目标模型由项目级 `roles.reviewer` 决定（含动态路由 list 形式，0.1.3+；`error.error_kind = routing_no_match` 按失败上报协议处理）
- `status = local_execution` → 当前主控继续本地审查
- `status = delegated` → 先读取 `.council/delegations/<id>/` 产物，再生成审查结论
- 返回错误、缺少 handoff/result artifact，或无法完成调用 → **停止当前 workflow 并报告失败**
- 仅当 `council` 明确缺失或不可调用时，才允许降级到纯主控审查，并显式说明正在降级

### 第四步：生成报告
问题分级：
- 🚨 严重（安全漏洞、数据丢失风险）
- ⚠️ 高优先级（性能问题、架构违规）
- 💡 改进建议（命名优化、代码简化）
- ✅ 做得好的地方

### 第五步：自动创建修复任务
严重问题调用 MCP `add_subtask` 创建修复任务。调用 `add_log` 记录审查结果。

但如果审查发现某个任务**根本方向有问题**（不是可修复的缺陷，而是任务本身已不该存在 / 已超出范围 / 已被其它实现替代），**不要**给这个"死任务"再挂修复子任务：`project-review` 不负责终态关闭，应升级到 `project-feedback` / `project-change` 并给出建议——由它们或控制器用 `close_task(cancelled|superseded)` 处理；本步用 `add_log(kind="decision", ...)` 记录"建议关闭 + 理由"，不要自行调用 `close_task`。

## 注意事项
- 不要鸡蛋里挑骨头
- 严重问题必须给具体修复建议
- 做得好的地方也要肯定
- 引用讨论结论时，优先摘取 `initial_position`、`current_controller_position`、`min_rounds` 等显式字段，而不是把外部模型原文直接当最终判断
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON 并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
