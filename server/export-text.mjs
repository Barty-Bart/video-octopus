// Transcript and Subtitles exports (the Export panel's Transcript and Subtitles kinds), both on the final timeline:
// the take's words through the locked cut and the blocks in order, plus each file block's own words when it has a
// transcript (server/export-words.mjs). Transcript: plain text or Markdown, with or without timecodes (every
// paragraph or every sentence) and the blocks as section headings. Subtitles: SRT or VTT, cues by the transcribe
// skill's rules (line length, lines, cue length, pauses and sentence ends, a minimum gap). Both write into renders/
// (<project>_transcript_vN.txt|md, <project>_subtitles_vN.srt|vtt) and log to WORKLOG.md; a preview comes back first.
import { readdirSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectMeta, appendWorklog } from './studio.mjs';
import { planParts } from './export-layers.mjs';
import { finalWords, buildCues, cueOptions, srt, vtt, joinWords, sentenceEnd } from './export-words.mjs';
import { FPS } from '../web/layout.js';

const KINDS = {
  transcript: { name: 'transcript', exts: ['txt', 'md'] },
  subtitles: { name: 'subtitles', exts: ['srt', 'vtt'] },
};
const tc = (t) => {
  t = Math.max(0, Math.floor(t + 1e-6));
  const hh = Math.floor(t / 3600), mm = Math.floor(t / 60) % 60, ss = t % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The export's parts as the video export builds them (the same plan the Layers export uses).
export function timelineParts(id, dir, body = {}) {
  const plan = planParts(id, dir, { layout: body.layout, useCut: body.useCut !== false, timelineOnly: true });
  return {
    parts: plan.parts.map((p) => ({ kind: p.kind, name: p.name, segs: p.segs, total: p.frames / FPS, start: p.start / FPS, blocks: p.blocks })),
    doc: plan.seq?.doc, total: plan.frames / FPS, cut: plan.useCut && plan.cut ? plan.cut.file : null,
  };
}

function nextFile(dir, id, kind, ext) {
  const base = `${id}_${KINDS[kind].name}`;
  let n = 1;
  try {
    for (const f of readdirSync(join(dir, 'renders'))) {
      const m = new RegExp(`^${esc(base)}_v(\\d+)\\.(${KINDS[kind].exts.join('|')})$`).exec(f);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  } catch {}
  return `renders/${base}_v${n}.${ext}`;
}

// ---- transcript ----
// Paragraphs: a new block starts one; otherwise one ends at a sentence end after a pause, or once it's long.
function paragraphs(words) {
  const out = [];
  let cur = null;
  words.forEach((w, i) => {
    if (!cur || w.block !== cur.block) { cur = { block: w.block, words: [], sentences: 0 }; out.push(cur); }
    cur.words.push(w);
    const next = words[i + 1];
    if (sentenceEnd(w.w)) {
      cur.sentences++;
      const gap = next ? next.s - w.e : 0;
      if (next && next.block === cur.block && (gap >= 1.2 || (cur.words.length >= 70 && cur.sentences >= 3) || cur.words.length >= 150)) cur = null;
    } else if (cur.words.length >= 220) cur = null; // no punctuation: still break up the wall of text
  });
  return out;
}
function sentences(ws) {
  const out = [];
  let cur = [];
  for (const w of ws) { cur.push(w); if (sentenceEnd(w.w)) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out;
}

export function transcriptText(fw, { format = 'txt', timecodes = 'none', headings = true, title = '' } = {}) {
  const md = format === 'md';
  const secs = headings ? fw.sections : [];
  const L = [];
  if (md && title) L.push(`# ${title}`, '');
  const stamp = (t) => (timecodes !== 'none' ? `[${tc(t)}] ` : '');
  let lastSection = null;
  for (const p of paragraphs(fw.words)) {
    // The section heading before the first paragraph of each block (a paragraph without a block: the section it's in).
    const sec = p.block ? secs.find((s) => s.id === p.block) : secs.filter((s) => s.start <= p.words[0].s + 1e-3).pop();
    if (sec && sec !== lastSection) {
      lastSection = sec;
      const head = `${sec.label}${timecodes !== 'none' ? ` · ${tc(sec.start)}` : ''}`;
      L.push(md ? `## ${head}` : head, '');
    }
    if (timecodes === 'sentence') {
      for (const s of sentences(p.words)) L.push(`${stamp(s[0].s)}${joinWords(s.map((x) => x.w))}${md ? '  ' : ''}`);
      if (md) L[L.length - 1] = L[L.length - 1].replace(/ {2}$/, '');
    } else L.push(`${stamp(p.words[0].s)}${joinWords(p.words.map((x) => x.w))}`);
    L.push('');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Headings for blocks without words go in their place (a sponsor read with no transcript yet).
function withMissing(fw) {
  if (!fw.missing.length) return fw;
  const words = fw.words.slice();
  for (const m of fw.missing) {
    const sec = fw.sections.find((s) => s.id === m.id);
    if (sec) words.push({ s: sec.start, e: sec.start, w: `(${m.label}: no transcript yet)`, block: m.id });
  }
  return { ...fw, words: words.sort((a, b) => a.s - b.s) };
}

// ---- the export ----
function build(id, dir, kind, b) {
  const tl = timelineParts(id, dir, b);
  const fw = finalWords(dir, tl.parts, tl.doc);
  const meta = projectMeta(dir) || {};
  if (kind === 'transcript') {
    const format = b.format === 'md' ? 'md' : 'txt';
    const timecodes = ['paragraph', 'sentence'].includes(b.timecodes) ? b.timecodes : 'none';
    const text = fw.words.length ? transcriptText(withMissing(fw), { format, timecodes, headings: b.headings !== false, title: meta.name || id }) : '';
    return { tl, fw, text, ext: format, settings: { format, timecodes, headings: b.headings !== false && fw.sections.length > 0 },
      stats: { words: fw.words.length, sections: fw.sections.length } };
  }
  const o = cueOptions(b);
  const format = b.format === 'vtt' ? 'vtt' : 'srt';
  const cues = buildCues(fw.words, o);
  const text = cues.length ? (format === 'vtt' ? vtt(cues) : srt(cues)) : '';
  const longest = Math.max(0, ...cues.flatMap((c) => c.lines.map((l) => l.length)));
  return { tl, fw, text, ext: format, settings: { format, ...o }, cues,
    stats: { cues: cues.length, words: fw.words.length, longestLine: longest, lines: Math.max(0, ...cues.map((c) => c.lines.length)), longestCue: Math.max(0, ...cues.map((c) => c.end - c.start)) } };
}

function summary(r) {
  return {
    total: r.tl.total, cut: r.tl.cut, parts: r.tl.parts.map((p) => ({ kind: p.kind, name: p.name, start: p.start, total: p.total })),
    sections: r.fw.sections.map((s) => ({ label: s.label, start: s.start })), missing: r.fw.missing, files: r.fw.files, takeFile: r.fw.takeFile,
    settings: r.settings, stats: r.stats,
  };
}

export function textPreview(id, dir, kind, b) {
  const r = build(id, dir, kind, b);
  return { ...summary(r), text: r.text, next: nextFile(dir, id, kind, r.ext) };
}

export function saveText(id, dir, kind, b) {
  const r = build(id, dir, kind, b);
  if (!r.text) throw new Error(r.fw.takeFile ? 'No words play on this timeline.' : 'There is no transcript yet: transcribe the take first (work/tr/words.json).');
  const file = nextFile(dir, id, kind, r.ext);
  mkdirSync(join(dir, 'renders'), { recursive: true });
  writeFileSync(join(dir, file), r.text);
  const where = `${r.tl.total.toFixed(1)} s${r.tl.cut ? `, cut from ${r.tl.cut}` : ', whole take'}${r.tl.parts.length > 1 ? `, blocks: ${r.tl.parts.map((p) => p.name).join(' · ')}` : ''}`;
  const from = `words from ${r.fw.files.join(' + ') || 'none'}`;
  if (kind === 'transcript') {
    const s = r.settings;
    appendWorklog(dir, `Exported transcript ${file} (${s.format === 'md' ? 'Markdown' : 'plain text'}, ${r.stats.words} words${s.timecodes !== 'none' ? `, timecodes every ${s.timecodes}` : ''}${s.headings ? `, ${r.stats.sections} section headings` : ''}; ${where}; ${from})`);
  } else {
    const s = r.settings;
    appendWorklog(dir, `Exported subtitles ${file} (${s.format.toUpperCase()}, ${r.stats.cues} cues, at most ${s.maxChars} characters × ${s.maxLines} line${s.maxLines > 1 ? 's' : ''}, cues up to ${s.maxDur} s, gap ${s.minGap} s${s.pauses ? ', split on pauses and sentence ends' : ''}; ${where}; ${from})`);
  }
  return { ...summary(r), file, text: r.text };
}

// Audio, transcript and subtitle files in renders/, for the Renders tab's cards.
const TEXT_RE = /_(mix|voice)_v\d+\.(wav|m4a|mp3)$|_transcript_v\d+\.(txt|md)$|_subtitles_v\d+\.(srt|vtt)$/;
export function listTextExports(dir, probeFile) {
  let names = [];
  try { names = readdirSync(join(dir, 'renders')); } catch { return []; }
  return names.filter((n) => TEXT_RE.test(n)).flatMap((n) => {
    try {
      const st = statSync(join(dir, 'renders', n));
      if (!st.isFile() || !st.size) return [];
      const ext = n.split('.').pop();
      const kind = /^(wav|m4a|mp3)$/.test(ext) ? 'audio' : /^(srt|vtt)$/.test(ext) ? 'subtitles' : 'transcript';
      const x = { file: `renders/${n}`, name: n, kind, ext, at: st.mtimeMs, bytes: st.size };
      if (kind === 'audio') { const p = probeFile?.(join(dir, 'renders', n)); if (p) x.duration = p.duration; x.contents = /_voice_v\d+\./.test(n) ? 'voice' : 'mix'; }
      else if (st.size < 4e6) {
        const t = readFileSync(join(dir, 'renders', n), 'utf8');
        // Words, leaving out timecodes, headings' markers and the "·" before a heading's time.
        x.count = kind === 'subtitles' ? (t.match(/-->/g) || []).length : (t.match(/\S+/g) || []).filter((w) => !/^(\[\d[\d:]*\]|#+|·|\d+:\d\d)$/.test(w)).length;
      }
      return [x];
    } catch { return []; }
  }).sort((a, b) => b.at - a.at);
}

// Routes: GET /export-text?kind=…&… (preview), POST /export-text {kind, …} (save).
export async function textRoute(req, res, { id, dir, action, url, send, body }) {
  if (action !== '/export-text') return false;
  try {
    if (req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const b = { ...q, useCut: q.useCut !== '0', headings: q.headings !== '0', pauses: q.pauses !== '0' };
      send(res, 200, textPreview(id, dir, KINDS[q.kind] ? q.kind : 'transcript', b));
    } else {
      const b = await body(req);
      send(res, 200, saveText(id, dir, KINDS[b.kind] ? b.kind : 'transcript', b));
    }
  } catch (e) { send(res, 400, { error: e.message }); }
  return true;
}
