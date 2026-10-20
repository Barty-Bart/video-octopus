// Shots and zooms on disk: work/shots.json and work/zooms.json (v2), read "settled" (block layouts moved into shots
// once, a shot edge at every section edge, shots and zooms back on their words after a re-cut), the /shots and /zooms
// routes, the bridge for the parts of Video Octopus that still give a whole block one layout, and what Claude is told.
// The data model and the edits are in web/shots.js; the look at a moment (lookAt, transitionAt, zoomAt) and the time
// model in web/layout.js.
//
// Routes (POST with X-Studio: 1 and { op, … } in the body, like /blocks; web/shots.js shotsEdit / zoomsEdit list the ops):
//   GET  /api/projects/<id>/shots  → { shots, zooms, spans, transitions }   (spans, transitions: web/shots.js shotSpans,
//                                     web/layout.js transitionsOf, on the locked cut)
//   GET  /api/projects/<id>/zooms  → the zooms doc
//   POST /api/projects/<id>/shots  { op, … } → { ok, id, note, shots, before, after, layout?, layoutBefore? }
//        (layout: the new project layout when "apply-all" or a "restore" with a layout changed the video's look)
//   POST /api/projects/<id>/zooms  { op, … } → { ok, id, note, zooms, before, after }
//   before/after are whole docs: send { op: 'restore', doc: before } (and layout: layoutBefore) to undo.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readJSON, writeJSON, mtime } from './util.mjs';
import { projectMeta, saveProjectMeta, roles, probe, lockedCut, appendWorklog } from './studio.mjs';
import { normalize, snapSegments, compose, lookAt, fitZoomBox, transitionsOf, ZOOM_ROLE } from '../web/layout.js';
import { normalizeDoc } from '../web/blockseq.js';
import { normalizeShots, normalizeZooms, syncSections, migrateLayouts, followCut, followCutZooms, shotsEdit, zoomsEdit,
  blockPresets, setBlockPreset, shotsWithoutProposals, shotSpans } from '../web/shots.js';

export const SHOTS = 'work/shots.json', ZOOMS = 'work/zooms.json';
const BLOCKS = 'work/blocks.json';

// ---- what shots and blocks work on: the canvas take, its words, the locked cut ----
// The camera of the canvas take carries the sound and the word times (a lone file counts as the camera).
export function takeOf(dir) {
  const r = roles(dir);
  const file = r.screen || r.webcam ? r.webcam || r.screen : r.main;
  const p = file ? probe(dir, file) : null;
  return { file, duration: p?.duration || 0 };
}
export function wordsOf(dir) {
  const since = projectMeta(dir)?.activeSince || 0;
  const f = ['work/tr/words.json', 'work/words.json'].find((x) => existsSync(join(dir, x)) && mtime(join(dir, x)) > since);
  const raw = f ? readJSON(join(dir, f), []) : [];
  return { file: f || null, words: (Array.isArray(raw) ? raw : []).filter((w) => Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1])) };
}
// ctx for web/shots.js: { take, duration, words, cut, base, blocks, blocksDoc }. blocks: [] without blocks.json,
// null when it's there but can't be read just now (then the section edges are left as they are).
export function shotsCtx(dir) {
  const take = takeOf(dir);
  const cut = lockedCut(dir);
  const segs = cut && take.duration ? snapSegments(cut.segments, take.duration) : null;
  const meta = projectMeta(dir) || {};
  const BAD = {};
  const raw = existsSync(join(dir, BLOCKS)) ? readJSON(join(dir, BLOCKS), BAD) : null;
  const blocksDoc = raw && raw !== BAD ? normalizeDoc(raw, take.duration || Infinity) : null;
  return { take, duration: take.duration || Infinity, words: wordsOf(dir).words, cut: segs?.length ? segs : null,
    base: normalize(meta.layout, meta.type), blocksDoc, blocks: raw === BAD ? null : blocksDoc?.blocks || [] };
}
// The canvas take's picture sizes, as compose() wants them (the same files as export.mjs canvasSources).
function takeDims(dir) {
  const r = roles(dir);
  const src = r.screen || r.webcam ? { screen: r.screen, cam: r.webcam } : r.audioOnly ? {} : { cam: r.main };
  const out = { screen: null, cam: null, files: {} };
  for (const k of ['screen', 'cam']) { const p = src[k] && probe(dir, src[k]); if (p?.w) out[k] = [p.w, p.h]; }
  return out;
}

