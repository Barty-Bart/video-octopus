// Blocks (M3b): the project as an ordered row of blocks in work/blocks.json (intro, main body, sponsor read, outro,
// B-roll, custom), shown as the section band over the timeline. A block is a range of the canvas take or its own file
// (a separate take, a dropped-in file, a library item). Rules ("first 30%", "after intro", "at a pause") put a block at
// the nearest pause that fits, and keep it there when the cut changes. Also here: the Prepare and Mark sections briefs,
// the @mention list for the chat, uploads, and takes recorded into a block. The maths lives in web/blockseq.js.
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, createWriteStream, renameSync, rmSync, constants } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readJSON, writeJSON, mtime, settings } from './util.mjs';
import { needsYou, needsSummary } from './cutreview.mjs';
import { projectMeta, saveProjectMeta, roles, probe, lockedCut, appendWorklog, makeProxies, proxyName, formatTemplate, formatId,
  blockTypes, listTakes, pipelineStatus, MEDIA, isAudio, projectMedia, takeIntoSource } from './studio.mjs';
import { playSource } from './playback.mjs';
import { snapSegments } from '../web/layout.js';
import { takeOf, wordsOf, settleShots, takeBlockPresets, setTakeBlockPresets } from './shots.mjs';
import { normalizeDoc, sequence, kindOf, placeByRule, layoutSig, moveBlock, setEdge, insertAt, removeFromRow,
  pausesOf, snapPoints, ruleLabel, newId, exportParts, TYPE_LABEL } from '../web/blockseq.js';

export const BLOCKS = 'work/blocks.json';
const VIDEO = /\.(mov|mp4|m4v|mkv|webm)$/i;
const clock = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };
const two = (t) => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

// ---- what the blocks work on: the canvas take, its words, the locked cut (takeOf, wordsOf: server/shots.mjs) ----
// A file block's own videos: the camera (or the one file) and, for a recorded take, its screen.
// A sound file (a mic-only take, a dropped voiceover) is a block too: no picture, its sound over the background.
function fileInfo(dir, b) {
  if (kindOf(b) !== 'file') return null;
  const one = (rel) => {
    if (!rel?.startsWith('source/')) return null;
    const name = rel.slice(7);
    if (/[\\/]/.test(name) || !existsSync(join(dir, rel))) return null;
    const p = probe(dir, name);
    return p?.w || (isAudio(name) && p?.duration) ? { name, ...p } : null;
  };
  const main = one(b.source.file), scr = one(b.source.screen);
  if (!main) return { missing: true, name: basename(b.source.file) };
  if (!main.w) {
    return { name: main.name, duration: main.duration, audio: true, audioOnly: true,
      dims: { screen: null, cam: null, files: {} }, files: { cam: null, screen: null, audio: main.name }, proxy: `source/${main.name}` };
  }
  const screenOnly = !scr && /_screen\./i.test(main.name);
  const cam = screenOnly ? null : main, screen = screenOnly ? main : scr;
  const duration = Math.min(...[cam, screen].filter(Boolean).map((x) => x.duration));
  return {
    name: main.name, duration, audio: Boolean((cam || screen).audio),
    dims: { screen: screen ? [screen.w, screen.h] : null, cam: cam ? [cam.w, cam.h] : null, files: {} },
    files: { cam: cam?.name || null, screen: screen?.name || null },
    proxy: playSource(dir, main.name).src, // what the block's preview plays (server/playback.mjs): its copy or the original
  };
}
export function blocksCtx(dir) {
  const take = takeOf(dir);
  const cut = lockedCut(dir);
  const segs = cut && take.duration ? snapSegments(cut.segments, take.duration) : null;
  const words = wordsOf(dir);
  return { take, cutFile: cut?.file || null, cut: segs?.length ? segs : null, words: words.words, wordsFile: words.file,
    fileDur: (b) => fileInfo(dir, b)?.duration || 0 };
}

// ---- blocks.json ----
export function readBlocks(dir, ctx = blocksCtx(dir)) {
  const raw = readJSON(join(dir, BLOCKS), null);
  return raw ? normalizeDoc(raw, ctx.take.duration || Infinity) : null;
}
// Before any block exists: the whole take as one block, so a block can be added without marking sections first.
function startDoc(dir, ctx) {
  const type = formatId(projectMeta(dir)?.type);
  return normalizeDoc({ format: type, marked: false, blocks: ctx.take.duration ? [{ id: 'take', type: 'body', label: 'Whole take', source: { take: [0, ctx.take.duration] } }] : [] }, ctx.take.duration);
}
const save = (dir, doc) => writeJSON(join(dir, BLOCKS), { ...doc, by: 'studio', updated: new Date().toISOString() });
// A save Video Octopus makes by itself (settling rule blocks when the row is read) is neither the creator's change nor
// Claude's: index.mjs wraps it (server/package-owner.mjs serverWrite) so it never lands in the change package.
let serverWrite = (dir, write) => write();
export const setServerWriteHook = (fn) => { serverWrite = typeof fn === 'function' ? fn : (dir, write) => write(); };

