// Shots and zooms: work/shots.json and work/zooms.json v2, their clean-up, the edits made on the
// Shots and Zooms lanes, the inspector and by Claude, and how they follow the sections and the cut. Pure: no DOM, no
// files, shared by the browser and the server (server/shots.mjs reads and writes the files and serves the routes).
// The look at a moment is worked out in web/layout.js (lookAt, transitionAt, zoomAt), which explains the time model.
//
// work/shots.json  { v: 1, shots: [shot, …], migrated? }      shots in order of start; a shot runs to the next one's start
//   shot { id, start, word?, name?, look?, in?, by?, status?, was?, section? }
//     start    source seconds (the take's own clock, the same as the words and the cut); the first shot starts at 0
//     word     index in the words list of the shot's first word (the first word whose middle is at or after start).
//              Video Octopus derives it from start whenever it reads the file; when the cut changes, the shot follows it
//     name     up to 60 characters (missing = just the number)
//     look     a partial layout (web/layout.js normalizeLook) merged over project.json "layout" (missing = the base)
//     in       the transition into this shot { type 'fade'|'slide'|'zoom', dur 0.2–1.5 s, dir 'left'|'right'|'up' (a
//              slide) }; missing = a cut. The first shot has none.
//     by       'you' | 'claude' (missing = you)      status  'proposed' | 'kept' (missing = kept; proposed draws dashed)
//     was      on a proposed change to a shot that was already there: its { look, in, name } before (No thanks puts
//              them back); a proposed shot without "was" is new, and No thanks removes it
//     section  the id of the take block (section) that starts here. A section edge is always a shot edge: Video Octopus keeps
//              a shot at every take block's start and moves it with that edge; it can't be merged or moved as a shot
//   migrated   { at, blocks: [{ id, preset, shot }] }: block layouts Video Octopus moved into shots (once, on first read)
//
// work/zooms.json  { v: 2, items: [zoom, …] }   items in order of a
//   zoom { id, target, a, b, c, d, box?, amount?, speed?, word?, name?, why?, by?, status?, was? }
//     target   'camera' | 'screen'
//     a…d      source seconds: a → b eases in, b → c holds, c → d eases out; ramps 0.1–2 s each, at least MIN_ZOOM long
//     box      { x, y, w, h }: fractions of the target's picture after its crop (0–1, at least 0.05 a side); Video Octopus
//              gives it the target's shape on the frame when it's set, so nothing stretches
//     amount   1–4: a punch-in without a box, that much closer than the shot's framing (face punch-ins 1.03–1.15).
//              A box wins.
//     speed    'smooth' (missing) | 'even' | 'snap'            word  index of its first word (missing: none in it)
//   v1 (the talking-head-zoom skill's { zooms: [{ in: [a, b], out: [c, d], amount, why }] }, on the locked cut's
//   timeline) still reads: as camera punch-ins, mapped to source seconds through the cut, by Claude, kept.
//
// ctx, for the functions below: { duration (the take's length, source seconds), words ([[start, end, text], …] as
// Video Octopus reads them), cut (the locked cut's segments, source seconds, or null), base (the normalized project layout),
// blocks (blocks.json's blocks, for section names) }.

import { PRESETS, TRANSITION_DUR, TRANSITION_MIN, TRANSITION_MAX, SLIDE_DIRS, ZOOM_SPEEDS, ZOOM_TARGETS, MIN_SHOT, DEFAULT_PUNCH,
  normalizeLook, mergeLook, lookKeys, shotAt, cutMap, playedAt } from './layout.js';
import { keptIn, kindOf } from './blockseq.js';

export const MIN_ZOOM = 0.3;     // seconds
export const ZOOM_RAMP = 0.6;    // a new zoom's ease in and ease out
export const ZOOM_DUR = 3;       // a new zoom made at the playhead
export const RAMP_MIN = 0.1, RAMP_MAX = 2;

const isNum = (v) => v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const str = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : undefined);
const okId = (x) => typeof x === 'string' && /^[\w-]{1,40}$/.test(x);
export const clock = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };
const listOf = (shots) => (Array.isArray(shots) ? shots : Array.isArray(shots?.shots) ? shots.shots : []);
const itemsOf = (zooms) => (Array.isArray(zooms) ? zooms : Array.isArray(zooms?.items) ? zooms.items : []);
const dur = (ctx) => (Number.isFinite(ctx?.duration) && ctx.duration > 0 ? ctx.duration : Infinity);
export function freeId(list, prefix = 's') {
  let n = 0;
  for (const x of list) { const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id || ''); if (m) n = Math.max(n, Number(m[1])); }
  return `${prefix}${n + 1}`;
}

// ---- words ----
// Is a word kept by the cut (its middle inside a kept part)?
export const keptWord = (w, cut) => { if (!cut?.length) return true; const m = (w[0] + w[1]) / 2; return cut.some(([a, b]) => m >= a && m < b); };
// The anchor word of a break at t: the first word whose middle is at or after t (null after the last word).
export function wordAt(t, words) {
  for (let i = 0; i < (words || []).length; i++) if ((words[i][0] + words[i][1]) / 2 >= t - 1e-6) return i;
  return null;
}
// Where a break before word i goes: on the cut's join if there is one in the gap before it, in the middle of a pause
// (0.25 s or more), else 40 ms before the word (never into the word before). Only kept words count as "before".
export function breakBefore(i, words, cut) {
  const w = words?.[i];
  if (!w) return null;
  let j = i - 1;
  while (j >= 0 && !keptWord(words[j], cut)) j--;
  const prevEnd = j >= 0 ? words[j][1] : 0;
  // (a kept part that starts before the word ends: the cut may have clipped the word's very start)
  const seg = cut?.length ? [...cut].sort((a, b) => a[0] - b[0]).find(([a]) => a > prevEnd + 1e-6 && a < w[1]) : null;
  if (seg) return r3(seg[0]);
  if (w[0] - prevEnd >= 0.25) return r3((prevEnd + w[0]) / 2);
  return r3(Math.max(prevEnd, w[0] - 0.04));
}
// S at the playhead: the break snaps to a pause within 0.15 s (the gap between two kept words of 0.25 s or more, or
// with a cut join in it), else to the nearest kept word's start. → { t, word }. No words: t as it is.
export function snapBreak(t, words, cut) {
  const ks = (words || []).map((w, i) => i).filter((i) => keptWord(words[i], cut));
  if (!ks.length) return { t: r3(t), word: null };
  let best = null;
  for (let n = 0; n + 1 < ks.length; n++) {
    const e = words[ks[n]][1], s = words[ks[n + 1]][0];
    const pause = s - e >= 0.25 || (cut?.length && cut.some(([a]) => a > e + 1e-6 && a < words[ks[n + 1]][1]));
    if (!pause || t < e - 0.15 || t > s + 0.15) continue;
    const dist = t < e ? e - t : t > s ? t - s : 0;
    if (!best || dist < best.dist) best = { i: ks[n + 1], dist };
  }
  const i = best ? best.i : ks.reduce((a, k) => (Math.abs(words[k][0] - t) < Math.abs(words[a][0] - t) ? k : a), ks[0]);
  return { t: breakBefore(i, words, cut), word: i };
}

