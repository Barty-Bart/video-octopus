// The editor's side of shots, the pure part: no DOM, shared by the canvas
// (web/app.js), the Shots lane (web/shotsui.js) and the smoke test. The data and its edits are in web/shots.js, the look
// at a moment in web/layout.js (lookAt, transitionAt); this file is how the canvas edits a shot and draws one.
//
// Editing a shot. The canvas edits a full layout like it always has (drags, sliders, tiles, the eye). In "This shot"
// that layout is the shot's own look (effectiveLook of the video's look and the shot's changes); each change is turned
// into a partial look (patchOf), kept on top of the shot's changes (applyPatch, which drops what equals the video's
// look again), and written with the routes' look / clear ops (reconcile). What can't differ per shot (the frame shape,
// the background, the list of extra layers) goes to the video's look (patchOf's `whole`).
//
// Drawing. frameLooks(t, ctx) is what the canvas draws at take second t: the look of the shot under the playhead, or,
// inside a transition, the two looks and how far it has got (played seconds, like web/layout.js transitionAt). The
// shot being edited draws from the canvas's own unsaved layout (ctx.edit), so a drag shows before it is saved.
import { NEEDS, normalizeLook, effectiveLook, shotAt, transitionsOf, playedAt, lookKeys } from './layout.js';
import { combineLooks } from './shots.js';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const OBJ = ['webcam', 'cam', 'screen'];

// What a full layout leaves out, as a look's hidden list: the canvas take's camera / screen and extra layers as
// "layer:<id>", sorted (a shot's hidden list replaces the video's whole list).
export function hiddenOf(layout) {
  const out = [...(layout?.hidden || []).filter((x) => x === 'cam' || x === 'screen')];
  for (const x of layout?.layers || []) if (x.hidden) out.push(`layer:${x.id}`);
  return [...new Set(out)].sort();
}

// patchOf(before, after) → { look, whole }: what changed between two full layouts. look: the change as a partial look
// (null: nothing a shot keeps); whole: { aspect?, bg?, layers? } (the layers without their hidden flags), the parts that
// stay whole-video, or null.
export function patchOf(a, b) {
  const look = {}, whole = {};
  for (const k of ['preset', 'side', 'mirror', 'pad']) if (!same(a?.[k], b?.[k]) && b?.[k] !== undefined) look[k] = b[k];
  for (const k of OBJ) {
    const x = a?.[k] || {}, y = b?.[k] || {}, o = {};
    for (const f of Object.keys(y)) if (!same(x[f], y[f])) o[f] = y[f];
    if (Object.keys(o).length) look[k] = o;
  }
  const ha = hiddenOf(a), hb = hiddenOf(b);
  if (!same(ha, hb)) look.hidden = hb;
  if (a?.aspect !== b?.aspect) whole.aspect = b.aspect;
  if (!same(a?.bg, b?.bg)) whole.bg = b.bg;
  const strip = (L) => (L || []).map(({ hidden, ...x }) => x);
  if (!same(strip(a?.layers), strip(b?.layers))) whole.layers = strip(b?.layers);
  return { look: normalizeLook(look), whole: Object.keys(whole).length ? whole : null };
}

// pruneToBase(look, base) → the look without what equals the video's own look (null when nothing is left), so the
// "changed in this shot" dots mean a real difference and the shot follows the video's look elsewhere.
export function pruneToBase(look, base) {
  if (!look) return null;
  const out = {};
  for (const [k, v] of Object.entries(look)) {
    if (k === 'hidden') { if (!same([...v].sort(), hiddenOf(base))) out.hidden = [...v].sort(); continue; }
    if (OBJ.includes(k)) {
      const o = {};
      for (const [f, x] of Object.entries(v || {})) if (!same(x, base?.[k]?.[f])) o[f] = x;
      if (Object.keys(o).length) out[k] = o;
      continue;
    }
    if (!same(v, base?.[k])) out[k] = v;
  }
  return normalizeLook(out);
}

// applyPatch(shotLook, change, base) → the shot's new partial look. A layout picked that needs a picture this shot
// hides (PiP while the camera is hidden here) shows that picture again, or the pick would change nothing.
export function applyPatch(cur, change, base) {
  let next = combineLooks(cur || null, change);
  if (next && change?.preset && next.hidden) {
    const need = NEEDS[change.preset] || [], was = new Set(hiddenOf(base));
    const kept = next.hidden.filter((x) => !(need.includes(x) && !was.has(x)));
    if (kept.length !== next.hidden.length) next = { ...next, hidden: kept };
  }
  return pruneToBase(next, base);
}