// Blocks with a rule (and not moved by hand) go where it says, and stay there while the cut and the take blocks
// stay the same. When they change, the block moves to the nearest pause that still fits, with a note saying so.
// internal: the row is only being read (the view, the export), so a save here is Video Octopus's own.
function settle(dir, doc, ctx, { persist = true, internal = false } = {}) {
  let changed = false;
  for (const b of doc.blocks.slice()) {
    const cur = doc.blocks.find((x) => x.id === b.id);
    if (!cur?.rule || cur.override || kindOf(cur) === 'take') continue;
    if (cur.placed && cur.placed.sig === layoutSig(doc, ctx, cur.id)) continue;
    const r = placeByRule(doc, cur.id, ctx);
    if (r.doc === doc) continue;
    const nb = r.doc.blocks.find((x) => x.id === cur.id);
    nb.note = cur.placed ? (r.moved ? `Moved to ${two(r.at)} to stay ${ruleLabel(cur.rule).toLowerCase()}, ${r.why}.` : cur.note) : `Placed at ${two(r.at)}, ${r.why}.`;
    doc = r.doc;
    changed = true;
  }
  if (changed && persist) { if (internal) serverWrite(dir, () => save(dir, doc)); else save(dir, doc); }
  return doc;
}

// ---- the view for the band, the strip and the export dialog ----
export function blocksView(dir) {
  // The shots first: reading them moves any take block's layout into a shot (blocks.json changes), and a take block's
  // layout is the preset of the shot at its start (server/shots.mjs takeBlockPresets).
  const presets = takeBlockPresets(dir);
  const ctx = blocksCtx(dir);
  const meta = projectMeta(dir) || {};
  const tpl = formatTemplate(meta.type);
  let doc = readBlocks(dir, ctx);
  const exists = Boolean(doc);
  if (doc) doc = settle(dir, doc, ctx, { internal: true });
  else doc = startDoc(dir, ctx);
  const seq = sequence(doc, ctx);
  const sceneInfo = scenesByBlock(dir);
  const items = seq.items.map((it) => {
    const b = it.block;
    const layout = it.kind === 'take' ? presets[b.id] : b.layout;
    return { ...b, ...(layout ? { layout } : {}), kind: it.kind, dur: it.dur, start: it.start, end: it.end, at: it.at ?? null,
      ruleText: b.rule ? ruleLabel(b.rule) : '', file: fileInfo(dir, b), scenes: sceneInfo[b.id] || null };
  });
  return {
    exists, marked: doc.marked, format: formatId(meta.type), template: (tpl?.blocks || []).map((x) => ({ type: x.type, label: x.label, rule: x.rule || null, optional: Boolean(x.optional), hint: x.hint || '' })),
    types: { ...TYPE_LABEL, ...blockTypes() }, take: ctx.take, cut: ctx.cutFile ? { file: ctx.cutFile, segments: ctx.cut } : null, wordsFile: ctx.wordsFile,
    items, total: seq.total, snaps: snapPoints(ctx.words), pauses: pausesOf(ctx.words, ctx.cut).map((p) => p.t),
    parts: (exportParts(doc, ctx.cut, ctx.take.duration) || []).length,
  };
}

// Scenes of the production sheet (and their open notes) per block: scenes carry an optional "block" (M3).
function scenesByBlock(dir) {
  const prod = readJSON(join(dir, 'work/production.json'), null);
  const notes = readJSON(join(dir, 'work/notes.json'), null)?.notes || [];
  const out = {};
  for (const s of Array.isArray(prod?.scenes) ? prod.scenes : []) {
    const k = String(s.block || '');
    if (!k) continue;
    (out[k] ||= { count: 0, notes: 0, ids: [] }).count++;
    out[k].ids.push(String(s.id ?? ''));
  }
  for (const n of notes) if (n?.block && out[n.block] && n.status === 'open') out[n.block].notes++;
  return out;
}

// A short summary for the project view (the rail, the export dialog).
export function blocksSummary(dir) {
  if (!existsSync(join(dir, BLOCKS))) return null;
  try {
    const v = blocksView(dir);
    return { count: v.items.length, marked: v.marked, parts: v.parts, labels: v.items.map((x) => x.label), total: v.total };
  } catch { return null; }
}

