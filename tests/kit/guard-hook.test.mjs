// Tests for hooks/guard.mjs, rules 1-4 and the skeleton (node:test, zero dependencies). Every input is
// hand-written and synthetic (acme/demo repositories, example.com remotes); heartbeat runtimes, configs,
// the read-only folders with their junctions and the fake AutoSkills checkouts of rule 4 live in OS temp
// dirs that the tests remove (links first). The rule matrix calls the exported decide() in process; the
// hook contract (stdout JSON, exit codes, heartbeat, --selftest) is checked by spawning the guard with the
// Node that runs the tests, so running this file under both Node versions covers both.
//
// Known gaps (ADR-006 §4 residual risks: "间接执行能绕过守卫：写进脚本文件再运行、Invoke-Expression、
// 编码过的命令，守卫都看不到原命令"). The guard does not pretend to catch them; the "known gaps" suite
// pins that they are allowed, so a change that starts catching one must update this list, the guard
// header and ADR-006 together:
//   - a push written into a script file and then run: bash push.sh, ./push.ps1, pwsh -File push.ps1;
//   - Invoke-Expression / iex with the command as a string;
//   - powershell -EncodedCommand <base64>;
//   - commands built at run time: $g = 'git'; & $g push, git $(echo push), aliases defined outside the
//     command (git config alias.p push, then git p);
//   - $( ) and backtick substitutions inside an unquoted bash here-doc (<<EOF), and $( ) inside a
//     PowerShell @"..."@ here-string (a backtick there is only PowerShell's escape character): the shell
//     runs them, the guard reads the body as data (pushurl = no_push is the backstop);
//   - writes into a read-only folder through a shell command (rule 2 sees only the write tools);
//   - a subagent call without agent_id would look like the main session to rule 3; C0 E2 found every
//     workflow-agent input carrying agent_id, so this stays a pinned gap, not an observed one.
// On one Windows account the guard only prevents mistakes; a deliberate bypass is out of its reach.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, SELFTEST, patchPaths, ERROR_DENY_MARK, ASK_MODES } from '../../hooks/guard.mjs';
import { shellForms } from '../../scripts/check-kit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO, 'hooks', 'guard.mjs');
const REASON_HINT = '用户本人可以在普通终端推送';

const temps = [];
const links = [];
function tempDir(name = 'guard-hook-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temps.push(dir);
  return dir;
}
// Links go first, so removing the temp dirs never walks into a link target.
after(() => {
  for (const l of links) { try { fs.unlinkSync(l); } catch { fs.rmSync(l, { force: true }); } }
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

/** A directory link: a junction on Windows (no admin right needed), a symlink elsewhere. */
function dirLink(target, at) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(at);
  return at;
}

const fwd = (p) => p.replace(/\\/g, '/');

let nodeWordPath = null;
/**
 * The Node that runs the tests under a path that is one plain word, as the first word of the Codex hook
 * command must be: a junction (a dir symlink off Windows) to its folder in an OS temp dir, since this Node
 * may sit under a folder with a space (Program Files).
 */
function nodeWord() {
  if (!nodeWordPath) {
    const link = dirLink(path.dirname(process.execPath), path.join(tempDir('guard-hook-nodebin-'), 'nodebin'));
    nodeWordPath = fwd(path.join(link, path.basename(process.execPath)));
  }
  return nodeWordPath;
}

/** All files under dir, relative, sorted. */
function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();
}

const claudeInput = (tool, command, mode = 'default') => ({
  session_id: 'synthetic-session', transcript_path: '~/.claude/projects/demo/synthetic-session.jsonl', cwd: '~/demo',
  permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'toolu_synthetic',
});
const codexInput = (command, tool = 'shell', field = 'command') => ({
  session_id: 'synthetic-session', turn_id: 'synthetic-turn', cwd: '~/demo', model: 'synthetic-model',
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { [field]: command },
});

const decision = (tool, command) => decide(claudeInput(tool, command), 'claude').decision;
/** A Claude input in a mode that cannot show the confirmation dialog, where a push is still a plain deny. */
const claudeNoDialog = (tool, command) => claudeInput(tool, command, 'dontAsk');
/**
 * A push on Claude, both ways: asked where the dialog can appear (mode default) and denied where it cannot
 * (mode dontAsk). PUSH is the one good answer; anything else shows both decisions.
 */
const PUSH = 'ask, and deny without a dialog';
const pushDecision = (tool, command) => {
  const asked = decide(claudeInput(tool, command), 'claude').decision;
  const refused = decide(claudeNoDialog(tool, command), 'claude').decision;
  return asked === 'ask' && refused === 'deny' ? PUSH : `${asked} in mode default, ${refused} in mode dontAsk`;
};
const codexDecision = (command, tool, field) => decide(codexInput(command, tool, field), 'codex').decision;

/** Run the guard on one input; returns exit code, stdout, stderr and the elapsed milliseconds. */
function runGuard(input, args = []) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { code: r.status, out: r.stdout, err: r.stderr, ms };
}

/** A temp runtime with a config pointing at it. */
function tempRuntime() {
  const root = tempDir();
  const runtime = path.join(root, 'rt');
  const config = path.join(root, 'hook-config.json');
  fs.writeFileSync(config, JSON.stringify({ runtime }));
  return { root, runtime, config, heartbeat: path.join(runtime, 'hooks', 'heartbeat', 'guard.jsonl') };
}

/** Assert every command gets the expected decision (one assertion message per command). */
function expectAll(fn, commands, expected) {
  for (const c of commands) assert.equal(fn(c), expected, `${expected} expected for: ${JSON.stringify(c)}`);
}

