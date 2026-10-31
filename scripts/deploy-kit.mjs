#!/usr/bin/env node
// deploy-kit: deploy the AutoSkills kit to the user level (ADR-006 §2.7). Zero dependencies (Node >= 18).
// The default is a dry-run that prints what a deploy would create, modify and remove, with a reason per item,
// and writes nothing. --apply writes after a backup and keeps a journal; --rollback <deploy id> undoes one
// deploy; --drill rehearses apply and rollback on a copy; --neutral parks the kit's user-level skills and contract
// for a measurement and is rolled back like a deploy. The other writing modes are --init-local (the local config)
// and --stage (a project-layout copy inside _private/ for the measurement scripts).
//
// Usage:
//   node scripts/deploy-kit.mjs [--dry-run] [--json] [--claude-contract import|inline] [--retire-legacy-agents]
//                               [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
//   node scripts/deploy-kit.mjs --dry-run --expect-clean [--json] [--home <dir>] [--runtime <dir>]
//                               [--projects-root <dir>] [--local-config <file>]
//   node scripts/deploy-kit.mjs --apply [--claude-contract import|inline] [--retire-legacy-agents] [--allow-running]
//                               [--ignore-pids <file>] [--home <dir>] [--runtime <dir>] [--projects-root <dir>]
//                               [--local-config <file>]
//   node scripts/deploy-kit.mjs --neutral [--dry-run] [--json] [--home <dir>] [--runtime <dir>] [--projects-root <dir>]
//                               [--local-config <file>]
//   node scripts/deploy-kit.mjs --neutral --apply [--allow-running] [--ignore-pids <file>] [--home <dir>]
//                               [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
//   node scripts/deploy-kit.mjs --rollback <deploy or neutral id> [--whole-file] [--allow-running] [--ignore-pids <file>]
//                               [--local-config <file>]
//   node scripts/deploy-kit.mjs --drill <dir> [--claude-contract import|inline] [--retire-legacy-agents]
//                               [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]
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
//   --apply recorded in the local config (deploy_options: claude_contract, retire_legacy_agents), or the
//   defaults when none are recorded, so it takes no option flags of its own.
//
// --apply carries out the plan. Deploy records live in <local config folder>/deploy/<deploy id>/ (by default
// <kit repo>/_private/deploy/, git-excluded):
//   1. Running agents: on the real user directory it lists processes (structured output of Get-CimInstance on
//      Windows, ps elsewhere; no localized text is parsed) and refuses while a claude or codex process runs,
//      unless --allow-running. The check applies only to --apply, --neutral --apply and --rollback on the real
//      user directory; dry-run, --drill, --stage and a redirected --home never check. --ignore-pids <file> lets
//      through the processes listed in a JSON list of {"pid": <number>, "created": "<creation time>"}: a
//      process passes only when both its PID and its creation time (as listProcesses reports it, UTC ISO 8601)
//      match an entry; every other claude or codex process still refuses. The measurement driver lists the
//      processes it started this way when it rolls back the neutral (AS3-120b). --apply is also refused while
//      a neutral is in place: roll the neutral back first.
//   2. Backup: every file the plan modifies or removes is copied to backup/ in the step-0 format
//      (files/<drive>/<path> plus manifest.json with home, sources, links and files[].label/src/rel/size/
//      sha256). Merged targets (settings.json, config.toml, workflow-rules.md) are labelled kit-merge, all
//      others kit-whole. Each copy is hash-checked; a failed backup stops the apply before any write.
//      ~/.claude.json and the other never-touch paths are never backed up or written.
//   3. Writes, each recorded in journal.json before it happens: created paths and the folders made for them,
//      modified paths with their hashes before and after, removed paths, for merged files the keys and
//      sections the kit added with the values they replaced (applied/ keeps the merged copies for diffs),
//      the pushurl originals (pushurl.json, the set-pushurl log) and the deploy options, which also go to
//      deploy_options in the local config. A failure on the way rolls everything back at once, merged files
//      included (from the backup), so the targets end as they were before the apply.
//   4. It prints the deploy id and the rollback command, and when ~/.codex/hooks.json was created or changed,
//      the next step: trust the hook again in Codex /hooks (codexTrustNote; the dry-run says it too).
// --rollback <deploy id> undoes one deploy in two classes:
//   - whole targets (skills, contract, agent definitions, hooks.json, rules, runtime files): the step-0
//     restore tool (restore_tool in the local config) runs as restore.mjs --backup <dir> --only kit-whole
//     --apply; it does not delete files, so the journal's created files and folders are removed here, removed
//     links are made again, removed folders get their subfolders back (empty ones included; the backup holds
//     files only) and the pushurl originals restored.
//   - merged targets (settings.json, config.toml, workflow-rules.md) are reversed from the journal: only the
//     kit's keys, list entries and sections go and the target keys get their earlier values back; everything
//     written since (a Codex trust section, a /config change) stays. A file that changed since the apply gets
//     a diff printed. --whole-file restores them from the backup instead (kit-merge).
//   Every target is checked at the end: whole targets against the backup hashes, merged ones for "kit keys
//   gone, target keys restored". A mismatch exits 1. After several deploys, roll back the latest first: an
//   earlier deploy id is refused while a later one is still in place.
// --neutral (v2 appendix D) parks the user level for a measurement, so the kit version under test is read
// only from the test repo's project level (Claude prefers a user-level skill over a project one of the same
// name; Codex lists both). The plan: remove the 7 kit skill folders from ~/.claude/skills and ~/.agents/skills
// and put the one line NEUTRAL_LINE (an HTML comment, no rule) in ~/.claude/CLAUDE.md, ~/.claude/AGENTS.md and
// ~/.codex/AGENTS.md (created when missing). settings.json, config.toml, hooks.json, the Codex rules, the
// runtime hooks, the agent definitions and the MCP registrations stay as deployed; the journal lists them
// under kept for the measurement manifest. Without --apply it is a dry-run. --neutral --apply goes through the
// same process check, backup and journal as --apply (journal kind "neutral", no deploy_options), prints the
// neutral id and the rollback command; --rollback <neutral id> restores the deployed state byte for byte. A
// deploy below the neutral cannot be rolled back before it (latest first), and --dry-run --expect-clean exits
// 1 while it is in place. check-kit recognises the neutral contract files by NEUTRAL_MARKER.
//
// --drill <dir> rehearses a deploy (v2 appendix C) inside <dir>/<timestamp>/, which must lie inside
// <kit repo>/_private/eval/ (not _private/rt, _private/deploy or elsewhere in _private/; anything else exits
// 2): a drill home with copies of the kit-related files of the source home (never ~/.claude.json), an empty
// runtime and a new git repository for pushurl. It applies, rolls back, compares the hash of every file with
// the state before and removes the timestamp folder. The source runtime, the
// .git/config of the repositories under the source projects root and the source home targets are hashed
// before and after; any change exits 1.
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
// Exit codes: 0 = plan printed (with --expect-clean: the plan is empty), local config written or already
// current, stage written, deployed, rolled back and verified, or drill passed. 1 = the plan has conflicts (a
// folder where a file must go, a merged file that cannot be read); with --expect-clean the plan is not empty;
// --apply or --neutral --apply refused (a claude or codex process runs, conflicts, a neutral in place) or failed
// and rolled back; --rollback left a target that does not match; the drill found a difference. 2 = usage or setup error (unknown option, missing
// local config, portable_node or restore tool, a kit source missing in the repo, a stage or drill folder
// outside _private/ or not replaceable, an unknown or already rolled back deploy id, an --ignore-pids file
// that is not a list of PID and creation time).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  KIT_REPO, DEFAULT_LOCAL_CONFIG, DEFAULT_OPTIONS, CLAUDE_CONTRACT_MODES, UsageError,
  targetMap, neverTouch, readLocalConfig, resolveRoots, recordedOptions, desiredFiles, stageFiles, kitSkillDirs, legacyRemovals,
  listFiles, slash, pathKey, within, realPathOf, jsonLike,
} from './lib/kit-targets.mjs';
import { keyValues, getValue, setValue, scanToml, removeValue, removeEmptyTable } from './lib/toml-edit.mjs';
import { planRepos, scanRepos, applyPlan, readLog, revertLog, NO_PUSH } from './set-pushurl.mjs';

const USAGE = 'usage: node scripts/deploy-kit.mjs [--dry-run] [--json] [--claude-contract import|inline] [--retire-legacy-agents]\n'
  + '                                   [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --dry-run --expect-clean [--json] [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --apply [--claude-contract import|inline] [--retire-legacy-agents] [--allow-running] [--ignore-pids <file>]\n'
  + '                                   [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --neutral [--dry-run] [--json] [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --neutral --apply [--allow-running] [--ignore-pids <file>]\n'
  + '                                   [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --rollback <deploy or neutral id> [--whole-file] [--allow-running] [--ignore-pids <file>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --drill <dir> [--claude-contract import|inline] [--retire-legacy-agents]\n'
  + '                                   [--home <dir>] [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]\n'
  + '       node scripts/deploy-kit.mjs --stage <dir> --layout project [--force]\n'
  + '       node scripts/deploy-kit.mjs --init-local [--runtime <dir>] [--projects-root <dir>] [--local-config <file>]';

const SELF = fileURLToPath(import.meta.url);
const WIN = process.platform === 'win32';
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

/** JSON form of the plan: absolute paths with /, no file content. expectClean adds expect_clean and clean;
 *  neutralInPlace (ids) is added when given; a neutral plan has mode neutral-dry-run and its kept list. */
