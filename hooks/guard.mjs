#!/usr/bin/env node
// guard: the AutoSkills PreToolUse guard for Claude Code and Codex (ADR-006 §2.5). Zero dependencies
// (Node >= 18).
//
// Usage (the hook registration is one fixed command line with both paths quoted; the logic lives in this
// file, so changing it does not need the hook to be trusted again):
//   "<node>" "<runtime>/hooks/guard.mjs" [--platform claude|codex] [--config <file>]
//   "<node>" "<runtime>/hooks/guard.mjs" --selftest
//
// Input: the PreToolUse JSON on stdin.
//   Claude: tool_name Bash or PowerShell, tool_input.command a string, parsed in that tool's syntax.
//   Codex: the input fields and the deny format are settled by the C0 probe (T-meta) and backfilled
//   after it. Until then a shell-like tool (Bash, PowerShell, shell, local_shell, shell_command,
//   exec_command, unified_exec, container.exec) is read from tool_input.command or tool_input.cmd, as a
//   string or an argv array; a string is parsed as both Bash and PowerShell and a deny in either wins.
//   The platform comes from --platform, else from the input (turn_id or a .codex transcript: codex;
//   permission_mode or a .claude transcript: claude).
//   Other tools and other events are allowed (rules 2-4 and the SessionStart hook come in a later task).
// Output: nothing on allow, so the normal permission flow goes on. On deny, one UTF-8 JSON line:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
// Exit codes: 0 = decided (allow or deny). 2 = error: unknown option, stdin is not a JSON object, a shell
// call has no command text or does not parse (unterminated quote, $( ... ), block comment, here-string),
// or the local config exists but cannot be read. The reason goes to stderr. Claude registers the guard
// with onFailure: "block", so an error blocks the call; Codex lets a call through when its hook fails,
// so there the guard is only a reminder.
//
// Local config: hook-config.json next to this script, written at deploy time; --config names another
// file (tests use temp dirs). Shape: {"runtime": "<absolute runtime dir>"}; other keys are ignored here.
// A missing file means no heartbeat; a file that exists but cannot be read or parsed is an error.
// Heartbeat: every run except --selftest appends one line to <runtime>/hooks/heartbeat/guard.jsonl with
// exactly {ts, platform, event, decision} (decision: allow, deny or error), never the command text, so
// the check script can tell the hook really ran. When the next line would take the file past 1 MiB, the
// file is first cut to its newest 512 KiB of whole lines. A heartbeat that cannot be written is a stderr
// note, never a block.
// --selftest runs the built-in samples in memory: it reads no stdin and no config and writes no file.
// Exit 0 = every sample gave the expected decision.
//
// Parsing: Bash, PowerShell and cmd text is split into simple commands at ; && || | & and newlines,
// ( ) groups, { } blocks and $( ) @( ) `...` substitutions (also inside double quotes). Quotes and escapes
// are removed, comments, here-doc and here-string bodies skipped, redirections dropped. Each command is
// checked after stripping VAR=value prefixes, reserved words (then, do ...) and wrappers (env, command,
// builtin, exec, nohup, time, sudo, nice, timeout, xargs) and after unwrapping bash/sh -c, powershell/pwsh -Command, cmd /c and
// Start-Process. The PowerShell & call operator separates like any & does, so "& git push" is git push.
//
// Rule 1, push and publish:
//   - git push in every spelling: -C, -c, --git-dir, --work-tree, git.exe or a full path to git, the
//     PowerShell & call, a full remote URL, an alias defined inline (-c alias.p=push p); also
//     send-pack, http-push, subtree push and lfs push.
//   - gh repo, release, pr and workflow writes: every subcommand except the read ones listed in GH_READS.
//   - gh api with a write method: -X/--method other than GET or HEAD, or -f/-F/--field/--raw-field/
//     --input without an explicit method (gh then sends POST). An explicit -X GET stays a read: gh sends
//     the fields as query parameters.
//   - npm publish.
//
// Known gaps, ADR-006 §4 residual risks. The guard does not pretend to catch them:
//   - indirect execution: a push written into a script file and then run (bash push.sh, ./push.ps1,
//     pwsh -File), Invoke-Expression, encoded commands (-EncodedCommand);
//   - commands built at run time: variables ($g push, & $git push), substitutions that produce the
//     subcommand (git $(echo push)), git and gh aliases defined outside the command.
//   On one Windows account the guard only prevents mistakes; it cannot stop a deliberate bypass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node hooks/guard.mjs [--platform claude|codex] [--config <file>]  (PreToolUse JSON on stdin)\n'
  + '       node hooks/guard.mjs --selftest';

