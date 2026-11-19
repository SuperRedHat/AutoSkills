// Tests for scripts/lib/accept (the accept command). Every ledger is synthetic and lives in an OS temp dir.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  test('a tie keeps the ledger order; more unblocked still goes first', async () => {
    // A and B each unblock one task, C unblocks two, D and E none: C, then A before B, then D before E.
    const dir = project([
      W('D'), W('A'), W('E'), W('B'), W('C'),
      T('P', { dependencies: ['A'] }), T('Q', { dependencies: ['B'] }), T('R', { dependencies: ['C'] }), T('S', { dependencies: ['C'] }),
    ]);
    const { html } = await run([dir]);
    const order = ['C task C', 'A task A', 'B task B', 'D task D', 'E task E'].map((s) => at(html, s));
    assert.ok(order.every((n) => n > 0), 'all tasks are on the page');
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
  test('a group stands where its first-ranked task stands, not where its module first shows in the ledger', async () => {
    // Module x comes first in the ledger, but the gate is in module y: y is the first group.
    const dir = project([W('A', { module: 'x' }), W('B', { module: 'y', stage_gate: true }), W('C', { module: 'x' })]);
    const { html } = await run([dir]);
    assert.ok(at(html, '<h2>y</h2>') > 0 && at(html, '<h2>x</h2>') > 0);
    assert.ok(at(html, '<h2>y</h2>') < at(html, '<h2>x</h2>'));
    assert.ok(at(html, 'B task B') < at(html, 'A task A'));
    assert.ok(at(html, 'A task A') < at(html, 'C task C'));
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
  // The block of one task on the page: from its heading to the next card.
  const block = (html, id) => {
    const from = html.indexOf(`<h3>${id} `);
    const to = html.indexOf('<section class="card">', from);
    return html.slice(from, to < 0 ? undefined : to);
  };
  test('passed: null (a task with no verification commands) is "not run", never a suggested rejection', async () => {
    const dir = project([W('A')]);
    rec(dir, 'r1', 'A', { passed: null, clean: true, commit: 'abc', commands: [], reason: 'the task has no verification commands' });
    const { html } = await run([dir]);
    assert.match(html, /驱动复验：没有跑，任务没有验证命令/);
    assert.ok(!html.includes('建议驳回'));
    assert.ok(!html.includes('驱动复验：没过'));
  });
  test('an unclean tree says why and lists the files; a failed git status says so', async () => {
    const dir = project([W('A'), W('B')]);
    rec(dir, 'r1', 'A', { passed: false, clean: false, commit: 'abc', commands: [], reason: 'the working tree is not clean (2 file(s) not committed)', dirty: ['?? src/new <file>.mjs', ' M src/old.mjs'] });
    rec(dir, 'r1', 'B', { passed: false, clean: false, commit: 'abc', commands: [], reason: 'git status failed', dirty: [] });
    const { html } = await run([dir]);
    const a = block(html, 'A');
    assert.match(a, /驱动复验：没过，建议驳回/);
    assert.match(a, /工作目录不干净，有 2 个文件没提交/);
    assert.ok(a.includes('?? src/new &lt;file&gt;.mjs'));
    assert.ok(a.includes('M src/old.mjs'));
    const b = block(html, 'B');
    assert.match(b, /驱动复验：没过，建议驳回/);
    assert.match(b, /没能检查工作目录/);
  });
  test('a command that timed out or could not start says so instead of an empty exit code', async () => {
    const dir = project([W('A')]);
    rec(dir, 'r1', 'A', {
      passed: false, clean: true, commit: 'abc', commands: [
        { command: 'node ok.mjs', exit_code: 0, log: 'logs/1.log' },
        { command: 'node slow.mjs', exit_code: null, timed_out: true, log: 'logs/2.log' },
        { command: 'node gone.mjs', exit_code: null, error: 'spawn ENOENT', log: 'logs/3.log' },
        { command: 'node bad.mjs', exit_code: 3, log: 'logs/4.log' },
      ],
    });
    const { html } = await run([dir]);
    assert.ok(!html.includes('node ok.mjs'), 'a command that passed is not listed');
    assert.match(html, /node slow\.mjs<\/code><\/td><td>超时没跑完<\/td><td>logs\/2\.log/);
    assert.match(html, /node gone\.mjs<\/code><\/td><td>没能启动：spawn ENOENT<\/td><td>logs\/3\.log/);
    assert.match(html, /node bad\.mjs<\/code><\/td><td>3<\/td><td>logs\/4\.log/);
  });
  test('a record without a readable passed is treated as no record', async () => {
    const dir = project([W('A')]);
    rec(dir, 'r1', 'A', { commit: 'abc', commands: [] });
    const { html } = await run([dir]);
    assert.match(html, /复验记录不完整/);
    assert.ok(!html.includes('建议驳回'));
  });
});

describe('the reply example', () => {
  test('one waiting task is named once; two are named together', async () => {
    const one = (await run([project([W('A')])])).html;
    assert.match(one, /<li>A 通过<\/li>/);
    assert.ok(!one.includes('A、A'));
    assert.match(one, /<li>A 驳回：&lt;原因&gt;<\/li>/);
    const two = (await run([project([W('A'), W('B')])])).html;
    assert.match(two, /<li>A、B 通过<\/li>/);
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
    const warned = (await run([live])).html;
    assert.match(warned, /有长跑正在跑/);
    // The stop command on the page can be pasted as it is: the kit's entry, the command, this project.
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'autoskills.mjs');
    assert.ok(warned.includes(`node &quot;${entry}&quot; stop &quot;${live}&quot;`), 'the stop command names the entry and the project');
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
  test('--out inside the ledger folder is refused and the ledger stays as it was', async () => {
    const dir = project([W('A')]);
    const ledger = path.join(stateDir(dir), 'tasks.json');
    const before = fs.readFileSync(ledger, 'utf8');
    for (const target of [ledger, path.join(stateDir(dir), 'sheet.html'), path.join(dir, '.claude', 'state', 'sub', 'x.html')]) {
      const r = await run([dir, '--out', target]);
      assert.equal(r.code, 2, target);
      assert.match(r.stderr, /ledger folder/);
      assert.ok(target === ledger || !fs.existsSync(target), `${target} was not written`);
    }
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
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
