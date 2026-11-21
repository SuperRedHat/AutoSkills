// Tests for the declarative platform fragments under config/ (node:test, zero dependencies): the Claude
// settings fragment, the project-verifier subagent, the Codex config fragment and hooks.json, and the
// local config example. The fragments are read as they are in the repo; nothing is written. Bash and
// PowerShell deny rules are also matched against sample commands with the wildcard semantics of the
// Claude Code permissions docs (a * matches any text; a trailing " *" that is the only wildcard also
// matches the bare command), so a typo that leaves a rule matching nothing is caught here. Whether the
// deployed rules really stop the calls is the deploy smoke matrix (AS3-121), not this file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RETIRED_CLAUDE_DENY, RETIRED_PUSH_DENY, RETIRED_PUBLISH_DENY, mergeClaudeSettings } from '../../scripts/lib/kit-targets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = path.join(REPO, 'config');
const SETTINGS = path.join(CONFIG, 'claude', 'settings.fragment.json');
const VERIFIER = path.join(CONFIG, 'claude', 'agents', 'project-verifier.md');
const CODEX_TOML = path.join(CONFIG, 'codex', 'config.fragment.toml');
const CODEX_HOOKS = path.join(CONFIG, 'codex', 'hooks.json');
const CODEX_RULES = path.join(CONFIG, 'codex', 'rules', 'autoskills.rules');
const KIT_LOCAL = path.join(CONFIG, 'kit-local.example.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * The publish categories of ADR-006 §2.5 with commands of each and nearby reads. Since AS3-385 the fragment
 * holds no deny rule for them (the owner decides in the confirmation dialog, as for a push); the samples
 * now pin two things: no rule of the fragment matches them, and the retired rules deploy takes out of the
 * user's settings are the ones that did.
 */
/**
 * git push is not in this list since AS3-379: a deny rule in the settings wins over the guard's "ask", and the
 * owner decides a push in the confirmation dialog. The guard still sees every push (guard-hook.test.mjs).
 */
const PUSH_SAMPLES = ['git push', 'git push origin main', 'git push --force origin HEAD',
  'git push https://example.invalid/owner/repo.git main', 'git -C . push', 'git -C sub/repo push origin main',
  'git -c push.default=current push', 'git -c credential.helper= push origin main'];
const DENY_SAMPLES = {
  'gh repo': {
    denied: ['gh repo create x', 'gh repo edit --visibility public', 'gh repo delete owner/repo --yes',
      'gh repo rename y', 'gh repo archive', 'gh repo deploy-key add key.pub'],
    allowed: ['gh repo view', 'gh repo list', 'gh repo clone owner/repo', 'gh repo deploy-key list'],
  },
  'gh release': {
    denied: ['gh release create x', 'gh release create v1 --notes x', 'gh release upload v1 a.zip',
      'gh release delete v1'],
    allowed: ['gh release list', 'gh release view v1', 'gh release download v1'],
  },
  'gh pr': {
    denied: ['gh pr create --fill', 'gh pr merge 1 --squash', 'gh pr comment 1 --body x', 'gh pr close 1',
      'gh pr review 1 --approve'],
    allowed: ['gh pr view 1', 'gh pr list', 'gh pr diff 1', 'gh pr checks 1', 'gh pr status'],
  },
  'gh workflow': {
    denied: ['gh workflow run ci.yml', 'gh workflow disable ci.yml'],
    allowed: ['gh workflow list', 'gh workflow view ci.yml'],
  },
  'gh api': {
    denied: ['gh api -X POST repos/owner/repo/issues', 'gh api repos/owner/repo/issues -X POST -f title=x',
      'gh api --method DELETE repos/owner/repo', 'gh api repos/owner/repo --method=PATCH -f name=y',
      'gh api -X PUT repos/owner/repo/topics'],
    allowed: ['gh api repos/owner/repo', 'gh api -X GET repos/owner/repo/issues', 'gh api user'],
  },
  'npm publish': {
    denied: ['npm publish', 'npm publish --dry-run', 'npm publish --access public'],
    allowed: ['npm test', 'npm pack', 'npm run build'],
  },
};

/** The outbound MCP tools that must be denied (claude.ai connector tools are mcp__claude_ai_<server>__<tool>). */
const OUTBOUND_MCP = [
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
  'mcp__claude_ai_Google_Drive__share_file',
  'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__update_event',
  'mcp__claude_ai_Google_Calendar__respond_to_event',
];

/** Tools that write files, run commands or spawn agents: none may be in project-verifier's tools. */
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Task'];

/** Tools of a rule list: { tool, spec } for Tool(spec), spec null for a bare tool name. */
function parseRule(rule) {
  const m = /^([^()]+)\((.*)\)$/s.exec(rule);
  return m ? { tool: m[1], spec: m[2] } : { tool: rule, spec: null };
}

/**
 * Whether a Bash or PowerShell rule specifier matches a simple command, per the permissions docs: each *
 * stands for any text (spaces included), everything else is literal, and a trailing " *" that is the
 * only wildcard also matches the command without it. PowerShell matching is case-insensitive.
 */
function specMatches(spec, command, { ignoreCase = false } = {}) {
  const parts = spec.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const flags = ignoreCase ? 'si' : 's';
  if (new RegExp(`^${parts.join('.*')}$`, flags).test(command)) return true;
  const stars = spec.split('*').length - 1;
  return stars === 1 && spec.endsWith(' *') && new RegExp(`^${parts[0].slice(0, -1)}$`, flags).test(command);
}

/** Whether any deny rule of the given shell tool matches the command. */
function denied(denyRules, tool, command) {
  return denyRules.map(parseRule)
    .some((r) => r.tool === tool && r.spec !== null && specMatches(r.spec, command, { ignoreCase: tool === 'PowerShell' }));
}

/**
 * The tool names a hook matcher selects, per the hooks docs: only letters, digits, _, -, spaces, comma and
 * | is an exact list; anything else is an unanchored JavaScript regex.
 */
function matcherSelects(matcher, toolName) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((s) => s.trim()).includes(toolName);
  return new RegExp(matcher).test(toolName);
}