export function planJson(plan, { expectClean = false, neutralInPlace } = {}) {
  const roots = { home: slash(plan.roots.home), runtime: slash(plan.roots.runtime), projects_root: slash(plan.roots.projectsRoot) };
  const file = (e) => ({ path: slash(e.path), group: e.group, mode: e.mode, reason: e.reason, ...(e.source ? { source: slash(e.source) } : {}) });
  return {
    tool: 'deploy-kit', mode: plan.kind === 'neutral' ? 'neutral-dry-run' : 'dry-run', roots, options: plan.options,
    ...(expectClean ? { expect_clean: true, clean: planIsEmpty(plan) } : {}),
    ...(neutralInPlace ? { neutral_in_place: neutralInPlace } : {}),
    ...(plan.kept ? { kept: plan.kept } : {}),
    create: plan.create.map(file), modify: plan.modify.map(file),
    remove: plan.remove.map((e) => ({ path: slash(e.path), kind: e.kind, files: e.files, group: e.group, reason: e.reason })),
    pushurl: plan.pushurl.map((e) => ({ repo: slash(e.repo), config: slash(e.config), remote: e.remote, original: e.original, value: NO_PUSH, reason: e.reason })),
    listed: plan.listed.map((e) => ({ path: slash(e.path), reason: e.reason })),
    conflicts: plan.conflicts.map((e) => ({ path: slash(e.path), reason: e.reason })),
    unchanged: plan.unchanged,
    not_touched: neverTouch(plan.roots).map(slash),
  };
}

/**
 * The re-trust note when a plan creates or changes ~/.codex/hooks.json, else null. Codex keeps the trust of
 * each hook handler in config.toml ([hooks.state.'<hooks.json>:<event>:<group>:<handler>'], C0 T-meta);
 * whether a changed hooks.json needs trusting again is inferred, not tested, so the owner checks /hooks.
 * @param {{create: object[], modify: object[], roots: object}} plan
 * @returns {string|null}
 */
export function codexTrustNote(plan) {
  const hooks = pathKey(targetMap(plan.roots).codexHooks);
  if (![...plan.create, ...plan.modify].some((e) => pathKey(e.path) === hooks)) return null;
  return `${slash(targetMap(plan.roots).codexHooks)} is created or changed: open Codex, then trust the AutoSkills hook again in /hooks `
    + '(check-kit lists the trust per handler; the guard does not run on Codex until it is trusted)';
}

function printPlan(plan, localConfig, { expectClean = false, neutralInPlace = [] } = {}) {
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
  const trust = codexTrustNote(plan);
  if (trust) console.log(`  after --apply: ${trust}`);
  if (!plan.options.retire_legacy_agents) console.log('  (the 3 old agents in ~/.claude/agents stay; --retire-legacy-agents archives and removes them)');
  console.log(`  never touched: ${neverTouch(plan.roots).map(s).join(', ')}; ~/.workflow-core scripts/, docs/, backups/; the project-manager registration`);
  console.log(`deploy-kit: ${plan.create.length} to create, ${plan.modify.length + plan.pushurl.length} to modify (${plan.pushurl.length} pushurl), `
    + `${plan.remove.length} to remove, ${plan.unchanged} unchanged, ${plan.listed.length} listed${plan.conflicts.length ? `, ${plan.conflicts.length} conflict(s)` : ''}`);
  if (neutralInPlace.length) {
    console.log(`deploy-kit: neutral ${neutralInPlace.join(', ')} is in place (the kit skills and contract are parked for a measurement); `
      + `roll it back with: ${rollbackCommand(neutralInPlace[neutralInPlace.length - 1], localConfig)}`);
  }
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
  const abs = privateFolder(dest, '--stage', repo);
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

// ---------- apply, rollback, drill: shared pieces ----------

// Rollback classes (ADR-006 §2.7). These groups are merged and reversed key by key; every other target is
// whole and comes back from the backup through the step-0 restore tool. hooks.json counts as whole even when
// the deploy merged it into an existing file: the task lists it with the whole targets.
const MERGE_KINDS = { settings: 'json', 'codex-config': 'toml', policies: 'lines' };
export const LABEL_WHOLE = 'kit-whole';
export const LABEL_MERGE = 'kit-merge';
export const JOURNAL = 'journal.json';
const BACKUP_DIR = 'backup';
const APPLIED_DIR = 'applied';
const PUSHURL_LOG = 'pushurl.json';
const DEPLOY_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
// Journal states a later deploy can be in while it still counts as in place.
const IN_PLACE = ['applying', 'applied', 'failed', 'rollback-failed'];
const DIFF_LINES = 40;

/** An apply or rollback that was refused or did not end clean (running agents, conflicts, a failed write or
 *  check): the CLI exits 1. */
export class DeployError extends Error {}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hashOf = (p) => { try { return sha256(fs.readFileSync(p)); } catch { return null; } };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = (v) => JSON.stringify(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const parseJson = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The folder that holds the deploy records: deploy/ next to the local config (_private/deploy/ by default). */
export function deployRootOf(localConfig) {
  return path.join(path.dirname(path.resolve(localConfig)), 'deploy');
}

/** A new deploy id: UTC date and time plus 4 hex digits, so ids sort in deploy order. */
export function newDeployId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * dest resolved; it must lie inside <repo>/_private/ (not be _private itself), as stage and drill folders do.
 * under narrows the parent further: drills only go below _private/eval/, never next to the runtime or the backups.
 */
function privateFolder(dest, flag, repo, under = '') {
  const priv = realPathOf(path.join(repo, '_private', under));
  const abs = path.resolve(dest);
  const real = realPathOf(abs);
  if (!within(real, priv) || pathKey(real) === pathKey(priv)) {
    throw new UsageError(`${flag} writes only to a folder inside ${slash(priv)}; refused: ${slash(abs)}`);
  }
  return abs;
}

// ---------- running agents ----------

const AGENT_NAME_RE = /^(?:claude|codex)(?:$|[ ._-])/i;
const AGENT_NODE_RE = /@anthropic-ai[\\/]claude-code|@openai[\\/]codex/i;
// Win32_Process through CIM, filtered and printed as JSON by PowerShell itself; the output is UTF-8 whatever
// the console code page, and nothing localized is read.
const PS_PROCESSES = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$list = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -match '^(claude|codex|node)' } | ForEach-Object {",
  "  [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); command_line = [string]$_.CommandLine } })",
  'ConvertTo-Json -InputObject $list -Compress -Depth 3',
].join('; ').replace('{; ', '{ ');

/**
 * Processes that may be Claude Code or Codex (names starting with claude, codex or node), from structured
 * output. Reads only.
 * @returns {{pid: number, name: string, created: string|null, command_line: string}[]}
 * @throws {Error} the list cannot be read
 */
export function listProcesses() {
  if (WIN) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PROCESSES],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`process list failed: ${r.error?.message || (r.stderr || '').trim().split(/\r?\n/)[0] || `exit ${r.status}`}`);
    const list = JSON.parse(r.stdout.trim() || '[]');
    return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.pid, name: p.name, created: p.created ?? null, command_line: p.command_line ?? '' }));
  }
  const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'comm=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`process list failed: ${r.error?.message || `exit ${r.status}`}`);
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), name: path.basename(m[2]), created: null, command_line: m[3] }));
}

/** True for a Claude Code or Codex process: claude*, codex* (CLI and desktop apps), or node running either CLI. */
export function isAgentProcess(p) {
  const base = String(p?.name ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (AGENT_NAME_RE.test(base)) return true;
  return /^node$/i.test(base) && AGENT_NODE_RE.test(String(p?.command_line ?? ''));
}

/**
 * Whether the running-agent check applies: only --apply, --neutral --apply and --rollback, and only on the
 * real user directory. Dry-run, --drill, --stage and a redirected home (tests, drills) never check.
 * @param {'apply'|'neutral-apply'|'rollback'|string} mode
 * @param {string} home the home the mode writes to
 * @param {string} [realHome]
 */
export function processCheckApplies(mode, home, realHome = os.homedir()) {
  if (!['apply', 'neutral-apply', 'rollback'].includes(mode)) return false;
  return pathKey(realPathOf(home)) === pathKey(realPathOf(realHome));
}

/**
 * Read an --ignore-pids file: a JSON list of {pid, created}, created being the creation time exactly as
 * listProcesses reports it. Reads only.
 * @param {string} file
 * @returns {{pid: number, created: string}[]}
 * @throws {UsageError} the file cannot be read, is not JSON, or an entry lacks a positive integer pid or a
 *   non-empty created string
 */
export function readIgnorePids(file) {
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new UsageError(`--ignore-pids file ${slash(file)} cannot be read: ${e.message}`);
  }
  if (!Array.isArray(list)) throw new UsageError(`--ignore-pids file ${slash(file)}: not a JSON list of {"pid", "created"}`);
  return list.map((it, i) => {
    if (!isObject(it) || !Number.isInteger(it.pid) || it.pid <= 0 || typeof it.created !== 'string' || !it.created.trim()) {
      throw new UsageError(`--ignore-pids file ${slash(file)}: entry ${i} needs a positive integer pid and a creation time string (created)`);
    }
    return { pid: it.pid, created: it.created };
  });
}

/** True when an --ignore-pids entry names this very process: same PID and the same creation time. A PID
 *  alone is not enough, since Windows reuses PIDs; a process without a known creation time never matches. */
const ignoredBy = (ignore, p) => p.created != null && ignore.some((i) => i.pid === p.pid && i.created === p.created);