// ---- edits from the band, the strip, the menus and @mentions ----
const TYPES_OK = (t) => Object.keys(TYPE_LABEL).includes(t);
export function blocksOp(dir, b) {
  settleShots(dir); // a take block's layout moves into a shot before the row is read (server/shots.mjs)
  const ctx = blocksCtx(dir);
  let doc = readBlocks(dir, ctx) || startDoc(dir, ctx);
  // The row before this edit, so the timeline can undo it (op "restore" puts a row back). Take blocks carry the preset
  // of the shot at their start in these copies, so an undo or redo puts the block menu's layout back too.
  const withPresets = (d) => { const pr = takeBlockPresets(dir, d.blocks); return { ...d, blocks: d.blocks.map((x) => (kindOf(x) === 'take' && pr[x.id] ? { ...x, layout: pr[x.id] } : x)) }; };
  const before = withPresets(structuredClone(doc));
  const find = (id) => { const x = doc.blocks.find((y) => y.id === id); if (!x) throw new Error('That block is gone.'); return x; };
  let made = null, note = null, shotPreset = null;
  const tl = timelineOp(doc, b, find, ctx);
  if (tl) {
    doc = tl.doc; made = tl.made || null; note = tl.note || null;
    // A restored row says each take block's layout: back into the shots (and out of blocks.json).
    if (b.op === 'restore') {
      shotPreset = doc.blocks.filter((x) => kindOf(x) === 'take').map((x) => ({ id: x.id, layout: x.layout || null }));
      for (const x of doc.blocks) if (kindOf(x) === 'take') delete x.layout;
    }
  } else if (b.op === 'insert') {
    const type = TYPES_OK(b.type) ? b.type : 'custom';
    const tplRule = formatTemplate(projectMeta(dir)?.type)?.blocks?.find((x) => x.type === type)?.rule || (type === 'sponsor' ? 'first 30%' : null);
    const source = b.source?.file ? { file: b.source.file, ...(b.source.screen ? { screen: b.source.screen } : {}) } : { pending: ['record', 'claude', 'file'].includes(b.source?.pending) ? b.source.pending : 'file' };
    const block = { id: newId(type), type, label: String(b.label || '').trim().slice(0, 60) || TYPE_LABEL[type], source };
    const rule = b.rule === undefined ? (b.where ? null : tplRule) : b.rule;
    if (rule) block.rule = String(rule).slice(0, 60);
    if (b.ask) block.ask = String(b.ask).slice(0, 600);
    if (b.where && !rule) {
      // "+" between two blocks: right there. A take second: the nearest gap or pause.
      if (b.where.at != null) { doc = insertAt(doc, block, { index: doc.blocks.length }); doc = moveBlock(doc, block.id, { at: Number(b.where.at) }, ctx); }
      else { const i = b.where.before ? doc.blocks.findIndex((x) => x.id === b.where.before) : -1; doc = insertAt(doc, block, { index: i < 0 ? doc.blocks.length : i }); }
    } else {
      doc = insertAt(doc, block, { index: doc.blocks.length });
      const r = placeByRule(doc, block.id, ctx);
      doc = r.doc;
      if (rule) doc.blocks.find((x) => x.id === block.id).note = `Placed at ${two(r.at)}, ${r.why}.`;
    }
    made = block.id;
    note = doc.blocks.find((x) => x.id === block.id)?.note || null;
  } else if (b.op === 'update') {
    const x = find(b.id);
    if (typeof b.label === 'string' && b.label.trim()) x.label = b.label.trim().slice(0, 60);
    if (b.type && TYPES_OK(b.type)) x.type = b.type;
    // A take block's look lives in its shots (work/shots.json): the layout goes to the shot at the block's start.
    // A file block is its own picture and keeps its layout here.
    if (b.layout !== undefined) {
      if (kindOf(x) === 'take') { shotPreset = [{ id: x.id, layout: b.layout || null }]; delete x.layout; }
      else if (b.layout) x.layout = b.layout; else delete x.layout;
    }
    if (b.rule !== undefined) {
      if (b.rule) { x.rule = String(b.rule).slice(0, 60); delete x.override; delete x.placed; } else { delete x.rule; delete x.override; delete x.placed; }
    }
    doc = normalizeDoc(doc, ctx.take.duration || Infinity);
  } else if (b.op === 'rule-back') {
    const x = find(b.id);
    delete x.override; delete x.placed;
  } else if (b.op === 'move') {
    find(b.id);
    doc = moveBlock(doc, b.id, b.at != null ? { at: Number(b.at) } : { before: b.before || null }, ctx);
    const x = doc.blocks.find((y) => y.id === b.id);
    if (x.rule) x.note = `Moved by you; "${ruleLabel(x.rule)}" no longer applies.`;
  } else if (b.op === 'edge') {
    find(b.id);
    doc = setEdge(doc, b.id, b.edge === 'start' ? 'start' : 'end', Number(b.t));
    doc.blocks.find((y) => y.id === b.id).reason = undefined;
    doc = normalizeDoc(doc, ctx.take.duration || Infinity);
  } else if (b.op === 'duplicate') {
    const x = find(b.id);
    const copy = { ...structuredClone(x), id: newId(x.type), ...(x.rule ? { override: true } : {}) };
    delete copy.part_of; delete copy.placed; delete copy.note; delete copy.reason;
    doc = insertAt(doc, copy, { index: doc.blocks.indexOf(x) + 1 });
    made = copy.id;
  } else if (b.op === 'delete') {
    find(b.id);
    doc = removeFromRow(doc, b.id);
  } else if (b.op === 'attach') {
    const x = find(b.id);
    if (!/^source\/[^/]+$/.test(b.file || '') || !existsSync(join(dir, b.file))) throw new Error('That file is not in source/.');
    x.source = { file: b.file, ...(b.screen && /^source\/[^/]+$/.test(b.screen) ? { screen: b.screen } : {}), ...(b.library ? { library: String(b.library) } : {}) };
  } else throw new Error('Unknown block action.');
  doc = settle(dir, doc, ctx);
  save(dir, doc);
  if (shotPreset) setTakeBlockPresets(dir, shotPreset.map((p) => ({ block: doc.blocks.find((y) => y.id === p.id), preset: p.layout })).filter((p) => p.block));
  return { ok: true, id: made, note, view: blocksView(dir), before, after: withPresets(readBlocks(dir, ctx)) };
}

