#!/usr/bin/env node
// guard: the AutoSkills PreToolUse guard for Claude Code and Codex (ADR-006 §2.5). Zero dependencies
// (Node >= 18).
//
// Usage (the hook registration is one fixed command line; the logic lives in this file, so changing it does
// not need the hook to be trusted again). Claude registers <node> as the command and the script and options
// as args; Codex gets one string whose first word, the portable Node path, is not quoted and whose script
// path is (config/codex/hooks.json):
//   <node> "<runtime>/hooks/guard.mjs" [--platform claude|codex] [--config <file>]
//   <node> "<runtime>/hooks/guard.mjs" --selftest
//
// Input: the PreToolUse JSON on stdin.
//   Claude: tool_name Bash or PowerShell, tool_input.command a string, parsed in that tool's syntax;
//   Edit, Write, MultiEdit (tool_input.file_path) and NotebookEdit (tool_input.notebook_path) for rule 2;
//   mcp__project-manager__<tool> for rule 3, with agent_id set only inside a subagent. C0 E2 (2026-10-31):
//   all 49 workflow-agent PreToolUse inputs carried agent_id and agent_type, so rule 3 holds for workflow
//   agents too; the main session's inputs have neither key.
//   Codex (C0 T-meta, codex-cli 0.166): PreToolUse brings session_id, turn_id, transcript_path, cwd,
//   hook_event_name, model, permission_mode, tool_name, tool_input and tool_use_id, and in a child thread
//   also agent_id and agent_type (the root thread has neither). A shell call is tool_name Bash with
//   tool_input.command the raw string the model wrote, often PowerShell (no argv, no powershell -Command
//   wrapper), so under codex a string is parsed as both Bash and PowerShell and a deny in either wins. MCP
//   tools are mcp__<server>__<tool> with the server's - turned into _ (mcp__project_manager__...); spawn
//   and wait (collaborationspawn_agent, collaborationwait_agent) are allowed. The other shell-like names
//   (PowerShell, shell, local_shell, shell_command, exec_command, unified_exec, container.exec, and
//   tool_input.cmd or an argv array) were not seen in C0 and stay as a fallback for other Codex builds.
//   apply_patch is read from tool_input (a string), tool_input.command, .input or .patch (the patch text,
//   or an argv array ["apply_patch", "<patch>"]); C0 captured no real apply_patch input, so these shapes
//   are untested. A project-manager tool is any tool_name that ends in project-manager (or
//   project_manager) plus __ . / or : and the tool, or a tool_input.server naming project-manager. The
//   hook process has no CODEX_THREAD_ID: identity comes only from the input (session_id, agent_id).
//   The platform comes from --platform, else from the input (turn_id or a .codex transcript: codex;
//   permission_mode or a .claude transcript: claude; Codex sends permission_mode too, turn_id wins).
//   Other tools and other events are allowed. Reads of customer data folders are not checked here: Read
//   is called often and each hook run starts Node (about 90 ms), so that stays with the settings deny rules.
// Output: nothing on allow, so the normal permission flow goes on. On deny, one UTF-8 JSON line, exit 0:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
//   Codex honoured this deny live in C0 in one case only (root thread, an MCP tool, the hook exit 0);
//   child threads, Bash and apply_patch were not covered.
//   On ask (a git push on Claude, see Rule 1), the same line with permissionDecision "ask", exit 0: Claude
//   shows the reason in a confirmation dialog and runs the call only after the owner's yes.
// Errors: unknown option, stdin is not a JSON object, a shell call has no command text or does not parse
// (unterminated quote, $( ... ), block comment, here-string), a write tool has neither a target path nor a
// readable patch while read-only folders are registered, the local config exists but cannot be read, or
// anything else throws. The reason always goes to stderr. Errors fail closed on both platforms (owner
// decision 2026-10-31, "出错即拦截"), each in the way its platform blocks:
//   - Claude (and any run without --platform codex): exit 2, nothing on stdout; Claude registers the guard
//     with onFailure: "block".
//   - --platform codex (the Codex registration): the deny JSON above, exit 0. Its reason starts with
//     ERROR_DENY_MARK, then names the error. Codex blocks on exit 2 only, and Windows PowerShell 5.1 -Command
//     turns a native exit 2 into 1 (AS3-125), while exit 0 with the JSON passes through every shell
//     unchanged and Codex honoured that JSON in C0. Which shell Codex runs hooks in is not known.
// Exit codes: 0 = decided (allow or deny), or an error under --platform codex. 2 = an error otherwise.
// So a broken hook-config.json blocks every matched call until it is fixed; check-kit validates that file
// and reports a failing selftest and a missing or old heartbeat. A guard that never starts is not covered
// by this: a missing Node, a load or syntax error in this file (Node exits 1) or a shell that cannot find
// the command gives no JSON and another exit code than 2, which Claude blocks (onFailure: "block") and
// Codex lets through (ADR-006 §4). check-kit runs the registered command lines with a synthetic allow and
// deny input to find that case.
//
// Local config: hook-config.json next to this script, written at deploy time from the git-excluded local
// kit config; --config names another file (tests use temp dirs). The repo holds only the placeholder
// hook-config.example.json. Shape: {"runtime": "<absolute runtime dir>", "readonly_dirs": ["<absolute
// dir>", ...], "kit_repo": "<absolute AutoSkills checkout>"}, every key optional; other keys are ignored.
// A missing file means no heartbeat and no read-only folders; a file that exists but cannot be read or
// parsed, or holds a relative path, is an error.
// Heartbeat: every run except --selftest appends one line to <runtime>/hooks/heartbeat/guard.jsonl with
// exactly {ts, platform, event, decision} (decision: allow, deny, ask or error), never the command text, so
// the check script can tell the hook really ran. When the next line would take the file past 1 MiB, the
// file is first cut to its newest 512 KiB of whole lines. A heartbeat that cannot be written is a stderr
// note, never a block. With AUTOSKILLS_GUARD_PROBE=1 in the environment no heartbeat is written: check-kit
// sets it for its live run of the command line, which must not pass for a real tool call (it changes
// nothing else; a hook process that had it set would only lose its heartbeat, which check-kit reports).
// --selftest runs the built-in samples in memory: it reads no stdin and no config and writes no file
// (the rule 2 and 4 samples name folders under the OS temp dir that are never created).
// Exit 0 = every sample gave the expected decision.
//
// Parsing: Bash, PowerShell and cmd text is split into simple commands at ; && || | & and newlines,
// ( ) groups, { } blocks and $( ) @( ) `...` substitutions (also inside double quotes). Quotes and escapes
// are removed (bash $'...' with its backslash escapes, \' included), comments skipped, redirections
// dropped. Here-doc and here-string bodies are skipped too, read as data: that is exact only for a quoted
// bash here-doc (<<'EOF') and a PowerShell @'...'@ here-string. In an unquoted here-doc (<<EOF) bash still
// runs $( ) and backtick substitutions, and in an @"..."@ here-string PowerShell still runs $( ) (a
// backtick there is only PowerShell's escape character), so a push written there runs unseen (ADR-006 §4;
// reading the bodies would block everyday doc and commit-message commands). The repo's pushurl = no_push
// is what stops that push. Each command is
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
//   A git push is asked, not denied, when all of this holds (owner decisions 2026-11-20 and 2026-11-21):
//   the platform is claude, the input's permission_mode is one of ASK_MODES, every rule-1 hit of the
//   command is a git push (no gh write, no npm publish beside it) and rule 4 does not hit. Everything else
//   is denied as before: Codex (its hooks do not support ask and would run the call), an unknown platform,
//   dontAsk, a missing or unknown permission_mode. In a headless session nobody can answer the dialog and
//   Claude refuses the asked call (measured in all six modes, docs/push-consent-probe.md), so an unattended
//   run still cannot push.
//
// Rule 2, read-only folders: Edit, Write, MultiEdit, NotebookEdit and apply_patch (every Add, Update,
//   Delete and Move to path of the patch; an Edit-like call without its path field is read as a patch)
//   are denied when the target lies in a registered read-only folder (readonly_dirs). Both sides are compared by real path: relative targets are resolved against
//   the input cwd, junctions and symlinks are resolved on the longest existing part of the path (a new
//   file under a linked folder counts), and on Windows case and / versus \ do not matter.
// Rule 3, the ledger belongs to the main session (v2 §3.7 item 2): a call that carries agent_id (a
//   subagent) to a project-manager tool other than the read tools in LEDGER_READS is denied; that covers
//   every write tool, set_project_dir and tools the guard does not know. The main session, which has no
//   agent_id, is never stopped here.
// Rule 4, git clean in the AutoSkills repo (added beyond the v2/v3 list, ADR-006 §2.5; delete it freely):
//   git clean with -x or -X (also inside a cluster such as -fdx, after -c alias expansion and in wrapped
//   shells) is denied when it would run in an AutoSkills checkout: the git root around the cwd, a cd,
//   pushd or Set-Location target in the same command, or the -C, --git-dir and --work-tree directories,
//   carries hooks/guard.mjs and scripts/lint-kit.mjs, or is the configured kit_repo. It would wipe the
//   runtime, the deploy backups and the measurement data in _private/, and with them the rollback.
//   git clean -n (--dry-run) deletes nothing and stays allowed, so does git clean without -x or -X.
//
// Known gaps, ADR-006 §4 residual risks. The guard does not pretend to catch them:
//   - indirect execution: a push written into a script file and then run (bash push.sh, ./push.ps1,
//     pwsh -File), Invoke-Expression, encoded commands (-EncodedCommand);
//   - commands built at run time: variables ($g push, & $git push), substitutions that produce the
//     subcommand (git $(echo push)), git and gh aliases defined outside the command.
//   - $( ) and backtick substitutions inside an unquoted bash here-doc, and $( ) inside a PowerShell
//     @"..."@ here-string body (see Parsing above); pushurl = no_push is the backstop.
//   - writes into a read-only folder through a shell command (Bash, PowerShell, a patch fed to apply_patch
//     through a shell here-doc): rule 2 sees only the write tools.
//   - Codex tools the hooks.json matcher does not send here, such as mcp__node_repl__js and
//     mcp__artifact_session__js, which can run code that writes files (C0 T-role; whether the guard should
//     cover them is the owner's call, ADR-006 §7).
//   - a subagent call without agent_id would look like the main session to rule 3; C0 E2 found none.
//   On one Windows account the guard only prevents mistakes; it cannot stop a deliberate bypass.
import fs from 'node:fs';
import os from 'node:os';
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
/** Set to 1 by check-kit's live run of the hook command line: no heartbeat line (see Heartbeat above). */
export const PROBE_ENV = 'AUTOSKILLS_GUARD_PROBE';