/** All string values in a JSON value. */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** Local paths and personal data that must not appear in the fragments (lint-kit privacy covers the rest). */
const LOCAL_PATH_RE = /(^|[\s"'(=])(?:[A-Za-z]:[\\/]|\/[a-z]\/|\\\\)|[\\/]Users[\\/](?!<)|@[\w-]+\.[\w.]+/;

describe('Claude settings fragment', () => {
  const settings = readJson(SETTINGS);
  const deny = settings.permissions?.deny ?? [];

  test('parses and sets the batch-1 platform settings', () => {
    assert.equal(settings.worktree?.baseRef, 'head');
    assert.equal(settings.subagentPromptCacheTtl, '1h');
    assert.equal(settings.env?.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS, '6');
  });

  test('never sets CLAUDE_CODE_EFFORT_LEVEL (it would override the effort of every subagent)', () => {
    assert.ok(!Object.hasOwn(settings.env ?? {}, 'CLAUDE_CODE_EFFORT_LEVEL'));
    assert.ok(!fs.readFileSync(SETTINGS, 'utf8').includes('CLAUDE_CODE_EFFORT_LEVEL'));
    assert.ok(!Object.hasOwn(settings, 'effortLevel'));
  });

  test('deny rules are strings, none twice, and none is a Bash or PowerShell rule (AS3-385)', () => {
    assert.ok(deny.length > 0);
    for (const r of deny) assert.equal(typeof r, 'string');
    assert.equal(new Set(deny).size, deny.length, 'duplicate deny rules');
    // A shell deny rule decides before the guard can ask; a bare Bash or PowerShell deny would remove the whole tool.
    assert.deepEqual(deny.filter((r) => /^(?:Bash|PowerShell)\b/.test(r)), [], 'no shell deny rule in the fragment');
  });

  test('the retired rules: ten for git push and ninety for publishing, each body once for Bash and once for PowerShell', () => {
    assert.equal(RETIRED_PUSH_DENY.length, 5);
    assert.equal(RETIRED_PUBLISH_DENY.length, 45);
    assert.equal(RETIRED_CLAUDE_DENY.length, 100);
    assert.equal(new Set(RETIRED_CLAUDE_DENY).size, 100, 'no rule twice');
    for (const body of [...RETIRED_PUSH_DENY, ...RETIRED_PUBLISH_DENY]) {
      for (const tool of ['Bash', 'PowerShell']) assert.ok(RETIRED_CLAUDE_DENY.includes(`${tool}(${body})`), `${tool}(${body})`);
    }
    for (const body of RETIRED_PUBLISH_DENY) assert.match(body, /^(?:gh (?:repo|release|pr|workflow|api) |npm publish )/, body);
    // Nothing the kit still wants is in the retired list.
    assert.deepEqual(RETIRED_CLAUDE_DENY.filter((r) => r.startsWith('mcp__') || /^(?:Read|Edit|Write|NotebookEdit)\(/.test(r)), []);
  });

  for (const [category, { denied: bad, allowed: good }] of Object.entries(DENY_SAMPLES)) {
    test(`${category}: no rule of the fragment matches; the retired rules are the ones that did, and they left the reads alone`, () => {
      for (const tool of ['Bash', 'PowerShell']) {
        for (const cmd of [...bad, ...good]) assert.ok(!denied(deny, tool, cmd), `${tool} must not deny by rule: ${cmd}`);
        for (const cmd of bad) assert.ok(denied(RETIRED_CLAUDE_DENY, tool, cmd), `a retired ${tool} rule matched: ${cmd}`);
        for (const cmd of good) assert.ok(!denied(RETIRED_CLAUDE_DENY, tool, cmd), `no retired ${tool} rule matched: ${cmd}`);
      }
    });
  }

  test('git push has no deny rule: none of the retired ones is in the fragment and no rule matches a push', () => {
    assert.deepEqual(deny.filter((r) => RETIRED_CLAUDE_DENY.includes(r)), []);
    assert.deepEqual(deny.filter((r) => /\bpush\b/i.test(r)), [], 'no deny rule names push');
    for (const tool of ['Bash', 'PowerShell']) {
      for (const cmd of PUSH_SAMPLES) assert.ok(!denied(deny, tool, cmd), `${tool} must not deny by rule: ${cmd}`);
      // The everyday git commands the old git push category listed as allowed are still not denied.
      for (const cmd of ['git status', 'git pull', 'git commit -m "fix"', 'git log --oneline', 'git -C . status']) assert.ok(!denied(deny, tool, cmd), `${tool} should not deny: ${cmd}`);
    }
  });

  test('the settings merge takes the retired push and publish deny rules out and leaves every other rule', () => {
    const own = ['Bash(rm -rf *)', 'Read(//d/secret/**)', 'Bash(git push --mirror *)'];
    // The owner's own rules stay, also one that names gh or npm in a spelling the kit never wrote.
    const mine = 'Bash(npm publish --tag danger *)';
    const current = { model: 'x', permissions: { allow: ['Bash(git push *)'], deny: [own[0], ...RETIRED_CLAUDE_DENY, own[1], mine, own[2]] } };
    const merged = mergeClaudeSettings(current, { permissions: { deny: deny.slice() } });
    assert.deepEqual(merged.permissions.deny.filter((r) => RETIRED_CLAUDE_DENY.includes(r)), []);
    for (const r of [...own, ...deny]) assert.ok(merged.permissions.deny.includes(r), `kept or added: ${r}`);
    assert.deepEqual(merged.permissions.deny.slice(0, 4), [own[0], own[1], mine, own[2]], 'the order of what stays is kept');
    assert.equal(merged.permissions.deny.length, 4 + deny.length, 'nothing but the retired rules is gone');
    assert.deepEqual(merged.permissions.allow, ['Bash(git push *)'], 'allow rules are not the kit\'s to touch');
    assert.equal(merged.model, 'x');
    assert.deepEqual(current.permissions.deny.length, 104, 'the input is not changed');
    assert.deepEqual(mergeClaudeSettings(merged, { permissions: { deny: deny.slice() } }), merged, 'a second merge changes nothing');
    assert.deepEqual(mergeClaudeSettings(null, { permissions: { deny: deny.slice() } }).permissions.deny, deny);
    assert.deepEqual(mergeClaudeSettings({ permissions: {} }, {}), { permissions: {} });
  });

  test('the sample matcher reads PowerShell rules case-insensitively, as PowerShell does', () => {
    assert.ok(denied(RETIRED_CLAUDE_DENY, 'PowerShell', 'NPM publish'));
    assert.ok(denied(RETIRED_CLAUDE_DENY, 'PowerShell', 'GH PR create --fill'));
    assert.ok(!denied(RETIRED_CLAUDE_DENY, 'Bash', 'GH PR create --fill'));
  });

  test('outbound MCP tools are denied by their exact names', () => {
    for (const t of OUTBOUND_MCP) assert.ok(deny.includes(t), `missing deny: ${t}`);
    const mcp = deny.filter((r) => r.startsWith('mcp__'));
    for (const r of mcp) assert.ok(!r.includes('('), `an mcp__ rule with parentheses is skipped by Claude Code: ${r}`);
  });

  test('no path rules in the fragment: read-only and customer folders are generated at deploy time', () => {
    const pathRules = deny.map(parseRule).filter((r) => ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(r.tool));
    assert.deepEqual(pathRules, []);
  });

  test('the PreToolUse guard covers only the relevant tools and blocks on failure', () => {
    const groups = settings.hooks?.PreToolUse ?? [];
    assert.ok(groups.length > 0);
    const relevant = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
      'mcp__project-manager__update_task_status', 'mcp__project-manager__set_project_dir', 'mcp__project-manager__get_task_by_id'];
    const irrelevant = ['Read', 'Grep', 'Glob', 'TodoWrite', 'WebFetch', 'Agent', 'mcp__claude_ai_Gmail__send_message',
      'mcp__other-server__update_task_status'];
    const selected = (tool) => groups.some((g) => matcherSelects(g.matcher, tool));
    for (const t of relevant) assert.ok(selected(t), `guard should see ${t}`);
    for (const t of irrelevant) assert.ok(!selected(t), `guard should not run for ${t}`);
    for (const g of groups) {
      assert.ok(g.hooks.length > 0);
      for (const h of g.hooks) {
        assert.equal(h.type, 'command');
        assert.equal(h.onFailure, 'block');
        assert.ok(!h.async && !h.asyncRewake, 'onFailure has no effect on background hooks');
        assert.equal(h.command, '<node>', 'the runtime portable Node, by absolute path at deploy time');
        assert.deepEqual(h.args, ['<runtime>/hooks/guard.mjs', '--platform', 'claude']);
      }
    }
  });

  test('SessionStart runs the session-start hook on startup, resume and compact', () => {
    const groups = settings.hooks?.SessionStart ?? [];
    assert.equal(groups.length, 1);
    for (const src of ['startup', 'resume', 'compact']) assert.ok(matcherSelects(groups[0].matcher, src), src);
    for (const src of ['clear', 'fork']) assert.ok(!matcherSelects(groups[0].matcher, src), src);
    const [h] = groups[0].hooks;
    assert.equal(h.command, '<node>');
    assert.deepEqual(h.args, ['<runtime>/hooks/session-start.mjs', '--platform', 'claude']);
    assert.notEqual(h.onFailure, 'block', 'a SessionStart hook must never stop a session');
  });

  test('the hook scripts it names exist in the repo', () => {
    const scripts = strings(settings.hooks).filter((s) => s.startsWith('<runtime>/hooks/'));
    assert.ok(scripts.length >= 2);
    for (const s of scripts) assert.ok(fs.existsSync(path.join(REPO, 'hooks', path.basename(s))), s);
  });
});

/** Minimal frontmatter reader for the verifier: one "key: value" per line between --- fences. */
function readFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter fences');
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    assert.ok(kv, `not a "key: value" line: ${line}`);
    assert.ok(!Object.hasOwn(fields, kv[1]), `duplicate key ${kv[1]}`);
    fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: text.slice(m[0].length) };
}
const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