const SELF = fileURLToPath(import.meta.url);
const HOOK_NAME = 'guard';
const CONFIG_NAME = 'hook-config.json';
const HEARTBEAT_MAX = 1024 * 1024;
const HEARTBEAT_KEEP = 512 * 1024;
const MAX_DEPTH = 8;
const PLATFORMS = new Set(['claude', 'codex']);

/** A command or input the guard cannot read; the run exits 2 so onFailure: "block" applies. */
export class ParseError extends Error {}

// ---------------------------------------------------------------------------------------------------
// Splitting shell text into simple commands

/**
 * Split shell text into simple commands, each an array of words with quotes and escapes removed.
 * @param {string} src shell text
 * @param {'bash'|'ps'|'cmd'} dialect syntax to read it in
 * @param {number} [depth] nesting depth of the caller (bounded by MAX_DEPTH)
 * @returns {string[][]}
 */
export function parseScript(src, dialect, depth = 0) {
  return scan(String(src), 0, dialect, depth, null).segs;
}

// Reads from start until the closer (')' or '`') or the end; returns the commands and the index after
// the closer. Substitutions and groups recurse, so their commands are checked like any other.
function scan(src, start, dialect, depth, closer) {
  if (depth > MAX_DEPTH) throw new ParseError('命令嵌套太深');
  const bash = dialect === 'bash', ps = dialect === 'ps', cmd = dialect === 'cmd';
  const segs = [];
  let words = [];
  let word = null; // null: no word started (an empty quoted string is a word: '')
  let dropNext = false; // the next word is a redirection target
  let heredocNext = null; // bash: the next word is a here-doc delimiter
  const heredocs = []; // bash: delimiters whose bodies start after the next newline
  let braces = 0; // ps: { opened inside a word (${name}, @{...}), closed by a literal }
  const add = (inner) => { for (const s of inner) segs.push(s); };
  const endWord = () => {
    if (word === null) return;
    if (heredocNext) { heredocs.push({ delim: word, strip: heredocNext.strip }); heredocNext = null; }
    else if (dropNext) dropNext = false;
    else words.push(word);
    word = null;
  };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  const placeholder = (text) => { if (dropNext) dropNext = false; else word = (word ?? '') + text; };

  let i = start;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (closer && c === closer) { endSeg(); return { segs, end: i + 1 }; }
    if (c === '\n' || c === '\r') {
      endSeg();
      i++;
      if (c === '\n' && heredocs.length) { i = skipHeredocs(src, i, heredocs); heredocs.length = 0; }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { endWord(); i++; continue; }
    if (c === '#' && word === null && !cmd) {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ps && c === '<' && d === '#' && word === null) {
      const e = src.indexOf('#>', i + 2);
      if (e < 0) throw new ParseError('块注释 <# 没有结束');
      i = e + 2;
      continue;
    }
    if (c === "'" && !cmd) { const r = readSingle(src, i, ps); word = (word ?? '') + r.text; i = r.end; continue; }
    if (c === '"') {
      const r = readDouble(src, i, dialect, depth);
      add(r.segs);
      word = (word ?? '') + r.text;
      i = r.end;
      continue;
    }
    if ((bash && c === '\\') || (ps && c === '`') || (cmd && c === '^')) {
      if (d === '\n') i += 2;
      else if (d === '\r' && src[i + 2] === '\n') i += 3;
      else { word = (word ?? '') + (d ?? ''); i += 2; }
      continue;
    }
    if (bash && c === '`') {
      const r = scan(src, i + 1, dialect, depth + 1, '`');
      add(r.segs);
      placeholder('`...`');
      i = r.end;
      continue;
    }
    if ((bash || ps) && (c === '$' || (ps && c === '@')) && d === '(') {
      const r = scan(src, i + 2, dialect, depth + 1, ')');
      add(r.segs);
      placeholder(`${c}(...)`);
      i = r.end;
      continue;
    }
    if (ps && c === '@' && (d === '"' || d === "'") && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 64))) {
      // Here-string: the body is data; it ends at a line that starts with "@ or '@.
      const e = src.indexOf(`\n${d}@`, i + 2);
      if (e < 0) throw new ParseError('here-string 没有结束');
      placeholder('@here-string');
      i = e + 3;
      continue;
    }
    if (c === '(') {
      endWord();
      const r = scan(src, i + 1, dialect, depth + 1, ')');
      add(r.segs);
      if (dropNext) dropNext = false; else words.push('(...)');
      i = r.end;
      continue;
    }
    if (c === ')') { endSeg(); i++; continue; } // a stray ) (bash case patterns): a boundary, not an error
    if ((bash || ps) && c === '{') {
      if (word === null) { endSeg(); i++; continue; }
      if (ps) braces++;
      word += c;
      i++;
      continue;
    }
    if ((bash || ps) && c === '}') {
      if (ps && braces > 0) { braces--; word = (word ?? '') + c; i++; continue; }
      if (ps || word === null) { endSeg(); i++; continue; }
      word += c;
      i++;
      continue;
    }
    if (c === ';') { endSeg(); i += d === ';' ? 2 : 1; continue; }
    if (c === '|') { endSeg(); i += d === '|' || d === '&' ? 2 : 1; continue; }
    if (c === '&') {
      if (d === '&') { endSeg(); i += 2; continue; }
      if (bash && d === '>') { endWord(); i += src[i + 2] === '>' ? 3 : 2; dropNext = true; continue; }
      endSeg(); // bash background, cmd separator, the PowerShell call operator
      i++;
      continue;
    }
    if (c === '>' || (c === '<' && !ps)) {
      // A word of digits (or * in PowerShell) right before it is the stream number, not an argument.
      if (word !== null && (/^\d+$/.test(word) || (ps && word === '*'))) word = null;
      else endWord();
      if (bash && c === '<' && d === '<' && src[i + 2] !== '<') {
        i += 2;
        let strip = false;
        if (src[i] === '-') { strip = true; i++; }
        heredocNext = { strip };
        continue;
      }
      i++;
      while (src[i] === '>' || src[i] === '<' || src[i] === '|') i++;
      if (src[i] === '&') { i++; while (i < src.length && /[0-9-]/.test(src[i])) i++; continue; }
      dropNext = true;
      continue;
    }
    word = (word ?? '') + c;
    i++;
  }
  if (closer) throw new ParseError(`缺少结尾的 ${closer}`);
  endSeg();
  return { segs, end: i };
}

