// The MP4 export shot by shot: every stretch of the take renders in the look
// of its shot (preset, camera and screen crop, zoom and focus, borders, a hidden camera or screen with the layout's
// fallback, the PiP box), and the shots join with a cut, a crossfade, a slide or a zoom (ffmpeg xfade: fade, slideleft /
// slideright / slideup, zoomin) at the length the shot says. Kept zooms (work/zooms.json) move a card's crop frame by
// frame: a time-based crop and scale (sendcmd sets each frame's scale and crop, from web/exportshots.js zoomCrops, the
// crops the preview draws). Proposed shots and zooms are left out. The plan (which frames, which look, where the crossfades go) is web/exportshots.js, the
// same rule the preview follows (web/layout.js lookAt / transitionAt).
//
// How it renders: each section part of the export (server/blocks.mjs sequenceForExport; the whole cut or take when there
// are no blocks) is one sound file and a row of picture pieces, all rendered in parallel:
//   - a run of one look: its frames only (the sources are seeked to it, so a 10-minute take with 20 shots decodes each
//     stretch once), composed with that look's canvas PNG layers like server/export.mjs does;
//   - a crossfade: the frames of its window composed in both looks and blended by xfade=transition=fade, with the weight
//     the preview gives each frame (p = (played − start) / dur; a microsecond timebase and a lead frame give xfade the
//     window's exact start, which is rarely on a frame);
//   - a file block (B-roll, a sponsor read file): its own picture in its own layout, as before.
// The sound never crossfades: each part's voice (with layer sound and sound cues) renders in one piece, so it can't
// double or dip at a break. Pictures and sounds are then joined with the concat demuxer (H.264 copied, the sound to AAC).
// The job folder (work/export/<stamp>/) keeps the PNGs, job.json (the plan) and run.sh, like every export.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cpus } from 'node:os';
import { studioTool, writeJSON, settings, h264, inside } from './util.mjs';
import { backgroundPlan, logTrialUse } from './backgrounds.mjs';
import { appendWorklog, probeFile } from './studio.mjs';
import { readShots, readZooms } from './shots.mjs';
import { mixCues } from './sound.mjs';
import { burnCaptions } from './export-words.mjs';
import { compose, snapSegments, FPS } from '../web/layout.js';
import { blockLayout } from '../web/blockseq.js';
import { keptShots, keptZooms, planTakePart, withScenes, sceneKey, zoomCrops } from '../web/exportshots.js';
import { partSpans, spliceBuilt, sheetCut } from './built.mjs';

const HEAD = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const half = 0.5 / FPS;
// Pieces rendered at once: each ffmpeg's filters run mostly on one core, so a few side by side use the machine.
const PARALLEL = Math.max(2, Math.min(6, Math.floor(cpus().length / 3)));

// ---- the plan ----
// shotsPlan(dir, { layout, info, useCut, seq }) → { shots, cut, parts: [{ part, plan }], changes, looks, fades }
// layout: the video's look (normalized); info: server/export.mjs exportInfo; seq: sequenceForExport (null: no blocks).
// changes: some stretch of the take doesn't look like the video's look, or a kept zoom moves a card, so the export has to
// go shot by shot. zooms: the kept zooms.
export function shotsPlan(dir, { layout, info, useCut = true, seq = null }) {
  let shots = [], zooms = [];
  try { shots = keptShots(readShots(dir)); } catch (e) { console.error('shots:', e.message); }
  try { zooms = keptZooms(readZooms(dir)); } catch (e) { console.error('zooms:', e.message); }
  const cut = useCut && info.cut ? info.cut.segments : null;
  const list = seq ? seq.parts : [{ kind: 'take', segs: cut || [[0, Math.floor(info.duration * FPS) / FPS]], blocks: null, plain: true }];
  const parts = list.map((p) => (p.kind !== 'take' || !shots.length ? { part: p, plan: null }
    : { part: p, plan: withScenes(planTakePart({ segs: snapSegments(p.segs, info.duration), shots, base: layout, cut, duration: info.duration }), info.dims) }));
  const runs = parts.flatMap((x) => x.plan?.runs || []);
  const zoomed = zooms.length > 0 && parts.some((x) => x.plan);
  return { shots, zooms, cut, parts, changes: parts.some((x) => x.plan?.changes) || zoomed,
    looks: new Set(runs.map((r) => r.key)).size, fades: parts.reduce((t, x) => t + (x.plan?.pieces.filter((p) => p.kind === 'fade').length || 0), 0) };
}

// A one-line summary for the worklog: "4 shots · 3 looks · 2 transitions · 2 zooms", or null when the shots change nothing.
export function shotsLine(sp) {
  if (!sp?.changes) return null;
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  return [n(sp.shots.length, 'shot'), n(sp.looks, 'look'), sp.fades ? n(sp.fades, 'transition') : null, sp.zooms?.length ? n(sp.zooms.length, 'zoom') : null].filter(Boolean).join(' · ');
}