// Edits from the timeline: split a take block at a take second (S / ⌘B), join a take block onto the one next to it
// (Delete on a take block: the take keeps playing, only the boundary goes), and restore a whole row (undo / redo).
function timelineOp(doc, b, find, ctx) {
  if (b.op === 'split') {
    const x = find(b.id), t = Number(b.t);
    if (kindOf(x) !== 'take') throw new Error('Only blocks of the main take can be split here.');
    const [s, e] = x.source.take;
    if (!(t > s + 0.2 && t < e - 0.2)) throw new Error('Move the playhead inside the block (not right at its edge) to split it.');
    const at = Math.round(t * 1000) / 1000;
    const base = x.label.replace(/ \(\d+\)$/, '');
    const n = doc.blocks.filter((y) => y.label === base || y.label.startsWith(`${base} (`)).length + 1;
    const tail = { ...structuredClone(x), id: newId(x.type), label: `${base} (${n})`, source: { take: [at, e] } };
    for (const k of ['reason', 'note', 'part_of', 'rule', 'override', 'placed']) delete tail[k];
    x.source.take = [s, at];
    return { doc: normalizeDoc(insertAt(doc, tail, { index: doc.blocks.indexOf(x) + 1 }), ctx.take.duration || Infinity), made: tail.id, note: `Split ${x.label} at ${clock(at)}.` };
  }
  if (b.op === 'join') {
    const x = find(b.id);
    if (kindOf(x) !== 'take') throw new Error('Only blocks of the main take join.');
    const takes = doc.blocks.filter((y) => y !== x && kindOf(y) === 'take');
    const near = takes.find((y) => Math.abs(y.source.take[1] - x.source.take[0]) < 0.02) || takes.find((y) => Math.abs(y.source.take[0] - x.source.take[1]) < 0.02);
    if (!near) throw new Error('This block has no take block right next to it to join.');
    near.source.take = [Math.min(near.source.take[0], x.source.take[0]), Math.max(near.source.take[1], x.source.take[1])];
    return { doc: normalizeDoc(removeFromRow(doc, x.id), ctx.take.duration || Infinity), note: `Joined ${x.label} into ${near.label}.` };
  }
  if (b.op === 'restore') {
    if (!b.doc || !Array.isArray(b.doc.blocks)) throw new Error('Nothing to restore.');
    return { doc: normalizeDoc(b.doc, ctx.take.duration || Infinity) };
  }
  return null;
}