function processGate({ check, allowRunning = false, lister = listProcesses, ignorePids = [] }) {
  if (!check) return { status: 'skipped', running: [], ignored: [] };
  let list;
  try { list = lister(); } catch (e) {
    if (allowRunning) return { status: 'unknown', running: [], ignored: [], note: e.message };
    throw new DeployError(`cannot list the running processes (${e.message}); close every Claude Code and Codex session and retry, or pass --allow-running`);
  }
  const agents = list.filter(isAgentProcess);
  const ignored = agents.filter((p) => ignoredBy(ignorePids, p));
  const running = agents.filter((p) => !ignored.includes(p));
  if (running.length && !allowRunning) {
    throw new DeployError(`claude or codex is running: ${running.map((p) => `${p.name} (pid ${p.pid})`).join(', ')}; `
      + 'close every Claude Code and Codex session (desktop background chats included) and retry, or pass --allow-running'
      + `${ignored.length ? ` (${ignored.length} process(es) let through by --ignore-pids)` : ''}`);
  }
  return { status: running.length ? 'allowed' : 'clear', running, ignored };
}

function gateLine(g) {
  if (g.status === 'skipped') return 'process check: skipped (not the real user directory)';
  if (g.status === 'clear' && g.ignored.length) {
    return `process check: no other claude or codex process running; ${g.ignored.map((p) => `${p.name} (pid ${p.pid})`).join(', ')} let through by --ignore-pids`;
  }
  if (g.status === 'clear') return 'process check: no claude or codex process running';
  if (g.status === 'unknown') return `process check: could not list processes (${g.note}); continuing because of --allow-running`;
  return `process check: ${g.running.length} claude or codex process(es) running; continuing because of --allow-running`;
}

// ---------- backup (step-0 format) ----------

/** Backup path of a file as the step-0 tool writes it: <drive letter>/<rest> (_root/<rest> without a drive). */
export function backupRel(abs) {
  const r = path.resolve(abs);
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(r);
  return m ? path.join(m[1].toUpperCase(), m[2]) : path.join('_root', r.replace(/^[\\/]+/, ''));
}

/**
 * Copy files into <dir>/files/<drive>/<path> and write <dir>/manifest.json in the format of the step-0
 * backup.mjs, so its restore.mjs can read it. Folders are walked; links are recorded, never followed. Every
 * copy is hash-checked.
 * @param {string} dir
 * @param {{path: string, label: string}[]} items
 * @param {{home: string, id: string}} meta
 * @returns {object} the manifest
 * @throws {Error} a copy fails or its hash differs
 */
export function writeBackup(dir, items, { home, id }) {
  const files = [];
  const links = [];
  const add = (label, p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { links.push({ label, src: p, target: fs.readlinkSync(p) }); return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p).sort()) add(label, path.join(p, n)); return; }
    const rel = backupRel(p);
    const dest = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(p, dest);
    const hash = hashOf(dest);
    if (hash === null || hash !== hashOf(p)) throw new Error(`backup copy of ${p} does not match the original`);
    files.push({ label, src: p, rel, size: st.size, sha256: hash, mtimeMs: st.mtimeMs });
  };
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  for (const it of items) add(it.label, it.path);
  const totals = {};
  for (const f of files) {
    totals[f.label] ??= { files: 0, bytes: 0 };
    totals[f.label].files++;
    totals[f.label].bytes += f.size;
  }
  const manifest = {
    created: new Date().toISOString(), tool: 'deploy-kit', deploy_id: id, home,
    sources: items.map((it) => ({ label: it.label, path: it.path })), links, totals, files,
  };
  writeJsonFile(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

// ---------- merged files: what the kit added, and how to take it out again ----------

const getAt = (v, p) => p.reduce((o, k) => (isObject(o) ? o[k] : undefined), v);

function setAt(root, p, value) {
  let o = root;
  for (const k of p.slice(0, -1)) {
    if (!isObject(o[k])) o[k] = {};
    o = o[k];
  }
  if (value === undefined) delete o[p[p.length - 1]];
  else o[p[p.length - 1]] = value;
}

/**
 * The changes from one JSON value to another, as reversible operations: add (key new in after), set (value
 * replaced), del (key gone), array (entries added, and entries removed with their index; the hook merge
 * replaces old kit hook groups this way).
 * @param {*} before
 * @param {*} after
 * @returns {object[]}
 */
export function jsonDiff(before, after, at = [], ops = []) {
  if (isObject(before) && isObject(after)) {
    for (const k of Object.keys(after)) {
      if (!Object.hasOwn(before, k)) ops.push({ op: 'add', path: [...at, k], value: after[k] });
      else jsonDiff(before[k], after[k], [...at, k], ops);
    }
    for (const k of Object.keys(before)) if (!Object.hasOwn(after, k)) ops.push({ op: 'del', path: [...at, k], before: before[k] });
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (stable(before) === stable(after)) return ops;
    const keys = after.map(stable);
    const used = new Array(after.length).fill(false);
    const removed = [];
    before.forEach((item, index) => {
      const j = keys.findIndex((k, i) => !used[i] && k === stable(item));
      if (j >= 0) used[j] = true;
      else removed.push({ index, item });
    });
    ops.push({ op: 'array', path: at, added: after.filter((_, i) => !used[i]), removed });
    return ops;
  }
  if (stable(before) !== stable(after)) ops.push({ op: 'set', path: at, before, after });
  return ops;
}

/** Take an added value out of parent[key]: object keys and list entries one by one, so content added later
 *  in the same place stays; a container left empty goes. */
function removeAdded(parent, key, value) {
  if (!isObject(parent) || !Object.hasOwn(parent, key)) return;
  const cur = parent[key];
  if (isObject(value) && isObject(cur)) {
    for (const [k, v] of Object.entries(value)) removeAdded(cur, k, v);
    if (!Object.keys(cur).length) delete parent[key];
  } else if (Array.isArray(value) && Array.isArray(cur)) {
    for (const item of value) {
      const i = cur.findIndex((x) => stable(x) === stable(item));
      if (i >= 0) cur.splice(i, 1);
    }
    if (!cur.length) delete parent[key];
  } else delete parent[key];
}

/**
 * Undo jsonDiff operations on the current value: added keys and entries go, replaced values and removed
 * entries come back; everything else in current stays.
 * @param {*} current
 * @param {object[]} ops from jsonDiff(before, applied)
 * @returns {*} a new value
 */
export function reverseJson(current, ops) {
  const out = { root: clone(current) };
  for (const o of [...ops].reverse()) {
    const p = ['root', ...o.path];
    if (o.op === 'add') removeAdded(getAt(out, p.slice(0, -1)), p[p.length - 1], o.value);
    else if (o.op === 'set' || o.op === 'del') setAt(out, p, clone(o.before));
    else if (o.op === 'array') {
      let arr = getAt(out, p);
      if (!Array.isArray(arr)) { arr = []; setAt(out, p, arr); }
      for (const item of o.added) {
        const i = arr.findIndex((x) => stable(x) === stable(item));
        if (i >= 0) arr.splice(i, 1);
      }
      for (const r of [...o.removed].sort((a, b) => a.index - b.index)) {
        if (!arr.some((x) => stable(x) === stable(r.item))) arr.splice(Math.min(r.index, arr.length), 0, clone(r.item));
      }
    }
  }
  return out.root;
}

/** What still differs from "kit keys gone, target keys restored" after reverseJson. */
function jsonProblems(value, ops) {
  const problems = [];
  const name = (p) => p.join('.') || '(root)';
  const leaves = (v, p) => {
    const cur = getAt(value, p);
    if (isObject(v) && isObject(cur)) { for (const [k, x] of Object.entries(v)) leaves(x, [...p, k]); return; }
    if (Array.isArray(v) && Array.isArray(cur)) {
      if (v.some((item) => cur.some((x) => stable(x) === stable(item)))) problems.push(`${name(p)} still holds kit entries`);
      return;
    }
    if (cur !== undefined) problems.push(`${name(p)} is still set`);
  };
  for (const o of ops) {
    if (o.op === 'add') leaves(o.value, o.path);
    else if (o.op === 'set' || o.op === 'del') { if (stable(getAt(value, o.path)) !== stable(o.before)) problems.push(`${name(o.path)} is not back to its earlier value`); }
    else if (o.op === 'array') {
      const arr = getAt(value, o.path);
      const has = (item) => Array.isArray(arr) && arr.some((x) => stable(x) === stable(item));
      if (o.added.some(has)) problems.push(`${name(o.path)} still holds kit entries`);
      if (o.removed.some((r) => !has(r.item))) problems.push(`${name(o.path)} misses entries it had before`);
    }
  }
  return problems;
}

/** The keys of the TOML fragment with their values before and after, and the tables the kit had to add. */
function tomlRecord(before, after, fragmentText) {
  const kvs = keyValues(fragmentText);
  const keys = kvs.map((kv) => ({ path: kv.path, before: before === null ? null : getValue(before, kv.path) ?? null, after: getValue(after, kv.path) ?? null }));
  const tables = [];
  for (const kv of kvs) {
    const t = kv.path.slice(0, -1);
    if (!t.length || tables.some((x) => stable(x.path) === stable(t))) continue;
    const existed = before !== null && scanToml(before).some((e) => (e.kind === 'header' && stable(e.path) === stable(t))
      || (e.kind === 'kv' && !e.inArray && e.path.length > t.length && stable(e.path.slice(0, t.length)) === stable(t)));
    tables.push({ path: t, existed });
  }
  return { keys, tables };
}

function reverseToml(text, rec) {
  let out = text;
  for (const k of [...rec.keys].reverse()) out = k.before === null ? removeValue(out, k.path) : setValue(out, k.path, k.before);
  for (const t of [...rec.tables].reverse()) if (!t.existed) out = removeEmptyTable(out, t.path);
  return out;
}

function tomlProblems(text, rec) {
  return rec.keys.filter((k) => (getValue(text, k.path) ?? null) !== k.before).map((k) => `${k.path.join('.')} is not back to ${k.before ?? 'unset'}`);
}

const splitLines = (text) => (text === null ? [] : text.split(/\r?\n/));

/**
 * Line diff (longest common subsequence): '=' kept, '-' only in a, '+' only in b.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {[string, string][]}
 */
export function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/** Hunks of a line diff with up to 3 kept lines of context on each side; at is the hunk's line in b. */
function lineHunks(a, b) {
  const ops = lineDiff(a, b);
  const hunks = [];
  let bi = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === '=') { bi++; k++; continue; }
    const h = { at: bi, before: [], after: [], pre: [], post: [] };
    for (let c = k - 1; c >= 0 && ops[c][0] === '=' && h.pre.length < 3; c--) h.pre.unshift(ops[c][1]);
    while (k < ops.length && ops[k][0] !== '=') {
      if (ops[k][0] === '-') h.before.push(ops[k][1]);
      else { h.after.push(ops[k][1]); bi++; }
      k++;
    }
    for (let c = k; c < ops.length && ops[c][0] === '=' && h.post.length < 3; c++) h.post.push(ops[c][1]);
    hunks.push(h);
  }
  return hunks;
}