describe('project-verifier subagent', () => {
  const { fields, body } = readFrontmatter(VERIFIER);

  test('frontmatter parses with the fields of the current subagent docs', () => {
    assert.equal(fields.name, 'project-verifier');
    assert.ok(fields.description.length > 0);
    assert.equal(fields.model, 'opus');
    assert.equal(fields.effort, 'high');
    const known = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'effort']);
    for (const k of Object.keys(fields)) assert.ok(known.has(k), `unexpected field ${k}`);
  });

  test('tools are read-only: Read, Grep, Glob and the ledger read tools', () => {
    const tools = list(fields.tools);
    assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'mcp__project-manager__get_task_by_id',
      'mcp__project-manager__get_all_tasks', 'mcp__project-manager__get_logs']);
    for (const t of WRITE_TOOLS) assert.ok(!tools.includes(t), `write tool in tools: ${t}`);
    for (const t of tools.filter((x) => x.startsWith('mcp__'))) {
      assert.match(t, /^mcp__project-manager__get_[a-z_]+$/, `ledger tool that is not a read: ${t}`);
      assert.ok(!t.endsWith('*'), 'no server-wide wildcard');
    }
  });

  test('write, shell and agent tools are disallowed explicitly', () => {
    const disallowed = list(fields.disallowedTools);
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent']) {
      assert.ok(disallowed.includes(t), `missing in disallowedTools: ${t}`);
    }
  });

  test('the body asks for review against the original criteria with graded findings', () => {
    for (const word of ['原始验收标准', '实现者的成功总结', 'blocker', 'major', 'minor', '违反哪条标准', '怎么复现', '实际影响']) {
      assert.ok(body.includes(word), `body lacks ${word}`);
    }
  });
});

