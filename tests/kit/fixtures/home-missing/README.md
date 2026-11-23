# check-kit fixture: before a deploy

A hand-written synthetic fake user directory with gaps, for tests/kit/check-kit.test.mjs (placeholders as in
../home-ok/README.md). Expected FAIL rows:

- Claude: CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS has another value, subagentPromptCacheTtl and
  worktree.baseRef are not set; both folder rules are missing (the old git push and npm publish rules and one
  old outbound MCP rule it still holds are WARN rows, not FAIL); the guard for shell and file tools has no
  onFailure: block, the SessionStart hook is not registered and the project-manager guard points to a script that does not exist.
- Codex: model_reasoning_effort is xhigh, followUpQueueMode is queue, agents.default_subagent_reasoning_effort
  is set; no hooks.json, no rules file, no project-manager registration.
- No project-manager build (the test writes no dist/index.js here).
- No contract files, no kit skills, no project-verifier.md.
- No heartbeat files (the hooks never ran), and runtime/hooks/guard.mjs is a stub whose --selftest prints
  nothing. There is no runtime/hooks/hook-config.json next to it (guard config row). The live run of the
  registered guard command lines fails: the stub allows but never denies, and the project-manager guard's
  script does not exist, so Node exits 1.
- projects/app becomes a repository (git-remotes.json) whose origin has no pushurl; its mirror remote is
  already no_push.

CLAUDE_CODE_EFFORT_LEVEL is set nowhere, so those rows pass.