/** Start of the occurrence of seq in lines nearest to hint, or -1. */
function findSeq(lines, seq, hint) {
  let best = -1;
  for (let s = 0; s + seq.length <= lines.length; s++) {
    if (seq.every((x, i) => lines[s + i] === x) && (best < 0 || Math.abs(s - hint) < Math.abs(best - hint))) best = s;
  }
  return best;
}

/** Undo line hunks on the current lines; hunks whose lines cannot be found are returned in failed. */
function unpatchLines(lines, hunks) {
  const out = [...lines];
  const failed = [];
  for (const h of [...hunks].reverse()) {
    let start = -1;
    const pos = findSeq(out, [...h.pre, ...h.after, ...h.post], h.at - h.pre.length);
    if (pos >= 0) start = pos + h.pre.length;
    else if (h.after.length) start = findSeq(out, h.after, h.at);
    if (start < 0) { failed.push(h); continue; }
    out.splice(start, h.after.length, ...h.before);
  }
  return { lines: out, failed };
}

function linesProblems(lines, hunks, beforeLines) {
  const problems = [];
  const had = new Set(beforeLines);
  for (const h of hunks) {
    const added = h.after.filter((l) => l.trim() && !had.has(l));
    if (added.some((l) => lines.includes(l))) problems.push(`kit lines still present (${added.find((l) => lines.includes(l))})`);
    const back = h.before;
    if (back.some((l) => l.trim()) && findSeq(lines, back, h.at) < 0) problems.push(`earlier lines not back (${back.find((l) => l.trim())})`);
  }
  return problems;
}

/** A short line diff for the output: only changed lines, at most DIFF_LINES. */
function diffText(fromText, toText) {
  const changed = lineDiff(splitLines(fromText), splitLines(toText)).filter(([op]) => op !== '=');
  const shownLines = changed.slice(0, DIFF_LINES).map(([op, l]) => `      ${op} ${l}`);
  if (changed.length > DIFF_LINES) shownLines.push(`      ... ${changed.length - DIFF_LINES} more changed line(s)`);
  return shownLines.join('\n');
}

/** The reversible record of one merged file: what the kit added and what it replaced. */
function mergeRecord(entry, beforeBuf) {
  const kind = MERGE_KINDS[entry.group];
  const before = beforeBuf === null ? null : beforeBuf.toString('utf8');
  const after = entry.content.toString('utf8');
  if (kind === 'json') return { kind, ops: jsonDiff(before === null ? {} : parseJson(before), parseJson(after)) };
  if (kind === 'toml') return { kind, ...tomlRecord(before, after, fs.readFileSync(entry.source, 'utf8').replace(/^\uFEFF/, '')) };
  return { kind, hunks: lineHunks(splitLines(before), splitLines(after)) };
}

// ---------- journal and local config ----------

function readJournal(dir) {
  const file = path.join(dir, JOURNAL);
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`deploy journal ${slash(file)} cannot be read: ${e.message}`); }
  if (!j || j.tool !== 'deploy-kit' || !Array.isArray(j.created) || !Array.isArray(j.modified) || !Array.isArray(j.removed) || !Array.isArray(j.merges)) {
    throw new UsageError(`${slash(file)} is not a deploy-kit journal`);
  }
  return j;
}

/** Set (or with undefined remove) deploy_options in the local config; the other keys and their order stay. */
function writeDeployOptions(localConfig, value) {
  const cfg = JSON.parse(fs.readFileSync(localConfig, 'utf8').replace(/^\uFEFF/, ''));
  if (value === undefined) delete cfg.deploy_options;
  else cfg.deploy_options = value;
  writeJsonFile(localConfig, cfg);
}

function kitHead(repo) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Subfolders under dir, relative with / separators, sorted; links are not entered. */
function listDirs(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!ent.isDirectory()) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      out.push(r);
      walk(path.join(d, ent.name), r);
    }
  };
  walk(dir, '');
  return out;
}

/** Remove a file, a link (never its target) or nothing. */
function removePath(p, kind) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink() || kind === 'link') {
    try { fs.unlinkSync(p); } catch (e) { if (e.code === 'EPERM' || e.code === 'EISDIR') fs.rmdirSync(p); else throw e; }
  } else fs.rmSync(p, { recursive: true, force: true });
}

/** The highest missing folder above file, or null when its folder exists. */
function missingTop(file) {
  let top = null;
  for (let d = path.dirname(file); !fs.existsSync(d); d = path.dirname(d)) {
    top = d;
    if (path.dirname(d) === d) break;
  }
  return top;
}

/** Remove the empty folders in dir, dir included; true when dir is gone. */
function pruneEmpty(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return true; }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  for (const n of fs.readdirSync(dir)) pruneEmpty(path.join(dir, n));
  if (fs.readdirSync(dir).length) return false;
  fs.rmdirSync(dir);
  return true;
}

// ---------- apply ----------

/**
 * Carry out a deploy plan: process check, backup, writes with a journal, deploy options. A failure after the
 * backup rolls the targets back at once (merged files from the backup too) and throws.
 * @param {object} plan from buildPlan, or from buildNeutralPlan (kind 'neutral': no deploy options recorded)
 * @param {{localConfig: string, local: object, repo?: string, checkProcesses?: boolean, allowRunning?: boolean,
 *   listProcesses?: function, ignorePids?: object[], failAt?: number}} opts checkProcesses: run the running-agent
 *   check (the CLI sets it from processCheckApplies); listProcesses replaces the process lister (tests);
 *   ignorePids: the entries of an --ignore-pids file; failAt makes write step n fail after a partial write (tests
 *   of the automatic rollback)
 * @returns {{id: string|null, dir: string|null, journal: object|null, gate: object, counts: object}} id null: the plan
 *   was empty, only the deploy options were recorded
 * @throws {DeployError} conflicts, a neutral in place, running agents, a failed backup, or a failed write (rolled back)
 * @throws {UsageError} the restore tool is missing (a rollback would be impossible)
 */
