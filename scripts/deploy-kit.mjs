#!/usr/bin/env node
// deploy-kit: plan the deployment of the AutoSkills kit to the user level (ADR-006 §2.7). Zero
// dependencies (Node >= 18). This version only plans: it prints what a deploy would create, modify and
// remove, with a reason per item, and writes nothing. Writing, backup and rollback come with --apply and
// --rollback (AS3-113); settings.json, config.toml, hooks, rules, the runtime area and pushurl join the
// plan with AS3-112b.
//
// Usage:
//   node scripts/deploy-kit.mjs [--dry-run] [--json] [--claude-contract import|inline] [--retire-legacy-agents]
//                               [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
//   node scripts/deploy-kit.mjs --init-local [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
//
// Roots: every target is resolved from three roots (scripts/lib/kit-targets.mjs): --home (default the user
// directory), --runtime (default runtime in the local config) and --projects-root (default projects_root in
// the local config). Tests pass all three, so they never read targets in the real user directory.
//
// Dry-run (the default): reads the contract, the 7 skills, the templates and the agent definition in this
// repo, the local config and the current targets; prints the plan in three groups (create, modify, remove)
// plus the folders that are only listed. A missing local config is an error that names --init-local.
//   --claude-contract import (default) writes ~/.claude/CLAUDE.md as @AGENTS.md plus the Claude-only lines;
//   inline puts the contract text there instead, for when the import does not load.
//   --retire-legacy-agents adds the 3 old agents (v2 decision 9) to the removals; without it they stay.
//   Removals are limited to the old project-* copies; a folder whose name starts with "{" (a failed brace
//   expansion) is listed, not removed.
//
// --init-local writes only the local config (default <kit repo>/_private/kit-local.json) and the two canary
// folders next to it (_private/eval/smoke/readonly-canary/ and customer-canary/, each with a note file):
//   readonly_dirs       read-only folders registered in the project rules under the projects root, plus the
//                       read-only canary. A project registers one in its CLAUDE.md or AGENTS.md either with
//                       the contract line "- 只读目录：<path>" (templates/repo-AGENTS.md) or as a table row
//                       whose first cell is a `relative/path/` and another cell says read-only (只读); the
//                       folder must exist.
//   customer_data_dirs  the customer-data canary; real folders are added by hand (AS3-121).
//   runtime, portable_node, projects_root, restore_tool: the runtime area (default <private>/rt), its newest
//                       node-v*/ Node, the projects root (default the parent of the kit repo) and the step-0
//                       restore tool.
// An existing local config is kept: lists only gain entries, set values stay unless --runtime or
// --projects-root names a new one, deploy_options and other keys stay. Nothing is written when nothing changes.
//
// Exit codes: 0 = plan printed (or local config written / already current). 1 = the plan has conflicts (a
// folder where a file must go). 2 = usage or setup error (unknown option, missing local config, a kit source
// missing in the repo, a mode that is not implemented yet).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  KIT_REPO, DEFAULT_LOCAL_CONFIG, DEFAULT_OPTIONS, CLAUDE_CONTRACT_MODES, UsageError,
  targetMap, neverTouch, readLocalConfig, resolveRoots, desiredFiles, kitSkillDirs, legacyRemovals, listFiles, slash, pathKey, within,
} from './lib/kit-targets.mjs';

const USAGE = 'usage: node scripts/deploy-kit.mjs [--dry-run] [--json] [--claude-contract import|inline] [--retire-legacy-agents]\n'
  + '                                   [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --init-local [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]';

const SELF = fileURLToPath(import.meta.url);
const WIN = process.platform === 'win32';
// Modes of later tasks: named here so the message says where they come from, not "unknown option".
const LATER = { apply: 'AS3-113', rollback: 'AS3-113', drill: 'AS3-113', neutral: 'AS3-114', stage: 'AS3-112b', 'expect-clean': 'AS3-112b' };
const CANARIES = {
  readonly: { rel: ['eval', 'smoke', 'readonly-canary'], note: 'Canary for the read-only guard (registered in readonly_dirs by deploy-kit --init-local).\nThe deploy smoke test tries to write here; every write must be refused. Do not remove this folder.\n' },
  customer: { rel: ['eval', 'smoke', 'customer-canary'], note: 'Canary for the customer-data deny rule (registered in customer_data_dirs by deploy-kit --init-local).\nThe deploy smoke test tries to read this file; the read must be refused. It holds no real data.\n' },
};
const CANARY_NOTE = 'README.txt';
const LOCAL_KEYS = ['readonly_dirs', 'customer_data_dirs', 'runtime', 'portable_node', 'projects_root', 'restore_tool'];

