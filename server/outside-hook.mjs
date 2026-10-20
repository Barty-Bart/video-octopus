// Video Octopus's own check in Auto mode ("safe steps") for a project chat: a change outside the project's folder comes back
// to the creator as an Allow / Deny card. Claude Code runs this file as a PreToolUse hook (server/claude.mjs passes it
// with --settings, and the project's folder as STUDIO_GUARD_DIR); it reads the tool call as JSON on stdin and prints an
// "ask" decision when a file tool's path, or a command's write target, is outside the project. Otherwise it prints
// nothing, and Claude Code's own rules and classifier decide as before, so project files never ask.
// A command's write targets: redirects (> >> &> 2>), tee, the destination of cp, mv, ln, install and rsync, what rm,
// rmdir, mkdir, touch, truncate, unlink, shred, chmod, chown and sed -i / perl -i change, ffmpeg's output, curl -o,
// wget -O / -P, dd of=, tar -c -f / -x -C, unzip -d and zip's archive, following cd. Temporary folders, /dev and Claude
// Code's own project memory (~/.claude/projects) don't count. What a script or program writes by itself (python x.py)
// can't be known before it runs: that stays with Claude Code's classifier.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTSIDE_REASON = 'Outside this project';
const WIN = process.platform === 'win32';
const fold = (s) => (WIN ? s.toLowerCase() : s);

// The real place of a path (symlinks followed on the longest part that exists), so a link can't hide where it goes.
function realPlace(p) {
  const rest = [];
  for (let head = p; ; head = dirname(head)) {
    try { return join(realpathSync.native(head), ...rest); } catch {}
    if (dirname(head) === head) return p;
    rest.unshift(basename(head));
  }
}
const within = (root, p) => { const r = fold(realPlace(resolve(root))), q = fold(realPlace(p)); return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep); };

// ---- a small shell reader: commands as word lists, each with its redirect targets ----
// Words keep a flag when they can't be known before the command runs ($VAR, $(…), `…`). Heredoc bodies are skipped.
function commands(src) {
  const out = [];
  let cmd = { words: [], redirs: [] }, word = null, dyn = false, i = 0, pendingRedir = false, heredocs = [];
  const endWord = () => {
    if (word === null) return;
    const w = { text: word, dyn };
    if (pendingRedir === 'heredoc') heredocs.push({ delim: word, dash: false });
    else if (pendingRedir === 'heredoc-') heredocs.push({ delim: word, dash: true });
    else if (pendingRedir === 'in') { /* an input file: not written */ }
    else if (pendingRedir) cmd.redirs.push(w);
    else cmd.words.push(w);
    pendingRedir = false; word = null; dyn = false;
  };
  const endCmd = () => { endWord(); if (cmd.words.length || cmd.redirs.length) out.push(cmd); cmd = { words: [], redirs: [] }; };
  const add = (c) => { word = (word ?? '') + c; };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { if (src[i + 1] !== '\n') add(src[i + 1]); i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); add(src.slice(i + 1, j < 0 ? src.length : j)); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; } if (src[j] === '$' || src[j] === '`') dyn = true; s += src[j]; j++; }
      add(s); i = j + 1; continue;
    }
    if (c === '$' || c === '`') {
      dyn = true;
      // $( … ) and ` … `: skip to the matching end (what runs inside isn't followed).
      if (c === '`') { const j = src.indexOf('`', i + 1); add(src.slice(i, j < 0 ? src.length : j + 1)); i = j < 0 ? src.length : j + 1; continue; }
      if (src[i + 1] === '(') { let d = 0, j = i + 1; for (; j < src.length; j++) { if (src[j] === '(') d++; else if (src[j] === ')' && --d === 0) break; } add(src.slice(i, j + 1)); i = j + 1; continue; }
      add(c); i++; continue;
    }
    if (c === '\n') {
      endCmd();
      // Heredoc bodies: skip their lines up to the end word.
      let j = i + 1;
      for (const h of heredocs) {
        for (;;) {
          const e = src.indexOf('\n', j), line = src.slice(j, e < 0 ? src.length : e);
          j = e < 0 ? src.length : e + 1;
          if ((h.dash ? line.trim() : line) === h.delim || e < 0) break;
        }
      }
      heredocs = [];
      i = j; continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      // &> and &>> redirect both outputs; everything else here ends a command.
      if (c === '&' && src[i + 1] === '>') { endWord(); pendingRedir = 'out'; i += src[i + 2] === '>' ? 3 : 2; continue; }
      endCmd(); i += (c === '|' || c === '&') && src[i + 1] === c ? 2 : 1; continue;
    }
    if (c === '>' || c === '<') {
      // N> or N>>: the number belongs to the redirect, not to the command's words.
      if (word !== null && /^\d+$/.test(word) && !dyn) word = null; else endWord();
      if (c === '<') {
        if (src[i + 1] === '<' && src[i + 2] !== '<') { const dash = src[i + 2] === '-'; pendingRedir = dash ? 'heredoc-' : 'heredoc'; i += dash ? 3 : 2; }
        else { pendingRedir = 'in'; i += src[i + 1] === '<' ? 3 : 1; }
        continue;
      }
      let j = i + 1;
      if (src[j] === '>' || src[j] === '|') j++;
      if (src[j] === '&') { // >&2, >&1: into another output, not a file
        j++; while (/[0-9-]/.test(src[j] || '')) j++;
        i = j; continue;
      }
      pendingRedir = 'out'; i = j; continue;
    }
    if (c === '#' && word === null) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; } // a comment
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    add(c); i++;
  }
  endCmd();
  return out;
}

