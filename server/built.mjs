// Built blocks: the videos a format's Build step renders (a tutorial's Intro; a whole Short or explainer), what they
// cover, how the Renders tab groups them, and how Export → Video puts them in.
//
// A Build step's render (core/pipelines.json done.files, e.g. renders/*intro*.mp4) is on the production sheet's
// timeline: its frame 0 is the sheet's 0:00, and the sheet runs on the cut the scenes and renders were made on
// (work/cut_scenes.json, else the locked cut). A step named after a block type (*intro*, *outro*…) covers that block of
// work/blocks.json, as far as the render reaches; any other (the Short, the explainer) covers the whole video.
//
// Export → Video (server/export-shots.mjs): a built block's render is the picture for the block's frames. The canvas
// pieces around it are trimmed, and a shot crossfade at its edge blends the canvas with the render. The sound stays the
// export's own: the voice in one piece over the whole cut (it can't double or gap at the join), and the sound cues of
// work/sfx.json. Cues inside a built block that weren't placed by hand in Video Octopus (Claude's, for its transitions) belong
// to its graphics: they're mixed only when its render is in, so a whoosh never plays over a plain picture. A render
// made on another cut than the export's, or an export of the whole take, leaves the render out: the canvas plays there.
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readJSON, mtime } from './util.mjs';
import { formatSteps, blockTypes, probeFile, projectMeta } from './studio.mjs';
import { snapSegments, FPS } from '../web/layout.js';

export const EXPORT_NAME = /_(screen|camera|pip|split|boxed)_v\d+\.mp4$/i; // the canvas's own exports (Export → Video)
const VIDEO = /\.(mp4|mov|m4v)$/i;
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const glob = (pat) => new RegExp(`^${pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

// The format's Build steps that render a video: [{ step, name, label, block (a block type) | null, res }].
export function buildSteps(type) {
  const types = Object.keys(blockTypes());
  return formatSteps(type).flatMap((s) => {
    const pats = (s.done?.files || []).filter((f) => /^renders\/[^/]+$/.test(f) && VIDEO.test(f.replaceAll('*', 'x')));
    if (!pats.length) return [];
    const word = pats.map((f) => /\*([a-z-]+)\*/i.exec(f)?.[1]?.toLowerCase()).find(Boolean) || null;
    const block = word && types.includes(word) ? word : null;
    return [{ step: s.id, name: s.name || s.label || s.id, label: block ? blockTypes()[block] : cap(word || s.label || s.id), block, res: pats.map((f) => glob(f.slice(8))) }];
  });
}

// A render's file name without the project's own name in front, so a project called "intro-test" doesn't make every
// render look like an intro.
const own = (id, f) => (id && f.toLowerCase().startsWith(`${id.toLowerCase()}_`) ? f.slice(id.length + 1) : f);

// What a render in renders/ is: { kind 'build' (a Build step's video) | 'export' (Export → Video) | 'other', group }.
export function renderKind(id, file, steps) {
  const f = basename(file);
  if (EXPORT_NAME.test(f)) return { kind: 'export', group: 'Video exports' };
  const s = steps.find((x) => x.res.some((re) => re.test(own(id, f))));
  if (s) return { kind: 'build', group: `${s.label} builds`, step: s.step, label: s.label };
  return { kind: 'other', group: 'Other videos' };
}

// Each Build step's newest finished render: [{ step, name, label, block, file, at, duration, frames, w, h }].
export function builtRenders(dir, id) {
  const steps = buildSteps(projectMeta(dir)?.type);
  if (!steps.length) return [];
  let files = [];
  try { files = readdirSync(join(dir, 'renders')).filter((f) => VIDEO.test(f) && !f.startsWith('.') && !/\.part\b/.test(f) && !EXPORT_NAME.test(f)); } catch {}
  return steps.flatMap((s) => {
    const mine = files.filter((f) => s.res.some((re) => re.test(own(id, f)))).map((f) => ({ f, at: mtime(join(dir, 'renders', f)) })).sort((a, b) => b.at - a.at);
    for (const { f, at } of mine) {
      const p = probeFile(join(dir, 'renders', f)); // a file still being written has no length yet: the one before counts
      if (p?.w && p.duration > 0.1) return [{ step: s.step, name: s.name, label: s.label, block: s.block, file: `renders/${f}`, at, duration: p.duration, frames: Math.round(p.duration * FPS), fps: p.fps, w: p.w, h: p.h }];
    }
    return [];
  });
}

// ---- the cut maths: take seconds ⇄ a cut's time ----
const toCut = (segs, x) => { let acc = 0; for (const [a, b] of segs) { if (x < a) return acc; if (x < b) return acc + x - a; acc += b - a; } return acc; };
const toTake = (segs, t) => { let acc = 0; for (const [a, b] of segs) { if (t < acc + b - a) return a + Math.max(0, t - acc); acc += b - a; } return segs.length ? segs[segs.length - 1][1] : t; };
const clip = (segs, a, b) => segs.map(([x, y]) => [Math.max(x, a), Math.min(y, b)]).filter(([x, y]) => y - x > 0.5 / FPS);
const sameCut = (A, B) => A.length === B.length && A.every(([a, b], i) => Math.round(a * FPS) === Math.round(B[i][0] * FPS) && Math.round(b * FPS) === Math.round(B[i][1] * FPS));
const clock = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`; };