/** Parse a TOML file with Python's tomllib (Python >= 3.11): python, else the py launcher. */
function parseToml(file) {
  const code = 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))';
  for (const [cmd, pre] of [['python', []], ['py', ['-3']]]) {
    const r = spawnSync(cmd, [...pre, '-c', code, file], { encoding: 'utf8' });
    if (r.status === 0) return JSON.parse(r.stdout);
    if (r.error?.code !== 'ENOENT' && r.stderr) throw new Error(`${cmd}: ${r.stderr.trim()}`);
  }
  return null;
}

describe('Codex config fragment', () => {
  test('tomllib parses it: medium effort, steer, no subagent effort and no thread cap', (t) => {
    const toml = parseToml(CODEX_TOML);
    if (!toml) { t.skip('no Python with tomllib found (python or py -3)'); return; }
    assert.deepEqual(toml, { model_reasoning_effort: 'medium', desktop: { followUpQueueMode: 'steer' } });
    assert.ok(!Object.hasOwn(toml.agents ?? {}, 'default_subagent_reasoning_effort'));
  });

  test('no key line sets the subagent effort or a thread cap, not even commented in', () => {
    const lines = fs.readFileSync(CODEX_TOML, 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    for (const l of lines) assert.doesNotMatch(l, /default_subagent_reasoning_effort|max_threads|max_concurrent_threads/);
  });
});

describe('Codex hooks.json', () => {
  const hooks = readJson(CODEX_HOOKS);

  test('registers the same guard for the shell, patch and ledger tools, failing closed', () => {
    const groups = hooks.hooks?.PreToolUse ?? [];
    assert.equal(groups.length, 1);
    const sees = (tool) => matcherSelects(groups[0].matcher, tool);
    for (const t of ['Bash', 'apply_patch', 'Edit', 'Write', 'mcp__project-manager__update_task_status',
      'mcp__project_manager__set_project_dir']) assert.ok(sees(t), t);
    for (const t of ['Read', 'TodoWrite', 'NotebookEdit2', 'mcp__claude_ai_Gmail__send_message', 'xBash']) assert.ok(!sees(t), t);
    const [h] = groups[0].hooks;
    assert.equal(h.type, 'command');
    // The bare Node path first, the script path quoted: the only form C0 ran (ADR-006 §7).
    assert.equal(h.command, '<node> "<runtime>/hooks/guard.mjs" --platform codex');
    assert.ok(Number.isInteger(h.timeout) && h.timeout > 0);
    assert.match(hooks.description, /出错即拦截/);
    assert.doesNotMatch(hooks.description, /放行|只当提醒/);
  });

  test('SessionStart is not registered on Codex (C0: root thread only, ADR-006 §7)', () => {
    assert.deepEqual(Object.keys(hooks.hooks), ['PreToolUse']);
  });
});

describe('Codex rules file', () => {
  test('forbids git push, gh writes and npm publish with prefix_rule', () => {
    const text = fs.readFileSync(CODEX_RULES, 'utf8');
    const rules = text.split(/^prefix_rule\(/m).slice(1);
    assert.ok(rules.length >= 3);
    for (const r of rules) assert.match(r, /decision = "forbidden"/);
    for (const head of ['["git", "push"]', '["gh", "release",', '["gh", "repo",', '["gh", "pr",', '["gh", "workflow",',
      '["gh", "api",', '["npm", "publish"]']) assert.ok(text.includes(`pattern = ${head}`), head);
  });
});

describe('local config example', () => {
  const local = readJson(KIT_LOCAL);

  test('documents every local field with placeholders only', () => {
    for (const k of ['readonly_dirs', 'customer_data_dirs', 'runtime', 'portable_node', 'projects_root',
      'restore_tool', 'deploy_options']) assert.ok(Object.hasOwn(local, k), k);
    assert.ok(Array.isArray(local.readonly_dirs) && Array.isArray(local.customer_data_dirs));
    for (const k of ['runtime', 'portable_node', 'projects_root', 'restore_tool']) assert.match(local[k], /^<[a-z-]+>/, k);
    for (const d of local.readonly_dirs) assert.match(d, /^<[a-z-]+>$/);
    assert.deepEqual(Object.keys(local.deploy_options).sort(), ['claude_contract', 'retire_legacy_agents']);
    for (const k of Object.keys(local).filter((x) => !x.startsWith('_'))) {
      assert.ok(local._comment.some((line) => line.startsWith(`${k}：`)), `no comment line for ${k}`);
    }
  });
});

describe('no local paths, names or addresses in the fragments', () => {
  const files = fs.readdirSync(CONFIG, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));

  test('config/ holds exactly the batch-1 fragments', () => {
    const rel = files.map((f) => path.relative(CONFIG, f).split(path.sep).join('/')).sort();
    assert.deepEqual(rel, ['claude/agents/project-verifier.md', 'claude/settings.fragment.json', 'codex/config.fragment.toml',
      'codex/hooks.json', 'codex/rules/autoskills.rules', 'kit-local.example.json']);
  });

  for (const file of [SETTINGS, VERIFIER, CODEX_TOML, CODEX_HOOKS, CODEX_RULES, KIT_LOCAL]) {
    test(path.basename(file), () => {
      const text = fs.readFileSync(file, 'utf8');
      const hit = text.split('\n').find((l) => LOCAL_PATH_RE.test(l));
      assert.equal(hit, undefined);
      assert.ok(!text.includes('\r'), 'LF line endings');
    });
  }
});
