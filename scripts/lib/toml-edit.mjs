// toml-edit: targeted edits of a TOML document as text, for the kit's merge into ~/.codex/config.toml
// (ADR-006 §2.6) and for the measurement scripts' cleanup of trust sections. Zero dependencies (Node >= 18).
// Nothing here reads or writes files: every function takes the text and returns the new text.
//
// The text is never parsed into values and printed again, so comments, blank lines, key and section order,
// quoting and line endings stay as they are. A small scanner splits the document into entries (blank,
// comment, [table] or [[array table]] header, key = value) and finds where each value ends, including
// multi-line strings and arrays, so a "[" inside a string is never taken for a header. Only the entries an
// edit names are touched:
//   setValue          replaces the value of one key, or adds the key to its table (adding the table at the
//                     end when it does not exist yet); a value that is already the same literal is left alone.
//   keyValues         every key = value of a document with its full dotted path and the value literal, so the
//                     kit's fragment (config/codex/config.fragment.toml) stays the one place that names the keys.
//   removeProjectsByPrefix
//                     drops the [projects.'<path>'] sections (and dotted projects.'<path>'.* keys) whose path
//                     lies in a folder, e.g. the trust entries Codex wrote for measurement repos under
//                     _private/eval/runs/.
//   removeValue, removeEmptyTable
//                     undo setValue for deploy-kit --rollback: drop one key line, and a [table] header that
//                     no longer holds keys together with the blank line setValue put above it.
// A document the scanner cannot follow (an unterminated string, a stray character after a value) or an
// edit TOML would reject (a key that is already an inline table or a dotted-key table) throws
// TomlEditError; the deploy plan reports it as a conflict instead of writing.

/** The document cannot be edited safely; the message names the line. */
export class TomlEditError extends Error {}

const BARE = /^[A-Za-z0-9_-]+$/;