// The cut the sheet and its renders are on, snapped to frames like the export's.
export function sheetCut(dir, duration) {
  const snap = readJSON(join(dir, 'work/cut_scenes.json'), null)?.segments;
  return Array.isArray(snap) && snap.length ? snapSegments(snap, duration) : null;
}

// What Export → Video can do with each built render (the Export panel's "What goes in" rows and the export itself):
// [{ id (the block id, or "video"), label, step, stepName, file, duration, take [a, b] (the take it covers), sheet [a, b]
//   (where that is on the render), partial, usable, why, cues }]. info: server/export.mjs exportInfo.
export function builtForExport(dir, id, info, { useCut = true, cues = [] } = {}) {
  const list = builtRenders(dir, id);
  if (!list.length || !info?.duration) return [];
  const blocks = (readJSON(join(dir, 'work/blocks.json'), null)?.blocks || []).filter((b) => Array.isArray(b?.source?.take));
  const cut = info.cut?.segments || null;
  const sheet = sheetCut(dir, info.duration) || cut;
  // A canvas look change waiting for Claude (server/cutsync.mjs): the render was built in the look before it.
  const look = (readJSON(join(dir, 'work/notes.json'), null)?.notes || []).find((n) => n?.kind === 'change' && n.field === 'look' && n.status === 'open');
  const oldLook = look ? (Array.isArray(look.edits) && look.edits.length ? look.edits.filter((e) => !/render/.test(e)).join('; ') : String(look.text || '')) : '';
  return list.map((r) => {
    const block = r.block ? blocks.find((b) => b.type === r.block) || blocks.find((b) => b.id === r.block) : null;
    // The block's stretch of the take (a render with no block of its own, or no blocks marked: the whole take).
    const [ta, tb] = block ? [Math.max(0, block.source.take[0]), Math.min(info.duration, block.source.take[1])] : [0, info.duration];
    const out = { id: block?.id || (r.block || 'video'), label: block?.label || r.label, step: r.step, stepName: r.name, file: r.file, duration: r.duration, fps: r.fps,
      blockTake: [ta, tb], take: null, sheet: null, partial: false, usable: false, why: '', cues: cues.filter((c) => graphicsCue(c, [ta, tb])).length,
      ...(oldLook ? { oldLook } : {}) };
    if (!useCut || !cut) return { ...out, why: 'It\'s made on the locked cut: export the locked cut to put it in.' };
    if (!sheet) return { ...out, why: 'There is no cut the scenes were made on yet.' };
    // The render must be on the export's cut over its stretch of the take, else the picture would slip off the voice.
    if (!sameCut(clip(cut, ta, tb), clip(sheet, ta, tb))) return { ...out, why: `The cut changed after ${r.name}: build it again to put it in.` };
    const s0 = toCut(sheet, ta), s1 = toCut(sheet, tb), end = Math.min(s1, r.duration);
    if (end - s0 < 0.5) return { ...out, why: `It doesn't reach the ${out.label} on the cut.` };
    const take = [Math.round(ta * FPS) / FPS, Math.round((end >= s1 - 2 / FPS ? tb : toTake(sheet, end)) * FPS) / FPS];
    const partial = end < s1 - 2 / FPS;
    return { ...out, take, sheet: [s0, end], partial, usable: true, cues: cues.filter((c) => graphicsCue(c, take)).length,
      why: partial ? `It covers ${clock(s0)}–${clock(end)} of the ${out.label}'s ${clock(s0)}–${clock(s1)}; the canvas plays the rest.` : '' };
  });
}

// A sound cue that belongs to a built block's graphics: inside its stretch of the take, and not placed by hand.
export const graphicsCue = (c, take) => Boolean(take) && c.by !== 'hand' && c.t >= take[0] - 1e-6 && c.t < take[1];

// The export's choice: the built renders that go in (usable, and not switched to the canvas: choice[id] === false), and
// the sound cues to leave out: a graphics cue of a block whose render doesn't go in, or beyond where its render reaches.
export function exportChoice(entries, choice = {}) {
  const use = entries.filter((e) => e.usable && choice?.[e.id] !== false);
  const skipCue = (c) => entries.some((e) => graphicsCue(c, e.blockTake) && !(use.includes(e) && graphicsCue(c, e.take)));
  return { use, skipCue };
}