function readSingle(src, i, ps) {
  let text = '';
  let j = i + 1;
  for (;;) {
    if (j >= src.length) throw new ParseError('单引号没有结束');
    const ch = src[j];
    if (ch === "'") {
      if (ps && src[j + 1] === "'") { text += "'"; j += 2; continue; }
      return { text, end: j + 1 };
    }
    text += ch;
    j++;
  }
}

function readDouble(src, i, dialect, depth) {
  const segs = [];
  let text = '';
  let j = i + 1;
  for (;;) {
    if (j >= src.length) {
      if (dialect === 'cmd') return { segs, text, end: j }; // cmd runs an open quote to the end of the line
      throw new ParseError('双引号没有结束');
    }
    const ch = src[j], nx = src[j + 1];
    if (ch === '"') {
      if (dialect === 'ps' && nx === '"') { text += '"'; j += 2; continue; }
      return { segs, text, end: j + 1 };
    }
    if (dialect === 'cmd') {
      if (ch === '\n' || ch === '\r') return { segs, text, end: j };
      text += ch;
      j++;
      continue;
    }
    if (dialect === 'bash' && ch === '\\') {
      if (nx === '\n') j += 2;
      else if ('$`"\\'.includes(nx ?? '')) { text += nx; j += 2; }
      else { text += ch; j++; }
      continue;
    }
    if (dialect === 'ps' && ch === '`') { text += nx ?? ''; j += 2; continue; }
    if (ch === '$' && nx === '(') {
      const r = scan(src, j + 2, dialect, depth + 1, ')');
      segs.push(...r.segs);
      text += '$(...)';
      j = r.end;
      continue;
    }
    if (dialect === 'bash' && ch === '`') {
      const r = scan(src, j + 1, dialect, depth + 1, '`');
      segs.push(...r.segs);
      text += '`...`';
      j = r.end;
      continue;
    }
    text += ch;
    j++;
  }
}