// ---------- plan ----------

function sameBytes(file, content) {
  try { return fs.readFileSync(file).equals(content); } catch { return false; }
}

/**
 * The deploy plan for the AS3-112a targets. Reads only.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @param {{claudeContract?: string, retireLegacyAgents?: boolean, repo?: string}} [opts]
 * @returns {{roots: object, options: object, create: object[], modify: object[], remove: object[], listed: object[],
 *   conflicts: object[], unchanged: number}} create/modify entries carry path, group, mode, reason, content
 *   (Buffer) and source (repo file) when the content is a plain copy
 */
export function buildPlan(roots, { claudeContract = DEFAULT_OPTIONS.claude_contract, retireLegacyAgents = DEFAULT_OPTIONS.retire_legacy_agents, repo = KIT_REPO } = {}) {
  const plan = {
    roots, options: { claude_contract: claudeContract, retire_legacy_agents: retireLegacyAgents },
    create: [], modify: [], remove: [], listed: [], conflicts: [], unchanged: 0,
  };
  const desired = desiredFiles(roots, { claudeContract, repo });
  for (const d of desired) {
    let st = null;
    try { st = fs.lstatSync(d.path); } catch { /* missing: create */ }
    if (!st) plan.create.push(d);
    else if (!st.isFile()) plan.conflicts.push({ path: d.path, reason: `a ${st.isDirectory() ? 'folder' : 'link'} stands where the kit puts a file` });
    else if (sameBytes(d.path, d.content)) plan.unchanged++;
    else plan.modify.push(d);
  }
  // Each kit skill folder is replaced whole: files the repo copy lacks go.
  const wanted = new Set(desired.map((d) => pathKey(d.path)));
  for (const dir of kitSkillDirs(roots)) {
    let st = null;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const rel of listFiles(dir)) {
      const p = path.join(dir, ...rel.split('/'));
      if (!wanted.has(pathKey(p))) plan.remove.push({ path: p, kind: 'file', files: [], group: 'skills', reason: `not in the repo copy of ${path.basename(dir)}; kit skill folders are replaced whole` });
    }
  }
  const legacy = legacyRemovals(roots, { retireLegacyAgents });
  plan.remove.push(...legacy.remove);
  plan.listed.push(...legacy.listed);
  // Other files in the deployed templates folder stay; an outdated one is check-kit's to report.
  const t = targetMap(roots);
  try {
    const own = new Set(listFiles(path.join(repo, 'templates')));
    for (const rel of listFiles(t.workflowTemplates)) {
      if (!own.has(rel)) plan.listed.push({ path: path.join(t.workflowTemplates, ...rel.split('/')), reason: 'not a kit template: kept (check-kit warns when it is outdated)' });
    }
  } catch { /* no deployed templates yet */ }
  return plan;
}

/**
 * Plan sanity: every path lies under one of the roots and none is a never-touch path. A failure here is a
 * bug in the target list, so it throws instead of printing a plan that would write outside the roots.
 */
function assertInsideRoots(plan) {
  const roots = [plan.roots.home, plan.roots.runtime, plan.roots.projectsRoot];
  const banned = neverTouch(plan.roots);
  for (const e of [...plan.create, ...plan.modify, ...plan.remove]) {
    if (!roots.some((r) => within(e.path, r))) throw new Error(`plan entry outside the roots: ${e.path}`);
    if (banned.some((b) => within(e.path, b))) throw new Error(`plan entry on a never-touch path: ${e.path}`);
  }
}

/** The path as shown: ~/... under home, <runtime>/... and <projects>/... under those roots, else absolute. */
function shown(p, roots) {
  const rel = (root, label) => {
    const r = path.relative(root, p);
    return r === '' ? label : `${label}/${r.split(path.sep).join('/')}`;
  };
  if (within(p, roots.home)) return rel(roots.home, '~');
  if (within(p, roots.runtime)) return rel(roots.runtime, '<runtime>');
  if (within(p, roots.projectsRoot)) return rel(roots.projectsRoot, '<projects>');
  return slash(p);
}

