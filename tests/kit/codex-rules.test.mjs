// Tests for config/codex/rules/autoskills.rules with Codex's own policy checker (node:test, zero
// dependencies). It runs `codex execpolicy check --rules <file> -- <command>` with the codex.exe that ships
// in the Codex desktop app ((Get-AppxPackage OpenAI.Codex).InstallLocation\app\resources\codex.exe); the
// npm codex is not used. Loading the file also validates the match and not_match examples in it.
//
// - Asserted: the three simple commands of ADR-006 §2.5 are forbidden, and nearby reads are not.
// - Recorded only: the forms prefix rules are expected to miss (git -C, git -c, git.exe, bash -lc and
//   powershell.exe -Command wrappers, commands chained with ;). Each result goes to the test output as a
//   diagnostic line; these are left to the guard hook and pushurl, and ADR-006 §4 lists them as residual risk.
//
// codex.exe runs with CODEX_HOME set to a temp dir that the test removes, because it writes helper files
// under its home on every start; the real ~/.codex is neither read nor written. Without codex.exe (not
// Windows, no desktop app, or the exe missing) every test is skipped with the reason.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES = path.join(REPO, 'config', 'codex', 'rules', 'autoskills.rules');

/** The desktop app's codex.exe, or { reason } when it cannot be found. */
function findCodex() {
  if (process.platform !== 'win32') return { reason: 'not Windows: the Codex desktop app (OpenAI.Codex) is a Windows package' };
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-AppxPackage OpenAI.Codex).InstallLocation'],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.error) return { reason: `powershell.exe could not run: ${r.error.message}` };
  const dir = r.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
  if (r.status !== 0 || !dir) return { reason: 'Get-AppxPackage OpenAI.Codex found no installed Codex desktop app' };
  const exe = path.join(dir, 'app', 'resources', 'codex.exe');
  if (!fs.existsSync(exe)) return { reason: `codex.exe not found at ${exe}` };
  return { exe };
}

const codex = findCodex();
const SKIP = codex.exe ? false : `skipped: ${codex.reason}`;
let home;
before(() => { if (codex.exe) home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rules-')); });
after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });

/**
 * The policy decision for one command given as argv tokens: forbidden, prompt, allow, or none when no
 * rule matches. Throws when codex.exe fails or prints something that is not the expected JSON.
 */
function check(argv) {
  const r = spawnSync(codex.exe, ['execpolicy', 'check', '--rules', RULES, '--', ...argv], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, CODEX_HOME: home },
  });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `codex execpolicy check exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.matchedRules), `unexpected output: ${r.stdout}`);
  return out.decision ?? 'none';
}

describe('Codex execpolicy rules', { skip: SKIP }, () => {
  test('the rules file loads and its match/not_match examples hold', (t) => {
    t.diagnostic(`codex.exe: ${codex.exe}`);
    const v = spawnSync(codex.exe, ['--version'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: home } });
    t.diagnostic(`version: ${v.stdout.trim()}`);
    assert.equal(check(['git', 'status']), 'none');
  });

  for (const cmd of [['git', 'push', 'origin', 'main'], ['gh', 'release', 'create', 'x'], ['npm', 'publish']]) {
    test(`forbidden: ${cmd.join(' ')}`, () => {
      assert.equal(check(cmd), 'forbidden');
    });
  }

  test('more simple write forms are forbidden', () => {
    for (const cmd of [['git', 'push'], ['gh', 'pr', 'create', '--fill'], ['gh', 'repo', 'edit', '--visibility', 'public'],
      ['gh', 'workflow', 'run', 'ci.yml'], ['gh', 'api', '-X', 'POST', 'repos/owner/repo/issues'], ['npm', 'publish', '--dry-run']]) {
      assert.equal(check(cmd), 'forbidden', cmd.join(' '));
    }
  });

  test('reads are not matched', () => {
    for (const cmd of [['git', 'status'], ['git', 'log', '--oneline'], ['gh', 'pr', 'view', '1'], ['gh', 'release', 'list'],
      ['gh', 'api', 'repos/owner/repo'], ['gh', 'api', '-X', 'GET', 'repos/owner/repo'], ['npm', 'test']]) {
      assert.equal(check(cmd), 'none', cmd.join(' '));
    }
  });

  // Recorded, not asserted: prefix rules see only the first words of a simple command.
  const RECORDED = [
    ['git -C', ['git', '-C', '.', 'push']],
    ['git -c', ['git', '-c', 'push.default=current', 'push']],
    ['git.exe', ['git.exe', 'push', 'origin', 'main']],
    ['bash -lc wrapper', ['bash', '-lc', 'git push origin main']],
    ['powershell.exe -Command wrapper', ['powershell.exe', '-Command', 'git push origin main']],
    ['; compound (tokens)', ['git', 'status', ';', 'git', 'push', 'origin', 'main']],
    ['; compound in bash -lc', ['bash', '-lc', 'git status; git push origin main']],
    ['; compound in powershell.exe -Command', ['powershell.exe', '-Command', 'git status; git push origin main']],
    ['gh api -X after the endpoint', ['gh', 'api', 'repos/owner/repo/issues', '-X', 'POST']],
  ];
  test('wrapped and compound forms: results recorded (expected to miss; the guard hook and pushurl cover them)', (t) => {
    const rows = RECORDED.map(([label, argv]) => ({ label, argv, decision: check(argv) }));
    for (const { label, argv, decision } of rows) {
      const note = decision === 'none' ? 'not matched, as expected' : 'MATCHED, unlike the expectation in ADR-006 §4';
      t.diagnostic(`${label}: ${JSON.stringify(argv)} -> ${decision} (${note})`);
    }
    for (const { decision } of rows) assert.ok(['none', 'forbidden', 'prompt', 'allow'].includes(decision));
  });
});
