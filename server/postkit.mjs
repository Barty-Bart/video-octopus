// The post kit: what goes with a video when it's posted. One card per platform in Video Octopus's Post tab:
// YouTube (title, description, pinned comment), Instagram and TikTok (captions with hashtags), and the
// comment WORD with the DM the auto-reply tool (LinkDM / ManyChat) sends. Claude writes work/post.json
// from the transcript and the project, fact-checked; the creator edits it in the app. post.md (the
// readable copy, which also marks the rail's post step done) is kept in step with it.
import { existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readJSON, writeJSON, mtime } from './util.mjs';
import { formats, formatId } from './studio.mjs';
import { stylePath } from './library.mjs';

const POST = 'work/post.json', MD = 'post.md';

// Project types are being renamed (long → tutorial, short/reel → short); read them through aliases.
export const isShort = (type) => formatId(type) === 'short';
export const postKind = (type) => (isShort(type) ? 'short' : 'tutorial');

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const FIELDS = ['word', 'youtube.title', 'youtube.description', 'youtube.comment', 'instagram.caption', 'tiktok.caption', 'dm.reply', 'dm.tool', 'notes'];

export function normalizePost(p) {
  p = p && typeof p === 'object' ? p : {};
  return {
    word: str(p.word || p.dm?.keyword).trim().toUpperCase(),
    youtube: { title: str(p.youtube?.title), description: str(p.youtube?.description), comment: str(p.youtube?.comment || p.youtube?.pinned) },
    instagram: { caption: str(p.instagram?.caption) },
    tiktok: { caption: str(p.tiktok?.caption) },
    dm: { reply: str(p.dm?.reply || p.dm?.message), tool: str(p.dm?.tool || 'LinkDM') },
    links: (Array.isArray(p.links) ? p.links : []).filter((l) => l && (l.url || l.label)).map((l) => ({ label: str(l.label), url: str(l.url), checked: str(l.checked) })),
    facts: (Array.isArray(p.facts) ? p.facts : []).map(str).filter(Boolean),
    notes: str(p.notes),
    edited: p.edited && typeof p.edited === 'object' ? p.edited : {},
    by: str(p.by || 'claude'), at: Number(p.at) || 0,
  };
}

export function readPost(dir, name) {
  const p = readJSON(join(dir, POST), null);
  if (p) syncMd(dir, name);
  return { exists: Boolean(p), at: mtime(join(dir, POST)), post: normalizePost(p) };
}

// Edits from the app: {"youtube.title": "…", …}. Only the known text fields; each edit is remembered so a
// rewrite keeps it.
export function savePost(dir, patch, name) {
  const p = normalizePost(readJSON(join(dir, POST), null));
  const now = Date.now();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!FIELDS.includes(k) || typeof v !== 'string') continue;
    const [a, b] = k.split('.');
    const val = k === 'word' ? v.trim().toUpperCase().slice(0, 40) : v.slice(0, 6000);
    if (b) p[a][b] = val; else p[a] = val;
    p.edited[k] = now;
  }
  p.at = now;
  writeJSON(join(dir, POST), p);
  syncMd(dir, name, true);
  return readPost(dir, name);
}

// post.md: the same kit as a page to read, in the creator's post-kit shape.
function syncMd(dir, name, force = false) {
  const md = join(dir, MD);
  if (!force && existsSync(md) && mtime(md) >= mtime(join(dir, POST))) return;
  const p = normalizePost(readJSON(join(dir, POST), null));
  const block = (t) => (t.trim() ? `\`\`\`\n${t.trim()}\n\`\`\`\n` : '_(empty)_\n');
  const parts = [`# ${name || basename(dir)}: post kit`, '', '_Written in Video Octopus\'s Post tab (work/post.json). Edit it there; this page follows._', ''];
  if (p.youtube.title || p.youtube.description || p.youtube.comment) {
    parts.push('## YouTube', '', `**Title:** ${p.youtube.title}`, '', '**Description**', block(p.youtube.description));
    if (p.youtube.comment) parts.push('**Pinned comment**', block(p.youtube.comment));
  }
  if (p.instagram.caption) parts.push('## Instagram caption', block(p.instagram.caption));
  if (p.tiktok.caption) parts.push('## TikTok caption', block(p.tiktok.caption));
  if (p.word || p.dm.reply) parts.push(`## ${p.dm.tool || 'LinkDM'}`, `Keyword: ${p.word || '?'} → DM: "${p.dm.reply.trim()}"`, '');
  if (p.links.length) parts.push('## Links', ...p.links.map((l) => `- ${l.label ? `${l.label}: ` : ''}${l.url}${l.checked ? ` (checked ${l.checked})` : ''}`), '');
  if (p.facts.length) parts.push('## Facts', ...p.facts.map((f) => `- ${f}`), '');
  if (p.notes.trim()) parts.push('## Still to do', p.notes.trim(), '');
  writeFileSync(md, parts.join('\n'));
}