/** Start of the deny reason of a failed run under --platform codex; check-kit tells it from a rule deny by it. */
export const ERROR_DENY_MARK = 'AutoSkills 守卫出错，按负责人定的出错即拦截处理';

/** A command or input the guard cannot read; the run fails closed (exit 2, or the deny JSON on Codex). */
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
    if (bash && c === '$' && d === "'") { const r = readAnsiC(src, i + 1); word = (word ?? '') + r.text; i = r.end; continue; }
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

// Bash ANSI-C quoting $'...' (i is at the opening quote): backslash escapes as bash expands them, so
// $'it\'s' is one word and $'\x70ush' reads as push. A quote without its closer is still an error.
const ANSI_C_SIMPLE = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};
function readAnsiC(src, i) {
  let text = '';
  let j = i + 1;
  for (;;) {
    if (j >= src.length) throw new ParseError('单引号没有结束');
    const ch = src[j];
    if (ch === "'") return { text, end: j + 1 };
    if (ch !== '\\') { text += ch; j++; continue; }
    const nx = src[j + 1];
    if (nx === undefined) throw new ParseError('单引号没有结束');
    if (Object.hasOwn(ANSI_C_SIMPLE, nx)) { text += ANSI_C_SIMPLE[nx]; j += 2; continue; }
    let m;
    if ((m = /^[0-7]{1,3}/.exec(src.slice(j + 1, j + 4)))) { text += String.fromCharCode(parseInt(m[0], 8) & 0xff); j += 1 + m[0].length; continue; }
    const hex = { x: 2, u: 4, U: 8 }[nx];
    if (hex && (m = new RegExp(`^[0-9A-Fa-f]{1,${hex}}`).exec(src.slice(j + 2, j + 2 + hex)))) {
      const cp = parseInt(m[0], 16);
      text += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      j += 2 + m[0].length;
      continue;
    }
    if (nx === 'c' && j + 2 < src.length && src[j + 2] !== "'") { text += String.fromCharCode(src.charCodeAt(j + 2) & 0x1f); j += 3; continue; }
    text += ch + nx; // an unknown escape stays as written
    j += 2;
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
const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

/**
 * What the commands of one shell call would do, as far as the rules care.
 * @typedef {object} Findings
 * @property {string[]} hits rule-1 hits: what would be pushed or published (e.g. "git push")
 * @property {Array<{cdirs: string[], extra: string[]}>} cleans rule 4: each git clean with -x or -X and
 *   no -n, with its -C directories (in order) and its --git-dir and --work-tree values
 * @property {string[]} dirs cd, pushd and Set-Location targets anywhere in the call
 */

/** An empty Findings record. */
export const newFindings = () => ({ hits: [], cleans: [], dirs: [] });

/**
 * Check one simple command and record what it would do in acc.
 * @param {string[]} words the command and its arguments
 * @param {number} depth nesting depth (bounded by MAX_DEPTH)
 * @param {Findings} acc collected findings
 */
export function checkWords(words, depth, acc) {
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
  if (name === 'git') checkGit(args, depth, acc);
  else if (name === 'gh') checkGh(args, acc.hits);
  else if (name === 'npm') checkNpm(args, acc.hits);
  else if (CD_COMMANDS.has(name)) recordCd(args, acc);
  else if (BASH_SHELLS.has(name)) unwrapBash(args, depth, acc);
  else if (PS_SHELLS.has(name)) unwrapPowerShell(name, args, depth, acc);
  else if (name === 'cmd') unwrapCmd(args, depth, acc);
  else if (START_PROCESS.has(name)) unwrapStartProcess(args, depth, acc);
}

// cd <dir>, cd /d <dir> (cmd), Set-Location [-Path|-LiteralPath] <dir>; a bare cd goes home.
function recordCd(args, acc) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (isParam(a, 'path', 2) || isParam(a, 'literalpath', 2)) { if (args[i + 1] !== undefined) acc.dirs.push(args[i + 1]); return; }
    if (a === '-' || a === '--' || (a.length > 1 && a.startsWith('-')) || /^\/d$/i.test(a)) continue;
    acc.dirs.push(a);
    return;
  }
  acc.dirs.push('~');
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

function checkScript(text, dialect, depth, acc) {
  for (const seg of parseScript(text, dialect, depth + 1)) checkWords(seg, depth + 1, acc);
}

function checkGit(args, depth, acc) {
  const aliases = new Map();
  const cdirs = []; // -C directories, each relative to the one before
  const extra = []; // --git-dir and --work-tree values
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    const eq = /^(--git-dir|--work-tree)=([\s\S]*)$/.exec(a);
    if (eq) { extra.push(eq[2]); continue; }
    if (GIT_VALUE_OPTS.has(a)) {
      const v = args[++i] ?? '';
      const m = a === '-c' ? /^alias\.([^=]+)=([\s\S]*)$/i.exec(v) : null;
      if (m) aliases.set(m[1].toLowerCase(), m[2]);
      if (a === '-C' && v) cdirs.push(v);
      if (a === '--git-dir' || a === '--work-tree') extra.push(v);
      continue;
    }
    if (!a.startsWith('-')) break;
  }
  if (i >= args.length) return;
  let sub = args[i].toLowerCase();
  let rest = args.slice(i + 1);
  if (aliases.has(sub)) {
    const v = aliases.get(sub).trim();
    if (v.startsWith('!')) { checkScript(v.slice(1), 'bash', depth, acc); return; }
    const words = v.split(/\s+/);
    sub = words[0].toLowerCase();
    rest = [...words.slice(1), ...rest];
  }
  if (GIT_PUSH.has(sub)) acc.hits.push(`git ${sub}`);
  else if ((sub === 'subtree' || sub === 'lfs') && rest.some((a) => a.toLowerCase() === 'push')) acc.hits.push(`git ${sub} push`);
  else if (sub === 'clean' && cleansIgnored(rest)) acc.cleans.push({ cdirs, extra });
}