describe('rule 1, Bash form', () => {
  test('git push in every spelling: asked, and denied without a dialog', () => {
    expectAll((c) => pushDecision('Bash', c), [
      'git push',
      'git push origin main',
      '  git push --force-with-lease origin HEAD',
      'git -C ../demo push',
      'git -C "D:/example/demo repo" push origin main',
      'git -c credential.helper= -c core.quotepath=off push',
      'git --git-dir=.git --work-tree=. push',
      'git --git-dir .git --work-tree . push',
      'git --no-pager push',
      'git.exe push',
      '/usr/bin/git push',
      '"C:/Program Files/Git/cmd/git.exe" push',
      'git push https://example.com/acme/demo.git main',
      'git push git@example.com:acme/demo.git HEAD:main',
      'git -c alias.p=push p origin main',
      "git -c 'alias.ship=!git push' ship",
      'git send-pack https://example.com/acme/demo.git main',
      'git subtree push --prefix dist origin gh-pages',
      'git lfs push origin main',
      'GIT_TRACE=1 git push',
      'env GIT_TRACE=1 git push',
      'command git push',
      'nohup git push &',
      'timeout 60 git push',
      'echo origin | xargs git push',
      '\\git push',
      "g'i't push",
    ], PUSH);
  });

  test('git push behind ; && || | & groups, substitutions and wrapped shells: asked, and denied without a dialog', () => {
    expectAll((c) => pushDecision('Bash', c), [
      'git status; git push',
      'git add -A && git commit -m "wip" && git push',
      'git fetch || git push',
      'echo done | git push',
      'npm test & git push',
      '(git push)',
      '{ git push; }',
      'if true; then git push; fi',
      'echo "$(git push)"',
      'echo `git push`',
      'x=$(git push 2>&1)',
      'git status\ngit push',
      'git status \\\n  && git push',
      'git push > push.log 2>&1',
      'bash -c "git push"',
      "bash -lc 'cd demo && git push origin main'",
      'sh -c "git status; git push"',
      'cmd /c "git push"',
      'cmd.exe /C git push origin main',
      'powershell -NoProfile -Command "git push"',
      "pwsh -c '& git push'",
    ], PUSH);
  });

  test('deny: gh repo, release, pr and workflow writes', () => {
    expectAll((c) => decision('Bash', c), [
      'gh repo create acme/demo --public',
      'gh repo delete acme/demo --yes',
      'gh repo edit --visibility public',
      'gh repo fork acme/demo',
      'gh repo rename demo2',
      'gh repo archive acme/demo',
      'gh repo sync',
      'gh repo deploy-key add key.pub',
      'gh release create v1.0.0 --notes x',
      'gh release upload v1.0.0 dist/demo.zip',
      'gh release edit v1.0.0 --draft=false',
      'gh release delete v1.0.0 --yes',
      'gh pr create --fill',
      'gh pr merge 12 --squash',
      'gh pr comment 12 --body "looks good"',
      'gh pr review 12 --approve',
      'gh pr close 12',
      'gh pr edit 12 --title x',
      'gh pr ready 12',
      'gh -R acme/demo pr create --fill',
      'gh pr create -R acme/demo --fill',
      'gh workflow run ci.yml',
      'gh workflow enable ci.yml',
      'gh workflow disable ci.yml',
      'gh.exe pr merge 12',
    ], 'deny');
  });

  test('deny: gh api with a write method or a body', () => {
    expectAll((c) => decision('Bash', c), [
      'gh api -X POST repos/acme/demo/issues',
      'gh api -XPOST repos/acme/demo/issues',
      'gh api --method PUT repos/acme/demo/topics',
      'gh api --method=patch repos/acme/demo',
      'gh api -X DELETE repos/acme/demo',
      'gh api repos/acme/demo/issues -f title=x',
      'gh api repos/acme/demo/issues -F number=1',
      'gh api repos/acme/demo/issues -ftitle=x',
      'gh api repos/acme/demo/issues --field title=x',
      'gh api repos/acme/demo/issues --raw-field title=x',
      'gh api repos/acme/demo/issues --input body.json',
      "gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'",
    ], 'deny');
  });

  test('deny: npm publish', () => {
    expectAll((c) => decision('Bash', c), [
      'npm publish',
      'npm publish --access public',
      'npm --registry https://registry.example.com publish',
      'npm.cmd publish --tag next',
      'npm run build && npm publish',
    ], 'deny');
  });

  test('allow: reads, local git and text that only mentions a push', () => {
    expectAll((c) => decision('Bash', c), [
      'git status',
      'git log --oneline -5',
      'git diff --stat HEAD~1',
      'git fetch origin',
      'git pull --ff-only',
      'git remote -v',
      'git config --get remote.origin.pushurl',
      'git help push',
      'git commit -m "docs: explain why git push is blocked"',
      "git log --grep 'push'",
      'echo "git push"',
      "echo 'git push origin main'",
      'grep -rn "git push" docs',
      'git status # git push comes later, from the owner',
      'git status 2>&1 | head -5',
      'gh pr view 12',
      'gh pr list --state open',
      'gh pr status',
      'gh pr diff 12',
      'gh pr checks 12',
      'gh pr checkout 12',
      'gh pr create --help',
      'gh repo view acme/demo',
      'gh repo clone acme/demo',
      'gh repo deploy-key list',
      'gh release list',
      'gh release view v1.0.0',
      'gh release download v1.0.0',
      'gh workflow list',
      'gh workflow view ci.yml',
      'gh run list',
      'gh api repos/acme/demo/pulls',
      'gh api -X GET repos/acme/demo',
      'gh api --method get repos/acme/demo',
      'gh api -X GET search/issues -f q=repo:acme/demo',
      'gh api --paginate repos/acme/demo/issues --jq ".[].title"',
      'npm install',
      'npm run build',
      'npm view demo-package version',
      'npm pack',
      'npm run publish-docs',
      '',
    ], 'allow');
  });

  test("ANSI-C quotes $'...': \\' and other escapes are read as bash does; an open quote is still an error", () => {
    expectAll((c) => decision('Bash', c), [
      "echo $'it\\'s done'",
      "git commit -m $'fix: don\\'t drop notes\\n\\nsecond line'",
      "printf $'a\\tb\\\\' && git status",
      "echo $'git push is left to the owner\\''",
    ], 'allow');
    expectAll((c) => pushDecision('Bash', c), [
      "git $'push' origin main",
      "git $'\\x70ush'",
      "git $'\\160ush' origin",
      "$'git' push",
      "git commit -m $'it\\'s' && git push",
    ], PUSH);
    const cfg = ['--config', path.join(tempDir(), 'missing.json')];
    const ok = runGuard(claudeInput('Bash', "git commit -m $'it\\'s done'"), cfg);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out, '');
    for (const open of ["echo $'it\\'s", "echo $'abc", "git commit -m 'it\\'s'"]) {
      const r = runGuard(claudeInput('Bash', open), cfg);
      assert.equal(r.code, 2, `${open}: exit code`);
      assert.match(r.err, /单引号没有结束/, open);
    }
  });

  test('allow: the heredoc commit message pattern, even with push lines, quotes and parentheses in the body', () => {
    const cmd = [
      'git add hooks/guard.mjs && git commit -m "$(cat <<\'EOF\'',
      'feat(hooks): add the guard (rule 1)',
      '',
      "git push is left to the owner; it's done from a normal terminal.",
      'git push origin main',
      'EOF',
      ')"',
    ].join('\n');
    assert.equal(decision('Bash', cmd), 'allow');
    assert.equal(decision('Bash', 'cat <<-EOF > notes.txt\n\tgit push\n\tEOF\ngit status'), 'allow');
    assert.equal(pushDecision('Bash', 'cat <<EOF\ngit push\nEOF\ngit push'), PUSH, 'the command after the body is still checked');
  });
});

describe('rule 1, PowerShell form', () => {
  test('git push in every spelling, with the & call: asked, and denied without a dialog', () => {
    expectAll((c) => pushDecision('PowerShell', c), [
      'git push',
      'git push origin main',
      '& git push origin main',
      '& git.exe push',
      '& "C:\\Program Files\\Git\\cmd\\git.exe" push',
      "& 'C:\\Program Files\\Git\\bin\\git.exe' -C 'D:\\example\\demo' push",
      'git -C D:\\example\\demo -c core.sshCommand=ssh push',
      'git --git-dir=.git push',
      'git push https://example.com/acme/demo.git main',
      'Set-Location D:\\example\\demo; git push',
      'git status; if ($LASTEXITCODE -eq 0) { git push }',
      'git fetch && git push',
      'git fetch || git push',
      'git push origin main 2>&1 | Out-Null',
      'git push *> push.log',
      'git push `\n  origin main',
      'Invoke-Command -ScriptBlock { git push }',
      'Write-Output "$(git push)"',
      '$out = $(git push)',
      '$out = @(git push)',
      '$out = (git push)',
      "Start-Process git -ArgumentList 'push','origin' -Wait",
      'Start-Process -FilePath git.exe -ArgumentList "push origin main" -NoNewWindow',
      'saps git push',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "git push"',
      "pwsh -nop -c 'git push'",
      'powershell git push',
      'cmd /c git push',
      'bash -lc "git push"',
    ], PUSH);
  });

  test('deny: gh writes, gh api writes and npm publish', () => {
    expectAll((c) => decision('PowerShell', c), [
      'gh repo create acme/demo --private',
      'gh release create v1.0.0',
      'gh pr create --fill',
      'gh pr merge 12 --squash',
      '& gh.exe workflow run ci.yml',
      'gh api -X POST repos/acme/demo/issues',
      'gh api --method DELETE repos/acme/demo',
      'gh api repos/acme/demo/issues -f title=x',
      'gh api repos/acme/demo/issues --input body.json',
      'npm publish',
      '& npm.cmd publish --tag next',
      'npm run build; npm publish',
    ], 'deny');
  });

  test('allow: reads, local git, here-strings and text that only mentions a push', () => {
    expectAll((c) => decision('PowerShell', c), [
      'git status',
      'git log -5 --oneline',
      'git status; git diff --stat',
      'git commit -m "docs: why git push is blocked"',
      "git commit -m 'it''s not a git push'",
      'git commit -m @"\nfeat(hooks): add the guard\ngit push origin main\n"@',
      "git commit -m @'\ngit push is the owner's job\n'@",
      "Write-Output 'git push'",
      'Select-String -Path docs\\*.md -Pattern "git push"',
      'git status # then git push, by the owner',
      '<# git push #> git status',
      'gh pr view 12',
      'gh pr list',
      'gh release view v1.0.0',
      'gh workflow view ci.yml',
      'gh api repos/acme/demo/pulls',
      'gh api -X GET repos/acme/demo',
      'npm install',
      'npm run build',
      'Get-ChildItem -Recurse | Where-Object { $_.Name -like "*push*" }',
      '$h = @{ name = "push" }; $h.name',
    ], 'allow');
  });
});

