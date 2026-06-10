---
name: project-init
description: 需求分析与 PRD 生成。PRD 确认后落盘到 project-manager MCP 并生成 repo-local AGENTS.md / CLAUDE.md。
---

# /project-init — 需求分析与 PRD 生成

## 执行流程

1. 通过对话澄清项目背景、目标用户、核心功能、非功能要求、技术偏好和验收标准。
2. 如果用户显式要求 `discuss <models>`，或需求边界存在明显争议，可先走一轮多模型讨论：
   - `council discuss "这个项目的需求边界应该如何定义？" --controller-position "<主控本地立场>"`（显式给模型时加 `--models ...`）
   - 协议细节（default_models 读取 / min_rounds / `data.summary_path` 读取 / shell 超时两段式恢复 / 失败白名单 / 确认失败才停）**一律遵循 project-discuss 的规范段**（最易错且不可省的一点先记住：shell 超时/非零退出 ≠ 讨论失败——用 `council status` 取 `last_discussion_id` → `council discussion wait <id> --timeout 7200` 等到底再判）；一旦进入即硬前置
   - 讨论结论只作为补充输入，不能替代用户确认
3. 把 `project-init` 视为显式阶段机，而不是"主控聊完就直接写 PRD"：
   - `planner -> synthesizer -> persistence`

### 委派契约（适用于本 skill 所有 `council delegate` 调用，前提：项目目录已确定）

- 不传 `--model`，目标模型由项目级 `roles.<role>` 决定
- `status = local_execution` → 当前主控本地完成该阶段
- `status = delegated` → 先读取 `.council/delegations/<id>/` 产物再进入下一阶段
- 返回错误、缺少 handoff/result artifact，或无法完成调用 → **停止当前 workflow 并报告失败**
- 仅当 `council` 明确缺失或不可调用时，才允许显式降级到主控本地执行

4. 先进入 `planner` 阶段（按委派契约）：
   - `council delegate --role planner --objective "整理已确认需求边界并形成 PRD 规划输入" --task-summary "需求分析与 PRD 规划"`
   - 项目目录未确定时只允许继续需求澄清；目录一确定，planner 阶段重新受 route-first 约束
5. 再进入 `synthesizer` 阶段（按委派契约）：
   - `council delegate --role synthesizer --objective "综合需求澄清与 planner 产物，输出 PRD 草案" --task-summary "PRD 综合整理" --required-artifact planner_result="<planner 的 result artifact>"`
6. 生成结构化 PRD，等待用户明确确认。
7. 用户确认后：
   - 调用 `save_prd`
   - 调用 `update_project_info`
   - 调用 `add_log`
8. 若项目目录已确定：
   - 生成 repo-local `AGENTS.md`
   - 生成 repo-local `CLAUDE.md`
   - 两者必须来自共享模板，不手写双份规则

## 项目目录状态判定

步骤 4 / 5 / 7 / 8 都依赖"项目目录是否已确定"的判断。统一语义如下：

- **已确定**：本会话已成功调用 `set_project_dir(<path>)`（其返回 `project_dir` 与 `state_exists`）；或用户在对话中明确给出目录路径并已登记。（`get_project_info()` 不返回 `project_dir` 字段，不要以它判定。）
- **未确定**：本会话尚未成功调用 `set_project_dir`，且对话里没有可推断的目录。

项目目录未确定时允许的行为集合：
- 继续需求澄清问答（只在对话内发生）
- 输出 PRD 预览供用户评审（不持久化）
- **禁止**调用 `save_prd` / `update_project_info` / `add_log(type="prd_saved")` 等任何写入 `.claude/state` 的持久化操作
- **禁止**生成 repo-local `AGENTS.md` / `CLAUDE.md`
- **禁止**进入 `planner` / `synthesizer` 的 route-first 委派（没有项目根目录就没有 `.council/` 可读写）

一旦目录确定，立即回到原步骤受 route-first 约束。

## 注意事项

- 不要替用户做决定，模糊之处必须追问
- 在 PRD 未确认前不要写代码
- `discuss` 是显式可选能力，不要在未被要求时默认触发多模型讨论；discuss 失败后不要假装这轮多模型分析已经完成
- repo-local 规则文件只写项目补充项，不复制全局规范全文
- 任何阶段路由失败或缺少预期 artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON（`workflow`/`failed_stage`/`error_kind`/`council_available`/`artifact_paths`/`fallback_attempted`/`message`）并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
