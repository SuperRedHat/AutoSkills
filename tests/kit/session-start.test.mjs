// Tests for hooks/session-start.mjs (node:test, zero dependencies). Inputs are hand-written and
// synthetic; heartbeat runtimes and configs live in OS temp dirs that the tests remove. The hook is
// spawned with the Node that runs the tests, so running this file under both Node versions covers both.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideSession, hintText, sessionIdOf, SELFTEST } from '../../hooks/session-start.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO, 'hooks', 'session-start.mjs');
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const temps = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-'));
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

/** A temp runtime with a config pointing at it. */
function tempRuntime() {
  const root = tempDir();
  const runtime = path.join(root, 'rt');
  const config = path.join(root, 'hook-config.json');
  fs.writeFileSync(config, JSON.stringify({ runtime }));
  return { root, runtime, config, heartbeat: path.join(runtime, 'hooks', 'heartbeat', 'session-start.jsonl') };
}

const claudeInput = (source, id = `synthetic-session-${source}`) => ({
  session_id: id, transcript_path: `~/.claude/projects/demo/${id}.jsonl`, cwd: '~/demo',
  hook_event_name: 'SessionStart', ...(source === undefined ? {} : { source }), model: 'synthetic-model',
});

/** Run the hook; stdout stays raw bytes so the encoding can be checked. */
function runHook(input, args = []) {
  const r = spawnSync(process.execPath, [HOOK, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input) });
  return { code: r.status, out: r.stdout, err: r.stderr.toString('utf8') };
}

/** The context of one output: valid UTF-8, no BOM, one JSON line. */
function contextOf(out) {
  const text = UTF8.decode(out);
  assert.notEqual(text.charCodeAt(0), 0xfeff, 'no BOM');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1, 'one JSON line');
  const j = JSON.parse(lines[0]);
  assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof j.hookSpecificOutput.additionalContext, 'string');
  return j.hookSpecificOutput.additionalContext;
}

function assertHints(ctx) {
  for (const needle of ['set_project_dir', 'get_server_info', '停点只有五种', '本轮做完', '只剩用户本人能定的事', '真的卡住',
    '预算或截止时间到', '用户说暂停或控制器出错', '证据只认本会话里实际执行的命令', '退出码']) {
    assert.ok(ctx.includes(needle), `context holds ${needle}`);
  }
  assert.ok(ctx.split('\n').length <= 8, 'a few lines only');
}

describe('SessionStart output', () => {
  for (const source of ['startup', 'resume', 'compact']) {
    test(`${source}: hints and the session id, UTF-8 JSON on stdout, exit 0`, () => {
      const rt = tempRuntime();
      const r = runHook(claudeInput(source), ['--config', rt.config]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.err, '');
      const ctx = contextOf(r.out);
      assertHints(ctx);
      assert.ok(ctx.includes(`synthetic-session-${source}`), 'session id');
      assert.ok(ctx.split('\n')[0].includes(source), 'source on the first line');
      assert.ok(Buffer.from('停点', 'utf8').length === 6 && r.out.includes(Buffer.from('停点', 'utf8')), 'Chinese written as UTF-8 bytes');
    });
  }

  test('clear: nothing on stdout; no source: hints as on startup', () => {
    const rt = tempRuntime();
    const clear = runHook(claudeInput('clear'), ['--config', rt.config]);
    assert.equal(clear.code, 0, clear.err);
    assert.equal(clear.out.length, 0);
    const none = runHook(claudeInput(undefined, 'synthetic-codex-thread'), ['--config', rt.config]);
    assert.equal(none.code, 0, none.err);
    assert.ok(contextOf(none.out).includes('synthetic-codex-thread'));
  });

  test('Codex input as C0 recorded it: startup gets the hints, the fork that follows each chat prints nothing', () => {
    const codex = (source) => ({
      session_id: '00000000-0000-7000-8000-000000000001', transcript_path: source === 'fork' ? null : '~/.codex/sessions/rollout-synthetic.jsonl',
      cwd: '~/demo', hook_event_name: 'SessionStart', model: 'synthetic-model', permission_mode: 'bypassPermissions', source,
    });
    const start = runHook(codex('startup'), ['--platform', 'codex', '--config', path.join(tempDir(), 'missing.json')]);
    assert.equal(start.code, 0, start.err);
    assertHints(contextOf(start.out));
    const fork = runHook(codex('fork'), ['--platform', 'codex', '--config', path.join(tempDir(), 'missing.json')]);
    assert.equal(fork.code, 0, fork.err);
    assert.equal(fork.out.length, 0);
  });

  test('a session id that is not an id is never echoed', () => {
    const rt = tempRuntime();
    for (const id of ['two words', 'line\nbreak', 'x'.repeat(129), '', 42]) {
      const r = runHook({ ...claudeInput('startup'), session_id: id }, ['--config', rt.config]);
      assert.equal(r.code, 0, r.err);
      const ctx = contextOf(r.out);
      assert.ok(ctx.includes('会话 id：未知'), JSON.stringify(id));
      if (typeof id === 'string' && id) assert.ok(!ctx.includes(id), JSON.stringify(id));
    }
  });

  test('stdin that is not a JSON object still gets the hints, exit 0, a note on stderr', () => {
    const rt = tempRuntime();
    for (const input of ['not json', '["startup"]', '']) {
      const r = runHook(input, ['--config', rt.config]);
      assert.equal(r.code, 0);
      assertHints(contextOf(r.out));
      assert.match(r.err, /不是 JSON 对象/);
    }
    const beats = fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(beats.map((b) => b.decision), ['error', 'error', 'error']);
  });
});