// Bash here-doc bodies are data: skip each body up to its delimiter line (bash only warns when the
// delimiter is missing, so the end of the text ends the body too).
function skipHeredocs(src, i, list) {
  for (const h of list) {
    while (i < src.length) {
      let e = src.indexOf('\n', i);
      if (e < 0) e = src.length;
      let line = src.slice(i, e).replace(/\r$/, '');
      if (h.strip) line = line.replace(/^\t+/, '');
      i = Math.min(e + 1, src.length);
      if (line === h.delim) break;
    }
  }
  return i;
}

// ---------------------------------------------------------------------------------------------------
// Checking one simple command

const WRAPPERS = {
  env: { value: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], assign: true },
  command: {},
  builtin: {},
  exec: { value: ['-a'] },
  nohup: {},
  time: {},
  sudo: { value: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'] },
  nice: { value: ['-n', '--adjustment'] },
  timeout: { value: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  xargs: { value: ['-a', '-d', '-E', '-e', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--replace'] },
};
// Bash reserved words that may stand before a command (if true; then git push; fi).
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!']);
const BASH_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);
const START_PROCESS = new Set(['start-process', 'saps', 'start']);
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);
const GIT_PUSH = new Set(['push', 'send-pack', 'http-push']);
// Read subcommands of the gh groups rule 1 covers; every other subcommand of these groups is a write.
const GH_READS = {
  repo: new Set(['view', 'list', 'ls', 'clone', 'set-default', 'credits', 'gitignore', 'license']),
  release: new Set(['list', 'ls', 'view', 'download', 'verify', 'verify-asset']),
  pr: new Set(['list', 'ls', 'view', 'status', 'diff', 'checks', 'checkout', 'co']),
  workflow: new Set(['list', 'ls', 'view']),
};
const GH_NESTED_READS = new Set(['list', 'ls', 'view']); // gh repo deploy-key / autolink <sub>
const GH_READ_METHODS = new Set(['GET', 'HEAD']);
const NPM_VALUE_OPTS = new Set(['--registry', '--otp', '--tag', '--access', '--userconfig', '--globalconfig', '--prefix', '--workspace', '-w', '--cache', '--loglevel', '--scope', '-C']);

/** Program name of a command word: the last path segment, lower case, without .exe/.cmd/.bat/.com. */
function programName(word) {
  return word.split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/**
 * Check one simple command; push what it would push or publish onto hits (e.g. "git push").
 * @param {string[]} words the command and its arguments
 * @param {number} depth nesting depth (bounded by MAX_DEPTH)
 * @param {string[]} hits collected rule-1 hits
 */
export function checkWords(words, depth, hits) {
  if (depth > MAX_DEPTH) throw new ParseError('命令嵌套太深');
  let w = words;
  for (;;) {
    while (w.length && (isAssign(w[0]) || SHELL_KEYWORDS.has(w[0]))) w = w.slice(1);
    const wrap = w.length ? WRAPPERS[programName(w[0])] : null;
    if (!wrap) break;
    w = stripWrapper(w.slice(1), wrap);
  }
  if (!w.length) return;
  const name = programName(w[0]);
  const args = w.slice(1);
  if (name === 'git') checkGit(args, depth, hits);
  else if (name === 'gh') checkGh(args, hits);
  else if (name === 'npm') checkNpm(args, hits);
  else if (BASH_SHELLS.has(name)) unwrapBash(args, depth, hits);
  else if (PS_SHELLS.has(name)) unwrapPowerShell(name, args, depth, hits);
  else if (name === 'cmd') unwrapCmd(args, depth, hits);
  else if (START_PROCESS.has(name)) unwrapStartProcess(args, depth, hits);
}

function stripWrapper(rest, wrap) {
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--') { i++; break; }
    if (wrap.assign && isAssign(a)) { i++; continue; }
    if (a.length > 1 && a.startsWith('-')) { i += wrap.value?.includes(a) ? 2 : 1; continue; }
    break;
  }
  return rest.slice(i + (wrap.positional ?? 0));
}

function checkScript(text, dialect, depth, hits) {
  for (const seg of parseScript(text, dialect, depth + 1)) checkWords(seg, depth + 1, hits);
}

function checkGit(args, depth, hits) {
  const aliases = new Map();
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (GIT_VALUE_OPTS.has(a)) {
      const v = args[++i] ?? '';
      const m = a === '-c' ? /^alias\.([^=]+)=([\s\S]*)$/i.exec(v) : null;
      if (m) aliases.set(m[1].toLowerCase(), m[2]);
      continue;
    }
    if (!a.startsWith('-')) break;
  }
  if (i >= args.length) return;
  let sub = args[i].toLowerCase();
  let rest = args.slice(i + 1);
  if (aliases.has(sub)) {
    const v = aliases.get(sub).trim();
    if (v.startsWith('!')) { checkScript(v.slice(1), 'bash', depth, hits); return; }
    const words = v.split(/\s+/);
    sub = words[0].toLowerCase();
    rest = [...words.slice(1), ...rest];
  }
  if (GIT_PUSH.has(sub)) hits.push(`git ${sub}`);
  else if ((sub === 'subtree' || sub === 'lfs') && rest.some((a) => a.toLowerCase() === 'push')) hits.push(`git ${sub} push`);
}