// A look as paths → values ('preset', 'cam.zoom', 'hidden', …), the routes' look / clear keys.
function flat(look) {
  const out = {};
  for (const p of lookKeys(look || {})) { const [a, f] = p.split('.'); out[p] = f ? look[a][f] : look[a]; }
  return out;
}
// reconcile(cur, next) → { set, clear }: the ops that turn a shot's saved look into the one the canvas has now.
// set: a partial look for { op: 'look' } (null: none); clear: keys for { op: 'clear', keys } (empty: none).
export function reconcile(cur, next) {
  const pc = flat(cur), pn = flat(next), set = {}, clear = [];
  for (const [p, v] of Object.entries(pn)) {
    if (same(pc[p], v)) continue;
    const [a, f] = p.split('.');
    if (f) (set[a] ||= {})[f] = v; else set[a] = v;
  }
  for (const p of Object.keys(pc)) if (!(p in pn)) clear.push(p);
  return { set: normalizeLook(set), clear };
}

// Does a look change any of these properties? keys: 'preset', 'webcam' (any field), 'cam.zoom', …
export const touches = (look, keys) => lookKeys(look || {}).filter((p) => keys.some((k) => p === k || p.startsWith(`${k}.`)));

// frameLooks(t, ctx) → { index, look, tr }: what the canvas draws at take second t.
//   ctx: { list (the shots, in order), base (the video's look), cut (the locked cut's segments, or null), duration,
//          edit: { id, look } (the shot being edited and its unsaved full layout) | null,
//          lookOf(i) (optional: a cached effective look), trs (optional: transitionsOf, cached) }
//   index: the shot under t (shotAt); look: the full layout to compose (inside a transition, the one more than half
//   way, for picking things on the canvas); tr: null, or { type, p (0 → 1, linear like ffmpeg's xfade), dur, index
//   (the incoming shot), id, from, to } with the two full layouts.
export function frameLooks(t, { list = [], base, cut = null, duration = Infinity, edit = null, lookOf = null, trs = null } = {}) {
  if (!list.length) return { index: 0, look: edit?.look || base, tr: null };
  const look = (i) => (edit && list[i]?.id === edit.id ? edit.look : lookOf ? lookOf(i) : effectiveLook(base, list[i]?.look || null));
  const index = shotAt(t, list).index;
  if (list.length > 1) {
    const tp = playedAt(t, cut);
    for (const tr of trs || transitionsOf(list, { cut, duration })) {
      if (tp < tr.start) break;
      if (tp >= tr.end) continue;
      const p = Math.min(1, Math.max(0, (tp - tr.start) / tr.dur)), from = look(tr.index - 1), to = look(tr.index);
      return { index, look: p < 0.5 ? from : to, tr: { type: tr.type, p, dur: tr.dur, index: tr.index, id: tr.id, from, to } };
    }
  }
  return { index, look: look(index), tr: null };
}

// "/" at the playhead on the Words lane: the break goes before the word at the caret: the word the playhead is in
// when it's in its first half, else the next one; between two words, the next one. Words the cut removes are
// skipped. → a word index, or null after the last word.
export function caretWord(t, words, cut = null) {
  const kept = (w) => !cut?.length || cut.some(([a, b]) => (w[0] + w[1]) / 2 >= a && (w[0] + w[1]) / 2 < b);
  for (let i = 0; i < (words || []).length; i++) {
    const w = words[i];
    if (!kept(w)) continue;
    if (t < (w[0] + w[1]) / 2) return i;
  }
  return null;
}

// The tiny picture of a shot's layout on the lane: { preset, cam, side } (cam false when its camera is hidden).
export function glyphOf(look) {
  const off = new Set(look?.hidden || []);
  return { preset: look?.preset || 'pip', cam: !off.has('cam'), screen: !off.has('screen'), side: look?.side === 'left' ? 'left' : 'right' };
}

// m:ss for the lane, the chip and the inspector ("0:42–1:05").
export const mmss = (t) => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
// What a transition is called: "Cut", "Crossfade 0.4 s".
export const trName = (tin) => (!tin ? 'Cut' : `${{ fade: 'Crossfade', slide: 'Slide', zoom: 'Zoom' }[tin.type] || 'Cut'} ${tin.dur} s`);
// The inspector's groups of properties: which keys each row edits (for its "changed in this shot" dot and ↺).
export function rowKeys(row, selected, preset) {
  if (row === 'layout') return ['preset', 'webcam', 'pad'];
  if (row === 'place') return ['side', 'mirror'];
  if (row === 'frame') return selected === 'cam' ? ['cam.zoom', 'cam.focus', 'cam.crop', 'cam.shape'] : selected === 'screen' ? ['screen.zoom', 'screen.focus', 'screen.crop'] : [];
  if (row === 'edge') {
    if (selected === 'cam' || (selected === 'screen' && preset === 'boxed')) return ['cam.border', 'cam.borderW', 'cam.shadow'];
    return selected === 'screen' ? ['screen.border', 'screen.borderW', 'screen.shadow'] : [];
  }
  return [];
}