export function applyDeploy(plan, { localConfig, local, repo = KIT_REPO, checkProcesses = false, allowRunning = false, listProcesses: lister, ignorePids = [], failAt = 0 }) {
  const neutral = plan.kind === 'neutral';
  if (plan.conflicts.length) throw new DeployError(`the plan has ${plan.conflicts.length} conflict(s); run a dry-run to see them, fix them and retry`);
  assertInsideRoots(plan);
  // A deploy or a second neutral on top of a neutral would be undone by the neutral's rollback.
  const parked = neutralsInPlace(localConfig);
  if (parked.length) {
    throw new DeployError(`neutral ${parked.map((r) => r.id).join(', ')} is in place; roll it back first: ${rollbackCommand(parked[parked.length - 1].id, localConfig)}`);
  }
  const gate = processGate({ check: checkProcesses, allowRunning, lister, ignorePids });
  const restoreTool = local.restore_tool;
  if (!restoreTool || !fs.existsSync(restoreTool)) {
    throw new UsageError(`restore_tool ${restoreTool ? slash(restoreTool) : '(not set)'} not found in the local config; --rollback needs the step-0 restore.mjs`);
  }
  const counts = { created: 0, modified: 0, merged: 0, removed: 0, pushurl: 0 };
  const rawLocal = JSON.parse(fs.readFileSync(localConfig, 'utf8').replace(/^\uFEFF/, ''));
  if (planIsEmpty(plan)) {
    if (!neutral && stable(rawLocal.deploy_options) !== stable(plan.options)) writeDeployOptions(localConfig, plan.options);
    return { id: null, dir: null, journal: null, gate, counts };
  }

  const id = newDeployId();
  const dir = path.join(deployRootOf(localConfig), id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  const classOf = (e) => (MERGE_KINDS[e.group] ? 'merge' : 'whole');
  let manifest;
  try {
    manifest = writeBackup(path.join(dir, BACKUP_DIR), [
      ...plan.modify.map((e) => ({ path: e.path, label: classOf(e) === 'merge' ? LABEL_MERGE : LABEL_WHOLE })),
      ...plan.remove.map((e) => ({ path: e.path, label: LABEL_WHOLE })),
    ], { home: plan.roots.home, id });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new DeployError(`backup failed, nothing was written: ${e.message}`);
  }
  const backupOf = new Map(manifest.files.map((f) => [pathKey(f.src), f]));

  const journal = {
    tool: 'deploy-kit', version: 1, id, kind: neutral ? 'neutral' : 'deploy', applied_at: new Date().toISOString(), status: 'applying', kit_head: kitHead(repo),
    options: plan.options, ...(neutral ? { kept: NEUTRAL_KEPT } : {}),
    roots: { home: plan.roots.home, runtime: plan.roots.runtime, projects_root: plan.roots.projectsRoot },
    local_config: path.resolve(localConfig), restore_tool: restoreTool, backup: BACKUP_DIR,
    created: [], created_dirs: [], modified: [], removed: [], merges: [], pushurl: null,
    deploy_options_before: rawLocal.deploy_options ?? null, deploy_options_recorded: false,
  };
  const save = () => writeJsonFile(path.join(dir, JOURNAL), journal);
  save();

  let step = 0;
  const tick = (target) => {
    step++;
    if (failAt && step === failAt) {
      if (target) fs.writeFileSync(target, 'partial write (injected failure)\n');
      throw new Error(`injected write failure at step ${step}`);
    }
  };
  try {
    for (const e of [...plan.create, ...plan.modify]) {
      const isNew = plan.create.includes(e);
      const cls = classOf(e);
      const after = sha256(e.content);
      const top = isNew ? missingTop(e.path) : null;
      if (top && !journal.created_dirs.some((d) => within(top, d))) journal.created_dirs.push(top);
      if (isNew) journal.created.push({ path: e.path, group: e.group, class: cls, after_sha256: after });
      else journal.modified.push({ path: e.path, group: e.group, class: cls, before_sha256: backupOf.get(pathKey(e.path)).sha256, after_sha256: after });
      if (cls === 'merge') {
        const b = isNew ? null : fs.readFileSync(path.join(dir, BACKUP_DIR, 'files', backupOf.get(pathKey(e.path)).rel));
        const applied = path.join(dir, APPLIED_DIR, backupRel(e.path));
        fs.mkdirSync(path.dirname(applied), { recursive: true });
        fs.writeFileSync(applied, e.content);
        journal.merges.push({ path: e.path, group: e.group, created: isNew, after_sha256: after, applied: path.relative(dir, applied), ...mergeRecord(e, b) });
      }
      save();
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      tick(e.path);
      fs.writeFileSync(e.path, e.content);
      counts[isNew ? 'created' : 'modified']++;
      if (cls === 'merge') counts.merged++;
    }
    for (const e of plan.remove) {
      let target = null;
      if (e.kind === 'link') { try { target = fs.readlinkSync(e.path); } catch { /* gone */ } }
      journal.removed.push({
        path: e.path, kind: e.kind, files: e.files, group: e.group, ...(e.kind === 'dir' ? { dirs: listDirs(e.path) } : {}),
        ...(target ? { target, dir_link: fs.statSync(e.path, { throwIfNoEntry: false })?.isDirectory() ?? false } : {}),
      });
      save();
      tick(null);
      removePath(e.path, e.kind);
      counts.removed++;
    }
    if (plan.pushurl.length) {
      journal.pushurl = { log: PUSHURL_LOG, entries: plan.pushurl.map((p) => ({ repo: p.repo, config: p.config, remote: p.remote, original: p.original })) };
      save();
      tick(null);
      const r = applyPlan(plan.pushurlPlan, path.join(dir, PUSHURL_LOG));
      if (r.failed) throw new Error(`pushurl failed for ${r.results.filter((x) => x.status === 'failed').map((x) => `${x.repo} (${x.remote}): ${x.detail}`).join('; ')}`);
      counts.pushurl = plan.pushurl.length;
    }
    tick(null);
    if (!neutral) {
      journal.deploy_options_recorded = true;
      save();
      writeDeployOptions(localConfig, plan.options);
    }
    journal.status = 'applied';
    save();
  } catch (err) {
    journal.status = 'failed';
    journal.error = err.message;
    save();
    const rb = doRollback(journal, dir, { wholeFile: true, restoreTool, localConfig, readonlyDirs: local.readonly_dirs ?? [] });
    journal.status = rb.ok ? 'auto-rolled-back' : 'rollback-failed';
    journal.rollback = { at: new Date().toISOString(), whole_file: true, automatic: true, problems: rb.problems, notes: rb.notes };
    save();
    throw new DeployError(`write failed: ${err.message}; ${rb.ok ? 'rolled back automatically, the targets are as before the apply'
      : `the automatic rollback left ${rb.problems.length} problem(s): ${rb.problems.join('; ')}`} (deploy id ${id}, journal ${slash(path.join(dir, JOURNAL))})`);
  }
  return { id, dir, journal, gate, counts };
}

// ---------- rollback ----------

/**
 * Undo a deploy from its journal and backup (shared by --rollback and the automatic rollback of --apply).
 * @returns {{ok: boolean, problems: string[], notes: string[], diffs: {path: string, diff: string}[]}}
 */
function doRollback(j, dir, { wholeFile, restoreTool, localConfig, readonlyDirs = [] }) {
  const problems = [];
  const notes = [];
  const diffs = [];
  const backupDir = path.join(dir, j.backup || BACKUP_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  const labels = wholeFile ? [LABEL_WHOLE, LABEL_MERGE] : [LABEL_WHOLE];
  const restored = manifest.files.filter((f) => labels.includes(f.label));

  for (const m of j.modified) {
    if ((m.class === 'whole' || wholeFile) && hashOf(m.path) !== m.after_sha256 && j.status === 'applied') {
      notes.push(`${slash(m.path)} changed since the apply; restored from the backup`);
    }
  }
  // Whole targets: the step-0 restore tool puts back every backed-up file whose hash differs.
  const r = spawnSync(process.execPath, [restoreTool, '--backup', backupDir, '--only', labels.join(','), '--apply'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) problems.push(`restore tool exited ${r.status ?? r.error?.message}: ${((r.stderr || '') + (r.stdout || '')).trim().split(/\r?\n/).pop()}`);
  // It does not delete: files the apply created go here.
  for (const c of j.created) if (c.class === 'whole' || wholeFile) removePath(c.path);
  for (const rm of j.removed.filter((x) => x.kind === 'link' && x.target)) {
    if (!fs.existsSync(rm.path)) {
      try { fs.symlinkSync(rm.target, rm.path, rm.dir_link ? 'junction' : 'file'); } catch (e) { problems.push(`link ${slash(rm.path)} not made again: ${e.message}`); }
    }
  }
  // The backup holds files only: removed folders get their (possibly empty) subfolders back.
  for (const rm of j.removed.filter((x) => x.kind === 'dir' && Array.isArray(x.dirs))) {
    for (const d of ['', ...rm.dirs]) fs.mkdirSync(path.join(rm.path, ...d.split('/').filter(Boolean)), { recursive: true });
  }

  // Merged targets: reverse what the kit added, keep the rest.
  if (!wholeFile) {
    const byPath = new Map(manifest.files.map((f) => [pathKey(f.src), f]));
    for (const rec of j.merges) {
      const p = rec.path;
      const b = byPath.get(pathKey(p));
      const beforeBuf = rec.created || !b ? null : fs.readFileSync(path.join(backupDir, 'files', b.rel));
      let curBuf;
      try { curBuf = fs.readFileSync(p); } catch {
        if (!rec.created) problems.push(`${slash(p)} is gone; nothing to reverse (--whole-file restores it from the backup)`);
        continue;
      }
      const cur = curBuf.toString('utf8');
      if (sha256(curBuf) !== rec.after_sha256) {
        let appliedText = null;
        try { appliedText = fs.readFileSync(path.join(dir, rec.applied), 'utf8'); } catch { /* no copy */ }
        notes.push(`${slash(p)} changed since the apply; its own changes stay`);
        if (appliedText !== null) diffs.push({ path: p, diff: diffText(appliedText, cur) });
      }
      try {
        let out = null;
        let remove = false;
        if (rec.kind === 'json') {
          const value = reverseJson(parseJson(cur), rec.ops);
          if (rec.created && isObject(value) && !Object.keys(value).length) remove = true;
          // Back to the value it had: the backup bytes keep the file's own formatting as well.
          else if (beforeBuf !== null && stable(value) === stable(parseJson(beforeBuf.toString('utf8')))) out = beforeBuf;
          else out = Buffer.from(jsonLike(value, cur), 'utf8');
        } else if (rec.kind === 'toml') {
          const text = reverseToml(cur, rec);
          if (rec.created && !text.trim()) remove = true;
          else out = Buffer.from(text, 'utf8');
        } else {
          const u = unpatchLines(splitLines(cur), rec.hunks);
          for (const h of u.failed) problems.push(`${slash(p)}: the kit lines near "${(h.after.find((l) => l.trim()) || h.pre.join(' ')).slice(0, 60)}" were not found; fix by hand or use --whole-file`);
          if (rec.created && u.lines.every((l) => !l.trim())) remove = true;
          else out = Buffer.from(u.lines.join(cur.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
        }
        if (remove) fs.rmSync(p, { force: true });
        else if (!out.equals(curBuf)) fs.writeFileSync(p, out);
      } catch (e) {
        problems.push(`${slash(p)}: cannot reverse the merge (${e.message}); use --whole-file`);
      }
    }
  }
  for (const d of [...j.created_dirs].reverse()) {
    if (!pruneEmpty(d)) notes.push(`${slash(d)} was created by the apply and is kept: it holds files the apply did not write`);
  }

  // pushurl originals, through set-pushurl's own revert.
  if (j.pushurl) {
    const log = path.join(dir, j.pushurl.log);
    if (fs.existsSync(log)) {
      const rv = revertLog(readLog(log), { readonlyDirs });
      for (const x of rv.results.filter((y) => y.status === 'skipped' || y.status === 'failed')) problems.push(`pushurl ${slash(x.repo)} (${x.remote}): ${x.status}: ${x.detail}`);
    }
  }
  // deploy_options: back to the value before the apply, unless something else wrote it since.
  if (j.deploy_options_recorded) {
    try {
      const cfg = JSON.parse(fs.readFileSync(localConfig, 'utf8').replace(/^\uFEFF/, ''));
      if (stable(cfg.deploy_options) === stable(j.options)) writeDeployOptions(localConfig, j.deploy_options_before ?? undefined);
      else notes.push('deploy_options in the local config changed since the apply; left as it is');
    } catch (e) { notes.push(`deploy_options not restored: ${e.message}`); }
  }

  // Check every target.
  for (const f of restored) if (hashOf(f.src) !== f.sha256) problems.push(`${slash(f.src)} does not match its backup`);
  for (const c of j.created) {
    if ((c.class === 'whole' || wholeFile) && fs.existsSync(c.path)) problems.push(`${slash(c.path)} was created by the apply and is still there`);
  }
  if (!wholeFile) {
    const byPath = new Map(manifest.files.map((f) => [pathKey(f.src), f]));
    for (const rec of j.merges) {
      let text;
      try { text = fs.readFileSync(rec.path, 'utf8'); } catch { continue; }
      const b = byPath.get(pathKey(rec.path));
      const beforeText = rec.created || !b ? null : fs.readFileSync(path.join(backupDir, 'files', b.rel), 'utf8');
      let found;
      try {
        found = rec.kind === 'json' ? jsonProblems(parseJson(text), rec.ops)
          : rec.kind === 'toml' ? tomlProblems(text, rec) : linesProblems(splitLines(text), rec.hunks, splitLines(beforeText));
      } catch (e) { found = [`cannot be read (${e.message})`]; }
      for (const x of found) problems.push(`${slash(rec.path)}: ${x}`);
    }
  }
  for (const rm of j.removed.filter((x) => x.kind === 'link' && x.target)) if (!fs.existsSync(rm.path)) problems.push(`link ${slash(rm.path)} is missing`);
  for (const rm of j.removed.filter((x) => x.kind === 'dir' && Array.isArray(x.dirs))) {
    for (const d of rm.dirs) if (!fs.existsSync(path.join(rm.path, ...d.split('/')))) problems.push(`folder ${slash(path.join(rm.path, ...d.split('/')))} is missing`);
  }
  return { ok: !problems.length, problems: [...new Set(problems)], notes, diffs };
}

/** Every deploy record under the deploy root, oldest first. */
function deployRecords(root) {
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => DEPLOY_ID_RE.test(n)); } catch { /* none yet */ }
  const out = [];
  for (const n of names) {
    try { out.push({ id: n, journal: readJournal(path.join(root, n)) }); } catch { /* not a journal: ignored */ }
  }
  return out.sort((a, b) => (a.journal.applied_at < b.journal.applied_at ? -1 : a.journal.applied_at > b.journal.applied_at ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Roll back one deploy. Refused while a later deploy is still in place (roll back the latest first).
 * @param {string} id
 * @param {{localConfig: string, wholeFile?: boolean, checkProcesses?: boolean|null, allowRunning?: boolean,
 *   listProcesses?: function, ignorePids?: object[]}} opts checkProcesses null: decided by processCheckApplies from
 *   the deploy's home; ignorePids: the entries of an --ignore-pids file
 * @returns {{id: string, ok: boolean, problems: string[], notes: string[], diffs: object[], gate: object, journal: object}}
 * @throws {UsageError} unknown or malformed id, already rolled back, restore tool missing
 * @throws {DeployError} a later deploy is in place, or claude or codex is running
 */
export function rollbackDeploy(id, { localConfig, wholeFile = false, checkProcesses = null, allowRunning = false, listProcesses: lister, ignorePids = [] }) {
  if (!DEPLOY_ID_RE.test(id)) throw new UsageError(`not a deploy id: ${id} (form 20261030-091500-ab12)`);
  const root = deployRootOf(localConfig);
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, JOURNAL))) throw new UsageError(`no deploy ${id} under ${slash(root)}`);
  const j = readJournal(dir);
  if (!IN_PLACE.includes(j.status)) throw new UsageError(`deploy ${id} is already ${j.status}; nothing to roll back`);
  const later = deployRecords(root).filter((r) => r.id !== id && IN_PLACE.includes(r.journal.status) && r.journal.applied_at > j.applied_at);
  if (later.length) {
    throw new DeployError(`deploy ${id} has later deploys still in place; roll back the latest first: ${later.reverse().map((r) => r.id).join(', ')}`);
  }
  const check = checkProcesses ?? processCheckApplies('rollback', j.roots.home);
  const gate = processGate({ check, allowRunning, lister, ignorePids });
  let local = {};
  try { local = readLocalConfig(localConfig); } catch { /* fall back to the journal */ }
  const restoreTool = local.restore_tool || j.restore_tool;
  if (!restoreTool || !fs.existsSync(restoreTool)) throw new UsageError(`restore tool ${restoreTool ? slash(restoreTool) : '(not set)'} not found; set restore_tool in the local config`);
  const rb = doRollback(j, dir, { wholeFile, restoreTool, localConfig, readonlyDirs: local.readonly_dirs ?? [] });
  j.status = rb.ok ? 'rolled-back' : 'rollback-failed';
  j.rollback = { at: new Date().toISOString(), whole_file: wholeFile, automatic: false, problems: rb.problems, notes: rb.notes };
  writeJsonFile(path.join(dir, JOURNAL), j);
  return { id, ...rb, gate, journal: j };
}

// ---------- neutral (measurement) ----------

// The one line each contract file holds while the user level is neutral (v2 appendix D). An HTML comment:
// no rule, skill, tool or hint that a measurement runs, so neither platform reads workflow instructions from
// the user level. check-kit recognises the neutral state by NEUTRAL_MARKER (isNeutralText).
export const NEUTRAL_MARKER = 'autoskills:neutral';
export const NEUTRAL_LINE = `<!-- ${NEUTRAL_MARKER} -->\n`;
// What a neutral leaves as deployed; the journal lists it (kept) for the measurement manifest.
export const NEUTRAL_KEPT = [
  '~/.claude/settings.json', '~/.codex/config.toml', '~/.codex/hooks.json', '~/.codex/rules/', '<runtime>/hooks/',
  '~/.claude/agents/', 'MCP registrations (~/.claude.json, mcp_servers in ~/.codex/config.toml)',
];

/** True when text is the neutral content of a contract file (a BOM, CRLF and surrounding blanks allowed). */
export function isNeutralText(text) {
  return String(text).replace(/^\uFEFF/, '').trim() === NEUTRAL_LINE.trim();
}

/**
 * The neutral plan: NEUTRAL_LINE in ~/.claude/CLAUDE.md, ~/.claude/AGENTS.md and ~/.codex/AGENTS.md (created
 * when missing), and the 7 kit skill folders in ~/.claude/skills and ~/.agents/skills removed. Nothing else is
 * planned. Reads only.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @returns {object} a plan in the shape of buildPlan with kind 'neutral', options null, no pushurl and kept
 */
export function buildNeutralPlan(roots) {
  const t = targetMap(roots);
  const plan = {
    kind: 'neutral', roots, options: null, kept: NEUTRAL_KEPT,
    create: [], modify: [], remove: [], pushurl: [], listed: [], conflicts: [], unchanged: 0, pushurlPlan: null,
  };
  const content = Buffer.from(NEUTRAL_LINE, 'utf8');
  for (const p of [t.claudeMd, t.claudeAgentsMd, t.codexAgentsMd]) {
    let st = null;
    try { st = fs.lstatSync(p); } catch { /* missing: create */ }
    const e = { path: p, content, group: 'contract', mode: 'whole', reason: 'one neutral line in place of the contract: no workflow rule at the user level while measuring (v2 appendix D)' };
    if (!st) plan.create.push(e);
    else if (!st.isFile()) plan.conflicts.push({ path: p, reason: `a ${st.isDirectory() ? 'folder' : 'link'} stands where the neutral puts a file` });
    else if (sameBytes(p, content)) plan.unchanged++;
    else plan.modify.push(e);
  }
  for (const dir of kitSkillDirs(roots)) {
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    plan.remove.push({
      path: dir, kind, files: kind === 'dir' ? listFiles(dir) : [], group: 'skills',
      reason: 'kit skill moved out while measuring: a user-level copy shadows (Claude) or doubles (Codex) the project-level one under test',
    });
  }
  return plan;
}

/** The neutral records still in place under the deploy root of localConfig, oldest first. */
export function neutralsInPlace(localConfig) {
  return deployRecords(deployRootOf(localConfig)).filter((r) => r.journal.kind === 'neutral' && IN_PLACE.includes(r.journal.status));
}

/** The kit deploys still in place (not neutrals), oldest first. */
function kitDeploysInPlace(localConfig) {
  return deployRecords(deployRootOf(localConfig)).filter((r) => r.journal.kind !== 'neutral' && r.journal.status === 'applied');
}

function printNeutralPlan(plan, localConfig) {
  const s = (p) => shown(p, plan.roots);
  const deploys = kitDeploysInPlace(localConfig);
  const parked = neutralsInPlace(localConfig);
  console.log('deploy-kit: --neutral dry-run, nothing is written');
  console.log(`  home ${slash(plan.roots.home)}; local config ${slash(localConfig)}`);
  console.log(deploys.length ? `  kit deploy in place: ${deploys.map((r) => r.id).join(', ')}`
    : `  no kit deploy in place under ${slash(deployRootOf(localConfig))}: the neutral parks what is there now`);
  const group = (title, list, sign, line) => {
    console.log(`${title} (${list.length}):`);
    for (const e of list) console.log(`  ${sign} ${line(e)}`);
  };
  group('create', plan.create, '+', (e) => `${s(e.path)}  [${e.group}] ${e.reason}`);
  group('modify', plan.modify, '~', (e) => `${s(e.path)}  [${e.group}] ${e.reason}`);
  group('remove', plan.remove, '-', (e) => `${s(e.path)}${e.kind === 'dir' ? `/ (${e.files.length} file(s))` : e.kind === 'link' ? ' (link only, the target stays)' : ''}  [${e.group}] ${e.reason}`);
  if (plan.conflicts.length) group('conflicts', plan.conflicts, '!', (e) => `${s(e.path)}  ${e.reason}`);
  console.log(`  kept as deployed: ${plan.kept.join(', ')}`);
  console.log(`deploy-kit: neutral: ${plan.create.length} to create, ${plan.modify.length} to modify, ${plan.remove.length} to remove, ${plan.unchanged} unchanged`
    + `${plan.conflicts.length ? `, ${plan.conflicts.length} conflict(s)` : ''}`);
  if (parked.length) {
    console.log(`deploy-kit: neutral ${parked.map((r) => r.id).join(', ')} is in place; roll it back with: ${rollbackCommand(parked[parked.length - 1].id, localConfig)}`);
  }
}

// ---------- drill ----------

/** sha256 of every file (and "dir" or "link:<target>" for the others) under p, keyed by prefix + relative path. */
function treeHashes(p, prefix, out = {}) {
  let st;
  try { st = fs.lstatSync(p); } catch { return out; }
  if (st.isSymbolicLink()) out[prefix] = `link:${fs.readlinkSync(p)}`;
  else if (st.isDirectory()) {
    out[prefix] = 'dir';
    for (const n of fs.readdirSync(p).sort()) treeHashes(path.join(p, n), `${prefix}/${n}`, out);
  } else out[prefix] = hashOf(p);
  return out;
}

function compareHashes(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] === after[k]) continue;
    out.push(`${k}: ${before[k] === undefined ? 'added' : after[k] === undefined ? 'missing' : 'changed'}`);
  }
  return out.sort();
}

