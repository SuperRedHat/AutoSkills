// lint-kit: allow-privacy synthetic test inputs: fake user names, local paths and addresses
// Tests for scripts/lint-kit.mjs (node:test, zero dependencies). Every input is synthetic: fixtures under
// tests/kit/fixtures/lint/ are hand-written, and cases with broken markers are built at run time and
// written to OS temp dirs. This file itself holds the synthetic paths and addresses that must fail the
// built-in privacy rules; it passes the privacy group only through the allow-privacy marker on line 1
// (the private word list still applies to it).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'lint-kit.mjs');
const FIX = path.join(REPO, 'tests', 'kit', 'fixtures', 'lint');
const KIT_SKILLS = ['project-consult', 'project-feedback', 'project-next', 'project-plan', 'project-quick', 'project-resume', 'project-status'];

/** Run lint-kit; returns exit code and output. */
function lint(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A marker line built at run time, so this file never carries a broken marker itself. */
const marker = (kind, reason = '') => `lint-kit${':'} allow-${kind}${reason ? ` ${reason}` : ''}`;

const temps = [];
/** A temp root holding the given files ({ 'rel/path': 'content' }). */
function tempRoot(files = {}, name = 'lint-kit-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const kitSkills = (desc = (n) => `Synthetic description of ${n}.`) => Object.fromEntries(KIT_SKILLS.map((n) => [`skills/${n}/SKILL.md`, skillMd(n, desc(n))]));

describe('privacy', () => {
  test('pass: placeholders, one-letter drive examples, SSH remotes and noreply addresses', () => {
    const r = lint('--root', path.join(FIX, 'privacy-pass'), '--check', 'privacy', '--path', 'notes.md');
    assert.equal(r.code, 0, r.out + r.err);
    assert.doesNotMatch(r.out, /privacy\/email/);
  });

  test('fail: each built-in rule, with Windows backslashes, Chinese and spaces', () => {
    const cases = [
      ['user-dir', 'Logs live in C:\\Users\\张三\\Documents\\a.txt'],
      ['user-dir', '"home": "C:\\\\Users\\\\Jane Doe\\\\repo"'],
      ['user-dir', 'Mac path /Users/bob/dev and Linux path /home/alice/src'],
      ['user-dir', 'Git Bash temp dir /c/Users/JANEDO~1/AppData/Local/Temp/x'],
      ['user-dir', 'WSL path /mnt/c/Users/janedoe/repo'],
      ['drive-path', 'Project at D:\\工作 项目\\demo-kit'],
      ['drive-path', 'Clone into E:/repos/demo-kit'],
      ['drive-path', 'cd /d/work/demo-private-kit && git status'],
      ['drive-path', 'WSL drive path "/mnt/e/演示 仓库/kit"'],
      ['email', 'Contact alice@example.com for access'],
    ];
    for (const [rule, text] of cases) {
      const root = tempRoot({ 'notes.md': `${text}\n` });
      const r = lint('--root', root, '--check', 'privacy', '--path', 'notes.md');
      assert.equal(r.code, 1, `${text}\n${r.out}`);
      assert.match(r.out, new RegExp(`notes\\.md:1:\\d+: privacy/${rule}:`), text);
    }
  });

  test('SSH remotes and noreply addresses are not emails, other addresses next to them are', () => {
    const root = tempRoot({
      'msg.txt': 'git@github.com:octo-org/demo.git\nssh://git@example.com/octo-org/demo.git\nCo-Authored-By: Claude <noreply@anthropic.com>\n'
        + 'Co-Authored-By: Octo <12345+octocat@users.noreply.github.com>\nReviewed-by: Dana <dana@example.net>\n',
    });
    const r = lint('--root', root, '--check', 'privacy', '--path', 'msg.txt');
    assert.equal(r.code, 1);
    const emails = r.out.split('\n').filter((l) => l.includes('privacy/email'));
    assert.equal(emails.length, 1, r.out);
    assert.match(emails[0], /^msg\.txt:5:/);
  });

  test('allow-privacy exempts the built-in rules for synthetic fixtures', () => {
    const r = lint('--root', path.join(FIX, 'privacy-allowed'), '--check', 'privacy', '--path', 'notes.md');
    assert.equal(r.code, 0, r.out + r.err);
  });

  test('allow-privacy does not exempt the private word list', () => {
    const r = lint('--root', path.join(FIX, 'privacy-private-list'), '--check', 'privacy', '--path', 'notes.md');
    assert.equal(r.code, 1, r.out);
    const hits = r.out.split('\n').filter((l) => / privacy\//.test(l));
    assert.ok(hits.length >= 3, r.out);
    assert.ok(hits.every((l) => l.includes('privacy/word-list')), r.out); // built-ins stay exempt
    assert.match(r.out, /notes\.md:5:\d+: privacy\/word-list: private word list entry #1 /); // zorblax-industries
    assert.match(r.out, /notes\.md:5:\d+: privacy\/word-list: private word list entry #3 /); // regex entry
    assert.match(r.out, /notes\.md:6:\d+: privacy\/word-list: private word list entry #2 /); // Chinese entry
    assert.doesNotMatch(r.out, /zorblax/i); // matches are masked in the output
  });

  test('word list entries: case, separators and word boundaries', () => {
    const files = {
      '_private/privacy-patterns.txt': '# synthetic\n\nZorblax Industries\nKestrel9\n',
      'a.md': 'ZORBLAX.INDUSTRIES\nZorblaxIndustries\nzorblax_industries\n',
      'b.md': 'Kestrel90 and xKestrel9 are other words\n',
    };
    const root = tempRoot(files);
    const a = lint('--root', root, '--check', 'privacy', '--path', 'a.md');
    assert.equal(a.code, 1);
    assert.equal(a.out.split('\n').filter((l) => l.includes('word-list')).length, 3, a.out);
    assert.equal(lint('--root', root, '--check', 'privacy', '--path', 'b.md').code, 0);
  });

  test('missing word list: built-in rules only, with a note and no error', () => {
    const root = tempRoot({ 'clean.md': 'Nothing private here: ~/.claude and C:/Users/<user>.\n', 'dirty.md': 'mail eve@example.com\n' });
    const clean = lint('--root', root, '--check', 'privacy', '--path', 'clean.md');
    assert.equal(clean.code, 0, clean.out + clean.err);
    assert.match(clean.err, /privacy-patterns\.txt not found/);
    assert.equal(lint('--root', root, '--check', 'privacy', '--path', 'dirty.md').code, 1);
  });

  test('a marker without a reason, a line-level allow-privacy and an unknown marker are findings', () => {
    const root = tempRoot({
      'no-reason.md': `<!-- ${marker('privacy')} -->\nplain text\n`,
      'trailing.md': `text <!-- ${marker('privacy', 'synthetic')} -->\nmail eve@example.com\n`,
      'unknown.md': `<!-- ${marker('everything', 'synthetic')} -->\n`,
    });
    const a = lint('--root', root, '--check', 'privacy', '--path', 'no-reason.md');
    assert.equal(a.code, 1);
    assert.match(a.out, /no-reason\.md:1:\d+: privacy\/marker: allow-privacy marker without a reason/);
    const b = lint('--root', root, '--check', 'privacy', '--path', 'trailing.md');
    assert.equal(b.code, 1);
    assert.match(b.out, /privacy\/marker: allow-privacy is file-level only/);
    assert.match(b.out, /trailing\.md:2:\d+: privacy\/email/); // not exempted
    const c = lint('--root', root, '--check', 'privacy', '--path', 'unknown.md');
    assert.equal(c.code, 1);
    assert.match(c.out, /unknown marker "allow-everything"/);
  });

  test('a reason without a letter or digit is no reason', () => {
    const root = tempRoot({ 'punct.md': `<!-- ${marker('privacy', ': `')} -->\nplain text\n` });
    const r = lint('--root', root, '--check', 'privacy', '--path', 'punct.md');
    assert.equal(r.code, 1);
    assert.match(r.out, /punct\.md:1:\d+: privacy\/marker: allow-privacy marker without a reason/);
  });

  test('markers named in prose, inline code or a Markdown fence are not markers', () => {
    const root = tempRoot({
      'doc.md': [
        `Fixtures use \`${marker('privacy', '<reason>')}\` on a line of its own.`,
        `Inline code with a comment: \`<!-- ${marker('privacy', 'synthetic')} -->\`.`,
        `Plain prose: ${marker('privacy', 'synthetic')}.`,
        `# ${marker('privacy', 'a heading is not a comment')}`,
        '```html',
        `<!-- ${marker('privacy', 'synthetic')} -->`,
        '```',
        'mail eve@example.com',
        '',
      ].join('\n'),
      'real.sh': `echo hi # ${marker('legacy', 'synthetic Gemini note')}\nGemini\n`,
    });
    const r = lint('--root', root, '--check', 'privacy', '--path', 'doc.md');
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, /\/marker:/);
    assert.match(r.out, /doc\.md:8:\d+: privacy\/email/); // no file-level exemption
    // Outside Markdown a trailing # comment is a comment: line 1 is allowed, line 2 is not.
    const s = lint('--root', root, '--check', 'legacy', '--path', 'real.sh');
    assert.equal(s.code, 1, s.out);
    assert.doesNotMatch(s.out, /real\.sh:1:/);
    assert.match(s.out, /real\.sh:2:\d+: legacy\/gemini/);
  });

  test('Windows --path with backslashes, Chinese and spaces', () => {
    const root = tempRoot({ '中文 目录/说明 文件.md': 'Clone into F:\\演示 仓库\\kit\n' }, 'lint kit 测试 ');
    const target = path.join(root, '中文 目录', '说明 文件.md'); // backslashes on Windows
    const r = lint('--root', root, '--check', 'privacy', '--path', target);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /中文 目录\/说明 文件\.md:1:\d+: privacy\/drive-path/);
    const dir = lint('--root', root, '--check', 'privacy', '--path', `${path.join(root, '中文 目录')}${path.sep}`);
    assert.equal(dir.code, 1);
  });

  test('--git-log reads commit messages with Chinese text (temp repo)', (t) => {
    if (spawnSync('git', ['--version']).status !== 0) { t.skip('git not available'); return; }
    const root = tempRoot({ '_private/privacy-patterns.txt': '雾松岭\n' }, 'lint-kit-git-');
    const msgDir = tempRoot({
      'm1.txt': 'feat: 添加中文说明\n\n正文提到雾松岭工厂。\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      'm2.txt': 'fix: 修复说明文字\n\n正文只有普通中文。\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
    });
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=Lint Test', '-c', 'user.email=lint@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '--no-verify', '-F', path.join(msgDir, 'm1.txt'));
    git('commit', '-q', '--allow-empty', '--no-verify', '-F', path.join(msgDir, 'm2.txt'));
    const all = lint('--root', root, '--git-log', 'HEAD');
    assert.equal(all.code, 1, all.out + all.err);
    assert.match(all.out, /^commit [0-9a-f]{10}:3:\d+: privacy\/word-list: private word list entry #1 /m);
    assert.match(all.out, /2 commit message\(s\)/);
    const last = lint('--root', root, '--check', 'privacy', '--git-log', 'HEAD~1..HEAD');
    assert.equal(last.code, 0, last.out + last.err); // the noreply trailer is not an email
  });

  test('repo: lint-kit itself and tests/kit pass the privacy group', () => {
    const r = lint('--check', 'privacy', '--path', 'scripts/lint-kit.mjs', '--path', 'tests/kit');
    assert.equal(r.code, 0, r.out + r.err);
  });
});

describe('tools', () => {
  test('pass: registered tools, valid enums, and field names are not taken for tools', () => {
    const r = lint('--root', path.join(FIX, 'tools-pass'), '--check', 'tools');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /ok \[tools\] 2 file\(s\)/);
  });

  test('fail: unregistered tools and values outside the 1.5.1 enums', () => {
    const r = lint('--root', path.join(FIX, 'tools-fail'), '--check', 'tools');
    assert.equal(r.code, 1);
    const expect = [
      /SKILL\.md:8:\d+: tools\/tool-name: tool "get_task_graph"/,
      /SKILL\.md:9:\d+: tools\/tool-name: tool "delete_task"/,
      /SKILL\.md:10:\d+: tools\/status: "finished"/,
      /SKILL\.md:11:\d+: tools\/status: "blocked"/,
      /SKILL\.md:12:\d+: tools\/acceptance-mode: "strict"/,
      /SKILL\.md:13:\d+: tools\/status: "doing" .*state-machine arrow/,
      /SKILL\.md:16:\d+: tools\/acceptance-mode: "review"/,
      /SKILL\.md:16:\d+: tools\/status: "open" .*task block/,
      /SKILL\.md:18:\d+: tools\/tool-name: tool "list_tasks"/,
      /SKILL\.md:18:\d+: tools\/tool-name: tool "complete_task"/,
      /SKILL\.md:18:\d+: tools\/tool-name: tool "start_task"/,
    ];
    for (const re of expect) assert.match(r.out, re);
    assert.doesNotMatch(r.out, /"(?:auto|todo|done|acceptance_mode|stage_gate)"/);
  });

  test('field names alone are clean', () => {
    const root = tempRoot({
      'mcp/project-manager/src/index.ts': 'server.tool("update_task_status", "", {}, async () => ({}));\n',
      'skills/project-x/SKILL.md': 'Set `acceptance_mode`, `stage_gate`, `needs_manual_review`, `verification_profile` and `review_checklist`; acceptance_mode: auto.\n',
    });
    const r = lint('--root', root, '--check', 'tools');
    assert.equal(r.code, 0, r.out);
  });

  test('a tool name ending a sentence is still checked; comments do not hide arrows outside them', () => {
    const root = tempRoot({
      'mcp/project-manager/src/index.ts': 'server.tool("update_task_status", "", {}, async () => ({}));\n',
      'skills/project-x/SKILL.md': 'Then call update_task_graph.\ntodo -> doing <!-- note --> done\n',
    });
    const r = lint('--root', root, '--check', 'tools');
    assert.equal(r.code, 1);
    assert.match(r.out, /SKILL\.md:1:\d+: tools\/tool-name: tool "update_task_graph"/);
    assert.match(r.out, /SKILL\.md:2:\d+: tools\/status: "doing"/);
    assert.doesNotMatch(r.out, /"note"/);
  });

  test('a missing tool registry is a setup error (exit 2)', () => {
    const root = tempRoot({ 'skills/project-x/SKILL.md': 'Call `add_log`.\n' });
    const r = lint('--root', root, '--check', 'tools');
    assert.equal(r.code, 2);
    assert.match(r.err, /tool registry not found/);
  });

  test('repo: tools referenced by the current skills and templates are registered', () => {
    const r = lint('--check', 'tools');
    assert.equal(r.code, 0, r.out + r.err);
  });
});

describe('skills', () => {
  test('pass: the 7 kit skills with short descriptions (plain and folded)', () => {
    const r = lint('--root', path.join(FIX, 'skills-pass'), '--check', 'skills');
    assert.equal(r.code, 0, r.out + r.err);
  });

  test('fail: name differs from the directory, missing description, no frontmatter', () => {
    const files = kitSkills();
    files['skills/project-next/SKILL.md'] = skillMd('project-nxt', 'Synthetic.');
    files['skills/project-plan/SKILL.md'] = '---\nname: project-plan\n---\n';
    files['skills/project-quick/SKILL.md'] = '# project-quick without frontmatter\n';
    const r = lint('--root', tempRoot(files), '--check', 'skills');
    assert.equal(r.code, 1);
    assert.match(r.out, /skills\/project-next\/SKILL\.md: skills\/name: name "project-nxt" differs/);
    assert.match(r.out, /skills\/project-plan\/SKILL\.md: skills\/description: frontmatter has no description/);
    assert.match(r.out, /skills\/project-quick\/SKILL\.md: skills\/frontmatter: missing YAML frontmatter/);
  });

  test('description length: 400 characters pass, 401 fail (counted in characters, not bytes)', () => {
    const ok = kitSkills();
    ok['skills/project-next/SKILL.md'] = skillMd('project-next', '说'.repeat(400));
    assert.equal(lint('--root', tempRoot(ok), '--check', 'skills').code, 0);
    const bad = kitSkills();
    bad['skills/project-next/SKILL.md'] = skillMd('project-next', '说'.repeat(401));
    const r = lint('--root', tempRoot(bad), '--check', 'skills');
    assert.equal(r.code, 1);
    assert.match(r.out, /skills\/description: description has 401 characters \(max 400\)/);
  });

  test('descriptions together over 2000 characters fail', () => {
    const r = lint('--root', tempRoot(kitSkills(() => 'x'.repeat(300))), '--check', 'skills');
    assert.equal(r.code, 1);
    assert.match(r.out, /skills\/description-total: descriptions total 2100 characters \(max 2000\)/);
  });

  test('without --path skills/ must hold exactly the 7 kit skills', () => {
    const files = kitSkills();
    delete files['skills/project-quick/SKILL.md'];
    files['skills/project-init/SKILL.md'] = skillMd('project-init', 'Retired.');
    const root = tempRoot(files);
    const r = lint('--root', root, '--check', 'skills');
    assert.equal(r.code, 1);
    assert.match(r.out, /skills\/skill-set: missing skill project-quick/);
    assert.match(r.out, /skills\/project-init\/: skills\/skill-set: not one of the 7 kit skills/);
    // With --path only the named skills are checked, not the set.
    assert.equal(lint('--root', root, '--check', 'skills', '--path', 'skills/project-next').code, 0);
  });
});

describe('legacy', () => {
  test('pass: file-level and line-level allow-legacy, tests/ is not scanned', () => {
    const r = lint('--root', path.join(FIX, 'legacy-pass'), '--check', 'legacy', '--path', 'scripts', '--path', 'skills', '--path', 'tests');
    assert.equal(r.code, 0, r.out + r.err);
  });

  test('fail: CouncilFlow, council commands and folders, retired skills, Gemini', () => {
    const r = lint('--root', path.join(FIX, 'legacy-fail'), '--check', 'legacy');
    assert.equal(r.code, 1);
    for (const rule of ['councilflow', 'council', 'retired-skill', 'gemini']) assert.match(r.out, new RegExp(`: legacy/${rule}: `));
    assert.match(r.out, /SKILL\.md:9:\d+: legacy\/retired-skill: retired skill name: project-review/);
    assert.match(r.out, /SKILL\.md:9:\d+: legacy\/retired-skill: retired skill name: project-init/);
    assert.match(r.out, /global\.md:3:\d+: legacy\/gemini: Gemini: GEMINI/);
  });

  test('a line-level marker exempts its own line only; a marker without a reason is a finding', () => {
    const root = tempRoot({
      'skills/a.md': `old project-design step <!-- ${marker('legacy', 'synthetic history line')} -->\nnew project-design step\n`,
      'skills/b.md': `<!-- ${marker('legacy')} -->\nGemini\n`,
    });
    const a = lint('--root', root, '--check', 'legacy', '--path', 'skills/a.md');
    assert.equal(a.code, 1);
    assert.doesNotMatch(a.out, /a\.md:1:/);
    assert.match(a.out, /a\.md:2:\d+: legacy\/retired-skill/);
    const b = lint('--root', root, '--check', 'legacy', '--path', 'skills/b.md');
    assert.equal(b.code, 1);
    assert.match(b.out, /b\.md:1:\d+: legacy\/marker: allow-legacy marker without a reason/);
    assert.match(b.out, /b\.md:2:\d+: legacy\/gemini/);
  });
});

describe('contract', () => {
  // Built from the repo's own templates at run time, so the tests never hold a second copy of the contract.
  const tpl = (name) => fs.readFileSync(path.join(REPO, 'templates', name), 'utf8');
  const CONTRACT = tpl('global-AGENTS.md');
  const without = (text, re) => text.split('\n').filter((l) => !re.test(l)).join('\n');
  /** A temp root with a templates/ dir: the real contract and Claude file unless overridden (null drops one). */
  const contractRoot = (files = {}) => tempRoot(Object.fromEntries(Object.entries({
    'templates/global-AGENTS.md': CONTRACT,
    'templates/global-claude-CLAUDE.md': tpl('global-claude-CLAUDE.md'),
    ...files,
  }).filter(([, text]) => text !== null)));
  const check = (root, ...more) => lint('--root', root, '--check', 'contract', ...more);

  test('pass: the repo templates', () => {
    const r = lint('--check', 'contract');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /ok \[contract\]/);
    const all = check(contractRoot({ 'templates/repo-AGENTS.md': tpl('repo-AGENTS.md'), 'templates/repo-CLAUDE.md': tpl('repo-CLAUDE.md'), 'templates/goal.txt': tpl('goal.txt') }));
    assert.equal(all.code, 0, all.out);
  });

  test('fail: each required clause missing', () => {
    const cases = [
      ['stop-points', without(CONTRACT, /停点只有五种/)],
      ['zero-exception', CONTRACT.replace('不访问客户数据', '')],
      ['evidence', without(CONTRACT, /测试证据必须是本会话里实际执行的命令/)],
      ['set-project-dir', without(CONTRACT, /get_server_info/)],
      ['subagents', without(CONTRACT, /^#+\s*子代理与并行/)],
      ['git-report', CONTRACT.replace('Conventional Commits', 'commits')],
    ];
    for (const [rule, text] of cases) {
      assert.notEqual(text, CONTRACT, rule);
      const r = check(contractRoot({ 'templates/global-AGENTS.md': text }));
      assert.equal(r.code, 1, `${rule}\n${r.out}`);
      assert.match(r.out, new RegExp(`templates/global-AGENTS\\.md: contract/${rule}: missing `), rule);
      assert.equal(r.out.split('\n').filter((l) => / contract\//.test(l)).length, 1, r.out); // only that clause
    }
  });

  test('length: 60 lines pass, 61 fail', () => {
    const n = CONTRACT.replace(/\n$/, '').split('\n').length;
    assert.ok(n <= 60, `contract has ${n} lines`);
    const pad = (k) => CONTRACT + '- 补充条款。\n'.repeat(k);
    assert.equal(check(contractRoot({ 'templates/global-AGENTS.md': pad(60 - n) })).code, 0);
    const r = check(contractRoot({ 'templates/global-AGENTS.md': pad(61 - n) }));
    assert.equal(r.code, 1);
    assert.match(r.out, /contract\/length: contract has 61 lines \(max 60\)/);
  });

  test('single source: a second copy, the retired Codex global and a missing contract are findings', () => {
    const two = check(contractRoot({ 'templates/codex/AGENTS.md': CONTRACT }));
    assert.equal(two.code, 1);
    assert.match(two.out, /templates\/codex\/AGENTS\.md: contract\/single-source: second contract source \(the first is templates\/global-AGENTS\.md\)/);
    const retired = check(contractRoot({ 'templates/global-codex-AGENTS.md': '# 全局规则\n' }));
    assert.equal(retired.code, 1);
    assert.match(retired.out, /templates\/global-codex-AGENTS\.md: contract\/single-source: retired second source/);
    const none = contractRoot({ 'templates/global-AGENTS.md': null, 'templates/repo-AGENTS.md': tpl('repo-AGENTS.md') });
    const r = check(none);
    assert.equal(r.code, 1);
    assert.match(r.out, /contract\/single-source: no contract source/);
    assert.equal(check(none, '--path', 'templates').code, 1); // a directory is a whole set
    assert.equal(check(none, '--path', 'templates/repo-AGENTS.md').code, 0, 'a single file needs no contract');
  });

  test('Claude global file: @AGENTS.md first, at most 10 more lines', () => {
    const lines = (k) => `@AGENTS.md\n\n${'- Claude 专属条款。\n'.repeat(k)}`;
    assert.equal(check(contractRoot({ 'templates/global-claude-CLAUDE.md': lines(10) })).code, 0);
    const long = check(contractRoot({ 'templates/global-claude-CLAUDE.md': lines(11) }));
    assert.equal(long.code, 1);
    assert.match(long.out, /global-claude-CLAUDE\.md: contract\/claude-import: 11 Claude-only lines after the import \(max 10\)/);
    const copy = check(contractRoot({ 'templates/global-claude-CLAUDE.md': `# 全局规则\n\n@AGENTS.md\n` }));
    assert.equal(copy.code, 1);
    assert.match(copy.out, /global-claude-CLAUDE\.md:1:1: contract\/claude-import: the first line must be @AGENTS\.md/);
  });

  test('fail: old rules in any template', () => {
    const cases = [
      ['design before code', '- 在写任何代码之前，必须先完成设计文档并等待用户明确确认。'],
      ['design before code', '- 涉及架构变更时必须先更新设计文档，等用户确认后再改代码。'],
      ['module-by-module confirmation', '- 每个模块做完都要逐个模块等用户确认。'],
      ['module-by-module confirmation', '- 不要一次性生成大量代码，分模块逐步实现并验证。'],
      ['asking on vague requirements', '- 需求模糊必须问。'],
      ['asking on vague requirements', '- 遇到模糊需求主动追问，不要假设。'],
      ['state-machine description', '### 任务状态机'],
      ['state-machine description', 'todo -> in_progress -> auto_verified -> done'],
      ['tech-stack default', '- 遵循 SOLID / DRY / KISS / 关注点分离'],
      ['tech-stack default', '- API 统一响应格式：`{ data, meta?, error? }`'],
      ['tech-stack default', '  - `pnpm exec vitest run`'],
    ];
    for (const [what, line] of cases) {
      const r = check(contractRoot({ 'templates/repo-AGENTS.md': `# 项目契约\n\n${line}\n` }));
      assert.equal(r.code, 1, `${line}\n${r.out}`);
      assert.match(r.out, new RegExp(`templates/repo-AGENTS\\.md:3:\\d+: contract/old-rule: old rule \\(${what}\\)`), line);
    }
  });

  test('fail: P0 terms in batch-1 templates; the batch-1 /goal template has none', () => {
    const goal = tpl('goal.txt');
    assert.match(goal, /验证命令实际跑过并通过/);
    const p0 = goal.replace('<项目> 的', '<项目> run=<run_id> 的').replace('验证命令实际跑过并通过', '验证执行器记录通过');
    const r = check(contractRoot({ 'templates/goal.txt': p0 }));
    assert.equal(r.code, 1);
    for (const term of ['run=', 'run_id', '执行器']) assert.match(r.out, new RegExp(`templates/goal\\.txt:\\d+:\\d+: contract/p0-term: P0 term in a batch-1 template: ${term}`));
    const c = check(contractRoot({ 'templates/global-AGENTS.md': `${CONTRACT}- 正式证据只认 runner 回执。\n` }));
    assert.equal(c.code, 1);
    assert.match(c.out, /contract\/p0-term: P0 term in a batch-1 template: runner/);
    assert.match(c.out, /contract\/p0-term: P0 term in a batch-1 template: 回执/);
  });
});

describe('cli', () => {
  test('usage errors exit 2', () => {
    assert.equal(lint().code, 2);
    assert.equal(lint('--check', 'bogus').code, 2);
    assert.equal(lint('--check', 'privacy', '--bogus').code, 2);
    assert.equal(lint('--check', 'privacy', '--path', 'does/not/exist.md').code, 2);
    assert.equal(lint('--git-log', 'HEAD', '--check', 'tools').code, 2);
    assert.equal(lint('--git-log', 'HEAD', '--path', 'README.md').code, 2);
  });

  test('a --git-log range that starts with - never reaches git', () => {
    const r = lint('--git-log=--output=lint-kit-should-not-exist.txt');
    assert.equal(r.code, 2);
    assert.match(r.err, /--git-log range must not start with -/);
    assert.equal(fs.existsSync(path.join(REPO, 'lint-kit-should-not-exist.txt')), false);
  });

  test('--check all runs every group', () => {
    const contract = fs.readFileSync(path.join(REPO, 'templates', 'global-AGENTS.md'), 'utf8');
    const root = tempRoot({
      ...kitSkills(),
      'mcp/project-manager/src/index.ts': 'server.tool("add_log", "", {}, async () => ({}));\nserver.tool("set_project_dir", "", {}, async () => ({}));\nserver.tool("get_server_info", "", {}, async () => ({}));\n',
      'templates/t.md': 'Call `add_log`.\n',
      'templates/global-AGENTS.md': contract,
    });
    const r = lint('--root', root, '--check', 'all');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /ok \[privacy,tools,skills,legacy,contract\]/);
  });

  test('read-only: a full run leaves the tree unchanged, and the source has no write calls', () => {
    const root = tempRoot({ ...kitSkills(), 'mcp/project-manager/src/index.ts': 'server.tool("add_log", "", {}, async () => ({}));\n', 'templates/t.md': 'Gemini at D:\\work\\kit, mail eve@example.com, `get_nothing`\n' });
    const snap = () => {
      const out = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out.push(`${p}/`); walk(p); } else { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); } } };
      walk(root);
      return out.sort().join('\n');
    };
    const before = snap();
    assert.equal(lint('--root', root, '--check', 'all').code, 1);
    assert.equal(snap(), before);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /\b(?:writeFile|appendFile|mkdir|mkdtemp|rmSync|rmdir|unlink|rename|copyFile|cpSync|symlink|truncate|createWriteStream|utimes|chmod)\w*\s*\(/);
  });
});