function checkGh(args, hits) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (pos[0]?.toLowerCase() === 'api') { checkGhApi(args.slice(i), hits); return; }
    if (a === '--help' || a === '-h') return;
    if (a === '-R' || a === '--repo') { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const [group, sub, sub2] = pos.map((p) => p.toLowerCase());
  if (group === 'api') { checkGhApi([], hits); return; }
  const reads = GH_READS[group];
  if (!reads || !sub || sub === 'help' || reads.has(sub)) return;
  if (group === 'repo' && (sub === 'deploy-key' || sub === 'autolink') && (!sub2 || GH_NESTED_READS.has(sub2))) return;
  hits.push(`gh ${group} ${sub}`);
}

function checkGhApi(args, hits) {
  let method = null;
  let body = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') method = args[++i] ?? '';
    else if (a.startsWith('--method=')) method = a.slice('--method='.length);
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) { body = true; i++; }
    else if (/^-[fF]./.test(a) || /^--(?:field|raw-field|input)=/.test(a)) body = true;
  }
  const m = method === null ? (body ? 'POST' : 'GET') : method.toUpperCase();
  if (!GH_READ_METHODS.has(m)) hits.push(`gh api（${m || '未写方法'}）`);
}

function checkNpm(args, hits) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (NPM_VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (a.toLowerCase() === 'publish') hits.push('npm publish');
    return;
  }
}

// bash -c '<script>' (also -lc, -ec ...). A script file (bash push.sh) is a known gap.
function unwrapBash(args, depth, hits) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '+o') { i++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { if (args[i + 1] !== undefined) checkScript(args[i + 1], 'bash', depth, hits); return; }
    if (a.startsWith('-') || a.startsWith('+')) continue;
    return;
  }
}

