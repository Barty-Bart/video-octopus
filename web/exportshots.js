// The export, shot by shot: which looks the kept shots give the take, the key
// of a look's canvas PNG layers, and a take part of the export planned as pieces: runs of one look, and crossfades at
// the shot breaks. Pure, shared by the browser (it draws one set of PNG layers per key, web/app.js) and the server
// (server/export-shots.mjs renders the pieces; server/export-layers.mjs uses the runs).
//
// THE RULE the plan follows, so the MP4 is the preview: export frame k of a take part shows source frame n (the k-th frame
// the cut keeps) in the look at that frame's source time, lookAt(n / fps) (web/layout.js). A shot that starts at s takes
// over at the first frame with n / fps ≥ s: the frame the preview switches on. A crossfade covers the frames whose played
// time is inside transitionAt's window [start, end) and gives the incoming look the weight p = (played − start) / dur,
// with transitionsOf's lengths (centred on the break, shrunk to fit short shots). The voice isn't in here: it plays on
// untouched under the pictures (server/export-shots.mjs renders it per section part, in one piece).
//
// ZOOMS (zoomAt, web/layout.js): kept zooms change a card's crop frame by frame, not its box, so they need no PNGs of
// their own: zoomCrops below gives each export frame the crop the preview draws (zoomedCrop of that frame's look), and
// server/export-shots.mjs turns it into a time-based crop and scale. TRANSITIONS: xfade's fade, slideleft / slideright /
// slideup and zoomin (web/layout.js xfadeName; the preview draws the same frames, slideOffsets and zoominAt).
import { FPS, compose, effectiveLook, transitionsOf, playedAt, xfadeName, zoomAt, zoomedCrop } from './layout.js';
import { shotsWithoutProposals, zoomsWithoutProposals } from './shots.js';

// ffmpeg xfade transition for each kind of shot transition (a slide by its direction: xfadeName).
export const XFADE = { fade: 'fade', slide: 'slideleft', zoom: 'zoomin' };

const listOf = (shots) => (Array.isArray(shots) ? shots : Array.isArray(shots?.shots) ? shots.shots : []);
// The shots the export renders: proposals left out (a proposed change is back to what it was, a proposed new shot gone).
export const keptShots = (doc) => listOf(shotsWithoutProposals(doc || { shots: [] })).slice().sort((a, b) => a.start - b.start);
// The zooms the export renders: the kept ones (a proposed change back to what it was, a proposed new zoom gone).
export const keptZooms = (doc) => zoomsWithoutProposals(doc || { items: [] }).items;

// What a scene's PNG layers depend on: the frame size and each card's box, corners, border and shadow, bottom to top.
// Two looks with the same key share one set of PNGs (a shot that only reframes or zooms the screen needs no new ones).
export const sceneKey = (scene) => JSON.stringify([scene.W, scene.H, scene.layers.map((ly) =>
  [ly.box.x, ly.box.y, ly.box.w, ly.box.h, ly.radius || 0, ly.border || 0, ly.border ? ly.borderColor || null : null, Boolean(ly.shadow)])]);

