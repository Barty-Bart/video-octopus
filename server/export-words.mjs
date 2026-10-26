// Words on the final timeline: the take's words mapped through the locked cut and the blocks, plus each file block's
// own words, with the blocks as sections. Shared by the Transcript and Subtitles exports (server/export-text.mjs) and
// the captions the Video export burns in (server/export.mjs calls burnCaptions). Pure apart from reading files.
//
// parts = the export's parts in playing order, as the video export builds them:
//   { kind: 'take' | 'file', segs: [[a, b], …] (take seconds, frame-snapped) | null (the whole take), total (seconds),
//     start (seconds where it starts in the export), blocks: [block ids] | null }
// Words: [start, end, word] in seconds of the canvas take: work/words_refined.json (the Cut Editor's refined times)
// first, then work/tr/words.json, then work/words.json; a file block's own words from work/tr/<file name>/words.json
// (or the transcribe skill's source/<file name>_transcript/words.json).
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { readJSON, mtime, APP_DIR } from './util.mjs';
import { projectMeta } from './studio.mjs';
import { readBlocks } from './blocks.mjs';
import { kindOf, keptIn } from '../web/blockseq.js';

export const TAKE_WORDS = ['work/words_refined.json', 'work/tr/words.json', 'work/words.json'];
const clean = (raw) => (Array.isArray(raw) ? raw : [])
  .filter((w) => Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]) && String(w[2]).trim())
  .map((w) => [Number(w[0]), Math.max(Number(w[0]), Number(w[1])), String(w[2]).trim()])
  .sort((a, b) => a[0] - b[0]);

// The canvas take's words. Files older than the canvas take (activeSince) belong to an earlier take.
export function takeWords(dir) {
  const since = projectMeta(dir)?.activeSince || 0;
  const file = TAKE_WORDS.find((f) => existsSync(join(dir, f)) && mtime(join(dir, f)) > since) || null;
  return { file, words: file ? clean(readJSON(join(dir, file), [])) : [] };
}

// A file block's own words (its own seconds), if it has been transcribed.
export function fileWordsPath(block) {
  const stem = basename(block.source.file, extname(block.source.file));
  return [`work/tr/${stem}/words_refined.json`, `work/tr/${stem}/words.json`, `work/tr_${stem}/words.json`, `source/${stem}_transcript/words.json`];
}
function fileWords(dir, block) {
  const file = fileWordsPath(block).find((f) => existsSync(join(dir, f)));
  return { file: file || null, words: file ? clean(readJSON(join(dir, file), [])) : [] };
}

// Take seconds → export seconds within one part's kept pieces (null when the cut removes that moment).
function mapper(segs) {
  const cum = [];
  let acc = 0;
  for (const [a, b] of segs) { cum.push(acc); acc += b - a; }
  const find = (t) => { let lo = 0, hi = segs.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t < segs[m][0]) hi = m - 1; else if (t >= segs[m][1]) lo = m + 1; else return m; } return -1; };
  return { find, cum, total: acc };
}

// Every word that plays in the export, in order: { s, e, w, block } (export seconds), and the sections (blocks) with
// where each starts. missing = file blocks without words.
export function finalWords(dir, parts, doc = undefined) {
  if (doc === undefined) doc = readBlocks(dir);
  const blocks = doc?.blocks || [];
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  const take = takeWords(dir);
  const out = [], sections = [], missing = [], files = new Set();
  const section = (b, start) => { if (b && !sections.some((x) => x.id === b.id && Math.abs(x.start - start) < 1e-3)) sections.push({ id: b.id, label: b.label, type: b.type, start }); };
  for (const p of parts) {
    if (p.kind === 'file') {
      const b = byId[p.blocks?.[0]];
      if (!b) continue;
      section(b, p.start);
      const fw = fileWords(dir, b);
      if (!fw.file) { missing.push({ id: b.id, label: b.label, file: b.source.file, want: fileWordsPath(b)[1] }); continue; }
      files.add(fw.file);
      for (const [s, e, w] of fw.words) {
        if ((s + e) / 2 >= p.total) continue;
        out.push({ s: p.start + s, e: p.start + Math.min(e, p.total), w, block: b.id });
      }
      continue;
    }
    const segs = p.segs || [[0, p.total]];
    const m = mapper(segs);
    // The take blocks this part plays: its own (a block run) or, for a plain export, every take block in order.
    const own = (p.blocks ? p.blocks.map((id) => byId[id]) : blocks).filter((b) => b && kindOf(b) === 'take' && keptIn(segs, b.source.take[0], b.source.take[1]) > 1e-3);
    for (const b of own) {
      const t = Math.max(b.source.take[0], segs[0][0]);
      let k = m.find(t);
      if (k < 0) k = segs.findIndex(([a]) => a >= t);
      if (k >= 0) section(b, p.start + m.cum[k] + Math.max(0, t - segs[k][0]));
    }
    if (take.words.length) files.add(take.file);
    for (const [s, e, w] of take.words) {
      const mid = (s + e) / 2;
      const k = m.find(mid);
      if (k < 0) continue;
      const blk = own.find((b) => mid >= b.source.take[0] && mid < b.source.take[1]);
      if (p.blocks && !blk) continue; // a block run only plays its own blocks' words
      const [a, bEnd] = segs[k];
      const base = p.start + m.cum[k] - a;
      out.push({ s: base + Math.max(s, a), e: base + Math.min(e, bEnd), w, block: blk?.id || null });
    }
  }
  out.sort((x, y) => x.s - y.s);
  sections.sort((x, y) => x.start - y.start);
  // One block (the whole take) is no sections.
  const useful = new Set(sections.map((x) => x.id)).size > 1;
  return { words: out, sections: useful ? sections : [], missing, files: [...files], takeFile: take.file };
}