const isParam = (a, full, min = 1) => {
  const p = a.slice(1).toLowerCase();
  return (a[0] === '-' || a[0] === '/') && p.length >= min && full.startsWith(p);
};
const PS_VALUE_PARAMS = [['executionpolicy', 2], ['ep', 2], ['windowstyle', 1], ['outputformat', 1], ['of', 2], ['inputformat', 1],
  ['if', 2], ['configurationname', 4], ['workingdirectory', 2], ['wd', 2], ['psconsolefile', 2], ['version', 1], ['settingsfile', 2], ['custompipename', 2]];

// powershell -Command <text...> (the rest of the line is the command); powershell.exe also takes a bare
// first argument as a command. -File, -EncodedCommand and pwsh's bare first argument (a file) are gaps.
function unwrapPowerShell(name, args, depth, hits) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (isParam(a, 'command')) {
      const text = args.slice(i + 1).join(' ');
      if (text !== '-') checkScript(text, 'ps', depth, hits);
      return;
    }
    if (isParam(a, 'encodedcommand') || a.toLowerCase() === '-ec' || isParam(a, 'file')) return;
    if (PS_VALUE_PARAMS.some(([p, min]) => isParam(a, p, min))) { i++; continue; }
    if (a.startsWith('-') || a.startsWith('/')) continue;
    if (name === 'powershell') checkScript(args.slice(i).join(' '), 'ps', depth, hits);
    return;
  }
}

// cmd /c <text...> or /k <text...>.
function unwrapCmd(args, depth, hits) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\/[ck]/i.test(a)) {
      checkScript([a.slice(2), ...args.slice(i + 1)].join(' ').trim(), 'cmd', depth, hits);
      return;
    }
    if (!a.startsWith('/')) return;
  }
}

const START_VALUE_PARAMS = ['workingdirectory', 'verb', 'windowstyle', 'redirectstandardoutput', 'redirectstandarderror',
  'redirectstandardinput', 'credential', 'environment'];

// Start-Process <file> <args> / -FilePath <file> -ArgumentList a,b or "a b" (also cmd's start).
function unwrapStartProcess(args, depth, hits) {
  let file = null;
  const argv = [];
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (isParam(a, 'filepath') || /^-(?:ps)?path$/i.test(a)) { file = args[++i] ?? null; continue; }
    if (isParam(a, 'argumentlist') || /^-args$/i.test(a)) { argv.push(args[++i] ?? ''); continue; }
    if (a.startsWith('-') && START_VALUE_PARAMS.some((p) => isParam(a, p, 2))) { i++; continue; }
    if (a.startsWith('-') || /^\/[a-z]+$/i.test(a)) continue;
    pos.push(a);
  }
  if (file === null) { while (pos.length && pos[0] === '') pos.shift(); file = pos.shift() ?? null; }
  if (!file) return;
  const rest = [...pos, ...argv].flatMap((v) => v.split(/[\s,]+/)).filter(Boolean);
  checkWords([file, ...rest], depth + 1, hits);
}

// ---------------------------------------------------------------------------------------------------
// Decision

const CODEX_SHELL_TOOLS = new Set(['shell', 'local_shell', 'shell_command', 'exec_command', 'unified_exec', 'container.exec']);

function dialectsFor(tool, platform) {
  const t = tool.toLowerCase();
  const shell = t === 'bash' || t === 'powershell' || CODEX_SHELL_TOOLS.has(t);
  if (!shell) return null;
  if (platform === 'codex' || CODEX_SHELL_TOOLS.has(t)) return ['bash', 'ps'];
  return t === 'bash' ? ['bash'] : ['ps'];
}

/**
 * Rule-1 hits of one command: a string is parsed in each dialect (a hit in any of them counts; it is an
 * error only when no dialect parses it); an argv array is one command as given.
 * @param {string|string[]} command
 * @param {Array<'bash'|'ps'|'cmd'>} dialects
 * @returns {string[]} what the command would push or publish, without duplicates
 */
