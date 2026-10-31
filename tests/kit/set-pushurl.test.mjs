// Tests for scripts/set-pushurl.mjs (node:test, zero dependencies). Every repository is synthetic: the
// fixture builds throwaway git repos with example.com remotes in OS temp dirs, never fetches or pushes,
// and the tests remove them (links first). git runs with an empty global config and no system config,
// so the owner's own git settings never leak into a result; the script under test gets the same env.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRepos } from '../../scripts/set-pushurl.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'set-pushurl.mjs');

const temps = [];
const links = [];
function tempDir(name = 'set-pushurl-') {
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
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(at);
  return at;
}

// Hermetic git: an empty global config, no system config, a synthetic identity.
const GIT_HOME = tempDir('set-pushurl-gitcfg-');
const EMPTY_GLOBAL = path.join(GIT_HOME, 'empty.gitconfig');
fs.writeFileSync(EMPTY_GLOBAL, '');
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))),
  GIT_CONFIG_GLOBAL: EMPTY_GLOBAL, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Kit Test', GIT_AUTHOR_EMAIL: 'noreply@example.com',
  GIT_COMMITTER_NAME: 'Kit Test', GIT_COMMITTER_EMAIL: 'noreply@example.com',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

/** A new repo at dir with the given remotes ({name: url}) and optional pushurls ({name: [values]}). */
function makeRepo(dir, remotes = {}, pushurls = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, url] of Object.entries(remotes)) git(dir, 'remote', 'add', name, url);
  for (const [name, values] of Object.entries(pushurls)) for (const v of values) git(dir, 'config', '--add', `remote.${name}.pushurl`, v);
  return dir;
}