// git clean options: true when -x or -X is given and -n/--dry-run is not. -e takes a value (the rest of
// a cluster, or the next word), so -ex excludes the pattern "x"; after -- come pathspecs.
function cleansIgnored(args) {
  let ignored = false;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a === '--dry-run') { dry = true; continue; }
    if (a === '--exclude') { i++; continue; }
    if (a.startsWith('--') || !a.startsWith('-') || a === '-') continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (c === 'e') { if (j === a.length - 1) i++; break; }
      if (c === 'x' || c === 'X') ignored = true;
      else if (c === 'n') dry = true;
    }
  }
  return ignored && !dry;
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
function unwrapBash(args, depth, acc) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '+o') { i++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { if (args[i + 1] !== undefined) checkScript(args[i + 1], 'bash', depth, acc); return; }
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
function unwrapPowerShell(name, args, depth, acc) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (isParam(a, 'command')) {
      const text = args.slice(i + 1).join(' ');
      if (text !== '-') checkScript(text, 'ps', depth, acc);
      return;
    }
    if (isParam(a, 'encodedcommand') || a.toLowerCase() === '-ec' || isParam(a, 'file')) return;
    if (PS_VALUE_PARAMS.some(([p, min]) => isParam(a, p, min))) { i++; continue; }
    if (a.startsWith('-') || a.startsWith('/')) continue;
    if (name === 'powershell') checkScript(args.slice(i).join(' '), 'ps', depth, acc);
    return;
  }
}

