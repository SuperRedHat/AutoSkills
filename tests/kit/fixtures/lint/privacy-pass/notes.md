# Synthetic notes that must pass the built-in privacy rules

- Home placeholders: ~/.claude/skills, C:/Users/<user>/.codex, C:\Users\<user>\AppData, %USERPROFILE%\.agents
- Profile placeholders: C:\Users\Public\Documents, /home/<user>/src, /Users/$USER/dev
- Git Bash and WSL placeholders: /c/Users/<user>/.claude, /mnt/c/Users/<user>/repo, /d/<project>, /c/Users/$USER
- Git Bash and WSL system paths: /c/Windows/System32, /mnt/c/Program Files/Git, /c/tmp, /mnt/data/cache
- Regex literals are not paths: `text.replace(/a/gi, '')` and `s.split(/x/g)`
- One-letter example drive paths: d:/x and D:/X are the same project.
- System folders: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
- SSH remotes are not emails: git@github.com:octo-org/demo-kit.git and ssh://git@example.com/octo-org/demo-kit.git
- noreply addresses are not emails: noreply@anthropic.com, 12345+octocat@users.noreply.github.com
- Package specs are not emails: react@18.3.1, @types/node

Co-Authored-By: Claude <noreply@anthropic.com>
