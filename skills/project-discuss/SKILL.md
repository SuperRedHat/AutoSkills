---
name: project-discuss
description: 独立多模型讨论入口。当用户说"讨论一下"、"多模型讨论"、"project-discuss"、"先让其他模型一起看看"等时触发。通过 CouncilFlow 发起正式讨论，再由当前主控输出结论并建议下一步。
---

# /project-discuss — 独立多模型讨论

## 你的角色
你是当前主控的讨论主持人，负责把问题 framing 清楚，调用 `CouncilFlow` 引入额外模型，并把结果收敛成可继续执行的结论。

## 执行流程

### 第零步：初始化项目上下文（关键）
1. 确定当前项目根目录的绝对路径。
2. 在调用任何其他 project-manager MCP 工具前，先执行 `set_project_dir`。
3. 若当前项目已经初始化，可调用 `get_project_context` 获取 PRD 摘要、架构摘要、任务状态和最近日志，作为讨论 framing 的输入。（Phase 0.2+ 该返回还含 `current_focus` 与双完成率 `metrics` 等只读 hint；这些只用于 framing，正式任务关闭仍由 host 调 `close_task`，讨论本身不改状态。）

### 第一步：明确讨论问题与参与模型
1. 把用户的问题整理成一句可执行、可讨论的 `question`。
2. 先由当前主控本地整理一句简短 `initial_position`，明确当前默认倾向、边界假设或推荐方向。
3. 优先使用用户显式指定的额外模型列表。
4. 如果用户没有指定模型，不要手工挑选其他模型，直接让 CouncilFlow 从项目级 `.council/config.yaml` 的 `discussion.default_models` 读取默认讨论参与者。
5. 如项目下缺少 `.council/config.yaml`，CouncilFlow 会在首次调用时自动创建项目本地配置模板。
6. 与当前主控重复的模型不要手工过滤为隐藏逻辑，直接交给 `CouncilFlow` 去重、提醒或短路。

### 第二步：发起讨论
调用：

```bash
council discuss "<question>" --controller-position "<initial_position>" --models claude,gemini
council discuss "<question>" --controller-position "<initial_position>"
```

可选追加：

```bash
--max-rounds 5
```

说明：
- `question` 是位置参数，不使用 `--question`
- 显式给模型时使用 `--models`
- 不写 `--models` 时，CouncilFlow 会自动读取项目级 `discussion.default_models`
- `--controller-position` 用来把当前主控的本地立场显式交给 CouncilFlow，避免 `codex -> codex` / `claude -> claude` / `gemini -> gemini` 这种同模型自嵌套
- CouncilFlow 会把这版立场分发给外部模型评论；最终结论仍由当前主控基于 summary 综合
- 只有达到项目级 `discussion.min_rounds` 之后，CouncilFlow 才允许提前收敛
- 如确实是在独立 CLI fallback 场景下运行，也可以省略 `--controller-position`，此时 CouncilFlow 会退回 provider 驱动的主控回合模式
- `discuss` 是显式入口；如果没有额外模型参与，就不应伪装成跨模型讨论
- 这是硬前置步骤：你**必须先调用 CouncilFlow**
- **shell 超时恢复协议（0.1.6+，硬前置）**：`council discuss` 自身的 shell 调用超时或非零退出**不等于**讨论失败——CouncilFlow 子进程一般还在跑，summary.md 会落盘。必须先恢复：
  1. `council status --project-root <root>` 取 `data.state.last_discussion_id`
  2. `council discussion wait <discussion_id> --project-root <root> --timeout 7200`
  3. 完成判定是双条件：`record.status == "completed"` AND `summary.md` 可读
  4. 只有 `discussion wait` 自身以非零退出并给出 `error_kind`（`wait_timeout` / `discussion_failed` / `record_corrupt` / `summary_missing` / `discussion_not_found`，或从 record 转发的 provider 错误如 `adapter_missing` / `provider_timeout`），才允许宣告失败
- 如果 `council discuss`（含上述恢复路径）最终确认失败、缺少 summary artifact，或无法完成调用，则**停止当前 workflow 并报告失败**；不要把单模型主控判断伪装成已经完成的多模型讨论

### 第三步：读取结构化产物
1. 优先使用命令返回 JSON 中的 `data.summary_path`。
2. 若需要手动定位，再读取 `.council/discuss/<discussion_id>/summary.md`。
3. 不要依赖不存在的 `latest` 别名目录。

### 第四步：输出结论
至少向用户汇总：
- `participants`
- `initial_position`
- `current_controller_position`
- `min_rounds`
- `key_options`
- `agreements`
- `disagreements`
- `recommended_decision`
- `open_questions`
- `next_step`

最终结论仍由当前主控输出，不把外部模型原文直接当成最终决策。

### 第五步：引导下一步
根据讨论结果建议后续动作，例如：
- 回到 `$project-ask` 继续追问
- 进入 `$project-design`
- 进入 `$project-plan`
- 使用 `$project-next` 落地执行
- 如结论改变范围或验收口径，进入 `$project-change`

## 注意事项
- `project-discuss` 只负责讨论和收敛，不直接改代码
- 讨论结果必须建立在显式 `.council` 产物上，不依赖隐藏共享上下文
- 如果 `CouncilFlow` 返回“与当前主控重复模型”的 warning，应如实告知用户，并继续本地主控判断
- 如果 `council` 缺失或不可调用，应明确告知用户当前无法发起跨模型讨论，而不是假装已经走了多模型流程
- 任何 `council discuss` 失败或缺少 summary artifact 时，按 `docs/integration.md::Workflow Failure Report Protocol` 输出结构化 JSON（`workflow=project-discuss`、`failed_stage=discussion`）并调用 `project-manager` MCP `add_log(type="workflow_failure", ...)`，再停止当前 workflow
