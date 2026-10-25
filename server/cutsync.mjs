// The cut the scenes and renders were made on, and keeping the change package in step with the cut.
//
// work/cut_scenes.json is a snapshot of the cut ({segments} in take seconds) that the production sheet, the scene
// files and the renders use. It's taken when a production sheet or a render is written (and the first time Video Octopus
// sees a project with a sheet), unless a cut change is still waiting in the package. Whenever the cut file changes,
// in Video Octopus's Cut tab, in the Cut Editor on its own or by Claude, the package's one "cut" item says what changed
// against that snapshot (or against the cut a sent item already took Claude to). On Save (apply-notes) Video Octopus
// re-times its own JSON files from the old cut to the new one, through the take, before Claude re-renders.
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readJSON, writeJSON } from './util.mjs';
import { lockedCut, probeFile } from './studio.mjs';
import { cutPlan } from './cuteditor.mjs';
import { basename } from 'node:path';
import { normalize } from '../web/layout.js';
import { notesDoc, saveNotes, cutEdits, setCutChange, setListChange } from './scenes.mjs';
import { takeBlockPresets } from './shots.mjs';
import { builtRenders } from './built.mjs';

export const SNAP = 'work/cut_scenes.json';
const SHEET = 'work/production.json', OVERRIDES = 'work/overrides.json', NOTES = 'work/notes.json';
const r3 = (x) => Math.round(x * 1000) / 1000;

export function cutSnapshot(dir) {
  const s = readJSON(join(dir, SNAP), null);
  return Array.isArray(s?.segments) && s.segments.length ? s : null;
}
export function takeSnapshot(dir, why, segments) {
  const segs = segments || lockedCut(dir)?.segments;
  if (!segs?.length) return null;
  const snap = { segments: segs.map(([a, b]) => [r3(a), r3(b)]), at: new Date().toISOString(), why,
    note: 'The cut the production sheet, the scene files and the renders are on (Video Octopus keeps this; take seconds).' };
  writeJSON(join(dir, SNAP), snap);
  return snap;
}
const openCut = (doc) => doc.notes.find((n) => n.kind === 'change' && n.field === 'cut' && n.status === 'open');

// A project with a sheet but no snapshot yet: assume the sheet is on the cut as it is now.
// A cut change already waiting (made before Video Octopus kept snapshots) knows the cut it started from: use that.
export function ensureSnapshot(dir) {
  if (cutSnapshot(dir) || !existsSync(join(dir, SHEET))) return;
  const open = openCut(notesDoc(dir));
  takeSnapshot(dir, open ? `the cut a waiting change started from (${open.id})` : 'first seen with a production sheet', open?.from?.segments);
}

// The package's cut item against the snapshot. Returns { created, removed } (created: say so in the chat).
export function syncCutItem(dir) {
  ensureSnapshot(dir);
  const snap = cutSnapshot(dir), cur = lockedCut(dir);
  if (!snap || !cur?.segments?.length) return { created: false };
  // A cut change already sent after the snapshot: Claude is (or was) taking the video to that cut, so count from there.
  const sent = notesDoc(dir).notes.filter((n) => n.kind === 'change' && n.field === 'cut' && n.status !== 'open' && n.sent_at && Date.parse(n.sent_at) >= Date.parse(snap.at))
    .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0];
  const base = sent?.to?.segments || snap.segments;
  return setCutChange(dir, base, cur.segments);
}