// ---- clean-up ----
export function normTransition(t) {
  if (!t || typeof t !== 'object' || !TRANSITION_DUR[t.type]) return null;
  const out = { type: t.type, dur: Math.round(clamp(isNum(t.dur) ? Number(t.dur) : TRANSITION_DUR[t.type], TRANSITION_MIN, TRANSITION_MAX) * 100) / 100 };
  if (t.type === 'slide') out.dir = SLIDE_DIRS.includes(t.dir) ? t.dir : 'left';
  return out;
}
// One look on top of another, still partial (cam, screen and webcam by field; hidden replaces).
export function combineLooks(look, change) {
  if (!change) return normalizeLook(look);
  const out = structuredClone(look || {});
  for (const [k, v] of Object.entries(change)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] || {}), ...v } : v;
  return normalizeLook(out);
}
// A look without some of its properties: 'cam' (all of it), 'cam.zoom' (one field), 'preset', 'hidden', …
export function withoutKeys(look, keys) {
  if (!look) return null;
  const out = structuredClone(look);
  for (const k of keys || []) {
    const [a, f] = String(k).split('.');
    if (f) { if (out[a] && typeof out[a] === 'object') { delete out[a][f]; if (!Object.keys(out[a]).length) delete out[a]; } } else delete out[a];
  }
  return normalizeLook(out);
}
const sameLook = (a, b) => JSON.stringify(normalizeLook(a)) === JSON.stringify(normalizeLook(b));
const normWas = (w) => {
  if (!w || typeof w !== 'object') return null;
  const look = normalizeLook(w.look), tin = normTransition(w.in), name = str(w.name, 60);
  return { ...(look ? { look } : {}), ...(tin ? { in: tin } : {}), ...(name ? { name } : {}) };
};

// normalizeShots(raw, ctx) → a clean shots doc: shots in order of start (one per start), the first at 0, valid ids,
// looks, transitions and words; nothing past the end of the take.
export function normalizeShots(raw, ctx = {}) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const end = dur(ctx), words = ctx.words || [];
  const rows = [];
  (Array.isArray(d.shots) ? d.shots : []).forEach((s, k) => {
    if (!s || typeof s !== 'object') return;
    const start = isNum(s.start) ? Number(s.start) : Number.isInteger(s.word) && words[s.word] ? breakBefore(s.word, words, ctx.cut) : null;
    if (start == null || (start > 0 && start >= end - 1e-3)) return;
    rows.push({ s, start: r3(Math.max(0, start)), k });
  });
  rows.sort((x, y) => x.start - y.start || x.k - y.k);
  const seen = new Set(), shots = [];
  for (const { s, start } of rows) {
    const prev = shots[shots.length - 1];
    if (prev && start - prev.start < 0.01) { if (s.section && !prev.section && okId(s.section)) prev.section = s.section; continue; }
    const id = okId(s.id) && !seen.has(s.id) ? s.id : null;
    if (id) seen.add(id);
    const shot = { id, start };
    const word = words.length ? wordAt(start, words) : Number.isInteger(s.word) && s.word >= 0 ? s.word : null;
    if (word != null) shot.word = word;
    if (str(s.name, 60)) shot.name = str(s.name, 60);
    const look = normalizeLook(s.look);
    if (look) shot.look = look;
    const tin = normTransition(s.in);
    if (tin) shot.in = tin;
    if (s.by === 'claude') shot.by = 'claude';
    if (s.status === 'proposed') { shot.status = 'proposed'; const was = normWas(s.was); if (was) shot.was = was; }
    if (okId(s.section)) shot.section = s.section;
    shots.push(shot);
  }
  if (!shots.length || shots[0].start > 0) shots.unshift({ id: null, start: 0, ...(words.length && wordAt(0, words) != null ? { word: wordAt(0, words) } : {}) });
  shots[0].start = 0;
  delete shots[0].in;
  delete shots[0].section;
  for (const s of shots) if (!s.id) { s.id = freeId(shots.filter((x) => x.id)); }
  const out = { v: 1, shots };
  if (d.migrated && typeof d.migrated === 'object') out.migrated = { at: str(d.migrated.at, 40) || null, blocks: (Array.isArray(d.migrated.blocks) ? d.migrated.blocks : []).slice(0, 100) };
  return out;
}

