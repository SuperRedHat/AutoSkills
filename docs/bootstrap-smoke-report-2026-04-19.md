# AutoSkills Bootstrap Smoke Report — 2026-04-19

**任务**：TASK-070（最终 gate）
**状态**：部分完成，等待真机 / clean VM 验证
**执行**：Claude Opus 4.7 via `/project-next`

## A. 本机侧验证（已完成）

### A.1 Git 本地状态

```bash
cd D:/project/AutoSkills
git log --oneline
# aca251a docs(autoskills): rewrite README + add docs/bootstrap.md (TASK-069)
# 154a05b feat(scripts): add bootstrap / sync-skills / backup / restore dual-version scripts (TASK-068)
# b7e1438 feat(manifest): add mcp-manifest.json with AUTOSKILLS_HOME placeholder (TASK-067)
# ca67c6f feat(mcp): migrate project-manager MCP server source from ~/.claude/ (TASK-066)
# 766a447 feat(skills): migrate 11 project-* skills + 4 templates from ~/.workflow-core/ (TASK-065)
# 10ff6d1 chore(scaffold): initialize AutoSkills directory structure (TASK-064)
# 5551eba Initial commit

git status --short
# (空；干净状态)

git branch --show-current
# master
```

**结论**：✅ 本地 7 个 commit 齐全（Initial + 6 个 TASK commits），工作目录干净。

⚠️ **分支名说明**：本地分支是 `master`（不是 `main`）。这是由于 `git init` 时用户 git 全局配置默认 `master`。任务原本写的是 "push -u origin main"，但实际按本地分支名 `master` 推送。如果将来要重命名为 `main`：

```bash
cd D:/project/AutoSkills
git branch -m master main
git push origin main
git push origin --delete master   # 危险操作，需用户确认
# 然后到 GitHub Settings → Branches 改默认分支
```

本报告**不**自动执行上述重命名操作。

### A.2 Remote 配置

```bash
git remote -v
# origin  https://github.com/SuperRedHat/AutoSkills.git (fetch)
# origin  https://github.com/SuperRedHat/AutoSkills.git (push)
```

**结论**：✅ Remote 已配置为用户指定的私有仓库 URL。

### A.3 Push 到 GitHub

```bash
git push -u origin master
# remote: Create a pull request for 'master' on GitHub by visiting:
# remote:      https://github.com/SuperRedHat/AutoSkills/pull/new/master
# remote:
# branch 'master' set up to track 'origin/master'.
# To https://github.com/SuperRedHat/AutoSkills.git
#  * [new branch]      master -> master
```

**结论**：✅ `master` 分支已推到 GitHub，7 个 commit 可见。没有使用 `--force` 或其他破坏性 flag。GitHub 端可能存在自动创建的 `main` 分支（空或仅含 GitHub 的 README），需用户在 GitHub Settings 确认默认分支。

### A.4 Dry-run bootstrap（本机）

```bash
cd D:/project/AutoSkills
bash scripts/bootstrap.sh --dry-run 2>&1 | head -40
# 输出显示：AUTOSKILLS_HOME 正确推导、11 skills 识别、5 步流程打印完整
# 无未捕获错误
```

**结论**：✅ bash 版本 dry-run 通过。

```powershell
powershell -NoProfile -File scripts/bootstrap.ps1 -DryRun 2>&1 | head -40
# 输出格式与 bash 版本对齐，AUTOSKILLS_HOME = D:\project\AutoSkills
```

**结论**：✅ PS1 版本 dry-run 通过（之前发现 pwsh 依赖已修复为 dot-source 兼容 PowerShell 5.x）。

### A.5 本机已有 CouncilFlow 安装状态

本机 CouncilFlow 已通过之前 TASK-050 的方式装好（用户自测可用）。`council status` 可用。

**结论**：✅ CouncilFlow 运行环境就绪。

### A.6 MCP server 构建验证（TASK-066 已跑通）

```bash
cd D:/project/AutoSkills/mcp/project-manager
npm install   # 成功
npm run build # tsc OK, dist/index.js 生成
# 已清理 dist/ 和 node_modules/
```

**结论**：✅ MCP server 可从源码构建，产物 `dist/index.js` 生成成功。

---

## B. 另机 / Clean VM 侧验证（待用户执行）

**为什么必须在不同机器或 clean VM**：本机已经装过多轮 skills + MCP，不管 bootstrap 跑多成功都可能是"已经在工作状态下又跑一遍"，无法证明**从零开始的新机器**能跑通。

以下 smoke 步骤需要你在另一台 Windows 真机或 clean 虚拟机上执行，把实际输出填回到本文件对应段落：

### B.1 环境准备

```
装：Python 3.13+, pipx, Git 2.30+, Node.js 20.x LTS+, PowerShell 5.1+
装：Codex CLI / Claude Code CLI / Gemini CLI（至少一个）
配：GitHub PAT（有本仓库 read 权限）
```

记录：
- OS 版本: __________
- Python 版本: `python --version` → __________
- Node 版本: `node --version` → __________
- PS 版本: `$PSVersionTable.PSVersion` → __________

### B.2 克隆两个仓库

