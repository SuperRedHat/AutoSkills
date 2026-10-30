# check-kit fixture: CLAUDE_CODE_EFFORT_LEVEL set

The deployed tree of ../home-ok/ (placeholders and dist/index.js as described there) with
CLAUDE_CODE_EFFORT_LEVEL in the env of home/.claude/settings.json and of
projects/demo/.claude/settings.local.json. The test also sets it in the process environment of check-kit.
The value is a sentinel that must never appear in the output. Expected FAIL rows: effort.process and
effort.settings (naming both files); every other config row passes.