const normBox = (b) => {
  if (!b || typeof b !== 'object' || !['x', 'y', 'w', 'h'].every((k) => isNum(b[k]))) return null;
  const w = clamp(Number(b.w), 0.05, 1), h = clamp(Number(b.h), 0.05, 1);
  return { x: r4(clamp(Number(b.x), 0, 1 - w)), y: r4(clamp(Number(b.y), 0, 1 - h)), w: r4(w), h: r4(h) };
};
// One zoom, cleaned up: times inside the take, at least MIN_ZOOM long, ramps 0.1–2 s that fit; null if unusable.
export function normZoom(z, ctx = {}) {
  if (!z || typeof z !== 'object' || !isNum(z.a) || !isNum(z.d)) return null;
  const end = dur(ctx), words = ctx.words || [];
  let a = clamp(Math.min(Number(z.a), Number(z.d)), 0, end), d = clamp(Math.max(Number(z.a), Number(z.d)), 0, end);
  if (d - a < MIN_ZOOM) { d = Math.min(end, a + MIN_ZOOM); a = Math.max(0, d - MIN_ZOOM); if (d - a < MIN_ZOOM - 1e-6) return null; }
  const span = d - a, lo = Math.min(RAMP_MIN, span / 2);
  let ri = clamp(isNum(z.b) ? Number(z.b) - a : ZOOM_RAMP, RAMP_MIN, RAMP_MAX), ro = clamp(isNum(z.c) ? d - Number(z.c) : ZOOM_RAMP, RAMP_MIN, RAMP_MAX);
  if (ri + ro > span) { const k = span / (ri + ro); ri = Math.max(lo, ri * k); ro = Math.max(lo, Math.min(ro * k, span - ri)); ri = Math.min(ri, span - ro); }
  const box = normBox(z.box);
  const out = { id: okId(z.id) ? z.id : null, target: ZOOM_TARGETS[z.target] ? z.target : box ? 'screen' : 'camera', a: r3(a), b: r3(a + ri), c: r3(d - ro), d: r3(d) };
  if (out.c < out.b) out.c = out.b;
  if (box) out.box = box;
  if (isNum(z.amount)) out.amount = Math.round(clamp(Number(z.amount), 1, 4) * 1000) / 1000;
  else if (!box) out.amount = DEFAULT_PUNCH;
  if (ZOOM_SPEEDS[z.speed] && z.speed !== 'smooth') out.speed = z.speed;
  const w = words.findIndex((x) => x[1] > a + 0.01 && x[0] < d - 0.01);
  if (w >= 0) out.word = w;
  if (str(z.name, 60)) out.name = str(z.name, 60);
  if (str(z.why, 200)) out.why = str(z.why, 200);
  if (z.by === 'claude') out.by = 'claude';
  if (z.status === 'proposed') {
    out.status = 'proposed';
    if (z.was && typeof z.was === 'object') {
      // "was" may name only what changed (say just the box): the rest is as the zoom is now.
      const w0 = normZoom({ ...z, ...z.was, id: 'was', status: undefined, was: undefined }, ctx);
      if (w0) { delete w0.id; delete w0.word; delete w0.status; delete w0.was; delete w0.by; out.was = w0; }
    }
  }
  return out;
}
// normalizeZooms(raw, ctx) → { v: 2, items } (v1 files converted: cut timeline → source seconds, camera punch-ins).
export function normalizeZooms(raw, ctx = {}) {
  const d = raw && typeof raw === 'object' ? raw : {};
  let list;
  if (!Array.isArray(d.items) && Array.isArray(d.zooms)) {
    const m = cutMap(ctx.cut);
    const pair = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => isNum(x));
    list = d.zooms.filter((x) => x && pair(x.in) && pair(x.out)).map((x) => ({
      target: 'camera', a: m.toSource(x.in[0]), b: m.toSource(x.in[1]), c: m.toSource(x.out[0]), d: m.toSource(x.out[1]),
      amount: isNum(x.amount) ? x.amount : DEFAULT_PUNCH, why: x.why, by: 'claude' }));
  } else list = Array.isArray(d.items) ? d.items : [];
  const seen = new Set();
  const items = list.slice(0, 500).map((z, k) => ({ z: normZoom(z, ctx), k })).filter((x) => x.z).sort((x, y) => x.z.a - y.z.a || x.k - y.k).map((x) => x.z);
  for (const z of items) { if (z.id && !seen.has(z.id)) seen.add(z.id); else z.id = null; }
  for (const z of items) if (!z.id) z.id = freeId(items.filter((x) => x.id), 'z');
  return { v: 2, items };
}

// ---- the shots and the cut ----
export const shotLabel = (list, i) => `Shot ${i + 1}${list[i]?.name ? ` (${list[i].name})` : ''}`;
// Seconds of shot i that play (the cut's kept seconds inside it).
export const playedLength = (shots, i, ctx = {}) => { const L = listOf(shots); return L[i] ? keptIn(ctx.cut || null, L[i].start, i + 1 < L.length ? L[i + 1].start : dur(ctx)) : 0; };

// shotSpans(shots, { cut, duration }) → [{ id, index, start, end, playedStart, playedEnd, played, shot }]: each shot's
// span in source seconds and in played seconds (end of the last shot: duration, or Infinity when unknown).
export function shotSpans(shots, { cut = null, duration = Infinity } = {}) {
  const L = listOf(shots);
  return L.map((s, i) => {
    const end = i + 1 < L.length ? L[i + 1].start : duration;
    const ps = playedAt(s.start, cut), pe = Number.isFinite(end) ? playedAt(end, cut) : Infinity;
    return { id: s.id, index: i, start: s.start, end, playedStart: ps, playedEnd: pe, played: pe - ps, shot: s };
  });
}
// splitByShots(pieces, shots) → [{ index, id, pieces }]: a take part's kept pieces ([[a, b], …] in playing order,
// source seconds) cut at the shot breaks, consecutive pieces of one shot together. For the export: each run renders
// with its shot's look; between two runs of different shots is where that break's transition (transitionsOf) plays.
export function splitByShots(pieces, shots) {
  const L = listOf(shots), out = [];
  for (const [a, b] of pieces || []) {
    let x = a;
    while (x < b - 1e-6) {
      const s = shotAt(x, L);
      if (!s) return [{ index: 0, id: null, pieces: (pieces || []).map((p) => [...p]) }];
      const e = Math.min(b, s.end);
      const last = out[out.length - 1];
      if (last && last.index === s.index) { const lp = last.pieces[last.pieces.length - 1]; if (Math.abs(lp[1] - x) < 1e-6) lp[1] = e; else last.pieces.push([x, e]); }
      else out.push({ index: s.index, id: s.shot.id, pieces: [[x, e]] });
      x = e;
    }
  }
  return out;
}