// ---- Blocks and the canvas look: what changed since Claude last got the package ----
// work/package_base.json holds both as Claude last got them (first sight: as they are; after each Save: as sent).
const BASE = 'work/package_base.json';
// A take block's layout is the preset of the shot at its start (work/shots.json; server/shots.mjs takeBlockPresets).
const blocksNow = (dir) => {
  const presets = takeBlockPresets(dir);
  return (readJSON(join(dir, 'work/blocks.json'), null)?.blocks || []).map((b) => ({ id: b.id, label: b.label, type: b.type, order: b.order, source: b.source || null, rule: b.rule || null,
    layout: (Array.isArray(b.source?.take) ? presets[b.id] : b.layout) || null }));
};
// The canvas look as the app reads it (defaults filled in), so a save that only fills defaults isn't a change.
const normLook = (dir, layout) => { if (!layout) return null; try { return normalize(layout, readJSON(join(dir, 'project.json'), null)?.type); } catch { return layout; } };
const lookNow = (dir) => normLook(dir, readJSON(join(dir, 'project.json'), null)?.layout || null);
// keepOpen: the creator's own blocks or look change that's still waiting to be sent keeps its starting point, so a
// change Claude makes meanwhile can't wipe it out of the package (the item then covers both).
export function markPackageBase(dir, { keepOpen = false } = {}) {
  const old = keepOpen ? readJSON(join(dir, BASE), null) : null;
  const waiting = new Set(old ? notesDoc(dir).notes.filter((n) => n.kind === 'change' && n.status === 'open').map((n) => n.field) : []);
  const blocks = waiting.has('blocks') ? old.blocks : blocksNow(dir), look = waiting.has('look') ? old.look : lookNow(dir);
  // Nothing moved (most turns end here): leave the file alone, so the watcher has nothing new to report.
  const cur = keepOpen ? old : readJSON(join(dir, BASE), null);
  if (cur && JSON.stringify(cur.blocks) === JSON.stringify(blocks) && JSON.stringify(cur.look) === JSON.stringify(look)) return;
  writeJSON(join(dir, BASE), { blocks, look,
    at: new Date().toISOString(), note: 'The blocks and canvas look as Claude last got them in a change package, or as Claude or Video Octopus left them (Video Octopus keeps this).' });
}
const clk = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const srcText = (s) => (s?.file ? `the file ${basename(s.file)}` : Array.isArray(s?.take) ? `take ${clk(s.take[0])}–${clk(s.take[1])}` : 'no source');
export function blocksEdits(A = [], B = []) {
  const a = new Map(A.map((x) => [x.id, x])), b = new Map(B.map((x) => [x.id, x])), name = (x) => `“${x.label || x.id}”`, out = [];
  for (const x of B) if (!a.has(x.id)) out.push(`added ${name(x)} (${x.type || 'block'}, ${srcText(x.source)})`);
  for (const x of A) if (!b.has(x.id)) out.push(`removed ${name(x)}`);
  for (const x of B) {
    const o = a.get(x.id);
    if (!o) continue;
    if ((o.label || '') !== (x.label || '')) out.push(`renamed ${name(o)} → ${name(x)}`);
    if (o.type !== x.type) out.push(`${name(x)} is now ${x.type}`);
    if (JSON.stringify(o.source) !== JSON.stringify(x.source)) out.push(`${name(x)} now uses ${srcText(x.source)} (was ${srcText(o.source)})`);
    if (JSON.stringify(o.rule) !== JSON.stringify(x.rule)) out.push(`${name(x)} placement ${x.rule ? `rule “${typeof x.rule === 'string' ? x.rule : JSON.stringify(x.rule)}”` : 'set by hand'}`);
    if (JSON.stringify(o.layout) !== JSON.stringify(x.layout)) out.push(`${name(x)} ${x.layout ? 'has its own layout' : 'uses the video layout again'}`);
  }
  const order = (L) => L.filter((x) => a.has(x.id) && b.has(x.id)).sort((p, q) => (p.order ?? 0) - (q.order ?? 0)).map((x) => x.id);
  if (order(A).join('|') !== order(B).join('|')) out.push(`new order: ${[...B].sort((p, q) => (p.order ?? 0) - (q.order ?? 0)).map((x) => x.label || x.id).join(', ')}`);
  return out;
}
const LOOK_NAME = { preset: 'layout', side: 'presenter side', mirror: 'mirror', aspect: 'aspect', 'cam.shape': 'camera frame', 'cam.zoom': 'camera zoom', 'cam.border': 'camera border',
  'screen.zoom': 'screen zoom', 'screen.border': 'screen border', pad: 'screen inset', layers: 'layers', 'bg.kind': 'background', background: 'background' };