const KEYWORDS = new Set(['do', 'then', 'else', 'elif', '{', '}', '!', 'time', 'if', 'while', 'until', 'exec', 'sudo', 'nohup', 'command', 'builtin', 'env']);
const isOpt = (w) => w.text.startsWith('-') && w.text !== '-';
// Each command's write targets (words), and how the working folder changes (cd).
function writeTargets(cmd) {
  let w = cmd.words.slice();
  while (w.length && (KEYWORDS.has(w[0].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].text))) w = w.slice(1);
  const out = [...cmd.redirs];
  if (!w.length) return { out };
  const name = basename(w[0].text).replace(/\.exe$/i, ''), args = w.slice(1);
  const plain = (skipValues = []) => { const r = []; for (let k = 0; k < args.length; k++) { if (skipValues.includes(args[k].text)) { k++; continue; } if (!isOpt(args[k]) && args[k].text) r.push(args[k]); } return r; };
  const valueOf = (...flags) => { for (let k = 0; k < args.length; k++) { const t = args[k].text; for (const f of flags) { if (t === f && args[k + 1]) return args[k + 1]; if (f.startsWith('--') && t.startsWith(f + '=')) return { text: t.slice(f.length + 1), dyn: args[k].dyn }; } } return null; };
  if (name === 'cd' || name === 'pushd') return { out, cd: args.find((a) => !isOpt(a)) || { text: homedir(), dyn: false } };
  switch (name) {
    case 'tee': out.push(...plain()); break;
    case 'cp': case 'mv': case 'ln': case 'install': case 'rsync': case 'scp': {
      const t = valueOf('-t', '--target-directory');
      const p = plain(name === 'install' ? ['-m', '-o', '-g'] : []);
      if (t) out.push(t); else if (p.length >= 2) out.push(p.at(-1));
      break;
    }
    case 'rm': case 'rmdir': case 'touch': case 'unlink': case 'shred': out.push(...plain()); break;
    case 'mkdir': out.push(...plain(['-m'])); break;
    case 'truncate': out.push(...plain(['-s', '-r'])); break;
    case 'chmod': case 'chown': case 'chgrp': out.push(...plain().slice(1)); break;
    case 'sed': case 'perl': {
      if (!args.some((a) => /^-[a-zA-Z]*i/.test(a.text) || a.text.startsWith('--in-place'))) break;
      const scripted = args.some((a) => ['-e', '-f', '--expression', '--file'].includes(a.text));
      const p = plain(['-e', '-f', '--expression', '--file']);
      out.push(...(scripted ? p : p.slice(1)));
      break;
    }
    case 'ffmpeg': { const last = args.at(-1); if (args.length > 1 && last && !isOpt(last) && last.text !== '-' && args.at(-2).text !== '-i') out.push(last); break; } // its output
    case 'curl': { const o = valueOf('-o', '--output'); if (o) out.push(o); else if (args.some((a) => a.text === '-O' || a.text === '--remote-name')) out.push({ text: '.', dyn: false }); break; }
    case 'wget': { const o = valueOf('-O', '--output-document'); const d = valueOf('-P', '--directory-prefix'); out.push(o || d || { text: '.', dyn: false }); break; }
    case 'dd': for (const a of args) if (a.text.startsWith('of=')) out.push({ text: a.text.slice(3), dyn: a.dyn }); break;
    case 'tar': {
      const first = args[0]?.text || '';
      const flags = args.filter(isOpt).map((a) => a.text).join('') + (first.startsWith('-') ? '' : first);
      if (/c/.test(flags)) { const f = valueOf('-f', '--file') || (/f$/.test(first) ? args[1] : null); if (f) out.push(f); }
      else if (/x/.test(flags)) out.push(valueOf('-C', '--directory') || { text: '.', dyn: false });
      break;
    }
    case 'unzip': out.push(valueOf('-d') || { text: '.', dyn: false }); break;
    case 'zip': { const p = plain(); if (p[0]) out.push(p[0]); break; }
    default: break;
  }
  return { out };
}