// followCut(doc, ctx) → { doc, notes, destructive }: shots stay on their words when the cut changes. The take's seconds
// don't move with a cut (only which words play), so a shot keeps its start while its first word is kept; when that
// word is cut it moves to its first kept word; when all its words are cut it merges into the shot before (with a
// note). The first shot and section shots stay where they are.
export function followCut(doc, ctx = {}) {
  const words = ctx.words || [], cut = ctx.cut || null;
  if (!words.length || !cut?.length) return { doc, notes: [], destructive: false };
  const L = doc.shots.map((s) => structuredClone(s));
  const names = new Map(L.map((s, i) => [s.id, shotLabel(L, i)]));
  const anchorOf = (s) => (Number.isInteger(s.word) && words[s.word] ? s.word : wordAt(s.start, words));
  const notes = [];
  let destructive = false;
  for (let i = 1; i < L.length; i++) {
    const s = L[i];
    if (s.section) continue;
    const w = anchorOf(s);
    if (w == null || keptWord(words[w], cut)) continue;
    const next = L[i + 1];
    const until = next ? anchorOf(next) ?? words.length : words.length;
    let k = w + 1;
    while (k < until && !keptWord(words[k], cut)) k++;
    if (k < until) {
      const t = breakBefore(k, words, cut);
      if (t > L[i - 1].start + 1e-3 && (!next || t < next.start - 1e-3)) {
        s.start = t; s.word = k;
        // (A line in the chat: on the cut's clock, as the video plays.)
        notes.push(`${names.get(s.id)} now starts at ${clock(cutMap(cut).toCut(t))}, on “${words[k][2]}”: its first word was cut.`);
        continue;
      }
    }
    notes.push(`${names.get(s.id)} merged into ${names.get(L[i - 1].id)}: all its words were cut.`);
    L.splice(i, 1);
    i--;
    destructive = true;
  }
  return { doc: { ...doc, shots: L }, notes, destructive };
}
// The same for zooms: a zoom whose first word is cut moves to its first kept word (the ease in moves with it); a zoom
// whose words are all cut is removed (with a note). A zoom with no words in it stays where it is.
export function followCutZooms(doc, ctx = {}) {
  const words = ctx.words || [], cut = ctx.cut || null;
  if (!words.length || !cut?.length) return { doc, notes: [], destructive: false };
  const items = [], notes = [];
  let destructive = false;
  itemsOf(doc).forEach((z0, n) => {
    const z = structuredClone(z0), label = `Zoom ${n + 1}${z.name ? ` (${z.name})` : ''}`;
    const w = Number.isInteger(z.word) && words[z.word] ? z.word : words.findIndex((x) => x[1] > z.a + 0.01 && x[0] < z.d - 0.01);
    if (w == null || w < 0 || keptWord(words[w], cut)) return items.push(z);
    let k = w + 1;
    while (k < words.length && words[k][0] < z.d - 0.01 && !keptWord(words[k], cut)) k++;
    if (k < words.length && words[k][0] < z.d - 0.01) {
      const shift = words[k][0] - words[w][0];
      z.a = r3(z.a + shift); z.b = r3(z.b + shift);
      if (z.c < z.b) z.c = z.b;
      if (z.d - z.a < MIN_ZOOM) z.d = r3(z.a + MIN_ZOOM);
      z.word = k;
      notes.push(`${label} now starts at ${clock(cutMap(cut).toCut(z.a))}, on “${words[k][2]}”: its first word was cut.`);
      return items.push(z);
    }
    notes.push(`${label} was removed: all its words were cut.`);
    destructive = true;
  });
  return { doc: { ...doc, items }, notes, destructive };
}

// ---- sections: a shot edge at every section edge ----
// syncSections(doc, blocks) → { doc, changed }. blocks: blocks.json's blocks (null = unknown: nothing changes).
// Every take block that starts after 0:00 has a shot starting there (tied by "section"); a new one starts as a copy of
// the shot it splits. A tied shot moves with its section's start. When a section goes, its shot stays as a plain
// break if it has a look or a transition of its own, else it goes.
export function syncSections(doc, blocks) {
  if (!Array.isArray(blocks)) return { doc, changed: false };
  const edges = new Map();
  for (const b of blocks) {
    if (kindOf(b) !== 'take' || !okId(b.id)) continue;
    const s = r3(b.source.take[0]);
    if (s > 0.01 && ![...edges.values()].some((x) => Math.abs(x - s) < 0.01) && !edges.has(b.id)) edges.set(b.id, s);
  }
  const before = JSON.stringify(doc.shots);
  let L = doc.shots.map((s) => structuredClone(s));
  const loose = new Set();
  for (const s of L) if (s.section) { if (edges.has(s.section)) s.start = edges.get(s.section); else { delete s.section; loose.add(s.id); } }
  for (const [id, t] of edges) {
    if (L.some((s) => s.section === id)) continue;
    const at = L.find((s) => !s.section && Math.abs(s.start - t) < 0.02);
    if (at) { at.start = t; at.section = id; continue; }
    const host = shotAt(t, [...L].sort((a, b) => a.start - b.start));
    L.push({ id: freeId(L), start: t, ...(host?.shot.look ? { look: structuredClone(host.shot.look) } : {}), section: id });
  }
  L.sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of L) {
    const prev = out[out.length - 1];
    // Two shots on one start: one shot, keeping the earlier one (its look) with the section's tie.
    if (prev && s.start - prev.start < 0.01) {
      if (s.section && !prev.section && prev.start > 0) { prev.section = s.section; prev.start = s.start; }
      if (!prev.look && s.look) prev.look = s.look;
      continue;
    }
    if (prev && loose.has(s.id) && !s.in && sameLook(s.look, prev.look)) continue;
    out.push(s);
  }
  if (out.length && out[0].section && out[0].start > 0.01) out.unshift({ id: freeId(out), start: 0 });
  const next = { ...doc, shots: out };
  return { doc: next, changed: JSON.stringify(out) !== before };
}

