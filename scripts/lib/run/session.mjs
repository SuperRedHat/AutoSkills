// One headless Claude Code session for the long-run driver: start `claude -p`, read its stream-json, end it when it
// goes quiet, and say how it ended. Ported from the eval harness's session driver (claude adapter, runTurn,
// childEnv, launchSpec, killTree); every session here is a fresh one (no --resume). Zero dependencies (Node >= 18).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** What the CLI prints when the subscription's usage is used up (the harness's rule, unchanged). */
export const USAGE_LIMIT_RE = /usage limit|hit your (usage )?limit|limit reached|rate[ _-]?limit|too many requests|\b429\b|quota/i;

// Variables a parent Claude Code / Codex session sets for itself; inheriting them would change the child
// (CLAUDE_EFFORT) or make it refuse to start as a nested session (CLAUDECODE).
const SESSION_ENV_EXACT = new Set(['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_CI']);
const SESSION_ENV_RE = /^(CLAUDE_CODE_(.*SESSION.*|BRIDGE.*|MESSAGING.*|ENTRYPOINT|EXECPATH|CHILD.*)|CODEX_SANDBOX.*|CODEX_INTERNAL.*)$/;

/**
 * The environment of a session: the driver's own without what a parent session set for itself, plus PROJECT_DIR (it
 * pins project-manager's project to this one; it otherwise searches upward) and no interactive git prompts.
 */