describe('rule 1, Codex input', () => {
  test('a string command is read as both Bash and PowerShell', () => {
    expectAll((c) => codexDecision(c), [
      'git push',
      "& 'C:\\Program Files\\Git\\cmd\\git.exe' push",
      'git -C ../demo push',
      'powershell -NoProfile -Command "git push origin main"',
      'gh pr create --fill',
      'npm publish',
    ], 'deny');
    expectAll((c) => codexDecision(c), ['git status', 'gh pr view 12', 'gh api repos/acme/demo/pulls', "Write-Output 'git push'"], 'allow');
  });

  test('an argv command is one command; wrapped shells are unwrapped', () => {
    expectAll((c) => codexDecision(c), [
      ['git', 'push'],
      ['git.exe', '-C', 'D:\\example\\demo', 'push', 'origin', 'main'],
      ['powershell.exe', '-NoProfile', '-Command', 'git status; git push'],
      ['bash', '-lc', 'git push'],
      ['gh', 'release', 'create', 'v1.0.0'],
      ['npm', 'publish'],
    ], 'deny');
    expectAll((c) => codexDecision(c), [['git', 'status'], ['gh', 'pr', 'view', '12'], ['echo', 'git push']], 'allow');
  });

  test('other shell tool names and the cmd field are read too', () => {
    assert.equal(codexDecision('git push', 'exec_command', 'cmd'), 'deny');
    assert.equal(codexDecision('git push', 'local_shell'), 'deny');
    assert.equal(codexDecision('git push', 'Bash'), 'deny');
    assert.equal(codexDecision('git status', 'unified_exec', 'cmd'), 'allow');
  });
});

// Field sets as C0 T-meta recorded them for codex-cli 0.166 (2026-10-31); every value here is synthetic.
const C0_ROOT = {
  session_id: '00000000-0000-7000-8000-000000000001', turn_id: '00000000-0000-7000-8000-0000000000a1',
  transcript_path: '~/.codex/sessions/2026/10/31/rollout-synthetic.jsonl', cwd: '~/demo', hook_event_name: 'PreToolUse',
  model: 'synthetic-model', permission_mode: 'bypassPermissions', tool_use_id: 'call_synthetic',
};
const C0_CHILD = { ...C0_ROOT, agent_id: '00000000-0000-7000-8000-000000000002', agent_type: 'default' };
const c0 = (base, tool, toolInput) => decide({ ...base, tool_name: tool, tool_input: toolInput }, 'codex').decision;

describe('Codex input in the shape C0 recorded (T-meta)', () => {
  test('shell calls are Bash with the raw string, PowerShell included; git -C reads stay allowed', () => {
    assert.equal(c0(C0_ROOT, 'Bash', { command: 'node tools/print-env.mjs CODEX_THREAD_ID --label root' }), 'allow');
    assert.equal(c0(C0_CHILD, 'Bash', { command: 'git -C ~/demo rev-parse --show-toplevel --abbrev-ref HEAD' }), 'allow');
    assert.equal(c0(C0_CHILD, 'Bash', { command: "Get-Content -LiteralPath '~/demo/AGENTS.md'" }), 'allow');
    assert.equal(c0(C0_CHILD, 'Bash', { command: 'git -C ~/demo push' }), 'deny');
    assert.equal(c0(C0_ROOT, 'Bash', { command: "Set-Location '~/demo'; & git.exe push origin HEAD" }), 'deny');
  });

  test('the platform is detected as codex from these inputs, though they carry permission_mode', () => {
    const r = spawnSync(process.execPath, [GUARD, '--config', path.join(tempDir(), 'missing.json')],
      { input: JSON.stringify({ ...C0_CHILD, tool_name: 'Bash', tool_input: { command: 'git push' } }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });

  test('rule 3 on Codex names: a child thread writing the ledger is denied, the root and reads are allowed', () => {
    assert.equal(c0(C0_CHILD, 'mcp__project_manager__update_task_status', { id: 'T1', status: 'done' }), 'deny');
    assert.equal(c0(C0_CHILD, 'mcp__project_manager__set_project_dir', { project_dir: '~/demo' }), 'deny');
    assert.equal(c0(C0_CHILD, 'mcp__project_manager__get_server_info', {}), 'allow');
    assert.equal(c0(C0_ROOT, 'mcp__project_manager__update_task_status', { id: 'T1', status: 'done' }), 'allow');
  });

  test('spawn, wait and other MCP tools are allowed', () => {
    assert.equal(c0(C0_ROOT, 'collaborationspawn_agent', { agent_type: 'default', fork_turns: 'none', task_name: 'demo' }), 'allow');
    assert.equal(c0(C0_ROOT, 'collaborationwait_agent', { timeout_ms: 60000 }), 'allow');
    assert.equal(c0(C0_CHILD, 'mcp__meta_logger__log_meta', { label: 'child' }), 'allow');
  });
});

describe('scope', () => {
  test('other tools and other events are allowed', () => {
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'notes.md' } }, 'claude').decision, 'allow');
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'mcp__demo__run', tool_input: { command: 'git push' } }, 'claude').decision, 'allow');
    assert.equal(decide({ ...claudeInput('Bash', 'git push'), hook_event_name: 'PostToolUse' }, 'claude').decision, 'allow');
  });
});

const WIN = process.platform === 'win32';

/**
 * Rule 2 fixture in a temp dir: the read-only folder vault/ (with a file and a sub folder), a sibling
 * vault-copy/ whose name starts the same, and work/vault-link, a junction to vault/.
 */
function readonlyFixture() {
  const root = tempDir('guard-readonly-');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'a.txt'), 'synthetic\n');
  fs.mkdirSync(path.join(root, 'vault-copy'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const link = dirLink(vault, path.join(work, 'vault-link'));
  return { root, vault, work, link };
}

/** One rule-2 decision: tool, tool_input, cwd and the registered read-only folders. */
function writeDecision(tool, toolInput, cwd, readonlyDirs, platform = 'claude') {
  const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd };
  return decide(input, platform, { readonlyDirs }).decision;
}

/** Git Bash spelling of a Windows path: C:\x\y -> /c/x/y. */
const msys = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');

