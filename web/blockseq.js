// Blocks: a project is an ordered row of blocks (work/blocks.json), shown as the section band over the timeline.
// Shared by the browser (band, strip) and the server (placement rules, export), like layout.js. Pure, no DOM.
//
// work/blocks.json  { v: 1, format, marked, blocks: [block, …] }   blocks are kept in the order they play.
// block  { id, type: intro|body|sponsor|outro|broll|custom, label, order (1…n, the position in the video),
//          source: { take: [start, end] }            a range of the canvas take, in source seconds
//                | { file: 'source/…', screen? }     its own file (a separate take: the camera file, plus its screen file)
//                | { pending: 'record'|'claude' }    still to come (recording, or Claude is making it)
//          rule?  "first 30%" | "after intro" | "before outro" | "at a pause" | "end" | "start"
//          override? true when the creator moved it by hand (the rule is kept but no longer applied)
//          layout? 'screen'|'camera'|'pip'|'split'|'boxed'   this block's own canvas layout
//          reason? one line: why a boundary sits where it does     note? what Video Octopus last did ("moved to 0:42 …")
//          placed? { t, sig }   where a rule put it (take seconds) and on which cut      part_of? the block it was split from }
// A file block sits between two blocks; putting it inside a take block splits that block in two (part_of links
// the halves, and they join up again when it moves away).

import { PRESETS } from './layout.js';

export const TYPES = ['intro', 'body', 'sponsor', 'outro', 'broll', 'custom'];
export const TYPE_LABEL = { intro: 'Intro', body: 'Main body', sponsor: 'Sponsor read', outro: 'Outro', broll: 'B-roll', custom: 'Custom' };