// ---- files for a block: upload (drag and drop, Use a file), a recorder take, a library item ----
const safeName = (n) => basename(String(n || 'file')).replace(/[^\w.() -]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
function freeName(dir, name) {
  const ext = extname(name), stem = basename(name, ext);
  let n = name;
  for (let i = 2; existsSync(join(dir, 'source', n)); i++) n = `${stem} (${i})${ext}`;
  return n;
}
async function upload(req, dir, name) {
  if (!MEDIA.test(name)) throw new Error('Drop a video (.mov, .mp4, .m4v, .mkv, .webm) or a sound file (.wav, .m4a, .mp3, .aif, .flac).');
  mkdirSync(join(dir, 'source'), { recursive: true });
  const n = freeName(dir, safeName(name));
  const part = join(dir, 'source', `.${n}.part`);
  try { await pipeline(req, createWriteStream(part)); } catch (e) { rmSync(part, { force: true }); throw e; }
  if (!statSync(part).size) { rmSync(part, { force: true }); throw new Error('The file was empty.'); }
  renameSync(part, join(dir, 'source', n));
  appendWorklog(dir, `Added ${n} to source/ (dropped into Video Octopus for a block)`);
  return `source/${n}`;
}
// Simple mode's "Drop anything for Claude" (V1 spec §6): clips, screenshots, product photos, logos, fonts and notes
// stay with the project, in source/ next to the takes (originals live there; projectMedia lists only the media). A
// dropped recording that should be the take goes through /take-upload instead (web/simple-editor.js decides).
export const DROP_FILE = /\.(mov|mp4|m4v|mkv|webm|wav|m4a|mp3|aif|aiff|caf|flac|png|jpe?g|gif|webp|svg|heic|pdf|txt|md|markdown|csv|json|ttf|otf|woff2?)$/i;
export const DROP_MAX = 2e9;
async function dropFile(req, dir, name) {
  if (!DROP_FILE.test(String(name || ''))) throw new Error('Drop a video, a sound, a picture, a PDF, a text file or a font.');
  mkdirSync(join(dir, 'source'), { recursive: true });
  const n = freeName(dir, safeName(name));
  const part = join(dir, 'source', `.${n}.part`);
  try { await pipeline(req, createWriteStream(part)); } catch (e) { rmSync(part, { force: true }); throw e; }
  const size = statSync(part).size;
  if (!size || size > DROP_MAX) { rmSync(part, { force: true }); throw new Error(size ? 'That file is too big to drop here.' : 'The file was empty.'); }
  renameSync(part, join(dir, 'source', n));
  appendWorklog(dir, `Added ${n} to source/ (dropped for Claude)`);
  return `source/${n}`;
}
// Clone a recorder take into source/ without touching the canvas take (APFS clone: instant, no extra space).
// An imported file waiting in Recordings moves in instead (studio.mjs takeIntoSource), as one of the video's imports.
function cloneTake(dir, takeDir) {
  const { files, imported } = takeIntoSource(dir, takeDir);
  const meta = projectMeta(dir) || {};
  saveProjectMeta(dir, imported ? { imports: { ...(meta.imports || {}), [basename(takeDir)]: imported } } : { takes: [...new Set([...(meta.takes || []), basename(takeDir)])] });
  const cam = files.find((f) => /_webcam\./i.test(f)) || files.find((f) => !/_screen\./i.test(f)) || files[0];
  const screen = files.find((f) => /_screen\./i.test(f) && f !== cam);
  return { files, file: `source/${cam}`, screen: screen ? `source/${screen}` : undefined };
}
const libraryRoot = () => join(settings().studio, settings().libraryDir || 'library');
function libraryVideos() {
  const root = libraryRoot(), out = [];
  const walk = (d, depth) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || out.length > 200) continue;
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (st.isFile() && VIDEO.test(n)) out.push({ path: relative(settings().studio, p), name: n, bytes: st.size, at: st.mtimeMs });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.at - a.at);
}

// A take recorded with Record setup aimed at a block: it lands in source/ and becomes that block's file.
export function receiveBlockTake(dir, takeDir, target, how = 'Recorded') {
  const blockId = String(target).slice('block:'.length);
  const t = cloneTake(dir, takeDir);
  const ctx = blocksCtx(dir);
  let doc = readBlocks(dir, ctx) || startDoc(dir, ctx);
  let x = doc.blocks.find((b) => b.id === blockId);
  if (!x) { x = { id: blockId.replace(/[^\w-]/g, '').slice(0, 40) || newId('custom'), type: 'custom', label: 'New take', source: { pending: 'record' } }; doc = insertAt(doc, x, { index: doc.blocks.length }); x = doc.blocks.find((b) => b.id === x.id); }
  x.source = { file: t.file, ...(t.screen ? { screen: t.screen } : {}) };
  doc = settle(dir, doc, ctx);
  save(dir, doc);
  appendWorklog(dir, `${how} take ${basename(takeDir)} for the block "${x.label}": ${t.files.join(', ')}`);
  return { files: t.files, block: x.id, label: x.label };
}