/** JSON form of the plan: absolute paths with /, no file content. */
export function planJson(plan) {
  const roots = { home: slash(plan.roots.home), runtime: slash(plan.roots.runtime), projects_root: slash(plan.roots.projectsRoot) };
  const file = (e) => ({ path: slash(e.path), group: e.group, mode: e.mode, reason: e.reason, ...(e.source ? { source: slash(e.source) } : {}) });
  return {
    tool: 'deploy-kit', mode: 'dry-run', roots, options: plan.options,
    create: plan.create.map(file), modify: plan.modify.map(file),
    remove: plan.remove.map((e) => ({ path: slash(e.path), kind: e.kind, files: e.files, group: e.group, reason: e.reason })),
    listed: plan.listed.map((e) => ({ path: slash(e.path), reason: e.reason })),
    conflicts: plan.conflicts.map((e) => ({ path: slash(e.path), reason: e.reason })),
    unchanged: plan.unchanged,
    not_touched: neverTouch(plan.roots).map(slash),
  };
}

function printPlan(plan, localConfig) {
  const s = (p) => shown(p, plan.roots);
  console.log('deploy-kit: dry-run, nothing is written');
  console.log(`  home ${slash(plan.roots.home)}; runtime ${slash(plan.roots.runtime)}; projects root ${slash(plan.roots.projectsRoot)}`);
  console.log(`  local config ${slash(localConfig)}; claude contract ${plan.options.claude_contract}; retire legacy agents ${plan.options.retire_legacy_agents ? 'yes' : 'no'}`);
  const group = (title, list, sign, line) => {
    console.log(`${title} (${list.length}):`);
    for (const e of list) console.log(`  ${sign} ${line(e)}`);
  };
  group('create', plan.create, '+', (e) => `${s(e.path)}  [${e.group}] ${e.reason}`);
  group('modify', plan.modify, '~', (e) => `${s(e.path)}  [${e.group}${e.mode === 'merge' ? ', merge' : ''}] ${e.reason}`);
  group('remove', plan.remove, '-', (e) => `${s(e.path)}${e.kind === 'dir' ? `/ (${e.files.length} file(s))` : e.kind === 'link' ? ' (link only, the target stays)' : ''}  [${e.group}] ${e.reason}`);
  group('listed, not changed', plan.listed, '=', (e) => `${s(e.path)}  ${e.reason}`);
  if (plan.conflicts.length) group('conflicts', plan.conflicts, '!', (e) => `${s(e.path)}  ${e.reason}`);
  if (!plan.options.retire_legacy_agents) console.log('  (the 3 old agents in ~/.claude/agents stay; --retire-legacy-agents archives and removes them)');
  console.log(`  never touched: ${neverTouch(plan.roots).map(s).join(', ')}; ~/.workflow-core scripts/, docs/, backups/`);
  console.log(`deploy-kit: ${plan.create.length} to create, ${plan.modify.length} to modify, ${plan.remove.length} to remove, `
    + `${plan.unchanged} unchanged, ${plan.listed.length} listed${plan.conflicts.length ? `, ${plan.conflicts.length} conflict(s)` : ''}`);
}

// ---------- init-local ----------

const PLACEHOLDER = /^(?:无|none|n\/a|-|<.*>)$/i;

/**
 * Read-only folders registered in the project rules (CLAUDE.md, AGENTS.md, .claude/CLAUDE.md) of each
 * project folder directly under projectsRoot. Reads only.
 * @param {string} projectsRoot
 * @returns {{dir: string, source: string, line: number}[]} existing folders, first registration of each
 */