/** The source home paths a deploy reads or changes: every planned target, removal and kit skill folder. */
function homeTargets(roots, plan, desired) {
  const set = new Map();
  for (const p of [...desired.map((d) => d.path), ...plan.remove.map((e) => e.path), ...kitSkillDirs(roots)]) {
    if (within(p, roots.home)) set.set(pathKey(p), p);
  }
  return [...set.values()].sort();
}

function realFingerprint(roots, targets) {
  const out = treeHashes(roots.runtime, 'runtime');
  for (const repo of scanRepos(roots.projectsRoot).candidates) {
    const g = path.join(repo, '.git');
    let st;
    try { st = fs.lstatSync(g); } catch { continue; }
    treeHashes(st.isDirectory() ? path.join(g, 'config') : g, `repo:${slash(repo)}`, out);
  }
  for (const p of targets) treeHashes(p, `home:${slash(p)}`, out);
  return out;
}

/** Copy files (folders walked; links skipped and counted) from src to dest. */
function copyTree(src, dest, counts) {
  let st;
  try { st = fs.lstatSync(src); } catch { return; }
  if (st.isSymbolicLink()) { counts.links++; return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dest, n), counts);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  counts.files++;
}

/**
 * The restore drill (v2 appendix C): apply and roll back on a copy of the kit-related files of the source
 * home, inside <dir>/<timestamp>/, then compare hashes. The timestamp folder is removed at the end.
 * @param {string} dir a folder inside <repo>/_private/eval/
 * @param {{roots: object, local: object, claudeContract?: string, retireLegacyAgents?: boolean, repo?: string}} opts
 *   roots and local: the source (by default the real user directory, runtime and projects root)
 * @returns {{ok: boolean, sub: string, copied: object, applied: object, rollback: object|null, mismatches: string[],
 *   sourceChanged: string[], removed: boolean}}
 */
