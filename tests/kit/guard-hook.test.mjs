// Tests for hooks/guard.mjs, rule 1 and the skeleton (node:test, zero dependencies). Every input is
// hand-written and synthetic (acme/demo repositories, example.com remotes); heartbeat runtimes and
// configs live in OS temp dirs that the tests remove. The rule matrix calls the exported decide() in
// process; the hook contract (stdout JSON, exit codes, heartbeat, --selftest) is checked by spawning the
// guard with the Node that runs the tests, so running this file under both Node versions covers both.
//
// Known gaps (ADR-006 §4 residual risks: "间接执行能绕过守卫：写进脚本文件再运行、Invoke-Expression、
// 编码过的命令，守卫都看不到原命令"). The guard does not pretend to catch them; the "known gaps" suite
// pins that they are allowed, so a change that starts catching one must update this list, the guard
// header and ADR-006 together:
//   - a push written into a script file and then run: bash push.sh, ./push.ps1, pwsh -File push.ps1;
//   - Invoke-Expression / iex with the command as a string;
//   - powershell -EncodedCommand <base64>;
//   - commands built at run time: $g = 'git'; & $g push, git $(echo push), aliases defined outside the
//     command (git config alias.p push, then git p).
// On one Windows account the guard only prevents mistakes; a deliberate bypass is out of its reach.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, SELFTEST } from '../../hooks/guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO, 'hooks', 'guard.mjs');
const REASON_HINT = '推送由你自己在普通终端做';

const temps = [];
function tempDir(name = 'guard-hook-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temps.push(dir);
  return dir;
}
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

/** All files under dir, relative, sorted. */
function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();
}

const claudeInput = (tool, command) => ({
  session_id: 'synthetic-session', transcript_path: '~/.claude/projects/demo/synthetic-session.jsonl', cwd: '~/demo',
  permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'toolu_synthetic',
});
const codexInput = (command, tool = 'shell', field = 'command') => ({
  session_id: 'synthetic-session', turn_id: 'synthetic-turn', cwd: '~/demo', model: 'synthetic-model',
  hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { [field]: command },
});

const decision = (tool, command) => decide(claudeInput(tool, command), 'claude').decision;
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
  test('deny: git push in every spelling', () => {
    expectAll((c) => decision('Bash', c), [
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
    ], 'deny');
  });

  test('deny: git push behind ; && || | & groups, substitutions and wrapped shells', () => {
    expectAll((c) => decision('Bash', c), [
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
    ], 'deny');
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
    assert.equal(decision('Bash', 'cat <<EOF\ngit push\nEOF\ngit push'), 'deny', 'the command after the body is still checked');
  });
});

describe('rule 1, PowerShell form', () => {
  test('deny: git push in every spelling, with the & call', () => {
    expectAll((c) => decision('PowerShell', c), [
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
    ], 'deny');
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

describe('scope', () => {
  test('other tools and other events are allowed', () => {
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'notes.md' } }, 'claude').decision, 'allow');
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'mcp__demo__run', tool_input: { command: 'git push' } }, 'claude').decision, 'allow');
    assert.equal(decide({ ...claudeInput('Bash', 'git push'), hook_event_name: 'PostToolUse' }, 'claude').decision, 'allow');
  });
});

// Documented, not desired: see the gap list at the top of this file and ADR-006 §4.
describe('known gaps (ADR-006 §4 residual risks, allowed on purpose)', () => {
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
});

describe('hook contract (spawned guard)', () => {
  test('deny: one UTF-8 JSON line on stdout, exit 0, the reason says who pushes', () => {
    const r = runGuard(claudeInput('Bash', 'git push origin main'), ['--config', path.join(tempDir(), 'missing.json')]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.length, 1);
    const j = JSON.parse(lines[0]);
    assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, new RegExp(REASON_HINT));
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /git push/);
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
    runGuard(claudeInput('Bash', `git push origin ${marker}`), ['--config', rt.config]);
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
    const r = runGuard(claudeInput('Bash', 'git push'), ['--config', rt.config]);
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
    const r = runGuard(claudeInput('Bash', 'git push'), ['--config', path.join(dir, 'hook-config.json')]);
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

  test('a config that exists but cannot be parsed is an error', () => {
    const dir = tempDir();
    const bad = path.join(dir, 'hook-config.json');
    fs.writeFileSync(bad, '{ runtime: ');
    const r = runGuard(claudeInput('Bash', 'git status'), ['--config', bad]);
    assert.equal(r.code, 2);
    assert.match(r.err, /hook-config\.json"/, 'the path is quoted');
    fs.writeFileSync(bad, JSON.stringify({ runtime: 'relative/rt' }));
    assert.equal(runGuard(claudeInput('Bash', 'git status'), ['--config', bad]).code, 2);
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