// migrateLayouts(doc, blocksDoc, now) → { doc, blocks, moved }: every take block with its own layout becomes a shot at
// the block's start with that preset as its look, and the block keeps no layout. Run it after syncSections (so the
// shot is there). File blocks keep theirs: they are their own picture, not part of the take's timeline.
export function migrateLayouts(doc, blocksDoc, now = new Date().toISOString()) {
  const moved = [];
  if (!blocksDoc || !Array.isArray(blocksDoc.blocks)) return { doc, blocks: blocksDoc, moved };
  const blocks = blocksDoc.blocks.map((b) => structuredClone(b));
  const L = doc.shots.map((s) => structuredClone(s));
  for (const b of blocks) {
    if (kindOf(b) !== 'take' || !PRESETS[b.layout]) continue;
    const s0 = r3(b.source.take[0]);
    let shot = s0 <= 0.01 ? L[0] : L.find((s) => Math.abs(s.start - s0) < 0.02);
    if (!shot) {
      const host = shotAt(s0, L);
      shot = { id: freeId(L), start: s0, ...(host?.shot.look ? { look: structuredClone(host.shot.look) } : {}) };
      L.splice(host ? host.index + 1 : L.length, 0, shot);
    }
    shot.look = combineLooks(shot.look, { preset: b.layout });
    moved.push({ id: b.id, preset: b.layout, shot: shot.id });
    delete b.layout;
  }
  if (!moved.length) return { doc, blocks: blocksDoc, moved };
  return { doc: { ...doc, shots: L, migrated: { at: now, blocks: [...(doc.migrated?.blocks || []), ...moved].slice(-100) } }, blocks: { ...blocksDoc, blocks }, moved };
}

// ---- the bridge for what still gives a whole block one layout ----
// blockPresets(blocks, shots) → { <take block id>: preset }: the preset of the shot at each take block's start. The
// block menu ("Layout for this block") and the export's block parts read this until they work shot by shot.
export function blockPresets(blocks, shots) {
  const out = {};
  for (const b of blocks || []) {
    if (kindOf(b) !== 'take') continue;
    const p = shotAt(b.source.take[0] + 1e-6, listOf(shots))?.shot.look?.preset;
    if (p) out[b.id] = p;
  }
  return out;
}
// The block menu's "Layout for this block" on a take block: the preset of the shot at its start (null clears it).
export function setBlockPreset(doc, block, preset) {
  const L = doc.shots.map((s) => structuredClone(s));
  const s0 = r3(block.source.take[0]);
  const shot = s0 <= 0.01 ? L[0] : L.find((s) => Math.abs(s.start - s0) < 0.02);
  if (!shot) return doc; // (the section edges aren't synced yet: syncSections first)
  const look = PRESETS[preset] ? combineLooks(shot.look, { preset }) : withoutKeys(shot.look, ['preset']);
  if (look) shot.look = look; else delete shot.look;
  return { ...doc, shots: L };
}

// ---- proposals ----
// What the shots look like with every proposal turned down: proposed changes back to "was", new proposed shots gone.
// This is what the export renders and the preview plays. keep: ids of proposals to leave as they are (the one the
// creator is looking at in the preview: "Proposed").
export function shotsWithoutProposals(doc, keep = null) {
  const L = [];
  const peek = keep ? new Set(keep) : null;
  for (const s0 of listOf(doc)) {
    if (s0.status !== 'proposed' || peek?.has(s0.id)) { L.push(s0); continue; }
    const s = structuredClone(s0);
    if (s.was || !L.length || s.section) {
      delete s.look; delete s.in; delete s.name;
      Object.assign(s, structuredClone(s.was || {}));
      delete s.status; delete s.was; delete s.by;
      if (!L.length) delete s.in;
      L.push(s);
    }
  }
  return { ...(Array.isArray(doc) ? {} : doc), v: 1, shots: L };
}
export function zoomsWithoutProposals(doc, keep = null) {
  const items = [];
  const peek = keep ? new Set(keep) : null;
  for (const z0 of itemsOf(doc)) {
    if (z0.status !== 'proposed' || peek?.has(z0.id)) { items.push(z0); continue; }
    if (!z0.was) continue;
    const z = { ...structuredClone(z0), ...structuredClone(z0.was) };
    delete z.status; delete z.was; delete z.by;
    items.push(z);
  }
  return { v: 2, items };
}
// The proposals waiting: { shots: [id…], zooms: [id…] } in time order.
export const proposalsOf = (shotsDoc, zoomsDoc) => ({
  shots: listOf(shotsDoc).filter((s) => s.status === 'proposed').map((s) => s.id),
  zooms: itemsOf(zoomsDoc).filter((z) => z.status === 'proposed').map((z) => z.id),
});
// newProposals(before, after) → { shots, zooms }: the proposals in `after` (docs { shots, zooms }) that weren't waiting
// in `before` as they are now (new ones, and ones Claude changed again). For the chat's "Claude proposed …" block.
export function newProposals(before = {}, after = {}) {
  const sig = (x) => { if (!x) return ''; const { word, updated, ...rest } = x; return JSON.stringify(rest); };
  const was = (list) => new Map(list.filter((x) => x.status === 'proposed').map((x) => [x.id, sig(x)]));
  const bs = was(listOf(before.shots)), bz = was(itemsOf(before.zooms));
  return {
    shots: listOf(after.shots).filter((s) => s.status === 'proposed' && bs.get(s.id) !== sig(s)).map((s) => s.id),
    zooms: itemsOf(after.zooms).filter((z) => z.status === 'proposed' && bz.get(z.id) !== sig(z)).map((z) => z.id),
  };
}
// "3 shots and 6 zooms", "1 zoom".
export function proposalWords({ shots = [], zooms = [] } = {}) {
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  return [shots.length ? n(shots.length, 'shot') : '', zooms.length ? n(zooms.length, 'zoom') : ''].filter(Boolean).join(' and ');
}
// What a proposed shot or zoom changes, in a few words ("Boxed, screen 1.5×, comes in with Slide 0.5 s").
export function proposalWhat(kind, x) {
  if (!x) return '';
  if (kind === 'zoom') return `${ZOOM_TARGETS[x.target] || 'Camera'} zoom${x.box ? ' into an area' : x.amount ? ` ${x.amount}×` : ''}${x.name ? ` · ${x.name}` : ''}`;
  const lk = x.look || {}, bits = [];
  if (lk.preset) bits.push(PRESETS[lk.preset] || lk.preset);
  if ((lk.hidden || []).includes('cam')) bits.push('no camera');
  if (lk.screen?.zoom > 1.001) bits.push(`screen ${lk.screen.zoom}×`);
  if (lk.cam?.zoom > 1.001) bits.push(`camera ${lk.cam.zoom}×`);
  if (x.in) bits.push(`comes in with ${{ fade: 'Crossfade', slide: 'Slide', zoom: 'Zoom' }[x.in.type]} ${x.in.dur} s`);
  if (!bits.length && x.was) bits.push('back to the video’s look');
  return `${x.name ? `${x.name}: ` : ''}${bits.join(', ') || 'a new shot'}`;
}

