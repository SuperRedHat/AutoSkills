# check-kit fixture: old and duplicate skill copies

Laid on top of ../home-ok/ (see its README for placeholders, fixture.json and git-remotes.json), with the
whole kit installed. Synthetic old copies by name, as the former sync scripts left them:

- FAIL: a retired skill in home/.claude/skills and one in home/.agents/skills; a kit skill in
  home/.agents/skills edited by hand (differs from the repo); project-* folders in home/.codex/skills,
  home/.gemini/skills, home/.codex/agents/skills and home/.workflow-core/skills.
- WARN only (with a delete command, no effect on the exit code): a folder named {project-init,project-next}
  from a failed brace expansion, home/.workflow-core/templates/global-codex-AGENTS.md (no longer shipped),
  the old agent home/.claude/agents/tester.md, and projects/legacy/CLAUDE.md and AGENTS.md, whose lines name
  retired skills and CouncilFlow (the set_project_dir line and the kit skill names are not reported).