export function findReadonlyDirs(projectsRoot) {
  const found = new Map();
  const add = (projectDir, raw, source, line) => {
    const v = raw.trim().replace(/^`|`$/g, '').trim();
    if (!v || PLACEHOLDER.test(v)) return;
    const dir = path.resolve(projectDir, v);
    let st;
    try { st = fs.statSync(dir); } catch { return; }
    if (st.isDirectory() && !found.has(pathKey(dir))) found.set(pathKey(dir), { dir, source, line });
  };
  let projects;
  try { projects = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return []; }
  for (const p of projects.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!p.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, p.name);
    for (const rel of ['AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
      const file = path.join(projectDir, rel);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      text.split(/\r?\n/).forEach((l, i) => {
        // The contract form of templates/repo-AGENTS.md: "- 只读目录：a、b".
        const m = /^\s*[-*]\s*只读目录\s*[：:]\s*(.+)$/.exec(l);
        if (m) { for (const part of m[1].split(/[、,，;；]/)) add(projectDir, part, file, i + 1); return; }
        // A table row: | `relative/path/` | ... | read-only |
        const cells = l.trim().startsWith('|') ? l.trim().replace(/^\||\|$/g, '').split('|') : null;
        if (!cells || cells.length < 2) return;
        const first = /^\s*`([^`]+\/)`\s*$/.exec(cells[0]);
        if (first && cells.slice(1).some((c) => /read-?only|只读/i.test(c))) add(projectDir, first[1], file, i + 1);
      });
    }
  }
  return [...found.values()];
}

/** Newest node-v<x.y.z>-*\/ under runtime that holds a Node binary, or null. */
function findPortableNode(runtime) {
  let names;
  try { names = fs.readdirSync(runtime); } catch { return null; }
  const ver = (n) => (/^node-v(\d+)\.(\d+)\.(\d+)-/.exec(n) || []).slice(1).map(Number);
  const cands = names.filter((n) => ver(n).length === 3).sort((a, b) => {
    const x = ver(a), y = ver(b);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  for (const n of cands) {
    for (const bin of [['node.exe'], ['bin', 'node']]) {
      const p = path.join(runtime, n, ...bin);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function union(list, add) {
  const out = [...list];
  const keys = new Set(list.map(pathKey));
  for (const d of add) if (!keys.has(pathKey(d))) { keys.add(pathKey(d)); out.push(slash(d)); }
  return out;
}

/**
 * Create or update the local config and the two canary folders. Writes only the config file and the canaries.
 * @param {{localConfig: string, runtime?: string, projectsRoot?: string}} opts
 * @returns {{config: object, written: boolean, created: string[], readonly: object[], notes: string[]}}
 */
export function initLocal({ localConfig, runtime, projectsRoot }) {
  const privateDir = path.dirname(localConfig);
  const notes = [];
  let old = {};
  if (fs.existsSync(localConfig)) old = readLocalConfig(localConfig);
  const roots = {
    runtime: runtime ? path.resolve(runtime) : old.runtime ? path.resolve(old.runtime) : path.join(privateDir, 'rt'),
    projectsRoot: projectsRoot ? path.resolve(projectsRoot) : old.projects_root ? path.resolve(old.projects_root) : path.dirname(KIT_REPO),
  };
  if (!fs.existsSync(roots.projectsRoot)) throw new UsageError(`projects root is not a folder: ${roots.projectsRoot}`);

  const created = [];
  const canary = {};
  for (const [kind, c] of Object.entries(CANARIES)) {
    const dir = path.join(privateDir, ...c.rel);
    const note = path.join(dir, CANARY_NOTE);
    if (!fs.existsSync(note)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(note, c.note);
      created.push(note);
    }
    canary[kind] = dir;
  }

  const readonly = findReadonlyDirs(roots.projectsRoot);
  const portable = (runtime || !old.portable_node) ? findPortableNode(roots.runtime) : path.resolve(old.portable_node);
  if (!portable) notes.push(`no node-v*/ Node found under ${slash(roots.runtime)}; portable_node is null`);
  const restore = old.restore_tool ? path.resolve(old.restore_tool) : path.join(privateDir, 'redesign-2026-10', 'step0', 'restore.mjs');
  if (!fs.existsSync(restore)) notes.push(`restore tool not found at ${slash(restore)}`);

  const fresh = {
    readonly_dirs: union(old.readonly_dirs || [], [...readonly.map((r) => r.dir), canary.readonly]),
    customer_data_dirs: union(old.customer_data_dirs || [], [canary.customer]),
    runtime: slash(roots.runtime),
    portable_node: portable ? slash(portable) : null,
    projects_root: slash(roots.projectsRoot),
    restore_tool: slash(restore),
  };
  // Known keys in the documented order, then everything else (deploy_options, owner additions) as it was.
  const config = { ...fresh };
  for (const [k, v] of Object.entries(old)) if (!LOCAL_KEYS.includes(k)) config[k] = v;
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const current = fs.existsSync(localConfig) ? fs.readFileSync(localConfig, 'utf8') : null;
  const written = current !== text;
  if (written) {
    fs.mkdirSync(privateDir, { recursive: true });
    const tmp = `${localConfig}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, localConfig);
  }
  return { config, written, created, readonly, notes };
}