function flat(o, p = '', out = {}) {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out); return out; }
  out[p] = Array.isArray(o) ? `${o.length} item${o.length === 1 ? '' : 's'}` : typeof o === 'number' ? Math.round(o * 100) / 100 : o;
  return out;
}
export function lookEdits(A, B) {
  if (!A || !B) return [];
  const fa = flat(A), fb = flat(B), out = [];
  const moved = new Set(); // camera / screen: framing moved, crop changed (one line each, not one per number)
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (fa[k] === fb[k]) continue;
    const m = /^(cam|screen)\.(focus|crop)\./.exec(k);
    if (m) { moved.add(`${m[1] === 'cam' ? 'camera' : 'screen'} ${m[2] === 'focus' ? 'framing moved' : 'crop changed'}`); continue; }
    out.push(`${LOOK_NAME[k] || k} ${fa[k] ?? 'none'} → ${fb[k] ?? 'none'}`);
  }
  out.push(...moved);
  return out;
}
export function syncDocItems(dir) {
  let base = readJSON(join(dir, BASE), null);
  if (!base) { markPackageBase(dir); return []; }
  const made = [];
  // The canvas look is Video Octopus's own (the canvas and its export draw it), so a change to it is only for Claude when
  // something Claude built shows the canvas look (a Build step's render: the intro), which then needs building again.
  // With nothing built, the base keeps up with the look, so a later build doesn't bring old changes back.
  const builds = builtRenders(dir, basename(dir));
  const lookE = lookEdits(normLook(dir, base.look), lookNow(dir));
  if (!builds.length && lookE.length) writeJSON(join(dir, BASE), { ...base, look: lookNow(dir) });
  if (builds.length && lookE.length) lookE.push(`${builds.map((b) => `the ${String(b.label).toLowerCase()} render (${b.file.replace(/^renders\//, '')})`).join(' and ')} still ${builds.length > 1 ? 'show' : 'shows'} the old look`);
  for (const [field, edits] of [['blocks', blocksEdits(base.blocks || [], blocksNow(dir))], ['look', builds.length ? lookE : []]]) {
    const r = setListChange(dir, field, edits);
    if (r.created) made.push(r.item);
  }
  return made;
}

// After the project's files change (the watcher's list, paths relative to the project). Returns the items that
// just appeared in the package (to say so in the chat).
export function onProjectFiles(dir, files) {
  const made = [];
  if (files.some((f) => f === 'work/blocks.json' || f === 'project.json' || f === 'work/shots.json')) made.push(...syncDocItems(dir));
  const sheetOrRender = files.some((f) => f === SHEET || /^renders\/[^/]+\.(mp4|mov|m4v)$/i.test(f));
  const cutFile = files.some((f) => /^work\/edl_(manual|fixed)\.json$/.test(f));
  if (sheetOrRender || cutFile) {
    // A new sheet or render is on the cut as it is now, unless a cut change is still waiting to be sent.
    if (sheetOrRender && existsSync(join(dir, SHEET)) && !openCut(notesDoc(dir))) takeSnapshot(dir, files.includes(SHEET) ? 'production sheet written' : 'render written');
    const r = syncCutItem(dir);
    if (r?.created) made.push(r.item);
  }
  return made;
}

// ---- Trimming a cut from Scenes (One scene's cut lines, Whole video's trim lens) ----
// The same cut as the Cut tab: Scenes reads the take the Cut Editor plays (its words and the cut now) and saves the
// whole cut into work/edl_manual.json the way the Cut Editor does, so the Cut tab, Scenes and the package agree.
const MANUAL = 'work/edl_manual.json';
export const cutVersion = (dir) => (existsSync(join(dir, MANUAL)) ? statSync(join(dir, MANUAL)).mtimeMs : 0);
export function cutTake(dir) {
  const plan = cutPlan(dir);
  if (!plan.ready) return { ok: false, why: plan.why };
  const raw = readJSON(join(dir, plan.words), []);
  const words = (Array.isArray(raw) ? raw : []).filter((w) => Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]))
    .map(([a, b, t]) => [r3(a), r3(b), String(t)]);
  const segs = lockedCut(dir)?.segments || readJSON(join(dir, plan.edl), {})?.segments_sec || [];
  const info = probeFile(join(dir, plan.video));
  return { ok: true, video: plan.video, words, segments: segs.map(([a, b]) => [r3(a), r3(b)]), version: cutVersion(dir),
    fps: info?.fps > 1 ? Math.round(info.fps * 1000) / 1000 : 30, duration: info?.duration || null };
}
// version: the cut file as the page last read it (its mtime); a newer save (the Cut tab, Claude) wins and the page
// reloads. Returns { conflict } or { version, created }.
export function saveCut(dir, segments, version) {
  if (version != null && Math.abs(Number(version) - cutVersion(dir)) > 1) return { conflict: true };
  const plan = cutPlan(dir);
  if (!plan.ready) throw new Error(plan.why);
  const segs = (Array.isArray(segments) ? segments : []).map(([a, b]) => [Number(a), Number(b)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a > 0.02).sort((x, y) => x[0] - y[0]).map(([a, b]) => [r3(a), r3(b)]);
  if (!segs.length) throw new Error('A cut needs something kept.');
  for (let i = 1; i < segs.length; i++) if (segs[i][0] < segs[i - 1][1] - 1e-3) throw new Error('Parts of the cut overlap.');
  const info = probeFile(join(dir, plan.video));
  writeJSON(join(dir, MANUAL), { source: join(dir, plan.video), fps: info?.fps || 30, segments_sec: segs, saved_at: new Date().toISOString(),
    edited_length: r3(segs.reduce((t, [a, b]) => t + b - a, 0)), by: 'Video Octopus Scenes' });
  const r = syncCutItem(dir);
  return { version: cutVersion(dir), created: Boolean(r?.created), item: r?.item || null };
}

// Old cut time → take → new cut time. A moment inside newly cut material moves to the next kept moment.
export function cutMapper(A, B) {
  const toTake = (t) => { let d = 0; for (const [a, b] of A) { const L = b - a; if (t <= d + L + 1e-6) return a + Math.max(0, t - d); d += L; } return A.length ? A[A.length - 1][1] : t; };
  const fromTake = (x) => { let d = 0; for (const [a, b] of B) { if (x < a - 1e-6) return d; if (x <= b + 1e-6) return d + (x - a); d += b - a; } return d; };
  const lenA = A.reduce((s, [a, b]) => s + b - a, 0), lenB = B.reduce((s, [a, b]) => s + b - a, 0);
  // Past the end of the cut (an end card appended after the take): keep the overhang.
  return (t) => r3(t > lenA ? lenB + (t - lenA) : fromTake(toTake(t)));
}
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
// "0:02" or "1:04.5" beat labels keep their precision.
function mapClock(s, map) {
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return s;
  const dec = (m[2].split('.')[1] || '').length, t = map(Number(m[1]) * 60 + Number(m[2]));
  const mm = Math.floor(t / 60), ss = (t - mm * 60).toFixed(dec);
  return `${mm}:${ss.padStart(dec ? 3 + dec : 2, '0')}`;
}

// Save (apply-notes) with a cut change waiting: re-time the sheet, the keyframes and element times, and the notes,
// keep copies of the old files, move the snapshot to the new cut, and mark the item so the brief can say so.
export function retimeOnSave(dir) {
  const doc = notesDoc(dir), item = openCut(doc);
  if (!item || !existsSync(join(dir, SHEET))) return null;
  const A = item.from?.segments, B = item.to?.segments;
  if (!A?.length || !B?.length || !cutEdits(A, B).length) return null;
  const map = cutMapper(A, B), at = new Date().toISOString();
  const backup = `work/retime-backup/${at.replace(/[:.]/g, '-')}`;
  const keep = (rel) => { const src = join(dir, rel); if (!existsSync(src)) return; const dst = join(dir, backup, rel.replace(/^work\//, '')); mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); };
  const done = [];

  const sheet = readJSON(join(dir, SHEET), null);
  if (sheet && Array.isArray(sheet.scenes)) {
    keep(SHEET);
    let beats = 0;
    for (const s of sheet.scenes) {
      if (isNum(s.start)) s.start = map(s.start);
      if (isNum(s.end)) s.end = map(s.end);
      if (isNum(s.sfx_at)) s.sfx_at = map(s.sfx_at);
      else if (Array.isArray(s.sfx_at)) s.sfx_at = s.sfx_at.map((x) => (isNum(x) ? map(x) : x));
      if (Array.isArray(s.beats)) s.beats = s.beats.map((b) => {
        beats++;
        if (Array.isArray(b) && typeof b[0] === 'string') return [mapClock(b[0], map), ...b.slice(1)];
        if (Array.isArray(b) && isNum(b[0])) return [map(b[0]), ...b.slice(1)];
        if (b && typeof b === 'object' && isNum(b.t)) return { ...b, t: map(b.t) };
        return b;
      });
    }
    for (const g of sheet.sections || []) { if (isNum(g.start)) g.start = map(g.start); if (isNum(g.end)) g.end = map(g.end); }
    writeJSON(join(dir, SHEET), sheet);
    done.push(`${SHEET} (${sheet.scenes.length} scenes, ${(sheet.sections || []).length} sections, ${beats} beats)`);
  }

  const ov = readJSON(join(dir, OVERRIDES), null);
  if (ov?.scenes && typeof ov.scenes === 'object') {
    let keys = 0, times = 0;
    for (const els of Object.values(ov.scenes)) for (const o of Object.values(els || {})) {
      for (const k of o?.keys || []) if (isNum(k.t)) { k.t = map(k.t); keys++; }
      for (const f of ['in', 'out']) if (isNum(o?.[f])) { o[f] = map(o[f]); times++; }
    }
    if (keys || times) { keep(OVERRIDES); writeJSON(join(dir, OVERRIDES), ov); done.push(`${OVERRIDES} (${keys} keyframe${keys === 1 ? '' : 's'}${times ? `, ${times} element times` : ''})`); }
  }

  keep(NOTES);
  let nn = 0;
  for (const n of doc.notes) {
    if (n === item || (n.kind === 'change' && n.field === 'cut')) continue;
    if (isNum(n.t)) { n.t = map(n.t); nn++; }
    if (Array.isArray(n.range) && n.range.every(isNum)) n.range = n.range.map(map);
    if (n.kind === 'change' && n.field === 'timing' && n.status === 'open') for (const v of [n.from, n.to]) for (const f of ['start', 'end', 'in', 'out']) if (isNum(v?.[f])) v[f] = map(v[f]);
  }
  done.push(`${NOTES} (${nn} note time${nn === 1 ? '' : 's'})`);
  item.retimed = { at, files: done, backup };
  saveNotes(dir, doc);
  takeSnapshot(dir, `Video Octopus re-timed the sheet to the new cut on Save (${item.id})`, B);
  return item.retimed;
}