describe('rule 2, read-only folders', () => {
  test('deny: Edit, Write, MultiEdit and NotebookEdit into the folder, by absolute and relative path', () => {
    const f = readonlyFixture();
    const ro = [f.vault];
    const d = (tool, ti, cwd = f.root) => writeDecision(tool, ti, cwd, ro);
    assert.equal(d('Write', { file_path: path.join(f.vault, 'new.md'), content: 'x' }), 'deny');
    assert.equal(d('Edit', { file_path: path.join(f.vault, 'a.txt'), old_string: 'a', new_string: 'b' }), 'deny');
    assert.equal(d('MultiEdit', { file_path: path.join(f.vault, 'a.txt'), edits: [] }), 'deny');
    assert.equal(d('NotebookEdit', { notebook_path: path.join(f.vault, 'sub', 'n.ipynb'), new_source: 'x' }), 'deny');
    assert.equal(d('Write', { file_path: path.join(f.vault, 'sub', 'deeper', 'new.md'), content: 'x' }), 'deny', 'a path that does not exist yet');
    assert.equal(d('Write', { file_path: f.vault, content: 'x' }), 'deny', 'the folder itself');
    assert.equal(d('Write', { file_path: 'vault/new.md', content: 'x' }), 'deny', 'relative to cwd');
    assert.equal(d('Edit', { file_path: '../vault/a.txt', old_string: 'a', new_string: 'b' }, f.work), 'deny', 'with ..');
  });

  test('deny: case and slash spellings of the same path (Windows)', { skip: !WIN && 'Windows paths only' }, () => {
    const f = readonlyFixture();
    const target = path.join(f.vault, 'a.txt');
    for (const p of [target.toUpperCase(), target.toLowerCase(), target.replace(/\\/g, '/'), target.replace(/\\/g, '/').toUpperCase(),
      `${path.join(f.vault, 'sub')}/new.md`, msys(target)]) {
      assert.equal(writeDecision('Edit', { file_path: p, old_string: 'a', new_string: 'b' }, f.root, [f.vault]), 'deny', p);
    }
    for (const dir of [f.vault.toUpperCase(), f.vault.replace(/\\/g, '/'), `${f.vault}\\`, `${f.vault.replace(/\\/g, '/')}/`]) {
      assert.equal(writeDecision('Write', { file_path: target, content: 'x' }, f.root, [dir]), 'deny', `registered as ${dir}`);
    }
  });

  test('deny: through a junction, both ways', () => {
    const f = readonlyFixture();
    assert.equal(fs.readFileSync(path.join(f.link, 'a.txt'), 'utf8'), 'synthetic\n', 'the junction reaches the folder');
    assert.equal(writeDecision('Edit', { file_path: path.join(f.link, 'a.txt'), old_string: 'a', new_string: 'b' }, f.root, [f.vault]), 'deny');
    assert.equal(writeDecision('Write', { file_path: path.join(f.link, 'sub', 'new.md'), content: 'x' }, f.root, [f.vault]), 'deny', 'new file under the link');
    assert.equal(writeDecision('Write', { file_path: 'vault-link/new.md', content: 'x' }, f.work, [f.vault]), 'deny', 'relative, through the link');
    assert.equal(writeDecision('Write', { file_path: path.join(f.vault, 'new.md'), content: 'x' }, f.root, [f.link]), 'deny', 'registered by the link path');
  });

  test('allow: siblings, other tools, the main checkout and no registered folder', () => {
    const f = readonlyFixture();
    const ro = [f.vault];
    assert.equal(writeDecision('Write', { file_path: path.join(f.root, 'vault-copy', 'x.md'), content: 'x' }, f.root, ro), 'allow', 'same name prefix');
    assert.equal(writeDecision('Write', { file_path: path.join(f.root, 'vault.md'), content: 'x' }, f.root, ro), 'allow');
    assert.equal(writeDecision('Edit', { file_path: path.join(f.work, 'notes.md'), old_string: 'a', new_string: 'b' }, f.root, ro), 'allow');
    assert.equal(writeDecision('Read', { file_path: path.join(f.vault, 'a.txt') }, f.root, ro), 'allow', 'reads are not rule 2');
    assert.equal(writeDecision('Grep', { pattern: 'x', path: f.vault }, f.root, ro), 'allow');
    assert.equal(writeDecision('Write', { file_path: path.join(f.vault, 'new.md'), content: 'x' }, f.root, []), 'allow', 'nothing registered');
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(f.vault, 'n.md') } }, 'claude').decision,
      'allow', 'no policy');
  });

  test('Codex apply_patch: every Add, Update, Delete and Move to path is checked', () => {
    const f = readonlyFixture();
    const ro = [f.vault];
    const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
    const inVault = patch(`*** Update File: ${path.join(f.vault, 'a.txt')}`, '@@', '-synthetic', '+changed');
    const d = (ti, cwd = f.root) => writeDecision('apply_patch', ti, cwd, ro, 'codex');
    assert.equal(d({ command: inVault }), 'deny');
    assert.equal(d({ input: inVault }), 'deny');
    assert.equal(d(inVault), 'deny', 'tool_input as the patch string');
    assert.equal(d({ command: ['apply_patch', inVault] }), 'deny', 'argv form');
    assert.equal(d({ command: patch('*** Add File: vault/new.md', '+x') }), 'deny', 'relative Add File');
    assert.equal(d({ command: patch(`*** Delete File: ${path.join(f.link, 'a.txt')}`) }), 'deny', 'Delete File through the junction');
    assert.equal(d({ command: patch(`*** Update File: ${path.join(f.work, 'x.md')}`, `*** Move to: ${path.join(f.vault, 'x.md')}`, '@@', '-a', '+b') }), 'deny',
      'Move to into the folder');
    assert.equal(d({ command: patch(`*** Update File: ${path.join(f.work, 'x.md')}`, '@@', '-a', '+b', `*** Add File: ${path.join(f.root, 'vault-copy', 'y.md')}`, '+y') }),
      'allow');
    assert.deepEqual(patchPaths(patch('*** Add File: a.md', '+x', '*** Update File: b.md', '*** Move to: c.md', '*** Delete File: d.md')),
      ['a.md', 'b.md', 'c.md', 'd.md']);
    assert.throws(() => d({ command: 'not a patch' }), /读不出要改的文件路径/, 'no path: error, so Claude-side onFailure blocks');
    assert.throws(() => writeDecision('Write', { content: 'x' }, f.root, ro), /没有可读的目标路径/);
  });

  test('Edit or Write without file_path is read as a patch (command, input or patch); neither is still an error', () => {
    const f = readonlyFixture();
    const ro = [f.vault];
    const patch = (target) => ['*** Begin Patch', `*** Add File: ${target}`, '+x', '*** End Patch'].join('\n');
    for (const tool of ['Edit', 'Write']) {
      for (const field of ['command', 'input', 'patch']) {
        assert.equal(writeDecision(tool, { [field]: patch(path.join(f.vault, 'n.md')) }, f.root, ro, 'codex'), 'deny', `${tool} ${field}`);
        assert.equal(writeDecision(tool, { [field]: patch(path.join(f.work, 'n.md')) }, f.root, ro, 'codex'), 'allow', `${tool} ${field}`);
      }
      assert.throws(() => writeDecision(tool, { command: 'not a patch' }, f.root, ro, 'codex'), /没有可读的目标路径，也没有可读的补丁/, tool);
    }
    // file_path still wins when it is there.
    assert.equal(writeDecision('Write', { file_path: path.join(f.work, 'n.md'), command: patch(path.join(f.vault, 'n.md')) }, f.root, ro), 'allow');
  });

  test('the guard never touches the fixture', () => {
    const f = readonlyFixture();
    const before = listFiles(f.vault);
    writeDecision('Write', { file_path: path.join(f.vault, 'new.md'), content: 'x' }, f.root, [f.vault]);
    writeDecision('apply_patch', { command: `*** Add File: ${path.join(f.vault, 'p.md')}\n+x` }, f.root, [f.vault], 'codex');
    assert.deepEqual(listFiles(f.vault), before);
  });
});

const SUBAGENT = { agent_id: 'agent-synthetic-1', agent_type: 'general-purpose' };
const LEDGER_WRITES = ['set_project_dir', 'update_task_status', 'update_tasks', 'create_tasks', 'edit_task', 'edit_tasks', 'add_log',
  'add_subtask', 'close_task', 'close_tasks', 'reopen_task', 'rename_task', 'set_task_priority', 'save_prd', 'save_architecture',
  'update_project_info', 'set_current_focus', 'archive_module', 'migrate_tasks_schema', 'reconcile', 'some_future_tool'];
const LEDGER_READ_TOOLS = ['get_all_tasks', 'get_task_by_id', 'get_logs', 'get_next_task', 'get_project_context', 'get_project_info',
  'get_prd', 'get_architecture', 'get_current_focus', 'get_portfolio', 'get_server_info', 'get_verification_profiles', 'lint_state'];

/** One rule-3 decision. */
function ledgerDecision(tool, extra = {}, toolInput = {}, platform = 'claude') {
  return decide({ session_id: 'synthetic-session', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, ...extra }, platform);
}