export function runDrill(dir, { roots: src, local: srcLocal, claudeContract = DEFAULT_OPTIONS.claude_contract, retireLegacyAgents = false, repo = KIT_REPO }) {
  const base = privateFolder(dir, '--drill', repo, 'eval');
  if (!srcLocal.restore_tool || !fs.existsSync(srcLocal.restore_tool)) {
    throw new UsageError(`restore_tool ${srcLocal.restore_tool ? slash(srcLocal.restore_tool) : '(not set)'} not found in the local config`);
  }
  const desired = desiredFiles(src, { claudeContract, repo, local: srcLocal });
  const srcPlan = buildPlan(src, { claudeContract, retireLegacyAgents, local: srcLocal, repo });
  const targets = homeTargets(src, srcPlan, desired);
  const sourceBefore = realFingerprint(src, targets);

  const sub = path.join(base, new Date().toISOString().replace(/[:.]/g, '-'));
  if (fs.existsSync(sub)) throw new UsageError(`drill folder already exists: ${slash(sub)}`);
  const roots = { home: path.join(sub, 'home'), runtime: path.join(sub, 'runtime'), projectsRoot: path.join(sub, 'projects') };
  const result = { ok: false, sub, copied: { files: 0, links: 0 }, applied: null, rollback: null, mismatches: [], sourceChanged: [], removed: false };
  try {
    for (const d of Object.values(roots)) fs.mkdirSync(d, { recursive: true });
    for (const p of targets) copyTree(p, path.join(roots.home, path.relative(src.home, p)), result.copied);
    // pushurl is exercised on a repository made for the drill only.
    const drillRepo = path.join(roots.projectsRoot, 'drill-repo');
    fs.mkdirSync(drillRepo);
    for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.invalid/drill/drill-repo.git']]) {
      const g = spawnSync('git', args, { cwd: drillRepo, encoding: 'utf8', windowsHide: true });
      if (g.status !== 0) throw new Error(`git ${args[0]} in the drill repo failed: ${(g.stderr || '').trim()}`);
    }
    const localConfig = path.join(sub, 'private', 'kit-local.json');
    const local = {
      readonly_dirs: srcLocal.readonly_dirs ?? [], customer_data_dirs: srcLocal.customer_data_dirs ?? [],
      runtime: slash(roots.runtime), portable_node: srcLocal.portable_node ?? null, projects_root: slash(roots.projectsRoot),
      restore_tool: slash(srcLocal.restore_tool),
    };
    writeJsonFile(localConfig, local);
    const snapshot = () => ({ ...treeHashes(roots.home, 'home'), ...treeHashes(roots.runtime, 'runtime'), ...treeHashes(roots.projectsRoot, 'projects') });
    const before = snapshot();
    const plan = buildPlan(roots, { claudeContract, retireLegacyAgents, local: readLocalConfig(localConfig), repo });
    const a = applyDeploy(plan, { localConfig, local: readLocalConfig(localConfig), repo });
    result.applied = { id: a.id, ...a.counts, changed: compareHashes(before, snapshot()).length };
    if (a.id) result.rollback = rollbackDeploy(a.id, { localConfig, checkProcesses: false });
    result.mismatches = compareHashes(before, snapshot());
  } finally {
    fs.rmSync(sub, { recursive: true, force: true });
    result.removed = !fs.existsSync(sub);
  }
  result.sourceChanged = compareHashes(sourceBefore, realFingerprint(src, targets));
  result.ok = !!result.applied && (result.rollback ? result.rollback.ok : true) && !result.mismatches.length && !result.sourceChanged.length && result.removed;
  return result;
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
        'whole-file': { type: 'boolean' }, 'allow-running': { type: 'boolean' }, 'ignore-pids': { type: 'string' },
        stage: { type: 'string' }, layout: { type: 'string' }, force: { type: 'boolean' }, 'expect-clean': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (a.help) return { help: true };
  const given = (...flags) => flags.filter((f) => a[f] !== undefined).map((f) => `--${f}`);
  const modes = given('apply', 'rollback', 'drill', 'stage', 'init-local');
  if (modes.length > 1) throw new UsageError(`${modes.join(' and ')} exclude each other`);
  if (a['whole-file'] !== undefined && a.rollback === undefined) throw new UsageError('--whole-file goes with --rollback');
  if (a['allow-running'] !== undefined && a.apply === undefined && a.rollback === undefined) throw new UsageError('--allow-running goes with --apply or --rollback');
  if (a['ignore-pids'] !== undefined && a.apply === undefined && a.rollback === undefined) throw new UsageError('--ignore-pids goes with --apply or --rollback');
  if (a.neutral) {
    // The neutral plan is fixed: no deploy options, no expect-clean of its own, no other mode.
    const extra = given('rollback', 'drill', 'stage', 'init-local', 'expect-clean', 'claude-contract', 'retire-legacy-agents');
    if (extra.length) throw new UsageError(`--neutral takes only --dry-run, --apply, --json, --allow-running, --ignore-pids and the root options (not ${extra.join(', ')})`);
  }
  let ignorePids = [];
  if (a['ignore-pids'] !== undefined) {
    if (!a['ignore-pids'].trim()) throw new UsageError('--ignore-pids needs a file');
    ignorePids = readIgnorePids(path.resolve(a['ignore-pids']));
  }
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
  for (const k of ['home', 'runtime', 'projects-root', 'local-config']) {
    if (a[k] !== undefined && !a[k].trim()) throw new UsageError(`--${k} needs a path`);
  }
  const localConfig = path.resolve(a['local-config'] ?? DEFAULT_LOCAL_CONFIG);
  if (a.rollback !== undefined) {
    // The roots come from the deploy's journal; only the local config says where the deploy records are.
    const extra = given('dry-run', 'json', 'expect-clean', 'claude-contract', 'retire-legacy-agents', 'home', 'runtime', 'projects-root');
    if (extra.length) throw new UsageError(`--rollback takes only --whole-file, --allow-running, --ignore-pids and --local-config (not ${extra.join(', ')})`);
    if (!a.rollback.trim()) throw new UsageError('--rollback needs a deploy id');
    return { mode: 'rollback', id: a.rollback.trim(), wholeFile: !!a['whole-file'], allowRunning: !!a['allow-running'], ignorePids, localConfig };
  }
  if (a.apply || a.drill !== undefined) {
    const extra = given('dry-run', 'json', 'expect-clean');
    const flag = a.apply ? (a.neutral ? '--neutral --apply' : '--apply') : '--drill';
    if (extra.length) throw new UsageError(`${flag} does not take ${extra.join(', ')}`);
    if (a.drill !== undefined && !a.drill.trim()) throw new UsageError('--drill needs a folder');
  }
  if (a['expect-clean']) {
    // The options come from deploy_options in the local config, so the deployed state is checked as deployed.
    const extra = given('init-local', 'claude-contract', 'retire-legacy-agents');
    if (extra.length) throw new UsageError(`--expect-clean plans with the options recorded in the local config; drop ${extra.join(', ')}`);
  }
  const contract = a['claude-contract'] ?? DEFAULT_OPTIONS.claude_contract;
  if (!CLAUDE_CONTRACT_MODES.includes(contract)) throw new UsageError(`--claude-contract must be import or inline: ${contract}`);
  const mode = a.neutral ? (a.apply ? 'neutral-apply' : 'neutral')
    : a['init-local'] ? 'init-local' : a.apply ? 'apply' : a.drill !== undefined ? 'drill' : 'dry-run';
  return {
    mode, json: !!a.json, claudeContract: contract, expectClean: !!a['expect-clean'], drill: a.drill, allowRunning: !!a['allow-running'], ignorePids,
    retireLegacyAgents: !!a['retire-legacy-agents'], home: a.home, runtime: a.runtime, projectsRoot: a['projects-root'], localConfig,
  };
}