// ---- edits: the Shots lane, "/", the inspector, Claude ----
// shotsEdit(doc, body, ctx) → { doc, made, note, base }. body.op is one of:
//   add      { t | word, snap?, look?, name?, in?, by?, status? }  a break at a time (snapped like S; snap: false = exact)
//            or before word index `word` ("/" in the words). The new shot is a copy of the shot it came from, with
//            look on top. made = its id.
//   split    { t, id? }                  S at the playhead (id: the shot the playhead is in)
//   merge    { id }                      remove the break at the start of shot id: the shot before keeps its look and
//                                        the transition goes
//   move     { id, t | word, snap? }     move the break at shot id's start (between its neighbours); a shot left
//                                        shorter than MIN_SHOT merges into the one that grew
//   look     { id | ids | all, look }    change these properties (a partial look) in the shot(s)
//   clear    { id | ids | all, keys? }   take properties out ('cam.zoom', 'hidden', 'cam', …; no keys = the whole
//                                        look: "Back to the video's look")
//   name     { id, name }
//   transition { id | all, in }          how shot id comes in ({ type, dur, dir } or null/{ type: 'cut' }); all: true =
//                                        every shot change ("Use for every shot change")
//   keep     { id | ids | all }          proposals become kept
//   reject   { id | ids | all }          proposals turned down (back to "was", or removed)
//   apply-all { id }                     this shot's own changes go into the base look (returned as base, a full
//                                        layout) and come out of every shot
//   same-as-previous { id }              this shot's look becomes the previous shot's
//   restore  { doc, layout? }            put a doc back (undo / redo); layout: put the base back too
// Errors are thrown with a sentence for the creator. MIN_SHOT counts played seconds (the cut's kept time).
export function shotsEdit(doc, b, ctx = {}) {
  const words = ctx.words || [], cut = ctx.cut || null, end = dur(ctx);
  let L = doc.shots.map((s) => structuredClone(s));
  const idx = (id) => { const i = L.findIndex((s) => s.id === id); if (i < 0) throw new Error('That shot is gone.'); return i; };
  const label = (i, list = L) => shotLabel(list, i);
  const lenOf = (list, i) => keptIn(cut, list[i].start, i + 1 < list.length ? list[i + 1].start : end);
  const sectionName = (s) => { const x = (ctx.blocks || []).find((y) => y.id === s.section); return x?.label ? `“${x.label}”` : 'a section'; };
  const where = () => {
    if (Number.isInteger(b.word)) { if (!words[b.word]) throw new Error('There is no such word.'); return { t: breakBefore(b.word, words, cut), word: b.word }; }
    if (!isNum(b.t)) throw new Error('Say where: a time (t) or a word.');
    return b.snap === false ? { t: r3(Number(b.t)), word: wordAt(Number(b.t), words) } : snapBreak(Number(b.t), words, cut);
  };
  const pick = (proposedOnly = false) => {
    const all = b.all ? L.map((_, i) => i) : Array.isArray(b.ids) ? b.ids.map(idx) : [idx(b.id)];
    return proposedOnly ? all.filter((i) => L[i].status === 'proposed') : all;
  };
  let made = null, note = null, base = null;
  switch (b.op) {
    case 'add': case 'split': {
      if (b.op === 'split' && !isNum(b.t)) throw new Error('Put the playhead where the new shot should start.');
      const { t: at, word } = where();
      if (!(at > 0) || at >= end) throw new Error('A new shot has to start inside the video, after 0:00.');
      if (L.some((s) => Math.abs(s.start - at) < 0.01)) throw new Error('There is a shot break there already.');
      const host = shotAt(at, L).index;
      if (b.op === 'split' && b.id && L[host].id !== b.id) throw new Error('The playhead is not inside that shot.');
      const shot = { id: freeId(L), start: at, ...(word != null ? { word } : {}) };
      const look = combineLooks(L[host].look, normalizeLook(b.look));
      if (look) shot.look = look;
      if (str(b.name, 60)) shot.name = str(b.name, 60);
      const tin = normTransition(b.in);
      if (tin) shot.in = tin;
      if (b.by === 'claude') shot.by = 'claude';
      if (b.status === 'proposed') shot.status = 'proposed';
      const next = [...L.slice(0, host + 1), shot, ...L.slice(host + 1)];
      if (lenOf(next, host) < MIN_SHOT - 1e-6 || lenOf(next, host + 1) < MIN_SHOT - 1e-6) throw new Error(`A shot is at least ${MIN_SHOT} s long: start this one further from the shot break next to it.`);
      L = next;
      made = shot.id;
      note = `${label(host + 1)} starts at ${clock(at)}${word != null && words[word] ? `, on “${words[word][2]}”` : ''}.`;
      break;
    }
    case 'merge': {
      const i = idx(b.id);
      if (i === 0) throw new Error('The first shot has no break before it.');
      if (L[i].section) throw new Error(`That break is where the section ${sectionName(L[i])} starts: a section edge is always a shot edge.`);
      note = `${label(i)} merged into ${label(i - 1)}.`;
      L.splice(i, 1);
      break;
    }
    case 'move': {
      const i = idx(b.id);
      if (i === 0) throw new Error('The first shot always starts at 0:00.');
      if (L[i].section) throw new Error(`That break is where the section ${sectionName(L[i])} starts: drag the section's edge to move it.`);
      const w = where();
      const lo = L[i - 1].start, hi = i + 1 < L.length ? L[i + 1].start : end;
      const at = r3(clamp(w.t, lo + 0.001, hi - 0.001));
      if (Math.abs(at - L[i].start) < 1e-4) break;
      const right = at > L[i].start;
      L[i].start = at;
      const wd = wordAt(at, words);
      if (wd != null) L[i].word = wd; else delete L[i].word;
      if (right && lenOf(L, i) < MIN_SHOT - 1e-6) {
        note = `${label(i)} was shorter than ${MIN_SHOT} s, so it merged into ${label(i - 1)}.`;
        L.splice(i, 1);
      } else if (!right && lenOf(L, i - 1) < MIN_SHOT - 1e-6) {
        const prev = L[i - 1];
        note = `${label(i - 1)} was shorter than ${MIN_SHOT} s, so it merged into ${label(i)}.`;
        L[i].start = prev.start;
        if (prev.word != null) L[i].word = prev.word; else delete L[i].word;
        delete L[i].in;
        if (prev.in) L[i].in = prev.in;
        if (prev.section) L[i].section = prev.section;
        L.splice(i - 1, 1);
      } else note = `${label(i)} now starts at ${clock(at)}.`;
      break;
    }
    case 'look': {
      const ch = normalizeLook(b.look);
      if (!ch) throw new Error('Nothing to change in the look.');
      const ids = pick();
      for (const i of ids) { const l = combineLooks(L[i].look, ch); if (l) L[i].look = l; else delete L[i].look; }
      note = ids.length === 1 ? `${label(ids[0])}: ${lookKeys(ch).join(', ')} changed.` : `${ids.length} shots: ${lookKeys(ch).join(', ')} changed.`;
      break;
    }
    case 'clear': {
      const keys = Array.isArray(b.keys) && b.keys.length ? b.keys.map(String) : null;
      const ids = pick();
      for (const i of ids) { const l = keys ? withoutKeys(L[i].look, keys) : null; if (l) L[i].look = l; else delete L[i].look; }
      note = keys ? `${ids.length === 1 ? label(ids[0]) : `${ids.length} shots`}: ${keys.join(', ')} back to the video's look.` : `${ids.length === 1 ? label(ids[0]) : `${ids.length} shots`} back to the video's look.`;
      break;
    }
    case 'name': {
      const i = idx(b.id), n = str(b.name, 60);
      if (n) L[i].name = n; else delete L[i].name;
      break;
    }
    case 'transition': {
      const tin = normTransition(b.in);
      const ids = b.all ? L.map((_, i) => i).slice(1) : [idx(b.id)];
      if (!b.all && ids[0] === 0) throw new Error('The first shot has nothing before it to come in from.');
      for (const i of ids) { if (tin) L[i].in = tin; else delete L[i].in; }
      const what = tin ? `${{ fade: 'Crossfade', slide: 'Slide', zoom: 'Zoom' }[tin.type]} ${tin.dur} s` : 'Cut';
      note = b.all ? `${what} for every shot change.` : `${label(ids[0])} comes in with: ${what}.`;
      break;
    }
    case 'keep': {
      const ids = pick(true);
      for (const i of ids) { delete L[i].status; delete L[i].was; }
      note = ids.length ? `Kept ${ids.length === 1 ? label(ids[0]) : `${ids.length} shots`}.` : 'Nothing was waiting.';
      break;
    }
    case 'reject': {
      const ids = pick(true).sort((x, y) => y - x);
      for (const i of ids) {
        const s = L[i];
        if (s.was || i === 0 || s.section) {
          delete s.look; delete s.in; delete s.name;
          Object.assign(s, structuredClone(s.was || {}));
          delete s.status; delete s.was; delete s.by;
          if (i === 0) delete s.in;
        } else L.splice(i, 1);
      }
      note = ids.length ? `Turned down ${ids.length === 1 ? 'a proposed shot' : `${ids.length} proposed shots`}.` : 'Nothing was waiting.';
      break;
    }
    case 'apply-all': {
      const i = idx(b.id), look = L[i].look;
      if (!look) throw new Error('This shot has no changes of its own to apply.');
      if (!ctx.base) throw new Error("The video's look is missing.");
      base = mergeLook(ctx.base, look);
      const keys = lookKeys(look);
      for (const s of L) { const l = withoutKeys(s.look, keys); if (l) s.look = l; else delete s.look; }
      note = `${label(i)}'s ${keys.join(', ')} now ${keys.length === 1 ? 'applies' : 'apply'} to every shot.`;
      break;
    }
    case 'same-as-previous': {
      const i = idx(b.id);
      if (i === 0) throw new Error('The first shot has no shot before it.');
      if (L[i - 1].look) L[i].look = structuredClone(L[i - 1].look); else delete L[i].look;
      note = `${label(i)} now looks like ${label(i - 1)}.`;
      break;
    }
    case 'restore': {
      if (!b.doc || !Array.isArray(b.doc.shots)) throw new Error('Nothing to restore.');
      L = b.doc.shots;
      if (b.layout && typeof b.layout === 'object') base = b.layout;
      break;
    }
    default: throw new Error('Unknown shots action.');
  }
  return { doc: normalizeShots({ ...doc, shots: L }, ctx), made, note, base };
}

