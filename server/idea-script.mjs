// The idea carries into the script (B8, wireflow J2): "Use this idea" on a Packaging card writes a short outline stub
// into the project's script.md (the record panel's script and the teleprompter, web/prompter.js), so Record and the
// project chat start from the idea instead of asking "What's this one about?" again.
// - Each card keeps its idea: the brief typed next to Generate (item.brief) and Codex's line for it ("1. <words> —
//   <idea>", parsed into item.idea = { words, text, hook?, beats? }). Older cards fall back to their name.
// - The stub: the title, the idea, and the hook and three beats when the card has them. Labels are [cues] (the
//   prompter shows them dim, not to be read out); the hook and beats are plain lines to say.
// - A script that already has text is never overwritten: the caller asks, then appends or skips.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCRIPT_MAX = 400000; // the /script route's limit
const clean = (s, n = 400) => String(s || '').replace(/\*\*/g, '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

// Codex's line for one idea, without its "1. ": "<words on it> — <the idea>", optionally "— hook: …" and "— beats: a; b; c".
export function parseIdeaLine(line) {
  const parts = String(line || '').replace(/\*\*/g, '').split(/\s+[—–]\s+|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const idea = { words: clean(parts[0], 120), text: '' };
  for (const p of parts.slice(1)) {
    const m = /^(hook|beats?)\s*:\s*(.+)$/i.exec(p);
    if (m && /^hook$/i.test(m[1])) idea.hook = clean(m[2]);
    else if (m) idea.beats = m[2].split(/\s*;\s*|\s*\|\s*/).map((b) => clean(b, 200)).filter(Boolean).slice(0, 3);
    else idea.text = clean(idea.text ? `${idea.text} — ${p}` : p);
  }
  return idea;
}

// What a card says about its idea: { name, words, text, hook, beats, brief, title }. sheet: its Generate sheet (for the
// brief of a card made before cards kept it); title: the board's working title.
export function ideaOf(item, { sheet = null, title = '' } = {}) {
  const name = String(item?.name || 'Idea');
  // "Idea 3 · 10 MIN EDIT — the result" → the line after the "Idea 3 · " (cards named before ideas were kept).
  const fromName = parseIdeaLine(name.replace(/^Idea \d+\s*·\s*/, '').replace(/\s*·\s*refined$/, ''));
  const kept = item?.idea || (/·/.test(name) ? fromName : null) || {};
  return {
    name: name.replace(/\s*·.*$/, ''),
    words: clean(kept.words, 120), text: clean(kept.text), hook: clean(kept.hook),
    beats: (kept.beats || []).map((b) => clean(b, 200)).filter(Boolean).slice(0, 3),
    brief: clean(item?.brief || sheet?.brief || '', 600), title: clean(title, 200),
  };
}

// The outline stub for script.md.
export function outlineStub(idea) {
  const lines = [`[From Packaging: ${idea.name || 'an idea'}]`];
  if (idea.title) lines.push(`[Title: ${idea.title}]`);
  if (idea.brief) lines.push(`[What it's about: ${idea.brief}]`);
  if (idea.words || idea.text) lines.push(`[The idea: ${[idea.words ? `“${idea.words}”` : '', idea.text].filter(Boolean).join(' — ')}]`);
  lines.push('');
  if (idea.hook) lines.push('[Hook]', idea.hook, '');
  if (idea.beats?.length) { idea.beats.forEach((b, i) => lines.push(`[${i + 1}] ${b}`)); lines.push(''); }
  if (!idea.hook && !idea.beats?.length) lines.push('[Next: a hook and three beats. Write them here, or ask Claude to outline it.]', '');
  return `${lines.join('\n').trimEnd()}\n`;
}

// Puts the stub in <dir>/script.md. Empty (or no) script: written ('new'). A script with text: nothing changes unless
// append (then it goes under it: 'appended'), and the answer says so ({ exists: true }) so the page can ask first.
// The same stub already in it: 'already'.
export function writeIdeaScript(dir, stub, { append = false } = {}) {
  const f = join(dir, 'script.md');
  const cur = existsSync(f) ? readFileSync(f, 'utf8').replace(/\r\n?/g, '\n') : '';
  if (!cur.trim()) { writeFileSync(f, stub); return { written: 'new' }; }
  if (cur.includes(stub.trim())) return { written: 'already' };
  if (!append) return { written: null, exists: true, words: (cur.match(/\S+/g) || []).length };
  const text = `${cur.trimEnd()}\n\n${stub}`;
  if (text.length > SCRIPT_MAX) { const e = new Error('The script is too long to add the outline: 400,000 characters at most.'); e.status = 400; throw e; }
  writeFileSync(f, text);
  return { written: 'appended' };
}

// What "Ask Claude to outline it" sends in the project chat (only a message; Claude's turn is the creator's own).
export const OUTLINE_ASK = 'Outline this video from the idea in script.md (from Packaging): a hook and three beats, short enough to read from the teleprompter. Put the outline in script.md under the idea and keep what is already there.';
