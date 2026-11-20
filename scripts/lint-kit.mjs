#!/usr/bin/env node
// lint-kit: read-only content checks for the AutoSkills kit. Zero dependencies (Node >= 18).
//
// Usage:
//   node scripts/lint-kit.mjs --check <group,group|all> [--path <file|dir>]... [--root <dir>]
//   node scripts/lint-kit.mjs --git-log <range> [--check privacy] [--root <dir>]
//
// Exit codes: 0 = no findings; 1 = findings; 2 = usage or setup error (unknown option or group,
// missing --path target, no tool registry, bad word-list regex, git failure).
//
// Groups (--check all = every group below):
//   privacy  Built-in rules: user directories with a concrete user name (C:\Users\<name>, /home/<name>,
//            /Users/<name>, and the Git Bash/MSYS and WSL forms /c/Users/<name>, /mnt/c/Users/<name>),
//            drive-letter local paths (D:\work\repo, D:/work, /d/work, /mnt/d/work; a one-letter first
//            segment such as d:/x, placeholders and system folders such as C:\Windows are not reported,
//            nor regex literals such as /a/gi), and email addresses.
//            Not emails: SSH remotes (git@<host>:<owner>/<repo>, ssh://git@<host>/...) and noreply
//            addresses (noreply@<domain>, <id>+<name>@users.noreply.github.com), so Co-Authored-By
//            trailers pass. Plus the local word list <root>/_private/privacy-patterns.txt (git-excluded;
//            names of people, customers and private projects live only there, because writing them into
//            a public repo is itself the leak). Without the list, only the built-in rules run (with a note).
//   tools    project-manager tool names referenced in the scanned files must be registered in
//            <root>/mcp/project-manager/src/index.ts. A bare snake_case identifier is a tool reference
//            when its first word is the first word of a registered tool (get_, update_, close_ ...), or
//            when it joins a likely tool verb to a ledger noun (list_tasks, delete_task, start_task:
//            GUESS_VERBS x LEDGER_NOUNS); mcp__project-manager__<name> is always one. So field names such
//            as acceptance_mode or stage_gate are never taken for tools, and the 1.5.1 Task and log fields
//            that do start with a tool verb (close_reason) are listed in FIELD_NAMES. Parts of paths and
//            file names (after / or \, or before .<ext>, as in scripts/set_env.sh) are not tool
//            references. Tools of the host platforms that share a first word with project-manager tools
//            (Codex's update_plan) are listed in OTHER_TOOLS; this group has no allow marker. Task status
//            values (in task tool calls, state-machine arrows and task JSON blocks) and acceptance_mode
//            values must be in the project-manager 1.5.1 enums; text in HTML comments is not read as a
//            state-machine arrow.
//   skills   SKILL.md frontmatter has name and description, name equals the directory name, each
//            description is <= 400 characters and all of them together <= 2000 (Codex lists skills in a
//            budget of 8000 characters or 2% of the context, shared with other skills). Without --path,
//            skills/ must hold exactly the 7 skills of AutoSkills 3.0.
//   legacy   CouncilFlow, council commands and folders, the 6 retired skill names, Gemini.
//   contract The shared contract (batch-1 version). The contract source is the scanned file with the
//            heading "## 自主契约"; there must be exactly one (none is a finding when the scan has no --path
//            or a --path directory; a scan of single files only does not require one). It must hold the five
//            stop points, the zero-exception rule, the push rule, the evidence rules, the set_project_dir sentence, the
//            subagent rules and the Git and reporting rules, in at most 60 lines. The global Claude file
//            (global-claude-CLAUDE.md) must open with @AGENTS.md and add at most 10 lines; the retired
//            global-codex-AGENTS.md is a second source. Every scanned file: no old rules (design before
//            code, module-by-module confirmation, asking on vague requirements, the state-machine
//            description, tech-stack defaults) and no P0 terms (run_id, runner, receipts, dispatch, leases,
//            the verification executor). A scanned global-claude-CLAUDE.md must name the project-verifier
//            subagent, and a scanned goal.txt must hold the key lines of the batch-1 /goal (v2 appendix B):
//            "验证命令实际跑过并通过" and "没有就绪任务，本身不等于完成". This group has no allow marker.
//   source   .mjs files hold no literal U+FEFF (an invisible character in the source): write the escape
//            \uFEFF instead, as in a regex that strips a BOM. This group has no allow marker.
//
// Scan surface:
//   Without --path: skills/, templates/, config/, hooks/, scripts/ and mcp-manifest.json; privacy adds
//   tests/. tools defaults to skills/ and templates/, skills to skills/, contract to templates/, source to
//   the .mjs files of the kit surface. With
//   --path, exactly the named files and directories. README.md and docs/ are scanned only when named.
//   legacy never scans files under tests/. Directory walks skip .git, node_modules and the historical
//   records (ADR-001..005, audit and migration reports in docs/, mcp/*/tests/fixtures/); a file named
//   directly is always scanned.
//   --git-log <range> runs only the privacy group, over commit messages; a range that starts with - is a
//   usage error, so it never reaches git as an option. git is called directly with
//   -c i18n.logOutputEncoding=UTF-8 and the output decoded as UTF-8: piping git through Windows
//   PowerShell 5.1 hands it to native programs as ASCII and turns Chinese into question marks.
//
// Allow markers (a reason with at least one letter or digit is required; a marker without one is a
// finding, so is an unknown allow-*). A marker must open a comment: <!-- in Markdown; <!--, //, /*, #, or
// a leading *, ; or -- elsewhere. A marker named in prose, in inline code (after an odd number of
// backticks on its line) or in a fenced block of a Markdown file is not one, so docs that describe the
// markers can write them as `lint-kit: allow-privacy <reason>`.
//   lint-kit: allow-legacy <reason>    On a comment line of its own: the whole file. After other content
//                                      on a line: that line only. For deploy scripts that delete old names
//                                      and checkers that report them.
//   lint-kit: allow-privacy <reason>   Whole file only (must stand on a comment line of its own). Exempts
//                                      the built-in rules only, for fixtures with synthetic paths and fake
//                                      names. Hits from the private word list are never exempted.
//   This script does not check its own rule definitions: in this file only the private word list applies.
//
// The script only reads: it never writes, moves or deletes files. Findings go to stdout, notes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node scripts/lint-kit.mjs --check <privacy,tools,skills,legacy,contract,source|all> [--path <file|dir>]... [--root <dir>]\n'
  + '       node scripts/lint-kit.mjs --git-log <range> [--check privacy] [--root <dir>]';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');
