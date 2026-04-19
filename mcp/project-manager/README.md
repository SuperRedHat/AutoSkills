# MCP Project Manager

Claude Code 的项目状态管理 MCP Server。提供 PRD、架构文档、任务列表、日志的持久化存储和跨会话恢复。

## 安装

```powershell
cd ~\.claude\mcp-project-manager
npm install
npm run build
```

## 配置

在项目目录的 `.claude/.mcp.json` 中添加（或在全局 `~/.claude/.mcp.json`）：

```json
{
  "mcpServers": {
    "project-manager": {
      "command": "node",
      "args": ["C:/Users/你的用户名/.claude/mcp-project-manager/dist/index.js"],
      "env": {
        "PROJECT_DIR": "."
      }
    }
  }
}
```

## 提供的 Tools

### 项目管理
- `get_project_info` — 获取项目元信息
- `update_project_info` — 更新项目名称、状态、技术栈
- `save_prd` / `get_prd` — 保存/获取 PRD 文档
- `save_architecture` / `get_architecture` — 保存/获取架构设计

### 任务管理
- `create_tasks` — 批量创建任务
- `get_next_task` — 获取下一个可执行任务（自动判断依赖）
- `update_task_status` — 更新任务状态（强制校验合法迁移路径）
- `get_all_tasks` — 获取所有任务（可按状态筛选）
- `get_task_by_id` — 获取单个任务详情
- `add_subtask` — 添加子任务

### 日志
- `add_log` — 记录操作日志
- `get_logs` — 获取最近日志

### 上下文恢复
- `get_project_context` — 一次性返回完整项目上下文