// ---- @mentions: what the chat can point at, each with the exact reference Claude gets ----
export function mentionables(dir) {
  const v = blocksView(dir);
  const blocks = v.items.map((x) => {
    const where = `${ordinal(x.order)} of ${v.items.length} in the video, ${two(x.start)}–${two(x.end)}`;
    const src = x.kind === 'take' ? `take ${clock(x.source.take[0])}–${clock(x.source.take[1])} of source/${v.take.file}` : x.kind === 'file' ? `file ${x.source.file}${x.source.screen ? ` + ${x.source.screen}` : ''}${x.file?.duration ? `, ${x.file.duration.toFixed(1)} s` : ''}${x.file?.audioOnly ? ', sound only (shown over the background)' : ''}` : `no file yet (${x.source.pending === 'record' ? 'waiting for a recording' : 'to be made'})`;
    return { label: x.label, ref: `block:${x.id}`, kind: x.type, sub: `${TYPE_LABEL[x.type] || x.type} · ${x.kind === 'take' ? 'part of the take' : x.kind === 'file' ? 'own file' : 'empty'} · ${two(x.start)}`,
      resolve: `block "${x.id}" (type ${x.type}) in work/blocks.json · ${src} · ${where}${x.rule ? ` · rule "${x.rule}"${x.override ? ' (moved by hand)' : ''}` : ''}${x.layout ? ` · layout ${x.layout}` : ''}${x.scenes ? ` · scenes ${x.scenes.ids.join(', ')}` : ''}` };
  });
  // New blocks to mention: the format's blocks that aren't there yet, plus a sponsor read, B-roll and a custom block.
  const have = new Set(v.items.map((x) => x.type)), seen = new Set();
  const fresh = [...v.template.filter((t) => !have.has(t.type)), { type: 'sponsor', label: TYPE_LABEL.sponsor, rule: 'first 30%' }, { type: 'broll', label: 'B-roll' }, { type: 'custom', label: 'Custom block' }]
    .filter((t) => !seen.has(t.type) && seen.add(t.type))
    .map((t) => ({ label: have.has(t.type) || v.items.some((x) => x.label === t.label) ? `Another ${t.label.toLowerCase()}` : t.label, blockLabel: t.label,
      ref: `new:${t.type}`, kind: t.type, isNew: true, rule: t.rule || null, sub: `New block${t.rule ? ` · ${ruleLabel(t.rule)}` : ''}`,
      resolve: `a new ${t.label.toLowerCase()} block (type ${t.type}), not in work/blocks.json yet${t.rule ? `; its rule would be "${t.rule}"` : ''}` }));
  const r = roles(dir);
  const files = r.files.map((f) => {
    const p = probe(dir, f);
    const role = f === v.take.file ? (isAudio(f) ? 'canvas take, mic only' : 'canvas take, camera') : r.take.includes(f) ? 'canvas take, screen' : v.items.some((x) => x.source.file === `source/${f}` || x.source.screen === `source/${f}`) ? 'a block\'s file' : 'other take';
    return { label: f, ref: `file:source/${f}`, kind: 'file', sub: `${role}${p?.duration ? ` · ${two(p.duration)}` : ''}`, resolve: `source/${f} (${role}${p?.duration ? `, ${p.duration.toFixed(1)} s` : ''}${p?.w ? `, ${p.w}×${p.h}` : ''})` };
  });
  let renders = [];
  try { renders = readdirSync(join(dir, 'renders')).filter((f) => /\.(mp4|mov)$/i.test(f)).sort().reverse().slice(0, 8); } catch {}
  for (const f of renders) files.push({ label: f, ref: `file:renders/${f}`, kind: 'render', sub: 'render', resolve: `renders/${f}` });
  const prod = readJSON(join(dir, 'work/production.json'), null);
  const scenes = (Array.isArray(prod?.scenes) ? prod.scenes : []).filter((s) => Number.isFinite(Number(s.start))).map((s, i) => {
    const id = String(s.id ?? i + 1), title = String(s.title || s.visual || s.line || `Scene ${id}`).split(/[:.;(]/)[0].slice(0, 40);
    return { label: `Scene ${id}`, ref: `scene:${id}`, kind: 'scene', sub: `${title} · ${two(Number(s.start))}`,
      resolve: `scene "${id}" of work/production.json ("${title}", ${clock(Number(s.start))}–${clock(Number(s.end))} on the render timeline${s.block ? `, block ${s.block}` : ''})` };
  });
  const library = libraryVideos().slice(0, 30).map((x) => ({ label: x.name, ref: `lib:${x.path}`, kind: 'library', sub: x.path, resolve: `${x.path} in the studio library` }));
  return { groups: [
    { key: 'blocks', label: 'Blocks', items: [...blocks, ...fresh] },
    { key: 'files', label: 'Takes and files', items: files },
    { key: 'scenes', label: 'Scenes', items: scenes },
    { key: 'library', label: 'Library', items: library, empty: `Nothing in ${relative(settings().studio, libraryRoot()) || 'library'}/ yet` },
  ] };
}
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// What "Use a file" and "From library" can pick.
export function blockSources(dir) {
  const r = roles(dir);
  // Every other video or sound file in source/ (other takes, dropped files, voiceovers).
  const files = projectMedia(dir).filter((f) => !r.take.includes(f)).map((f) => { const p = probe(dir, f); return { file: `source/${f}`, name: f, duration: p?.duration || 0 }; });
  return { files, takes: listTakes().slice(0, 8), library: libraryVideos().slice(0, 60), libraryDir: relative(settings().studio, libraryRoot()) || 'library' };
}

// ---- briefs for the in-app Claude ----
export function sectionsBrief(dir, type) {
  const tpl = formatTemplate(type);
  const ctx = blocksCtx(dir);
  const doc = readBlocks(dir, ctx);
  const own = (doc?.blocks || []).filter((b) => kindOf(b) !== 'take');
  const list = (tpl?.blocks || []).map((b) => `${b.label} (type ${b.type}${b.optional ? ', optional' : ''}): ${b.hint}`).join('; ');
  const example = (tpl?.blocks || []).filter((b) => !b.optional).slice(0, 2).map((b, i) => `{"id": "${b.label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}", "type": "${b.type}", "label": "${b.label}", "order": ${i + 1}, "source": {"take": [${i ? '41.85, 150.2' : '0, 41.85'}]}, "reason": "${i ? 'ends on \\"…and that\'s the whole setup.\\"' : 'ends on \\"…so let\'s get into it\\"'}"}`).join(', ');
  return [
    `Mark the sections of this ${tpl?.label || 'video'}: propose where each block starts and ends, from the transcript, and write work/blocks.json. Video Octopus shows them as the section band over the timeline, where I'll drag any boundary that's off.`,
    `- Words: ${ctx.wordsFile || 'work/tr/words.json'} ([start, end, word] in seconds of source/${ctx.take.file}, which is ${ctx.take.duration.toFixed(1)} s long).${ctx.cutFile ? ` The locked cut ${ctx.cutFile} ("segments_sec", same seconds) says what's kept: go by the kept words.` : ''}`,
    `- The blocks of this format, in order: ${list}.`,
    `- Write {"v": 1, "format": "${formatId(type)}", "marked": true, "blocks": [${example}, …]}. Take ranges ("source": {"take": [start, end]}) cover the whole take from 0 to ${ctx.take.duration.toFixed(2)} with no gaps or overlaps, in playing order. Put each boundary in the pause just before the first word of the next block (that word's start minus 0.05 s). "reason" is one line per boundary: the words the block ends on (the last block: the words it starts with).`,
    own.length ? `- Keep these blocks exactly as they are (their own files and rules; Video Octopus places them again by their rule): ${own.map((b) => `"${b.id}" (${b.label}${b.rule ? `, rule "${b.rule}"` : ''})`).join(', ')}.` : '',
    `Then tell me each boundary in one line, e.g. "Intro ends at 0:42, on 'so let's get into it'".`,
  ].filter(Boolean).join('\n');
}

// The text a step sends, for steps whose brief Video Octopus writes itself (Mark sections). null = use the step's ask.
export function stepBrief(dir, type, stepId) {
  const step = pipelineStatus(dir, type)?.steps.find((s) => s.id === stepId);
  if (step?.brief === 'sections') return sectionsBrief(dir, type);
  return null;
}

// "Ask Claude" from the + menu: Claude makes the block's file.
export function askBrief(dir, id) {
  const doc = readBlocks(dir);
  const b = doc?.blocks.find((x) => x.id === id);
  if (!b) throw new Error('That block is gone.');
  const ly = projectMeta(dir)?.layout || {};
  return `Make the "${b.label}" block (type ${b.type}, id "${b.id}" in work/blocks.json) for this project${b.ask ? `: ${b.ask}` : '.'}\nRender it as its own video into source/ (${ly.aspect === '9:16' ? '1080×1920' : '1920×1080'}, 30 fps, with sound if it needs any), then set that block's "source" to {"file": "source/<name>"} in work/blocks.json. Leave its position, rule and the other blocks as they are: Video Octopus places it and splices it into the export.`;
}

// ---- Prepare on the rail: running, its sub-steps, and what needs the creator ----
const runs = new Map(); // project id -> when Prepare was sent
export const noteStep = (id, step) => { if (step === 'prepare') runs.set(id, Date.now()); };
export function prepareState(id, dir, busy) {
  const started = runs.get(id) || 0;
  const joins = join(dir, 'work/joins.json');
  const finished = mtime(joins) > started;
  const running = Boolean(busy && started && !finished);
  if (!busy && started && Date.now() - started > 5000) runs.delete(id);
  const p = readJSON(join(dir, 'work/prepare.json'), null);
  const j = readJSON(joins, null);
  const clipped = Number(j?.summary?.likely_clipped) || 0;
  // What still needs the creator: the one count the done line, the dock, the Cut chip, the Cut inspector and the
  // Keep / Cut list all show (server/cutreview.mjs needsYou: the parts in To check nobody has decided yet).
  const needs = needsYou(dir);
  return { running, needs, summary: needsSummary(dir) || (typeof p?.summary === 'string' ? p.summary.slice(0, 120) : null),
    asks: Array.isArray(p?.ask) ? p.ask.slice(0, 20).map((a) => ({ t: Number(a.t) || 0, what: String(a.what || '').slice(0, 120) })) : [], clipped };
}

// What the in-app Claude is told about blocks (added to the project context).
export const blocksContext = () => `Blocks: work/blocks.json is the project's row of blocks, in playing order: {v: 1, format, marked, blocks: [{id, type "intro"|"body"|"sponsor"|"outro"|"broll"|"custom", label, order, source {take: [start, end] (seconds of the canvas take)} or {file: "source/…", screen?: "source/…"} (its own video) or {pending: "record"|"claude"}, rule? ("first 30%", "after intro", "before outro", "at a pause", "end"), override? (moved by hand), layout? (a file block's own canvas preset; a take block's look is its shots in work/shots.json, and Video Octopus moves a layout put on a take block into the shot at its start), reason? (one line on its boundary), part_of? (a take block split by an inserted block)}]}. Video Octopus shows them as a band over the timeline; Export renders them in order (take blocks cut by the locked cut, file blocks spliced in with the same canvas layout and their own sound). Video Octopus places blocks with a rule at the nearest pause that fits and moves them again when the cut changes, so don't do that by hand. Production-sheet scenes and notes carry the id of their block ("block"). A message may end with "Video Octopus references": those resolve the @mentions in it to exact ids, files and times; use them.`;

// ---- routes: /blocks, /block-sources, /mentions, /upload, /block-ask ----
export async function blocksRoute(req, res, { dir, action, url, send, body, chat, broadcast }) {
  if (action === '/blocks' && req.method === 'GET') return send(res, 200, blocksView(dir)), true;
  if (action === '/block-sources') return send(res, 200, blockSources(dir)), true;
  if (action === '/mentions') return send(res, 200, mentionables(dir)), true;
  if (req.method !== 'POST' || !['/upload', '/drop', '/blocks', '/block-ask'].includes(action)) return false;
  if (action === '/drop') {
    try {
      const file = await dropFile(req, dir, url.searchParams.get('name') || '');
      if (MEDIA.test(file)) makeProxies(dir, broadcast);
      broadcast({ t: 'files' });
      return send(res, 200, { file }), true;
    } catch (e) { return send(res, 400, { error: e.message }), true; }
  }
  if (action === '/upload') {
    try {
      const file = await upload(req, dir, url.searchParams.get('name') || 'file.mp4');
      makeProxies(dir, broadcast);
      broadcast({ t: 'files' });
      return send(res, 200, { file }), true;
    } catch (e) { return send(res, 400, { error: e.message }), true; }
  }
  const b = await body(req);
  try {
    if (action === '/blocks') {
      if (b.op === 'use-take') {
        if (!b.take || /[/\\]|\.\./.test(b.take)) throw new Error('Bad take');
        const t = cloneTake(dir, join(settings().recordingsDir, b.take));
        makeProxies(dir, broadcast);
        appendWorklog(dir, `Imported take ${b.take} for a block: ${t.files.join(', ')}`);
        return send(res, 200, blocksOp(dir, { op: 'attach', id: b.id, file: t.file, screen: t.screen })), true;
      }
      if (b.op === 'use-library') {
        const src = join(settings().studio, String(b.path || ''));
        if (!String(b.path || '').startsWith(relative(settings().studio, libraryRoot())) || b.path.includes('..') || !existsSync(src)) throw new Error('That library file is gone.');
        const n = freeName(dir, safeName(basename(src)));
        mkdirSync(join(dir, 'source'), { recursive: true });
        copyFileSync(src, join(dir, 'source', n), constants.COPYFILE_FICLONE);
        makeProxies(dir, broadcast);
        appendWorklog(dir, `Copied ${b.path} from the library into source/${n} for a block`);
        return send(res, 200, blocksOp(dir, { op: 'attach', id: b.id, file: `source/${n}`, library: b.path })), true;
      }
      const r = blocksOp(dir, b);
      if (b.op === 'attach') makeProxies(dir, broadcast);
      broadcast({ t: 'files' });
      return send(res, 200, r), true;
    }
    if (action === '/block-ask') {
      await chat().send(askBrief(dir, b.id), { brief: { name: 'Make a block' } });
      return send(res, 200, { ok: true }), true;
    }
  } catch (e) { return send(res, 400, { error: e.message }), true; }
  return false;
}

// The video as parts for the export (server/export.mjs): null when the blocks don't change the plain export.
// useCut false: the whole take inside each block ("Whole take" in the export dialog). Take blocks carry no look here:
// the look of every stretch of the take is its shot's (work/shots.json), and the export renders it shot by shot
// (server/export-shots.mjs), so consecutive take blocks are one part and only file blocks and a new order split it.
export function sequenceForExport(dir, { useCut = true, readOnly = false } = {}) {
  // Text planning needs the same sequence, but must not migrate visual layouts or
  // persist automatic rule placement just to preview a transcript/subtitle file.
  if (!readOnly) { try { settleShots(dir); } catch (e) { console.error('shots:', e.message); } }
  const ctx = blocksCtx(dir);
  let doc = readBlocks(dir, ctx);
  if (!doc) return null;
  doc = settle(dir, doc, ctx, { persist: !readOnly, internal: true });
  doc = { ...doc, blocks: doc.blocks.map((x) => { if (kindOf(x) !== 'take' || !x.layout) return x; const { layout, ...y } = x; return y; }) };
  const parts = exportParts(doc, useCut ? ctx.cut : null, ctx.take.duration);
  if (!parts) return null;
  for (const p of parts) if (p.kind === 'file') p.info = fileInfo(dir, p.block);
  const missing = parts.filter((p) => p.kind === 'file' && (!p.info || p.info.missing));
  if (missing.length) throw new Error(`The block${missing.length > 1 ? 's' : ''} ${missing.map((p) => `"${p.block.label}"`).join(', ')} ${missing.length > 1 ? 'have' : 'has'} no playable file yet.`);
  return { parts, doc, cutFile: useCut ? ctx.cutFile : null };
}

// For the record panel and chat notes.
export const blockLabel = (dir, id) => readBlocks(dir)?.blocks.find((b) => b.id === id)?.label || null;