// ---------- main ----------

function parseCli(argv) {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, 'init-local': { type: 'boolean' },
        'claude-contract': { type: 'string' }, 'retire-legacy-agents': { type: 'boolean' },
        home: { type: 'string' }, runtime: { type: 'string' }, 'projects-root': { type: 'string' }, 'local-config': { type: 'string' },
        apply: { type: 'boolean' }, rollback: { type: 'string' }, drill: { type: 'string' }, neutral: { type: 'boolean' },
        stage: { type: 'string' }, 'expect-clean': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (a.help) return { help: true };
  for (const [flag, task] of Object.entries(LATER)) {
    if (a[flag] !== undefined) throw new UsageError(`--${flag} is not implemented yet (${task}); this version only plans`);
  }
  if (a['init-local'] && (a['dry-run'] || a.json || a.home !== undefined || a['claude-contract'] !== undefined || a['retire-legacy-agents'])) {
    throw new UsageError('--init-local takes only --runtime, --projects-root and --local-config');
  }
  const contract = a['claude-contract'] ?? DEFAULT_OPTIONS.claude_contract;
  if (!CLAUDE_CONTRACT_MODES.includes(contract)) throw new UsageError(`--claude-contract must be import or inline: ${contract}`);
  for (const k of ['home', 'runtime', 'projects-root', 'local-config']) {
    if (a[k] !== undefined && !a[k].trim()) throw new UsageError(`--${k} needs a path`);
  }
  return {
    mode: a['init-local'] ? 'init-local' : 'dry-run', json: !!a.json, claudeContract: contract,
    retireLegacyAgents: !!a['retire-legacy-agents'], home: a.home, runtime: a.runtime, projectsRoot: a['projects-root'],
    localConfig: path.resolve(a['local-config'] ?? DEFAULT_LOCAL_CONFIG),
  };
}

function run(argv) {
  const opts = parseCli(argv);
  if (opts.help) { console.log(USAGE); return 0; }

  if (opts.mode === 'init-local') {
    const r = initLocal(opts);
    for (const f of r.created) console.log(`deploy-kit: created ${slash(f)}`);
    for (const ro of r.readonly) console.log(`deploy-kit: read-only dir ${slash(ro.dir)} (registered in ${slash(ro.source)}:${ro.line})`);
    for (const n of r.notes) console.error(`deploy-kit: note: ${n}`);
    console.log(`deploy-kit: local config ${slash(opts.localConfig)} ${r.written ? 'written' : 'already current'}; `
      + `${r.config.readonly_dirs.length} read-only dir(s), ${r.config.customer_data_dirs.length} customer-data dir(s)`);
    console.log('deploy-kit: add real customer-data folders to customer_data_dirs by hand; this file is git-excluded');
    return 0;
  }

  const local = readLocalConfig(opts.localConfig);
  const roots = resolveRoots({ home: opts.home, runtime: opts.runtime, projectsRoot: opts.projectsRoot }, local);
  if (!fs.existsSync(roots.home) || !fs.statSync(roots.home).isDirectory()) throw new UsageError(`home is not a folder: ${roots.home}`);
  const plan = buildPlan(roots, { claudeContract: opts.claudeContract, retireLegacyAgents: opts.retireLegacyAgents });
  assertInsideRoots(plan);
  if (opts.json) console.log(JSON.stringify(planJson(plan), null, 2));
  else printPlan(plan, opts.localConfig);
  return plan.conflicts.length ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  return WIN ? a.toLowerCase() === SELF.toLowerCase() : a === SELF;
})();
if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof UsageError ? `deploy-kit: ${e.message}\n${USAGE}` : `deploy-kit: error: ${e.stack || e}`);
    process.exitCode = 2;
  }
}
