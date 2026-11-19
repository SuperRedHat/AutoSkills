// Tests for scripts/lib/accept (the accept command). Every ledger is synthetic and lives in an OS temp dir.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptCommand } from '../../scripts/lib/accept/cli.mjs';
import { stateDir } from '../../scripts/lib/ledger-read.mjs';

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const T = (id, extra = {}) => ({
  id, title: `task ${id}`, description: '', dependencies: [], complexity: 'S', acceptance_criteria: [], files: [],
  module: 'm', needs_manual_review: false, status: 'todo', created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z', commit_hash: '', notes: '', ...extra,
});
const W = (id, extra = {}) => T(id, { status: 'awaiting_manual_acceptance', acceptance_mode: 'manual', ...extra });

function project(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-'));
  temps.push(dir);
  if (tasks) {
    fs.mkdirSync(stateDir(dir), { recursive: true });
    fs.writeFileSync(path.join(stateDir(dir), 'tasks.json'), JSON.stringify({ tasks }));
  }
  return dir;
}

async function run(args) {
  let stdout = '';
  let stderr = '';
  const code = await acceptCommand(args, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } });
  return { code, stdout, stderr, html: code === 0 && stdout.trim() && !args.includes('--help') ? fs.readFileSync(stdout.trim(), 'utf8') : null };
}

const at = (html, text) => html.indexOf(text);

describe('grouping and order', () => {
  test('gates first, then the most unblocked, then ledger order; groups by their first task', async () => {
    const dir = project([
      W('A', { module: 'x' }),
      W('B', { module: 'y' }),
      W('C', { module: 'x', stage_gate: true }),
      W('D', { module: 'y' }),
      T('E', { dependencies: ['D'] }),
      T('F', { dependencies: ['D'] }),
      T('G', { dependencies: ['B'] }),
    ]);
    const { code, html } = await run([dir]);
    assert.equal(code, 0);
    const order = ['C task C', 'A task A', 'D task D', 'B task B'].map((s) => at(html, s));
    assert.ok(order.every((n) => n > 0), 'all tasks are on the page');
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // group x (holds the gate C) comes before group y
    assert.ok(at(html, '<h2>x</h2>') < at(html, '<h2>y</h2>'));
    assert.match(html, /\[门禁任务\]/);
  });
  test('the page lists what passing unblocks', async () => {
    const dir = project([W('A'), T('B', { dependencies: ['A'], title: 'the next one' })]);
    const { html } = await run([dir]);
    assert.match(html, /B the next one/);
  });
});

describe('escaping', () => {
  test('title, notes, criteria and checklist cannot make tags or attributes', async () => {
    const evil = '<script>alert("x")</script> & \'q\'';
    const dir = project([W('A', { title: evil, notes: evil, acceptance_criteria: [evil], review_checklist: [evil] })]);
    const { html } = await run([dir]);
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('alert("x")'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;'));
  });
});

describe('empty and missing', () => {
  test('nothing waiting still gives a page', async () => {
    const { code, html } = await run([project([T('A')])]);
    assert.equal(code, 0);
    assert.match(html, /没有等你验收的任务/);
  });
  test('no ledger exits 1 with a message', async () => {
    const r = await run([project(null)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no ledger/);
  });
});

describe('driver verification', () => {
  const rec = (dir, run, id, body) => {
    const d = path.join(dir, '.autoskills', 'runs', run, 'tasks');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${id}.verify.json`), JSON.stringify({ task_id: id, at: '2026-11-19T00:00:00Z', ...body }));
  };
  test('passed, failed and no record', async () => {
    const dir = project([W('A'), W('B'), W('C')]);
    rec(dir, 'r1', 'A', { passed: true, commit: 'abcdef1234567', commands: [] });
    rec(dir, 'r1', 'B', { passed: false, commit: 'abc', commands: [{ command: 'node --test x.mjs', exit_code: 1, log: 'logs/x.log' }] });
    const { html } = await run([dir]);
    assert.match(html, /驱动复验：通过/);
    assert.match(html, /驱动复验：没过，建议驳回/);
    assert.match(html, /node --test x\.mjs/);
    assert.match(html, /logs\/x\.log/);
    assert.match(html, /没有复验记录/);
  });
});

describe('the lock', () => {
  const lock = (dir, pid) => {
    fs.mkdirSync(path.join(dir, '.autoskills'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.autoskills', 'run.lock'), JSON.stringify({ pid, run: 'r', started_at: 'now' }));
  };
  test('a live lock warns, a dead lock and no lock do not', async () => {
    const live = project([W('A')]);
    lock(live, process.pid);
    assert.match((await run([live])).html, /有长跑正在跑/);
    const dead = project([W('A')]);
    lock(dead, 2 ** 22 + 12345);
    assert.ok(!(await run([dead])).html.includes('有长跑正在跑'));
    assert.ok(!(await run([project([W('A')])])).html.includes('有长跑正在跑'));
  });
});

describe('options', () => {
  test('--out writes there; default goes to the acceptance dir', async () => {
    const dir = project([W('A')]);
    const target = path.join(dir, 'sub', 'sheet.html');
    const r = await run([dir, '--out', target]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), target);
    assert.ok(fs.existsSync(target));
    const d = await run([dir]);
    assert.ok(d.stdout.trim().startsWith(path.join(dir, '.autoskills', 'acceptance')));
    assert.ok(d.stdout.trim().endsWith('.html'));
  });
  test('--help exits 0; usage errors exit 2', async () => {
    assert.equal((await run(['--help'])).code, 0);
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['a', 'b'])).code, 2);
    assert.equal((await run(['a', '--bogus'])).code, 2);
    assert.equal((await run(['a', '--out'])).code, 2);
  });
});

describe('self-contained', () => {
  test('no http(s) references and no script element', async () => {
    const { html } = await run([project([W('A', { stage_gate: true, acceptance_mode: 'milestone_manual' }), W('B')])]);
    assert.ok(!/https?:\/\//.test(html));
    assert.ok(!/<script/i.test(html));
    assert.match(html, /T?A、B 通过|A、B 通过/);
  });
});
