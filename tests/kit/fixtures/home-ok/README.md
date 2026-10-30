# check-kit fixture: deployed

A hand-written synthetic tree for tests/kit/check-kit.test.mjs: a fake user directory (home/) as deploy-kit
leaves it, its runtime (runtime/hooks/ with stub hook scripts), a projects root (projects/) and the local
config (local.json). Nothing here is copied from a real user directory.

The test copies the tree into an OS temp dir and fills the placeholders: `<home>`, `<runtime>` and
`<projects>` with the temp folders, `<projects-posix>` with the projects folder in the form of Claude's path
rules (//c/...), `<node>` with the Node that runs the test. It also writes a synthetic
home/.claude/mcp-project-manager/dist/index.js (dist/ is git-ignored), so that row is a WARN, not a FAIL.
Expected: no FAIL; check-kit exits 0 in strict mode. home/.codex/rules/autoskills.rules is a copy of
config/codex/rules/autoskills.rules and must be updated with it.
