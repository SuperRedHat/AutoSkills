# MCP Server Migration Report (TASK-066)

**日期**：2026-04-19
**源**：`~/.claude/mcp-project-manager/`
**目标**：`D:/project/AutoSkills/mcp/project-manager/`
**策略**：cp -r（拷贝，非移动）；原始位置保持不动

## 搬迁清单

### 拷贝的文件

| 类型 | 源路径 | 目标路径 | 状态 |
|---|---|---|---|
| TypeScript 源 | `~/.claude/mcp-project-manager/src/` | `AutoSkills/mcp/project-manager/src/` | ✅ |
| 依赖声明 | `~/.claude/mcp-project-manager/package.json` | `AutoSkills/mcp/project-manager/package.json` | ✅ |
| 锁文件 | `~/.claude/mcp-project-manager/package-lock.json` | `AutoSkills/mcp/project-manager/package-lock.json` | ✅（保证可复现构建） |
| 编译配置 | `~/.claude/mcp-project-manager/tsconfig.json` | `AutoSkills/mcp/project-manager/tsconfig.json` | ✅ |
| 文档 | `~/.claude/mcp-project-manager/README.md` | `AutoSkills/mcp/project-manager/README.md` | ✅ |

### 明确排除（由 .gitignore 保障）

| 类型 | 源路径 | 为何排除 |
|---|---|---|
| 构建产物 | `~/.claude/mcp-project-manager/dist/` | 由 `npm run build` 在 bootstrap 时生成 |
| 依赖目录 | `~/.claude/mcp-project-manager/node_modules/` | 由 `npm install` 在 bootstrap 时恢复 |

## 去个人化扫描

对源做了完整扫描：

```bash
grep -rnIE 'C:\\Users\\David Zhai|/c/Users/David Zhai|David Zhai' \
  ~/.claude/mcp-project-manager/src \
  ~/.claude/mcp-project-manager/package.json \
  ~/.claude/mcp-project-manager/tsconfig.json
# → 无匹配
```

**0 个替换点**。MCP server 源码从设计上就**无硬编码用户路径** —— 它通过 MCP 协议从调用方（codex/claude/gemini CLI）接收 `project_dir` 参数，然后在该项目目录下读写 `.claude/state/*` 文件。源码自身不知道也不关心用户家目录在哪。

## 搬迁后扫描

```bash
cd D:/project/AutoSkills/mcp/project-manager
grep -rnIE 'C:\\Users\\David Zhai|/c/Users/David Zhai' src package.json tsconfig.json
# → NO_USER_PATH

grep -rnIE 'sk-[A-Za-z0-9_-]{20,}|ghp_|xoxb-|AIza[0-9A-Za-z_-]{30,}' src package.json tsconfig.json
# → 无匹配
```

## 业务逻辑改动

**零改动**。所有 TypeScript 源字节对拷：

- MCP 工具注册逻辑（`set_project_dir` / `get_prd` / `save_prd` / `get_architecture` / `save_architecture` / `create_tasks` / `get_next_task` / `update_task_status` / `add_log` / `get_project_context` 等）未改
- `package.json` 的 `name` / `version` / `main` / `scripts` / `dependencies` 未改
- `tsconfig.json` 的 `target` / `module` / `moduleResolution` / `outDir` / `rootDir` / `strict` 未改

## 构建验证

```bash
cd D:/project/AutoSkills/mcp/project-manager
npm install            # → 依赖安装成功
npm run build          # → tsc 编译成功
ls dist/index.js       # → 产物存在
```

构建产物 `dist/index.js` 存在且可被 MCP 客户端识别。构建完成后已清理 `dist/` 和 `node_modules/` 以符合 .gitignore 约束（`not test -d node_modules && not test -d dist`）。

## 原始位置状态

```bash
ls ~/.claude/mcp-project-manager/
# → README.md  dist  node_modules  package-lock.json  package.json  src  tsconfig.json
```

原始目录**未被修改、未被删除、未被移动**。`dist/` 和 `node_modules/` 仍存在于原位（来自之前的全局安装），不影响本搬迁。

## 验收状态

| 验收项 | 状态 |
|---|---|
| src/ + package.json + tsconfig.json + README.md 齐全 | ✅ |
| 未拷贝 dist/ 或 node_modules/ | ✅ |
| 无 `C:\Users\David Zhai` 硬编码路径 | ✅（源本就无） |
| 无 API key / token | ✅ |
| `npm install && npm run build` 成功生成 dist/index.js | ✅（已验证后清理） |
| docs/mcp-migration-report.md 存在 | ✅ |
| 原始 ~/.claude/mcp-project-manager/ 未动 | ✅ |

**建议**：TASK-067 的 mcp-manifest.json 将使用 `${AUTOSKILLS_HOME}/mcp/project-manager/dist/index.js` 作为路径占位；TASK-068 的 bootstrap.{ps1,sh} 会在新电脑上运行 `npm install && npm run build` 生成 dist/，再按 manifest 注册到三端 CLI。