/** pushurl values of a remote in the repo config ([] when unset). */
function pushurls(dir, remote) {
  const r = spawnSync('git', ['config', '--local', '--get-all', `remote.${remote}.pushurl`], { cwd: dir, env: ENV, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** git config --list of a config file, sorted. */
const configList = (file) => git(path.dirname(file), 'config', '--file', file, '--list').split(/\r?\n/).filter(Boolean).sort();

/** sha256 of every file under dir, walked with lstat (links recorded, never entered). */
function treeHash(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (st.isSymbolicLink()) out[rel] = 'link';
      else if (st.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Changed, added and removed files between two treeHash results. */
function treeDiff(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

/**
 * The synthetic projects root:
 *   alpha/                        origin + upstream (upstream already no_push)
 *   alpha-wt/                     a worktree of alpha
 *   beta/                         origin with a pushurl of its own
 *   group/sub/gamma/              a repo two levels down
 *   local-only/                   no remotes
 *   node_modules/zeta/            never looked at
 *   ro/delta/                     inside the registered read-only dir
 *   delta-wt/                     a worktree of ro/delta: its common dir is read-only
 *   lab/_private/eval/runs/r1/epsilon/  a measurement repo
 *   old-wt/.venv -> <outside>/target    a junction to a repo outside the root (skipped by name)
 *   old-wt/checkout -> <outside>/target a junction with an ordinary name (lstat sees the link)
 * plus <outside>/target, a repo with a remote, and the local config naming ro/ read-only.
 */
function fixture() {
  const base = tempDir();
  const root = path.join(base, 'projects');
  const outside = path.join(base, 'outside');
  const alpha = makeRepo(path.join(root, 'alpha'), { origin: 'https://example.com/demo/alpha.git', upstream: 'https://example.com/acme/alpha.git' }, { upstream: ['no_push'] });
  git(alpha, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(alpha, 'worktree', 'add', '-q', '-b', 'wt', path.join(root, 'alpha-wt'));
  const beta = makeRepo(path.join(root, 'beta'), { origin: 'https://example.com/demo/beta.git' }, { origin: ['https://example.com/demo/beta-push.git'] });
  const gamma = makeRepo(path.join(root, 'group', 'sub', 'gamma'), { origin: 'https://example.com/demo/gamma.git' });
  const localOnly = makeRepo(path.join(root, 'local-only'));
  const zeta = makeRepo(path.join(root, 'node_modules', 'zeta'), { origin: 'https://example.com/demo/zeta.git' });
  const delta = makeRepo(path.join(root, 'ro', 'delta'), { origin: 'https://example.com/demo/delta.git' });
  git(delta, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(delta, 'worktree', 'add', '-q', '-b', 'wt', path.join(root, 'delta-wt'));
  const epsilon = makeRepo(path.join(root, 'lab', '_private', 'eval', 'runs', 'r1', 'epsilon'), { origin: 'https://example.com/demo/epsilon.git' });
  const target = makeRepo(path.join(outside, 'target'), { origin: 'https://example.com/demo/target.git' });
  fs.mkdirSync(path.join(root, 'old-wt'), { recursive: true });
  dirLink(target, path.join(root, 'old-wt', '.venv'));
  const link = dirLink(target, path.join(root, 'old-wt', 'checkout'));
  const localConfig = path.join(base, 'kit-local.json');
  fs.writeFileSync(localConfig, JSON.stringify({ readonly_dirs: [path.join(root, 'ro')] }));
  return { base, root, outside, alpha, beta, gamma, localOnly, zeta, delta, epsilon, target, link, localConfig };
}

/** Run set-pushurl; returns exit code and output. */
function run(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const scanArgs = (f, ...rest) => ['--root', f.root, '--depth', '6', '--local-config', f.localConfig, ...rest];
const cfg = (dir) => path.join(dir, '.git', 'config');

describe('scan', () => {
  test('dry-run lists every repo and remote, skips with reasons, and writes nothing', () => {
    const f = fixture();
    const before = { root: treeHash(f.root), outside: treeHash(f.outside) };
    const r = run(...scanArgs(f, '--dry-run'));
    assert.equal(r.code, 0, r.out + r.err);
    const out = r.out;
    // Several remotes, one of them already no_push.
    assert.match(out, /^repo alpha$/m);
    assert.match(out, /^ {2}remote origin: would set pushurl = no_push \(was unset\)$/m);
    assert.match(out, /^ {2}remote upstream: already no_push$/m);
    assert.match(out, /^repo beta\n {2}remote origin: would set pushurl = no_push \(was https:\/\/example\.com\/demo\/beta-push\.git\)$/m);
    // A repo in a subdirectory.
    assert.match(out, /^repo group\/sub\/gamma$/m);
    // Worktree, read-only dir, measurement repo and no remotes are skipped with their reasons.
    assert.match(out, /^skip alpha-wt: same git common dir as alpha \(worktree\)$/m);
    assert.match(out, /^skip ro\/delta: read-only dir .*ro \(registered in the local config\)$/m);
    assert.match(out, /^skip delta-wt: read-only dir .*ro \(registered in the local config\)$/m);
    assert.match(out, /^skip lab\/_private\/eval\/runs\/r1\/epsilon: measurement repo under _private\/eval\/runs\/$/m);
    assert.match(out, /^skip local-only: no remotes$/m);
    // The junction is listed, not followed; .venv and node_modules are not entered.
    assert.match(out, /^link old-wt\/checkout: junction or symlink, not followed$/m);
    assert.doesNotMatch(out, /target|zeta|\.venv/);
    assert.match(out, /^set-pushurl: 3 repo\(s\), 4 remote\(s\): 3 to set, 1 already no_push; 5 repo\(s\) skipped, 1 link\(s\) not followed$/m);
    assert.doesNotMatch(r.err, /not found/);
    assert.deepEqual(treeDiff(before.root, treeHash(f.root)), []);
    assert.deepEqual(treeDiff(before.outside, treeHash(f.outside)), []);
  });

  test('scanRepos uses lstat: the junction is not entered and its target is not a candidate', () => {
    const f = fixture();
    const targetBefore = treeHash(f.target);
    const s = scanRepos(f.root, { depth: 6 });
    const rel = (p) => path.relative(f.root, p).split(path.sep).join('/');
    assert.deepEqual(s.links.map(rel), ['old-wt/checkout']);
    assert.ok(!s.candidates.some((c) => rel(c).startsWith('old-wt/') || rel(c).startsWith('node_modules/')), s.candidates.join('\n'));
    assert.ok(!s.candidates.some((c) => fs.realpathSync(c) === fs.realpathSync(f.target)));
    assert.deepEqual(treeDiff(targetBefore, treeHash(f.target)), []);
  });

  test('--depth limits how far down the walk looks', () => {
    const f = fixture();
    const r = run('--root', f.root, '--depth', '1', '--local-config', f.localConfig, '--dry-run');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^repo alpha$/m);
    assert.doesNotMatch(r.out, /gamma|ro\/delta|epsilon/);
  });

  test('without the local config the read-only dir is not skipped, and a note says so', () => {
    const f = fixture();
    const before = treeHash(f.root);
    const r = run('--root', f.root, '--depth', '6', '--local-config', path.join(f.base, 'missing.json'), '--dry-run');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.err, /local config .*missing\.json not found; read-only dirs are not skipped/);
    // delta-wt sorts first, so the shared config is reached through it and ro/delta counts as its worktree.
    assert.match(r.out, /^repo delta-wt\n {2}remote origin: would set pushurl = no_push \(was unset\)$/m);
    assert.match(r.out, /^skip ro\/delta: same git common dir as delta-wt \(worktree\)$/m);
    assert.doesNotMatch(r.out, /read-only dir/);
    assert.deepEqual(treeDiff(before, treeHash(f.root)), []);
  });
});

describe('apply and revert', () => {
  test('--apply changes only remote.*.pushurl, is idempotent, and --revert restores the original values', () => {
    const f = fixture();
    const handled = [f.alpha, f.beta, f.gamma];
    const lists = Object.fromEntries(handled.map((d) => [d, configList(cfg(d))]));
    const before = { root: treeHash(f.root), outside: treeHash(f.outside) };
    const log1 = path.join(f.base, 'logs', 'apply-1.json');

    const r1 = run(...scanArgs(f, '--apply', '--log', log1));
    assert.equal(r1.code, 0, r1.out + r1.err);
    assert.match(r1.out, /^repo alpha\n {2}remote origin: set pushurl = no_push \(was unset\)\n {2}remote upstream: already no_push$/m);
    assert.match(r1.out, /^ {2}remote origin: set pushurl = no_push \(was https:\/\/example\.com\/demo\/beta-push\.git\)$/m);
    assert.match(r1.out, /^skip ro\/delta: read-only dir/m);
    assert.match(r1.out, /: 3 set, 1 already no_push;/);
    for (const d of handled) assert.deepEqual(pushurls(d, 'origin'), ['no_push'], d);
    assert.deepEqual(pushurls(f.alpha, 'upstream'), ['no_push']);
    // Only the three repo configs changed, and in them only remote.*.pushurl lines.
    const after1 = treeHash(f.root);
    assert.deepEqual(treeDiff(before.root, after1), ['alpha/.git/config', 'beta/.git/config', 'group/sub/gamma/.git/config']);
    for (const d of handled) {
      const changed = (a, b) => a.filter((l) => !b.includes(l));
      const now = configList(cfg(d));
      for (const l of [...changed(lists[d], now), ...changed(now, lists[d])]) assert.match(l, /^remote\.[^=]+\.pushurl=/, `${d}: ${l}`);
    }
    // The junction target outside the root, the read-only repo and the measurement repo are untouched.
    assert.deepEqual(treeDiff(before.outside, treeHash(f.outside)), []);
    // The log holds the original values, written before the change.
    const log = JSON.parse(fs.readFileSync(log1, 'utf8'));
    const entry = (repo, remote) => log.entries.find((e) => fs.realpathSync(e.repo) === fs.realpathSync(repo) && e.remote === remote);
    assert.deepEqual(entry(f.alpha, 'origin'), { ...entry(f.alpha, 'origin'), original: null, action: 'set' });
    assert.deepEqual(entry(f.alpha, 'upstream').original, ['no_push']);
    assert.equal(entry(f.alpha, 'upstream').action, 'unchanged');
    assert.deepEqual(entry(f.beta, 'origin').original, ['https://example.com/demo/beta-push.git']);
    assert.equal(log.entries.length, 4);

    // A second apply changes nothing.
    const log2 = path.join(f.base, 'logs', 'apply-2.json');
    const r2 = run(...scanArgs(f, '--apply', '--log', log2));
    assert.equal(r2.code, 0, r2.out + r2.err);
    assert.match(r2.out, /: 0 set, 4 already no_push;/);
    assert.deepEqual(treeDiff(after1, treeHash(f.root)), []);
    // Reverting the second log restores nothing.
    const r2b = run('--revert', log2, '--local-config', f.localConfig);
    assert.equal(r2b.code, 0, r2b.out + r2b.err);
    assert.match(r2b.out, /0 restored, 0 already restored, 4 not changed by the apply, 0 not restored/);
    assert.deepEqual(treeDiff(after1, treeHash(f.root)), []);

    // Revert dry-run reads only, then the revert restores every original value.
    const rd = run('--revert', log1, '--dry-run', '--local-config', f.localConfig);
    assert.equal(rd.code, 0, rd.out + rd.err);
    assert.match(rd.out, /remote origin: would restore to https:\/\/example\.com\/demo\/beta-push\.git/);
    assert.deepEqual(treeDiff(after1, treeHash(f.root)), []);
    const r3 = run('--revert', log1, '--local-config', f.localConfig);
    assert.equal(r3.code, 0, r3.out + r3.err);
    assert.match(r3.out, /^ {2}remote origin: restored to unset$/m);
    assert.match(r3.out, /^ {2}remote origin: restored to https:\/\/example\.com\/demo\/beta-push\.git$/m);
    assert.match(r3.out, /3 restored, 0 already restored, 1 not changed by the apply, 0 not restored/);
    for (const d of handled) assert.deepEqual(configList(cfg(d)), lists[d], d);
    assert.deepEqual(pushurls(f.alpha, 'upstream'), ['no_push']);
    // Running it again finds everything already restored.
    const r4 = run('--revert', log1, '--local-config', f.localConfig);
    assert.equal(r4.code, 0, r4.out + r4.err);
    assert.match(r4.out, /0 restored, 3 already restored/);
  });

  test('--apply through a worktree path writes the shared config once; a value changed after the apply is not reverted', () => {
    const f = fixture();
    const log = path.join(f.base, 'apply.json');
    const r = run(...scanArgs(f, '--apply', '--log', log));
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(pushurls(path.join(f.root, 'alpha-wt'), 'origin'), ['no_push']);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).entries.filter((e) => e.remote === 'origin' && /alpha/.test(e.repo)).length, 1);
    git(f.gamma, 'config', '--replace-all', 'remote.origin.pushurl', 'https://example.com/demo/gamma-new.git');
    const rv = run('--revert', log, '--local-config', f.localConfig);
    assert.equal(rv.code, 1, rv.out + rv.err);
    assert.match(rv.out, /remote origin: skipped: changed since the apply \(now: https:\/\/example\.com\/demo\/gamma-new\.git\); left as it is/);
    assert.deepEqual(pushurls(f.gamma, 'origin'), ['https://example.com/demo/gamma-new.git']);
    assert.deepEqual(pushurls(f.beta, 'origin'), ['https://example.com/demo/beta-push.git']);
  });

  test('--revert with --root restores only repos under that root', () => {
    const f = fixture();
    const log = path.join(f.base, 'apply.json');
    assert.equal(run(...scanArgs(f, '--apply', '--log', log)).code, 0);
    const rv = run('--revert', log, '--root', path.join(f.root, 'group'), '--local-config', f.localConfig);
    assert.equal(rv.code, 0, rv.out + rv.err);
    assert.deepEqual(pushurls(f.gamma, 'origin'), []);
    assert.deepEqual(pushurls(f.beta, 'origin'), ['no_push']);
    assert.match(rv.out, /1 restored/);
  });
});

describe('usage', () => {
  test('a mode is required, modes exclude each other, an existing log is never overwritten', () => {
    const f = fixture();
    assert.equal(run('--root', f.root).code, 2);
    assert.equal(run('--root', f.root, '--dry-run', '--apply').code, 2);
    assert.equal(run('--root', f.root, '--depth', 'x', '--dry-run').code, 2);
    assert.equal(run('--dry-run').code, 2);
    assert.equal(run('--root', path.join(f.base, 'nope'), '--dry-run').code, 2);
    const log = path.join(f.base, 'exists.json');
    fs.writeFileSync(log, '{}');
    const before = treeHash(f.root);
    const r = run(...scanArgs(f, '--apply', '--log', log));
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /already exists/);
    assert.equal(fs.readFileSync(log, 'utf8'), '{}');
    assert.deepEqual(treeDiff(before, treeHash(f.root)), []);
  });

  test('started through a junction (symlink elsewhere) to scripts/: set-pushurl still runs', () => {
    const link = dirLink(path.join(REPO, 'scripts'), path.join(tempDir(), 'scripts-link'));
    const viaLink = path.join(link, 'set-pushurl.mjs');
    assert.notEqual(fs.realpathSync(viaLink).toLowerCase(), viaLink.toLowerCase(), 'the path really goes through a link');
    const help = spawnSync(process.execPath, [viaLink, '--help'], { env: ENV, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage: node scripts\/set-pushurl\.mjs/, 'the usage is printed, so run() ran');
    const f = fixture();
    const dry = spawnSync(process.execPath, [viaLink, ...scanArgs(f, '--dry-run')], { env: ENV, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.notEqual(dry.stdout.trim(), '', 'the dry-run printed its plan');
    assert.equal(spawnSync(process.execPath, [viaLink, '--dry-run'], { env: ENV, encoding: 'utf8' }).status, 2, 'usage errors still exit 2');
  });

  test('a bad local config is an error, not a silent "no read-only dirs"', () => {
    const f = fixture();
    const bad = path.join(f.base, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ readonly_dirs: ['relative/dir'] }));
    const r = run('--root', f.root, '--local-config', bad, '--dry-run');
    assert.equal(r.code, 2);
    assert.match(r.err, /not an absolute path/);
  });
});