export function childEnv(project, base = process.env, extra = {}) {
  const env = {};
  const stripped = [];
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase();
    if (SESSION_ENV_EXACT.has(K) || SESSION_ENV_RE.test(K) || K === 'PROJECT_DIR') {
      if (K !== 'PROJECT_DIR') stripped.push(k);
      continue;
    }
    env[k] = v;
  }
  // AUTOSKILLS_UNATTENDED: the guard hook then denies a git push in every permission mode (hooks/guard.mjs, UNATTENDED_ENV).
  Object.assign(env, { PROJECT_DIR: project, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', DISABLE_AUTOUPDATER: '1', AUTOSKILLS_UNATTENDED: '1' }, extra);
  return { env, stripped };
}

/** How to start `file`: a .mjs/.cjs/.js stand-in runs under this Node; .cmd/.bat/.ps1 are refused (they re-parse the prompt). */
export function launchSpec(file, args) {
  if (/\.(mjs|cjs|js)$/i.test(file)) return { cmd: process.execPath, argv: [file, ...args] };
  if (/\.(cmd|bat|ps1)$/i.test(file)) {
    throw new Error(`refusing to launch ${file}: a shell shim would re-parse the prompt; point to the .exe instead`);
  }
  return { cmd: file, argv: args };
}

/** Kill a whole process tree (Windows: taskkill /T /F). */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

function findOnPath(names, env = process.env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  for (const dir of (env[key] || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const full = path.join(dir.replace(/^"|"$/g, ''), n);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** The claude executable: --cli, else CLAUDE_EXE, else the first claude(.exe) on PATH. */
export function resolveClaude(override, env = process.env) {
  return override || env.CLAUDE_EXE || (process.platform === 'win32' ? findOnPath(['claude.exe'], env) : findOnPath(['claude'], env));
}

/** `<cli> --version`, or null. */
export function cliVersion(file) {
  try {
    const { cmd, argv } = launchSpec(file, ['--version']);
    const r = spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

/** The command line of one session. model and effort are passed only when given. */
export function sessionArgs({ prompt, permissionMode, model, effort }) {
  return [
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode,
    ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
  ];
}

// result.modelUsage has no reasoning split; input counts cache reads and writes, as the harness counted them.
export function tokensOf(r) {
  const t = { input_total: 0, input_cached: 0, cache_write: 0, output_total: 0 };
  const mu = r?.modelUsage && Object.keys(r.modelUsage).length ? Object.values(r.modelUsage) : null;
  if (mu) {
    for (const m of mu) {
      t.input_total += (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
      t.input_cached += m.cacheReadInputTokens || 0;
      t.cache_write += m.cacheCreationInputTokens || 0;
      t.output_total += m.outputTokens || 0;
    }
  } else if (r?.usage) {
    const u = r.usage;
    t.input_total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    t.input_cached = u.cache_read_input_tokens || 0;
    t.cache_write = u.cache_creation_input_tokens || 0;
    t.output_total = u.output_tokens || 0;
  }
  t.total = t.input_total + t.output_total;
  return t;
}

function newAcc() {
  return { sessionId: null, init: null, result: null, lastText: '', toolCalls: 0, kitCalls: 0, skills: [], hooks: [], events: 0, badLines: 0 };
}

function onEvent(acc, e) {
  if (e.session_id && !acc.sessionId) acc.sessionId = e.session_id;
  if (e.type === 'system' && e.subtype === 'init') {
    const names = (a) => (Array.isArray(a) ? a.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : []);
    const cmds = [...names(e.slash_commands), ...names(e.skills)];
    const tools = Array.isArray(e.tools) ? e.tools : [];
    acc.init = {
      model: e.model ?? null, cli_version: e.claude_code_version ?? null, permission_mode: e.permissionMode ?? null,
      cwd: e.cwd ?? null, tools: tools.length,
      mcp_servers: (e.mcp_servers || []).map((s) => `${s.name}:${s.status}`),
      kit_tools: tools.filter((t) => /project-manager/.test(String(t))).length,
      kit_skills: [...new Set(cmds.filter((c) => /^project-/.test(c)))],
    };
  } else if (e.type === 'system' && /hook/i.test(String(e.subtype || ''))) {
    acc.hooks.push({ subtype: e.subtype, name: e.hook_name ?? e.hook_event ?? e.name ?? null });
  } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text && !e.parent_tool_use_id) acc.lastText = b.text;
      if (b.type !== 'tool_use') continue;
      acc.toolCalls += 1;
      const name = String(b.name || '');
      if (/project-manager/.test(name)) acc.kitCalls += 1;
      if (name === 'Skill') acc.skills.push(String(b.input?.skill || b.input?.command || b.input?.name || '?'));
    }
  } else if (e.type === 'result') {
    acc.result = e;
  }
}

/**
 * How a session ended. errorKind: null (it ran to its result), spawn, idle_timeout, interrupt, process (no result or a
 * non-zero exit), api (the result says it failed), max_turns, usage_limit (the subscription's usage is used up).
 */
export function outcomeOf(acc, proc) {
  const r = acc.result;
  const finalText = r && typeof r.result === 'string' ? r.result : acc.lastText;
  let errorKind = null;
  if (proc.spawnError) errorKind = 'spawn';
  else if (proc.killed === 'idle') errorKind = 'idle_timeout';
  else if (proc.killed === 'interrupt') errorKind = 'interrupt';
  else if (!r) errorKind = 'process';
  else if (r.is_error || r.subtype !== 'success') errorKind = r.subtype === 'error_max_turns' ? 'max_turns' : 'api';
  else if (proc.code !== 0) errorKind = 'process';
  if (errorKind && errorKind !== 'spawn' && errorKind !== 'interrupt' && USAGE_LIMIT_RE.test(`${finalText || ''}\n${proc.stderrTail || ''}`)) errorKind = 'usage_limit';
  return {
    sessionId: acc.sessionId || r?.session_id || null,
    errorKind,
    exitCode: proc.code,
    finalText: finalText || '',
    tokens: tokensOf(r),
    costUsd: r?.total_cost_usd ?? null,
    detail: r ? {
      subtype: r.subtype, is_error: r.is_error, num_turns: r.num_turns ?? null,
      permission_denials: Array.isArray(r.permission_denials) ? r.permission_denials.length : 0,
      api_error_status: r.api_error_status ?? null,
    } : null,
    init: acc.init, toolCalls: acc.toolCalls, kitCalls: acc.kitCalls, skills: acc.skills, hooks: acc.hooks,
    events: acc.events, badLines: acc.badLines,
  };
}

const tail = (s, n) => (s.length > n ? s.slice(s.length - n) : s);

/**
 * Run one session to its end. The session is ended (its whole process tree) when nothing has come on stdout or
 * stderr for idleMs, or when shouldInterrupt() turns true. A Ctrl+C in the driver's console does not reach it (see
 * docs/windows/finish/a-probes.md, probe 3).
 * @returns {Promise<{outcome: object, ms: number}>}
 */
export async function runSession({ cli, args, cwd, env, stdoutFile, stderrFile, idleMs, shouldInterrupt = () => false, onChild = () => {}, pollMs = 1000 }) {
  const acc = newAcc();
  const started = Date.now();
  fs.mkdirSync(path.dirname(stdoutFile), { recursive: true });
  const out = fs.createWriteStream(stdoutFile);
  const err = fs.createWriteStream(stderrFile);
  const closeLogs = () => Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
  let child;
  try {
    const { cmd, argv } = launchSpec(cli, args);
    // windowsHide gives the session a console of its own (hidden), so a Ctrl+C in the driver's console does not reach
    // it; detached would too, but then a console program the session starts without hiding gets a visible window.
    child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    await closeLogs();
    return { outcome: outcomeOf(acc, { code: null, killed: null, spawnError: e.message, stderrTail: '' }), ms: 0 };
  }
  onChild(child);
  let killed = null;
  let lastActivity = Date.now();
  let buf = '';
  let errTail = '';
  const decoder = new StringDecoder('utf8');
  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let e;
    try { e = JSON.parse(line); } catch { acc.badLines += 1; return; }
    acc.events += 1;
    try { onEvent(acc, e); } catch { acc.badLines += 1; }
  };
  child.stdout.on('data', (b) => {
    lastActivity = Date.now();
    out.write(b);
    buf += decoder.write(b);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (b) => { lastActivity = Date.now(); err.write(b); errTail = tail(errTail + b.toString('utf8'), 4000); });
  const timer = setInterval(() => {
    if (killed) return;
    if (shouldInterrupt()) { killed = 'interrupt'; killTree(child.pid); } else if (Date.now() - lastActivity >= idleMs) { killed = 'idle'; killTree(child.pid); }
  }, pollMs);
  const res = await new Promise((resolve) => {
    let graceTimer = null;
    let closed = false;
    child.on('error', (e) => resolve({ code: null, spawnError: e.message }));
    child.on('close', (code) => { closed = true; clearTimeout(graceTimer); resolve({ code, spawnError: null }); });
    // A grandchild that inherited the pipes can keep them open after the CLI exits.
    child.on('exit', (code) => {
      if (closed) return;
      graceTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, spawnError: null }); }, 15000);
    });
  });
  clearInterval(timer);
  buf += decoder.end();
  if (buf.trim()) handleLine(buf);
  await closeLogs();
  const outcome = outcomeOf(acc, { code: res.code, killed, spawnError: res.spawnError, stderrTail: errTail });
  return { outcome, ms: Date.now() - started };
}