export function checkCommand(command, dialects) {
  const hits = [];
  if (Array.isArray(command)) { checkWords(command, 0, hits); return [...new Set(hits)]; }
  let parsed = 0;
  let lastError = null;
  for (const d of dialects) {
    try {
      for (const seg of parseScript(command, d)) checkWords(seg, 0, hits);
      parsed++;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      lastError = e;
    }
  }
  if (!parsed) throw lastError;
  return [...new Set(hits)];
}

/** The deny reason: what was stopped and what to do instead (ADR-006 §2.5 and §4). */
export function denyReason(hits) {
  return `AutoSkills 守卫拒绝了这条命令：${hits.join('、')} 会推送或发布到远端，代理不做这类操作。`
    + '推送由你自己在普通终端做（“你”指用户本人），例如 git push <完整地址> <分支>；GitHub 和 npm 的写操作也由用户本人做。'
    + '代理不要换写法重试：把要推送或发布的分支、提交写进汇报，接着做不受影响的工作。';
}

/** Platform of a hook input when --platform is not given. */
export function detectPlatform(input) {
  const tp = typeof input?.transcript_path === 'string' ? input.transcript_path.replace(/\\/g, '/') : '';
  if ('turn_id' in (input ?? {}) || tp.includes('/.codex/')) return 'codex';
  if ('permission_mode' in (input ?? {}) || tp.includes('/.claude/')) return 'claude';
  return 'unknown';
}

/**
 * Decide one PreToolUse input.
 * @param {object} input the hook input JSON
 * @param {string} platform claude, codex or unknown
 * @returns {{decision: 'allow'|'deny', reason?: string}}
 * @throws {ParseError} when the input or the command cannot be read
 */
export function decide(input, platform) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ParseError('钩子输入不是 JSON 对象');
  const event = input.hook_event_name ?? 'PreToolUse';
  if (event !== 'PreToolUse') return { decision: 'allow' };
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const dialects = dialectsFor(tool, platform);
  if (!dialects) return { decision: 'allow' };
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = ti.command ?? ti.cmd;
  const argv = Array.isArray(command) && command.length && command.every((x) => typeof x === 'string');
  if (typeof command !== 'string' && !argv) throw new ParseError(`${tool} 调用没有可读的命令文本`);
  const hits = checkCommand(command, dialects);
  return hits.length ? { decision: 'deny', reason: denyReason(hits) } : { decision: 'allow' };
}

// ---------------------------------------------------------------------------------------------------
// Local config, heartbeat, selftest, main

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`读不了本地配置 "${file}"（${e.code || e.message}）`);
  }
  let cfg;
  try { cfg = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error(`本地配置 "${file}" 不是合法的 JSON`); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`本地配置 "${file}" 不是 JSON 对象`);
  if (cfg.runtime !== undefined && (typeof cfg.runtime !== 'string' || !path.isAbsolute(cfg.runtime))) {
    throw new Error(`本地配置 "${file}" 里的 runtime 必须是绝对路径`);
  }
  return cfg;
}

function writeHeartbeat(config, entry) {
  if (!config?.runtime) return;
  const dir = path.join(config.runtime, 'hooks', 'heartbeat');
  const file = path.join(dir, `${HOOK_NAME}.jsonl`);
  const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (size + line.length > HEARTBEAT_MAX) truncateHeartbeat(file);
    fs.appendFileSync(file, line);
  } catch (e) {
    process.stderr.write(`guard: note: heartbeat not written to "${file}" (${e.code || e.message})\n`);
  }
}

// Keep the newest HEARTBEAT_KEEP bytes, starting at a line boundary.
function truncateHeartbeat(file) {
  const buf = fs.readFileSync(file);
  let start = Math.max(0, buf.length - HEARTBEAT_KEEP);
  if (start > 0) {
    const nl = buf.indexOf(0x0a, start - 1);
    start = nl < 0 ? buf.length : nl + 1;
  }
  const kept = buf.subarray(start);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, kept);
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, kept);
  }
}

