#!/usr/bin/env node
// deploy-kit: plan the deployment of the AutoSkills kit to the user level (ADR-006 §2.7). Zero
// dependencies (Node >= 18). This version plans the user-level deploy: it prints what a deploy would
// create, modify and remove, with a reason per item, and writes nothing there. Writing, backup and rollback
// come with --apply and --rollback (AS3-113). The only writing modes are --init-local (the local config)
// and --stage (a project-layout copy inside _private/ for the measurement scripts).
//
// Usage:
//   node scripts/deploy-kit.mjs [--dry-run] [--json] [--claude-contract import|inline] [--retire-legacy-agents]
//                               [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
//   node scripts/deploy-kit.mjs --dry-run --expect-clean [--json] [--home <dir>] [--runtime <dir>]
//                               [--projects-root <dir>] [--local-config <file>]
//   node scripts/deploy-kit.mjs --stage <dir> --layout project [--force]
//   node scripts/deploy-kit.mjs --init-local [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
//
// Roots: every target is resolved from three roots (scripts/lib/kit-targets.mjs): --home (default the user
// directory), --runtime (default runtime in the local config) and --projects-root (default projects_root in
// the local config). Tests pass all three, so they never read targets in the real user directory.
//
// Dry-run (the default): reads the contract, the 7 skills, the templates, the agent definition, the config
// fragments and the hooks in this repo, the local config and the current targets; prints the plan in three
// groups (create, modify, remove) plus what is only listed. A missing local config is an error that names
// --init-local. The targets are those of scripts/lib/kit-targets.mjs: contract, CLAUDE.md, the 7 skills on
// both platforms, project-verifier, templates, workflow-rules.md, settings.json, config.toml, the Codex
// hooks.json and rules, the hook scripts and their config in <runtime>/hooks/, and pushurl = no_push for
// every repository with remotes under the projects root (planned by scripts/set-pushurl.mjs; read-only
// folders and measurement repos are skipped). Merged files (settings.json, config.toml, an existing
// hooks.json, workflow-rules.md) keep everything that is not the kit's; a merged file that cannot be read
// is a conflict. The project-manager registration is not touched (batch 1 keeps 1.5.1 on the system Node).
//   --claude-contract import (default) writes ~/.claude/CLAUDE.md as @AGENTS.md plus the Claude-only lines;
//   inline puts the contract text there instead, for when the import does not load.
//   --retire-legacy-agents adds the 3 old agents (v2 decision 9) to the removals; without it they stay.
//   Removals are limited to the old project-* copies; a folder whose name starts with "{" (a failed brace
//   expansion) is listed, not removed.
//   --expect-clean checks a deploy: exit 0 only when the plan is empty. It plans with the options the last
//   --apply recorded in the local config (deploy_options: claude_contract, retire_legacy_agents; written by
//   AS3-113), or the defaults when none are recorded, so it takes no option flags of its own.
//
// --stage <dir> --layout project writes the same kit content in the project layout into <dir>, which must
// lie inside <kit repo>/_private/: .claude/AGENTS.md, .claude/CLAUDE.md (first line @AGENTS.md),
// .claude/skills/<7>, .agents/skills/<7> and contract/AGENTS.md (the contract text the measurement scripts
// build AGENTS.override.md from), plus stage-manifest.json (files and SHA-256). A non-empty <dir> is replaced
// only with --force and only when it holds an earlier stage (its stage-manifest.json). It needs no local
// config and reads no user-level file.
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
// Exit codes: 0 = plan printed (with --expect-clean: the plan is empty; or local config written / already
// current; or stage written). 1 = the plan has conflicts (a folder where a file must go, a merged file that
// cannot be read), or with --expect-clean the plan is not empty. 2 = usage or setup error (unknown option,
// missing local config or portable_node, a kit source missing in the repo, a stage target outside _private/
// or not replaceable, a mode that is not implemented yet).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  KIT_REPO, DEFAULT_LOCAL_CONFIG, DEFAULT_OPTIONS, CLAUDE_CONTRACT_MODES, UsageError,
  targetMap, neverTouch, readLocalConfig, resolveRoots, recordedOptions, desiredFiles, stageFiles, kitSkillDirs, legacyRemovals,
  listFiles, slash, pathKey, within, realPathOf,
} from './lib/kit-targets.mjs';
import { planRepos, NO_PUSH } from './set-pushurl.mjs';

