# deploy-kit fixtures

Hand-written synthetic trees for tests/kit/deploy-kit.test.mjs. The tests copy them into OS temp dirs
and pass --home, --runtime and --projects-root there. Nothing here is copied from a real user directory.

- home/: a fake user directory with old project-* skill copies in every legacy location, other skills that
  must stay, the three old agents, a brace-expansion folder, never-touch files and an old workflow-rules.md.
  Merge targets: .claude/settings.json (own permissions, env, hooks and a plugin, plus kit hook entries
  from an older runtime that the merge replaces) and .codex/config.toml (comments, trust sections in both
  quoting styles, a plugin, an MCP server with a multi-line string, a desktop section).
- projects/: two fake projects that register read-only folders in their rules (the contract line and the
  table form) plus folders that must not be picked up. The tests add git repositories with a remote at
  run time (a .git folder cannot be committed here).