// "Write it": the brief for the project's Claude.
export function postBrief(dir, meta) {
  const kind = postKind(meta?.type);
  const fmt = formats()[formatId(meta?.type)] || meta?.type || 'video';
  const have = (f) => existsSync(join(dir, f));
  const sources = [
    ['work/tr/words.json', 'the transcript of the take (word times)'],
    ['work/words.json', 'the transcript (word times)'],
    ['work/rough_words.json', 'the words after the rough cut'],
    ['work/production.json', 'the production sheet (scenes)'],
    ['WORKLOG.md', 'the project log'],
  ].filter(([f]) => have(f)).map(([f, what]) => `${f} (${what})`);
  const style = meta?.style && stylePath(meta.style);
  const old = readJSON(join(dir, POST), null);
  const edited = Object.keys(old?.edited || {});
  const shape = kind === 'short'
    ? `{
  "word": "the comment WORD: one short word in capitals that fits the video; viewers comment it to get the link",
  "youtube": {"title": "the Shorts title, under 70 characters", "description": "2–4 short lines and the link line", "comment": "the pinned comment (YouTube can't auto-DM, so the link goes here)"},
  "instagram": {"caption": "opens with the comment-WORD line, then the post, then 3–5 hashtags"},
  "tiktok": {"caption": "the TikTok version, shorter, with hashtags"},
  "dm": {"reply": "the DM the auto-reply tool sends to everyone who comments the WORD, with the link", "tool": "LinkDM or ManyChat"},
  "links": [{"label": "", "url": "", "checked": "YYYY-MM-DD"}],
  "facts": ["each claim you checked, and where"],
  "notes": "what the creator still has to fill in or decide (empty if nothing)"
}`
    : `{
  "word": "a comment WORD only if the video offers something to send (else \\"\\")",
  "youtube": {"title": "under 70 characters", "description": "a short opening, the links, then chapters (0:00 Intro …) from the production sheet or the transcript", "comment": "the pinned comment"},
  "dm": {"reply": "the DM for the WORD, if there is one", "tool": "LinkDM or ManyChat"},
  "links": [{"label": "", "url": "", "checked": "YYYY-MM-DD"}],
  "facts": ["each claim you checked, and where"],
  "notes": "what the creator still has to fill in or decide (empty if nothing)"
}`;
  return [
    `Write the post kit for this ${fmt} into work/post.json. Video Octopus shows it in its Post tab, one card per platform with a copy button per field, and keeps post.md in step.`,
    sources.length ? `Read: ${sources.join(', ')}.` : `There's no transcript yet: transcribe the take first (work/tr/words.json), then write the kit from it.`,
    style ? `This project's style: ${style} (read its CTA and caption sections).` : '',
    `Write it in the creator's own voice and follow the studio's posting rules: read the studio's notes first (CLAUDE.md, any brand-voice skill, style or reel notes, and earlier post kits such as *-post.md files) and match how those are written.`,
    `Fact-check everything: every tool, repo, feature, number, link and price must come from the video, the project files or a page you opened just now. Never invent a link or a price. If you can't confirm one, write [LINK] (or leave the price out) and say what's missing in "notes". List every link in "links" with the date you checked it, and each checked claim in "facts".`,
    edited.length ? `The creator already edited ${edited.join(', ')} in the app: keep those exactly as they are.` : '',
    `Use exactly this JSON shape (plain UTF-8, "" for anything that doesn't apply):`,
    shape,
    `When it's saved, tell me in two lines: the WORD, and what still needs me.`,
  ].filter(Boolean).join('\n');
}

export function postSummary(dir) {
  const at = mtime(join(dir, POST));
  if (!at) return { exists: false, at: 0 };
  const p = normalizePost(readJSON(join(dir, POST), null));
  return { exists: true, at, word: p.word, notes: Boolean(p.notes.trim()) };
}