// ---- text helpers ----
export const sentenceEnd = (w) => /[.!?…]["'”’)\]]*$/.test(w);
// Whisper splits some words ("Co" "-work", "don" "'t"): those pieces join without a space.
const glue = (prev, w) => /^[-'’][\p{L}\p{N}]/u.test(w) || /^[.,!?;:%…)\]}”’]/u.test(w) || /[-(\[{“]$/.test(prev);
export function joinWords(list) {
  let s = '';
  for (const w of list) s += !s ? w : glue(s, w) ? w : ` ${w}`;
  return s;
}

// ---- subtitle cues (the transcribe skill's SRT rules: break on a pause, a sentence end, the length or the duration) ----
// opts: maxChars (per line), maxLines (1 | 2), maxDur (s), minGap (s between cues), pauses (split on pauses and
// sentence ends), pause (s), minDur (s, a short cue stays up longer when there's room), fits(line) = extra width check.
export const CUE_DEFAULTS = { maxChars: 42, maxLines: 2, maxDur: 6, minGap: 0.1, pauses: true, pause: 0.6, minDur: 0.8 };
export function cueOptions(o = {}) {
  const n = (v, d, a, b) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(b, Math.max(a, Number(v))) : d);
  return { maxChars: Math.round(n(o.maxChars, 42, 10, 80)), maxLines: Number(o.maxLines) === 1 ? 1 : 2, maxDur: n(o.maxDur, 6, 1, 20),
    minGap: n(o.minGap, 0.1, 0, 1), pauses: o.pauses !== false, pause: n(o.pause, 0.6, 0.2, 3), minDur: n(o.minDur, 0.8, 0, 3) };
}

// The words of one cue as lines (null when they don't fit in maxLines lines of maxChars).
function layout(ws, o, fits) {
  const ok = (line) => line.length <= o.maxChars && (!fits || fits(line));
  const all = joinWords(ws.map((x) => x.w));
  if (ok(all)) return [all];
  if (o.maxLines < 2 || ws.length < 2) return null;
  let best = null;
  for (let i = 1; i < ws.length; i++) {
    const a = joinWords(ws.slice(0, i).map((x) => x.w)), b = joinWords(ws.slice(i).map((x) => x.w));
    if (!ok(a) || !ok(b)) continue;
    // Balanced lines, a little in favour of breaking after punctuation.
    const score = Math.abs(a.length - b.length) - (/[,;:.!?]$/.test(a) ? 6 : 0);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best?.lines || null;
}

export function buildCues(words, opts = {}, fits = null) {
  const o = cueOptions(opts);
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1];
      const brk = w.block !== cur[0].block
        || (o.pauses && w.s - last.e > o.pause)
        || w.e - cur[0].s > o.maxDur
        || (o.pauses && sentenceEnd(last.w) && joinWords(cur.map((x) => x.w)).length > 12)
        || !layout([...cur, w], o, fits);
      if (brk) { groups.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const cues = groups.map((g) => ({ start: g[0].s, end: g[g.length - 1].e, lines: layout(g, o, fits) || [joinWords(g.map((x) => x.w))], block: g[0].block }));
  // Gaps and short cues: keep minGap between cues; a short cue stays up to minDur when the next one leaves room.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], next = cues[i + 1];
    const limit = next ? next.start - o.minGap : Infinity;
    if (c.end - c.start < o.minDur) c.end = Math.max(c.end, Math.min(c.start + o.minDur, limit));
    if (c.end > limit) c.end = Math.max(c.start + 0.04, limit);
  }
  return cues;
}

// ---- SRT / VTT ----
const stamp = (t, sep) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};
export const srt = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n');
export const vtt = (cues) => `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`).join('\n')}`;

// ---- burned-in captions (the Video export) ----
// Geist SemiBold, white with a soft dark shadow, drawn by ffmpeg's libass. 16:9: centred low in the frame, inside the
// title-safe area; 9:16: inside the Shorts safe zone (x 60–940, above y 1440, clear of the buttons on the right).
export const CAPTION_FONT = join(APP_DIR, 'web', 'fonts', 'geist-sans-latin-600-normal.ttf');
export function captionFrame(W, H) {
  if (H > W) {
    const size = Math.round(W * 0.06);
    // The text's bottom (and its shadow) stays above y 1440 of 1920: clear of the caption, buttons and progress bar.
    return { size, left: Math.round(W * 60 / 1080), right: Math.round(W * 140 / 1080), bottom: Math.round(H * 480 / 1920 + size * 0.25), width: Math.round(W * 880 / 1080) };
  }
  const size = Math.round(H * 0.05);
  return { size, left: Math.round(W * 0.1), right: Math.round(W * 0.1), bottom: Math.round(H * 0.075), width: Math.round(W * 0.8) };
}
// Estimated width of a line in Geist SemiBold (em per character), so lines never need a third row.
const EM = (ch) => (/[il.,:;'!|ı]/.test(ch) ? 0.27 : /[fjrt()\-"]/.test(ch) ? 0.4 : /[ ]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.86
  : /[A-Z]/.test(ch) ? 0.68 : /[0-9]/.test(ch) ? 0.6 : 0.57);
export const lineWidth = (s, size) => [...s].reduce((t, ch) => t + EM(ch), 0) * size;

const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (s) => s.replace(/\\/g, '/').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'));

// look (Simple mode's Captions tool, web/simple-flow.js CAPTION_LOOKS): 'clean' (the default: white with a soft
// shadow), 'bold' (bigger, capitals, a dark outline) or 'boxed' (white on a dark box).
export const CAPTION_LOOK_KEYS = ['clean', 'bold', 'boxed'];
export function assFile(cues, W, H, from = 0, to = Infinity, look = 'clean') {
  const fr0 = captionFrame(W, H), bold = look === 'bold', boxed = look === 'boxed';
  const fr = bold ? { ...fr0, size: Math.round(fr0.size * 1.15) } : fr0;
  const shadow = Math.max(2, Math.round(fr.size * 0.06));
  const rows = cues.filter((c) => c.end > from + 0.01 && c.start < to - 0.01).map((c) => {
    const a = Math.max(0, c.start - from), b = Math.min(to, c.end) - from;
    // Layer 0: a soft shadow (the text, dark and blurred, a little lower); layer 1: the crisp white text.
    const text = c.lines.map((l) => assText(bold ? l.toUpperCase() : l)).join('\\N');
    if (bold || boxed) return `Dialogue: 1,${assTime(a)},${assTime(b)},Caption,,0,0,0,,${text}`;
    return `Dialogue: 0,${assTime(a)},${assTime(b)},Shadow,,0,0,0,,{\\blur${Math.round(fr.size * 0.14)}}${text}\n` +
      `Dialogue: 1,${assTime(a)},${assTime(b)},Caption,,0,0,0,,${text}`;
  });
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    (bold ? `Style: Caption,Geist SemiBold,${fr.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(fr.size * 0.08))},0,2,${fr.left},${fr.right},${fr.bottom},1\n`
      : boxed ? `Style: Caption,Geist SemiBold,${fr.size},&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,3,${Math.max(4, Math.round(fr.size * 0.22))},0,2,${fr.left},${fr.right},${fr.bottom},1\n`
      : `Style: Caption,Geist SemiBold,${fr.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,${fr.left},${fr.right},${fr.bottom},1\n`) +
    `Style: Shadow,Geist SemiBold,${fr.size},&H50000000,&H50000000,&H50000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,${fr.left},${fr.right},${fr.bottom - shadow},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${rows.join('\n')}\n`;
}

// The cues for burning in: the Subtitles settings, with lines no wider than the caption area.
export function captionCues(dir, parts, doc, opts, W, H) {
  const fr = captionFrame(W, H);
  const { words } = finalWords(dir, parts, doc);
  return buildCues(words, opts, (line) => lineWidth(line, fr.size) <= fr.width * 0.94);
}

// Hook for server/export.mjs: adds the captions to the picture chain (cur = the label of the finished picture) for the
// stretch [from, to) of the export and returns the new label; without captions (or words) it returns cur unchanged.
const cueCache = new Map();
export function burnCaptions(dir, { f, cur, jobRel, W, H, captions, parts, doc, from = 0, to = Infinity, tag = '' }) {
  if (!captions || captions.on === false) return cur;
  const key = `${jobRel}:${W}x${H}`;
  let cues = cueCache.get(key);
  if (!cues) { cues = captionCues(dir, parts, doc, captions, W, H); cueCache.set(key, cues); setTimeout(() => cueCache.delete(key), 60000).unref?.(); }
  if (!cues.length) {
    if (!from) throw new Error('There are no words to caption: transcribe the take first (work/tr/words.json).');
    return cur;
  }
  const fonts = `${jobRel}/fonts`;
  mkdirSync(join(dir, fonts), { recursive: true });
  if (!existsSync(join(dir, fonts, basename(CAPTION_FONT)))) copyFileSync(CAPTION_FONT, join(dir, fonts, basename(CAPTION_FONT)));
  const file = `${jobRel}/captions${tag ? `_${tag}` : ''}.ass`;
  writeFileSync(join(dir, file), assFile(cues, W, H, from, to, CAPTION_LOOK_KEYS.includes(captions.look) ? captions.look : 'clean'));
  const label = `[cap${tag}]`;
  f.push(`${cur}ass=filename=${file}:fontsdir=${fonts}${label}`);
  return label;
}