// The looks an export of this take can show: the base, then each kept shot's effective look, each once. The browser
// draws a PNG set per sceneKey of these (web/app.js exportLayers / layerPngs).
export function exportLooks(base, shotsDoc) {
  const out = [], seen = new Set();
  for (const l of [base, ...keptShots(shotsDoc).map((s) => effectiveLook(base, s.look || null))]) {
    const k = JSON.stringify(l);
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  return out;
}

// The first frame at or after a time (frames are at n / fps; a hair of tolerance for float error).
const frameAt = (t, fps) => Math.ceil(t * fps - 1e-4);

// planTakePart({ segs, shots, base, cut, duration, fps }) → { frames, runs, pieces, changes }
//   segs     the part's kept pieces of the take in playing order, source seconds snapped to frames (server: snapSegments)
//   shots    the kept shots (keptShots)               base  the video's look (normalized layout)
//   cut      the cut the played time is measured on (the export's: the locked cut, or null for the whole take)
//   duration the take's length (source seconds), for transitionsOf's last shot
// runs     [{ k0, k1, src, shots: [index…], look, key }]: stretches of one look, part frames [k0, k1); src = the source
//          frame ranges [[a, b), …] they show. Neighbouring shots with the same look are one run.
// pieces   what to render, in order, covering [0, frames): { kind 'look', k0, k1, src, run } or
//          { kind 'fade', k0, k1, src, from, to (runs), type, xfade, start, dur, at } where start/at are part seconds
//          (the window's start and the break, on the part's own clock) and dur the crossfade's length.
// changes  true when some run doesn't look like the base (the export then goes shot by shot).
export function planTakePart({ segs, shots, base, cut = null, duration = Infinity, fps = FPS }) {
  const list = listOf(shots);
  const ranges = (segs || []).map(([a, b]) => [Math.round(a * fps), Math.round(b * fps)]).filter(([a, b]) => b > a);
  const frames = ranges.reduce((t, [a, b]) => t + b - a, 0);
  if (!frames) return { frames: 0, runs: [], pieces: [], changes: false };
  // Shot i takes over at frame starts[i]; a frame belongs to the last shot that started at or before it.
  const starts = list.map((s, i) => (i ? frameAt(s.start, fps) : -Infinity));
  const shotOf = (n) => { let i = 0; while (i + 1 < list.length && starts[i + 1] <= n) i++; return i; };
  const looks = list.map((s) => effectiveLook(base, s.look || null));
  const keys = looks.map((l) => JSON.stringify(l));
  const baseKey = JSON.stringify(base);
  // Shot runs on the part's frames: split each kept range at the shot starts inside it.
  const sruns = [];
  let k = 0;
  for (const [a, b] of ranges) {
    let x = a;
    while (x < b) {
      const i = list.length ? shotOf(x) : -1;
      const next = i >= 0 && i + 1 < list.length ? Math.min(b, Math.max(x + 1, starts[i + 1])) : b;
      const last = sruns[sruns.length - 1];
      if (last && last.shot === i) { last.k1 += next - x; const lr = last.src[last.src.length - 1]; if (lr[1] === x) lr[1] = next; else last.src.push([x, next]); }
      else sruns.push({ shot: i, k0: k, k1: k + next - x, src: [[x, next]] });
      k += next - x;
      x = next;
    }
  }
  // Runs: neighbouring shot runs with the same look are one (a transition between two equal pictures changes nothing).
  const runs = [];
  for (const s of sruns) {
    const look = s.shot >= 0 ? looks[s.shot] : base, key = s.shot >= 0 ? keys[s.shot] : baseKey;
    const last = runs[runs.length - 1];
    if (last && last.key === key) { last.k1 = s.k1; last.shots.push(s.shot); for (const r of s.src) { const lr = last.src[last.src.length - 1]; if (lr[1] === r[0]) lr[1] = r[1]; else last.src.push([...r]); } }
    else runs.push({ k0: s.k0, k1: s.k1, src: s.src.map((r) => [...r]), shots: [s.shot], look, key });
  }
  // Crossfades at the breaks between runs, where the take plays straight on from one shot into the next.
  const P0 = playedAt(ranges[0][0] / fps, cut); // played time of the part's first frame
  const trs = transitionsOf(list, { cut, duration });
  const fades = [];
  for (let r = 0; r + 1 < runs.length; r++) {
    const A = runs[r], B = runs[r + 1], i = B.shots[0];
    if (A.shots[A.shots.length - 1] !== i - 1) continue; // a shot in between plays no frames here: a cut
    const tr = trs.find((x) => x.index === i);
    if (!tr) continue;
    const prevEnd = fades.length ? fades[fades.length - 1].k1 : 0;
    const k0 = Math.max(A.k0, prevEnd, frameAt(tr.start - P0, fps)), k1 = Math.min(B.k1, frameAt(tr.end - P0, fps));
    if (!(k1 > k0) || k0 > A.k1 || k1 < B.k0) continue;
    fades.push({ kind: 'fade', k0, k1, from: A, to: B, type: tr.type, xfade: xfadeName(tr.type, tr.dir), dir: tr.dir, start: tr.start - P0, dur: tr.dur, at: tr.at - P0 });
  }
  // Pieces: each run's plain stretch, then the crossfade out of it (the fades don't overlap: see prevEnd above).
  const pieces = [];
  let at = 0;
  for (const run of runs) {
    const fout = fades.find((f) => f.from === run);
    const b = fout ? fout.k0 : run.k1;
    if (b > at) { pieces.push({ kind: 'look', k0: at, k1: b, run }); at = b; }
    if (fout) { pieces.push(fout); at = fout.k1; }
  }
  // Source frames of a stretch of the part [k0, k1).
  const srcOf = (k0, k1) => {
    const out = [];
    let acc = 0;
    for (const [a, b] of ranges) {
      const n = b - a, lo = Math.max(k0, acc), hi = Math.min(k1, acc + n);
      if (hi > lo) out.push([a + lo - acc, a + hi - acc]);
      acc += n;
    }
    return out;
  };
  for (const p of pieces) p.src = srcOf(p.k0, p.k1);
  return { frames, runs, pieces, changes: runs.some((r) => r.key !== baseKey) };
}

// The scenes and PNG keys of a plan's runs (compose() with the take's picture sizes), for the server.
export function withScenes(plan, dims) {
  for (const r of plan.runs) { r.scene = compose(r.look, dims); r.sceneKey = sceneKey(r.scene); }
  return plan;
}

// For the Export panel: how the kept shots and zooms change this export, { shots, looks, fades, kinds, zooms } over the
// cut (or the whole take), or null when every stretch looks like the video (the export runs as it always did).
// kinds: { fade, slide, zoom } transitions by kind; zooms: kept zooms.
export function shotsSummary({ base, shots, segs, cut = null, duration = Infinity, zooms = null }) {
  const list = keptShots(shots), zs = keptZooms(zooms);
  if (list.length < 1 || !segs?.length) return null;
  const plan = planTakePart({ segs, shots: list, base, cut, duration });
  if (!plan.changes && !zs.length) return null;
  const fades = plan.pieces.filter((p) => p.kind === 'fade'), kinds = {};
  for (const f of fades) kinds[f.type] = (kinds[f.type] || 0) + 1;
  return { shots: list.length, looks: new Set(plan.runs.map((r) => r.key)).size, fades: fades.length, kinds, zooms: zs.length, changes: plan.changes };
}

// zoomCrops({ look, scene, dims, src, zooms, shots, cut, fps }) → [{ i, crops }] for each camera or screen card of a
// look that a kept zoom moves during these frames: crops[j] = the crop (fractions of the whole source picture, like
// ly.crop) for the j-th frame of src (source frame ranges [[a, b), …] in playing order), zoomedCrop of zoomAt at that
// frame's source time, exactly what the preview draws there. Cards no zoom touches aren't listed (their crop is ly.crop).
export function zoomCrops({ look, scene, dims, src, zooms, shots = null, cut = null, fps = FPS }) {
  const list = Array.isArray(zooms) ? zooms : zooms?.items || [];
  if (!list.length || !src?.length) return [];
  const out = [];
  scene.layers.forEach((ly, i) => {
    if (ly.role !== 'cam' && ly.role !== 'screen') return;
    const target = ly.role === 'cam' ? 'camera' : 'screen';
    if (!list.some((z) => (z.target || 'camera') === target)) return;
    const crops = [];
    let moved = false;
    for (const [a, b] of src) for (let n = a; n < b; n++) {
      const z = zoomAt(n / fps, target, list, { shots, cut });
      const c = z ? zoomedCrop(look, ly, z, dims) : ly.crop;
      if (z) moved = true;
      crops.push(c);
    }
    if (moved) out.push({ i, target, crops });
  });
  return out;
}