// A word as a place: ~ expanded, against the working folder; null when it can't be known now.
function place(w, cwd) {
  if (!w || w.dyn) return null;
  let t = w.text;
  if (!t || /^[a-z][\w+.-]*:\/\//i.test(t) || (/^[^/\\]+:/.test(t) && !/^[A-Za-z]:[\\/]/.test(t))) return null; // a URL or a remote host
  if (t === '~') t = homedir(); else if (t.startsWith('~/') || (WIN && t.startsWith('~\\'))) t = join(homedir(), t.slice(2));
  // A wildcard: the folder before it.
  const g = t.search(/[*?[]/);
  if (g >= 0) t = dirname(t.slice(0, g) + 'x');
  return isAbsolute(t) ? resolve(t) : cwd ? resolve(cwd, t) : null;
}

// Where it may write without asking: the project; outside the studio, temporary folders, /dev and Claude Code's own
// project memory. The rest of the studio always asks (other projects, the library, the creator's notes and logs).
function allowed(p, dir, studio) {
  if (within(dir, p)) return true;
  if (studio && within(studio, p)) return false;
  if (/^\/dev(\/|$)/.test(p)) return true;
  const tmps = [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  if (tmps.some((t) => t && within(t, p))) return true;
  return within(join(homedir(), '.claude', 'projects'), p);
}

// The tool call → null (nothing to say) or { path } (the first place outside the project it would change).
export function decide(input = {}, { dir = process.env.STUDIO_GUARD_DIR, studio = process.env.STUDIO_GUARD_STUDIO } = {}) {
  if (!dir) return null;
  const tool = input.tool_name, ti = input.tool_input || {}, cwd = input.cwd || process.cwd();
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const f = ti.file_path || ti.notebook_path;
    if (!f) return null;
    const p = isAbsolute(f) ? resolve(f) : resolve(cwd, f);
    return allowed(p, dir, studio) ? null : { path: p };
  }
  if (tool !== 'Bash') return null;
  let here = cwd;
  for (const c of commands(String(ti.command || ''))) {
    const { out, cd } = writeTargets(c);
    for (const w of out) {
      const p = place(w, here);
      if (p && !allowed(p, dir, studio)) return { path: p };
    }
    if (cd) here = place(cd, here); // unknown after a cd we can't follow: later relative targets aren't judged
  }
  return null;
}

// "notes/log.md" inside the studio, else the path with ~ for the home folder.
export function shown(p, studio = process.env.STUDIO_GUARD_STUDIO) {
  if (studio && within(studio, p)) return relative(realPlace(resolve(studio)), realPlace(p)) || '.';
  const home = homedir();
  return p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const d = decide(input);
  if (!d) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `${OUTSIDE_REASON}: ${shown(d.path)}` } }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
