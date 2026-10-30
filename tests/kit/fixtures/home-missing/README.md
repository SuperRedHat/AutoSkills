# check-kit fixture: before a deploy

A hand-written synthetic fake user directory with gaps, for tests/kit/check-kit.test.mjs (placeholders as in
../home-ok/README.md). Expected FAIL rows:

- Claude: CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS has another value, subagentPromptCacheTtl and
  worktree.baseRef are not set; most Bash deny rules, every PowerShell rule, most outbound MCP rules and both
  folder rules are missing; the guard for shell and file tools has no onFailure: block, the SessionStart hook
  is not registered and the project-manager guard points to a script that does not exist.
- Codex: model_reasoning_effort is xhigh, followUpQueueMode is queue, agents.default_subagent_reasoning_effort
  is set; no hooks.json, no rules file, no project-manager registration.
- No project-manager build (the test writes no dist/index.js here).

CLAUDE_CODE_EFFORT_LEVEL is set nowhere, so those rows pass.