/** The rollback command as printed: --local-config only when it is not the default. */
function rollbackCommand(id, localConfig) {
  const lc = pathKey(localConfig) === pathKey(DEFAULT_LOCAL_CONFIG) ? '' : ` --local-config "${slash(localConfig)}"`;
  return `node scripts/deploy-kit.mjs --rollback ${id}${lc}`;
}

function printRollback(r) {
  console.log(`deploy-kit: rollback ${r.id}${r.journal.rollback.whole_file ? ' --whole-file' : ''}: ${gateLine(r.gate)}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  for (const d of r.diffs) console.log(`  diff of ${slash(d.path)} since the apply (- as deployed, + now):\n${d.diff}`);
  for (const p of r.problems) console.log(`  MISMATCH ${p}`);
  console.log(r.ok ? `deploy-kit: rolled back ${r.journal.kind === 'neutral' ? 'neutral ' : ''}${r.id}; every target checked (whole files against the backup hashes, merged files: kit keys gone, earlier values back)`
    : `deploy-kit: rollback ${r.id} left ${r.problems.length} mismatch(es); see above (--whole-file restores the merged files from the backup)`);
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

  if (opts.mode === 'rollback') {
    const r = rollbackDeploy(opts.id, { localConfig: opts.localConfig, wholeFile: opts.wholeFile, allowRunning: opts.allowRunning, ignorePids: opts.ignorePids });
    printRollback(r);
    return r.ok ? 0 : 1;
  }

  const local = readLocalConfig(opts.localConfig);
  const roots = resolveRoots({ home: opts.home, runtime: opts.runtime, projectsRoot: opts.projectsRoot }, local);
  if (!fs.existsSync(roots.home) || !fs.statSync(roots.home).isDirectory()) throw new UsageError(`home is not a folder: ${roots.home}`);

  if (opts.mode === 'drill') {
    console.log(`deploy-kit: drill from home ${slash(roots.home)}, runtime ${slash(roots.runtime)}, projects root ${slash(roots.projectsRoot)}`);
    const r = runDrill(opts.drill, { roots, local, claudeContract: opts.claudeContract, retireLegacyAgents: opts.retireLegacyAgents });
    console.log(`  drill folder ${slash(r.sub)}: ${r.copied.files} kit-related file(s) copied${r.copied.links ? `, ${r.copied.links} link(s) not copied` : ''}; empty runtime; new repo for pushurl`);
    if (r.applied) {
      console.log(`  apply ${r.applied.id ?? '(empty plan)'}: ${r.applied.created} created, ${r.applied.modified} modified (${r.applied.merged} merged), `
        + `${r.applied.removed} removed, ${r.applied.pushurl} pushurl; ${r.applied.changed} path(s) changed`);
    }
    if (r.rollback) {
      for (const n of r.rollback.notes) console.log(`  note: ${n}`);
      for (const p of r.rollback.problems) console.log(`  rollback MISMATCH ${p}`);
    }
    for (const m of r.mismatches) console.log(`  after rollback differs from before: ${m}`);
    for (const m of r.sourceChanged) console.log(`  SOURCE CHANGED ${m}`);
    console.log(`  drill folder ${r.removed ? 'removed' : 'NOT removed'}; source runtime, repo .git/config files and home targets ${r.sourceChanged.length ? 'CHANGED' : 'unchanged'}`);
    console.log(r.ok ? 'deploy-kit: drill passed: apply then rollback gave back every file hash'
      : 'deploy-kit: drill FAILED; see above');
    return r.ok ? 0 : 1;
  }

  if (opts.mode === 'neutral' || opts.mode === 'neutral-apply') {
    const plan = buildNeutralPlan(roots);
    assertInsideRoots(plan);
    if (opts.mode === 'neutral') {
      if (opts.json) console.log(JSON.stringify(planJson(plan, { neutralInPlace: neutralsInPlace(opts.localConfig).map((x) => x.id) }), null, 2));
      else printNeutralPlan(plan, opts.localConfig);
      return plan.conflicts.length ? 1 : 0;
    }
    if (plan.conflicts.length) {
      printNeutralPlan(plan, opts.localConfig);
      throw new DeployError(`the neutral plan has ${plan.conflicts.length} conflict(s); nothing was written`);
    }
    const r = applyDeploy(plan, {
      localConfig: opts.localConfig, local, checkProcesses: processCheckApplies('neutral-apply', roots.home), allowRunning: opts.allowRunning, ignorePids: opts.ignorePids,
    });
    console.log(`deploy-kit: neutral: home ${slash(roots.home)}`);
    console.log(`  ${gateLine(r.gate)}`);
    if (!r.id) { console.log('deploy-kit: the user level is already neutral; nothing to write'); return 0; }
    const c = r.counts;
    console.log(`  backup: ${r.journal.modified.length + r.journal.removed.length} target(s) in ${slash(path.join(r.dir, BACKUP_DIR))} (step-0 format, hashes checked)`);
    console.log(`  written: ${c.created} created, ${c.modified} modified, ${c.removed} removed; journal ${slash(path.join(r.dir, JOURNAL))}`);
    console.log(`  kept as deployed: ${NEUTRAL_KEPT.join(', ')}`);
    console.log(`deploy-kit: neutral id ${r.id}`);
    console.log(`deploy-kit: roll back with: ${rollbackCommand(r.id, opts.localConfig)}`);
    return 0;
  }

  const options = opts.expectClean
    ? (({ claude_contract: c, retire_legacy_agents: r }) => ({ claudeContract: c, retireLegacyAgents: r }))(recordedOptions(local))
    : { claudeContract: opts.claudeContract, retireLegacyAgents: opts.retireLegacyAgents };
  const plan = buildPlan(roots, { ...options, local });
  assertInsideRoots(plan);

  if (opts.mode === 'apply') {
    if (plan.conflicts.length) {
      printPlan(plan, opts.localConfig);
      throw new DeployError(`the plan has ${plan.conflicts.length} conflict(s); nothing was written`);
    }
    const r = applyDeploy(plan, {
      localConfig: opts.localConfig, local, checkProcesses: processCheckApplies('apply', roots.home), allowRunning: opts.allowRunning, ignorePids: opts.ignorePids,
    });
    console.log(`deploy-kit: apply: home ${slash(roots.home)}; runtime ${slash(roots.runtime)}; projects root ${slash(roots.projectsRoot)}`);
    console.log(`  ${gateLine(r.gate)}`);
    console.log(`  claude contract ${plan.options.claude_contract}; retire legacy agents ${plan.options.retire_legacy_agents ? 'yes' : 'no'} (recorded as deploy_options in ${slash(opts.localConfig)})`);
    if (!r.id) { console.log('deploy-kit: the plan is empty; nothing to deploy'); return 0; }
    const c = r.counts;
    console.log(`  backup: ${r.journal.modified.length + r.journal.removed.length} target(s) in ${slash(path.join(r.dir, BACKUP_DIR))} (step-0 format, hashes checked)`);
    console.log(`  written: ${c.created} created, ${c.modified} modified (${c.merged} merged), ${c.removed} removed, ${c.pushurl} pushurl; journal ${slash(path.join(r.dir, JOURNAL))}`);
    console.log(`deploy-kit: deploy id ${r.id}`);
    console.log(`deploy-kit: roll back with: ${rollbackCommand(r.id, opts.localConfig)}`);
    const trust = codexTrustNote(plan);
    if (trust) console.log(`deploy-kit: next: ${trust}`);
    return 0;
  }

  const neutralInPlace = neutralsInPlace(opts.localConfig).map((x) => x.id);
  if (opts.json) console.log(JSON.stringify(planJson(plan, { expectClean: opts.expectClean, neutralInPlace }), null, 2));
  else printPlan(plan, opts.localConfig, { expectClean: opts.expectClean, neutralInPlace });
  if (opts.expectClean) return planIsEmpty(plan) ? 0 : 1;
  return plan.conflicts.length ? 1 : 0;
}

// Both sides by real path, as in the hooks: Node gives the main module its real path, so a start through a
// junction or symlink would otherwise skip run() and exit 0 without a word.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  let a, b;
  try { a = fs.realpathSync(path.resolve(process.argv[1])); b = fs.realpathSync(SELF); } catch { return false; }
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) console.error(`deploy-kit: ${e.message}\n${USAGE}`);
    else console.error(e instanceof DeployError ? `deploy-kit: ${e.message}` : `deploy-kit: error: ${e.stack || e}`);
    process.exitCode = e instanceof DeployError ? 1 : 2;
  }
}