// ---- where the sources start (input seeking keeps the same frames as decoding from the start) ----
// With -ss X, ffmpeg gives a file's packets pts − (format start + X); the plain export's setpts=PTS−STARTPTS counts from
// the first video frame. So a seeked input gets setpts=round(PTS+(X + format start − video start)/TB): the same clock
// (rounded to a whole tick: in a file whose timebase is one frame, 1/30, a truncated 0.99999 tick is a frame early).
const starts = new Map();
export function startShift(dir, file) {
  const p = join(dir, file);
  if (!starts.has(p)) {
    let v = 0;
    try {
      const o = JSON.parse(String(execFileSync(studioTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time:format=start_time', '-of', 'json', p], { timeout: 8000 })));
      v = (Number(o.format?.start_time) || 0) - (Number(o.streams?.[0]?.start_time) || 0);
    } catch {}
    starts.set(p, v);
  }
  return starts.get(p);
}

// ---- the export ----
// ctx from server/export.mjs: { jobs, pngFrom, nextName, quote, seq, layout, info, sp, built }.
// built: the built blocks whose render goes in (server/built.mjs): their frames play the render instead of the canvas.
export function exportShots(id, dir, body, emit, { jobs, pngFrom, nextName, quote, seq, layout, info, sp, built = [] }) {
  const now = new Date(), two = (v) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const jobRel = `work/export/${stamp}`;
  mkdirSync(join(dir, jobRel), { recursive: true });
  mkdirSync(join(dir, 'renders'), { recursive: true });
  const labels = Object.fromEntries((seq?.doc.blocks || []).map((b) => [b.id, b.label]));
  const shotName = (i) => { const s = sp.shots[i]; return s ? `Shot ${i + 1}${s.name ? ` (${s.name})` : ''}` : 'Shot 1'; };
  const takeSrc = { screen: info.sources.screen && `source/${info.sources.screen}`, cam: info.sources.cam && `source/${info.sources.cam}`, audio: info.sources.audio && `source/${info.sources.audio}` };
  const takeSounds = () => {
    const s = [];
    if (info.audio) s.push(takeSrc[info.audio]);
    for (const x of layout.layers) if (x.audio && info.layerAudio[x.file] && !s.includes(`source/${x.file}`)) s.push(`source/${x.file}`);
    return s;
  };

  // The canvas PNG layers: one set per look (by sceneKey, web/exportshots.js), and a file block's own set.
  const baseKey = sceneKey(compose(layout, info.dims));
  const sets = new Map(); // write key → { prefix, mids: [i…] }
  const writeSet = (key, prefix, scene, pngs, what) => {
    if (sets.has(key)) return sets.get(key);
    if (!pngs) throw new Error(`The canvas didn't send the picture layers for ${what}. Reload the page and try again.`);
    const { W, H } = scene, files = { base: pngFrom(pngs.base, W, H, `${what} background`) };
    scene.layers.forEach((ly, i) => {
      files[`mask${i}`] = pngFrom(pngs[`mask${i}`], ly.box.w, ly.box.h, `${what} ${ly.role} mask`);
      if (pngs[`mid${i}`]) files[`mid${i}`] = pngFrom(pngs[`mid${i}`], W, H, `${what} ${ly.role} frame`);
    });
    for (const [k, buf] of Object.entries(files)) writeFileSync(join(dir, jobRel, `${prefix}_${k}.png`), buf);
    const set = { prefix, mids: Object.keys(files).filter((x) => x.startsWith('mid')).map((x) => Number(x.slice(3))) };
    sets.set(key, set);
    return set;
  };
  let lookN = 0;
  const lookSet = (run, what) => {
    const key = `look:${run.sceneKey}`;
    if (sets.has(key)) return sets.get(key);
    return writeSet(key, `L${lookN++}`, run.scene, body.pngs?.looks?.[run.sceneKey] || (run.sceneKey === baseKey ? body.pngs : null), what);
  };

  // Parts → picture pieces and one sound each.
  const parts = [], pieces = [];
  const sheet = built.length ? sheetCut(dir, info.duration) || sp.cut : null; // the cut the built renders are on
  const W0 = compose(layout, info.dims).W, H0 = compose(layout, info.dims).H;
  const renderComp = (r) => ({ render: r, scene: { W: W0, H: H0, layers: [], preset: null }, shots: [] });
  let at = 0; // frames
  sp.parts.forEach(({ part: p, plan }, k) => {
    const tag = `p${two(k)}`;
    if (p.kind === 'take') {
      const segs = snapSegments(p.segs, info.duration);
      const frames = plan ? plan.frames : Math.round(segs.reduce((t, [a, b]) => t + b - a, 0) * FPS);
      const sounds = takeSounds();
      const name = p.blocks?.length ? p.blocks.map((b) => labels[b]).filter((v, i, a) => a.indexOf(v) === i).join(' + ') : segs.length && sp.cut ? 'Take (locked cut)' : 'Whole take';
      if (!frames) return;
      let runsOf = plan ? plan.pieces : [{ kind: 'look', k0: 0, k1: frames, src: segs.map(([a, b]) => [Math.round(a * FPS), Math.round(b * FPS)]), run: { look: layout, scene: compose(layout, info.dims), sceneKey: baseKey, shots: [0] } }];
      // A built block's frames play its render (the canvas pieces around it are trimmed; server/built.mjs).
      const spans = built.length && sheet ? partSpans(built, segs, sheet) : [];
      if (spans.length) {
        const ranges = segs.map(([a, b]) => [Math.round(a * FPS), Math.round(b * FPS)]);
        const srcOf = (k0, k1) => { const out = []; let acc = 0; for (const [a, b] of ranges) { const lo = Math.max(k0, acc), hi = Math.min(k1, acc + b - a); if (hi > lo) out.push([a + lo - acc, a + hi - acc]); acc += b - a; } return out; };
        runsOf = spliceBuilt(runsOf, spans, srcOf);
      }
      // (a sound-only take with nothing on screen in any shot and no sound: nothing to export, as before)
      if (!sounds.length && runsOf.every((x) => x.kind !== 'render' && (x.kind === 'look' ? [x.run] : [x.from, x.to]).every((r) => r.render || !r.scene.layers.length))) return;
      const part = { tag, kind: 'take', name, segs, frames, start: at, sounds, blocks: p.blocks || null, range: rangeOf(seq, p), audio: `${jobRel}/${tag}_sound.wav` };
      parts.push(part);
      for (const x of runsOf) {
        const comps = x.kind === 'render' ? [renderComp(x.render)] : (x.kind === 'look' ? [x.run] : [x.from, x.to]).map((r) => (r.render ? renderComp(r.render)
          : { scene: r.scene, set: lookSet(r, `${name}, ${shotName(r.shots[0])}`), src: takeSrc, dims: info.dims, look: r.look, shots: r.shots }));
        pieces.push({ kind: x.kind, part, comps, src: x.kind === 'render' ? null : x.src, frames: x.k1 - x.k0, start: at + x.k0, seek: true,
          ...(x.kind === 'fade' ? { fade: { xfade: x.xfade, type: x.type, dur: x.dur, start: x.start - x.k0 / FPS } } : {}) });
      }
      at += frames;
    } else {
      const fi = p.info;
      const look = blockLayout(layout, p.block), scene = compose(look, fi.dims);
      const frames = Math.floor(fi.duration * FPS);
      const src = { screen: fi.files.screen && `source/${fi.files.screen}`, cam: fi.files.cam && `source/${fi.files.cam}`, audio: fi.files.audio && `source/${fi.files.audio}` };
      const sounds = fi.audio ? [src.cam || src.screen || src.audio] : [];
      if ((!scene.layers.length && !sounds.length) || !frames) return;
      const name = `${p.block.label} (own file)`;
      const part = { tag, kind: 'file', name, segs: null, frames, start: at, sounds, blocks: [p.block.id], range: null, audio: `${jobRel}/${tag}_sound.wav` };
      parts.push(part);
      const set = writeSet(`file:${p.block.id}`, `${tag}F`, scene, (body.blockPngs || body.pngs?.blocks)?.[p.block.id], `"${name}"`);
      pieces.push({ kind: 'file', part, comps: [{ scene, set, src, dims: fi.dims, look, shots: [] }], src: null, frames, start: at, seek: false });
      at += frames;
    }
  });
  if (!parts.length) throw new Error('Nothing to export yet: add a recording first.');
  pieces.forEach((x, i) => { x.tag = `v${String(i).padStart(3, '0')}`; x.out = `${jobRel}/${x.tag}.mov`; });
  const total = at / FPS;

  // An animated background is planned once for the whole video; each piece takes its own stretch of it.
  const main = compose(layout, info.dims);
  const bgPlan = backgroundPlan(id, dir, layout, { W: main.W, H: main.H, total, jobRel });
  let bgLoop = null;
  if (bgPlan && !bgPlan.prepare) { const p = probeFile(inside(dir, bgPlan.bg.file)); bgLoop = p?.duration > 0.1 ? p.duration : null; }
  const bgInput = (start, len) => {
    // A drawn one (bg.mkv has millisecond timestamps): exact 1/30 s frames, as the layers export does, so no piece is a
    // frame short (half a frame early, so the seek keeps the frame it lands on).
    if (bgPlan.prepare) return { args: [...(start > 0 ? ['-ss', Math.max(0, start - half).toFixed(5)] : []), '-i', bgPlan.file], filter: `setpts=PTS-STARTPTS,fps=${FPS},format=rgb24` };
    // A looped video: start at its phase (later loops start from its beginning again), else the stretch of the loop.
    if (bgLoop) return { args: ['-stream_loop', '-1', '-ss', (start % bgLoop).toFixed(5), '-t', (len + 1).toFixed(3), '-i', bgPlan.bg.file], filter: `${bgPlan.filter},setpts=PTS-STARTPTS` };
    return { args: ['-stream_loop', '-1', '-t', (start + len + 1).toFixed(3), '-i', bgPlan.bg.file], filter: `${bgPlan.filter},trim=start=${start.toFixed(5)},setpts=PTS-STARTPTS` };
  };

  // ---- one picture piece ----
  const pieceArgs = (x) => {
    const args = [...HEAD];
    let n = 0;
    const input = (list) => { args.push(...list); return n++; };
    const len = x.frames / FPS, f = [];
    const fileOf = (c, ly) => (ly.role === 'layer' ? `source/${ly.file}` : c.src[ly.role]);
    const dimsOf = (c, ly) => (ly.role === 'layer' ? c.dims.files[ly.file] : c.dims[ly.role]);
    // The source videos, decoded once each (seeked to the piece) and split for every card that shows them.
    const uses = new Map();
    x.comps.forEach((c, ci) => c.scene.layers.forEach((ly, i) => { const file = fileOf(c, ly); if (!uses.has(file)) uses.set(file, []); uses.get(file).push(`u${ci}_${i}`); }));
    const sel = x.src ? x.src.map(([a, b]) => `gte(t,${(a / FPS - half).toFixed(5)})*lt(t,${(b / FPS - half).toFixed(5)})`).join('+') : null;
    for (const [file, labels] of uses) {
      let chain;
      if (x.seek && x.src) {
        const a = x.src[0][0] / FPS, b = x.src[x.src.length - 1][1] / FPS;
        const X = Math.max(0, Math.floor((a - 1) * 1000) / 1000);
        const k = input([...(X > 0 ? ['-ss', X.toFixed(3)] : []), '-t', (b - X + 1).toFixed(3), '-hwaccel', 'videotoolbox', '-i', file]);
        chain = `[${k}:v]${X > 0 ? `setpts=round(PTS+${(X + startShift(dir, file)).toFixed(6)}/TB)` : 'setpts=PTS-STARTPTS'},fps=${FPS},select='${sel}',setpts=N/${FPS}/TB`;
      } else {
        const k = input(['-hwaccel', 'videotoolbox', '-i', file]);
        chain = `[${k}:v]setpts=PTS-STARTPTS,fps=${FPS}`;
      }
      f.push(labels.length > 1 ? `${chain},split=${labels.length}${labels.map((l) => `[${l}]`).join('')}` : `${chain}[${labels[0]}]`);
    }
    const still = (name) => input(['-loop', '1', '-framerate', String(FPS), '-t', len.toFixed(3), '-i', `${jobRel}/${name}.png`]);
    let bgLabels = [];
    const canvasComps = x.comps.map((c, ci) => (c.render ? null : ci)).filter((ci) => ci != null);
    if (bgPlan && canvasComps.length) {
      const b = bgInput(x.start / FPS, len), k = input(b.args);
      bgLabels = x.comps.map((c, ci) => (c.render ? null : `[bg${ci}]`));
      const ls = bgLabels.filter(Boolean);
      f.push(`[${k}:v]${b.filter}${ls.length > 1 ? `,split=${ls.length}` : ''}${ls.join('')}`);
    }
    // Each look: the background, then every card (cut, cropped, scaled, mirrored, in its mask), its border and the next
    // card's shadow (the mid PNGs) between them. A card a kept zoom moves gets its crop frame by frame (zoomChain).
    const out = x.comps.map((c, ci) => {
      // A built block's render (server/built.mjs): its frames from r0 for the piece's length, a first or last frame held
      // where the piece reaches past it (a crossfade at its edge), scaled into the frame. HD with no colour tags is taken
      // as BT.709, the way the browser showed it in Scenes.
      if (c.render) {
        const r = c.render;
        let a = Math.max(0, Math.min(r.frames, r.r0)), b = Math.max(a, Math.min(r.frames, r.r0 + x.frames));
        if (b <= a) [a, b] = r.r0 >= r.frames ? [r.frames - 1, r.frames] : [0, 1]; // all past its end (or before its start): one frame, held
        const lead = Math.max(0, Math.min(x.frames, a - r.r0)), tail = Math.max(0, x.frames - lead - (b - a));
        const k = input(['-i', r.file]);
        // Frame by frame: a render at the export's rate is taken by its frame numbers (a joined render's timestamps can
        // wobble, and a timestamp-led pick would drop one frame and repeat the next); another rate is converted by time.
        // (fps again after the last setpts: frames with no duration would be dropped by the encoder's frame-rate logic.)
        const same = !r.fps || Math.abs(r.fps - FPS) < 0.01;
        const W = c.scene.W, H = c.scene.H;
        // (Whole ticks of 1/30 s: N/30/TB lands a hair early for some N, and fps would then take the next frame there.)
        f.push(`[${k}:v]${same ? `settb=1/${FPS},setpts=N` : 'setpts=PTS-STARTPTS'},fps=${FPS},trim=start_frame=${a}:end_frame=${b},setpts=N,fps=${FPS},` +
          `tpad=start=${lead}:start_mode=clone:stop=${tail + 2}:stop_mode=clone,scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos:in_color_matrix=bt709:in_range=tv,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24[rc${ci}]`);
        return `[rc${ci}]`;
      }
      const baseIn = still(`${c.set.prefix}_base`);
      const maskIn = c.scene.layers.map((_, i) => still(`${c.set.prefix}_mask${i}`));
      const midIn = c.scene.layers.map((_, i) => (c.set.mids.includes(i) ? still(`${c.set.prefix}_mid${i}`) : null));
      const zc = x.src && c.look && sp.zooms?.length ? zoomCrops({ look: c.look, scene: c.scene, dims: c.dims, src: x.src, zooms: sp.zooms, shots: sp.shots, cut: sp.cut }) : [];
      c.scene.layers.forEach((ly, i) => {
        const p = dimsOf(c, ly);
        const z = zc.find((v) => v.i === i);
        if (z) { f.push(`[u${ci}_${i}]${zoomChain(x, ci, i, ly, p, z.crops)}[v${ci}_${i}]`); }
        else {
          const cw = Math.round(ly.crop.w * p[0]), ch = Math.round(ly.crop.h * p[1]);
          // Even offsets: hardware-decoded frames are NV12, and an odd chroma offset would swap U and V (blue skin).
          const cx = 2 * Math.round((ly.crop.x * p[0]) / 2), cy = 2 * Math.round((ly.crop.y * p[1]) / 2);
          f.push(`[u${ci}_${i}]crop=${cw}:${ch}:${cx}:${cy},scale=${ly.box.w}:${ly.box.h}:flags=lanczos${ly.mirror ? ',hflip' : ''},format=rgba[v${ci}_${i}]`);
        }
        f.push(`[${maskIn[i]}:v]format=gray[k${ci}_${i}]`, `[v${ci}_${i}][k${ci}_${i}]alphamerge=shortest=1[a${ci}_${i}]`);
      });
      let cur = `[${baseIn}:v]`;
      if (bgPlan) { f.push(`${bgLabels[ci]}[${baseIn}:v]overlay=0:0:format=rgb:shortest=1[bgb${ci}]`); cur = `[bgb${ci}]`; }
      c.scene.layers.forEach((ly, i) => {
        f.push(`${cur}[a${ci}_${i}]overlay=${ly.box.x}:${ly.box.y}:format=rgb${i === 0 ? ':shortest=1' : ''}[o${ci}_${i}]`);
        cur = `[o${ci}_${i}]`;
        if (midIn[i] != null) { f.push(`${cur}[${midIn[i]}:v]overlay=0:0:format=rgb[m${ci}_${i}]`); cur = `[m${ci}_${i}]`; }
      });
      return cur;
    });
    // Two clone frames at the end (cut off again by -frames:v): a piece never comes out short, so the pictures stay on
    // the sound's clock after every join even if a source ends a frame early.
    let cur = out[0];
    if (!x.fade) { f.push(`${cur}tpad=stop=2:stop_mode=clone[pad]`); cur = '[pad]'; }
    if (x.fade) {
      // The crossfade: xfade blends frame j of the outgoing look with frame j of the incoming one, weight
      // (pts − offset) / duration on the incoming. A lead frame in front of the outgoing look (trimmed again after) and a
      // microsecond timebase let offset sit exactly where the window starts, between frames; two clone frames at the
      // ends let xfade finish. So frame k of the piece gets p = (its played time − start) / dur, as in the preview.
      const off = Math.max(0, x.fade.start + 1 / FPS);
      f.push(`${out[0]}tpad=start=1:start_mode=clone:stop=2:stop_mode=clone,setpts=N/${FPS}/TB,fps=${FPS},settb=AVTB[xa]`,
        `${out[1]}tpad=stop=2:stop_mode=clone,setpts=N/${FPS}/TB,fps=${FPS},settb=AVTB[xb]`,
        `[xa][xb]xfade=transition=${x.fade.xfade}:duration=${x.fade.dur.toFixed(6)}:offset=${off.toFixed(6)},trim=start_frame=1,setpts=N/${FPS}/TB,fps=${FPS}[xf]`);
      cur = '[xf]';
    }
    const W = x.comps[0].scene.W, H = x.comps[0].scene.H;
    cur = burnCaptions(dir, { f, cur, jobRel, W, H, captions: body.captions, parts: captionParts, doc: seq ? seq.doc : undefined, from: x.start / FPS, to: (x.start + x.frames) / FPS, tag: x.tag });
    f.push(`${cur}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]`);
    args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-an', ...h264('16M'), '-profile:v', 'high', ...COLOR,
      '-frames:v', String(x.frames), '-f', 'mov', x.out);
    return args;
  };
  // A zoomed card: one crop to the area all its frames show (even pixels: NV12), then per frame (sendcmd, a command file
  // in the job folder) a scale that makes that frame's crop the size of the card, and a card-sized crop at its place:
  // crop(t) = zoomedCrop(look, card, zoomAt(t)), the same crop the preview draws, to the nearest pixel of the scaled area.
  const zoomCmds = [];
  function zoomChain(x, ci, i, ly, [SW, SH], crops) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of [ly.crop, ...crops]) { x0 = Math.min(x0, c.x * SW); y0 = Math.min(y0, c.y * SH); x1 = Math.max(x1, (c.x + c.w) * SW); y1 = Math.max(y1, (c.y + c.h) * SH); }
    const ux = Math.max(0, 2 * Math.floor(x0 / 2)), uy = Math.max(0, 2 * Math.floor(y0 / 2));
    const uw = Math.min(SW - ux, 2 * Math.ceil((x1 - ux) / 2)), uh = Math.min(SH - uy, 2 * Math.ceil((y1 - uy) / 2));
    const BW = ly.box.w, BH = ly.box.h;
    const at = (c) => {
      const w = Math.max(BW, Math.round((uw * BW) / Math.max(1e-6, c.w * SW))), h = Math.max(BH, Math.round((uh * BH) / Math.max(1e-6, c.h * SH)));
      return [w, h, Math.min(w - BW, Math.max(0, Math.round(((c.x * SW - ux) * w) / uw))), Math.min(h - BH, Math.max(0, Math.round(((c.y * SH - uy) * h) / uh)))];
    };
    const zs = `zs${ci}_${i}`, zk = `zk${ci}_${i}`, v = crops.map(at), lines = [];
    for (let j = 1; j < v.length; j++) {
      const [w, h, cx, cy] = v[j], [pw, ph, px, py] = v[j - 1];
      if (w === pw && h === ph && cx === px && cy === py) continue;
      lines.push(`${((j - 0.5) / FPS).toFixed(6)} ${w !== pw || h !== ph ? `${zs} w ${w}, ${zs} h ${h}, ` : ''}${zk} x ${cx}, ${zk} y ${cy};`);
    }
    const file = `${jobRel}/${x.tag}_zoom${ci}_${i}.cmd`;
    zoomCmds.push({ file, lines });
    const [w0, h0, cx0, cy0] = v[0];
    return `crop=${uw}:${uh}:${ux}:${uy},format=rgba${lines.length ? `,sendcmd=f=${file}` : ''},scale@${zs}=w=${w0}:h=${h0}:flags=lanczos,crop@${zk}=w=${BW}:h=${BH}:x=${cx0}:y=${cy0}:exact=1${ly.mirror ? ',hflip' : ''},format=rgba`;
  }
  // Captions see the parts as the plain and block exports do (start and length in seconds).
  const captionParts = parts.map((p) => ({ kind: p.kind, segs: p.segs, total: p.frames / FPS, start: p.start / FPS, blocks: p.blocks }));

  // ---- one part's sound: the voice (and layers with sound) cut like the picture, the sound cues under it ----
  const soundArgs = (part) => {
    const args = [...HEAD];
    let n = 0;
    const input = (list) => { args.push(...list); return n++; };
    const totalP = part.frames / FPS, f = [];
    const sel = part.segs ? part.segs.map(([a, b]) => `gte(t,${(a - half).toFixed(5)})*lt(t,${(b - half).toFixed(5)})`).join('+') : null;
    if (part.sounds.length) {
      part.sounds.forEach((file, i) => {
        const k = input(['-i', file]);
        f.push(`[${k}:a]aresample=48000:first_pts=0,asetnsamples=n=${48000 / FPS}:p=0` + (sel ? `,aselect='${sel}',asetpts=N/SR/TB` : '') + `[s${i}]`);
      });
      f.push(part.sounds.length > 1 ? `${part.sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${part.sounds.length}:duration=first:normalize=0[sm]` : `[s0]anull[sm]`);
    } else {
      const k = input(['-f', 'lavfi', '-t', totalP.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo']);
      f.push(`[${k}:a]anull[sm]`);
    }
    const cues = part.kind === 'take' ? mixCues(dir, { f, input, segs: part.segs, total: totalP, voice: '[sm]', voiceFile: part.sounds[0]?.replace(/^source\//, ''), range: part.range, skip: body.skipCue }) : { label: '[sm]', cues: 0 };
    part.cues = cues.cues;
    f.push(`${cues.label}aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[aout]`);
    args.push('-filter_complex', f.join(';'), '-map', '[aout]', '-c:a', 'pcm_s16le', '-t', totalP.toFixed(3), '-f', 'wav', part.audio);
    return args;
  };

  // Each run: its ffmpeg, how many frames it writes (span) and how much of the work it is (weight: sound is quick).
  const compName = (c) => (c.render ? `the ${c.render.label} (${c.render.file.replace(/^renders\//, '')})` : shotName(c.shots[0]));
  const runs = [...pieces.map((x) => ({ args: pieceArgs(x), span: x.frames, weight: x.frames * (x.kind === 'fade' ? 2 : 1),
    what: x.kind === 'fade' ? `${({ fade: 'crossfade', slide: 'slide', zoom: 'zoom' })[x.fade.type] || 'crossfade'} into ${compName(x.comps[1])}` : x.kind === 'file' ? x.part.name : compName(x.comps[0]) })),
    ...parts.map((p) => ({ args: soundArgs(p), span: p.frames, weight: p.frames * 0.05, what: `${p.name}: sound` }))];
  for (const z of zoomCmds) writeFileSync(join(dir, z.file), z.lines.join('\n') + '\n');
  const preset = main.preset;
  const out = nextName(dir, id, preset);
  writeFileSync(join(dir, jobRel, 'pictures.txt'), pieces.map((x) => `file '${x.tag}.mov'`).join('\n') + '\n');
  writeFileSync(join(dir, jobRel, 'sounds.txt'), parts.map((p) => `file '${p.tag}_sound.wav'`).join('\n') + '\n');
  const joinArgs = [...HEAD, '-f', 'concat', '-safe', '0', '-i', `${jobRel}/pictures.txt`, '-f', 'concat', '-safe', '0', '-i', `${jobRel}/sounds.txt`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', `${out}.part`];
  const ffmpeg = studioTool('ffmpeg');
  const presets = [...new Set(pieces.flatMap((x) => x.comps.map((c) => c.scene.preset)).filter(Boolean))];
  const builtIn = [...new Set(pieces.flatMap((x) => x.comps.filter((c) => c.render).map((c) => `${c.render.label} from ${c.render.file}`)))];
  writeJSON(join(dir, jobRel, 'job.json'), {
    out, layout, blocks: seq?.doc.blocks || null, cut: sp.cut ? { file: info.cut.file, segments: sp.cut } : null, duration: total,
    built: built.map((b) => ({ block: b.id, label: b.label, file: b.file, take: b.take, sheet: b.sheet })),
    background: bgPlan ? { ...bgPlan.bg, file: bgPlan.file || bgPlan.bg.file, frames: bgPlan.frames } : layout.bg,
    shots: sp.shots.map((s, i) => ({ id: s.id, n: i + 1, name: s.name || null, start: s.start, look: s.look || null, in: s.in || null })),
    zooms: (sp.zooms || []).map((z) => ({ id: z.id, target: z.target, a: z.a, b: z.b, c: z.c, d: z.d, ...(z.box ? { box: z.box } : { amount: z.amount }), speed: z.speed || 'smooth' })),
    looks: Object.fromEntries([...sets.entries()].map(([k, v]) => [v.prefix, k])),
    parts: parts.map((p) => ({ name: p.name, kind: p.kind, blocks: p.blocks, start: p.start / FPS, duration: p.frames / FPS, segments: p.segs, sound: p.audio, sounds: p.sounds })),
    pieces: pieces.map((x) => ({ file: x.out, kind: x.kind, part: x.part.tag, start: x.start / FPS, frames: x.frames, sources: x.src && x.src.map(([a, b]) => [a / FPS, b / FPS]),
      looks: x.comps.map((c) => (c.render ? { render: c.render.file, block: c.render.label, from: c.render.r0 }
        : { png: c.set.prefix, preset: c.scene.preset, shots: c.shots.map((i) => sp.shots[i]?.id || null), cards: c.scene.layers.map((ly) => ly.ref) })),
      ...(x.fade ? { fade: x.fade } : {}) })),
    ffmpeg: [...runs.map((r) => [ffmpeg, ...r.args]), [ffmpeg, ...joinArgs]],
  });
  const sh = join(dir, jobRel, 'run.sh');
  const line = (a) => [ffmpeg, ...a.filter((v) => v !== '-progress' && v !== 'pipe:1')].map(quote).join(' ');
  writeFileSync(sh, `#!/bin/sh\n# Re-run this export from the project folder: each picture piece and sound (shot by shot), then the join.\ncd "$(dirname "$0")/../../.." || exit 1\nset -e\n` +
    runs.map((r) => line(r.args)).join('\n') + `\n${line(joinArgs)} && mv ${quote(out + '.part')} ${quote(out)}\n`);
  chmodSync(sh, 0o755);

  const fadeN = pieces.filter((x) => x.kind === 'fade').length, zoomN = sp.zooms?.length || 0;
  const label = `Exporting ${out.replace('renders/', '')} (${total.toFixed(1)} s, shot by shot${fadeN ? `, ${fadeN} transition${fadeN > 1 ? 's' : ''}` : ''}${zoomN ? `, ${zoomN} zoom${zoomN > 1 ? 's' : ''}` : ''}${sp.cut ? ', locked cut' : ''})`;
  const procs = new Set();
  const job = { proc: { kill: (sig) => { for (const p of procs) { try { p.kill(sig); } catch {} } render?.cancel?.(); } }, label, progress: 0, out, cancelled: false, started: Date.now() };
  let render = null;
  jobs.set(id, job);
  emit({ t: 'job', id: 'export', label, progress: 0, cancel: true });
  let err = '', lastEmit = 0;
  const workTotal = runs.reduce((t, r) => t + r.weight, 0) + total * FPS * 0.03;
  const live = new Map();
  let doneWork = 0;
  const tick = (what) => {
    job.progress = Math.min(0.99, (doneWork + [...live.values()].reduce((t, v) => t + v, 0)) / workTotal);
    if (Date.now() - lastEmit < 200) return;
    lastEmit = Date.now();
    emit({ t: 'job', id: 'export', label: `${label}: ${what}`, progress: job.progress, cancel: true });
  };
  const runOne = ({ args, span, weight, what }) => new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('stopped'));
    const proc = spawn(ffmpeg, args, { cwd: dir });
    procs.add(proc);
    const key = {};
    proc.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    proc.stdout.on('data', (d) => {
      const m = [...String(d).matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m) { live.set(key, Math.min(1, (Number(m[1]) / 1e6) * FPS / Math.max(1, span)) * weight); tick(what); }
    });
    proc.on('error', (e) => { procs.delete(proc); reject(e); });
    proc.on('exit', (code) => {
      procs.delete(proc); live.delete(key);
      if (code === 0 && !job.cancelled) { doneWork += weight; tick(what); resolve(); } else reject(new Error(job.cancelled ? 'stopped' : `ffmpeg ${code}`));
    });
  });
  // At most PARALLEL ffmpegs at a time, in order.
  const runAll = async () => {
    let next = 0;
    const lane = async () => { while (next < runs.length) await runOne(runs[next++]); };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, runs.length) }, lane));
  };
  const work = async () => {
    if (bgPlan?.prepare) {
      render = bgPlan.prepare((p) => emit({ t: 'job', id: 'export', label: `Rendering the ${bgPlan.label} background (${Math.floor(p * 100)}%) · ${label}`, progress: 0, cancel: true }));
      await render.done;
      render = null;
      if (job.cancelled) throw new Error('stopped');
    }
    const t0 = Date.now();
    await runAll();
    job.renderSecs = (Date.now() - t0) / 1000;
    await runOne({ args: joinArgs, span: total * FPS, weight: total * FPS * 0.03, what: 'joining the pieces' });
  };
  work().then(() => finish(true), (e) => { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } if (!err && e?.message !== 'stopped') err = e?.message || String(e); finish(false); });
  function finish(ok) {
    jobs.delete(id);
    const part = join(dir, `${out}.part`);
    if (ok && existsSync(part)) {
      renameSync(part, join(dir, out));
      const secs = ((Date.now() - job.started) / 1000).toFixed(0);
      const cueCount = parts.reduce((t, p) => t + (p.cues || 0), 0);
      const shotsText = shotsLine(sp) || (sp.shots.length ? `${sp.shots.length} shot${sp.shots.length === 1 ? '' : 's'}` : 'one look');
      appendWorklog(dir, `Exported ${out} (${presets.join('/')}, ${layout.aspect}, ${total.toFixed(1)} s, shot by shot: ${shotsText}; ${pieces.length} picture pieces${builtIn.length ? `; ${builtIn.join(', ')}` : ''}${seq ? `, blocks: ${parts.map((p) => p.name).join(' · ')}` : ''}${sp.cut ? `; cut from ${info.cut.file}` : ', whole take'}${cueCount ? `; ${cueCount} sound cue${cueCount > 1 ? 's' : ''}` : ''}${body.captions ? '; captions burned in' : ''}; job ${jobRel}, ${secs} s)`);
      logTrialUse(dir, relative(settings().studio, dir), { bg: layout.bg, preset, out });
      let bytes = 0;
      try { bytes = statSync(join(dir, out)).size; } catch {}
      emit({ t: 'job', id: 'export', label: `Exported ${out}`, progress: 1, done: true, ok: true, file: out,
        receipt: { file: out, preset, aspect: layout.aspect, duration: total, cut: sp.cut ? info.cut.file : null, seconds: Number(secs), bytes, at: Date.now(),
          shots: shotsText, ...(builtIn.length ? { built: builtIn } : {}), ...(seq ? { blocks: parts.map((p) => p.name) } : {}) } });
    } else {
      try { rmSync(part, { force: true }); } catch {}
      const why = job.cancelled ? 'Export stopped' : `Export failed (${err.trim().split('\n').slice(-2).join(' ')})`;
      emit({ t: 'job', id: 'export', label: why, progress: 1, done: true, ok: job.cancelled });
    }
    emit({ t: 'files' });
  }
  return { out, duration: total, job: jobRel, parts: parts.length, pieces: pieces.length, shots: sp.shots.length };
}

// The take range a take part's blocks cover (the sound cues inside it mix into its sound), or null (no blocks: all).
function rangeOf(seq, p) {
  if (!seq || !p.blocks?.length) return null;
  const r = p.blocks.map((b) => seq.doc.blocks.find((x) => x.id === b)?.source.take).filter(Boolean);
  return r.length ? [Math.min(...r.map((x) => x[0])), Math.max(...r.map((x) => x[1]))] : null;
}