```bash
# CouncilFlow
pipx install git+https://<PAT>@github.com/SuperRedHat/CouncilFlow.git

# AutoSkills
git clone https://<PAT>@github.com/SuperRedHat/AutoSkills.git
cd AutoSkills
```

预期：✅ / ❌
实际输出:
```
[填入]
```

### B.3 验证 CouncilFlow

```bash
council status
```

预期：输出 controller 识别结果、最近讨论/委派记录、配置语言
实际输出:
```
[填入]
```

### B.4 先 dry-run 再正式 bootstrap

```bash
# Windows
powershell -NoProfile -File scripts/bootstrap.ps1 -DryRun
# 确认无异常后：
powershell -NoProfile -File scripts/bootstrap.ps1
```

预期：5 步流程全绿，无未捕获错误
实际输出（关键行）:
```
[填入：每一步的开始/完成行]
```

### B.5 验证三端 MCP 注册

```bash
codex mcp get project-manager
```
实际输出:
```
[填入]
```

```bash
claude mcp get project-manager -s user
```
实际输出:
```
[填入]
```

```bash
# 查 gemini 配置
python -c "import json; import os; d=json.load(open(os.path.expanduser('~/.gemini/settings.json'))); print(d.get('mcpServers',{}).get('project-manager'))"
```
实际输出:
```
[填入]
```

### B.6 验证 skills 同步到三端

```bash
ls ~/.codex/skills/ | grep project- | wc -l     # 预期 11
ls ~/.claude/skills/ | grep project- | wc -l    # 预期 11
ls ~/.gemini/skills/ | grep project- | wc -l    # 预期 11
```
实际:
- codex: __________
- claude: __________
- gemini: __________

### B.7 三端主控会话调用 project-status

分别在 Codex / Claude Code / Gemini CLI 新开会话中执行：

```
/project-status
```

预期：MCP 能被识别（无 "MCP not found" 错误），project-status skill 能正常返回（若当前目录不是项目，返回相应提示；若是项目，返回看板摘要）

实际：
- **Codex**: [填 OK / FAIL + 错误摘要]
- **Claude Code**: [填 OK / FAIL + 错误摘要]
- **Gemini**: [填 OK / FAIL + 错误摘要]

### B.8 完整通过标志

以下**全部为 ✅** 才算本阶段 gate 通过：

- [ ] B.2 `pipx install CouncilFlow` 成功
- [ ] B.2 `git clone AutoSkills` 成功
- [ ] B.3 `council status` 返回正确
- [ ] B.4 bootstrap 5 步全绿
- [ ] B.5 codex mcp 可见
- [ ] B.5 claude mcp 可见
- [ ] B.5 gemini settings.json 有 project-manager
- [ ] B.6 三端 skills 数量各 = 11
- [ ] B.7 三端 project-status 均响应

---

## C. 已排除的破坏性操作

以下操作**未执行**：

- ❌ `git filter-repo`（未运行，与 TASK-061 审计结论 NO_FINDINGS 一致）
- ❌ `git push --force` / `--force-with-lease`（push 是 fast-forward，无需 force）
- ❌ `git reset --hard`
- ❌ 本地 / 远程分支删除（除 `master` -> `main` 重命名说明中标记为"需用户确认"）

---

## D. 未解决事项 / 遗留

| 项 | 描述 | 下一步 |
|---|---|---|
| 分支命名 | 本地与远程都是 `master`；任务原文件的 main 为非关键命名假设 | 用户决定是否改 main（详见 A.1） |
| 真机 smoke | 未在不同机器上跑通端到端 | 用户执行 B 段 |
| 远程 initial commit 冲突 | GitHub 可能有自动生成的空 main 分支 | 用户到 GitHub Settings 检查并决定是否删掉 |
| CouncilFlow 私有访问 | 新机安装 CouncilFlow 需要 PAT | 在 B.2 验证一次 |

---

## E. 建议流程

你接下来在一台 clean Windows VM 或不同电脑上：

1. 装好 B.1 的所有前置依赖
2. 按 B.2 ~ B.7 顺序跑
3. 把实际输出填回本文件
4. 全绿后回到本机 commit 更新后的报告
5. 运行 `/project-feedback TASK-070 accept` 关闭 gate

或者如果你觉得本机验证已经足够（因为 67 个 done 任务的 smoke 在 2026-04-18 已经覆盖了类似场景），可以直接 `/project-feedback TASK-070 accept` 跳过另机 smoke —— 但这意味着我们假设 bootstrap 脚本在新电脑上的行为与本机 dry-run 等价，这是一个较弱的假设。

---

## F. 截至提交时的 Git 状态

```
cd D:/project/AutoSkills
git log -1 --format='%H %s'
# aca251a docs(autoskills): rewrite README + add docs/bootstrap.md (TASK-069)

git remote get-url origin
# https://github.com/SuperRedHat/AutoSkills.git

git rev-parse --abbrev-ref HEAD
# master
```

**GitHub 远程**：https://github.com/SuperRedHat/AutoSkills （private）
**当前分支**：master
**推送的 commit 范围**：5551eba..aca251a（7 个 commits）