const GROUPS = ['privacy', 'tools', 'skills', 'legacy', 'contract', 'source'];

const KIT_SURFACE = ['skills', 'templates', 'config', 'hooks', 'scripts', 'mcp-manifest.json'];
const DEFAULT_SURFACE = {
  privacy: [...KIT_SURFACE, 'tests'],
  tools: ['skills', 'templates'],
  skills: ['skills'],
  legacy: KIT_SURFACE,
  contract: ['templates'],
  source: KIT_SURFACE,
};
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// Historical records: kept as written, not part of the kit (repo-relative, forward slashes).
const HISTORICAL = [
  /^docs\/adr-00[1-5]-/,
  /^docs\/(?:.*-report.*|audit-.*)\.md$/,
  /^mcp\/[^/]+\/tests\/fixtures\//,
];
const WORD_LIST = '_private/privacy-patterns.txt';

// project-manager 1.5.1 enums (mcp/project-manager/src/state.ts: Task.status, AcceptanceMode).
const TASK_STATUSES = new Set(['todo', 'in_progress', 'auto_verified', 'awaiting_manual_acceptance', 'done', 'cancelled', 'superseded']);
const ACCEPTANCE_MODES = new Set(['auto', 'manual', 'milestone_manual']);
// Task tools whose call arguments carry task status values.
const STATUS_TOOLS = ['update_task_status', 'update_tasks', 'get_all_tasks', 'close_task', 'close_tasks', 'reopen_task'];
// Built-in tools of the host platforms that share a first word with project-manager tools. Known host
// tools go here: the tools group has no allow marker.
const OTHER_TOOLS = new Set(['update_plan']);
// snake_case fields of the 1.5.1 Task and log entries (mcp/project-manager/src/state.ts); close_reason
// shares its first word with close_task.
const FIELD_NAMES = new Set(['acceptance_criteria', 'needs_manual_review', 'acceptance_mode', 'verification_profile', 'verification_commands',
  'review_checklist', 'stage_gate', 'created_at', 'updated_at', 'commit_hash', 'replacement_task_id', 'closed_at', 'close_reason',
  'task_id', 'from_status', 'to_status', 'event_type']);
// Likely made-up tools: a common tool verb that no registered tool starts with, joined to a ledger noun.
const GUESS_VERBS = new Set(['list', 'delete', 'remove', 'complete', 'start', 'finish', 'mark', 'fetch', 'read', 'write', 'query', 'search',
  'find', 'show', 'move', 'assign', 'approve', 'reject', 'submit', 'cancel', 'block', 'init', 'sync', 'load', 'insert', 'upsert']);
const LEDGER_NOUNS = new Set(['task', 'tasks', 'subtask', 'subtasks', 'log', 'logs', 'prd', 'architecture', 'focus', 'profile', 'profiles',
  'module', 'modules', 'project', 'portfolio', 'context', 'status', 'state']);

// The 7 skills of AutoSkills 3.0 and the 6 retired in batch 1.
const KIT_SKILLS = ['project-consult', 'project-feedback', 'project-next', 'project-plan', 'project-quick', 'project-resume', 'project-status'];
const RETIRED_SKILLS = ['project-ask', 'project-change', 'project-design', 'project-discuss', 'project-init', 'project-review'];
const DESC_MAX = 400;
const DESC_TOTAL_MAX = 2000;

const LEGACY_RULES = [
  { rule: 'councilflow', re: /councilflow/gi, what: 'CouncilFlow' },
  { rule: 'council', re: /(?<![A-Za-z])council(?!flow)/gi, what: 'council command or folder' },
  { rule: 'retired-skill', re: new RegExp(`(?<![A-Za-z0-9_-])(?:${RETIRED_SKILLS.join('|')})(?![A-Za-z0-9_-])`, 'g'), what: 'retired skill name' },
  { rule: 'gemini', re: /(?<![A-Za-z])gemini/gi, what: 'Gemini' },
];

