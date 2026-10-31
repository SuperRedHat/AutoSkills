# check-kit fixture: deployed

A hand-written synthetic tree for tests/kit/check-kit.test.mjs: a fake user directory (home/) as deploy-kit
leaves it, its runtime (runtime/hooks/ with heartbeat files), a projects root (projects/) and the local
config (local.json). Nothing here is copied from a real user directory.

The test copies the tree into an OS temp dir and fills the placeholders: `<home>`, `<runtime>` and
`<projects>` with the temp folders, `<projects-posix>` with the projects folder in the form of Claude's path
rules (//c/...), `<node>` with the Node that runs the test, `<recent>` with a time one hour ago. It also
writes a synthetic home/.claude/mcp-project-manager/dist/index.js (dist/ is git-ignored), so that row is a
WARN, not a FAIL.

fixture.json names the kit groups the test installs from the repo at run time, where the tree has no file
of its own: `contract` (~/.claude/AGENTS.md, CLAUDE.md, ~/.codex/AGENTS.md), `skills` (the 7 kit skills in
~/.claude/skills and ~/.agents/skills), `agents` (~/.claude/agents/project-verifier.md) and `hooks`
(guard.mjs and session-start.mjs in runtime/hooks/), so these copies never go stale. With `base`, the named
fixture is laid down first and this one on top. Each git-remotes.json becomes a git repository in its
folder with those remotes (and pushurl where given); the marker file is removed.

Expected: no FAIL; check-kit exits 0 in strict mode. WARN: the repo in the read-only folder
projects/demo/frozen (pushurl skipped) and the synthetic project-manager build. home/.codex/config.toml
holds a synthetic hook trust table for the one kit handler of home/.codex/hooks.json (pre_tool_use:0:0, in
the layout C0 found), so the Codex hook trust row passes.
home/.codex/rules/autoskills.rules is a copy of config/codex/rules/autoskills.rules and must be updated
with it.