// Retime notes ("Shot 3 merged into Shot 2: all its words were cut.") go to whoever listens (index.mjs: the chat).
const listeners = new Set();
export const onShotNotes = (fn) => listeners.add(fn);
const tell = (dir, notes) => { if (notes.length) for (const fn of listeners) { try { fn(dir, notes); } catch {} } };
// A copy of a file before Video Octopus merges or removes something in it (work/retime-backup/<time>/…).
function backup(dir, rel) {
  const src = join(dir, rel);
  if (!existsSync(src)) return;
  const dst = join(dir, 'work/retime-backup', new Date().toISOString().replace(/[:.]/g, '-'), rel.replace(/^work\//, ''));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
const saveShots = (dir, doc) => writeJSON(join(dir, SHOTS), { ...doc, updated: new Date().toISOString() });
const saveZooms = (dir, doc) => writeJSON(join(dir, ZOOMS), { ...doc, updated: new Date().toISOString() });

// ---- reading, settled ----
// settleShots(dir) → { doc, notes, changed }: shots.json as it should be now, written back only when something had to
// change (a section edge, a block layout moved in, a shot whose words were cut). Every read goes through here, so
// the page, the export and Claude's next look all see the same.
export function settleShots(dir, ctx = shotsCtx(dir)) {
  const raw = readJSON(join(dir, SHOTS), null);
  const start = normalizeShots(raw, ctx);
  let doc = syncSections(start, ctx.blocks).doc;
  const notes = [];
  // Block layouts (blocks.json "layout" on a take block) become shots, once: the block keeps no layout.
  if (ctx.blocksDoc) {
    const m = migrateLayouts(doc, ctx.blocksDoc);
    if (m.moved.length) {
      doc = m.doc;
      writeJSON(join(dir, BLOCKS), { ...m.blocks, by: 'studio', updated: new Date().toISOString() });
      ctx.blocksDoc = m.blocks; ctx.blocks = m.blocks.blocks;
      const names = m.moved.map((x) => `${m.blocks.blocks.find((b) => b.id === x.id)?.label || x.id}: ${x.preset}`).join(', ');
      appendWorklog(dir, `Moved ${m.moved.length === 1 ? 'a block layout' : `${m.moved.length} block layouts`} into shots (work/shots.json): ${names}`);
    }
  }
  const fc = followCut(doc, ctx);
  doc = normalizeShots(fc.doc, ctx);
  notes.push(...fc.notes);
  const changed = JSON.stringify(doc.shots) !== JSON.stringify(start.shots) || JSON.stringify(doc.migrated || null) !== JSON.stringify(start.migrated || null);
  // No file and nothing beyond the one shot of the whole video: leave the project as it is.
  if (changed && (raw || doc.shots.length > 1 || doc.migrated)) {
    if (fc.destructive) backup(dir, SHOTS);
    saveShots(dir, doc);
  }
  tell(dir, notes);
  return { doc, notes, changed };
}
export const readShots = (dir) => settleShots(dir).doc;

// settleZooms(dir) → { doc, notes, v1 }: zooms.json v2 (a v1 file reads as camera punch-ins; the first edit writes v2).
export function settleZooms(dir, ctx = shotsCtx(dir)) {
  const raw = readJSON(join(dir, ZOOMS), null);
  if (!raw || typeof raw !== 'object') return { doc: { v: 2, items: [] }, notes: [], v1: false };
  let doc = normalizeZooms(raw, ctx);
  if (!Array.isArray(raw.items) && Array.isArray(raw.zooms)) return { doc, notes: [], v1: true };
  const fc = followCutZooms(doc, ctx);
  if (fc.notes.length) {
    doc = normalizeZooms(fc.doc, ctx);
    if (fc.destructive) backup(dir, ZOOMS);
    saveZooms(dir, doc);
    tell(dir, fc.notes);
  }
  return { doc, notes: fc.notes, v1: false };
}
export const readZooms = (dir) => settleZooms(dir).doc;
// Both, on one read of the take, the words and the cut (the project view).
export function readShotsAndZooms(dir) {
  const ctx = shotsCtx(dir);
  return { shots: settleShots(dir, ctx).doc, zooms: settleZooms(dir, ctx).doc };
}

// ---- edits ----
export function shotsOp(dir, b) {
  const ctx = shotsCtx(dir);
  const before = settleShots(dir, ctx).doc;
  const r = shotsEdit(before, b, ctx);
  const doc = normalizeShots(syncSections(r.doc, ctx.blocks).doc, ctx);
  let layout = null;
  if (r.base) { layout = normalize(r.base, projectMeta(dir)?.type); saveProjectMeta(dir, { layout }); }
  saveShots(dir, doc);
  return { ok: true, id: r.made, note: r.note, shots: doc, before, after: doc, ...(layout ? { layout, layoutBefore: ctx.base } : {}) };
}
export function zoomsOp(dir, b) {
  const ctx = shotsCtx(dir);
  const before = settleZooms(dir, ctx).doc;
  const shots = settleShots(dir, ctx).doc, dims = takeDims(dir);
  // A box gets the target's shape on the frame at the zoom's start (that moment's look), so nothing stretches.
  ctx.fit = (box, z) => {
    const role = ZOOM_ROLE[z.target], d = dims[role];
    if (!box || !d) return box;
    const ly = compose(lookAt(z.a + 1e-3, ctx.base, shots), dims).layers.find((x) => x.ref === role);
    return ly ? fitZoomBox(box, d[0] / d[1], ly.region, ly.box.w / ly.box.h) : box;
  };
  const r = zoomsEdit(before, b, ctx);
  saveZooms(dir, r.doc);
  return { ok: true, id: r.made, note: r.note, zooms: r.doc, before, after: r.doc };
}

// ---- the bridge: block menus and block exports that still give a whole block one layout ----
// { <take block id>: preset } from the kept shots (the shot at each take block's start). Reading it also settles the
// shots, so call it before reading blocks.json (a block layout may be moved into a shot on the way).
export function takeBlockPresets(dir, blocks = null) {
  try {
    const ctx = shotsCtx(dir);
    const doc = settleShots(dir, ctx).doc;
    return blockPresets(blocks || ctx.blocks || [], shotsWithoutProposals(doc));
  } catch (e) { console.error('shots:', e.message); return {}; }
}
// The block menu's "Layout for this block" on take blocks (and a block undo putting them back): the shot at each
// block's start gets (or loses, preset null) that preset. list: [{ block, preset }].
export function setTakeBlockPresets(dir, list) {
  const ctx = shotsCtx(dir);
  let doc = settleShots(dir, ctx).doc;
  const before = JSON.stringify(doc.shots);
  for (const { block, preset } of list) doc = setBlockPreset(doc, block, preset);
  doc = normalizeShots(doc, ctx);
  if (JSON.stringify(doc.shots) !== before) saveShots(dir, doc);
}

// ---- routes ----
export async function shotsRoute(req, res, { dir, action, send, body }) {
  if (action !== '/shots' && action !== '/zooms') return false;
  if (req.method === 'GET') {
    if (action === '/zooms') return send(res, 200, readZooms(dir)), true;
    const ctx = shotsCtx(dir), shots = settleShots(dir, ctx).doc;
    return send(res, 200, { shots, zooms: settleZooms(dir, ctx).doc, spans: shotSpans(shots, ctx).map(({ shot, ...x }) => x),
      transitions: transitionsOf(shots, ctx) }), true;
  }
  if (req.method !== 'POST') return false;
  const b = await body(req);
  try { return send(res, 200, action === '/shots' ? shotsOp(dir, b) : zoomsOp(dir, b)), true; }
  catch (e) { return send(res, 400, { error: e.message }), true; }
}

// What the in-app Claude is told about shots and zooms (added to the project context, after the blocks).
export const shotsContext = () => `Shots and zooms: work/shots.json is the look over time, like Descript's scenes: {v: 1, shots: [{id, start, word, name, look, in, by, status, was, section}]}. A shot runs from its start (seconds of the canvas take, the same clock as the words, not the cut's timeline; the first shot starts at 0) to the next shot's start, and is at least 0.5 s long on the cut. word = the index of its first word in the words file (Video Octopus fills it in from start, and moves the shot to its first kept word when the cut removes that word). look = a partial layout merged over project.json layout: only preset, side, mirror, webcam, pad, cam, screen and hidden (the background, the aspect, the extra layers' list and the sound stay whole-video); cam, screen and webcam merge field by field, hidden replaces the whole list ("cam", "screen", "layer:<id>"); no look = the video's look; a shot that hides the camera its preset needs shows Screen instead. in = how this shot comes in: {type "fade"|"slide"|"zoom", dur 0.2–1.5 s (0.4 fade, 0.5 slide or zoom), dir "left"|"right"|"up" for a slide}, centred on its start; missing = a cut. section = Video Octopus's own: that shot starts where the take block (section) with that id starts; Video Octopus keeps a shot edge at every section edge, so don't move or remove those. work/zooms.json is {v: 2, items: [{id, target "camera"|"screen", a, b, c, d (take seconds: eases in a→b, holds, eases out c→d; ramps 0.1–2 s), box {x, y, w, h} (fractions of the target's picture after its crop) or amount (a punch-in that much closer than the shot's framing, 1.03–1.15 for a face), speed "smooth"|"even"|"snap", name, why, by, status}]}: moves inside a shot, clipped at the next shot's start; the later of two overlapping zooms wins. An older zooms.json {zooms: [{in, out, amount}]} on the cut's timeline still reads (as camera punch-ins), but write v2. Every shot or zoom you add or change gets "by": "claude" and "status": "proposed" (and, when you change one that was already there, "was": what it was before, e.g. {look, in, name}); Video Octopus draws them dashed on the Shots and Zooms lanes, each with Keep it / No thanks, and after your turn the chat shows "Claude proposed 2 shots and 3 zooms · Show me · Keep all · No thanks to all". The preview and the export leave a proposal out until the creator keeps it (No thanks puts "was" back, or removes a new one), so tell the creator to look at them and press Keep it or No thanks (or Keep all in the chat); leave the creator's shots and zooms exactly as they are. Add zooms (the talking-head-zoom skill) only redoes your own camera punch-ins (target "camera", by "claude"): keep every other zoom in work/zooms.json as it is, screen zooms included. Say in one line what you changed ("Shots · 1 shot changed, 1 zoom added").`;
