// kit-targets: the root mapping, the local config and the target list of the AutoSkills kit. Shared by
// deploy-kit (plan and write), check-kit (compare) and the measurement scripts, so every one of them
// resolves the same paths from the same three roots. Zero dependencies (Node >= 18). Read only: nothing
// in this module writes, moves or deletes files.
// lint-kit: allow-legacy the deletion list names the six retired skills and the old Gemini skill folder it removes
//
// Roots (resolveRoots):
//   home           the user directory (default os.homedir()); every user-level target hangs off it.
//   runtime        the runtime area for hooks and the portable Node (default: runtime in the local config).
//   projects_root  the folder that holds the project repositories (default: projects_root in the local config).
// Tests and drills redirect all three, so they never touch the real user directory, runtime or repos.
//
// Targets of AS3-112a (desiredFiles, legacyRemovals; ADR-006 §2.7, v2 §3.1/§3.5/§3.6, v3 §5):
//   ~/.claude/AGENTS.md, ~/.codex/AGENTS.md   the shared contract (templates/global-AGENTS.md), whole file.
//   ~/.claude/CLAUDE.md                        templates/global-claude-CLAUDE.md, which opens with @AGENTS.md;
//                                              claude_contract=inline puts the contract text in place of the
//                                              import line (fallback when the import does not load).
//   ~/.claude/skills/<7>, ~/.agents/skills/<7> the 7 kit skills, each folder replaced whole.
//   ~/.claude/agents/project-verifier.md       the independent verifier (v2 §3.6).
//   ~/.workflow-core/templates/<file>          every file of templates/; other files there stay.
//   ~/.workflow-core/policies/workflow-rules.md merged: the old "Core Rules" section is removed and a marked
//                                              block points to the contract; the other sections stay.
//   Removed: the old project-* copies only (LEGACY_SKILL_DIRS), and with retireLegacyAgents the 3 old
//   agents of LEGACY_AGENTS. Folders whose name starts with "{" (a failed brace expansion) are listed, never
//   removed. Never targeted: ~/.claude.json, the project-manager dist, verification-profiles.json and
//   acceptance-matrix.json (NEVER_TOUCH), and ~/.workflow-core scripts/, docs/ and backups/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_LOCAL_CONFIG = path.join(KIT_REPO, '_private', 'kit-local.json');
const WIN = process.platform === 'win32';

/** A usage or setup error: the CLIs exit 2 on it. */
export class UsageError extends Error {}

// The 7 skills of AutoSkills 3.0 and the 6 retired in batch 1 (same lists as lint-kit).
export const KIT_SKILLS = ['project-consult', 'project-feedback', 'project-next', 'project-plan', 'project-quick', 'project-resume', 'project-status'];
export const RETIRED_SKILLS = ['project-ask', 'project-change', 'project-design', 'project-discuss', 'project-init', 'project-review'];
// Agent definitions the kit deploys to ~/.claude/agents/ (from config/claude/agents/<name>.md).
export const KIT_AGENTS = ['project-verifier'];
// The 3 agents from March that call retired skills (v2 decision 9): archived, then removed, only with
// --retire-legacy-agents.
export const LEGACY_AGENTS = ['code-reviewer', 'researcher', 'tester'];
export const CLAUDE_CONTRACT_MODES = ['import', 'inline'];
export const DEFAULT_OPTIONS = Object.freeze({ claude_contract: 'import', retire_legacy_agents: false });
const IMPORT_LINE = '@AGENTS.md';

// Old skill copies (v2 §3.6 and decision 9, ADR-006 §2.7). select 'retired' removes only RETIRED_SKILLS;
// 'project' removes every project-* folder. Other folders (pdf, playwright, .system, synced ...) are never
// looked at beyond their name.
export const LEGACY_SKILL_DIRS = [
  { key: 'claudeSkills', select: 'retired', reason: 'skill retired in AutoSkills 3.0 (ADR-006 §2.7)' },
  { key: 'codexSkills', select: 'project', reason: 'old copy: Codex reads the kit skills from ~/.agents/skills (v2 §3.6)' },
  { key: 'geminiSkills', select: 'project', reason: 'old copy: Gemini is no longer a kit platform (v2 §3.6)' },
  { key: 'codexAgentSkills', select: 'project', reason: 'old copy left by the former sync script; not a skill location' },
  { key: 'workflowSkills', select: 'project', reason: 'old copy of the former skill source; the kit deploys from its repo' },
];