// The shared contract (batch-1 version: v2 appendix A plus the set_project_dir sentence of v3 section 5).
const CONTRACT_HEADING = /^#{1,6}\s*自主契约(?:（[^）]*）)?\s*$/;
const CONTRACT_SOURCE = 'global-AGENTS.md';
const CONTRACT_MAX_LINES = 60;
const CLAUDE_GLOBAL = 'global-claude-CLAUDE.md';
const CLAUDE_EXTRA_MAX = 10;
// What other batch-1 templates must carry, by file name: every pattern must match somewhere in the file.
const TEMPLATE_REQUIRED = {
  [CLAUDE_GLOBAL]: [{ rule: 'claude-verifier', what: 'the project-verifier subagent', res: [/project-verifier/] }],
  'goal.txt': [{ rule: 'goal-template', what: 'the key lines of the batch-1 /goal (v2 appendix B)', res: [/验证命令实际跑过并通过/, /没有就绪任务，本身不等于完成/] }],
};
// Former second sources of the global rules, replaced by templates/global-AGENTS.md.
const RETIRED_SOURCES = ['global-codex-AGENTS.md'];
// Clauses the contract must carry: every pattern of an entry must match somewhere in the file.
const CONTRACT_REQUIRED = [
  { rule: 'stop-points', what: 'the five stop points', res: [/停点只有五种/, /本轮做完/, /只剩用户本人能定的事/, /真的卡住/, /预算或截止时间到/, /用户说暂停或控制器出错/] },
  { rule: 'zero-exception', what: 'the zero-exception rule', res: [/零例外规则/, /不发布/, /不对外发送/, /不改只读目录/, /不访问客户数据/] },
  // Since AS3-379 a push is no zero-exception rule: it is off by default and decided by the owner's click.
  { rule: 'push-consent', what: 'the push rule (off by default, the owner\'s yes in the dialog, never unattended)', res: [/推送（git push）默认不做/, /用户本人在确认窗里点同意/, /文字里的“已同意”不算数/, /不改 pushurl/, /不换写法重试/, /无人值守的会话不推送/] },
  { rule: 'evidence', what: 'the evidence rules', res: [/测试证据必须是本会话里实际执行的命令/, /退出码/, /提交号从 git 读取/] },
  { rule: 'set-project-dir', what: 'the set_project_dir sentence', res: [/根线程开始时用主检出的绝对路径调一次 ?`?set_project_dir`?，并用 ?`?get_server_info`? ?核对 ?`?state_files/] },
  { rule: 'subagents', what: 'the subagent rules', res: [/^#{1,6}\s*子代理与并行/m, /只有主会话（Codex 里是根线程）写账本/, /子代理不调用 set_project_dir/, /同一个项目同一时间只允许一个进程写账本/] },
  { rule: 'git-report', what: 'the Git and reporting rules', res: [/^#{1,6}\s*Git 与汇报/m, /Conventional Commits/, /汇报进度或完成前，逐条对照本会话的工具结果/] },
];
// Old rules that batch 1 removes from the templates (v2 section 3.1).
const OLD_RULES = [
  { what: 'design before code', re: /先[^。\n]{0,8}设计[^。\n]{0,16}再[^。\n]{0,4}[写改][^。\n]{0,2}代码|[写改](?:任何)?代码(?:之)?前[^。\n]{0,20}设计/g },
  { what: 'module-by-module confirmation', re: /逐(?:个)?模块[^。\n]{0,6}确认|分模块逐步/g },
  { what: 'asking on vague requirements', re: /(?:需求[^。\n]{0,4}模糊|模糊[^。\n]{0,2}需求)[^。\n]{0,10}(?:问|澄清)/g },
  { what: 'state-machine description', re: /状态机|state machine|(?<![A-Za-z0-9_])(?:todo|in_progress|auto_verified)\s*-+>/gi },
  { what: 'tech-stack default', re: /\bSOLID\b|表现层\s*-+>|统一响应格式|\{\s*data,\s*meta\?|pnpm exec|前端(?:验证基线|任务默认策略)|技术栈默认/g },
];
// Terms of the parallel P0 version that the batch-1 templates must not carry yet.
const P0_TERMS = /(?<![A-Za-z0-9_])(?:run_id|runner|fence|op_key)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_-])run=|回执|分派|租约|执行器/g;

// User-name segments that are placeholders or shared system profiles, not a person.
const USER_PLACEHOLDERS = new Set(['user', 'username', 'me', 'you', 'yourname', 'your-name', 'your_name', 'name', 'someone', 'xxx', 'public', 'default', 'all users']);
// First segments of drive paths that say nothing about this machine's owner or projects.
const DRIVE_GENERIC = new Set(['windows', 'program files', 'program', 'programdata', 'path', 'tmp', 'temp', 'foo', 'bar', 'example', 'dir', 'folder']);
const WIN_USER_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>|:*?]+)/gi;
// Optional Git Bash/MSYS (/c) or WSL (/mnt/c) drive prefix before /Users or /home.
const NIX_USER_RE = /(?<![\w.~-])(?:\/mnt)?(?:\/[A-Za-z])?\/(?:home|[Uu]sers)\/([^/\s"'`<>|:*?]+)/g;
const DRIVE_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+([^\\/\s"'`<>|:*?]+)/g;
// Git Bash/MSYS (/d/work) and WSL (/mnt/d/work) drive paths. The segment stops at code punctuation, so
// a regex literal such as /a/gi, leaves only its flags (see builtinPrivacy).
const MSYS_DRIVE_RE = /(?<![\w.~\/-])\/(?:mnt\/)?[A-Za-z]\/([^\\/\s"'`<>|:*?()[\]{},;=]+)/g;
const EMAIL_RE = /(?<![\w.+-])([\w.+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])/g;

const MARKER_RE = /lint-kit:\s*allow-([A-Za-z-]*)/g;
// What must stand right before a marker: a comment opener (in Markdown, an HTML comment only).
const MARKER_LEAD_MD = /<!--\s*$/;
const MARKER_LEAD = /(?:<!--|\/\/|\/\*|#|^\s*\*|^\s*;|^\s*--)\s*$/;

class UsageError extends Error {}

function toPosix(p) { return p.split(path.sep).join('/'); }
function samePath(a, b) {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}
function relOf(root, abs) {
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? toPosix(rel) : toPosix(abs);
}

// ---------- files ----------

/** Text content of a file, or null for binary files (NUL byte in the first 8 KiB). */
function readText(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** Files under the given targets: directories are walked, files named directly are always kept. */
function collectFiles(root, targets, { strict }) {
  const out = new Map();
  const walk = (abs) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const child = path.join(abs, ent.name);
      const rel = relOf(root, child);
      if (HISTORICAL.some((re) => re.test(rel))) continue;
      if (ent.isDirectory()) walk(child);
      else if (ent.isFile()) out.set(child, rel);
    }
  };
  for (const t of targets) {
    const abs = path.resolve(root, t);
    if (!fs.existsSync(abs)) {
      if (strict) throw new UsageError(`path not found: ${t}`);
      continue;
    }
    if (fs.statSync(abs).isDirectory()) walk(abs);
    else out.set(abs, relOf(root, abs));
  }
  return [...out].map(([abs, rel]) => ({ abs, rel }));
}

// ---------- allow markers ----------

/** The first marker on a line that opens a comment and is not inside inline code, or null. */
function findMarker(line, markdown) {
  for (const m of line.matchAll(MARKER_RE)) {
    const before = line.slice(0, m.index);
    if ((before.match(/`/g) || []).length % 2) continue; // inside inline code or a template literal
    if ((markdown ? MARKER_LEAD_MD : MARKER_LEAD).test(before)) return m;
  }
  return null;
}

/** Allow markers of one file: file-level flags, allowed line indexes and marker findings. */
function parseMarkers(lines, markdown) {
  const res = { file: { legacy: false, privacy: false }, legacyLines: new Set(), errors: [] };
  let fenced = false; // inside a fenced block of a Markdown file
  lines.forEach((line, i) => {
    if (markdown && /^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = findMarker(line, markdown);
    if (!m) return;
    const kind = m[1];
    const reason = line.slice(m.index + m[0].length).replace(/(?:-->|\*\/)\s*$/, '').trim();
    const ownLine = line.slice(0, m.index).replace(/<!--|\/\/|\/\*|\*|#|;|--|\s/g, '') === '';
    const group = kind === 'legacy' || kind === 'privacy' ? kind : null;
    if (!group) {
      res.errors.push({ line: i, col: m.index, group: null, rule: 'marker', msg: `unknown marker "allow-${kind}" (known: allow-legacy, allow-privacy)` });
      return;
    }
    if (!/[\p{L}\p{N}]/u.test(reason)) {
      res.errors.push({ line: i, col: m.index, group, rule: 'marker', msg: `allow-${group} marker without a reason` });
      return;
    }
    if (group === 'privacy') {
      if (ownLine) res.file.privacy = true;
      else res.errors.push({ line: i, col: m.index, group, rule: 'marker', msg: 'allow-privacy is file-level only: put it on a comment line of its own' });
    } else if (ownLine) res.file.legacy = true;
    else res.legacyLines.add(i);
  });
  return res;
}

// ---------- privacy ----------

/** Compiled entries of the private word list, or null when the list does not exist. */
function loadWordList(root) {
  const file = path.join(root, WORD_LIST);
  if (!fs.existsSync(file)) return null;
  const entries = [];
  readText(file).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let re;
    if (line.startsWith('re:')) {
      try { re = new RegExp(line.slice(3), 'gi'); } catch (e) { throw new UsageError(`${WORD_LIST}:${i + 1}: bad regex: ${e.message}`); }
    } else {
      const body = line.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]*');
      const head = /^[0-9A-Za-z]/.test(line) ? '(?<![0-9A-Za-z])' : '';
      const tail = /[0-9A-Za-z]$/.test(line) ? '(?![0-9A-Za-z])' : '';
      re = new RegExp(head + body + tail, 'gi');
    }
    entries.push({ re, n: entries.length + 1, at: i + 1 });
  });
  return entries;
}

function mask(s) { return `${[...s][0]}***`; }

/** A drive path's first segment that says nothing about this machine (Users, one letter, placeholder, system folder). */
function isGenericDriveSegment(seg) {
  return /^users$/i.test(seg) || [...seg].length < 2 || /^[<$%{]/.test(seg) || DRIVE_GENERIC.has(seg.toLowerCase());
}

function isPlaceholderName(name) {
  return /^[<$%{*.~]/.test(name) || USER_PLACEHOLDERS.has(name.toLowerCase());
}

function isExemptEmail(line, m) {
  const [whole, local, domain] = m;
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + whole.length);
  if (local.toLowerCase() === 'git' && (after.startsWith(':') || before.endsWith('//'))) return true; // SSH remote
  return /^no-?reply$/i.test(local) || /(?:^|\.)no-?reply\./i.test(domain);
}

/** Built-in privacy rules on one line. */
function builtinPrivacy(line) {
  const hits = [];
  for (const m of line.matchAll(WIN_USER_RE)) {
    if (!isPlaceholderName(m[1])) hits.push({ col: m.index, rule: 'user-dir', msg: `user directory with a concrete user name: ${m[0]}` });
  }
  for (const m of line.matchAll(NIX_USER_RE)) {
    if (!isPlaceholderName(m[1])) hits.push({ col: m.index, rule: 'user-dir', msg: `user directory with a concrete user name: ${m[0]}` });
  }
  for (const m of line.matchAll(DRIVE_RE)) {
    if (isGenericDriveSegment(m[1])) continue;
    hits.push({ col: m.index, rule: 'drive-path', msg: `drive-letter local path: ${m[0]}` });
  }
  for (const m of line.matchAll(MSYS_DRIVE_RE)) {
    const seg = m[1];
    // A last segment of regex flag letters belongs to a regex literal (/a/gi), not a path.
    const flags = /^[dgimsuyv]+$/.test(seg) && !/^[\\/]/.test(line.slice(m.index + m[0].length));
    if (isGenericDriveSegment(seg) || flags) continue;
    hits.push({ col: m.index, rule: 'drive-path', msg: `drive-letter local path: ${m[0]}` });
  }
  for (const m of line.matchAll(EMAIL_RE)) {
    if (!isExemptEmail(line, m)) hits.push({ col: m.index, rule: 'email', msg: `email address: ${m[0]}` });
  }
  return hits;
}

/** Privacy findings of one text. builtin=false skips the built-in rules (allow-privacy, own rules). */
function privacyText(lines, words, builtin) {
  const out = [];
  lines.forEach((line, i) => {
    for (const w of words || []) {
      for (const m of line.matchAll(w.re)) {
        if (!m[0]) continue;
        out.push({ line: i, col: m.index, rule: 'word-list', msg: `private word list entry #${w.n} (${WORD_LIST}:${w.at}) matched "${mask(m[0])}"` });
      }
    }
    if (builtin) out.push(...builtinPrivacy(line).map((h) => ({ ...h, line: i })));
  });
  return out;
}

// ---------- tools ----------

/** Registered project-manager tool names and their first words. */
function loadRegistry(root) {
  const file = path.join(root, 'mcp/project-manager/src/index.ts');
  if (!fs.existsSync(file)) throw new UsageError(`tool registry not found: ${relOf(root, file)}`);
  const names = new Set([...readText(file).matchAll(/\.(?:tool|registerTool)\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]));
  if (!names.size) throw new UsageError(`no tools registered in ${relOf(root, file)}`);
  const verbs = new Set([...names].filter((n) => n.includes('_')).map((n) => n.split('_')[0]));
  return { names, verbs };
}

/** Text of a call's argument list on one line (up to the matching parenthesis or the line end). */
function callArgs(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open + 1, i);
  }
  return line.slice(open + 1);
}

/** The line with HTML comments replaced by spaces (columns kept); open = a comment runs on to the next line. */
function blankHtmlComments(line, open) {
  let text = '';
  let rest = line;
  for (;;) {
    if (open) {
      const end = rest.indexOf('-->');
      if (end < 0) return { text: text + ' '.repeat(rest.length), open: true };
      text += ' '.repeat(end + 3);
      rest = rest.slice(end + 3);
      open = false;
    }
    const start = rest.indexOf('<!--');
    if (start < 0) return { text: text + rest, open: false };
    text += `${rest.slice(0, start)}    `;
    rest = rest.slice(start + 4);
    open = true;
  }
}

function toolsText(lines, reg) {
  const out = [];
  const badStatus = (i, col, v, where) => {
    if (!TASK_STATUSES.has(v)) out.push({ line: i, col, rule: 'status', msg: `"${v}" is not a project-manager 1.5.1 task status (${where})` });
  };
  let fence = null; // { start, text[] } while inside a fenced code block
  const taskBlocks = [];
  let inComment = false; // inside an HTML comment that spans lines
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence) { taskBlocks.push(fence); fence = null; } else fence = { start: i, lines: [] };
    } else if (fence) fence.lines.push({ i, line });

    // Tool names.
    for (const m of line.matchAll(/mcp__project-manager__([A-Za-z0-9_]+)/g)) {
      if (!reg.names.has(m[1])) out.push({ line: i, col: m.index, rule: 'tool-name', msg: `tool "${m[1]}" is not registered in mcp/project-manager/src/index.ts` });
    }
    // Not after / or \ and not before .<ext>: parts of paths and file names (scripts/set_env.sh).
    for (const m of line.matchAll(/(?<![A-Za-z0-9_/\\])([a-z]+)_[a-z0-9_]*[a-z0-9]\b(?!\.[A-Za-z0-9])/g)) {
      const name = m[0];
      const toolLike = reg.verbs.has(m[1]) || (GUESS_VERBS.has(m[1]) && LEDGER_NOUNS.has(name.slice(name.lastIndexOf('_') + 1)));
      if (!toolLike || reg.names.has(name) || OTHER_TOOLS.has(name) || FIELD_NAMES.has(name)) continue;
      out.push({ line: i, col: m.index, rule: 'tool-name', msg: `tool "${name}" is not registered in mcp/project-manager/src/index.ts` });
    }

    // Task status values in task tool calls.
    for (const m of line.matchAll(new RegExp(`(?<![A-Za-z0-9_])(${STATUS_TOOLS.join('|')})\\s*\\(`, 'g'))) {
      const args = callArgs(line, m.index + m[0].length - 1);
      const base = m.index + m[0].length;
      for (const a of args.matchAll(/\b(?:to_)?status["'`]?\s*[=:]\s*["'`]?([A-Za-z_]+)/g)) badStatus(i, base + a.index, a[1], `${m[1]} argument`);
      for (const a of args.matchAll(/(?<![=:]\s*)["'`]([a-z_]+)["'`](?!\s*:)/g)) {
        if (a[1] !== 'status' && a[1] !== 'to_status') badStatus(i, base + a.index, a[1], `${m[1]} argument`);
      }
    }

    // State-machine arrows: once a line chains a task status, every link must be one. HTML comments
    // (allow markers, notes) are blanked first, or their closing --> would read as an arrow.
    const bare = blankHtmlComments(line, inComment);
    inComment = bare.open;
    const arrows = [...bare.text.matchAll(/([a-z_]+)\s*-+>/g)].map((a) => ({ v: a[1], col: a.index }));
    for (const a of bare.text.matchAll(/-+>\s*([a-z_]+(?:\s*\|\s*[a-z_]+)*)/g)) {
      for (const v of a[1].split('|')) arrows.push({ v: v.trim(), col: a.index });
    }
    if (arrows.some((a) => TASK_STATUSES.has(a.v))) for (const a of arrows) badStatus(i, a.col, a.v, 'state-machine arrow');

    // acceptance_mode values.
    for (const m of line.matchAll(/acceptance_mode["'`]?\s*(?:==|=|:)\s*["'`]?([a-z_]+(?:\s*\|\s*[a-z_]+)*)/g)) {
      for (const v of m[1].split('|').map((s) => s.trim())) {
        if (!ACCEPTANCE_MODES.has(v)) out.push({ line: i, col: m.index, rule: 'acceptance-mode', msg: `"${v}" is not a project-manager 1.5.1 acceptance_mode` });
      }
    }
  });

  // Task JSON/YAML in fenced blocks that describe tasks (they name acceptance_mode or verification_commands).
  for (const b of taskBlocks) {
    if (!b.lines.some((l) => /acceptance_mode|verification_commands/.test(l.line))) continue;
    for (const { i, line } of b.lines) {
      const m = /"status"\s*:\s*"([A-Za-z_]+)"|^\s*status:\s*([A-Za-z_]+)\s*$/.exec(line);
      if (m) badStatus(i, m.index, m[1] || m[2], 'task block');
    }
  }
  return out;
}

// ---------- skills ----------

/** Frontmatter keys of a SKILL.md (a small YAML subset: plain, quoted and block scalars). */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const fm = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2].trim();
    const more = [];
    while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
    if (/^[|>][+-]?$/.test(v)) v = more.join(v[0] === '|' ? '\n' : ' ');
    else {
      if (more.length) v = [v, ...more].join(' ');
      if (/^".*"$/s.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'.*'$/s.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    }
    fm[m[1]] = v;
  }
  return fm;
}

function skillsCheck(root, files, scoped) {
  const out = [];
  const skills = files.filter((f) => path.basename(f.abs) === 'SKILL.md');
  let total = 0;
  for (const f of skills) {
    const add = (rule, msg) => out.push({ rel: f.rel, line: null, col: null, group: 'skills', rule, msg });
    const fm = parseFrontmatter(readText(f.abs) ?? '');
    if (!fm) { add('frontmatter', 'missing YAML frontmatter (--- ... ---) at the top'); continue; }
    const dir = path.basename(path.dirname(f.abs));
    if (!fm.name) add('name', 'frontmatter has no name');
    else if (fm.name !== dir) add('name', `name "${fm.name}" differs from the directory name "${dir}"`);
    if (!fm.description) { add('description', 'frontmatter has no description'); continue; }
    const len = [...fm.description].length;
    total += len;
    if (len > DESC_MAX) add('description', `description has ${len} characters (max ${DESC_MAX})`);
  }
  if (total > DESC_TOTAL_MAX) {
    out.push({ rel: scoped ? '(scanned skills)' : 'skills/', line: null, col: null, group: 'skills', rule: 'description-total', msg: `descriptions total ${total} characters (max ${DESC_TOTAL_MAX})` });
  }
  if (!scoped) {
    const dir = path.join(root, 'skills');
    const have = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    for (const n of KIT_SKILLS.filter((s) => !have.includes(s))) out.push({ rel: 'skills/', line: null, col: null, group: 'skills', rule: 'skill-set', msg: `missing skill ${n}` });
    for (const n of have.filter((s) => !KIT_SKILLS.includes(s))) out.push({ rel: `skills/${n}/`, line: null, col: null, group: 'skills', rule: 'skill-set', msg: `not one of the ${KIT_SKILLS.length} kit skills: ${n}` });
    for (const n of have.filter((s) => KIT_SKILLS.includes(s) && !fs.existsSync(path.join(dir, s, 'SKILL.md')))) {
      out.push({ rel: `skills/${n}/`, line: null, col: null, group: 'skills', rule: 'skill-set', msg: 'directory without SKILL.md' });
    }
  }
  return out;
}

// ---------- legacy ----------

function legacyText(lines, markers) {
  const out = [];
  if (markers.file.legacy) return out;
  lines.forEach((line, i) => {
    if (markers.legacyLines.has(i)) return;
    for (const r of LEGACY_RULES) {
      for (const m of line.matchAll(r.re)) out.push({ line: i, col: m.index, rule: r.rule, msg: `${r.what}: ${m[0]}` });
    }
  });
  return out;
}

// ---------- contract ----------

/** Contract findings over the scanned files; needSource = the scan covers a whole set (no --path, or a directory). */
function contractCheck(files, load, needSource) {
  const out = [];
  const docs = files.map((f) => ({ f, doc: load(f) })).filter((x) => x.doc);
  // global-AGENTS.md counts as the source when it is among them; the others are reported as copies.
  const rank = ({ f }) => (path.basename(f.abs) === CONTRACT_SOURCE ? 0 : 1);
  const sources = docs.filter(({ doc }) => doc.lines.some((l) => CONTRACT_HEADING.test(l)))
    .sort((a, b) => rank(a) - rank(b) || (a.f.rel < b.f.rel ? -1 : a.f.rel > b.f.rel ? 1 : 0));
  if (!sources.length && needSource) out.push({ rel: '(scanned files)', line: null, col: null, rule: 'single-source', msg: 'no contract source: no scanned file has the heading "## 自主契约"' });
  sources.slice(1).forEach(({ f }) => out.push({ rel: f.rel, line: null, col: null, rule: 'single-source', msg: `second contract source (the first is ${sources[0].f.rel}); keep one and import it` }));
  for (const { f, doc } of sources) {
    const add = (rule, msg) => out.push({ rel: f.rel, line: null, col: null, rule, msg });
    const text = doc.lines.join('\n');
    for (const req of CONTRACT_REQUIRED) {
      const miss = req.res.filter((re) => !re.test(text));
      if (miss.length) add(req.rule, `missing ${req.what}: no match for ${miss.map((re) => re.source).join(', ')}`);
    }
    const n = doc.lines.length - (doc.lines[doc.lines.length - 1] === '' ? 1 : 0);
    if (n > CONTRACT_MAX_LINES) add('length', `contract has ${n} lines (max ${CONTRACT_MAX_LINES})`);
  }
  for (const { f, doc } of docs) {
    const add = (line, col, rule, msg) => out.push({ rel: f.rel, line, col, rule, msg });
    const base = path.basename(f.abs);
    if (RETIRED_SOURCES.includes(base)) add(null, null, 'single-source', 'retired second source of the global rules; templates/global-AGENTS.md replaces it');
    const text = doc.lines.join('\n');
    for (const req of TEMPLATE_REQUIRED[base] || []) {
      const miss = req.res.filter((re) => !re.test(text));
      if (miss.length) add(null, null, req.rule, `missing ${req.what}: no match for ${miss.map((re) => re.source).join(', ')}`);
    }
    if (base === CLAUDE_GLOBAL) {
      if (doc.lines[0].trim() !== '@AGENTS.md') add(0, 0, 'claude-import', 'the first line must be @AGENTS.md (import the contract, do not copy it)');
      const extra = doc.lines.slice(1).filter((l) => l.trim()).length;
      if (extra > CLAUDE_EXTRA_MAX) add(null, null, 'claude-import', `${extra} Claude-only lines after the import (max ${CLAUDE_EXTRA_MAX})`);
    }
    doc.lines.forEach((line, i) => {
      for (const r of OLD_RULES) for (const m of line.matchAll(r.re)) add(i, m.index, 'old-rule', `old rule (${r.what}): ${m[0]}`);
      for (const m of line.matchAll(P0_TERMS)) add(i, m.index, 'p0-term', `P0 term in a batch-1 template: ${m[0]}`);
    });
  }
  return out;
}

// ---------- source ----------

/** Literal U+FEFF characters in a .mjs file, a leading BOM included (readText would strip that one). */
function sourceCheck(files) {
  const out = [];
  for (const f of files.filter((x) => /\.mjs$/i.test(x.abs))) {
    const buf = fs.readFileSync(f.abs);
    if (buf.subarray(0, 8192).includes(0)) continue;
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      for (let col = line.indexOf('\uFEFF'); col >= 0; col = line.indexOf('\uFEFF', col + 1)) {
        out.push({ rel: f.rel, line: i, col, group: 'source', rule: 'literal-bom', msg: 'literal U+FEFF in the source; write the escape \\uFEFF' });
      }
    });
  }
  return out;
}

// ---------- git log ----------

function gitMessages(root, range) {
  const r = spawnSync('git', ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '--no-color', '--format=%H%x00%B%x1e', range, '--'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new UsageError(`git failed: ${r.error.message}`);
  if (r.status !== 0) throw new UsageError(`git log ${range} failed: ${new TextDecoder('utf-8').decode(r.stderr).trim()}`);
  return new TextDecoder('utf-8').decode(r.stdout).split('\x1e').map((s) => s.replace(/^\r?\n/, '')).filter(Boolean).map((rec) => {
    const [hash, body = ''] = rec.split('\x00');
    return { hash, lines: body.replace(/\s+$/, '').split(/\r?\n/) };
  });
}

// ---------- main ----------

function parseCli(argv) {
  let a;
  try {
    a = parseArgs({ args: argv, options: { check: { type: 'string', multiple: true }, path: { type: 'string', multiple: true }, root: { type: 'string' }, 'git-log': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (a.help) return { help: true };
  const listed = (a.check || []).flatMap((c) => c.split(',')).map((s) => s.trim()).filter(Boolean);
  for (const g of listed) if (g !== 'all' && !GROUPS.includes(g)) throw new UsageError(`unknown group "${g}" (known: ${GROUPS.join(', ')}, all)`);
  const gitLog = a['git-log'];
  if (gitLog !== undefined) {
    if (!gitLog.trim()) throw new UsageError('--git-log needs a range');
    if (gitLog.trim().startsWith('-')) throw new UsageError(`--git-log range must not start with -: ${gitLog}`);
    if (listed.some((g) => g !== 'privacy')) throw new UsageError('--git-log runs only the privacy group');
    if (a.path) throw new UsageError('--git-log scans commit messages; it does not take --path');
  } else if (!listed.length) throw new UsageError('--check is required');
  const groups = gitLog !== undefined ? ['privacy'] : listed.includes('all') ? GROUPS : GROUPS.filter((g) => listed.includes(g));
  const root = path.resolve(a.root ?? DEFAULT_ROOT);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`root is not a directory: ${a.root}`);
  return { groups, paths: a.path || null, root, gitLog };
}

function run(argv) {
  const opts = parseCli(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  const { groups, paths, root, gitLog } = opts;
  const findings = [];
  let words = null;
  if (groups.includes('privacy')) {
    words = loadWordList(root);
    if (!words) console.error(`lint-kit: note: ${WORD_LIST} not found under ${toPosix(root)}; privacy uses the built-in rules only`);
  }

  if (gitLog !== undefined) {
    const commits = gitMessages(root, gitLog);
    for (const c of commits) {
      for (const f of privacyText(c.lines, words, true)) findings.push({ ...f, rel: `commit ${c.hash.slice(0, 10)}`, group: 'privacy' });
    }
    return report(findings, groups, `${commits.length} commit message(s)`);
  }

  const reg = groups.includes('tools') ? loadRegistry(root) : null;
  const cache = new Map();
  const load = (f) => {
    if (!cache.has(f.abs)) {
      const text = readText(f.abs);
      const lines = text === null ? null : text.split(/\r?\n/);
      cache.set(f.abs, lines && { lines, markers: parseMarkers(lines, /\.(?:md|markdown)$/i.test(f.abs)) });
    }
    return cache.get(f.abs);
  };
  const seen = new Set();
  const reported = new Set();
  for (const g of groups) {
    let files = collectFiles(root, paths || DEFAULT_SURFACE[g], { strict: !!paths });
    if (g === 'legacy') files = files.filter((f) => !f.rel.startsWith('tests/'));
    files.forEach((f) => seen.add(f.abs));
    if (g === 'skills') { findings.push(...skillsCheck(root, files, !!paths)); continue; }
    if (g === 'source') { findings.push(...sourceCheck(files)); continue; }
    if (g === 'contract') {
      const needSource = !paths || paths.some((p) => fs.statSync(path.resolve(root, p)).isDirectory());
      findings.push(...contractCheck(files.filter((f) => !samePath(f.abs, SELF)), load, needSource).map((x) => ({ ...x, group: g })));
      continue;
    }
    for (const f of files) {
      const doc = load(f);
      if (!doc) continue;
      const self = samePath(f.abs, SELF);
      const add = (list) => list.forEach((x) => findings.push({ ...x, rel: f.rel, group: g }));
      if (!self) {
        // Marker findings belong to their group; unknown markers are reported once, by the first group.
        add(doc.markers.errors.filter((e) => e.group === g || (e.group === null && !reported.has(f.abs))));
        reported.add(f.abs);
      }
      if (g === 'privacy') add(privacyText(doc.lines, words, !self && !doc.markers.file.privacy));
      else if (self) continue;
      else if (g === 'tools') add(toolsText(doc.lines, reg));
      else if (g === 'legacy') add(legacyText(doc.lines, doc.markers));
    }
  }
  return report(findings, groups, `${seen.size} file(s)`);
}

function report(findings, groups, scope) {
  for (const f of findings) {
    const loc = f.line == null ? f.rel : `${f.rel}:${f.line + 1}:${f.col + 1}`;
    console.log(`${loc}: ${f.group}/${f.rule}: ${f.msg}`);
  }
  console.log(findings.length ? `lint-kit: ${findings.length} finding(s) [${groups.join(',')}] in ${scope}` : `lint-kit: ok [${groups.join(',')}] ${scope}`);
  return findings.length ? 1 : 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (e) {
  // Any failure to run the checks is exit 2, never 1, so callers can tell it from findings.
  console.error(e instanceof UsageError ? `lint-kit: ${e.message}\n${USAGE}` : `lint-kit: error: ${e.stack || e}`);
  process.exitCode = 2;
}
