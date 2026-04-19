# Bootstrap 深度文档

这份文档解释 `scripts/bootstrap.{ps1,sh}` 每一步到底做什么、为什么这么做、失败了怎么回滚、manifest 里的字段怎么读。面向想改这些脚本或排错到比 README 更深层的人。

---

## 目录

- [五步流程详解](#五步流程详解)
- [幂等性保证](#幂等性保证)
- [快照结构](#快照结构)
- [回滚路径](#回滚路径)
- [mcp-manifest.json schema](#mcp-manifestjson-schema)
- [环境变量解析](#环境变量解析)
- [失败模式](#失败模式)
- [PS1 与 Bash 行为等价性](#ps1-与-bash-行为等价性)

---

## 五步流程详解

### Step 1/5 — 备份

调用 `scripts/backup-global-workflow.{ps1,sh}`。

**做什么**：
- 创建 `~/.workflow-core-backups/<timestamp>/`（ISO8601 时间戳，带毫秒）
- 拷贝以下内容（若存在）：
  - `~/.codex/skills/` → `codex-skills/`
  - `~/.claude/skills/` → `claude-skills/`
  - `~/.gemini/skills/` → `gemini-skills/`
  - `~/.claude/commands/` → `claude-commands/`
  - `~/.gemini/settings.json` → `gemini-settings.json`
- 运行 `codex mcp get project-manager` 和 `claude mcp get project-manager -s user`，输出追加到 `mcp-state.log`（用于回滚时参照）

**为什么在最前面做**：sync-skills 会覆盖三端 `skills/project-*`。没有备份就没有回滚的基础。

### Step 2/5 — 同步 skills

调用 `scripts/sync-skills.{ps1,sh}`。

**做什么**：
- 读 `AutoSkills/skills/` 下所有 `project-*` 目录（白名单过滤）
- 对每个目标根（`~/.codex/skills`、`~/.claude/skills`、`~/.gemini/skills`）：
  1. 清理 orphan 的 `project-*` 目录（源没有但目标有的）
  2. 清理 brace-expansion 创建的畸形目录（包含 `{`、`}`、`,` 的）
  3. 逐 skill 覆盖：先 `rm -rf <target>/project-X`，再递归拷贝（排除 `*.bak`）
  4. 对每个 skill 的 `SKILL.md` 做 SHA-256 校验，源与目标必须一致
- 清理 `~/.claude/commands/project-*.md` 旧派生文件（已被 skills 直接消费取代）

**为什么用白名单**：防止同步脚本意外删除 Codex 原生的 `.system`、Gemini 原生的某些目录。

### Step 3/5 — 构建 MCP server

**做什么**：
- `cd AutoSkills/mcp/project-manager`
- `npm install` — 从 `package-lock.json` 恢复精确依赖
- `npm run build` — 跑 `tsc`，输出到 `dist/`
- 校验 `dist/index.js` 存在

**为什么不在仓库预构建**：`node_modules` + `dist` 会让仓库膨胀 ~50MB 且跨平台可能有差异。按需构建保证每台机器用自己的 Node 版本产出一致的 `dist/index.js`。

### Step 4/5 — 注册 MCP

读 `mcp-manifest.json`，展开 `${AUTOSKILLS_HOME}` 占位符后，对三端分别：

**codex**：
```bash
codex mcp remove project-manager 2>/dev/null || true  # 先清旧的
codex mcp add project-manager -- node <AUTOSKILLS_HOME>/mcp/project-manager/dist/index.js
```

**claude**（注意 `-s user`，否则会登记为当前项目的 project-scope）：
```bash
claude mcp remove project-manager -s user 2>/dev/null || true
claude mcp add project-manager -s user -- node <...>
```

**gemini**（没有 `gemini mcp add` 命令，直接改 `~/.gemini/settings.json`）：
```json
{
  "mcpServers": {
    "project-manager": {
      "command": "node",
      "args": ["<AUTOSKILLS_HOME>/mcp/project-manager/dist/index.js"],
      "trust": true
    }
  }
}
```

如果某个 CLI 没装，bootstrap 会打印 `[info] ... CLI not found, skipping` 并继续，不让整个流程失败。

### Step 5/5 — 校验

对每一端跑 `mcp get` 或读 `settings.json`，把结果缩进打印出来。这一步不会因为未装而报错，只是少输出一段。

---

## 幂等性保证

bootstrap 设计为**可以反复跑**，不会把系统搞乱：

- **备份**：每次跑都写新时间戳快照。不会"覆盖上一次的备份"。多次跑会累积多份快照，手动清理即可
- **同步 skills**：对每个 skill，先 `rm -rf` 目标再拷贝。所以第二次跑不会出现"部分旧内容 + 部分新内容混合"的状态
- **构建 MCP**：`npm install` + `npm run build` 本身幂等（锁文件决定依赖，tsc 覆盖输出）
- **注册 MCP**：先 `remove` 再 `add`。第二次跑会刷新注册但结果等价

唯一非幂等点：每次跑都会在 `~/.workflow-core-backups/` 下多一份快照。**磁盘会缓慢增长**，定期手动清理老快照即可。

---

## 快照结构

一个时间戳目录下的内容：

```
~/.workflow-core-backups/20260419T201129373Z/
├── codex-skills/         # ~/.codex/skills/ 的镜像（仅 project-* 相关）
├── claude-skills/        # ~/.claude/skills/ 的镜像
├── gemini-skills/        # ~/.gemini/skills/ 的镜像
├── claude-commands/      # ~/.claude/commands/ 的镜像
├── gemini-settings.json  # ~/.gemini/settings.json 的完整快照
└── mcp-state.log         # codex + claude mcp get 命令的输出日志
```

`mcp-state.log` 是文本日志不是可执行恢复脚本——它提供"当时的注册状态看起来是什么样"，方便回滚时对照确认。

---

## 回滚路径

假设需要回到某次 bootstrap 之前的状态：

### 1. 确定快照

```bash
ls -1t ~/.workflow-core-backups/   # 按时间倒序列出
```

选择要回滚到的时间戳（最近一次 bootstrap 前的那份）。

### 2. 文件级回滚

```powershell
powershell -NoProfile -File scripts/restore-global-workflow.ps1 -SnapshotPath "$env:USERPROFILE\.workflow-core-backups\<TS>"
```

```bash
bash scripts/restore-global-workflow.sh --snapshot "$HOME/.workflow-core-backups/<TS>"
```

restore 会：
- 删除 `~/.codex/skills`、`~/.claude/skills`、`~/.gemini/skills`、`~/.claude/commands` 的当前内容
- 从快照拷回
- 恢复 `~/.gemini/settings.json`

### 3. MCP 注册回滚

restore **不会**自动跑 `codex mcp remove` / `claude mcp remove`——那些注册状态没法从静态快照机械恢复（快照只记录了当时的 `mcp get` 输出作为参照）。

如果要清除 MCP 注册：

```bash
# 完全移除
codex mcp remove project-manager
claude mcp remove project-manager -s user
# gemini: 手动从 ~/.gemini/settings.json 删除 mcpServers.project-manager

# 或：重新跑 bootstrap 让它按当前 manifest 再次注册
bash scripts/bootstrap.sh
```

---

## mcp-manifest.json schema

当前 `version=1` 的 schema：

```json
{
  "version": 1,
  "servers": {
    "<server-name>": {
      "command": "<executable>",
      "args_template": ["<arg1>", "<arg2 with ${AUTOSKILLS_HOME}>"],
      "env": {},
      "trust": {
        "codex": false,
        "claude": false,
        "gemini": true
      }
    }
  }
}
```

字段释义：
- `version`：schema 版本，当前只支持 1
- `servers.<name>`：服务名。Codex/Claude 的 `mcp add <name>` 与 Gemini 的 `mcpServers.<name>` 用同一个 key
- `command`：可执行文件（通常是 `node`，也可以是 `python` / 绝对路径等）
- `args_template`：参数列表模板，支持 `${AUTOSKILLS_HOME}` 占位符（bootstrap 运行时展开为当前 repo 根目录）
- `env`：注入到 server 进程的环境变量（当前为空对象）
- `trust.<cli>`：每端 CLI 是否把该 server 标为 trusted。Gemini 的 `trust: true` 会跳过交互确认；Codex/Claude 默认 false

---

## 环境变量解析

bootstrap 运行时会把 `${AUTOSKILLS_HOME}` 替换为真实路径。该值的来源：

- **PS1**：`$autoSkillsHome = Split-Path -Parent $scriptDir`
- **Bash**：`AUTOSKILLS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"`

都是从脚本自身位置往上一层推导得到（scripts/ 的父目录 = 仓库根）。

这意味着：**你 clone 到哪里，AUTOSKILLS_HOME 就是哪里**。不依赖外部环境变量，不假设用户目录。

---

## 失败模式

bootstrap 可能在哪里失败，分别怎么处理：

| 阶段 | 失败表现 | 处理 |
|---|---|---|
| Step 1 备份 | 磁盘满 / 权限错 | 清空间；检查 `~/.workflow-core-backups/` 权限 |
| Step 2 同步 | SHA-256 mismatch | 通常 line-ending 差异，`rm -rf <target>/project-*` 重跑 |
| Step 3 build | `npm install` 报 EACCES | 不要 sudo；切 nvm/volta |
| Step 3 build | `npm run build` TypeScript 错 | 清 `node_modules` 重装 |
| Step 4 注册 | `codex: command not found` | 不装就不装；bootstrap 会跳过 |
| Step 4 注册 | `claude mcp add` 报 "already exists" | bootstrap 先 remove 再 add，理论上不会；若发生则手动 remove |
| Step 4 Gemini | `~/.gemini/settings.json` 损坏 JSON | bootstrap 会读失败；先备份老文件再重写 |
| Step 5 校验 | `mcp get` 看不到 | 看 `mcp-state.log` 对比；`codex/claude mcp remove` + 重跑 Step 4 |

---

## PS1 与 Bash 行为等价性

为了保证跨平台一致，两版本在以下锚点**完全等价**：

- 退出码：`0` 成功 / `1` 一般失败 / `2` 参数错 / `3` 必需产物缺失 / `4` 工具缺失
- 日志前缀：`[dry-run]` / `[action]` / `[verify]` / `[info]` / `[backup]` / `[sync-skills]`
- Dry-run 语义：不写盘 / 不 `npm install` / 不调 CLI，只打印
- `AUTOSKILLS_HOME` 的推导方式一致（脚本父目录）
- `~/.workflow-core-backups/<ISO8601>/` 位置相同
- MCP 注册动作一致（先 remove 后 add）

如果发现两版本行为不一致，以 Bash 为准（更保守），PS1 向其对齐。