const num = (x) => (x !== null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const r3 = (x) => Math.round(x * 1000) / 1000;
const str = (x, n) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : undefined);
export const kindOf = (b) => (b?.source?.take ? 'take' : b?.source?.file ? 'file' : 'pending');
export const newId = (type = 'b') => `${String(type).replace(/[^\w]/g, '').slice(0, 10) || 'b'}-${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;
const okFile = (f) => typeof f === 'string' && /^(source|library)\/[^\0]+$/.test(f) && !f.split('/').includes('..');

// Clean up blocks.json from disk, the browser or Claude. takeDur clamps the take ranges.
export function normalizeDoc(raw, takeDur = Infinity) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const list = (Array.isArray(d.blocks) ? d.blocks : []).map((b, i) => ({ b, i })).filter(({ b }) => b && typeof b === 'object')
    .sort((x, y) => (num(x.b.order) ?? x.i + 1) - (num(y.b.order) ?? y.i + 1) || x.i - y.i);
  const blocks = [];
  for (const { b } of list) {
    const type = TYPES.includes(b.type) ? b.type : 'custom';
    let id = /^[\w-]{1,40}$/.test(b.id || '') ? b.id : newId(type);
    while (seen.has(id)) id = newId(type);
    seen.add(id);
    const s = b.source || {};
    let source = null;
    if (Array.isArray(s.take) && s.take.length === 2 && num(s.take[0]) != null && num(s.take[1]) != null) {
      const a = Math.max(0, Math.min(takeDur, num(s.take[0]))), e = Math.max(0, Math.min(takeDur, num(s.take[1])));
      if (e - a >= 0.05) source = { take: [r3(a), r3(e)] };
    } else if (okFile(s.file)) {
      source = { file: s.file, ...(okFile(s.screen) ? { screen: s.screen } : {}), ...(str(s.library, 300) ? { library: str(s.library, 300) } : {}) };
    } else if (s.pending) source = { pending: ['record', 'claude', 'file'].includes(s.pending) ? s.pending : 'claude' };
    if (!source) continue;
    const out = { id, type, label: str(b.label, 60) || TYPE_LABEL[type], order: 0, source };
    for (const k of ['rule', 'reason', 'note', 'ask']) if (str(b[k], k === 'ask' ? 600 : 240)) out[k] = str(b[k], k === 'ask' ? 600 : 240);
    if (b.override && out.rule) out.override = true;
    if (PRESETS[b.layout]) out.layout = b.layout;
    if (/^[\w-]{1,40}$/.test(b.part_of || '')) out.part_of = b.part_of;
    if (b.placed && num(b.placed.t) != null) out.placed = { t: r3(num(b.placed.t)), sig: String(b.placed.sig || '').slice(0, 400), ...(/^[\w-]{1,40}$/.test(b.placed.after || '') ? { after: b.placed.after } : {}) };
    blocks.push(out);
  }
  blocks.forEach((b, i) => (b.order = i + 1));
  return { v: 1, format: str(d.format, 30) || null, marked: Boolean(d.marked), ...(str(d.by, 40) ? { by: str(d.by, 40) } : {}), blocks };
}

// ---- the cut ----
// Seconds of [a, b] the locked cut keeps (no cut: all of it), and the kept pieces themselves.
export function keptPieces(segs, a, b) {
  if (!segs) return b > a ? [[a, b]] : [];
  const out = [];
  for (const [x, y] of segs) { const s = Math.max(a, x), e = Math.min(b, y); if (e - s > 1e-6) out.push([s, e]); }
  return out;
}
export const keptIn = (segs, a, b) => keptPieces(segs, a, b).reduce((t, [x, y]) => t + y - x, 0);
export const cutSig = (segs) => (segs ? segs.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(',') : 'whole');

// The video in order: every block with its length and where it starts in the finished video. File blocks also get
// `at`: the take second they sit at, so the band can draw them on the take's timeline.
// ctx = { cut: segments | null, fileDur: (block) => seconds }
export function sequence(doc, ctx) {
  let pos = 0;
  const seq = doc.blocks.map((b) => {
    const kind = kindOf(b);
    const dur = kind === 'take' ? keptIn(ctx.cut, b.source.take[0], b.source.take[1]) : kind === 'file' ? Math.max(0, ctx.fileDur?.(b) || 0) : 0;
    const it = { block: b, kind, dur, start: pos, end: pos + dur };
    pos += dur;
    return it;
  });
  seq.forEach((it, i) => {
    if (it.kind === 'take') return;
    const prev = seq.slice(0, i).reverse().find((x) => x.kind === 'take');
    const next = seq.slice(i + 1).find((x) => x.kind === 'take');
    it.at = prev ? prev.block.source.take[1] : next ? next.block.source.take[0] : 0;
  });
  return { items: seq, total: pos };
}

// ---- words: pauses and snap points ----
const kept = (segs, t) => !segs || segs.some(([a, b]) => t >= a && t < b);
const sentenceEnd = (w) => /[.!?…]["')\]]*$/.test(w);
// Pauses between kept words, with a split point in each and a score (longer, and after a sentence, is better).
export function pausesOf(words, segs, min = 0.25) {
  const ws = (words || []).filter((w) => kept(segs, (w[0] + w[1]) / 2)).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i + 1 < ws.length; i++) {
    const [, e1, t1] = ws[i], [s2] = ws[i + 1];
    const gap = s2 - e1, sent = sentenceEnd(String(t1));
    if (!(gap >= min || (sent && gap >= 0.12))) continue;
    // A cut boundary inside the gap is the cleanest place to split; else the middle of the pause.
    const edge = segs?.find(([, b]) => b >= e1 && b <= s2);
    const t = edge ? edge[1] : (e1 + s2) / 2;
    out.push({ t: r3(t), gap: r3(gap), score: Math.min(gap, 1.5) + (sent ? 0.8 : /[,;:]$/.test(String(t1)) ? 0.2 : 0), sentence: sent, before: String(t1), after: String(ws[i + 1][2]) });
  }
  return out;
}
// Where a dragged boundary may land: just before each word (40 ms of air, never into the word before) and mid-pause.
export function snapPoints(words) {
  const ws = (words || []).slice().sort((a, b) => a[0] - b[0]);
  const pts = [];
  ws.forEach((w, i) => {
    const prevEnd = i ? ws[i - 1][1] : 0;
    pts.push(r3(Math.max(prevEnd, w[0] - 0.04)));
    if (i && w[0] - prevEnd >= 0.25) pts.push(r3((prevEnd + w[0]) / 2));
  });
  return [...new Set(pts)].sort((a, b) => a - b);
}

// ---- rules ----
export function parseRule(rule) {
  const r = String(rule || '').toLowerCase().trim();
  if (!r) return null;
  let m;
  if ((m = /(?:first|within|in the first)\D*(\d{1,2})\s*%/.exec(r) || /^(\d{1,2})\s*%/.exec(r))) return { kind: 'first', pct: Number(m[1]) };
  if ((m = /^after\s+(?:the\s+)?(.+)$/.exec(r))) return { kind: 'after', what: m[1] };
  if ((m = /^before\s+(?:the\s+)?(.+)$/.exec(r))) return { kind: 'before', what: m[1] };
  if (/\bend\b|\blast\b/.test(r)) return { kind: 'end' };
  if (/\bstart\b|\bbeginning\b/.test(r)) return { kind: 'start' };
  if (/pause/.test(r)) return { kind: 'pause' };
  return null;
}
export function ruleLabel(rule) {
  const p = parseRule(rule);
  if (!p) return rule ? String(rule) : '';
  return { first: `In the first ${p.pct}%`, after: `After the ${p.what}`, before: `Before the ${p.what}`, end: 'At the end', start: 'At the start', pause: 'At a pause' }[p.kind];
}
const matches = (b, what) => { const w = String(what).toLowerCase().replace(/s$/, ''); return b.type === w || b.label.toLowerCase().startsWith(w) || b.id === what; };

// ---- editing the row ----
// Take a block out of the row; split halves that now touch again join back up.
export function removeFromRow(doc, id) {
  return mergeParts({ ...doc, blocks: doc.blocks.filter((b) => b.id !== id) });
}
export function mergeParts(doc) {
  const out = [];
  for (const b of doc.blocks.map((x) => structuredClone(x))) {
    const prev = out[out.length - 1];
    if (prev && kindOf(prev) === 'take' && kindOf(b) === 'take' && b.part_of && (b.part_of === prev.id || b.part_of === prev.part_of)
      && Math.abs(prev.source.take[1] - b.source.take[0]) < 0.02) { prev.source.take[1] = b.source.take[1]; continue; }
    out.push(b);
  }
  out.forEach((b, i) => (b.order = i + 1));
  return { ...doc, blocks: out };
}
// Put a block into the row: at a position (index 0 = first), or inside a take block at a take second (splits it).
export function insertAt(doc, block, where) {
  const blocks = doc.blocks.map((x) => structuredClone(x));
  let idx = Math.max(0, Math.min(blocks.length, where.index ?? blocks.length));
  if (where.split) {
    const i = blocks.findIndex((b) => b.id === where.split);
    const x = blocks[i];
    if (i >= 0 && kindOf(x) === 'take' && where.t > x.source.take[0] + 0.05 && where.t < x.source.take[1] - 0.05) {
      const tail = { ...structuredClone(x), id: newId(x.type), source: { take: [r3(where.t), x.source.take[1]] }, part_of: x.part_of || x.id };
      delete tail.reason; delete tail.note;
      x.source.take = [x.source.take[0], r3(where.t)];
      blocks.splice(i + 1, 0, block, tail);
      idx = -1;
    } else if (i >= 0) idx = where.t <= x.source.take[0] + 0.05 ? i : i + 1;
  }
  if (idx >= 0) blocks.splice(idx, 0, block);
  blocks.forEach((b, k) => (b.order = k + 1));
  return { ...doc, blocks };
}

// Every place a block could go in the row: the gaps between blocks, and the pauses inside take blocks.
// pos = where that is in the finished video (seconds), t = the take second it sits at.
function spots(doc, ctx) {
  const { items, total } = sequence(doc, ctx);
  const pauses = pausesOf(ctx.words, ctx.cut);
  const out = [{ index: 0, pos: 0, t: items.find((x) => x.kind === 'take')?.block.source.take[0] ?? 0, score: 0.5, after: null, before: items[0]?.block || null }];
  items.forEach((it, i) => {
    const b = it.block;
    if (it.kind === 'take') {
      const [s, e] = b.source.take;
      for (const p of pauses) if (p.t > s + 0.3 && p.t < e - 0.3) out.push({ split: b.id, t: p.t, pos: it.start + keptIn(ctx.cut, s, p.t), score: p.score, inside: b, pause: p });
    }
    out.push({ index: i + 1, pos: it.end, t: it.kind === 'take' ? b.source.take[1] : it.at ?? 0, score: 2 + (b.type === 'intro' ? 1 : 0), after: b, before: items[i + 1]?.block || null });
  });
  return { list: out.sort((a, b) => a.pos - b.pos), total };
}

// Where a rule puts a block: the best fitting spot, or the one nearest to `near` (a take second) when it was
// already placed and only needs to stay valid. Returns { spot, why } or null when nothing fits.
export function findSpot(doc, rule, ctx, near = null, after = null) {
  const p = parseRule(rule) || { kind: 'pause' };
  const { list, total } = spots(doc, ctx);
  const items = sequence(doc, ctx).items;
  let fit;
  if (p.kind === 'first') {
    const introEnd = Math.max(0, ...items.filter((x) => x.block.type === 'intro').map((x) => x.end));
    fit = list.filter((s) => s.pos <= (p.pct / 100) * total + 1e-6 && s.pos >= introEnd - 1e-6 && s.inside?.type !== 'intro' && s.inside?.type !== 'outro' && s.index !== 0);
    if (!fit.length) fit = list.filter((s) => s.after?.type === 'intro');
  } else if (p.kind === 'after') fit = list.filter((s) => s.after && matches(s.after, p.what)).slice(-1);
  else if (p.kind === 'before') fit = list.filter((s) => s.before && matches(s.before, p.what)).slice(0, 1);
  else if (p.kind === 'end') fit = [list[list.length - 1]];
  else if (p.kind === 'start') fit = [list[0]];
  else fit = list;
  if (!fit?.length) return null;
  // Placed right after a block before: stay after that block while it still fits (it follows a moved boundary).
  const anchored = after && fit.find((s) => s.after && (s.after.id === after || s.after.part_of === after) && s.index != null);
  const best = anchored || (near != null)
    ? fit.slice().sort((a, b) => Math.abs(a.t - near) - Math.abs(b.t - near) || b.score - a.score)[0]
    : fit.slice().sort((a, b) => b.score - a.score || a.pos - b.pos)[0];
  const why = best.pause ? `at a pause after "${best.pause.before}"` : best.after ? `after the ${best.after.label.toLowerCase()}` : 'at the start';
  return { spot: best, why, total };
}

// The cut and the take part of the row without this block: what a rule placement depends on. When it changes,
// the block is placed again (nearest to where it was).
export const layoutSig = (doc, ctx, id) => cutSig(ctx.cut) + '|' + removeFromRow(doc, id).blocks.filter((b) => kindOf(b) === 'take').map((b) => `${b.type}:${b.source.take.join('-')}`).join(',');

// Put a block where its rule says (or keep it where it is if that still fits, nearest to its last place).
export function placeByRule(doc, id, ctx) {
  const b = doc.blocks.find((x) => x.id === id);
  if (!b) return { doc, moved: false };
  const rest = removeFromRow(doc, id);
  const near = b.placed?.t ?? null;
  const found = findSpot(rest, b.rule, ctx, near, b.placed?.after || null);
  if (!found) return { doc, moved: false };
  const after = found.spot.index != null && found.spot.after && kindOf(found.spot.after) === 'take' ? found.spot.after.part_of || found.spot.after.id : null;
  const next = insertAt(rest, { ...structuredClone(b), placed: { t: found.spot.t, sig: layoutSig(rest, ctx, id), ...(after ? { after } : {}) } }, found.spot);
  return { doc: next, moved: near == null || Math.abs(near - found.spot.t) > 0.05, at: found.spot.pos, why: found.why };
}

// Move a block by hand: before another block (null = to the end), or to a take second (snapped to the nearest
// gap or pause). A hand move overrides the block's rule.
export function moveBlock(doc, id, to, ctx) {
  const b = doc.blocks.find((x) => x.id === id);
  if (!b) return doc;
  const moved = { ...structuredClone(b), ...(b.rule ? { override: true } : {}) };
  delete moved.placed;
  const rest = removeFromRow(doc, id);
  if (to.at != null) {
    const { list } = spots(rest, ctx);
    const s = list.slice().sort((a, b) => Math.abs(a.t - to.at) - Math.abs(b.t - to.at) || (b.index != null) - (a.index != null))[0];
    return insertAt(rest, moved, s || { index: rest.blocks.length });
  }
  const i = to.before ? rest.blocks.findIndex((x) => x.id === to.before) : -1;
  return insertAt(rest, moved, { index: i < 0 ? rest.blocks.length : i });
}

// Drag a take block's edge; the block that touches it on the take moves with it.
export function setEdge(doc, id, edge, t) {
  const blocks = doc.blocks.map((x) => structuredClone(x));
  const b = blocks.find((x) => x.id === id);
  if (!b || kindOf(b) !== 'take') return doc;
  const [s, e] = b.source.take;
  const old = edge === 'end' ? e : s;
  const touching = blocks.filter((x) => x !== b && kindOf(x) === 'take' && Math.abs((edge === 'end' ? x.source.take[0] : x.source.take[1]) - old) < 0.02);
  let lo = edge === 'end' ? s + 0.2 : 0, hi = edge === 'end' ? Infinity : e - 0.2;
  for (const x of touching) { if (edge === 'end') hi = Math.min(hi, x.source.take[1] - 0.2); else lo = Math.max(lo, x.source.take[0] + 0.2); }
  const v = r3(Math.max(lo, Math.min(hi, t)));
  if (edge === 'end') b.source.take[1] = v; else b.source.take[0] = v;
  for (const x of touching) { if (edge === 'end') x.source.take[0] = v; else x.source.take[1] = v; }
  return { ...doc, blocks };
}

// ---- export ----
// The video as parts to render one after another: runs of the take (cut by the locked cut, in order) and file blocks.
// Returns null when the blocks don't change the plain export (the whole take, in order, one layout).
export function exportParts(doc, cut, takeDur) {
  const parts = [];
  for (const b of doc.blocks) {
    const kind = kindOf(b);
    if (kind === 'pending') continue;
    if (kind === 'file') { parts.push({ kind: 'file', block: b }); continue; }
    const pieces = keptPieces(cut, b.source.take[0], b.source.take[1]);
    if (!pieces.length) continue;
    const last = parts[parts.length - 1];
    // Join onto the previous take run when the layout matches and the take keeps running forwards.
    if (last?.kind === 'take' && (last.layout || null) === (b.layout || null) && pieces[0][0] >= last.segs[last.segs.length - 1][1] - 1e-6) {
      last.segs.push(...pieces); last.blocks.push(b.id);
    } else parts.push({ kind: 'take', segs: pieces.map((x) => [...x]), blocks: [b.id], layout: b.layout || null });
  }
  const whole = cut || [[0, takeDur]];
  const plain = parts.length === 1 && parts[0].kind === 'take' && !parts[0].layout
    && Math.abs(parts[0].segs.reduce((t, [a, c]) => t + c - a, 0) - whole.reduce((t, [a, c]) => t + Math.min(c, takeDur) - a, 0)) < 0.05;
  return plain || !parts.length ? null : parts;
}

// The canvas layout a block renders with: the project's layout, its own preset if it has one; a file block
// shows only its own videos (no extra layers), and B-roll is never mirrored.
export function blockLayout(layout, block) {
  const l = structuredClone(layout);
  if (block?.layout) l.preset = block.layout;
  if (kindOf(block) !== 'take') {
    l.layers = [];
    // B-roll is its own picture: the whole of it, not the take's camera or screen framing (zoom, crop).
    if (block.type === 'broll') {
      l.mirror = false; l.cam = { ...l.cam, zoom: 1, focus: { x: 0.5, y: 0.5 }, crop: { t: 0, r: 0, b: 0, l: 0 } };
      l.screen = { ...(l.screen || {}), zoom: 1, focus: { x: 0.5, y: 0.5 }, crop: { t: 0, r: 0, b: 0, l: 0 } };
    }
  }
  return l;
}
