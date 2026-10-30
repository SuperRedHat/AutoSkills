// Tests for scripts/bootstrap.ps1 and scripts/bootstrap.sh (node:test, zero dependencies). Every run is a
// dry-run with --local-config pointed at synthetic files in an OS temp dir, so the scripts stop at the deploy
// prerequisites check: nothing is built or registered and deploy-kit never reads the user directory.
// bootstrap.ps1 runs under Windows PowerShell (5.1) on Windows; bootstrap.sh under bash (Git Bash on Windows,
// found next to git; never the WSL launcher). A shell that is not there skips its tests.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const RETIRED = ['sync-skills', 'backup-global-workflow', 'restore-global-workflow'];

const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
  temps.push(dir);
  return dir;
}
const slash = (p) => p.split(path.sep).join('/');

/** Git Bash on Windows (<git>/bin/bash.exe), bash elsewhere; null when there is none. */
function findBash() {
  if (!WIN) return spawnSync('bash', ['-c', 'exit 0']).status === 0 ? 'bash' : null;
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  // <git>/mingw64/libexec/git-core -> <git>/bin/bash.exe
  const bash = path.resolve(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
  return fs.existsSync(bash) ? bash : null;
}

const SHELLS = [
  {
    name: 'bootstrap.ps1 (Windows PowerShell)',
    skip: WIN ? false : 'Windows only',
    run: (localConfig) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(REPO, 'scripts', 'bootstrap.ps1'), '-DryRun', '-LocalConfig', localConfig], { encoding: 'utf8', cwd: REPO }),
  },
  (() => {
    const bash = findBash();
    return {
      name: 'bootstrap.sh (bash)',
      skip: bash ? false : 'no bash found',
      run: (localConfig) => spawnSync(bash, [path.join(REPO, 'scripts', 'bootstrap.sh').split(path.sep).join('/'), '--dry-run',
        `--local-config=${slash(localConfig)}`], { encoding: 'utf8', cwd: REPO }),
    };
  })(),
];

for (const sh of SHELLS) {
  describe(sh.name, { skip: sh.skip }, () => {
    test('reads mcp-manifest.json and only prints the build and the registration', () => {
      const r = sh.run(path.join(tempDir(), 'missing', 'kit-local.json'));
      assert.match(r.stdout, /resolved command: node \S*mcp[\\/]project-manager[\\/]dist[\\/]index\.js/);
      assert.match(r.stdout, /\[dry-run\] npm run build/);
      assert.doesNotMatch(r.stdout, /\[action\]/);
    });

    test('a missing local config exits 3 with the --init-local remedy and does not run deploy-kit', () => {
      const cfg = path.join(tempDir(), 'missing', 'kit-local.json');
      const r = sh.run(cfg);
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stdout, /\[missing\] local config not found/);
      assert.match(r.stdout, /node scripts\/deploy-kit\.mjs --init-local/);
      assert.match(r.stdout, /deploy-kit was not run/);
      assert.doesNotMatch(r.stdout, /deploy-kit: dry-run/);
      assert.equal(fs.existsSync(cfg), false);
    });

    test('a portable Node that does not exist exits 3 with the download and verify steps', () => {
      const dir = tempDir();
      const runtime = path.join(dir, 'rt');
      const cfg = path.join(dir, 'kit-local.json');
      fs.writeFileSync(cfg, JSON.stringify({ runtime: slash(runtime), portable_node: slash(path.join(runtime, 'node-v24.22.2-win-x64', 'node.exe')) }));
      const r = sh.run(cfg);
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stdout, /\[missing\] portable Node: .*does not exist/);
      assert.match(r.stdout, /https:\/\/nodejs\.org\/dist\/v24\.22\.2\/\S+ and \S+\/SHASUMS256\.txt/);
      assert.match(r.stdout, /--init-local --runtime /);
      assert.doesNotMatch(r.stdout, /deploy-kit: dry-run/);
      assert.equal(fs.existsSync(runtime), false);
    });

    test('portable_node null and an invalid config also exit 3', () => {
      const dir = tempDir();
      const unset = path.join(dir, 'unset.json');
      fs.writeFileSync(unset, JSON.stringify({ runtime: null, portable_node: null }));
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, '{bad');
      const r1 = sh.run(unset);
      assert.equal(r1.status, 3, r1.stdout + r1.stderr);
      assert.match(r1.stdout, /portable_node is not set/);
      const r2 = sh.run(bad);
      assert.equal(r2.status, 3, r2.stdout + r2.stderr);
      assert.match(r2.stdout, /not a valid JSON object/);
      assert.match(r2.stdout, /Fix the JSON in /);
    });
  });
}

test('the manifest and both bootstraps name no retired script and no third platform', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'mcp-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.servers['project-manager'].trust).sort(), ['claude', 'codex']);
  for (const f of ['bootstrap.ps1', 'bootstrap.sh']) {
    const text = fs.readFileSync(path.join(REPO, 'scripts', f), 'utf8');
    assert.doesNotMatch(text, /gemini/i, `${f} names Gemini`);
    for (const name of RETIRED) {
      assert.equal(text.includes(name), false, `${f} names ${name}`);
      assert.equal(fs.existsSync(path.join(REPO, 'scripts', `${name}.ps1`)), false);
      assert.equal(fs.existsSync(path.join(REPO, 'scripts', `${name}.sh`)), false);
    }
  }
});