describe('heartbeat, config and options', () => {
  test('one line per run with exactly ts, platform, event and decision, never the session id', () => {
    const rt = tempRuntime();
    const marker = 'synthetic-heartbeat-marker';
    runHook(claudeInput('startup', marker), ['--config', rt.config]);
    runHook(claudeInput('clear', marker), ['--config', rt.config]);
    runHook({ session_id: marker, turn_id: 'synthetic-turn', hook_event_name: 'SessionStart', source: 'resume' }, ['--config', rt.config]);
    runHook(claudeInput('compact', marker), ['--config', rt.config, '--platform', 'codex']);
    const text = fs.readFileSync(rt.heartbeat, 'utf8');
    assert.doesNotMatch(text, new RegExp(marker));
    const entries = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entries.length, 4);
    for (const e of entries) {
      assert.deepEqual(Object.keys(e).sort(), ['decision', 'event', 'platform', 'ts']);
      assert.equal(e.event, 'SessionStart');
      assert.ok(!Number.isNaN(Date.parse(e.ts)));
    }
    assert.deepEqual(entries.map((e) => e.decision), ['inject', 'skip', 'inject', 'inject']);
    assert.deepEqual(entries.map((e) => e.platform), ['claude', 'claude', 'codex', 'codex']);
  });

  test('a heartbeat over 1 MiB is cut to its newest whole lines', () => {
    const rt = tempRuntime();
    fs.mkdirSync(path.dirname(rt.heartbeat), { recursive: true });
    const old = `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', platform: 'claude', event: 'SessionStart', decision: 'inject' })}\n`;
    fs.writeFileSync(rt.heartbeat, old.repeat(Math.ceil((1024 * 1024 + 4096) / old.length)));
    assert.equal(runHook(claudeInput('startup'), ['--config', rt.config]).code, 0);
    const size = fs.statSync(rt.heartbeat).size;
    assert.ok(size > 0 && size <= 1024 * 1024, `size after the cut: ${size}`);
    const lines = fs.readFileSync(rt.heartbeat, 'utf8').trim().split('\n');
    for (const l of lines) JSON.parse(l);
    assert.equal(JSON.parse(lines.at(-1)).ts.startsWith('2026-01-01'), false);
  });

  test('no config file: hints, no heartbeat; a broken config: hints, a note, no heartbeat', () => {
    const dir = tempDir();
    const missing = runHook(claudeInput('startup'), ['--config', path.join(dir, 'hook-config.json')]);
    assert.equal(missing.code, 0, missing.err);
    assertHints(contextOf(missing.out));
    assert.deepEqual(listFiles(dir), []);
    const bad = path.join(dir, 'hook-config.json');
    fs.writeFileSync(bad, '{ runtime: ');
    const broken = runHook(claudeInput('resume'), ['--config', bad]);
    assert.equal(broken.code, 0);
    assertHints(contextOf(broken.out));
    assert.match(broken.err, /hook-config\.json"/);
    assert.deepEqual(listFiles(dir), ['hook-config.json']);
  });

  test('--selftest checks every sample and writes no file', () => {
    const rt = tempRuntime();
    const before = listFiles(rt.root);
    const cwd = tempDir();
    const r = spawnSync(process.execPath, [HOOK, '--selftest', '--config', rt.config], { cwd, encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ok \\(${SELFTEST.length} samples\\)`));
    assert.deepEqual(listFiles(rt.root), before);
    assert.deepEqual(listFiles(cwd), []);
  });

  test('an unknown option or platform exits 2 with nothing on stdout', () => {
    for (const args of [['--bogus'], ['--platform', 'other']]) {
      const r = runHook(claudeInput('startup'), args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.out.length, 0);
    }
  });
});

describe('in process', () => {
  test('decideSession and the session id check', () => {
    assert.equal(decideSession(claudeInput('startup')).decision, 'inject');
    assert.equal(decideSession(claudeInput('clear')).decision, 'skip');
    assert.equal(decideSession(claudeInput('other-source')).decision, 'skip');
    assert.equal(decideSession(null).decision, 'error');
    assert.equal(sessionIdOf({ session_id: 'a1-b2_c3.d4:e5' }), 'a1-b2_c3.d4:e5');
    assert.equal(sessionIdOf({ session_id: 'a b' }), '未知');
    assert.equal(sessionIdOf({}), '未知');
    assertHints(hintText('synthetic-id', 'startup'));
  });
});
