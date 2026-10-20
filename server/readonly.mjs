// Commands that only look, which a chat may run without an Allow card (the Video Octopus assistant: it still asks before every
// change). The same rule Auto uses for pi (core/pi/octopus-extension.js readOnly: ls, cat, head, grep, find, wc, jq…,
// one or a chain joined by && || ; | & or a new line, no redirects, no command substitution, no option that writes a
// file or runs another program), plus the octopus command's read commands, run by its real path (bin/octopus.mjs:
// projects [list|open|archived], settings [section], schedules [list|runs], library [section|inbox], dashboard, skills,
// models [family] (never models download), help; --json and --range only). A cd in the chain is followed for the octopus command's path.
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readOnly } from '../core/pi/octopus-extension.js';
import { APP_DIR, IS_WIN } from './util.mjs';

const CLI = resolve(APP_DIR, 'bin', 'octopus.mjs');
const fold = (s) => (IS_WIN ? s.toLowerCase() : s);

// Plain words: quotes taken off; null when a word can't be read without running something ($, `, globs aren't paths here).
function words(part) {
  const out = [];
  const re = /"([^"$`\\]*)"|'([^']*)'|([^\s'"]+)/g;
  let m, rest = part;
  if (/[$`\\]/.test(part)) return null;
  while ((m = re.exec(rest))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const READ = {
  projects: (v) => [undefined, 'list', 'open', 'archived'].includes(v),
  settings: (v) => v !== 'set',
  schedules: (v) => [undefined, 'list', 'runs'].includes(v),
  library: (v) => !['accept', 'add', 'aside'].includes(v),
  models: (v) => v !== 'download',
  dashboard: () => true, skills: () => true, help: () => true,
};
export function studioRead(part, cwd) {
  const w = words(part);
  if (!w || w.length < 2 || !/^node(\.exe)?$/i.test(basename(w[0]))) return false;
  const file = isAbsolute(w[1]) ? resolve(w[1]) : cwd ? resolve(cwd, w[1]) : null;
  if (!file || fold(file) !== fold(CLI)) return false;
  const pos = [];
  for (let i = 2; i < w.length; i++) {
    if (w[i] === '--json') continue;
    if (w[i] === '--range') { i++; continue; }
    if (w[i].startsWith('-')) return false; // any other option belongs to a change (--name, --kind, --cron…)
    pos.push(w[i]);
  }
  const area = pos[0] || 'help';
  return Boolean(READ[area]?.(pos[1]));
}

export function lookOnly(raw, cwd) {
  // Throwing output away (2>/dev/null) or joining it (2>&1) is still only looking.
  const cmd = String(raw || '').replace(/\d?>\s*\/dev\/null(?![^\s;&|])/g, '').replace(/\d?>&\d(?![^\s;&|])/g, '');
  if (!cmd.trim() || /[`<>]|\$\(/.test(cmd)) return false;
  let here = cwd;
  for (const part of cmd.split(/&&|\|\||[;&|\r\n]/).map((p) => p.trim()).filter(Boolean)) {
    if (!readOnly(part) && !studioRead(part, here)) return false;
    const cd = /^cd(?:\s+(.+))?$/.exec(part);
    if (cd) {
      const w = words(cd[1] || '~');
      const to = w?.[0] === '~' ? homedir() : w?.[0]?.startsWith('~/') ? resolve(homedir(), w[0].slice(2)) : w?.[0];
      here = to && here ? resolve(here, to) : to && isAbsolute(to) ? to : null;
    }
  }
  return true;
}