// Built-in samples for --selftest: [tool, command, expected decision, platform].
export const SELFTEST = [
  ['Bash', 'git status', 'allow', 'claude'],
  ['Bash', 'git commit -m "docs: why git push is blocked"', 'allow', 'claude'],
  ['Bash', 'gh pr view 12', 'allow', 'claude'],
  ['Bash', 'gh api repos/acme/demo/pulls', 'allow', 'claude'],
  ['Bash', 'gh api -X GET search/issues -f q=demo', 'allow', 'claude'],
  ['Bash', 'git push origin main', 'deny', 'claude'],
  ['Bash', 'git -C ../demo -c core.quotepath=off push', 'deny', 'claude'],
  ['Bash', 'cd demo && npm test; git.exe push https://example.com/acme/demo.git HEAD', 'deny', 'claude'],
  ['Bash', 'bash -lc "git --git-dir=.git push"', 'deny', 'claude'],
  ['Bash', 'gh pr create --fill', 'deny', 'claude'],
  ['Bash', 'gh api repos/acme/demo/issues -f title=x', 'deny', 'claude'],
  ['Bash', 'npm publish --access public', 'deny', 'claude'],
  ['PowerShell', 'git status; git log -3 --oneline', 'allow', 'claude'],
  ['PowerShell', "& 'C:\\Program Files\\Git\\cmd\\git.exe' push", 'deny', 'claude'],
  ['PowerShell', 'Start-Process git -ArgumentList "push origin main"', 'deny', 'claude'],
  ['PowerShell', 'gh release create v1.0.0', 'deny', 'claude'],
  ['PowerShell', 'gh api --method DELETE repos/acme/demo', 'deny', 'claude'],
  ['shell', 'powershell -NoProfile -Command "git push"', 'deny', 'codex'],
  ['shell', 'gh workflow list', 'allow', 'codex'],
];

function selftest() {
  let failed = 0;
  for (const [tool, command, expected, platform] of SELFTEST) {
    let got;
    try {
      got = decide({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }, platform).decision;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      got = 'error';
    }
    if (got !== expected) {
      failed++;
      console.log(`guard selftest: FAIL ${tool} ${JSON.stringify(command)}: expected ${expected}, got ${got}`);
    }
  }
  console.log(failed ? `guard selftest: ${failed} of ${SELFTEST.length} failed` : `guard selftest: ok (${SELFTEST.length} samples)`);
  return failed ? 1 : 0;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: { selftest: { type: 'boolean' }, platform: { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }).values;
    if (opts.platform !== undefined && !PLATFORMS.has(opts.platform)) throw new Error(`unknown platform ${JSON.stringify(opts.platform)}`);
  } catch (e) {
    process.stderr.write(`guard: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.selftest) return selftest();

  let config;
  try {
    config = loadConfig(path.resolve(opts.config ?? path.join(path.dirname(SELF), CONFIG_NAME)));
  } catch (e) {
    process.stderr.write(`AutoSkills 守卫出错，已按失败处理：${e.message}\n`);
    return 2;
  }

  let platform = opts.platform ?? 'unknown';
  let event = 'PreToolUse';
  let decision = 'error';
  let out = '';
  let code = 2;
  try {
    let input;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new ParseError('钩子输入不是合法的 JSON'); }
    platform = opts.platform ?? detectPlatform(input);
    // The event name is recorded only when it looks like one; the heartbeat never carries free text.
    const ev = input?.hook_event_name;
    event = typeof ev === 'string' && /^[A-Za-z]{1,40}$/.test(ev) ? ev : ev === undefined ? 'PreToolUse' : 'unknown';
    const r = decide(input, platform);
    decision = r.decision;
    code = 0;
    if (r.decision === 'deny') {
      out = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } })}\n`;
    }
  } catch (e) {
    const why = e instanceof ParseError ? e.message : `内部错误（${e.message}）`;
    process.stderr.write(`AutoSkills 守卫无法判断这次调用，已按失败处理：${why}。请把命令改写成引号成对的简单命令后再试。\n`);
  }
  writeHeartbeat(config, { ts: new Date().toISOString(), platform, event, decision });
  if (out) process.stdout.write(Buffer.from(out, 'utf8'));
  return code;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]), b = SELF;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