// zoomsEdit(doc, body, ctx) → { doc, made, note }. ctx.fit(box, zoom) (optional) gives a box the target's shape on
// the frame. body.op is one of:
//   add     { target, t | a, d? | dur?, words? [i, j], box?, amount?, speed?, in?, out?, name?, why?, by?, status? }
//           starts at t (the playhead) and lasts ZOOM_DUR s, or exactly as long as words i…j; in/out = ramp seconds
//   move    { id, a | t | dt }             the whole zoom (clamped inside the take)
//   trim    { id, a?, d? }                 either end; the ramps keep their lengths where they fit
//   set     { id, target?, box? (null = none), amount? (null = none), speed?, in?, out?, name?, why? }
//   delete  { id | ids }
//   keep    { id | ids | all }        reject  { id | ids | all } (back to "was", or removed)
//   restore { doc }
export function zoomsEdit(doc, b, ctx = {}) {
  const words = ctx.words || [], end = dur(ctx);
  let items = itemsOf(doc).map((z) => structuredClone(z));
  const idx = (id) => { const i = items.findIndex((z) => z.id === id); if (i < 0) throw new Error('That zoom is gone.'); return i; };
  const pick = (proposedOnly = false) => {
    const all = b.all ? items.map((_, i) => i) : Array.isArray(b.ids) ? b.ids.map(idx) : [idx(b.id)];
    return proposedOnly ? all.filter((i) => items[i].status === 'proposed') : all;
  };
  const ramp = (v, def) => (isNum(v) ? clamp(Number(v), RAMP_MIN, RAMP_MAX) : def);
  const fit = (z) => { if (z.box && ctx.fit) { const f = ctx.fit(normBox(z.box), z); if (f) z.box = f; } return z; };
  let made = null, note = null;
  switch (b.op) {
    case 'add': {
      let a, d;
      if (Array.isArray(b.words) && b.words.length) {
        const ws = b.words.map(Number).filter(Number.isInteger), i = Math.min(...ws), j = Math.max(...ws);
        if (!words[i] || !words[j]) throw new Error('Those words are not in the transcript.');
        a = words[i][0]; d = words[j][1];
      } else {
        a = isNum(b.a) ? Number(b.a) : isNum(b.t) ? Number(b.t) : null;
        if (a == null) throw new Error('Say when the zoom starts: the playhead (t), a time (a) or words.');
        d = isNum(b.d) ? Number(b.d) : a + (isNum(b.dur) ? Number(b.dur) : ZOOM_DUR);
      }
      if (a >= end - MIN_ZOOM / 2) throw new Error('A zoom has to start inside the video.');
      const ri = ramp(b.in, ZOOM_RAMP), ro = ramp(b.out, ZOOM_RAMP);
      const z = { id: freeId(items, 'z'), target: ZOOM_TARGETS[b.target] ? b.target : b.box ? 'screen' : 'camera', a, b: a + ri, c: d - ro, d,
        ...(b.box ? { box: b.box } : {}), ...(isNum(b.amount) ? { amount: Number(b.amount) } : {}), ...(ZOOM_SPEEDS[b.speed] ? { speed: b.speed } : {}),
        ...(str(b.name, 60) ? { name: str(b.name, 60) } : {}), ...(str(b.why, 200) ? { why: str(b.why, 200) } : {}),
        ...(b.by === 'claude' ? { by: 'claude' } : {}), ...(b.status === 'proposed' ? { status: 'proposed' } : {}) };
      const clean = normZoom(fit(z), ctx);
      if (!clean) throw new Error("That zoom doesn't fit in the video.");
      items.push(clean);
      made = clean.id;
      note = `${ZOOM_TARGETS[clean.target]} zoom at ${clock(clean.a)}–${clock(clean.d)}.`;
      break;
    }
    case 'move': {
      const i = idx(b.id), z = items[i];
      let shift = isNum(b.dt) ? Number(b.dt) : isNum(b.a) ? Number(b.a) - z.a : isNum(b.t) ? Number(b.t) - z.a : null;
      if (shift == null) throw new Error('Say where to move it (a, t or dt).');
      shift = clamp(shift, -z.a, (Number.isFinite(end) ? end : Infinity) - z.d);
      for (const k of ['a', 'b', 'c', 'd']) z[k] += shift;
      note = `Zoom moved to ${clock(z.a)}.`;
      break;
    }
    case 'trim': {
      const i = idx(b.id), z = items[i], ri = z.b - z.a, ro = z.d - z.c;
      if (isNum(b.a)) { z.a = clamp(Number(b.a), 0, z.d - MIN_ZOOM); z.b = z.a + ri; }
      if (isNum(b.d)) { z.d = clamp(Number(b.d), z.a + MIN_ZOOM, end); z.c = z.d - ro; }
      if (z.c < z.b) { const mid = (z.a + z.d) / 2; z.b = Math.min(z.b, mid); z.c = Math.max(z.c, mid); }
      note = `Zoom now ${clock(z.a)}–${clock(z.d)}.`;
      break;
    }
    case 'set': {
      const i = idx(b.id), z = items[i];
      if (ZOOM_TARGETS[b.target]) z.target = b.target;
      if (b.box === null) delete z.box; else if (b.box) z.box = b.box;
      if (b.amount === null) delete z.amount; else if (isNum(b.amount)) z.amount = Number(b.amount);
      if (ZOOM_SPEEDS[b.speed]) { if (b.speed === 'smooth') delete z.speed; else z.speed = b.speed; }
      if (isNum(b.in)) z.b = z.a + ramp(b.in, ZOOM_RAMP);
      if (isNum(b.out)) z.c = z.d - ramp(b.out, ZOOM_RAMP);
      for (const k of ['name', 'why']) if (typeof b[k] === 'string') { if (str(b[k], k === 'name' ? 60 : 200)) z[k] = str(b[k], k === 'name' ? 60 : 200); else delete z[k]; }
      if (b.box || ZOOM_TARGETS[b.target]) fit(z);
      note = 'Zoom changed.';
      break;
    }
    case 'delete': {
      const ids = new Set((Array.isArray(b.ids) ? b.ids : [b.id]).map((id) => items[idx(id)].id));
      items = items.filter((z) => !ids.has(z.id));
      note = ids.size === 1 ? 'Zoom deleted.' : `${ids.size} zooms deleted.`;
      break;
    }
    case 'keep': {
      const ids = pick(true);
      for (const i of ids) { delete items[i].status; delete items[i].was; }
      note = ids.length ? `Kept ${ids.length === 1 ? 'a zoom' : `${ids.length} zooms`}.` : 'Nothing was waiting.';
      break;
    }
    case 'reject': {
      const ids = new Set(pick(true));
      items = items.flatMap((z, i) => {
        if (!ids.has(i)) return [z];
        if (!z.was) return [];
        const back = { ...z, ...structuredClone(z.was) };
        delete back.status; delete back.was; delete back.by;
        return [back];
      });
      note = ids.size ? `Turned down ${ids.size === 1 ? 'a proposed zoom' : `${ids.size} proposed zooms`}.` : 'Nothing was waiting.';
      break;
    }
    case 'restore': {
      if (!b.doc || !Array.isArray(b.doc.items)) throw new Error('Nothing to restore.');
      items = b.doc.items;
      break;
    }
    default: throw new Error('Unknown zooms action.');
  }
  return { doc: normalizeZooms({ v: 2, items }, ctx), made, note };
}