const USAGE = 'usage: node scripts/deploy-kit.mjs [--dry-run] [--json] [--claude-contract import|inline] [--retire-legacy-agents]\n'
  + '                                   [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --dry-run --expect-clean [--json] [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --stage <dir> --layout project [--force]\n'
  + '       node scripts/deploy-kit.mjs --init-local [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]';

const SELF = fileURLToPath(import.meta.url);
const WIN = process.platform === 'win32';
// Modes of later tasks: named here so the message says where they come from, not "unknown option".
const LATER = { apply: 'AS3-113', rollback: 'AS3-113', drill: 'AS3-113', neutral: 'AS3-114' };
const STAGE_LAYOUTS = ['project'];
export const STAGE_MANIFEST = 'stage-manifest.json';
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
 * The deploy plan for every kit target. Reads only (git runs read-only queries for the pushurl plan).
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @param {{claudeContract?: string, retireLegacyAgents?: boolean, repo?: string, local: object}} opts local: the
 *   parsed local config (read-only and customer-data folders, portable_node)
 * @returns {{roots: object, options: object, create: object[], modify: object[], remove: object[], pushurl: object[],
 *   listed: object[], conflicts: object[], unchanged: number, pushurlPlan: object}} create/modify entries carry
 *   path, group, mode, reason, content (Buffer) and source (repo file) when the content comes from one;
 *   pushurl entries carry repo, config, remote and original; pushurlPlan is the set-pushurl plan behind them
 */