// workflow-rules.md: the kit block and the section it retires.
export const WF_BEGIN = '<!-- autoskills:begin -->';
export const WF_END = '<!-- autoskills:end -->';
const WF_POINTER = [
  '## AutoSkills 3.0',
  '',
  'The shared rules live in the autonomy contract: `~/.claude/AGENTS.md` and `~/.codex/AGENTS.md` (the same text,',
  'from `templates/global-AGENTS.md` of the AutoSkills repo). Where this file and the contract differ, the contract applies.',
  'Project contracts start from `~/.workflow-core/templates/repo-AGENTS.md`. The former "Core Rules" section is retired.',
];
const WF_RETIRED_SECTION = /^##\s+Core Rules\s*$/i;
const WF_DEFAULT_TITLE = '# Shared Workflow Rules';

// ---------- paths ----------

/** Absolute path with / separators, as written to the local config. */
export const slash = (p) => path.resolve(p).split(path.sep).join('/');

/** Comparison key: resolved, on Windows in lower case. */
export const pathKey = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));

/** True when p is dir or lies below it. */
export function within(p, dir) {
  const k = pathKey(p), d = pathKey(dir);
  return k === d || k.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/**
 * Every user-level and runtime location the kit knows, resolved from the three roots.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots absolute paths
 * @returns {Record<string, string>} absolute paths
 */
export function targetMap(roots) {
  const h = (...p) => path.join(roots.home, ...p);
  return {
    claudeDir: h('.claude'),
    claudeAgentsMd: h('.claude', 'AGENTS.md'),
    claudeMd: h('.claude', 'CLAUDE.md'),
    claudeSkills: h('.claude', 'skills'),
    claudeAgents: h('.claude', 'agents'),
    claudeSettings: h('.claude', 'settings.json'),
    claudeJson: h('.claude.json'),
    pmServer: h('.claude', 'mcp-project-manager'),
    codexDir: h('.codex'),
    codexAgentsMd: h('.codex', 'AGENTS.md'),
    codexConfig: h('.codex', 'config.toml'),
    codexSkills: h('.codex', 'skills'),
    codexAgentSkills: h('.codex', 'agents', 'skills'),
    agentsSkills: h('.agents', 'skills'),
    geminiSkills: h('.gemini', 'skills'),
    workflowCore: h('.workflow-core'),
    workflowTemplates: h('.workflow-core', 'templates'),
    workflowSkills: h('.workflow-core', 'skills'),
    workflowRules: h('.workflow-core', 'policies', 'workflow-rules.md'),
    verificationProfiles: h('.workflow-core', 'policies', 'verification-profiles.json'),
    acceptanceMatrix: h('.workflow-core', 'policies', 'acceptance-matrix.json'),
    runtime: roots.runtime,
    runtimeHooks: path.join(roots.runtime, 'hooks'),
    projectsRoot: roots.projectsRoot,
  };
}

/** Paths the kit never writes or removes (ADR-006 §2.7). */
export function neverTouch(roots) {
  const t = targetMap(roots);
  return [t.claudeJson, path.join(t.pmServer, 'dist'), t.verificationProfiles, t.acceptanceMatrix];
}

// ---------- local config ----------

/**
 * Read and check the local config (_private/kit-local.json; fields in config/kit-local.example.json).
 * @param {string} file
 * @returns {object} the parsed config; missing lists are []
 * @throws {UsageError} the file is missing (message names --init-local), unreadable, or a path is not absolute
 */
export function readLocalConfig(file) {
  if (!fs.existsSync(file)) {
    throw new UsageError(`local config ${file} not found; create it first with: node scripts/deploy-kit.mjs --init-local`);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    throw new UsageError(`local config ${file} cannot be read: ${e.message}`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new UsageError(`local config ${file}: not a JSON object`);
  for (const key of ['readonly_dirs', 'customer_data_dirs']) {
    const v = cfg[key] ?? [];
    if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !path.isAbsolute(d))) {
      throw new UsageError(`local config ${file}: ${key} must be a list of absolute paths`);
    }
    cfg[key] = v;
  }
  for (const key of ['runtime', 'projects_root', 'portable_node', 'restore_tool']) {
    const v = cfg[key];
    if (v !== undefined && v !== null && (typeof v !== 'string' || !path.isAbsolute(v))) {
      throw new UsageError(`local config ${file}: ${key} must be an absolute path`);
    }
  }
  return cfg;
}

/**
 * The three roots: command-line values first, then the user directory and the local config.
 * @param {{home?: string, runtime?: string, projectsRoot?: string}} cli
 * @param {object|null} local parsed local config (null: no defaults for runtime and projects_root)
 * @returns {{home: string, runtime: string, projectsRoot: string}} absolute paths
 * @throws {UsageError} a root has neither a command-line value nor a local-config value
 */
export function resolveRoots(cli = {}, local = null) {
  const pick = (flag, key, name) => {
    if (flag) return path.resolve(flag);
    if (local && local[key]) return path.resolve(local[key]);
    throw new UsageError(`no ${name}: pass --${name} or set ${key} in the local config`);
  };
  return {
    home: path.resolve(cli.home || os.homedir()),
    runtime: pick(cli.runtime, 'runtime', 'runtime'),
    projectsRoot: pick(cli.projectsRoot, 'projects_root', 'projects-root'),
  };
}

// ---------- desired state ----------

/** Files under dir, relative with / separators, sorted; links are listed, never entered. */
export function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/**
 * ~/.claude/CLAUDE.md for the inline mode: the contract text in place of the leading @AGENTS.md line.
 * @param {string} claudeTemplate text of templates/global-claude-CLAUDE.md
 * @param {string} contract text of templates/global-AGENTS.md
 * @returns {string}
 */
export function inlineClaude(claudeTemplate, contract) {
  const lines = claudeTemplate.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || lines[first].trim() !== IMPORT_LINE) {
    throw new UsageError(`templates/global-claude-CLAUDE.md must open with ${IMPORT_LINE}`);
  }
  return [contract.replace(/\s+$/, ''), ...lines.slice(first + 1)].join('\n');
}