describe('rule 3, subagents do not write the ledger', () => {
  test('deny: a subagent calling a write tool, set_project_dir or an unknown project-manager tool', () => {
    for (const t of LEDGER_WRITES) {
      const r = ledgerDecision(`mcp__project-manager__${t}`, SUBAGENT);
      assert.equal(r.decision, 'deny', t);
      assert.match(r.reason, /子代理/);
      assert.match(r.reason, new RegExp(t));
    }
    assert.match(ledgerDecision('mcp__project-manager__set_project_dir', SUBAGENT).reason, /账本目标/);
  });

  test('allow: a subagent reading the ledger', () => {
    for (const t of LEDGER_READ_TOOLS) assert.equal(ledgerDecision(`mcp__project-manager__${t}`, SUBAGENT).decision, 'allow', t);
  });

  test('allow: the main session (no agent_id) writes and switches the ledger', () => {
    for (const t of [...LEDGER_WRITES, ...LEDGER_READ_TOOLS]) assert.equal(ledgerDecision(`mcp__project-manager__${t}`).decision, 'allow', t);
    assert.equal(ledgerDecision('mcp__project-manager__update_task_status', { agent_id: '' }).decision, 'allow', 'empty agent_id');
    assert.equal(ledgerDecision('mcp__project-manager__update_task_status', { agent_id: null }).decision, 'allow', 'null agent_id');
  });

  test('other spellings of the server and tool name (C0 saw mcp__project_manager__<tool> on Codex)', () => {
    for (const tool of ['mcp__project_manager__add_log', 'project-manager.add_log', 'project-manager/add_log', 'project_manager:add_log',
      'mcp__plugin_kit_project-manager__add_log', 'MCP__Project-Manager__Add_Log']) {
      assert.equal(ledgerDecision(tool, SUBAGENT).decision, 'deny', tool);
    }
    assert.equal(ledgerDecision('add_log', SUBAGENT, { server: 'project-manager' }).decision, 'deny', 'server in tool_input');
    assert.equal(ledgerDecision('call', SUBAGENT, { server_name: 'project_manager', tool: 'get_logs' }).decision, 'allow', 'read named in tool_input');
    const codexSub = { turn_id: 'synthetic-turn', ...SUBAGENT };
    assert.equal(ledgerDecision('mcp__project-manager__update_tasks', codexSub, {}, 'codex').decision, 'deny');
    assert.equal(ledgerDecision('mcp__project-manager__update_tasks', { turn_id: 'synthetic-turn' }, {}, 'codex').decision, 'allow', 'Codex root thread');
  });

  test('allow: tools of other servers, even with ledger-like names', () => {
    assert.equal(ledgerDecision('mcp__demo__update_task_status', SUBAGENT).decision, 'allow');
    assert.equal(ledgerDecision('mcp__project-manager-viewer-x__noop', SUBAGENT).decision, 'allow');
    assert.equal(ledgerDecision('Read', SUBAGENT, { file_path: 'notes.md' }).decision, 'allow');
  });
});

/**
 * Rule 4 fixture in a temp dir: kit/ is a fake AutoSkills checkout (.git, hooks/guard.mjs,
 * scripts/lint-kit.mjs, _private/) with a nested repo kit/nested; other/ is an unrelated repo and
 * plain/ a repo without the markers (for kit_repo from the config).
 */