export function buildPlan(roots, { claudeContract = DEFAULT_OPTIONS.claude_contract, retireLegacyAgents = DEFAULT_OPTIONS.retire_legacy_agents, repo = KIT_REPO, local } = {}) {
  if (!local) throw new UsageError('buildPlan needs the local config');
  const plan = {
    roots, options: { claude_contract: claudeContract, retire_legacy_agents: retireLegacyAgents },
    create: [], modify: [], remove: [], pushurl: [], listed: [], conflicts: [], unchanged: 0, pushurlPlan: null,
  };
  const desired = desiredFiles(roots, { claudeContract, repo, local });
  for (const d of desired) {
    if (d.conflict) { plan.conflicts.push({ path: d.path, reason: d.conflict }); continue; }
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

  // pushurl = no_push for every repository with remotes under the projects root (set-pushurl's own scan
  // and skip rules; --apply hands pushurlPlan to its applyPlan).
  const pp = planRepos(roots.projectsRoot, { readonlyDirs: local.readonly_dirs ?? [] });
  plan.pushurlPlan = pp;
  for (const r of pp.repos) {
    for (const m of r.remotes) {
      if (m.action === 'set') {
        plan.pushurl.push({
          repo: r.path, config: r.config, remote: m.name, original: m.original,
          reason: `remote ${m.name}: pushurl ${m.original === null ? 'unset' : m.original.join(', ')} -> ${NO_PUSH} (set-pushurl; agents cannot push by remote name)`,
        });
      }
      if (m.outside.length) plan.listed.push({ path: r.path, reason: `remote ${m.name}: pushurl ${m.outside.join(', ')} comes from a config outside the repo and is not changed` });
    }
  }
  for (const s of pp.skipped) if (/^read-only dir/.test(s.reason)) plan.listed.push({ path: s.path, reason: `pushurl not set: ${s.reason}` });
  return plan;
}

/** True when a deploy would change nothing: no creation, modification, removal, pushurl change or conflict. */
export function planIsEmpty(plan) {
  return !plan.create.length && !plan.modify.length && !plan.remove.length && !plan.pushurl.length && !plan.conflicts.length;
}

/**
 * Plan sanity: every path lies under one of the roots and none is a never-touch path. A failure here is a
 * bug in the target list, so it throws instead of printing a plan that would write outside the roots.
 */
function assertInsideRoots(plan) {
  const roots = [plan.roots.home, plan.roots.runtime, plan.roots.projectsRoot];
  const banned = neverTouch(plan.roots);
  for (const e of [...plan.create, ...plan.modify, ...plan.remove, ...plan.pushurl.map((p) => ({ path: p.repo }))]) {
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

/** The config file of a pushurl entry as shown: <repo>/.git/config when it is that repo's own (git reports
 *  the common dir as a real path, which may differ in spelling from the scanned repo path). */
function pushurlShown(e, s) {
  const gitDir = path.dirname(e.config);
  const own = path.basename(gitDir) === '.git' && pathKey(realPathOf(path.dirname(gitDir))) === pathKey(realPathOf(e.repo));
  return own ? `${s(e.repo)}/.git/config` : s(e.config);
}

/** JSON form of the plan: absolute paths with /, no file content. expectClean adds expect_clean and clean. */
export function planJson(plan, { expectClean = false } = {}) {
  const roots = { home: slash(plan.roots.home), runtime: slash(plan.roots.runtime), projects_root: slash(plan.roots.projectsRoot) };
  const file = (e) => ({ path: slash(e.path), group: e.group, mode: e.mode, reason: e.reason, ...(e.source ? { source: slash(e.source) } : {}) });
  return {
    tool: 'deploy-kit', mode: 'dry-run', roots, options: plan.options,
    ...(expectClean ? { expect_clean: true, clean: planIsEmpty(plan) } : {}),
    create: plan.create.map(file), modify: plan.modify.map(file),
    remove: plan.remove.map((e) => ({ path: slash(e.path), kind: e.kind, files: e.files, group: e.group, reason: e.reason })),
    pushurl: plan.pushurl.map((e) => ({ repo: slash(e.repo), config: slash(e.config), remote: e.remote, original: e.original, value: NO_PUSH, reason: e.reason })),
    listed: plan.listed.map((e) => ({ path: slash(e.path), reason: e.reason })),
    conflicts: plan.conflicts.map((e) => ({ path: slash(e.path), reason: e.reason })),
    unchanged: plan.unchanged,
    not_touched: neverTouch(plan.roots).map(slash),
  };
}

function printPlan(plan, localConfig, { expectClean = false } = {}) {
  const s = (p) => shown(p, plan.roots);
  console.log(`deploy-kit: dry-run${expectClean ? ' --expect-clean' : ''}, nothing is written`);
  console.log(`  home ${slash(plan.roots.home)}; runtime ${slash(plan.roots.runtime)}; projects root ${slash(plan.roots.projectsRoot)}`);
  console.log(`  local config ${slash(localConfig)}; claude contract ${plan.options.claude_contract}; retire legacy agents ${plan.options.retire_legacy_agents ? 'yes' : 'no'}`
    + `${expectClean ? ' (options recorded by the last --apply, or the defaults)' : ''}`);
  const group = (title, list, sign, line) => {
    console.log(`${title} (${list.length}):`);
    for (const e of list) console.log(`  ${sign} ${line(e)}`);
  };
  group('create', plan.create, '+', (e) => `${s(e.path)}  [${e.group}] ${e.reason}`);
  const modify = [
    ...plan.modify.map((e) => `${s(e.path)}  [${e.group}${e.mode === 'merge' ? ', merge' : ''}] ${e.reason}`),
    ...plan.pushurl.map((e) => `${pushurlShown(e, s)}  [pushurl] ${e.reason}`),
  ];
  group('modify', modify, '~', (line) => line);
  group('remove', plan.remove, '-', (e) => `${s(e.path)}${e.kind === 'dir' ? `/ (${e.files.length} file(s))` : e.kind === 'link' ? ' (link only, the target stays)' : ''}  [${e.group}] ${e.reason}`);
  group('listed, not changed', plan.listed, '=', (e) => `${s(e.path)}  ${e.reason}`);
  if (plan.conflicts.length) group('conflicts', plan.conflicts, '!', (e) => `${s(e.path)}  ${e.reason}`);
  if (!plan.options.retire_legacy_agents) console.log('  (the 3 old agents in ~/.claude/agents stay; --retire-legacy-agents archives and removes them)');
  console.log(`  never touched: ${neverTouch(plan.roots).map(s).join(', ')}; ~/.workflow-core scripts/, docs/, backups/; the project-manager registration`);
  console.log(`deploy-kit: ${plan.create.length} to create, ${plan.modify.length + plan.pushurl.length} to modify (${plan.pushurl.length} pushurl), `
    + `${plan.remove.length} to remove, ${plan.unchanged} unchanged, ${plan.listed.length} listed${plan.conflicts.length ? `, ${plan.conflicts.length} conflict(s)` : ''}`);
  if (expectClean) {
    console.log(planIsEmpty(plan) ? 'deploy-kit: expect-clean: the plan is empty; the deploy is in place'
      : 'deploy-kit: expect-clean: the plan is not empty; the deployed state differs from the kit');
  }
}

// ---------- stage ----------

/**
 * Write the kit in the project layout into dest, a folder inside <repo>/_private/ (the measurement scripts
 * copy it into a test repo). The files are written to a sibling temp folder first and moved in at the end.
 * @param {string} dest
 * @param {{layout?: string, force?: boolean, repo?: string}} [opts]
 * @returns {{dest: string, files: {rel: string, sha256: string}[], replaced: boolean}}
 * @throws {UsageError} dest is not inside _private/, is a file or a link, or is a non-empty folder without
 *   --force or without the manifest of an earlier stage
 */
export function stageProject(dest, { layout = 'project', force = false, repo = KIT_REPO } = {}) {
  if (!STAGE_LAYOUTS.includes(layout)) throw new UsageError(`--layout must be one of ${STAGE_LAYOUTS.join(', ')}: ${layout}`);
  const priv = realPathOf(path.join(repo, '_private'));
  const abs = path.resolve(dest);
  const real = realPathOf(abs);
  if (!within(real, priv) || pathKey(real) === pathKey(priv)) {
    throw new UsageError(`--stage writes only to a folder inside ${slash(priv)}; refused: ${slash(abs)}`);
  }
  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* new folder */ }
  let replaced = false;
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UsageError(`--stage target is not a folder: ${slash(abs)}`);
    if (fs.readdirSync(abs).length) {
      if (!force) throw new UsageError(`--stage target is not empty: ${slash(abs)}; --force replaces an earlier stage`);
      if (!fs.existsSync(path.join(abs, STAGE_MANIFEST))) {
        throw new UsageError(`--stage target holds files that --stage did not write (no ${STAGE_MANIFEST}): ${slash(abs)}; --force replaces only an earlier stage`);
      }
      replaced = true;
    }
  }
  const files = stageFiles(repo);
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const f of files) {
      const p = path.join(tmp, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    const manifest = {
      tool: 'deploy-kit', layout, created: new Date().toISOString(), kit_repo: slash(repo),
      files: files.map((f) => ({ path: f.rel, sha256: crypto.createHash('sha256').update(f.content).digest('hex') })),
    };
    fs.writeFileSync(path.join(tmp, STAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    if (st) fs.rmSync(abs, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(tmp, abs);
    return { dest: abs, files: manifest.files, replaced };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
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
        stage: { type: 'string' }, layout: { type: 'string' }, force: { type: 'boolean' }, 'expect-clean': { type: 'boolean' },
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
  const given = (...flags) => flags.filter((f) => a[f] !== undefined).map((f) => `--${f}`);
  if (a['init-local'] && (a['dry-run'] || a.json || a.home !== undefined || a['claude-contract'] !== undefined || a['retire-legacy-agents'])) {
    throw new UsageError('--init-local takes only --runtime, --projects-root and --local-config');
  }
  if (a.stage !== undefined) {
    const extra = given('init-local', 'dry-run', 'json', 'expect-clean', 'claude-contract', 'retire-legacy-agents', 'home', 'runtime', 'projects-root', 'local-config');
    if (extra.length) throw new UsageError(`--stage takes only --layout and --force (not ${extra.join(', ')})`);
    if (!a.stage.trim()) throw new UsageError('--stage needs a folder');
    if (a.layout === undefined) throw new UsageError('--stage needs --layout project');
    if (!STAGE_LAYOUTS.includes(a.layout)) throw new UsageError(`--layout must be one of ${STAGE_LAYOUTS.join(', ')}: ${a.layout}`);
    return { mode: 'stage', stage: a.stage, layout: a.layout, force: !!a.force };
  }
  if (a.layout !== undefined || a.force !== undefined) throw new UsageError('--layout and --force go with --stage');
  if (a['expect-clean']) {
    // The options come from deploy_options in the local config, so the deployed state is checked as deployed.
    const extra = given('init-local', 'claude-contract', 'retire-legacy-agents');
    if (extra.length) throw new UsageError(`--expect-clean plans with the options recorded in the local config; drop ${extra.join(', ')}`);
  }
  const contract = a['claude-contract'] ?? DEFAULT_OPTIONS.claude_contract;
  if (!CLAUDE_CONTRACT_MODES.includes(contract)) throw new UsageError(`--claude-contract must be import or inline: ${contract}`);
  for (const k of ['home', 'runtime', 'projects-root', 'local-config']) {
    if (a[k] !== undefined && !a[k].trim()) throw new UsageError(`--${k} needs a path`);
  }
  return {
    mode: a['init-local'] ? 'init-local' : 'dry-run', json: !!a.json, claudeContract: contract, expectClean: !!a['expect-clean'],
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

  if (opts.mode === 'stage') {
    const r = stageProject(opts.stage, { layout: opts.layout, force: opts.force });
    console.log(`deploy-kit: staged ${r.files.length} file(s) in the ${opts.layout} layout to ${slash(r.dest)}${r.replaced ? ' (earlier stage replaced)' : ''}`);
    console.log('  .claude/AGENTS.md, .claude/CLAUDE.md (@AGENTS.md), .claude/skills/, .agents/skills/, contract/AGENTS.md; '
      + `file list and SHA-256 in ${STAGE_MANIFEST}`);
    return 0;
  }

  const local = readLocalConfig(opts.localConfig);
  const roots = resolveRoots({ home: opts.home, runtime: opts.runtime, projectsRoot: opts.projectsRoot }, local);
  if (!fs.existsSync(roots.home) || !fs.statSync(roots.home).isDirectory()) throw new UsageError(`home is not a folder: ${roots.home}`);
  const options = opts.expectClean
    ? (({ claude_contract: c, retire_legacy_agents: r }) => ({ claudeContract: c, retireLegacyAgents: r }))(recordedOptions(local))
    : { claudeContract: opts.claudeContract, retireLegacyAgents: opts.retireLegacyAgents };
  const plan = buildPlan(roots, { ...options, local });
  assertInsideRoots(plan);
  if (opts.json) console.log(JSON.stringify(planJson(plan, { expectClean: opts.expectClean }), null, 2));
  else printPlan(plan, opts.localConfig, { expectClean: opts.expectClean });
  if (opts.expectClean) return planIsEmpty(plan) ? 0 : 1;
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