// cmd /c <text...> or /k <text...>.
function unwrapCmd(args, depth, acc) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\/[ck]/i.test(a)) {
      checkScript([a.slice(2), ...args.slice(i + 1)].join(' ').trim(), 'cmd', depth, acc);
      return;
    }
    if (!a.startsWith('/')) return;
  }
}

const START_VALUE_PARAMS = ['workingdirectory', 'verb', 'windowstyle', 'redirectstandardoutput', 'redirectstandarderror',
  'redirectstandardinput', 'credential', 'environment'];

// Start-Process <file> <args> / -FilePath <file> -ArgumentList a,b or "a b" (also cmd's start).
function unwrapStartProcess(args, depth, acc) {
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
  checkWords([file, ...rest], depth + 1, acc);
}

// ---------------------------------------------------------------------------------------------------
// Paths (rules 2 and 4)

const WIN = process.platform === 'win32';

/**
 * A path as the file system sees it, resolved against base: ~ is the home folder, and on Windows a Git
 * Bash drive path such as /<drive>/<dir> is <drive>:/<dir>.
 * @param {string} p path as written in the call
 * @param {string} base absolute directory for relative paths
 * @returns {string}
 */
export function toFsPath(p, base) {
  let s = String(p);
  if (s === '~' || /^~[\\/]/.test(s)) s = path.join(os.homedir(), s.slice(1));
  else if (WIN) {
    const m = /^\/([A-Za-z])(?=\/|$)/.exec(s);
    if (m) s = `${m[1]}:${s.slice(2) || '/'}`;
  }
  return path.resolve(base, s);
}

/**
 * Real path: junctions and symlinks resolved on the longest existing part of p, the rest kept as
 * written, so a new file under a linked folder maps into the link target.
 * @param {string} p absolute path
 * @returns {string}
 */
export function realPath(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    let real = null;
    try { real = fs.realpathSync.native(cur); } catch { /* missing or unreadable: try the parent */ }
    if (real !== null) return path.join(real.replace(/^\\\\\?\\(?=[A-Za-z]:)/, ''), ...rest.reverse());
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = parent;
  }
}

// Comparison key: the real path, on Windows in lower case (path.join already uses backslashes there).
const pathKey = (p) => (WIN ? realPath(p).toLowerCase() : realPath(p));