// The frames of a take part (its kept take, snapped seconds, in order) that each render covers: [{ k0, k1, r0, entry }]
// in part frames, r0 = the render's frame at k0. sheet: the cut the render is on (snapped).
export function partSpans(entries, segs, sheet) {
  const S = sheet.map(([a, b]) => [Math.round(a * FPS), Math.round(b * FPS)]);
  const rf = (x) => { let acc = 0; for (const [a, b] of S) { if (x < a) return null; if (x < b) return acc + x - a; acc += b - a; } return null; };
  const out = [];
  for (const e of entries) {
    const TA = Math.round(e.take[0] * FPS), TB = Math.round(e.take[1] * FPS), RF = Math.round(e.duration * FPS);
    let k = 0;
    for (const [a, b] of segs) {
      const A = Math.round(a * FPS), B = Math.round(b * FPS), lo = Math.max(A, TA), hi = Math.min(B, TB);
      if (hi > lo) {
        const k0 = k + lo - A, r0 = rf(lo), last = out[out.length - 1];
        if (r0 != null) {
          if (last && last.entry === e && last.k1 === k0 && last.r0 + (last.k1 - last.k0) === r0) last.k1 = k0 + hi - lo;
          else out.push({ k0, k1: k0 + hi - lo, r0, entry: e });
        }
      }
      k += B - A;
    }
    // A render a frame or two short of its block holds its last frame; one that stops earlier leaves the rest to the canvas.
    for (const s of out) if (s.entry === e && s.r0 + (s.k1 - s.k0) > RF + 2) s.k1 = s.k0 + Math.max(0, RF - s.r0);
  }
  return out.filter((s) => s.k1 > s.k0).sort((a, b) => a.k0 - b.k0);
}

// Put the renders into a take part's pieces (web/exportshots.js planTakePart: look and fade pieces over part frames):
// a look piece is trimmed around a span, a crossfade inside one goes, a crossfade across its edge blends the canvas with
// the render (the render side keeps its first or last frame where the window reaches past it), and a render piece
// covers the rest. srcOf(k0, k1) gives the source frames of a stretch of the part.
export function spliceBuilt(pieces, spans, srcOf) {
  let list = pieces;
  for (const sp of spans) {
    const next = [];
    let r0 = sp.k0, r1 = sp.k1;
    const side = (k) => ({ render: { file: sp.entry.file, r0: sp.r0 + (k - sp.k0), frames: Math.round(sp.entry.duration * FPS), fps: sp.entry.fps || FPS, label: sp.entry.label } });
    for (const x of list) {
      if (x.k1 <= sp.k0 || x.k0 >= sp.k1 || x.kind === 'render') { next.push(x); continue; }
      if (x.kind === 'look' || x.kind === 'file') {
        if (x.k0 < sp.k0) next.push({ ...x, k1: sp.k0, src: srcOf(x.k0, sp.k0) });
        if (x.k1 > sp.k1) next.push({ ...x, k0: sp.k1, src: srcOf(sp.k1, x.k1) });
        continue;
      }
      // A crossfade.
      if (x.k0 < sp.k0 && x.k1 > sp.k1) { r1 = r0; next.push(x); continue; } // the render is shorter than the fade: the canvas
      if (x.k0 < sp.k0) { next.push({ ...x, to: side(x.k0) }); r0 = Math.max(r0, x.k1); continue; } // into the render
      if (x.k1 > sp.k1) { next.push({ ...x, from: side(x.k0) }); r1 = Math.min(r1, x.k0); continue; } // out of it
      // inside it: gone
    }
    if (r1 > r0) next.push({ kind: 'render', k0: r0, k1: r1, render: side(r0).render });
    list = next.sort((a, b) => a.k0 - b.k0);
  }
  return list;
}

// ---- Scenes: which scenes a render has built (the render starts at the sheet's 0:00 and reaches its length) ----
const PREVIEW = /_scene\d+_preview|_preview\b|_snip/i;
// How far the scene renders reach on the sheet's timeline (the longest one; previews of one scene don't count).
export function builtEnd(dir) {
  let files = [];
  try { files = readdirSync(join(dir, 'renders')).filter((f) => VIDEO.test(f) && !f.startsWith('.') && !/\.part\b/.test(f) && !EXPORT_NAME.test(f) && !PREVIEW.test(f)); } catch {}
  return files.reduce((m, f) => Math.max(m, probeFile(join(dir, 'renders', f))?.duration || 0), 0);
}
// A scene is built when a render reaches into it (more than a few frames).
export const isBuilt = (s, end) => end > s.start + 0.1;