function lineOf(text, pos) {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function fail(text, pos, msg) {
  throw new TomlEditError(`line ${lineOf(text, pos)}: ${msg}`);
}

const isSpace = (c) => c === ' ' || c === '\t';
const isEol = (text, i) => i >= text.length || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n');

/** Index just past the line ending at i (or text.length). */
function pastEol(text, i) {
  if (text[i] === '\r' && text[i + 1] === '\n') return i + 2;
  if (text[i] === '\n') return i + 1;
  return i;
}

function skipSpace(text, i) {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/** A single-line basic string starting at i (the opening quote). Returns its decoded value and end. */
function basicString(text, i) {
  let out = '';
  let j = i + 1;
  while (j < text.length && !isEol(text, j)) {
    const c = text[j];
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\\') {
      const e = text[j + 1];
      if (e === 'u' || e === 'U' || e === 'x') {
        const n = e === 'u' ? 4 : e === 'U' ? 8 : 2;
        const hex = text.slice(j + 2, j + 2 + n);
        if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(hex)) fail(text, j, 'bad escape in a string');
        out += String.fromCodePoint(parseInt(hex, 16));
        j += 2 + n;
        continue;
      }
      if (!(e in ESCAPES)) fail(text, j, 'bad escape in a string');
      out += ESCAPES[e];
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  return fail(text, i, 'unterminated string');
}

/** A single-line literal string starting at i. */
function literalString(text, i) {
  let j = i + 1;
  while (j < text.length && !isEol(text, j)) {
    if (text[j] === "'") return { value: text.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return fail(text, i, 'unterminated string');
}

/** A multi-line string (""" or ''') starting at i; returns the index past its closing quotes. */
function multiString(text, i) {
  const q = text[i];
  let j = i + 3;
  while (j < text.length) {
    if (q === '"' && text[j] === '\\') { j += 2; continue; }
    if (text[j] === q && text[j + 1] === q && text[j + 2] === q) {
      j += 3;
      // Up to two quotes right before the closing delimiter belong to the content.
      for (let k = 0; k < 2 && text[j] === q; k++) j++;
      return j;
    }
    j++;
  }
  return fail(text, i, 'unterminated multi-line string');
}

/**
 * A dotted key starting at i (after leading spaces). Returns the decoded parts and the index after the key.
 * @returns {{parts: string[], end: number}}
 */
function parseKey(text, i) {
  const parts = [];
  for (;;) {
    i = skipSpace(text, i);
    const c = text[i];
    if (c === '"') { const s = basicString(text, i); parts.push(s.value); i = s.end; } else if (c === "'") { const s = literalString(text, i); parts.push(s.value); i = s.end; } else {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) j++;
      if (j === i) fail(text, i, 'expected a key');
      parts.push(text.slice(i, j));
      i = j;
    }
    const k = skipSpace(text, i);
    if (text[k] !== '.') return { parts, end: i };
    i = k + 1;
  }
}

/** Index past a value starting at i; arrays and inline tables may span lines and hold comments. */
function scanValue(text, i) {
  const c = text[i];
  if (c === '"' || c === "'") {
    if (text[i + 1] === c && text[i + 2] === c) return multiString(text, i);
    return (c === '"' ? basicString(text, i) : literalString(text, i)).end;
  }
  if (c === '[' || c === '{') {
    const stack = [c === '[' ? ']' : '}'];
    let j = i + 1;
    while (stack.length) {
      if (j >= text.length) fail(text, i, 'unterminated array or inline table');
      const d = text[j];
      if (d === '"' || d === "'") { j = scanValue(text, j); continue; }
      if (d === '#') { while (j < text.length && !isEol(text, j)) j++; continue; }
      if (d === '[') stack.push(']');
      else if (d === '{') stack.push('}');
      else if (d === ']' || d === '}') {
        if (stack.pop() !== d) fail(text, j, 'mismatched bracket');
      }
      j++;
    }
    return j;
  }
  // A scalar (number, boolean, date, time): up to a comment or the end of the line.
  let j = i;
  while (j < text.length && !isEol(text, j) && text[j] !== '#') j++;
  while (j > i && isSpace(text[j - 1])) j--;
  if (j === i) fail(text, i, 'missing value');
  return j;
}

/** After a header or value: only spaces and an optional comment may follow on the line. */
function lineRest(text, i) {
  i = skipSpace(text, i);
  if (text[i] === '#') while (i < text.length && !isEol(text, i)) i++;
  if (!isEol(text, i)) fail(text, i, `unexpected text "${text.slice(i, i + 20)}"`);
  return pastEol(text, i);
}

/**
 * Split a document into entries. Each entry covers whole lines: [start, end) runs from the line start to
 * just past its line ending.
 * kind 'kv' carries table (the enclosing header path), key (its dotted parts), path (table + key), inArray
 * (inside an [[array table]]) and valueStart/valueEnd; kind 'header' carries path and array.
 * @param {string} text
 * @returns {{kind: 'blank'|'comment'|'header'|'kv', start: number, end: number, path?: string[], table?: string[],
 *   key?: string[], array?: boolean, inArray?: boolean, valueStart?: number, valueEnd?: number}[]}
 * @throws {TomlEditError}
 */
export function scanToml(text) {
  const entries = [];
  let table = [];
  let inArray = false;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < text.length) {
    const start = pos;
    const i = skipSpace(text, pos);
    if (isEol(text, i)) { pos = pastEol(text, i); entries.push({ kind: 'blank', start, end: pos }); continue; }
    if (text[i] === '#') { pos = lineRest(text, i); entries.push({ kind: 'comment', start, end: pos }); continue; }
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      const k = parseKey(text, i + (array ? 2 : 1));
      let j = skipSpace(text, k.end);
      if (text[j] !== ']' || (array && text[j + 1] !== ']')) fail(text, j, 'expected ] after a table name');
      pos = lineRest(text, j + (array ? 2 : 1));
      table = k.parts;
      inArray = array;
      entries.push({ kind: 'header', start, end: pos, path: k.parts, array });
      continue;
    }
    const k = parseKey(text, i);
    const eq = skipSpace(text, k.end);
    if (text[eq] !== '=') fail(text, eq, 'expected = after a key');
    const valueStart = skipSpace(text, eq + 1);
    const valueEnd = scanValue(text, valueStart);
    pos = lineRest(text, valueEnd);
    entries.push({ kind: 'kv', start, end: pos, table, key: k.parts, path: [...table, ...k.parts], inArray, valueStart, valueEnd });
  }
  return entries;
}

const samePath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isPrefix = (p, of) => p.length < of.length && p.every((x, i) => x === of[i]);

/** One key part as written in TOML: bare when possible, else a basic string. */
export function formatKeyPart(part) {
  if (BARE.test(part)) return part;
  return `"${part.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

const formatKey = (parts) => parts.map(formatKeyPart).join('.');

/**
 * Every key = value of a document outside array tables.
 * @param {string} text
 * @returns {{path: string[], raw: string}[]} raw is the value literal as written
 */
export function keyValues(text) {
  return scanToml(text).filter((e) => e.kind === 'kv' && !e.inArray).map((e) => ({ path: e.path, raw: text.slice(e.valueStart, e.valueEnd) }));
}

/**
 * The value literal of a key, or undefined when the document does not set it.
 * @param {string} text
 * @param {string[]} keyPath e.g. ['desktop', 'followUpQueueMode']
 * @returns {string|undefined}
 */
export function getValue(text, keyPath) {
  return keyValues(text).find((e) => samePath(e.path, keyPath))?.raw;
}

/**
 * Set one key to a value literal. An existing key keeps its place, its key spelling and its trailing
 * comment; only the value text changes. A missing key goes after the last key of its table (root keys
 * before the first header); a missing table is added at the end of the document.
 * @param {string} text the document ('' for none)
 * @param {string[]} keyPath full dotted path of the key
 * @param {string} literal the value as TOML text, e.g. '"medium"'
 * @returns {string} the new document (the same string when nothing changes)
 * @throws {TomlEditError} the document cannot be scanned, the key sits in an array table, or a parent of
 *   the key is already a value (inline table) or a table made of dotted keys
 */
export function setValue(text, keyPath, literal) {
  if (!keyPath.length) throw new TomlEditError('empty key path');
  const entries = scanToml(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const name = formatKey(keyPath);
  const hit = entries.find((e) => e.kind === 'kv' && !e.inArray && samePath(e.path, keyPath));
  if (hit) {
    if (text.slice(hit.valueStart, hit.valueEnd) === literal) return text;
    return text.slice(0, hit.valueStart) + literal + text.slice(hit.valueEnd);
  }
  const blocker = entries.find((e) => e.kind === 'kv' && !e.inArray && isPrefix(e.path, keyPath));
  if (blocker) fail(text, blocker.start, `${formatKey(blocker.path)} is already a value; ${name} cannot be added`);
  const table = keyPath.slice(0, -1);
  const line = `${formatKeyPart(keyPath[keyPath.length - 1])} = ${literal}`;
  const insertAt = (at, s) => text.slice(0, at) + s + text.slice(at);

  if (!table.length) {
    const firstHeader = entries.findIndex((e) => e.kind === 'header');
    const rootKeys = entries.slice(0, firstHeader < 0 ? entries.length : firstHeader).filter((e) => e.kind === 'kv');
    if (rootKeys.length) {
      const last = rootKeys[rootKeys.length - 1];
      return insertAt(last.end, `${atLineEnd(text, last.end, eol)}${line}${eol}`);
    }
    if (firstHeader < 0) return `${text}${atLineEnd(text, text.length, eol)}${line}${eol}`;
    // Comments right above the first header belong to it: the new key goes above them.
    let k = firstHeader;
    while (k > 0 && entries[k - 1].kind === 'comment') k--;
    return insertAt(entries[k].start, `${line}${eol}${eol}`);
  }

  const h = entries.findIndex((e) => e.kind === 'header' && samePath(e.path, table));
  if (h >= 0) {
    if (entries[h].array) fail(text, entries[h].start, `[[${formatKey(table)}]] is an array of tables`);
    let lastKv = h;
    for (let k = h + 1; k < entries.length && entries[k].kind !== 'header'; k++) if (entries[k].kind === 'kv') lastKv = k;
    return insertAt(entries[lastKv].end, `${atLineEnd(text, entries[lastKv].end, eol)}${line}${eol}`);
  }
  // A table that dotted keys already define cannot get a [header] of its own.
  const underHeader = (e) => samePath(table, e.table) || isPrefix(table, e.table);
  const dotted = entries.find((e) => e.kind === 'kv' && !e.inArray && e.key.length > 1 && isPrefix(table, e.path) && !underHeader(e));
  if (dotted) fail(text, dotted.start, `${formatKey(table)} is defined by dotted keys; ${name} cannot be added as a [table]`);
  const sep = text.length === 0 ? '' : `${atLineEnd(text, text.length, eol)}${eol}`;
  return `${text}${sep}[${formatKey(table)}]${eol}${line}${eol}`;
}

/**
 * Remove one key = value entry: its whole lines, a trailing comment included. A key the document does not
 * set leaves the text as it is.
 * @param {string} text
 * @param {string[]} keyPath full dotted path of the key
 * @returns {string} the new document (the same string when nothing changes)
 * @throws {TomlEditError} the document cannot be scanned
 */
export function removeValue(text, keyPath) {
  const hit = scanToml(text).find((e) => e.kind === 'kv' && !e.inArray && samePath(e.path, keyPath));
  if (!hit) return text;
  return text.slice(0, hit.start) + text.slice(hit.end);
}

/**
 * Remove a [table] header that holds no keys (only blank lines up to the next header), with the blank line
 * right above it: the counterpart of setValue adding a missing table at the end. A table that holds a key
 * or a comment, an array of tables and a missing header leave the text as it is.
 * @param {string} text
 * @param {string[]} tablePath e.g. ['desktop']
 * @returns {string}
 * @throws {TomlEditError} the document cannot be scanned
 */
export function removeEmptyTable(text, tablePath) {
  const entries = scanToml(text);
  const h = entries.findIndex((e) => e.kind === 'header' && !e.array && samePath(e.path, tablePath));
  if (h < 0) return text;
  for (let k = h + 1; k < entries.length && entries[k].kind !== 'header'; k++) if (entries[k].kind !== 'blank') return text;
  const start = h > 0 && entries[h - 1].kind === 'blank' ? entries[h - 1].start : entries[h].start;
  return text.slice(0, start) + text.slice(entries[h].end);
}

/** A line ending when the text before `at` does not end with one (a last line without newline). */
function atLineEnd(text, at, eol) {
  return at === 0 || text[at - 1] === '\n' ? '' : eol;
}

const WIN = process.platform === 'win32';

/** Path compare key: \\?\ prefix dropped, / separators, no trailing /, lower case on Windows or for drive paths. */
function folderKey(p) {
  let s = String(p).replace(/^(?:\\\\|\/\/)[?.][\\/]/, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (WIN || /^[A-Za-z]:/.test(s)) s = s.toLowerCase();
  return s;
}

/** True when p is folder or lies below it (path compare, no file system access). */
export function inFolder(p, folder) {
  const a = folderKey(p), b = folderKey(folder);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Remove the [projects.'<path>'] sections (with their sub-tables) and dotted projects.'<path>'.* keys whose
 * path lies in folder. A removed section takes its key lines and the blank and comment lines up to the next
 * header, except a comment block that ends the section (right above the next header, or at the end of the
 * file), which belongs to what follows. Everything else stays.
 * @param {string} text
 * @param {string} folder absolute folder; / and \, the \\?\ prefix and (on Windows or for drive paths) case
 *   do not matter; a sibling folder that only shares the name start (runs2 for runs) is not a match
 * @returns {{text: string, removed: string[]}} the new document and the project paths removed, in order
 * @throws {TomlEditError} the document cannot be scanned
 */
export function removeProjectsByPrefix(text, folder) {
  if (!folder) throw new TomlEditError('empty folder');
  const entries = scanToml(text);
  const match = (p) => p.length >= 2 && p[0] === 'projects' && inFolder(p[1], folder);
  const drop = new Set();
  const removed = [];
  const note = (p) => { if (!removed.includes(p)) removed.push(p); };
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k];
    if (e.kind === 'header' && match(e.path)) {
      note(e.path[1]);
      let end = k + 1;
      while (end < entries.length && entries[end].kind !== 'header') end++;
      let keep = end;
      while (keep > k + 1 && entries[keep - 1].kind === 'comment') keep--;
      for (let m = k; m < keep; m++) drop.add(m);
      k = keep - 1;
    } else if (e.kind === 'kv' && !e.inArray && match(e.path) && !match(e.table)) {
      note(e.path[1]);
      drop.add(k);
    }
  }
  if (!drop.size) return { text, removed };
  let out = text.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  entries.forEach((e, k) => { if (!drop.has(k)) out += text.slice(e.start, e.end); });
  return { text: out, removed };
}