function kitFixture() {
  const root = tempDir('guard-kit-');
  const kit = path.join(root, 'kit');
  for (const d of ['.git', 'hooks', 'scripts', 'tests', '_private', path.join('nested', '.git')]) fs.mkdirSync(path.join(kit, d), { recursive: true });
  fs.writeFileSync(path.join(kit, 'hooks', 'guard.mjs'), '// synthetic marker\n');
  fs.writeFileSync(path.join(kit, 'scripts', 'lint-kit.mjs'), '// synthetic marker\n');
  for (const d of [path.join('other', '.git'), path.join('plain', '.git'), path.join('plain', 'src')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  return { root, kit, other: path.join(root, 'other'), plain: path.join(root, 'plain') };
}

const shellDecision = (tool, command, cwd, kitRepos = []) => decide(
  { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd, permission_mode: 'default' }, 'claude', { kitRepos },
).decision;

describe('rule 4, git clean -x/-X in the AutoSkills repo', () => {
  test('deny: in the checkout, in Bash form', () => {
    const f = kitFixture();
    expectAll((c) => shellDecision('Bash', c, f.kit), [
      'git clean -fdx',
      'git clean -xfd',
      'git clean -ffdx',
      'git clean -fX',
      'git clean -d -f -x',
      'git clean -x -f -- _private',
      'git clean -fdx -e node_modules',
      'git -c core.quotepath=off clean -fdx',
      'git -c "alias.wipe=clean -fdx" wipe',
      'git.exe clean -fdx',
      'git status && git clean -fdx',
      'bash -lc "git clean -fdx"',
      'cd tests && git clean -fdx',
    ], 'deny');
    const r = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git clean -fdx' }, cwd: f.kit }, 'claude');
    assert.match(r.reason, /_private\//);
    assert.match(r.reason, /git clean -n/);
  });

  test('deny: in the checkout, in PowerShell form', () => {
    const f = kitFixture();
    expectAll((c) => shellDecision('PowerShell', c, f.kit), [
      'git clean -fdx',
      '& git clean -fX',
      'Set-Location tests; git clean -xdf',
      'powershell -NoProfile -Command "git clean -fdx"',
    ], 'deny');
  });

  test('allow: -n, -fd and the like in the checkout', () => {
    const f = kitFixture();
    for (const tool of ['Bash', 'PowerShell']) {
      expectAll((c) => shellDecision(tool, c, f.kit), [
        'git clean -n',
        'git clean -fd',
        'git clean -f',
        'git clean -nd',
        'git clean -n -x',
        'git clean --dry-run -X',
        'git clean -ndX',
        'git clean -fd -e x',
        'git clean -fdex',
        'git clean -fd -- -x',
        'git status',
        'echo "git clean -fdx"',
      ], 'allow');
    }
  });

  test('deny: the checkout reached from elsewhere (-C, cd, --git-dir, Git Bash paths)', () => {
    const f = kitFixture();
    expectAll((c) => shellDecision('Bash', c, f.other), [
      `git -C "${f.kit}" clean -fdx`,
      `git -C "${f.root}" -C kit clean -fdx`,
      `cd "${f.kit}" && git clean -fdx`,
      `cd "${path.join(f.kit, 'tests')}"; git clean -fX`,
      `pushd "${f.kit}" && git clean -fdx`,
      `git --git-dir="${path.join(f.kit, '.git')}" --work-tree="${f.kit}" clean -fdx`,
      `git --work-tree "${f.kit}" clean -xdf`,
    ], 'deny');
    expectAll((c) => shellDecision('PowerShell', c, f.other), [
      `Set-Location -Path '${f.kit}'; git clean -fdx`,
      `cd '${f.kit}'; git clean -fdx`,
      `git -C '${f.kit}' clean -fX`,
    ], 'deny');
    if (WIN) {
      assert.equal(shellDecision('Bash', `cd ${msys(f.kit)} && git clean -fdx`, f.other), 'deny', 'Git Bash drive path');
      assert.equal(shellDecision('Bash', 'git clean -fdx', f.kit.toUpperCase()), 'deny', 'upper-case cwd');
    }
  });

  test('allow: other repositories, a nested repo inside the checkout', () => {
    const f = kitFixture();
    assert.equal(shellDecision('Bash', 'git clean -fdx', f.other), 'allow');
    assert.equal(shellDecision('PowerShell', 'git clean -fdX', f.other), 'allow');
    assert.equal(shellDecision('Bash', 'git clean -fdx', path.join(f.kit, 'nested')), 'allow', 'nested repo: only it is cleaned');
    assert.equal(shellDecision('Bash', `git -C "${f.other}" clean -fdx`, f.root), 'allow');
  });

  test('kit_repo from the config marks a checkout without the markers', () => {
    const f = kitFixture();
    assert.equal(shellDecision('Bash', 'git clean -fdx', f.plain), 'allow', 'no markers, not configured');
    assert.equal(shellDecision('Bash', 'git clean -fdx', f.plain, [f.plain]), 'deny');
    assert.equal(shellDecision('Bash', 'git clean -fdx', path.join(f.plain, 'src'), [f.plain]), 'deny', 'sub folder');
    assert.equal(shellDecision('Bash', 'git clean -fd', f.plain, [f.plain]), 'allow');
    assert.equal(shellDecision('Bash', 'git clean -fdx', path.join(f.kit, 'nested'), [f.kit]), 'allow', 'nested repo below the configured one');
    if (WIN) assert.equal(shellDecision('Bash', 'git clean -fdx', f.plain, [f.plain.toUpperCase().replace(/\\/g, '/')]), 'deny', 'case and slashes');
  });

  test('this repository counts as an AutoSkills checkout (read only)', () => {
    assert.equal(shellDecision('Bash', 'git clean -fdx', REPO), 'deny');
    assert.equal(shellDecision('PowerShell', 'git clean -fd', REPO), 'allow');
    assert.equal(shellDecision('Bash', 'git clean -n -x', REPO), 'allow');
  });

  test('rules 1 and 4 together: both reasons', () => {
    const f = kitFixture();
    const r = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git clean -fdx && git push' }, cwd: f.kit }, 'claude');
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /git push/);
    assert.match(r.reason, /_private\//);
  });
});

// Documented, not desired: see the gap list at the top of this file and ADR-006 §4.
describe('known gaps (ADR-006 §4 residual risks, allowed on purpose)', () => {
  test('shell writes into a read-only folder and subagent calls without agent_id', () => {
    const f = readonlyFixture();
    const target = path.join(f.vault, 'a.txt');
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo x > "${target}"` }, cwd: f.root },
      'claude', { readonlyDirs: [f.vault] }).decision, 'allow');
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: `Set-Content -Path '${target}' -Value x` },
      cwd: f.root }, 'claude', { readonlyDirs: [f.vault] }).decision, 'allow');
    assert.equal(ledgerDecision('mcp__project-manager__update_task_status').decision, 'allow', 'no agent_id: treated as the main session');
  });

  test('indirect execution and commands built at run time are not seen', () => {
    const encoded = Buffer.from('git push', 'utf16le').toString('base64');
    expectAll((c) => decision('Bash', c), [
      'bash push.sh',
      './push.sh',
      'git $(echo push)',
      'g=git; $g push',
    ], 'allow');
    expectAll((c) => decision('PowerShell', c), [
      './push.ps1',
      'pwsh -File push.ps1',
      'Invoke-Expression "git push"',
      "iex 'git push origin main'",
      `powershell -EncodedCommand ${encoded}`,
      "$g = 'git'; & $g push",
      'git p',
    ], 'allow');
  });

  test('substitutions in unquoted here-doc and @"..."@ here-string bodies are not seen', () => {
    assert.equal(decision('Bash', 'cat <<EOF\n$(git push)\nEOF'), 'allow');
    assert.equal(decision('Bash', 'cat <<EOF\n`git push`\nEOF'), 'allow');
    assert.equal(decision('PowerShell', 'Write-Output @"\n$(git push)\n"@'), 'allow');
  });
});

describe('rule 1: a push is asked only where the owner can answer (AS3-379)', () => {
  const push = 'git push https://example.com/acme/demo.git main';
  const inMode = (mode, command = push, tool = 'Bash') => decide(claudeInput(tool, command, mode), 'claude');

  test('the modes: ask in default, acceptEdits, auto, plan and bypassPermissions; deny in dontAsk, with no mode and with an unknown one', () => {
    assert.deepEqual([...ASK_MODES].sort(), ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'plan']);
    for (const mode of ASK_MODES) assert.equal(inMode(mode).decision, 'ask', mode);
    for (const mode of ['dontAsk', 'somethingNew', '', 'DEFAULT', null, 7, ['default']]) assert.equal(inMode(mode).decision, 'deny', JSON.stringify(mode));
    const { permission_mode, ...noMode } = claudeInput('Bash', push);
    assert.equal(permission_mode, 'default');
    assert.equal(decide(noMode, 'claude').decision, 'deny', 'no permission_mode field');
  });

  test('only on platform claude: codex and an unknown platform deny, whatever the mode says', () => {
    for (const mode of ASK_MODES) {
      assert.equal(decide(claudeInput('Bash', push, mode), 'codex').decision, 'deny', `codex, ${mode}`);
      assert.equal(decide(claudeInput('Bash', push, mode), 'unknown').decision, 'deny', `unknown, ${mode}`);
      assert.equal(decide({ ...codexInput(push), permission_mode: mode }, 'codex').decision, 'deny', `codex input, ${mode}`);
    }
  });

  test('a push beside anything else that is refused stays a deny', () => {
    const kit = tempDir();
    for (const command of [
      'git push origin main && npm publish',
      'npm publish; git push origin main',
      'git push origin main; gh pr create --fill',
      'gh release create v1.0.0 && git push --tags',
      'git push origin main | gh api -X POST repos/acme/demo/issues',
    ]) {
      for (const mode of ASK_MODES) assert.equal(inMode(mode, command).decision, 'deny', `${mode}: ${command}`);
    }
    const withClean = { ...claudeInput('Bash', 'git clean -fdx && git push origin main'), cwd: kit };
    assert.equal(decide(withClean, 'claude', { kitRepos: [kit] }).decision, 'deny', 'git clean -x in the kit repo beside a push');
    assert.equal(decide({ ...withClean, tool_input: { command: 'git clean -fd && git push origin main' } }, 'claude', { kitRepos: [kit] }).decision, 'ask', 'a clean without -x is no reason to refuse');
  });

  test('publishing and gh writes are never asked', () => {
    for (const mode of [...ASK_MODES, 'dontAsk']) {
      for (const command of ['npm publish', 'npm publish --access public', 'gh pr create --fill', 'gh release create v1.0.0', 'gh repo create acme/demo --public', 'gh api -X POST repos/acme/demo/issues', 'gh workflow run ci.yml']) {
        assert.equal(inMode(mode, command).decision, 'deny', `${mode}: ${command}`);
        assert.equal(inMode(mode, command, 'PowerShell').decision, 'deny', `${mode}, PowerShell: ${command}`);
      }
    }
  });

  test('the ask reason is for the owner: it names the push and says a yes is needed; the deny reason says why there was no dialog', () => {
    const asked = inMode('bypassPermissions');
    assert.match(asked.reason, /git push/);
    assert.match(asked.reason, /点同意才推送/);
    assert.doesNotMatch(asked.reason, /拒绝了这条命令/);
    const refused = inMode('dontAsk');
    assert.match(refused.reason, /拒绝了这条命令/);
    assert.match(refused.reason, /确认窗/);
    assert.match(refused.reason, new RegExp(REASON_HINT));
  });

  test('spawned: the ask is one JSON line with permissionDecision ask, exit 0, and the heartbeat says ask', () => {
    const rt = tempRuntime();
    const r = runGuard(claudeInput('Bash', push, 'bypassPermissions'), ['--config', rt.config, '--platform', 'claude']);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.length, 1);
    const o = JSON.parse(lines[0]).hookSpecificOutput;
    assert.equal(o.hookEventName, 'PreToolUse');
    assert.equal(o.permissionDecision, 'ask');
    assert.match(o.permissionDecisionReason, /点同意才推送/);
    // Without --platform the Claude input is detected as claude and asks too.
    assert.equal(JSON.parse(runGuard(claudeInput('PowerShell', '& git.exe push'), ['--config', rt.config]).out).hookSpecificOutput.permissionDecision, 'ask');
    const entries = fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => e.decision), ['ask', 'ask']);
    assert.deepEqual(entries.map((e) => e.platform), ['claude', 'claude']);
    assert.doesNotMatch(fs.readFileSync(rt.heartbeat, 'utf8'), /git|example\.com/);
  });

  test('spawned with --platform codex: the same Claude-looking input is a deny, never an ask', () => {
    const rt = tempRuntime();
    for (const mode of ASK_MODES) {
      const r = runGuard(claudeInput('Bash', push, mode), ['--config', rt.config, '--platform', 'codex']);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny', mode);
    }
    const decisions = fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n').map((l) => JSON.parse(l).decision);
    assert.deepEqual([...new Set(decisions)], ['deny']);
  });

  test('a call the guard cannot read is still an error, not an ask', () => {
    const r = runGuard(claudeInput('Bash', 'git push "origin', 'bypassPermissions'), ['--config', path.join(tempDir(), 'missing.json')]);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
  });
});

describe('hook contract (spawned guard)', () => {
  test('deny: one UTF-8 JSON line on stdout, exit 0, the reason says who pushes', () => {
    const r = runGuard(claudeNoDialog('Bash', 'git push origin main'), ['--config', path.join(tempDir(), 'missing.json')]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.length, 1);
    const j = JSON.parse(lines[0]);
    assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, new RegExp(REASON_HINT));
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /git push/);
  });

  test('started through a junction (symlink elsewhere) to hooks/: the guard still runs and push is still denied', () => {
    const link = dirLink(path.join(REPO, 'hooks'), path.join(tempDir(), 'hooks-link'));
    const viaLink = path.join(link, 'guard.mjs');
    assert.notEqual(fs.realpathSync(viaLink).toLowerCase(), viaLink.toLowerCase(), 'the path really goes through a link');
    const cfg = ['--config', path.join(tempDir(), 'missing.json')];
    const spawnLinked = (file, input, args) => spawnSync(process.execPath, [file, ...args], { input: JSON.stringify(input), encoding: 'utf8' });
    const deny = spawnLinked(viaLink, claudeNoDialog('Bash', 'git push origin main'), cfg);
    assert.equal(deny.status, 0, deny.stderr);
    assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const ps = spawnLinked(viaLink, claudeNoDialog('PowerShell', '& git.exe push'), cfg);
    assert.equal(JSON.parse(ps.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const self = spawnSync(process.execPath, [viaLink, '--selftest'], { encoding: 'utf8', input: '' });
    assert.equal(self.status, 0, self.stderr);
    assert.match(self.stdout, /ok \(\d+ samples\)/, '--selftest prints its result, so main() ran');
    // The SessionStart hook has the same entry check.
    const start = spawnLinked(path.join(link, 'session-start.mjs'), { session_id: 'synthetic-session', source: 'startup', hook_event_name: 'SessionStart' }, cfg);
    assert.equal(start.status, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  });

  test('deny on Codex input uses the same output; allow prints nothing', () => {
    const cfg = ['--config', path.join(tempDir(), 'missing.json')];
    const deny = runGuard(codexInput(['git', 'push']), cfg);
    assert.equal(deny.code, 0, deny.err);
    assert.equal(JSON.parse(deny.out).hookSpecificOutput.permissionDecision, 'deny');
    const allow = runGuard(claudeInput('PowerShell', 'git status'), cfg);
    assert.equal(allow.code, 0, allow.err);
    assert.equal(allow.out, '');
  });

  test('heartbeat: one line per run with exactly ts, platform, event and decision, never the command', () => {
    const rt = tempRuntime();
    const marker = 'feature-zz-heartbeat-marker';
    runGuard(claudeNoDialog('Bash', `git push origin ${marker}`), ['--config', rt.config]);
    runGuard(claudeInput('Bash', `git log ${marker}`), ['--config', rt.config]);
    runGuard(codexInput(`git push origin ${marker}`), ['--config', rt.config]);
    runGuard(claudeInput('Bash', `git push "${marker}`), ['--config', rt.config]);
    const text = fs.readFileSync(rt.heartbeat, 'utf8');
    assert.doesNotMatch(text, new RegExp(marker));
    assert.doesNotMatch(text, /git/);
    const entries = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entries.length, 4);
    for (const e of entries) {
      assert.deepEqual(Object.keys(e).sort(), ['decision', 'event', 'platform', 'ts']);
      assert.equal(e.event, 'PreToolUse');
      assert.ok(!Number.isNaN(Date.parse(e.ts)));
    }
    assert.deepEqual(entries.map((e) => e.decision), ['deny', 'allow', 'deny', 'error']);
    assert.deepEqual(entries.map((e) => e.platform), ['claude', 'claude', 'codex', 'claude']);
    assert.equal(JSON.parse(runGuardLast(rt)).platform, 'codex', '--platform wins over the input');
  });

  /** One more run with --platform codex on a Claude input; returns the last heartbeat line. */
  function runGuardLast(rt) {
    runGuard(claudeInput('Bash', 'git status'), ['--config', rt.config, '--platform', 'codex']);
    return fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n').pop();
  }

  test('heartbeat: a file over 1 MiB is cut to its newest whole lines before the next line', () => {
    const rt = tempRuntime();
    fs.mkdirSync(path.dirname(rt.heartbeat), { recursive: true });
    const old = `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', platform: 'claude', event: 'PreToolUse', decision: 'allow' })}\n`;
    fs.writeFileSync(rt.heartbeat, old.repeat(Math.ceil((1024 * 1024 + 4096) / old.length)));
    assert.ok(fs.statSync(rt.heartbeat).size > 1024 * 1024);
    const r = runGuard(claudeNoDialog('Bash', 'git push'), ['--config', rt.config]);
    assert.equal(r.code, 0, r.err);
    const size = fs.statSync(rt.heartbeat).size;
    assert.ok(size <= 1024 * 1024, `size after the cut: ${size}`);
    assert.ok(size > 0);
    const lines = fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n');
    for (const l of lines) JSON.parse(l); // whole lines only
    assert.equal(JSON.parse(lines.at(-1)).decision, 'deny');
    assert.equal(JSON.parse(lines.at(-1)).ts.startsWith('2026-01-01'), false);
  });

  test('no config file: no heartbeat, the decision still holds', () => {
    const dir = tempDir();
    const r = runGuard(claudeNoDialog('Bash', 'git push'), ['--config', path.join(dir, 'hook-config.json')]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(listFiles(dir), []);
  });

  test('--selftest runs the built-in samples and writes no file', () => {
    const rt = tempRuntime();
    const before = listFiles(rt.root);
    const cwd = tempDir();
    const r = spawnSync(process.execPath, [GUARD, '--selftest', '--config', rt.config], { cwd, encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ok \\(${SELFTEST.length} samples\\)`));
    assert.deepEqual(listFiles(rt.root), before);
    assert.deepEqual(listFiles(cwd), []);
    assert.ok(SELFTEST.some((s) => s[2] === 'deny') && SELFTEST.some((s) => s[2] === 'allow'));
  });

  test('errors exit non-zero with the reason on stderr and no decision on stdout', () => {
    const cfg = ['--config', path.join(tempDir(), 'missing.json')];
    const cases = [
      ['not JSON', 'git push'],
      ['JSON but not an object', '["git","push"]'],
      ['Bash: unterminated double quote', claudeInput('Bash', 'git push "origin')],
      ['Bash: unterminated single quote', claudeInput('Bash', "git commit -m 'wip")],
      ['Bash: unterminated $(', claudeInput('Bash', 'echo $(git status')],
      ['PowerShell: unterminated quote', claudeInput('PowerShell', "git push 'origin")],
      ['PowerShell: unterminated here-string', claudeInput('PowerShell', 'git commit -m @"\nmessage')],
      ['PowerShell: unterminated block comment', claudeInput('PowerShell', '<# note git status')],
      ['Codex: no dialect parses it', codexInput('git push "origin')],
      ['no command text', { ...claudeInput('Bash', 'x'), tool_input: {} }],
    ];
    for (const [label, input] of cases) {
      const r = runGuard(input, cfg);
      assert.notEqual(r.code, 0, `${label}: exit code`);
      assert.equal(r.out, '', `${label}: stdout`);
      assert.match(r.err, /AutoSkills 守卫/, `${label}: stderr`);
    }
    const unknown = runGuard(claudeInput('Bash', 'git status'), ['--platform', 'other']);
    assert.equal(unknown.code, 2);
  });

  /** Assert a failed Codex run: one deny JSON line whose reason starts with ERROR_DENY_MARK, exit 0, the reason on stderr. */
  function expectErrorDeny(r, label) {
    assert.equal(r.code, 0, `${label}: exit code (stderr: ${r.err})`);
    const lines = r.out.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `${label}: one line on stdout: ${r.out}`);
    const o = JSON.parse(lines[0]).hookSpecificOutput;
    assert.equal(o.hookEventName, 'PreToolUse', label);
    assert.equal(o.permissionDecision, 'deny', label);
    assert.ok(o.permissionDecisionReason.startsWith(ERROR_DENY_MARK), `${label}: ${o.permissionDecisionReason}`);
    assert.match(r.err, /AutoSkills 守卫.*已按失败处理|^guard: /, `${label}: stderr`);
    return o.permissionDecisionReason;
  }

  /** The three errors of AS3-126 (broken config, a command that does not parse, input that is not JSON), each with its config file. */
  function codexErrorCases() {
    const dir = tempDir();
    const missing = path.join(dir, 'missing.json');
    const bad = path.join(dir, 'hook-config.json');
    fs.writeFileSync(bad, '{ runtime: ');
    const bash = (command) => ({ ...C0_ROOT, tool_name: 'Bash', tool_input: { command } });
    return {
      missing,
      bash,
      errors: [
        ['broken config', bash('git status'), bad, /本地配置 ".*" 不是合法的 JSON/],
        ['command does not parse', bash("echo it's done"), missing, /单引号没有结束/],
        ['input is not JSON', 'not json', missing, /钩子输入不是合法的 JSON/],
      ],
    };
  }

  test('fail closed on Codex: every error prints the deny JSON naming the error and exits 0, the reason also on stderr (AS3-126)', () => {
    const { errors, missing, bash } = codexErrorCases();
    const dir = tempDir();
    const ro = path.join(dir, 'ro.json');
    fs.writeFileSync(ro, JSON.stringify({ readonly_dirs: [path.join(dir, 'vault')] }));
    const cases = [
      ...errors.map(([label, input, config, why]) => [label, input, ['--platform', 'codex', '--config', config], why]),
      ['no command text', { ...C0_ROOT, tool_name: 'Bash', tool_input: {} }, ['--platform', 'codex', '--config', missing], /没有可读的命令文本/],
      ['Edit with neither a path nor a patch', { ...C0_CHILD, tool_name: 'Edit', tool_input: { command: 'x' } }, ['--platform', 'codex', '--config', ro], /没有可读的目标路径/],
      ['unknown option', bash('git status'), ['--platform', 'codex', '--bogus'], /用法错误（.*--bogus/],
      ['unknown option, --platform=codex', bash('git status'), ['--platform=codex', '--bogus'], /用法错误/],
    ];
    for (const [label, input, args, why] of cases) assert.match(expectErrorDeny(runGuard(input, args), label), why, label);
    // The Claude side is unchanged: the same errors exit 2 with nothing on stdout.
    for (const [label, input, args] of cases) {
      const r = runGuard(input, args.map((a) => a.replace(/^(--platform=)?codex$/, '$1claude')));
      assert.equal(r.code, 2, `claude, ${label}: exit code`);
      assert.equal(r.out, '', `claude, ${label}: stdout`);
      assert.match(r.err, /AutoSkills 守卫.*已按失败处理|^guard: /, `claude, ${label}: stderr`);
    }
  });

  test('fail closed on Codex in each shell its hook may run in (check-kit\'s shellForms): the three errors give the deny JSON and exit 0, allow and deny are unchanged', (t) => {
    const { errors, missing, bash } = codexErrorCases();
    // The Codex line as config/codex/hooks.json writes it: the Node path one plain word, the script path quoted.
    const line = (config) => `${nodeWord()} "${fwd(GUARD)}" --platform codex --config "${fwd(config)}"`;
    const run = (form, input) => {
      const r = spawnSync(form.file, form.args, {
        input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true,
        windowsVerbatimArguments: !!form.verbatim, timeout: 60_000,
      });
      return { code: r.status, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? ` (${r.error.code})` : ''}` };
    };
    const vias = shellForms(line(missing)).map((f) => f.via);
    if (WIN) for (const v of ['cmd /d /s /c', 'cmd /c', 'powershell -Command']) assert.ok(vias.includes(v), `${v} in ${vias.join(', ')}`);
    t.diagnostic(`shells run: ${vias.join(', ')}`);
    for (const [label, input, config, why] of errors) {
      for (const form of shellForms(line(config))) assert.match(expectErrorDeny(run(form, input), `${form.via}, ${label}`), why, `${form.via}, ${label}`);
    }
    for (const form of shellForms(line(missing))) {
      const allow = run(form, bash('git status'));
      assert.equal(allow.code, 0, `${form.via}, allow: ${allow.err}`);
      assert.equal(allow.out, '', `${form.via}, allow: stdout`);
      const deny = run(form, bash('git push origin main'));
      assert.equal(deny.code, 0, `${form.via}, deny: ${deny.err}`);
      const o = JSON.parse(deny.out.trim()).hookSpecificOutput;
      assert.equal(o.permissionDecision, 'deny', form.via);
      assert.match(o.permissionDecisionReason, new RegExp(REASON_HINT), form.via);
      assert.ok(!o.permissionDecisionReason.startsWith(ERROR_DENY_MARK), `${form.via}: a rule deny is not an error deny`);
    }
  });

  test('a config that exists but cannot be parsed is an error', () => {
    const dir = tempDir();
    const bad = path.join(dir, 'hook-config.json');
    fs.writeFileSync(bad, '{ runtime: ');
    const r = runGuard(claudeInput('Bash', 'git status'), ['--config', bad]);
    assert.equal(r.code, 2);
    assert.match(r.err, /hook-config\.json"/, 'the path is quoted');
    fs.writeFileSync(bad, JSON.stringify({ runtime: 'relative/rt' }));
    assert.equal(runGuard(claudeInput('Bash', 'git status'), ['--config', bad]).code, 2);
    for (const cfg of [{ readonly_dirs: ['relative/vault'] }, { readonly_dirs: 'not-a-list' }, { kit_repo: 'relative/kit' }]) {
      fs.writeFileSync(bad, JSON.stringify(cfg));
      const r = runGuard(claudeInput('Bash', 'git status'), ['--config', bad]);
      assert.equal(r.code, 2, JSON.stringify(cfg));
      assert.equal(r.out, '');
    }
  });

  test('config: readonly_dirs and kit_repo reach rules 2 and 4 of the spawned guard', () => {
    const f = readonlyFixture();
    const k = kitFixture();
    const rt = tempRuntime();
    fs.writeFileSync(rt.config, JSON.stringify({ runtime: rt.runtime, readonly_dirs: [f.vault], kit_repo: k.plain }));
    const write = runGuard({ ...claudeInput('Write', 'x'), tool_input: { file_path: path.join(f.link, 'new.md'), content: 'x' }, cwd: f.root },
      ['--config', rt.config]);
    assert.equal(write.code, 0, write.err);
    const j = JSON.parse(write.out);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /只读目录/);
    const clean = runGuard({ ...claudeInput('Bash', 'git clean -fdx'), cwd: k.plain }, ['--config', rt.config]);
    assert.equal(JSON.parse(clean.out).hookSpecificOutput.permissionDecision, 'deny', clean.err);
    const sub = runGuard({ ...claudeInput('x', 'x'), tool_name: 'mcp__project-manager__add_log', tool_input: { type: 'note' }, ...SUBAGENT },
      ['--config', rt.config]);
    assert.match(JSON.parse(sub.out).hookSpecificOutput.permissionDecisionReason, /子代理/);
    const ok = runGuard({ ...claudeInput('Write', 'x'), tool_input: { file_path: path.join(f.work, 'n.md'), content: 'x' }, cwd: f.root },
      ['--config', rt.config]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out, '');
    const noTarget = runGuard({ ...claudeInput('Write', 'x'), tool_input: { content: 'x' } }, ['--config', rt.config]);
    assert.equal(noTarget.code, 2, 'a write tool without a target is an error while folders are registered');
    const beats = fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(beats.map((b) => b.decision), ['deny', 'deny', 'deny', 'allow', 'error']);
    assert.doesNotMatch(fs.readFileSync(rt.heartbeat, 'utf8'), /vault|new\.md|add_log/, 'no paths or tool names in the heartbeat');
  });

  test('timing: one call of the guard, per Node version', (t) => {
    const rt = tempRuntime();
    const runs = { deny: [], allow: [] };
    for (let i = 0; i < 5; i++) {
      runs.deny.push(runGuard(claudeInput('Bash', 'git -C ../demo push origin main'), ['--config', rt.config]).ms);
      runs.allow.push(runGuard(claudeInput('PowerShell', 'git status; git log -3 --oneline'), ['--config', rt.config]).ms);
    }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    for (const [kind, xs] of Object.entries(runs)) {
      t.diagnostic(`guard single call, node ${process.version}, ${kind}: median ${median(xs).toFixed(1)} ms `
        + `(min ${Math.min(...xs).toFixed(1)}, max ${Math.max(...xs).toFixed(1)}, n=${xs.length}, process spawn included)`);
    }
    assert.equal(fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n').length, 10);
  });
});