function within(key, rootKey) {
  if (key === rootKey) return true;
  return key.startsWith(rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep);
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

// The nearest directory at or above dir that holds .git, or null.
function gitRoot(dir) {
  for (let cur = dir; ;) {
    if (exists(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// ---------------------------------------------------------------------------------------------------
// Rules 2-4

const EDIT_TOOLS = { edit: ['file_path'], write: ['file_path'], multiedit: ['file_path'], notebookedit: ['notebook_path', 'file_path'] };
const PATCH_TOOLS = new Set(['apply_patch']);
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/**
 * File paths of an apply_patch text: every Add File, Update File, Delete File and Move to header.
 * @param {string} text the patch
 * @returns {string[]}
 */
export function patchPaths(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = PATCH_HEADER.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// Paths a write tool call would write, as written in the call. An Edit-like call without its path field
// is read like apply_patch (Codex may send a patch under Edit or Write; C0 captured no such input), so
// only a call with neither a path nor a patch header is an error.
function writeTargets(tool, raw) {
  const t = tool.toLowerCase();
  const ti = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (EDIT_TOOLS[t]) {
    const p = EDIT_TOOLS[t].map((k) => ti[k]).find((v) => typeof v === 'string' && v !== '');
    if (p) return [p];
  }
  for (const v of typeof raw === 'string' ? [raw] : [ti.command, ti.input, ti.patch]) {
    const text = Array.isArray(v) && v.length > 1 && programName(String(v[0])) === 'apply_patch' ? v[1] : v;
    if (typeof text !== 'string') continue;
    const paths = patchPaths(text);
    if (paths.length) return paths;
  }
  if (EDIT_TOOLS[t]) throw new ParseError(`${tool} 调用没有可读的目标路径，也没有可读的补丁`);
  throw new ParseError(`${tool} 调用里读不出要改的文件路径`);
}

// project-manager 1.5.1 tools that only read. Every other tool of that server writes the ledger or, like
// set_project_dir, switches it for the whole session; tools added later count as writes until listed.
const LEDGER_READS = new Set(['get_all_tasks', 'get_architecture', 'get_current_focus', 'get_logs', 'get_next_task',
  'get_portfolio', 'get_prd', 'get_project_context', 'get_project_info', 'get_server_info', 'get_task_by_id',
  'get_verification_profiles', 'lint_state']);

/**
 * The project-manager tool a call names (lower case), or null for any other tool.
 * @param {string} tool tool_name of the call
 * @param {object} ti tool_input of the call
 * @returns {string|null}
 */
export function ledgerTool(tool, ti) {
  const m = /project[-_]manager(?:__|[./:])([A-Za-z0-9_]+)$/i.exec(tool);
  if (m) return m[1].toLowerCase();
  const server = [ti.server, ti.server_name, ti.mcp_server].find((v) => typeof v === 'string');
  if (!server || !/^project[-_]manager$/i.test(server)) return null;
  const name = [ti.tool, ti.tool_name, ti.name].find((v) => typeof v === 'string') ?? tool;
  return name.split(/__|[./:]/).pop().toLowerCase() || '?';
}

const KIT_MARKERS = [['hooks', 'guard.mjs'], ['scripts', 'lint-kit.mjs']];

/**
 * True when a command run in dir works on an AutoSkills checkout: the git root around dir carries the
 * kit markers, or dir lies in a configured kit repo and not in a nested repo below it.
 * @param {string} dir absolute directory
 * @param {string[]} [kitRepos] configured AutoSkills checkouts (kit_repo)
 * @returns {boolean}
 */
export function inKitRepo(dir, kitRepos = []) {
  const real = realPath(dir);
  const root = gitRoot(real);
  if (root && KIT_MARKERS.every((m) => exists(path.join(root, ...m)))) return true;
  const key = pathKey(real);
  const rootKey = root && pathKey(root);
  return kitRepos.some((k) => {
    const kk = pathKey(k);
    return within(key, kk) && !(rootKey && rootKey !== kk && within(rootKey, kk));
  });
}

// Rule 4: does any recorded git clean -x/-X run in an AutoSkills checkout? Each clean is tried from the
// cwd and from every cd target of the call, then through its -C chain and its --git-dir/--work-tree.
function cleanInKit(found, cwd, kitRepos) {
  const bases = [cwd, ...found.dirs.map((d) => toFsPath(d, cwd))];
  for (const c of found.cleans) {
    for (const b of bases) {
      const at = c.cdirs.reduce((dir, d) => toFsPath(d, dir), b);
      for (const dir of [at, ...c.extra.map((e) => toFsPath(e, at))]) if (inKitRepo(dir, kitRepos)) return true;
    }
  }
  return false;
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
 * Findings of one command: a string is parsed in each dialect (a finding in any of them counts; it is an
 * error only when no dialect parses it); an argv array is one command as given.
 * @param {string|string[]} command
 * @param {Array<'bash'|'ps'|'cmd'>} dialects
 * @returns {Findings} rule-1 hits without duplicates, rule-4 cleans and cd targets
 */
export function checkCommand(command, dialects) {
  const acc = newFindings();
  if (Array.isArray(command)) checkWords(command, 0, acc);
  else {
    let parsed = 0;
    let lastError = null;
    for (const d of dialects) {
      try {
        for (const seg of parseScript(command, d)) checkWords(seg, 0, acc);
        parsed++;
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        lastError = e;
      }
    }
    if (!parsed) throw lastError;
  }
  acc.hits = [...new Set(acc.hits)];
  return acc;
}

/** The rule-1 deny reason: what was stopped and what to do instead (ADR-006 §2.5 and §4). */
export function denyReason(hits) {
  return `AutoSkills 守卫拒绝了这条命令：${hits.join('、')} 会推送或发布到远端。`
    + '推送要用户本人在确认窗里点同意；这次调用弹不了确认窗（无人值守的会话、Codex、不支持的权限模式），或者同一条命令里还有发布或 GitHub 的写操作，所以直接拒绝。'
    + '用户本人可以在普通终端推送，例如 git push <完整地址> <分支>；GitHub 和 npm 的写操作由用户本人做。'
    + '代理不要换写法重试：把要推送或发布的分支、提交写进汇报，接着做不受影响的工作。';
}

/** The rule-1 ask reason, shown to the owner in the confirmation dialog. */
export function askReason(hits) {
  return `AutoSkills 守卫：这条命令里有 ${hits.join('、')}，会把提交推送到远端。`
    + '请看清上面的命令推到哪个地址、哪个分支；点同意才推送，点拒绝就不推。';
}

/** The rule-2 deny reason. */
export function readonlyReason(target, dir) {
  return `AutoSkills 守卫拒绝了这次写入："${target}" 按真实路径落在登记的只读目录 "${dir}" 里。`
    + '只读目录只读取、不修改，也不要换工具或换路径（链接、大小写、斜杠）重试。'
    + '需要改的内容和原因写进汇报，由用户本人处理；接着做不受影响的工作。';
}

/** The rule-3 deny reason. */
export function ledgerReason(tool) {
  const what = tool === 'set_project_dir' ? '它会改掉整个会话的账本目标' : '它会写账本';
  return `AutoSkills 守卫拒绝了这次调用：子代理不能调用 project-manager 的 ${tool}（${what}）。`
    + '只有主会话（Codex 里是根线程）写账本、认领任务和记录验收；子代理把结果交回主会话，由主会话来写。'
    + '读账本的工具照常可用，读时带上主检出的绝对路径。';
}

/** The rule-4 deny reason. */
export function cleanReason() {
  return 'AutoSkills 守卫拒绝了这条命令：在 AutoSkills 仓库里，带 -x 或 -X 的 git clean 会删掉 _private/ 里的运行区、部署备份和测量数据，回滚就没了。'
    + '要看会删什么用 git clean -n；要清未跟踪的文件用不带 -x、-X 的 git clean -fd，或者指定路径删除。';
}

/** Platform of a hook input when --platform is not given. */
export function detectPlatform(input) {
  const tp = typeof input?.transcript_path === 'string' ? input.transcript_path.replace(/\\/g, '/') : '';
  if ('turn_id' in (input ?? {}) || tp.includes('/.codex/')) return 'codex';
  if ('permission_mode' in (input ?? {}) || tp.includes('/.claude/')) return 'claude';
  return 'unknown';
}

const PARSE_HINT = '请把命令改写成引号成对的简单命令，写入工具要带目标路径，然后再试。';
const KIT_FAULT_HINT = '这是守卫本身或它的配置出了问题，不是这条命令的问题：不要换写法重试，把这句原因写进汇报，由用户本人修'
  + '（check-kit 会指出哪里坏了），接着做不受影响的工作。';

/** The deny reason of a failed run under --platform codex: ERROR_DENY_MARK, the error and what to do next. */
export function errorDenyReason(why, hint = KIT_FAULT_HINT) {
  return `${ERROR_DENY_MARK}，拦下了这次调用：${why}。${hint}`;
}

const ALLOW = Object.freeze({ decision: 'allow' });
const deny = (reason) => ({ decision: 'deny', reason });
const ask = (reason) => ({ decision: 'ask', reason });

/**
 * Claude permission modes in which a push is answered with "ask" (owner decisions 2026-11-20 and 2026-11-21).
 * Measured: in a headless session an asked call does not run in any of the six modes; in an interactive
 * bypassPermissions session the dialog appears and the call runs after a yes (docs/push-consent-probe.md).
 * dontAsk, a missing field and any other value stay a deny.
 */
export const ASK_MODES = new Set(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);

/** True for a rule-1 hit that is a git push (checkGit names them "git ..."); gh and npm hits are not. */
const isPushHit = (hit) => hit.startsWith('git ');

/**
 * Decide one PreToolUse input.
 * @param {object} input the hook input JSON
 * @param {string} platform claude, codex or unknown
 * @param {{readonlyDirs?: string[], kitRepos?: string[]}} [policy] registered read-only folders (rule 2)
 *   and AutoSkills checkouts (rule 4), from the local config
 * @returns {{decision: 'allow'|'deny'|'ask', reason?: string}} ask only for a push on platform claude in
 *   one of ASK_MODES
 * @throws {ParseError} when the input, the command or a write target cannot be read
 */
export function decide(input, platform, policy = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ParseError('钩子输入不是 JSON 对象');
  const event = input.hook_event_name ?? 'PreToolUse';
  if (event !== 'PreToolUse') return ALLOW;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const raw = input.tool_input;
  const ti = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cwd = toFsPath(typeof input.cwd === 'string' && input.cwd ? input.cwd : '.', process.cwd());

  const ledger = ledgerTool(tool, ti);
  if (ledger !== null) {
    const subagent = input.agent_id !== undefined && input.agent_id !== null && input.agent_id !== '';
    return subagent && !LEDGER_READS.has(ledger) ? deny(ledgerReason(ledger)) : ALLOW;
  }

  const t = tool.toLowerCase();
  if (EDIT_TOOLS[t] || PATCH_TOOLS.has(t)) {
    const readonly = policy.readonlyDirs ?? [];
    if (!readonly.length) return ALLOW;
    const roots = readonly.map((dir) => ({ dir, key: pathKey(toFsPath(dir, cwd)) }));
    for (const target of writeTargets(tool, raw)) {
      const key = pathKey(toFsPath(target, cwd));
      const hit = roots.find((r) => within(key, r.key));
      if (hit) return deny(readonlyReason(target, hit.dir));
    }
    return ALLOW;
  }

  const dialects = dialectsFor(tool, platform);
  if (!dialects) return ALLOW;
  const command = ti.command ?? ti.cmd;
  const argv = Array.isArray(command) && command.length && command.every((x) => typeof x === 'string');
  if (typeof command !== 'string' && !argv) throw new ParseError(`${tool} 调用没有可读的命令文本`);
  const found = checkCommand(command, dialects);
  const clean = found.cleans.length > 0 && cleanInKit(found, cwd, policy.kitRepos ?? []);
  // A push and nothing else that is refused: the owner decides in the confirmation dialog (see Rule 1).
  if (found.hits.length && !clean && found.hits.every(isPushHit) && platform === 'claude' && ASK_MODES.has(input.permission_mode)) {
    return ask(askReason(found.hits));
  }
  const reasons = [];
  if (found.hits.length) reasons.push(denyReason(found.hits));
  if (clean) reasons.push(cleanReason());
  return reasons.length ? deny(reasons.join('\n')) : ALLOW;
}

// ---------------------------------------------------------------------------------------------------
// Local config, heartbeat, selftest, main

/**
 * Read the local hook config (shared with hooks/session-start.mjs).
 * @param {string} file absolute path of hook-config.json
 * @returns {object|null} the config, or null when the file does not exist
 * @throws {Error} when the file exists but cannot be read or parsed, or holds a relative path
 */
export function loadConfig(file) {
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
  const absolute = (v) => typeof v === 'string' && path.isAbsolute(v);
  for (const key of ['runtime', 'kit_repo']) {
    if (cfg[key] !== undefined && !absolute(cfg[key])) throw new Error(`本地配置 "${file}" 里的 ${key} 必须是绝对路径`);
  }
  if (cfg.readonly_dirs !== undefined && !(Array.isArray(cfg.readonly_dirs) && cfg.readonly_dirs.every(absolute))) {
    throw new Error(`本地配置 "${file}" 里的 readonly_dirs 必须是绝对路径的数组`);
  }
  return cfg;
}

/** The rule policy of a loaded config (no config: no read-only folders, kit repos found by markers only). */
export function policyFrom(config) {
  return { readonlyDirs: config?.readonly_dirs ?? [], kitRepos: config?.kit_repo ? [config.kit_repo] : [] };
}

/**
 * Append one heartbeat line to <runtime>/hooks/heartbeat/<name>.jsonl; never throws.
 * @param {object|null} config the loaded config (no runtime: nothing is written)
 * @param {object} entry the line, exactly {ts, platform, event, decision}
 * @param {string} [name] hook name (file name and stderr prefix)
 */
export function writeHeartbeat(config, entry, name = HOOK_NAME) {
  if (!config?.runtime) return;
  const dir = path.join(config.runtime, 'hooks', 'heartbeat');
  const file = path.join(dir, `${name}.jsonl`);
  const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (size + line.length > HEARTBEAT_MAX) truncateHeartbeat(file);
    fs.appendFileSync(file, line);
  } catch (e) {
    process.stderr.write(`${name}: note: heartbeat not written to "${file}" (${e.code || e.message})\n`);
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

// Selftest folders: never created; rules 2 and 4 only read the file system, so missing folders are fine.
const ST_ROOT = path.join(os.tmpdir(), 'autoskills-guard-selftest');
const ST_READONLY = path.join(ST_ROOT, 'readonly');
const ST_KIT = path.join(ST_ROOT, 'kit');
const SELFTEST_POLICY = { readonlyDirs: [ST_READONLY], kitRepos: [ST_KIT] };
const ST_AGENT = { agent_id: 'selftest-agent', agent_type: 'general-purpose' };

// Built-in samples for --selftest: [tool, tool_input (a string is the command), expected decision,
// platform, extra input fields]. Rules 2 and 4 use SELFTEST_POLICY.
export const SELFTEST = [
  ['Bash', 'git status', 'allow', 'claude'],
  ['Bash', 'git commit -m "docs: why git push is blocked"', 'allow', 'claude'],
  ['Bash', 'gh pr view 12', 'allow', 'claude'],
  ['Bash', 'gh api repos/acme/demo/pulls', 'allow', 'claude'],
  ['Bash', 'gh api -X GET search/issues -f q=demo', 'allow', 'claude'],
  ['Bash', 'git push origin main', 'deny', 'claude'],
  // A push is asked on Claude when the input carries a permission mode that can show the dialog.
  ['Bash', 'git push https://example.com/acme/demo.git main', 'ask', 'claude', { permission_mode: 'default' }],
  ['PowerShell', "& 'C:\\Program Files\\Git\\cmd\\git.exe' -C ../demo push", 'ask', 'claude', { permission_mode: 'bypassPermissions' }],
  ['Bash', 'git push origin main', 'ask', 'claude', { permission_mode: 'auto' }],
  ['Bash', 'git push origin main', 'deny', 'claude', { permission_mode: 'dontAsk' }],
  ['Bash', 'git push origin main', 'deny', 'claude', { permission_mode: 'somethingNew' }],
  ['Bash', 'git push origin main', 'deny', 'codex', { permission_mode: 'default' }],
  ['Bash', 'git push origin main', 'deny', 'unknown', { permission_mode: 'default' }],
  ['Bash', 'git push origin main && npm publish', 'deny', 'claude', { permission_mode: 'default' }],
  ['Bash', 'git push origin main; gh pr create --fill', 'deny', 'claude', { permission_mode: 'default' }],
  ['Bash', 'npm publish --access public', 'deny', 'claude', { permission_mode: 'default' }],
  ['Bash', 'gh release create v1.0.0', 'deny', 'claude', { permission_mode: 'bypassPermissions' }],
  ['Bash', 'git clean -fdx && git push origin main', 'deny', 'claude', { permission_mode: 'default', cwd: ST_KIT }],
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
  ['Write', { file_path: path.join(ST_READONLY, 'notes.md'), content: 'x' }, 'deny', 'claude'],
  ['Edit', { file_path: path.join(ST_ROOT, 'readonly-copy', 'notes.md'), old_string: 'a', new_string: 'b' }, 'allow', 'claude'],
  ['apply_patch', { command: `*** Begin Patch\n*** Update File: ${path.join(ST_READONLY, 'a.txt')}\n@@\n-a\n+b\n*** End Patch` }, 'deny', 'codex'],
  ['Edit', { command: `*** Begin Patch\n*** Add File: ${path.join(ST_READONLY, 'b.txt')}\n+b\n*** End Patch` }, 'deny', 'codex'],
  ['Write', { command: `*** Begin Patch\n*** Add File: ${path.join(ST_ROOT, 'writable', 'b.txt')}\n+b\n*** End Patch` }, 'allow', 'codex'],
  // Codex as C0 saw it: shell calls are tool_name Bash with the raw string, often PowerShell.
  ['Bash', "Get-Content -LiteralPath 'notes.md'; git -C ../demo push", 'deny', 'codex'],
  ['Bash', 'git -C ../demo status --porcelain', 'allow', 'codex'],
  ['mcp__project_manager__update_task_status', { id: 'T1', status: 'done' }, 'deny', 'codex', { agent_id: 'selftest-thread', agent_type: 'default' }],
  ['mcp__project_manager__update_task_status', { id: 'T1', status: 'done' }, 'allow', 'codex'],
  ['mcp__project-manager__update_task_status', { id: 'T1', status: 'done' }, 'deny', 'claude', ST_AGENT],
  ['mcp__project-manager__set_project_dir', { project_dir: ST_ROOT }, 'deny', 'claude', ST_AGENT],
  ['mcp__project-manager__get_task_by_id', { id: 'T1' }, 'allow', 'claude', ST_AGENT],
  ['mcp__project-manager__update_task_status', { id: 'T1', status: 'done' }, 'allow', 'claude'],
  ['Bash', 'git clean -fdx', 'deny', 'claude', { cwd: ST_KIT }],
  ['PowerShell', 'git clean -fX', 'deny', 'claude', { cwd: ST_KIT }],
  ['Bash', 'git clean -fd', 'allow', 'claude', { cwd: ST_KIT }],
  ['Bash', 'git clean -n -x', 'allow', 'claude', { cwd: ST_KIT }],
];

function selftest() {
  let failed = 0;
  for (const [tool, ti, expected, platform, extra] of SELFTEST) {
    const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: typeof ti === 'string' ? { command: ti } : ti, ...extra };
    let got;
    try {
      got = decide(input, platform, SELFTEST_POLICY).decision;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      got = 'error';
    }
    if (got !== expected) {
      failed++;
      console.log(`guard selftest: FAIL ${tool} ${JSON.stringify(input.tool_input)}: expected ${expected}, got ${got}`);
    }
  }
  console.log(failed ? `guard selftest: ${failed} of ${SELFTEST.length} failed` : `guard selftest: ok (${SELFTEST.length} samples)`);
  return failed ? 1 : 0;
}

/** The deny JSON line (one line of text, newline included) for a reason. */
const decisionLine = (permissionDecision, reason) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } })}\n`;
const denyLine = (reason) => decisionLine('deny', reason);
/** The ask JSON line: Claude shows the reason in its confirmation dialog and runs the call only after a yes. */
const askLine = (reason) => decisionLine('ask', reason);

/** True when argv asks for --platform codex (the last one wins, as in parseArgs); read even when parseArgs fails. */
function codexArgv(argv) {
  let platform;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform') platform = argv[i + 1];
    else if (argv[i].startsWith('--platform=')) platform = argv[i].slice('--platform='.length);
  }
  return platform === 'codex';
}

// A run that fails before it can decide: the reason to stderr, then exit 2, or under --platform codex the
// deny JSON and exit 0 (see Errors above).
function failClosed(codex, stderrText, why) {
  process.stderr.write(stderrText);
  if (!codex) return 2;
  process.stdout.write(Buffer.from(denyLine(errorDenyReason(why)), 'utf8'));
  return 0;
}

function main(argv) {
  const codex = codexArgv(argv);
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
    return failClosed(codex, `guard: ${e.message}\n${USAGE}\n`, `钩子命令行的用法错误（${e.message}）`);
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.selftest) return selftest();

  let config;
  try {
    config = loadConfig(path.resolve(opts.config ?? path.join(path.dirname(SELF), CONFIG_NAME)));
  } catch (e) {
    return failClosed(codex, `AutoSkills 守卫出错，已按失败处理：${e.message}\n`, e.message);
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
    const r = decide(input, platform, policyFrom(config));
    decision = r.decision;
    code = 0;
    if (r.decision === 'deny') out = denyLine(r.reason);
    // Never under --platform codex: decide() asks on platform claude only, and Codex would run an asked call.
    else if (r.decision === 'ask' && codex) { decision = 'deny'; out = denyLine(denyReason(['git push'])); }
    else if (r.decision === 'ask') out = askLine(r.reason);
  } catch (e) {
    const parse = e instanceof ParseError;
    const why = parse ? e.message : `内部错误（${e.message}）`;
    process.stderr.write(`AutoSkills 守卫无法判断这次调用，已按失败处理：${why}。${PARSE_HINT}\n`);
    if (codex) {
      out = denyLine(errorDenyReason(`无法判断这次调用（${why}）`, parse ? PARSE_HINT : KIT_FAULT_HINT));
      code = 0;
    }
  }
  if (process.env[PROBE_ENV] !== '1') writeHeartbeat(config, { ts: new Date().toISOString(), platform, event, decision });
  if (out) process.stdout.write(Buffer.from(out, 'utf8'));
  return code;
}

// Both sides by real path: Node gives the main module its real path, so a start through a junction or
// symlink would otherwise never run main() and allow everything without a word.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  let a, b;
  try { a = fs.realpathSync(path.resolve(process.argv[1])); b = fs.realpathSync(SELF); } catch { return false; }
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
// Fail closed: anything main() did not catch still exits 2 with a reason on stderr, or under --platform
// codex prints the deny JSON and exits 0. An uncaught throw would exit 1, which Codex lets through.
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  try {
    process.exitCode = main(argv);
  } catch (e) {
    const why = `内部错误（${e?.message ?? e}）`;
    process.exitCode = failClosed(codexArgv(argv), `AutoSkills 守卫出错，已按失败处理：${why}\n`, why);
  }
}