/**
 * workflow-rules.md after the merge: an earlier kit block is dropped, the "## Core Rules" section is removed
 * and the kit block goes right after the title. Other sections and the line endings stay. Applying it to
 * its own output gives the same text.
 * @param {string|null} text current file, or null when it does not exist
 * @returns {string}
 */
export function mergeWorkflowRules(text) {
  const src = text === null ? `${WF_DEFAULT_TITLE}\n` : text;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const b = lines.indexOf(WF_BEGIN);
  const e = b >= 0 ? lines.indexOf(WF_END, b) : -1;
  if (b >= 0 && e > b) {
    lines.splice(b, e - b + 1);
    if (lines[b] === '') lines.splice(b, 1);
  }
  const c = lines.findIndex((l) => WF_RETIRED_SECTION.test(l));
  if (c >= 0) {
    let end = c + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    lines.splice(c, end - c);
  }
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  let at = h1 + 1;
  if (h1 >= 0) {
    if (lines[at] === '') at++;
    else lines.splice(at++, 0, '');
  }
  lines.splice(at, 0, WF_BEGIN, ...WF_POINTER, WF_END, '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join(eol) + eol;
}

/**
 * The files the kit wants on disk (AS3-112a targets), with their content. Reads the repo and, for merged
 * files, the current target. Writes nothing.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @param {{claudeContract?: string, repo?: string}} [opts]
 * @returns {{path: string, content: Buffer, group: string, mode: 'whole'|'merge', source?: string, reason: string}[]}
 * @throws {UsageError} the repo lacks a source, or skills/ does not hold exactly the 7 kit skills
 */
export function desiredFiles(roots, { claudeContract = DEFAULT_OPTIONS.claude_contract, repo = KIT_REPO } = {}) {
  if (!CLAUDE_CONTRACT_MODES.includes(claudeContract)) {
    throw new UsageError(`claude contract mode must be one of ${CLAUDE_CONTRACT_MODES.join(', ')}: ${claudeContract}`);
  }
  const t = targetMap(roots);
  const r = (...p) => path.join(repo, ...p);
  const need = (file) => { if (!fs.existsSync(file)) throw new UsageError(`kit source missing: ${file}`); return file; };
  const out = [];
  const copy = (target, source, group, reason) => out.push({ path: target, content: fs.readFileSync(need(source)), group, mode: 'whole', source, reason });

  const contractSrc = need(r('templates', 'global-AGENTS.md'));
  copy(t.claudeAgentsMd, contractSrc, 'contract', 'shared contract (v3 §5: the same text for both platforms)');
  copy(t.codexAgentsMd, contractSrc, 'contract', 'shared contract (v3 §5: the same text for both platforms)');
  const claudeSrc = need(r('templates', 'global-claude-CLAUDE.md'));
  if (claudeContract === 'inline') {
    const text = inlineClaude(readText(claudeSrc), readText(contractSrc));
    out.push({ path: t.claudeMd, content: Buffer.from(text, 'utf8'), group: 'contract', mode: 'whole', reason: 'Claude entry file with the contract inline (--claude-contract inline)' });
  } else {
    copy(t.claudeMd, claudeSrc, 'contract', `Claude entry file: ${IMPORT_LINE} plus the Claude-only lines (v3 §5)`);
  }

  const skillsDir = need(r('skills'));
  const present = fs.readdirSync(skillsDir).filter((n) => fs.statSync(path.join(skillsDir, n)).isDirectory()).sort();
  if (present.join(',') !== [...KIT_SKILLS].sort().join(',')) {
    throw new UsageError(`skills/ must hold exactly the 7 kit skills (${KIT_SKILLS.join(', ')}); found: ${present.join(', ') || 'none'}`);
  }
  for (const base of [t.claudeSkills, t.agentsSkills]) {
    for (const skill of KIT_SKILLS) {
      for (const rel of listFiles(r('skills', skill))) {
        copy(path.join(base, skill, ...rel.split('/')), r('skills', skill, ...rel.split('/')), 'skills', 'kit skill (ADR-006 §2.7)');
      }
    }
  }

  for (const agent of KIT_AGENTS) {
    copy(path.join(t.claudeAgents, `${agent}.md`), r('config', 'claude', 'agents', `${agent}.md`), 'agents', 'independent verifier (v2 §3.6)');
  }

  for (const rel of listFiles(need(r('templates')))) {
    copy(path.join(t.workflowTemplates, ...rel.split('/')), r('templates', ...rel.split('/')), 'templates', 'kit template (project-plan reads the deployed copies)');
  }

  const current = fs.existsSync(t.workflowRules) ? readText(t.workflowRules) : null;
  out.push({
    path: t.workflowRules, content: Buffer.from(mergeWorkflowRules(current), 'utf8'), group: 'policies', mode: 'merge',
    reason: 'point the shared rules to the contract; the old Core Rules section is removed, other sections stay',
  });
  return out;
}

/**
 * Kit skill folders on the target side; files in them that the repo copy lacks are removed with the deploy
 * (each folder is replaced whole).
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @returns {string[]} absolute folder paths
 */
export function kitSkillDirs(roots) {
  const t = targetMap(roots);
  return [t.claudeSkills, t.agentsSkills].flatMap((base) => KIT_SKILLS.map((s) => path.join(base, s)));
}

/**
 * Old copies to remove and folders that are only listed. Reads directory entries only.
 * @param {{home: string, runtime: string, projectsRoot: string}} roots
 * @param {{retireLegacyAgents?: boolean}} [opts]
 * @returns {{remove: {path: string, kind: 'dir'|'file'|'link', files: string[], group: string, reason: string}[],
 *   listed: {path: string, reason: string}[]}}
 */
export function legacyRemovals(roots, { retireLegacyAgents = false } = {}) {
  const t = targetMap(roots);
  const remove = [];
  const listed = [];
  const entry = (p, group, reason) => {
    const st = fs.lstatSync(p);
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    remove.push({ path: p, kind, files: kind === 'dir' ? listFiles(p) : [], group, reason });
  };
  for (const loc of LEGACY_SKILL_DIRS) {
    const base = t[loc.key];
    let names;
    try { names = fs.readdirSync(base).sort(); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('{') && name.includes('project-')) {
        listed.push({ path: path.join(base, name), reason: 'not removed: the name does not start with project- (a failed brace expansion); check-kit warns and names the delete command' });
        continue;
      }
      const hit = loc.select === 'retired' ? RETIRED_SKILLS.includes(name) : /^project-/.test(name);
      if (hit) entry(path.join(base, name), 'legacy-skills', loc.reason);
    }
  }
  if (retireLegacyAgents) {
    for (const agent of LEGACY_AGENTS) {
      const p = path.join(t.claudeAgents, `${agent}.md`);
      if (fs.existsSync(p)) entry(p, 'legacy-agents', 'old agent that calls retired skills (v2 decision 9): archived under _private/deploy/<id>/ first, then removed');
    }
  }
  return { remove, listed };
}
